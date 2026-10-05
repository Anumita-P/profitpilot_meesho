/**
 * LAYER: MODELS (4 of 4 the pilot needs) - lifecycle stage + trigger rules.
 * Deck slide 4: the engine tracks orders and profit/order over time; stage
 * windows differ by category ("a 60-day-old kurti may already be mature, a
 * 60-day lunch box is still launching"). Every threshold below is a default
 * the pilot calibrates.
 *
 * Orders follow a Bass-like logistic curve; profit/order peaks earlier and
 * falls faster. Shape is illustrative, not fitted data.
 */

import { CATEGORIES, ENGINE, STAGES, STAGE_ORDER, STAGE_WINDOWS_BASE } from '../config/deck.js';
import { computeFloor, ceil9, round } from './floor.js';
import { ordersPerDay } from './demand.js';

const r2 = (x) => Math.round(x * 100) / 100;
const money = (v) => `${v < 0 ? '-' : ''}₹${Math.abs(Math.round(v)).toLocaleString('en-IN')}`;

/** Category-scaled stage windows. Deck slide 4 box 2: durations are defaults. */
export function stageWindows(sku) {
  const life = sku.lifeDays;
  const sc = life / STAGE_WINDOWS_BASE.life;
  const D = (x) => Math.round(x * sc);
  return {
    life,
    launch: D(STAGE_WINDOWS_BASE.launch),
    growth: D(STAGE_WINDOWS_BASE.growth),
    maturity: D(STAGE_WINDOWS_BASE.maturity),
    decline: D(STAGE_WINDOWS_BASE.decline),
    scale: sc,
    D,
  };
}

export function stageAt(sku, day) {
  const w = stageWindows(sku);
  return day < w.launch ? 'launch'
    : day < w.growth ? 'growth'
    : day < w.maturity ? 'maturity'
    : day < w.decline ? 'decline'
    : 'exit';
}

/**
 * Stage classifier from measured signals (deck slide 4 box 3 / slide 5):
 *   g   = kept units, last 4 weeks / the 4 weeks before, - 1
 *   DOI = stock / average daily units
 * Launch: age < launch window · Growth: g > +15% · Maturity: |g| <= 15%
 * Decline: g < -15% or DOI > 60 · Exit: stock age > 90 d / season end.
 */
export function classifyStage(input) {
  const { sku, ageDays, keptUnitTrendPct = 0, doi = 30, stockAgeDays = 0, sellThroughPct = 45, seasonEnded = false } = input;
  const w = stageWindows(sku);
  const drivers = [];
  if (seasonEnded) drivers.push('season ended');
  if (stockAgeDays > 90) drivers.push(`stock batch age ${stockAgeDays} d > 90 d (cash stuck)`);
  if (doi > 60) drivers.push(`DOI ${doi} d > 60 (sell-through ${sellThroughPct}%)`);
  if (keptUnitTrendPct > 15) drivers.push(`kept-unit trend g = +${keptUnitTrendPct}% > +15%`);
  if (keptUnitTrendPct < -15) drivers.push(`kept-unit trend g = ${keptUnitTrendPct}% < -15%`);

  if (ageDays < w.launch) return stage('launch', `age ${ageDays} d < launch window ${w.launch} d`);
  if (keptUnitTrendPct > 15) return stage('growth', `kept-unit trend g = +${keptUnitTrendPct}% > +15%`);
  if (ageDays >= w.decline || seasonEnded) return stage('exit', `age ${ageDays} d >= ${w.decline} d (past the decline window)${seasonEnded ? '; season ended' : ''}`);
  if (keptUnitTrendPct < -15 || doi > 60) return stage('decline', `${keptUnitTrendPct < -15 ? `g = ${keptUnitTrendPct}% < -15%` : `DOI ${doi} d > 60`}`);
  return stage('maturity', `g = ${keptUnitTrendPct >= 0 ? '+' : ''}${keptUnitTrendPct}% inside +-15%, DOI ${doi} d`);

  function stage(key, reason) {
    return {
      stage: key, name: STAGES[key].name, color: STAGES[key].color, reason, drivers,
      windows: w, defaultMode: STAGES[key].defaultMode, goal: STAGES[key].goal, move: STAGES[key].move,
    };
  }
}

/**
 * The full lifecycle model for one listing: the price path the engine would
 * have taken, with every trigger and both decision trees.
 */
export function lifecycle(listing, opts = {}) {
  const sku = listing.sku;
  const f = opts.floor || computeFloor(sku.key, listing.costOverrides || {});
  const w = stageWindows(sku);
  const day = opts.day ?? listing.ageDays;
  const stage = opts.stage || classifyStage({ sku, ageDays: listing.ageDays, ...listing.signals }).stage;

  const P0 = listing.offlinePrice ?? sku.price;
  const P1 = Math.round((listing.price || sku.live) * 1.04);
  const Rv = Math.round(P1 * 0.935);

  /* Rival test (deck slide 4 box 3): the rival takes ~30% of orders at the held
     price. If we match, the rival is still there, so the match starts from the
     post-rival level and only gains the price effect (b = -3). */
  const live = listing.price || sku.live;
  const preO = Math.round(ordersPerDay(listing, P1));
  const holdO = Math.round(ordersPerDay(listing, P1) * 0.7);
  const matchO = +(holdO * Math.pow(P1 / live, 3)).toFixed(1);
  const holdProfit = holdO * f.k * (P1 - f.F);
  const matchProfit = matchO * f.k * (live - f.F);
  const doMatch = matchProfit > holdProfit;
  const Pm = doMatch ? live : P1;

  const M1 = ceil9(Pm * 0.92);
  const M2 = ceil9(M1 * 0.92);
  const M3 = Math.max(f.Fplus, ceil9(M2 * 0.92));

  const D = w.D;
  const events = [
    { day: D(38), price: P1, label: `${money(live)} -> ${money(P1)} (+4% Growth step)`, type: 'growth-step' },
    { day: D(52), price: P1, label: `Rival lists ${money(Rv)}`, type: 'rival' },
    { day: D(56), price: Pm, label: doMatch ? `Partial match ${money(P1)} -> ${money(live)}` : `Hold ${money(P1)}: matching earns less`, type: 'match-test' },
    { day: D(140), price: M1, label: `Markdown ${money(Pm)} -> ${money(M1)}`, type: 'markdown-1' },
    { day: D(162), price: M2, label: `${money(M1)} -> ${money(M2)}`, type: 'markdown-2' },
    { day: D(175), price: M3, label: `${money(M2)} -> ${money(M3)} (clearance, >= F)`, type: 'clearance' },
  ];

  const a = ordersPerDay(listing, live);
  const b = ordersPerDay(listing, P1);
  const c = doMatch ? matchO : holdO;
  const e = ordersPerDay(listing, Pm);
  const ordersPoints = [
    [0, a * 8 / 23], [15, a * 14 / 23], [30, a * 19 / 23], [36, a],
    [38, b], [52, b], [54, holdO], [56, c], [90, e], [105, e * 21 / 22],
    [120, e * 17 / 22], [130, e * 11 / 22], [140, e * 7 / 22], [155, e * 5 / 22],
    [175, e * 4 / 22], [180, e * 3 / 22],
  ].map(([d, v]) => [D(d), +v.toFixed(2)]);

  return {
    listingId: listing.id,
    sku: sku.key,
    day,
    stage,
    stageName: STAGES[stage].name,
    stageColor: STAGES[stage].color,
    windows: w,
    floor: { F: f.F, B: f.B, k: f.k, recoveryFloor: f.frec, clearance: f.Fplus },
    startPrice: { offline: P0, step1: P1, rival: Rv, held: Pm, matched: doMatch },
    rivalTest: {
      holdOrders: holdO, matchOrders: matchO,
      preRivalOrders: preO,
      holdProfitPerDay: r2(holdProfit), matchProfitPerDay: r2(matchProfit),
      decision: doMatch ? 'partial match (never below floor)' : 'hold: matching earns less',
      formula: `hold ${money(P1)} -> ${preO} -> ${holdO}/day -> ${money(holdProfit)}/day; match ${money(live)} -> ${holdO} x (${money(P1)}/${money(live)})^3 = ${matchO}/day -> ${money(matchProfit)}/day`,
    },
    priceLadder: { M1, M2, M3, clearanceTarget: f.Fplus, recoveryFloor: f.frec, steps: 8 },
    events,
    ordersPoints,
    priceAtDay: priceAtDay(events, day, listing),
    seedUsed: 0,
  };
}

function priceAtDay(events, day, listing) {
  let p = listing.price;
  events.forEach((ev) => { if (day >= ev.day) p = ev.price; });
  return p;
}

/**
 * The signals the engine reads, and the price move, per stage.
 * Deck slide 4 box 3 - "every threshold is a default the pilot calibrates".
 */
export function stageSignals(listing, stage, opts = {}) {
  const f = opts.floor || computeFloor(listing.sku.key, listing.costOverrides || {});
  const sig = listing.signals;
  const kr = sig.keptRatePct ?? Math.round(f.k * 100);
  const orders = ordersPerDay(listing, listing.price);
  const targets = {
    launch:   { ordersTrend: 'ramping', keptUnitTrend: 'n/a', doi: 45, cvr: '12%' },
    growth:   { ordersTrend: 'rising', keptUnitTrend: '+21%', doi: 35, cvr: '13%' },
    maturity: { ordersTrend: 'steady', keptUnitTrend: '+3%', doi: 40, cvr: '13%' },
    decline:  { ordersTrend: 'falling', keptUnitTrend: '-22%', doi: 73, cvr: '11%' },
    exit:     { ordersTrend: 'low', keptUnitTrend: '-28%', doi: 85, cvr: '10%' },
  }[stage];
  return [
    { label: 'Orders / day', value: r2(orders), note: targets.ordersTrend, state: stage === 'decline' || stage === 'exit' ? 'bad' : 'ok' },
    { label: 'Kept-unit trend g', value: `${sig.keptUnitTrendPct}%`, note: 'Growth > +15% · Decline < -15%', state: sig.keptUnitTrendPct < -15 ? 'bad' : sig.keptUnitTrendPct > 15 ? 'ok' : 'warn' },
    { label: 'Days of inventory', value: sig.doi, note: 'limit 60 · min 30 before a step', state: sig.doi > 60 ? 'bad' : sig.doi < 30 ? 'warn' : 'ok' },
    { label: 'Conversion', value: `${sig.cvr}%`, note: `median ${sig.cvrMedian}%`, state: sig.cvr < sig.cvrMedian ? 'warn' : 'ok' },
    { label: 'Kept rate', value: `${kr}%`, note: `${Math.round(f.k * 100)}% assumed in F`, state: kr < Math.round(f.k * 100) ? 'bad' : 'ok' },
    { label: 'Rival gap', value: `${sig.rivalGapPct}%`, note: 'rival undercut trigger: > 5% for 7 days', state: sig.rivalGapPct > 5 ? 'bad' : 'ok' },
  ];
}

/** The trigger table (deck slide 4 box 3) as machine-readable rules. */
export function triggers(listing, opts = {}) {
  const f = opts.floor || computeFloor(listing.sku.key, listing.costOverrides || {});
  const sig = listing.signals;
  return [
    { stage: 'launch', goal: 'Learn demand fast', signals: 'impressions, CTR, CVR, first ratings',
      trigger: '>= 1,000 impressions or 14 days',
      fired: (listing.impressionsSinceMove ?? sig.views) >= 1000 || listing.ageDays >= 14,
      action: 'sanity check only: are buyers ordering, are returns normal' },
    { stage: 'growth', goal: 'Scale what works', signals: 'kept-unit growth vs last season, CVR vs similar SKUs, kept rate',
      trigger: 'CVR holds 2 weeks after a step',
      fired: sig.cvr >= sig.cvrMedian && sig.cvrHoldWeeks >= 2,
      action: `step up 3-5% or cut discount (now: ${money(listing.price - f.F)} per kept order)` },
    { stage: 'maturity', goal: 'Protect margin', signals: 'contribution per order, impression share, rival price gap',
      trigger: 'rival undercuts > 5% for 7 days',
      fired: sig.rivalGapPct > 5,
      action: 'defend with costs and dual price, not deep cuts' },
    { stage: 'decline', goal: 'Recover value', signals: 'kept units vs last season, DOI, sell-through',
      trigger: 'DOI > 60 or margin < 0',
      fired: sig.doi > 60 || listing.price - f.F < 0,
      action: 'bundle, wider reach (seller approves), ₹30 steps >= full cost F' },
    { stage: 'exit', goal: 'Free the cash', signals: 'stock age, season end',
      trigger: 'stock age > 90 days / season end',
      fired: (sig.stockAgeDays ?? 0) > 90,
      action: `clearance >= F ${money(f.F)}; below F only with explicit consent, never below ${money(f.frec)}` },
  ];
}

/**
 * Decline exits: value recovered per stuck unit (deck slide 5 box 4).
 * recovery = sell-through x net cash/unit / F.
 */
export function exits(listing, opts = {}) {
  const f = opts.floor || computeFloor(listing.sku.key, listing.costOverrides || {});
  const list = [
    { key: 'bundle', label: 'Bundle with a fast mover', deckRange: '50-80%', sellThrough: 85, netFactor: 0.78, freight: 0 },
    { key: 'markdown', label: 'Markdown ladder', deckRange: '40-70%', sellThrough: 75, netFactor: 0.73, freight: 0 },
    { key: 'reach', label: 'Wider reach (similar regions, seller approves)', deckRange: '+30-60% local sell-through', sellThrough: 45 * 1.3, netFactor: 0.85, freight: 15 },
    { key: 'b2b', label: 'B2B / bulk lot', deckRange: '20-50%', sellThrough: 100, netFactor: 0.35, freight: 0 },
  ];
  return list.map((o) => {
    const st = Math.min(100, o.sellThrough);
    const net = o.netFactor * f.F - o.freight;
    const recoveryPct = st / 100 * net / f.F * 100;
    return {
      key: o.key, label: o.label, deckRange: o.deckRange,
      sellThroughPct: r2(st), netCashPerUnit: r2(net),
      recoveryPct: r2(recoveryPct),
      recoveredPerUnit: r2(recoveryPct / 100 * f.F),
      why: recoveryPct >= 50 ? 'Recovers most of the cost without cutting the unit price for other buyers.' : 'Recovers less than a bundle or a markdown; use when the item cannot sell at >= the recovery floor.',
    };
  }).concat([
    { key: 'return-donate', label: 'Return / donate', deckRange: 'costs ₹40-60/unit', recoveryPct: -12, recoveredPerUnit: -50, netCashPerUnit: -50, sellThroughPct: 0, why: 'Recovers nothing; costs reverse logistics ₹40-60 per unit. Only when the item cannot sell at >= the recovery floor.' },
    { key: 'park', label: 'Park for next season', deckRange: 'holding ~2%/month', recoveryPct: -2, recoveredPerUnit: -r2(f.F * 0.02), netCashPerUnit: 0, sellThroughPct: 0, why: `Holding cost is about 2% of F per month (₹${r2(f.F * 0.02)} here). Category life is ${CATEGORIES[f.category].life}.` },
  ]);
}

/** Exit consent: going below F, never below the recovery floor (deck slide 5 box 5). */
export function exitConsent(listing, opts = {}) {
  const f = opts.floor || computeFloor(listing.sku.key, listing.costOverrides || {});
  const lc = opts.lifecycle || lifecycle(listing, opts);
  const price = Math.max(f.frec, ceil9(lc.priceLadder.M3 * 0.94));
  return {
    price,
    floor: f.F,
    recoveryFloor: f.frec,
    lossPerKeptOrder: r2(price - f.F),
    freesCash: price >= f.frec,
    warning: `${money(price)} - F ${money(f.F)} = ${money(price - f.F)} per kept order, but it frees cash: ${money(price)} >= ${money(f.frec)}`,
    consentRequired: true,
    /* Honest note: because the markdown ladder lives on the MARGIN price (Pm = F / 0.78) and
       walks down in 8% steps, its final rung sits at roughly 1.03-1.14 x F, so this 0.94 step
       usually still lands ABOVE F. The recovery floor is the guard for the cases where it does
       not (long-lived stock, a shallow ladder). Either way the seller sees the exact loss. */
    aboveFloorInThisCase: price >= f.F,
    scope: 'Exit stage only, with explicit seller consent; consent can be withdrawn any time and the price returns to >= F.',
    recoveryFloorDefinition: 'Variable costs that still leave the seller\'s pocket (no ads, no capital charge).',
    holdsWeight: `Holding the stock loses about ${money(f.F * 0.02)} per unit per month instead.`,
  };
}

/** Sorted stage list for the UI road. */
export function stageRoad(sku) {
  const w = stageWindows(sku);
  const edges = { launch: [0, w.launch], growth: [w.launch, w.growth], maturity: [w.growth, w.maturity], decline: [w.maturity, w.decline], exit: [w.decline, w.life] };
  return STAGE_ORDER.map((k) => ({ key: k, name: STAGES[k].name, color: STAGES[k].color, from: edges[k][0], to: edges[k][1], mid: Math.round((edges[k][0] + edges[k][1]) / 2), ...STAGES[k] }));
}

/** Bass-like logistic used by the deck's illustrative curve (slide 4 box 1). */
export function orderCurve(t) {
  const q = 0.04 + 0.86 / (1 + Math.exp(-11 * (t - 0.3))) - 2.6 * Math.pow(Math.max(0, t - 0.62), 1.7);
  return Math.max(0, q);
}

export { STAGES, ENGINE };
