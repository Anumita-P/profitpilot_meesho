/**
 * CLOSED-LOOP TEST SUITE.
 *
 * These tests are about behaviour that a demo can be tempted to fake:
 *   - a price below the floor is refused and NOTHING changes;
 *   - no verdict without evidence, no claim without a holdout, no win without an
 *     outcome that was actually measured;
 *   - autopilot is earned, not granted, and only by wins that beat a holdout;
 *   - the loop closes: observed events change the features and the NEXT
 *     recommendation is measurably different because of what was observed.
 *
 * The store is isolated in a temp directory, and every timestamp is explicit, so
 * the whole file is deterministic and re-runnable.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-loop-'));
process.env.PP_DATA_DIR = tmp;

const db = await import('../src/store/db.js');
const events = await import('../src/domain/events.js');
const recs = await import('../src/domain/recommendations.js');
const outcomes = await import('../src/domain/outcomes.js');
const exps = await import('../src/domain/experiments.js');
const actions = await import('../src/domain/actions.js');
const trust = await import('../src/domain/trust.js');
const apply = await import('../src/domain/apply.js');
const recalc = await import('../src/jobs/recalc.js');
const scheduler = await import('../src/jobs/scheduler.js');
const versions = await import('../src/domain/versions.js');
const models = await import('../src/models/interfaces.js');
const { recommend } = await import('../src/engine/recommend.js');
const { preflight } = await import('../src/engine/guardrails.js');
const { computeFloor } = await import('../src/engine/floor.js');
const { GUARDRAILS } = await import('../src/config/deck.js');

outcomes.registerEventIngest(events);

const LISTING = 'L-kurti';
const SKU = 'kurti';
const FLOOR = 309;               // deck: kurti F
const DAY = 86400000;
const iso = (s) => new Date(s).toISOString();
const reset = () => { db.reset(); };

/* ============================ 1. event loop ============================== */
test('event ingestion validates, dedupes and refuses cross-seller writes', () => {
  reset();
  const good = events.ingest({
    listing_id: LISTING, event_type: 'VIEW_RECORDED', timestamp: '2026-10-01T00:00:00Z',
    payload: { views: 1200, clicks: 44 }, source: 'seller_panel',
  }, { sellerId: 'S-ramesh' });
  assert.match(good.event.event_id, /^EVT-\d{6}$/, 'an event id is minted');
  assert.equal(good.duplicate, false);

  // same natural key -> the same event, not a second row
  const again = events.ingest({
    listing_id: LISTING, event_type: 'VIEW_RECORDED', timestamp: '2026-10-01T00:00:00Z',
    payload: { views: 1200, clicks: 44 }, source: 'seller_panel',
  }, { sellerId: 'S-ramesh' });
  assert.equal(again.duplicate, true, 'natural-key dedupe');
  assert.equal(again.event.event_id, good.event.event_id);

  // another seller cannot write into this listing
  assert.throws(() => events.ingest({
    listing_id: LISTING, event_type: 'VIEW_RECORDED', timestamp: '2026-10-01T01:00:00Z',
    payload: { views: 10, clicks: 1 }, source: 'seller_panel',
  }, { sellerId: 'S-meera' }), (e) => e.status === 403, 'cross-seller ingest is refused');

  // malformed payloads are 400s that name the field
  const malformed = (() => {
    try { events.ingest({ listing_id: LISTING, event_type: 'VIEW_RECORDED', payload: {} }, { sellerId: 'S-ramesh' }); return null; } catch (e) { return e; }
  })();
  assert.equal(malformed.status, 400, 'a malformed payload is a 400');
  assert.ok(/payload|views|clicks/.test(malformed.message), `the refusal names what is missing (${malformed.message})`);
  assert.throws(() => events.ingest({ listing_id: LISTING, event_type: 'NOT_A_TYPE', payload: {} }, {}),
    (e) => e.status === 400, 'unknown type refused');
  assert.equal(events.EVENT_TYPE_LIST.length, 14, 'the 14 event types are wired');
});

test('a below-floor PRICE_CHANGED is refused, stores nothing and is audited', () => {
  reset();
  const before = db.listing(LISTING).price;
  const eventsBefore = db.load().ingestedEvents.length;

  assert.throws(() => events.ingest({
    listing_id: LISTING, event_type: 'PRICE_CHANGED', timestamp: '2026-10-01T00:00:00Z',
    payload: { to: 249, from: before }, source: 'seller_panel',
  }, { sellerId: 'S-ramesh' }), (e) => e.status === 409, '249 is below the 309 floor');

  assert.equal(db.listing(LISTING).price, before, 'the price did not move');
  assert.equal(db.load().ingestedEvents.length, eventsBefore, 'no event was stored');
  const blocked = db.events(50).find((e) => e.type === 'guardrail.blocked');
  assert.ok(blocked, 'the refusal is audited');

  // with explicit seller consent the exit-recovery price is allowed
  const consented = events.ingest({
    listing_id: LISTING, event_type: 'PRICE_CHANGED', timestamp: '2026-10-01T01:00:00Z',
    payload: { to: computeFloor(SKU).frec, from: before, consent: true }, source: 'seller_panel',
  }, { sellerId: 'S-ramesh', consent: true });
  assert.equal(consented.duplicate, false);
  assert.equal(db.listing(LISTING).price, computeFloor(SKU).frec, 'consented recovery price applied');
});

/* ====================== 2. floors cannot be bypassed ===================== */
test('the floor is arithmetically impossible to go below silently', () => {
  const f = computeFloor(SKU);
  assert.equal(f.F, FLOOR, 'kurti floor is the deck number');
  assert.equal(f.F, f.cs + f.pack + f.fwd + f.Cret + f.Crto + f.other, 'F is the sum of its parts');
  assert.ok(f.frec < f.F, 'the consented recovery floor is below F');

  reset();
  const live = db.listing(LISTING).price;
  const attempts = [
    { to: 0 }, { to: -100 }, { to: FLOOR - 1 }, { to: 249 },
  ];
  for (const a of attempts) {
    assert.throws(() => apply.applyPrice({ listingId: LISTING, to: a.to, actor: 'test' }),
      (e) => e.status === 409 || e.status === 400, `₹${a.to} must not publish`);
  }
  assert.equal(db.listing(LISTING).price, live, 'the live price is untouched after every attempt');

  // the Loss Warning states the per-kept-order loss, from the same arithmetic.
  // A dry run does not throw: it reports refusal, so the UI can explain it.
  const warn = apply.previewPrice({ listingId: LISTING, to: 299, actor: 'test' });
  assert.equal(warn.belowFloor, true);
  assert.equal(warn.wouldBlock, true, 'the preview says it would be refused');
  assert.ok(warn.blocking.some((b) => b.startsWith('Floor')), 'the floor check is among the blockers');
  assert.equal(db.listing(LISTING).price, live, 'and the preview still changed nothing');
});

/* ========================= 3. the ten guardrails ========================= */
test('every one of the ten guardrails refuses the move it exists for', () => {
  reset();
  const f = computeFloor(SKU);
  const base = { floor: f, from: 369, to: 384, views: 6000, daysSinceMove: 30, movesThisMonth: 0 };

  // 1-5 are the pre-flight checks: remove one condition at a time.
  const checks = (over) => preflight({ ...base, ...over }).checks;
  assert.equal(checks({})[0].key, 'Floor');
  assert.equal(checks({ to: 300 })[0].ok, false, '1. hard floor');
  assert.equal(checks({ to: 420 }).find((c) => c.key.startsWith('Step')).ok, false, '2. +-8% step');
  assert.equal(checks({ views: 900 }).find((c) => c.key.startsWith('Views')).ok, false, '3. 1,000-view sanity');
  assert.equal(checks({ daysSinceMove: 3 }).find((c) => c.key.startsWith('Cooldown')).ok, false, '4. 7-day cooldown');
  assert.equal(checks({ movesThisMonth: 2 }).find((c) => c.key.startsWith('≤')).ok, false, '5. <= 2 moves a month');
  const schedule = checks({}).find((c) => c.key.startsWith('Auto-revert'));
  assert.match(schedule.detail, /day 14/, '6. auto-revert is scheduled at day 14');
  assert.match(schedule.detail, /day 28/, '7. confirm is scheduled at day 28');

  // 8. the Loss Warning: below-floor attempts carry the per-kept-order loss
  assert.throws(() => apply.applyPrice({ listingId: LISTING, to: 299, actor: 'test' }), (e) => {
    assert.ok(e.detail.lossWarning && e.detail.lossWarning.perKeptOrder < 0, 'the loss is quantified');
    return e.status === 409;
  });

  // 9. the panic brake: a cut with no price-value branch fired is refused
  const rec = recalc;
  db.load().listings[LISTING].signals.views = 6000;
  const a = actions.create({ recommendationId: mkRec(320) });
  const checked = actions.check(a.action.action_id);
  assert.equal(checked.status, 'BLOCKED', '9. panic brake refuses a diagnose-first cut');
  assert.ok(checked.guardrail.blocking.some((b) => /Panic brake/.test(b)), 'and says why');

  // 10. the permanent holdout: a claim is refused without one
  const e = exps.create({ name: 'holdout test', seller_id: 'S-ramesh', listing_id: LISTING }, {});
  const claim = exps.generateClaim(e.experiment_id);
  assert.equal(claim.allowed, false, '10. no claim without treatment + holdout evidence');
  assert.ok(e.design.holdoutPct >= 1, 'the design keeps a holdout');

  assert.equal(GUARDRAILS.hardFloor && GUARDRAILS.panicBrake, true, 'guardrails are config, not per-request');
  void rec;
});

/* ======================= 4. lifecycle state machine ====================== */
test('the recommendation lifecycle refuses invalid moves and never invents a verdict', () => {
  reset();
  const id = mkRec(384);
  assert.equal(recs.get(id).status, 'GENERATED');
  assert.throws(() => recs.markApplied(id, { price: 384 }), (e) => e.status === 409,
    'GENERATED cannot jump to APPLIED');
  const err = (() => { try { recs.markApplied(id, { price: 384 }); } catch (e) { return e; } })();
  assert.ok(err.detail.allowed.includes('APPLIED') === false || err.detail.allowed.length > 0, 'the refusal lists the allowed moves');

  recs.markShown(id);
  recs.markDecision(id, 'accept', {});
  recs.markApplied(id, { price: 384, at: '2026-10-02T00:00:00Z' });
  assert.equal(recs.get(id).status, 'APPLIED');
  assert.equal(recs.get(id).observation.judgeAt, iso(new Date('2026-10-02T00:00:00Z').getTime() + 14 * DAY), 'judged on day 14');

  // nothing observed yet -> computeOutcome refuses, and markOutcome refuses too
  const thin = outcomes.computeOutcome({ recommendation: id });
  assert.equal(thin.insufficient, true, 'no verdict on a thin window');
  assert.throws(() => recs.markOutcome(id, { verdict: 'WIN', outcome: thin }), (e) => e.status === 409,
    'a verdict without evidence is refused');

  // rejected recommendations can never be a win
  const id2 = mkRec(384, 'reject-me');
  recs.markShown(id2);
  recs.markDecision(id2, 'reject', {});
  assert.equal(recs.get(id2).status, 'REJECTED');
  assert.equal(trust.evidenceFor({ sellerId: 'S-ramesh' }).some((r) => r.recommendation_id === id2), false,
    'a rejected card is not evidence');
});

/* ====================== 5. trust from valid outcomes only ================= */
test('autopilot is earned only by wins that beat a holdout, and never by a provisional one', () => {
  reset();
  const d = db.load();
  d.sellers['S-ramesh'].control[SKU] = 'au';       // the seller grants more than earned
  db.save();

  assert.equal(trust.autonomyFor('S-ramesh', SKU).effective, 'cp', 'grant cannot exceed entitlement');

  for (let i = 0; i < 4; i++) winRec(i, { deltaPct: 15, quality: true });
  let t = trust.computedTrust('S-ramesh');
  assert.equal(t.wins, 0, 'provisional wins (no holdout) never count');
  assert.equal(t.provisional_wins, 4);
  assert.equal(t.ladder.level, 'cp', 'Autopilot is still locked');

  // a quality-breaching win does not count either, even with a holdout present
  const e = openHoldoutExperiment();
  winRec(9, { deltaPct: 30, quality: false });
  assert.equal(trust.computedTrust('S-ramesh').wins, 0, 'quality breach is not a win');

  // now add holdout observations that cover the post-change period
  observeBothArms(e);
  t = trust.applyTrust('S-ramesh');
  assert.ok(t.wins >= 4, `four measured wins now count (got ${t.wins})`);
  assert.equal(t.trust ? t.trust.level : t.ladder.level, 'au', 'Autopilot is unlocked by measured wins and orders');
  assert.equal(trust.autonomyFor('S-ramesh', SKU).effective, 'au', 'and only then does the grant take effect');

  const bad = trust.evidenceFor({ sellerId: 'S-ramesh' }).find((r) => r.primary_delta_pct === 30);
  assert.equal(bad.counts_towards_autopilot, false, 'the quality-breaching row stays out');
});

/* ======================= 6. experiments + claimGuard ===================== */
test('experiments assign deterministically, refuse early claims and report honestly', () => {
  reset();
  const e = exps.create({ name: 'pilot', seller_id: 'S-ramesh', listing_id: LISTING }, {});
  const a1 = exps.assign(e.experiment_id, 'L-kurti');
  const a2 = exps.assign(e.experiment_id, 'L-kurti');
  assert.equal(a1.arm, a2.arm, 'assignment is deterministic');
  assert.equal(a1.bucket, a2.bucket);

  exps.start(e.experiment_id);
  const early = exps.generateClaim(e.experiment_id);
  assert.equal(early.allowed, false, 'no claim with no data');
  assert.equal(early.evidenceGate.enough, false);

  exps.observe(e.experiment_id, { arm: 'treatment', window: { from: '2026-09-01T00:00:00Z', to: '2026-09-08T00:00:00Z' }, metrics: { units: 6, keptOrders: 42, contribution: 4200 } });
  const oneArm = exps.generateClaim(e.experiment_id);
  assert.equal(oneArm.allowed, false, 'no claim with only one arm');

  observeBothArms(e.experiment_id);
  const imp = exps.impact(e.experiment_id);
  assert.equal(imp.enoughData, true);
  assert.ok(imp.arms.treatment.mean > imp.arms.holdout.mean, 'treatment is ahead on the primary metric');
  assert.ok(Array.isArray(imp.ci95) === false && typeof imp.ci95.low === 'number', 'an interval is reported');
  assert.match(imp.powerNote, /n ≈ 251/, 'the deck power note is carried through');

  const claim = exps.generateClaim(e.experiment_id);
  assert.equal(claim.allowed, true);
  assert.ok(claim.wordingIfAllowed.includes('contribution per kept order'));
  assert.equal(claim.evidence.enoughData, true);
});

/* ============================ 7. action queue ============================ */
test('the action queue needs approval or earned autonomy, and guardrails run at both ends', () => {
  reset();
  const id = mkRec(384);
  const created = actions.create({ recommendationId: id });
  const checked = actions.check(created.action.action_id);
  assert.equal(checked.status, 'PROPOSED', 'Co-Pilot: the seller decides');

  assert.throws(() => actions.execute(created.action.action_id), (e) => e.status === 409, 'cannot execute a proposal');
  assert.throws(() => actions.enqueue(created.action.action_id), (e) => e.status === 409, 'cannot queue a proposal');

  actions.approve(created.action.action_id, { by: 'seller:S-ramesh' });
  actions.enqueue(created.action.action_id);
  const done = actions.execute(created.action.action_id, { at: '2026-10-03T00:00:00Z' });
  assert.equal(done.status, 'VERIFIED', 'executed and verified against the store');
  assert.equal(db.listing(LISTING).price, 384);
  assert.equal(done.verification.observed, 384);
  assert.throws(() => actions.execute(created.action.action_id), (e) => e.status === 409, 'double execution refused');

  const rec = recs.get(id);
  assert.equal(rec.status, 'APPLIED', 'the recommendation follows the action');
  const entry = actions.audit({ actionId: created.action.action_id });
  assert.ok(entry.length >= 5, 'every transition is audited');
  assert.ok(db.events(80).some((ev) => ev.type === 'action.verified'), 'and mirrored into the event stream');
});

/* ===================== 8. idempotency + determinism ====================== */
test('the scheduler is deterministic and idempotent', () => {
  reset();
  const at = '2026-10-10T00:00:00Z';
  const r1 = recalc.runCycle({ at, kinds: ['cooldown', 'signals', 'observe', 'reconcile'] });
  const r2 = recalc.runCycle({ at, kinds: ['cooldown', 'signals', 'observe', 'reconcile'] });
  assert.deepEqual(r2.results.cooldown.detail, r1.results.cooldown.detail, 'same data + same instant -> same counters');
  assert.equal(r2.results.observe.judged, 0, 'nothing new to judge the second time');
  assert.equal(r2.changed, 0, 'the second run changes nothing');

  const dry = scheduler.runNow({ at: '2026-10-11T00:00:00Z', dryRun: true, kinds: ['cooldown'] });
  assert.equal(dry.dryRun, true);
  assert.equal(db.load().jobs.counters.cycles, 2, 'the dry run did not record itself');
  const future = scheduler.runNow({ at: Date.now() + 100 * 365 * DAY });
  assert.equal(future.ok, false, 'a run cannot be scheduled in the future');
  assert.match(future.errors[0].message, /future/, 'and it says why');
  assert.equal(db.load().jobs.counters.errors, 0, 'no errors recorded');
});

/* ========================= 9. version registry =========================== */
test('every recommendation, action and experiment carries the full version set', () => {
  reset();
  const id = mkRec(384);
  const rec = recs.get(id);
  for (const key of ['feature_version', 'demand_model_version', 'risk_model_version', 'lifecycle_model_version', 'guardrail_version', 'economics_version']) {
    assert.ok(rec.versions[key], `recommendation carries ${key}`);
  }
  const created = actions.create({ recommendationId: id });
  assert.ok(created.action.versions.guardrail_version);
  const e = exps.create({ name: 'v', seller_id: 'S-ramesh', listing_id: LISTING }, {});
  assert.ok(e.versions.experiment_version);
  const set = versions.versionSet();
  assert.equal(Object.keys(set).length, 11, '10 versions + stampedAt');
  const explained = versions.explainVersions(rec.versions);
  assert.ok(explained.every((v) => v.what && v.replaceWith !== undefined), 'each version says what it is and what replaces it');
});

/* ===================== 10. model interfaces (no fake ML) ================== */
test('the model interfaces are deterministic, documented and parity-safe', () => {
  reset();
  const view = db.hydrate(db.listing(LISTING));
  for (const name of Object.keys(models.INTERFACES)) {
    const out = models.call(name, { listingId: LISTING });
    assert.equal(out.model_interface || name, name);
    assert.ok(out.replaceWith && out.replaceWith.length > 20, `${name} documents its replacement point`);
    assert.equal(out.deterministic, true, `${name} claims to be a rule, and is`);
    const second = models.call(name, { listingId: LISTING });
    assert.deepEqual(sans(second.output), sans(out.output), `${name} is deterministic (apart from the card's creation stamp)`);
  }
  // parity: the interface output IS the engine output, not a re-implementation
  const viaInterface = models.recommendPrice(view, { mode: 'growth' }).output;
  const direct = recommend(view, { mode: 'growth' });
  assert.deepEqual(sans(viaInterface), sans(direct),
    'recommendPrice adds no drift over the parity-pinned engine');
  assert.match(models.MODEL_NOTES.claim, /No machine learning/);
});

/* ==========================================================================
   THE MOST IMPORTANT TEST: the loop closes.
   EVENTS -> FEATURES -> RECOMMENDATION -> DECISION -> ACTION -> OBSERVED
   OUTCOME -> EXPERIMENT -> MODEL UPDATE -> NEXT RECOMMENDATION
   ========================================================================== */
test('END TO END: observed events change the features and therefore the next recommendation', () => {
  reset();
  const day = (n) => new Date(Date.parse('2026-09-01T00:00:00Z') + n * DAY).toISOString();

  const before = db.hydrate(db.listing(LISTING)).signals;   // the seed assumption, before any observation

  /* 1. DATA: the seller's own trade lands in the event stream. */
  const ingest = events.ingestBatch([
    { event_type: 'VIEW_RECORDED', listing_id: LISTING, timestamp: day(1), source: 'seller_panel', payload: { views: 1400, clicks: 58 } },
    { event_type: 'ORDER_PLACED', listing_id: LISTING, timestamp: day(1), source: 'seller_panel', payload: { units: 1, orderValue: 369, paymentMode: 'prepaid' } },
  ], { sellerId: 'S-ramesh' });
  assert.equal(ingest.created, 2);

  /* 2. FEATURES: signals now come from what was observed, not from the seed. */
  const feat = recalc.signals({ at: day(2) });
  const after = db.hydrate(db.listing(LISTING)).signals;
  assert.notEqual(after.views, before.views, 'the observed window replaced the seed assumption');
  assert.ok(after.views > 0, `the feature the models read is now observed (${after.views} views)`);
  assert.equal(after.views, 1400, 'and it is exactly what the event stream carried');
  assert.equal(feat.updated, 0, 'the signals job is idempotent: nothing left to refresh at day 2');

  /* 3. RECOMMENDATION -> 4. DECISION -> 5. ACTION (the queue, guardrailed). */
  const rec = mkRec(384);
  const stepped = actions.step({ recommendationId: rec, at: day(2) });
  assert.equal(stepped.stoppedAt, 'PROPOSED', 'Co-Pilot proposes');
  actions.approve(stepped.action.action_id, { by: 'seller:S-ramesh', at: day(2) });
  actions.enqueue(stepped.action.action_id, { at: day(2) });
  const executed = actions.execute(stepped.action.action_id, { at: day(2) });
  assert.equal(executed.status, 'VERIFIED');
  assert.equal(db.listing(LISTING).price, 384, 'the price is live');

  /* 6. OBSERVED OUTCOME: 25 days of trade arrive as events (source: simulator). */
  const sim = outcomes.simulateEventStream({
    listingId: LISTING, from: day(3), days: 25, seed: 11, ordersPerDayMultiplier: 1.35,
  });
  assert.ok(sim.pushed.created > 500, 'a real event volume arrived');

  const judged = recalc.observe({ at: day(29) });
  assert.equal(judged.judged, 1, 'exactly one recommendation was judged');
  const recAfter = recs.get(rec);
  assert.ok(['WON', 'NEUTRAL', 'LOST'].includes(recAfter.status), `a verdict was reached (${recAfter.status})`);
  assert.equal(recAfter.outcome.insufficient, false, 'the verdict had evidence behind it');
  assert.equal(recAfter.outcome.primary.metric, 'contribution_per_kept_order', 'the primary metric is economics, not revenue');
  const out = outcomes.outcomes({ listingId: LISTING });
  assert.equal(out.length, 1, 'the outcome is stored');
  assert.ok(out[0].window.days >= 7, 'the window is long enough to mean something');

  /* 7. EXPERIMENT: measurement against a holdout, with an honest claim gate. */
  const e = exps.create({ name: 'kurti step-up', seller_id: 'S-ramesh', listing_id: LISTING, intervention: { kind: 'price_change', description: 'step up 4.9%' } }, {});
  exps.start(e.experiment_id);
  exps.observe(e.experiment_id, { arm: 'treatment', window: { from: day(4), to: day(18) }, metrics: { units: 8, keptOrders: 52, contribution: 5200, cvrPct: 3.4 } });
  exps.observe(e.experiment_id, { arm: 'treatment', window: { from: day(18), to: day(28) }, metrics: { units: 8, keptOrders: 50, contribution: 4900, cvrPct: 3.3 } });
  exps.observe(e.experiment_id, { arm: 'holdout', window: { from: day(4), to: day(18) }, metrics: { units: 8, keptOrders: 44, contribution: 3696, cvrPct: 3.2 } });
  exps.observe(e.experiment_id, { arm: 'holdout', window: { from: day(18), to: day(28) }, metrics: { units: 8, keptOrders: 43, contribution: 3612, cvrPct: 3.2 } });
  const claim = exps.generateClaim(e.experiment_id);
  assert.equal(claim.allowed, true, 'with both arms measured, a claim is allowed');
  assert.ok(claim.evidence.treatment.observations >= 2 && claim.evidence.holdout.observations >= 2);

  /* 8. MODEL UPDATE: trust recomputed from the valid outcome, then the NEXT card. */
  const t = trust.applyTrust('S-ramesh');
  assert.ok(t.wins >= 1, 'the measured win is banked');
  assert.match(t.ladder.next, /weeks|Co-Pilot|Autopilot/);

  // the scheduler drives the final step: cooldown counters, signals, and a cycle record
  const cycle = scheduler.runNow({ at: day(40), kinds: ['cooldown', 'signals', 'observe', 'reconcile'] });
  assert.equal(cycle.ok, true, 'the scheduled cycle ran cleanly');
  const nextView = db.hydrate(db.listing(LISTING));
  const nextRec = recs.generate({
    cardId: 'next', kind: 'price_up', from: nextView.price, to: nextView.price,
    headline: 'next card', what: 'follow-up after the measured window',
  }, { listingId: LISTING, listing: nextView, mode: 'growth', force: true });

  assert.equal(nextRec.recommendation.recommendation_id !== rec, true, 'a NEW recommendation exists');
  assert.equal(nextRec.recommendation.price_before, 384, 'it prices from the LIVE price the loop produced');
  assert.ok(nextRec.recommendation.versions.feature_version, 'and carries the version set');

  const explain = recs.explain(rec);
  assert.ok(explain, 'the judged recommendation can still explain itself');

  /* The decisive check: the observed trade is visible in the features that the
     next recommendation is built from. That is the loop actually closing. */
  const observed = db.listing(LISTING).observed || {};
  assert.ok(observed.views > 0, 'observed views are recorded on the listing');
  assert.equal(nextView.signals.views, observed.views, 'the next decision reads the observed views, not the seed');
  assert.ok(nextView.signals.keptRatePct != null, 'and a kept rate derived from real returns');
  assert.ok(db.load().jobs.counters.cycles >= 1, 'the scheduler recorded the cycle that did it');

  /* The audit trail holds the whole story, in order.
     Note: the engine's in-memory event ring is capped (1500 entries) and the
     simulator pushed ~1,900 events, so the action steps are asserted from the
     closed-loop audit record (which is the durable trail), not from the ring. */
  const recent = db.events(1500).map((ev) => ev.type);
  assert.ok(recent.includes('observation.judged'), 'the judgement is in the event stream');
  assert.ok(recent.includes('outcome.recorded'), 'the outcome is in the event stream');

  const trail = actions.get(stepped.action.action_id).history.map((h) => h.to);   // ascending
  assert.ok(actions.audit({ actionId: stepped.action.action_id }).length >= 5, 'the audit endpoint has the same story');
  for (const step of ['CHECKED', 'PROPOSED', 'APPROVED', 'QUEUED', 'EXECUTED', 'VERIFIED']) {
    assert.ok(trail.includes(step), `the action trail contains ${step} (got ${trail.join(' > ')})`);
  }
  const order = (t) => trail.indexOf(t);
  assert.ok(order('CHECKED') < order('APPROVED') && order('APPROVED') < order('EXECUTED') && order('EXECUTED') < order('VERIFIED'),
    'the queue ran in order: guardrails -> approval -> execution -> verification');
  const recHistory = recs.get(rec).history.map((h) => h.to);
  assert.ok(recHistory[0] === 'GENERATED' && recHistory.includes('APPLIED'), `the recommendation history is complete (${recHistory.join(' > ')})`);
});

/** Strip volatile stamps so a determinism comparison compares the decision, not the clock. */
function sans(x) {
  const clone = JSON.parse(JSON.stringify(x ?? null));
  const drop = (o) => {
    if (!o || typeof o !== 'object') return o;
    for (const k of Object.keys(o)) {
      if (k === 'createdAt' || k === 'generatedAt' || k === 'stampedAt' || k === 'checkedAt' || k === 'updatedAt') delete o[k];
      else drop(o[k]);
    }
    return o;
  };
  return drop(clone);
}

/* ------------------------------- helpers -------------------------------- */
let recCounter = 0;
function mkRec(to, tag = 'gen') {
  recCounter++;
  const price = db.listing(LISTING).price;
  const { recommendation } = recs.generate({
    cardId: `C-${tag}-${recCounter}`, kind: to > price ? 'price_up' : 'price_down',
    from: price, to, headline: `${tag} card`, what: 'test card',
  }, { listingId: LISTING, mode: 'growth', force: true });
  return recommendation.recommendation_id;
}

function winRec(i, { deltaPct = 12, quality = true } = {}) {
  const id = mkRec(db.listing(LISTING).price, `w${i}`);
  recs.markShown(id);
  recs.markDecision(id, 'accept', {});
  recs.markApplied(id, { price: db.listing(LISTING).price, by: 'seller', at: `2026-09-0${(i % 9) + 1}T00:00:00Z` });
  recs.addSample(id, { at: `2026-09-1${i % 9}T00:00:00Z` });
  recs.markOutcome(id, {
    verdict: 'WIN',
    outcome: {
      insufficient: false, verdict: 'WIN',
      quality: { pass: quality, breached: quality ? [] : ['returns'] },
      primary: { metric: 'contribution_per_kept_order', deltaPct },
      window: { days: 14 },
    },
  });
  return id;
}

function openHoldoutExperiment() {
  const e = exps.create({ name: 'holdout', seller_id: 'S-ramesh', listing_id: LISTING }, {});
  exps.start(e.experiment_id);
  return e.experiment_id;
}

function observeBothArms(experimentId) {
  exps.observe(experimentId, { arm: 'treatment', window: { from: '2026-09-01T00:00:00Z', to: '2026-09-08T00:00:00Z' }, metrics: { units: 5, keptOrders: 44, contribution: 4840 } });
  exps.observe(experimentId, { arm: 'treatment', window: { from: '2026-09-08T00:00:00Z', to: '2026-09-15T00:00:00Z' }, metrics: { units: 5, keptOrders: 46, contribution: 5060 } });
  exps.observe(experimentId, { arm: 'holdout', window: { from: '2026-09-01T00:00:00Z', to: '2026-09-08T00:00:00Z' }, metrics: { units: 5, keptOrders: 38, contribution: 3192 } });
  exps.observe(experimentId, { arm: 'holdout', window: { from: '2026-09-08T00:00:00Z', to: '2026-09-15T00:00:00Z' }, metrics: { units: 5, keptOrders: 37, contribution: 3108 } });
}
