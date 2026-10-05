/**
 * Catalogue + price-science endpoints.
 * Everything a client needs to explain a price without doing any arithmetic
 * itself: SKUs, floors, sensitivity, the cold-start plan, risk models,
 * programmes and the 2.0 module catalogue.
 */

import { CATEGORIES, ENGINE, GUARDRAILS, LAUNCH_MATRIX, LIMITS, MODES, PILOT, PROVENANCE, SERVICE, SKUS, STAGES } from '../config/deck.js';
import { computeFloor, floorWhy, sensitivity, priceAtMargin } from '../engine/floor.js';
import { betaPrior, penalty, simulate as simulateEngine, ordersPerDay } from '../engine/demand.js';
import { modeCatalogue } from '../engine/modes.js';
import { launchPlan, deckExamples } from '../engine/launch.js';
import { moduleCatalogue, pooledProcurement, reorderPoint, packagingAudit } from '../engine/programmes.js';
import { PINCODE_CLUSTERS, bufferMatrix, codRisk, keepProbability, returnRisk } from '../engine/risk.js';
import { cityRanking } from '../engine/pilot.js';
import { hydratedListings } from '../store/db.js';
import { ok, fail } from '../http/respond.js';

export function register(router) {
  /* ---------------------------------- meta ---------------------------------- */
  router.get('/api/health', () => ({
    status: 'ok',
    service: SERVICE.name,
    version: SERVICE.version,
    engine: SERVICE.engine,
    deck: SERVICE.deck,
    uptimeSec: Math.round(process.uptime()),
    disclaimer: SERVICE.banner,
  }), { summary: 'Liveness + what this service is' });

  router.get('/api/meta', () => ({
    service: SERVICE,
    engine: ENGINE,
    guardrails: GUARDRAILS,
    categories: CATEGORIES,
    modes: modeCatalogue(),
    stages: STAGES,
    limits: LIMITS,
    pilotConstants: { sampleSize: PILOT.impact.sampleSize, design: PILOT.design, cities: PILOT.cities },
    provenance: PROVENANCE,
    economy: {
      returnAdjustedFloor: 'F = all costs / kept orders (M4, M6)',
      dualPriceGap: 'gap ~= C_ret, so profit per kept order is the same either way',
      rewardPerImpression: 'r_a = CTR x CVR x k x (p_a - F)',
    },
  }), { summary: 'Engine constants, guardrails, modes, stages, limits and the slide-provenance map' });

  router.get('/api/routes', (_ctx, router) => ({ routes: router.list(), provenance: PROVENANCE }),
    { summary: 'Self-documenting endpoint index' });

  /* ---------------------------------- SKUs ---------------------------------- */
  router.get('/api/skus', () => ({
    skus: Object.values(SKUS).map((s) => {
      const f = computeFloor(s.key);
      return {
        key: s.key, name: s.name, short: s.short, emoji: s.emoji, category: s.category,
        categoryName: CATEGORIES[s.category].name,
        offlinePrice: s.price, livePrice: s.live, band: s.band, median: s.median,
        lookalikes: s.lookalikes, closestRival: s.closestRival, lifeDays: s.lifeDays,
        life: CATEGORIES[s.category].life,
        costs: s.costs, features: s.features,
        floor: { F: f.F, B: f.B, k: f.k, Pe: f.Pe, Pn: f.Pn, gap: f.gap, Fno: f.Fno, Fplus: f.Fplus, recoveryFloor: f.frec, arms: f.arms },
        marginAtLive: Math.round((s.live - f.F) * 100) / 100,
        beta: betaPrior(s.category),
      };
    }),
  }), { summary: 'The SKU library with floors (deck slide 2 box 1)' });

  router.get('/api/floors', (ctx) => {
    const floors = {};
    for (const key of Object.keys(SKUS)) floors[key] = computeFloor(key, overridesFrom(ctx.query));
    return ok(ctx.res, { floors, guardrails: GUARDRAILS });
  }, { summary: 'Every SKU floor in one call (full breakdown, arms, dual price, recovery floor)' });

  router.get('/api/skus/:key', (ctx) => {
    const sku = SKUS[ctx.params.key];
    if (!sku) return fail(ctx.res, 404, `unknown SKU: ${ctx.params.key}`);
    const f = computeFloor(sku.key, overridesFrom(ctx.query));
    return ok(ctx.res, {
      sku,
      category: CATEGORIES[sku.category],
      floor: f,
      floorWhy: floorWhy(sku.key, overridesFrom(ctx.query)),
      band: { p25: sku.band[0], p75: sku.band[1], median: sku.median, lookalikes: sku.lookalikes },
      economics: {
        priceAt15pctTargetMargin: Math.ceil(priceAtMargin(f.F, ENGINE.TARGET_MARGIN_DEFAULT)),
        priceAtMargin20: Math.ceil(priceAtMargin(f.F, 0.20)),
        floorTimes0_97: f.Fplus,
        floorDivide0_78: Math.round(f.F / 0.78),
      },
    });
  }, { summary: 'One SKU: costs, floor breakdown, band, target-margin prices' });

  router.get('/api/skus/:key/floor', (ctx) => {
    if (!SKUS[ctx.params.key]) return fail(ctx.res, 404, `unknown SKU: ${ctx.params.key}`);
    const overrides = overridesFrom(ctx.query);
    return ok(ctx.res, { floor: computeFloor(ctx.params.key, overrides), why: floorWhy(ctx.params.key, overrides) });
  }, { summary: 'Return-adjusted floor F for a SKU, with seller cost overrides' });

  router.post('/api/skus/:key/floor', (ctx) => {
    if (!SKUS[ctx.params.key]) return fail(ctx.res, 404, `unknown SKU: ${ctx.params.key}`);
    const overrides = sanitiseOverrides(ctx.body);
    return ok(ctx.res, { floor: computeFloor(ctx.params.key, overrides), why: floorWhy(ctx.params.key, overrides) });
  }, { summary: 'Floor for a set of cost inputs (the First price screen) - two numbers required, the rest prefilled' });

  router.get('/api/skus/:key/floor/sensitivity', (ctx) => {
    if (!SKUS[ctx.params.key]) return fail(ctx.res, 404, `unknown SKU: ${ctx.params.key}`);
    return ok(ctx.res, sensitivity(ctx.params.key, overridesFrom(ctx.query)));
  }, { summary: 'What moves F: sourcing, returns, weight, RTO, COD, ads (deck slide 2 box 2)' });

  /* --------------------------------- launch --------------------------------- */
  router.post('/api/launch/plan', (ctx) => {
    const body = ctx.body || {};
    if (!body.category) return fail(ctx.res, 400, 'category is required', `one of: ${Object.keys(CATEGORIES).join(', ')}`);
    try {
      return ok(ctx.res, launchPlan(body));
    } catch (e) {
      return fail(ctx.res, 400, e.message);
    }
  }, { summary: 'The cold-start path: category prior -> look-alikes -> features -> risk -> launch-play -> price hypothesis' });

  router.get('/api/launch/examples', () => ({ examples: deckExamples() }),
    { summary: 'The three worked examples from deck slide 3 box 4, computed end to end' });

  router.get('/api/launch/matrix', () => ({ matrix: LAUNCH_MATRIX }),
    { summary: 'The launch-play matrix (competition x stock depth)' });

  /* ------------------------------- risk models ------------------------------ */
  router.get('/api/risk/pincodes', () => ({ clusters: PINCODE_CLUSTERS }));

  router.post('/api/risk/return', (ctx) => {
    const b = ctx.body || {};
    if (!b.category) return fail(ctx.res, 400, 'category is required');
    return ok(ctx.res, returnRisk(b));
  }, { summary: 'Return / RTO risk per SKU x pincode (AUC >= 0.75 target)' });

  router.post('/api/risk/cod', (ctx) => ok(ctx.res, codRisk(ctx.body || {})),
    { summary: 'COD risk score and the prepaid action (2.0 module)' });

  router.get('/api/risk/keep-probability', (ctx) => {
    const skuKey = ctx.query.sku || 'kurti';
    if (!SKUS[skuKey]) return fail(ctx.res, 404, `unknown SKU: ${skuKey}`);
    const fake = { sku: SKUS[skuKey] };
    return ok(ctx.res, {
      sku: skuKey,
      clusters: PINCODE_CLUSTERS.map((c) => keepProbability(fake, c.key)),
    });
  }, { summary: 'Keep-probability by pincode cluster (which price to show first)' });

  /* ------------------------------- programmes ------------------------------- */
  router.get('/api/programmes', () => ({ modules: moduleCatalogue(), optInRequired: true }),
    { summary: 'ProfitPilot 2.0 modules: who does the work, how it runs, what it is worth, which limit it fixes' });

  router.post('/api/programmes/reorder-point', (ctx) => {
    const b = ctx.body || {};
    if (!b.dailyUnits || !b.leadTimeDays) return fail(ctx.res, 400, 'dailyUnits and leadTimeDays are required');
    return ok(ctx.res, reorderPoint(b));
  }, { summary: 'Reorder point = demand during lead time + safety stock (M28)' });

  router.post('/api/programmes/pooled-procurement', (ctx) => ok(ctx.res, pooledProcurement(ctx.body || {})),
    { summary: 'Pool 5 sellers to meet a 300-unit MOQ (2.0, opt-in)' });

  router.post('/api/programmes/packaging-audit', (ctx) => ok(ctx.res, packagingAudit(ctx.body || {})),
    { summary: 'Valmo scan station: declared vs actual size/weight' });

  /* -------------------------------- dashboard ------------------------------- */
  router.get('/api/system/status', () => {
    const listings = hydratedListings();
    return ({
      listings: listings.map((l) => ({ id: l.id, sku: l.skuKey, price: l.price, floor: l.floor.F, stage: l.stage, health: l.health })),
      belowFloor: listings.filter((l) => l.price < l.floor.F).length,
      guardrailsOn: GUARDRAILS.hardFloor && GUARDRAILS.panicBrake,
      pincodes: PINCODE_CLUSTERS.length,
      cities: cityRanking().slice(0, 3).map((c) => ({ name: c.name, score: c.score })),
    });
  }, { summary: 'Ops view: which listings sit below the floor, guardrails on/off, bandit rotation state' });
}

export function overridesFrom(query = {}) {
  const num = (v) => (v === undefined || v === '' ? undefined : Number(v));
  const out = {};
  for (const k of ['cs', 'pack', 'fwd', 'ret', 'rto', 'T', 'dmg', 'promo', 'ads', 'tax', 'cap']) {
    const n = num(query[k]);
    if (n !== undefined && Number.isFinite(n)) out[k] = n;
  }
  if (query.category) out.category = query.category;
  return out;
}

export function sanitiseOverrides(body = {}) {
  const out = {};
  const bounds = { cs: [0, 100000], pack: [0, 5000], fwd: [0, 5000], ret: [0, 90], rto: [0, 90], T: [0, 100000], dmg: [0, 5000], promo: [0, 5000], ads: [0, 5000], tax: [0, 5000], cap: [0, 5000] };
  for (const [k, [lo, hi]] of Object.entries(bounds)) {
    if (body[k] === undefined || body[k] === null || body[k] === '') continue;
    const n = Number(body[k]);
    if (!Number.isFinite(n)) continue;
    out[k] = Math.max(lo, Math.min(hi, n));
  }
  if (body.category && CATEGORIES[body.category]) out.category = body.category;
  return out;
}

export function limitWarning() {
  return LIMITS.map((l) => `1.0 limit ${l.id}: ${l.limit} - ${l.fix20}`);
}
