/**
 * LAYER: DECISION - price search that cannot lose money.
 * Deck slide 7 box 4 (M19/M20): a guardrailed Thompson-sampling bandit over
 * price MENUS (easy-returns / no-return).
 *
 *   reward  r_a = CTR x CVR x k x (p_a - F) = theta_a x (p_a - F)  per impression
 *   prior   theta_a ~ Beta(n0 * theta_hat, n0 * (1 - theta_hat)), n0 = 2,000,
 *           theta_hat from the pooled demand model (b = -3)
 *   pull    one Thompson draw per day; that menu is live for every buyer all day
 *           (time-block rotation), then s += kept, f += impressions - kept
 *   filter  arms below F (and below T in MARGIN mode) never enter the draw
 *
 * The state lives on the server so arms keep learning between sessions, and so
 * every client sees the same live menu for the day (fairness: no per-buyer
 * pricing). The holdout arm is similar sellers without ProfitPilot at their own
 * price - seller level, so every buyer still sees one price.
 */

import { ENGINE } from '../config/deck.js';
import { computeFloor } from './floor.js';
import { objective, eligible } from './modes.js';
import { thetaPrior, thetaTrue } from './demand.js';
import { enginePreflight } from './guardrails.js';

/**
 * Share of impressions left on the holdout arm. The deck's rollout keeps a
 * permanent 5% holdout at seller level; the prototype's in-browser lab used a
 * token 5 impressions/day, which makes the observed lift pure noise. The
 * backend uses the deck's real 5% share (see docs/DECK_FIDELITY.md).
 */
export const HOLD_PCT = 0.05;
const BATCH = 95;          // impressions per batch
const BATCHES_PER_DAY = 48; // -> 4,560 treated impressions per SKU-day
const TREATED_PER_DAY = BATCH * BATCHES_PER_DAY;

const r2 = (x) => Math.round(x * 100) / 100;
const r3 = (x) => Math.round(x * 1000) / 1000;
const money = (v) => `₹${Math.abs(Math.round(v)).toLocaleString('en-IN')}`;

/* ---------------------------- RNG (seeded, reproducible) --------------------------- */
export function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
function gauss(r) {
  let u = 0; let v = 0;
  while (u === 0) u = r();
  while (v === 0) v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function gammaS(a, r) {
  if (a < 1) return gammaS(a + 1, r) * Math.pow(r(), 1 / a);
  const d = a - 1 / 3; const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x; let v;
    do { x = gauss(r); v = 1 + c * x; } while (v <= 0);
    v = v * v * v;
    const u = r();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}
export function betaS(a, b, r) {
  const x = gammaS(a, r); const y = gammaS(b, r);
  return x / (x + y);
}

/* ------------------------------- bandit state ------------------------------- */
/**
 * Arms = the floor engine's 5 menu prices, minus the "lean" arm (index 1) which
 * the deck drops, so 4 menus: below-floor / balanced / margin / stretch.
 */
export function initBandit(listing, mode, opts = {}) {
  const f = opts.floor || computeFloor(listing.sku.key, listing.costOverrides || {});
  const arms = f.arms
    .filter((p, i) => i !== 1)
    .map((p) => {
      const prior = thetaPrior(p, f);
      return {
        p, pn: p - f.gap,
        a0: ENGINE.N0 * prior, b0: ENGINE.N0 * (1 - prior),
        a: ENGINE.N0 * prior, b: ENGINE.N0 * (1 - prior),
        n: 0, kept: 0, th: thetaTrue(listing, p, f),
      };
    });
  return {
    listingId: listing.id,
    sku: listing.sku.key,
    mode,
    day: 0,
    seed: opts.seed ?? 7,
    holdoutPct: HOLD_PCT,
    arms,
    last: null,
    holdout: { p: listing.offlinePrice ?? listing.sku.price, n: 0, kept: 0, th: thetaTrue(listing, listing.offlinePrice ?? listing.sku.price, f) },
    log: [],
  };
}

export function armEligible(state, arm, f, mode) {
  const e = eligible(mode, arm, f);
  return e.ok;
}

/**
 * Advance the bandit by N days.
 * Each day: ONE Thompson draw selects the menu that is live for all buyers that
 * day; 48 batches x 95 impressions on the treated arm; 5 impressions on holdout.
 */
export function run(state, days, listing, opts = {}) {
  const f = opts.floor || computeFloor(listing.sku.key, listing.costOverrides || {});
  const mode = state.mode;
  const rand = rng(state.seed + state.day * 7919 + 13);
  const log = [];

  for (let d = 0; d < days; d++) {
    const elig = state.arms.filter((a) => armEligible(state, a, f, mode));
    if (!elig.length) break;
    let best = null; let bestV = -Infinity;
    for (const a of elig) {
      const th = betaS(a.a, a.b, rand);
      const v = th * objective(mode, a, f);
      if (v > bestV) { bestV = v; best = a; }
    }
    // simulate the day's traffic for the chosen menu
    let keptToday = 0; let impressionsToday = 0;
    for (let batch = 0; batch < BATCHES_PER_DAY; batch++) {
      let k = 0;
      for (let i = 0; i < BATCH; i++) if (rand() < best.th) k++;
      best.n += BATCH; best.kept += k;
      best.a += k; best.b += BATCH - k;
      keptToday += k; impressionsToday += BATCH;
    }
    // the holdout: similar sellers without ProfitPilot, at their own price
    const holdImpressions = Math.max(1, Math.round(TREATED_PER_DAY * (state.holdoutPct ?? HOLD_PCT)));
    let hk = 0;
    for (let i = 0; i < holdImpressions; i++) if (rand() < state.holdout.th) hk++;
    state.holdout.n += holdImpressions; state.holdout.kept += hk;

    state.day++;
    state.last = {
      p: best.p, pn: best.pn, keptToday, impressionsToday,
      keptPer1k: r2(keptToday / impressionsToday * 1000),
      keepRate: r3(keptToday / impressionsToday),
    };
    log.push({ day: state.day, menu: [best.p, best.pn], kept: keptToday, impressions: impressionsToday, holdoutImpressions: holdImpressions });
  }
  state.log = (state.log || []).concat(log).slice(-400);
  state.seedUsed = state.seed;
  return state;
}

/**
 * Normal-approximation 95% interval on the lift, by the delta method:
 *   ratio = T / H, Var(ratio) ~= ratio^2 (Var(T)/T^2 + Var(H)/H^2)
 * with each arm's kept count treated as Binomial(n, theta) (so
 * Var(profit per impression) ~= p(1-p)(p - F)^2 / n).
 *
 * It is an approximation and is labelled as one: the real interval comes from
 * the seller-level randomised pilot (M22/M23), not from this simulation.
 */
export function liftInterval95(arms, holdout, F) {
  const total = arms.reduce((x, a) => x + a.n, 0);
  if (!total || !holdout.n) return null;
  const armStats = arms.filter((a) => a.n > 0).map((a) => {
    const p = a.kept / a.n;
    return { w: a.n / total, mean: p * (a.p - F), var: p * (1 - p) * Math.pow(a.p - F, 2) / a.n };
  });
  const T = armStats.reduce((x, s) => x + s.w * s.mean, 0);
  const varT = armStats.reduce((x, s) => x + Math.pow(s.w, 2) * s.var, 0);
  const pH = holdout.kept / holdout.n;
  const H = pH * (holdout.p - F);
  const varH = pH * (1 - pH) * Math.pow(holdout.p - F, 2) / holdout.n;
  if (H <= 0) return null;
  const ratio = T / H;
  const varRatio = ratio * ratio * (varT / (T * T) + varH / (H * H));
  const se = Math.sqrt(varRatio);
  return {
    point: r2((ratio - 1) * 100),
    low: r2((ratio - 1 - 1.96 * se) * 100),
    high: r2((ratio - 1 + 1.96 * se) * 100),
    method: 'normal approximation, delta method on T / H',
    note: 'an interval that still contains 0 means the simulation cannot separate the two yet',
  };
}

/** Everything the Engine lab needs to draw itself. */
export function snapshot(state, listing, opts = {}) {
  const f = opts.floor || computeFloor(listing.sku.key, listing.costOverrides || {});
  const mode = state.mode;
  const eligibleArms = state.arms.filter((a) => armEligible(state, a, f, mode));
  const best = eligibleArms.length
    ? eligibleArms.reduce((x, a) => ((a.a / (a.a + a.b)) * objective(mode, a, f) > (x.a / (x.a + x.b)) * objective(mode, x, f) ? a : x))
    : null;

  const totalImpressions = state.arms.reduce((x, a) => x + a.n, 0) || 1;
  const banditProfit = state.arms.reduce((x, a) => x + a.kept * (a.p - f.F), 0) / totalImpressions;
  const holdoutProfit = state.holdout.n ? state.holdout.kept / state.holdout.n * (state.holdout.p - f.F) : 0;
  const expectedBandit = state.arms.reduce((x, a) => x + a.n * a.th * (a.p - f.F), 0) / totalImpressions;
  const expectedHoldout = state.holdout.th * (state.holdout.p - f.F);

  const enoughData = state.holdout.n >= 2 * ENGINE.N0;

  const rows = state.arms.map((a, i) => {
    const mean = a.a / (a.a + a.b);
    return {
      index: i,
      price: a.p,
      noReturnPrice: a.pn,
      label: ['below floor', 'balanced', 'margin', 'stretch'][i] || `arm ${i}`,
      status: a.p < f.F ? 'BLOCKED' : !armEligible(state, a, f, mode) ? 'filtered' : 'eligible',
      blockedBelowFloor: a.p < f.F,
      pulls: a.n,
      pullShare: state.arms.reduce((x, y) => x + y.n, 0) ? a.n / state.arms.reduce((x, y) => x + y.n, 0) : 0,
      posterior: { alpha: r2(a.a), beta: r2(a.b), mean: r3(mean), weight: r3(a.n / (a.n + ENGINE.N0)), alpha0: r2(a.a0), beta0: r2(a.b0) },
      kept: a.kept,
      a: r2(a.a), b: r2(a.b), a0: r2(a.a0), b0: r2(a.b0),
      rewardPer1kImpressions: r3(mean * (a.p - f.F) * 1000),
      rewardPerImpression: r3(mean * (a.p - f.F)),
      truth: { theta: r3(a.th), rewardPerImpression: r3(a.th * (a.p - f.F)) },
      prior: { theta: r3(thetaPrior(a.p, f)), rewardPerImpression: r3(thetaPrior(a.p, f) * (a.p - f.F)) },
      best: a === best,
    };
  });

  return {
    listingId: listing.id,
    sku: listing.sku.key,
    mode,
    modeName: { cash: 'CASH', growth: 'GROWTH', margin: 'MARGIN', clear: 'CLEAR' }[mode] || mode,
    objective: {
      cash: '₹ profit per rupee-day (dual price engaged)',
      growth: '₹ profit per impression, volume-first',
      margin: '₹ profit per impression, arms below T filtered',
      clear: 'kept orders per impression (sell-through)',
    }[mode] || '₹ profit per impression',
    day: state.day,
    liveToday: state.last ? { price: state.last.p, noReturnPrice: state.last.pn, keepRate: state.last.keepRate, impressions: state.last.impressionsToday } : null,
    arms: rows,
    bestArm: best ? { price: best.p, noReturnPrice: best.pn } : null,
    holdout: { price: state.holdout.p, impressions: state.holdout.n, kept: state.holdout.kept, profitPerImpression: r3(holdoutProfit) },
    result: {
      impressions: totalImpressions,
      keptOrders: state.arms.reduce((x, a) => x + a.kept, 0),
      keptPer1kImpressions: r2(state.arms.reduce((x, a) => x + a.kept, 0) / totalImpressions * 1000),
      holdoutSharePct: state.holdoutPct ?? HOLD_PCT,
      banditProfitPerImpression: r3(banditProfit),
      holdoutProfitPerImpression: r3(holdoutProfit),
      observedLiftPct: enoughData ? r2((banditProfit - holdoutProfit) / holdoutProfit * 100) : null,
      observedLiftCI95: enoughData ? liftInterval95(state.arms, state.holdout, f.F) : null,
      enoughData,
      enoughDataReason: enoughData
        ? `holdout has ${state.holdout.n.toLocaleString('en-IN')} impressions (>= 2 x n0)`
        : `holdout has ${state.holdout.n.toLocaleString('en-IN')} impressions; an observed lift is not reported below 4,000 (2 x n0) - the deck's rule is that the holdout decides what may be claimed`,
      expectedBanditPerImpression: r3(expectedBandit),
      expectedHoldoutPerImpression: r3(expectedHoldout),
      expectedLiftPct: expectedHoldout > 0 ? r2((expectedBandit - expectedHoldout) / expectedHoldout * 100) : null,
      noisy: true,
    },
    log: (state.log || []).slice(-60),
    maths: {
      reward: 'r_a = CTR x CVR x k x (p_a - F) = theta_a x (p_a - F) per impression',
      prior: `theta_a ~ Beta(n0 * theta_hat, n0 * (1 - theta_hat)), n0 = ${ENGINE.N0.toLocaleString('en-IN')} from the pooled demand model (ln q = a + b ln p, b = -3)`,
      pull: 'one draw per day; that menu is live for every buyer that day, then s += kept, f += impressions - kept',
      shrinkage: 'w = n / (n + n0) - weight on the SKU\'s own data vs the category prior',
      rotation: 'time-block rotation keeps every buyer seeing one price; no per-buyer pricing (fairness)',
      floorFilter: `arms below F ${money(f.F)} are removed before the draw${mode === 'margin' ? `, and MARGIN also drops arms below ${money(f.T)} profit per kept order` : ''}`,
    },
    floor: { F: f.F, B: f.B, k: f.k, gap: f.gap, arms: f.arms },
  };
}

/** Pre-flight on the proposed move from the live price to the best arm. */
export function propose(state, listing, ctx = {}) {
  const f = ctx.floor || computeFloor(listing.sku.key, listing.costOverrides || {});
  const snap = snapshot(state, listing, { floor: f });
  if (!snap.bestArm) return { proposed: null, reason: 'no eligible arm' };
  const from = listing.price;
  const raw = snap.bestArm.price;
  const stepPct = (raw - from) / from;
  const clipped = Math.abs(stepPct) > 0.08 ? Math.round(from * (1 + Math.sign(stepPct) * 0.08)) : raw;
  const arm = state.arms.find((a) => a.p === raw);
  const checks = enginePreflight({
    floor: f, from, to: raw,
    views: arm ? arm.n : 0,
    daysSinceMove: ctx.daysSinceMove ?? listing.daysSinceMove ?? 0,
    movesThisMonth: ctx.movesThisMonth ?? listing.movesThisMonth ?? 0,
    consent: false,
  });
  const blocking = checks.filter((c) => !c.ok && c.key !== 'Step <= 8%');
  return {
    from,
    proposed: raw,
    clippedTo: clipped !== raw ? clipped : null,
    checks,
    passes: blocking.length === 0,
    card: raw === from
      ? 'No move needed: the best arm is the current price.'
      : blocking.length === 0
        ? `All checks pass -> the seller sees one card: "${money(from)} -> ${money(clipped)}? Yes / No"`
        : 'At least one check fails -> no card is shown this week.',
    sellerCard: raw === from ? null : { from, to: clipped, question: 'Do you want to move your price?', effect: `${money(clipped - f.F)} per kept order vs ${money(from - f.F)} now` },
  };
}
