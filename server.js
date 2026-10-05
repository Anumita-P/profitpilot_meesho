#!/usr/bin/env node
/**
 * ProfitPilot 1.0 backend - the pricing engine, guardrails and measurement
 * layer behind the Meesho DICE S3 prototype.
 *
 * One process serves two things:
 *   /            the wired front-end (public/index.html) - same UI as the demo
 *                file, but reading its numbers from this API
 *   /api/*       the engine (layers: DATA -> FEATURES -> MODELS -> DECISION -> ACTION)
 *
 * Run:   node server.js            (PORT=8787 by default)
 * Docs:  GET /api/routes          (self-documenting endpoint index)
 *        GET /api/meta            (constants, guardrails, slide provenance)
 */

import http from 'node:http';
import { createRouter, readBody, context } from './src/http/router.js';
import { cors, fail, json, notFound, serveStatic, serveIndex } from './src/http/respond.js';
import { load, logEvent, stats } from './src/store/db.js';
import { register as registerCatalog } from './src/api/catalog.js';
import { register as registerListings } from './src/api/listings.js';
import { register as registerEngine } from './src/api/engine.js';
import { register as registerCoach } from './src/api/coach.js';
import { register as registerEvents } from './src/api/events.js';
import { register as registerLifecycle } from './src/api/lifecycle.js';
import { register as registerExperiments } from './src/api/experiments.js';
import { register as registerActions } from './src/api/actions.js';
import { register as registerJobs } from './src/api/jobs.js';
import { register as registerAdmin } from './src/api/admin.js';
import { register as registerModels } from './src/api/models.js';
import { register as registerVersions } from './src/api/versions.js';
import * as session from './src/http/session.js';
import { enforceScope } from './src/auth/scope.js';
import * as idempotency from './src/http/idempotency.js';
import { logError } from './src/store/db.js';

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';

const router = createRouter();
registerCatalog(router);
registerListings(router);
registerEngine(router);
registerCoach(router);
/* the closed loop: events -> recommendations -> outcomes -> experiments -> actions -> jobs */
registerEvents(router);
registerLifecycle(router);
registerExperiments(router);
registerActions(router);
registerJobs(router);
registerAdmin(router);
registerModels(router);
registerVersions(router);

/* The scheduler is created but NOT started: control is explicit (POST /api/jobs/start),
   which is what makes the demo deterministic. */
import('./src/jobs/scheduler.js').then((s) => logEvent('scheduler.available', { jobs: s.JOBS })).catch(() => {});

/* A few small routes that do not deserve their own module. */
router.post('/api/admin/reset', (ctx) => {
  session.requireAdmin(ctx);            // demo mode passes when PP_ADMIN_TOKEN is unset; set it to enforce
  // eslint-disable-next-line global-require
  return import('./src/store/db.js').then((m) => {
    m.reset();
    logEvent('admin.reset');
    return { reset: true, stats: m.stats() };
  });
}, { summary: 'Reset the demo database back to the deck seed' });

router.get('/api/admin/export', (ctx) => {
  session.requireAdmin(ctx);
  const d = load();
  return { snapshot: d, stats: stats() };
}, { summary: 'Full JSON snapshot (what the prototype persists)' });

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  cors(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // HEAD is answered exactly like GET (Node sends the headers and drops the body).
  // Preview proxies, uptime monitors and link checkers probe with HEAD: a 404 here
  // makes a perfectly healthy server look dead.
  const method = req.method === 'HEAD' ? 'GET' : req.method;
  const found = router.find(method, url.pathname);

  if (!found) {
    // static assets (the wired front-end + the API bridge)
    if (method === 'GET' && !url.pathname.startsWith('/api/')) {
      if (url.pathname === '/' || url.pathname === '/index.html') return serveIndex(res);
      return serveStatic(res, url.pathname);
    }
    if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
    return notFound(res, url.pathname);
  }

  let captured = null;                       // response body, for idempotency replay
  try {
    const body = ['POST', 'PATCH', 'PUT'].includes(req.method) ? await readBody(req) : {};
    const ctx = context(req, res, url, found.params, body);
    ctx.identity = session.resolve(ctx);     // 401 on a bad/expired token, before any work happens
    session.sessionHeaders(ctx, res);        // X-Request-Id / X-Correlation-Id on every response
    enforceScope(ctx);                       // 403 when a session reaches for another seller's resource

    // Retried write? Answer from the stored response and execute nothing twice.
    const replay = idempotency.lookup(ctx);
    if (replay) {
      return json(res, replay.status, replay.body, { ...replay.headers, 'X-Request-Id': replay.request_id, 'X-Correlation-Id': ctx.correlation_id });
    }
    if (idempotency.keyFor(ctx)) installCapture(res, (payload) => { captured = payload; });

    const out = await found.route.handler(ctx, router);
    if (!res.writableEnded && out !== undefined) json(res, 200, withMeta(out));
    else if (!res.writableEnded) json(res, 200, { ok: true });
    if (captured) idempotency.store(ctx, captured);
    idempotency.settle(ctx, res.statusCode);   // a response with no stored body is never left "in flight"
  } catch (err) {
    const status = err.status || 500;
    const detail = err.detail || (status >= 500 && process.env.PP_DEBUG_STACKS === '1' ? err.stack : null);
    if (!res.writableEnded) fail(res, status, status >= 500 && !process.env.PP_DEBUG_STACKS ? 'internal error (see the server log and GET /api/admin/errors)' : (err.message || 'internal error'), detail);
    try { idempotency.release(ctx); } catch { /* freeing a key must never mask the real error */ }
    if (status >= 500) {
      console.error(`[${req.method} ${url.pathname}]`, err);
      try { logError({ where: `${req.method} ${url.pathname}`, message: err.message, status, stack: err.stack }); } catch { /* logging must never mask the original error */ }
    }
  } finally {
    const ms = Date.now() - started;
    if (process.env.PP_LOG !== 'off') {
      console.log(`${req.method.padEnd(5)} ${url.pathname}${url.search ? url.search : ''} -> ${res.statusCode} (${ms}ms)`);
    }
  }
});

/** Capture the JSON a handler wrote straight to the socket, for idempotency. */
function installCapture(res, cb) {
  const origEnd = res.end.bind(res);
  res.end = (chunk, ...rest) => {
    try {
      const status = res.statusCode;
      const type = String(res.getHeader('content-type') || '');
      const text = chunk ? chunk.toString('utf8') : '';
      if (status && type.includes('application/json') && text.trim()) {
        cb({ status, body: JSON.parse(text) });
      }
    } catch { /* a body we cannot parse is simply not replayable */ }
    return origEnd(chunk, ...rest);
  };
}

function withMeta(body) {
  if (body && typeof body === 'object' && !Array.isArray(body) && body._meta === undefined) {
    return {
      ...body,
      _meta: {
        engine: 'ProfitPilot 1.0',
        generatedAt: new Date().toISOString(),
        disclaimer: 'Illustrative planning defaults and simulated data from the DICE S3 deck. Not real Meesho data.',
      },
    };
  }
  return body;
}

/* Wire the simulator's event ingest (module cycle avoided by doing it at boot). */
import('./src/domain/events.js')
  .then((m) => import('./src/domain/outcomes.js').then((o) => o.registerEventIngest(m)))
  .then(() => logEvent('closedLoop.wired', { eventIngest: 'registered' }))
  .catch((e) => console.error('[wiring] event ingest not registered:', e.message));

load(); // seed on first boot
logEvent('server.boot', { port: PORT });

server.listen(PORT, HOST, () => {
  const s = stats();
  console.log('');
  console.log('  ProfitPilot 1.0 backend  ·  Meesho DICE Challenge S3  ·  Team Fiery Diamonds');
  console.log('  ---------------------------------------------------------------------');
  console.log(`  UI + API    http://localhost:${PORT}/`);
  console.log(`  Endpoints   http://localhost:${PORT}/api/routes`);
  console.log(`  Engine meta http://localhost:${PORT}/api/meta`);
  console.log(`  Data        ${s.listings} listings · ${s.sellers} seller(s) · ${s.decisions} decisions · ${s.events} events`);
  console.log(`  Closed loop events ${s.ingestedEvents ?? 0} · recommendations ${s.recommendations ?? 0} · actions ${s.actions ?? 0} · experiments ${s.experiments ?? 0}`);
  console.log('  Scheduler   stopped (start it with POST /api/jobs/start - the demo stays deterministic until you do)');
  console.log(`  Store       ${s.dataFile}`);
  console.log('  All numbers are illustrative planning defaults. No real Meesho data.');
  console.log('');
});

const shutdown = (sig) => {
  console.log(`\n[${sig}] shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));
