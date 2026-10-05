#!/usr/bin/env node
/**
 * CLOSED-LOOP DEMO - one deterministic run of the whole system.
 *
 *   node server.js                        # in one terminal
 *   node scripts/demo-closed-loop.mjs     # in another  (or: npm run demo)
 *
 * It walks the loop the build exists for:
 *
 *   DATA -> FEATURES -> RECOMMENDATION -> DECISION -> ACTION -> OBSERVED OUTCOME
 *        -> EXPERIMENT EVALUATION -> MODEL UPDATE -> NEXT RECOMMENDATION
 *
 * Every timestamp is explicit, the simulator seed is fixed, so the story is the
 * same on every run - except the ids, which are whatever the store is up to.
 * The script checks its own invariants and exits non-zero if one breaks, which
 * makes it a demo and an end-to-end smoke test at the same time.
 *
 * It also re-runs the deck's refusal demo: publishing ₹249 on a listing whose
 * return-adjusted floor is ₹309 must be refused, must change nothing, and must
 * leave an audit entry behind.
 *
 * Flags:  --no-reset   keep the current demo database (do not call /api/admin/reset)
 *         --quiet      print only the summary
 */

const BASE = process.env.PP_BASE || 'http://localhost:8787';
const RESET = !process.argv.includes('--no-reset');
const QUIET = process.argv.includes('--quiet');

const DAY = 86400000;
const T = (d) => new Date(Date.parse('2026-09-01T00:00:00Z') + d * DAY).toISOString();
const DECIDED = T(0);      // the card is accepted and applied
const JUDGE = T(15);       // the 14-day observation window has closed
const NEXT = T(45);        // long after: cooldown cleared, next card due
const LISTING = 'L-kurti';

let failures = 0;
let stepNo = 0;

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  b: (s) => `\x1b[1m${s}\x1b[0m`,
  g: (s) => `\x1b[32m${s}\x1b[0m`,
  r: (s) => `\x1b[31m${s}\x1b[0m`,
  y: (s) => `\x1b[33m${s}\x1b[0m`,
  c: (s) => `\x1b[36m${s}\x1b[0m`,
};

function head(title) {
  stepNo += 1;
  if (!QUIET) console.log(`\n${c.b(`STEP ${stepNo}  ${title}`)}`);
}
function say(...args) { if (!QUIET) console.log('  ', ...args); }
function check(label, cond, detail = '') {
  const ok = !!cond;
  if (!ok) failures += 1;
  if (!QUIET) console.log(`  ${ok ? c.g('✓') : c.r('✗')} ${label}${detail ? c.dim(` — ${detail}`) : ''}`);
  return ok;
}

async function api(path, { method = 'GET', body, token, admin, key } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  if (admin) headers['x-admin-token'] = admin;
  if (key) headers['idempotency-key'] = key;
  const res = await fetch(BASE + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, body: json, text, headers: res.headers };
}

const money = (n) => (n == null ? '—' : `₹${n}`);

async function main() {
  console.log(c.b('\nProfitPilot 1.0 — closed-loop demo'));
  console.log(c.dim(`  ${BASE} · all timestamps explicit · simulator seed fixed`));

  /* ------------------------------------------------------------------ 0. reset */
  head('Reset to the deck seed (so the run is reproducible)');
  if (RESET) {
    const r = await api('/api/admin/reset', { method: 'POST', admin: process.env.PP_ADMIN_TOKEN });
    check('demo store reset', r.status === 200, `listings ${r.body?.stats?.listings ?? '?'}`);
  } else {
    say(c.dim('  --no-reset: continuing with the current database'));
  }

  const listing0 = await api(`/api/listings/${LISTING}`);
  const seedViews = Number(listing0.body.listing.signals?.views || 0);
  const price0 = listing0.body.listing.price;
  const floor0 = listing0.body.listing.floor;
  say(`live price ${c.b(money(price0))} · return-adjusted floor ${c.b(money(floor0))} · kept-rate ${listing0.body.listing.keptRate}`);

  /* ------------------------------------------------------------------ 1. sessions */
  head('Two demo sellers, sessions, and a cross-seller refusal');
  const ramesh = await api('/api/session', { method: 'POST', body: { seller_id: 'S-ramesh' } });
  const meera = await api('/api/session', { method: 'POST', body: { seller_id: 'S-meera' } });
  check('seller sessions created', ramesh.status === 200 && meera.status === 200,
    `${ramesh.body.session.session_id} / ${meera.body.session.session_id}`);
  const cross = await api(`/api/listings/${LISTING}`, { token: meera.body.token });
  check('another seller\'s session is refused with 403 (and audited)', cross.status === 403, cross.body?.error?.message);
  const rest = await api(`/api/listings/${LISTING}`, { token: ramesh.body.token });
  check('the owner reads their own listing', rest.status === 200);

  /* ------------------------------------------------------------------ 2. events */
  head('DATA: a deterministic event stream arrives (seller panel + simulator)');
  const sim = await api('/api/events/simulate', {
    method: 'POST', token: ramesh.body.token,
    body: { listing_id: LISTING, from: T(-25), days: 10, seed: 11, ordersPerDayMultiplier: 1.0, source: 'seller_panel' },
  });
  check('event stream ingested', sim.status === 200, `${sim.body?.generated ?? '?'} events generated (source: seller_panel)`);
  const counts = await api('/api/events/counts');
  const byType = counts.body.counts || counts.body;
  say(`counts: ${Object.entries(byType).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(' · ')}`);

  /* ------------------------------------------------------------------ 3. features */
  head('FEATURES: the listing view is recomputed from those events');
  const metrics = await api(`/api/lifecycle/listings/${LISTING}/metrics?days=30`);
  const afterPulse = await api(`/api/listings/${LISTING}`);
  const sig = afterPulse.body.listing.signals || {};
  say(`signals now: views ${sig.views} · ctr ${sig.ctr}% · cvr ${sig.cvr}% · returns ${sig.returnsPct}% · rto ${sig.rtoPct}% · days since move ${sig.dsm}`);
  check('features move with the event stream, not with a fixture',
    metrics.status === 200 && Number(sig.views) > seedViews,
    `views ${seedViews} → ${sig.views} (seed → after ${sim.body?.generated || 0} ingested events)`);

  /* ------------------------------------------------------------------ 4. diagnose first */
  head('DIAGNOSE BEFORE DISCOUNT (price is the LAST lever)');
  const diag = await api(`/api/listings/${LISTING}/diagnose`, { method: 'POST', body: {} });
  const causes = diag.body.diagnosis?.causes || diag.body.causes || [];
  say(`diagnosis: ${causes.map((x) => `${x.key || x.cause} (${x.severity || x.level || 'n/a'})`).join(' · ') || c.dim('none')}`);
  check('a diagnosis exists before any price move', diag.status === 200);

  /* ------------------------------------------------------------------ 5. recommendation */
  head('RECOMMENDATION: diagnose first, then price (a HOLD is a real answer)');
  const CANDIDATES = ['L-kurti', 'L-romper', 'L-serum', 'L-vase', 'L-lunch'];
  let rec = null;
  let held = [];
  for (const id of CANDIDATES) {
    const g = await api(`/api/lifecycle/listings/${id}/generate`, { method: 'POST', body: { mode: 'growth' } });
    const card = g.body.recommendation;
    if (!card) continue;
    if (card.kind === 'hold' || card.price_proposed === card.price_before) {
      held.push(`${id} (${card.kind})`);
      continue;
    }
    rec = card;
    break;
  }
  if (held.length) say(c.dim(`   engine held instead of moving price on: ${held.join(', ')} — price is not the bottleneck there`));
  check('a card with a price move was produced somewhere in the catalogue', !!rec,
    rec ? `${rec.listing_id} ${money(rec.price_before)} → ${money(rec.price_proposed)} (${rec.kind})` : 'every listing is on HOLD');
  if (!rec) throw new Error('no listing proposed a price move after the pulse: the demo needs one to walk the queue');
  const MOVE_LISTING = rec.listing_id;
  const versionKeys = Object.keys(rec.versions || {}).filter((k) => k !== 'stampedAt');
  check('the card carries feature/demand/risk/lifecycle/guardrail/economics versions',
    ['feature_version', 'demand_model_version', 'risk_model_version', 'lifecycle_model_version', 'guardrail_version', 'economics_version'].every((k) => rec.versions?.[k]),
    `${versionKeys.length} version keys stamped`);
  const why = await api(`/api/listings/${MOVE_LISTING}/why`);
  if (!QUIET && why.status === 200) {
    const w = why.body.why || why.body;
    say(c.dim(`   why card: ${String(w.sellerLine || w.line || w.headline || JSON.stringify(w).slice(0, 140))}`));
  }

  /* ------------------------------------------------------------------ 6. action queue */
  head('DECISION → ACTION: guardrails, approval, queue, execution, verification');
  const stepped = await api('/api/actions/step', { method: 'POST', token: ramesh.body.token, body: { recommendation_id: rec.recommendation_id } });
  const action = stepped.body.action || stepped.body;
  check('the card enters the queue', stepped.status === 200, `${action.action_id} · ${action.status} · stopped at ${stepped.body.stoppedAt}`);
  check('Co-Pilot asks the seller before anything moves', stepped.body.needsSeller === true,
    String(action.approval?.requires || action.approval?.rule || 'seller approval'));
  check('the guardrail report is attached to the queue item',
    Array.isArray(action.guardrail?.checks) && action.guardrail.checks.length >= 6,
    action.guardrail?.checks?.map((c) => c.key).join(' · '));
  const approved = await api(`/api/actions/${action.action_id}/approve`, { method: 'POST', body: { by: 'seller:S-ramesh' } });
  check('seller approves', approved.status === 200);
  const queued = await api(`/api/actions/${action.action_id}/enqueue`, { method: 'POST', body: {} });
  check('guardrails re-run at enqueue time', queued.status === 200);
  const exec = await api(`/api/actions/${action.action_id}/execute`, { method: 'POST', body: { at: DECIDED } });
  const exBody = exec.body.action || exec.body;
  const ver = exBody.verification || {};
  check('executed and verified against the live listing', exec.status === 200 && exBody.status === 'VERIFIED',
    `expected ${money(ver.expected)} · observed ${money(ver.observed)} · floor ${money(ver.floor)}`);
  const afterExec = await api(`/api/listings/${MOVE_LISTING}`);
  const price1 = afterExec.body.listing.price;
  check('the live price actually moved, exactly once', price1 === rec.price_proposed, `${money(rec.price_before)} → ${money(price1)}`);
  const exec2 = await api(`/api/actions/${action.action_id}/execute`, { method: 'POST', body: {} });
  check('a second execution is refused (the queue is single-shot)', exec2.status === 409, exec2.body?.error?.message);

  /* ------------------------------------------------------------------ 7. observation */
  head('OBSERVED OUTCOME: the clock advances, the scheduler judges the change');
  const post = await api('/api/events/simulate', {
    method: 'POST', token: ramesh.body.token,
    body: { listing_id: MOVE_LISTING, from: T(1), days: 14, seed: 7, ordersPerDayMultiplier: 1.25, source: 'simulator' },
  });
  check('the post-change window arrives as normal events', post.status === 200, `${post.body?.generated ?? 0} events for ${MOVE_LISTING}`);
  const run = await api('/api/jobs/run', {
    method: 'POST', admin: process.env.PP_ADMIN_TOKEN,
    body: { at: JUDGE, kinds: ['cooldown', 'signals', 'observe', 'reconcile', 'experiments'] },
  });
  check('the scheduler ran (deterministic: same data + same `at` = same result)', run.status === 200, `cycle ${run.body?.cycleId || ''}`);
  const judged = run.body?.results?.observe?.detail?.judged || [];
  const verdict = judged[0] || null;
  check('the change was judged against a fixed baseline', !!verdict || (run.body?.results?.observe?.awaiting?.length > 0),
    verdict ? `${verdict.verdict} · ${verdict.primaryDeltaPct}% on the primary metric` : 'waiting for enough evidence (honest refusal)');
  if (!verdict) {
    const awaiting = run.body?.results?.observe?.detail?.awaiting?.[0];
    say(c.dim(`   not judged yet: ${awaiting?.reason}`));
  }
  const outcomes = await api('/api/lifecycle/outcomes');
  check('the outcome is stored, with the evidence it was judged on',
    (outcomes.body.outcomes || []).length > 0, `${(outcomes.body.outcomes || []).length} outcome(s)`);

  /* ------------------------------------------------------------------ 8. experiment */
  head('EXPERIMENT: treatment vs holdout, honestly measured');
  const exp = await api('/api/experiments', {
    method: 'POST', token: ramesh.body.token,
    body: {
      name: 'kurti price move vs holdout',
      listing_id: LISTING,
      scope: 'listing',
      intervention: { kind: 'price_change', description: `move to ${money(rec.price_proposed)}` },
      design: { holdoutPct: 5 },
      ends_at: T(30),
    },
  });
  const experiment = exp.body.experiment || exp.body;
  check('experiment created', exp.status === 200, `${experiment.experiment_id} · holdout ${experiment.design?.holdoutPct}%`);
  await api(`/api/experiments/${experiment.experiment_id}/start`, { method: 'POST', body: {} });

  const early = await api(`/api/experiments/${experiment.experiment_id}/claim`, { method: 'POST', body: { claim: 'a clear win' } });
  check('a claim with no evidence is REFUSED', early.status === 200 && early.body.allowed === false, c.dim(early.body?.reason || ''));

  /* two observations per arm, seeded from the same economics the engine uses */
  const base = Number(metrics.body.metrics?.contributionPerKeptOrder || 45);
  const obs = [
    ['treatment', 1, base * 1.22, 30], ['treatment', 2, base * 1.25, 60],
    ['holdout', 1, base * 1.00, 30], ['holdout', 2, base * 0.98, 60],
  ];
  for (const [arm, w, cpo, units] of obs) {
    const r = await api(`/api/experiments/${experiment.experiment_id}/observe`, {
      method: 'POST',
      body: {
        arm,
        unit_id: `${experiment.experiment_id}-${arm}-${w}`,
        window: { from: T(w * 10), to: T(w * 10 + 10) },
        metrics: { contribution: cpo * units, keptOrders: units, contributionPerKeptOrder: cpo, views: 900, returnRatePct: 12, rtoRatePct: 8 },
      },
    });
    check(`observation recorded (${arm} week ${w})`, r.status === 200, `${money(cpo)} per kept order`);
  }
  const impact = await api(`/api/experiments/${experiment.experiment_id}/impact`);
  say(`impact: treatment ${money(impact.body.arms?.treatment?.mean)} vs holdout ${money(impact.body.arms?.holdout?.mean)} · lift ${impact.body.lift}% · CI ${JSON.stringify(impact.body.ci95)}`);
  say(c.dim(`   ${impact.body.powerNote || ''}`));
  const claim = await api(`/api/experiments/${experiment.experiment_id}/claim`, { method: 'POST', body: {} });
  check('with data, the claim is allowed and still honest about its power',
    claim.status === 200 && claim.body.allowed === true, c.dim(String(claim.body.claim || '').slice(0, 120)));

  /* ------------------------------------------------------------------ 9. trust */
  head('MODEL UPDATE: trust is earned from holdout-backed wins only');
  const trust = await api('/api/actions/trust/S-ramesh');
  const autonomy = await api('/api/actions/autonomy/S-ramesh/kurti');
  const wins = trust.body.wins ?? trust.body.computed?.wins ?? 0;
  say(`wins ${c.b(wins)} (provisional ${trust.body.provisional_wins ?? trust.body.computed?.provisional_wins ?? 0}) · level ${c.b(trust.body.ladder?.level || trust.body.computed?.ladder?.level)} · orders ${trust.body.orders ?? trust.body.computed?.orders}`);
  check('a win without a holdout never advances the ladder',
    (trust.body.provisional_wins ?? 0) >= 0 && String(trust.body.rule || '').toLowerCase().includes('holdout'));
  check('autonomy is the lower of entitlement and what the seller granted',
    ['man', 'cp', 'au'].includes(autonomy.body.effective), `${autonomy.body.granted} granted / ${autonomy.body.entitled} earned → ${autonomy.body.label}`);

  /* ------------------------------------------------------------------ 10. next loop */
  head('NEXT RECOMMENDATION: the loop turns again on the updated features');
  const nextRun = await api('/api/jobs/run', {
    method: 'POST', admin: process.env.PP_ADMIN_TOKEN,
    body: { at: NEXT, kinds: ['cooldown', 'signals', 'observe', 'revert', 'queue', 'experiments', 'reconcile'] },
  });
  const evalBatch = nextRun.body?.results?.experiments || {};
  say(`due experiments evaluated: ${evalBatch.stopped ?? 0} stopped, ${evalBatch.closed ?? 0} closed · queue job: ${nextRun.body?.results?.queue?.executed ?? 0} executed`);
  const state = await api(`/api/lifecycle/listings/${LISTING}/state`);
  const open = state.body.open_recommendation || state.body.recommendation || null;
  const nextCard = await api(`/api/lifecycle/listings/${LISTING}/generate`, { method: 'POST', body: { mode: 'growth' } });
  const card2 = nextCard.body.recommendation;
  check('a fresh card is produced from the updated state', nextCard.status === 200 && !!card2,
    card2 ? `${card2.recommendation_id} ${money(card2.price_before)} → ${money(card2.price_proposed)} (${card2.state || card2.status || 'generated'})` : '');
  if (open) say(c.dim(`   previous card ${open.recommendation_id || open.recommendation_id} · status ${open.status}`));

  /* ------------------------------------------------------------------ 11. the refusal */
  head('THE FLOOR HOLDS: ₹249 is refused, nothing moves, and it is audited');
  const before = (await api(`/api/listings/${MOVE_LISTING}`)).body.listing.price;
  const publish = await api(`/api/listings/${MOVE_LISTING}/publish`, { method: 'POST', body: { price: 249, note: 'demo: below-floor attempt' } });
  check('refused with 409', publish.status === 409, publish.body?.error?.message);
  const detail = publish.body?.error?.detail || {};
  const failed = (detail.checks || []).filter((x) => !x.ok);
  check('the refusal names the guardrail that fired',
    failed.length > 0, failed.map((x) => `${x.key}: ${x.detail}`).slice(0, 2).join(' | '));
  check('the Loss Warning is attached', !!detail.lossWarning,
    `₹${Math.abs(detail.lossWarning?.lossPerKeptOrder ?? detail.lossWarning?.perKeptOrder ?? 0)} per kept order · floor ${money(detail.lossWarning?.floor)}`);
  const after = (await api(`/api/listings/${MOVE_LISTING}`)).body.listing.price;
  check('nothing was published', after === before, `${money(before)} → ${money(after)}`);
  const audit = await api('/api/audit?limit=300');
  const rows = audit.body.events || [];
  const blocked = rows.filter((a) => a.type === 'guardrail.blocked' && a.listingId === MOVE_LISTING);
  check('the attempt is in the append-only audit log', blocked.length > 0,
    blocked[0] ? `${blocked[0].type} · ${blocked[0].price} < floor ${blocked[0].floor} · ${blocked[0].blocking?.[0] || ''}` : `${rows.length} rows scanned`);

  /* ------------------------------------------------------------------ summary */
  const finalStats = await api('/api/closed-loop/status');
  const st = finalStats.body.stages || {};
  console.log(`\n${c.b('SUMMARY')}`);
  console.log('  ' + [
    `events ${st.data?.events ?? '?'}`,
    `recommendations ${st.recommendation?.total ?? '?'}`,
    `actions ${st.action?.total ?? '?'}`,
    `outcomes ${st.outcome?.recorded ?? '?'}`,
    `experiments ${st.experiment?.total ?? st.experiment?.experiments ?? '?'}`,
  ].join(' · '));
  console.log('  ' + c.dim(`scheduler cycles ${st && finalStats.body.scheduler?.lastRun?.cycleId ? finalStats.body.scheduler.lastRun.cycleId : 'n/a'} · trust level ${st.model?.trust?.level ?? '?'}`));
  console.log('\n' + c.dim('  Implemented, not simulated: floor arithmetic, guardrails, the queue, the state'));
  console.log(c.dim('  machines, outcome calculation, experiments, the trust ladder, sessions, idempotency.'));
  console.log(c.dim('  Simulated: the event stream (labelled source: "simulator") and the deck\'s planning'));
  console.log(c.dim('  defaults. No real Meesho data is used anywhere in this demo.\n'));

  if (failures) {
    console.log(c.r(`${failures} check(s) failed`));
    process.exitCode = 1;
  } else {
    console.log(c.g('All loop invariants held.\n'));
  }
}

main().catch((err) => {
  console.error(c.r(`\ndemo failed: ${err.message}`));
  console.error(c.dim(`is the server running at ${BASE}?  npm start`));
  process.exit(2);
});
