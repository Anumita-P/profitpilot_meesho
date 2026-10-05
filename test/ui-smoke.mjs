/**
 * UI SMOKE TEST (optional) - boots the real page in a headless DOM, talks to a
 * live backend and checks the bridge end to end: badge, floor, recommendation,
 * decision round-trip, and every screen rendering without a JS error.
 *
 *   node server.js &                       # backend on :8787
 *   npm i --no-save jsdom                  # or: NODE_PATH=/path/to/jsdom
 *   node test/ui-smoke.mjs
 *
 * If jsdom is not installed the test skips (exit 0) instead of failing: it is a
 * development check, not part of `npm test`.
 */

const BASE = process.env.PP_BASE || 'http://localhost:8787';
let JSDOM;
try {
  ({ JSDOM } = await import('jsdom'));
} catch {
  console.log('SKIP: jsdom is not installed (npm i --no-save jsdom)');
  process.exit(0);
}

const health = await fetch(BASE + '/api/health').then((r) => r.ok).catch(() => false);
if (!health) {
  console.log(`SKIP: no backend on ${BASE} (start it with: npm start)`);
  process.exit(0);
}

// start from a clean demo state, and leave it clean: this test accepts a card,
// undoes it, and tries to publish below the floor.
await fetch(BASE + '/api/admin/reset', { method: 'POST' }).catch(() => {});

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} - ${name}${detail ? ' :: ' + detail : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dom = await JSDOM.fromURL(BASE + '/', {
  runScripts: 'dangerously',
  resources: 'usable',
  pretendToBeVisual: true,
  beforeParse(window) {
    window.fetch = (url, opts) => fetch(new URL(url, BASE).toString(), opts);
    window.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 16);
    window.scrollTo = () => {};
  },
});

const { window } = dom;
const $ = (sel) => window.document.querySelector(sel);
const ev = (code) => window.eval(code);

try {
  // wait for the bridge to boot and fetch /api/bootstrap
  for (let i = 0; i < 60 && !ev('window.PPAPI && PPAPI.state().api.booted'); i++) await sleep(100);

  check('the bridge boots', ev('!!window.PPAPI'));
  check('the page is online', ev('PPAPI.state().api.online') === true, ev('String(PPAPI.state().api.server && PPAPI.state().api.server.name)'));
  check('the badge is injected', !!$('#ppBadge'), $('#ppBadge')?.textContent?.trim());
  check('badge says it is on the backend', /engine server|backend|connected/i.test($('#ppBadge')?.textContent || ''));

  check('the floor comes from the server', ev('FL("kurti").F') === 309 && ev('!!FL("kurti").server'));
  check('all five floors match the deck',
    JSON.stringify(ev('SKIDS.map(function(k){return FL(k).F})')) === JSON.stringify([309, 346, 166, 266, 367]),
    JSON.stringify(ev('SKIDS.map(function(k){return FL(k).F})')));

  check('recommendation is the server\'s', ev('recFor("kurti").from') === 369 && ev('recFor("kurti").to') === 384,
    `${ev('recFor("kurti").from')} -> ${ev('recFor("kurti").to')}`);
  check('recommendation carries the Why blocks',
    ['what', 'why', 'eff', 'conf', 'confWhy', 'undo'].every((k) => ev(`!!recFor("kurti").${k}`)));
  check('recommendation carries pre-flight checks', ev('(recFor("kurti").pf||[]).length') === 6);
  check('recommendation carries the logic tree', ev('(recFor("kurti").logic||{}).n')?.length >= 3);

  let apiHtml = '';
  for (const view of ['home', 'first-price', 'modes', 'simulator', 'diagnose', 'lifecycle', 'coach', 'engine', 'pilot', 'v2', 'api', 'about']) {
    let error = null;
    try { ev(`go('${view}')`); } catch (e) { error = e.message; }
    await sleep(40);
    const html = $('#view')?.innerHTML || '';
    if (view === 'api') apiHtml = html;
    check(`view renders: ${view}`, !error && html.length > 500, error || `${html.length} chars`);
  }

  check('the Backend screen lists the API', /\/api\/listings\/:id\/lifecycle/.test(apiHtml));
  check('the Backend screen shows the audit trail', /Audit trail|audit/i.test(apiHtml));
  check('the Backend screen shows live KPIs', /Orders \/ day|orders \/ day/i.test(apiHtml));

  ev("go('diagnose')");
  await sleep(4000);                       // the node scan animates for ~3 s
  const diagHtml = $('#view')?.innerHTML || '';
  check('diagnose shows the server scan (not the loader)', /SERVER SCAN/.test(diagHtml) && !/Running the 8-node scan/.test(diagHtml));
  // the kurti's funnel is healthy, so the scan says so instead of inventing a fix
  check('the server scan gives a verdict and either a fix or an all-clear',
    /Fix the largest|No branch fires/.test(diagHtml), /Fix the largest/.test(diagHtml) ? 'fix named' : 'all-clear');

  ev("go('lifecycle')");
  await sleep(1200);
  const lcHtml = $('#view')?.innerHTML || '';
  check('lifecycle uses the server model', /SERVER/.test(lcHtml));
  check('the server lifecycle box carries the ladder and the rival test', /Rival test from the server/.test(lcHtml));

  ev("go('engine')");
  await sleep(1500);
  check('the engine lab renders the server bandit box (not the loader)',
    /Server bandit/.test($('#view')?.innerHTML || '') && !/Loading the server bandit state/.test($('#view')?.innerHTML || ''));
  await sleep(200);
  let engineErr = null;
  try { ev('enReset(); enStep(6)'); } catch (e) { engineErr = e.message; }
  await sleep(1500);
  check('the engine lab runs the server bandit', !engineErr, engineErr || '');
  check('the bandit snapshot is cached', !!ev('PPAPI.state().srv.bandit.kurti'));
  check('the bandit put real traffic through the holdout', ev('PPAPI.state().srv.bandit.kurti.holdout.impressions') > 0,
    String(ev('PPAPI.state().srv.bandit.kurti.holdout.impressions')));
  check('below-floor arms were never pulled', ev('PPAPI.state().srv.bandit.kurti.arms.filter(function(a){return a.blockedBelowFloor}).every(function(a){return a.pulls===0})'));

  ev("go('coach')");
  ev('cAns("returns")');            // fires the server question
  await sleep(1200);
  let coachErr = null, coachHtml = '';
  try { coachHtml = String(ev('cAns("returns")')); } catch (e) { coachErr = e.message; }
  check('the coach answers from the server', !coachErr && /SERVER/.test(coachHtml), coachErr || `${coachHtml.length} chars`);
  check('the coach answer carries a source and a confidence', /Source|confidence/i.test(coachHtml));
  const freeText = await fetch(BASE + '/api/coach/ask', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: 'Returns kyun aa rahe hain?', listing: 'L-kurti', lang: 'hi' }),
  }).then((r) => r.json());
  check('the endpoint answers a Hindi free-text question', freeText.answer && freeText.matchedIntent === 'returns', freeText.matchedIntent);
  check('the endpoint never claims a money action happened', freeText.moneyActionsRequireTap === true);

  // decision round-trip: accept the growth card, the server must move the price
  ev("go('home')");
  await sleep(200);
  const before = ev('live("kurti")');
  const key = ev('recFor("kurti").key');
  ev(`decide(${JSON.stringify(key)}, 'y', 'kurti')`);
  await sleep(1200);
  const after = ev('live("kurti")');
  check('accepting the card moves the live price on the server', after !== before, `${before} -> ${after}`);
  check('the decision id is remembered for undo', !!ev('Object.keys(PPAPI.state().srv.decisions).length'));
  const audit = await fetch(BASE + '/api/audit').then((r) => r.json());
  check('the audit log has the decision', (audit.events || []).some((e) => e.type === 'decision.accepted'), (audit.events || []).length + ' events');

  ev(`undoDec(${JSON.stringify(key)})`);
  await sleep(900);
  check('undo restores the price', ev('live("kurti")') === before, String(ev('live("kurti")')));

  // ---- closed loop: the bridge mirrors the seller's tap into the persistent loop ----
  await sleep(1400);
  const loopState = ev('(PPAPI.loop && PPAPI.loop.state()) || {}');
  check('the bridge fetched the closed-loop state', !!(loopState.status && loopState.status.stages), loopState.error || 'stages ok');
  const st = (loopState.status && loopState.status.stages) || {};
  check('loop status carries every stage of the loop',
    !!(st.data && st.features && st.recommendation && st.decision && st.action && st.outcome && st.experiment && st.model),
    st.recommendation ? `${st.recommendation.total} recommendations` : 'missing');
  check('the tap created a persistent recommendation record',
    !!(loopState.listing && (loopState.listing.open_recommendation || loopState.listing.latest_recommendation)),
    loopState.listing && loopState.listing.latest_recommendation ? loopState.listing.latest_recommendation.status : 'none');
  check('the trust ladder is read from the server, not guessed',
    !!(loopState.trust && loopState.trust.ladder && typeof loopState.trust.wins === 'number'),
    loopState.trust ? `${loopState.trust.ladder.level} · ${loopState.trust.wins} wins` : 'none');
  check('trust only counts wins with evidence', !!(loopState.trust && loopState.trust.evidence),
    `${((loopState.trust || {}).evidence || []).length} evidence rows`);

  ev("go('api')");
  await sleep(400);
  const loopHtml = $('#view')?.innerHTML || '';
  check('the Backend screen renders the Closed loop card', /Closed loop/.test(loopHtml));
  check('the Closed loop card shows the full stage strip', /DATA/.test(loopHtml) && /FEATURES/.test(loopHtml) && /RECOMMENDATION/.test(loopHtml) && /OUTCOME/.test(loopHtml) && /MODEL/.test(loopHtml));
  check('the Closed loop card shows this listing\'s observation window and audit trail',
    /Observation window/.test(loopHtml) && /Audit trail/.test(loopHtml));
  const loopAudit = await fetch(BASE + '/api/actions/audit?limit=5').then((r) => r.json()).catch(() => ({}));
  check('the audit endpoint answers for the loop', Array.isArray(loopAudit.entries), (loopAudit.entries || []).length + ' entries');
  const stateEndpoint = await fetch(BASE + '/api/lifecycle/listings/L-kurti/state').then((r) => r.json()).catch(() => ({}));
  check('the listing loop state endpoint answers', !!stateEndpoint.listing, stateEndpoint.listing ? `${stateEndpoint.listing.sku} @ ${stateEndpoint.listing.price}` : 'none');

  // a blocked move must render the guardrail sheet, not publish
  ev(`PPAPI.publish(249, { note: 'smoke test' }).then(function(){window.__pub='ok'}).catch(function(e){window.__pub=e.status})`);
  await sleep(700);
  const pub = ev('window.__pub');
  check('publishing below the floor is refused (409)', pub === 409, String(pub));
} catch (err) {
  check('smoke test completed without a harness error', false, err.stack || err.message);
} finally {
  dom.window.close();
}

await fetch(BASE + '/api/admin/reset', { method: 'POST' }).catch(() => {});
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
