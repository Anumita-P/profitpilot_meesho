/**
 * SUCCESS MEASUREMENT - pilot, impact and metrics (deck slide 8).
 *   M22 Lift = (Y_T - Y_H) / Y_H        M23 n = 2 (z_a/2 + z_b)^2 s^2 / d^2
 *   M24 City score S = sum w_t x_t     M15/M19/M20 feed the engine.
 *
 * Everything here is an ILLUSTRATIVE target with a causal chain, never a
 * result. The backend refuses to publish a lift without a holdout comparison -
 * that is the point of the pilot design.
 */

import { PILOT } from '../config/deck.js';

const r2 = (x) => Math.round(x * 100) / 100;
const money = (v) => `₹${v.toLocaleString('en-IN', { maximumFractionDigits: 1 })}`;

/* M24: city score S = sum w_t * x_t over density / fit / tier / ops / returns */
export function cityScore(scores) {
  const w = PILOT.cityWeights;
  const s = w.density * scores.density + w.fit * scores.fit + w.tier * scores.tier + w.ops * scores.ops + w.returns * scores.returns;
  return r2(s);
}

export function cityRanking() {
  return Object.entries(PILOT.cities)
    .map(([key, c]) => ({ key, ...c, score: cityScore(c.scores), weights: PILOT.cityWeights }))
    .sort((a, b) => b.score - a.score);
}

/* M23: sample size */
export function sampleSize({ alphaZ = PILOT.impact.sampleSize.alpha, powerZ = PILOT.impact.sampleSize.power, sigma = PILOT.impact.sampleSize.sigma, delta = PILOT.impact.sampleSize.delta } = {}) {
  const n = 2 * Math.pow(alphaZ + powerZ, 2) * sigma * sigma / (delta * delta);
  return {
    inputs: { alphaZ, powerZ, sigma, delta },
    nExact: r2(n),
    nPerArm: Math.ceil(n - 1e-9),
    formula: `n = 2 (z_a/2 + z_b)^2 s^2 / d^2 = 2 x (${alphaZ} + ${powerZ})^2 x ${sigma}^2 / ${delta}^2 = ${r2(n)}`,
    interpretation: `${Math.ceil(n - 1e-9)} sellers per arm detects a ${money(delta)} difference in profit per kept order; the pilot runs 250 vs 250.`,
    power: `alpha = ${alphaZ === 1.96 ? '5%' : alphaZ}, power = ${powerZ === 0.84 ? '80%' : powerZ}`,
  };
}

/* M22: lift */
export function lift(treated, holdout) {
  if (!holdout) return null;
  return r2((treated - holdout) / holdout * 100);
}

export function pilotDesign() {
  const cities = cityRanking();
  return {
    where: cities.slice(0, 2),
    backup: cities[2],
    scoring: { formula: 'S = sum w_t x_t', weights: PILOT.cityWeights },
    design: {
      ...PILOT.design,
      randomisation: 'by seller: all of a seller\'s products in one group, so every buyer still sees one price',
      matching: 'matched on category, tenure and sales band',
      primaryMetric: 'seller profit per week (normalised per impression) vs holdout',
      secondaryMetrics: ['seller profit per kept order', 'below-floor listings', 'buyer conversion (guardrail)', 'mode upgrades', 'suggestions accepted'],
      goNoGo: 'week 12 go / no-go, then a permanent 5% holdout stays forever',
      caveat: 'lift may include orders won from other sellers, so GMV is an upper bound',
    },
    impact: {
      ...PILOT.impact.profitPerKeptOrder,
      liftPct: lift(PILOT.impact.profitPerKeptOrder.treated, PILOT.impact.profitPerKeptOrder.holdout),
      waterfall: PILOT.impact.waterfall,
      keptOrders: PILOT.impact.keptOrders,
      keptOrdersLiftPct: lift(30.55, PILOT.impact.keptOrders.holdout),
      otherMetrics: PILOT.impact.other,
      stopRules: PILOT.impact.stopRules,
    },
    roadmap: [
      { phase: 'Phase 0', months: '0-1', gate: 'floor within +-5% vs settlement', work: 'data pipes, floor engine, models' },
      { phase: 'Phase 1', months: '1-4', gate: 'profit lift vs holdout', work: 'Surat + Rajkot pilot, 50/50, 500 sellers' },
      { phase: 'Phase 2', months: '4-6', gate: '12 weeks, no guardrail trip', work: '2 fashion, home, beauty, kids - 50k sellers' },
      { phase: 'Phase 3', months: '6-12', gate: 'NMV/GMV ratio up', work: 'countrywide + programmes - about 3 lakh sellers' },
      { phase: 'Phase 4', months: '12+', gate: '5% holdout stays forever', work: 'ProfitPilot 2.0 modules, opt-in - all 7 lakh+ sellers' },
    ],
  };
}

/** Cohort maths for 10,000 new sellers (deck slide 8 box 6). */
export function cohort(overrides = {}) {
  const c = { ...PILOT.impact.cohort, ...overrides };
  const nmvWith = c.nmvPerSellerWith;
  const nmvWithout = c.nmvPerSellerWithout;
  const nmvUpliftPct = r2((nmvWith - nmvWithout) / nmvWithout * 100);
  const cohortWith = c.activeWith * nmvWith;
  const cohortWithout = c.activeWithout * nmvWithout;
  // deck slide 8: +24% profit per kept order x +10% kept orders -> about +37% profit per adopter (1.24 x 1.10 = 1.364)
  const profitUplift = r2((1.24 * 1.10 - 1) * 100);
  return {
    inputs: c,
    /* the deck prints ₹65 cr -> ₹90 cr (+37%); the inputs give 5,000 x ₹1.31 L = ₹65.5 cr -> 6,000 x ₹1.50 L = ₹90 cr (+37.4%). Same story, we show the rounding. */
    deckClaim: {
      cohortNmvWithout: c.cohortNmvWithout,
      cohortNmvWith: c.cohortNmvWith,
      upliftPct: r2((c.cohortNmvWith - c.cohortNmvWithout) / c.cohortNmvWithout * 100),
      roundingNote: `Deck slide 8 prints ${'₹'}65 cr -> ${'₹'}90 cr (+37%). From the stated inputs (5,000 x ${'₹'}1.31 L) the 'without' side is ${'₹'}65.5 cr, so the computed uplift is 37.4% - the deck rounded down.`,
    },
    computed: { cohortNmvWithout: cohortWithout, cohortNmvWith: cohortWith },
    nmvUpliftPct,
    profitPerAdopterPct: profitUplift,
    cohortNmvWith: cohortWith,
    cohortNmvWithout: cohortWithout,
    cohortUpliftPct: r2((cohortWith - cohortWithout) / cohortWithout * 100),
    causalChain: [
      'NMV/seller = 28 kept orders x 12 months x ₹390 average kept price = ₹1.31 L; with ProfitPilot 31 x 12 x ₹402 = ₹1.50 L',
      'profit per adopter: 1.24 x 1.10 = +37%',
      'cohort = active sellers x NMV per seller: 5,000 x ₹1.31 L vs 6,000 x ₹1.50 L',
    ],
    sensitivity: {
      halfRetentionGain: money(0.50 * 1.05 * 1.5e5 * 100 / 100),
      note: 'half the retention gain -> about ₹82 cr (+26%); half the order gain -> about ₹85 cr (+30%)',
    },
    marketplace: { gmvUpliftPct: '+7-11%', basis: '(1.10 x 1.03 - 1) x 50-80% adoption; upper bound (share shift)' },
    guardrail: 'buyer conversion must not fall more than 2 pp vs holdout; max 2 price moves / month',
  };
}

/** Waterfall-1: profit per kept order (deck slide 8 box 4). */
export function waterfallProfit() {
  const w = PILOT.impact.waterfall;
  let acc = 0;
  const rows = w.map((row, i) => {
    if (row.kind === 'base' || row.kind === 'end') { acc = row.value; return { ...row, running: acc }; }
    acc += row.value;
    return { ...row, running: r2(acc) };
  });
  const base = w[0].value; const end = w[w.length - 1].value;
  return {
    rows,
    total: r2(end - base),
    liftPct: lift(end, base),
    arithmetic: `${w[1].value} + ${w[2].value} + ${w[3].value} = +₹${r2(end - base)} -> ₹${end}; (${end} - ${base}) / ${base} = ${lift(end, base)}%`,
    note: 'Dual price is not counted here: the no-return price is lower by about the return cost it saves, so profit per kept order stays the same. Its gain shows up in kept orders and faster cash.',
    why: {
      'Below-floor / under-priced SKUs fixed': ['Weeks 1-2 measure how many listings sit below their return-adjusted floor F.', 'Every such SKU is lifted to >= F; under-priced SKUs move into the look-alike band.', 'Average effect across the catalogue is about +₹10 per kept order (~1 in 4 SKUs x ₹40 gap).'],
      'Growth steps +4% on 30% of SKUs': ['+4% steps on the ~30% of SKUs in Growth whose conversion held 2 weeks.', 'e.g. kurti ₹369 -> ₹384 = +₹15; x 30% of SKUs = +₹4.5.'],
      'Panic cuts avoided': ['Diagnose-before-discount blocks cuts when clicks, returns or stock are the real problem.', 'Holdout sellers make those cuts (~15% of SKUs by ~₹40); treated sellers fix the non-price cause instead.'],
    },
  };
}

/** Waterfall-2: kept orders per seller per month (deck slide 8 box 4). */
export function waterfallKeptOrders() {
  const chain = PILOT.impact.keptOrders.chain;
  return {
    rows: chain,
    start: chain[0].value,
    end: r2(chain[chain.length - 1].value),
    liftPct: lift(chain[chain.length - 1].value, chain[0].value),
    deckClaim: { to: 31, liftPct: 10, roundingNote: `Deck slide 8 prints 28 -> 31 (+10%). The deck's own multipliers (x 1.10 x 1.08 x 0.964 x 84/82 x 0.93) give 30.55 (+9.1%); we keep the multipliers exact and show 30.55, and quote the deck's 31 only as the rounded claim.` },
    arithmetic: chain.map((c, i) => (i === 0 ? `${c.value}` : `x ${c.mult}`)).join(' ') + ` = ${r2(chain[chain.length - 1].value)} (deck prints ~31)`,
    why: [
      'x 1.10: listing fixes from Diagnose (photo, title, size chart) raise conversion.',
      'x 1.08: dual price - buyers who would not buy with returns priced in now buy no-return (30% choose ₹339 x +25%).',
      'x 0.964: the price-step elasticity cost of +4% steps (b = -3) on the stepped SKUs.',
      'x 84/82: fewer returns, so more delivered orders stay kept (kept rate 82% -> 84.5%).',
      'x 0.93: repricing up - about 25% of products are lifted to their floor or into the band and lose about 28% of their orders.',
    ],
  };
}

/** Metrics menu the pilot reports (deck slide 8 box 5). */
export function metrics() {
  return {
    primary: [{ level: 'Seller', metric: 'profit per week (per impression) vs holdout' }],
    secondary: [
      { level: 'Seller', metric: 'profit per kept order' },
      { level: 'Seller', metric: 'below-floor listings' },
      { level: 'Trust', metric: 'suggestions accepted, mode upgrades, "Why?" opened, overrides, Loss Warnings shown' },
      { level: 'Guardrail', metric: 'buyer conversion, <= 2 price moves / month' },
      { level: 'Marketplace', metric: 'NMV / GMV, return & RTO, prepaid share' },
      { level: 'Platform vs seller interest', metric: 'north star = seller profit / impression; buyer-CVR guardrail; holdout programme routing' },
    ],
  };
}

/** Refuses to show a lift that is not holdout-verified. */
export function claimGuard(claim, opts = {}) {
  if (!opts.hasHoldout) {
    return { allowed: false, reason: 'No holdout comparison yet: this is a target with a causal chain, not a result.', claim };
  }
  return { allowed: true, claim, lift: lift(opts.treated, opts.holdout) };
}
