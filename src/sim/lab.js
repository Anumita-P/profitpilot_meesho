/**
 * THE SCENARIO LAB (v2 phase 9).
 *
 * Eight deterministic, resettable scenarios that each exercise one honest failure
 * mode, and each shows the WHOLE decision path rather than a verdict:
 *
 *   INPUT -> DIAGNOSIS -> COUNTERFACTUALS -> RECOMMENDATION -> GUARDRAILS -> EXPECTED ECONOMIC RESULT
 *
 *   A  price-sensitive demand      shoppers who respond strongly to price
 *   B  catalogue bottleneck        plenty of impressions, few clicks
 *   C  high returns                conversion fine, returns above the category
 *   D  RTO spike                   COD-heavy cluster, parcels refused
 *   E  inventory ageing            old stock, weak demand, long cover
 *   F  demand surge                demand jumps; is there stock to serve it?
 *   G  competitive price shock     SYNTHETIC pressure on the seller's own demand
 *                                  curve - no competitor data is used anywhere
 *   H  aggressive undercutting     a discount race the floor has to survive
 *
 * A scenario is a set of simulator parameters (src/sim/scenario.js) plus the
 * variables a seller may edit and re-run. The run goes through the SAME market
 * model and the SAME event pipeline as everything else: the day loop emits events,
 * the events fold into features, the features drive the diagnosis, and the
 * diagnosis decides whether price is even on the table.
 *
 * Every scenario is resettable. Reset removes the events that run produced and
 * rebuilds the feature fold from what remains (src/domain/events.js rebuildObserved),
 * so a re-run starts from the same place instead of stacking on top of itself.
 */

import { load, save, listing, httpError } from '../store/db.js';
import * as scenarios from './scenario.js';
import * as market from './market.js';
import * as events from '../domain/events.js';
import { windowFeatures } from '../jobs/recalc.js';
import * as bottleneck from '../domain/bottleneck.js';
import * as counterfactual from '../domain/counterfactual.js';
import * as promotion from '../domain/promotion.js';
import * as inventory from '../domain/inventory.js';
import { versionSet } from '../domain/versions.js';

export const LAB_RUN_TAG = 'lab_run';        // marks events a lab run produced
const DAY = 86400000;

/**
 * The lab is a SANDBOX: before a scenario runs, every simulated event for that
 * listing is cleared and the feature fold is rebuilt, so the eight scenarios are
 * independent of each other and of any earlier run. Events from the seller's real
 * panels (`source: 'seller_panel'` / `'marketplace'`) are never touched - only the
 * simulator's own footprint is removed, and the response says how many.
 */
export function clearSandbox(listingId) {
  const d = load();
  const ids = (d.ingestedEvents || [])
    .filter((e) => e.listing_id === listingId && e.source === 'simulator')
    .map((e) => e.event_id);
  const removed = events.removeEvents({ ids, listingId, releaseKeysFor: listingId, reason: 'scenario lab sandbox reset' });
  const observed = events.rebuildObserved(listingId);
  /* INVENTORY_UPDATED events move the listing's OWN stock, and rebuilding the fold
     does not undo that. The sandbox therefore restores the stock position from the
     scenario's frozen baseline: leave the world the way you found it. */
  let stockRestored = null;
  let signalsRestored = null;
  const raw = d.listings[listingId];
  const baseline = (d.scenarios || []).find((x) => x.listing_id === listingId && x.baseline)?.baseline || null;
  if (raw && baseline) {
    /* the run folded its simulated events into the listing's features. Rebuilding
       `observed` empties the fold but does NOT put the anchors back, so a second
       scenario would start from the first scenario's cumulative traffic. Restore
       the scenario's frozen snapshot. */
    if (baseline.signals) {
      raw.signals = JSON.parse(JSON.stringify(baseline.signals));
      signalsRestored = 'full snapshot from the scenario baseline';
    } else {
      const s = raw.signals || (raw.signals = {});
      const keys = ['views', 'clicks', 'ctr', 'cvr', 'returnsPct', 'rtoPct', 'codShare', 'q0', 'keptRatePct'];
      const put = {};
      for (const k of keys) if (baseline[k] != null && s[k] !== baseline[k]) { put[k] = baseline[k]; s[k] = baseline[k]; }
      signalsRestored = Object.keys(put).length ? put : 'already at the baseline';
    }
    if (baseline.stock?.units != null && raw.stock && raw.stock.units !== baseline.stock.units) {
      stockRestored = { from: raw.stock.units, to: baseline.stock.units };
      raw.stock.units = baseline.stock.units;
    }
    save();
  }
  for (const s of d.scenarios || []) {
    if (s.listing_id === listingId && (s.lab_key || s.baseline_key)) scenarios.reset(s.scenario_id, { reason: 'lab sandbox reset' });
  }
  return { listing_id: listingId, events_removed: removed, features_rebuilt: true, signals_restored: signalsRestored, stock_restored: stockRestored, observed };
}
const round2 = (x) => Math.round(x * 100) / 100;

/** Every scenario is defined as data: simulator knobs + the variables a seller may edit. */
export const LAB_SCENARIOS = [
  {
    key: 'A',
    name: 'Price-sensitive demand',
    story: 'Shoppers in this category compare prices closely. A small move changes volume a lot, so the question is whether the extra volume pays for the thinner margin.',
    knobs: { sku: { elasticity: -2.2, demandLevel: 'medium', inventory: 1500, inventoryAgeDays: 45 }, market: { priceSensitivity: 2.2, demandTrend: 0.01 }, seller: { returnPropensity: 0.6, rtoPropensity: 0.5 }, risk: { returnRisk: 0.6, rtoRisk: 0.5 } },
    variables: [
      { key: 'market.priceSensitivity', label: 'Price sensitivity', default: 2.2, min: 0.2, max: 4, unit: 'x' },
      { key: 'sku.elasticity', label: 'Demand elasticity', default: -2.2, min: -6, max: -0.2, unit: '' },
      { key: 'sku.basePrice', label: 'Base price', default: null, min: 50, max: 5000, unit: '₹' },
    ],
    expect: 'price is a genuine lever here: the counterfactual curve should be clearly peaked, not flat',
    intent: { category: 'PRICE', driver: 'price_sensitive_market', note: 'traffic and clicks are fine, conversion is what is broken, and the scenario declares this market strongly price-sensitive' },
  },
  {
    key: 'B',
    name: 'Catalogue bottleneck',
    story: 'The listing gets plenty of impressions but shoppers do not click. Nothing about the price explains that - the main image and title do.',
    knobs: { sku: { catalogueQuality: 'low', inventory: 500, inventoryAgeDays: 45 }, seller: { catalogueQuality: 'low', returnPropensity: 0.3, rtoPropensity: 0.3, fulfilmentQuality: 'high', codShare: 0.4 }, market: { priceSensitivity: 0.8 }, risk: { returnRisk: 0.5, rtoRisk: 0.5 } },
    variables: [
      { key: 'sku.catalogueQuality', label: 'Catalogue quality', default: 'low', min: 0, max: 0, unit: '' },
      { key: 'seller.catalogueQuality', label: 'Seller catalogue quality', default: 'low', min: 0, max: 0, unit: '' },
    ],
    expect: 'CATALOGUE, with price_action HOLD and a recommendation to fix the image/title - no discount',
    intent: { category: 'CATALOGUE', driver: 'clicks', note: 'traffic is strong, clicks are weak against the category, the price is already in position' },
  },
  {
    key: 'C',
    name: 'High returns',
    story: 'Clicks and conversion are healthy, but a fifth of kept orders come back. Discounting would multiply the same problem.',
    knobs: { seller: { returnPropensity: 1.9, rtoPropensity: 0.5 }, risk: { returnRisk: 1.6, rtoRisk: 0.4 }, sku: { inventoryAgeDays: 45, inventory: 600 } },
    variables: [
      { key: 'seller.returnPropensity', label: 'Return propensity', default: 1.9, min: 0, max: 5, unit: 'x' },
      { key: 'risk.returnRisk', label: 'Return risk multiplier', default: 1.6, min: 0, max: 5, unit: 'x' },
    ],
    expect: 'RETURN_RTO (or MIXED with returns), price_action HOLD, fix sizing/photos/expectations first',
    intent: { category: 'RETURN_RTO', driver: 'returns', note: 'orders arrive and come back: returns run hot against the category prior' },
  },
  {
    key: 'D',
    name: 'RTO spike',
    story: 'A COD-heavy cluster is refusing parcels. The seller pays for the trip in both directions.',
    knobs: { seller: { rtoPropensity: 1.8, codShare: 0.75, returnPropensity: 0.4 }, risk: { rtoRisk: 1.6, codRisk: 1.4, returnRisk: 0.4 }, sku: { inventory: 800, inventoryAgeDays: 45 } },
    variables: [
      { key: 'seller.rtoPropensity', label: 'RTO propensity', default: 1.8, min: 0, max: 5, unit: 'x' },
      { key: 'seller.codShare', label: 'COD share', default: 0.75, min: 0, max: 1, unit: '' },
    ],
    expect: 'RETURN_RTO, HOLD, and an operational line about COD handling rather than a price cut',
    intent: { category: 'RETURN_RTO', driver: 'rto', note: 'the RTO component is what is hot, not the returns component' },
  },
  {
    key: 'E',
    name: 'Inventory ageing',
    story: 'The stock is old and demand is soft. Turning stock into cash is worth more than the last few rupees of margin.',
    knobs: { sku: { inventoryAgeDays: 165, inventory: 900, demandLevel: 'low' }, market: { demandTrend: -0.02 }, seller: { inventoryLevel: 'high', returnPropensity: 0.6, rtoPropensity: 0.5 }, risk: { returnRisk: 0.6, rtoRisk: 0.5 } },
    variables: [
      { key: 'sku.inventoryAgeDays', label: 'Stock age', default: 165, min: 0, max: 720, unit: 'days' },
      { key: 'sku.inventory', label: 'Units on hand', default: 900, min: 0, max: 5000, unit: '' },
      { key: 'sku.demandLevel', label: 'Demand level', default: 'low', min: 0, max: 0, unit: '' },
    ],
    expect: 'INVENTORY / CLEARANCE with a CONTROLLED REDUCTION - a price action, but on the floor and with the recovery path visible',
    intent: { category: 'INVENTORY', driver: null, note: 'stock is old and demand is quiet: AGING or CLEARANCE both mean a controlled reduction; STOCKOUT_RISK would not' },
  },
  {
    key: 'F',
    name: 'Demand surge',
    story: 'Demand jumps. If the stock cannot serve it, the wrong move is to stimulate more demand.',
    knobs: { market: { demandTrend: 0.03, seasonalShock: 0.6 }, sku: { demandLevel: 'very_high', inventory: 60, inventoryAgeDays: 20 }, seller: { fulfilmentQuality: 'medium', returnPropensity: 0.5, rtoPropensity: 0.5 }, risk: { returnRisk: 0.6, rtoRisk: 0.5 } },
    variables: [
      { key: 'market.demandTrend', label: 'Demand trend', default: 0.03, min: -0.2, max: 0.2, unit: '/day' },
      { key: 'market.seasonalShock', label: 'Seasonal shock', default: 0.6, min: -1, max: 1, unit: '' },
      { key: 'sku.inventory', label: 'Units on hand', default: 60, min: 0, max: 5000, unit: '' },
    ],
    expect: 'either STOCKOUT_RISK (protect price, replenish) or a healthy-demand HOLD - never a discount',
    intent: { category: 'INVENTORY', driver: 'STOCKOUT_RISK', note: 'demand surged; the binding constraint is stock, and demand must not be stimulated' },
  },
  {
    key: 'G',
    name: 'Competitive price shock (synthetic)',
    story: 'A synthetic shock makes the category price-sensitive overnight. This models pressure on the seller\'s OWN demand curve; no competitor data is used, by design and by policy.',
    knobs: { market: { competitionIntensity: 'high', priceSensitivity: 1.9, demandTrend: -0.03, seasonalShock: -0.4 }, sku: { demandLevel: 'very_low', inventory: 130, inventoryAgeDays: 45 }, seller: { returnPropensity: 0.6, rtoPropensity: 0.5 }, risk: { returnRisk: 0.6, rtoRisk: 0.5 } },
    variables: [
      { key: 'market.priceSensitivity', label: 'Price sensitivity', default: 1.9, min: 0.2, max: 4, unit: 'x' },
      { key: 'market.competitionIntensity', label: 'Competition intensity', default: 'high', min: 0, max: 0, unit: '' },
      { key: 'market.demandTrend', label: 'Demand trend', default: -0.03, min: -0.2, max: 0.2, unit: '/day' },
    ],
    expect: 'DEMAND: the shock shows up as traffic the listing is not getting; the engine HOLDS price instead of matching a rival price it cannot see, and the answer comes from contribution',
    intent: { category: 'DEMAND', driver: null, note: 'a synthetic competitive shock removes demand; with almost no traffic, a price move cannot be the answer - price is held and the case is answered on contribution' },
  },
  {
    key: 'H',
    name: 'Aggressive undercutting',
    story: 'A steep discount looks like the only way to keep volume. This is where the floor and the Loss Warning have to hold.',
    knobs: { market: { priceSensitivity: 2.6, demandTrend: -0.02, competitionIntensity: 'high', lookalikeGapPct: 14 }, sku: { basePrice: null, inventory: 700, inventoryAgeDays: 40 }, seller: { returnPropensity: 0.6, rtoPropensity: 0.5 }, risk: { returnRisk: 0.6, rtoRisk: 0.5 } },
    variables: [
      { key: 'market.priceSensitivity', label: 'Price sensitivity', default: 2.6, min: 0.2, max: 4, unit: 'x' },
      { key: 'sku.basePrice', label: 'Base price', default: null, min: 50, max: 5000, unit: '₹' },
      { key: 'market.lookalikeGapPct', label: 'Look-alike gap (synthetic)', default: 14, min: -90, max: 300, unit: '%' },
    ],
    expect: 'PRICE: the price sits above its look-alikes; the counterfactual grid SHOWS the cheap prices - with the floor marked - and the recommendation does not simply follow the cheapest or the highest-revenue candidate',
    intent: { category: 'PRICE', driver: 'price_off_vs_lookalikes', note: 'undercutting is declared as a look-alike gap, never as a competitor price this engine reads' },
  },
];

export function get(key) {
  const def = LAB_SCENARIOS.find((s) => s.key === String(key).toUpperCase());
  if (!def) throw httpError(404, `unknown lab scenario: ${key}`, { available: LAB_SCENARIOS.map((s) => s.key) });
  return def;
}

/** Resolve the editable variables (defaults + overrides) into simulator knob values. */
function resolveVariables(def, overrides = {}) {
  const resolved = {};
  const unknown = [];
  for (const v of def.variables) {
    const v2 = overrides[v.key];
    let value = v2 === undefined ? v.default : v2;
    if (value === null && v.key.endsWith('basePrice')) continue;       // null = "the listing's own price"
    if (typeof value === 'string' && !['low', 'medium', 'high', 'very_low', 'very_high'].includes(value)) unknown.push(v.key);
    resolved[v.key] = value;
  }
  for (const k of Object.keys(overrides)) if (!def.variables.some((v) => v.key === k)) unknown.push(k);
  if (unknown.length) throw httpError(400, `unknown variable(s): ${unknown.join(', ')}`, { field: 'variables', allowed: def.variables.map((v) => v.key) });
  return resolved;
}

/** Merge defaults, the scenario's knobs and the resolved variables into a simulator input. */
export function buildInput(key, { listingId = null, variables = {}, days = 30, seed = 7, name = null } = {}) {
  const def = get(key);
  const resolved = resolveVariables(def, variables);
  const target = listingId || 'L-kurti';
  const l = listing(target);
  const input = {
    name: name || `Lab ${def.key} - ${def.name}`,
    listing_id: target,
    skuKey: l.skuKey,
    seed,
    horizon_days: days,
    sku: { ...def.knobs.sku },
    seller: { ...def.knobs.seller },
    market: { ...def.knobs.market },
    risk: { ...def.knobs.risk },
    notes: `scenario lab ${def.key}: ${def.story}`,
  };
  if (input.sku.basePrice === undefined || input.sku.basePrice === null) delete input.sku.basePrice;
  for (const [path, value] of Object.entries(resolved)) {
    const [group, field] = path.split('.');
    if (group === 'listing' || !field) continue;
    input[group] ||= {};
    input[group][field] = value;
  }
  return { def, input, resolved };
}

/** A stable scenario id per lab key + listing, so a re-run updates the same scenario. */
export function scenarioIdFor(key, listingId) {
  const d = load();
  const existing = (d.scenarios || []).find((s) => s.lab_key === String(key).toUpperCase() && s.listing_id === listingId);
  return existing?.scenario_id || null;
}

/** Reset: remove the events the last run produced and rebuild the feature fold. */
export function reset(key, { listingId = null, rebuild = true } = {}) {
  const d = load();
  const def = get(key);
  const target = listingId || 'L-kurti';
  const scenarioId = scenarioIdFor(def.key, target);
  let removed = 0;
  if (scenarioId) {
    /* remove exactly the events this scenario's runs ingested (by event_id), so a
       re-run does not stack a second simulated month on top of the first */
    const ids = (d.simRuns || [])
      .filter((r) => r.scenario_id === scenarioId && r.listing_id === target)
      .flatMap((r) => r.events?.ids || []);
    removed = events.removeEvents({ ids, listingId: target, reason: `lab scenario ${def.key} reset` });
    scenarios.reset(scenarioId, { reason: 'lab scenario reset: the run is cleared so the scenario can be re-run from the same start' });
  }
  const observed = rebuild ? events.rebuildObserved(target) : null;
  const run = (d.simRuns || []).find((r) => r.lab_key === def.key && r.listing_id === target);
  if (run) { run.status = 'RESET'; run.removed_events = removed; run.reset_at = new Date().toISOString(); save(); }
  return { scenario: def.key, listing_id: target, scenario_id: scenarioId, events_removed: removed, features_rebuilt: !!observed, observed };
}

/**
 * Run a lab scenario end to end and report the whole decision path.
 * The order matters: events first, then features, then the diagnosis, and only
 * then - if the diagnosis allows it - the counterfactual.
 */
export function run(key, { listingId = null, variables = {}, days = 30, seed = 7, reset: doReset = true, horizonDays = 30 } = {}) {
  const def = get(key);
  const target = listingId || 'L-kurti';
  const resetInfo = doReset ? clearSandbox(target) : null;

  const { input, resolved } = buildInput(def.key, { listingId: target, variables, days, seed });
  const d = load();
  d.scenarios ||= [];
  let scenario = (d.scenarios || []).find((s) => s.lab_key === def.key && s.listing_id === target);
  if (scenario) {
    scenario = scenarios.update(scenario.scenario_id, { ...input, skuKey: input.skuKey, listing_id: target, seed, horizon_days: days }, { actor: 'lab' });
  } else {
    scenario = scenarios.create({ ...input, listing_id: target }, { sellerId: listing(target).sellerId, actor: 'lab' });
    scenario.lab_key = def.key;
    scenario.lab_name = def.name;
    scenario.lab_story = def.story;
    save();
  }
  scenario.lab_key = def.key;
  scenario.lab_variables = resolved;
  save();

  /* 1-2. the market runs and the events land in the SAME pipeline */
  const startedAt = scenario.start_at;
  const ran = market.run(scenario.scenario_id, { days, at: startedAt, actor: 'lab' });
  const ledger = ran.ledger || [];
  const lastDay = ledger[ledger.length - 1] || null;
  const endAt = ran.run?.ledger?.to || ran.scenario?.last_run_at || null;

  /* 3. features: fold what was observed into the signals the models read */
  const L = listing(target);
  events.refreshSignalsFromObserved(L);
  save();

  /* 3b. the DIAGNOSIS reads the seller's most recent week of this scenario, not
     the whole horizon. The cumulative fold compares a month of views against a
     DAILY category median and would make every scenario look broken at once; a
     recent window keeps the units honest and the bottleneck specific. */
  const windowDays = Math.min(7, ledger.length) || 1;
  const lastDate = ledger.length ? ledger[ledger.length - 1].date : null;
  const toMs = lastDate ? Date.parse(lastDate) + 86400000 : Date.parse(scenario.start_at) + 86400000;
  const win = windowFeatures(target, {
    from: new Date(toMs - windowDays * 86400000).toISOString(),
    to: new Date(toMs).toISOString(),
    days: windowDays,
  });

  /* the stock position the SCENARIO puts the seller in: the run's own ending
     stock, the scenario's stock age, and the sell-through the run produced. These
     are analysis overrides - the listing itself is never mutated by the lab. */
  const keptTotal = ledger.reduce((a, r) => a + r.kept, 0);
  const startedWith = scenario.sku.inventory;
  const onHand = ran.scenario?.inventoryNow ?? Math.max(0, startedWith - keptTotal);
  const unitsPerDay = round2(keptTotal / Math.max(1, ledger.length));
  const invState = inventory.stateOf(target, {
    onHand, unitsPerDay,
    ageDays: scenario.sku.inventoryAgeDays,
    sellThroughPct: startedWith ? round2((keptTotal / startedWith) * 100) : null,
  });

  /* is demand heating up or cooling off inside this scenario? The inventory stance
     uses it to decide whether a controlled reduction is the right lever. */
  const weekOrders = (rows) => rows.reduce((a, r) => a + r.orders, 0);
  const firstWeek = ledger.slice(0, Math.min(7, ledger.length));
  const lastWeek = ledger.slice(-windowDays);
  const orderChangePct = weekOrders(firstWeek) ? round2(((weekOrders(lastWeek) - weekOrders(firstWeek)) / weekOrders(firstWeek)) * 100) : null;
  const demandContext = {
    first_week_orders: weekOrders(firstWeek),
    last_week_orders: weekOrders(lastWeek),
    change_pct: orderChangePct,
    hot: orderChangePct == null ? null : orderChangePct > 5,
    reading: orderChangePct == null ? 'not enough days to compare'
      : orderChangePct > 5 ? 'demand is heating up inside this scenario'
        : orderChangePct < -5 ? 'demand is cooling off inside this scenario'
          : 'demand is flat inside this scenario',
  };

  /* 4. diagnosis first - and price only if the diagnosis says so */
  /* the run's own price against the look-alike benchmark the listing carries:
     a scenario may raise or cut the price, and the position has to move with it. */
  const lookalikeMedian = L.signals?.rivalGapPct != null ? L.price / (1 + L.signals.rivalGapPct / 100) : null;
  const priceNow = ledger.length ? ledger[ledger.length - 1].price : L.price;
  const declaredGap = scenario.market?.lookalikeGapPct;
  const signalOverrides = {
    rivalGapPct: declaredGap != null
      ? round2(declaredGap)
      : (lookalikeMedian ? round2(((priceNow / lookalikeMedian) - 1) * 100) : null),
    gap_declared_by_scenario: declaredGap != null,
    priceSensitivity: scenario.market?.priceSensitivity ?? null,
  };

  const first = bottleneck.analyse(target, { inventoryState: invState, window: win, demand: demandContext, signalOverrides });
  const cf = first.price_action === 'EVALUATE'
    ? counterfactual.grid(target, { horizonDays })
    : null;
  const diagnosis = cf ? bottleneck.analyse(target, { counterfactual: cf, inventoryState: invState, window: win, demand: demandContext, signalOverrides }) : first;

  /* 5. recommendation + guardrails on the recommended candidate only */
  const rec = cf?.recommendation || null;
  const guardrail = rec
    ? (cf.candidates.find((c) => c.candidate === rec.candidate)?.guardrails || null)
    : null;

  /* 6. expected economic result: the modelled horizon, and what the simulation
        actually produced for the same day loop (both labelled). */
  const liveRow = cf?.candidates.find((c) => c.candidate === cf.context.live_price) || null;
  const floor = inventory.stateOf(target).floor;
  const simulatedResult = lastDay ? {
    days_run: ledger.length,
    views: ledger.reduce((a, r) => a + r.views, 0),
    orders: ledger.reduce((a, r) => a + r.orders, 0),
    kept_orders: ledger.reduce((a, r) => a + r.kept, 0),
    revenue: round2(ledger.reduce((a, r) => a + (r.revenue || 0), 0)),
    contribution: round2(ledger.reduce((a, r) => a + (r.contribution || 0), 0)),
    contribution_per_kept_order: (() => {
      const kept = ledger.reduce((a, r) => a + r.kept, 0);
      const contrib = ledger.reduce((a, r) => a + (r.contribution || 0), 0);
      return kept ? round2(contrib / kept) : null;
    })(),
    label: 'SIMULATED - what this scenario produced in the day loop, not a forecast of the seller\'s real listing',
  } : null;

  const intent = def.intent || null;
  const matchesIntent = intent ? (diagnosis.category === intent.category
    && (!intent.driver || diagnosis.primary_driver === intent.driver)) : null;
  const report = {
    scenario: {
      key: def.key, name: def.name, story: def.story, expect: def.expect,
      intended_bottleneck: intent ? intent.category : null,
      intended_driver: intent ? (intent.driver || null) : null,
      intended_note: intent ? intent.note : null,
    },
    intent_check: {
      intended: intent ? `${intent.category}${intent.driver ? '/' + intent.driver : ''}` : null,
      observed: `${diagnosis.category}${diagnosis.primary_driver ? '/' + diagnosis.primary_driver : ''}`,
      matches: matchesIntent,
      reading: matchesIntent === null ? 'no intent declared for this scenario'
        : matchesIntent ? 'the scenario produces the intended bottleneck from evidence, not by labelling'
          : `the evidence does not support the intended bottleneck: ${diagnosis.confidence_basis}`,
    },
    label: counterfactual.LABEL,
    listing_id: target,
    sku: L.skuKey,
    seed,
    days,
    variables: resolved,
    editable_variables: def.variables,
    inputs: {
      simulator: {
        listing_id: target, sku: scenario.sku, seller: scenario.seller, market: scenario.market, risk: scenario.risk,
        horizon_days: scenario.horizon_days, seed: scenario.seed,
      },
      starting_price: cf?.context.live_price ?? listing(target).price,
      floor,
    },
    day_loop: {
      scenario_id: scenario.scenario_id,
      days_run: ledger.length,
      first_day: ledger[0] || null,
      last_day: lastDay,
      ingested: ran.ingested || null,
      window: { from: ran.run?.ledger?.from || null, to: endAt },
      totals: ran.totals || null,
    },
    diagnosis: {
      category: diagnosis.category,
      category_label: diagnosis.category_label,
      primary_driver: diagnosis.primary_driver,
      basis: diagnosis.basis,
      demand_context: diagnosis.demand_context,
      signals: diagnosis.signals,
      existing_branches: diagnosis.existing_branches,
      confidence: diagnosis.confidence,
      confidence_kind: 'categorical only',
      price_action: diagnosis.price_action,
      secondary: diagnosis.secondary,
      recommended_action: diagnosis.recommended_action,
      evidence: diagnosis.evidence,
      facts: diagnosis.facts,
      inventory_state: diagnosis.inventory?.state,
      promotion: diagnosis.promotion,
    },
    counterfactuals: cf
      ? {
        label: cf.label,
        horizon_days: cf.context.horizon_days,
        curve: cf.curve,
        recommendation: cf.recommendation,
        not_the_cheapest: cf.not_the_cheapest,
        not_the_highest_revenue: cf.not_the_highest_revenue,
        promotion_check: cf.promotion_check,
      }
      : { skipped: true, why: 'the diagnosis did not name price as the lever, so no counterfactual was run - that IS the answer for this scenario' },
    recommendation: cf
      ? {
        decision: 'CHANGE_PRICE',
        candidate: rec.candidate,
        price_action: rec.price_action,
        move_pct: rec.move_pct,
        why: rec.why,
        basis: 'expected contribution over the horizon among the eligible candidates',
        guardrail,
        live_candidate: liveRow ? { candidate: liveRow.candidate, expected_contribution: liveRow.expected_value.value, contribution_per_kept_order: liveRow.economics.contribution_per_kept_order } : null,
        expected_economic_result: {
          label: counterfactual.LABEL,
          horizon_days: cf.context.horizon_days,
          contribution_per_kept_order: rec.contribution_per_kept_order,
          expected_contribution: rec.expected_contribution,
          delta_vs_live: liveRow ? round2(rec.expected_contribution - liveRow.expected_value.value) : null,
          kept_orders: cf.candidates.find((c) => c.candidate === rec.candidate)?.operations.kept_orders ?? null,
          honest_caveat: 'an estimate from the same deterministic curve the product uses; the real answer comes from the seller\'s own events after the change',
        },
      }
      : {
        decision: 'HOLD',
        price_action: diagnosis.price_action,
        why: diagnosis.recommended_action.line,
        expected_economic_result: {
          label: counterfactual.LABEL,
          note: 'no price change is recommended, so the economic result of holding is the seller\'s current trajectory - shown by the simulated day loop above',
        },
      },
    guardrails: {
      applied: !!guardrail,
      result: guardrail ? (guardrail.eligible ? 'the recommended candidate passes every guardrail' : `blocked by ${guardrail.blocked_by.join(', ')}`) : 'no price candidate to check',
      checks: guardrail?.checks || null,
      rule: 'hard floor · ±8% per move · 7-day cooldown · ≤2 moves/month · 1,000-view sanity · 14-day auto-revert · Loss Warning',
    },
    simulated_result: simulatedResult,
    diagnosis_window: win,
    price_position: { price: priceNow, lookalike_median_implied: lookalikeMedian ? round2(lookalikeMedian) : null, gap_pct: signalOverrides?.rivalGapPct ?? null },
    stock_position: { on_hand: onHand, units_per_day: unitsPerDay, age_days: scenario.sku.inventoryAgeDays, sell_through_pct: startedWith ? round2((keptTotal / startedWith) * 100) : null, basis: invState.basis },
    reset: resetInfo,
    versions: versionSet(),
    note: 'INPUT -> DIAGNOSIS -> COUNTERFACTUALS -> RECOMMENDATION -> GUARDRAILS -> EXPECTED ECONOMIC RESULT. The simulator is illustrative; the guardrails and the floor are real code paths, and nothing was executed on the listing.',
  };
  return report;
}

export function list() {
  const d = load();
  return LAB_SCENARIOS.map((s) => {
    const runs = (d.simRuns || []).filter((r) => r.lab_key === s.key);
    return {
      key: s.key, name: s.name, story: s.story, expect: s.expect,
      variables: s.variables,
      last_run: runs.length ? runs[runs.length - 1] : null,
      scenario_id: scenarioIdFor(s.key, runs.length ? runs[runs.length - 1].listing_id : 'L-kurti'),
    };
  });
}

export { round2 };

/* ------------------------------ calibration ------------------------------ */
/**
 * Re-run each built-in scenario and report which ones produce the bottleneck the
 * scenario was DESIGNED to show.
 *
 * This is not a pass/fail. The simulated population is generated from the
 * scenario's own stated propensities, and the lab's job is to say, per scenario,
 * whether the evidence it produced actually supports the story it tells. Where it
 * does not, the next knob to move is named - `next_variable` - instead of quietly
 * relabelling the diagnosis to match the slide.
 *
 * Expensive (one full run per scenario) and deliberately explicit: it is a lab
 * tool, not a request path.
 */
export function calibrate({ listingId = null, days = 21, seed = 7, only = null, keep = false } = {}) {
  const keys = only ? (Array.isArray(only) ? only : [only]) : LAB_SCENARIOS.map((x) => x.key);
  const runs = [];
  for (const key of keys) {
    const built = buildInput(key, { listingId, days, seed });
    const out = run(key, { listingId: built.listing_id, days, seed });
    runs.push({
      key,
      name: out.scenario.name,
      listing_id: built.listing_id,
      intended: out.scenario.intended_bottleneck,
      intended_driver: out.scenario.intended_driver,
      observed: out.diagnosis.category,
      observed_driver: out.diagnosis.primary_driver,
      matches: out.intent_check.matches,
      confidence: out.diagnosis.confidence,
      basis: out.diagnosis.basis,
      reading: out.intent_check.reading,
      next_variable: out.intent_check.matches ? null : nextVariableFor(key, out),
      events: out.day_loop?.events ?? null,
      behaviour_fingerprint: out.versions?.behaviour_fingerprint ?? null,
    });
    if (!keep) clearSandbox(built.listing_id);
  }
  const matched = runs.filter((r) => r.matches === true).length;
  return {
    runs,
    matched,
    total: runs.length,
    note: 'Simulated scenarios on a generated population. A scenario whose observed bottleneck differs from its intent is reported honestly, with the variable to move next - the diagnosis is never relabelled to fit the story.',
  };
}

/** Which scenario variable to move to make the intended bottleneck show up. */
export function nextVariableFor(key, out) {
  const observed = out.diagnosis.category;
  const intended = out.scenario.intended_bottleneck;
  const vs = out.diagnosis.basis || {};
  if (key === 'B') return 'sku.catalogueQuality is already low: raise ctrBenchmark only if the category prior is wrong, otherwise lower catalogueQuality further to widen the click gap';
  if (key === 'C') return 'seller.returnPropensity (0.3 now): raise it so returns clear the category prior, and/or lower categoryReturnsPct';
  if (key === 'D') return 'seller.rtoPropensity and risk.codRisk: raise the RTO propensity, and keep codShare high - RTO, not returns, has to be the hot component';
  if (key === 'E') return 'sku.inventoryAgeDays and market demandLevel: more age plus quieter demand; the run must also end with real stock left, or the state reads STOCKOUT_RISK instead';
  if (key === 'F') return 'market.demandTrend / demandShock: the surge has to out-run stock within the horizon so cover falls under the risk line';
  if (key === 'A') return 'market.priceSensitivity and the counterfactual band: the price has to sit outside the band with healthy traffic and clicks';
  return `${key}: widening the gap between the intended bottleneck (${intended}) and the other signals; currently reading ${observed}`;
}
