/**
 * RECALC JOBS (phase 2 of the loop).
 *
 * Everything that has to happen "later" lives here as a function of (data, at):
 * no setInterval inside the decision logic, no Date.now() in the middle of a
 * calculation, no randomness. src/jobs/scheduler.js is the only part that knows
 * about time, and even it can be driven by hand with an explicit clock - which is
 * how the tests and the demo jump 14 days into the future.
 *
 *   cooldown     - days-since-move and moves-this-month, DERIVED from the
 *                  listing's own price history (never stored as separate truth)
 *   signals      - refresh the features the models read from OBSERVED events only
 *   observe      - judge applied recommendations whose window is due; a verdict
 *                  without evidence is refused
 *   revert       - 14-day safety net: a losing / quality-breaching change is
 *                  reverted through applyPrice() (the one guarded write), which
 *                  means the floor, the step rule and the cooldown still apply
 *   queue        - drain the action queue and expire stale proposals
 *   experiments  - close experiments whose window has ended
 *   reconcile    - re-check every live price against its floor; raises alerts,
 *                  never silently reprices
 *
 * A cycle is deterministic and idempotent per timestamp: the same data at the
 * same instant produces the same counters, and running it again changes nothing.
 */

import { load, save, logEvent, httpError, hydrate } from '../store/db.js';
import * as events from '../domain/events.js';
import * as recs from '../domain/recommendations.js';
import * as outcomes from '../domain/outcomes.js';
import * as trust from '../domain/trust.js';
import * as actions from '../domain/actions.js';
import { computeFloor } from '../engine/floor.js';
import { applyPrice } from '../domain/apply.js';
import { GUARDRAILS } from '../config/deck.js';

export const JOB_NAMES = ['cooldown', 'signals', 'observe', 'revert', 'queue', 'experiments', 'reconcile'];

const DAY = 86400000;

/**
 * When did this stored event happen?
 *
 * Stored rows carry `timestamp` (src/domain/events.js writes it on every path);
 * older rows and hand-made fixtures sometimes use `occurred_at` or `ts`. Reading
 * a field the store does not write is how a guardrail silently sees zero traffic,
 * so all three are accepted, in that order.
 */
const eventMs = (e) => Date.parse(e?.timestamp ?? e?.occurred_at ?? e?.ts ?? 0);
const iso = (x) => new Date(x).toISOString();

/** Accept a clock as an ISO string, a Date, a ms number, or nothing (wall clock). */
export const toIso = (at) => {
  if (at === null || at === undefined || at === '') return new Date().toISOString();
  const d = at instanceof Date ? at : new Date(typeof at === 'number' ? at : at);
  if (Number.isNaN(d.getTime())) throw httpError(400, `at must be a timestamp (got ${String(at)})`, { field: 'at' });
  return d.toISOString();
};
const round2 = (x) => Math.round(x * 100) / 100;

/** The signals the event layer owns. Kept in one place so the job can tell
 *  "nothing left to refresh" from "the observed window changed something". */
export const SIGNAL_KEYS = ['views', 'clicks', 'ctr', 'returnsPct', 'rtoPct', 'keptRatePct', 'cvr', 'doi'];

export function signalsFingerprint(signals = {}) {
  return SIGNAL_KEYS.map((k) => `${k}=${signals[k] ?? ''}`).join('|');
}

/* ------------------------------------------------------------------ *
 * 1. cooldown
 * ------------------------------------------------------------------ */

export function cooldown({ at = new Date().toISOString() } = {}) {
  at = toIso(at);
  const d = load();
  const now = Date.parse(at);
  const detail = [];
  let changed = 0;
  for (const raw of Object.values(d.listings || {})) {
    const history = (raw.priceHistory || []).filter((h) => !h.reverted && h.ts);
    const last = history.length ? history[history.length - 1] : null;
    const daysSinceMove = last ? Math.max(0, Math.floor((now - Date.parse(last.ts)) / DAY)) : 999;
    const monthStart = now - 30 * DAY;
    const movesThisMonth = history.filter((h) => Date.parse(h.ts) >= monthStart).length;
    const since = last ? Date.parse(last.ts) : 0;
    const impressionsSinceMove = (d.ingestedEvents || [])
      .filter((e) => e.listing_id === raw.id && e.event_type === 'VIEW_RECORDED' && eventMs(e) >= since)
      .reduce((a, e) => a + (e.payload?.units || 0), 0);

    const row = { listing_id: raw.id, sku: raw.skuKey, days_since_move: daysSinceMove, moves_this_month: movesThisMonth, impressions_since_move: impressionsSinceMove };
    detail.push(row);                                            // the computed table, identical on a re-run
    if (raw.daysSinceMove !== daysSinceMove || raw.movesThisMonth !== movesThisMonth || raw.impressionsSinceMove !== impressionsSinceMove) {
      raw.daysSinceMove = daysSinceMove;
      raw.movesThisMonth = movesThisMonth;
      raw.impressionsSinceMove = impressionsSinceMove;
      changed += 1;
    }
  }
  if (changed) save();
  return {
    job: 'cooldown', at, listings_updated: changed, listings: detail.length, detail,
    rules: { cooldown_days: GUARDRAILS.cooldownDays, moves_per_month: GUARDRAILS.maxMovesPerMonth, view_sanity: GUARDRAILS.minViewsForMove },
  };
}

/* ------------------------------------------------------------------ *
 * 2. signals
 * ------------------------------------------------------------------ */

/**
 * Refresh features from the seller's own events. The fold itself lives in
 * src/domain/events.js; this job only decides which listings changed, so a
 * cadence-driven refresh can never invent data.
 */
export function signals({ at = new Date().toISOString() } = {}) {
  at = toIso(at);
  const d = load();
  const detail = [];
  let updated = 0;
  for (const raw of Object.values(d.listings || {})) {
    const before = signalsFingerprint(raw.signals);
    try {
      events.refreshSignalsFromObserved(raw);
    } catch (err) {
      detail.push({ listing_id: raw.id, error: err.message, updated: false });
      continue;
    }
    const after = signalsFingerprint(raw.signals);
    const changed = before !== after;
    if (changed) updated += 1;
    detail.push({ listing_id: raw.id, updated: changed, observed_since: raw.observed?.since ?? null, views: raw.signals?.views ?? null, ctr: raw.signals?.ctr ?? null });
  }
  return { job: 'signals', at, updated, listings: detail.length, detail };
}

/* ------------------------------------------------------------------ *
 * 3. observe
 * ------------------------------------------------------------------ */

/** Raw counts from the event stream over a window (what the seller's own trade says). */
export function windowCounts(listingId, { from, to }) {
  const d = load();
  const fromMs = Date.parse(from); const toMs = Date.parse(to);
  const c = { views: 0, clicks: 0, orders: 0, cancelled: 0, delivered: 0, returned: 0, rto: 0, kept: 0, days: Math.max(1, Math.round((toMs - fromMs) / DAY)) };
  for (const e of d.ingestedEvents || []) {
    if (e.listing_id !== listingId) continue;
    const t = eventMs(e);
    if (!(t >= fromMs && t <= toMs)) continue;
    const u = e.payload?.units ?? 0;
    switch (e.event_type) {
      /* a VIEW_RECORDED row carries the day's traffic in one payload: the
         marketplace emits a single row per day with {views, clicks}, while other
         sources may emit per-unit rows. Read both shapes. */
      case 'VIEW_RECORDED': c.views += (e.payload?.views ?? u); c.clicks += (e.payload?.clicks ?? 0); break;
      case 'CLICK_RECORDED': c.clicks += (e.payload?.clicks ?? u); break;
      case 'ORDER_PLACED': c.orders += u; break;
      case 'ORDER_CANCELLED': c.cancelled += u; break;
      case 'ORDER_DELIVERED': c.delivered += u; break;
      case 'ORDER_RETURNED': c.returned += u; break;
      case 'ORDER_RTO': c.rto += u; break;
      default: break;
    }
  }
  c.kept = c.delivered - c.returned;
  return c;
}

/**
 * A recent observed window, normalised to per-day rates.
 *
 * This exists because the cumulative feature fold is the wrong basis for a
 * DIAGNOSIS: `signals.views` is a DAILY figure and the category median it is
 * compared against is also daily, so a month of accumulated views would read as
 * "32x the market". The window gives the seller's last N days as rates, and
 * conversion comes out as orders per CLICK - the same scale as `cvrMedian`.
 *
 * Read-only: it never writes, so a diagnosis can be run without side effects.
 */
export function windowFeatures(listingId, { from, to, days = null } = {}) {
  const counts = windowCounts(listingId, { from, to });
  const d = Math.max(1, days ?? counts.days);
  const dispatched = counts.delivered + counts.rto;
  const kept = counts.delivered - counts.returned;
  const round1 = (x) => Math.round(x * 10) / 10;
  return {
    window: { from, to, days: d },
    counts: { ...counts, kept },
    per_day: {
      views: round1(counts.views / d),
      clicks: round1(counts.clicks / d),
      orders: round1(counts.orders / d),
      kept: round1(kept / d),
    },
    ctr: counts.views ? Math.round((counts.clicks / counts.views) * 1000) / 10 : null,
    cvr: counts.clicks ? Math.round((counts.orders / counts.clicks) * 1000) / 10 : null,
    returnsPct: dispatched ? Math.round((counts.returned / dispatched) * 1000) / 10 : null,
    rtoPct: dispatched ? Math.round((counts.rto / dispatched) * 1000) / 10 : null,
    keptRatePct: dispatched ? Math.round(((dispatched - counts.returned - counts.rto) / dispatched) * 1000) / 10 : null,
    dispatched,
    basis: `last ${d} observed day(s)`,
    note: 'Per-day rates from ingested events only. Conversion is orders per click; returns and RTO are shares of dispatched orders.',
  };
}

/** What an open observation is still waiting for (read-only; shown in the UI). */
export function waitingOn(rec, { at }) {
  const counts = windowCounts(rec.listing_id, { from: rec.applied?.at || rec.created_at, to: at });
  const missing = [];
  if (counts.kept < outcomes.MIN_EVIDENCE.keptOrders) missing.push(`kept orders ${counts.kept} < ${outcomes.MIN_EVIDENCE.keptOrders}`);
  if (counts.views < outcomes.MIN_EVIDENCE.views) missing.push(`views ${counts.views} < ${outcomes.MIN_EVIDENCE.views}`);
  if (counts.days < outcomes.MIN_EVIDENCE.days) missing.push(`window ${counts.days}d < ${outcomes.MIN_EVIDENCE.days}d`);
  return { ...counts, missing, enough: missing.length === 0, min_evidence: outcomes.MIN_EVIDENCE };
}

/**
 * Judge every recommendation whose window is due. Evidence-free verdicts are
 * impossible: computeOutcome() returns { insufficient: true } and the
 * recommendation stays open with a note about what is missing.
 */
export function observe({ at = new Date().toISOString() } = {}) {
  at = toIso(at);
  const d = load();
  const now = Date.parse(at);
  const closed = [];
  const waiting = [];
  for (const rec of d.recommendations || []) {
    if (!['APPLIED', 'OBSERVING'].includes(rec.status)) continue;
    const judgeAt = rec.observation?.judgeAt ? Date.parse(rec.observation.judgeAt) : null;
    if (!judgeAt || judgeAt > now) continue;                     // not due yet

    const result = outcomes.computeOutcome({ recommendation: rec, window: { to: at } });
    if (result.insufficient) {
      if (rec.status === 'APPLIED') recs.markObserving(rec.recommendation_id, { at });
      const w = waitingOn(rec, { at });
      const fresh = recs.get(rec.recommendation_id);
      fresh.observation.waitingOn = w;
      fresh.observation.judgedAt = at;
      save();
      waiting.push({ recommendation_id: rec.recommendation_id, listing_id: rec.listing_id, sku: rec.sku, waiting_on: w.missing, status: fresh.status });
      continue;
    }

    const w = waitingOn(rec, { at });
    recs.addSample(rec.recommendation_id, {
      at, window_from: result.window?.from, window_to: result.window?.to,
      orders: w.orders, kept_orders: w.kept, views: w.views,
      average_price: rec.price_proposed, source: 'ingested events',
    });
    const outcome = outcomes.recordOutcome(rec.recommendation_id, result, { at });
    logEvent('observation.judged', {
      recommendationId: rec.recommendation_id, listingId: rec.listing_id, sku: rec.sku,
      verdict: result.verdict, deltaPct: result.primary?.deltaPct ?? null,
      windowFrom: result.window?.from, windowTo: result.window?.to,
      keptOrders: result.evidence?.keptOrders ?? null, views: result.evidence?.views ?? null,
      qualityPass: result.quality?.pass ?? null, at,
    });
    logEvent('outcome.recorded', {
      outcomeId: outcome.outcome_id, recommendationId: rec.recommendation_id, listingId: rec.listing_id,
      sku: rec.sku, verdict: result.verdict, primary: result.primary?.metric,
      deltaPct: result.primary?.deltaPct ?? null, baselineSource: result.baselineSource, at,
    });
    const trustNow = trust.applyTrust(rec.seller_id);            // trust moves only from valid evidence
    recs.markOutcome(rec.recommendation_id, { verdict: result.verdict, outcome: result, at, trust: trustNow });

    /* day 28: the change survived its full window - retain it (or it is reverted
       by the revert job first, which runs later in the same cycle). */
    let confirmed = false;
    if (judgeAt + 14 * DAY <= now) {
      const cur = recs.get(rec.recommendation_id);
      if (['WON', 'NEUTRAL', 'LOST'].includes(cur.status)) {
        recs.markRetained(rec.recommendation_id, { at, by: 'system' });
        const done = recs.get(rec.recommendation_id);
        done.observation.confirmedAt = at;
        confirmed = true;
      }
    }
    save();
    closed.push({
      recommendation_id: rec.recommendation_id, listing_id: rec.listing_id, sku: rec.sku,
      verdict: result.verdict, why: result.verdictWhy, delta_pct: result.primary?.deltaPct ?? null,
      window: result.window, outcome_id: outcome.outcome_id, confirmed,
      trust: { level: trustNow?.ladder?.level, wins: trustNow?.wins, changed: trustNow?.changed },
    });
  }
  return { job: 'observe', at, judged: closed.length, closed, waiting, waiting_count: waiting.length };
}

/* ------------------------------------------------------------------ *
 * 4. revert
 * ------------------------------------------------------------------ */

/**
 * The 14-day safety net. Autopilot (or an earned Co-Pilot revert) restores the
 * previous price - through applyPrice(), so the floor and the other guardrails
 * still apply. Manual sellers get a proposal and keep their hands on the wheel.
 */
export function revert({ at = new Date().toISOString() } = {}) {
  at = toIso(at);
  const d = load();
  const now = Date.parse(at);
  const auto_reverted = [];
  const pending_approval = [];
  const blocked = [];
  for (const rec of d.recommendations || []) {
    if (rec.reverted?.at) continue;
    if (!['APPLIED', 'OBSERVING', 'WON', 'NEUTRAL', 'LOST'].includes(rec.status)) continue;
    const appliedAt = rec.applied?.at ? Date.parse(rec.applied.at) : null;
    if (!appliedAt || now - appliedAt < 14 * DAY) continue;
    const bad = rec.outcome?.verdict === 'LOSS' || (rec.outcome?.quality && rec.outcome.quality.pass === false);
    if (!bad) continue;

    const entry = {
      recommendation_id: rec.recommendation_id, listing_id: rec.listing_id, sku: rec.sku,
      from: rec.price_proposed, to: rec.price_before,
      why: rec.outcome?.verdict === 'LOSS'
        ? 'contribution per kept order fell past the neutral band'
        : `customer quality breached: ${rec.outcome?.quality?.breached?.join(', ') || 'quality guardrail'}`,
      verdict: rec.outcome?.verdict || null,
    };
    const aut = trust.autonomyFor(rec.seller_id, rec.sku);
    if (aut.effective === 'man') {
      pending_approval.push({ ...entry, autonomy: 'man', needs: 'seller approval (Manual mode - the engine proposes, the seller decides)' });
      const cur = recs.get(rec.recommendation_id);
      cur.revert = { ...entry, autonomy: 'man', needs: 'seller approval', proposed_at: at };
      save();
      continue;
    }
    try {
      const applied = applyPrice({
        listingId: rec.listing_id, to: rec.price_before, at, mode: rec.mode, actor: 'engine',
        reason: `${aut.effective === 'au' ? 'autopilot auto-revert' : 'co-pilot revert'} after ${rec.outcome?.verdict || 'failed check'}`,
        recommendationId: rec.recommendation_id,
      });
      recs.markReverted(rec.recommendation_id, {
        at, by: 'system', restoredPrice: applied?.to ?? rec.price_before,
        reason: `${entry.why} (${aut.effective === 'au' ? 'autopilot auto-revert' : 'co-pilot revert'})`,
      });
      trust.applyTrust(rec.seller_id);
      auto_reverted.push({ ...entry, autonomy: aut.effective, restored_price: applied?.to ?? rec.price_before, checks_passed: (applied?.checks || []).filter((c) => c.ok).map((c) => c.key) });
    } catch (err) {
      const failed = err.detail?.checks?.filter((c) => !c.ok).map((c) => `${c.key}: ${c.detail}`) || [err.message];
      const cur = recs.get(rec.recommendation_id);
      cur.revert = { ...entry, autonomy: aut.effective, blocked_by: failed, retry: true, at };
      save();
      blocked.push({ ...entry, blocked_by: failed, note: 'the revert is itself subject to the floor, the step rule and the cooldown; it will be retried on the next cycle' });
    }
  }
  return { job: 'revert', at, auto_reverted, pending_approval, blocked };
}

/* ------------------------------------------------------------------ *
 * 5. queue - the action queue drains here, on the same clock
 * ------------------------------------------------------------------ */

export function queue({ at = new Date().toISOString() } = {}) {
  at = toIso(at);
  const drained = actions.runQueue({ at, by: 'scheduler' });
  const expired = actions.expireStale({ at });
  return {
    job: 'queue', at,
    queued: drained.queued, executed: drained.executed, failed: drained.failed,
    expired: expired?.expired?.length ?? expired?.expired ?? 0,
    detail: { executed: drained.detail?.executed || [], failed: drained.detail?.failed || [], expired: expired?.detail || expired?.expired || [] },
  };
}

/* ------------------------------------------------------------------ *
 * 6. experiments
 * ------------------------------------------------------------------ */

export function experiments({ at = new Date().toISOString() } = {}) {
  at = toIso(at);
  const d = load();
  const now = Date.parse(at);
  const closed = [];
  for (const x of d.experiments || []) {
    if (x.status !== 'RUNNING') continue;
    if (!x.ends_at || Date.parse(x.ends_at) > now) continue;
    x.status = 'COMPLETED';
    x.completed_at = at;
    closed.push({ experiment_id: x.experiment_id, listing_id: x.listing_id, ended_at: x.ends_at });
  }
  if (closed.length) { save(); logEvent('experiment.completed', { count: closed.length, at }); }
  return { job: 'experiments', at, closed };
}

/* ------------------------------------------------------------------ *
 * 7. reconcile
 * ------------------------------------------------------------------ */

export function reconcile({ at = new Date().toISOString() } = {}) {
  at = toIso(at);
  const d = load();
  const alerts = [];
  const floors = [];
  for (const raw of Object.values(d.listings || {})) {
    const f = computeFloor(raw.skuKey, raw.costOverrides || {});
    const before = raw.__lastFloor ?? null;
    if (before !== null && Math.abs(before - f.F) > 0.5) {
      alerts.push({ listing_id: raw.id, sku: raw.skuKey, kind: 'FLOOR_MOVED', from: before, to: f.F, note: 'a cost change moved the return-adjusted floor; the recommended price was re-derived' });
      logEvent('floor.moved', { listingId: raw.id, from: before, to: f.F, at });
    }
    raw.__lastFloor = f.F;
    floors.push({ listing_id: raw.id, sku: raw.skuKey, floor: f.F, price: raw.price, margin_per_kept_order: round2(raw.price - f.F), below_floor: raw.price < f.F });
  }
  save();
  return { job: 'reconcile', at, floors, alerts };
}

/* ------------------------------------------------------------------ *
 * the cycle
 * ------------------------------------------------------------------ */

const JOBS = { cooldown, signals, observe, revert, queue, experiments, reconcile };

/** How far ahead a cycle may be scheduled. The store's own events arrive within
 *  days of happening, so a run beyond this horizon would be inventing time. */
export const MAX_LOOKAHEAD_DAYS = 30;

export function runCycle({ at = new Date().toISOString(), kinds = JOB_NAMES, dryRun = false, trigger = 'manual', actor = null } = {}) {
  const when = toIso(at);
  const ts = Date.parse(when);
  const ahead = ts - Date.now();
  if (ahead > MAX_LOOKAHEAD_DAYS * DAY) {
    return {
      ok: false,
      dryRun: !!dryRun,
      at: when,
      refused: 'FUTURE_RUN',
      kinds,
      errors: [{ message: `a run cannot be scheduled ${Math.round(ahead / DAY)} days into the future (limit ${MAX_LOOKAHEAD_DAYS} days): nothing in the store can justify a verdict about time that has not passed`, kind: 'refused' }],
      results: {},
      changed: 0,
      guardrails: 'refusals are not recorded as job errors: nothing ran, so nothing failed',
    };
  }

  const list = kinds && kinds.length ? kinds : JOB_NAMES;
  const results = {};
  const errors = [];
  for (const kind of list) {
    const fn = JOBS[kind];
    if (!fn) throw httpError(400, `unknown job kind: ${kind}`, { field: 'kinds', allowed: JOB_NAMES });
    try {
      results[kind] = fn({ at: when });
    } catch (err) {
      errors.push({ kind, message: err.message, status: err.status ?? 500 });
      results[kind] = { job: kind, at: when, error: err.message };
    }
  }

  const changes = {
    listings_touched: results.cooldown?.listings_updated || 0,
    signals_refreshed: results.signals?.updated || 0,
    outcomes_judged: results.observe?.judged || 0,
    still_waiting: results.observe?.waiting_count || 0,
    auto_reverted: results.revert?.auto_reverted?.length || 0,
    reverts_pending: results.revert?.pending_approval?.length || 0,
    reverts_blocked: results.revert?.blocked?.length || 0,
    queue_executed: results.queue?.executed || 0,
    queue_expired: results.queue?.expired || 0,
    experiments_closed: results.experiments?.closed?.length || 0,
    floor_alerts: results.reconcile?.alerts?.length || 0,
  };
  const changed = Object.values(changes).reduce((a, b) => a + b, 0);
  const summary = { ok: errors.length === 0, at: when, trigger, actor: actor || trigger, kinds: list, dryRun: !!dryRun, results, changes, changed, errors };

  if (!dryRun) recordRun(summary);
  else recordDryRun(summary);
  return summary;
}

/** Persist the cycle counters + a small run history that survives restarts. */
export function recordRun(summary) {
  const d = load();
  d.jobs ||= {};
  d.jobs.counters ||= { cycles: 0, errors: 0, dryRuns: 0 };
  d.jobs.runs ||= [];
  const id = `CY-${String(d.jobs.counters.cycles + 1).padStart(4, '0')}`;
  d.jobs.counters.cycles += 1;
  if (summary.errors?.length) d.jobs.counters.errors += summary.errors.length;
  d.jobs.runs.push({
    cycleId: id, at: summary.at, trigger: summary.trigger, kinds: summary.kinds,
    changed: summary.changed, changes: summary.changes,
    ok: summary.ok, errors: summary.errors?.map((e) => e.message) || [],
  });
  if (d.jobs.runs.length > 200) d.jobs.runs = d.jobs.runs.slice(-100);
  d.jobs.lastRun = d.jobs.runs[d.jobs.runs.length - 1];
  save();
  logEvent('scheduler.cycle', { cycleId: id, at: summary.at, kinds: summary.kinds, changed: summary.changed, ok: summary.ok });
  return d.jobs.lastRun;
}

function recordDryRun(summary) {
  const d = load();
  d.jobs ||= {};
  d.jobs.counters ||= { cycles: 0, errors: 0, dryRuns: 0 };
  d.jobs.counters.dryRuns += 1;
  d.jobs.lastDryRun = { at: summary.at, kinds: summary.kinds, changed: summary.changed, wouldChange: summary.changes };
  save();
  return d.jobs.lastDryRun;
}

/** What the scheduler would find interesting right now (read-only). */
export function preview({ at = new Date().toISOString() } = {}) {
  at = toIso(at);
  const d = load();
  const now = Date.parse(at);
  const due = [];
  for (const r of d.recommendations || []) {
    const judgeAt = r.observation?.judgeAt ? Date.parse(r.observation.judgeAt) : null;
    if (['APPLIED', 'OBSERVING'].includes(r.status) && judgeAt && judgeAt <= now) {
      due.push({ recommendation_id: r.recommendation_id, listing_id: r.listing_id, sku: r.sku, status: r.status, judge_at: r.observation.judgeAt, waiting_on: (waitingOn(r, { at })).missing });
    }
  }
  return {
    at,
    due_observations: due,
    reverts_pending: (d.recommendations || []).filter((r) => r.revert && !r.reverted?.at).length,
    reverts_armed: (d.recommendations || []).filter((r) => ['APPLIED', 'OBSERVING'].includes(r.status) && r.applied?.at && now - Date.parse(r.applied.at) >= 14 * DAY
      && (r.outcome?.verdict === 'LOSS' || r.outcome?.quality?.pass === false)).length,
    queue_open: (d.actions || []).filter((a) => ['PROPOSED', 'APPROVED', 'AUTONOMOUS', 'QUEUED'].includes(a.status)).length,
    experiments_running: (d.experiments || []).filter((x) => x.status === 'RUNNING').length,
    experiments_due_to_close: (d.experiments || []).filter((x) => x.status === 'RUNNING' && x.ends_at && Date.parse(x.ends_at) <= now).length,
    jobs_last_run: d.jobs?.lastRun || null,
    rounds_recorded: (d.jobs?.runs || []).length,
    note: 'Read-only preview: what the next cycle would act on. Nothing is written.',
  };
}

export { round2, iso };
