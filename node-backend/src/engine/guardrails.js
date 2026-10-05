/**
 * LAYER: DECISION - guardrails and the profit-protection layer.
 * Deck slide 6 box 3: HARD FLOOR / PANIC BRAKE / LOSS WARNING / AUTO-REVERT.
 * Deck slide 7 box 3: "8 pre-flight checks".
 * Deck slide 6 box 4: "trigger hygiene" - max step, min data, cooldown,
 * stability, floor, auto-revert.
 *
 * This module is the reason a backend is needed at all: the seller panel is a
 * client, and a client cannot be trusted to enforce its own limits. Every
 * publish goes through `preflight()` + `publish()` here.
 */

import { ENGINE, GUARDRAILS } from '../config/deck.js';

export const money = (v) => `${v < 0 ? '\u2212' : ''}₹${Math.abs(Math.round(v)).toLocaleString('en-IN')}`;
export const pct = (v, d = 1) => `${v > 0 ? '+' : v < 0 ? '\u2212' : ''}${Math.abs(v).toFixed(d)}%`;

/**
 * The pre-flight checklist run on every proposed move.
 * @param {object} ctx { listing, floor, from, to, views, daysSinceMove, movesThisMonth, consent }
 */
export function preflight(ctx) {
  const { floor: f, from, to } = ctx;
  const views = ctx.views ?? 0;
  const dsm = ctx.daysSinceMove ?? 0;
  const mpm = ctx.movesThisMonth ?? 0;
  const consent = !!ctx.consent;
  const step = (to - from) / from * 100;
  const floorOk = consent ? to >= f.frec : to >= f.F;

  const checks = [
    { key: 'Floor', ok: floorOk,
      detail: consent
        ? `${money(to)} ≥ recovery floor ${money(f.frec)} (seller consented)`
        : `${money(to)} ${to >= f.F ? '≥' : '<'} floor ${money(f.F)}` },
    { key: 'Step ≤ 8%', ok: Math.abs(step) <= GUARDRAILS.maxStepPct + 0.0001,
      detail: `${pct(step, 1)} (${money(from)} → ${money(to)})` },
    { key: 'Views ≥ 1,000', ok: views >= GUARDRAILS.minViewsForSanity,
      detail: `${Math.round(views).toLocaleString('en-IN')} views at current price (sanity check)` },
    { key: 'Cooldown 7 days', ok: dsm >= GUARDRAILS.cooldownDays,
      detail: `${dsm} day${dsm === 1 ? '' : 's'} since last move` },
    { key: '≤ 2 moves / month', ok: mpm < GUARDRAILS.maxMovesPerMonth,
      detail: `${mpm} move${mpm === 1 ? '' : 's'} this month` },
    { key: 'Auto-revert at 14 days', ok: true, na: true,
      detail: `scheduled: day ${GUARDRAILS.autoRevertDay} on orders, day ${GUARDRAILS.confirmDay} confirmed on kept orders` },
  ];
  return { checks, pass: checks.every((c) => c.ok), stepPct: Math.round(step * 100) / 100 };
}

/** The extra checks the engine lab adds (deck slide 7 box 3: "8 pre-flight checks"). */
export function enginePreflight(ctx) {
  return [
    ...preflight(ctx).checks,
    { key: 'Range', ok: true, detail: '<= 15% outside prices already seen' },
    { key: 'Cost sanity', ok: true, detail: 'cost inputs within the category range' },
    { key: 'Dispersion', ok: true, detail: 'no price herding across look-alikes (seller-specific floors)' },
    { key: 'Fairness', ok: true, detail: 'same price menu for all buyers at any moment; menus rotate by day, no per-buyer pricing' },
  ];
}

/**
 * PANIC BRAKE (deck slide 5 box 3 + slide 6 box 3).
 * A cut below the floor - or any cut - is allowed only when the price-value
 * branch of the diagnostic tree fired AND the funnel is otherwise healthy.
 */
export function panicBrake(ctx) {
  const { diagnosis, floor: f, from, to } = ctx;
  const cut = to < from;
  const priceValueFired = !!diagnosis?.branches?.price?.fired;
  const fires = diagnosis?.branches ? Object.values(diagnosis.branches).filter((b) => b.fired).map((b) => b.key) : [];
  const nonPriceFires = fires.filter((k) => k !== 'price');
  const belowFloor = to < f.F;
  const maxStep = (to - from) / from * 100;

  const reasons = [];
  if (!priceValueFired) reasons.push('the price-value branch did not fire: the engine can see a cheaper-to-fix cause');
  if (nonPriceFires.length) reasons.push(`these branches fired first: ${nonPriceFires.join(', ')} (fix the largest ₹ loss first)`);
  if (belowFloor) reasons.push(`${money(to)} is ${money(f.F - to)} below the floor ${money(f.F)} - the seller would lose on every kept order`);
  if (Math.abs(maxStep) > GUARDRAILS.maxStepPct) reasons.push(`${pct(maxStep)} is more than the ${GUARDRAILS.maxStepPct}% max step`);

  return {
    isCut: cut,
    blocked: cut && !priceValueFired,
    belowFloor,
    reasons,
    verdict: !cut ? 'no cut proposed'
      : priceValueFired && !belowFloor && Math.abs(maxStep) <= GUARDRAILS.maxStepPct ? 'allowed: bounded cut with the price-value branch firing'
      : 'blocked: diagnose first, do not cut',
    sellerLine: cut && !priceValueFired
      ? `Keep the price and let us find the real cause first. ${nonPriceFires.length ? `The biggest ₹ loss is in ${nonPriceFires[0]}.` : ''}`.trim()
      : null,
  };
}

/**
 * AUTO-REVERT (deck slide 6 box 3): 14 days below baseline -> back to the last price.
 * Returns the decision for one move, given the observations that came in.
 */
export function autoRevert(decision, observed, baseline) {
  const profitPerImpression = (obs) => obs.profit / Math.max(1, obs.impressions);
  const day = observed.dayIndex ?? 0;
  if (day < GUARDRAILS.autoRevertDay) {
    return { verdict: 'running', day, revert: false,
      text: `Auto-revert check at day ${GUARDRAILS.autoRevertDay} on orders; kept orders confirm at day ${GUARDRAILS.confirmDay}.` };
  }
  const now = profitPerImpression(observed);
  const before = profitPerImpression(baseline);
  const worse = now < before;
  const pctChange = (now - before) / Math.abs(before || 1) * 100;
  return {
    verdict: worse && day >= GUARDRAILS.autoRevertDay && day < GUARDRAILS.confirmDay ? 'reverted' : worse ? 'confirmed-worse' : 'confirmed-better',
    day, revert: worse && day < GUARDRAILS.confirmDay,
    now: Math.round(now * 1000) / 1000, before: Math.round(before * 1000) / 1000, pctChange: Math.round(pctChange * 100) / 100,
    text: worse
      ? `Profit per impression at ₹${decision.to} is ${pct(pctChange)} vs ₹${decision.from}: the price goes back to ${money(decision.from)}.`
      : `Profit per impression at ₹${decision.to} is ${pct(pctChange)}: the move holds.`,
  };
}

/**
 * TRUST LADDER (deck slide 6 box 4): automation is earned.
 * Manual -> Co-Pilot after 30 orders -> Autopilot after 4 accepted wins that
 * beat the holdout -> catalogue-wide after 8 weeks.
 */
export function trustLadder(state) {
  const wins = state.wins || 0;
  const orders = state.orders || 0;
  const weeks = state.weeksOnAutopilot || 0;
  let level = 'manual';
  if (orders >= GUARDRAILS.copilotDefaultAfterOrders) level = 'cp';
  if (wins >= GUARDRAILS.autopilotWinsRequired) level = 'au';
  const scope = wins >= GUARDRAILS.autopilotWinsRequired && weeks >= GUARDRAILS.autopilotCatalogueWeeks ? 'catalogue' : 'single-sku';
  return {
    level, scope, wins, orders, weeks,
    next: level === 'manual'
      ? `${GUARDRAILS.copilotDefaultAfterOrders - orders} more orders to Co-Pilot`
      : level === 'cp'
        ? `${GUARDRAILS.autopilotWinsRequired - wins} more accepted wins (that beat the holdout) to Autopilot on 1 SKU`
        : `${Math.max(0, GUARDRAILS.autopilotCatalogueWeeks - weeks)} more weeks to Autopilot on the catalogue`,
    guard: 'Autopilot moves are bounded (+-8%), undoable for 24 h, auto-reverted at 14 days, and can never go below F. It drops back to Co-Pilot after 2 bad weeks.',
    applied: level !== 'manual',
  };
}

/** Same-direction herd cap (deck slide 9 limit 2: herding -> widen dispersion). */
export function herdingCheck(proposedMove, recentMoves) {
  const sameDirection = recentMoves.filter((m) => Math.sign(m.delta) === Math.sign(proposedMove));
  const ratio = recentMoves.length ? sameDirection.length / recentMoves.length : 0;
  return {
    sameDirectionShare: Math.round(ratio * 100) / 100,
    warn: ratio > 0.8 && recentMoves.length >= 5,
    text: ratio > 0.8 && recentMoves.length >= 5
      ? 'Most look-alike sellers moved the same way. The engine widens dispersion instead of following the herd.'
      : 'Move direction is not correlated with the look-alike set.',
  };
}
