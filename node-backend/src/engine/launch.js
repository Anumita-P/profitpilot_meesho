/**
 * DELIVERABLE 1 - the first price, with no history (deck slide 3).
 * "Launch: the first price is a tested hypothesis."
 *
 * The cold-start path, all five steps, using only day-0 inputs:
 *   1 Category prior -> band        (category GMV, return & RTO history)
 *   2 Comparable SKUs -> median     (Meesho catalogue, image+text similarity)
 *   3 SKU features                  (upload form: images, attributes)
 *   4 Risk estimates -> safety in F (pincode RTO, COD share, reason codes)
 *   4b Launch-play matrix           (days of stock x look-alike count)
 *   5 Price hypothesis              (floor-checked opening + dual-price menu)
 */

import { CATEGORIES, ENGINE, LAUNCH_MATRIX, SKUS } from '../config/deck.js';
import { computeFloor, ceil9, floor9, round } from './floor.js';
import { returnRisk } from './risk.js';

const r2 = (x) => Math.round(x * 100) / 100;
const money = (v) => `${v < 0 ? '-' : ''}₹${Math.abs(Math.round(v)).toLocaleString('en-IN')}`;

/**
 * @param {object} input
 *   { category, sellerCost (C_s), features:{fragile, weightKg, sizeRisk},
 *     comparables:{ count, median, p25, p75 }, stock:{ days, units },
 *     pincodeCluster, codShare, targetProfit }
 */
export function launchPlan(input) {
  const cat = CATEGORIES[input.category];
  if (!cat) throw new Error(`unknown category: ${input.category}`);

  const comparables = input.comparables || {};
  const stock = input.stock || {};
  const features = input.features || {};
  const notes = [];

  /* 1. Category prior -> band (a new SKU has no data; its category's history is the best first guess) */
  const band = [comparables.p25 ?? 299, comparables.p75 ?? 599];
  const priorBand = {
    step: 1,
    title: 'Category prior',
    why: 'A new SKU has no data; its category\'s history is the best first guess.',
    inputs: [`Category GMV, return & RTO history (${cat.name}: returns ${cat.ret}%, RTO ${cat.rto}%)`],
    output: `band ${money(band[0])}-${money(band[1])}`,
    band,
  };

  /* 2. Comparable SKUs -> median */
  const median = comparables.median ?? Math.round((band[0] + band[1]) / 2);
  const comparableStep = {
    step: 2,
    title: 'Comparable SKUs',
    why: 'Buyers compare side by side, so look-alikes set the price band.',
    inputs: ['Meesho catalogue, image + text similarity (CLIP-style embeddings)'],
    output: `${comparables.count ?? 24} look-alikes, median ${money(median)}`,
    count: comparables.count ?? 24,
    median,
    atBandUpper: median >= band[1],
  };

  /* 3. SKU features -> both demand and cost shift (fragile/weight change the floor) */
  /* The deck's own weight lever (slide 2 box 2): 0.5 kg -> ₹25, 1 kg -> ₹45 (+₹20),
     i.e. fwd = 5 + 40 x kg, floored at ₹15 for very light parcels.
     Only what the features actually change is overridden: a non-fragile SKU keeps the
     category's own packaging line, and no weight keeps the category freight. */
  const featureCosts = {
    pack: features.fragile ? 25 : null,
    fwd: features.weightKg ? Math.max(15, Math.round(5 + 40 * features.weightKg)) : null,
  };
  const base = SKUS[input.skuKey || nearestSku(input.category)] || { pack: 10, fwd: 25 };
  const packUsed = featureCosts.pack ?? base.pack;
  const fwdUsed = featureCosts.fwd ?? base.fwd;
  const featureStep = {
    step: 3,
    title: 'SKU features',
    why: 'Fabric, weight and fragility shift both demand and cost.',
    inputs: ['Seller upload form: images, attributes'],
    output: `feature vector x -> freight ${money(fwdUsed)} (${fwdUsed === base.fwd ? 'category line' : `${money(fwdUsed - base.fwd)} vs the category line`}), packaging ${money(packUsed)} in F`,
    featureVector: {
      fragile: !!features.fragile,
      weightKg: features.weightKg ?? 0.5,
      sizeRisk: features.sizeRisk ?? 0.5,
      sizes: features.sizes || [],
      material: features.material || null,
    },
  };

  /* 5. Floor (moved up): the risk step and the hypothesis both quote it */
  const floor = computeFloor(input.skuKey || nearestSku(input.category), {
    ...(input.sellerCost != null ? { cs: input.sellerCost } : {}),
    ...(featureCosts.pack != null ? { pack: featureCosts.pack } : {}),
    ...(featureCosts.fwd != null ? { fwd: featureCosts.fwd } : {}),
    ...(input.targetProfit != null ? { T: input.targetProfit } : {}),
  });
  const safetyMargin = Math.round(floor.F * ENGINE.LAUNCH_SAFETY_MARGIN_PCT);
  const minPrice = floor.F + safetyMargin;   // deck slide 4 step 4 / slide 7 trace: F ₹309 + ₹18 = ₹327 min

  /* 4. Risk estimates -> the safety margin on top of F */
  const risk = returnRisk({
    category: input.category,
    fragile: features.fragile,
    weightKg: features.weightKg,
    sizeRisk: features.sizeRisk,
    pincodeCluster: input.pincodeCluster || 'tier2-cod',
    codShare: input.codShare,
  });
  const riskStep = {
    step: 4,
    title: 'Risk estimates',
    why: 'Returns and RTO set the floor; a safety margin covers the uncertainty.',
    inputs: ['Pincode RTO, COD share, reason codes'],
    output: `P(return) = ${(risk.pReturn * 100).toFixed(1)}%, P(RTO) = ${(risk.pRto * 100).toFixed(1)}% -> buffer B ${money(floor.B)} inside F, plus a ${money(safetyMargin)} safety margin (${(ENGINE.LAUNCH_SAFETY_MARGIN_PCT * 100).toFixed(1)}% of F) for floor-estimation error`,
    risk: { ...risk, bufferInsideFloor: floor.B, safetyMargin, minPrice },
  };

  /* 4b. Launch-play matrix: days of stock x look-alike count */
  const competitionHigh = (comparableStep.count ?? 0) >= 20;
  // "deep" means 45+ days of cover OR a large absolute lot (the deck's Rajkot row is "300 units")
  const stockDeep = (stock.days ?? 30) >= 45 || (stock.units ?? 0) >= 100;
  const playKey = competitionHigh ? (stockDeep ? 'velocity' : 'differentiate') : (stockDeep ? 'priceDiscovery' : 'controlled');
  const play = { step: '4b', title: 'Launch-play matrix', why: 'A crowded feed with deep stock needs a sharper opening.', matrix: LAUNCH_MATRIX[playKey], key: playKey,
    inputs: [`days of stock ${stock.days ?? '?'} x look-alikes ${comparableStep.count ?? '?'}`] };

  /* 5. Price hypothesis: floor-checked opening + dual-price menu */
  /* Price points end in 9; the largest ₹9 price below the median is floor9(median - 1).
     (The prototype states this rule on the first-price step.) */
  const underMedian = floor9(median - 1);
  const aboveMedian = ceil9(median);
  const discoveryLadder = [aboveMedian, ceil9(aboveMedian + 10)];

  const currentPrice = input.currentPrice != null ? input.currentPrice : null;
  const currentInsideBand = currentPrice != null && currentPrice >= band[0] && currentPrice <= band[1] && currentPrice >= minPrice;

  let opening = floor.Pe;
  let openingRule = 'floor + target profit (P* = F + T)';
  if (playKey === 'velocity') { opening = Math.min(floor.Pe, underMedian); openingRule = `open just under the median: min(F + T, ${money(underMedian)})`; }
  if (playKey === 'priceDiscovery') { opening = Math.max(floor.Pe, aboveMedian); openingRule = `test high: max(F + T, ${money(aboveMedian)})`; }
  if (playKey === 'controlled') { opening = Math.max(floor.Pe, ceil9(band[1] * 0.95)); openingRule = 'premium, no deep discount: near the top of the band'; }
  if (playKey === 'differentiate') { opening = Math.max(floor.Pe, aboveMedian); openingRule = 'bundle or better image first; price near the median'; }
  if (currentInsideBand && playKey === 'priceDiscovery') { opening = currentPrice; openingRule = `hold your current ${money(currentPrice)}: it is already inside the band, above the floor and above the margin`; }
  opening = Math.max(opening, minPrice);   // never open inside the safety margin

  const belowBand = opening < band[0];
  const aboveBand = opening > band[1];
  if (belowBand) notes.push(`${money(opening)} is below the band p25 ${money(band[0])}: either the SKU is genuinely cheaper (differentiate) or the cost inputs need a look.`);
  if (aboveBand) notes.push(`${money(opening)} is above the band p75 ${money(band[1])}: premium play, expect lower volume (velocity is not the goal here).`);

  const menu = { easyReturns: opening, noReturn: opening - floor.gap, gap: floor.gap, gapEqualsReturnCost: floor.Cret };

  const hypothesis = {
    step: 5,
    title: 'Price hypothesis',
    why: 'A floor-checked opening; dual-price menu now, price tests after day 14.',
    output: `open at ${money(opening)} (floor ${money(floor.F)} + ${money(safetyMargin)} margin = ${money(minPrice)} min) with the no-return menu at ${money(menu.noReturn)}`,
    opening,
    openingRule,
    floor: floor.F,
    safetyMargin,
    minPrice,
    underMedian,
    aboveMedian,
    profitPerKeptOrder: r2(opening - floor.F),
    targetMargin: input.targetProfit != null ? r2(1 - floor.F / opening) : null,
    menu,
    belowBand, aboveBand,
  };

  /* Day-15 test plan (deck slide 3 box 1: "now, price tests after day 14") */
  const testPlan = {
    days1to14: 'Sanity check only: are buyers ordering (first kept orders) and are returns normal? No price change.',
    day15Onwards: {
      method: 'price menus rotate by day (time-block rotation), one menu live for every buyer per day',
      arms: floor.arms.map((p) => [p, p - floor.gap]),
      discoveryLadder: playKey === 'priceDiscovery' ? discoveryLadder : null,
      rotation: playKey === 'priceDiscovery'
        ? `alternate days: ${money(opening)} vs ${discoveryLadder.map(money).join(' / ')}`
        : 'one menu per day, all buyers see the same menu that day',
      filtered: `arms below F ${money(floor.F)} never enter the draw`,
      learning: 'one Thompson draw per day; reward = profit per impression',
    },
    firstDecisionPoint: 'day 14: conversion vs category median, kept rate vs the floor assumption',
  };

  const playbook = [
    { day: 'Day 0', action: `Open at ${money(opening)} easy-returns / ${money(menu.noReturn)} no-return`, source: 'this plan' },
    { day: 'Day 0-14', action: 'Sanity check: first kept orders, returns normal, no price change', source: 'deck slide 3 box 1' },
    { day: 'Day 14', action: 'If views are low: fix title/attributes/photo first (Diagnose), not price', source: 'deck slide 5' },
    { day: 'Day 15+', action: `Price menus rotate by day (${floor.arms.map((p) => money(p)).join(' / ')})`, source: 'deck slide 7 box 4' },
    { day: 'Day 30', action: 'Manual -> Co-Pilot unlock after 30 orders', source: 'deck slide 6 box 4' },
    { day: 'Day 38+', action: 'Growth step +3-5% when CVR holds 2 weeks', source: 'deck slide 4 box 3' },
  ];

  return {
    category: input.category,
    categoryName: cat.name,
    steps: [priorBand, comparableStep, featureStep, riskStep, play, hypothesis],
    band,
    median,
    play: { key: playKey, ...LAUNCH_MATRIX[playKey] },
    floor: {
      F: floor.F, B: floor.B, k: floor.k,
      breakdown: { cs: floor.cs, pack: floor.pack, fwd: floor.fwd, Cret: floor.Cret, Crto: floor.Crto, other: floor.other },
    },
    hypothesis: hypothesis.output,
    menu,
    testPlan,
    playbook,
    notes,
    confidence: 'Low at day 0 (no own history); rises with the first 1,000 views and the first price test.',
    why: [
      'Every input already exists on day 0: cost from the upload form, band from the catalogue, risk from pincode history.',
      'The opening price is checked against the return-adjusted floor before it is proposed, so day-1 pricing cannot lose money silently.',
      'Price sensitivity is learned across similar products (pooled) until this listing has sold at two or more prices.',
    ],
  };
}

/** The deck's own worked examples (slide 3 box 4). */
export function deckExamples() {
  return {
    bangaloreKurti: launchPlan({
      category: 'ethnic', skuKey: 'kurti', sellerCost: 180, targetProfit: 60,
      features: { fragile: false, weightKg: 0.5, sizeRisk: 0.6 },
      comparables: { count: 24, median: 379, p25: 299, p75: 599 },
      stock: { days: 45, units: 40 }, pincodeCluster: 'tier2-cod',
    }),
    jaipurHandblock: {
      note: 'deck: F = ₹430 (assumed) -> band ₹499-599 -> hold ₹549, no discount',
      plan: launchPlan({
        category: 'ethnic', skuKey: 'kurti', sellerCost: 300, targetProfit: 100,

        features: { fragile: false, weightKg: 0.5, sizeRisk: 0.4, handmade: true },
        comparables: { count: 3, median: 540, p25: 499, p75: 599 },
        stock: { days: 60, units: 30 }, pincodeCluster: 'metro-prepaid',
      }),
    },
    rajkotLunchbox: {
      note: 'deck: F ₹346 -> median ₹469 -> ₹449 today (already inside the band, so hold); from day 15 price discovery ₹469 / ₹479 on alternate days',
      plan: launchPlan({
        category: 'kitchen', skuKey: 'lunch', sellerCost: 210, targetProfit: 63, currentPrice: 449,
        features: { fragile: false, weightKg: 1 },
        comparables: { count: 6, median: 469, p25: 379, p75: 499 },
        stock: { days: 25, units: 300 }, pincodeCluster: 'tier3-cod',
      }),
    },
  };
}

function nearestSku(category) {
  const found = Object.values(SKUS).find((s) => s.category === category);
  return found ? found.key : 'kurti';
}
