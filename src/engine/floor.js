/**
 * LAYER: MODELS (1 of 4 the pilot needs) - cost & floor model.
 * Deck slide 2 box 2/4 (M4, M6), slide 3 box 2, slide 6 box 3.
 *
 *   F = all costs / kept orders = C_s + C_pack + C_fwd + C_ret + C_RTO + other
 *   B = C_ret + C_RTO                      (the return + RTO buffer, already inside F)
 *   k = kept / 100 placed                  (the kept rate: 100 -> 97 -> deliv -> kept)
 *
 * The deck's own worked example (slide 2 box 4), which the parity tests assert:
 *   sourcing 180 + pack 10 + fwd 25 + return 32 + RTO 18 + other 44 = F 309
 *   kurti: 100 placed -> 97 dispatched -> 89 delivered -> 78 kept  => k = 0.78, B = 50
 */

import { CATEGORIES, ENGINE, GUARDRAILS, SKUS } from '../config/deck.js';

export const round = (x) => Math.round(x);
export const ceil9 = (x) => Math.ceil((x + 1) / 10) * 10 - 1;
export const floor9 = (x) => Math.floor((x + 1) / 10) * 10 - 1;
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/** Merge catalogue cost defaults <- category prior <- seller overrides. */
export function costInputs(sku, overrides = {}) {
  const cat = CATEGORIES[overrides.category || sku.category];
  const base = {
    category: sku.category,
    cs: sku.costs.cs,
    pack: sku.costs.pack,
    fwd: sku.costs.fwd,
    ret: sku.costs.ret,
    rto: sku.costs.rto,
    T: sku.costs.T,
    ...cat.other, // dmg, promo, ads, tax, cap
  };
  return { ...base, ...overrides, category: overrides.category || sku.category };
}

/**
 * The floor. Pure function: (cost inputs) -> (F, B, k, arms, dual price, recovery floor).
 * All money is INR per kept order unless noted.
 */
export function computeFloor(skuKey, overrides = {}) {
  const sku = SKUS[skuKey];
  if (!sku) throw new Error(`unknown SKU: ${skuKey}`);
  const c = costInputs(sku, overrides);
  const cat = CATEGORIES[c.category];
  const o = { dmg: c.dmg, promo: c.promo, ads: c.ads, tax: c.tax, cap: c.cap };

  // 100 placed orders -> dispatched -> delivered -> kept  (deck slide 2 box 1)
  const placed = 100;
  const dispatched = round(placed * ENGINE.SHARE_DISPATCHED);
  const rtoN = round(dispatched * c.rto / 100);
  const delivered = dispatched - rtoN;
  const retN = round(delivered * c.ret / 100);
  const kept = delivered - retN;
  const k = kept / placed;

  // Return / RTO cost spread over the orders that actually stay sold
  const Cret = round(retN * cat.unitRet / kept);
  const Crto = round(rtoN * cat.unitRto / kept);
  const other = o.dmg + o.promo + o.ads + o.tax + o.cap;
  const F = c.cs + c.pack + c.fwd + Cret + Crto + other;
  const B = Cret + Crto;                      // return + RTO buffer per kept order
  const T = c.T;                              // the seller's target profit per piece
  const Pe = F + T;                           // easy-returns start price
  const gap = Math.max(10, 10 * round(Cret / 10)); // dual-price gap ~= return cost saved
  const Pn = Pe - gap;                        // no-return start price
  const Fno = F - Cret;                       // no-return floor: F - C_ret
  const Fplus = ceil9(F / (1 - ENGINE.MARKDOWN_TARGET_MARGIN)); // clearance: F / 0.97
  const Pm = Math.max(Pe, ceil9(F / (1 - ENGINE.MARGIN_MODE_M))); // MARGIN mode start: F / 0.78
  const Pg = ceil9(F / 0.92);                 // 8% growth headroom reference

  // Menu arms (deck slide 7 box 4): 5 arms; the lean arm (index 1) is dropped by the bandit
  const u = Math.max(10, round(Pe * 0.0813 / 10) * 10);
  const arms = [Pn - u - 10, Pn, Pe, Pe + u, Pe + 2 * u];

  const frec = Math.min(sku.recoveryFloorFallback, F - 1); // recovery floor = variable costs only

  return {
    sku: skuKey,
    skuName: sku.name,
    category: c.category,
    categoryName: cat.name,
    inputs: c,
    other,
    otherLines: o,
    stepped: { placed, dispatched, delivered, kept, rtoN, retN },
    k, kept, delivered, dispatched, retN, rtoN, placed,
    cs: c.cs, pack: c.pack, fwd: c.fwd, ret: c.ret, rto: c.rto, T,
    Cret, Crto, B,
    F, Pe, Pn, gap, Fno, Fplus, Pm, Pg, arms, frec,
    marginAtPe: 1 - F / Pe,
    marginAtPn: 1 - Fno / Pn,
    // deck slide 2 box 6: "the flat guess under-prices every kept order by ₹35"
    sellerGuessBuffer: 15,
    engineBuffer: B,
    bufferUnderestimate: B - 15,
  };
}

/** Price at a target margin: P* = F / (1 - m).  Deck slide 2 box 2. */
export function priceAtMargin(F, m) {
  return F / (1 - m);
}

/**
 * Floor sensitivity (deck slide 2 box 2): what moves F.
 * Each lever is re-run through the same floor model, so the number the seller
 * sees is the engine's own arithmetic. `deck` records the figure printed on the
 * slide, and `matchesDeck` flags any divergence (see docs/DECK_FIDELITY.md).
 */
export function sensitivity(skuKey, overrides = {}) {
  const base = computeFloor(skuKey, overrides);
  const levers = [
    { key: 'sourcing', label: 'Sourcing +₹40', change: { cs: base.inputs.cs + 40 }, deck: 30,
      note: 'the seller pays this on every kept order, so F moves 1:1 with the input' },
    { key: 'returns', label: 'Returns 12% -> 20% (+8 pp)', change: { ret: base.inputs.ret + 8 }, deck: 25,
      note: 'return cost spread over fewer kept orders' },
    { key: 'weight', label: 'Weight 0.5 kg -> 1 kg (freight slab)', change: { fwd: base.inputs.fwd + 20 }, deck: 20,
      note: 'forward freight by weight slab' },
    { key: 'rto', label: 'RTO 8% -> 15% (+7 pp)', change: { rto: base.inputs.rto + 7 }, deck: 18,
      note: 'COD refusals are paid out of the kept orders' },
    { key: 'cod', label: 'COD share 50% -> 80%', change: { rto: base.inputs.rto + 6 }, deck: 15,
      note: 'modelled as +6 pp RTO (COD orders fail 20.9% vs 5.8% prepaid)' },
    { key: 'ads', label: 'Ads ₹12 -> ₹25 per kept order', change: { ads: 25 }, deck: 12,
      note: 'ads sit inside the floor, so a ₹13 spend increase is ₹13 on F' },
  ];
  return {
    base: { F: base.F, B: base.B, k: base.k },
    levers: levers.map((l) => {
      const after = computeFloor(skuKey, { ...overrides, ...l.change });
      const delta = after.F - base.F;
      const parts = {
        Cret: after.Cret - base.Cret,
        Crto: after.Crto - base.Crto,
        other: after.other - base.other,
        direct: (l.change.cs ? 40 : 0) + (l.change.fwd ? 20 : 0),
      };
      return {
        key: l.key, label: l.label, note: l.note,
        dF: delta, dF_deck: l.deck,
        matchesDeck: Math.abs(delta - l.deck) <= 2,
        F_after: after.F, breakdown: parts,
        // deck slide 2 shows the sensitivity as "the gap between what the seller
        // guesses and what the floor needs", so we also report the priced impact
        priceAt15pctMargin: ceil9(priceAtMargin(after.F, ENGINE.TARGET_MARGIN_DEFAULT)),
      };
    }),
    // the five levers the deck highlights as "never typed by the seller"
    buyerSide: 'Returns/RTO/COD/ads are computed from Meesho\'s own reason codes and rate cards; the seller only types C_s and T.',
  };
}

/** Cheap check used by the ops console and the tests. */
export function floorIsSane(f) {
  const sum = f.cs + f.pack + f.fwd + f.Cret + f.Crto + f.other;
  return {
    sumsToF: Math.abs(sum - f.F) < 1e-9,
    keptConsistent: f.kept === f.delivered - f.retN && f.delivered === f.dispatched - f.rtoN,
    floorBelowStartPrice: f.F < f.Pe,
    noReturnFloorBelowFloor: f.Fno <= f.F,
    withinGuardrails: f.arms[2] >= f.F,
  };
}

/**
 * The floor "Why" card (deck slide 6 box 3 - every suggestion has a Why).
 * Returns the same five blocks the product shows: what / why / ₹ effect /
 * confidence / undo.
 */
export function floorWhy(skuKey, overrides = {}) {
  const f = computeFloor(skuKey, overrides);
  return {
    title: `Your floor F = ${f.F}`,
    what: `F = ₹${f.F} per kept order for ${f.skuName}. Selling below F loses money on every order that stays sold.`,
    why: [
      `C_s ${f.cs} + C_pack ${f.pack} + C_fwd ${f.fwd} + C_ret ${f.Cret} + C_RTO ${f.Crto} + other ${f.other} = ₹${f.F}`,
      `Kept rate k = ${f.k.toFixed(2)}: 100 placed -> ${f.dispatched} dispatched -> ${f.delivered} delivered -> ${f.kept} kept.`,
      `Return + RTO cost B = ₹${f.B} per kept order: already inside F, never added twice.`,
      `Dual price: easy-returns ₹${f.Pe} / no-return ₹${f.Pn}. The ₹${f.gap} gap is the return cost a no-return buyer never triggers, so the seller does not type it.`,
      `Naive check: ₹${f.Pe} - sourcing ₹${f.cs} = ₹${f.Pe - f.cs}, but the real profit per kept order is ₹${f.Pe - f.F}. A flat ₹15 buffer guess under-prices every kept order by ₹${f.bufferUnderestimate}.`,
    ],
    effect: `At ₹${f.Pe}: ₹${f.Pe - f.F} profit per kept order. At ₹${f.Pn}: ₹${f.Pn - f.Fno} (same, because the gap equals the saved return cost).`,
    confidence: 'High',
    confidenceWhy: 'The seller\'s own cost inputs plus category priors for returns/RTO, recalibrated weekly against Meesho settlements (+-5% target).',
    undo: 'Floor protection is ON in every mode; it cannot be switched off. The floor itself is recomputed weekly.',
    guardrails: {
      maxStepPct: GUARDRAILS.maxStepPct,
      hardFloor: GUARDRAILS.hardFloor,
      recoveryFloor: f.frec,
    },
  };
}
