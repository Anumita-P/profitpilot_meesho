/**
 * SNAPSHOT - freeze what the server-computed UI currently looks like.
 *
 *   node server.js &
 *   node scripts/snapshot.mjs            # needs jsdom: npm i --no-save jsdom
 *
 * Boots the wired page against the live API, walks to a few screens and writes
 * self-contained HTML files (scripts and handlers stripped) into docs/snapshots/.
 * Useful as proof-of-run evidence, and viewable anywhere with no server.
 */
const BASE = process.env.PP_BASE || 'http://localhost:8787';
const fs = await import('node:fs');
const path = await import('node:path');

let JSDOM;
try { ({ JSDOM } = await import('jsdom')); } catch { console.log('SKIP: jsdom missing (npm i --no-save jsdom)'); process.exit(0); }
if (!(await fetch(BASE + '/api/health').then((r) => r.ok).catch(() => false))) { console.log('SKIP: no server on ' + BASE); process.exit(0); }

const out = path.join(process.cwd(), 'docs', 'snapshots');
fs.mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dom = await JSDOM.fromURL(BASE + '/', {
  runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true,
  beforeParse(w) { w.fetch = (u, o) => fetch(new URL(u, BASE).toString(), o); w.scrollTo = () => {}; w.requestAnimationFrame = (cb) => setTimeout(cb, 16); },
});
const { window } = dom;
const ev = (c) => window.eval(c);
for (let i = 0; i < 60 && !ev('window.PPAPI && PPAPI.state().api.booted'); i++) await sleep(100);

await fetch(BASE + '/api/admin/reset', { method: 'POST' });   // a clean demo state for the picture
await sleep(300);
await fetch(BASE + '/api/engine/bandit/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ listing: 'L-kurti', mode: 'growth', days: 30 }) });

// diagnose animates its 8 nodes (~0.4 s each) and the engine lab waits for the
// bandit response, so give those views time to finish before freezing them
const shots = [['home', 'home', 1000], ['lifecycle', 'lifecycle', 1200], ['diagnose', 'diagnose', 5000], ['engine', 'engine-lab', 4000], ['api', 'backend-screen', 1200]];
for (const [view, name, wait] of shots) {
  try { ev(`go('${view}')`); } catch {}
  await sleep(wait);
  let html = '<!doctype html>\n' + window.document.documentElement.outerHTML;
  html = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/\son[a-z]+="[^"]*"/gi, '');
  fs.writeFileSync(path.join(out, `${name}.html`), html);
  console.log(`${name}.html  ${(html.length / 1024).toFixed(0)} KB`);
}
dom.window.close();
console.log('written to docs/snapshots/');
