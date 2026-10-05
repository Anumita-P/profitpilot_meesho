/**
 * THE SCHEDULER (phase 2 of the loop).
 *
 * One configurable interval. Every tick runs a recalc cycle (src/jobs/recalc.js)
 * at an explicit clock time, records what it changed, and can be inspected or
 * driven by hand:
 *
 *   start({ intervalMs, kinds })  - begin ticking (created STOPPED; control is explicit)
 *   stop({ reason })              - stop ticking, keep the history
 *   runNow({ at, kinds, dryRun }) - run one cycle now, or at a given instant
 *   status()                      - running?, interval, last run, counters, errors, history
 *   preview()                     - what a cycle would find interesting (read-only)
 *   _reset()                      - deterministic hook for tests
 *
 * The scheduler is created but never started at boot: a demo that changes state
 * whenever it feels like it cannot be reviewed. A manual run may carry an explicit
 * `at`, which is how the reproducible demo time-travels - the store's own history
 * decides what is due, so nothing is faked. A run more than a month ahead of the
 * wall clock is refused: nothing in the store can justify a verdict about time
 * that has not passed.
 *
 * Jobs never move a price directly. applyPrice() (src/domain/apply.js) is the one
 * guarded write, and only the revert job may call it.
 */

import { load } from '../store/db.js';
import { runCycle, preview as recalcPreview, JOB_NAMES, MAX_LOOKAHEAD_DAYS } from './recalc.js';

export const JOBS = JOB_NAMES;
export const DEFAULT_INTERVAL_MS = 60_000;

const state = {
  timer: null,
  intervalMs: DEFAULT_INTERVAL_MS,
  startedAt: null,
  stoppedAt: null,
  stopReason: null,
  ticks: 0,
  lastRun: null,
  lastError: null,
  clock: null,          // an explicit clock for hand-driven runs
  history: [],          // in-process history (the store keeps the durable one)
};

/** Run one cycle. `at` defaults to the scheduler's clock, then to the wall clock. */
export function runNow({ at = null, kinds = null, dryRun = false, trigger = 'manual' } = {}) {
  const when = at || state.clock || new Date().toISOString();
  let summary;
  try {
    summary = runCycle({ at: when, kinds: kinds || JOB_NAMES, dryRun, trigger });
  } catch (err) {
    state.lastError = { at: when, message: err.message, status: err.status ?? 500 };
    throw err;
  }
  if (summary.ok === false && summary.refused) {
    /* a refused run did not run: it is not an error and it is not a cycle */
    state.history.push({ at: when, trigger, refused: summary.refused, changed: 0 });
    if (state.history.length > 100) state.history = state.history.slice(-60);
    return summary;
  }
  if (!dryRun) {
    state.ticks += 1;
    state.lastRun = load().jobs?.lastRun || { at: when, changed: summary.changed };
    state.lastError = summary.errors?.length ? { at: when, message: summary.errors.map((e) => e.message).join('; ') } : null;
  }
  state.history.push({ at: when, trigger, dryRun: !!dryRun, changed: summary.changed, changes: summary.changes, ok: summary.ok });
  if (state.history.length > 100) state.history = state.history.slice(-60);
  return summary;
}

export function start({ intervalMs = state.intervalMs, kinds = null, at = null, runImmediately = false, reason = null } = {}) {
  stop({ reason: 'restarting' });
  state.intervalMs = Math.max(1000, Number(intervalMs) || DEFAULT_INTERVAL_MS);
  state.startedAt = at || state.clock || new Date().toISOString();
  state.stoppedAt = null;
  state.stopReason = reason || null;
  state.timer = setInterval(() => {
    try { runNow({ trigger: 'tick' }); } catch { /* recorded in state.lastError */ }
  }, state.intervalMs);
  if (state.timer.unref) state.timer.unref();
  if (runImmediately) runNow({ trigger: 'start' });
  return status();
}

export function stop({ reason = null } = {}) {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  state.stoppedAt = new Date().toISOString();
  state.stopReason = reason;
  return status();
}

export function status() {
  const d = load();
  const counters = d.jobs?.counters || { cycles: 0, errors: 0, dryRuns: 0 };
  const persistedRuns = (d.jobs?.runs || []).slice(-20).reverse();
  return {
    running: !!state.timer,
    intervalMs: state.intervalMs,
    interval_ms: state.intervalMs,
    ticks: state.ticks,
    startedAt: state.startedAt,
    started_at: state.startedAt,
    stoppedAt: state.stoppedAt,
    stopped_at: state.stoppedAt,
    stopReason: state.stopReason,
    clock: state.clock,
    lastRun: state.lastRun || d.jobs?.lastRun || null,
    lastDryRun: d.jobs?.lastDryRun || null,
    counters,
    errors: state.lastError ? [state.lastError, ...state.history.filter((h) => h.ok === false)] : state.history.filter((h) => h.ok === false),
    history: state.history.slice(-20).reverse(),
    persistedRuns,
    jobs: JOB_NAMES,
    kinds: JOB_NAMES,
    lookaheadDays: MAX_LOOKAHEAD_DAYS,
    nextRunAt: state.timer && state.lastRun ? new Date(Date.parse(state.lastRun.at) + state.intervalMs).toISOString() : null,
    note: 'Created STOPPED. Tests and the demo drive it with runNow({ at }) so time is explicit and the result is reproducible.',
  };
}

export function preview(opts = {}) {
  return recalcPreview(opts);
}

/** Recent runs, newest first (in-process first, then the durable history). */
export function history({ limit = 20 } = {}) {
  const d = load();
  return {
    process: state.history.slice(-limit).reverse(),
    persisted: (d.jobs?.runs || []).slice(-limit).reverse(),
  };
}

/** Set an explicit clock for hand-driven runs (the demo's time travel). */
export function setClock(at) {
  state.clock = at;
  return { clock: state.clock };
}

/** Deterministic test hook: stop ticking and forget the in-process state. */
export function _reset() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  state.intervalMs = DEFAULT_INTERVAL_MS;
  state.startedAt = null;
  state.stoppedAt = null;
  state.stopReason = null;
  state.ticks = 0;
  state.lastRun = null;
  state.lastError = null;
  state.clock = null;
  state.history = [];
  return status();
}

export { JOB_NAMES as kinds, DEFAULT_INTERVAL_MS as intervalDefault };
