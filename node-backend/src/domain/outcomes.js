/**
 * CLOSED-LOOP OUTCOME CALCULATOR (phase 2).
 *
 * Answers the only question that matters after a price move:
 *
 *   "Did this actually improve seller economics without damaging customer quality?"
 *
 * Engineering rules:
 *   - PRIMARY METRIC is aligned with the deck's economics, not with revenue:
 *     contribution per KEPT order and total contribution (kept orders only),
 *     plus profit per impression - the north star on slide 9. Revenue is
 *     reported for context and never used to call a win.
 *   - EVERY NUMBER COMES FROM EVENTS. If the window has too little data the
 *     calculator says so (`insufficient: true`) and returns NO verdict. It never
 *     invents significance.
 *   - The baseline is the window of the same length immediately before the
 *     change, measured from the same event stream. When there is no observed
 *     baseline, it falls back to the listing's modelled signals and LABELS that
 *     (`baselineSource: 'modelled-from-seed'`) so nobody mistakes it for
 *     measured behaviour.
 *   - Customer quality is a guardrail, not a tiebreak: a cheaper price that
 *     raises returns (or cancellation / RTO rate) cannot be called a win.
 */

import { load, listing, logEvent, httpError, save } from '../store/db.js';
import { computeFloor } from '../engine/floor.js';
import { rng } from '../engine/bandit.js';

export const PRIMARY_METRIC = 'contribution_per_kept_order';
export const PRIMARY_METRIC_LABEL = 'Contribution per kept order';
export const QUALITY_GUARDRAILS = {
  maxReturnRateIncreasePp: 1.0,      // returns may not get worse by more than 1 pp
  maxRtoRateIncreasePp: 1.0,
  maxCancellationRateIncreasePp: 1.0,
  maxCvrDropPp: 2.0,                 // deck slide 8: "buyer conversion > 5% below holdout at a similar price -> pause"
};
export const WIN_THRESHOLD_PCT = 2;  // +2% on the primary metric, with quality intact
/* Minimum evidence before a verdict is allowed. The deck judges on orders at
   day 14 and confirms on kept orders at day 28 (return-window lag), so a window
   shorter than a week is never given a verdict - it reports "too early". */
export const MIN_EVIDENCE = { keptOrders: 5, views: 500, days: 7 };

const r2 = (x) => Math.round(x * 100) / 100;

/* ------------------------------ aggregation ------------------------------- */

/**
 * Fold the ingested event stream into comparable metrics for one window.
 * @param {string} listingId
 * @param {{from?:string,to?:string,days?:number}} window
 */
export function metricsFor(listingId, window = {}) {
  const L = listing(listingId);
  const d = load();
  const to = window.to ? new Date(window.to) : new Date();
  const from = window.from ? new Date(window.from)
    : new Date(to.getTime() - (window.days ?? 14) * 86400000);
  const floor = computeFloor(L.skuKey, L.costOverrides || {});
  const events = (d.ingestedEvents || []).filter((e) => e.listing_id === listingId
    && new Date(e.timestamp) >= from && new Date(e.timestamp) <= to);

  const m = {
    window: { from: from.toISOString(), to: to.toISOString(), days: Math.max(1, Math.round((to - from) / 86400000)) },
    events: events.length,
    views: 0, clicks: 0, placed: 0, cancelled: 0, shipped: 0, delivered: 0, returned: 0, rto: 0,
    units: 0, unitsReturned: 0, unitsRto: 0,
    revenue: 0, deliveredValue: 0, returnCost: 0, rtoCost: 0,
    reasonCodes: {},
  };
  for (const e of events) {
    const p = e.payload || {};
    switch (e.event_type) {
      case 'VIEW_RECORDED': m.views += p.views || 0; m.clicks += p.clicks || 0; break;
      case 'ORDER_PLACED': m.placed += 1; m.units += p.units || 1; m.revenue += (p.orderValue != null ? p.orderValue : L.price) * (p.units || 1); break;
      case 'ORDER_CANCELLED': m.cancelled += 1; break;
      case 'ORDER_SHIPPED': m.shipped += 1; break;
      case 'ORDER_DELIVERED': m.delivered += 1; m.deliveredValue += (p.orderValue != null ? p.orderValue : L.price) * (p.units || 1); break;
      case 'ORDER_RETURNED':
        m.returned += 1; m.unitsReturned += p.units || 1;
        m.returnCost += p.returnCost != null ? p.returnCost : 0;
        if (p.reasonCode) m.reasonCodes[p.reasonCode] = (m.reasonCodes[p.reasonCode] || 0) + 1;
        break;
      case 'ORDER_RTO': m.rto += 1; m.unitsRto += p.units || 1; m.rtoCost += p.rtoCost != null ? p.rtoCost : 0; break;
      default: break;
    }
  }

  const dispatched = m.shipped || (m.delivered + m.returned + m.rto);
  const keptOrders = Math.max(0, m.delivered - m.returned);
  const keptUnits = Math.max(0, m.delivered - m.unitsReturned);
  const avgKeptPrice = keptOrders > 0 ? m.deliveredValue / Math.max(1, m.delivered) : (L.price);
  const contributionPerKeptOrder = keptOrders > 0 ? avgKeptPrice - floor.F : 0;
  const totalContribution = keptOrders > 0 ? keptOrders * contributionPerKeptOrder : 0;

  return {
    ...m,
    floorF: floor.F,
    keptRatePct: floor.k * 100,
    dispatched,
    keptOrders,
    keptUnits,
    avgKeptPrice: r2(avgKeptPrice),
    contributionPerKeptOrder: r2(contributionPerKeptOrder),
    totalContribution: r2(totalContribution),
    profitPerImpression: m.views > 0 ? Math.round(totalContribution / m.views * 100000) / 100000 : null,
    cvrPct: m.views > 0 ? r2(m.placed / m.views * 100) : null,
    cancellationRatePct: m.placed > 0 ? r2(m.cancelled / m.placed * 100) : null,
    returnRatePct: dispatched > 0 ? r2(m.returned / dispatched * 100) : null,
    rtoRatePct: dispatched > 0 ? r2(m.rto / dispatched * 100) : null,
    keptRateOfDispatchedPct: dispatched > 0 ? r2((dispatched - m.returned - m.rto) / dispatched * 100) : null,
    inventoryVelocityUnitsPerDay: r2((m.delivered + m.unitsReturned + m.unitsRto) / m.window.days),
  };
}

/* -------------------------------- baseline -------------------------------- */

/** The same-length window immediately before `from`. */
export function baselineWindow(window) {
  const from = new Date(window.from);
  const days = window.days || Math.round((new Date(window.to) - from) / 86400000) || 14;
  const baseTo = new Date(from.getTime() - 1);
  const baseFrom = new Date(baseTo.getTime() - days * 86400000);
  return { from: baseFrom.toISOString(), to: baseTo.toISOString(), days };
}

/**
 * Baseline metrics: the observed pre-window when it has enough events, otherwise
 * the listing's modelled signals - clearly labelled either way.
 */
export function baselineFor(listingId, window, opts = {}) {
  const b = baselineWindow(window);
  const observed = metricsFor(listingId, b);
  if (observed.delivered + observed.placed >= MIN_EVIDENCE.keptOrders) {
    return { ...observed, source: 'observed', note: 'measured from the ingested event stream before the change' };
  }
  const L = listing(listingId);
  const floor = computeFloor(L.skuKey, L.costOverrides || {});
  const days = b.days;
  const ordersPerDay = L.signals.q0 || L.stock?.dailyUnits || 1;
  const placed = Math.round(ordersPerDay * days);
  const dispatched = Math.round(placed * 0.97);
  const rto = Math.round(dispatched * (L.signals.rtoPct || 8) / 100);
  const delivered = dispatched - rto;
  const returned = Math.round(delivered * (L.signals.returnsPct || floor.ret) / 100);
  const keptOrders = Math.max(0, delivered - returned);
  // A baseline for a PRICE change must be modelled at the price that was live
  // before the change, otherwise a price move would be compared with itself and
  // always look like a 0% delta. Callers pass the pre-change price; the price
  // used is always reported back so a reader can see exactly what was modelled.
  const avgPrice = opts.price != null ? opts.price : L.price;
  return {
    window: { ...b },
    events: 0,
    source: 'modelled-from-seed',
    modelledAtPrice: avgPrice,
    modelledAt: `${avgPrice === L.price ? 'current price' : `the price before the change (₹${avgPrice}); live price is ₹${L.price}`}`,
    note: 'not enough ingested events before the change: this baseline is modelled from the listing\'s own signals (labelled, never presented as measured)',
    views: Math.round((L.signals.views || 0) * days / 7),
    clicks: null, placed, cancelled: 0, shipped: dispatched, delivered, returned, rto,
    units: placed, unitsReturned: returned, unitsRto: rto,
    revenue: placed * avgPrice, deliveredValue: delivered * avgPrice, returnCost: 0, rtoCost: 0,
    reasonCodes: {},
    floorF: floor.F,
    keptRatePct: floor.k * 100,
    dispatched, keptOrders, keptUnits: keptOrders,
    avgKeptPrice: r2(avgPrice),
    contributionPerKeptOrder: r2(avgPrice - floor.F),
    totalContribution: r2(keptOrders * (avgPrice - floor.F)),
    profitPerImpression: null,
    cvrPct: null,
    cancellationRatePct: null,
    returnRatePct: r2(returned / Math.max(1, dispatched) * 100),
    rtoRatePct: r2(rto / Math.max(1, dispatched) * 100),
    keptRateOfDispatchedPct: r2(keptOrders / Math.max(1, dispatched) * 100),
    inventoryVelocityUnitsPerDay: r2((delivered + returned + rto) / days),
  };
}

/* -------------------------------- comparison ------------------------------ */

export function compare(after, before) {
  const delta = (k) => (after[k] == null || before[k] == null ? null : r2(after[k] - before[k]));
  const pct = (k) => (after[k] == null || before[k] == null || before[k] === 0 ? null
    : Math.round((after[k] - before[k]) / Math.abs(before[k]) * 10000) / 100);
  return {
    primary: {
      metric: PRIMARY_METRIC,
      label: PRIMARY_METRIC_LABEL,
      before: before.contributionPerKeptOrder,
      after: after.contributionPerKeptOrder,
      delta: delta('contributionPerKeptOrder'),
      deltaPct: pct('contributionPerKeptOrder'),
    },
    totalContribution: { before: before.totalContribution, after: after.totalContribution, delta: delta('totalContribution'), deltaPct: pct('totalContribution') },
    keptOrders: { before: before.keptOrders, after: after.keptOrders, delta: delta('keptOrders'), deltaPct: pct('keptOrders') },
    keptRatePct: { before: before.keptRateOfDispatchedPct, after: after.keptRateOfDispatchedPct, delta: delta('keptRateOfDispatchedPct') },
    profitPerImpression: { before: before.profitPerImpression, after: after.profitPerImpression, deltaPct: before.profitPerImpression ? pct('profitPerImpression') : null },
    context: {
      views: { before: before.views, after: after.views },
      ordersPlaced: { before: before.placed, after: after.placed },
      cvrPct: { before: before.cvrPct, after: after.cvrPct, delta: delta('cvrPct') },
      revenue: { before: before.revenue, after: after.revenue, deltaPct: pct('revenue'), note: 'context only: revenue is not the decision metric' },
      inventoryVelocityUnitsPerDay: { before: before.inventoryVelocityUnitsPerDay, after: after.inventoryVelocityUnitsPerDay },
    },
  };
}

/** Customer-quality guardrails: did the change make buyers worse off? */
export function qualityVerdict(after, before) {
  const checks = [
    { key: 'returns', label: 'Return rate', before: before.returnRatePct, after: after.returnRatePct, deltaPp: after.returnRatePct != null && before.returnRatePct != null ? r2(after.returnRatePct - before.returnRatePct) : null, limitPp: QUALITY_GUARDRAILS.maxReturnRateIncreasePp, note: 'a cheaper price must not buy orders with more returns' },
    { key: 'rto', label: 'RTO rate', before: before.rtoRatePct, after: after.rtoRatePct, deltaPp: after.rtoRatePct != null && before.rtoRatePct != null ? r2(after.rtoRatePct - before.rtoRatePct) : null, limitPp: QUALITY_GUARDRAILS.maxRtoRateIncreasePp, note: 'COD refusals rise when price falls (deck slide 2 box 3)' },
    { key: 'cancellations', label: 'Cancellation rate', before: before.cancellationRatePct, after: after.cancellationRatePct, deltaPp: after.cancellationRatePct != null && before.cancellationRatePct != null ? r2(after.cancellationRatePct - before.cancellationRatePct) : null, limitPp: QUALITY_GUARDRAILS.maxCancellationRateIncreasePp, note: 'orders that never ship cost packaging and rank' },
    { key: 'cvr', label: 'Conversion (CVR)', before: before.cvrPct, after: after.cvrPct, deltaPp: after.cvrPct != null && before.cvrPct != null ? r2(after.cvrPct - before.cvrPct) : null, limitPp: QUALITY_GUARDRAILS.maxCvrDropPp, invert: true, note: 'buyer conversion may not fall more than 2 pp (deck slide 8 guardrail)' },
  ].map((c) => ({ ...c, ok: c.deltaPp == null ? true : (c.invert ? c.deltaPp >= -c.limitPp : c.deltaPp <= c.limitPp) }));
  return { pass: checks.every((c) => c.ok), checks, breached: checks.filter((c) => !c.ok).map((c) => c.key) };
}

/* --------------------------------- verdict -------------------------------- */

/**
 * Compute the outcome for an applied recommendation.
 * @returns {{insufficient:boolean, reason?:string, verdict?:'WIN'|'NEUTRAL'|'LOSS', ...}}
 */
export function computeOutcome({ recommendation, window = null, requireEvidence = MIN_EVIDENCE } = {}) {
  const rec = typeof recommendation === 'string'
    ? (load().recommendations || []).find((r) => r.recommendation_id === recommendation)
    : recommendation;
  if (!rec) throw httpError(404, `unknown recommendation: ${recommendation}`);
  const applied = rec.applied?.at || rec.timestamps?.appliedAt;
  if (!applied) throw httpError(409, `recommendation ${rec.recommendation_id} was never applied: nothing to measure`);

  const to = window?.to || new Date().toISOString();
  const win = window?.from
    ? { from: window.from, to }
    : { from: applied, to, days: Math.max(1, Math.round((new Date(to) - new Date(applied)) / 86400000)) };

  const after = metricsFor(rec.listing_id, win);
  const before = baselineFor(rec.listing_id, after.window, { price: rec.price_before });
  const cmp = compare(after, before);
  const quality = qualityVerdict(after, before);

  const days = after.window.days;
  const shortEvidence = [];
  if (after.keptOrders < requireEvidence.keptOrders) shortEvidence.push(`kept orders ${after.keptOrders} < ${requireEvidence.keptOrders}`);
  if (after.views < requireEvidence.views) shortEvidence.push(`views ${after.views} < ${requireEvidence.views}`);
  if (after.events === 0) shortEvidence.push('no events in the window');

  if (days < (requireEvidence.days ?? MIN_EVIDENCE.days)) shortEvidence.push(`window ${days}d < ${requireEvidence.days ?? MIN_EVIDENCE.days}d`);

  if (shortEvidence.length) {
    return {
      insufficient: true,
      reason: `Not enough evidence to judge yet: ${shortEvidence.join('; ')}.`,
      window: after.window,
      daysElapsed: days,
      observed: { after: { keptOrders: after.keptOrders, views: after.views, events: after.events } },
      primary: cmp.primary,
      quality,
      baselineSource: before.source,
      nextCheck: 'the scheduler re-checks every tick until the window has enough evidence',
    };
  }

  const dPct = cmp.primary.deltaPct;
  let verdict = 'NEUTRAL';
  if (dPct != null && dPct >= WIN_THRESHOLD_PCT) verdict = 'WIN';
  if (dPct != null && dPct <= -WIN_THRESHOLD_PCT) verdict = 'LOSS';
  if (verdict === 'WIN' && !quality.pass) verdict = 'NEUTRAL';   // cheaper orders with worse returns is not a win

  return {
    insufficient: false,
    verdict,
    verdictWhy: verdict === 'WIN'
      ? `contribution per kept order ${cmp.primary.deltaPct}% (>= +${WIN_THRESHOLD_PCT}%) and customer quality intact`
      : verdict === 'LOSS'
        ? `contribution per kept order ${cmp.primary.deltaPct}% (<= -${WIN_THRESHOLD_PCT}%)`
        : !quality.pass
          ? `the metric moved but customer quality breached: ${quality.breached.join(', ')}`
          : `contribution per kept order ${cmp.primary.deltaPct}% is inside the +-${WIN_THRESHOLD_PCT}% neutral band`,
    window: after.window,
    daysElapsed: days,
    primary: cmp.primary,
    measures: cmp,
    quality,
    metrics: { after, before },
    baselineSource: before.source,
    evidence: {
      keptOrders: after.keptOrders,
      views: after.views,
      events: after.events,
      source: 'ingested event stream',
    },
    note: 'Contribution is kept-order economics (price - return-adjusted floor per kept order), not revenue. Nothing here is extrapolated beyond the observed window.',
  };
}

/* --------------------------- demo event generator ------------------------- */

/**
 * Deterministically generate the kind of event stream a real pipe would push,
 * so the demo can show the loop closing. SIMULATED, and labelled as such
 * everywhere it is used: `source: 'simulator'` on every event.
 *
 * @param {object} opts { listingId, from, to, days, seed, ordersPerDayMultiplier, returnRateDeltaPp, push }
 */
export function simulateEventStream({
  listingId, from, days = 14, seed = 7, viewsPerDay = null, ordersPerDayMultiplier = 1,
  returnRatePctDelta = 0, rtoRatePctDelta = 0, source = 'simulator', push = true,
} = {}) {
  const L = listing(listingId);
  const floor = computeFloor(L.skuKey, L.costOverrides || {});
  const start = from ? new Date(from) : new Date();
  const random = rng(seed);
  const baseOrders = (L.signals.q0 || L.stock?.dailyUnits || 1) * ordersPerDayMultiplier;
  const views = viewsPerDay ?? Math.max(50, Math.round((L.signals.views || 1000) / 7 * (ordersPerDayMultiplier ** 0.5)));
  const retRate = Math.max(0, (L.signals.returnsPct || floor.ret) + returnRatePctDelta) / 100;
  const rtoRate = Math.max(0, (L.signals.rtoPct || floor.rto) + rtoRatePctDelta) / 100;
  const out = [];
  for (let day = 0; day < days; day++) {
    const ts = new Date(start.getTime() + day * 86400000).toISOString();
    const dailyViews = Math.round(views * (0.85 + random() * 0.3));
    out.push({ event_type: 'VIEW_RECORDED', listing_id: listingId, timestamp: ts, source, payload: { views: dailyViews, clicks: Math.round(dailyViews * 0.041) } });
    const placed = Math.max(0, Math.round(baseOrders * (0.85 + random() * 0.3)));
    for (let i = 0; i < placed; i++) {
      const t = new Date(start.getTime() + day * 86400000 + i * 60000).toISOString();
      const cancelled = random() < 0.03;
      const cod = random() < (L.signals.codShare ?? 0.5);
      out.push({ event_type: 'ORDER_PLACED', listing_id: listingId, timestamp: t, source, payload: { units: 1, orderValue: L.price, paymentMode: cod ? 'cod' : 'prepaid' } });
      if (cancelled) { out.push({ event_type: 'ORDER_CANCELLED', listing_id: listingId, timestamp: t, source, payload: { units: 1, reason: 'buyer changed mind' } }); continue; }
      out.push({ event_type: 'ORDER_SHIPPED', listing_id: listingId, timestamp: t, source, payload: { units: 1 } });
      const rto = random() < rtoRate;
      if (rto) { out.push({ event_type: 'ORDER_RTO', listing_id: listingId, timestamp: t, source, payload: { units: 1, orderValue: L.price, rtoCost: Math.round(floor.Crto / Math.max(1, Math.round(floor.rtoN / 7)) ) || 60 } }); continue; }
      out.push({ event_type: 'ORDER_DELIVERED', listing_id: listingId, timestamp: t, source, payload: { units: 1, orderValue: L.price } });
      if (random() < retRate) {
        out.push({ event_type: 'ORDER_RETURNED', listing_id: listingId, timestamp: t, source, payload: { units: 1, orderValue: L.price, reasonCode: ['size', 'damage', 'quality', 'not as described'][Math.floor(random() * 4)], returnCost: 32 } });
      }
    }
  }
  if (!push) return out;
  /* The API caps a caller-supplied batch at 500; an internal simulator slice of
     a longer window simply pushes several batches. */
  const { ingestBatch } = require_events();
  const results = { count: 0, created: 0, duplicates: 0 };
  for (let i = 0; i < out.length; i += 400) {
    const batch = ingestBatch(out.slice(i, i + 400), { sellerId: L.sellerId, source, actor: 'simulator' });
    results.count += batch.count; results.created += batch.created; results.duplicates += batch.duplicates;
  }
  return { generated: out.length, pushed: results };
}

/* lazy import to avoid a cycle at module load (events.js imports the store, not us) */
let _events = null;
function require_events() {
  if (!_events) throw new Error('outcomes.simulateEventStream needs registerEventIngest() called once at boot');
  return _events;
}
export function registerEventIngest(mod) { _events = mod; }

/** Record an outcome against the store (used by the recommender + scheduler). */
export function recordOutcome(recommendationId, outcome, { at = null } = {}) {
  const d = load();
  const rec = (d.recommendations || []).find((r) => r.recommendation_id === recommendationId);
  if (!rec) throw httpError(404, `unknown recommendation: ${recommendationId}`);
  d.outcomes.push({
    outcome_id: `O-${String(d.outcomes.length + 1).padStart(4, '0')}`,
    recommendation_id: recommendationId,
    listing_id: rec.listing_id,
    sku: rec.sku,
    verdict: outcome.verdict || null,
    insufficient: !!outcome.insufficient,
    primary: outcome.primary,
    quality: outcome.quality,
    window: outcome.window,
    baseline_source: outcome.baselineSource,
    at: at || new Date().toISOString(),
  });
  logEvent('outcome.recorded', {
    recommendationId, listingId: rec.listing_id, verdict: outcome.verdict || 'INSUFFICIENT',
    primaryDeltaPct: outcome.primary?.deltaPct ?? null,
  });
  save();
  return d.outcomes[d.outcomes.length - 1];
}

export function outcomes(filter = {}) {
  const d = load();
  let all = d.outcomes || [];
  if (filter.listingId) all = all.filter((o) => o.listing_id === filter.listingId);
  if (filter.verdict) all = all.filter((o) => o.verdict === filter.verdict);
  return all.slice().reverse();
}
