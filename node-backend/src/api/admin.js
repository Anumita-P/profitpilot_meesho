/**
 * SESSIONS, OBSERVABILITY AND THE CLOSED-LOOP SUMMARY (phase 6 wiring).
 *
 *   POST/GET/DELETE /api/session      demo seller sessions (hashed tokens)
 *   GET  /api/metrics                 counters for the loop and the process
 *   GET  /api/admin/system            storage, scheduler, versions, protection state
 *   GET  /api/admin/errors            the error log (no stack traces in API bodies)
 *   GET  /api/admin/audit             the audit trail, admin-scoped
 *   GET  /api/admin/sessions          live demo sessions (hints only, never tokens)
 *   GET  /api/closed-loop/status      one call that says where the loop is
 */

import { ok, fail } from '../http/respond.js';
import * as session from '../http/session.js';
import * as idempotency from '../http/idempotency.js';
import * as recs from '../domain/recommendations.js';
import * as actions from '../domain/actions.js';
import * as outcomes from '../domain/outcomes.js';
import * as experiments from '../domain/experiments.js';
import * as trust from '../domain/trust.js';
import * as versions from '../domain/versions.js';
import * as scheduler from '../jobs/scheduler.js';
import { JOB_NAMES } from '../jobs/recalc.js';
import { stats, errorLog, events, sellers, hydratedListings, load, storage } from '../store/db.js';
import { SERVICE, GUARDRAILS } from '../config/deck.js';

export function register(router) {
  /* -------------------------------- sessions ------------------------------ */
  router.post('/api/session', (ctx) => {
    try {
      const created = session.createSession({
        sellerId: ctx.body?.seller_id || null,
        role: ctx.body?.role || 'seller',
        label: ctx.body?.label || null,
        ttlHours: ctx.body?.ttlHours || undefined,
      });
      return ok(ctx.res, {
        ...created,
        usage: {
          header: 'Authorization: Bearer <token>  (or X-Session: <token>)',
          effect: 'the session scopes every request to its seller; anything else is a 403 and is audited',
        },
        warning: 'Demo sessions for a local prototype. Tokens are stored hashed; this is not production auth.',
      });
    } catch (e) { return fail(ctx.res, e.status || 500, e.message, e.detail || null); }
  }, { summary: 'Create a demo session (seller or admin). Returns the token once, stores only its hash' });

  router.get('/api/session', (ctx) => {
    try {
      const id = ctx.identity || session.resolve(ctx);
      return ok(ctx.res, {
        identity: session.publicSession({ ...(id.session || {}), session_id: id.session_id || null }),
        scope: session.scopeReport(id),
        request: { request_id: ctx.request_id, correlation_id: ctx.correlation_id },
        sessions_available: process.env.PP_SESSION_REQUIRED === '1'
          ? 'PP_SESSION_REQUIRED=1: seller-scoped writes need a session'
          : 'demo mode: sessions are optional and the seeded demo seller is the default caller',
      });
    } catch (e) { return fail(ctx.res, e.status || 500, e.message, e.detail || null); }
  }, { summary: 'Who am I, what am I scoped to, and what are my request ids' });

  router.delete('/api/session', (ctx) => {
    try {
      const token = (ctx.req.headers.authorization || '').replace(/^Bearer\s+/i, '') || ctx.req.headers['x-session'];
      if (!token) return fail(ctx.res, 400, 'no session token presented', { hint: 'Authorization: Bearer <token>' });
      const out = session.revokeSession(token);
      return ok(ctx.res, out);
    } catch (e) { return fail(ctx.res, e.status || 500, e.message, e.detail || null); }
  }, { summary: 'Revoke the presented session token' });

  router.get('/api/admin/sessions', (ctx) => {
    try {
      session.requireAdmin(ctx);
      return ok(ctx.res, { sessions: session.listSessions() });
    } catch (e) { return fail(ctx.res, e.status || 500, e.message, e.detail || null); }
  }, { summary: 'Live demo sessions (admin). Token hints only - tokens themselves are never stored' });

  /* -------------------------------- metrics ------------------------------- */
  router.get('/api/metrics', (ctx) => {
    try {
      session.requireAdmin(ctx);
      const s = stats();
      const d = load();
      return ok(ctx.res, {
        counters: s,
        loop: {
          eventsIngested: (d.ingestedEvents || []).length,
          eventTypesSeen: Array.from(new Set((d.ingestedEvents || []).map((e) => e.event_type))).length,
          recommendations: (d.recommendations || []).length,
          openRecommendations: recs.counts({}).total ? recs.counts({}).byStatus : {},
          outcomesRecorded: (d.outcomes || []).length,
          experiments: (d.experiments || []).length,
          actions: (d.actions || []).length,
          reverts: (d.reverts || []).length,
          auditEntries: (d.audit || []).length,
          sessions: Object.keys(d.sessions || {}).length,
        },
        quality: {
          winsWithEvidence: (d.outcomes || []).filter((o) => o.verdict === 'WIN' && !o.insufficient).length,
          verdictsWithoutEvidence: (d.outcomes || []).filter((o) => o.insufficient).length,
          claimsRefused: (d.ingestedEvents || []).filter((e) => e.event_type === 'experiment.claim' && e.payload?.allowed === false).length,
          note: 'verdictsWithoutEvidence must stay 0: the outcome calculator refuses to produce one, and claimGuard refuses claims without a holdout',
        },
        idempotency: idempotency.stats(),
        process: { uptimeSec: Math.round(process.uptime()), memoryMb: Math.round(process.memoryUsage().rss / 1048576) },
      });
    } catch (e) { return fail(ctx.res, e.status || 500, e.message, e.detail || null); }
  }, { summary: 'Loop counters, idempotency store and process metrics (admin)' });

  /* --------------------------------- system ------------------------------- */
  router.get('/api/admin/system', (ctx) => {
    try {
      session.requireAdmin(ctx);
      const s = stats();
      const d = load();
      return ok(ctx.res, {
        service: SERVICE,
        storage: {
          ...storage.describe(),
          file: s.dataFile,
          bytes: s.fileBytes ?? null,
          collections: Object.keys(d).length,
        },
        scheduler: {
          running: scheduler.status().running,
          intervalMs: scheduler.status().intervalMs,
          jobs: JOB_NAMES,
          lastRun: scheduler.status().lastRun,
          cycles: scheduler.status().counters,
          errors: scheduler.status().errors.length,
        },
        versions: versions.versionSet(),
        guardrails: {
          hard_floor: GUARDRAILS.hardFloor,
          max_step_pct: GUARDRAILS.maxStepPct,
          cooldown_days: GUARDRAILS.cooldownDays,
          max_moves_per_month: GUARDRAILS.maxMovesPerMonth,
          min_views: GUARDRAILS.minViewsForSanity,
          auto_revert_day: GUARDRAILS.autoRevertDay,
          confirm_day: GUARDRAILS.confirmDay,
          autopilot_wins_required: GUARDRAILS.autopilotWinsRequired,
          note: 'these are read from src/config/deck.js: the API cannot raise them, and no route weakens them',
        },
        protection: {
          seller_sessions: Object.keys(d.sessions || {}).length,
          session_required: process.env.PP_SESSION_REQUIRED === '1',
          admin_token_configured: !!process.env.PP_ADMIN_TOKEN,
          admin_protection: process.env.PP_ADMIN_TOKEN
            ? 'enforced: /api/admin/* needs X-Admin-Token or an admin session'
            : 'DEMO MODE: PP_ADMIN_TOKEN is not set, so the local prototype (and its scripts) may call /api/admin/*. Set PP_ADMIN_TOKEN to enforce.',
          cross_seller: 'a session scoped to seller A is refused (403 + audit) on seller B\'s data',
        },
        idempotency: idempotency.stats(),
        events: { stream: events(5) },
        errors: errorLog(5),
        sellers: sellers().map((sl) => ({ id: sl.id, name: sl.name, wins: sl.wins, control: sl.control, trust: sl.trust?.level || null })),
        listings: hydratedListings().map((l) => ({ id: l.id, sku: l.skuKey, price: l.price, floor: l.floor.F, stage: l.stage })),
        note: 'Everything here is illustrative demo state. Mechanical constants come from the deck; the code says which are modelled.',
      });
    } catch (e) { return fail(ctx.res, e.status || 500, e.message, e.detail || null); }
  }, { summary: 'Storage, scheduler, versions, guardrails and protection state (admin)' });

  router.get('/api/admin/errors', (ctx) => {
    try {
      session.requireAdmin(ctx);
      const rows = errorLog(Math.min(200, Number(ctx.query.limit || 50)));
      return ok(ctx.res, {
        errors: rows,
        count: rows.length,
        policy: 'API responses never carry stack traces (set PP_DEBUG_STACKS=1 to opt in locally); details go here and to the server log',
      });
    } catch (e) { return fail(ctx.res, e.status || 500, e.message, e.detail || null); }
  }, { summary: 'The error log (admin)' });

  router.get('/api/admin/audit', (ctx) => {
    try {
      session.requireAdmin(ctx);
      const d = load();
      return ok(ctx.res, {
        entries: (d.audit || []).slice(-(Math.min(500, Number(ctx.query.limit || 100)))).reverse(),
        total: (d.audit || []).length,
        rule: 'every state-changing action writes here: who, what, from -> to, why, when',
      });
    } catch (e) { return fail(ctx.res, e.status || 500, e.message, e.detail || null); }
  }, { summary: 'The full audit trail (admin)' });

  /* ----------------------------- closed-loop view ------------------------ */
  router.get('/api/closed-loop/status', (ctx) => {
    try {
      const id = ctx.identity || session.resolve(ctx);
      const sellerId = session.scopedSeller(ctx, ctx.query.seller || null);
      const d = load();
      const counts = recs.counts({ sellerId });
      const actionCounts = actions.counts({ sellerId });
      const out = outcomes.outcomes({ sellerId });
      const exps = experiments.list({ sellerId });
      return ok(ctx.res, {
        seller_id: sellerId,
        identity: session.scopeReport(id),
        stages: {
          data: { events: (d.ingestedEvents || []).filter((e) => !sellerId || e.seller_id === sellerId).length, dev_simulated: (d.ingestedEvents || []).filter((e) => e.source === 'simulator').length },
          features: { listings_with_signals: Object.keys(d.listings || {}).length, refreshed: Object.values(d.listings || {}).filter((l) => l.signalsRefreshedAt).length },
          recommendation: counts,
          decision: { decisions_recorded: (d.decisions || []).length, accepted: counts.accepted, rejected: counts.rejected, overridden: counts.overridden },
          action: actionCounts,
          outcome: { recorded: out.length, wins: out.filter((o) => o.verdict === 'WIN').length, losses: out.filter((o) => o.verdict === 'LOSS').length, neutral: out.filter((o) => o.verdict === 'NEUTRAL').length },
          experiment: experiments.summary({ sellerId }),
          model: { trust: trust.computedTrust(sellerId).ladder, versions: versions.versionSet() },
        },
        scheduler: { running: scheduler.status().running, lastRun: scheduler.status().lastRun },
        reverts: (d.reverts || []).slice(-5),
        note: 'Where the loop currently is, stage by stage, for this seller.',
      });
    } catch (e) { return fail(ctx.res, e.status || 500, e.message, e.detail || null); }
  }, { summary: 'One call: where the closed loop is right now (data -> ... -> model update)' });
}
