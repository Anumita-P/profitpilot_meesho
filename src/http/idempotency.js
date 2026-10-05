/**
 * IDEMPOTENT WRITES (phase 6, requirement 10).
 *
 * A retried POST must not publish a price twice, queue two actions, ingest a
 * batch twice or record two outcomes. Standard behaviour, done properly:
 *
 *   - the caller sends `Idempotency-Key: <anything unique>` on a write;
 *   - the first request runs and its response is stored under that key;
 *   - a retry with the SAME key and the SAME request fingerprint gets the stored
 *     response back, byte-identical, with `Idempotent-Replay: true` and the
 *     original request id, and nothing is executed twice;
 *   - a retry with the same key but a DIFFERENT body is a 409: silently running
 *     the new body would be exactly the bug this is here to prevent;
 *   - a key is bound to method + path, so the same key on a different endpoint is
 *     a conflict too;
 *   - responses for non-2xx are NOT stored (a refusal must be re-evaluated
 *     against live data - the guardrails may have changed);
 *   - keys are bounded (last 500) and bounded in time (24 h), so the store
 *     cannot grow forever;
 *   - a key is CLAIMED before the handler runs (`inflight`). Two identical
 *     requests arriving together therefore cannot both execute: the second gets a
 *     409 "still in flight" instead of a second price change.
 *
 * No request id and no idempotency key still works exactly as before: this is
 * opt-in by header, which is why the existing UI is unaffected.
 */

import crypto from 'node:crypto';
import { load, save, logEvent } from '../store/db.js';

const MAX_KEYS = 500;
const TTL_MS = 24 * 3600000;
export const HEADER = 'idempotency-key';

const fingerprint = (method, path, body) => crypto.createHash('sha256')
  .update(`${method} ${path} ${JSON.stringify(body ?? {})}`)
  .digest('hex').slice(0, 32);

const WRITE_METHODS = ['POST', 'PATCH', 'PUT', 'DELETE'];

export function keyFor(ctx) {
  /* Idempotency keys exist for WRITES. A GET is already safe and repeatable, so a
     key on a read is ignored rather than turning the route into a cache. */
  const method = ctx.req?.method || ctx.method;
  if (!WRITE_METHODS.includes(method)) return null;
  const raw = ctx.req.headers[HEADER] || ctx.req.headers['x-idempotency-key'];
  return raw ? String(raw).trim().slice(0, 200) : null;
}

/** Look for a stored response. Returns null when this is a first-time write. */
export function lookup(ctx) {
  const key = keyFor(ctx);
  if (!key) return null;
  const d = load();
  d.idempotency ||= {};
  prune(d);
  const fp = fingerprint(ctx.method, ctx.pathname, ctx.body);
  const entry = d.idempotency[key];

  if (!entry) {
    /* Claim the key BEFORE the handler runs, so an identical request that
       arrives while this one is executing is refused rather than replayed. */
    d.idempotency[key] = {
      key,
      method: ctx.method,
      path: ctx.pathname,
      fingerprint: fp,
      inflight: true,
      at: new Date().toISOString(),
      request_id: ctx.request_id || null,
      correlation_id: ctx.correlation_id || null,
    };
    save();
    return null;
  }

  if (entry.method !== ctx.method || entry.path !== ctx.pathname || entry.fingerprint !== fp) {
    const err = new Error(`idempotency key "${key}" was already used for ${entry.method} ${entry.path} with a different request body`);
    err.status = 409;
    err.detail = {
      key,
      original: { method: entry.method, path: entry.path, at: entry.at, request_id: entry.request_id },
      rule: 'a key is bound to one method + path + body: send a new key for a different request',
    };
    logEvent('idempotency.conflict', { key, path: ctx.pathname, original: entry.path });
    save();
    throw err;
  }

  if (entry.inflight) {
    const err = new Error(`a request with idempotency key "${key}" is still in flight`);
    err.status = 409;
    err.detail = { key, original: { method: entry.method, path: entry.path, at: entry.at }, rule: 'wait for the first response, then retry: the stored answer will be replayed.' };
    logEvent('idempotency.inflight', { key, path: ctx.pathname });
    save();
    throw err;
  }

  if (entry.replayable === false) {
    const err = new Error(`idempotency key "${key}" was used for a response that cannot be replayed`);
    err.status = 409;
    err.detail = { key, status: entry.status, rule: 'the original answer was not a stored JSON body (it was streamed or empty): send a new key.' };
    throw err;
  }

  logEvent('idempotency.replay', { key, path: ctx.pathname, original_request_id: entry.request_id });
  save();
  const headers = { 'Idempotent-Replay': 'true', 'Idempotent-Key': key };
  if (entry.request_id) headers['X-Original-Request-Id'] = entry.request_id;   // never send an undefined header
  return {
    replay: true,
    key,
    status: entry.status,
    body: entry.body,
    request_id: entry.request_id || null,
    storedAt: entry.at,
    headers,
  };
}

/** Store the response of a successful write so a retry can be answered from it. */
export function store(ctx, { status, body, request_id = null }) {
  const key = keyFor(ctx);
  if (!key) return null;
  if (!(status >= 200 && status < 300)) return null;    // refusals are never cached
  const d = load();
  d.idempotency ||= {};
  d.idempotency[key] = {
    key,
    method: ctx.method,
    path: ctx.pathname,
    fingerprint: fingerprint(ctx.method, ctx.pathname, ctx.body),
    status,
    body,
    inflight: false,
    replayable: true,
    at: new Date().toISOString(),
    request_id: request_id || ctx.request_id || null,      // the id the client saw on the first response
    correlation_id: ctx.correlation_id || null,
  };
  prune(d);
  save();
  return d.idempotency[key];
}

/**
 * The handler failed: drop the claim so the caller can retry the same key.
 * (A 4xx/5xx is never cached - a refusal has to be re-evaluated against live
 * guardrails, and a crash has nothing worth replaying.)
 */
export function release(ctx) {
  const key = keyFor(ctx);
  if (!key) return false;
  const d = load();
  const entry = d.idempotency?.[key];
  if (!entry) return false;
  if (entry.replayable === true) return false;      // a real stored answer is kept: it is the point of the key
  delete d.idempotency[key];                        // an in-flight claim, or a refusal that was never cached
  save();
  return true;
}

/**
 * The handler finished. If it wrote a body, `store()` already closed the claim;
 * if it did not (an empty or streamed response), mark the claim settled without a
 * body so a retry gets an honest 409 instead of "still in flight" forever.
 */
export function settle(ctx, status) {
  const key = keyFor(ctx);
  if (!key) return null;
  const d = load();
  const entry = d.idempotency?.[key];
  if (!entry || !entry.inflight) return null;

  /* Some handlers answer a refusal themselves (fail(res, 400, ...)) instead of
     throwing, so this is also where that case is cleaned up: a refusal is never
     cached, and it must not lock the key either. */
  if (status >= 400) {
    delete d.idempotency[key];
    save();
    return null;
  }

  entry.inflight = false;
  entry.replayable = false;     // 2xx with nothing stored: honest "cannot replay" rather than "in flight" forever
  entry.status = status;
  entry.at = new Date().toISOString();
  save();
  return entry;
}

function prune(d) {
  const keys = Object.keys(d.idempotency || {});
  const now = Date.now();
  for (const k of keys) {
    if (now - new Date(d.idempotency[k].at).getTime() > TTL_MS) delete d.idempotency[k];
  }
  const left = Object.keys(d.idempotency);
  if (left.length > MAX_KEYS) {
    left.sort((a, b) => new Date(d.idempotency[a].at) - new Date(d.idempotency[b].at));
    for (const k of left.slice(0, left.length - MAX_KEYS)) delete d.idempotency[k];
  }
}

export function stats() {
  const d = load();
  const entries = Object.values(d.idempotency || {});
  return {
    keys: entries.length,
    inflight: entries.filter((e) => e.inflight).length,
    notReplayable: entries.filter((e) => e.replayable === false).length,
    maxKeys: MAX_KEYS,
    ttlHours: TTL_MS / 3600000,
    newest: entries.sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, 5)
      .map((e) => ({ key: e.key, method: e.method, path: e.path, at: e.at, request_id: e.request_id })),
    rule: 'stored responses are replayed for a matching key + method + path + body; a mismatch is a 409; refusals (4xx/5xx) are never cached',
  };
}

export { fingerprint };
