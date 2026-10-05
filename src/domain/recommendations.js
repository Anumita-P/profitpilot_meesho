/**
 * RECOMMENDATION LIFECYCLE (phase 1) - the spine of the closed loop.
 *
 *   GENERATED -> SHOWN -> ACCEPTED | REJECTED | OVERRIDDEN
 *   ACCEPTED  -> APPLIED -> OBSERVING -> WON | NEUTRAL | LOST
 *   WON       -> RETAINED
 *   any applied state -> REVERTED   (undo, auto-revert, or a failed verify)
 *   BLOCKED is terminal-ish: the guardrails refused the move, nothing changed.
 *
 * Every transition is validated. An invalid transition throws 409 with the
 * allowed next states, so a caller can never walk a recommendation into an
 * impossible state (for example: OBSERVING without ever being APPLIED, or WON
 * without an observation window).
 *
 * The record is deliberately fat: it keeps everything needed to RE-EXPLAIN the
 * decision later - the price before/after, the reason, the model/config
 * versions, the guardrail verdict, the decision, the timestamps, the
 * observation window and the outcome. That is what makes a historical
 * recommendation reproducible rather than a mystery (phase 7).
 *
 * This module does not compute economics and it does not bypass guardrails: it
 * stores what the engine and the guardrails decided.
 */

import { load, save, logEvent, httpError, listing } from '../store/db.js';
import { versionSet, explainVersions } from './versions.js';

export const STATES = [
  'GENERATED',    // the engine produced a card
  'SHOWN',        // the card reached the seller (or the API returned it)
  'ACCEPTED',     // the seller tapped YES
  'REJECTED',     // the seller tapped NO
  'OVERRIDDEN',   // the seller published something else; logged, never counted as a win
  'BLOCKED',      // the guardrails refused it; nothing changed
  'APPLIED',      // the price is live
  'OBSERVING',    // inside the observation window
  'WON',          // the window closed better than baseline
  'NEUTRAL',      // no measurable change
  'LOST',         // worse than baseline
  'RETAINED',     // kept after a win (the seller left it alone)
  'REVERTED',     // put back (undo / auto-revert / failed verify)
];

export const TRANSITIONS = {
  GENERATED: ['SHOWN', 'ACCEPTED', 'REJECTED', 'OVERRIDDEN', 'BLOCKED'],
  SHOWN: ['ACCEPTED', 'REJECTED', 'OVERRIDDEN', 'BLOCKED'],
  ACCEPTED: ['APPLIED', 'REVERTED', 'BLOCKED'],
  OVERRIDDEN: ['APPLIED', 'REVERTED'],
  BLOCKED: [],
  REJECTED: [],
  APPLIED: ['OBSERVING', 'REVERTED'],
  OBSERVING: ['WON', 'NEUTRAL', 'LOST', 'REVERTED'],
  WON: ['RETAINED', 'REVERTED'],
  NEUTRAL: ['RETAINED', 'REVERTED'],
  LOST: ['REVERTED', 'RETAINED'],
  RETAINED: ['REVERTED'],
  REVERTED: [],
};

/** States where the recommendation is still "open" for a listing. */
export const OPEN_STATES = ['GENERATED', 'SHOWN', 'ACCEPTED', 'APPLIED', 'OBSERVING'];

export const DEFAULT_OBSERVATION = { judgeDay: 14, confirmDay: 28, orderWindow: 'orders react within days; returns arrive late (return-window lag)' };

function nowIso(at) {
  return (at ? new Date(at) : new Date()).toISOString();
}

function nextId(d) {
  d.counters.recommendations = (d.counters.recommendations || 0) + 1;
  return `R-${String(d.counters.recommendations).padStart(4, '0')}`;
}

function find(d, id) {
  const rec = (d.recommendations || []).find((r) => r.recommendation_id === id);
  if (!rec) throw httpError(404, `unknown recommendation: ${id}`);
  return rec;
}

/* --------------------------------- create --------------------------------- */

/**
 * Create (or return the open twin of) a recommendation record.
 * @param {object} card    the engine's card: { cardId, kind, from, to, headline, ... }
 * @param {object} ctx     { listing (hydrated), mode, guardrail, reason, actor, source, at, correlationId }
 */
export function generate(card, ctx = {}) {
  const d = load();
  const l = ctx.listing || listing(ctx.listingId);
  const mode = ctx.mode || l.mode || 'growth';
  const openTwin = (d.recommendations || []).find((r) => r.listing_id === l.id && r.mode === mode
    && OPEN_STATES.includes(r.status) && r.card_id === card.cardId);
  if (openTwin && !ctx.force) {
    return { recommendation: openTwin, reused: true };
  }
  const rec = {
    recommendation_id: nextId(d),
    card_id: card.cardId || null,
    kind: card.kind || 'hold',
    seller_id: l.sellerId,
    listing_id: l.id,
    sku: l.skuKey,
    mode,
    price_before: card.from != null ? card.from : l.price,
    price_proposed: card.to != null ? card.to : l.price,
    reason: ctx.reason || card.what || card.headline || null,
    headline: card.headline || null,
    effect: card.effect || null,
    confidence: card.confidence || null,
    guardrail: ctx.guardrail || null,          // { pass, checks[], blocking[] } as evaluated
    versions: versionSet({ mode }),
    status: 'GENERATED',
    decision: null,                             // accept | reject | override
    decision_id: null,
    applied: null,
    observation: { ...DEFAULT_OBSERVATION, startedAt: null, closesAt: null, samples: [] },
    outcome: null,
    trust: null,                                // { winsBefore, winsAfter, levelAfter }
    timestamps: { generatedAt: nowIso(ctx.at) },
    correlation_id: ctx.correlationId || null,
    history: [{ at: nowIso(ctx.at), from: null, to: 'GENERATED', by: ctx.actor || 'engine', note: 'card generated' }],
    source: ctx.source || 'engine',
  };
  d.recommendations.push(rec);
  logEvent('recommendation.generated', {
    recommendationId: rec.recommendation_id, listingId: l.id, sku: l.skuKey, mode,
    from: rec.price_before, to: rec.price_proposed, kind: rec.kind, cardId: rec.card_id,
  });
  save();
  return { recommendation: rec, reused: false };
}

/* ------------------------------- transitions ------------------------------ */

/** The one place a status may change. Validates and audits. */
export function transition(id, to, { by = 'system', note = null, patch = {}, at = null } = {}) {
  if (!STATES.includes(to)) throw httpError(400, `unknown recommendation state: ${to}`);
  const d = load();
  const rec = find(d, id);
  const allowed = TRANSITIONS[rec.status] || [];
  if (!allowed.includes(to)) {
    throw httpError(409, `invalid transition ${rec.status} -> ${to}`, {
      recommendation_id: id, from: rec.status, requested: to, allowed,
    });
  }
  const from = rec.status;
  rec.status = to;
  Object.assign(rec, patch);
  rec.timestamps[`${to.toLowerCase()}At`] = nowIso(at);
  rec.history.push({ at: nowIso(at), from, to, by, note });
  logEvent('recommendation.status', {
    recommendationId: id, listingId: rec.listing_id, from, to, by, note,
  });
  save();
  return rec;
}

export function markShown(id, evidence = {}) {
  const d = load();
  const rec = find(d, id);
  if (rec.status === 'GENERATED') return transition(id, 'SHOWN', { by: evidence.by || 'api', note: evidence.note || 'returned to the seller', patch: { shown: evidence } });
  return rec;   // already shown/accepted: showing again is not an error
}

export function markDecision(id, decision, { note = null, decision_id = null, at = null, by = 'seller' } = {}) {
  const map = { accept: 'ACCEPTED', reject: 'REJECTED', override: 'OVERRIDDEN' };
  const to = map[decision];
  if (!to) throw httpError(400, `decision must be accept | reject | override`);
  return transition(id, to, { by, note, at, patch: { decision, decision_id } });
}

export function markApplied(id, { price = null, decision_id = null, at = null, by = 'seller', verified = null } = {}) {
  const d = load();
  const rec = find(d, id);
  const target = price != null ? price : rec.price_proposed;
  const appliedAt = nowIso(at);
  const window = {
    ...rec.observation,
    startedAt: appliedAt,
    judgeAt: new Date(new Date(appliedAt).getTime() + DEFAULT_OBSERVATION.judgeDay * 86400000).toISOString(),
    confirmAt: new Date(new Date(appliedAt).getTime() + DEFAULT_OBSERVATION.confirmDay * 86400000).toISOString(),
  };
  return transition(id, 'APPLIED', {
    by, at, note: `price ${rec.price_before} -> ${target}`,
    patch: { price_applied: target, applied: { at: appliedAt, by, decision_id, verified }, observation: window },
  });
}

export function markObserving(id, { at = null, baseline = null } = {}) {
  return transition(id, 'OBSERVING', { by: 'scheduler', at, note: 'observation window open', patch: { observation: { ...find(load(), id).observation, baseline } } });
}

/** Attach one sample from the event stream (the scheduler adds these). */
export function addSample(id, sample) {
  const d = load();
  const rec = find(d, id);
  if (!['APPLIED', 'OBSERVING'].includes(rec.status)) {
    throw httpError(409, `cannot observe a recommendation in state ${rec.status}`, { allowed: ['APPLIED', 'OBSERVING'] });
  }
  rec.observation.samples.push(sample);
  if (rec.status === 'APPLIED') transition(id, 'OBSERVING', { by: 'scheduler', note: 'first observation arrived' });
  else { rec.observation.updatedAt = new Date().toISOString(); save(); }
  return find(load(), id);
}

/**
 * Close the window with a verdict from the outcome calculator. A verdict may
 * only be attached while OBSERVING, and only with evidence - the outcome module
 * is responsible for refusing to invent one.
 */
export function markOutcome(id, { verdict, outcome, at = null, trust = null }) {
  const to = { WIN: 'WON', NEUTRAL: 'NEUTRAL', LOSS: 'LOST' }[verdict];
  if (!to) throw httpError(400, `verdict must be WIN | NEUTRAL | LOSS`);
  if (!outcome || outcome.insufficient) {
    throw httpError(409, 'no verdict without evidence: the observation window has too little data', { outcome });
  }
  return transition(id, to, {
    by: 'scheduler', at, note: `outcome ${verdict}`,
    patch: {
      outcome,
      trust,
      observation: { ...find(load(), id).observation, closedAt: nowIso(at) },
    },
  });
}

export function markRetained(id, { at = null, by = 'seller' } = {}) {
  return transition(id, 'RETAINED', { by, at, note: 'kept after the window' });
}

export function markReverted(id, { at = null, by = 'system', reason = null, restoredPrice = null } = {}) {
  const rec = find(load(), id);
  return transition(id, 'REVERTED', {
    by, at, note: reason || 'reverted',
    patch: { reverted: { at: nowIso(at), by, reason, restoredPrice: restoredPrice != null ? restoredPrice : rec.price_before } },
  });
}

export function markBlocked(id, { blocking = [], checks = [], at = null, by = 'engine' } = {}) {
  return transition(id, 'BLOCKED', {
    by, at, note: 'guardrails refused the move',
    patch: { guardrail: { pass: false, checks, blocking } },
  });
}

/* --------------------------------- queries -------------------------------- */

export function get(id) {
  return find(load(), id);
}

export function list(filter = {}) {
  const d = load();
  let all = (d.recommendations || []).slice();
  if (filter.listingId) all = all.filter((r) => r.listing_id === filter.listingId);
  if (filter.sellerId) {
    const mine = new Set(Object.values(d.listings).filter((l) => l.sellerId === filter.sellerId).map((l) => l.id));
    all = all.filter((r) => mine.has(r.listing_id));
  }
  if (filter.status) {
    const states = Array.isArray(filter.status) ? filter.status : [filter.status];
    all = all.filter((r) => states.includes(r.status));
  }
  if (filter.openOnly) all = all.filter((r) => OPEN_STATES.includes(r.status));
  return all.slice().reverse();
}

export function openFor(listingId) {
  return list({ listingId, openOnly: true })[0] || null;
}

export function counts(filter = {}) {
  const all = list(filter);
  const byStatus = {};
  for (const r of all) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
  return {
    total: all.length,
    byStatus,
    accepted: (byStatus.ACCEPTED || 0) + (byStatus.APPLIED || 0) + (byStatus.OBSERVING || 0) + (byStatus.WON || 0) + (byStatus.NEUTRAL || 0) + (byStatus.LOST || 0) + (byStatus.RETAINED || 0),
    rejected: byStatus.REJECTED || 0,
    overridden: byStatus.OVERRIDDEN || 0,
    blocked: byStatus.BLOCKED || 0,
    wins: byStatus.WON || 0,
    ...byStatus,
  };
}

/** Reproducibility: explain exactly which configuration produced this card. */
export function explain(id) {
  const rec = find(load(), id);
  return {
    recommendation_id: rec.recommendation_id,
    listing_id: rec.listing_id,
    sku: rec.sku,
    mode: rec.mode,
    status: rec.status,
    prices: { before: rec.price_before, proposed: rec.price_proposed, applied: rec.price_applied ?? null },
    reason: rec.reason,
    guardrail: rec.guardrail,
    versions: rec.versions,
    versionNotes: explainVersions(rec.versions),
    timestamps: rec.timestamps,
    history: rec.history,
    decision: rec.decision,
    observation: rec.observation,
    outcome: rec.outcome,
    note: 'Every field here is what the engine saw at the time. Re-running the same engines with the same versions and the same features reproduces this card.',
  };
}

export { DEFAULT_OBSERVATION as OBSERVATION };
