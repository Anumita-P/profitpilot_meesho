/**
 * RECOMMENDATION LIFECYCLE + OUTCOME API (phases 1-2 surface, phase 6 wiring).
 *
 * The existing seller-facing routes are untouched: GET
 * /api/listings/:id/recommendation still returns the engine card, POST
 * /api/listings/:id/decisions still records the tap, /api/undo still reverses.
 * What is added here is the PERSISTENT machine around them: a recommendation
 * record with a full state history, an observation window, an outcome judged by
 * the deterministic outcome calculator, and a generate-measure loop that the
 * scheduler drives.
 */

import { ok, fail } from '../http/respond.js';
import { hydrate, listing, listings, decisions, updateDecision, decision, logEvent, httpError } from '../store/db.js';
import { recommendPrice as recommendPriceModel } from '../models/interfaces.js';
import * as recs from '../domain/recommendations.js';
import * as outcomes from '../domain/outcomes.js';
import * as trust from '../domain/trust.js';
import * as session from '../http/session.js';
import { ingestBatch } from '../domain/events.js';

export function register(router) {
  /* ------------------------------ state machine --------------------------- */
  router.get('/api/lifecycle/states', () => ({
    states: recs.STATES,
    transitions: recs.TRANSITIONS,
    open_states: recs.OPEN_STATES,
    observation: recs.OBSERVATION,
    outcome_model: {
      primary_metric: outcomes.PRIMARY_METRIC,
      primary_metric_label: outcomes.PRIMARY_METRIC_LABEL,
      win_threshold_pct: outcomes.WIN_THRESHOLD_PCT,
      min_evidence: outcomes.MIN_EVIDENCE,
      quality_guardrails: outcomes.QUALITY_GUARDRAILS,
      note: 'The primary metric is contribution per kept order (kept-order economics), never revenue.',
    },
    rule: 'every status change is written to the recommendation history, the audit trail and the event stream',
  }), { summary: 'The 13-state recommendation machine and the outcome model it feeds' });

  /* --------------------------- generate / list --------------------------- */
  router.get('/api/lifecycle/recommendations', (ctx) => {
    try {
      const sellerId = session.scopedSeller(ctx, ctx.query.seller || null);
      const rows = recs.list({
        sellerId,
        listingId: ctx.query.listing || null,
        status: ctx.query.status ? String(ctx.query.status).split(',') : null,
        openOnly: ctx.flag('open', false),
      }).slice(0, Math.min(500, Number(ctx.query.limit || 100)));
      return ok(ctx.res, { recommendations: rows, counts: recs.counts({ sellerId }) });
    } catch (e) { return fail(ctx.res, e.status || 500, e.message, e.detail || null); }
  }, { summary: 'Persistent recommendations, newest first (filter by listing, status, open)' });

  router.get('/api/lifecycle/recommendations/:id', (ctx) => {
    try {
      const rec = recs.get(ctx.params.id);
      session.scope(ctx, { sellerId: rec.seller_id, what: 'read this recommendation' });
      return ok(ctx.res, { recommendation: rec, explain: recs.explain(rec.recommendation_id) });
    } catch (e) { return fail(ctx.res, e.status || 500, e.message, e.detail || null); }
  }, { summary: 'One recommendation with its full history and a plain-language explain()' });

  /**
   * Turn the engine card the seller is looking at into a persistent
   * recommendation record. The card itself still comes from the untouched
   * recommend() engine, so parity is preserved: this only stores it.
   */
  router.post('/api/lifecycle/listings/:id/generate', (ctx) => {
    try {
      session.scope(ctx, { listingId: ctx.params.id, what: 'generate a recommendation' });
      const raw = listing(ctx.params.id);
      const view = hydrate(raw);
      const mode = ctx.body?.mode || view.mode || 'growth';
      // Through the formal model interface (same engine underneath): the loop
      // should call models, not reach into engine internals.
      const card = recommendPriceModel(view, { mode }).output;
      const generated = recs.generate({
        cardId: `${view.id}:${mode}:${card.to}`,
        kind: card.kind || (card.to > raw.price ? 'price_up' : card.to < raw.price ? 'price_down' : 'hold'),
        from: card.from, to: card.to,
        headline: card.headline || card.why || null,
        what: card.why || card.headline || null,
        effect: card.effect || null,
        confidence: card.confidence || null,
      }, {
        listingId: view.id,
        listing: view,
        mode,
        reason: ctx.body?.reason || 'generated from the engine recommendation card',
        guardrail: card.guardrail || null,
        actor: ctx.identity?.session_id || 'api',
        source: 'api',
        correlationId: ctx.correlation_id,
      });
      return ok(ctx.res, {
        recommendation: generated.recommendation,
        reused: generated.reused,
        card: { from: card.from, to: card.to, kind: card.kind, headline: card.headline, confidence: card.confidence },
        note: generated.reused
          ? 'an open recommendation for this listing + mode + card already existed: reused, not duplicated'
          : 'stored: the card now has a lifecycle the scheduler can observe',
      });
    } catch (e) { return fail(ctx.res, e.status || 500, e.message, e.detail || null); }
  }, { summary: 'Store the current engine card as a persistent recommendation (idempotent per card)' });

  /* ------------------------------- transitions --------------------------- */
  const VERBS = {
    shown: (ctx, id) => recs.markShown(id, { by: 'api', note: ctx.body?.note || 'returned to the seller' }),
    decision: (ctx, id) => recs.markDecision(id, ctx.body?.decision, {
      note: ctx.body?.note || null, decision_id: ctx.body?.decision_id || null, by: ctx.body?.by || 'seller',
    }),
    apply: (ctx, id) => recs.markApplied(id, {
      price: ctx.body?.price != null ? Number(ctx.body.price) : null,
      by: ctx.body?.by || 'seller', decision_id: ctx.body?.decision_id || null, verified: ctx.body?.verified ?? null,
    }),
    sample: (ctx, id) => recs.addSample(id, ctx.body?.sample || { at: new Date().toISOString() }),
    outcome: (ctx, id) => recs.markOutcome(id, {
      verdict: ctx.body?.verdict, outcome: ctx.body?.outcome || null, trust: ctx.body?.trust || null,
    }),
    retain: (ctx, id) => recs.markRetained(id, { by: ctx.body?.by || 'seller' }),
    revert: (ctx, id) => recs.markReverted(id, {
      by: ctx.body?.by || 'seller', reason: ctx.body?.reason || null,
      restoredPrice: ctx.body?.restoredPrice != null ? Number(ctx.body.restoredPrice) : null,
    }),
    block: (ctx, id) => recs.markBlocked(id, { blocking: ctx.body?.blocking || [], checks: ctx.body?.checks || [], by: ctx.body?.by || 'api' }),
  };

  router.post('/api/lifecycle/recommendations/:id/:verb', (ctx) => {
    try {
      const { id, verb } = ctx.params;
      const fn = VERBS[verb];
      if (!fn) return fail(ctx.res, 404, `unknown lifecycle verb "${verb}"`, { known: Object.keys(VERBS) });
      const rec = recs.get(id);
      session.scope(ctx, { sellerId: rec.seller_id, what: `move recommendation ${id}` });
      const before = rec.status;
      const updated = fn(ctx, id);
      logEvent('recommendation.transition', {
        recommendationId: id, verb, from: before, to: updated.status,
        listingId: updated.listing_id, actor: ctx.identity?.session_id || 'api',
        correlationId: ctx.correlation_id,
      });
      return ok(ctx.res, { recommendation: updated, transition: { from: before, to: updated.status, verb } });
    } catch (e) { return fail(ctx.res, e.status || 500, e.message, e.detail || null); }
  }, { summary: 'Move a recommendation: shown | decision | apply | sample | outcome | retain | revert | block (invalid moves are 409 with the allowed list)' });

  /* --------------------------------- outcome ----------------------------- */
  router.get('/api/lifecycle/listings/:id/metrics', (ctx) => {
    try {
      session.scope(ctx, { listingId: ctx.params.id, what: 'read metrics' });
      const days = Math.min(180, Number(ctx.query.days || 14));
      const after = outcomes.metricsFor(ctx.params.id, { days });
      const before = outcomes.baselineFor(ctx.params.id, after.window, { price: ctx.num('atPrice', null) });
      const cmp = outcomes.compare(after, before);
      return ok(ctx.res, {
        metrics: after,
        baseline: before,
        comparison: cmp,
        quality: outcomes.qualityVerdict(after, before),
        primary_metric: outcomes.PRIMARY_METRIC_LABEL,
        note: 'Deterministic arithmetic over ingested events. Where the baseline is modelled it is labelled as such.',
      });
    } catch (e) { return fail(ctx.res, e.status || 500, e.message, e.detail || null); }
  }, { summary: 'Deterministic metrics for a listing window + its baseline and comparison' });

  router.post('/api/lifecycle/recommendations/:id/measure', (ctx) => {
    try {
      const rec = recs.get(ctx.params.id);
      session.scope(ctx, { sellerId: rec.seller_id, what: 'measure this recommendation' });
      const outcome = outcomes.computeOutcome({
        recommendation: rec,
        window: ctx.body?.window || null,
        requireEvidence: ctx.body?.requireEvidence || outcomes.MIN_EVIDENCE,
      });
      if (outcome.insufficient) {
        return ok(ctx.res, { measured: false, outcome, note: 'no verdict was recorded: the window does not have enough evidence yet' });
      }
      const stored = outcomes.recordOutcome(rec.recommendation_id, outcome, { at: ctx.body?.at || null });
      return ok(ctx.res, { measured: true, outcome, stored });
    } catch (e) { return fail(ctx.res, e.status || 500, e.message, e.detail || null); }
  }, { summary: 'Compute (and only then record) an outcome: refuses a verdict without evidence' });

  router.get('/api/lifecycle/outcomes', (ctx) => {
    try {
      const sellerId = session.scopedSeller(ctx, ctx.query.seller || null);
      return ok(ctx.res, { outcomes: outcomes.outcomes({ sellerId, listingId: ctx.query.listing || null }).slice(0, 200) });
    } catch (e) { return fail(ctx.res, e.status || 500, e.message, e.detail || null); }
  }, { summary: 'Recorded outcomes (verdicts that had evidence)' });

  /* ------------------------- UI-facing state summary -------------------- */
  router.get('/api/lifecycle/listings/:id/state', (ctx) => {
    try {
      session.scope(ctx, { listingId: ctx.params.id, what: 'read loop state' });
      const raw = listing(ctx.params.id);
      const view = hydrate(raw);
      const open = recs.openFor(view.id);
      const all = recs.list({ listingId: view.id });
      const latest = all[0] || null;
      const outcomesForListing = outcomes.outcomes({ listingId: view.id });
      return ok(ctx.res, {
        listing: {
          id: view.id, sku: view.skuKey, price: raw.price, floor: view.floor.F,
          mode: view.mode, stage: view.stage, health: view.health,
          daysSinceMove: raw.daysSinceMove ?? null, movesThisMonth: raw.movesThisMonth ?? 0,
        },
        open_recommendation: open ? {
          recommendation_id: open.recommendation_id, status: open.status, kind: open.kind,
          from: open.price_before, to: open.price_proposed,
          observation: open.observation, outcome: open.outcome, history: open.history.slice(-5),
        } : null,
        latest_recommendation: latest ? { recommendation_id: latest.recommendation_id, status: latest.status, outcome: latest.outcome || null } : null,
        observations: all.filter((r) => r.observation?.samples?.length).slice(0, 5).map((r) => ({
          recommendation_id: r.recommendation_id, status: r.status, samples: r.observation.samples.slice(-3), judgeAt: r.observation.judgeAt,
        })),
        outcomes: outcomesForListing.slice(0, 5),
        trust: trust.computedTrust(view.sellerId),
        note: 'One call for the UI bridge: what the loop currently knows about this listing.',
      });
    } catch (e) { return fail(ctx.res, e.status || 500, e.message, e.detail || null); }
  }, { summary: 'UI bridge state: open recommendation, observation, outcomes, trust for one listing' });

  /* --------------------------- legacy convenience ----------------------- */
  router.get('/api/lifecycle/summary', (ctx) => {
    try {
      const sellerId = session.scopedSeller(ctx, ctx.query.seller || null);
      const counts = recs.counts({ sellerId });
      const out = outcomes.outcomes({ sellerId });
      return ok(ctx.res, {
        counts,
        outcomes: {
          total: out.length,
          wins: out.filter((o) => o.verdict === 'WIN').length,
          neutral: out.filter((o) => o.verdict === 'NEUTRAL').length,
          losses: out.filter((o) => o.verdict === 'LOSS').length,
        },
        trust: trust.computedTrust(sellerId),
        decisions_recorded: decisions().filter((dec) => (listings(sellerId).some((l) => l.id === dec.listingId))).length,
        note: 'The engine decision log (decisions) and the closed-loop record (recommendations) are both kept: the prototype route still works unchanged.',
      });
    } catch (e) { return fail(ctx.res, e.status || 500, e.message, e.detail || null); }
  }, { summary: 'Loop health for a seller: recommendation counts, outcome mix, trust' });

  router.post('/api/lifecycle/listings/:id/observe', (ctx) => {
    try {
      session.scope(ctx, { listingId: ctx.params.id, what: 'observe a decision' });
      const decisionId = ctx.body?.decision_id || null;
      if (!decisionId) return fail(ctx.res, 400, 'decision_id is required', { field: 'decision_id' });
      const dec = decision(decisionId);
      const updated = updateDecision(decisionId, {
        observed: {
          at: new Date().toISOString(),
          ...(ctx.body?.observed || {}),
        },
      }, 'decision.observed', { listingId: ctx.params.id, decisionId });
      return ok(ctx.res, { decision: updated, note: 'the legacy /observe path is unchanged; this mirrors it into the closed-loop event stream when you send events too' });
    } catch (e) { return fail(ctx.res, e.status || 500, e.message, e.detail || null); }
  }, { summary: 'Extend the legacy observe step without changing POST /api/decisions/:id/observe' });

  /* ingest helper so a caller can push a whole observation window in one call */
  router.post('/api/lifecycle/listings/:id/window', (ctx) => {
    try {
      session.scope(ctx, { listingId: ctx.params.id, what: 'push an observation window' });
      const list = Array.isArray(ctx.body?.events) ? ctx.body.events : [];
      if (!list.length) return fail(ctx.res, 400, 'events[] is required', { field: 'events' });
      const result = ingestBatch(list, { sellerId: ctx.identity.seller_id, actor: 'api:window', source: ctx.body?.source || 'api' });
      return ok(ctx.res, { ingested: result, note: 'after this lands, POST /api/jobs/run { kind: observe } will judge the window' });
    } catch (e) { return fail(ctx.res, e.status || 500, e.message, e.detail || null); }
  }, { summary: 'Push an observation window for a listing in one call' });
}
