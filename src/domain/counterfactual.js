/**
 * COUNTERFACTUAL PRICE ENGINE (v2 phase 2).
 *
 * "What would each price actually do?" - answered with the models that already
 * exist, on one screen, for a grid of candidate prices:
 *
 *   candidate price
 *     -> demand          (src/engine/demand.js: ordersPerDay with its price kink)
 *     -> operational risk (src/engine/demand.js riskMixAtPrice + src/engine/risk.js priors)
 *     -> kept orders      (cancellations, RTO, returns applied)
 *     -> seller contribution (price - return-adjusted floor, per kept order)
 *     -> guardrail eligibility (src/engine/guardrails.js preflight, unmodified)
 *     -> expected value   (contribution over the horizon)
 *
 * THREE RULES THIS FILE OBEYS:
 *
 *  1. IT IS LABELLED. Every response carries
 *     `label: 'ILLUSTRATIVE MODEL ESTIMATE'` and the model versions used. This is
 *     the same deterministic demand curve the rest of the product uses, applied
 *     to a price that has not happened. It is not a prediction, not a forecast,
 *     and not evidence - evidence comes from ingested events and holdouts.
 *
 *  2. IT CAN LOOK BELOW THE FLOOR. Analysing a sub-floor price is useful: it
 *     shows the Loss Warning and the shape of the curve. It is marked
 *     `eligible: false, blocked_by: ['Floor']` and can never be the recommendation
 *     - nor can it be executed, because applyPrice() checks the same guardrails
 *     again at execution time.
 *
 *  3. THE RECOMMENDATION IS NOT THE CHEAPEST OR THE HIGHEST-REVENUE PRICE.
 *     It is the eligible candidate with the best expected CONTRIBUTION over the
 *     horizon, with ties broken towards the smallest move from the live price.
 *     The cheapest and highest-revenue candidates are reported beside it,
 *     precisely so the difference is visible.
 */

import { listing, hydrate, httpError, load } from '../store/db.js';
import { computeFloor } from '../engine/floor.js';
import { ordersPerDay, riskMixAtPrice } from '../engine/demand.js';
import { preflight } from '../engine/guardrails.js';
import { GUARDRAILS } from '../config/deck.js';
import * as promotion from './promotion.js';
import * as inventory from './inventory.js';
import { versionSet } from './versions.js';

export const LABEL = 'ILLUSTRATIVE MODEL ESTIMATE';
export const HORIZON_DEFAULT = 30;

const round2 = (x) => Math.round(x * 100) / 100;
const r0 = (x) => Math.round(x);

/** The default grid: the deck's own arms plus a wider spread, anchored on the live price. */
export function defaultGrid(listingId, { step = 20, span = 3 } = {}) {
  const L = hydrate(listing(listingId));
  const live = L.price;
  const out = new Set([live]);
  for (let i = 1; i <= span; i++) {
    out.add(r0(live - i * step));
    out.add(r0(live + i * step));
  }
  return [...out].filter((p) => p > 20).sort((a, b) => a - b);
}

/**
 * Evaluate one candidate price. Pure arithmetic: no store writes.
 * @param {string} listingId
 * @param {number} candidate
 * @param {object} opts { horizonDays, promotions, demandFactor }
 */
export function evaluate(listingId, candidate, { horizonDays = HORIZON_DEFAULT, promotions = null, demandFactor = 1 } = {}) {
  const raw = listing(listingId);
  const L = hydrate(raw);
  const f = computeFloor(raw.skuKey, raw.costOverrides || {});
  const price = r0(candidate);
  const live = L.price;

  const promo = promotion.composePrice(listingId, { basePrice: price, promotions });
  const effective = promo.effectivePrice;
  const promoDiscount = price - effective;

  /* demand: the engine's own curve, relative to the live price */
  const ordersAtLive = Math.max(0.01, ordersPerDay(L, live));
  const ordersHere = ordersPerDay(L, price);            // base price drives the demand curve
  const demandIndex = ordersHere / ordersAtLive;

  /* traffic: clicks scale with demand; CTR is held at the listing's own rate and
     all price sensitivity flows through the demand curve, so the two cannot
     double-count the same effect (stated, not hidden). */
  const baseClicks = L.signals.clicks || Math.max(1, r0((L.signals.views || 1400) * (L.signals.ctr || 4) / 100));
  const clicksPerDay = Math.max(0, baseClicks * demandIndex * demandFactor);
  const ctr = L.signals.ctr ? L.signals.ctr / 100 : 0.04;
  const viewsPerDay = ctr > 0 ? clicksPerDay / ctr : 0;
  const ordersPerDayHere = Math.max(0, L.signals.q0 || L.ordersPerDay || 1) * demandIndex * demandFactor;

  /* operational risk at THIS price: discounts attract COD buyers and returns */
  let mix;
  try {
    mix = riskMixAtPrice(L, effective, f);
  } catch {
    mix = null;
  }
  const cancelP = mix?.cancelP ?? 0.03;
  const rtoP = mix?.rtoP ?? ((L.signals.rtoPct || 8) / 100);
  const retP = mix?.retP ?? ((L.signals.returnsPct || 12) / 100);
  const keptRate = (1 - cancelP) * (1 - rtoP) * (1 - retP);

  const orders = ordersPerDayHere * horizonDays;
  const cancelled = orders * cancelP;
  const rto = orders * (1 - cancelP) * rtoP;
  const delivered = orders * (1 - cancelP) * (1 - rtoP);
  const returned = delivered * retP;
  const keptOrders = delivered - returned;

  const contributionPerKeptOrder = effective - f.F;
  const totalContribution = keptOrders * contributionPerKeptOrder;
  const revenue = keptOrders * effective;
  const grossRevenue = orders * effective;

  /* guardrails: the SAME preflight the publish path and the action queue use */
  const checks = preflight({
    floor: f,
    from: live,
    to: price,
    views: L.signals.views ?? 0,
    daysSinceMove: raw.daysSinceMove ?? 0,
    movesThisMonth: raw.movesThisMonth ?? 0,
    consent: false,
  });
  const blocking = checks.checks.filter((c) => !c.ok);

  return {
    candidate: price,
    effectivePrice: effective,
    promotionDiscount: round2(promoDiscount),
    demand: {
      orders_per_day: round2(ordersPerDayHere),
      demand_index_vs_live: round2(demandIndex),
      views_per_day: round2(viewsPerDay),
      clicks_per_day: round2(clicksPerDay),
      ctr_pct: round2(ctr * 100),
      cvr_pct: clicksPerDay > 0 ? round2((ordersPerDayHere / clicksPerDay) * 100) : 0,
    },
    operations: {
      cancelled: round2(cancelled),
      rto: round2(rto),
      delivered: round2(delivered),
      returned: round2(returned),
      kept_orders: round2(keptOrders),
      kept_rate_pct: round2(keptRate * 100),
    },
    economics: {
      revenue: round2(revenue),
      gross_revenue: round2(grossRevenue),
      contribution_per_kept_order: round2(contributionPerKeptOrder),
      total_contribution: round2(totalContribution),
      floor: f.F,
      recovery_floor: f.frec,
      margin_pct_of_price: effective > 0 ? round2((contributionPerKeptOrder / effective) * 100) : 0,
    },
    risk_flags: flagsFor({ price, effective, floor: f, blocking, L, raw, keptRate, retP, rtoP }),
    guardrails: {
      eligible: blocking.length === 0,
      blocked_by: blocking.map((c) => c.key),
      detail: blocking.map((c) => `${c.key}: ${c.detail}`),
      checks: checks.checks,
      loss_warning: price < f.F
        ? { price, floor: f.F, per_kept_order: round2(price - f.F), message: `₹${price} is ₹${Math.abs(round2(price - f.F))} below the return-adjusted floor ₹${f.F}.` }
        : null,
    },
    expected_value: {
      metric: 'total contribution over the horizon (kept orders x contribution per kept order)',
      horizon_days: horizonDays,
      value: round2(totalContribution),
      per_kept_order: round2(contributionPerKeptOrder),
    },
  };
}

function flagsFor({ price, effective, floor, blocking, L, raw, keptRate, retP, rtoP }) {
  const flags = [];
  if (effective < floor.F) flags.push({ key: 'below_floor', level: 'blocking', detail: `effective price ₹${effective} is below the return-adjusted floor ₹${floor.F}` });
  if (blocking.some((c) => c.key.startsWith('Step'))) flags.push({ key: 'step_too_big', level: 'blocking', detail: `the move is larger than the ±${GUARDRAILS.maxStepPct}% per-move rule` });
  if (blocking.some((c) => c.key.startsWith('Cooldown'))) flags.push({ key: 'cooldown', level: 'blocking', detail: `only ${raw.daysSinceMove ?? 0} days since the last move (cooldown is ${GUARDRAILS.cooldownDays})` });
  if (blocking.some((c) => c.key.includes('moves'))) flags.push({ key: 'move_budget', level: 'blocking', detail: `${raw.movesThisMonth ?? 0} moves already this month (cap ${GUARDRAILS.maxMovesPerMonth})` });
  if (retP > 0.18) flags.push({ key: 'return_pressure', level: 'watch', detail: `estimated return rate ${round2(retP * 100)}% at this price` });
  if (rtoP > 0.14) flags.push({ key: 'rto_pressure', level: 'watch', detail: `estimated RTO rate ${round2(rtoP * 100)}% at this price` });
  if (keptRate < 0.7) flags.push({ key: 'thin_kept_rate', level: 'watch', detail: `only ${round2(keptRate * 100)}% of orders survive to a kept order` });
  if (price < L.price && (L.stage === 'exit' || L.stage === 'decline')) flags.push({ key: 'late_life_cut', level: 'watch', detail: `cutting price in the ${L.stage} stage: check the Exit/recovery path first` });
  return flags;
}

/**
 * Evaluate a grid and pick a recommendation.
 * @returns {object} the full counterfactual report for the API
 */
export function grid(listingId, { candidates = null, horizonDays = HORIZON_DEFAULT, promotions = null } = {}) {
  const raw = listing(listingId);
  const L = hydrate(raw);
  const prices = (candidates && candidates.length ? candidates.map((p) => r0(p)) : defaultGrid(listingId))
    .filter((p) => Number.isFinite(p) && p > 20)
    .sort((a, b) => a - b);
  if (!prices.length) throw httpError(400, 'candidates must contain at least one positive price', { field: 'candidates' });

  const rows = prices.map((p) => evaluate(listingId, p, { horizonDays, promotions }));
  const eligible = rows.filter((r) => r.guardrails.eligible);

  /* expected contribution, ties broken by the SMALLEST move from the live price */
  const ranked = [...eligible].sort((a, b) => (b.expected_value.value - a.expected_value.value)
    || (Math.abs(a.candidate - L.price) - Math.abs(b.candidate - L.price)));
  const recommended = ranked[0] || null;
  const cheapest = rows.reduce((a, b) => (b.candidate < a.candidate ? b : a), rows[0]);
  const highestRevenue = rows.reduce((a, b) => (b.economics.gross_revenue > a.economics.gross_revenue ? b : a), rows[0]);
  const bestPerKeptOrder = rows.reduce((a, b) => (b.economics.contribution_per_kept_order > a.economics.contribution_per_kept_order ? b : a), rows[0]);
  const live = rows.find((r) => r.candidate === L.price) || null;

  const inv = inventory.stateOf(listingId);
  const stance = inventory.stance(inv);
  /* Promotion interaction. Checked on the recommended candidate when it is a cut,
     and otherwise on the best eligible cut on the grid - because for an ageing or
     clearance listing a cut is exactly what is under consideration even when the
     headline recommendation happens to be a raise. */
  const bestCutRow = rows.filter((r) => r.guardrails.eligible && r.candidate < L.price)
    .sort((a, b) => b.expected_value.value - a.expected_value.value)[0] || null;
  const cutUnderConsideration = recommended && recommended.candidate < L.price ? recommended : bestCutRow;
  const contradiction = cutUnderConsideration
    ? { ...promotion.contradiction(listingId, cutUnderConsideration.candidate), checked_candidate: cutUnderConsideration.candidate }
    : { contradictory: false, stacks: false, why: 'no eligible cut is on the grid, so promotion stacking is not in play', checked_candidate: null };

  return {
    listing_id: listingId,
    sku: raw.skuKey,
    label: LABEL,
    disclaimer: 'These are model estimates from the same deterministic curve the product uses. They are NOT a forecast, NOT evidence, and NOT a promise: the observed outcome comes from ingested events and holdouts after the change.',
    as_of: new Date().toISOString(),
    context: {
      live_price: L.price,
      floor: computeFloor(raw.skuKey, raw.costOverrides || {}).F,
      stage: L.stage,
      mode: L.mode,
      horizon_days: horizonDays,
      effective_price_now: promotion.composePrice(listingId).effectivePrice,
      inventory_state: inv.state.key,
      inventory_stance: stance.price_stance,
      versions: versionSet(),
    },
    curve: rows.map((r) => ({
      price: r.candidate,
      effective_price: r.effectivePrice,
      kept_orders: r.operations.kept_orders,
      contribution_per_kept_order: r.economics.contribution_per_kept_order,
      total_contribution: r.economics.total_contribution,
      revenue: r.economics.revenue,
      eligible: r.guardrails.eligible,
      blocked_by: r.guardrails.blocked_by,
      below_floor: r.effectivePrice < r.economics.floor,
    })),
    candidates: rows,
    recommendation: recommended
      ? {
        candidate: recommended.candidate,
        effective_price: recommended.effectivePrice,
        expected_contribution: recommended.expected_value.value,
        contribution_per_kept_order: recommended.economics.contribution_per_kept_order,
        price_action: recommended.candidate > L.price ? 'RAISE' : recommended.candidate < L.price ? 'REDUCE' : 'HOLD',
        move_pct: round2(((recommended.candidate - L.price) / L.price) * 100),
        why: `highest expected contribution among the ${eligible.length} eligible candidate(s), and ${recommended.candidate === L.price ? 'the live price' : `the smallest move that gets there`}`,
        basis: 'expected contribution over the horizon, subject to the unchanged guardrails',
      }
      : null,
    not_the_cheapest: {
      candidate: cheapest.candidate,
      candidate_contribution: cheapest.economics.total_contribution,
      note: `the cheapest candidate is ₹${cheapest.candidate}${cheapest.guardrails.eligible ? '' : ' (blocked: ' + cheapest.guardrails.blocked_by.join(', ') + ')'}. The recommendation is not the cheapest price - it is the best expected contribution among the legal ones.`,
    },
    not_the_highest_revenue: {
      candidate: highestRevenue.candidate,
      revenue: highestRevenue.economics.gross_revenue,
      contribution: highestRevenue.economics.total_contribution,
      note: `the highest gross revenue sits at ₹${highestRevenue.candidate}, but the objective is contribution per kept order, not revenue.`,
    },
    best_per_kept_order: {
      candidate: bestPerKeptOrder.candidate,
      value: bestPerKeptOrder.economics.contribution_per_kept_order,
      note: 'the highest contribution per kept order is usually the highest price; it is reported so the volume/margin trade-off is visible, and it is not automatically the recommendation either.',
    },
    live_candidate: live,
    promotion_check: contradiction,
    inventory_check: { state: inv, stance },
    assumptions: [
      'demand follows the product\'s existing price curve (src/engine/demand.js), relative to the live price',
      'CTR is held at the listing\'s own rate; all price sensitivity flows through the demand curve (no double counting)',
      `return / RTO / cancellation rates move with price through riskMixAtPrice(); guardrails are the unmodified preflight()`,
      'the horizon is a modelling choice, not a promise about when the effect arrives',
      'stock is assumed to cover the kept orders implied by the candidate (a candidate that would stock out is still shown, with the stockout flag on the inventory check)',
    ],
  };
}

/** Convenience: what would happen at one specific price. */
export function at(listingId, price, opts = {}) {
  return evaluate(listingId, price, opts);
}
