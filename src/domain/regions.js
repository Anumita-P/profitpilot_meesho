/**
 * REGIONAL / PINCODE ECONOMICS (v2 phase 8).
 *
 * The same listing does not behave the same everywhere. COD-heavy Tier-3 clusters
 * refuse more parcels; metro prepaid converts differently; one cluster can be the
 * reason a SKU's return rate looks bad in aggregate.
 *
 * This module reports the seller's own performance BY AGGREGATED PINCODE CLUSTER
 * and, when a cluster diverges, names the OPERATIONAL cause to investigate.
 *
 * HARD RULE, and it is a legal one as much as a product one: this is aggregate
 * cluster economics only. There is no individual-customer data, no per-buyer
 * pricing and no personalised offer anywhere in this file or in the routes that
 * expose it. The output of a divergence is an operational action - review COD
 * handling, improve fulfilment, packaging audit, stock placement - never a
 * different price for a different person.
 *
 * Where the ingested events carry pincodes, the aggregation is measured. Where
 * they do not yet, the cluster split is the SAME deterministic prior the risk
 * model already uses (`bufferMatrix` in src/engine/risk.js) and every row says so
 * in `basis`. Measured and modelled are never mixed silently.
 */

import { listing, hydrate, load, httpError } from '../store/db.js';
import { computeFloor } from '../engine/floor.js';
import { PINCODE_CLUSTERS, bufferMatrix, returnRisk, codRisk } from '../engine/risk.js';
import { ordersPerDay } from '../engine/demand.js';

const round2 = (x) => Math.round(x * 100) / 100;

/** Cluster weights for the modelled split: COD share is the seller's own mix, spread across clusters. */
function modelledWeights(listingId) {
  const L = hydrate(listing(listingId));
  const codShare = L.signals.codShare ?? 0.5;
  const raw = PINCODE_CLUSTERS.map((c) => Math.max(0.001, 1 - Math.abs(c.codShare - codShare) * 1.6)
    * (c.tier === 2 ? 1.25 : c.tier === 3 ? 1.1 : 1));       // Tier-2+ is where Meesho's buyers are (deck slide 10)
  const sum = raw.reduce((a, b) => a + b, 0);
  return PINCODE_CLUSTERS.map((c, i) => ({ cluster: c, weight: raw[i] / sum }));
}

/** Aggregated performance by cluster: measured when pincodes exist, modelled otherwise. */
export function report(listingId, { days = 30 } = {}) {
  const raw = listing(listingId);
  const L = hydrate(raw);
  const f = computeFloor(raw.skuKey, raw.costOverrides || {});
  const events = (load().ingestedEvents || []).filter((e) => e.listing_id === listingId);
  const withPincode = events.filter((e) => e.payload?.pincode);
  const measured = withPincode.length >= 25;

  const ordersPerDayNow = ordersPerDay(L, raw.price) || 1;

  const rows = PINCODE_CLUSTERS.map((c, idx) => {
    const rr = returnRisk({ category: c.category || L.sku.category, fragile: L.sku.features?.fragile, weightKg: L.sku.features?.weightKg, pincodeCluster: c.key, codShare: c.codShare });
    const risk = { keep: round2((1 - rr.pReturn) * (1 - rr.pRto)), pReturn: rr.pReturn, rto: rr.pRto };
    const cod = codRisk({ pincodeCluster: c.key, orderValue: raw.price });
    if (measured) {
      const mine = withPincode.filter((e) => clusterOf(e.payload.pincode) === c.key);
      const placed = mine.filter((e) => e.event_type === 'ORDER_PLACED').length;
      const delivered = mine.filter((e) => e.event_type === 'ORDER_DELIVERED').length;
      const returned = mine.filter((e) => e.event_type === 'ORDER_RETURNED').length;
      const rto = mine.filter((e) => e.event_type === 'ORDER_RTO').length;
      const keptOrders = delivered - returned;
      const codShare = placed ? round2(mine.filter((e) => e.event_type === 'ORDER_PLACED' && e.payload?.paymentMode === 'cod').length / placed) : c.codShare;
      const contribution = round2(keptOrders * (raw.price - f.F));
      return {
        cluster: c.key, label: c.label, tier: c.tier, basis: 'ingested events with pincodes',
        orders: placed, kept_orders: keptOrders, order_rate_per_day: round2(placed / days),
        cod_share: codShare, rto, returns: returned,
        rto_rate_pct: delivered + rto ? round2((rto / (delivered + rto)) * 100) : null,
        return_rate_pct: delivered ? round2((returned / delivered) * 100) : null,
        kept_rate_pct: round2(risk.keep * 100),
        contribution: contribution,
        fulfilment_risk: risk.keep < 0.55 ? 'high' : risk.keep < 0.72 ? 'medium' : 'low',
        note: c.note,
      };
    }
    const w = modelledWeights(listingId)[idx].weight;
    const orders = ordersPerDayNow * days * w;
    const keptOrders = orders * risk.keep;
    return {
      cluster: c.key, label: c.label, tier: c.tier, basis: 'modelled prior (no pincode-level events yet)',
      orders: round2(orders), kept_orders: round2(keptOrders), order_rate_per_day: round2(orders / days),
      cod_share: c.codShare, rto: round2(orders * risk.rto), returns: round2(orders * risk.pReturn),
      rto_rate_pct: round2(risk.rto * 100), return_rate_pct: round2(risk.pReturn * 100),
      kept_rate_pct: round2(risk.keep * 100),
      contribution: round2(keptOrders * (raw.price - f.F)),
      fulfilment_risk: risk.keep < 0.55 ? 'high' : risk.keep < 0.72 ? 'medium' : 'low',
      cod_refusal_score_pct: round2(cod.score * 100),
      note: c.note,
    };
  });

  /* divergence: which cluster deviates most from the listing's own average? */
  const avgKept = rows.reduce((a, r) => a + r.kept_rate_pct, 0) / rows.length;
  const avgReturn = rows.reduce((a, r) => a + (r.return_rate_pct || 0), 0) / rows.length;
  const divergences = rows.map((r) => ({
    cluster: r.cluster, label: r.label,
    kept_rate_delta_pct: round2(r.kept_rate_pct - avgKept),
    return_rate_delta_pct: round2((r.return_rate_pct || 0) - avgReturn),
    share_of_orders_pct: round2((r.orders / Math.max(0.001, rows.reduce((a, x) => a + x.orders, 0))) * 100),
  })).sort((a, b) => Math.abs(b.kept_rate_delta_pct) - Math.abs(a.kept_rate_delta_pct));

  const worst = divergences[0];

  return {
    listing_id: listingId,
    sku: raw.skuKey,
    days,
    basis: measured ? 'measured from ingested events that carry pincodes' : 'MODELLED prior: the ingested events do not carry pincodes yet, so the cluster split uses the same priors as src/engine/risk.js',
    aggregated_only: true,
    privacy_note: 'Aggregated pincode clusters only. No individual customer data, no per-customer pricing, no personalised offers - by design and by policy.',
    clusters: rows,
    divergence: worst && Math.abs(worst.kept_rate_delta_pct) >= 8
      ? {
        cluster: worst.cluster,
        label: worst.label,
        kept_rate_delta_pct: worst.kept_rate_delta_pct,
        return_rate_delta_pct: worst.return_rate_delta_pct,
        reading: `${worst.label} keeps ${Math.abs(worst.kept_rate_delta_pct)} points ${worst.kept_rate_delta_pct < 0 ? 'fewer' : 'more'} orders than the listing average`,
      }
      : null,
    operational_recommendations: recommendations(rows, worst, { measured }),
    consistency_check: {
      buffer_matrix: bufferMatrix(L, f).map((b) => ({ cluster: b.cluster, pReturn: b.pReturn, pRto: b.pRto })),
      note: 'The same risk priors the floor buffer uses, so a regional finding and the floor cannot tell different stories.',
    },
    policy: 'Regional divergence produces an OPERATIONAL recommendation (COD handling, fulfilment, packaging, stock placement), never a different price for a different shopper.',
  };
}

function recommendations(rows, worst, { measured }) {
  const out = [];
  const codHeavy = rows.filter((r) => r.cod_share >= 0.74);
  if (codHeavy.length) {
    out.push({
      key: 'review_cod_risk',
      line: `${codHeavy.map((r) => r.label).join(', ')} are COD-heavy: a prepaid nudge and clearer COD terms reduce refusals there (COD orders fail ~20.9% vs 5.8% prepaid, Unicommerce).`,
      type: 'operational',
    });
  }
  if (worst && worst.return_rate_delta_pct > 4) {
    out.push({ key: 'packaging_audit', line: `${worst.label} returns run above the listing average: a packaging and size-information audit is the first thing to check.`, type: 'operational' });
  }
  if (worst && worst.kept_rate_delta_pct < -8) {
    out.push({ key: 'improve_fulfilment', line: `${worst.label} keeps fewer orders than the rest: check courier lanes and dispatch time for that cluster before changing anything about price.`, type: 'operational' });
  }
  out.push({ key: 'stock_placement', line: 'If one cluster sells through faster, place stock closer to it rather than repricing for it.', type: 'operational' });
  if (!measured) out.push({ key: 'collect_pincode_events', line: 'These rows are modelled from priors: start sending pincode-aggregated events to replace the estimate with a measurement.', type: 'data' });
  return out;
}

/** Which cluster a pincode belongs to - deterministic, and only ever used in aggregate. */
export function clusterOf(pincode) {
  const digits = String(pincode || '').replace(/\D/g, '');
  if (!digits) return null;
  const first = Number(digits[0]);
  const last = Number(digits[digits.length - 1]);
  if (first <= 2) return 'metro-prepaid';
  if (first <= 4) return last % 2 === 0 ? 'metro-cod' : 'tier2-prepaid';
  if (first <= 6) return last % 3 === 0 ? 'tier3-cod' : 'tier2-cod';
  return 'tier3-cod';
}

/** A deterministic cluster split for a simulated stream (used by the simulator's options). */
export function weightsFor(listingId) {
  return modelledWeights(listingId).map((w) => ({ cluster: w.cluster.key, weight: w.weight }));
}

