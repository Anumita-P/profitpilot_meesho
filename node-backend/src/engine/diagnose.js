/**
 * LAYER: DECISION - "diagnose before you discount".
 * Deck slide 5: an 8-node scan that runs weekly; a card shows only if a signal
 * holds 2 weeks. Price is checked LAST. If two branches fire, fix the one with
 * the largest ₹ loss first (M15).
 *
 * The seller never sees this tree: they see ✔ Yes / ✘ No answers, plus the
 * Panic Brake verdict (slide 5 box 3).
 */

import { CATEGORIES, DIAGNOSE_NODES, ENGINE } from '../config/deck.js';
import { computeFloor } from './floor.js';
import { ordersPerDay } from './demand.js';

const r2 = (x) => Math.round(x * 100) / 100;
const money = (v) => `${v < 0 ? '-' : ''}₹${Math.abs(Math.round(v)).toLocaleString('en-IN')}`;

/**
 * @param {object} listing
 * @param {object} signals - weekly signals for this listing
 *   { views, viewsMedian, ctr, ctrZ, clicks, cvr, cvrZ, returnsPct, rtoPct,
 *     categoryReturnsPct, categoryRtoPct, doi, sellThroughPct, stockAgeDays,
 *     deliveryDays, deliveryP75, price, band:[p25,p75], weeksHolding }
 */
export function diagnose(listing, signals) {
  const sku = listing.sku;
  const f = computeFloor(sku.key, listing.costOverrides || {});
  const s = { ...listing.signals, ...signals };
  const p = s.price ?? listing.price;
  const orders = ordersPerDay(listing, p);
  const margin = p - f.F;
  const weeksHolding = s.weeksHolding ?? 2;

  const branches = {};

  /* 1. VISIBILITY: impressions < 50% of the median for 7 days */
  {
    const fired = weeksHolding >= 2 && s.views < 0.5 * s.viewsMedian;
    const deficit = Math.max(0, 1 - s.views / s.viewsMedian);
    branches.views = {
      key: 'views', label: 'Views', fired,
      evidence: `${s.views.toLocaleString('en-IN')} impressions vs ${s.viewsMedian.toLocaleString('en-IN')} median (${Math.round(s.views / s.viewsMedian * 100)}% of median; trigger < 50% for 7 days)`,
      impactPerWeek: r2(deficit * orders * 7 * margin),
      owner: 'seller',
      fix: 'Better title, attributes, category mapping; ads or discount only after that',
      impactNote: 'lost profit from the missing impressions',
    };
  }

  /* 2. LISTING: CTR z < -1.5 */
  {
    const fired = weeksHolding >= 2 && (s.ctrZ ?? 0) < -1.5;
    branches.clicks = {
      key: 'clicks', label: 'Clicks (CTR)', fired,
      evidence: `CTR ${s.ctr}% vs ${s.ctrMedian ?? 4.0}% benchmark (z = ${s.ctrZ}); trigger z < -1.5 for 2 weeks`,
      impactPerWeek: fired ? r2(orders * (1 - s.ctr / (s.ctrMedian ?? 4.0)) * 7 * margin) : 0,
      owner: 'seller',
      fix: 'New main image, lifestyle photo, clearer price badge',
      impactNote: 'lost profit from the clicks that did not happen',
    };
  }

  /* 3. PRICE-VALUE / TRUST: CVR z < -1.5 with >= 300 clicks */
  {
    const fired = weeksHolding >= 2 && (s.cvrZ ?? 0) < -1.5 && (s.clicks ?? 0) >= 300;
    const insideBand = p >= s.band[0] && p <= s.band[1];
    branches.conv = {
      key: 'conv', label: 'Conversion', fired,
      evidence: `CVR ${s.cvr}% vs ${s.cvrMedian}% median (z = ${s.cvrZ}; ${s.clicks} clicks, needs >= 300)`,
      impactPerWeek: fired ? r2(orders * (1 - s.cvr / s.cvrMedian) * 7 * margin) : 0,
      owner: 'seller',
      priceInsideBand: insideBand,
      priceValue: !insideBand && p > s.band[1],
      fix: insideBand
        ? 'Price is inside the band -> page & trust fix: reviews, size chart, delivery promise. NOT a price cut.'
        : p > s.band[1]
          ? 'Price is above the band p75: bounded test (<= 8%) or dual price'
          : 'Price is below the band p25: raise into the band',
      impactNote: 'lost profit from the conversion gap',
      note: 'this is the only branch that can authorise a price move (Panic Brake)',
    };
  }

  /* 4. RETURNS: returns > category + 5 pp */
  {
    const cat = CATEGORIES[f.category];
    const limit = s.categoryReturnsPct + 5;
    const fired = s.returnsPct > limit;
    const excessPp = Math.max(0, s.returnsPct - s.categoryReturnsPct);
    branches.ret = {
      key: 'ret', label: 'Returns', fired,
      evidence: `returns ${s.returnsPct}% vs category ${s.categoryReturnsPct}% + 5 pp (${limit}%)`,
      // every extra percentage point of returns costs one reverse-logistics unit cost
      impactPerWeek: fired ? r2((excessPp / 100) * orders * 7 * cat.unitRet) : 0,
      owner: 'seller',
      fix: 'Size chart, quality check, true photos (size is ~4 pp of 18 pp returns); platform side: prepaid nudge, damage audit',
      impactNote: `extra return cost per week at ₹${cat.unitRet} per returned unit`,
    };
  }

  /* 5. RTO: RTO > category + 5 pp */
  {
    const cat = CATEGORIES[f.category];
    const limit = s.categoryRtoPct + 5;
    const fired = s.rtoPct > limit;
    const excessPp = Math.max(0, s.rtoPct - s.categoryRtoPct);
    branches.rto = {
      key: 'rto', label: 'RTO', fired,
      evidence: `RTO ${s.rtoPct}% vs category ${s.categoryRtoPct}% + 5 pp (${limit}%)`,
      impactPerWeek: fired ? r2((excessPp / 100) * orders * 7 * cat.unitRto) : 0,
      owner: 'platform',
      fix: 'COD confirmation, prepaid nudge for risky pincodes (2.0: COD risk score), Valmo routing',
      impactNote: 'COD orders fail 20.9% vs prepaid 5.8% [Unicommerce]',
    };
  }

  /* 6. STOCK: < 7 days (stock-out risk) or > 60 days (cash stuck) */
  {
    const tooLow = s.doi < 7;
    const tooHigh = s.doi > 60;
    branches.stock = {
      key: 'stock', label: 'Stock', fired: tooLow || tooHigh,
      evidence: `${s.doi} days of inventory (fires if < 7 or > 60); sell-through ${s.sellThroughPct ?? '—'}%`,
      impactPerWeek: tooHigh
        ? r2(f.F * orders * 7 * ENGINE.CARRY_COST_PER_MONTH / 4.33 * 0.15)
        : tooLow
          ? r2(orders * 7 * margin * 0.3)
          : 0,
      owner: 'seller',
      fix: tooHigh
        ? 'Free the cash: bundle with a fast mover, then a markdown ladder in <= 8% steps (never below F)'
        : tooLow
          ? 'Replenish first: ROP = demand during lead time + safety stock (2.0 reorder alert)'
          : 'No action; stock cover is inside 7-60 days',
      direction: tooHigh ? 'overstock' : tooLow ? 'understock' : 'healthy',
      impactNote: tooHigh ? 'capital tied up at ~2%/month' : tooLow ? 'stock-out profit at risk' : '',
    };
  }

  /* 7. DELIVERY: slower than the category p75 */
  {
    const fired = s.deliveryDays > s.deliveryP75;
    branches.del = {
      key: 'del', label: 'Delivery', fired,
      evidence: `${s.deliveryDays} days vs category p75 ${s.deliveryP75} days`,
      impactPerWeek: fired ? r2(orders * 7 * margin * 0.08) : 0,
      owner: 'platform',
      fix: 'Dispatch SLA, Valmo hub routing, regional pre-positioning (2.0, opt-in)',
      impactNote: 'slower delivery lifts refusal and return rates',
    };
  }

  /* 8. PRICE: band position - checked LAST on purpose */
  {
    const above = p > s.band[1];
    const below = p < s.band[0];
    const outside = above || below;
    const elasticity = 3; // |b| = 3 category prior (deck slide 7 box 4)
    let impact = 0;
    if (above) impact = r2(orders * (1 - Math.pow(s.band[1] / p, Math.abs(elasticity))) * 7 * margin);
    if (below) impact = r2((s.band[0] - p) * orders * f.k * 7);
    branches.price = {
      key: 'price', label: 'Price', fired: outside,
      evidence: `₹${p} vs the look-alike band ₹${s.band[0]}-${s.band[1]} (median ₹${s.band.length > 2 ? s.band[2] : sku.median}); checked last`,
      impactPerWeek: impact,
      owner: 'engine',
      fix: above
        ? 'Craft or differentiate, hold, or a bounded test inside the band; never a > 8% jump'
        : below
          ? 'Raise to the band p25 (bounded steps) - this is usually found money'
          : 'Inside the band: the price is not the problem',
      impactNote: above ? 'orders lost to cheaper look-alikes' : below ? 'profit left on the table' : '',
      checkedLast: true,
    };
  }

  /* Ranked by ₹ impact per week - "fix the largest ₹ loss first" (M15). */
  const fired = Object.values(branches).filter((b) => b.fired).sort((a, b) => b.impactPerWeek - a.impactPerWeek);
  const totalImpact = r2(fired.reduce((x, b) => x + Math.max(0, b.impactPerWeek), 0));
  const priceValueFired = branches.conv.fired && (branches.conv.priceValue || branches.price.fired);

  return {
    listingId: listing.id,
    sku: sku.key,
    price: p,
    floor: f.F,
    branches,
    firedCount: fired.length,
    firedOrder: fired.map((b) => ({ key: b.key, label: b.label, impactPerWeek: b.impactPerWeek, owner: b.owner })),
    biggestLoss: fired[0] ? { key: fired[0].key, label: fired[0].label, impactPerWeek: fired[0].impactPerWeek, fix: fired[0].fix } : null,
    totalImpactPerWeek: totalImpact,
    priceValueFired,
    healthy: fired.length === 0,
    verdict: fired.length === 0
      ? 'All five signal checks are clean: hold the price and scale.'
      : `${fired.length} of 8 checks fail. Fix ${fired[0].label} first (₹${Math.round(fired[0].impactPerWeek)}/week).`,
  };
}

/**
 * The seller-facing card for a proposed cut (deck slide 5 box 2/3).
 * Six ✔/✘ answers - the seller sees the answers, never the tree.
 */
export function sellerCard(ctx) {
  const { diagnosis, floor: f, from, to, signals } = ctx;
  const s = signals || {};
  const stepPct = (to - from) / from * 100;
  const returns = [
    {
      q: 'Did the price-value branch fire?',
      ok: !!diagnosis.priceValueFired,
      detail: diagnosis.priceValueFired ? 'yes' : 'no',
    },
    {
      q: '>= 1,000 impressions since the last move?',
      ok: (s.impressionsSinceMove ?? s.views ?? 0) >= 1000,
      detail: `${(s.impressionsSinceMove ?? s.views ?? 0).toLocaleString('en-IN')}`,
    },
    {
      q: '>= 7 days since the last move?',
      ok: (ctx.daysSinceMove ?? 0) >= 7,
      detail: `${ctx.daysSinceMove ?? 0} days`,
    },
    {
      q: 'New price >= return-adjusted floor?',
      ok: to >= f.F,
      detail: to >= f.F ? `₹${to} >= ₹${f.F}` : `₹${to} < ₹${f.F}`,
    },
    {
      q: 'Step <= 8% and <= 2 moves a month?',
      ok: Math.abs(stepPct) <= 8 && (ctx.movesThisMonth ?? 0) < 2,
      detail: `${stepPct.toFixed(0)}%`,
    },
    {
      q: 'Profit >= baseline after 14 days?',
      ok: null,
      detail: `${ctx.dayIndex ?? 7} days so far · auto-revert scheduled at day 14`,
    },
  ];
  const failed = returns.filter((r) => r.ok === false).length;
  const failures = returns.filter((r) => r.ok === false).map((r) => r.q);
  const blocked = failed > 0 && !ctx.consent;
  return {
    listingId: ctx.listingId,
    from, to,
    lossPerKeptOrder: Math.round(to - f.F),
    blocked,
    failedCount: failed,
    failures,
    checks: returns,
    lossWarning: to < f.F
      ? { price: to, perKeptOrder: Math.round(to - f.F), sellerLine: `₹${to} loses ₹${Math.abs(Math.round(to - f.F))} per kept order. Keep ₹${from} and let us find the real cause?` }
      : null,
    sellerLine: blocked
      ? (to < f.F
        ? `₹${to} loses ₹${Math.abs(Math.round(to - f.F))} per kept order. Keep ₹${from} and let us find the real cause?`
        : `This move breaks a guardrail (${failures.join('; ')}). Nothing was published.`)
      : 'All checks pass: this move goes to the seller as one Yes / No card.',
    engineLine: failed
      ? `${failed} of 6 checks fail -> cut blocked${to < f.F ? ', Loss Warning shown' : ''}; the tree finds the real cause first.`
      : 'All 6 checks pass -> one card, bounded by the 8% step and the floor.',
  };
}

/** Signals arriving from Meesho's own pipes (deck slide 7 box 1: DATA). */
export function normaliseSignals(raw = {}) {
  return {
    views: raw.views ?? 0,
    viewsMedian: raw.viewsMedian ?? 4000,
    ctr: raw.ctr ?? 4.0,
    ctrMedian: raw.ctrMedian ?? 4.0,
    ctrZ: raw.ctrZ ?? 0,
    clicks: raw.clicks ?? Math.round((raw.views ?? 0) * (raw.ctr ?? 4) / 100),
    cvr: raw.cvr ?? 12,
    cvrMedian: raw.cvrMedian ?? 12,
    cvrZ: raw.cvrZ ?? 0,
    returnsPct: raw.returnsPct ?? 0,
    categoryReturnsPct: raw.categoryReturnsPct ?? 18,
    rtoPct: raw.rtoPct ?? 0,
    categoryRtoPct: raw.categoryRtoPct ?? 11,
    doi: raw.doi ?? 30,
    sellThroughPct: raw.sellThroughPct ?? 45,
    stockAgeDays: raw.stockAgeDays ?? 40,
    deliveryDays: raw.deliveryDays ?? 4.5,
    deliveryP75: raw.deliveryP75 ?? 5,
    price: raw.price,
    band: raw.band,
    weeksHolding: raw.weeksHolding ?? 2,
    impressionsSinceMove: raw.impressionsSinceMove ?? raw.views ?? 0,
  };
}
