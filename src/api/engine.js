/**
 * Engine lab + pilot endpoints.
 *
 * The bandit's state and the pilot's maths live on the server, so that
 * (a) learning accumulates across sessions, (b) every client sees the same menu
 * for the day (one price for every buyer), and (c) the holdout is decided by
 * the backend, not by whichever browser happens to be open.
 */

import { ENGINE, PILOT } from '../config/deck.js';
import { computeFloor } from '../engine/floor.js';
import { initBandit, run, snapshot, propose } from '../engine/bandit.js';
import { cityRanking, cityScore, cohort, metrics, pilotDesign, sampleSize, waterfallKeptOrders, waterfallProfit, claimGuard } from '../engine/pilot.js';
import { banditGet, banditKeys, banditSet, events, hydrate, hydratedListings, listing, logEvent, stats } from '../store/db.js';
import { ok, fail } from '../http/respond.js';

export function register(router) {
  /* ------------------------------- the bandit ------------------------------ */
  router.get('/api/engine/bandit', (ctx) => {
    try {
      const l = hydrate(listing(ctx.query.listing || 'L-kurti'));
      const mode = ctx.query.mode || l.mode;
      const key = `${l.id}:${mode}`;
      const { state, created } = getOrInit(l, mode);
      return ok(ctx.res, { key, created, ...snapshot(state, l, { floor: l.floor }), engineKey: key });
    } catch (e) { return fail(ctx.res, e.status || 500, e.message); }
  }, { summary: 'Current bandit state: arms, posteriors, pulls, holdout, lift' });

  router.post('/api/engine/bandit/run', (ctx) => {
    try {
      const b = ctx.body || {};
      const l = hydrate(listing(b.listing || 'L-kurti'));
      const mode = b.mode || l.mode;
      const days = Math.max(1, Math.min(400, Number(b.days) || 1));
      const { state } = getOrInit(l, mode, { seed: b.seed });
      if (b.seed != null) state.seed = Number(b.seed);
      if (b.mode && b.mode !== state.mode) { state.mode = b.mode; }
      run(state, days, l, { floor: l.floor });
      banditSet(`${l.id}:${mode}`, state);
      logEvent('bandit.run', { listingId: l.id, mode, days, day: state.day, seed: state.seed });
      const snap = snapshot(state, l, { floor: l.floor });
      return ok(ctx.res, {
        key: `${l.id}:${mode}`,
        ranDays: days,
        ...snap,
        proposed: propose(state, l, { floor: l.floor, daysSinceMove: l.daysSinceMove, movesThisMonth: l.movesThisMonth }),
        fairness: 'One menu is live for every buyer that day (time-block rotation). No per-buyer pricing.',
      });
    } catch (e) { return fail(ctx.res, e.status || 500, e.message); }
  }, { summary: 'Run N days of constrained Thompson sampling and return arms, lift and the pre-flight proposal' });

  router.post('/api/engine/bandit/reset', (ctx) => {
    try {
      const b = ctx.body || {};
      const l = hydrate(listing(b.listing || 'L-kurti'));
      const mode = b.mode || l.mode;
      const state = initBandit(l, mode, { floor: l.floor, seed: b.seed ?? Math.floor(Math.random() * 1000) });
      banditSet(`${l.id}:${mode}`, state);
      return ok(ctx.res, { key: `${l.id}:${mode}`, ...snapshot(state, l, { floor: l.floor }) });
    } catch (e) { return fail(ctx.res, e.status || 500, e.message); }
  }, { summary: 'Reset the arms (fresh prior, new seed)' });

  router.get('/api/engine/bandits', () => ({ bandits: banditKeys(), note: 'one bandit per listing x goal mode' }));

  router.get('/api/engine/maths', () => ({
    reward: 'r_a = CTR x CVR x k x (p_a - F) = theta_a x (p_a - F) per impression',
    prior: `theta_a ~ Beta(n0 theta_hat, n0 (1 - theta_hat)), n0 = ${ENGINE.N0}`,
    pullRule: 'one Thompson draw per day; that menu is live for all buyers that day; s += kept, f += impressions - kept',
    shrinkage: 'w = n / (n + n0)',
    guard: 'arms below F never enter the draw; one menu per day; 5% holdout at seller level',
    rewardPerImpressionDefinition: 'profit per impression (M19)',
  }), { summary: 'The bandit maths, exactly as on deck slide 7 box 4' });

  /* --------------------------------- pilot -------------------------------- */
  router.get('/api/pilot/design', () => (pilotDesign()),
    { summary: 'Cities, scoring, randomisation, metrics, roadmap and stop rules' });

  router.get('/api/pilot/cities', (ctx) => {
    const cities = cityRanking();
    return ok(ctx.res, {
      cities,
      weights: PILOT.cityWeights,
      recommended: cities.slice(0, 2).map((c) => c.name),
      backup: cities[2].name,
      note: 'Surat scores 4.55 and Rajkot 4.10: one carries the returns problem (fashion), the other the freight problem (bulky home goods).',
    });
  }, { summary: 'City scoring S = sum w_t x_t (M24)' });

  router.post('/api/pilot/sample-size', (ctx) => ok(ctx.res, sampleSize(ctx.body || {})),
    { summary: 'n = 2 (z_a/2 + z_b)^2 s^2 / d^2 (M23)' });

  router.get('/api/pilot/sample-size', (ctx) => ok(ctx.res, sampleSize({})));

  router.get('/api/pilot/impact', () => ({
    profitPerKeptOrder: waterfallProfit(),
    keptOrdersPerSeller: waterfallKeptOrders(),
    metrics: metrics(),
    sampleSize: sampleSize({}),
    caveat: 'Every number here is a target with a causal chain, not a result. The 50/50 pilot and the permanent holdout decide what may be claimed.',
  }), { summary: 'Impact waterfalls + metrics (deck slide 8)' });

  router.post('/api/pilot/cohort', (ctx) => ok(ctx.res, cohort(ctx.body || {})),
    { summary: 'Cohort maths for 10,000 new sellers (deck slide 8 box 6)' });

  router.post('/api/pilot/claim', (ctx) => {
    const b = ctx.body || {};
    return ok(ctx.res, claimGuard(b.claim || 'lift', { hasHoldout: !!b.hasHoldout, treated: b.treated, holdout: b.holdout }));
  }, { summary: 'Claims guard: no lift is published without a holdout comparison' });

  /* ------------------------- live measurement (ops) ----------------------- */
  router.get('/api/pilot/live', () => {
    const all = hydratedListings();
    const rows = all.map((l) => {
      const bandit = banditGet(`${l.id}:${l.mode}`);
      return {
        listingId: l.id, sku: l.skuKey, mode: l.mode,
        price: l.price, floor: l.floor.F,
        belowFloor: l.price < l.floor.F,
        banditDay: bandit ? bandit.day : 0,
        impressions: bandit ? bandit.arms.reduce((x, a) => x + a.n, 0) : 0,
        holdoutImpressions: bandit ? bandit.holdout.n : 0,
      };
    });
    return ({
      treated: rows.filter((r) => !r.belowFloor),
      guardrail: {
        belowFloorListings: rows.filter((r) => r.belowFloor).length,
        target: '0% below floor without the seller first seeing the ₹ loss',
        floorAccuracyVsSettlement: '+-5% target; recalibrate if breached',
      },
      stopRules: PILOT.impact.stopRules,
      stats: stats(),
    });
  }, { summary: 'Ops view: what is live, what the holdout sees, and the stop rules' });

  router.get('/api/audit', (ctx) => ({
    events: events(ctx.num('limit', 50)),
    note: 'Append-only log: every suggestion, acceptance, override, Loss Warning and auto-revert. This is how 2.0 closes the loop on 1.0 limit 5.',
  }), { summary: 'Action + guardrail audit trail' });
}

/* ------------------------------- helpers --------------------------------- */
function getOrInit(l, mode, opts = {}) {
  const key = `${l.id}:${mode}`;
  let state = banditGet(key);
  let created = false;
  if (!state || opts.seed != null && state.seed !== opts.seed) {
    state = initBandit(l, mode, { floor: l.floor, seed: opts.seed ?? 7 });
    banditSet(key, state);
    created = true;
  }
  return { state, created };
}
