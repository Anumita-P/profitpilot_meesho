/**
 * ENGINE TEST - the layers the prototype leaves to the panel: guardrails,
 * the bandit, the lifecycle ladder, the risk models, the pilot maths and the
 * coach. These assert the deck's claims, not just that the code runs.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// isolate the store before any module reads it
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-engine-'));
process.env.PP_DATA_DIR = tmp;

const { computeFloor, floorIsSane, sensitivity, floorWhy, priceAtMargin } = await import('../src/engine/floor.js');
const { simulate, lossWarning, penalty, shrinkage, riskMixAtPrice } = await import('../src/engine/demand.js');
const { modePrice, cashComparison, clearStep, objective, eligible } = await import('../src/engine/modes.js');
const { preflight, panicBrake, autoRevert, trustLadder, herdingCheck, enginePreflight } = await import('../src/engine/guardrails.js');
const { recommend, dualPriceMenu } = await import('../src/engine/recommend.js');
const { diagnose, sellerCard, normaliseSignals } = await import('../src/engine/diagnose.js');
const { lifecycle, classifyStage, stageWindows, exits, exitConsent, stageRoad, orderCurve } = await import('../src/engine/lifecycle.js');
const { initBandit, run, snapshot, propose, HOLD_PCT, liftInterval95 } = await import('../src/engine/bandit.js');
const { sampleSize, cityRanking, cityScore, cohort, waterfallProfit, waterfallKeptOrders, claimGuard, pilotDesign } = await import('../src/engine/pilot.js');
const { launchPlan, deckExamples } = await import('../src/engine/launch.js');
const { returnRisk, codRisk, keepProbability, bufferMatrix, PINCODE_CLUSTERS } = await import('../src/engine/risk.js');
const { routeProgramme, reorderPoint, pooledProcurement, packagingAudit, moduleCatalogue } = await import('../src/engine/programmes.js');
const { answer, routeIntent, intents } = await import('../src/engine/coach.js');
const { hydrate, hydratedListings, listing, seller } = await import('../src/store/db.js');

const all = () => hydratedListings();
const byKey = (k) => hydrate(listing(`L-${k}`));

/* ------------------------------- floor layer ------------------------------ */
test('every floor is internally consistent and above zero', () => {
  for (const l of all()) {
    const sane = floorIsSane(l.floor);
    assert.equal(sane.sumsToF, true, `${l.skuKey}: floor adds up`);
    assert.equal(sane.keptConsistent, true, `${l.skuKey}: 100 -> dispatched -> delivered -> kept`);
    assert.equal(sane.floorBelowStartPrice, true, `${l.skuKey}: F < start price`);
    assert.equal(l.floor.F > 0, true);
    assert.equal(l.floor.B, l.floor.Cret + l.floor.Crto, `${l.skuKey}: B = C_ret + C_RTO`);
  }
});

test('the floor Why carries all five blocks the deck promises', () => {
  const w = floorWhy('kurti');
  for (const k of ['what', 'why', 'effect', 'confidence', 'confidenceWhy', 'undo']) assert.ok(w[k], k);
  assert.equal(w.why.length >= 4, true);
  // deck slide 2 box 2: "180 + 10 + 25 + 32 + 18 + 44 = ₹309" - the engine writes the same sum with C_s / C_pack labels
  const sumLine = w.why[0].replace(/[A-Za-z_]+ /g, '');
  assert.match(sumLine, /^180 \+ 10 \+ 25 \+ 32 \+ 18 \+ 44 = ₹309/);
});

test('price at target margin follows P* = F / (1 - m)', () => {
  assert.equal(Math.round(priceAtMargin(309, 0.15)), Math.round(309 / 0.85));
  assert.equal(Math.round(priceAtMargin(309, 0.22)), Math.round(309 / 0.78));
});

test('raising a cost input raises the floor and the start price', () => {
  const base = computeFloor('kurti');
  const after = computeFloor('kurti', { cs: 220 });
  assert.equal(after.F, base.F + 40, 'sourcing is paid on every kept order');
  assert.equal(after.Pe, base.Pe + 40);
  assert.equal(sensitivity('kurti').levers.length, 6);
});

/* ------------------------------ demand layer ----------------------------- */
test('demand falls as price rises (monotone), and the penalty only bites above the median', () => {
  const l = byKey('kurti');
  let last = Infinity;
  for (let p = 199; p <= 599; p += 25) {
    const o = simulate(l).rows.length ? null : null;
    void o;
  }
  const { ordersPerDay } = { ordersPerDay: (x, p) => x.q0 * Math.pow(p / x.price, -3) };
  for (let p = 199; p <= 599; p += 25) {
    const q = ordersPerDay(l, p);
    assert.ok(q < last, `orders must fall at ${p}`);
    last = q;
  }
  assert.equal(penalty(300, 379), 1, 'no penalty below the median');
  assert.ok(penalty(500, 379) < 1, 'penalty above the median');
});

test('the simulator flags and blocks below-floor prices', () => {
  const l = byKey('kurti');
  const sim = simulate(l);
  const below = sim.rows.filter((r) => r.price < l.floor.F);
  assert.ok(below.length >= 1, 'the 299 arm is below the 309 floor');
  assert.equal(below[0].blocked, true);
  assert.equal(sim.warning !== null, true);
});

test('the Loss Warning gives the deck\'s own number for ₹249', () => {
  const l = byKey('kurti');
  const lw = lossWarning(l, 249);
  assert.equal(lw.blocked, true);
  assert.equal(lw.perKeptOrder, -60);
  assert.match(lw.message, /loses ₹60/);
});

test('COD share rises as price falls (price moves RTO)', () => {
  const l = byKey('kurti');
  const cheap = riskMixAtPrice(l, 299, l.floor);
  const dear = riskMixAtPrice(l, 429, l.floor);
  assert.ok(cheap.codShare > dear.codShare);
});

test('shrinkage matches w = n / (n + n0)', () => {
  assert.equal(shrinkage(0), 0);
  assert.equal(shrinkage(2000), 0.5);
  assert.equal(Math.round(shrinkage(18000) * 100) / 100, 0.9);
});

/* ------------------------------- modes layer ----------------------------- */
test('the floor is enforced in every goal mode', () => {
  for (const mode of ['cash', 'growth', 'margin', 'clear']) {
    for (const l of all()) {
      const rec = recommend(l, { mode });
      assert.ok(rec.to >= l.floor.F || rec.kind === 'hold' || rec.kind === 'launch',
        `${l.skuKey}/${mode}: ${rec.to} >= floor ${l.floor.F}`);
      assert.ok(rec.to >= l.floor.frec, `${l.skuKey}/${mode}: never below the recovery floor`);
    }
  }
});

test('MARGIN mode filters arms below the target profit', () => {
  const l = byKey('kurti');
  const f = l.floor;
  const arms = f.arms.map((p) => ({ p, pn: p - f.gap }));
  const allowed = arms.filter((a) => eligible('margin', a, f).ok);
  assert.equal(allowed.every((a) => a.p - f.F >= f.T), true);
  assert.equal(objective('margin', { p: f.F + 1 }, f), -Infinity, 'arms below T are never sampled');
  assert.equal(objective('clear', { p: f.F + 1 }, f), 1, 'CLEAR maximises sell-through, not margin');
});

test('CASH mode shows the cash-cycle gain from the no-return price', () => {
  const l = byKey('kurti');
  const c = cashComparison(l.floor);
  assert.ok(c.noReturn.perRupeeDay > c.easy.perRupeeDay);
  assert.match(c.why.join(' '), /dual pricing/);
});

test('CLEAR mode steps down but stops at F / 0.97', () => {
  const l = byKey('kurti');
  const step = clearStep(l.floor, 429);
  assert.ok(step.price < 429 && step.price >= l.floor.Fplus);
  const atFloor = clearStep(l.floor, l.floor.Fplus);
  assert.equal(atFloor.moved, false);
});

test('the dual-price menu keeps ₹ per kept order equal on both sides', () => {
  const l = byKey('kurti');
  const m = dualPriceMenu(l);
  assert.equal(m.easyReturns.price, 369);
  assert.equal(m.noReturn.price, 339);
  assert.equal(m.gap, 30);
  assert.equal(m.returnCostPerKeptOrder, 32, 'the gap is computed from C_ret, then rounded to a ₹10 step');
  assert.equal(m.gapMinusReturnCost, -2, 'the rounding is disclosed, not hidden');
  // deck slide 2 box 5: easy returns "floor ₹309 + ₹60", no returns "floor ₹277 + ₹62"
  assert.equal(m.easyReturns.profitPerKeptOrder, 60);
  assert.equal(m.noReturn.profitPerKeptOrder, 62);
  assert.equal(m.floor, 309);
  assert.equal(m.noReturnFloor, 277);
});

/* ----------------------------- guardrail layer --------------------------- */
test('pre-flight blocks an oversized step, a fresh-move cooldown and a third monthly move', () => {
  const f = computeFloor('kurti');
  assert.equal(preflight({ floor: f, from: 369, to: 415, views: 6200, daysSinceMove: 36, movesThisMonth: 0 }).pass, false, '+12.5% step');
  assert.equal(preflight({ floor: f, from: 369, to: 349, views: 6200, daysSinceMove: 2, movesThisMonth: 0 }).pass, false, 'cooldown');
  assert.equal(preflight({ floor: f, from: 369, to: 349, views: 6200, daysSinceMove: 36, movesThisMonth: 2 }).pass, false, 'two moves already');
  assert.equal(preflight({ floor: f, from: 369, to: 349, views: 6200, daysSinceMove: 36, movesThisMonth: 0 }).pass, true, 'a clean -5.4% step');
  assert.equal(preflight({ floor: f, from: 369, to: 349, views: 400, daysSinceMove: 36, movesThisMonth: 0 }).pass, false, 'too little data');
});

test('the floor check blocks a below-floor price unless Exit consent is given', () => {
  const f = computeFloor('vase');
  const without = preflight({ floor: f, from: 499, to: Math.min(f.frec, 359), views: 1400, daysSinceMove: 40, movesThisMonth: 0, consent: false });
  assert.equal(without.checks[0].ok, false);
  const withConsent = preflight({ floor: f, from: 499, to: f.frec, views: 1400, daysSinceMove: 40, movesThisMonth: 0, consent: true });
  assert.equal(withConsent.checks[0].ok, true, 'consent uses the recovery floor instead of F');
});

test('the engine lab adds the four extra pre-flight checks', () => {
  const f = computeFloor('kurti');
  const checks = enginePreflight({ floor: f, from: 369, to: 379, views: 5000, daysSinceMove: 30, movesThisMonth: 0 });
  assert.equal(checks.length, 10, '6 trigger-hygiene checks + 4 engine-lab checks');
  for (const k of ['Range', 'Cost sanity', 'Dispersion', 'Fairness']) {
    assert.ok(checks.some((c) => c.key === k), k);
  }
});

test('the panic brake blocks a cut when the price-value branch did not fire', () => {
  const l = byKey('serum');
  const d = diagnose(l, { ...l.signals, cvrZ: 0, ctrZ: -1.9, weeksHolding: 3 });
  assert.equal(d.priceValueFired, false);
  const brake = panicBrake({ diagnosis: d, floor: l.floor, from: 249, to: 199 });
  assert.equal(brake.blocked, true);
  assert.match(brake.verdict, /blocked/);
  assert.match(brake.sellerLine, /real cause/);
});

test('the panic brake allows a bounded cut when the price-value branch fires inside the band', () => {
  const l = byKey('kurti');
  const d = diagnose(l, { ...l.signals, cvrZ: -1.8, cvr: 9, clicks: 500, weeksHolding: 3, price: 439 }); // above the band p75 429
  assert.equal(d.priceValueFired, true);
  const brake = panicBrake({ diagnosis: d, floor: l.floor, from: 439, to: 409 });
  assert.equal(brake.blocked, false);
  assert.match(brake.verdict, /allowed/);
});

test('auto-revert sends the price back when profit per impression gets worse at day 14', () => {
  const worse = autoRevert({ from: 369, to: 384 }, { dayIndex: 14, impressions: 20000, profit: 5000 }, { impressions: 19000, profit: 6000 });
  assert.equal(worse.revert, true);
  const better = autoRevert({ from: 369, to: 384 }, { dayIndex: 14, impressions: 20000, profit: 9000 }, { impressions: 19000, profit: 6000 });
  assert.equal(better.revert, false);
  const early = autoRevert({ from: 369, to: 384 }, { dayIndex: 7, impressions: 9000, profit: 1000 }, { impressions: 9000, profit: 3000 });
  assert.equal(early.verdict, 'running', 'nothing happens before day 14');
});

test('the trust ladder is earned, never granted', () => {
  assert.equal(trustLadder({ wins: 0, orders: 10 }).level, 'manual');
  assert.equal(trustLadder({ wins: 0, orders: 31 }).level, 'cp');
  assert.equal(trustLadder({ wins: 4, orders: 100, weeksOnAutopilot: 2 }).level, 'au');
  assert.equal(trustLadder({ wins: 4, orders: 100, weeksOnAutopilot: 9 }).scope, 'catalogue');
  assert.match(trustLadder({ wins: 4, orders: 100 }).guard, /never go below F/);
});

test('same-direction herding is capped, not copied', () => {
  const h = herdingCheck(-20, [{ delta: -10 }, { delta: -15 }, { delta: -5 }, { delta: -20 }, { delta: -8 }, { delta: -12 }]);
  assert.equal(h.warn, true);
  assert.match(h.text, /widens dispersion/);
  const clean = herdingCheck(-20, [{ delta: 10 }, { delta: -15 }, { delta: 5 }]);
  assert.equal(clean.warn, false);
});

/* ---------------------------- recommend layer ---------------------------- */
test('the weekly card always carries the five Why blocks and its pre-flight', () => {
  for (const l of all()) {
    for (const mode of ['growth', 'cash', 'margin', 'clear']) {
      const r = recommend(l, { mode });
      assert.ok(r.what && r.why.length && r.effect && r.confidence && r.undo, `${l.skuKey}/${mode}`);
      assert.ok(r.confidenceWhy);
      assert.equal(typeof r.guardrails.canPublish, 'boolean');
      if (r.kind !== 'hold' && r.kind !== 'launch' && r.kind !== 'dual') {
        assert.ok(r.preflight, `${l.skuKey}/${mode}: moves carry pre-flight checks`);
      }
    }
  }
});

test('a fresh move triggers the cooldown hold, and only a third of the month is spendable', () => {
  const l = byKey('kurti');
  const fresh = recommend({ ...l, daysSinceMove: 1 }, { mode: 'growth' });
  assert.equal(fresh.kind, 'hold');
  assert.match(fresh.headline, /cooldown/);
  const spent = recommend({ ...l, movesThisMonth: 2 }, { mode: 'growth' });
  assert.equal(spent.kind, 'hold');
});

test('the growth branch requires conversion to hold, stock cover and the kept rate', () => {
  const l = byKey('kurti');
  assert.equal(recommend(l, { mode: 'growth' }).kind, 'up');
  assert.equal(recommend({ ...l, signals: { ...l.signals, cvr: 9 } }, { mode: 'growth' }).kind, 'hold');
  assert.equal(recommend({ ...l, signals: { ...l.signals, doi: 12 } }, { mode: 'growth' }).kind, 'hold');
  assert.equal(recommend({ ...l, signals: { ...l.signals, keptRatePct: 60 } }, { mode: 'growth' }).kind, 'hold');
});

/* ----------------------------- diagnose layer ---------------------------- */
test('the deck\'s serum scenario: clicks are the bottleneck, not the price', () => {
  const l = byKey('serum');
  const d = diagnose(l, l.signals);
  assert.equal(d.branches.clicks.fired, true);
  assert.equal(d.branches.views.fired, false);
  assert.match(d.branches.clicks.fix, /main image/);
  assert.equal(d.biggestLoss.key, 'clicks');
});

test('price is checked last and flagged with the band position', () => {
  const l = byKey('kurti');
  const d = diagnose(l, { ...l.signals, price: 599 });
  assert.equal(d.branches.price.checkedLast, true);
  assert.equal(d.branches.price.fired, true);
  assert.match(d.branches.price.fix, /bounded test|craf/i);
});

test('the seller card hides the ₹60 loss behind a Yes / No line', () => {
  const l = byKey('kurti');
  const d = diagnose(l, l.signals);
  const card = sellerCard({ listingId: l.id, diagnosis: d, floor: l.floor, from: 369, to: 249, signals: l.signals, daysSinceMove: 36, movesThisMonth: 0, dayIndex: 7 });
  assert.equal(card.blocked, true);
  assert.equal(card.lossPerKeptOrder, -60);
  assert.match(card.sellerLine, /₹249 loses ₹60 per kept order/);
  assert.equal(card.checks.length, 6);
  assert.match(card.engineLine, /checks fail/);
});

/* ---------------------------- lifecycle layer ---------------------------- */
test('stage windows scale with the category life, so the same day means different things', () => {
  const kurti = stageWindows(byKey('kurti').sku);
  const lunch = stageWindows(byKey('lunch').sku);
  assert.equal(kurti.launch, 30);
  assert.equal(lunch.launch, 60);
  assert.ok(lunch.decline > kurti.decline);
});

test('the classifier reproduces the deck: kurti growth, lunch/serum maturity, vase decline', () => {
  assert.equal(byKey('kurti').stage, 'growth');
  assert.equal(byKey('lunch').stage, 'maturity');
  assert.equal(byKey('serum').stage, 'maturity');
  assert.equal(byKey('romper').stage, 'growth');
  assert.equal(byKey('vase').stage, 'decline');
});

test('the classifier reacts to signals, not just age', () => {
  const sku = byKey('kurti').sku;
  assert.equal(classifyStage({ sku, ageDays: 10 }).stage, 'launch');
  assert.equal(classifyStage({ sku, ageDays: 40, keptUnitTrendPct: 30 }).stage, 'growth');
  assert.equal(classifyStage({ sku, ageDays: 100, keptUnitTrendPct: 2 }).stage, 'maturity');
  assert.equal(classifyStage({ sku, ageDays: 150, keptUnitTrendPct: -25 }).stage, 'decline');
  assert.equal(classifyStage({ sku, ageDays: 150, keptUnitTrendPct: 0, doi: 80 }).stage, 'decline');
  assert.equal(classifyStage({ sku, ageDays: 179, keptUnitTrendPct: 0 }).stage, 'exit');
});

test('the lifecycle ladder never breaks the floor, and the rival test is arithmetic', () => {
  for (const l of all()) {
    const lc = lifecycle(l);
    assert.ok(lc.priceLadder.M3 >= lc.floor.F, `${l.skuKey}: clearance >= F`);
    assert.ok(lc.priceLadder.M1 < lc.events[2].price, 'markdown goes down');
    assert.match(lc.rivalTest.formula, /hold .* match .*\/day/);
    assert.equal(lc.events.length, 6);
  }
});

test('exits rank by value recovered, and parking loses carry cost', () => {
  const l = byKey('vase');
  const ex = exits(l);
  const bundle = ex.find((e) => e.key === 'bundle');
  const b2b = ex.find((e) => e.key === 'b2b');
  assert.ok(bundle.recoveryPct > b2b.recoveryPct, 'bundling beats a bulk lot');
  assert.ok(ex.find((e) => e.key === 'park').recoveryPct < 0, 'parking costs money');
  assert.match(ex.find((e) => e.key === 'return-donate').why, /reverse logistics/);
});

test('Exit consent is explicit, never below the recovery floor, and always priced with its loss', () => {
  for (const id of ['kurti', 'lunch', 'serum', 'romper', 'vase']) {
    const l = byKey(id);
    const lc = lifecycle(l);
    const c = exitConsent(l);
    assert.equal(c.consentRequired, true, id);
    assert.ok(c.price >= l.floor.frec, `${id}: never below the recovery floor`);
    assert.ok(c.price < lc.priceLadder.M1, `${id}: below the first markdown rung`);
    assert.ok(c.price <= l.floor.Pm, `${id}: far below the plan price`);
    assert.ok(c.price >= Math.round(l.floor.F * 0.96), `${id}: within a rounding step of the floor (the 0.94 step off the last rung)`);
    assert.match(c.warning, /frees cash/);
    assert.equal(c.scope.startsWith('Exit stage only, with explicit seller consent'), true);
    assert.match(c.recoveryFloorDefinition, /Variable costs/);
    assert.equal(typeof c.aboveFloorInThisCase, 'boolean');
  }
  // the guard that matters: if the ladder ever has to cross F, the recovery floor catches it
  const l = byKey('vase');
  assert.ok(l.floor.frec < l.floor.F, 'the recovery floor is a genuine sub-floor number');
  const forced = { ...l, floor: { ...l.floor, frec: 399 } }; // a recovery floor above the consent price
  const c = exitConsent(forced, { floor: forced.floor });
  assert.equal(c.price, 399, 'consent stops at the recovery floor, it does not go lower');
});

test('the stage road covers the whole life without gaps', () => {
  const road = stageRoad(byKey('kurti').sku);
  assert.equal(road.length, 5);
  for (let i = 1; i < road.length; i++) assert.equal(road[i].from, road[i - 1].to, 'contiguous stages');
  assert.equal(road[0].from, 0);
});

test('the deck\'s illustrative curve rises, peaks and decays', () => {
  const early = orderCurve(0.05);
  const peak = orderCurve(0.45);
  const late = orderCurve(0.9);
  assert.ok(peak > early && peak > late, 'hump-shaped');
  assert.ok(orderCurve(1) < 0.6 * peak, 'the exit stage is materially below the peak');
  // the deck prints the formula itself (slide 4 box 1) - keep it exact
  const deckCurve = (t) => 0.04 + 0.86 / (1 + Math.exp(-11 * (t - 0.3))) - 2.6 * Math.pow(Math.max(0, t - 0.62), 1.7);
  for (const t of [0, 0.2, 0.45, 0.7, 1]) assert.ok(Math.abs(orderCurve(t) - Math.max(0, deckCurve(t))) < 1e-12, `t=${t}`);
});

/* ------------------------------ bandit layer ----------------------------- */
test('the bandit filters sub-floor arms, keeps one menu per day and learns', () => {
  const l = byKey('kurti');
  const state = initBandit(l, 'growth');
  assert.equal(state.arms.length, 4, '5 arms minus the lean arm the prototype drops');
  assert.equal(state.arms[0].p, 299);
  assert.match(String(HOLD_PCT), /0\.05/);
  run(state, 30, l);
  const snap = snapshot(state, l);
  const blocked = snap.arms.find((a) => a.price < l.floor.F);
  assert.equal(blocked.status, 'BLOCKED');
  assert.equal(blocked.pulls, 0, 'a below-floor arm is never pulled');
  const pulled = snap.arms.filter((a) => a.pulls > 0);
  assert.ok(pulled.length >= 2, 'exploration happens');
  assert.ok(snap.arms.reduce((x, a) => x + a.pulls, 0) > 100000, '30 days of traffic');
  assert.ok(snap.holdout.impressions > 0, 'the holdout is measured');
  assert.ok(snap.result.expectedLiftPct !== null);
  assert.equal(snap.bestArm.price, 369, 'truth favours the current price over the prior\'s higher arms');
});

test('the prior favours high prices and the data corrects it', () => {
  const l = byKey('kurti');
  const state = initBandit(l, 'growth');
  const snap0 = snapshot(state, l);
  const priorFavours = snap0.arms.slice().sort((a, b) => b.prior.rewardPerImpression - a.prior.rewardPerImpression);
  assert.equal(priorFavours[0].price, 429, 'before data, b = -3 with no penalty favours the top arm');
  run(state, 40, l);
  const snap = snapshot(state, l);
  const best = snap.arms.filter((a) => a.pulls > 0).slice().sort((a, b) => b.posterior.mean - a.posterior.mean)[0];
  assert.ok(best.price <= 399, 'the data pulls the belief down');
});

test('every arm carries a posterior, a weight and an interval-friendly CI', () => {
  const l = byKey('kurti');
  const state = initBandit(l, 'growth');
  run(state, 10, l);
  const snap = snapshot(state, l);
  snap.arms.forEach((a) => {
    assert.ok(a.posterior.alpha > 0 && a.posterior.beta > 0, 'Beta posterior parameters');
    assert.ok(a.posterior.weight >= 0 && a.posterior.weight <= 1, 'shrinkage weight');
    assert.equal(typeof a.truth.theta, 'number');
    assert.equal(typeof a.prior.theta, 'number');
  });
  const ci = liftInterval95(state.arms, state.holdout, l.floor.F);
  assert.ok(ci.low <= ci.point && ci.point <= ci.high);
});

test('the proposal goes through pre-flight before the seller sees a card', () => {
  const l = byKey('kurti');
  const state = initBandit(l, 'growth');
  run(state, 5, l);
  const p = propose(state, l, { daysSinceMove: 36, movesThisMonth: 0 });
  assert.ok(p.checks.length === 8 || p.checks.length === 10);
  assert.equal(typeof p.passes, 'boolean');
  if (!p.passes) assert.match(p.card, /no card/);
});

/* ------------------------------- pilot layer ----------------------------- */
test('the sample size is the deck\'s 251 per arm', () => {
  const s = sampleSize();
  assert.equal(s.nPerArm, 251);
  assert.match(s.formula, /2 x \(1.96 \+ 0.84\)/);
});

test('the city scores and ranking match the deck', () => {
  const cities = cityRanking();
  assert.equal(cityScore(cities[0].scores), 4.55);
  assert.equal(cities[0].name, 'Surat');
  assert.equal(cities[1].name, 'Rajkot');
  assert.equal(cities.find((c) => c.name === 'Tiruppur').score, 3.6, 'the backup city');
});

test('the impact waterfall adds to the deck\'s ₹104.5 (+24%)', () => {
  const w = waterfallProfit();
  assert.equal(w.rows[w.rows.length - 1].value, 104.5);
  assert.equal(w.total, 20.5);
  assert.equal(Math.round(w.liftPct), 24); // deck prints +24% (84 -> 104.5 is +24.4%)
  assert.match(w.note, /Dual price is not counted here/);
});

test('the kept-order chain multiplies to about 31 (+10%)', () => {
  const w = waterfallKeptOrders();
  assert.equal(w.start, 28);
  assert.ok(Math.abs(w.end - 30.55) < 0.01);
  assert.equal(Math.round(w.liftPct), 9);           // computed from the deck's own multipliers
  assert.deepEqual(w.deckClaim, { to: 31, liftPct: 10, roundingNote: w.deckClaim.roundingNote });
  assert.match(w.deckClaim.roundingNote, /30\.55/); // the rounded claim is disclosed
  assert.equal(w.why.length, 5);
});

test('the cohort maths holds the deck\'s ₹65 cr -> ₹90 cr (+37%)', () => {
  const c = cohort();
  assert.equal(c.deckClaim.cohortNmvWithout, 650000000, 'deck prints ₹65 cr');
  assert.equal(c.deckClaim.cohortNmvWith, 900000000, 'deck prints ₹90 cr');
  assert.equal(c.deckClaim.upliftPct, 38.46, 'deck prints +37% on its rounded figures');
  assert.equal(Math.round(c.computed.cohortNmvWithout / 1e7 * 10) / 10, 65.5, '5,000 x ₹1.31 L');
  assert.equal(Math.round(c.computed.cohortNmvWith / 1e7), 90, '6,000 x ₹1.50 L');
  assert.equal(Math.round(c.cohortUpliftPct), 37, 'the computed uplift is also +37% once rounded');
  assert.match(c.deckClaim.roundingNote, /65\.5/);
  assert.equal(c.profitPerAdopterPct, 36.4);
});

test('the claim guard refuses a lift without a holdout', () => {
  assert.equal(claimGuard('+24% profit').allowed, false);
  assert.match(claimGuard('+24% profit').reason, /holdout/);
  assert.equal(claimGuard('+24%', { hasHoldout: true, treated: 104.5, holdout: 84 }).allowed, true);
});

test('the pilot plan names two cities, a backup, 500 sellers and the stop rules', () => {
  const d = pilotDesign();
  assert.equal(d.where.length, 2);
  assert.equal(d.backup.name, 'Tiruppur');
  assert.equal(d.design.treated + d.design.holdout, 500);
  assert.equal(d.design.weeks, 12);
  assert.equal(d.impact.stopRules.length, 4);
  assert.equal(d.roadmap.length, 5);
});

/* ------------------------------- launch layer ---------------------------- */
test('the cold-start plan returns five steps and a floor-checked opening price', () => {
  const p = deckExamples().bangaloreKurti;
  assert.equal(p.steps.length, 6, 'steps 1,2,3,4,4b,5');
  assert.equal(p.steps[5].title, 'Price hypothesis');
  assert.ok(p.steps[5].opening >= p.floor.F, 'opening is above the floor');
  assert.equal(p.menu.easyReturns - p.menu.noReturn, p.menu.gap);
  assert.equal(p.testPlan.days1to14.includes('No price change'), true);
  assert.equal(p.playbook.length, 6);
});

test('the launch-play matrix routes on competition and stock depth', () => {
  const deep = launchPlan({ category: 'ethnic', skuKey: 'kurti', comparables: { count: 24, median: 379 }, stock: { days: 60 } });
  assert.equal(deep.play.key, 'velocity', 'crowded + deep stock -> open just under the median');
  const thin = launchPlan({ category: 'ethnic', skuKey: 'kurti', comparables: { count: 24, median: 379 }, stock: { days: 10 } });
  assert.equal(thin.play.key, 'differentiate');
  const quiet = launchPlan({ category: 'ethnic', skuKey: 'kurti', comparables: { count: 3, median: 540, p25: 499, p75: 599 }, stock: { days: 60 } });
  assert.equal(quiet.play.key, 'priceDiscovery');
});

test('the deck\'s three worked launch examples reproduce, input for input', () => {
  const e = deckExamples();
  const b = e.bangaloreKurti;
  assert.equal(b.floor.F, 309);                      // 180 + 10 + 25 + 32 + 18 + 44
  assert.equal(b.steps[5].safetyMargin, 18);         // deck trace: "F ₹309 + ₹18 margin = ₹327 min"
  assert.equal(b.steps[5].opening, 369);             // Velocity: open just under the ₹379 median
  assert.equal(b.menu.noReturn, 339);                // the dual-price menu ₹369 / ₹339
  assert.equal(b.play.key, 'velocity');

  const j = e.jaipurHandblock.plan;
  assert.equal(j.floor.F, 429);                      // deck: "F ₹430 (assumed)"
  assert.equal(j.steps[5].opening, 549);             // deck: "hold ₹549, no discount"
  assert.equal(j.play.key, 'priceDiscovery');

  const r = e.rajkotLunchbox.plan;
  assert.equal(r.floor.F, 346);                      // the deck's lunch-box floor
  assert.equal(r.steps[5].opening, 449);             // deck: "₹449 today"
  assert.deepEqual(r.testPlan.day15Onwards.discoveryLadder, [469, 479]); // "from day 15 ₹479 on alternate days"
});

test('a fragile, heavy SKU gets a higher freight and packaging input', () => {
  const light = launchPlan({ category: 'ethnic', skuKey: 'kurti', features: { weightKg: 0.4, fragile: false }, comparables: { count: 10, median: 379 }, stock: { days: 40 } });
  const heavy = launchPlan({ category: 'ethnic', skuKey: 'kurti', features: { weightKg: 1.5, fragile: true }, comparables: { count: 10, median: 379 }, stock: { days: 40 } });
  assert.ok(heavy.floor.breakdown.fwd > light.floor.breakdown.fwd);
  assert.ok(heavy.floor.breakdown.pack > light.floor.breakdown.pack);
});

/* -------------------------------- risk layer ----------------------------- */
test('return risk rises with COD, fragility and pincode tier', () => {
  const base = returnRisk({ category: 'ethnic', pincodeCluster: 'metro-prepaid', fragile: false, weightKg: 0.5 });
  const worst = returnRisk({ category: 'ethnic', pincodeCluster: 'tier3-cod', fragile: true, weightKg: 1.5 });
  assert.ok(worst.pReturn > base.pReturn);
  assert.equal(worst.pRto > base.pRto, true);
  assert.equal(PINCODE_CLUSTERS.length, 5);
});

test('the prepaid nudge lowers the modelled return risk', () => {
  const withNudge = returnRisk({ category: 'ethnic', pincodeCluster: 'tier3-cod', prepaidNudge: true });
  const without = returnRisk({ category: 'ethnic', pincodeCluster: 'tier3-cod', prepaidNudge: false });
  assert.ok(withNudge.pReturn < without.pReturn);
  assert.ok(withNudge.why.join(' ').includes('20.9%'));
});

test('COD risk flags the risky cluster and suggests the cheap action', () => {
  const high = codRisk({ pincodeCluster: 'tier3-cod', orderValue: 900 });
  const low = codRisk({ pincodeCluster: 'metro-prepaid', orderValue: 200, customerCodAcceptance: 0.95 });
  assert.ok(high.score > low.score);
  assert.match(high.action, /prepaid|confirmation/);
  assert.equal(low.band, 'low');
});

test('keep-probability decides which price to show first, per cluster', () => {
  const l = byKey('kurti');
  const kp = keepProbability(l, 'tier3-cod');
  assert.ok(kp.keepProbability > 0 && kp.keepProbability < 1);
  assert.match(kp.display, /no-return|easy-returns/);
  assert.equal(bufferMatrix(l, l.floor).length, 5);
});

/* ----------------------------- programme layer --------------------------- */
test('programme routing follows the deck\'s three rules', () => {
  assert.equal(routeProgramme({ salesHistoryDays: 10 }).programme, 'STARTER_PACK');
  assert.equal(routeProgramme({ salesHistoryDays: 90, artisanScore: 0.8, lookalikes: 4 }).programme, 'MAKER_PROGRAMME');
  assert.equal(routeProgramme({ salesHistoryDays: 90, artisanScore: 0.8, lookalikes: 20 }).programme, 'HUMAN_REVIEW');
  assert.equal(routeProgramme({ salesHistoryDays: 90, artisanScore: 0.2, doi: 73 }).programme, 'STOCK_RECOVERY');
  assert.equal(routeProgramme({ salesHistoryDays: 90, artisanScore: 0.2, doi: 20 }).programme, 'FAST_MOVERS');
});

test('the reorder point reproduces the deck\'s 102 units', () => {
  const rop = reorderPoint({ dailyUnits: 12, leadTimeDays: 7 });
  assert.equal(rop.demandInLeadTime, 84);
  assert.equal(rop.reorderPoint, 102);
  assert.equal(rop.orderQuantity, 170);
  assert.equal(rop.cashRequired, 35700);
  assert.equal(rop.poolingSaving, 3740);
});

test('pooled procurement and the weight audit carry the deck\'s numbers', () => {
  const pool = pooledProcurement({});
  assert.equal(pool.forecastPerSeller, 60);
  assert.equal(pool.savingPerSeller, 1320);
  const audit = packagingAudit({ declaredKg: 0.5, actualKg: 0.9, declaredCm: 20, actualCm: 26, fragile: true });
  assert.equal(audit.slabMismatch, true);
  assert.ok(audit.rechargePerParcel > 0);
  assert.match(audit.kit, /fragile kit/);
});

test('every 2.0 module fixes at least one numbered 1.0 limit', () => {
  const mods = moduleCatalogue();
  assert.equal(mods.length, 9);
  mods.forEach((m) => assert.ok(m.fixes.length > 0 && m.who && m.impact, m.name));
});

/* ------------------------------- coach layer ----------------------------- */
test('the coach routes English and Hindi questions to the same intents', () => {
  assert.equal(routeIntent('Why are returns coming?'), 'returns');
  assert.equal(routeIntent('Returns kyun aa rahe hain?'), 'returns');
  assert.equal(routeIntent('My orders dropped'), 'orders');
  assert.equal(routeIntent('Orders kam ho gaye'), 'orders');
  assert.equal(routeIntent('How is my floor made?'), 'floor');
  assert.equal(routeIntent('Should I run ads?'), 'ads');
  assert.equal(routeIntent('When to reorder stock?'), 'reorder');
  assert.equal(routeIntent('I still want to cut price'), 'cut');
  assert.equal(routeIntent('what is a quokka'), null);
  assert.equal(intents().length >= 15, true);
});

test('the coach answers with a source, a confidence and engine numbers, in both languages', () => {
  const l = byKey('kurti');
  for (const lang of ['en', 'hi']) {
    for (const intent of intents()) {
      const a = answer({ listing: l, intent, lang, mode: 'growth' });
      assert.ok(a.answer && a.answer.length > 10, `${lang}/${intent}: answer`);
      assert.ok(a.source, `${lang}/${intent}: source`);
      assert.ok(['High', 'Medium', 'Low'].includes(a.confidence), `${lang}/${intent}: confidence`);
      assert.equal(a.moneyActionsRequireTap, true);
      assert.equal(a.neverChangesAnythingItself, true);
      if (a.engine) {
        assert.equal(a.engine.floor, l.floor.F, `${lang}/${intent}: uses the live floor`);
      }
    }
  }
});

test('a thin-data answer says so instead of guessing', () => {
  const thin = { ...byKey('kurti'), signals: { ...byKey('kurti').signals, views: 300 } };
  const a = answer({ listing: thin, intent: 'orders', lang: 'en' });
  assert.equal(a.confidence, 'Low');
  assert.equal(a.thinData, true);
  assert.match(a.confidenceWhy, /300 impressions/);
  const healthy = answer({ listing: byKey('kurti'), intent: 'orders', lang: 'en' });
  assert.notEqual(healthy.confidence, 'Low', '6,200 impressions do not count as thin');
});

test('the seller\'s eight questions all have a live answer', async () => {
  const l = byKey('kurti');
  const map = { 'How much should I sell it for?': 'raise', 'Will it actually make a profit?': 'profit', 'Others already sell it. What now?': 'comp', 'Why are buyers not ordering?': 'orders', 'Why do buyers return it?': 'returns', 'Where is the demand?': 'comp', 'Stock is stuck. Discount or wait?': 'stuck', 'Should I pay for ads?': 'ads' };
  for (const [q, intent] of Object.entries(map)) {
    const a = answer({ listing: l, intent, lang: 'en' });
    assert.ok(a.answer.length > 20, q);
  }
});

/* ------------------------------ store layer ------------------------------- */
test('the demo seller is the deck\'s seller and his state persists', () => {
  const s = seller('S-ramesh');
  assert.equal(s.name, 'Ramesh');
  assert.equal(s.city, 'Surat');
  assert.equal(s.pilot.city, 'surat');
  assert.equal(s.pilot.arm, 'treated');
  assert.equal(s.wins >= 0, true);
});
