/**
 * LAYER: MODELS (3 of 4) - return / RTO risk.
 * Deck slide 7 box 2: "return / RTO risk - buffer per SKU x pincode" and the
 * feature table "category, size, pincode, COD", daily refresh, AUC >= 0.75.
 *
 * This is a small, honest logistic model: it is not the LightGBM the deck
 * proposes for production, but it uses exactly the same features and returns
 * the same shape of output (probability, band, action).
 */

import { RISK_MODEL } from '../config/deck.js';
import { round2 } from './demand.js';

const sig = (x) => 1 / (1 + Math.exp(-x));

/** Illustrative pincode clusters (tier + COD behaviour). Nothing real here. */
export const PINCODE_CLUSTERS = [
  { key: 'metro-prepaid', label: 'Metro, prepaid-heavy', tier: 1, codShare: 0.28, note: 'fast lanes, low refusal' },
  { key: 'metro-cod', label: 'Metro, COD-heavy', tier: 1, codShare: 0.62, note: 'high intent, more refusals' },
  { key: 'tier2-prepaid', label: 'Tier-2, prepaid', tier: 2, codShare: 0.45, note: 'Meesho core buyer' },
  { key: 'tier2-cod', label: 'Tier-2, COD', tier: 2, codShare: 0.74, note: '~80% of Meesho shoppers are Tier-2+' },
  { key: 'tier3-cod', label: 'Tier-3+, COD', tier: 3, codShare: 0.86, note: 'hardest refusal rate; prepaid nudge helps most' },
];

/**
 * @param {object} ctx { category, fragile, weightKg, sizeRisk (0-1), pincodeCluster, prepaidNudge, codShare }
 */
export function returnRisk(ctx) {
  const base = RISK_MODEL.categoryReturnBase[ctx.category] ?? 0.12;
  const cluster = PINCODE_CLUSTERS.find((c) => c.key === ctx.pincodeCluster) || PINCODE_CLUSTERS[2];
  const w = RISK_MODEL.weights;
  const cod = ctx.codShare ?? cluster.codShare;
  const z = RISK_MODEL.intercept
    + w.categoryRet * (base - 0.12) * 10
    + w.sizeRisk * (ctx.sizeRisk ?? 0.5)
    + w.codShare * cod
    + w.fragile * (ctx.fragile ? 1 : 0)
    + w.weightKg * Math.min(2, ctx.weightKg ?? 0.5)
    + w.cityTier * (cluster.tier - 1)
    + w.prepaidNudge * (ctx.prepaidNudge ? 1 : 0);
  const pReturn = round2(sig(z) * 100) / 100;
  const pRto = round2((cod * RISK_MODEL.codFailureRate + (1 - cod) * RISK_MODEL.prepaidFailureRate) * 100) / 100;
  const band = pReturn >= 0.22 ? 'high' : pReturn >= 0.14 ? 'medium' : 'low';
  return {
    inputs: { category: ctx.category, fragile: !!ctx.fragile, weightKg: ctx.weightKg ?? 0.5, sizeRisk: ctx.sizeRisk ?? 0.5, codShare: cod, pincodeCluster: cluster.key },
    pReturn, pRto,
    band,
    bufferPct: round2(pReturn * 100),
    action: band === 'high'
      ? 'Add size chart + true photos before scaling spend; offer prepaid on this cluster (2.0 COD risk score).'
      : band === 'medium'
        ? 'Ship with the size chart and a QC check; watch reason codes weekly.'
        : 'Normal handling; keep the standard buffer.',
    why: [
      `Category base return rate ${(base * 100).toFixed(0)}% (${ctx.category}).`,
      `Pincode cluster ${cluster.label}: COD share ${(cod * 100).toFixed(0)}%, tier ${cluster.tier}.`,
      `COD orders fail ${(RISK_MODEL.codFailureRate * 100).toFixed(1)}% vs ${(RISK_MODEL.prepaidFailureRate * 100).toFixed(1)}% prepaid [Unicommerce].`,
      ctx.fragile ? 'Fragile item: breakage adds to the return buffer.' : 'Not fragile.',
      'Production path: gradient-boosted classifier, same features, daily refresh, AUC >= 0.75.',
    ],
  };
}

/** COD risk score used by the 2.0 module (deck slide 10 box 2). */
export function codRisk({ pincodeCluster, orderValue, customerCodAcceptance }) {
  const cluster = PINCODE_CLUSTERS.find((c) => c.key === pincodeCluster) || PINCODE_CLUSTERS[4];
  const z = -2.1 + 1.9 * cluster.codShare + 0.0012 * (orderValue ?? 400) - 1.6 * (customerCodAcceptance ?? 0.6);
  const score = round2(sig(z));
  const bandScore = score >= 0.6 ? 'high' : score >= 0.35 ? 'medium' : 'low';
  return {
    cluster: cluster.key,
    score,
    band: bandScore,
    action: bandScore === 'high'
      ? 'Offer a prepaid discount or a confirmation call before dispatch (2.0, opt-in).'
      : bandScore === 'medium'
        ? 'Show the no-return price first and nudge prepaid.'
        : 'Normal routing; no intervention.',
    expectedEffect: bandScore === 'high' ? 'COD failure 20.9% -> about 6% on flagged orders (assumed)' : 'no measurable effect modelled',
  };
}

/** Buffer per SKU x pincode (deck slide 7 box 2: "buffer per SKU x pincode"). */
export function bufferMatrix(listing, floor) {
  return PINCODE_CLUSTERS.map((c) => {
    const r = returnRisk({
      category: floor.category,
      fragile: listing.sku.features?.fragile,
      weightKg: listing.sku.features?.weightKg,
      pincodeCluster: c.key,
      codShare: c.codShare,
    });
    return {
      cluster: c.key, label: c.label, tier: c.tier, codShare: c.codShare,
      pReturn: r.pReturn, pRto: r.pRto, band: r.band,
      bufferPerKeptOrder: round2(floor.B * (0.6 + r.pReturn)),
      note: c.note,
    };
  });
}

/** Keep-probability by cluster (deck slide 10 box 3: product-customer fit). */
export function keepProbability(listing, clusterKey) {
  const r = returnRisk({ category: listing.sku.category, pincodeCluster: clusterKey, fragile: listing.sku.features?.fragile, weightKg: listing.sku.features?.weightKg });
  const keep = round2((1 - r.pReturn) * (1 - r.pRto));
  return {
    cluster: clusterKey, keepProbability: keep,
    display: keep >= 0.85 ? 'show the easy-returns price first' : 'show the no-return price first (lower refusal risk)',
    why: [
      `Return risk ${(r.pReturn * 100).toFixed(1)}%, RTO risk ${(r.pRto * 100).toFixed(1)}% on this cluster.`,
      'No-return orders cannot come back, so the keep-probability of the priced order is higher.',
      'One honest price per product per cluster: no per-buyer pricing (fairness guardrail).',
    ],
  };
}
