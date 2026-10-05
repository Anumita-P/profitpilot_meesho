/**
 * LAYER: MODELS (2 of 4) - demand & elasticity.
 * Deck slide 7 box 4: "ln q = a + b ln p (b = -3 category prior) + look-alike
 * penalty above the median", monotone in price, pooled priors that the SKU's
 * own data overrides with shrinkage w = n / (n + n0).
 *
 * Kept unit economics per day:
 *   orders/day(p) = q0 * (p / p_live)^beta * pen(p)
 *   profit/day(p) = orders/day(p) * k * (p - F)
 */

import { ENGINE, CATEGORIES } from '../config/deck.js';
import { computeFloor } from './floor.js';

/** Look-alike penalty for pricing above the median of the band (kink at the median). */
export function penalty(p, median) {
  if (!(p > median)) return 1;
  return Math.exp(-ENGINE.GAMMA * Math.pow((p - median) / median, 2));
}

/** Pooled prior for a SKU-category pair, before any of this listing's own data. */
export function betaPrior(category) {
  return (CATEGORIES[category] || CATEGORIES.ethnic).beta ?? ENGINE.BETA;
}

/**
 * Orders per day at price p.
 * @param {object} listing - must carry { q0, price, sku } - q0 = orders/day at the live price
 */
export function ordersPerDay(listing, p, opts = {}) {
  const sku = listing.sku;
  const live = listing.price;
  const beta = opts.beta ?? listing.beta ?? betaPrior(sku.category);
  const kink = opts.kink !== false;
  const k0 = kink ? penalty(p, sku.median) / penalty(live, sku.median) : 1;
  return listing.q0 * Math.pow(p / live, beta) * k0;
}

/** Profit per day in ₹, after returns and RTO (kept orders only). */
export function profitPerDay(listing, p, floorOrOverrides, opts = {}) {
  const f = floorOrOverrides && floorOrOverrides.F != null
    ? floorOrOverrides
    : computeFloor(listing.sku.key, listing.costOverrides || {});
  const o = ordersPerDay(listing, p, opts);
  return o * f.k * (p - f.F);
}

/** Profit per impression - the bandit's reward (deck slide 7 box 4, M19). */
export function rewardPerImpression(listing, p, f) {
  const theta = thetaTrue(listing, p, f);
  return theta * (p - f.F);
}

/** Base kept-per-impression rate theta_a = CTR x CVR x k. */
export function thetaTrue(listing, p, f) {
  const sku = listing.sku;
  const beta = listing.beta ?? betaPrior(sku.category);
  return ENGINE.CTR0 * ENGINE.CVR0 * Math.pow(p / f.Pe, beta) * penalty(p, sku.median) * f.k;
}

/** Prior belief about theta (no SKU data yet) - pooled demand model only. */
export function thetaPrior(p, f) {
  return ENGINE.CTR0 * ENGINE.CVR0 * Math.pow(p / f.Pe, ENGINE.BETA) * f.k;
}

/** Shrinkage weight on the SKU's own data vs the category prior. */
export function shrinkage(n, n0 = ENGINE.N0) {
  return n / (n + n0);
}

/**
 * What-if: the simulator's table + curve (deck slide 6 box 4 "what-if simulator").
 * Returns one row per price plus the best price inside the visible range.
 */
export function simulate(listing, opts = {}) {
  const f = opts.floor || computeFloor(listing.sku.key, listing.costOverrides || {});
  const kink = opts.kink !== false;
  const sku = listing.sku;
  const lo = opts.lo ?? Math.min(f.arms[0], sku.closestRival, f.F - 10);
  const hi = opts.hi ?? Math.round(f.Pe * 1.217);

  const rows = f.arms
    .filter((p) => p >= lo && p <= hi)
    .map((p) => {
      const o = ordersPerDay(listing, p, { kink });
      const d = o * f.k * (p - f.F);
      return {
        price: p,
        ordersPerDay: +o.toFixed(2),
        profitPerKeptOrder: round2(p - f.F),
        profitPerDay: round2(d),
        belowFloor: p < f.F,
        blocked: p < f.F,
        isLive: p === listing.price,
      };
    });

  const curve = [];
  for (let p = lo; p <= hi; p += 2) {
    curve.push([p, round2(profitPerDay(listing, p, f, { kink }))]);
  }
  let best = null;
  let bestV = -Infinity;
  for (let p = lo; p <= hi; p++) {
    const v = profitPerDay(listing, p, f, { kink });
    if (v > bestV) { bestV = v; best = p; }
  }

  const atLive = profitPerDay(listing, listing.price, f, { kink });
  const bestRow = rows.find((r) => r.price === best);

  return {
    listing: listing.id,
    sku: sku.key,
    kink,
    range: [lo, hi],
    floor: { F: f.F, B: f.B, k: f.k, recoveryFloor: f.frec },
    rows,
    curve,
    best: { price: best, profitPerDay: round2(bestV), inMenu: !!bestRow },
    live: { price: listing.price, profitPerDay: round2(atLive), profitPerKeptOrder: round2(listing.price - f.F) },
    warning: rows.some((r) => r.belowFloor)
      ? `Arms below the floor are blocked before any test: ₹${f.arms[0]} sits ${f.F - f.arms[0]} below F ₹${f.F}.`
      : null,
  };
}

/** Loss Warning for a hand-typed price (deck slide 6 box 3). */
export function lossWarning(listing, price, opts = {}) {
  const f = opts.floor || computeFloor(listing.sku.key, listing.costOverrides || {});
  const consent = !!opts.consent;
  const floorUsed = consent ? f.frec : f.F;
  const perOrder = price - f.F;
  return {
    price,
    floor: f.F,
    recoveryFloor: f.frec,
    floorUsed,
    perKeptOrder: round2(perOrder),
    blocked: !consent && price < f.F,
    blockedBelowRecovery: consent && price < f.frec,
    message: price >= f.F
      ? null
      : `₹${price} is ₹${Math.abs(round2(perOrder))} below your floor F ₹${f.F}. Every kept order loses ₹${Math.abs(round2(perOrder))}.`,
    panicBrake: 'A cut below F needs the price-value branch of the diagnostic tree to fire first (deck slide 5 box 3).',
  };
}

/** Return/RTO mix estimate at a price: COD share falls as price rises (deck slide 2 box 6). */
export function riskMixAtPrice(listing, price, f) {
  const codShare = listing.codShare ?? 0.5;
  const elasticity = -0.35; // COD share vs price index, planning default
  const codAtPrice = Math.max(0.05, Math.min(0.95, codShare * Math.pow(price / listing.price, elasticity)));
  return {
    codShare: round2(codAtPrice),
    prepaidShare: round2(1 - codAtPrice),
    note: 'price also moves RTO: a lower price pulls in more COD buyers, who refuse more',
  };
}

export const round2 = (x) => Math.round(x * 100) / 100;
