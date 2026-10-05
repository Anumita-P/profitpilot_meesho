/**
 * THE ACTION QUEUE (phase 5).
 *
 *   RECOMMENDATION -> GUARDRAILS -> PROPOSAL -> APPROVAL / AUTONOMY
 *                  -> QUEUE -> EXECUTION -> VERIFICATION -> AUDIT
 *
 * Every arrow is a stored state transition with an actor, a timestamp and an
 * audit entry. Nothing jumps the queue: even an Autopilot move is a queued
 * action that gets claimed, executed through the one guarded price write, then
 * verified by re-reading the listing.
 *
 * WHO DECIDES
 *   Manual and Co-Pilot: the engine may CHECK and PROPOSE, the seller must
 *   APPROVE. An action in PROPOSED never executes itself, no matter what.
 *   Autopilot: only when the trust ladder says the seller earned it for that SKU
 *   (src/domain/trust.js: holdout-backed wins, never a provisional win), and only
 *   after the same pre-flight guardrails run. The guardrails are upstream of the
 *   autonomy decision, not downstream of it.
 *
 * DOUBLE-EXECUTION SAFETY: an action must be CLAIMED (claimedBy/claimedAt)
 * before execution, and the claim is refused if the action is not in QUEUED
 * state. Combined with the idempotency middleware (phase 6) a retried request
 * cannot publish twice.
 */

import { load, save, listing, hydrate, logEvent, httpError } from '../store/db.js';
import { preflight, panicBrake, trustLadder } from '../engine/guardrails.js';
import { computeFloor } from '../engine/floor.js';
import { diagnose } from '../engine/diagnose.js';
import { GUARDRAILS } from '../config/deck.js';
import { applyPrice } from './apply.js';
import * as recs from './recommendations.js';
import { autonomyFor, applyTrust } from './trust.js';
import { versionSet } from './versions.js';

export const ACTION_STATUS = [
  'CREATED',      // built from a recommendation, not yet checked
  'CHECKED',      // pre-flight ran and passed
  'BLOCKED',      // pre-flight refused: terminal, nothing changed
  'PROPOSED',     // waiting for the seller (Manual / Co-Pilot)
  'AUTONOMOUS',   // the engine may act (Autopilot, earned and granted)
  'APPROVED',     // a human said yes
  'REJECTED',     // a human said no
  'QUEUED',       // claimed by the executor
  'EXECUTED',     // the price write happened
  'VERIFIED',     // re-read the listing: the change is live
  'FAILED',       // execution or verification failed
  'EXPIRED',      // stale proposal, seller never answered
];

export const TRANSITIONS = {
  CREATED: ['CHECKED', 'BLOCKED'],
  CHECKED: ['PROPOSED', 'AUTONOMOUS', 'BLOCKED', 'REJECTED', 'EXPIRED'],
  PROPOSED: ['APPROVED', 'REJECTED', 'EXPIRED'],
  AUTONOMOUS: ['QUEUED', 'REJECTED', 'EXPIRED'],
  APPROVED: ['QUEUED', 'EXPIRED'],
  QUEUED: ['EXECUTED', 'FAILED'],
  EXECUTED: ['VERIFIED', 'FAILED'],
  VERIFIED: [],
  BLOCKED: [], REJECTED: [], FAILED: [], EXPIRED: [],
};

const TERMINAL = ['BLOCKED', 'REJECTED', 'FAILED', 'EXPIRED', 'VERIFIED'];
const r2 = (x) => Math.round(x * 100) / 100;
const nowIso = (at) => (at ? new Date(at).toISOString() : new Date().toISOString());

function find(d, id) {
  const a = (d.actions || []).find((x) => x.action_id === id);
  if (!a) throw httpError(404, `unknown action: ${id}`);
  return a;
}

function nextId(d) {
  d.counters.actions = (d.counters.actions || 0) + 1;
  return `A-${String(d.counters.actions).padStart(4, '0')}`;
}

/* ------------------------------ transitions ------------------------------- */

function transition(action, to, { by = 'engine', note = null, patch = {}, at = null } = {}) {
  const d = load();
  const from = action.status;
  const allowed = TRANSITIONS[from] || [];
  if (!allowed.includes(to)) {
    throw httpError(409, `invalid action transition ${from} -> ${to}`, { allowed, action_id: action.action_id });
  }
  action.status = to;
  action.updated_at = nowIso(at);
  Object.assign(action, patch);
  action.history.push({ at: action.updated_at, from, to, by, note });
  const entry = {
    audit_id: `AU-${(d.audit.length + 1)}`,
    at: action.updated_at, actor: by, entity: 'action', action_id: action.action_id,
    recommendation_id: action.recommendation_id, listing_id: action.listing_id, sku: action.sku,
    from, to, note, correlation_id: action.correlation_id,
  };
  d.audit.push(entry);
  if (d.audit.length > 5000) d.audit.splice(0, d.audit.length - 5000);
  save();
  logEvent(`action.${to.toLowerCase()}`, {
    actionId: action.action_id, recommendationId: action.recommendation_id,
    listingId: action.listing_id, sku: action.sku, from, to, by, note,
    correlationId: action.correlation_id,
  });
  return action;
}

/* --------------------------------- create --------------------------------- */

/** Build an action from a recommendation (the only way an action is born). */
export function create({ recommendationId, to = null, kind = 'price_change', by = 'engine', at = null, correlationId = null } = {}) {
  const d = load();
  const rec = recs.get(recommendationId);
  if (!rec) throw httpError(404, `unknown recommendation: ${recommendationId}`);
  if (['REVERTED', 'REJECTED', 'BLOCKED'].includes(rec.status)) {
    throw httpError(409, `recommendation ${recommendationId} is ${rec.status}: nothing to queue`, { status: rec.status });
  }
  const existing = (d.actions || []).find((a) => a.recommendation_id === recommendationId && !TERMINAL.includes(a.status));
  if (existing) return { action: existing, reused: true };

  const raw = listing(rec.listing_id);
  const floor = computeFloor(raw.skuKey, raw.costOverrides || {});
  const action = {
    action_id: nextId(d),
    kind,
    recommendation_id: rec.recommendation_id,
    seller_id: rec.seller_id,
    listing_id: rec.listing_id,
    sku: rec.sku,
    from: rec.price_before ?? raw.price,
    to: to != null ? Math.round(to) : Math.round(rec.price_proposed),
    floor: floor.F,
    mode: rec.mode,
    status: 'CREATED',
    guardrail: null,        // filled by check()
    autonomy: null,         // filled by check()
    approval: null,
    execution: null,
    verification: null,
    expiry: null,
    versions: versionSet({ mode: rec.mode, recommendation_id: rec.recommendation_id }),
    correlation_id: correlationId || rec.correlation_id || null,
    created_at: nowIso(at),
    updated_at: nowIso(at),
    history: [{ at: nowIso(at), from: null, to: 'CREATED', by, note: `from ${rec.recommendation_id} (${rec.kind})` }],
  };
  d.actions.push(action);
  save();
  logEvent('action.created', {
    actionId: action.action_id, recommendationId: rec.recommendation_id, listingId: action.listing_id,
    sku: action.sku, from: action.from, to: action.to,
  });
  return { action, reused: false };
}

/* ------------------------------- guardrails ------------------------------- */

/**
 * Step 2: pre-flight. Same six checks the seller-facing publish route uses.
 * Refusal here is a terminal BLOCKED action with the reasons stored - a blocked
 * action is a result, not an error.
 */
export function check(actionId, { at = null, requireViews = null } = {}) {
  const d = load();
  const a = find(d, actionId);
  if (a.status !== 'CREATED') throw httpError(409, `check() expects a CREATED action, got ${a.status}`);
  const raw = listing(a.listing_id);
  const floor = computeFloor(raw.skuKey, raw.costOverrides || {});
  const result = preflight({
    floor, from: raw.price, to: a.to,
    views: requireViews ?? raw.signals?.views ?? 0,
    daysSinceMove: raw.daysSinceMove ?? 0,
    movesThisMonth: raw.movesThisMonth ?? 0,
    consent: false,
  });
  const blocking = result.checks.filter((c) => !c.ok).map((c) => `${c.key}: ${c.detail}`);

  // Diagnose-before-discount (deck slide 4): a price CUT is only allowed in the
  // queue when the diagnosis says price is the branch to fix. Any other fired
  // branch means there is a cheaper cause to fix first, and the action is blocked.
  const view = hydrate(raw);
  const diag = diagnose(view, view.signals);
  const panic = panicBrake({ diagnosis: diag, floor, from: raw.price, to: a.to });
  if (panic.blocked || panic.belowFloor) {
    for (const reason of panic.reasons) blocking.push(`Panic brake: ${reason}`);
  }

  a.guardrail = {
    pass: result.pass,
    checks: result.checks,
    blocking,
    panicBrake: { blocked: panic.blocked, belowFloor: panic.belowFloor, verdict: panic.verdict, reasons: panic.reasons, sellerLine: panic.sellerLine },
    floor: { F: floor.F, frec: floor.frec, gap: floor.gap },
    checkedAt: nowIso(at),
    livePriceAtCheck: raw.price,
  };
  if (blocking.length) {
    transition(a, 'BLOCKED', { by: 'guardrails', note: blocking.join(' | '), at, patch: {} });
    // The linked recommendation is closed out as BLOCKED too, so a refused card
    // cannot be re-offered or counted as a win later.
    try { recs.markBlocked(a.recommendation_id, { blocking, checks: result.checks, at, by: 'guardrails' }); }
    catch { /* already terminal: the action record is the source of truth */ }
    logEvent('guardrail.blocked', {
      actionId: a.action_id, listingId: a.listing_id, via: 'action-queue',
      price: a.to, floor: floor.F, blocking,
    });
    return a;
  }

  // Autonomy is decided AFTER the guardrails pass, never instead of them.
  const autonomy = autonomyFor(a.seller_id, a.sku);
  a.autonomy = autonomy;
  transition(a, 'CHECKED', { by: 'guardrails', note: `pre-flight passed (${result.checks.length} checks)`, at });

  if (autonomy.effective === 'au' && !autonomy.needsSeller) {
    return transition(a, 'AUTONOMOUS', {
      by: 'engine',
      note: `Autopilot: ${autonomy.why}`,
      at,
      patch: { autonomy },
    });
  }
  return transition(a, 'PROPOSED', {
    by: 'engine',
    note: `${autonomy.label}: ${autonomy.why} - the seller decides`,
    at,
    patch: { autonomy },
  });
}

/* -------------------------- approval / autonomy --------------------------- */

export function approve(actionId, { by = 'seller', note = null, at = null } = {}) {
  const d = load();
  const a = find(d, actionId);
  if (a.status !== 'PROPOSED') {
    throw httpError(409, `only a PROPOSED action can be approved (this one is ${a.status})`, { status: a.status });
  }
  return transition(a, 'APPROVED', {
    by, note: note || 'seller approved the proposal', at,
    patch: { approval: { by, at: nowIso(at), note, mode: a.autonomy?.label || 'unknown' } },
  });
}

export function reject(actionId, { by = 'seller', note = null, at = null } = {}) {
  const d = load();
  const a = find(d, actionId);
  if (!['PROPOSED', 'AUTONOMOUS', 'CHECKED'].includes(a.status)) {
    throw httpError(409, `cannot reject an action in status ${a.status}`, { status: a.status });
  }
  const rejected = transition(a, 'REJECTED', { by, note: note || 'refused', at });
  // The linked recommendation follows the seller's decision: a rejected action
  // is a rejected recommendation, and it can never be counted as a win.
  try { recs.markDecision(a.recommendation_id, 'reject', { note: note || 'action rejected', by, at }); }
  catch { /* the recommendation may already be in a terminal state; the action record is the source of truth */ }
  return rejected;
}

/** Step 5: queue. Approval (or earned autonomy) is required to get here. */
export function enqueue(actionId, { at = null, by = 'executor', executeAfter = null } = {}) {
  const d = load();
  const a = find(d, actionId);
  if (!['APPROVED', 'AUTONOMOUS'].includes(a.status)) {
    throw httpError(409, `only an APPROVED or AUTONOMOUS action can be queued (this one is ${a.status})`, { status: a.status });
  }
  return transition(a, 'QUEUED', {
    at, by,
    note: executeAfter ? `queued, execute after ${executeAfter}` : 'queued for execution',
    patch: { queue: { queuedAt: nowIso(at), queuedBy: by, executeAfter } },
  });
}

/* -------------------------------- execution -------------------------------- */

/**
 * Claim + execute + verify in one call, but each is a separate recorded step.
 * The claim is what makes double execution impossible: QUEUED -> EXECUTED is
 * allowed exactly once, so a second claim on the same action is a 409.
 */
export function execute(actionId, { at = null, by = 'executor', verify = true } = {}) {
  const d = load();
  const a = find(d, actionId);
  if (a.status !== 'QUEUED') {
    throw httpError(409, `action ${actionId} is ${a.status}: nothing to execute (double execution is refused)`, { status: a.status });
  }
  const raw = listing(a.listing_id);
  a.claim = { claimedBy: by, claimedAt: nowIso(at), priceAtClaim: raw.price };

  let result;
  try {
    result = applyPrice({
      listingId: a.listing_id,
      to: a.to,
      actor: `action:${a.autonomy?.effective || a.mode || 'engine'}`,
      reason: `action ${a.action_id} (${a.kind}) approved via ${a.approval ? 'seller approval' : 'earned autonomy'}`,
      recommendationId: a.recommendation_id,
      mode: a.mode,
      at,
      requireViews: raw.signals?.views ?? 0,
    });
  } catch (err) {
    // Guardrails are re-checked inside applyPrice against LIVE data: if the
    // world moved between the check and the execution, this is a FAILED action,
    // not a price.
    transition(a, 'FAILED', {
      by: 'guardrails', at,
      note: `execution refused: ${err.message}`,
      patch: { execution: { at: nowIso(at), by, refused: true, blocking: err.detail?.blocking || [err.message] } },
    });
    return a;
  }

  transition(a, 'EXECUTED', {
    at, by,
    note: `price ${result.from} -> ${result.to} (floor ${result.floor})`,
    patch: { execution: { at: result.at || nowIso(at), by, from: result.from, to: result.to, floor: result.floor, override: result.override } },
  });

  // The recommendation follows the action: it is now applied and observing.
  try {
    const rec = recs.get(a.recommendation_id);
    if (rec.status === 'GENERATED') recs.markShown(a.recommendation_id, { by: 'engine', note: 'autopilot executed' });
    const live = recs.get(a.recommendation_id);
    if (['GENERATED', 'SHOWN'].includes(live.status)) {
      recs.markDecision(a.recommendation_id, 'accept', { by: a.approval ? a.approval.by : 'engine:autopilot', note: 'executed by the action queue', at });
    }
    recs.markApplied(a.recommendation_id, { price: result.to, at, by: a.approval ? 'seller' : 'engine:autopilot', verified: true });
  } catch (err) {
    logEvent('action.recommendationLinkFailed', { actionId: a.action_id, recommendationId: a.recommendation_id, message: err.message });
  }

  return verify ? verifyAction(a.action_id, { at, by: 'verifier' }) : a;
}

/** Step 7: verification. Re-read the listing and compare with the intent. */
export function verifyAction(actionId, { at = null, by = 'verifier' } = {}) {
  const d = load();
  const a = find(d, actionId);
  if (a.status !== 'EXECUTED') {
    throw httpError(409, `only an EXECUTED action can be verified (this one is ${a.status})`, { status: a.status });
  }
  const raw = listing(a.listing_id);
  const matches = raw.price === a.to;
  a.verification = {
    at: nowIso(at), by, expected: a.to, observed: raw.price, matches,
    floor: computeFloor(raw.skuKey, raw.costOverrides || {}).F,
    source: 're-read from the store after the write',
  };
  if (!matches) {
    transition(a, 'FAILED', { by, at, note: `verification failed: expected ${a.to}, store says ${raw.price}` });
    return a;
  }
  transition(a, 'VERIFIED', { by, at, note: `store confirms ₹${raw.price} is live` });
  applyTrust(a.seller_id);   // a verified action may add a valid win; it never invents one
  logEvent('action.audited', {
    actionId: a.action_id, recommendationId: a.recommendation_id, listingId: a.listing_id,
    price: raw.price, verifiedAt: a.verification.at,
  });
  return a;
}

/* ------------------------------- pipeline -------------------------------- */

/**
 * Walk an action as far as the trust ladder allows. Manual / Co-Pilot stop at
 * PROPOSED; Autopilot runs all the way to VERIFIED. Returns the action plus the
 * stage it stopped at.
 */
export function step({ recommendationId = null, actionId = null, to = null, at = null, by = 'engine', correlationId = null } = {}) {
  let a;
  if (actionId) a = find(load(), actionId);
  else {
    const created = create({ recommendationId, to, at, by, correlationId });
    a = created.action;
    if (created.reused) return { action: a, stoppedAt: a.status, reused: true };
  }
  if (a.status === 'CREATED') a = check(a.action_id, { at });
  if (a.status === 'AUTONOMOUS') a = enqueue(a.action_id, { at, by: 'autopilot' });
  if (a.status === 'QUEUED') a = execute(a.action_id, { at, by: 'autopilot' });
  return { action: find(load(), a.action_id), stoppedAt: find(load(), a.action_id).status, needsSeller: ['PROPOSED'].includes(a.status) };
}

/** Process the queue: every QUEUED action is executed, in creation order. */
export function runQueue({ at = null, by = 'scheduler' } = {}) {
  const d = load();
  const queued = (d.actions || [])
    .filter((a) => a.status === 'QUEUED')
    .sort((x, y) => new Date(x.created_at) - new Date(y.created_at) || x.action_id.localeCompare(y.action_id));
  const executed = [];
  const failed = [];
  for (const a of queued) {
    try { executed.push({ actionId: a.action_id, status: execute(a.action_id, { at, by }).status }); }
    catch (err) { failed.push({ actionId: a.action_id, error: err.message }); }
  }
  return { job: 'queue', at: nowIso(at), queued: queued.length, executed: executed.length, failed: failed.length, detail: { executed, failed } };
}

/** Expire proposals the seller never answered (keeps the queue honest). */
export function expireStale({ at = null, olderThanHours = 72 } = {}) {
  const d = load();
  const cut = new Date(at || Date.now()).getTime() - olderThanHours * 3600000;
  const expired = [];
  for (const a of (d.actions || [])) {
    if (a.status !== 'PROPOSED') continue;
    if (new Date(a.created_at).getTime() > cut) continue;
    transition(a, 'EXPIRED', { by: 'scheduler', at, note: `no answer within ${olderThanHours}h` });
    expired.push(a.action_id);
  }
  return { job: 'expire', at: nowIso(at), expired: expired.length, detail: expired };
}

/* --------------------------------- queries -------------------------------- */

export function get(id) { return find(load(), id); }

export function list(filter = {}) {
  const d = load();
  let all = (d.actions || []).slice();
  if (filter.sellerId) all = all.filter((a) => a.seller_id === filter.sellerId);
  if (filter.listingId) all = all.filter((a) => a.listing_id === filter.listingId);
  if (filter.status) {
    const s = Array.isArray(filter.status) ? filter.status : [filter.status];
    all = all.filter((a) => s.includes(a.status));
  }
  if (filter.open) all = all.filter((a) => !TERMINAL.includes(a.status));
  return all.slice().reverse();
}

export function counts(filter = {}) {
  const all = list(filter);
  const out = {};
  for (const s of ACTION_STATUS) out[s] = all.filter((a) => a.status === s).length;
  return { total: all.length, ...out };
}

/** The stage-by-stage view the UI (and the audit) reads: where is everything? */
export function pipeline(filter = {}) {
  const all = list(filter);
  const stage = (label, statuses) => ({
    stage: label,
    statuses,
    count: all.filter((a) => statuses.includes(a.status)).length,
    items: all.filter((a) => statuses.includes(a.status)).slice(0, 10).map((a) => ({
      action_id: a.action_id, recommendation_id: a.recommendation_id, listing_id: a.listing_id,
      sku: a.sku, from: a.from, to: a.to, status: a.status, updated_at: a.updated_at,
    })),
  });
  return {
    generated_at: new Date().toISOString(),
    steps: [
      stage('1 recommendation', ['CREATED']),
      stage('2 guardrails', ['CHECKED', 'BLOCKED']),
      stage('3 proposal / autonomy', ['PROPOSED', 'AUTONOMOUS']),
      stage('4 approval', ['APPROVED', 'REJECTED']),
      stage('5 queue', ['QUEUED']),
      stage('6 execution', ['EXECUTED', 'FAILED']),
      stage('7 verification', ['VERIFIED', 'EXPIRED']),
    ],
    counts: counts(filter),
    audit_tail: (load().audit || []).slice(-10).reverse(),
    rule: 'the engine may propose; only the seller (Manual/Co-Pilot) or earned autonomy (Autopilot) may queue; nothing executes without passing pre-flight at both check time and execution time',
  };
}

/** The audit trail for one entity (action, recommendation or listing). */
export function audit(filter = {}) {
  const d = load();
  let rows = (d.audit || []).slice();
  if (filter.actionId) rows = rows.filter((r) => r.action_id === filter.actionId);
  if (filter.recommendationId) rows = rows.filter((r) => r.recommendation_id === filter.recommendationId);
  if (filter.listingId) rows = rows.filter((r) => r.listing_id === filter.listingId);
  if (filter.sellerId) rows = rows.filter((r) => (d.actions.find((a) => a.action_id === r.action_id)?.seller_id) === filter.sellerId);
  return rows.slice(-(filter.limit || 100)).reverse();
}
