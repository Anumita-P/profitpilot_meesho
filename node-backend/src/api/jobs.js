/**
 * SCHEDULER CONTROL API (phase 4 surface, phase 6 wiring).
 *
 * Explicit control, because a demo that changes state whenever it feels like it
 * cannot be reviewed: the scheduler is created STOPPED and only runs when you
 * start it or call run-now. A manual run may carry an explicit `at`, which is
 * how the reproducible demo time-travels (the store's own history decides what
 * is due - nothing is faked).
 */

import { ok, fail } from '../http/respond.js';
import * as scheduler from '../jobs/scheduler.js';
import { JOB_NAMES } from '../jobs/recalc.js';
import * as session from '../http/session.js';

export function register(router) {
  router.get('/api/jobs/status', (ctx) => {
    try {
      session.requireAdmin(ctx);
      const s = scheduler.status();
      return ok(ctx.res, { ...s, jobDescriptions: JOB_DESCRIPTIONS });
    } catch (e) { return fail(ctx.res, e.status || 500, e.message, e.detail || null); }
  }, { summary: 'Scheduler status: running, interval, jobs, last run, errors, persisted history' });

  router.get('/api/jobs/history', (ctx) => {
    try {
      session.requireAdmin(ctx);
      const s = scheduler.status();
      return ok(ctx.res, { process: s.history, persisted: s.persistedRuns, errors: s.errors });
    } catch (e) { return fail(ctx.res, e.status || 500, e.message, e.detail || null); }
  }, { summary: 'Recent scheduler runs (in-process + persisted across restarts)' });

  router.post('/api/jobs/start', (ctx) => {
    try {
      session.requireAdmin(ctx);
      const s = scheduler.start({ intervalMs: ctx.body?.intervalMs ?? null, kinds: ctx.body?.kinds ?? null });
      return ok(ctx.res, { ...s, note: 'the loop now ticks on its own interval; run-now still works for a deterministic step' });
    } catch (e) { return fail(ctx.res, e.status || 500, e.message, e.detail || null); }
  }, { summary: 'Start the scheduler (intervalMs default 60000)' });

  router.post('/api/jobs/stop', (ctx) => {
    try {
      session.requireAdmin(ctx);
      return ok(ctx.res, scheduler.stop({ reason: ctx.body?.reason || 'stopped via API' }));
    } catch (e) { return fail(ctx.res, e.status || 500, e.message, e.detail || null); }
  }, { summary: 'Stop the scheduler (state and history are kept)' });

  router.post('/api/jobs/run', (ctx) => {
    try {
      session.requireAdmin(ctx);
      const kinds = ctx.body?.kinds || (ctx.body?.kind ? [ctx.body.kind] : null);
      const report = scheduler.runNow({
        at: ctx.body?.at ?? null,
        kinds,
        dryRun: !!ctx.body?.dryRun,
        trigger: 'api',
      });
      return ok(ctx.res, {
        ...report,
        determinism: 'the same data + the same `at` produce the same result: re-run it and compare',
        guardrails: 'no job may bypass a guardrail; the only price write a job can make is the 14-day auto-revert',
      });
    } catch (e) { return fail(ctx.res, e.status || 500, e.message, e.detail || null); }
  }, { summary: 'Run one cycle now: { at, kinds, dryRun } - deterministic and idempotent per timestamp' });

  router.get('/api/jobs', () => ({
    jobs: JOB_NAMES,
    descriptions: JOB_DESCRIPTIONS,
    control: ['GET /api/jobs/status', 'POST /api/jobs/start', 'POST /api/jobs/stop', 'POST /api/jobs/run', 'GET /api/jobs/history'],
  }), { summary: 'The available jobs and what each one does' });
}

const JOB_DESCRIPTIONS = {
  cooldown: 'Recompute days-since-move and moves-this-month from price history (cooldown + move budget)',
  signals: 'Refresh listing signals from OBSERVED events only, so a new recommendation sees what actually happened',
  observe: 'Judge applied recommendations whose window is due; refuses a verdict without evidence',
  revert: '14-day safety net: Autopilot reverts a losing or quality-breaching change (guardrailed); Manual/Co-Pilot get a proposal',
  queue: 'Drain the action queue and expire stale proposals',
  experiments: 'Stop experiments whose stop rules fired, close experiments that reached their end date',
  reconcile: 'Re-check every live price against its floor; raises alerts, never silently reprices',
};
