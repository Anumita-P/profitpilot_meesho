/**
 * DEMO SELLER SESSIONS + ACCESS SCOPING (phase 6, requirement 1 & 10).
 *
 * What this gives the build:
 *   - real session tokens (random 122-bit UUIDs, stored as SHA-256 hashes, never
 *     logged in full) issued by POST /api/session;
 *   - seller-scoped access: a seller's session can only touch that seller's
 *     listings, recommendations, actions, events and experiments. Anything else
 *     is a 403 with an audit entry - not a silent empty result;
 *   - admin protection: /api/admin/* requires an admin session or the
 *     PP_ADMIN_TOKEN, with an explicit, documented demo fallback when no token is
 *     configured (the local prototype and its scripts keep working);
 *   - request + correlation ids on every response, and a verdict on whether the
 *     caller's request was scoped, so nothing in the logs is ambiguous.
 *
 * The existing demo behaviour is preserved: with no session and no headers, a
 * request is served as the seeded demo seller exactly as before. Nothing is
 * required to keep the UI working; scoping is enforced the moment a caller
 * identifies itself.
 */

import crypto from 'node:crypto';
import { load, save, logEvent, httpError } from '../store/db.js';

const DEFAULT_TTL_HOURS = 12;
const MAX_SESSIONS = 200;

const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const timingSafe = (a, b) => {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
};

/* --------------------------------- sessions -------------------------------- */

export function defaultSellerId() {
  const d = load();
  const ids = Object.keys(d.sellers || {});
  return ids[0] || null;
}

export function createSession({ sellerId = null, role = 'seller', label = null, ttlHours = DEFAULT_TTL_HOURS, at = null } = {}) {
  const d = load();
  if (!['seller', 'admin'].includes(role)) throw httpError(400, 'role must be seller or admin');
  const seller = role === 'seller' ? (sellerId || defaultSellerId()) : (sellerId || null);
  if (role === 'seller' && (!seller || !d.sellers[seller])) {
    throw httpError(400, `unknown seller: ${sellerId}`, { known: Object.keys(d.sellers || {}) });
  }
  const token = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, '');
  const now = at ? new Date(at).toISOString() : new Date().toISOString();
  const session = {
    session_id: `SES-${String(Object.keys(d.sessions || {}).length + 1).padStart(4, '0')}`,
    token_hint: `…${token.slice(-6)}`,
    seller_id: seller,
    role,
    label: label || (role === 'admin' ? 'admin session' : `${d.sellers[seller]?.name || seller} (demo session)`),
    created_at: now,
    expires_at: new Date(new Date(now).getTime() + ttlHours * 3600000).toISOString(),
    requests: 0,
    last_seen_at: now,
    demo: true,
  };
  d.sessions[hashToken(token)] = session;
  // keep the store bounded: drop the oldest sessions past the cap
  const keys = Object.keys(d.sessions);
  if (keys.length > MAX_SESSIONS) {
    for (const k of keys.slice(0, keys.length - MAX_SESSIONS)) delete d.sessions[k];
  }
  save();
  logEvent('session.created', { sessionId: session.session_id, sellerId: seller, role, hint: session.token_hint });
  return { token, session: publicSession(session) };
}

export function revokeSession(token) {
  const d = load();
  const key = hashToken(token);
  const s = d.sessions[key];
  if (!s) return { revoked: false };
  delete d.sessions[key];
  save();
  logEvent('session.revoked', { sessionId: s.session_id, sellerId: s.seller_id, role: s.role });
  return { revoked: true, session_id: s.session_id };
}

export function publicSession(s = {}) {
  const { token_hint, ...rest } = s;
  return { ...rest, token_hint };
}

function bearer(req) {
  const h = req.headers.authorization || '';
  if (h.toLowerCase().startsWith('bearer ')) return h.slice(7).trim();
  return null;
}

/**
 * Who is calling? Resolution order, most explicit first:
 *   Authorization: Bearer <token>  ->  X-Session  ->  X-Seller-Id (legacy demo
 *   convenience, exactly what the UI bridge already sends)  ->  the seeded
 *   default seller.
 */
export function resolve(ctx) {
  const d = load();
  const token = bearer(ctx.req) || ctx.req.headers['x-session'] || null;
  let session = null;
  if (token) {
    session = d.sessions[hashToken(token)] || null;
    if (!session) throw httpError(401, 'unknown or expired session token', { hint: 'POST /api/session to create a demo session' });
    if (new Date(session.expires_at).getTime() < Date.now()) {
      delete d.sessions[hashToken(token)];
      save();
      throw httpError(401, 'session expired', { expired_at: session.expires_at });
    }
    session.requests = (session.requests || 0) + 1;
    session.last_seen_at = new Date().toISOString();
    save();
  }
  const headerSeller = ctx.req.headers['x-seller-id'] || ctx.query.seller || null;
  /* HOW a caller is an admin matters. /api/admin/* accepts the demo-mode fallback
     (no PP_ADMIN_TOKEN configured - a local prototype), but data scoping must not:
     otherwise every caller would be an admin for other sellers' listings. */
  const configuredAdmin = !!process.env.PP_ADMIN_TOKEN;
  const presentedAdminToken = configuredAdmin && !!ctx.req.headers['x-admin-token'] && adminAuthorised(ctx.req);
  const adminVia = (session?.role === 'admin') ? 'session' : presentedAdminToken ? 'token' : (adminAuthorised(ctx.req) ? 'demo-default' : null);
  const sellerId = session?.seller_id || headerSeller || defaultSellerId();
  const role = session?.role || 'seller';
  const identity = {
    session: session ? publicSession(session) : null,
    session_id: session?.session_id || null,
    token: token ? hashToken(token).slice(0, 12) : null,   // a fingerprint, never the token
    authenticated: !!session,
    legacy: !session && !!headerSeller,
    seller_id: sellerId,
    role,
    admin: role === 'admin' || adminAuthorised(ctx.req),
    source: session ? 'session' : (headerSeller ? 'header' : 'default'),
    demo_default: !session && !headerSeller,
    admin_token_configured: configuredAdmin,
    admin_via: adminVia,           // 'session' | 'token' | 'demo-default' | null
  };
  return identity;
}

/** Admin authorisation: admin session, or the configured static token. */
export function adminAuthorised(req = null) {
  const configured = process.env.PP_ADMIN_TOKEN;
  if (!configured) return true;        // demo mode: no token configured, documented + reported in /api/admin/system
  if (!req) return false;
  const presented = req.headers['x-admin-token'] || bearer(req) || '';
  return !!presented && timingSafe(presented, configured);
}

export function requireAdmin(ctx) {
  const id = ctx.identity || (ctx.identity = resolve(ctx));
  if (!id.admin) {
    deny(ctx, { what: 'admin', reason: 'admin routes need an admin session or X-Admin-Token', detail: { path: ctx.pathname } });
  }
  return id;
}

/* --------------------------------- scoping -------------------------------- */

/**
 * Assert the caller may touch this seller's / listing's data. Throws 403 (and
 * audits) rather than returning empty data: "you may not see this" and "there is
 * nothing here" are different answers.
 */
export function scope(ctx, { sellerId = null, listingId = null, what = 'resource', allowAdmin = true } = {}) {
  const id = ctx.identity || (ctx.identity = resolve(ctx));
  if (id.role === 'admin' && allowAdmin) return id;
  let owner = sellerId;
  if (!owner && listingId) {
    const l = load().listings[listingId];
    if (!l) throw httpError(404, `unknown listing: ${listingId}`);
    owner = l.sellerId;
  }
  if (!owner) return id;
  if (owner !== id.seller_id) {
    deny(ctx, {
      what,
      reason: `session ${id.session_id || '(anonymous demo)'} is scoped to ${id.seller_id} and cannot access ${owner}'s ${what}`,
      detail: { requested_seller: owner, session_seller: id.seller_id, listing_id: listingId },
      status: 403,
      event: 'cross_seller_access',
    });
  }
  return id;
}

/** Seller id to use for a query: the session's, or an explicit override that must be in scope. */
export function scopedSeller(ctx, requested = null) {
  const id = ctx.identity || (ctx.identity = resolve(ctx));
  if (requested && requested !== id.seller_id && id.role !== 'admin') {
    deny(ctx, {
      what: 'seller data',
      reason: `session is scoped to ${id.seller_id}; ${requested} is out of scope`,
      detail: { requested_seller: requested, session_seller: id.seller_id },
      status: 403,
      event: 'cross_seller_access',
    });
  }
  return requested && id.role === 'admin' ? requested : id.seller_id;
}

function deny(ctx, { what, reason, detail = {}, status = 403, event = 'access.denied' }) {
  const d = load();
  const entry = {
    at: new Date().toISOString(),
    kind: event,
    actor: ctx.identity?.session_id || 'anonymous',
    session_seller: ctx.identity?.seller_id || null,
    role: ctx.identity?.role || 'seller',
    method: ctx.method,
    path: ctx.pathname,
    what,
    reason,
    ...detail,
  };
  d.audit.push({ audit_id: `AU-${d.audit.length + 1}`, at: entry.at, actor: entry.actor, entity: 'access', from: null, to: event, note: reason, ...detail });
  save();
  logEvent(event, entry);
  throw httpError(status, reason, detail);
}

/* --------------------------- request identifiers --------------------------- */

/** Request id + correlation id, echoed on every response (requirement 10). */
export function identify(ctx) {
  const rid = ctx.req.headers['x-request-id'] || `req_${crypto.randomUUID().slice(0, 18)}`;
  const cid = ctx.req.headers['x-correlation-id'] || ctx.req.headers['x-request-id'] || `cor_${crypto.randomUUID().slice(0, 18)}`;
  ctx.request_id = rid;
  ctx.correlation_id = cid;
  return { request_id: rid, correlation_id: cid };
}

export function sessionHeaders(ctx, res) {
  const { request_id, correlation_id } = ctx.request_id ? ctx : identify(ctx);
  res.setHeader('X-Request-Id', request_id);
  res.setHeader('X-Correlation-Id', correlation_id);
  if (ctx.identity?.session_id) res.setHeader('X-Session-Id', ctx.identity.session_id);
  return { request_id, correlation_id };
}

export function listSessions() {
  const d = load();
  return Object.values(d.sessions || {})
    .map(publicSession)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

export function scopeReport(identity) {
  return {
    authenticated: identity.authenticated,
    session_id: identity.session_id,
    role: identity.role,
    seller_id: identity.seller_id,
    source: identity.source,
    demo_default: identity.demo_default,
    legacy_header: identity.legacy,
    admin_token_configured: identity.admin_token_configured,
    note: identity.demo_default
      ? 'no session and no X-Seller-Id: served as the seeded demo seller exactly as before (the UI relies on this)'
      : (identity.authenticated ? 'session-scoped: cross-seller access is refused with 403 and audited' : 'scoped by the X-Seller-Id header (legacy demo convenience, still honoured)'),
  };
}
