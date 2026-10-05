/**
 * PORTFOLIO LAYER (v2 phase 3).
 *
 * No SKU is an island. If A ₹20 cut on the kurti moves demand that would have gone
 * to the kurta next to it on the shelf, then "SKU A improved" is a half-truth: the
 * seller's bank account is the sum, not the SKU.
 *
 * WHAT THIS IS: a deterministic, explainable approximation built from what the
 * catalogue actually contains - category, price band, shared features (fabric /
 * material / fragility / size runs), how many look-alikes the category has, and
 * how much of the seller's contribution each SKU already carries.
 *
 * WHAT THIS IS NOT: a causal claim. Two listings can share every attribute in the
 * catalogue and still appeal to different buyers. So the language is always
 * "estimated overlap" and "potential cannibalisation", the score is shown with its
 * inputs, and nothing here is allowed to overrule the guardrails or the diagnosis.
 */

import { listings, hydrate, listing, httpError } from '../store/db.js';
import { computeFloor } from '../engine/floor.js';
import * as counterfactual from './counterfactual.js';
import * as inventory from './inventory.js';

const round2 = (x) => Math.round(x * 100) / 100;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/* ------------------------------- similarity -------------------------------- */

/**
 * How much two listings look like substitutes, 0..1, with the inputs shown.
 * Weights: same category 0.40, price-band overlap 0.30, shared features 0.20,
 * catalogue-density (look-alike counts) 0.10.
 */
export function similarity(a, b) {
  const A = hydrate(listing(a));
  const B = hydrate(listing(b));
  const parts = [];

  const sameCategory = A.sku.category === B.sku.category;
  parts.push({ key: 'same_category', weight: 0.4, hit: sameCategory ? 1 : 0, detail: `${A.sku.category} vs ${B.sku.category}` });

  const [lo1, hi1] = A.sku.band; const [lo2, hi2] = B.sku.band;
  const overlap = Math.max(0, Math.min(hi1, hi2) - Math.max(lo1, lo2));
  const union = Math.max(hi1, hi2) - Math.min(lo1, lo2);
  const bandScore = union > 0 ? overlap / union : 0;
  parts.push({ key: 'price_band_overlap', weight: 0.3, hit: round2(bandScore), detail: `₹${lo1}-${hi1} vs ₹${lo2}-${hi2}` });

  const fa = A.sku.features || {}; const fb = B.sku.features || {};
  const keys = [...new Set([...Object.keys(fa), ...Object.keys(fb)])];
  const shared = keys.filter((k) => fa[k] !== undefined && fb[k] !== undefined && String(fa[k]) === String(fb[k]));
  const featureScore = keys.length ? shared.length / keys.length : 0;
  parts.push({ key: 'shared_attributes', weight: 0.2, hit: round2(featureScore), detail: shared.length ? `shared: ${shared.join(', ')}` : 'no shared attribute values' });

  const density = 1 - clamp(Math.abs((A.sku.lookalikes || 0) - (B.sku.lookalikes || 0)) / 40, 0, 1);
  parts.push({ key: 'catalogue_density', weight: 0.1, hit: round2(density), detail: `${A.sku.lookalikes} vs ${B.sku.lookalikes} look-alikes` });

  const score = round2(clamp(parts.reduce((acc, p) => acc + p.weight * p.hit, 0), 0, 1));
  return {
    a: a, b: b, score,
    band: score >= 0.75 ? 'substitutes' : score >= 0.5 ? 'related' : 'distinct',
    inputs: parts,
    note: 'Deterministic catalogue similarity: category, price band, shared attributes and look-alike density. Not a demand model and not a causal claim.',
  };
}

/* --------------------------------- rollup --------------------------------- */

/** The seller's catalogue as a portfolio: categories, concentration, hero/clearance, pairs. */
export function view(sellerId) {
  const rows = listings(sellerId).map((raw) => {
    const L = hydrate(raw);
    const f = computeFloor(raw.skuKey, raw.costOverrides || {});
    const inv = inventory.stateOf(raw.id);
    const perKept = round2(raw.price - f.F);
    const keptPerDay = L.signals.q0 || 0;
    const contributionPerDay = round2(perKept * keptPerDay * f.k);
    return {
      listing_id: raw.id,
      sku: raw.skuKey,
      category: L.sku.category,
      price: raw.price,
      floor: f.F,
      contribution_per_kept_order: perKept,
      kept_orders_per_day: keptPerDay,
      contribution_per_day: contributionPerDay,
      inventory_state: inv.state.key,
      inventory_units: inv.inventory.on_hand,
      band: L.sku.band,
      stage: L.stage,
    };
  });

  const total = round2(rows.reduce((a, r) => a + r.contribution_per_day, 0));
  const byCategory = {};
  for (const r of rows) {
    byCategory[r.category] ||= { category: r.category, listings: 0, contribution_per_day: 0, units: 0, prices: [] };
    byCategory[r.category].listings += 1;
    byCategory[r.category].contribution_per_day = round2(byCategory[r.category].contribution_per_day + r.contribution_per_day);
    byCategory[r.category].units += r.inventory_units || 0;
    byCategory[r.category].prices.push(r.price);
  }
  const categories = Object.values(byCategory).map((c) => ({
    ...c,
    share_pct: total ? round2((c.contribution_per_day / total) * 100) : 0,
    price_dispersion_pct: c.prices.length ? round2(((Math.max(...c.prices) - Math.min(...c.prices)) / Math.max(...c.prices)) * 100) : 0,
  }));

  /* concentration: Herfindahl-style, plus the single biggest share */
  const hhi = total ? round2(rows.reduce((a, r) => a + ((r.contribution_per_day / total) * 100) ** 2, 0)) : 0;
  const sorted = [...rows].sort((a, b) => b.contribution_per_day - a.contribution_per_day);
  const hero = sorted[0] || null;
  const clearance = [...rows]
    .filter((r) => ['CLEARANCE', 'AGING', 'SLOW'].includes(r.inventory_state))
    .sort((a, b) => (b.inventory_units || 0) - (a.inventory_units || 0))[0] || null;

  /* the pairs most likely to compete with each other */
  const pairs = [];
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const s = similarity(rows[i].listing_id, rows[j].listing_id);
      if (s.score >= 0.5) pairs.push({ a: s.a, b: s.b, score: s.score, band: s.band, inputs: s.inputs });
    }
  }
  pairs.sort((x, y) => y.score - x.score);

  return {
    seller_id: sellerId,
    as_of: new Date().toISOString(),
    listings: rows,
    total_contribution_per_day: total,
    categories,
    concentration: {
      hhi: hhi,
      reading: hhi > 4000 ? 'concentrated: a single SKU carries the seller\'s economics, so its price is a portfolio decision'
        : hhi > 2000 ? 'moderately concentrated'
          : 'diversified across SKUs',
      top_sku_share_pct: hero && total ? round2((hero.contribution_per_day / total) * 100) : 0,
    },
    hero_sku: hero,
    clearance_sku: clearance,
    overlapping_pairs: pairs,
    note: 'Estimated overlaps from the catalogue (category, price band, attributes, density). Treat them as questions to check, not as measured substitution.',
  };
}

/**
 * The portfolio impact of a candidate move on one listing: the SKU's own change,
 * plus the estimated demand it may pull from overlapping listings, priced in
 * contribution.
 *
 * @param {string} listingId
 * @param {number} candidatePrice
 * @param {object} opts { horizonDays, maxPartners }
 */
export function impactOfMove(listingId, candidatePrice, { horizonDays = counterfactual.HORIZON_DEFAULT, maxPartners = 3 } = {}) {
  const raw = listing(listingId);
  const sellerId = raw.sellerId;
  const cf = counterfactual.evaluate(listingId, candidatePrice, { horizonDays });
  const liveRow = counterfactual.evaluate(listingId, raw.price, { horizonDays });
  const individualDelta = round2(cf.expected_value.value - liveRow.expected_value.value);

  const others = listings(sellerId).filter((l) => l.id !== listingId);
  const partners = others
    .map((l) => ({ l, sim: similarity(listingId, l.id) }))
    .filter((x) => x.sim.score >= 0.4)
    .sort((a, b) => b.sim.score - a.sim.score)
    .slice(0, maxPartners);

  /* Where does the extra demand come from? Two sources, and only one of them is
     the seller's loss:
       - new-to-the-seller demand: no portfolio effect;
       - substituted demand from an overlapping listing: its contribution falls by
         (substituted orders x its contribution per kept order).
     The substitution share rises with similarity and falls with how much of the
     seller's traffic is incremental (modelled as 1 - similarity/2, floored), and
     is capped at half the gained orders: a conservative, declared assumption. */
  const rows = [];
  let totalDiversion = 0;
  for (const { l, sim } of partners) {
    const B = hydrate(l);
    const bFloor = computeFloor(l.skuKey, l.costOverrides || {});
    const bContributionPerKept = round2(l.price - bFloor.F);
    const gainedOrders = Math.max(0, cf.operations.kept_orders - liveRow.operations.kept_orders);
    const substitutionShare = clamp(sim.score * 0.5 * (1 - l.signals.doi ? 0 : 0) + (sim.score - 0.4) * 0.5, 0, 0.5);
    const divertedOrders = round2(gainedOrders * substitutionShare);
    const lostContribution = round2(divertedOrders * bContributionPerKept);
    if (divertedOrders > 0.01) {
      rows.push({
        listing_id: l.id, sku: l.skuKey, similarity: sim.score, band: sim.band,
        its_contribution_per_kept_order: bContributionPerKept,
        estimated_diverted_kept_orders: divertedOrders,
        estimated_contribution_lost: lostContribution,
        why: `${round2(sim.score * 100)}% catalogue similarity (${sim.inputs.filter((p) => p.hit > 0).map((p) => p.key).join(', ') || 'price band only'})`,
      });
      totalDiversion += lostContribution;
    }
  }
  const net = round2(individualDelta - totalDiversion);
  const risk = totalDiversion <= 0 ? 'none'
    : net <= 0 ? 'high' : totalDiversion >= individualDelta * 0.4 ? 'medium' : 'low';

  return {
    listing_id: listingId,
    seller_id: sellerId,
    candidate_price: Math.round(candidatePrice),
    live_price: raw.price,
    horizon_days: horizonDays,
    individual: {
      contribution_per_kept_order: cf.economics.contribution_per_kept_order,
      kept_orders: cf.operations.kept_orders,
      expected_contribution: cf.expected_value.value,
      delta_vs_live: individualDelta,
      line: individualDelta >= 0
        ? `on its own, this move is worth about ₹${individualDelta} more contribution over ${horizonDays} days`
        : `on its own, this move costs about ₹${Math.abs(individualDelta)} of contribution over ${horizonDays} days`,
    },
    portfolio: {
      estimated_diverted_kept_orders: round2(rows.reduce((a, r) => a + r.estimated_diverted_kept_orders, 0)),
      estimated_contribution_lost: round2(totalDiversion),
      net: net,
      cannibalisation_risk: risk,
      partners: rows,
      line: rows.length === 0
        ? 'no catalogue overlap was found: this move looks like its own decision (estimated overlap, not a certainty)'
        : `${rows.length} overlapping listing(s) may absorb part of the gain: estimated ₹${round2(totalDiversion)} of contribution could move rather than appear. Net portfolio effect ≈ ₹${net}.`,
      caveat: 'Estimated overlap / potential cannibalisation. Two similar listings can still appeal to different buyers - this is a prompt to check, not a measurement.',
    },
    verdict: {
      improves_individual: individualDelta > 0,
      improves_portfolio: net > 0,
      headline: rows.length === 0
        ? (individualDelta > 0 ? 'improves the SKU, with no overlap detected' : 'does not improve the SKU')
        : individualDelta > 0 && net <= 0
          ? 'improves the SKU individually, but the portfolio benefit is limited because it may cannibalise another listing'
          : individualDelta > 0
            ? 'improves the SKU, and the portfolio effect stays positive after the estimated overlap'
            : 'does not improve either the SKU or the portfolio',
    },
  };
}

/** Recompute and cache the rollup (the scheduler can call this). */
export function refresh(sellerId) {
  const v = view(sellerId);
  return v;
}
