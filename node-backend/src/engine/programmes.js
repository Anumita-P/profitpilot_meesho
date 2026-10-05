/**
 * ProfitPilot 2.0 - programme routing and module catalogue (deck slide 10).
 * Programmes attach to products, so one seller can be in more than one.
 *
 * The router is deliberately rule-based and readable: the deck says 2.0 is
 * opt-in and that the engine routes on measured inputs, so this endpoint
 * returns the path that lit up, the KPI, and which 1.0 limit it fixes.
 */

import { PROGRAMMES, SKUS } from '../config/deck.js';
import { computeFloor } from './floor.js';
import { lifecycle, stageWindows } from './lifecycle.js';

const r2 = (x) => Math.round(x * 100) / 100;

/**
 * @param {object} input { skuKey, salesHistoryDays, artisanScore, lookalikes, doi, unitsOnHand, dailyUnits }
 */
export function routeProgramme(input) {
  const history = input.salesHistoryDays ?? 0;
  const artisan = input.artisanScore ?? 0.3;
  const look = input.lookalikes ?? 24;
  const doi = input.doi ?? 30;

  const n1 = history < 30;
  const n2 = !n1 && artisan >= 0.7;
  const n3 = !n1 && !n2 && doi > 60;
  const out = n1 ? 'STARTER_PACK'
    : n2 ? (look < 10 ? 'MAKER_PROGRAMME' : 'HUMAN_REVIEW')
      : n3 ? 'STOCK_RECOVERY' : 'FAST_MOVERS';

  const nodes = [
    { q: 'Sales history < 30 days?', yes: 'STARTER PACK', no: 'next', v: n1 ? 'yes' : 'no', d: `${history} days` },
    { q: 'Artisan score >= 0.7?', yes: 'few copies -> MAKER PROGRAMME, many -> HUMAN REVIEW', no: 'next', v: n1 ? null : n2 ? 'yes' : 'no', d: artisan.toFixed(2) },
    { q: 'Days of inventory > 60?', yes: 'STOCK RECOVERY', no: 'FAST MOVERS', v: n1 || n2 ? null : n3 ? 'yes' : 'no', d: `${doi} days` },
  ];

  const modules = {
    STARTER_PACK: {
      modules: ['Onboarding + catalogue template kit (template -> live in 2 days)', 'Category packaging kit', 'Dual-price guidance at upload', 'Starting price + margin-floor guidance'],
      trigger: 'no sales history yet',
      kpi: 'first 10 kept orders in 30 days, vs holdout',
      fixesLimits: [3, 7],
    },
    FAST_MOVERS: {
      modules: ['Replenishment alerts (reorder point)', 'Pooled procurement suggestion', 'Meesho widens reach (seller approves)', 'Test +3-5% price steps when demand stays strong'],
      trigger: 'look-alikes high, demand stable',
      kpi: 'stock-outs -20 to -30%',
      fixesLimits: [4],
    },
    MAKER_PROGRAMME: {
      modules: ['"Handcrafted" badge and premium slot, after a craft / GI check', 'Storytelling templates', 'No discount-led positioning'],
      trigger: 'artisan score >= 0.7, few look-alikes',
      kpi: 'higher price realised vs commodity',
      fixesLimits: [8],
    },
    HUMAN_REVIEW: {
      modules: ['A person checks craft claims before any badge', 'Standard listing tools until then'],
      trigger: 'craft-like but many copies',
      kpi: 'protects the badge from abuse',
      fixesLimits: [8],
    },
    STOCK_RECOVERY: {
      modules: ['Bundles with fast movers', 'Regional redistribution / wider reach (seller approves)', 'Markdown steps >= full cost F'],
      trigger: 'days of inventory > 60',
      kpi: 'value recovered vs no action',
      fixesLimits: [4, 7],
    },
  }[out];

  return {
    programme: out,
    name: PROGRAMMES[out.toLowerCase().replace(/_([a-z])/g, (m, c) => c.toUpperCase())]?.name || out,
    inputs: { salesHistoryDays: history, artisanScore: artisan, lookalikes: look, doi },
    path: nodes,
    outcome: out,
    ...modules,
    confidence: 'Medium',
    confidenceWhy: 'Rule-based routing on measured inputs; re-evaluated weekly.',
    sellerControl: 'The seller can opt out of any programme; nothing in 2.0 runs without opt-in.',
  };
}

/** Reorder point (deck slide 10 box 2): ROP = daily demand x lead time + safety stock. */
export function reorderPoint({ dailyUnits, leadTimeDays, sd = 4.1, serviceLevel = 1.65, orderCoverDays = 14 }) {
  const demandInLeadTime = dailyUnits * leadTimeDays;
  const safetyStock = Math.round(serviceLevel * sd * Math.sqrt(leadTimeDays));
  const rop = Math.round(demandInLeadTime + safetyStock);
  const orderQty = Math.round(dailyUnits * orderCoverDays / 10) * 10;
  return {
    inputs: { dailyUnits, leadTimeDays, sd, serviceLevel, orderCoverDays },
    demandInLeadTime: Math.round(demandInLeadTime),
    safetyStock,
    reorderPoint: rop,
    formula: `ROP = ${dailyUnits} x ${leadTimeDays} + ${safetyStock} = ${rop} units`,
    orderQuantity: orderQty,
    cashRequired: orderQty * 210,
    pooledCash: orderQty * 188,
    poolingSaving: orderQty * (210 - 188),
    kpi: 'stock-outs -20 to -30%',
  };
}

/** Pooled procurement (deck slide 10 box 2: 5 sellers meet a 300-unit MOQ). */
export function pooledProcurement({ sellers = 5, moq = 300, soloPrice = 210, pooledPrice = 188 }) {
  const forecast = Math.round(moq / sellers);
  return {
    sellers, moq, soloPrice, pooledPrice,
    forecastPerSeller: forecast,
    soloTotal: forecast * soloPrice,
    pooledTotal: forecast * pooledPrice,
    savingPerSeller: forecast * (soloPrice - pooledPrice),
    floorEffect: `floor falls by about ₹${Math.round((soloPrice - pooledPrice) * 0.85)} per kept order once the bulk quote lands`,
    note: 'ops signs the order only once the sellers\' commitments are firm.',
  };
}

/** Packaging + weight audit (deck slide 10 box 2, Valmo scan station). */
export function packagingAudit({ declaredKg, actualKg, declaredCm, actualCm, fragile }) {
  const slabMismatch = Math.abs(actualKg - declaredKg) > 0.1 || Math.abs(actualCm - declaredCm) > 2;
  const reCharge = slabMismatch ? Math.round(Math.abs(actualKg - declaredKg) * 45) : 0;
  return {
    slabMismatch,
    rechargePerParcel: reCharge,
    action: slabMismatch
      ? `Declared ${declaredKg} kg / ${declaredCm} cm vs actual ${actualKg} kg / ${actualCm} cm: re-charge the slab and nudge the right-size kit.`
      : 'Declared size and weight match the scan.',
    kit: fragile ? 'fragile kit: damage 6% -> 3% (kit trial), packaging cost inside F' : 'standard kit',
    credit: 'slab re-charge is credited back to the seller when the declaration is corrected.',
  };
}

/** The 1.0 limits each 2.0 module fixes (deck slide 9 box 1 -> slide 10). */
export function moduleCatalogue() {
  return [
    { key: 'packaging-weight-audit', name: 'Packaging + weight audit', who: 'AUTO + AI', example: 'Ceramic vase ₹499', how: 'Scan station at the Valmo hub checks size & weight vs declared; mismatch -> slab re-charge + kit nudge', impact: 'Damage 6% -> 3% with the fragile kit', fixes: [4, 7] },
    { key: 'pooled-procurement', name: 'Pooled procurement', who: 'AI + OPS', example: 'Steel lunch box ₹449', how: 'Engine pools 5 sellers\' forecast to meet a 300-unit MOQ; ops signs only once commitments are firm', impact: '₹210 -> ₹188 bulk quote; floor ₹346 -> about ₹324', fixes: [4, 7] },
    { key: 'valmo-fulfilment', name: 'Optional Valmo fulfilment pilot', who: 'AI + AUTO', example: 'Baby romper set ₹349', how: 'Fast movers only, opt-in: regional forecast pre-positions stock with Valmo partners', impact: 'Delivery 5.2 -> 3.1 days; RTO 8% -> 5% (fewer refusals)', fixes: [1, 7] },
    { key: 'cod-risk-score', name: 'COD risk score', who: 'AI + AUTO', example: 'All SKUs', how: 'High-risk pincode orders get a prepaid offer or a confirmation call before dispatch', impact: 'COD orders fail 20.9% vs prepaid 5.8% [Unicommerce]', fixes: [7] },
    { key: 'inventory-credit', name: 'Inventory credit', who: 'PARTNER', example: 'Vitamin-C serum ₹249', how: 'Credit line sized from sales & return risk; repaid through the lender\'s auto-debit', impact: '₹34k line -> about 500 units; no stock-outs at peak', fixes: [3, 4] },
    { key: 'fraud-shield', name: 'Fraud & abuse shield', who: 'AI + AUTO', example: 'Kurti (wardrobing)', how: 'Abuse score; photo-on-return for high-risk claims', impact: 'Wardrobing and false "not received" claims priced out', fixes: [8] },
    { key: 'product-customer-fit', name: 'Product-customer fit', who: 'AI', example: 'Region-specific price display', how: 'Show the no-return price first in COD-heavy clusters (seller approves)', impact: 'Keep-probability 0.71 -> 0.86 in cluster A style comparisons', fixes: [1] },
    { key: 'review-intelligence', name: 'Review intelligence', who: 'AI', example: 'Kurti reviews', how: 'Reviews -> product and listing fixes ("size runs small": 38% of negatives)', impact: '-1 to -2 pp returns (about -₹5 to -₹10 on F)', fixes: [8] },
    { key: 'return-root-cause', name: 'Return root-cause engine', who: 'AI', example: 'Returns 22% split', how: 'Why it failed -> one action at a time (size 54%, damage 18%, quality 12%)', impact: '22% -> about 16% returns; F -₹19', fixes: [8] },
  ];
}

export { lifecycle, stageWindows, computeFloor, SKUS, r2 };
