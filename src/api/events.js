/**
 * EVENT INGESTION API (phase 1 surface, phase 6 wiring).
 *
 * The event stream is the only way observed reality enters the system. These
 * routes are a thin, seller-scoped shell around src/domain/events.js, which owns
 * the rules: 14 event types, per-type payload validation, natural-key
 * idempotency, and the rule that a below-floor PRICE_CHANGED without seller
 * consent is refused (409) and stores nothing.
 */

import { ok, fail } from '../http/respond.js';
import * as events from '../domain/events.js';
import * as session from '../http/session.js';
import { stats as dbStats } from '../store/db.js';
import { registerEventIngest } from '../domain/outcomes.js';

export function register(router) {
  // The simulator lives in the outcome module; it needs the event ingest
  // functions and cannot import them statically (module cycle), so the wiring
  // happens here, once, when the routes are mounted.
  registerEventIngest(events);

  /* ------------------------------- ingest ------------------------------- */
  router.post('/api/events', (ctx) => {
    try {
      const listingId = ctx.body?.listing_id || null;
      if (listingId) session.scope(ctx, { listingId, what: 'ingest events for this listing' });
      const result = events.ingest(ctx.body || {}, {
        sellerId: session.scopedSeller(ctx, ctx.body?.seller_id || null),
        actor: ctx.identity?.session_id || 'api',
        source: ctx.body?.source || (ctx.identity?.authenticated ? 'api' : 'demo'),
        correlationId: ctx.correlation_id,
      });
      return ok(ctx.res, { ...result, request_id: ctx.request_id });
    } catch (e) { return fail(ctx.res, e.status || 500, e.message, e.detail || null); }
  }, { summary: 'Ingest one event (validated, deduplicated on its natural key, floor-guarded)' });

  router.post('/api/events/batch', (ctx) => {
    try {
      const list = ctx.body?.events;
      if (!Array.isArray(list)) return fail(ctx.res, 400, 'events must be an array', { field: 'events' });
      const result = events.ingestBatch(list, {
        sellerId: session.scopedSeller(ctx, ctx.body?.seller_id || null),
        actor: ctx.identity?.session_id || 'api',
        source: ctx.body?.source || 'api',
        correlationId: ctx.correlation_id,
      });
      return ok(ctx.res, { ...result, request_id: ctx.request_id });
    } catch (e) { return fail(ctx.res, e.status || 500, e.message, e.detail || null); }
  }, { summary: 'Ingest a batch of events (max 500 per call; the demo simulator chunks its own)' });

  /* ------------------------------- queries ------------------------------ */
  router.get('/api/events/counts', (ctx) => {
    try {
      const sellerId = session.scopedSeller(ctx, ctx.query.seller || null);
      const listingId = ctx.query.listing || null;
      if (listingId) session.scope(ctx, { listingId, what: 'read events' });
      return ok(ctx.res, { counts: events.eventTypeCounts({ sellerId, listingId }), types: events.EVENT_TYPE_LIST.length });
    } catch (e) { return fail(ctx.res, e.status || 500, e.message, e.detail || null); }
  }, { summary: 'Event counts per type (the closed loop\'s raw material)' });

  router.get('/api/events/timeline', (ctx) => {
    try {
      const sellerId = session.scopedSeller(ctx, ctx.query.seller || null);
      const rows = events.listEvents({
        sellerId,
        listingId: ctx.query.listing || null,
        limit: Math.min(2000, Number(ctx.query.limit || 500)),
      });
      const byDay = {};
      for (const e of rows) {
        const day = String(e.timestamp).slice(0, 10);
        byDay[day] ||= { day, events: 0, types: {} };
        byDay[day].events++;
        byDay[day].types[e.event_type] = (byDay[day].types[e.event_type] || 0) + 1;
      }
      return ok(ctx.res, {
        days: Object.values(byDay).sort((a, b) => (a.day < b.day ? -1 : 1)),
        total: rows.length,
        types: events.EVENT_TYPE_LIST,
      });
    } catch (e) { return fail(ctx.res, e.status || 500, e.message, e.detail || null); }
  }, { summary: 'Events grouped by day, to see whether the loop is actually receiving data' });

  router.get('/api/events', (ctx) => {
    try {
      const sellerId = session.scopedSeller(ctx, ctx.query.seller || null);
      const listingId = ctx.query.listing || null;
      if (listingId) session.scope(ctx, { listingId, what: 'read events' });
      const rows = events.listEvents({
        sellerId,
        listingId,
        type: ctx.query.type || null,
        source: ctx.query.source || null,
        since: ctx.query.since || null,
        until: ctx.query.until || null,
        limit: Math.min(1000, Number(ctx.query.limit || 100)),
      });
      return ok(ctx.res, { events: rows, count: rows.length, rules: events.GUARDRAIL_NOTE });
    } catch (e) { return fail(ctx.res, e.status || 500, e.message, e.detail || null); }
  }, { summary: 'List ingested events (newest last; filter by listing, type, source, window)' });

  /* ------------------------------- simulator ---------------------------- */
  router.post('/api/events/simulate', (ctx) => {
    try {
      const listingId = ctx.body?.listing_id;
      if (!listingId) return fail(ctx.res, 400, 'listing_id is required', { field: 'listing_id' });
      session.scope(ctx, { listingId, what: 'simulate events for this listing' });
      // The simulator lives in the outcomes module (it needs the floor to price
      // returns); load it lazily so neither module has to import the other.
      return import('../domain/outcomes.js').then((outcomes) => ok(ctx.res, outcomes.simulateEventStream({
        listingId,
        from: ctx.body.from || null,
        days: Math.min(120, Number(ctx.body.days || 14)),
        seed: Number(ctx.body.seed || 7),
        ordersPerDayMultiplier: Number(ctx.body.ordersPerDayMultiplier || 1),
        returnRatePctDelta: Number(ctx.body.returnRatePctDelta || 0),
        rtoRatePctDelta: Number(ctx.body.rtoRatePctDelta || 0),
      }))).catch((e) => fail(ctx.res, e.status || 500, e.message, e.detail || null));
    } catch (e) { return fail(ctx.res, e.status || 500, e.message, e.detail || null); }
  }, { summary: 'SIMULATED: generate a deterministic event stream (labelled source=simulator) to close the loop' });

  /* ------------------------------ event types --------------------------- */
  router.get('/api/events/types', () => ({
    types: events.EVENT_TYPE_LIST,
    count: events.EVENT_COUNT,
    payload_rules: events.EVENT_TYPES,
    sources: events.SOURCE_LIST,
    envelope: ['event_id', 'seller_id', 'listing_id', 'event_type', 'timestamp', 'payload', 'source', 'correlation_id'],
    rule: events.GUARDRAIL_NOTE,
  }), { summary: 'The 14 event types, their payload rules and the envelope' });

  router.get('/api/events/stats', (ctx) => {
    try {
      const s = dbStats();
      return ok(ctx.res, { ingestedEvents: s.ingestedEvents, totals: events.eventTypeCounts({}), file: s.eventFile });
    } catch (e) { return fail(ctx.res, e.status || 500, e.message, e.detail || null); }
  }, { summary: 'How much event data this instance holds' });
  router.get('/api/events/:id', (ctx) => {
    try {
      const e = events.eventById(ctx.params.id);
      if (!e) return fail(ctx.res, 404, `unknown event: ${ctx.params.id}`);
      session.scope(ctx, { sellerId: e.seller_id, what: 'read this event' });
      return ok(ctx.res, { event: e });
    } catch (e2) { return fail(ctx.res, e2.status || 500, e2.message, e2.detail || null); }
  }, { summary: 'One event by event_id' });

}
