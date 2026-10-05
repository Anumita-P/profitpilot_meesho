/**
 * PROMOTION-AWARE ECONOMICS (v2 phase 5).
 *
 * The customer pays the EFFECTIVE price; the seller's economics must be computed
 * on the same number the shopper sees. So:
 *
 *     base price  +  seller discount  +  promotion  =  effective price
 *
 * Everything downstream (the floor comparison, contribution, demand, the
 * counterfactual grid, the experiment's baseline) uses the effective price, while
 * the ACTION still names which lever moved - because "cut the base price" and
 * "run a ₹30 coupon" are different decisions with different costs, different
 * reversibility, and different effects on the price history that the cooldown and
 * the ±8% step rule depend on.
 *
 * Two jobs:
 *   1. compose the price the shopper sees, and say who contributed what;
 *   2. detect CONTRADICTORY interventions - the case the deck cares about, where
 *      the engine is about to cut the base price while an active promotion already
 *      gives the shopper an equivalent discount. The right answer there is usually
 *      HOLD the base price, not "discount twice".
 *
 * Nothing in this file guesses. A promotion is only considered active if it is
 * recorded with `active: true`; the equivalence test is arithmetic on the two
 * discounts; and the recommendation's cost is measured on the promotion's own
 * budget (unit cost of the coupon), not on the base price alone.
 */

import { load, save, logEvent, httpError, listing, hydrate } from '../store/db.js';
import { enumValue, money, number, text, timestamp, boolean } from '../http/validate.js';
import { computeFloor } from '../engine/floor.js';
import { versionSet } from './versions.js';

export const KINDS = ['coupon', 'flat_discount', 'free_shipping', 'bundle'];
/** How much of the promotion the SELLER funds, per kind. Free shipping is funded
 *  by the seller too (it is a real cost), a bundle is priced into the basket. */
export const FUNDING = { coupon: 1, flat_discount: 1, free_shipping: 1, bundle: 0 };
/** How much a promotion of this kind is worth to the shopper, relative to its
 *  face value: a coupon is a straight discount, free shipping is worth less
 *  (buyers discount it mentally), a bundle changes the basket. These weights are
 *  planning defaults, declared here so they can be argued with in one place. */
export const SHOPPER_WEIGHT = { coupon: 1, flat_discount: 1, free_shipping: 0.7, bundle: 0.5 };

const round2 = (x) => Math.round(x * 100) / 100;

/** All promotions on record for a listing (newest last). */
export function forListing(listingId) {
  return (load().promotions || []).filter((p) => p.listing_id === listingId);
}

export function activeFor(listingId) {
  return forListing(listingId).filter((p) => p.active);
}

/**
 * The price the shopper actually pays, and the split of who pays for it.
 * @returns {{basePrice, promoValue, shippingValue, effectivePrice, sellerFunded, shopperValue, promotions, note}}
 */
export function composePrice(listingId, { basePrice = null, promotions = null } = {}) {
  const l = listing(listingId);
  const base = Math.round(basePrice ?? l.price);
  const list = promotions || activeFor(listingId);
  let sellerFunded = 0;
  let shopperValue = 0;
  let shippingWaived = false;
  for (const p of list) {
    const face = p.kind === 'free_shipping' ? (p.value || 0) : p.value;
    sellerFunded += FUNDING[p.kind] * face;
    shopperValue += SHOPPER_WEIGHT[p.kind] * face;
    if (p.kind === 'free_shipping') shippingWaived = true;
  }
  const effective = Math.max(1, Math.round(base - sellerFunded * (1 - 0)));   // the shopper pays base minus what the seller funds
  return {
    listing_id: listingId,
    basePrice: base,
    promotions: list.map((p) => ({ promotion_id: p.promotion_id, kind: p.kind, value: p.value, active: p.active, note: p.note || null })),
    promotionValue: round2(sellerFunded),
    shopperDiscountValue: round2(shopperValue),
    freeShipping: shippingWaived,
    effectivePrice: effective,
    discountPct: base ? round2(((base - effective) / base) * 100) : 0,
    note: 'effectivePrice = base - what the seller funds. Contribution, the floor comparison and demand all use effectivePrice; the action records which lever moved.',
  };
}

/** Record (or replace) a promotion on a listing. */
export function setPromotion(listingId, input = {}, ctx = {}) {
  const d = load();
  const l = listing(listingId);
  const promo = {
    promotion_id: `PR-${(d.promotions || []).length + 1}`,
    listing_id: listingId,
    seller_id: l.sellerId,
    kind: enumValue(input.kind, 'kind', KINDS),
    value: money(input.value, 'value', { min: 0, max: 5000 }),
    active: input.active === undefined ? true : boolean(input.active, 'active'),
    starts_at: input.starts_at ? timestamp(input.starts_at, 'starts_at') : new Date().toISOString(),
    ends_at: input.ends_at ? timestamp(input.ends_at, 'ends_at') : null,
    note: text(input.note || null, 'note', { required: false, maxLength: 200, default: null }),
    created_at: new Date().toISOString(),
    actor: ctx.actor || 'seller',
    versions: versionSet(),
  };
  d.promotions.push(promo);
  logEvent('promotion.set', { listingId, promotionId: promo.promotion_id, kind: promo.kind, value: promo.value, active: promo.active, actor: promo.actor });
  save();
  return promo;
}

export function endPromotion(promotionId, { at = null, reason = null } = {}) {
  const d = load();
  const p = (d.promotions || []).find((x) => x.promotion_id === promotionId);
  if (!p) throw httpError(404, `unknown promotion: ${promotionId}`);
  p.active = false;
  p.ended_at = at ? timestamp(at, 'at') : new Date().toISOString();
  p.end_reason = reason;
  logEvent('promotion.ended', { listingId: p.listing_id, promotionId, reason });
  save();
  return p;
}

/**
 * Does the seller already have a promotion that gives the shopper what a base
 * price cut would give? If yes, the base cut is redundant - and the honest
 * recommendation is to HOLD the base price and change the promotion (or nothing).
 *
 * @param {string} listingId
 * @param {number} candidateBasePrice the proposed new base price
 */
export function contradiction(listingId, candidateBasePrice) {
  const l = listing(listingId);
  const now = composePrice(listingId);
  const after = composePrice(listingId, { basePrice: candidateBasePrice });
  const active = now.promotions.filter((p) => p.active);
  const baseCut = round2(now.basePrice - after.basePrice);
  const promoDiscount = round2(now.basePrice - now.effectivePrice);
  const candidateEffectiveCut = round2(now.effectivePrice - after.effectivePrice);
  const stacks = active.length > 0 && baseCut > 0;              // both are funded by the seller
  /* The case the product cares about: a comparable discount is ALREADY live, so
     cutting the base price mostly re-expresses a discount the shopper already has
     - and the seller ends up paying for both. The threshold is declared: a base
     cut is treated as redundant when the live promotion is worth at least half of
     it (baseCut <= 2 x promoDiscount). */
  const equivalent = baseCut > 0 && promoDiscount > 0 && baseCut <= 2 * promoDiscount;
  const why = equivalent
    ? `a promotion worth ₹${promoDiscount} is already live and the proposed base-price cut is ₹${baseCut}: the shopper already has most of this discount, and stacking the two means the seller funds ₹${round2(promoDiscount + baseCut)} for one effect`
    : stacks
      ? `a promotion worth ₹${promoDiscount} is live: a base-price cut stacks on top of it, so the seller would fund both levers at once`
      : (baseCut > 0
        ? `the base cut moves the shopper's price by ₹${candidateEffectiveCut}; no comparable promotion is live`
        : 'the candidate does not cut the base price');
  return {
    contradictory: equivalent,
    stacks,
    why,
    existing_promotion_value: promoDiscount,
    base_cut: baseCut,
    existing_effective: now.effectivePrice,
    candidate_effective: after.effectivePrice,
    stacking_cost: stacks ? round2(promoDiscount + baseCut) : 0,
    effective_change_pct: now.effectivePrice ? round2(((after.effectivePrice - now.effectivePrice) / now.effectivePrice) * 100) : 0,
    equivalent_lever: equivalent ? 'change or end the promotion instead of the base price' : null,
    rule: 'when a comparable discount is already live, HOLD the base price and change the promotion (or do nothing) - the deck\'s rule that price is the last lever, applied to promotions',
  };
}

/**
 * What each lever would cost the seller per kept order, so "change promotion" and
 * "change price" can be compared on the same basis.
 */
export function leverCosts(listingId, { candidates = null } = {}) {
  const l = hydrate(listing(listingId));
  const floor = computeFloor(l.skuKey, l.costOverrides || {});
  const now = composePrice(listingId);
  const base = now.basePrice;
  const prices = candidates || [
    base,
    Math.round(base * 0.96), Math.round(base * 0.92), Math.round(base * 0.88),
    Math.round(base * 1.04), Math.round(base * 1.08),
  ];
  const promoLevers = [0, 10, 20, 30, 50].map((v) => ({
    lever: 'promotion',
    value: v,
    effectivePrice: Math.max(1, base - v),
    contributionPerKeptOrder: round2(Math.max(1, base - v) - floor.F),
    belowFloor: Math.max(1, base - v) < floor.F,
  }));
  return {
    listing_id: listingId,
    floor: floor.F,
    base_price: base,
    current: now,
    price_levers: prices.map((p) => ({
      lever: 'base_price',
      value: p,
      effectivePrice: Math.max(1, p - (base - now.effectivePrice)),
      contributionPerKeptOrder: round2(Math.max(1, p - (base - now.effectivePrice)) - floor.F),
      stepPct: round2(((p - base) / base) * 100),
      belowFloor: Math.max(1, p - (base - now.effectivePrice)) < floor.F,
    })),
    promotion_levers: promoLevers,
    reading: 'Both lever families are measured as contribution per kept order, and both are checked against the same floor. A promotion is not a way around the floor.',
  };
}

/** Promotions the seller has granted that are worth mentioning in an explanation. */
export function describe(listingId) {
  const active = activeFor(listingId);
  if (!active.length) return { active: false, line: 'No active promotion.' };
  const c = composePrice(listingId);
  return {
    active: true,
    line: `Active promotion: ₹${c.promotionValue} off an ₹${c.basePrice} base price (shopper pays ₹${c.effectivePrice}).`,
    compose: c,
  };
}
