/**
 * VERSION REGISTRY (phase 7 of the closed-loop build).
 *
 * The goal is reproducibility: given a recommendation from three weeks ago, we
 * must be able to say exactly which feature definition, which demand model,
 * which risk model, which lifecycle classifier, which guardrail set and which
 * economics produced it.
 *
 * Same philosophy as config/deck.js: every number and every model lives next to
 * the slide (or the rule) it came from. This file adds the *version* of each of
 * those pieces, so a stored recommendation is a reproducible artefact.
 *
 * Nothing here claims machine-learned accuracy. `implementation` says what is
 * running today; `replaceWith` says what a production build would swap in
 * behind the same interface (see src/engine/interfaces.js).
 */

import { ENGINE, GUARDRAILS, SERVICE } from '../config/deck.js';

/** Bump a version when the *behaviour* changes, not when the code is reformatted. */
export const VERSIONS = {
  feature_version: {
    value: 'features-1.0.0',
    what: 'Listing + SKU feature set used by every model',
    implementation: 'src/store/db.js hydrate() + src/engine/lifecycle.js stageSignals()',
    covers: ['q0 orders/day', 'price', 'cost overrides', 'views/clicks/CTR/CVR', 'DOI', 'kept-unit trend', 'COD share', 'delivery days'],
  },
  demand_model_version: {
    value: 'demand-1.0.0',
    what: `ln q = a + b ln p with b = ${ENGINE.BETA} + look-alike penalty (gamma = ${ENGINE.GAMMA})`,
    implementation: 'src/engine/demand.js ordersPerDay() / penalty() / shrinkage()',
    replaceWith: 'LightGBM monotone-in-price + hierarchical Bayes per category (deck slide 7 box 2)',
  },
  risk_model_version: {
    value: 'risk-1.0.0',
    what: 'Return / RTO risk from category priors, pincode cluster, COD share and fragility',
    implementation: 'src/engine/risk.js returnRisk() / keepProbability()',
    replaceWith: 'Gradient-boosted classifier on reason codes + pincode history (deck slide 7 box 2: AUC >= 0.75)',
  },
  lifecycle_model_version: {
    value: 'lifecycle-1.0.0',
    what: 'Stage windows scaled by category life; stage from kept-unit trend, DOI and age',
    implementation: 'src/engine/lifecycle.js classifyStage()',
    replaceWith: 'HMM / rules + smoothing on kept-unit trend (deck slide 7 box 2)',
  },
  guardrail_version: {
    value: 'guardrails-1.0.0',
    what: `Hard floor F, +-${GUARDRAILS.maxStepPct}% step, ${GUARDRAILS.cooldownDays}-day cooldown, <= ${GUARDRAILS.maxMovesPerMonth} moves/month, ${GUARDRAILS.minViewsForSanity}-view sanity check, ${GUARDRAILS.autoRevertDay}/${GUARDRAILS.confirmDay}-day revert, panic brake, herding cap`,
    implementation: 'src/engine/guardrails.js preflight() / panicBrake() / autoRevert()',
    replaceWith: 'nothing: this layer is deliberately rules, so it stays explainable and auditable',
  },
  economics_version: {
    value: 'economics-1.0.0',
    what: 'Floor arithmetic, kept-rate chain, dual-price gap and contribution definition',
    implementation: 'src/engine/floor.js computeFloor() + src/config/deck.js',
    replaceWith: 'rate cards and settlement reconciliation (pilot gate: floor within +-5% of settlement)',
  },
  recommender_version: {
    value: 'recommend-1.0.0',
    what: 'Mode-aware weekly card: freshness, stock, kept-rate and band logic + constrained Thompson bandit',
    implementation: 'src/engine/recommend.js recommend() + src/engine/bandit.js',
    replaceWith: 'the bandit stays; the demand model behind its arms is what gets replaced',
  },
  outcome_model_version: {
    value: 'outcome-1.0.0',
    what: 'Closed-loop outcome from ingested events: contribution per kept order (primary), customer-quality guardrails (secondary)',
    implementation: 'src/domain/outcomes.js computeOutcome()',
    replaceWith: 'CLV / repeat-season objective (deck slide 9 limit 6) once repeat data exists',
  },
  experiment_version: {
    value: 'experiment-1.0.0',
    what: 'Deterministic hash assignment, fixed-baseline comparison, honest intervals',
    implementation: 'src/domain/experiments.js',
    replaceWith: 'CUPED / sequential testing once volume allows (deck slide 8 M23: n = 251 per arm)',
  },
  api_version: {
    value: 'api-1.1.0',
    what: 'HTTP surface (62 routes in 1.0, extended in 1.1 with events, lifecycle, experiments, actions, jobs)',
    implementation: 'src/api/*.js',
    replaceWith: 'nothing; additive only',
  },
};

/** The exact set stamped onto every recommendation, decision, experiment and action. */
export function versionSet(extra = {}) {
  const out = {};
  for (const [k, v] of Object.entries(VERSIONS)) out[k] = v.value;
  out.stampedAt = new Date().toISOString();
  return { ...out, ...extra };
}

/** Human explanation for "why does this historical recommendation look like this". */
export function explainVersions(set = {}) {
  return Object.entries(VERSIONS)
    .filter(([k]) => set[k])
    .map(([k, v]) => ({
      key: k,
      version: set[k],
      what: v.what,
      implementation: v.implementation,
      replaceWith: v.replaceWith || 'stays as-is',
      changed: v.value !== set[k],
    }));
}

export const ENGINE_VERSION = `${SERVICE.engine} ${SERVICE.version}`;

export default VERSIONS;
