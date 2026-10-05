/**
 * INVENTORY-AWARE ECONOMICS (v2 phase 4).
 *
 * A price decision is also an inventory decision. The same demand curve that
 * makes a discount profitable when stock is rotting makes it destructive when
 * stock is nearly out, and pointless when the product is brand new and the real
 * problem is that nobody has seen it yet.
 *
 * This module turns the listing's stock + traffic into the features the rest of
 * the system reads:
 *
 *   inventory_age, days_of_cover, sell_through_rate, stockout_probability,
 *   inventory_velocity, ageing_bucket
 *
 * and one state, which is what a seller actually needs to hear:
 *
 *   NEW | HEALTHY | SLOW | AGING | CLEARANCE | STOCKOUT_RISK
 *
 * The state then sets the STANCE - what a price move is allowed to be trying to
 * do here - and the reason, in one sentence. Every number is arithmetic over the
 * listing's own signals and stock; nothing here is a learned model, and the
 * thresholds are declared as constants so they can be argued with.
 */

import { listing, hydrate, httpError, load } from '../store/db.js';
import { computeFloor } from '../engine/floor.js';
import { reorderPoint } from '../engine/programmes.js';

export const STATES = ['NEW', 'HEALTHY', 'SLOW', 'AGING', 'CLEARANCE', 'STOCKOUT_RISK'];

/** Thresholds, declared once. Ageing buckets are in days of stock age. */
export const THRESHOLDS = {
  newDays: 21,             // a listing younger than this is still learning
  slowCoverDays: 45,       // more cover than this with weak sell-through = slow
  agingAgeDays: 60,
  clearanceAgeDays: 120,
  clearanceCoverDays: 180,
  stockoutCoverDays: 10,   // less cover than this = do not stimulate demand
  healthyCoverMin: 14,
  healthyCoverMax: 60,
};

const round2 = (x) => Math.round(x * 100) / 100;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/**
 * Features + state for one listing.
 * @param {string} listingId
 * @param {object} opts { unitsPerDay: override the observed velocity }
 */
export function stateOf(listingId, { unitsPerDay = null, onHand: onHandOverride = null, ageDays: ageOverride = null, sellThroughPct: sellThroughOverride = null } = {}) {
  /* The named overrides let an ANALYSIS look at a hypothetical stock position
     without touching the listing - the scenario lab and the counterfactual both
     need that, exactly like they may analyse a price that has not been set. The
     output always says which numbers were supplied rather than observed. */
  const overrides = {};
  if (unitsPerDay != null) overrides.units_per_day = unitsPerDay;
  if (onHandOverride != null) overrides.on_hand = onHandOverride;
  if (ageOverride != null) overrides.age_days = ageOverride;
  if (sellThroughOverride != null) overrides.sell_through_pct = sellThroughOverride;
  const raw = listing(listingId);
  const L = hydrate(raw);
  const floor = computeFloor(raw.skuKey, raw.costOverrides || {});
  const sig = L.signals || {};

  /* velocity: kept units per day. Observed events win when they exist; otherwise
     the listing's own q0 anchor (kept orders/day) is used, and that is said. */
  const keptPerDay = unitsPerDay ?? sig.q0 ?? L.ordersPerDay ?? 1;
  const velocitySource = unitsPerDay != null ? 'override' : (sig.q0 ? 'signals.q0 (kept orders/day)' : 'default');

  const onHand = overrides.on_hand ?? raw.stock?.units ?? sig.stockUnits ?? null;
  const ageDays = overrides.age_days ?? raw.ageDays ?? sig.ageDays ?? 0;
  const stockAgeDays = sig.stockAgeDays ?? null;   // age of the stock batch, when the seller records it
  const daysOfCover = onHand == null ? null : round2(onHand / Math.max(0.1, keptPerDay));
  const sellThroughPct = (() => {
    if (overrides.sell_through_pct != null) return overrides.sell_through_pct;
    if (sig.sellThroughPct != null) return sig.sellThroughPct;
    const inStock = raw.stock?.units ?? null;
    const sold = raw.stock?.soldUnits ?? null;
    if (inStock != null && sold != null && inStock + sold > 0) return round2((sold / (inStock + sold)) * 100);
    return null;
  })();

  /* stockout probability over the next 14 days, using a normal approximation of
     the pipeline: needs = 14 x velocity, sigma ~ sqrt(14 x velocity) (Poisson-ish),
     which is the same assumption the reorder-point module already makes. */
  const horizon = 14;
  const need = keptPerDay * horizon;
  const sigma = Math.sqrt(Math.max(1, need));
  const stockoutProbability = onHand == null ? null : clamp(0.5 * (1 + erf((need - onHand) / (sigma * Math.SQRT2))), 0, 1);
  const stockoutInDays = keptPerDay > 0 && onHand != null ? round2(onHand / keptPerDay) : null;

  const ageingBucket = ageDays < THRESHOLDS.newDays ? 'new'
    : ageDays < THRESHOLDS.agingAgeDays ? 'fresh'
      : ageDays < THRESHOLDS.clearanceAgeDays ? 'ageing'
        : 'stale';

  const state = classify({
    ageDays, daysOfCover, sellThroughPct, stockoutProbability, onHand,
  });

  return {
    listing_id: listingId,
    sku: raw.skuKey,
    price: raw.price,
    floor: floor.F,
    inventory: {
      on_hand: onHand,
      age_days: ageDays,
      stock_age_days: stockAgeDays,
      days_of_cover: daysOfCover,
      sell_through_pct: sellThroughPct,
      stockout_probability_14d: stockoutProbability == null ? null : round2(stockoutProbability * 100) / 100,
      stockout_in_days: stockoutInDays,
      inventory_velocity_units_per_day: round2(keptPerDay),
      ageing_bucket: ageingBucket,
      velocity_source: velocitySource,
    },
    overrides,
    basis: Object.keys(overrides).length ? 'analysis overrides supplied (hypothetical stock position - not the live listing)' : 'the listing\'s own stock and signals',
    state,
    thresholds: THRESHOLDS,
    note: 'Inventory state is arithmetic over the listing\'s own stock, age and traffic. Thresholds live in THRESHOLDS so they can be changed in one place.',
  };
}

/** The six states, in the order they are checked. */
export function classify({ ageDays = 0, daysOfCover = null, sellThroughPct = null, stockoutProbability = null, onHand = null } = {}) {
  if ((daysOfCover != null && daysOfCover < THRESHOLDS.stockoutCoverDays) || (stockoutProbability != null && stockoutProbability > 0.6) || onHand === 0) {
    return { key: 'STOCKOUT_RISK', label: 'Stockout risk', severity: 'high' };
  }
  if (ageDays < THRESHOLDS.newDays) return { key: 'NEW', label: 'New listing', severity: 'info' };
  if ((daysOfCover != null && daysOfCover > THRESHOLDS.clearanceCoverDays) || (ageDays >= THRESHOLDS.clearanceAgeDays && (sellThroughPct == null || sellThroughPct < 60))) {
    return { key: 'CLEARANCE', label: 'Clearance', severity: 'high' };
  }
  if (ageDays >= THRESHOLDS.agingAgeDays || (daysOfCover != null && daysOfCover > THRESHOLDS.slowCoverDays && (sellThroughPct == null || sellThroughPct < 55))) {
    return { key: 'AGING', label: 'Ageing stock', severity: 'medium' };
  }
  if (daysOfCover != null && daysOfCover > THRESHOLDS.healthyCoverMax) return { key: 'SLOW', label: 'Slow mover', severity: 'medium' };
  return { key: 'HEALTHY', label: 'Healthy', severity: 'ok' };
}

/**
 * What a price move is allowed to be trying to do in this state, and what it must
 * not do. This is the bridge from the feature layer to the diagnosis: it is the
 * reason the engine can say "hold" without being lazy.
 */
export function stance(state, { demand = null } = {}) {
  const s = state.state?.key || state;
  const demandHot = demand?.hot ?? null;
  switch (s) {
    case 'STOCKOUT_RISK':
      return {
        key: 'protect_and_replenish',
        price_stance: 'HOLD_OR_RAISE',
        why: 'stock is nearly gone: stimulating demand would sell out faster and hand the sale to a competitor at a worse price',
        do_not: ['discount', 'run a promotion that increases volume'],
        do: ['replenish (reorder point)', 'protect price', 'consider a small increase if the listing can still sell'],
        programme: 'reorder-point',
      };
    case 'NEW':
      return {
        key: 'learn_first',
        price_stance: 'HOLD',
        why: 'the listing is new: there is not enough traffic yet for a price test to mean anything, and a discount teaches the wrong lesson',
        do_not: ['discount', 'optimise margin'],
        do: ['get impressions (title, attributes, category)', 'collect ~4 weeks of signals before a price decision'],
        programme: null,
      };
    case 'CLEARANCE':
      return {
        key: 'recover_cash',
        price_stance: 'CONTROLLED_REDUCTION',
        why: 'the stock is old and the cover is long: the floor protects the margin per kept order, so the discount is about turning stock into cash, not chasing volume',
        do_not: ['discount below the recovery floor without Exit consent'],
        do: ['bundle or clear', 'measure kept orders, not orders'],
        programme: 'clearance',
      };
    case 'AGING':
      return {
        key: demandHot === false ? 'controlled_discount' : 'investigate_then_discount',
        price_stance: demandHot === false ? 'CONTROLLED_REDUCTION' : 'HOLD_FIRST',
        why: demandHot === false
          ? 'demand is soft and the stock is ageing: a controlled reduction is the lever that turns stock into cash'
          : 'stock is ageing but demand is still strong - that points at an operational cause (storage, listing, fulfilment) before a price cut',
        do_not: ['a deep cut before the operational cause is checked'],
        do: ['check storage/fulfilment', 'then a controlled reduction if demand is soft'],
        programme: 'packaging-audit',
      };
    case 'SLOW':
      return {
        key: 'reprice_or_reposition',
        price_stance: 'EVALUATE',
        why: 'the stock is slow but not old yet: this is the last comfortable moment to reposition before it becomes ageing stock',
        do_not: ['ignore it until it ages'],
        do: ['review catalogue and price together'],
        programme: null,
      };
    default:
      return {
        key: 'hold_the_line',
        price_stance: 'HOLD',
        why: 'inventory is healthy: there is nothing to fix on the stock side, so the decision belongs to price/demand/catalogue evidence',
        do_not: [],
        do: ['keep watching'],
        programme: null,
      };
  }
}

/** Connect to the existing procurement module rather than inventing a second one. */
export function reorderAdvice(listingId) {
  const s = stateOf(listingId);
  const dailyUnits = s.inventory.inventory_velocity_units_per_day;
  let plan = null;
  try {
    plan = reorderPoint({ dailyUnits, leadTimeDays: 7, serviceLevel: 0.95 });
  } catch (err) {
    plan = { error: err.message };
  }
  return {
    listing_id: listingId,
    state: s.state,
    daily_units: dailyUnits,
    reorder: plan,
    note: 'Uses the existing reorder-point module (2.0 programmes) instead of a second inventory model.',
  };
}

/* ------------------------------- helpers ---------------------------------- */

/** Abramowitz-Stegun approximation of erf: enough for a stockout probability. */
function erf(x) {
  const sign = Math.sign(x);
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax);
  return sign * y;
}

export { round2, clamp, erf };
