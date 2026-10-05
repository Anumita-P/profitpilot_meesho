/**
 * EVENT MODEL + INGESTION (phase 1).
 *
 * One event shape for everything that happens to a listing, whether it comes
 * from Meesho's own pipes (orders, RTO, returns, impressions), from the seller
 * panel (listing edits, price changes) or from ProfitPilot itself (a card was
 * shown, accepted, rejected, overridden).
 *
 *   {
 *     event_id, seller_id, listing_id, sku, event_type, timestamp,
 *     payload, source, correlation_id, [idempotency_key], ingested_at, seq
 *   }
 *
 * Three rules the layer enforces, because the whole closed loop depends on them:
 *
 *   1. VALIDATE - every type declares the payload fields it needs. An unknown or
 *      malformed event is rejected (400) instead of being stored half-formed.
 *   2. IDEMPOTENT - the same event (same `idempotency_key`, or the same
 *      natural key: type + listing + timestamp + amount) is never counted twice.
 *      A re-send returns the original event with `duplicate: true`.
 *   3. GUARDRAILED - a PRICE_CHANGED event that would put a listing below its
 *      return-adjusted floor is refused (409) unless it carries explicit Exit
 *      consent. Ingestion cannot be used to sneak around the hard floor.
 *
 * The append-only philosophy is preserved: ingested events are appended to the
 * business audit log, and the raw stream is kept in the store.
 */

import { SKUS, GUARDRAILS } from '../config/deck.js';
import {
  load, save, listing, logEvent, httpError,
} from '../store/db.js';
import { computeFloor } from '../engine/floor.js';
import { enumValue, number, object, text, timestamp, boolean, id as idRule } from '../http/validate.js';

/** The event vocabulary. `payload` documents what each type must carry. */
export const EVENT_TYPES = {
  ORDER_PLACED: {
    needs: ['units'],
    optional: ['orderValue', 'paymentMode', 'pincode', 'customerId'],
    effect: 'adds to placed/units/revenue-at-risk; COD share feeds the RTO prior',
  },
  ORDER_SHIPPED: { needs: [], optional: ['units', 'slabKg'], effect: 'adds to dispatched' },
  ORDER_DELIVERED: { needs: [], optional: ['units', 'orderValue'], effect: 'adds to delivered + recognized revenue' },
  ORDER_RETURNED: {
    needs: [], optional: ['units', 'reasonCode', 'orderValue', 'returnCost'],
    effect: 'adds to returned; reason codes feed the return-risk model',
  },
  ORDER_RTO: { needs: [], optional: ['units', 'orderValue', 'rtoCost'], effect: 'adds to RTO (undelivered refusals)' },
  ORDER_CANCELLED: { needs: [], optional: ['units', 'reason'] , effect: 'adds to cancelled pre-dispatch' },
  INVENTORY_UPDATED: { needs: ['units'], optional: ['leadTimeDays'], effect: 'stock on hand -> days of inventory (DOI)' },
  PRICE_CHANGED: {
    needs: ['to'],
    optional: ['from', 'reason', 'consent', 'decisionId', 'recommendationId'],
    effect: 'the live price itself; below-floor changes need Exit consent or are refused',
  },
  LISTING_UPDATED: { needs: [], optional: ['title', 'images', 'attributes', 'category'], effect: 'content edits: title, images, attributes (never the price)' },
  VIEW_RECORDED: { needs: ['views'], optional: ['clicks', 'impressions'], effect: 'impressions/clicks -> CTR, CVR and demand features' },
  RECOMMENDATION_SHOWN: { needs: ['recommendation_id'], optional: ['surface'], effect: 'lifecycle: GENERATED -> SHOWN' },
  RECOMMENDATION_ACCEPTED: { needs: ['recommendation_id'], optional: ['mode'], effect: 'lifecycle: SHOWN -> ACCEPTED' },
  RECOMMENDATION_REJECTED: { needs: ['recommendation_id'], optional: ['note'], effect: 'lifecycle: SHOWN -> REJECTED' },
  RECOMMENDATION_OVERRIDDEN: { needs: ['recommendation_id'], optional: ['to', 'note'], effect: 'lifecycle: SHOWN -> OVERRIDDEN (logged as an override, never trusted as a win)' },
};

export const EVENT_TYPE_LIST = Object.keys(EVENT_TYPES);
const SOURCES = ['meesho_pipe', 'seller_panel', 'profitpilot', 'simulator', 'scheduler', 'api', 'demo'];

/* ------------------------------- validation ------------------------------- */

function validatePayload(type, payload = {}) {
  const spec = EVENT_TYPES[type];
  const out = {};
  for (const field of spec.needs) {
    /* An ORDER cannot have zero units; INVENTORY_UPDATED legitimately can: stock
       on hand reaches 0, and "0 in stock" is a fact the pipeline must accept. */
    if (field === 'units') out.units = number(payload.units, 'payload.units', { min: type === 'INVENTORY_UPDATED' ? 0 : 1, max: 10000 });
    else if (field === 'views') out.views = number(payload.views, 'payload.views', { min: 0, max: 10_000_000 });
    else if (field === 'to') out.to = number(payload.to, 'payload.to', { min: 1, max: 1_000_000 });
    else if (field === 'units_optional') out[field] = number(payload[field], `payload.${field}`, { min: 0, max: 10000, required: false });
    else if (field.endsWith('_id') || field === 'reasonCode' || field === 'note' || field === 'reason') out[field] = text(payload[field], `payload.${field}`, { maxLength: 200 });
    else out[field] = payload[field];
  }
  for (const field of spec.optional) {
    const v = payload[field];
    if (v === undefined || v === null || v === '') continue;
    if (['units', 'views', 'clicks', 'orderValue', 'returnCost', 'rtoCost', 'slabKg', 'from', 'to', 'leadTimeDays'].includes(field)) {
      out[field] = number(v, `payload.${field}`, { min: 0, max: 10_000_000 });
    } else if (field === 'consent') {
      out.consent = boolean(v, 'payload.consent');
    } else if (field === 'images') {
      out.images = Array.isArray(v) ? v.slice(0, 20).map((x) => String(x).slice(0, 300)) : throw400('payload.images must be an array');
    } else if (field === 'attributes') {
      out.attributes = object(v, 'payload.attributes');
    } else {
      out[field] = String(v).slice(0, 300);
    }
  }
  return out;
}

function throw400(message) { throw httpError(400, message); }

/* -------------------------------- ingestion ------------------------------- */

/**
 * Dedupe rule, deliberately explicit:
 *   - an explicit `idempotency_key` always wins (pipes that retry should send one);
 *   - otherwise a natural key is built from the caller's *explicit* timestamp
 *     (Meesho's own pipelines do send one) - the same fact re-pushed with the
 *     same timestamp is the same event;
 *   - an event with no timestamp is auto-stamped and treated as a NEW fact.
 *     Guessing "this looks like a duplicate" from payload shape alone would
 *     silently drop two genuinely identical orders.
 */
function naturalKey(type, sellerId, listingId, payload, ts, explicitTs) {
  const amount = payload.units ?? payload.views ?? payload.to ?? payload.recommendation_id ?? '';
  return explicitTs ? `${type}|${sellerId}|${listingId}|${ts}|${amount}` : null;
}

function hashOf(obj) {
  const s = JSON.stringify(obj);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

/**
 * Ingest one event.
 * @param {object} input  { event_type, listing_id|sku, payload, source, timestamp, correlation_id, idempotency_key }
 * @param {object} ctx    { sellerId, source, correlationId, actor }
 * @returns {{ event: object, duplicate: boolean, applied: object|null }}
 */
export function ingest(input = {}, ctx = {}) {
  const d = load();
  const eventType = enumValue(input.event_type ?? input.type, 'event_type', EVENT_TYPE_LIST);
  const sellerId = idRule(input.seller_id ?? ctx.sellerId, 'seller_id');

  const rawListingId = input.listing_id ?? input.listingId;
  const skuKey = input.sku ?? input.sku_key;
  let target = null;
  if (rawListingId) {
    target = listing(idRule(rawListingId, 'listing_id'));
  } else if (skuKey) {
    const key = String(skuKey).toLowerCase();
    if (!SKUS[key]) throw httpError(400, `unknown sku: ${skuKey}`);
    target = Object.values(d.listings).find((l) => l.sellerId === sellerId && l.skuKey === key) || null;
    if (!target) throw httpError(404, `no listing for sku ${key} under ${sellerId}`);
  } else {
    // seller-level events (e.g. a session or an aggregate push) are allowed for a few types
    const sellerLevel = ['VIEW_RECORDED'].includes(eventType) ? false : true;
    if (!sellerLevel) throw httpError(400, 'listing_id or sku is required for this event type');
  }

  if (target && target.sellerId !== sellerId && !ctx.admin) {
    throw httpError(403, `listing ${target.id} does not belong to ${sellerId}`);
  }

  const payload = validatePayload(eventType, input.payload || input || {});
  const explicitTs = input.timestamp ?? input.ts ?? null;
  const ts = timestamp(explicitTs, 'timestamp', { dflt: null }) || new Date().toISOString();
  const source = enumValue(input.source ?? ctx.source ?? 'api', 'source', SOURCES);
  const idempotencyKey = input.idempotency_key ?? input.idempotencyKey
    ?? naturalKey(eventType, sellerId, target ? target.id : '-', payload, ts, explicitTs)
    ?? `auto-${hashOf({ eventType, sellerId, ts, payload, n: (d.counters.events || 0) })}`;
  const correlationId = input.correlation_id ?? input.correlationId ?? ctx.correlationId ?? `cor-${hashOf({ eventType, sellerId, ts })}`;

  /* idempotency: same key + same content -> return the original, do not double count */
  d.ingestedIndex ||= {};
  if (Object.keys(d.ingestedIndex).length > 5000) {
    const keep = (d.ingestedEvents || []).slice(-4000).map((e) => e.idempotency_key);
    d.ingestedIndex = Object.fromEntries(Object.entries(d.ingestedIndex).filter(([k]) => keep.includes(k)));
  }
  const existingId = d.ingestedIndex[idempotencyKey];
  if (existingId) {
    const existing = d.ingestedEvents.find((e) => e.event_id === existingId);
    const same = existing && hashOf(existing.payload) === hashOf(payload);
    if (same) return { event: existing, duplicate: true, applied: null };
    throw httpError(409, `idempotency_key ${idempotencyKey} was already used with a different payload`, { event_id: existingId });
  }

  const seq = (d.counters.events || 0) + 1;
  const event = {
    event_id: `EVT-${String(seq).padStart(6, '0')}`,
    seq,
    seller_id: sellerId,
    listing_id: target ? target.id : null,
    sku: target ? target.skuKey : (skuKey ? String(skuKey).toLowerCase() : null),
    event_type: eventType,
    timestamp: ts,
    payload,
    source,
    correlation_id: correlationId,
    idempotency_key: idempotencyKey,
    ingested_at: new Date().toISOString(),
    actor: ctx.actor || 'api',
  };

  /* Apply FIRST: if the event is refused (a below-floor price change), nothing
     is stored - a blocked action must not leave a half-applied event behind.
     The refusal itself is audited inside applyPriceEvent(). */
  const applied = applyEvent(event, target, ctx);

  d.counters.events = seq;
  d.ingestedEvents.push(event);
  if (d.ingestedEvents.length > 5000) d.ingestedEvents = d.ingestedEvents.slice(-4000);
  d.ingestedIndex[idempotencyKey] = event.event_id;

  logEvent('event.ingested', {
    eventId: event.event_id, eventType, sellerId, listingId: event.listing_id,
    sku: event.sku, source, correlationId, duplicate: false,
  });
  save();
  return { event, duplicate: false, applied };
}

/** Ingest many, atomically enough for a demo: all-or-nothing validation. */
export function ingestBatch(list, ctx = {}) {
  if (!Array.isArray(list)) throw httpError(400, 'events must be an array');
  if (list.length > 500) throw httpError(400, 'at most 500 events per batch');
  const results = list.map((e) => ingest(e, ctx));
  return {
    count: results.length,
    created: results.filter((r) => !r.duplicate).length,
    duplicates: results.filter((r) => r.duplicate).length,
    events: results.map((r) => r.event),
    applied: results.map((r) => r.applied).filter(Boolean),
  };
}

/* ------------------------- event -> features (FEATURES) ------------------- */

/**
 * Apply an event to the listing's observed features. This is the FEATURES layer
 * being updated by DATA - the same counters the outcome calculator reads.
 */
function applyEvent(event, target, ctx) {
  if (!target) return { kind: 'none', reason: 'seller-level event' };
  const L = target;
  L.observed ||= {
    since: null, views: 0, clicks: 0, placed: 0, shipped: 0, delivered: 0,
    returned: 0, rto: 0, cancelled: 0, units: 0, revenue: 0,
    returnCost: 0, rtoCost: 0, reasonCodes: {},
  };
  const o = L.observed;
  o.since ||= event.timestamp;
  const p = event.payload;

  switch (event.event_type) {
    case 'VIEW_RECORDED':
      o.views += p.views;
      if (p.clicks != null) o.clicks += p.clicks;
      break;
    case 'ORDER_PLACED':
      o.placed += 1;
      o.units += p.units;
      break;
    case 'ORDER_SHIPPED':
      o.shipped += 1;
      break;
    case 'ORDER_DELIVERED':
      o.delivered += 1;
      o.revenue += (p.orderValue != null ? p.orderValue : L.price) * (p.units || 1);
      break;
    case 'ORDER_RETURNED':
      o.returned += 1;
      o.returnCost += p.returnCost != null ? p.returnCost : 0;
      if (p.reasonCode) o.reasonCodes[p.reasonCode] = (o.reasonCodes[p.reasonCode] || 0) + 1;
      break;
    case 'ORDER_RTO':
      o.rto += 1;
      o.rtoCost += p.rtoCost != null ? p.rtoCost : 0;
      break;
    case 'ORDER_CANCELLED':
      o.cancelled += 1;
      break;
    case 'INVENTORY_UPDATED':
      L.stock = { ...(L.stock || {}), units: p.units, ...(p.leadTimeDays ? { leadTimeDays: p.leadTimeDays } : {}) };
      break;
    case 'LISTING_UPDATED':
      L.content = { ...(L.content || {}), ...(p.title ? { title: p.title } : {}), ...(p.images ? { images: p.images } : {}), ...(p.attributes ? { attributes: p.attributes } : {}), updatedAt: event.timestamp };
      break;
    case 'PRICE_CHANGED':
      return applyPriceEvent(L, event, ctx);
    default:
      return { kind: 'informational', event_type: event.event_type };
  }

  refreshSignalsFromObserved(L);
  save();
  return { kind: 'features', listing_id: L.id, observed: o };
}

/**
 * A price change arriving as an event is still a price change: it goes through
 * the floor check. Below-floor changes need Exit consent (the same rule the
 * publish route applies) - ingestion cannot bypass the hard floor.
 */
function applyPriceEvent(L, event, ctx) {
  const p = event.payload;
  const floor = computeFloor(L.skuKey, L.costOverrides || {});
  const below = p.to < floor.F;
  const consent = !!p.consent && (L.stage === 'exit' || ctx.consent === true);
  const acknowledge = ctx.acknowledgeLossWarning === true;
  if (below && !consent && !acknowledge) {
    logEvent('guardrail.blocked', {
      listingId: L.id, via: 'event.ingest', eventType: 'PRICE_CHANGED',
      price: p.to, floor: floor.F, lossPerKeptOrder: Math.round(p.to - floor.F),
      reason: 'below the return-adjusted floor without Exit consent',
    });
    save();
    throw httpError(409, 'PRICE_CHANGED refused: the price is below the return-adjusted floor', {
      price: p.to, floor: floor.F,
      lossPerKeptOrder: Math.round(p.to - floor.F),
      sellerLine: `₹${p.to} loses ₹${Math.abs(Math.round(p.to - floor.F))} per kept order.`,
      rule: 'hard floor: no route, job or event may publish below F without explicit Exit consent',
    });
  }
  const from = p.from != null ? p.from : L.price;
  L.price = Math.round(p.to);
  L.daysSinceMove = 0;
  L.movesThisMonth = (L.movesThisMonth || 0) + 1;
  L.priceHistory = [...(L.priceHistory || []), {
    ts: event.timestamp, price: L.price,
    reason: p.reason || 'price change ingested as an event',
    decisionId: p.decisionId || null, recommendationId: p.recommendationId || null,
  }];
  save();
  return { kind: 'price', listing_id: L.id, from, to: L.price, consent, belowFloor: below };
}

/**
 * Fold observed events into the signals the models read, so a new
 * recommendation always sees what actually happened - not the seed values.
 * Only signals with real observations are touched.
 */
export function refreshSignalsFromObserved(L, overrides = {}) {
  const o = L.observed;
  if (!o) return L.signals;
  const s = L.signals;
  /* Optional overrides. The simulator knows things a plain event fold cannot see:
     how the scenario says this seller behaves on returns/RTO, and how much real
     traffic a scenario actually represents once its day loop is scaled down. These
     are ANALYSIS-time values only - they never write to the event log. */
  const w = overrides.weightOverrides || null;
  if (o.views > 0) {
    s.views = o.views;
    if (o.clicks > 0) {
      s.clicks = o.clicks;
      s.ctr = Math.round(o.clicks / o.views * 1000) / 10;
    }
  }
  const dispatched = o.shipped || o.delivered + o.returned + o.rto;
  if (dispatched > 0) {
    s.returnsPct = Math.round(o.returned / dispatched * 1000) / 10;
    s.rtoPct = Math.round(o.rto / dispatched * 1000) / 10;
    s.keptRatePct = Math.round((dispatched - o.returned - o.rto) / dispatched * 1000) / 10;
  }
  const placed = o.placed || o.delivered + o.rto + o.cancelled;
  if (placed > 0 && o.views > 0) s.cvr = Math.round(placed / o.views * 1000) / 10;
  if (L.stock && L.stock.dailyUnits) {
    s.doi = Math.max(0, Math.round(L.stock.units / L.stock.dailyUnits));
  }
  /* a scenario may state that THIS seller's returns and RTO are structurally high.
     Blend that in rather than letting the random draw decide. */
  if (w) {
    const blend = (current, intended) => intended == null ? current
      : current == null ? intended
        : Math.round((current * (1 - (w.weight ?? 0.5)) + intended * (w.weight ?? 0.5)) * 10) / 10;
    if (w.returnsPct != null) s.returnsPct = blend(s.returnsPct, w.returnsPct);
    if (w.rtoPct != null) s.rtoPct = blend(s.rtoPct, w.rtoPct);
  }
  /* how much real traffic does this scenario represent? The day loop emits a
     scaled slice of the funnel, so the listing signals are scaled back up. */
  if (overrides.views != null && overrides.views > 0) {
    s.views = overrides.views;
    if (s.ctr != null) s.clicks = Math.round(s.views * s.ctr / 100);
  }
  save();
  return s;
}

/* --------------------------------- queries -------------------------------- */

/**
 * Rebuild the observed feature fold for one listing from scratch.
 *
 * `observed` is a cumulative fold (applyEvent adds to it), so removing events
 * cannot simply subtract. This replays whatever events remain, in sequence order,
 * through the SAME fold the ingest path uses - one code path, no second opinion.
 * Used by the scenario lab's reset so a re-run starts from the same place.
 */
export function rebuildObserved(listingId) {
  const d = load();
  const L = d.listings[listingId];
  if (!L) throw httpError(404, `unknown listing: ${listingId}`);
  delete L.observed;
  const rows = (d.ingestedEvents || [])
    .filter((e) => e.listing_id === listingId)
    .sort((a, b) => (a.seq || 0) - (b.seq || 0));
  for (const e of rows) applyEvent(e, L, {});
  save();
  return L.observed || null;
}

/**
 * Remove events from the pipeline (the scenario lab's reset). Events are addressed
 * by exact event_id - never by a filter that might catch a neighbour's history -
 * and their idempotency keys are released so the same event can be ingested again
 * on the next run.
 */
export function removeEvents({ ids = [], listingId = null, releaseKeysFor = null, reason = null } = {}) {
  const d = load();
  const wanted = new Set(ids);
  if (!wanted.size && !releaseKeysFor) return 0;
  const before = (d.ingestedEvents || []).length;
  const keep = [];
  let removed = 0;
  for (const e of d.ingestedEvents || []) {
    const match = wanted.has(e.event_id) && (!listingId || e.listing_id === listingId);
    if (match) {
      removed += 1;
      if (d.ingestedIndex && e.idempotency_key) delete d.ingestedIndex[e.idempotency_key];
    } else keep.push(e);
  }
  /* The dedupe index must be released too, and NOT only for the records we removed:
     the ingest ring is capped (5000 -> slice(-4000)), so a record can be trimmed
     while its natural key stays in the index. Left behind, that key refuses the
     next simulator run that legitimately wants the same (type, timestamp) slot.
     `releaseKeysFor` frees every index entry that names this listing. */
  let releasedKeys = 0;
  if (releaseKeysFor && d.ingestedIndex) {
    const needle = `|${releaseKeysFor}|`;
    for (const k of Object.keys(d.ingestedIndex)) {
      if (k.includes(needle)) { delete d.ingestedIndex[k]; releasedKeys += 1; }
    }
  }
  d.ingestedEvents = keep;
  save();
  logEvent('events.removed', { count: removed, of: before, listingId, releasedKeys, reason: reason || 'scenario lab reset', at: new Date().toISOString() });
  save();
  return removed;
}

export function listEvents(filter = {}) {
  const d = load();
  let all = d.ingestedEvents || [];
  if (filter.sellerId) all = all.filter((e) => e.seller_id === filter.sellerId);
  if (filter.listingId) all = all.filter((e) => e.listing_id === filter.listingId);
  if (filter.sku) all = all.filter((e) => e.sku === filter.sku);
  if (filter.type) {
    const types = Array.isArray(filter.type) ? filter.type : [filter.type];
    all = all.filter((e) => types.includes(e.event_type));
  }
  if (filter.correlationId) all = all.filter((e) => e.correlation_id === filter.correlationId);
  if (filter.from) all = all.filter((e) => e.timestamp >= filter.from);
  if (filter.to) all = all.filter((e) => e.timestamp <= filter.to);
  const limit = filter.limit ?? 100;
  return all.slice(-limit).reverse();
}

/** Count of every event type in the stream (used by /api/metrics). */
export function eventTypeCounts(filter = {}) {
  const all = listEvents({ ...filter, limit: 100000 });
  return all.reduce((acc, e) => {
    acc[e.event_type] = (acc[e.event_type] || 0) + 1;
    return acc;
  }, {});
}

export function eventById(id) {
  const e = (load().ingestedEvents || []).find((x) => x.event_id === id);
  if (!e) throw httpError(404, `unknown event: ${id}`);
  return e;
}

export const SOURCE_LIST = SOURCES;
export const EVENT_COUNT = EVENT_TYPE_LIST.length;
export const GUARDRAIL_NOTE = `PRICE_CHANGED events are checked against the floor (${GUARDRAILS.hardFloor ? 'hard floor ON' : 'off'}) exactly like the publish route.`;
