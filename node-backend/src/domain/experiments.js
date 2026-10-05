/**
 * EXPERIMENTS + PERSISTENT HOLDOUTS (phase 3).
 *
 * The pilot on deck slide 8 is 250 vs 250 sellers with a permanent 5% holdout
 * and a hard rule: no lift claim without valid treatment + holdout evidence.
 * This module makes that infrastructure persistent and reusable for any
 * intervention, not just the city pilot:
 *
 *   experiment_id, seller/listing/cohort, treatment group, holdout group,
 *   intervention, start/end dates, primary metric, guardrail metrics, status,
 *   results.
 *
 * Three deliberate properties:
 *
 *   1. DETERMINISTIC ASSIGNMENT. A unit (seller, listing or SKU-week) is
 *      assigned by hashing experiment_id + unit_id, so the same unit always
 *      lands in the same arm. No random state to persist, and a judge can
 *      recompute any assignment by hand.
 *   2. HONEST STATISTICS. The impact report gives a difference in means with a
 *      normal-approximation interval and an explicit `enoughData` flag. It never
 *      prints a p-value it cannot support, never claims significance under the
 *      pilot's power threshold, and always says what the sample could detect.
 *      (Deck slide 9 M23: n = 251 per arm to detect ₹10.)
 *   3. claimGuard STAYS IN CHARGE. `generateClaim()` delegates to
 *      src/engine/pilot.js claimGuard(): if either arm is missing, the claim is
 *      refused with the deck's wording. Nothing here overrides it.
 */

import { load, save, logEvent, httpError } from '../store/db.js';
import { PILOT } from '../config/deck.js';
import { claimGuard, sampleSize } from '../engine/pilot.js';
import { number, text, enumValue, timestamp, id as idRule, object } from '../http/validate.js';
import { versionSet } from './versions.js';

export const EXPERIMENT_STATUS = ['DRAFT', 'RUNNING', 'STOPPED', 'CLOSED'];
export const ARMS = ['treatment', 'holdout'];

const r2 = (x) => Math.round(x * 100) / 100;

function nextId(d) {
  d.counters.experiments = (d.counters.experiments || 0) + 1;
  return `EXP-${String(d.counters.experiments).padStart(4, '0')}`;
}

function find(d, id) {
  const e = (d.experiments || []).find((x) => x.experiment_id === id);
  if (!e) throw httpError(404, `unknown experiment: ${id}`);
  return e;
}

/** Stable 32-bit hash: the same unit always gets the same arm. */
export function hashUnit(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** Weights: the deck's permanent 5% holdout by default. */
export function armFor(experiment, unitId) {
  const pct = experiment.design?.holdoutPct ?? 5;
  const bucket = hashUnit(`${experiment.experiment_id}|${unitId}`) % 100;
  return bucket < pct ? 'holdout' : 'treatment';
}

/* --------------------------------- create --------------------------------- */

export function create(input = {}, ctx = {}) {
  const d = load();
  const exp = {
    experiment_id: nextId(d),
    name: text(input.name, 'name', { maxLength: 120 }),
    scope: enumValue(input.scope || 'listing', 'scope', ['seller', 'listing', 'cohort', 'sku_week']),
    seller_id: idRule(input.seller_id ?? input.sellerId ?? ctx.sellerId, 'seller_id'),
    listing_id: input.listing_id ? idRule(input.listing_id, 'listing_id') : null,
    cohort: input.cohort ? text(input.cohort, 'cohort', { maxLength: 80 }) : null,
    intervention: {
      kind: enumValue(input.intervention?.kind || 'price_change', 'intervention.kind', ['price_change', 'dual_price', 'listing_fix', 'programme', 'no_op']),
      description: text(input.intervention?.description || input.description || 'untitled intervention', 'intervention.description', { maxLength: 300 }),
      payload: object(input.intervention?.payload, 'intervention.payload', { required: false }) || {},
    },
    design: {
      treatment: text(input.design?.treatment || 'engine price decisions', 'design.treatment', { maxLength: 120 }),
      holdout: text(input.design?.holdout || 'unchanged price (holdout)', 'design.holdout', { maxLength: 120 }),
      holdoutPct: number(input.design?.holdoutPct ?? 5, 'design.holdoutPct', { min: 1, max: 50 }),
      unit: enumValue(input.design?.unit || 'listing', 'design.unit', ['seller', 'listing', 'sku_week']),
      randomisation: 'deterministic hash of experiment_id + unit_id (recomputable by hand)',
    },
    primary_metric: text(input.primary_metric || 'contribution_per_kept_order', 'primary_metric', { maxLength: 60 }),
    guardrail_metrics: Array.isArray(input.guardrail_metrics) && input.guardrail_metrics.length
      ? input.guardrail_metrics.slice(0, 10).map((s) => String(s).slice(0, 60))
      : ['return_rate_pct', 'rto_rate_pct', 'cancellation_rate_pct', 'cvr_pct'],
    status: 'DRAFT',
    started_at: null,
    ends_at: input.ends_at ? timestamp(input.ends_at, 'ends_at') : null,
    closed_at: null,
    observations: [],
    results: null,
    stop_rules: (PILOT.impact?.stopRules || []).map((r) => (typeof r === 'string' ? r : `${r.rule} -> ${r.action}`)),
    versions: versionSet(),
    created_at: new Date().toISOString(),
    correlation_id: ctx.correlationId || null,
  };
  d.experiments.push(exp);
  logEvent('experiment.created', {
    experimentId: exp.experiment_id, sellerId: exp.seller_id, listingId: exp.listing_id,
    intervention: exp.intervention.kind, holdoutPct: exp.design.holdoutPct,
  });
  save();
  return exp;
}

export function start(id, { at = null } = {}) {
  const d = load();
  const e = find(d, id);
  if (e.status === 'RUNNING') return e;
  if (!['DRAFT', 'STOPPED'].includes(e.status)) throw httpError(409, `cannot start an experiment in status ${e.status}`);
  e.status = 'RUNNING';
  e.started_at = at ? new Date(at).toISOString() : new Date().toISOString();
  logEvent('experiment.started', { experimentId: id });
  save();
  return e;
}

export function stop(id, { reason = null, at = null } = {}) {
  const d = load();
  const e = find(d, id);
  if (e.status !== 'RUNNING') throw httpError(409, `cannot stop an experiment in status ${e.status}`);
  e.status = 'STOPPED';
  e.stopped_reason = reason;
  e.stopped_at = at ? new Date(at).toISOString() : new Date().toISOString();
  logEvent('experiment.stopped', { experimentId: id, reason });
  save();
  return e;
}

/* -------------------------------- assignment ------------------------------ */

export function assign(id, unitId) {
  const d = load();
  const e = find(d, id);
  const unit = idRule(unitId, 'unit_id');
  const arm = armFor(e, unit);
  e.assignment ||= {};
  e.assignment[unit] = arm;
  save();
  return { experiment_id: id, unit_id: unit, arm, bucket: hashUnit(`${id}|${unit}`) % 100, holdoutPct: e.design.holdoutPct };
}

/** Group view: who is in treatment, who is in holdout. */
export function groups(id, unitIds = []) {
  const d = load();
  const e = find(d, id);
  const A = e.assignment || {};
  const units = unitIds.length ? unitIds : Object.keys(A);
  const treatment = units.filter((u) => (A[u] || armFor(e, u)) === 'treatment');
  const holdout = units.filter((u) => (A[u] || armFor(e, u)) === 'holdout');
  return {
    experiment_id: id,
    unit: e.design.unit,
    treatment: { count: treatment.length, units: treatment },
    holdout: { count: holdout.length, units: holdout },
    holdoutPct: e.design.holdoutPct,
    note: 'assignment is deterministic: hash(experiment_id + unit_id) % 100 < holdoutPct -> holdout',
  };
}

/* ------------------------------ observations ------------------------------ */

/**
 * Record one observation. Either arm's data can arrive; the report refuses to
 * compute anything until BOTH arms have data (phase 3 requirement: a claim must
 * fail when valid treatment + holdout evidence is missing).
 */
export function observe(id, input = {}) {
  const d = load();
  const e = find(d, id);
  const arm = enumValue(input.arm, 'arm', ARMS);
  const obs = {
    observation_id: `XO-${e.observations.length + 1}`,
    arm,
    unit_id: input.unit_id ? idRule(input.unit_id, 'unit_id') : null,
    window: {
      from: timestamp(input.window?.from ?? input.from, 'window.from', { required: true }),
      to: timestamp(input.window?.to ?? input.to, 'window.to', { required: true }),
    },
    metrics: {
      units: number(input.metrics?.units ?? input.units, 'metrics.units', { min: 0, max: 1_000_000, required: false }) ?? null,
      keptOrders: number(input.metrics?.keptOrders ?? input.keptOrders, 'metrics.keptOrders', { min: 0, max: 1_000_000, required: false }) ?? null,
      views: number(input.metrics?.views ?? input.views, 'metrics.views', { min: 0, max: 100_000_000, required: false }) ?? null,
      orders: number(input.metrics?.orders ?? input.orders, 'metrics.orders', { min: 0, max: 1_000_000, required: false }) ?? null,
      contribution: number(input.metrics?.contribution ?? input.contribution, 'metrics.contribution', { min: -1e9, max: 1e9 }),
      contributionPerKeptOrder: input.metrics?.contributionPerKeptOrder ?? input.contributionPerKeptOrder ?? null,
      returnRatePct: input.metrics?.returnRatePct ?? input.returnRatePct ?? null,
      rtoRatePct: input.metrics?.rtoRatePct ?? input.rtoRatePct ?? null,
      cancellationRatePct: input.metrics?.cancellationRatePct ?? input.cancellationRatePct ?? null,
      cvrPct: input.metrics?.cvrPct ?? input.cvrPct ?? null,
    },
    source: text(input.source || 'api', 'source', { maxLength: 40 }),
    recorded_at: new Date().toISOString(),
  };
  if (obs.metrics.contribution == null && obs.metrics.contributionPerKeptOrder == null) {
    throw httpError(400, 'metrics.contribution or metrics.contributionPerKeptOrder is required');
  }
  e.observations.push(obs);
  logEvent('experiment.observed', { experimentId: id, arm, unitId: obs.unit_id, window: obs.window });
  save();
  return obs;
}

/* ---------------------------------- impact -------------------------------- */

function mean(xs) {
  const v = xs.filter((x) => x != null && Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}
function sd(xs) {
  const v = xs.filter((x) => x != null && Number.isFinite(x));
  if (v.length < 2) return null;
  const m = mean(v);
  return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1));
}

/**
 * Difference in means with a normal-approximation 95% interval. Honest about
 * small samples: `enoughData` is false until each arm has >= 2 observations and
 * the interval is reported regardless, with a plain-language reading.
 */
export function impact(id) {
  const d = load();
  const e = find(d, id);
  const metricOf = (o) => (o.metrics.contributionPerKeptOrder != null
    ? o.metrics.contributionPerKeptOrder
    : (o.metrics.keptOrders ? o.metrics.contribution / o.metrics.keptOrders : o.metrics.contribution));
  const t = e.observations.filter((o) => o.arm === 'treatment').map(metricOf).filter((x) => x != null);
  const h = e.observations.filter((o) => o.arm === 'holdout').map(metricOf).filter((x) => x != null);

  const mt = mean(t); const mh = mean(h);
  const st = sd(t); const sh = sd(h);
  const nT = t.length; const nH = h.length;
  const both = mt != null && mh != null;
  const se = nT > 1 && nH > 1 && st != null && sh != null
    ? Math.sqrt((st * st) / nT + (sh * sh) / nH)
    : null;
  const diff = both ? mt - mh : null;
  const ci = se != null ? { low: r2(diff - 1.96 * se), high: r2(diff + 1.96 * se) } : null;
  const perArm = sampleSize();

  return {
    experiment_id: id,
    status: e.status,
    primary_metric: e.primary_metric,
    arms: {
      treatment: { observations: nT, mean: mt == null ? null : r2(mt), sd: st == null ? null : r2(st) },
      holdout: { observations: nH, mean: mh == null ? null : r2(mh), sd: sh == null ? null : r2(sh) },
    },
    lift: both && mh !== 0 ? r2((mt - mh) / Math.abs(mh) * 100) : null,
    difference: diff == null ? null : r2(diff),
    ci95: ci,
    enoughData: nT >= 2 && nH >= 2,
    powerNote: `The deck's pilot design needs n ≈ ${perArm.nPerArm} per arm to detect ₹${perArm.inputs.delta} per kept order (sigma ${perArm.inputs.sigma}). These are ${nT} vs ${nH} observations, so treat any interval as directional, not decisive.`,
    guardrailMetrics: guardrailReport(e),
    observedStopRules: observedStopRules(e),
    note: 'No p-value is printed: with a handful of observations a p-value would be theatre. The interval and the power note say what the sample can and cannot support.',
  };
}

function guardrailReport(e) {
  const pick = (o) => ({
    returnRatePct: o.metrics.returnRatePct,
    rtoRatePct: o.metrics.rtoRatePct,
    cancellationRatePct: o.metrics.cancellationRatePct,
    cvrPct: o.metrics.cvrPct,
  });
  const agg = (arm) => {
    const rows = e.observations.filter((o) => o.arm === arm).map(pick);
    const out = {};
    for (const k of ['returnRatePct', 'rtoRatePct', 'cancellationRatePct', 'cvrPct']) {
      const vals = rows.map((r) => r[k]).filter((x) => x != null);
      out[k] = vals.length ? r2(mean(vals)) : null;
    }
    return out;
  };
  const t = agg('treatment'); const h = agg('holdout');
  const checks = Object.keys(t).map((k) => ({
    key: k,
    treatment: t[k],
    holdout: h[k],
    deltaPp: t[k] != null && h[k] != null ? r2(t[k] - h[k]) : null,
  }));
  return { treatment: t, holdout: h, checks };
}

/** Apply the deck's stop rules to whatever observations exist. */
function observedStopRules(e) {
  const triggered = [];
  const g = guardrailReport(e);
  const cvr = g.checks.find((c) => c.key === 'cvrPct');
  if (cvr && cvr.deltaPp != null && cvr.deltaPp <= -5) triggered.push({ rule: 'Buyer conversion > 5% below holdout at a similar price', action: 'pause Autopilot' });
  if (e.design.holdoutPct < 1) triggered.push({ rule: 'No holdout to compare against', action: 'do not claim anything' });
  return { triggered, all: e.stop_rules };
}

/* --------------------------------- close ---------------------------------- */

export function close(id, { at = null, note = null } = {}) {
  const d = load();
  const e = find(d, id);
  if (e.status === 'CLOSED') return e;
  const report = impact(id);
  e.status = 'CLOSED';
  e.closed_at = at ? new Date(at).toISOString() : new Date().toISOString();
  e.results = { ...report, closedAt: e.closed_at, note };
  logEvent('experiment.closed', {
    experimentId: id, treatment: report.arms.treatment.observations, holdout: report.arms.holdout.observations,
    lift: report.lift, enoughData: report.enoughData,
  });
  save();
  return e;
}

/**
 * A claim is what may be said publicly. claimGuard decides - this function only
 * assembles the inputs and refuses to invent them.
 */
export function generateClaim(id, { requested = null } = {}) {
  const d = load();
  const e = find(d, id);
  const report = e.results || impact(id);
  const treatmentObs = report.arms.treatment.observations;
  const holdoutObs = report.arms.holdout.observations;
  const claimText = requested || (report.lift != null
    ? `${report.lift > 0 ? '+' : ''}${report.lift}% ${e.primary_metric.replace(/_/g, ' ')} vs holdout`
    : 'impact not measured yet');

  // Two gates, both must pass. Gate 1 is ours: the evidence must be big enough to
  // be worth reading at all (>= 2 observations per arm, the point at which an
  // interval exists). Gate 2 is the deck's own claimGuard() in pilot.js, which
  // refuses anything without a holdout comparison. Neither can be skipped by a
  // caller; both are reported in the claim object.
  const enough = !!report.enoughData;
  const guard = enough
    ? claimGuard(claimText, {
      hasHoldout: holdoutObs > 0 && treatmentObs > 0,
      treated: report.arms.treatment.mean,
      holdout: report.arms.holdout.mean,
    })
    : {
      allowed: false,
      reason: `Not enough evidence to claim anything: ${treatmentObs} treatment vs ${holdoutObs} holdout observation(s); at least 2 valid observations per arm are needed before an interval exists (the deck's pilot design runs ~${sampleSize().nPerArm} sellers per arm).`,
    };

  const claim = {
    experiment_id: id,
    requested: claimText,
    allowed: guard.allowed,
    reason: guard.reason || null,
    evidenceGate: {
      enough: enough,
      rule: '>= 2 observations per arm before a lift may be claimed',
    },
    evidence: {
      treatment: { observations: treatmentObs, mean: report.arms.treatment.mean, unit: e.design.unit },
      holdout: { observations: holdoutObs, mean: report.arms.holdout.mean, unit: e.design.unit },
      difference: report.difference ?? null,
      ci95: report.ci95 ?? null,
      enoughData: !!report.enoughData,
      primary_metric: e.primary_metric,
    },
    wordingIfAllowed: guard.allowed
      ? `${claimText} (${treatmentObs} treated vs ${holdoutObs} holdout observations; ${e.primary_metric.replace(/_/g, ' ')})`
      : null,
    disclaimer: 'Illustrative demo data. A claim is only ever as good as the holdout behind it.',
    guard: 'gate 1: experiment evidence gate; gate 2: src/engine/pilot.js claimGuard() (unchanged by this module)',
  };
  logEvent('experiment.claim', { experimentId: id, allowed: guard.allowed, requested: claimText });
  save();
  return claim;
}

/* --------------------------------- queries -------------------------------- */

export function get(id) {
  return find(load(), id);
}

export function list(filter = {}) {
  const d = load();
  let all = (d.experiments || []).slice();
  if (filter.sellerId) all = all.filter((e) => e.seller_id === filter.sellerId);
  if (filter.listingId) all = all.filter((e) => e.listing_id === filter.listingId);
  if (filter.status) {
    const s = Array.isArray(filter.status) ? filter.status : [filter.status];
    all = all.filter((e) => s.includes(e.status));
  }
  return all.slice().reverse();
}

/** The holdout this seller's listing is in, if any - used by the recommender. */
export function holdoutFor(listingId) {
  const d = load();
  const e = (d.experiments || []).find((x) => x.listing_id === listingId
    && x.status === 'RUNNING' && armFor(x, listingId) === 'holdout');
  return e ? { experiment_id: e.experiment_id, arm: 'holdout', note: 'this listing is in the holdout: the engine measures, it does not intervene' } : null;
}

/** One-call summary for the UI: state of the loop's experiment layer. */
export function summary(filter = {}) {
  const all = list(filter);
  return {
    total: all.length,
    running: all.filter((e) => e.status === 'RUNNING').length,
    closed: all.filter((e) => e.status === 'CLOSED').length,
    withResults: all.filter((e) => e.results).length,
    experiments: all.slice(0, 10).map((e) => ({
      experiment_id: e.experiment_id,
      name: e.name,
      status: e.status,
      listing_id: e.listing_id,
      holdoutPct: e.design.holdoutPct,
      observations: e.observations.length,
      lift: e.results?.lift ?? null,
      enoughData: e.results?.enoughData ?? null,
    })),
    claimGuard: 'no claim without treatment + holdout evidence (src/engine/pilot.js)',
  };
}
