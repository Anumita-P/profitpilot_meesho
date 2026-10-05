/**
 * SECURITY + API-SAFETY TEST.
 *
 * Runs against real HTTP (see test/helpers/server.mjs):
 *   - demo seller sessions, seller-scoped access, cross-seller 403 everywhere;
 *   - admin protection, including the enforced mode (PP_ADMIN_TOKEN set);
 *   - payload validation errors that name the field;
 *   - idempotency keys: replay the same response, refuse a reused key;
 *   - request / correlation ids on every response;
 *   - no stack traces in API bodies (the policy is asserted at the source too).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './helpers/server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('seller sessions scope every request, and admin routes are protected', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());

  /* ------------------------------- sessions ------------------------------ */
  const ramesh = await srv.api('/api/session', { method: 'POST', body: { seller_id: 'S-ramesh' } });
  assert.equal(ramesh.status, 200, 'a demo session can be created');
  assert.match(ramesh.body.token, /^[0-9a-f-]{20,}/i, 'a token is returned once');
  assert.equal(ramesh.body.session.role, 'seller');

  const meera = await srv.api('/api/session', { method: 'POST', body: { seller_id: 'S-meera' } });
  assert.equal(meera.status, 200);
  const rt = ramesh.body.token;
  const mt = meera.body.token;
  assert.notEqual(rt, mt, 'tokens are unique');

  const who = await srv.api('/api/session', { token: rt });
  assert.equal(who.body.scope.seller_id, 'S-ramesh');
  assert.equal(who.body.scope.authenticated, true);
  assert.equal(who.status, 200);
  assert.ok(who.headers.get('x-request-id'), 'X-Request-Id is echoed');
  assert.ok(who.headers.get('x-correlation-id'), 'X-Correlation-Id is echoed');

  const bad = await srv.api('/api/session', { token: 'not-a-real-token' });
  assert.equal(bad.status, 401, 'an unknown token is 401, not a silent downgrade');

  /* --------------------------- cross-seller 403 --------------------------- */
  const ownedByRamesh = ['/api/listings/L-kurti', '/api/lifecycle/listings/L-kurti/state', '/api/actions/trust/S-ramesh'];
  for (const p of ownedByRamesh) {
    const res = await srv.api(p, { token: mt });
    assert.equal(res.status, 403, `${p} must refuse the other seller's session`);
    assert.equal(res.body.error.status, 403);
    assert.ok(!/at .*\.js:\d+/.test(res.body.error.message), 'the refusal carries no stack');
  }

  const ownRead = await srv.api('/api/listings/L-kurti', { token: rt });
  assert.equal(ownRead.status, 200, 'the owner can read their own listing');

  const crossIngest = await srv.api('/api/events', {
    method: 'POST', token: mt,
    body: { listing_id: 'L-kurti', event_type: 'VIEW_RECORDED', timestamp: '2026-10-01T00:00:00Z', payload: { views: 50, clicks: 2 } },
  });
  assert.equal(crossIngest.status, 403, 'another seller cannot write events into this listing');

  const crossListingWrite = await srv.api('/api/listings/L-kurti/costs', { method: 'POST', token: mt, body: { cs: 300 } });
  assert.equal(crossListingWrite.status, 403, 'another seller cannot rewrite cost inputs');

  /* ---------------------------- no-session mode -------------------------- */
  const anon = await srv.api('/api/listings/L-kurti');
  assert.equal(anon.status, 200, 'the seeded demo caller still works with no session (the UI relies on it)');
  const anonClaim = await srv.api('/api/events', {
    method: 'POST',
    body: { listing_id: 'L-kurti', event_type: 'VIEW_RECORDED', timestamp: '2026-10-02T00:00:00Z', payload: { views: 50, clicks: 2 } },
  });
  assert.equal(anonClaim.status, 200, 'and can still use the prototype the way it always did');

  /* ---------------------------- validation ------------------------------ */
  const noType = await srv.api('/api/events', { method: 'POST', body: { listing_id: 'L-kurti' } });
  assert.equal(noType.status, 400);
  assert.ok(noType.body.error.detail && noType.body.error.detail.field, 'the 400 names the missing field');

  const badType = await srv.api('/api/events', { method: 'POST', body: { listing_id: 'L-kurti', event_type: 'NOT_A_THING', payload: {} } });
  assert.equal(badType.status, 400);

  const badExperiment = await srv.api('/api/experiments', { method: 'POST', body: { description: 'no name' } });
  assert.equal(badExperiment.status, 400, 'required fields are enforced');

  /* ---------------------------- idempotency ----------------------------- */
  const event = {
    listing_id: 'L-kurti', event_type: 'ORDER_PLACED', timestamp: '2026-10-03T00:00:00Z',
    payload: { units: 1, orderValue: 369, paymentMode: 'prepaid' },
  };
  const first = await srv.api('/api/events', { method: 'POST', headers: { 'idempotency-key': 'k-order-1' }, body: event });
  assert.equal(first.status, 200);
  const firstId = first.body.event.event_id;

  const again = await srv.api('/api/events', { method: 'POST', headers: { 'idempotency-key': 'k-order-1' }, body: event });
  assert.equal(again.status, 200, 'the retry is answered from the stored response');
  assert.equal(again.body.event.event_id, firstId, 'and it is the same event, not a second one');
  assert.equal(again.headers.get('idempotent-replay'), 'true', 'and it says so');

  const conflict = await srv.api('/api/events', {
    method: 'POST', headers: { 'idempotency-key': 'k-order-1' },
    body: { ...event, payload: { units: 9, orderValue: 369, paymentMode: 'prepaid' } },
  });
  assert.equal(conflict.status, 409, 'the same key with a different body is refused');

  /* --------------------------- request ids ------------------------------ */
  const traced = await srv.api('/api/health', { headers: { 'x-request-id': 'req-from-test', 'x-correlation-id': 'cor-from-test' } });
  assert.equal(traced.headers.get('x-request-id'), 'req-from-test', 'an inbound request id is honoured');
  assert.equal(traced.headers.get('x-correlation-id'), 'cor-from-test');

  /* ------------------------ admin, demo mode ---------------------------- */
  const sys = await srv.api('/api/admin/system');
  assert.equal(sys.status, 200, 'with no PP_ADMIN_TOKEN the local prototype is trusted (documented demo mode)');
  assert.match(sys.body.protection.admin_protection, /DEMO MODE/);
  assert.equal(sys.body.protection.cross_seller.includes('403'), true, 'and the system view states the cross-seller rule');

  /* ---------------------------- error log path -------------------------- */
  const errors = await srv.api('/api/admin/errors');
  assert.equal(errors.status, 200);
  assert.match(errors.body.policy, /never carry stack traces/);

  /* the source must not leak a stack into a response outside the debug flag */
  const serverSource = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const stackUses = serverSource.match(/err\.stack/g) || [];
  assert.ok(stackUses.length <= 2, 'err.stack is referenced only in the error log + the opt-in debug branch');
  assert.ok(/PP_DEBUG_STACKS/.test(serverSource), 'and stack traces in responses are opt-in via PP_DEBUG_STACKS');
});

test('with PP_ADMIN_TOKEN set, admin routes are enforced', async (t) => {
  const srv = await startServer({ PP_ADMIN_TOKEN: 'test-admin-token' });
  t.after(() => srv.stop());

  const denied = await srv.api('/api/admin/system');
  assert.equal(denied.status, 403, 'no token -> refused');

  const wrong = await srv.api('/api/admin/system', { adminToken: 'nope' });
  assert.equal(wrong.status, 403, 'a wrong token is refused');

  const allowed = await srv.api('/api/admin/system', { adminToken: 'test-admin-token' });
  assert.equal(allowed.status, 200, 'the configured token is accepted');
  assert.match(allowed.body.protection.admin_protection, /enforced/);

  const resetDenied = await srv.api('/api/admin/reset', { method: 'POST' });
  assert.equal(resetDenied.status, 403, 'destructive admin routes are protected too');

  const resetAllowed = await srv.api('/api/admin/reset', { method: 'POST', adminToken: 'test-admin-token' });
  assert.equal(resetAllowed.status, 200);

  /* an admin session (role: admin) is another way in */
  const admin = await srv.api('/api/session', { method: 'POST', body: { role: 'admin' } });
  assert.equal(admin.status, 200);
  const viaSession = await srv.api('/api/admin/system', { token: admin.body.token });
  assert.equal(viaSession.status, 200, 'an admin session passes the same gate');

  /* admin sessions may look across sellers, seller sessions may not */
  const crossAdmin = await srv.api('/api/listings/L-kurti', { token: admin.body.token });
  assert.equal(crossAdmin.status, 200, 'an admin may inspect any seller\'s listing');
});
