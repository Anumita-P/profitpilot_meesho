/**
 * SCENARIO MODEL (v2 phase 1).
 *
 * A scenario is the description of a seller, a SKU and a market. It is data, not
 * code: the lab screen edits it, the API validates it, the simulator reads it,
 * and every run against it is reproducible from `seed` + the parameters.
 *
 * WHAT THIS IS NOT: real Meesho data, and not a forecast. Every scenario carries
 * `label: 'SIMULATED - illustrative'`, and the numbers it produces are the output
 * of the deterministic model in src/sim/market.js, never evidence about a real
 * marketplace. Evidence still comes from ingested events and holdout experiments
 * (see src/domain/trust.js).
 *
 * Reuse: the scenario scales and shifts the EXISTING engines - demand
 * (ordersPerDay with its price penalty), the return/RTO priors in risk.js, the
 * floor arithmetic in floor.js - rather than inventing a parallel economics.
 * A scenario knob that the engine does not have (`demandShock`) multiplies the
 * engine's own output instead of replacing the curve.
 */

import { load, save, logEvent, httpError, listing, hydrate } from '../store/db.js';
import { SKUS } from '../config/deck.js';
import { number, text, enumValue, object, id as idRule } from '../http/validate.js';
import { fingerprintOf } from './random.js';
import { versionSet } from '../domain/versions.js';

export const STATUSES = ['DRAFT', 'RUNNING', 'PAUSED', 'DONE'];
export const LABEL = 'SIMULATED - illustrative';
export const DEMAND_LEVELS = ['very_low', 'low', 'medium', 'high', 'very_high'];
export const QUALITIES = ['low', 'medium', 'high'];

/** Multipliers for the categorical knobs: one place, so the lab and the tests agree. */
export const DEMAND_LEVEL_FACTOR = { very_low: 0.45, low: 0.7, medium: 1, high: 1.35, very_high: 1.8 };
export const QUALITY_FACTOR = { low: 0.62, medium: 1, high: 1.38 };
/** Catalogue quality acts on clicks; seller quality on fulfilment and returns. */
export const QUALITY_CTR_FACTOR = { low: 0.7, medium: 1, high: 1.25 };
export const FULFILMENT_FACTOR = { low: 1.9, medium: 1.15, high: 0.7 };

const DEFAULTS = {
  horizon_days: 30,
  sku: { demandLevel: 'medium', elasticity: null, catalogueQuality: 'medium', seasonality: 0, inventory: 500, inventoryAgeDays: 20, unitCost: null, basePrice: null, promotion: null },
  seller: { quality: 'medium', catalogueQuality: 'medium', fulfilmentQuality: 'medium', inventoryLevel: null, inventoryAgeDays: null, returnPropensity: 1, rtoPropensity: 1, codShare: null },
  market: { demandTrend: 0, competitionIntensity: 'medium', priceSensitivity: 1, seasonalShock: 0, demandShock: 0, lookalikeGapPct: null },
  risk: { codRisk: 1, returnRisk: 1, rtoRisk: 1, fulfilmentRisk: 1 },
};

const num = (v, field, { min = -100, max = 100, required = false, dflt = 0 } = {}) => (v === undefined || v === null
  ? dflt
  : number(v, field, { min, max, required }));

/**
 * Validate + normalise a scenario body. Fail-fast with the field name, like the
 * rest of the API: a lab screen that silently ignores a knob is worse than one
 * that refuses it.
 */
export function normalise(input = {}, { sellerId = null, existing = null } = {}) {
  const base = existing || DEFAULTS;
  const skuIn = object(input.sku, 'sku', { required: false, default: {} });
  const sellerIn = object(input.seller, 'seller', { required: false, default: {} });
  const marketIn = object(input.market, 'market', { required: false, default: {} });
  const riskIn = object(input.risk, 'risk', { required: false, default: {} });

  const skuKey = enumValue(input.skuKey ?? input.sku_key ?? existing?.skuKey, 'sku_key', Object.keys(SKUS));
  const sku = SKUS[skuKey];
  const listingId = input.listing_id ? idRule(input.listing_id, 'listing_id') : `L-${skuKey}`;
  const target = listing(listingId);                       // 404s for an unknown listing

  const out = {
    name: text(input.name ?? existing?.name ?? `${sku.name} scenario`, 'name', { maxLength: 120 }),
    seller_id: sellerId || existing?.seller_id || target.sellerId,
    listing_id: listingId,
    skuKey,
    seed: number(input.seed ?? existing?.seed ?? 7, 'seed', { min: 0, max: 2 ** 31 - 1, integer: true }),
    horizon_days: number(input.horizon_days ?? existing?.horizon_days ?? DEFAULTS.horizon_days, 'horizon_days', { min: 1, max: 180, integer: true }),
    start_at: input.start_at ?? existing?.start_at ?? new Date().toISOString(),
    notes: text(input.notes ?? existing?.notes ?? null, 'notes', { required: false, maxLength: 400, default: null }),
    sku: {
      basePrice: Math.round(num(skuIn.basePrice ?? existing?.sku?.basePrice ?? target.price, 'sku.basePrice', { min: 50, max: 50000 })),
      unitCost: Math.round(num(skuIn.unitCost ?? existing?.sku?.unitCost ?? sku.costs.cs, 'sku.unitCost', { min: 1, max: 40000 })),
      category: sku.category,
      demandLevel: enumValue(skuIn.demandLevel ?? existing?.sku?.demandLevel ?? base.sku.demandLevel, 'sku.demandLevel', DEMAND_LEVELS),
      elasticity: num(skuIn.elasticity ?? existing?.sku?.elasticity ?? null, 'sku.elasticity', { min: -6, max: 0, dflt: null }),
      catalogueQuality: enumValue(skuIn.catalogueQuality ?? existing?.sku?.catalogueQuality ?? base.sku.catalogueQuality, 'sku.catalogueQuality', QUALITIES),
      inventory: Math.round(num(skuIn.inventory ?? existing?.sku?.inventory ?? base.sku.inventory, 'sku.inventory', { min: 0, max: 100000 })),
      inventoryAgeDays: Math.round(num(skuIn.inventoryAgeDays ?? existing?.sku?.inventoryAgeDays ?? base.sku.inventoryAgeDays, 'sku.inventoryAgeDays', { min: 0, max: 720 })),
      seasonality: num(skuIn.seasonality ?? existing?.sku?.seasonality ?? 0, 'sku.seasonality', { min: -1, max: 1 }),
      promotion: input.promotion !== undefined ? promotionIn(input.promotion) : (existing?.sku?.promotion ?? null),
    },
    seller: {
      quality: enumValue(sellerIn.quality ?? existing?.seller?.quality ?? base.seller.quality, 'seller.quality', QUALITIES),
      catalogueQuality: enumValue(sellerIn.catalogueQuality ?? existing?.seller?.catalogueQuality ?? base.seller.catalogueQuality, 'seller.catalogueQuality', QUALITIES),
      fulfilmentQuality: enumValue(sellerIn.fulfilmentQuality ?? existing?.seller?.fulfilmentQuality ?? base.seller.fulfilmentQuality, 'seller.fulfilmentQuality', QUALITIES),
      inventoryLevel: sellerIn.inventoryLevel === undefined ? (existing?.seller?.inventoryLevel ?? null) : String(sellerIn.inventoryLevel),
      inventoryAgeDays: sellerIn.inventoryAgeDays === undefined ? (existing?.seller?.inventoryAgeDays ?? null) : Math.round(num(sellerIn.inventoryAgeDays, 'seller.inventoryAgeDays', { min: 0, max: 720 })),
      returnPropensity: num(sellerIn.returnPropensity ?? existing?.seller?.returnPropensity ?? 1, 'seller.returnPropensity', { min: 0, max: 5 }),
      rtoPropensity: num(sellerIn.rtoPropensity ?? existing?.seller?.rtoPropensity ?? 1, 'seller.rtoPropensity', { min: 0, max: 5 }),
      codShare: num(sellerIn.codShare ?? existing?.seller?.codShare ?? target.signals?.codShare ?? 0.5, 'seller.codShare', { min: 0, max: 1 }),
    },
    market: {
      demandTrend: num(marketIn.demandTrend ?? existing?.market?.demandTrend ?? 0, 'market.demandTrend', { min: -0.2, max: 0.2 }),
      competitionIntensity: enumValue(marketIn.competitionIntensity ?? existing?.market?.competitionIntensity ?? base.market.competitionIntensity, 'market.competitionIntensity', QUALITIES),
      /* The look-alike gap the SCENARIO declares: how far this listing's price sits
         above the median of comparable listings in the synthetic market, in percent.
         It is an input assumption of the stress test - this engine never reads a
         rival's actual price. Null means "keep the listing's own stored gap". */
      lookalikeGapPct: marketIn.lookalikeGapPct === undefined
        ? (existing?.market?.lookalikeGapPct ?? base.market.lookalikeGapPct ?? null)
        : num(marketIn.lookalikeGapPct, 'market.lookalikeGapPct', { min: -90, max: 300, dflt: null }),
      priceSensitivity: num(marketIn.priceSensitivity ?? existing?.market?.priceSensitivity ?? 1, 'market.priceSensitivity', { min: 0, max: 4 }),
      seasonalShock: num(marketIn.seasonalShock ?? existing?.market?.seasonalShock ?? 0, 'market.seasonalShock', { min: -1, max: 3 }),
      demandShock: num(marketIn.demandShock ?? existing?.market?.demandShock ?? 0, 'market.demandShock', { min: -1, max: 5 }),
    },
    risk: {
      codRisk: num(riskIn.codRisk ?? existing?.risk?.codRisk ?? 1, 'risk.codRisk', { min: 0, max: 5 }),
      returnRisk: num(riskIn.returnRisk ?? existing?.risk?.returnRisk ?? 1, 'risk.returnRisk', { min: 0, max: 5 }),
      rtoRisk: num(riskIn.rtoRisk ?? existing?.risk?.rtoRisk ?? 1, 'risk.rtoRisk', { min: 0, max: 5 }),
      fulfilmentRisk: num(riskIn.fulfilmentRisk ?? existing?.risk?.fulfilmentRisk ?? 1, 'risk.fulfilmentRisk', { min: 0, max: 5 }),
    },
  };
  return out;
}

function promotionIn(p) {
  if (p === null || p === undefined || p === '' || p === false) return null;
  return {
    kind: enumValue(p.kind || 'coupon', 'promotion.kind', ['coupon', 'flat_discount', 'free_shipping', 'bundle']),
    value: number(p.value, 'promotion.value', { min: 0, max: 5000 }),
    active: p.active === undefined ? true : !!p.active,
    note: text(p.note || null, 'promotion.note', { required: false, maxLength: 200, default: null }),
  };
}

/** The part of a scenario that changes BEHAVIOUR. `name`, `notes` and `start_at`
 *  are labels: two scenarios with the same behaviour fingerprint produce the same
 *  stream, which is the determinism property the tests check. */
export function behaviourFingerprint(params) {
  return fingerprintOf({
    skuKey: params.skuKey,
    seed: params.seed,
    horizon_days: params.horizon_days,
    sku: params.sku,
    seller: params.seller,
    market: params.market,
    risk: params.risk,
  });
}

/** The observed starting point the scenario was built from (frozen at creation).
 *  Without this, re-running a scenario after new events arrived would silently
 *  change its output - i.e. the "same seed, same result" promise would be false. */
export function captureBaseline(listingId) {
  const L = hydrate(listing(listingId));
  return {
    captured_at: new Date().toISOString(),
    price: L.price,
    /* the full feature snapshot as well as the named anchors below: the scenario
       lab folds a run's events into the listing's signals, so a reset has to be
       able to put every feature back exactly as it was. Without this, one run's
       cumulative fold becomes the next run's starting traffic. */
    signals: JSON.parse(JSON.stringify(L.signals || {})),
    observed: null,
    views: L.signals.views,
    clicks: L.signals.clicks ?? Math.round((L.signals.views || 0) * (L.signals.ctr || 4) / 100),
    ctr: L.signals.ctr,
    q0: L.signals.q0,
    returnsPct: L.signals.returnsPct,
    rtoPct: L.signals.rtoPct,
    codShare: L.signals.codShare,
    stock: L.stock?.units ?? null,
    note: 'The listing as it was when this scenario was created. The simulator starts from these anchors so the run is reproducible even after real traffic arrives. POST /api/sim/scenarios/:id/rebuild re-captures it.',
  };
}

export function create(input = {}, ctx = {}) {
  const d = load();
  const params = normalise(input, { sellerId: ctx.sellerId });
  d.counters.scenarios = (d.counters.scenarios || 0) + 1;
  const scenario = {
    scenario_id: `SC-${String(d.counters.scenarios).padStart(4, '0')}`,
    ...params,
    status: 'DRAFT',
    cursor_day: 0,                 // how many days have already been simulated
    ledger: [],                    // per-day simulated aggregates (the simulator's own books)
    event_ids: [],                 // ids of the events this scenario pushed through the real pipeline
    totals: emptyTotals(),
    runs: 0,
    last_run_at: null,
    baseline: captureBaseline(params.listing_id),
    label: LABEL,
    warning: 'SIMULATED scenario. These parameters and their outcomes are illustrative model output, not Meesho data and not a forecast.',
    versions: versionSet(),
    params_fingerprint: behaviourFingerprint(params),
    created_at: new Date().toISOString(),
    correlation_id: ctx.correlationId || null,
  };
  d.scenarios.push(scenario);
  logEvent('scenario.created', { scenarioId: scenario.scenario_id, sellerId: scenario.seller_id, listingId: scenario.listing_id, seed: scenario.seed });
  save();
  return scenario;
}

export function emptyTotals() {
  return { views: 0, clicks: 0, orders: 0, cancelled: 0, shipped: 0, delivered: 0, returned: 0, rto: 0, kept: 0, unitsKept: 0, revenue: 0, contribution: 0, inventoryEnd: null, stockoutDays: 0 };
}

export function find(d, id) {
  const s = (d.scenarios || []).find((x) => x.scenario_id === id);
  if (!s) throw httpError(404, `unknown scenario: ${id}`);
  return s;
}

export function get(id) {
  return find(load(), id);
}

export function list(filter = {}) {
  const d = load();
  return (d.scenarios || []).filter((s) => (!filter.sellerId || s.seller_id === filter.sellerId)
    && (!filter.listingId || s.listing_id === filter.listingId)
    && (!filter.status || s.status === filter.status));
}

/** The listing view the simulator drives (hydrated: sku, floor, signals, stage). */
export function hydratedTarget(scenario) {
  return hydrate(listing(scenario.listing_id));
}

export function update(id, patch = {}) {
  const d = load();
  const s = find(d, id);
  if (s.status === 'RUNNING' && patch.status === undefined) {
    throw httpError(409, `${id} is RUNNING: pause it before editing parameters (a run must be reproducible from its parameters)`, { scenario_id: id });
  }
  const next = normalise(patch, { sellerId: s.seller_id, existing: s });
  Object.assign(s, next);
  s.params_fingerprint = behaviourFingerprint(next);
  s.updated_at = new Date().toISOString();
  logEvent('scenario.updated', { scenarioId: id, fingerprint: s.params_fingerprint });
  save();
  return s;
}

/** Reset a run: keeps the parameters, wipes the ledger and the cursor. */
export function reset(id, { keepEvents = true, reason = null } = {}) {
  const d = load();
  const s = find(d, id);
  s.cursor_day = 0;
  s.ledger = [];
  s.event_ids = [];        // the scenario's own bookkeeping starts fresh; the events themselves stay in the pipeline (they are history now)
  s.totals = emptyTotals();
  s.status = 'DRAFT';
  s.last_run_at = null;
  s.reset_at = new Date().toISOString();
  s.reset_note = reason || `reset: the ledger and the cursor are cleared, the ${keepEvents ? 'already-ingested events stay in the pipeline (they are real history now)' : 'params are unchanged'}`;
  logEvent('scenario.reset', { scenarioId: id, keepEvents, reason });
  save();
  return s;
}

export function setStatus(id, status, note = null) {
  const s = get(id);
  const d = load();
  const target = find(d, id);
  target.status = enumValue(status, 'status', STATUSES);
  target.status_note = note;
  target.status_at = new Date().toISOString();
  save();
  return target;
}

export const DEFAULTS_EXPORT = DEFAULTS;
