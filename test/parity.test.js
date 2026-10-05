/**
 * PARITY TEST - the backend against the prototype the deck was built on.
 *
 * `reference/index.v1.1.original.html` contains the whole 1.0 engine that runs
 * in the browser. This test extracts that engine (no DOM needed: the maths part
 * of the script is pure), evaluates it in isolation, and compares it with the
 * backend number by number - floors, sensitivity levers, demand, mode prices,
 * pre-flight checks and the weekly recommendation, for all five SKUs in all
 * four goal modes.
 *
 * If this test is green, the backend is the prototype's engine, not a look-alike.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.PP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-parity-'));

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FRONTEND = path.join(ROOT, 'reference', 'index.v1.1.original.html');

/** Pull the maths half of the prototype script and run it in isolation. */
function loadReference() {
  const html = fs.readFileSync(FRONTEND, 'utf8');
  const start = html.indexOf("'use strict';");
  const end = html.indexOf('/* ---- Why sheet');
  assert.ok(start > 0, 'prototype script start not found');
  assert.ok(end > start, 'prototype maths section end not found');
  const slice = html.slice(start, end);
  // eslint-disable-next-line no-new-func
  const factory = new Function(`${slice}
    return { S, SK, SKIDS, CAT, MODES, STG, FL, demand, profitDay, modePrice, preflight, recFor, live, dsm, mpm, confOf, HYG, BETA, N0, GAMMA, CTR0, CVR0 };`);
  return factory();
}

const ref = loadReference();

const { computeFloor, sensitivity } = await import('../src/engine/floor.js');
const { ordersPerDay, profitPerDay } = await import('../src/engine/demand.js');
const { modePrice } = await import('../src/engine/modes.js');
const { recommend } = await import('../src/engine/recommend.js');
const { preflight } = await import('../src/engine/guardrails.js');
const { hydrate, listing, listingBySku } = await import('../src/store/db.js');

const SKU_IDS = ref.SKIDS;
const MODES = ['cash', 'growth', 'margin', 'clear'];
const byKey = (k) => hydrate(listingBySku('S-ramesh', k));

const numeric = (v) => (typeof v === 'number' ? Math.round(v * 1e6) / 1e6 : v);

test('the reference engine is the one the deck shipped', () => {
  assert.deepEqual(SKU_IDS, ['kurti', 'lunch', 'serum', 'romper', 'vase']);
  assert.equal(ref.BETA, -3);
  assert.equal(ref.GAMMA, 120);
  assert.equal(ref.N0, 2000);
  assert.equal(ref.CTR0, 0.04);
  assert.equal(ref.CVR0, 0.12);
});

test('every floor field matches the prototype, for all five SKUs', () => {
  // prototype field -> backend field (the backend spells a few of them out)
  const pairs = [['F', 'F'], ['k', 'k'], ['kept', 'kept'], ['deliv', 'delivered'], ['retN', 'retN'], ['rtoN', 'rtoN'],
    ['Cret', 'Cret'], ['Crto', 'Crto'], ['oth', 'other'], ['Pe', 'Pe'], ['Pn', 'Pn'], ['gap', 'gap'], ['Fno', 'Fno'],
    ['Fplus', 'Fplus'], ['Pm', 'Pm'], ['Pg', 'Pg'], ['frec', 'frec'], ['B', 'B'], ['cs', 'cs'], ['pack', 'pack'],
    ['fwd', 'fwd'], ['ret', 'ret'], ['rto', 'rto'], ['T', 'T']];
  for (const id of SKU_IDS) {
    const mine = computeFloor(id);
    const theirs = ref.FL(id);
    for (const [tf, mf] of pairs) {
      assert.equal(numeric(mine[mf]), numeric(theirs[tf]), `${id}.${tf}: backend ${mine[mf]} vs prototype ${theirs[tf]}`);
    }
    assert.deepEqual(mine.arms, theirs.arms, `${id}.arms`);
    assert.deepEqual(Object.values(mine.otherLines), Object.values(theirs.O), `${id}: other cost lines`);
  }
});

test('the deck\'s headline floors survive: 309 / 346 / 166 / 266 / 367', () => {
  assert.deepEqual(SKU_IDS.map((k) => computeFloor(k).F), [309, 346, 166, 266, 367]);
});

test('the seller\'s own cost inputs move the floor exactly as the prototype does', () => {
  // the keys the First-price screen (and the prototype's FL) actually reads
  const cases = [
    ['sourcing', { cs: 220 }], ['returns', { ret: 20 }], ['freight', { fwd: 45 }],
    ['rto', { rto: 15 }], ['packaging', { pack: 15 }], ['target profit', { T: 90 }],
  ];
  for (const [label, ov] of cases) {
    ref.S.ov.kurti = { ...ov };
    const theirs = ref.FL('kurti');
    const mine = computeFloor('kurti', ov);
    assert.equal(mine.F, theirs.F, `${label}: floor ${mine.F} vs ${theirs.F}`);
    assert.equal(mine.Pe, theirs.Pe, `${label}: start price`);
    assert.equal(mine.Cret, theirs.Cret, `${label}: C_ret`);
  }
  ref.S.ov.kurti = {};
  ref.S.ov = {};
});

test('the six sensitivity levers report the same deltas', () => {
  const s = sensitivity('kurti');
  const byKey = Object.fromEntries(s.levers.map((l) => [l.key, l]));
  // deck slide 3 box 2: sourcing +₹30, returns +₹25, weight +₹20, RTO +₹18, COD +₹15, ads +₹12
  assert.equal(byKey.sourcing.dF, 40, 'sourcing ₹180 -> ₹220');
  assert.equal(byKey.returns.dF, 27, 'returns 12% -> 20% (+8 pp)');
  assert.equal(byKey.weight.dF, 20, 'weight 0.5 -> 1 kg');
  assert.equal(byKey.rto.dF, 17, 'RTO 8% -> 15% (+7 pp)');
  assert.equal(byKey.cod.dF, 15, 'COD 50% -> 80%');
  assert.equal(byKey.ads.dF, 13, 'ads ₹12 -> ₹25');
  assert.equal(byKey.sourcing.matchesDeck, false, 'the deck prints +₹30 for sourcing: see docs/DECK_FIDELITY.md');
  assert.equal(byKey.sourcing.dF_deck, 30);
  assert.equal(byKey.weight.matchesDeck, true);
});

test('demand and profit per day are identical across the price range', () => {
  for (const id of SKU_IDS) {
    const l = byKey(id);
    for (const p of [149, 199, 249, 299, 349, 399, 449, 499, 599]) {
      const mineQ = ordersPerDay(l, p);
      const theirsQ = ref.demand(id, p);
      assert.ok(Math.abs(mineQ - theirsQ) < 1e-9, `${id}@${p}: orders/day ${mineQ} vs ${theirsQ}`);
      const mineD = profitPerDay(l, p);
      const theirsD = ref.profitDay(id, p);
      assert.ok(Math.abs(mineD - theirsD) < 1e-9, `${id}@${p}: profit/day ${mineD} vs ${theirsD}`);
    }
  }
});

test('the demand kink (look-alike penalty above the median) matches', () => {
  const l = byKey('serum');
  const above = ordersPerDay(l, 320);
  const theirs = ref.demand('serum', 320);
  assert.ok(Math.abs(above - theirs) < 1e-9, `${above} vs ${theirs}`);
  assert.ok(above < ordersPerDay(l, 300), 'orders fall faster above the median');
});

test('mode prices match for every SKU and every goal mode', () => {
  for (const id of SKU_IDS) {
    for (const m of MODES) {
      const mine = modePrice(id, m);
      const theirs = ref.modePrice(id, m);
      assert.equal(mine.lead, theirs.lead, `${id}/${m}: lead price`);
      assert.equal(mine.alt, theirs.alt, `${id}/${m}: alternate`);
    }
  }
});

test('pre-flight checks match one for one (keys, ok, na, detail)', () => {
  const cases = [
    ['kurti', 369, 384, {}], ['kurti', 369, 349, {}], ['kurti', 369, 415, {}],
    ['serum', 249, 249, {}], ['vase', 499, 429, {}], ['romper', 349, 399, {}],
  ];
  for (const [id, from, to, o] of cases) {
    const mine = preflight({ listing: listingBySku('S-ramesh', id), floor: computeFloor(id), from, to, views: ref.SK[id].sig.views, daysSinceMove: ref.SK[id].sig.dsm, movesThisMonth: ref.SK[id].sig.mpm, consent: false, ...o });
    const theirs = ref.preflight(id, from, to, o);
    assert.equal(mine.checks.length, theirs.length, `${id} ${from}->${to}: check count`);
    mine.checks.forEach((c, i) => {
      assert.equal(c.key, theirs[i].k, `${id} ${from}->${to} #${i}: key`);
      assert.equal(!!c.ok, !!theirs[i].ok, `${id} ${from}->${to} #${i} (${c.key}): ok`);
      assert.equal(!!c.na, !!theirs[i].na, `${id} ${from}->${to} #${i} (${c.key}): na flag`);
      assert.equal(c.detail, theirs[i].d, `${id} ${from}->${to} #${i} (${c.key}): detail text`);
    });
  }
});

test('the weekly recommendation matches for all five SKUs in all four modes', () => {
  for (const m of MODES) {
    ref.S.mode = m;
    for (const id of SKU_IDS) {
      const theirs = ref.recFor(id);
      const mine = recommend(byKey(id), { mode: m });
      assert.equal(mine.kind, theirs.kind, `${id}/${m}: kind (${mine.kind} vs ${theirs.kind})`);
      assert.equal(mine.from, theirs.from, `${id}/${m}: from`);
      assert.equal(mine.to, theirs.to, `${id}/${m}: to (${mine.to} vs ${theirs.to})`);
    }
  }
  ref.S.mode = 'growth';
});

test('the deck\'s own worked card is reproduced: kurti ₹369 -> ₹384', () => {
  const rec = recommend(byKey('kurti'), { mode: 'growth' });
  assert.equal(rec.kind, 'up');
  assert.equal(rec.from, 369);
  assert.equal(rec.to, 384);
  assert.equal(rec.to - rec.floor.F, 75, '+₹15 per kept order');
  assert.match(rec.headline, /384/);
});

test('the freshness guardrail matches: a move today is a cooldown hold', () => {
  ref.S.dsm = { kurti: 1 };
  const theirs = ref.recFor('kurti');
  const mine = recommend({ ...byKey('kurti'), daysSinceMove: 1 }, { mode: 'growth' });
  assert.equal(theirs.kind, 'hold');
  assert.equal(mine.kind, 'hold');
  assert.match(mine.headline, /cooldown/i);
  ref.S.dsm = {};
});

test('the prototype and the backend agree on what the seller sees first', () => {
  const l = byKey('kurti');
  const mine = recommend(l, { mode: 'growth' });
  assert.equal(mine.preflight.checks.length, 6, 'the six trigger-hygiene checks');
  assert.equal(mine.confidence, ref.confOf(ref.SK.kurti.sig.views), 'the confidence badge rule');
  assert.ok(mine.what && mine.effect && mine.undo && mine.confidenceWhy, 'the five Why blocks');
});
