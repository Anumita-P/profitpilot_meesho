/**
 * IDEMPOTENCY + REQUEST-ID TEST.
 *
 * The closed loop writes prices, queues actions, ingests events and records
 * outcomes. A retried POST in that world is not a cosmetic problem: it is a
 * second price change. This suite drives the real server over HTTP and checks the
 * promise end to end:
 *
 *   1. the same key + the same body is replayed, and NOTHING runs twice;
 *   2. the same key + a different body is a 409 that names the original;
 *   3. two identical requests in flight together cannot both execute;
 *   4. a refusal (4xx) is never cached, so a corrected retry still works;
 *   5. a GET is never replayed (no write, no stored body);
 *   6. executing an action twice is refused even WITHOUT an idempotency key -
 *      the queue itself is single-shot;
 *   7. request / correlation ids are echoed and appear on the response.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.mjs';

const order = (over = {}) => ({
  listing_id: 'L-kurti',
  event_type: 'ORDER_PLACED',
  timestamp: '2026-10-03T00:00:00Z',
  payload: { units: 1, orderValue: 369, paymentMode: 'prepaid' },
  ...over,
});

const countEvents = async (srv, type) => {
  const r = await srv.api(`/api/events/counts?type=${type}`);
  const counts = r.body.counts || r.body;
  return typeof counts === 'object' ? (counts[type] ?? 0) : 0;
};

test('writes are idempotent, refusals are not cached, and a price is never published twice', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());

  /* ---------------------- 1. same key + same body: replay ------------------- */
  const first = await srv.api('/api/events', { method: 'POST', headers: { 'idempotency-key': 'evt-1' }, body: order() });
  assert.equal(first.status, 200);
  const eventId = first.body.event.event_id;
  const afterFirst = await countEvents(srv, 'ORDER_PLACED');

  const retry = await srv.api('/api/events', { method: 'POST', headers: { 'idempotency-key': 'evt-1' }, body: order() });
  assert.equal(retry.status, 200, 'the retry succeeds');
  assert.equal(retry.headers.get('idempotent-replay'), 'true');
  assert.equal(retry.headers.get('idempotent-key'), 'evt-1');
  assert.equal(retry.headers.get('x-original-request-id'), first.headers.get('x-request-id'), 'and names the original request');
  assert.equal(retry.body.event.event_id, eventId, 'the same event, not a second one');
  assert.equal(await countEvents(srv, 'ORDER_PLACED'), afterFirst, 'the event count did not move');

  /* ------------------------- 2. same key, new body: 409 -------------------- */
  const conflict = await srv.api('/api/events', { method: 'POST', headers: { 'idempotency-key': 'evt-1' }, body: order({ payload: { units: 3, orderValue: 369, paymentMode: 'prepaid' } }) });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.detail.key, 'evt-1');
  assert.equal(conflict.body.error.detail.original.method, 'POST');
  assert.equal(await countEvents(srv, 'ORDER_PLACED'), afterFirst, 'the refused body was not ingested');

  /* ------------------ 3. two identical requests in flight ------------------ */
  /* Which mechanism fires depends on timing: if the second arrives while the
     first is still executing it is refused (409 "in flight"); if it arrives after
     the first has finished it is replayed. What must NEVER happen is two
     executions, so that is what is asserted. */
  const [a, b] = await Promise.all([
    srv.api('/api/events', { method: 'POST', headers: { 'idempotency-key': 'evt-race' }, body: order({ timestamp: '2026-10-04T00:00:00Z' }) }),
    srv.api('/api/events', { method: 'POST', headers: { 'idempotency-key': 'evt-race' }, body: order({ timestamp: '2026-10-04T00:00:00Z' }) }),
  ]);
  const fresh = [a, b].filter((r) => r.status === 200 && r.headers.get('idempotent-replay') !== 'true');
  const other = [a, b].find((r) => r !== fresh[0]);
  assert.equal(fresh.length, 1, 'exactly one of the pair executed');
  assert.ok([200, 409].includes(other.status), `the other was replayed or refused (got ${other.status})`);
  assert.equal(fresh[0].body.event.event_id, (await srv.api(`/api/events/${fresh[0].body.event.event_id}`)).body.event.event_id);
  assert.equal(await countEvents(srv, 'ORDER_PLACED'), afterFirst + 1, 'exactly one of the pair was ingested');

  /* ------------------- 4. a refusal is never cached ----------------------- */
  const bad = await srv.api('/api/events', { method: 'POST', headers: { 'idempotency-key': 'evt-fix' }, body: { listing_id: 'L-kurti', event_type: 'ORDER_PLACED', payload: {} } });
  assert.equal(bad.status, 400, 'the first attempt is refused');
  assert.equal(bad.headers.get('idempotent-replay'), null);
  const fixed = await srv.api('/api/events', { method: 'POST', headers: { 'idempotency-key': 'evt-fix' }, body: order({ timestamp: '2026-10-05T00:00:00Z' }) });
  assert.equal(fixed.status, 200, 'the corrected retry with the SAME key is evaluated on live data, not replayed as a refusal');

  /* --------------------------- 5. GETs are not replayed ------------------- */
  const g1 = await srv.api('/api/health', { headers: { 'idempotency-key': 'get-1' } });
  const g2 = await srv.api('/api/health', { headers: { 'idempotency-key': 'get-1' } });
  assert.equal(g1.status, 200);
  assert.equal(g2.status, 200);
  assert.equal(g2.headers.get('idempotent-replay'), null, 'a read is a read: nothing is stored for it');

  /* ---------------- 6. the queue itself is single-shot ------------------- */
  const rec = await srv.api('/api/lifecycle/listings/L-kurti/generate', { method: 'POST', body: {} });
  const recId = (rec.body.recommendation || rec.body).recommendation_id;
  assert.ok(recId, 'a recommendation was generated');

  const stepped = await srv.api('/api/actions/step', { method: 'POST', body: { recommendation_id: recId } });
  assert.equal(stepped.status, 200, 'the card enters the queue');
  const actionId = (stepped.body.action || stepped.body).action_id;
  assert.ok(actionId);

  for (const [step, body] of [['approve', { by: 'seller:S-ramesh' }], ['enqueue', {}]]) {
    const r = await srv.api(`/api/actions/${actionId}/${step}`, { method: 'POST', body });
    assert.equal(r.status, 200, `${step} is accepted`);
  }

  const execKey = { 'idempotency-key': 'exec-1' };
  const exec1 = await srv.api(`/api/actions/${actionId}/execute`, { method: 'POST', headers: execKey, body: {} });
  assert.equal(exec1.status, 200, 'the first execution applies');
  const price = exec1.body.execution?.price ?? (await srv.api('/api/listings/L-kurti')).body.listing.price;

  const exec2 = await srv.api(`/api/actions/${actionId}/execute`, { method: 'POST', headers: execKey, body: {} });
  assert.equal(exec2.status, 200, 'the retry is answered from the stored response');
  assert.equal(exec2.headers.get('idempotent-replay'), 'true');
  assert.deepEqual(exec2.body.execution, exec1.body.execution, 'byte-identical execution report');

  const exec3 = await srv.api(`/api/actions/${actionId}/execute`, { method: 'POST', body: {} });
  assert.equal(exec3.status, 409, 'and with no key the queue refuses a second execution outright');

  const listing = await srv.api('/api/listings/L-kurti');
  assert.equal(listing.body.listing.price, price, 'the price moved exactly once');
  const history = listing.body.listing.priceHistory || [];
  assert.equal(history.filter((h) => h.recommendationId === recId).length, 1, 'exactly one price-history entry for that recommendation');

  /* --------------------------- 7. request ids ---------------------------- */
  const traced = await srv.api('/api/health', { headers: { 'x-request-id': 'req-abc', 'x-correlation-id': 'cor-xyz' } });
  assert.equal(traced.headers.get('x-request-id'), 'req-abc');
  assert.equal(traced.headers.get('x-correlation-id'), 'cor-xyz');
  const generated = await srv.api('/api/health');
  assert.match(generated.headers.get('x-request-id'), /^req[_-][0-9a-z-]{8,}$/i, 'a request id is always present');
  assert.ok(generated.headers.get('x-correlation-id'), 'and so is a correlation id');

  /* ------------- the store shows the keys, and their state -------------- */
  const summary = await srv.api('/api/admin/system');
  assert.equal(summary.status, 200);
  const idem = summary.body.idempotency;
  assert.ok(idem, 'the system view reports idempotency state');
  assert.equal(idem.inflight, 0, 'no key is left claimed after the responses are written');
  assert.ok(idem.keys >= 3, `every key that stored a successful response is kept (got ${idem.keys})`);
  assert.equal(idem.notReplayable, 0, 'and none is left in the un-replayable state');
});
