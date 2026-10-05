/**
 * ROUTE SMOKE - calls every route the server advertises and reports the status.
 *
 *   node server.js &
 *   node scripts/smoke-routes.mjs
 *
 * It is a developer check, not part of `npm test`: the unit/parity tests cover
 * the maths, this covers the wiring (a handler that throws, a missing import).
 */

const BASE = process.env.PP_BASE || 'http://localhost:8787';

const BODIES = {
  '/api/skus/:key/floor': { overrides: { cs: 200 } },
  '/api/launch/plan': { category: 'ethnic', skuKey: 'kurti', sellerCost: 180, targetProfit: 60, comparables: { count: 24, median: 379, p25: 299, p75: 599 }, stock: { days: 45, units: 40 } },
  '/api/risk/return': { category: 'ethnic', pincodeCluster: 'tier3-cod', fragile: false, weightKg: 0.5 },
  '/api/risk/cod': { pincodeCluster: 'tier3-cod', orderValue: 700 },
  '/api/programmes/reorder-point': { dailyUnits: 12, leadTimeDays: 7 },
  '/api/programmes/pooled-procurement': { sellers: 5 },
  '/api/programmes/packaging-audit': { declaredKg: 0.5, actualKg: 0.9, declaredCm: 20, actualCm: 26, fragile: true },
  '/api/listings/:id': { price: 379 },
  '/api/listings/:id/costs': { costs: { cs: 200, cat: 'ethnic' } },
  '/api/listings/:id/simulate': { kink: true },
  '/api/listings/:id/diagnose': {},
  '/api/listings/:id/publish': { price: 379, note: 'smoke' },
  '/api/listings/:id/decisions': { cardId: null, action: 'accept' },
  '/api/engine/bandit/run': { listing: 'L-kurti', mode: 'growth', days: 3 },
  '/api/engine/bandit/reset': { listing: 'L-kurti', mode: 'growth' },
  '/api/pilot/sample-size': {},
  '/api/pilot/cohort': {},
  '/api/pilot/claim': { claim: '+24% profit', hasHoldout: true, treated: 104.5, holdout: 84 },
  '/api/coach/ask': { question: 'Why are returns coming?', listing: 'L-kurti', lang: 'en' },
  '/api/decisions/:id/observe': { impressions: 20000, profit: 5000, baseline: { impressions: 19000, profit: 6000 } },
};

const routes = await fetch(BASE + '/api/routes').then((r) => r.json());
const listingId = await fetch(BASE + '/api/bootstrap').then((r) => r.json()).then((b) => b.listingIds.kurti);
const firstDecision = await fetch(BASE + '/api/decisions').then((r) => r.json()).then((d) => (d.decisions || [])[0]);

let pass = 0;
const rows = [];
for (const { method, path } of routes.routes) {
  if (path === '/api/admin/reset') continue; // destructive, tested separately
  let url = path;
  let body = BODIES[path];
  if (path.includes(':key')) url = path.replace(':key', 'kurti');
  if (path.includes(':id')) {
    url = path.replace(':id', path.startsWith('/api/sellers/') ? 'S-ramesh' : path.startsWith('/api/decisions/') ? (firstDecision ? firstDecision.id : 'D-0001') : listingId);
  }
  if (path === '/api/listings/:id/decisions' && body) {
    const rec = await fetch(`${BASE}/api/listings/${listingId}/recommendation`).then((r) => r.json());
    body = { cardId: rec.cardId, action: 'reject', note: 'smoke' };
  }
  const res = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: ['POST', 'PATCH', 'PUT'].includes(method) ? JSON.stringify(body || {}) : undefined,
  });
  const text = await res.text();
  let detail = '';
  if (!res.ok) {
    try { detail = JSON.parse(text).error.message; } catch { detail = text.slice(0, 80); }
  } else {
    detail = `${text.length} bytes`;
  }
  // 4xx with a clear message is a correct answer too: a guardrail refused the move,
  // a body was deliberately incomplete, or the state has already moved on. 5xx is a bug.
  const ok = res.status < 500;
  if (ok) pass++;
  rows.push(`${ok ? 'ok  ' : 'FAIL'} ${String(res.status).padEnd(3)} ${method.padEnd(5)} ${url.padEnd(52)} ${detail}`);
}

/* Proxies and uptime monitors probe with HEAD before they load anything: a 404
   on HEAD makes a healthy server look dead (it did, until this was fixed). */
for (const path of ['/', '/index.html', '/api-bridge.js', '/api/floors', '/api/health']) {
  const res = await fetch(BASE + path, { method: 'HEAD' });
  const ok = res.ok;
  if (ok) pass++;
  rows.push(`${ok ? 'ok  ' : 'FAIL'} ${String(res.status).padEnd(3)} HEAD  ${path.padEnd(52)} ${res.headers.get('content-type')}`);
}

console.log(rows.join('\n'));
console.log(`\n${pass}/${rows.length} checks answered`);
process.exit(pass === rows.length ? 0 : 1);
