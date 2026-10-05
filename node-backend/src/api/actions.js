/**
 * ACTION QUEUE API (phase 5 surface, phase 6 wiring).
 *
 *   POST /api/actions                       build an action from a recommendation
 *   POST /api/actions/step                  build it and walk it as far as trust allows
 *   POST /api/actions/:id/check|approve|reject|enqueue|execute|verify|expire
 *   POST /api/actions/run-queue             drain everything that is queued
 *   GET  /api/actions                       the queue
 *   GET  /api/actions/pipeline              where every action is, stage by stage
 *   GET  /api/actions/audit                 the audit trail
 */

import { ok, fail } from '../http/respond.js';
import * as actions from '../domain/actions.js';
import * as trust from '../domain/trust.js';
import * as session from '../http/session.js';
import * as recs from '../domain/recommendations.js';

export function register(router) {
  router.get('/api/actions/pipeline', (ctx) => {
    try {
      const sellerId = session.scopedSeller(ctx, ctx.query.seller || null);
      return ok(ctx.res, actions.pipeline({ sellerId }));
    } catch (e) { return fail(ctx.res, e.status || 500, e.message, e.detail || null); }
  }, { summary: 'The pipeline: recommendation -> guardrails -> proposal -> approval -> queue -> execution -> verification' });

  router.get('/api/actions/audit', (ctx) => {
    try {
      const filter = {
        actionId: ctx.query.action || null,
        recommendationId: ctx.query.recommendation || null,
        listingId: ctx.query.listing || null,
        limit: Math.min(500, Number(ctx.query.limit || 100)),
      };
      if (filter.listingId) session.scope(ctx, { listingId: filter.listingId, what: 'read the audit trail' });
      else session.scopedSeller(ctx, ctx.query.seller || null);   // identity check even when unfiltered
      return ok(ctx.res, {
        entries: actions.audit(filter),
        rule: 'every state change writes an audit entry: actor, from, to, why, when',
      });
    } catch (e) { return fail(ctx.res, e.status || 500, e.message, e.detail || null); }
  }, { summary: 'Audit trail for actions, recommendations or listings' });

  router.get('/api/actions', (ctx) => {
    try {
      const sellerId = session.scopedSeller(ctx, ctx.query.seller || null);
      const rows = actions.list({
        sellerId,
        listingId: ctx.query.listing || null,
        status: ctx.query.status ? String(ctx.query.status).split(',') : null,
        open: ctx.flag('open', false),
      });
      return ok(ctx.res, { actions: rows, counts: actions.counts({ sellerId }) });
    } catch (e) { return fail(ctx.res, e.status || 500, e.message, e.detail || null); }
  }, { summary: 'The action queue, newest first' });

  router.get('/api/actions/:id', (ctx) => {
    try {
      const a = actions.get(ctx.params.id);
      session.scope(ctx, { sellerId: a.seller_id, what: 'read this action' });
      return ok(ctx.res, { action: a, audit: actions.audit({ actionId: a.action_id }) });
    } catch (e) { return fail(ctx.res, e.status || 500, e.message, e.detail || null); }
  }, { summary: 'One action with its audit trail' });

  /* ------------------------------- creation ------------------------------- */
  function build(ctx, recommendationId, to) {
    const created = actions.create({
      recommendationId,
      to,
      by: ctx.identity?.session_id || 'api',
      correlationId: ctx.correlation_id,
    });
    session.scope(ctx, { sellerId: created.action.seller_id, what: 'queue an action' });
    return created;
  }

  router.post('/api/actions', (ctx) => {
    try {
      if (!ctx.body?.recommendation_id) return fail(ctx.res, 400, 'recommendation_id is required', { field: 'recommendation_id' });
      const created = build(ctx, ctx.body.recommendation_id, ctx.body?.to);
      const checked = ctx.flag('check', true) ? actions.check(created.action.action_id) : created.action;
      return ok(ctx.res, { action: checked, created: !created.reused, reused: created.reused });
    } catch (e) { return fail(ctx.res, e.status || 500, e.message, e.detail || null); }
  }, { summary: 'Create an action from a recommendation and run pre-flight (idempotent per recommendation)' });

  router.post('/api/actions/step', (ctx) => {
    try {
      if (!ctx.body?.recommendation_id && !ctx.body?.action_id) {
        return fail(ctx.res, 400, 'recommendation_id or action_id is required', { fields: ['recommendation_id', 'action_id'] });
      }
      if (ctx.body?.recommendation_id) recs.get(ctx.body.recommendation_id);   // 404 before anything is created
      const result = actions.step({
        recommendationId: ctx.body?.recommendation_id || null,
        actionId: ctx.body?.action_id || null,
        to: ctx.body?.to ?? null,
        by: ctx.identity?.session_id || 'api',
        correlationId: ctx.correlation_id,
      });
      session.scope(ctx, { sellerId: result.action.seller_id, what: 'step an action' });
      return ok(ctx.res, {
        ...result,
        why: result.stoppedAt === 'PROPOSED'
          ? `${result.action.autonomy?.label}: the engine may propose, the seller decides. Approve with POST /api/actions/${result.action.action_id}/approve`
          : result.stoppedAt === 'BLOCKED'
            ? `refused by guardrails: ${(result.action.guardrail?.blocking || []).join(' | ')}`
            : `stopped at ${result.stoppedAt}`,
      });
    } catch (e) { return fail(ctx.res, e.status || 500, e.message, e.detail || null); }
  }, { summary: 'Create (or continue) an action and walk it as far as the trust ladder allows' });

  router.post('/api/actions/run-queue', (ctx) => {
    try {
      session.requireAdmin(ctx);            // draining the whole queue is an operator action
      return ok(ctx.res, actions.runQueue({ at: ctx.body?.at || null, by: ctx.identity?.session_id || 'api' }));
    } catch (e) { return fail(ctx.res, e.status || 500, e.message, e.detail || null); }
  }, { summary: 'Execute every queued action (operator; guardrails still apply at execution time)' });

  /* ------------------------------- transitions ---------------------------- */
  const STEPS = {
    check: (ctx, id) => actions.check(id, { at: ctx.body?.at || null }),
    approve: (ctx, id) => actions.approve(id, { by: ctx.body?.by || ctx.identity?.session_id || 'seller', note: ctx.body?.note || null, at: ctx.body?.at || null }),
    reject: (ctx, id) => actions.reject(id, { by: ctx.body?.by || ctx.identity?.session_id || 'seller', note: ctx.body?.note || null, at: ctx.body?.at || null }),
    enqueue: (ctx, id) => actions.enqueue(id, { at: ctx.body?.at || null, by: ctx.identity?.session_id || 'executor' }),
    execute: (ctx, id) => actions.execute(id, { at: ctx.body?.at || null, by: ctx.identity?.session_id || 'executor', verify: ctx.body?.verify !== false }),
    verify: (ctx, id) => actions.verifyAction(id, { at: ctx.body?.at || null, by: ctx.identity?.session_id || 'verifier' }),
  };

  router.post('/api/actions/:id/:step', (ctx) => {
    try {
      const { id, step } = ctx.params;
      const fn = STEPS[step];
      if (!fn) return fail(ctx.res, 404, `unknown action step "${step}"`, { known: Object.keys(STEPS) });
      const a = actions.get(id);
      session.scope(ctx, { sellerId: a.seller_id, what: `${step} this action` });
      const updated = fn(ctx, id);
      return ok(ctx.res, {
        action: updated,
        step,
        startedFrom: a.status,
        trust: trust.computedTrust(updated.seller_id).ladder,
        why: updated.guardrail?.blocking?.length ? `guardrail: ${updated.guardrail.blocking.join(' | ')}` : null,
      });
    } catch (e) { return fail(ctx.res, e.status || 500, e.message, e.detail || null); }
  }, { summary: 'Action steps: check | approve | reject | enqueue | execute | verify' });

  /* --------------------------------- trust -------------------------------- */
  router.get('/api/actions/trust/:sellerId', (ctx) => {
    try {
      session.scope(ctx, { sellerId: ctx.params.sellerId, what: 'read the trust ladder' });
      return ok(ctx.res, trust.computedTrust(ctx.params.sellerId));
    } catch (e) { return fail(ctx.res, e.status || 500, e.message, e.detail || null); }
  }, { summary: 'The trust ladder with the evidence behind every counted win (and every refusal to count one)' });

  router.get('/api/actions/autonomy/:sellerId/:sku', (ctx) => {
    try {
      session.scope(ctx, { sellerId: ctx.params.sellerId, what: 'read autonomy for this SKU' });
      return ok(ctx.res, trust.autonomyFor(ctx.params.sellerId, ctx.params.sku));
    } catch (e) { return fail(ctx.res, e.status || 500, e.message, e.detail || null); }
  }, { summary: 'Effective autonomy for a SKU: what the seller granted, capped by what the seller earned' });
}
