/**
 * DATA layer (deck slide 7 box 1) + persistence.
 *
 * Deliberately dependency-free: the prototype stores its state in one JSON
 * snapshot plus an append-only event log (data/events.jsonl). Swapping this for
 * Postgres is a single module change - every caller goes through the helpers
 * below, and nothing outside this file touches the filesystem.
 *
 * In production this is where Meesho's own tables would sit: orders, cancels,
 * RTO, returns + reason codes, impressions/clicks, inventory, settlements,
 * pincode/COD history, live catalogue.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SKUS } from '../config/deck.js';
import { seedDatabase } from './seed.js';
import { createStorage } from './storage.js';
import { computeFloor } from '../engine/floor.js';
import { classifyStage, stageWindows } from '../engine/lifecycle.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
export const DATA_DIR = process.env.PP_DATA_DIR || path.join(ROOT, 'data');

/* Every file read/write goes through the Storage seam (src/store/storage.js).
   Callers here are unchanged, so swapping in SQLite later touches one file. */
export const storage = createStorage({ dir: DATA_DIR, seed: seedDatabase });

export const DB_FILE = path.join(DATA_DIR, 'db.json');
export const EVENTS_FILE = path.join(DATA_DIR, 'events.jsonl');

let db = null;

/* ------------------------------- load / save ------------------------------- */
export function load() {
  if (db) return db;
  db = migrate(storage.read());
  return db;
}

/**
 * Collections added by the closed-loop build. Each is additive: an existing
 * database keeps every field it had and gains empty arrays/maps.
 */
function migrate(d) {
  d.sellers ||= {};
  d.listings ||= {};
  d.decisions ||= [];
  d.bandit ||= {};
  d.counters ||= { decisions: 0, moves: 0, events: 0, recommendations: 0, actions: 0, experiments: 0 };
  d.ageDays ||= {};              // demo clock per listing (scheduler advances this)
  d.ingestedEvents ||= [];       // the unified event stream (phase 1)
  d.recommendations ||= [];      // recommendation lifecycle records (phase 1)
  d.actions ||= [];              // action queue (phase 5)
  d.experiments ||= [];          // persistent experiments + holdouts (phase 3)
  d.observations ||= [];         // per-recommendation observation windows (phase 2)
  d.outcomes ||= [];             // closed-loop outcomes (phase 2)
  d.idempotency ||= {};          // request-id -> stored response (phase 6)
  d.sessions ||= {};             // demo sessions (phase 6)
  d.jobs ||= {};                 // scheduler job state (phase 4)
  d.reverts ||= [];              // triggered reverts (phase 4)
  d.audit ||= [];                // structured action audit trail (phase 5)
  /* v2 (Decision Intelligence): simulations, portfolios, promotions, regions */
  d.scenarios ||= [];            // seller/market simulator scenarios (v2 phase 1)
  d.simRuns ||= [];              // one row per simulation run/advance (v2 phase 1)
  d.portfolios ||= {};           // seller -> portfolio policy + cached rollups (v2 phase 2)
  d.promotions ||= [];           // promotion state per listing (v2 phase 4)
  d.regions ||= [];              // pincode-cluster aggregates (v2 phase 7)
  return d;
}

export function flush() {
  if (!db) return;
  storage.write(db);
}

/**
 * Writes can be suspended for a dry run: the cycle executes against real data
 * in memory, reports what it would do, and the caller restores the snapshot, so
 * nothing reaches the disk.
 */
let writesSuspended = false;
export function suspendWrites(on) { writesSuspended = !!on; return writesSuspended; }

/** Debounced save so a burst of API calls writes once. */
export function save() {
  if (!db || writesSuspended) return;
  storage.write(db);
}

export function reset() {
  db = migrate(seedDatabase());
  storage.snapshot = db;
  storage.flush();
  storage.clearEvents();
  return db;
}

/* --------------------------------- events --------------------------------- */
/** Append-only audit log. Deck slide 9 limit 5: "we do not always know which advice was applied" -> 2.0 fixes it with action tracking. */
export function logEvent(type, payload = {}) {
  load();
  const event = {
    id: `EV-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    ts: new Date().toISOString(), type, ...payload,
  };
  db.events = db.events || [];
  db.events.push(event);
  if (db.events.length > 2000) db.events = db.events.slice(-1500);
  storage.appendEvent(event);
  save();
  return event;
}

export function events(limit = 50) {
  const d = load();
  return (d.events || []).slice(-limit).reverse();
}

/** Technical error log - separate from the business audit trail (phase 12). */
export function logError(record) {
  try { storage.appendError(record); } catch { /* console only */ }
}
export function errorLog(limit = 50) {
  return storage.readErrors(limit);
}

/* -------------------------------- sellers --------------------------------- */
export function sellers() {
  return Object.values(load().sellers);
}
export function seller(id) {
  const s = load().sellers[id];
  if (!s) throw httpError(404, `unknown seller: ${id}`);
  return s;
}
export function saveSeller(s) {
  load().sellers[s.id] = s;
  save();
  return s;
}

/* -------------------------------- listings -------------------------------- */
export function listings(sellerId) {
  const all = Object.values(load().listings);
  if (!sellerId) return all;
  const ids = Array.isArray(sellerId) ? sellerId : [sellerId];
  return all.filter((l) => ids.includes(l.sellerId));
}
export function listing(id) {
  const l = load().listings[id];
  if (!l) throw httpError(404, `unknown listing: ${id}`);
  return l;
}
export function saveListing(l, eventType, payload = {}) {
  load().listings[l.id] = l;
  save();
  if (eventType) logEvent(eventType, { listingId: l.id, sku: l.skuKey, ...payload });
  return l;
}
export function listingBySku(sellerId, skuKey) {
  return listings(sellerId).find((l) => l.skuKey === skuKey);
}

/**
 * Attach everything the engines need to a listing row: the SKU object, the
 * lifecycle stage and windows, the floor, health and the health reasons.
 * Engines stay pure; the view model is built here.
 */
export function hydrate(l) {
  const sku = SKUS[l.skuKey];
  if (!sku) throw httpError(500, `listing ${l.id} points at unknown SKU ${l.skuKey}`);
  const floor = computeFloor(l.skuKey, l.costOverrides || {});
  const stageInfo = classifyStage({
    sku,
    ageDays: l.ageDays,
    keptUnitTrendPct: l.signals.keptUnitTrendPct,
    doi: l.signals.doi,
    stockAgeDays: l.signals.stockAgeDays,
    sellThroughPct: l.signals.sellThroughPct,
  });
  const margin = l.price - floor.F;
  const returnRate = l.costOverrides?.ret ?? sku.costs.ret;
  const health = (margin < 20 || l.signals.doi < 10 || l.signals.doi > 60 || returnRate > 20)
    ? { key: 'n', label: 'Needs attention', color: '#D32F2F' }
    : (margin >= 50 && returnRate < 15 && l.signals.doi >= 20 && l.signals.doi <= 60)
      ? { key: 'h', label: 'Healthy', color: '#1B8A5A' }
      : { key: 'w', label: 'Watch', color: '#F58A0B' };
  const bandit = (load().bandit || {})[`${l.id}:${l.mode || 'growth'}`];
  const priceTestImpressions = bandit ? bandit.arms.reduce((x, a) => x + a.n, 0) : 0;
  return {
    ...l,
    sku,
    floor,
    priceTestImpressions,
    mode: l.mode || 'growth',
    stage: stageInfo.stage,
    stageInfo,
    stageWindow: stageWindows(sku),
    signals: { ...l.signals, band: [sku.band[0], sku.band[1]], price: l.price },
    health,
    margin,
    ordersPerDay: round2(l.signals.q0 ?? sku.ordersAtLive),
    daysSinceMove: l.daysSinceMove ?? 0,
    movesThisMonth: l.movesThisMonth ?? 0,
    q0: l.signals.q0 ?? sku.ordersAtLive,
  };
}

export function hydratedListings(sellerId) {
  return listings(sellerId).map(hydrate);
}

export function hydrateAll() {
  return listings().map(hydrate);
}

/* -------------------------------- decisions ------------------------------- */
export function decisions(filter = {}) {
  let all = load().decisions || [];
  if (filter.listingId) all = all.filter((d) => d.listingId === filter.listingId);
  if (filter.status) all = all.filter((d) => d.status === filter.status);
  return all.slice().reverse();
}

export function decision(id) {
  const d = (load().decisions || []).find((x) => x.id === id);
  if (!d) throw httpError(404, `unknown decision: ${id}`);
  return d;
}

export function addDecision(d) {
  const store = load();
  store.counters.decisions = (store.counters.decisions || 0) + 1;
  const rec = { id: `D-${String(store.counters.decisions).padStart(4, '0')}`, ...d };
  store.decisions = store.decisions || [];
  store.decisions.push(rec);
  save();
  return rec;
}

export function updateDecision(id, patch, eventType, payload = {}) {
  const d = decision(id);
  Object.assign(d, patch);
  save();
  if (eventType) logEvent(eventType, { decisionId: d.id, listingId: d.listingId, ...payload });
  return d;
}

/* --------------------------------- bandit --------------------------------- */
export function banditGet(key) {
  return load().bandit[key] || null;
}
export function banditSet(key, state) {
  load().bandit[key] = state;
  save();
  return state;
}
export function banditKeys() {
  return Object.keys(load().bandit || {});
}

/* --------------------------------- misc ---------------------------------- */
export function stats() {
  const d = load();
  const count = (arr, pred) => (arr || []).filter(pred || (() => true)).length;
  return {
    sellers: Object.keys(d.sellers).length,
    listings: Object.keys(d.listings).length,
    decisions: (d.decisions || []).length,
    events: (d.events || []).length,
    bandits: Object.keys(d.bandit || {}).length,
    ingestedEvents: (d.ingestedEvents || []).length,
    recommendations: (d.recommendations || []).length,
    recommendationsApplied: count(d.recommendations, (r) => ['APPLIED', 'OBSERVING', 'WON', 'NEUTRAL', 'LOST', 'RETAINED'].includes(r.status)),
    recommendationsRejected: count(d.recommendations, (r) => r.status === 'REJECTED'),
    recommendationsOverridden: count(d.recommendations, (r) => r.status === 'OVERRIDDEN'),
    blockedDecisions: count(d.audit, (a) => a.kind === 'guardrail.blocked'),
    reverts: (d.reverts || []).length,
    actions: (d.actions || []).length,
    actionsQueued: count(d.actions, (a) => ['QUEUED', 'EXECUTING'].includes(a.status)),
    experiments: (d.experiments || []).length,
    experimentsActive: count(d.experiments, (e) => e.status === 'RUNNING'),
    sessions: Object.keys(d.sessions || {}).length,
    jobs: Object.keys(d.jobs || {}).length,
    dataFile: DB_FILE,
    eventFile: EVENTS_FILE,
  };
}

export function httpError(status, message, detail) {
  const e = new Error(message);
  e.status = status;
  // a structured detail is part of the API contract: guardrail blocks explain
  // themselves, and callers must not have to parse a message string.
  if (detail !== undefined) e.detail = detail;
  return e;
}

const round2 = (x) => Math.round(x * 100) / 100;
export { round2 };
