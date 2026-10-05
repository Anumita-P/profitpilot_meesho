/**
 * SELLER + MARKET SIMULATOR (v2 phase 1).
 *
 * It generates the kind of event stream a seller panel or the Meesho pipe would
 * push, and pushes it through THE SAME ingestion pipeline the real product uses
 * (`events.ingestBatch`). There is no separate "simulated analytics" path: the
 * features, signals, recommendations, outcomes and experiments downstream cannot
 * tell a simulated event from an ingested one - except that every simulated
 * event carries `source: 'simulator'` (or `demo`), which is exactly how the
 * system stays honest about where a number came from.
 *
 * The economics are not re-invented here. The funnel is driven by the same
 * constants and curves the engine uses:
 *
 *   views   = the listing's own view rate, scaled by demand level, trend,
 *             seasonality, competition and catalogue quality
 *   ctr     = CTR0 x catalogue-quality factor x the price penalty curve
 *             (src/engine/demand.js penalty()) - the same curve the demand model
 *             uses, so a price cut cannot look cheap in one place and expensive
 *             in another
 *   cvr     = CVR0 x demand factor
 *   ops     = cancellation / RTO / return priors from the listing's signals and
 *             category priors (src/engine/risk.js), scaled by the scenario's
 *             operational-risk knobs and the seller's quality
 *   money   = the floor arithmetic (src/engine/floor.js) with the scenario's unit
 *             cost, so contribution per kept order is defined the same way as
 *             everywhere else in the system
 *
 * Each day, each listing draws from its own stream (`sub(seed, scenario, day)`),
 * so a scenario is reproducible: same seed + same parameters = same stream, in
 * this process or the next. The raw oracle (`rand`) never touches the outcome -
 * it only decides how many of today's orders are cancelled / RTO / returned.
 *
 * The ledger (per-day aggregates) is kept next to the ingested events on purpose:
 * `reconcile()` compares them, so "the simulator and the pipeline agree" is a
 * checked property rather than a claim.
 */

import { load, save, logEvent, httpError } from '../store/db.js';
import { ENGINE, GUARDRAILS } from '../config/deck.js';
import { computeFloor } from '../engine/floor.js';
import { ordersPerDay, penalty } from '../engine/demand.js';
import * as events from '../domain/events.js';
import * as scenarioModel from './scenario.js';
import { sub, jitter, roundCount, bernoulli, fingerprintOf, hashSeed } from './random.js';

const DAY = 86400000;
const SOURCE = 'simulator';

/* ------------------------------- scenario maths ---------------------------- */

/**
 * A second-level offset inside the day, derived from the PARAMETERS (not the id):
 *   - identical parameters + seed + start date -> identical offset, so two such
 *     scenarios produce byte-identical streams (the determinism property is
 *     checkable, see test/v2.test.js);
 *   - different parameters -> almost certainly a different offset, so two
 *     scenarios on the same listing do not collide on the pipeline's natural key
 *     (type|seller|listing|timestamp|units) and get a loud 409 instead of a
 *     silent merge.
 */
/* A params-derived offset spread across a whole day. Two DIFFERENT scenarios that
   share a listing can therefore never collide on (event type, timestamp) - which
   the pipeline treats as the same event - while a re-run of the SAME scenario
   produces the identical offset and therefore dedupes exactly as before. */
const scenarioOffsetSec = (scenario) => hashSeed(scenario.params_fingerprint || '') % 86400;

const demandFactor = (s) => scenarioModel.DEMAND_LEVEL_FACTOR[s.sku.demandLevel]
  * (s.seller.quality === 'high' ? 1.1 : s.seller.quality === 'low' ? 0.9 : 1);

const ctrFactor = (s) => scenarioModel.QUALITY_CTR_FACTOR[s.sku.catalogueQuality]
  * Math.sqrt(scenarioModel.QUALITY_CTR_FACTOR[s.seller.catalogueQuality]);

const cvrDemand = (s) => scenarioModel.DEMAND_LEVEL_FACTOR[s.sku.demandLevel];

const seasonalityAt = (s, day) => 1 + s.market.seasonalShock * Math.sin((2 * Math.PI * day) / 30);
const competitionAt = (s) => (s.market.competitionIntensity === 'high' ? 0.82 : s.market.competitionIntensity === 'low' ? 1.12 : 1);

/** Customer-facing price: base minus an active promotion (phase 5 owns the full rule). */
export function effectivePrice(scenario) {
  const p = scenario.sku.promotion;
  if (!p || !p.active) return scenario.sku.basePrice;
  const off = p.kind === 'flat_discount' || p.kind === 'coupon' ? p.value : 0;
  return Math.max(1, Math.round(scenario.sku.basePrice - off));
}

/* --------------------------------- one day -------------------------------- */

/**
 * Produce one day of the world. Pure: no store writes, no clock reads.
 * @returns {{ events: object[], row: object, inventoryEnd: number, stockout: boolean }}
 */
export function dayPlan(scenario, dayIndex, { inventoryStart, rand = sub(scenario.seed, scenario.listing_id, 'day', dayIndex) } = {}) {
  const L = scenarioModel.hydratedTarget(scenario);
  /* Anchors come from the scenario's frozen baseline (or the live listing for a
     scenario created before baselines existed), never from whatever the listing
     happens to look like now: that is what makes a run reproducible. */
  const base = scenario.baseline || {};
  const signals = {
    views: base.views ?? L.signals.views,
    clicks: base.clicks ?? L.signals.clicks ?? Math.round((L.signals.views || 0) * (L.signals.ctr || 4) / 100),
    ctr: base.ctr ?? L.signals.ctr,
    q0: base.q0 ?? L.signals.q0,
    returnsPct: base.returnsPct ?? L.signals.returnsPct,
    rtoPct: base.rtoPct ?? L.signals.rtoPct,
    codShare: base.codShare ?? L.signals.codShare,
  };
  const price = effectivePrice(scenario);
  const costOverrides = { cs: scenario.sku.unitCost };
  const floor = computeFloor(scenario.skuKey, costOverrides);
  const date = new Date(Date.parse(scenario.start_at) + dayIndex * DAY);

  /* views: the listing's own daily rate, scaled by the scenario's market.
     (In this dataset `signals.views` and `signals.clicks` are daily figures -
     clicks == views x ctr - which is why the funnel is anchored on them directly
     rather than on a per-week guess.) */
  const baseViews = Math.max(20, Math.round(signals.views || 1400));
  /* a compound trend over a long horizon can explode; the ceiling keeps the
     payload inside the event contract (views <= 1e7) and the run plausible */
  const VIEW_CEILING = 9_000_000;
  const views = Math.min(VIEW_CEILING, Math.max(0, Math.round(baseViews
    * demandFactor(scenario)
    * Math.pow(1 + scenario.market.demandTrend, dayIndex)
    * (1 + scenario.market.demandShock)
    * seasonalityAt(scenario, dayIndex)
    * competitionAt(scenario)
    * jitter(rand, 0.12))));

  /* clicks: the listing's own CTR, moved by catalogue quality and by the SAME
     price-penalty curve the demand model uses (src/engine/demand.js penalty()),
     so a price change cannot look cheap here and expensive there. */
  const ctrBase = (signals.ctr ? signals.ctr / 100 : ENGINE.CTR0) * ctrFactor(scenario);
  const priceRatio = penalty(price, L.sku.median) / penalty(L.price, L.sku.median);
  const ctr = clamp(ctrBase * Math.pow(priceRatio, scenario.market.priceSensitivity), 0.001, 0.4);
  const clicks = roundCount(rand, views * ctr);

  /* orders: the listing's OWN implied CVR (q0 / clicks), so the funnel and the
     demand model start from the same observed reality, then the scenario moves it */
  const cvrBase = clamp((signals.q0 || 1) / Math.max(1, signals.clicks || 1), 0.01, 0.6);
  const cvr = clamp(cvrBase * cvrDemand(scenario) * (1 + scenario.market.demandShock) * jitter(rand, 0.08), 0.001, 0.6);
  let orders = roundCount(rand, clicks * cvr);
  const stockLimited = orders > inventoryStart;
  if (stockLimited) orders = Math.max(0, inventoryStart);

  const cancelP = clamp(0.03 * scenarioModel.FULFILMENT_FACTOR[scenario.seller.fulfilmentQuality] * scenario.risk.fulfilmentRisk, 0, 0.9);
  const rtoP = clamp((signals.rtoPct / 100) * scenario.seller.rtoPropensity * scenario.risk.rtoRisk * (1 + scenario.seller.codShare * scenario.risk.codRisk * 0.5), 0, 0.9);
  const retP = clamp((signals.returnsPct / 100) * scenario.seller.returnPropensity * scenario.risk.returnRisk, 0, 0.9);

  const offsetSec = scenarioOffsetSec(scenario);
  const rows = [];
  let cancelled = 0; let shipped = 0; let delivered = 0; let returned = 0; let rto = 0;
  for (let i = 0; i < orders; i++) {
    const r = sub(scenario.seed, scenario.listing_id, 'order', dayIndex, i);
    /* Orders are spread across their OWN day (proportional to the day's volume),
       never by a fixed minute step: with a fixed step a day that produces more
       than 1,440 orders wraps into the next day and two different orders end up
       with the same timestamp - which the pipeline (rightly) treats as one event. */
    const spreadMs = orders > 0 ? Math.floor(((i + 1) * 86_400_000) / (orders + 1)) % 86_400_000 : 0;
    const ts = new Date(date.getTime() + spreadMs + offsetSec * 1000).toISOString();
    const cod = bernoulli(r, scenario.seller.codShare);
    rows.push({ event_type: 'ORDER_PLACED', listing_id: scenario.listing_id, timestamp: ts, source: SOURCE, payload: { units: 1, orderValue: price, paymentMode: cod ? 'cod' : 'prepaid' } });
    if (bernoulli(r, cancelP)) {
      cancelled += 1;
      rows.push({ event_type: 'ORDER_CANCELLED', listing_id: scenario.listing_id, timestamp: ts, source: SOURCE, payload: { units: 1, reason: 'buyer cancelled (simulated)' } });
      continue;
    }
    shipped += 1;
    rows.push({ event_type: 'ORDER_SHIPPED', listing_id: scenario.listing_id, timestamp: ts, source: SOURCE, payload: { units: 1 } });
    if (bernoulli(r, rtoP)) {
      rto += 1;
      rows.push({ event_type: 'ORDER_RTO', listing_id: scenario.listing_id, timestamp: ts, source: SOURCE, payload: { units: 1, orderValue: price, rtoCost: floor.Crto } });
      continue;
    }
    delivered += 1;
    rows.push({ event_type: 'ORDER_DELIVERED', listing_id: scenario.listing_id, timestamp: ts, source: SOURCE, payload: { units: 1, orderValue: price } });
    if (bernoulli(r, retP)) {
      returned += 1;
      const reasons = ['size', 'damage', 'quality', 'not as described'];
      rows.push({ event_type: 'ORDER_RETURNED', listing_id: scenario.listing_id, timestamp: ts, source: SOURCE, payload: { units: 1, orderValue: price, reasonCode: reasons[Math.floor(r() * reasons.length)], returnCost: floor.Cret } });
    }
  }

  const engineOrders = ordersPerDay(L, price, { beta: scenario.sku.elasticity ?? undefined })
    * demandFactor(scenario) * (1 + scenario.market.demandShock);
  const kept = delivered - returned;
  const inventoryEnd = Math.max(0, inventoryStart - kept);
  const stockout = inventoryStart > 0 && inventoryEnd === 0;

  rows.unshift({ event_type: 'VIEW_RECORDED', listing_id: scenario.listing_id, timestamp: date.toISOString(), source: SOURCE, payload: { views, clicks } });
  rows.push({ event_type: 'INVENTORY_UPDATED', listing_id: scenario.listing_id, timestamp: new Date(date.getTime() + 23 * 3600000).toISOString(), source: SOURCE, payload: { units: inventoryEnd } });

  const contribution = kept * (price - floor.F);
  return {
    events: rows,
    row: {
      day: dayIndex + 1,
      date: date.toISOString(),
      views,
      clicks,
      ctrPct: round2(ctr * 100),
      cvrPct: round2(cvr * 100),
      orders,
      cancelled,
      shipped,
      delivered,
      returned,
      rto,
      kept,
      price,
      effectivePrice: price,
      floor: floor.F,
      marginPerKeptOrder: round2(price - floor.F),
      contribution: round2(contribution),
      revenue: round2(kept * price),
      inventoryEnd,
      stockLimited,
      /* the funnel above and the demand model are two views of the same listing:
         this ratio is reported so a reviewer can see they stay the same order of
         magnitude (the deck's own seed implies CVR ~9%, CVR0 is 12%). */
      engineOrdersPerDay: round2(engineOrders),
      funnelVsEnginePct: round2((orders / Math.max(0.01, engineOrders)) * 100),
      simulated: true,
    },
    inventoryEnd,
    stockout,
  };
}

/* ---------------------------------- run ----------------------------------- */

/**
 * Advance a scenario by `days` days: generate the stream, push it through the
 * real ingest pipeline, record the ledger, and log the run.
 *
 * @returns {{ scenario, run, ledger: object[], ingested: object }}
 */
export function run(id, { days = null, at = null, actor = 'simulator', dryRun = false } = {}) {
  const d = load();
  const scenario = scenarioModel.find(d, id);
  const horizon = scenario.horizon_days;
  const want = Math.max(1, Math.round(days ?? horizon));
  const remaining = Math.max(0, horizon - scenario.cursor_day);
  if (remaining === 0 && scenario.status === 'DONE' && !days) {
    throw httpError(409, `${id} has already run its whole horizon (${horizon} days): reset it or run it with an explicit \`days\``, { scenario_id: id, cursor_day: scenario.cursor_day, horizon_days: horizon });
  }
  const count = Math.min(want, remaining || want);

  const plan = [];
  let inventory = scenario.sku.inventory;
  let stockoutDays = 0;
  for (let i = 0; i < count; i++) {
    const dayIndex = scenario.cursor_day + i;
    const out = dayPlan(scenario, dayIndex, { inventoryStart: inventory });
    inventory = out.inventoryEnd;
    if (out.stockout) stockoutDays += 1;
    plan.push(out);
  }
  const allEvents = plan.flatMap((p) => p.events);
  const ledger = plan.map((p) => p.row);
  const totals = sumRows(ledger, scenario.totals, stockoutDays);

  if (dryRun) {
    return { scenario, dryRun: true, wouldIngest: allEvents.length, ledger, totals, wrote: false };
  }

  /* the SAME pipeline: chunked at 400 (ingestBatch caps caller batches at 500) */
  const results = { count: 0, created: 0, duplicates: 0, ids: [] };
  for (let i = 0; i < allEvents.length; i += 400) {
    const batch = events.ingestBatch(allEvents.slice(i, i + 400), { sellerId: scenario.seller_id, source: SOURCE, actor: `simulator:${scenario.scenario_id}` });
    results.count += batch.count; results.created += batch.created; results.duplicates += batch.duplicates;
    for (const ev of batch.events || []) if (ev?.event_id) results.ids.push(ev.event_id);
  }

  scenario.cursor_day += count;
  scenario.ledger = [...scenario.ledger, ...ledger].slice(-400);
  scenario.totals = totals;
  scenario.event_ids = [...scenario.event_ids, ...results.ids].slice(-5000);
  scenario.runs += 1;
  scenario.last_run_at = at ? new Date(at).toISOString() : new Date().toISOString();
  scenario.status = scenario.cursor_day >= horizon ? 'DONE' : 'RUNNING';
  scenario.inventoryNow = inventory;

  const runRow = {
    run_id: `SR-${(d.simRuns || []).length + 1}`,
    scenario_id: id,
    seller_id: scenario.seller_id,
    listing_id: scenario.listing_id,
    days: count,
    from_day: scenario.cursor_day - count + 1,
    to_day: scenario.cursor_day,
    seed: scenario.seed,
    params_fingerprint: scenario.params_fingerprint,
    ledger: { from: ledger[0]?.date, to: ledger[ledger.length - 1]?.date },
    events: results,
    totals,
    at: scenario.last_run_at,
    actor,
    simulated: true,
    label: scenarioModel.LABEL,
  };
  d.simRuns.push(runRow);
  if (d.simRuns.length > 500) d.simRuns.splice(0, d.simRuns.length - 500);
  save();

  logEvent('scenario.run', {
    scenarioId: id, days: count, seed: scenario.seed, fingerprint: scenario.params_fingerprint,
    events: results.created, cursorDay: scenario.cursor_day, actor, simulated: true,
  });
  save();

  return { scenario, run: runRow, ledger, ingested: results, totals };
}

/* -------------------------------- aggregates ------------------------------- */

function sumRows(rows, prev = scenarioModel.emptyTotals(), stockoutDays = 0) {
  const t = { ...prev };
  for (const r of rows) {
    t.views += r.views; t.clicks += r.clicks; t.orders += r.orders;
    t.cancelled += r.cancelled; t.shipped += r.shipped; t.delivered += r.delivered;
    t.returned += r.returned; t.rto += r.rto; t.kept += r.kept;
    t.unitsKept += r.kept; t.revenue += r.revenue; t.contribution += r.contribution;
    t.inventoryEnd = r.inventoryEnd;
  }
  t.stockoutDays += stockoutDays;
  t.views = Math.round(t.views); t.revenue = round2(t.revenue); t.contribution = round2(t.contribution);
  return t;
}

/** Metrics for a scenario, straight from its ledger (deterministic arithmetic). */
export function metrics(id) {
  const s = scenarioModel.get(id);
  const t = s.totals;
  const days = s.ledger.length;
  const placed = t.orders || 0;
  return {
    scenario_id: s.scenario_id,
    label: s.label,
    days_simulated: days,
    horizon_days: s.horizon_days,
    cursor_day: s.cursor_day,
    price: effectivePrice(s),
    base_price: s.sku.basePrice,
    floor: computeFloor(s.skuKey, { cs: s.sku.unitCost }).F,
    totals: t,
    rates: {
      ctrPct: t.views ? round2((t.clicks / t.views) * 100) : 0,
      cvrPct: t.clicks ? round2((placed / t.clicks) * 100) : 0,
      cancellationRatePct: placed ? round2((t.cancelled / placed) * 100) : 0,
      rtoRatePct: t.shipped ? round2((t.rto / t.shipped) * 100) : 0,
      returnRatePct: t.delivered ? round2((t.returned / t.delivered) * 100) : 0,
      keptRatePct: t.delivered ? round2((t.kept / t.delivered) * 100) : 0,
      contributionPerKeptOrder: t.kept ? round2(t.contribution / t.kept) : 0,
      inventoryVelocityUnitsPerDay: days ? round2(t.unitsKept / days) : 0,
      sellThroughPct: s.sku.inventory ? round2((t.unitsKept / s.sku.inventory) * 100) : 0,
    },
    inventory: {
      start: Math.round(s.sku.inventory),
      end: t.inventoryEnd,
      unitsKept: t.unitsKept,
      stockoutDays: t.stockoutDays,
      daysOfCover: t.unitsKept && days ? round2((t.inventoryEnd ?? 0) / (t.unitsKept / days)) : null,
    },
    provenance: {
      source: SOURCE,
      seed: s.seed,
      params_fingerprint: s.params_fingerprint,
      label: s.label,
      note: 'Every event this scenario generated is labelled source: "simulator" in the same event stream the real product reads.',
    },
  };
}

/**
 * The honesty check: the simulator's own ledger vs what the pipeline actually
 * ingested for this scenario. A mismatch means the two disagree - which would be
 * a bug worth seeing, not a rounding detail to hide.
 */
export function reconcile(id) {
  const s = scenarioModel.get(id);
  const counted = scenarioModel.emptyTotals();
  let missing = 0;
  for (const eventId of s.event_ids) {
    const e = events.eventById(eventId);
    if (!e) { missing += 1; continue; }
    const p = e.payload || {};
    switch (e.event_type) {
      case 'VIEW_RECORDED': counted.views += p.views || 0; counted.clicks += p.clicks || 0; break;
      case 'ORDER_PLACED': counted.orders += p.units || 1; break;
      case 'ORDER_CANCELLED': counted.cancelled += p.units || 1; break;
      case 'ORDER_SHIPPED': counted.shipped += p.units || 1; break;
      case 'ORDER_DELIVERED': counted.delivered += p.units || 1; break;
      case 'ORDER_RETURNED': counted.returned += p.units || 1; break;
      case 'ORDER_RTO': counted.rto += p.units || 1; break;
      default: break;
    }
  }
  counted.kept = counted.delivered - counted.returned;
  const ledger = { views: s.totals.views, clicks: s.totals.clicks, orders: s.totals.orders, cancelled: s.totals.cancelled, shipped: s.totals.shipped, delivered: s.totals.delivered, returned: s.totals.returned, rto: s.totals.rto, kept: s.totals.kept };
  const ingested = { views: counted.views, clicks: counted.clicks, orders: counted.orders, cancelled: counted.cancelled, shipped: counted.shipped, delivered: counted.delivered, returned: counted.returned, rto: counted.rto, kept: counted.kept };
  const deltas = {};
  for (const k of Object.keys(ledger)) if (ledger[k] !== ingested[k]) deltas[k] = ingested[k] - ledger[k];
  return {
    scenario_id: id,
    tracked_events: s.event_ids.length,
    untracked: s.event_ids.length >= 5000 ? 'the id list is capped at 5,000: older events are still in the pipeline, they are just no longer listed here' : null,
    missing,
    ledger,
    ingested,
    deltas,
    matches: Object.keys(deltas).length === 0 && missing === 0,
    note: 'ledger = what the simulator decided to generate; ingested = what the pipeline actually stored. They must match.',
  };
}

/** Inspect the events a scenario generated (optionally one day). */
export function generatedEvents(id, { day = null, limit = 200 } = {}) {
  const s = scenarioModel.get(id);
  const ids = s.event_ids.slice(-limit);
  const rows = ids.map((e) => events.eventById(e)).filter(Boolean);
  const filtered = day == null ? rows : rows.filter((e) => {
    const start = Date.parse(s.start_at);
    return Math.floor((Date.parse(e.timestamp) - start) / DAY) + 1 === day;
  });
  return {
    scenario_id: id,
    day,
    count: filtered.length,
    by_type: filtered.reduce((acc, e) => ({ ...acc, [e.event_type]: (acc[e.event_type] || 0) + 1 }), {}),
    events: filtered.slice(-limit).map((e) => ({ event_id: e.event_id, event_type: e.event_type, timestamp: e.timestamp, source: e.source, payload: e.payload })),
    note: 'These are real rows in the unified event stream (source: "simulator"), not a private simulation log.',
  };
}

/* --------------------------------- helpers -------------------------------- */

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round2 = (x) => Math.round(x * 100) / 100;

export { round2, fingerprintOf, DAY, GUARDRAILS };
