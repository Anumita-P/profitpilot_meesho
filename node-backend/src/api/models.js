/**
 * MODEL INTERFACE API (requirement 9).
 *
 * These routes exist so the model contracts can be inspected and exercised
 * without reading the source: what goes in, what comes out, which version of the
 * rules produced it, and - importantly - what a real trained model would replace.
 */

import { ok, fail } from '../http/respond.js';
import * as models from '../models/interfaces.js';
import * as session from '../http/session.js';
import { versionSet } from '../domain/versions.js';

export function register(router) {
  router.get('/api/models', () => ({
    interfaces: Object.keys(models.INTERFACES),
    contracts: CONTRACTS,
    versions: versionSet(),
    notes: models.MODEL_NOTES,
    honesty: 'No ML library, no fitted weights, no accuracy claim. Every interface is a deterministic rule over deck constants and the seller\'s own data, with a documented seam for a real model.',
  }), { summary: 'The five model interfaces, their contracts and where a real model plugs in' });

  router.get('/api/models/explain/:listingId', (ctx) => {
    try {
      session.scope(ctx, { listingId: ctx.params.listingId, what: 'explain the models for this listing' });
      return ok(ctx.res, models.explain(ctx.params.listingId, { mode: ctx.query.mode || null }));
    } catch (e) { return fail(ctx.res, e.status || 500, e.message, e.detail || null); }
  }, { summary: 'All five interfaces evaluated for one listing, with plain-language explanations' });

  router.post('/api/models/:name', (ctx) => {
    try {
      const name = ctx.params.name;
      if (!models.INTERFACES[name]) return fail(ctx.res, 404, `unknown model interface: ${name}`, { known: Object.keys(models.INTERFACES) });
      const listingId = ctx.body?.listingId || ctx.body?.listing_id || ctx.query.listing || null;
      if (listingId) session.scope(ctx, { listingId, what: `run ${name}` });
      return ok(ctx.res, models.call(name, {
        listingId,
        price: ctx.body?.price ?? null,
        mode: ctx.body?.mode ?? null,
        cluster: ctx.body?.cluster ?? null,
        opts: ctx.body?.opts || {},
      }));
    } catch (e) { return fail(ctx.res, e.status || 500, e.message, e.detail || null); }
  }, { summary: 'Call one model interface: { listingId, price?, mode?, cluster? }' });
}

const CONTRACTS = {
  predictDemand: { input: '(listing features, price) -> orders/day', output: 'orders_per_day, cod/prepaid mix', replaceWith: 'served demand model (GBM or hierarchical elasticity)' },
  estimateReturnRisk: { input: '(SKU features, cluster, seller signals) -> risk', output: 'pReturn, pRto, band, drivers', replaceWith: 'per-SKU return-risk model on own order-level reason codes' },
  estimateKeepProbability: { input: '(SKU features, pincode cluster) -> probability', output: 'keepProbability, which price to show first', replaceWith: 'same logistic with fitted coefficients' },
  classifyLifecycle: { input: '(listing age, trend, stock, sell-through) -> stage', output: 'stage, window, why', replaceWith: 'hazard/survival model over comparable SKUs' },
  recommendPrice: { input: '(listing, mode, constraints) -> card', output: 'from, to, kind, why, confidence', replaceWith: 'contextual bandit policy (in-repo constrained Thompson sampler is the stand-in)' },
};
