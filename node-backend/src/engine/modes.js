/**
 * LAYER: DECISION - goal modes.
 * Deck slide 6 box 2: "Three control modes; goals: CASH = paid sooner,
 * GROWTH = sales first, MARGIN = ₹ per piece, CLEAR = sell fast, >= cost".
 *
 * Each mode changes (a) the objective the engine optimises and (b) which arms
 * are eligible. The floor is never negotiable - it is enforced in every mode.
 */

import { ENGINE, MODES } from '../config/deck.js';
import { computeFloor, ceil9, floor9, round } from './floor.js';

/** The mode's advertised prices for a SKU (used on the Modes screen + first price). */
export function modePrice(skuKey, mode = 'growth', overrides = {}) {
  const f = computeFloor(skuKey, overrides);
  switch (mode) {
    case 'cash':
      return {
        mode, lead: f.Pn, alt: f.Pe,
        label: `No-return ₹${f.Pn} + prepaid nudge`,
        margin: round2(1 - f.Fno / f.Pn),
        why: `No-return floor = F - C_ret = ₹${f.F} - ₹${f.Cret} = ₹${f.Fno}. Cash is final sooner because a no-return order cannot come back.`,
      };
    case 'growth':
      return {
        mode, lead: f.Pn, alt: f.Pe,
        label: `₹${f.Pn}-₹${f.Pe}`,
        margin: round2(1 - f.F / f.Pe),
        why: `Volume-first: start at F + T = ₹${f.Pe} with the no-return price ₹${f.Pn} as the lead, step +3-5% once CVR holds 2 weeks.`,
      };
    case 'margin':
      return {
        mode, lead: f.Pm, alt: f.Pe + 2 * (f.arms[3] - f.Pe),
        label: `₹${f.Pm} (arms ₹${f.Pe}-₹${f.arms[4]})`,
        margin: round2(1 - f.F / f.Pm),
        why: `P* = F / (1 - m) = ₹${f.F} / 0.78 = ₹${round2(f.F / 0.78)} -> ₹${f.Pm}. Arms below ₹${f.T} profit per kept order are filtered out.`,
      };
    default:
      return {
        mode: 'clear', lead: f.Fplus, alt: f.Fplus,
        label: `₹${f.Fplus} - never below ₹${f.F}`,
        margin: round2(1 - f.F / f.Fplus),
        why: `Clearance price = F / 0.97 = ₹${f.Fplus} (m = 3%). Deeper only at Exit with explicit consent, never below the recovery floor ₹${f.frec}.`,
      };
  }
}

/** Objective value the bandit maximises for an arm, per mode. */
export function objective(mode, arm, f) {
  const margin = arm.p - f.F;
  switch (mode) {
    case 'clear':  return 1;                 // sell-through first: maximise kept orders per impression
    case 'margin': return margin < f.T ? -Infinity : margin;
    default:       return margin;            // cash + growth: ₹ per impression
  }
}

/** Eligibility: hard floor first, then the mode rule. */
export function eligible(mode, arm, f) {
  if (arm.p < f.F) return { ok: false, reason: 'below floor F' };
  if (mode === 'margin' && arm.p - f.F < f.T) return { ok: false, reason: 'below target profit T' };
  return { ok: true, reason: 'eligible' };
}

/** CASH mode: profit per rupee-day, easy-returns vs no-return. */
export function cashComparison(f, price = f.Pe) {
  const e = ENGINE.CASH_CYCLE_EASY_RETURNS_DAYS;
  const n = ENGINE.CASH_CYCLE_NO_RETURN_DAYS;
  const easy = { price, floor: f.F, profit: price - f.F, days: e, perRupeeDay: round4((price - f.F) / (f.F * e)) };
  const pn = price - f.gap;
  const no = { price: pn, floor: f.Fno, profit: pn - f.Fno, days: n, perRupeeDay: round4((pn - f.Fno) / (f.Fno * n)) };
  return {
    easy, noReturn: no,
    multiple: round2(no.perRupeeDay / easy.perRupeeDay),
    why: [
      `Assumed cash cycle: easy-returns about ${e} days (return window), no-return about ${n} days.`,
      `Meesho already runs dual pricing: >${ENGINE.SHARE_NO_RETURN_PICK * 100}% of delivered orders pick the lower no-return price, ~${ENGINE.NO_RETURN_RETURN_DROP * 100}% fewer returns.`,
      "The dual-price gap goes to the buyer; the seller's profit per kept order stays about the same, cash arrives sooner.",
    ],
  };
}

/** CLEAR mode: bounded markdown step that never crosses the floor. */
export function clearStep(f, price, overrides = {}) {
  if (price <= f.Fplus) return { price, moved: false, why: `₹${price} is already at the clearance price F / 0.97 = ₹${f.Fplus}.` };
  const target = Math.max(f.Fplus, ceil9(price * (1 - ENGINE.MARKDOWN_TARGET_MARGIN - 0.05)));
  return {
    price: target, moved: true,
    stepPct: round2((target - price) / price * 100),
    why: `CLEAR: sell fast, never below F ₹${f.F}. Step ${round2((target - price) / price * 100)}% (limit ${8}%), stopping at ₹${f.Fplus} = F / 0.97.`,
  };
}

/** The mode whitelist used by the "Modes" screen and by GET /api/meta. */
export function modeCatalogue() {
  return Object.values(MODES);
}

export const round2 = (x) => Math.round(x * 100) / 100;
export const round4 = (x) => Math.round(x * 10000) / 10000;

export { floor9, ceil9 };
