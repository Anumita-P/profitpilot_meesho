/**
 * EXPERIMENTS + HOLDOUTS API (phase 3 surface, phase 6 wiring).
 *
 * create -> start -> assign -> observe -> impact -> claim -> close.
 * claimGuard (src/engine/pilot.js) is the gate on anything a seller could repeat
 * as a claim, and the evidence gate in front of it refuses to hand a small
 * sample to it in the first place.
 */

import { ok, fail } from '../http/respond.js';
import * as exp from '../domain/experiments.js';
import * as session from '../http/session.js';

export function register(router) {
  router.get('/api/experiments', (ctx) => {
    try {
      const sellerId = session.scopedSeller(ctx, ctx.query.seller || null);
      return ok(ctx.res, {
        experiments: exp.list({ sellerId, listingId: ctx.query.listing || null, status: ctx.query.status || null }),
        summary: exp.summary({ sellerId }),
      });
    } catch (e) { return fail(ctx.res, e.status || 500, e.message, e.detail || null); }
  }, { summary: 'Experiments this seller has (with holdout design and observation counts)' });

  router.get('/api/experiments/summary', (ctx) => {
    try {
      const sellerId = session.scopedSeller(ctx, ctx.query.seller || null);
      return ok(ctx.res, exp.summary({ sellerId }));
    } catch (e) { return fail(ctx.res, e.status || 500, e.message, e.detail || null); }
  }, { summary: 'How many experiments are running, closed, and claimable' });

  router.post('/api/experiments', (ctx) => {
    try {
      const listingId = ctx.body?.listing_id || null;
      if (listingId) session.scope(ctx, { listingId, what: 'create an experiment for this listing' });
      const sellerId = session.scopedSeller(ctx, ctx.body?.seller_id || null);
      const created = exp.create({ ...ctx.body, seller_id: sellerId }, { sellerId, correlationId: ctx.correlation_id });
      return ok(ctx.res, {
        experiment: created,
        next: `POST /api/experiments/${created.experiment_id}/start to begin the clock, then observe both arms`,
      });
    } catch (e) { return fail(ctx.res, e.status || 500, e.message, e.detail || null); }
  }, { summary: 'Create an experiment (treated vs holdout, deterministic hash assignment)' });

  router.get('/api/experiments/:id', (ctx) => {
    try {
      const e = exp.get(ctx.params.id);
      session.scope(ctx, { sellerId: e.seller_id, what: 'read this experiment' });
      return ok(ctx.res, { experiment: e, impact: exp.impact(e.experiment_id) });
    } catch (e) { return fail(ctx.res, e.status || 500, e.message, e.detail || null); }
  }, { summary: 'One experiment with its current impact report' });

  router.get('/api/experiments/:id/impact', (ctx) => {
    try {
      const e = exp.get(ctx.params.id);
      session.scope(ctx, { sellerId: e.seller_id, what: 'read this experiment impact' });
      return ok(ctx.res, exp.impact(e.experiment_id));
    } catch (e) { return fail(ctx.res, e.status || 500, e.message, e.detail || null); }
  }, { summary: 'Difference in means with a 95% interval, an explicit enoughData flag and the deck\'s power note' });

  router.get('/api/experiments/:id/groups', (ctx) => {
    try {
      const e = exp.get(ctx.params.id);
      session.scope(ctx, { sellerId: e.seller_id, what: 'read this experiment groups' });
      const units = ctx.query.units ? String(ctx.query.units).split(',') : [];
      return ok(ctx.res, exp.groups(e.experiment_id, units));
    } catch (e) { return fail(ctx.res, e.status || 500, e.message, e.detail || null); }
  }, { summary: 'Who landed in treatment and who in holdout (recomputable by hand)' });

  router.post('/api/experiments/:id/claim', (ctx) => {
    try {
      const e = exp.get(ctx.params.id);
      session.scope(ctx, { sellerId: e.seller_id, what: 'generate a claim from this experiment' });
      return ok(ctx.res, exp.generateClaim(e.experiment_id, { requested: ctx.body?.claim || null }));
    } catch (e) { return fail(ctx.res, e.status || 500, e.message, e.detail || null); }
  }, { summary: 'Ask whether a claim may be made: refused without a valid treatment + holdout evidence' });

  router.get('/api/experiments/:id/claim', (ctx) => {
    try {
      const e = exp.get(ctx.params.id);
      session.scope(ctx, { sellerId: e.seller_id, what: 'read this experiment claim' });
      return ok(ctx.res, exp.generateClaim(e.experiment_id, { requested: ctx.query.claim || null }));
    } catch (e) { return fail(ctx.res, e.status || 500, e.message, e.detail || null); }
  }, { summary: 'Same as POST, conveniently' });
  const ACTIONS = {
    start: (ctx, id) => exp.start(id, { at: ctx.body?.at || null }),
    stop: (ctx, id) => exp.stop(id, { reason: ctx.body?.reason || 'stopped by request', at: ctx.body?.at || null }),
    observe: (ctx, id) => exp.observe(id, ctx.body || {}),
    close: (ctx, id) => exp.close(id, { at: ctx.body?.at || null, note: ctx.body?.note || null }),
    assign: (ctx, id) => exp.assign(id, ctx.body?.unit_id || ctx.body?.listing_id || id),
  };

  router.post('/api/experiments/:id/:action', (ctx) => {
    try {
      const { id, action } = ctx.params;
      const fn = ACTIONS[action];
      if (!fn) return fail(ctx.res, 404, `unknown experiment action "${action}"`, { known: [...Object.keys(ACTIONS), 'impact', 'claim', 'groups'] });
      const e = exp.get(id);
      session.scope(ctx, { sellerId: e.seller_id, what: `run ${action} on this experiment` });
      const result = fn(ctx, id);
      return ok(ctx.res, { experiment_id: id, action, result: action === 'observe' ? result : exp.get(id), impact: exp.impact(id) });
    } catch (e) { return fail(ctx.res, e.status || 500, e.message, e.detail || null); }
  }, { summary: 'Experiment actions: start | stop | observe | assign | close' });

}
