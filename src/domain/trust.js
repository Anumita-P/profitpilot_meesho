/**
 * TRUST (deck slide 6 box 4) - earned, never assumed.
 *
 * Manual -> Co-Pilot after 30 orders -> Autopilot after 4 ACCEPTED WINS THAT
 * BEAT THE HOLDOUT -> catalogue-wide after 8 weeks on Autopilot.
 *
 * The whole point of this module is what it refuses to count:
 *
 *   - a recommendation that is merely accepted is not a win;
 *   - a win with an insufficient observation window is not a win (the outcome
 *     module refuses to produce the verdict in the first place);
 *   - a win that breached a customer-quality guardrail is not a win;
 *   - a win with NO holdout comparison is recorded as PROVISIONAL. It is shown
 *     to the seller, it never advances the ladder. Autopilot is only unlocked by
 *     wins measured against a group that was deliberately left alone.
 *
 * The existing engine function `trustLadder()` (src/engine/guardrails.js) is
 * still the thing that computes the level: this module only supplies it with
 * honest inputs, so the deck's thresholds and wording are untouched.
 */

import { load, save, logEvent, httpError } from '../store/db.js';
import { trustLadder } from '../engine/guardrails.js';
import * as experiments from './experiments.js';

const WIN_STATES = ['WON', 'RETAINED'];

/**
 * Everything that could plausibly count as a win, with the reason it does or
 * does not. This is the function to read if you are sceptical about a number.
 */
export function evidenceFor({ sellerId = null } = {}) {
  const d = load();
  const rows = [];
  for (const rec of (d.recommendations || [])) {
    if (!WIN_STATES.includes(rec.status)) continue;
    if (sellerId && rec.seller_id !== sellerId) continue;
    const o = rec.outcome || null;
    const holdout = holdoutComparison(rec);
    const checks = [
      { key: 'verdict recorded', ok: !!o && !o.insufficient, detail: o ? (o.insufficient ? 'window too small to judge' : `verdict ${o.verdict || 'n/a'}`) : 'no outcome attached' },
      { key: 'primary metric won', ok: !!(o && o.primary && o.primary.deltaPct != null && o.primary.deltaPct > 0), detail: o?.primary?.deltaPct != null ? `${o.primary.deltaPct}% on ${o.primary.metric || 'primary'}` : 'no measured delta' },
      { key: 'quality intact', ok: !!(o && o.quality && o.quality.pass), detail: o?.quality ? (o.quality.pass ? 'returns, RTO and cancellations within tolerance' : `breached: ${(o.quality.breached || []).join(', ')}`) : 'not evaluated' },
      { key: 'measured at least a full observation window', ok: !!(o && o.window && (o.window.days ?? 0) >= 7), detail: o?.window ? `${o.window.days ?? 0} day window` : 'no window' },
      { key: 'beat a holdout', ok: !!holdout && holdout.beaten === true, detail: holdout ? holdout.detail : 'no holdout comparison exists for this listing: the win is provisional' },
    ];
    const valid = checks.slice(0, 4).every((c) => c.ok);
    rows.push({
      recommendation_id: rec.recommendation_id,
      listing_id: rec.listing_id,
      sku: rec.sku,
      status: rec.status,
      primary_delta_pct: o?.primary?.deltaPct ?? null,
      checks,
      valid_win: valid,
      holdout_backed: !!(valid && holdout && holdout.beaten === true),
      counts_towards_autopilot: !!(valid && holdout && holdout.beaten === true),
      why: !valid ? `not a valid win: ${checks.filter((c) => !c.ok).map((c) => c.key).join('; ')}`
        : (holdout && holdout.beaten === true) ? 'valid win measured against a holdout that was left alone'
          : 'valid win, but provisional: no holdout comparison, so it does not unlock Autopilot',
    });
  }
  return rows;
}

/**
 * The holdout check for one recommendation's listing.
 *
 * A comparison only counts when it is real:
 *   - both arms must have data (the claimGuard rule, unchanged);
 *   - both arms must have enough observations for an interval to exist
 *     (`enoughData`), so a single holdout row cannot unlock automation;
 *   - at least one observation must be dated on or after the change went live,
 *     i.e. the holdout actually covers the period being judged. A holdout from
 *     before the change proves nothing about the change.
 */
function holdoutComparison(rec) {
  const appliedAt = rec.applied?.at || rec.timestamps?.appliedAt || null;
  const exps = experiments.list({ listingId: rec.listing_id }).filter((e) => e.observations.length > 0);
  if (!exps.length) return null;
  const e = exps[exps.length - 1];
  const coversAfter = appliedAt
    ? e.observations.some((o) => new Date(o.window.to) >= new Date(appliedAt))
    : true;
  const report = experiments.impact(e.experiment_id);
  const t = report.arms.treatment.mean;
  const h = report.arms.holdout.mean;
  if (t == null || h == null) {
    return { experiment_id: e.experiment_id, beaten: null, detail: `${e.experiment_id} has only one arm's data so far: nothing to compare yet` };
  }
  if (!report.enoughData) {
    return { experiment_id: e.experiment_id, beaten: null, detail: `${e.experiment_id} has too few observations per arm for an interval: provisional only` };
  }
  if (!coversAfter) {
    return { experiment_id: e.experiment_id, beaten: null, detail: `${e.experiment_id}'s observations all predate the change, so the holdout does not cover the period being judged` };
  }
  return {
    experiment_id: e.experiment_id,
    beaten: t > h,
    detail: `${e.experiment_id}: treatment ${t} vs holdout ${h} on ${report.primary_metric.replace(/_/g, ' ')} (${report.arms.treatment.observations} vs ${report.arms.holdout.observations} observations)`,
  };
}

/**
 * The ladder for a seller, computed from evidence. Deterministic, read-only.
 */
export function computedTrust(sellerId) {
  const d = load();
  const seller = d.sellers[sellerId];
  if (!seller) throw httpError(404, `unknown seller: ${sellerId}`);
  const rows = evidenceFor({ sellerId });
  const banked = rows.filter((r) => r.counts_towards_autopilot);
  const provisional = rows.filter((r) => r.holdout_backed === false && r.valid_win);
  const orders = orderCount(sellerId);
  const ladder = trustLadder({
    wins: banked.length,
    orders,
    weeksOnAutopilot: seller.weeksOnAutopilot || 0,
  });
  return {
    seller_id: sellerId,
    ladder,
    wins: banked.length,
    provisional_wins: provisional.length,
    orders,
    wins_to_autopilot: Math.max(0, 4 - banked.length),
    evidence: rows,
    provisional: provisional.map((r) => ({ recommendation_id: r.recommendation_id, why: r.why })),
    rule: 'Autopilot is unlocked only by accepted wins that beat a holdout. Provisional wins (no holdout) are shown but never counted.',
    note: 'The thresholds themselves (30 orders, 4 wins, 8 weeks) come from the deck and live in src/engine/guardrails.js.',
  };
}

/** Orders the seller has actually handled: lifetime seed + observed placed orders. */
function orderCount(sellerId) {
  const d = load();
  const seller = d.sellers[sellerId] || {};
  let observedPlaced = 0;
  for (const e of (d.ingestedEvents || [])) {
    if (e.event_type === 'ORDER_PLACED' && e.seller_id === sellerId) observedPlaced++;
  }
  return (seller.ordersLifetime || 0) + observedPlaced;
}

/** Persist the computed trust on the seller record (never invents a win). */
export function applyTrust(sellerId) {
  const d = load();
  const t = computedTrust(sellerId);
  const seller = d.sellers[sellerId];
  const before = { wins: seller.wins ?? null, trust: seller.trust?.level ?? null };
  seller.wins = t.wins;
  seller.provisionalWins = t.provisional_wins;
  seller.ordersCounted = t.orders;
  seller.trust = { ...t.ladder, computedAt: new Date().toISOString(), evidence: t.evidence.length };
  save();
  const after = { wins: seller.wins, trust: seller.trust.level };
  if (before.wins !== after.wins || before.trust !== after.trust) {
    logEvent('trust.updated', {
      sellerId, winsBefore: before.wins, winsAfter: after.wins,
      levelBefore: before.trust, levelAfter: after.trust,
      provisional: t.provisional_wins, orders: t.orders,
    });
    save();
  }
  return { ...t, before, after, changed: before.wins !== after.wins || before.trust !== after.trust };
}

/** Recompute for every seller (called by the scheduler after judging outcomes). */
export function applyAllTrust() {
  const d = load();
  const out = [];
  for (const id of Object.keys(d.sellers || {})) {
    try { out.push({ sellerId: id, ...applyTrust(id) }); }
    catch (err) { out.push({ sellerId: id, error: err.message }); }
  }
  return { sellers: out.length, updated: out.filter((o) => o.changed).length, detail: out.map((o) => ({ sellerId: o.sellerId, wins: o.wins, level: o.ladder?.level, changed: o.changed, error: o.error })) };
}

/**
 * The autonomy level for one SKU: the entitlement from the ladder, capped by the
 * seller's own grant on the record ('man' | 'cp' | 'au'). A seller may always
 * choose LESS automation than they have earned; never more.
 */
const RANK = { man: 0, cp: 1, au: 2 };

export function autonomyFor(sellerId, skuKey) {
  const d = load();
  const seller = d.sellers[sellerId] || {};
  const granted = seller.control?.[skuKey] || 'man';
  const t = computedTrust(sellerId);
  const entitled = t.ladder.level;                       // 'manual' | 'cp' | 'au'
  const entitledCode = entitled === 'manual' ? 'man' : entitled;
  const effective = RANK[granted] <= RANK[entitledCode] ? granted : entitledCode;
  return {
    seller_id: sellerId,
    sku: skuKey,
    granted,
    entitled: entitledCode,
    effective,
    label: { man: 'Manual', cp: 'Co-Pilot', au: 'Autopilot' }[effective],
    needsSeller: effective !== 'au',
    wins: t.wins,
    provisional_wins: t.provisional_wins,
    next: t.ladder.next,
    why: effective !== entitledCode
      ? `entitled to ${entitledCode} but the seller has granted ${granted} on this SKU: the lower level wins`
      : `earned ${entitledCode} from ${t.wins} holdout-backed win(s) and ${t.orders} orders`,
  };
}
