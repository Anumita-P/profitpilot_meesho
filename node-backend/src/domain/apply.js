/**
 * THE GUARDED PRICE WRITE.
 *
 * One function that may change a published price. Everything that can move a
 * price converges here - the action queue (autopilot), the recommendation
 * lifecycle after a seller tap, the scheduler - so the floor check and the
 * guardrails exist in exactly one place and cannot be re-implemented slightly
 * differently by a new caller.
 *
 * (The seller-facing publish route keeps its own handler for backwards
 * compatibility; it applies the identical preflight and floor rules, and the
 * regression tests assert both paths refuse the same things.)
 *
 * Contract:
 *   - below F  -> refused (409) unless explicit Exit consent (then it must stay
 *                 >= the recovery floor);
 *   - any failing pre-flight check -> refused unless `override` is set by an
 *                 authorised actor, in which case it is audited as an override;
 *   - success writes the price, the history entry, the audit events and returns
 *                 the before/after view. Refusals write an audit event too, and
 *                 mutate nothing.
 */

import { GUARDRAILS } from '../config/deck.js';
import { load, listing, save, logEvent, httpError } from '../store/db.js';
import { computeFloor } from '../engine/floor.js';
import { preflight } from '../engine/guardrails.js';

const r2 = (x) => Math.round(x * 100) / 100;

/**
 * @param {object} args
 *   listingId, to, actor, reason, decisionId, recommendationId, mode,
 *   consent (Exit only), override ({ by, note }) for an authorised override,
 *   at (timestamp), correlationId
 * @returns {{ applied:true, listing, from, to, checks, override }}
 */
export function applyPrice({
  listingId, to, actor = 'scheduler', reason = null, decisionId = null,
  recommendationId = null, mode = null, consent = false, override = null,
  at = null, correlationId = null, requireViews = null, dryRun = false,
} = {}) {
  const target = Math.round(Number(to));
  if (!Number.isFinite(target) || target <= 0) throw httpError(400, 'to must be a positive number');

  const raw = listing(listingId);
  const floor = computeFloor(raw.skuKey, raw.costOverrides || {});
  const from = raw.price;
  const belowFloor = target < floor.F;
  const exitConsent = !!consent && (raw.stage === 'exit' || consent === 'exit-consent');

  const checks = preflight({
    floor, from, to: target,
    views: requireViews ?? raw.signals?.views ?? 0,
    daysSinceMove: raw.daysSinceMove ?? 0,
    movesThisMonth: raw.movesThisMonth ?? 0,
    consent: exitConsent,
  });
  const blocking = checks.checks.filter((c) => !c.ok);
  const loss = belowFloor ? r2(target - floor.F) : null;

  /**
   * A dry run answers "what would happen if we published this?" - including
   * "it would be refused, and here is why". It writes nothing and audits nothing.
   */
  if (dryRun) {
    return {
      applied: false,
      dryRun: true,
      from,
      to: target,
      floor: floor.F,
      belowFloor,
      wouldBlock: blocking.length > 0,
      blocking: blocking.map((c) => `${c.key}: ${c.detail}`),
      checks: checks.checks,
      lossWarning: belowFloor
        ? {
          price: target,
          floor: floor.F,
          perKeptOrder: loss,
          message: `₹${target} is ₹${Math.abs(loss)} below the return-adjusted floor ₹${floor.F}. Every kept order loses ₹${Math.abs(loss)}.`,
        }
        : null,
    };
  }

  if (blocking.length && !override) {
    logEvent('guardrail.blocked', {
      listingId, via: 'applyPrice', actor, price: target, floor: floor.F,
      blocking: blocking.map((c) => `${c.key}: ${c.detail}`), belowFloor,
      lossPerKeptOrder: loss, correlationId,
    });
    save();
    throw httpError(409, 'guardrail blocked this price change', {
      checks: checks.checks,
      blocking: blocking.map((c) => `${c.key}: ${c.detail}`),
      price: target,
      floor: floor.F,
      lossWarning: belowFloor
        ? {
          price: target,
          floor: floor.F,
          perKeptOrder: loss,
          message: `₹${target} is ₹${Math.abs(loss)} below the return-adjusted floor ₹${floor.F}. Every kept order loses ₹${Math.abs(loss)}.`,
        }
        : null,
      sellerLine: belowFloor
        ? `₹${target} loses ₹${Math.abs(loss)} per kept order. Keep ₹${from} and let us find the real cause?`
        : 'This move breaks a guardrail. Nothing was published.',
      rule: `hard floor · ±${GUARDRAILS.maxStepPct}% per move · ${GUARDRAILS.cooldownDays}-day cooldown · ≤ ${GUARDRAILS.maxMovesPerMonth} moves/month`,
    });
  }

  const ts = at ? new Date(at).toISOString() : new Date().toISOString();
  raw.price = target;
  raw.daysSinceMove = 0;
  raw.movesThisMonth = (raw.movesThisMonth || 0) + 1;
  raw.approvedPricesSeen = Array.from(new Set([...(raw.approvedPricesSeen || []), target]));
  raw.priceHistory = [...(raw.priceHistory || []), {
    ts, price: target,
    reason: reason || (exitConsent ? 'recovery price with seller consent (Exit)' : 'price applied by the engine'),
    decisionId, recommendationId, actor, mode,
    ...(override ? { override: { by: override.by || actor, note: override.note || null, checks: blocking.map((c) => c.key) } } : {}),
  }];
  save();

  logEvent('listing.priceApplied', {
    listingId, from, to: target, actor, reason, decisionId, recommendationId,
    override: override ? { by: override.by || actor, checks: blocking.map((c) => c.key) } : null,
    consent: exitConsent, correlationId,
  });
  if (override) {
    logEvent('decision.override', {
      listingId, recommendationId, decisionId, from, to: target,
      blockersOverridden: blocking.map((c) => c.key), by: override.by || actor, note: override.note || null,
    });
  }
  if (belowFloor) {
    logEvent('guardrail.lossWarning', {
      listingId, price: target, floor: floor.F, lossPerKeptOrder: r2(target - floor.F),
      acknowledged: true, consent: exitConsent,
    });
  }
  save();

  return {
    applied: true,
    listingId,
    from,
    to: target,
    floor: floor.F,
    checks: checks.checks,
    blocking: blocking.map((c) => c.key),
    override: !!override,
    consent: exitConsent,
    at: ts,
  };
}

/** Dry-run helper for the UI: "what would happen if we published this?" */
export function previewPrice(args) {
  return applyPrice({ ...args, dryRun: true });
}

/** Read-only summary used by the action queue and the audit views. */
export function priceState(listingId) {
  const raw = listing(listingId);
  const floor = computeFloor(raw.skuKey, raw.costOverrides || {});
  return {
    listingId,
    price: raw.price,
    floor: floor.F,
    recoveryFloor: floor.frec,
    marginPerKeptOrder: r2(raw.price - floor.F),
    belowFloor: raw.price < floor.F,
    daysSinceMove: raw.daysSinceMove ?? null,
    movesThisMonth: raw.movesThisMonth ?? 0,
    history: (raw.priceHistory || []).slice(-5).reverse(),
  };
}
