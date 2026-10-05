/**
 * ROUTE-LEVEL SELLER SCOPING (requirement 1).
 *
 * The closed-loop modules scope themselves (they call session.scope()). The
 * routes that existed before sessions did not - and rewriting 62 handlers to add
 * a check to each one is exactly the kind of sweep that leaves one route open.
 *
 * So the check is central: before a handler runs, the URL is resolved to the
 * seller who owns the resource it names, and a session that is scoped to a
 * different seller gets a 403 that is written to the audit trail. Routes that do
 * not name a seller-owned resource (engine maths, the deck's constants, health)
 * are untouched, and an id that does not exist is left to the handler so the
 * caller still gets the handler's own 404.
 *
 * The default demo caller (no session, no header) resolves to the seeded demo
 * seller, which is why the UI, the snapshot script and every existing test keep
 * working exactly as before.
 */

import { load, logEvent, httpError, save } from '../store/db.js';

/** Collectors: pathname -> the seller who owns what it names. */
function ownerOfListing(id) {
  const l = load().listings[id];
  return l ? l.sellerId : null;
}

function ownerOfDecision(id) {
  const d = (load().decisions || []).find((x) => x.id === id);
  if (!d) return null;
  if (d.sellerId) return d.sellerId;
  return d.listingId ? ownerOfListing(d.listingId) : null;
}

function ownerOfAction(id) {
  const a = (load().actions || []).find((x) => x.action_id === id);
  return a ? a.seller_id : null;
}

function ownerOfExperiment(id) {
  const e = (load().experiments || []).find((x) => x.experiment_id === id);
  return e ? e.seller_id : null;
}

function ownerOfRecommendation(id) {
  const r = (load().recommendations || []).find((x) => x.recommendation_id === id);
  return r ? r.seller_id : null;
}

/**
 * @returns {{sellerId: string|null, resource: string, id: string}|null}
 */
export function requiredSeller(pathname) {
  const parts = pathname.split('/').filter(Boolean);        // ['api','listings','L-kurti','publish']
  if (parts[0] !== 'api' || parts.length < 3) return null;

  // /api/listings/:id/...          /api/lifecycle/listings/:id/...
  if (parts[1] === 'listings') return { sellerId: ownerOfListing(parts[2]), resource: 'listing', id: parts[2] };
  if (parts[1] === 'lifecycle' && parts[2] === 'listings') return { sellerId: ownerOfListing(parts[3]), resource: 'listing', id: parts[3] };

  // /api/decisions/:id/...
  if (parts[1] === 'decisions') return { sellerId: ownerOfDecision(parts[2]), resource: 'decision', id: parts[2] };

  // /api/sellers/:id/...
  if (parts[1] === 'sellers') return { sellerId: parts[2], resource: 'seller', id: parts[2] };

  // /api/actions/A-0001[/step]   (named sub-routes like /pipeline are ignored)
  if (parts[1] === 'actions' && /^A-\d+$/i.test(parts[2])) return { sellerId: ownerOfAction(parts[2]), resource: 'action', id: parts[2] };

  // /api/experiments/EXP-0001[/...]  (skip /summary, /:id/claim etc. still resolve by id)
  if (parts[1] === 'experiments' && /^EXP-/i.test(parts[2])) return { sellerId: ownerOfExperiment(parts[2]), resource: 'experiment', id: parts[2] };

  // /api/lifecycle/recommendations/R-0001[/...]
  if (parts[1] === 'lifecycle' && parts[2] === 'recommendations') return { sellerId: ownerOfRecommendation(parts[3]), resource: 'recommendation', id: parts[3] };

  return null;
}

/**
 * Throws 403 when the caller's session does not own the resource.
 * Admins pass. Unknown ids pass (the handler decides 404).
 */
export function enforceScope(ctx) {
  const identity = ctx.identity;
  if (!identity) return;                      // nothing to enforce without an identity
  const req = requiredSeller(ctx.pathname);
  if (!req || !req.sellerId) return;

  /* Demo mode makes every caller 'admin' for /api/admin/* (no PP_ADMIN_TOKEN is
     configured). That fallback must NOT open other sellers' data, so only a real
     admin session or a presented admin token passes the scope check. */
  const isAdmin = identity.role === 'admin' || identity.admin_via === 'token';
  if (isAdmin) return;
  if (req.sellerId === identity.seller_id) return;

  const detail = {
    requested_seller: req.sellerId,
    session_seller: identity.seller_id,
    session_id: identity.session_id || null,
    resource: req.resource,
    id: req.id,
    why: `this ${req.resource} belongs to ${req.sellerId}; the caller is scoped to ${identity.seller_id}`,
  };
  recordDenial(ctx, 'cross_seller', detail);
  throw httpError(403, `forbidden: ${req.resource} ${req.id} belongs to another seller`, detail);
}

/** The audit entry for a refusal: who tried what, from where, and why it failed. */
export function recordDenial(ctx, kind, detail = {}) {
  const d = load();
  const entry = {
    audit_id: `AU-${(d.audit || []).length + 1}`,
    at: new Date().toISOString(),
    actor: ctx.identity?.session_id || 'anonymous',
    entity: 'access',
    kind,
    method: ctx.method,
    path: ctx.pathname,
    session_seller: ctx.identity?.seller_id || null,
    role: ctx.identity?.role || 'seller',
    ...detail,
  };
  d.audit.push(entry);
  if (d.audit.length > 5000) d.audit.splice(0, d.audit.length - 5000);
  save();
  logEvent('access.denied', { kind, path: ctx.pathname, ...detail });
  return entry;
}

/** Which registrations this check covers, for the docs and /api/admin/system. */
export const SCOPE_RULES = [
  '/api/listings/:id/**',
  '/api/lifecycle/listings/:id/**',
  '/api/decisions/:id/**',
  '/api/sellers/:id/**',
  '/api/actions/:actionId/**',
  '/api/experiments/:experimentId/**',
  '/api/lifecycle/recommendations/:recommendationId/**',
];
