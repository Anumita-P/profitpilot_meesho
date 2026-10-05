/**
 * VERSION REGISTRY SURFACE (phase 7).
 *
 * The registry itself lives in src/domain/versions.js and is stamped onto every
 * recommendation, decision, action, experiment and outcome as they are created.
 * These routes make that visible and checkable, which is the only reason to keep
 * versions at all:
 *
 *   GET /api/versions                 the whole registry: value, what it governs,
 *                                     where it is implemented, what replaces it
 *   GET /api/versions/explain         the same, in the words of a reader asking
 *                                     "why does this old recommendation look like this?"
 *   GET /api/versions/for/:kind/:id   the set STAMPED on one stored artefact, with
 *                                     any drift against today's registry
 *   GET /api/versions/drift           everything in the store whose stamp no longer
 *                                     matches the registry
 *
 * Drift is reported honestly: today every version is a constant, so drift is
 * normally empty - it fills the moment someone bumps a version, which is exactly
 * when an old recommendation needs explaining.
 */

import { ok, fail } from '../http/respond.js';
import { load } from '../store/db.js';
import { VERSIONS, versionSet, explainVersions, ENGINE_VERSION } from '../domain/versions.js';
import * as session from '../http/session.js';

const KIND_TABLE = {
  recommendation: { collection: 'recommendations', id: (x) => x.recommendation_id, label: 'recommendation' },
  decision: { collection: 'decisions', id: (x) => x.id, label: 'decision' },
  action: { collection: 'actions', id: (x) => x.action_id, label: 'action' },
  experiment: { collection: 'experiments', id: (x) => x.experiment_id, label: 'experiment' },
  outcome: { collection: 'outcomes', id: (x) => x.outcome_id || x.recommendation_id, label: 'outcome' },
};

const REGISTRY_ROWS = () => Object.entries(VERSIONS).map(([key, v]) => ({
  key,
  version: v.value,
  what: v.what,
  implementation: v.implementation,
  replaceWith: v.replaceWith || 'stays as-is (rules, not a model)',
}));

/** Which artefact kinds carry the stamp, and where it is written. */
const STAMPED_ON = [
  { kind: 'recommendation', field: 'recommendations[].versions', writtenBy: 'src/domain/recommendations.js generate()' },
  { kind: 'decision', field: 'decisions[].versions', writtenBy: 'src/api/listings.js publish/decide path' },
  { kind: 'action', field: 'actions[].versions', writtenBy: 'src/domain/actions.js create()' },
  { kind: 'experiment', field: 'experiments[].versions', writtenBy: 'src/domain/experiments.js create()' },
  { kind: 'outcome', field: 'outcomes[].versions', writtenBy: 'src/domain/outcomes.js recordOutcome()' },
];

/** Compare a stored stamp against the registry: the honest reproducibility check. */
function driftFor(stamp = {}) {
  const current = versionSet();
  return Object.keys(VERSIONS)
    .filter((k) => stamp[k] && stamp[k] !== current[k])
    .map((k) => ({ key: k, stamped: stamp[k], current: current[k], what: VERSIONS[k].what }));
}

export function register(router) {
  router.get('/api/versions', () => ({
    engine: ENGINE_VERSION,
    registry: REGISTRY_ROWS(),
    current: versionSet(),
    stampedOn: STAMPED_ON,
    bumpPolicy: 'Bump a version when the BEHAVIOUR changes (a model, a window, a threshold, the floor arithmetic), never for a refactor or a comment. The version is stamped at creation time and never rewritten.',
    driftPolicy: 'A stored artefact keeps the versions it was created under. GET /api/versions/for/:kind/:id reports any difference against today\'s registry so an old recommendation can still be explained.',
    note: 'These identifiers exist so a decision can be reproduced. They are not claims of accuracy.',
  }), { summary: 'The version registry: feature, demand, risk, lifecycle, guardrail and economics versions' });

  router.get('/api/versions/explain', () => ({
    engine: ENGINE_VERSION,
    versions: explainVersions(versionSet()),
    reading: 'For each key: what it governs, what implements it today, and what a production build would replace it with. `changed` is false while the stamp matches the registry.',
  }), { summary: 'Plain-language explanation of every version in the set, with its replacement point' });

  router.get('/api/versions/drift', (ctx) => {
    try {
      session.requireAdmin(ctx);
      const d = load();
      const rows = [];
      for (const [kind, t] of Object.entries(KIND_TABLE)) {
        for (const entity of (d[t.collection] || [])) {
          const stamp = entity.versions || null;
          if (!stamp) {
            rows.push({ kind, id: t.id(entity), unversioned: true, why: 'created before the registry (or by an older build): no stamp to compare' });
            continue;
          }
          const drift = driftFor(stamp);
          if (drift.length) rows.push({ kind, id: t.id(entity), drift });
        }
      }
      return ok(ctx.res, {
        drifted: rows.length,
        rows,
        reading: 'Empty means: every stored artefact can be reproduced with the code in this repository. An `unversioned` row is a pre-registry record and is reported rather than hidden.',
      });
    } catch (e) { return fail(ctx.res, e.status || 500, e.message, e.detail || null); }
  }, { summary: 'Everything stored whose version stamp no longer matches the registry (admin)' });

  router.get('/api/versions/for/:kind/:id', (ctx) => {
    try {
      const kind = String(ctx.params.kind || '').toLowerCase();
      const table = KIND_TABLE[kind];
      if (!table) {
        return fail(ctx.res, 400, `unknown artefact kind: ${ctx.params.kind}`, {
          field: 'kind',
          allowed: Object.keys(KIND_TABLE),
        });
      }
      const id = ctx.params.id;
      const entity = (load()[table.collection] || []).find((x) => t_id(table, x) === id);
      if (!entity) return fail(ctx.res, 404, `unknown ${table.label}: ${id}`);
      if (entity.seller_id) session.scope(ctx, { sellerId: entity.seller_id, what: `${table.label} ${id}` });

      const stamp = entity.versions || null;
      return ok(ctx.res, {
        kind,
        id,
        seller_id: entity.seller_id || null,
        stamped: stamp,
        explain: stamp ? explainVersions(stamp) : [],
        drift: stamp ? driftFor(stamp) : [],
        current: versionSet(),
        reproducible: !!stamp && driftFor(stamp).length === 0,
        note: stamp
          ? 'The stamp is what the artefact was created under. If `drift` is empty, this build reproduces it.'
          : 'No stamp on this record: it predates the version registry, so only the code history can explain it. New records always carry one.',
      });
    } catch (e) { return fail(ctx.res, e.status || 500, e.message, e.detail || null); }
  }, { summary: 'The version set stamped on one recommendation, decision, action, experiment or outcome' });
}

function t_id(table, entity) {
  try { return table.id(entity); } catch { return null; }
}

export default { register };
