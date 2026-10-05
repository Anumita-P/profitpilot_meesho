/**
 * FORMAL MODEL INTERFACES (requirement 9).
 *
 * Five named model interfaces, each with the same shape so a reader (or a future
 * engineer) can see exactly what a model must accept and return:
 *
 *   predictDemand(listing, price, opts)        -> orders/day at that price
 *   estimateReturnRisk(listing, opts)          -> return / RTO risk for the SKU
 *   estimateKeepProbability(listing, cluster)  -> P(order is kept | delivery)
 *   classifyLifecycle(listing, opts)           -> stage + window + reasons
 *   recommendPrice(listing, opts)              -> the card the seller sees
 *
 * WHAT THESE ARE, STATED PLAINLY: deterministic, documented rules and deck
 * constants. There is no machine learning in this repository, no trained
 * weights, and no accuracy figure is claimed anywhere. The demand curve is the
 * deck's own elasticity form, the risk model uses the seed rates, the keep
 * probability is a logistic over pincode/hub signals with hand-set coefficients,
 * the lifecycle classifier is a threshold rule. They are deliberately simple so
 * that every number in the demo can be recomputed by hand.
 *
 * REPLACEMENT POINT: each interface returns `model` (name + version) and
 * `replaceWith` (what a real model would be). Swapping in a served model means
 * implementing the same input/output contract in one place - the callers
 * (engine, recommender, action queue, scheduler) do not change. `deterministic`
 * says whether the current implementation is a rule (true) or a fitted model
 * (false, nothing here).
 *
 * Every interface is also exposed over HTTP (GET /api/models, POST
 * /api/models/:name) so the contract can be exercised without reading the code.
 */

import { ordersPerDay, lossWarning, riskMixAtPrice, betaPrior } from '../engine/demand.js';
import { returnRisk, keepProbability, bufferMatrix } from '../engine/risk.js';
import { lifecycle, classifyStage, stageSignals } from '../engine/lifecycle.js';
import { recommend, confidence } from '../engine/recommend.js';
import { computeFloor } from '../engine/floor.js';
import { hydrate, listing as getListing, httpError } from '../store/db.js';
import { versionSet } from '../domain/versions.js';

const V = versionSet();

const wrap = ({ name, version, inputs, output, deterministic = true, model, replaceWith, explain, notes = null }) => ({
  model_interface: name,
  model,
  version,
  deterministic,
  inputs,
  output,
  explain,
  replaceWith,
  notes,
});

/* ------------------------------ predictDemand ----------------------------- */

export function predictDemand(listingOrId, price = null, opts = {}) {
  const l = typeof listingOrId === 'string' ? hydrate(getListing(listingOrId)) : listingOrId;
  const p = price != null ? Number(price) : l.price;
  const orders = ordersPerDay(l, p, opts);
  const floor = l.floor || computeFloor(l.skuKey, l.costOverrides || {});
  const mix = riskMixAtPrice(l, p, floor);
  return wrap({
    name: 'predictDemand',
    model: `${V.demand_model_version} (deck demand curve, evaluated deterministically)`,
    version: V.demand_model_version,
    inputs: {
      listing_id: l.id, sku: l.skuKey, price: p, baseline_orders_per_day: l.signals?.q0 ?? l.q0 ?? null,
      median_price: l.priceMedian ?? null,
      beta_prior: betaPrior(l.sku?.category || l.category || 'apparel'),
      signals: { views: l.signals?.views ?? null, ctr: l.signals?.ctr ?? null, cvr: l.signals?.cvr ?? null },
    },
    output: { orders_per_day: orders, ...mix },
    explain: `At ₹${p} the curve predicts ${orders.ordersPerDay ?? orders} orders/day for ${l.skuKey}; the median-anchored penalty term is the only shape assumption.`,
    replaceWith: 'a served demand model (gradient boosting or a hierarchical Bayesian elasticity) with the same signature: (listing features, price) -> orders/day distribution. Wire it into this function only.',
    notes: 'Monotone in price by construction before the penalty term; no accuracy is claimed - the curve is the deck\'s planning form.',
  });
}

/* ---------------------------- estimateReturnRisk -------------------------- */

export function estimateReturnRisk(listingOrId, opts = {}) {
  const l = typeof listingOrId === 'string' ? hydrate(getListing(listingOrId)) : listingOrId;
  const floor = l.floor || computeFloor(l.skuKey, l.costOverrides || {});
  // Same context the listing screen passes to the risk engine today: the SKU's
  // own category and physical features plus the cluster the seller ships into.
  const ctx = {
    category: floor.category,
    fragile: l.sku?.features?.fragile,
    weightKg: l.sku?.features?.weightKg,
    sizeRisk: l.signals?.sizeRisk ?? undefined,
    pincodeCluster: opts.cluster || 'tier2-cod',
    codShare: l.signals?.codShare,
    ...(opts.risk || {}),
  };
  const risk = returnRisk(ctx);
  return wrap({
    name: 'estimateReturnRisk',
    model: `${V.risk_model_version} (category priors + the seller's own signals; no rival data)`,
    version: V.risk_model_version,
    inputs: {
      listing_id: l.id, sku: l.skuKey, category: ctx.category, cluster: ctx.pincodeCluster,
      seller_signals: { returnsPct: l.signals?.returnsPct ?? null, rtoPct: l.signals?.rtoPct ?? null, codShare: l.signals?.codShare ?? null },
      cost_inputs: l.costOverrides || {},
    },
    output: risk,
    explain: `Return/RTO risk for ${l.skuKey} from the category prior and the seller's own returns history; buffer ₹${floor.B} per kept order is what it costs.`,
    replaceWith: 'a per-SKU return-risk model fed by the seller\'s own order-level returns (size/fit/quality reason codes). Same contract: (SKU features) -> {expectedReturnRate, expectedRtoRate, drivers}.',
    notes: 'Legal constraint: the inputs are the seller\'s own SKU-week aggregates and public category priors. No competitor data enters this function (Competition Act 2002 framing in the deck).',
  });
}

/* -------------------------- estimateKeepProbability ----------------------- */

export function estimateKeepProbability(listingOrId, clusterKey = null) {
  const l = typeof listingOrId === 'string' ? hydrate(getListing(listingOrId)) : listingOrId;
  const cluster = clusterKey || 'tier2-cod';
  const out = keepProbability(l, cluster);
  return wrap({
    name: 'estimateKeepProbability',
    model: `${V.risk_model_version}:keep (logistic over pincode-cluster and COD share)`,
    version: V.risk_model_version,
    inputs: { listing_id: l.id, sku: l.skuKey, cluster, cod_share: l.signals?.codShare ?? null, delivery_days: l.signals?.deliveryDays ?? null },
    output: out,
    explain: `P(kept | delivered) = ${out.keepProbability ?? out.p ?? 'n/a'}. COD failure 20.9% vs prepaid 5.8% (Unicommerce, cited in the deck) is what drives it.`,
    replaceWith: 'the same logistic with coefficients fitted on the seller\'s delivered-order outcomes; contract unchanged.',
    notes: 'Hand-set coefficients. The only place a fitted model would change is the coefficient vector.',
  });
}

/* ----------------------------- classifyLifecycle --------------------------- */

export function classifyLifecycle(listingOrId, opts = {}) {
  const l = typeof listingOrId === 'string' ? hydrate(getListing(listingOrId)) : listingOrId;
  const lc = lifecycle(l, opts);
  return wrap({
    name: 'classifyLifecycle',
    model: `${V.lifecycle_model_version} (threshold rule over age, trend, stock and sell-through)`,
    version: V.lifecycle_model_version,
    inputs: { listing_id: l.id, sku: l.skuKey, age_days: l.ageDays, signals: l.signals, stock: l.stock || null },
    output: lc,
    explain: `Stage ${lc.stage} (window ${lc.stageWindow?.fromDay ?? '?'}-${lc.stageWindow?.toDay ?? '?'} day). Windows scale with the category life (life/180).`,
    replaceWith: 'a survival/hazard model over comparable SKUs to place the stage boundary, or a vendor lifecycle signal. Contract: (listing + signals) -> {stage, window, why}.',
    notes: 'Deterministic thresholds from the deck. classifyStage(input) is the raw rule if you prefer to call it directly.',
  });
}

/* ------------------------------- recommendPrice ---------------------------- */

export function recommendPrice(listingOrId, opts = {}) {
  const l = typeof listingOrId === 'string' ? hydrate(getListing(listingOrId)) : listingOrId;
  const mode = opts.mode || l.mode || 'growth';
  const card = recommend(l, { ...opts, mode });
  return wrap({
    name: 'recommendPrice',
    model: `${V.recommender_version} (mode objective + floor + guardrail pre-flight; price is the LAST resort)`,
    version: V.recommender_version,
    inputs: { listing_id: l.id, sku: l.skuKey, mode, price: l.price, floor: l.floor?.F ?? null, mode_objective: opts.objective || null },
    output: card,
    explain: card.why || card.headline || `Mode ${mode} card for ${l.skuKey}.`,
    replaceWith: 'a contextual bandit or an offline-trained policy; the constrained Thompson sampler in src/engine/bandit.js is the in-repo stand-in. Contract: (listing, mode, constraints) -> card {from, to, kind, why, confidence}.',
    notes: 'This interface never bypasses the floor: guardrails are applied by the caller (action queue / publish route) as well.',
  });
}

/* --------------------------------- registry -------------------------------- */

export const INTERFACES = {
  predictDemand,
  estimateReturnRisk,
  estimateKeepProbability,
  classifyLifecycle,
  recommendPrice,
};

export const MODEL_NOTES = {
  claim: 'No machine learning, no fitted weights, no accuracy metric is claimed anywhere in this build. These are deterministic rules over the deck\'s constants and the seller\'s own data.',
  replacement: 'Every interface is a single function with a documented input/output contract: swapping in a served model is a one-function change.',
  versions: V,
  economics_unchanged: 'The floor (F), the C_ret/C_rto buffers and the mode objectives are not model interfaces and are deliberately hard-coded in src/engine/floor.js + src/config/deck.js.',
  fairness: 'estimateReturnRisk uses only the seller\'s own aggregates plus public category priors: no rival data, no pooling across rivals (deck slide 10 legal framing).',
};

/** Call any interface by name with a listing id. Used by POST /api/models/:name. */
export function call(name, { listingId, price = null, mode = null, cluster = null, opts = {} } = {}) {
  const fn = INTERFACES[name];
  if (!fn) throw httpError(404, `unknown model interface: ${name}`, { known: Object.keys(INTERFACES) });
  if (!listingId) throw httpError(400, 'listingId is required', { field: 'listingId' });
  switch (name) {
    case 'predictDemand': return fn(listingId, price, opts);
    case 'estimateKeepProbability': return fn(listingId, cluster);
    case 'recommendPrice': return fn(listingId, { mode, ...opts });
    default: return fn(listingId, opts);
  }
}

/** Everything the interfaces say about one listing, in one call. */
export function explain(listingId, { mode = null } = {}) {
  const l = hydrate(getListing(listingId));
  return {
    listing_id: l.id,
    sku: l.skuKey,
    interfaces: {
      predictDemand: predictDemand(l, l.price),
      estimateReturnRisk: estimateReturnRisk(l),
      estimateKeepProbability: estimateKeepProbability(l),
      classifyLifecycle: classifyLifecycle(l),
      recommendPrice: recommendPrice(l, { mode: mode || l.mode }),
    },
    confidence: confidence(l.signals?.views ?? 0, l.signals?.priceTestImpressions ?? 0),
    notes: MODEL_NOTES,
  };
}

export { stageSignals, classifyStage, bufferMatrix, lossWarning };
