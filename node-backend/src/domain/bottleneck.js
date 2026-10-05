/**
 * BOTTLENECK DIAGNOSIS (v2 phase 6) - the FIRST decision layer.
 *
 * The product question is not "what price should I set?". It is:
 *
 *      "What is actually hurting this product?"
 *
 * So before any price is discussed, the evidence is classified into one of eight
 * categories:
 *
 *   PRICE | CATALOGUE | DEMAND | FULFILMENT | RETURN_RTO | INVENTORY |
 *   PROMOTION | MIXED_UNCERTAIN
 *
 * and the output says whether a PRICE move is even the right lever:
 * `price_action: 'HOLD' | 'HOLD_FIRST' | 'EVALUATE'`.
 *
 * The evidence is the listing's own signals (impressions vs median, CTR and its
 * z-score, CVR and its z-score, price position against the band and the closest
 * rival, return/RTO rates against category priors, delivery days against p75,
 * days of inventory) plus the existing branch diagnosis in src/engine/diagnose.js
 * and the inventory/promotion modules. NOTHING here invents a new metric, and no
 * path defaults to price: price is only concluded when the traffic is fine, the
 * catalogue is fine, the operations are fine, and the conversion is the thing that
 * is broken while the price is out of position.
 *
 * Deterministic: same signals in, same category out. The thresholds are named
 * constants (`T`), so a reviewer can disagree with one number instead of the whole
 * idea.
 */

import { listing, hydrate, httpError } from '../store/db.js';
import { diagnose } from '../engine/diagnose.js';
import { computeFloor } from '../engine/floor.js';
import { DEMAND_LEVEL_FACTOR } from '../sim/scenario.js';
import * as inventory from './inventory.js';
import * as promotion from './promotion.js';

export const CATEGORIES = ['PRICE', 'CATALOGUE', 'DEMAND', 'FULFILMENT', 'RETURN_RTO', 'INVENTORY', 'PROMOTION', 'MIXED_UNCERTAIN'];

/** Thresholds: one place, so the lab and the tests agree. */
export const T = {
  viewsWeakRatio: 0.5,        // impressions below half the median for the category
  viewsHealthyRatio: 0.8,
  ctrWeakZ: -1.0,
  ctrWeakRatio: 0.85,         // CTR below 85% of the category benchmark
  cvrWeakZ: -1.0,
  returnsHotRatio: 1.15,      // returns above 115% of the category prior
  rtoHotRatio: 1.15,
  deliverySlowRatio: 1.15,    // delivery days above 115% of p75
  priceHighGapPct: 8,         // more than 8% above the look-alike median after the penalty
  priceSensitivityHigh: 1.5,  // declared elasticity of demand to price: above this, price is a lever
  priceLowGapPct: -8,
  strongSignalsForMixed: 2,
};

const round2 = (x) => Math.round(x * 100) / 100;

/**
 * Gather the evidence, then classify. Read-only.
 * @param {string} listingId
 * @param {object} opts { counterfactual: the report from counterfactual.grid(), demandLevel }
 */
export function analyse(listingId, { counterfactual = null, inventoryState = null, window = null, demand = null, signalOverrides = null } = {}) {
  const raw = listing(listingId);
  const L = hydrate(raw);
  const f = computeFloor(raw.skuKey, raw.costOverrides || {});
  const s = L.signals || {};

  let branches = null;
  try {
    branches = diagnose(L)?.branches || null;
  } catch { branches = null; }

  const inv = inventoryState || inventory.stateOf(listingId);
  const invStance = inventory.stance(inv, { demand });
  const promo = promotion.describe(listingId);

  /* ---------------------------- the BASIS ---------------------------------
     Traffic, conversion and returns come from a RECENT observed window when one
     is supplied, otherwise from the listing's own signals. The units have to
     match the benchmarks: the window is per-day and conversion is orders per
     CLICK, the same scale as `cvrMedian`. Comparing a cumulative fold against a
     daily median is what made every scenario read as "mixed".               */
  const hasWindow = !!(window && window.counts && window.counts.views > 0);
  const viewsMedian = s.viewsMedian ?? null;
  const ctrBenchmark = s.ctrMedian ?? 4;
  const cvrBenchmark = s.cvrMedian ?? null;
  const basis = hasWindow
    ? {
      source: window.basis,
      window: window.window,
      views_per_day: window.per_day.views,
      views_ratio: viewsMedian ? round2(window.per_day.views / viewsMedian) : null,
      ctr: window.ctr,
      cvr: window.cvr,
      returns_pct: window.returnsPct ?? s.returnsPct ?? null,
      rto_pct: window.rtoPct ?? s.rtoPct ?? null,
      counts: window.counts,
      benchmark: { views_median_per_day: viewsMedian, ctr_median: ctrBenchmark, cvr_median: cvrBenchmark, category_returns_pct: s.categoryReturnsPct ?? null, category_rto_pct: s.categoryRtoPct ?? null },
    }
    : {
      source: 'listing signals (no recent observed window supplied)',
      window: null,
      views_per_day: s.views ?? null,
      views_ratio: viewsMedian ? round2((s.views ?? 0) / viewsMedian) : null,
      ctr: s.ctr ?? null,
      cvr: s.cvr ?? null,
      returns_pct: s.returnsPct ?? null,
      rto_pct: s.rtoPct ?? null,
      counts: null,
      benchmark: { views_median_per_day: viewsMedian, ctr_median: ctrBenchmark, cvr_median: cvrBenchmark, category_returns_pct: s.categoryReturnsPct ?? null, category_rto_pct: s.categoryRtoPct ?? null },
    };

  const viewsRatio = basis.views_ratio;
  const ctrZ = s.ctrZ ?? null;
  const cvrZ = s.cvrZ ?? null;
  const returnsRatio = s.categoryReturnsPct ? round2((basis.returns_pct ?? 0) / s.categoryReturnsPct) : null;
  const rtoRatio = s.categoryRtoPct ? round2((basis.rto_pct ?? 0) / s.categoryRtoPct) : null;
  const deliveryRatio = s.deliveryP75 ? round2(s.deliveryDays / s.deliveryP75) : null;
  const priceGap = signalOverrides?.rivalGapPct ?? s.rivalGapPct ?? null;   // + = we are above the look-alike median
  const priceSensitivity = signalOverrides?.priceSensitivity ?? s.priceSensitivity ?? null;
  const bandMax = L.sku.band?.[1] ?? null;
  const bandMin = L.sku.band?.[0] ?? null;
  const aboveBand = bandMax != null && raw.price > bandMax;
  const belowBand = bandMin != null && raw.price < bandMin;

  /* ---------------------------- the signals ------------------------------ */
  const ctrWeak = hasWindow
    ? (basis.ctr != null && basis.ctr < ctrBenchmark * T.ctrWeakRatio)
    : ((ctrZ != null && ctrZ < T.ctrWeakZ) || (s.ctr != null && s.ctr < ctrBenchmark * T.ctrWeakRatio));
  const cvrWeak = hasWindow
    ? (basis.cvr != null && cvrBenchmark != null && basis.cvr < cvrBenchmark * 0.9)
    : ((cvrZ != null && cvrZ < T.cvrWeakZ) || (s.cvr != null && cvrBenchmark != null && s.cvr < cvrBenchmark * 0.9));

  const signal = {
    impressions_low: viewsRatio != null && viewsRatio < T.viewsWeakRatio,
    impressions_healthy: viewsRatio == null || viewsRatio >= T.viewsHealthyRatio,
    ctr_weak: ctrWeak && (L.sku.lookalikes ?? 0) > 10,
    conversion_weak: cvrWeak,
    returns_hot: returnsRatio != null && returnsRatio > T.returnsHotRatio,
    rto_hot: rtoRatio != null && rtoRatio > T.rtoHotRatio,
    delivery_slow: deliveryRatio != null && deliveryRatio > T.deliverySlowRatio,
    price_out_of_position: (priceGap != null && (priceGap > T.priceHighGapPct || priceGap < T.priceLowGapPct)) || aboveBand || belowBand,
    price_sensitive: priceSensitivity != null && priceSensitivity >= T.priceSensitivityHigh,
    catalogue_quality_low: L.sku.lookalikes != null && L.sku.lookalikes < 12,
    inventory_pressured: ['STOCKOUT_RISK', 'AGING', 'CLEARANCE', 'NEW'].includes(inv.state.key),
    promotion_active: promo.active,
    promotion_contradiction: !!(counterfactual?.promotion_check?.contradictory),
  };

  const evidence = buildEvidence({ L, s, signal, inv, invStance, promo, basis, viewsRatio, ctrZ, returnsRatio, rtoRatio, deliveryRatio, priceGap, priceSensitivity, branches });

  /* --------------------------- classification ---------------------------- */
  const strong = [];
  if (signal.delivery_slow || branches?.delivery?.fired) strong.push('FULFILMENT');
  if (signal.returns_hot || signal.rto_hot || branches?.returns?.fired || branches?.rto?.fired) strong.push('RETURN_RTO');
  if (inv.state.key === 'STOCKOUT_RISK' || inv.state.key === 'CLEARANCE' || inv.state.key === 'AGING') strong.push('INVENTORY');
  if (signal.promotion_contradiction) strong.push('PROMOTION');
  if (signal.impressions_low) strong.push('DEMAND');
  if (inv.state.key === 'NEW') strong.push('DEMAND');
  if (signal.ctr_weak && signal.impressions_healthy) strong.push('CATALOGUE');
  /* PRICE is only a lever when conversion is what is broken and the listing can
     actually be priced: either it sits out of position against its look-alikes, or
     the market itself is demonstrably price-sensitive (the scenario declares that,
     this engine never reads a rival's price). Traffic must not be critically low -
     a price move cannot fix a listing nobody is being shown - but it does not have
     to be thriving either. */
  if (signal.conversion_weak && !signal.impressions_low && !signal.ctr_weak
    && (signal.price_out_of_position || signal.price_sensitive)
    && !signal.returns_hot && !signal.rto_hot && !signal.delivery_slow) strong.push('PRICE');

  const distinct = [...new Set(strong)];
  let primary;
  let confidence;
  let mixedKind = null;
  if (distinct.length === 0) {
    /* Nothing crossed its threshold. That is a real answer, and it is NOT "the
       problem is demand": it means the evidence does not justify an intervention
       yet, so the honest output is "no clear bottleneck" with no price action. */
    primary = 'MIXED_UNCERTAIN';
    confidence = 'low';
    mixedKind = 'no_clear_signal';
  } else if (distinct.length >= T.strongSignalsForMixed) {
    primary = 'MIXED_UNCERTAIN';
    confidence = 'medium';
    mixedKind = 'multiple_signals';
  } else {
    primary = distinct[0];
    confidence = strong.length >= 2 ? 'high' : 'medium';
  }

  /* which part of RETURN_RTO, or which inventory state, is the driver: two
     scenarios can share a category and still be different problems */
  const returnDriver = signal.rto_hot && signal.returns_hot ? 'both' : signal.rto_hot ? 'rto' : signal.returns_hot ? 'returns' : null;
  const primaryDriver = primary === 'RETURN_RTO' ? returnDriver
    : primary === 'INVENTORY' ? inv.state.key
      : primary === 'PRICE' ? (aboveBand ? 'price_above_band' : belowBand ? 'price_below_band' : signal.price_out_of_position ? 'price_off_vs_lookalikes' : 'price_sensitive_market')
        : primary === 'CATALOGUE' ? 'clicks' : null;

  const opsProblem = ['FULFILMENT', 'RETURN_RTO'].includes(primary);
  const invProblem = primary === 'INVENTORY';
  const priceAction = primary === 'PRICE' ? 'EVALUATE'
    : (invProblem && invStance.price_stance === 'CONTROLLED_REDUCTION') ? 'EVALUATE'
      : (opsProblem || primary === 'CATALOGUE' || primary === 'DEMAND' || primary === 'PROMOTION') ? 'HOLD'
        : 'HOLD_FIRST';

  const recommended = recommendedAction(primary, { inv, invStance, promo, signal });

  return {
    listing_id: listingId,
    sku: raw.skuKey,
    category: primary,
    category_label: LABEL_OF[primary],
    primary_driver: primaryDriver,
    mixed_kind: mixedKind,
    secondary: distinct.filter((d) => d !== primary),
    confidence,
    confidence_basis: confidenceBasis({ distinct, strong, evidence, mixedKind }),
    price_action: priceAction,
    recommended_action: recommended,
    evidence,
    signals: signal,
    basis,
    demand_context: demand,
    signal_overrides: signalOverrides,
    facts: {
      impressions: hasWindow ? basis.counts.views : s.views,
      impressions_per_day: basis.views_per_day,
      impressions_median: viewsMedian,
      impressions_ratio: viewsRatio,
      ctr: basis.ctr, ctr_median: ctrBenchmark, ctr_z: ctrZ,
      cvr: basis.cvr, cvr_median: cvrBenchmark, cvr_z: cvrZ,
      returns_pct: basis.returns_pct, category_returns_pct: s.categoryReturnsPct, returns_ratio: returnsRatio,
      rto_pct: basis.rto_pct, category_rto_pct: s.categoryRtoPct, rto_ratio: rtoRatio,
      delivery_days: s.deliveryDays, delivery_p75: s.deliveryP75, delivery_ratio: deliveryRatio,
      price: raw.price, floor: f.F, price_gap_vs_lookalikes_pct: priceGap, price_sensitivity: priceSensitivity,
      band: L.sku.band, lookalikes: L.sku.lookalikes,
      stage: L.stage, mode: L.mode,
      basis_source: basis.source,
    },
    inventory: { state: inv.state, stance: invStance, features: inv.inventory, basis: inv.basis, overrides: inv.overrides },
    promotion: { active: promo.active, line: promo.line },
    existing_branches: branches,
    engine_diagnosis_used: 'src/engine/diagnose.js (unchanged) - the v2 layer classifies its branches and the listing signals into one bottleneck; it does not replace it',
    thresholds: T,
    note: 'Deterministic classification over the listing\'s own evidence. Price is the last lever: it is only proposed when the traffic, catalogue and operations are all fine and conversion is what is broken.',
  };
}

const LABEL_OF = {
  PRICE: 'Price problem',
  CATALOGUE: 'Catalogue quality problem (clicks)',
  DEMAND: 'Demand / visibility problem',
  FULFILMENT: 'Fulfilment problem',
  RETURN_RTO: 'Return / RTO problem',
  INVENTORY: 'Inventory problem',
  PROMOTION: 'Promotion problem',
  MIXED_UNCERTAIN: 'Mixed / uncertain',
};

function buildEvidence({ L, s, signal, inv, invStance, promo, basis, viewsRatio, ctrZ, returnsRatio, rtoRatio, deliveryRatio, priceGap, priceSensitivity, branches }) {
  const e = [];
  e.push({ key: 'basis', value: basis.source, reading: basis.window ? `window ${basis.window.from} -> ${basis.window.to}` : 'the listing\'s stored signals' });
  if (viewsRatio != null) e.push({ key: 'impressions_per_day', value: basis.views_per_day, vs: `daily median ${basis.benchmark.views_median_per_day}`, ratio: viewsRatio, reading: signal.impressions_low ? 'well below the category median' : signal.impressions_healthy ? 'healthy' : 'near the median' });
  else e.push({ key: 'impressions_per_day', value: basis.views_per_day, reading: 'no daily median available to compare against' });
  if (basis.ctr != null) e.push({ key: 'ctr_pct', value: basis.ctr, vs: `median ${basis.benchmark.ctr_median}`, reading: signal.ctr_weak ? 'shoppers see it and do not click' : 'clicks are not the bottleneck' });
  if (basis.cvr != null) e.push({ key: 'cvr_pct', value: basis.cvr, vs: `median ${basis.benchmark.cvr_median}`, reading: signal.conversion_weak ? 'clicks arrive and do not convert' : 'conversion is not the bottleneck' });
  if (basis.returns_pct != null || s.returnsPct != null) e.push({ key: 'returns_pct', value: basis.returns_pct, vs: `category ${basis.benchmark.category_returns_pct}%`, reading: signal.returns_hot ? 'returns are running hot against the category prior' : 'returns are within the category norm' });
  if (basis.rto_pct != null || s.rtoPct != null) e.push({ key: 'rto_pct', value: basis.rto_pct, vs: `category ${basis.benchmark.category_rto_pct}%`, reading: signal.rto_hot ? 'RTO is running hot against the category prior' : 'RTO is within the category norm' });
  if (deliveryRatio != null) e.push({ key: 'delivery_days', value: s.deliveryDays, vs: `p75 ${s.deliveryP75}`, reading: signal.delivery_slow ? 'delivery is slower than the promise' : 'delivery is inside the promise' });
  if (priceGap != null) e.push({ key: 'price_vs_lookalikes_pct', value: priceGap, reading: signal.price_out_of_position ? 'the price is out of position against look-alikes' : 'the price is in position' });
  if (priceSensitivity != null) e.push({ key: 'price_sensitivity', value: priceSensitivity, vs: `high above ${T.priceSensitivityHigh}`, reading: signal.price_sensitive ? 'this market reacts strongly to price' : 'this market does not react strongly to price' });
  e.push({ key: 'inventory_state', value: inv.state.key, reading: invStance.why });
  if (inv.inventory.stockout_probability_14d != null) e.push({ key: 'stockout_probability_14d', value: inv.inventory.stockout_probability_14d, reading: inv.inventory.stockout_probability_14d > 0.6 ? 'a stockout is likely within two weeks' : 'stock covers the near term' });
  e.push({ key: 'promotion', value: promo.active ? 'active' : 'none', reading: promo.line });
  if (branches) {
    const fired = Object.values(branches).filter((b) => b.fired).map((b) => b.label || b.key);
    e.push({ key: 'engine_branches_fired', value: fired.length ? fired : 'none', reading: fired.length ? 'the rule-based branches that also fired' : 'no rule-based branch fired' });
  }
  return e;
}

function confidenceBasis({ distinct, strong, evidence, mixedKind }) {
  if (mixedKind === 'no_clear_signal') return 'no signal crossed its threshold: nothing here justifies an intervention, so confidence is low and the recommendation is to collect more evidence rather than move a price';
  if (distinct.length >= T.strongSignalsForMixed) return `${distinct.length} independent signals crossed their thresholds (${distinct.join(', ')}), so this is reported as mixed`;
  return strong.length >= 2
    ? `${strong.length} independent signals point the same way`
    : 'a single signal crossed its threshold';
}

function recommendedAction(primary, { inv, invStance, promo, signal }) {
  switch (primary) {
    case 'PRICE':
      return {
        key: 'evaluate_price',
        line: 'Price is the bottleneck: evaluate the counterfactual grid - the cheapest price is still not the answer, contribution per kept order is.',
        api: 'POST /api/listings/:id/counterfactual',
      };
    case 'CATALOGUE':
      return {
        key: 'improve_catalogue',
        line: 'Improve the main image, the title and the product information first. Price is not the reason shoppers are not clicking.',
        api: null,
      };
    case 'DEMAND':
      return {
        key: inv.state.key === 'NEW' ? 'learn_first' : 'fix_visibility',
        line: inv.state.key === 'NEW'
          ? 'The listing is new: collect ~4 weeks of traffic before any price decision is meaningful.'
          : 'Traffic is the problem, not the price. Category mapping, attributes and ads come before a discount.',
        api: null,
      };
    case 'FULFILMENT':
      return { key: 'fix_fulfilment', line: 'Delivery is slower than the promise: fix dispatch/packaging before touching price. A price cut on slow delivery buys returns.', api: null };
    case 'RETURN_RTO':
      return { key: 'fix_returns', line: 'Returns/RTO are the bottleneck: size charts, photos, packaging and COD handling. A discount would increase the volume of the same problem.', api: null };
    case 'INVENTORY':
      return {
        key: invStance.key,
        line: invStance.why,
        api: invStance.programme ? `POST /api/programmes/${invStance.programme}` : null,
      };
    case 'PROMOTION':
      return { key: 'adjust_promotion', line: 'An active promotion already gives the shopper most of the discount a price cut would: change the promotion or leave both alone.', api: 'GET /api/listings/:id/promotion' };
    default:
      return { key: 'collect_evidence', line: 'Two or more things are broken at once: fix the operational cause first, then re-price. Nothing here justifies a price move on its own.', api: 'GET /api/closed-loop/status' };
  }
}

/** The whole pipeline in one call: inventory + promotion + diagnosis (+ counterfactual if price is the lever). */
export function full(listingId, { counterfactualFn = null } = {}) {
  const inv = inventory.stateOf(listingId);
  const first = analyse(listingId, { inventoryState: inv });
  let cf = null;
  if (counterfactualFn && first.price_action === 'EVALUATE') cf = counterfactualFn(listingId);
  const second = cf ? analyse(listingId, { counterfactual: cf, inventoryState: inv }) : first;
  return {
    diagnosis: second,
    counterfactual: cf,
    price_evaluated_because: cf ? 'the diagnosis named price (or a controlled reduction) as the lever' : 'the diagnosis did not name price as the lever, so no counterfactual was run',
    note: 'Nothing is executed here. This is the diagnosis layer; the execution path is the action queue, which re-runs the guardrails.',
  };
}
