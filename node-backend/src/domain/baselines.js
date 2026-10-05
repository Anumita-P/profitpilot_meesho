/**
 * BASELINE COMPARISON (v2 phase 10).
 *
 * "Would this actually have been better than what I do anyway?"
 *
 * Three strategies, one environment:
 *
 *   A  STATIC PRICE          - set it once, never touch it
 *   B  RULE-BASED DISCOUNT   - a simple, public rule: if the listing is not selling
 *                              through, cut 5% (never below the floor + a minimum
 *                              margin), at most twice a month
 *   C  FULL ENGINE           - the decision loop: diagnosis first, counterfactuals
 *                              when price is the bottleneck, guardrails on every
 *                              move, hold when the evidence says hold
 *
 * All three run over the SAME simulated environment: same listing, same SKU
 * parameters, same seed, same horizon, same market, and the same day-level random
 * draws (the simulator's RNG is keyed on seed + listing + day, so every strategy
 * faces the identical demand sequence). Only the pricing policy differs.
 *
 * The comparison runs IN MEMORY on `market.dayPlan()` - the same function the
 * simulator uses - and deliberately does NOT ingest its events into the store: a
 * comparison study must not contaminate the seller's live signals, and the engine's
 * own diagnosis has to keep reading the seller's real data. Each strategy's
 * scenario is stored (so the environment is inspectable and resettable) but it
 * ingests nothing.
 *
 * One consequence, stated rather than hidden: because the number of orders differs
 * per strategy, the *operational* sampling (which order gets returned, which parcel
 * is refused) consumes a different number of draws - more orders means more
 * chances for a return, which is realistic. The demand draw for a given day is
 * identical across strategies, so the comparison is not comparing two weathers.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO:
 *   - it does not manufacture a win. If C loses on a metric, the row says so.
 *   - it does not claim significance. One deterministic run per strategy is one
 *     observation: `significance` is reported as 'not established' and repeated
 *     runs are the only honest way to talk about noise.
 *   - it does not let a strategy bypass the floor. B and C both go through the
 *     same preflight checks; a blocked move is counted and reported.
 */

import { listing, hydrate, load, save } from '../store/db.js';
import { computeFloor } from '../engine/floor.js';
import { preflight } from '../engine/guardrails.js';
import { ordersPerDay } from '../engine/demand.js';
import { GUARDRAILS } from '../config/deck.js';
import * as market from '../sim/market.js';
import { clearSandbox } from '../sim/lab.js';
import * as scenarios from '../sim/scenario.js';
import * as events from '../domain/events.js';
import * as bottleneck from '../domain/bottleneck.js';
import * as counterfactual from '../domain/counterfactual.js';
import * as inventory from '../domain/inventory.js';
import { versionSet } from '../domain/versions.js';

export const STRATEGIES = [
  { key: 'A', name: 'Static price', note: 'the price is set once and never touched' },
  { key: 'B', name: 'Rule-based discount', note: 'sell-through below target -> cut 5%, floor and a minimum margin respected, at most 2 moves per month', rule: 'if sell_through < 45% and days_since_move >= 15 and moves_this_month < 2 -> price -5%, but never below floor + ₹15 per kept order' },
  { key: 'C', name: 'Full engine', note: 'diagnosis first, counterfactuals when price is the bottleneck, guardrails on every move', rule: 're-decide every 5 days: diagnose -> if price is the lever, take the best eligible counterfactual candidate; if not, hold' },
];

export const METRICS = [
  ['revenue', 'revenue over the horizon'],
  ['contribution', 'contribution over the horizon (the seller-economic objective)'],
  ['kept_orders', 'kept orders'],
  ['conversion_pct', 'orders / views'],
  ['return_rate_pct', 'returns / delivered'],
  ['rto_rate_pct', 'RTO / dispatched'],
  ['cancellations', 'cancelled orders'],
  ['inventory_velocity', 'kept units per day'],
  ['price_changes', 'number of price changes'],
  ['average_price_movement_pct', 'average size of each price move'],
  ['guardrail_blocks', 'moves refused by the guardrails'],
];

const round2 = (x) => Math.round(x * 100) / 100;

/**
 * Run one strategy over the simulated environment.
 * @param {object} env { listingId, days, seed, horizonDays }
 * @param {object} strategy one of STRATEGIES
 */
export function runStrategy(env, strategy) {
  const { listingId, days, seed, horizonDays = 30 } = env;
  const raw = listing(listingId);
  const L = hydrate(raw);
  const floor = computeFloor(raw.skuKey, raw.costOverrides || {});
  const d = load();

  /* one scenario per (environment, strategy): created once, reset before each run */
  const name = `Baseline ${strategy.key} - ${strategy.name}`;
  let scenario = (d.scenarios || []).find((s) => s.baseline_key === strategy.key && s.listing_id === listingId && s.seed === seed && s.horizon_days === days);
  if (scenario) {
    const ids = (d.simRuns || []).filter((r) => r.scenario_id === scenario.scenario_id).flatMap((r) => r.events?.ids || []);
    events.removeEvents({ ids, listingId, reason: `baseline ${strategy.key} re-run` });
    scenarios.reset(scenario.scenario_id, { reason: `baseline ${strategy.key}: cleared for a fresh run`, params: false });
  } else {
    scenario = scenarios.create({
      name, listing_id: listingId, skuKey: raw.skuKey, seed, horizon_days: days,
      notes: `baseline comparison strategy ${strategy.key}: ${strategy.note}`,
    }, { sellerId: raw.sellerId, actor: 'baseline' });
    scenario.baseline_key = strategy.key;
    scenario.baseline_name = strategy.name;
    save();
  }

  /* the strategy's own price policy: a function of the day and the state so far */
  scenario.sku.basePrice = raw.price;
  scenario.baseline_key = strategy.key;
  scenario.ingests_events = false;
  save();

  const book = { price: raw.price, moves: [], blocks: [], lastMoveDay: -99, movesThisMonth: 0, monthStartDay: 0 };
  const plan = [];
  let price = raw.price;
  let inventoryUnits = scenario.sku.inventory;

  for (let day = 0; day < days; day++) {
    /* --- the policy decides the price for THIS day ------------------------- */
    let target = price;
    if (strategy.key === 'B') {
      const soldSoFar = plan.reduce((a, r) => a + r.kept, 0);
      const sellThrough = scenario.sku.inventory ? (soldSoFar / scenario.sku.inventory) * 100 : 100;
      const monthMoves = book.moves.filter((m) => m.day >= book.monthStartDay).length;
      if (sellThrough < 45 && day - book.lastMoveDay >= 15 && monthMoves < 2) {
        target = Math.round(price * 0.95);
        const minPrice = floor.F + 15;
        if (target < minPrice) target = Math.ceil(minPrice);
      }
    } else if (strategy.key === 'C' && (day === 0 || day % 5 === 0)) {
      /* the engine: diagnose, then act only if price is the lever */
      const inv = inventory.stateOf(listingId);
      const diag = bottleneck.analyse(listingId, { inventoryState: inv });
      if (diag.price_action === 'EVALUATE') {
        const cf = counterfactual.grid(listingId, { horizonDays });
        const rec = cf.recommendation;
        if (rec && rec.price_action !== 'HOLD') {
          const span = (rec.candidate - price) / price;
          const stepped = Math.abs(span) > GUARDRAILS.maxStepPct / 100
            ? Math.round(price * (1 + Math.sign(span) * GUARDRAILS.maxStepPct / 100))
            : rec.candidate;
          target = stepped;
        }
      }
    }

    /* --- the guardrails apply to EVERY strategy that moves a price --------- */
    if (target !== price) {
      const checks = preflight({
        floor, from: price, to: target,
        views: plan.length ? Math.round(plan[plan.length - 1].views * 7) : (L.signals.views || 0),   // weekly-view proxy for the 1,000-view sanity rule
        daysSinceMove: day - book.lastMoveDay, movesThisMonth: book.moves.filter((m) => m.day >= book.monthStartDay).length,
        consent: false,
      });
      const blocking = checks.checks.filter((c) => !c.ok);
      if (blocking.length) {
        book.blocks.push({ day, from: price, to: target, blocked_by: blocking.map((c) => c.key), detail: blocking.map((c) => `${c.key}: ${c.detail}`) });
        target = price;                                             // the move does not happen
      } else {
        book.moves.push({ day, from: price, to: target, delta_pct: round2(((target - price) / price) * 100), by: strategy.key });
        book.lastMoveDay = day;
        price = target;
      }
    }

    /* --- the day loop, with the same demand/risk model as the simulator ---- */
    scenario.sku.basePrice = price;
    const out = market.dayPlan(scenario, day, { inventoryStart: inventoryUnits });
    inventoryUnits = out.inventoryEnd;
    plan.push({ ...out.row, price, strategy: strategy.key });
    scenario.sku.basePrice = raw.price;                              // restore for the next decision
  }

  /* the ledger IS the result: no ingestion, so nothing leaks into the seller's
     live signals (the scenario is stored for inspection and reset) */
  const ledger = plan;
  const totals = ledger.reduce((t, r) => ({
    views: t.views + r.views, clicks: t.clicks + r.clicks, orders: t.orders + r.orders,
    cancelled: t.cancelled + r.cancelled, shipped: t.shipped + r.shipped, delivered: t.delivered + r.delivered,
    returned: t.returned + r.returned, rto: t.rto + r.rto, kept: t.kept + r.kept,
    revenue: round2(t.revenue + (r.revenue || 0)), contribution: round2(t.contribution + (r.contribution || 0)),
    inventoryEnd: r.inventoryEnd, price: r.price,
  }), { views: 0, clicks: 0, orders: 0, cancelled: 0, shipped: 0, delivered: 0, returned: 0, rto: 0, kept: 0, revenue: 0, contribution: 0, inventoryEnd: inventoryUnits, price: raw.price });

  const dispatched = totals.delivered + totals.rto;
  const moves = book.moves;
  return {
    strategy: strategy.key,
    name: strategy.name,
    note: strategy.note,
    rule: strategy.rule || null,
    scenario_id: scenario.scenario_id,
    environment: { listing_id: listingId, sku: raw.skuKey, seed, days, floor: floor.F, start_price: raw.price },
    metrics: {
      revenue: totals.revenue,
      contribution: totals.contribution,
      kept_orders: totals.kept,
      conversion_pct: totals.views ? round2((totals.orders / totals.views) * 100) : 0,
      return_rate_pct: totals.delivered ? round2((totals.returned / totals.delivered) * 100) : 0,
      rto_rate_pct: dispatched ? round2((totals.rto / dispatched) * 100) : 0,
      cancellations: totals.cancelled,
      inventory_velocity: round2(totals.kept / days),
      price_changes: moves.length,
      average_price_movement_pct: moves.length ? round2(moves.reduce((a, m) => a + Math.abs(m.delta_pct), 0) / moves.length) : 0,
      guardrail_blocks: book.blocks.length,
    },
    price_path: ledger.map((r) => ({ day: r.day ?? null, date: r.date, price: r.price })),
    moves,
    blocks: book.blocks,
    simulated: true,
    label: 'SIMULATED - deterministic day loop, illustrative parameters',
  };
}

/**
 * Compare the three strategies over one environment.
 * @param {object} opts { listingId, days, seed, horizonDays, strategies }
 */
export function compare({ listingId = 'L-kurti', days = 30, seed = 7, horizonDays = 30, strategies = ['A', 'B', 'C'] } = {}) {
  /* Same starting point for every strategy: the simulator's own footprint on this
     listing is cleared and the feature fold rebuilt before any strategy runs. The
     seller's real events are untouched. */
  const sandbox = clearSandbox(listingId);
  const wanted = STRATEGIES.filter((s) => strategies.includes(s.key));
  const runs = wanted.map((s) => runStrategy({ listingId, days, seed, horizonDays }, s));
  const baseline = runs.find((r) => r.strategy === 'A') || runs[0];

  const table = [];
  for (const run of runs) {
    for (const [metric, label] of METRICS) {
      const value = run.metrics[metric];
      const base = baseline.metrics[metric];
      table.push({
        strategy: run.strategy,
        strategy_name: run.name,
        metric,
        metric_label: label,
        value,
        delta_vs_baseline: round2(value - base),
        delta_pct_vs_baseline: base ? round2(((value - base) / Math.abs(base)) * 100) : null,
      });
    }
  }

  const headline = [];
  for (const run of runs.filter((r) => r.strategy !== 'A')) {
    const c = run.metrics.contribution; const b = baseline.metrics.contribution;
    const delta = round2(c - b);
    headline.push({
      strategy: run.strategy,
      name: run.name,
      contribution_delta_vs_static: delta,
      contribution_delta_pct: b ? round2((delta / Math.abs(b)) * 100) : null,
      kept_orders_delta: run.metrics.kept_orders - baseline.metrics.kept_orders,
      price_changes: run.metrics.price_changes,
      guardrail_blocks: run.metrics.guardrail_blocks,
      reading: delta > 0
        ? `${run.name} produced ₹${delta} more contribution than a static price over ${days} simulated days, with ${run.metrics.price_changes} price change(s)`
        : delta < 0
          ? `${run.name} produced ₹${Math.abs(delta)} LESS contribution than doing nothing - reported as it is, not hidden`
          : `${run.name} matched a static price on contribution`,
    });
  }

  return {
    label: 'SIMULATED - illustrative, deterministic',
    as_of: new Date().toISOString(),
    environment: { listing_id: listingId, days, seed, note: 'all strategies ran the same day loop, the same demand and risk models, and the same seed' },
    sandbox: { cleared_events: sandbox.events_removed, note: 'the simulator sandbox was cleared first so every strategy started from the listing as it really is; the seller\'s own events were not touched' },
    strategies: runs.map((r) => ({ strategy: r.strategy, name: r.name, note: r.note, rule: r.rule || null, scenario_id: r.scenario_id, metrics: r.metrics, moves: r.moves.length, blocks: r.blocks.length })),
    baseline: 'A (static price)',
    table,
    headline,
    price_paths: runs.map((r) => ({ strategy: r.strategy, path: r.price_path })),
    guardrail_blocks: runs.flatMap((r) => r.blocks.map((b) => ({ strategy: r.strategy, ...b }))),
    honesty: {
      runs_per_strategy: 1,
      significance: 'not established',
      statement: 'One deterministic run per strategy over the same environment. That is one observation, not a sample: no significance is claimed, and a single run cannot separate the effect of the strategy from the effect of the seed. Repeated runs (different seeds) are the honest way to talk about noise.',
      no_hidden_advantage: 'Every strategy faced the same demand curve, the same operational risks, the same seed and the same guardrails. The engine (C) had no information the others lacked - it simply reacts to the diagnosis.',
      floor_respected: `Every strategy is subject to the same hard floor (₹${baseline.environment.floor} for ${listingId}) and the ±${GUARDRAILS.maxStepPct}% step rule; a blocked move is counted, not silently applied.`,
    },
    versions: versionSet(),
  };
}
