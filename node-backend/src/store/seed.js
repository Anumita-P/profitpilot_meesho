/**
 * Seed data for the prototype.
 *
 * It mirrors the demo seller in the deck front-end: Ramesh, a new-to-online
 * seller in Surat with five listings, the same SKU library, the same live
 * prices and the same weekly signals the UI shows. Everything is illustrative.
 */

import { SKUS } from '../config/deck.js';

export const SELLER_ID = 'S-ramesh';
export const LISTING_PREFIX = 'L';

/** Signals that back the demo stories in the deck (per listing, weekly). */
const SIGNALS = {
  kurti: {
    stage: 'growth', ageDays: 36, views: 6200, viewsMedian: 4000,
    ctr: 4.1, ctrMedian: 4.0, ctrZ: 0.3,
    cvr: 13, cvrMedian: 12, cvrZ: 0.5, cvrHoldWeeks: 2,
    doi: 35, sellThroughPct: 52, stockAgeDays: 38, deliveryDays: 4.2, deliveryP75: 5,
    rivalGapPct: 2, keptUnitTrendPct: 21, keptRatePct: 79, codShare: 0.5,
    returnsPct: 12, categoryReturnsPct: 18, rtoPct: 8, categoryRtoPct: 11,
    dsm: 36, impressionsSinceMove: 6200,
  },
  lunch: {
    stage: 'maturity', ageDays: 140, views: 4100, viewsMedian: 4000,
    ctr: 3.9, ctrMedian: 4.0, ctrZ: -0.3,
    cvr: 11, cvrMedian: 11, cvrZ: 0, cvrHoldWeeks: 4,
    doi: 8, sellThroughPct: 68, stockAgeDays: 45, deliveryDays: 5.5, deliveryP75: 5,
    rivalGapPct: 0, keptUnitTrendPct: 3, keptRatePct: 85, codShare: 0.6,
    returnsPct: 5, categoryReturnsPct: 9, rtoPct: 7, categoryRtoPct: 11,
    dsm: 60, impressionsSinceMove: 4100,
  },
  serum: {
    stage: 'maturity', ageDays: 110, views: 5000, viewsMedian: 4000,
    ctr: 2.5, ctrMedian: 4.0, ctrZ: -1.9,
    cvr: 12, cvrMedian: 12, cvrZ: -0.2, cvrHoldWeeks: 2,
    doi: 40, sellThroughPct: 47, stockAgeDays: 55, deliveryDays: 4.0, deliveryP75: 5,
    rivalGapPct: -12, keptUnitTrendPct: 2, keptRatePct: 86, codShare: 0.45,
    returnsPct: 4, categoryReturnsPct: 8, rtoPct: 9, categoryRtoPct: 11,
    dsm: 52, impressionsSinceMove: 5000,
  },
  romper: {
    stage: 'growth', ageDays: 45, views: 2600, viewsMedian: 3000,
    ctr: 4.2, ctrMedian: 4.1, ctrZ: 0.2,
    cvr: 14, cvrMedian: 13, cvrZ: 0.6, cvrHoldWeeks: 2,
    doi: 32, sellThroughPct: 55, stockAgeDays: 42, deliveryDays: 4.4, deliveryP75: 5,
    rivalGapPct: 1, keptUnitTrendPct: 23, keptRatePct: 81, codShare: 0.55,
    returnsPct: 10, categoryReturnsPct: 14, rtoPct: 8, categoryRtoPct: 11,
    dsm: 45, impressionsSinceMove: 2600,
  },
  vase: {
    stage: 'decline', ageDays: 200, views: 1400, viewsMedian: 2200,
    ctr: 3.0, ctrMedian: 3.6, ctrZ: -1.2,
    cvr: 9, cvrMedian: 11, cvrZ: -1.7, cvrHoldWeeks: 3,
    doi: 73, sellThroughPct: 31, stockAgeDays: 210, deliveryDays: 6.1, deliveryP75: 5,
    rivalGapPct: 0, keptUnitTrendPct: -22, keptRatePct: 81, codShare: 0.5,
    returnsPct: 22, categoryReturnsPct: 11, rtoPct: 9, categoryRtoPct: 11,
    dsm: 40, impressionsSinceMove: 1400,
  },
};

export function seedDatabase() {
  const sellers = {
    [SELLER_ID]: {
      id: SELLER_ID,
      name: 'Ramesh',
      city: 'Surat',
      state: 'Gujarat',
      cluster: 'tier-2',
      joinedDaysAgo: 41,
      language: 'hi',
      control: { kurti: 'cp', lunch: 'cp', serum: 'cp', romper: 'man', vase: 'cp' },
      wins: 1,
      ordersLifetime: 48,
      weeksOnAutopilot: 0,
      consent: { belowFloor: false, programmes: {} },
      holdout: false,
      pilot: { city: 'surat', arm: 'treated', enrolledWeek: 0 },
    },
    /**
     * A second demo seller who owns NO listings. She exists so the access rules
     * have something to refuse: a session scoped to Meera asking for Ramesh's
     * listing must be a 403 that is audited, not an empty page. She is also the
     * pilot's holdout arm, which is why her record carries holdout: true.
     */
    'S-meera': {
      id: 'S-meera',
      name: 'Meera',
      city: 'Rajkot',
      state: 'Gujarat',
      cluster: 'tier-3',
      joinedDaysAgo: 12,
      language: 'gu',
      control: {},
      wins: 0,
      ordersLifetime: 6,
      weeksOnAutopilot: 0,
      consent: { belowFloor: false, programmes: {} },
      holdout: true,
      pilot: { city: 'rajkot', arm: 'holdout', enrolledWeek: 0 },
    },
  };

  const listings = {};
  Object.values(SKUS).forEach((sku) => {
    const sig = SIGNALS[sku.key];
    const id = `${LISTING_PREFIX}-${sku.key}`;
    const intended = sku.price;
    const live = sku.live;
    listings[id] = {
      id,
      sellerId: SELLER_ID,
      skuKey: sku.key,
      // day-0 hypothesis: the seller's offline price; live: where it trades today
      offlinePrice: intended,
      price: live,
      mode: 'growth',
      control: 'cp',
      consent: false,
      language: 'hi',
      ageDays: sig.ageDays,
      daysSinceMove: sig.dsm ?? 10,
      movesThisMonth: 0,
      costOverrides: {},
      costGuessBuffer: 15, // the seller's flat buffer guess (deck slide 2 box 6)
      approvedPricesSeen: [intended, live],
      // The history is the source of truth for the cooldown / moves-per-month
      // counters, so its timestamps must agree with `daysSinceMove`: the live
      // price was set `dsm` days ago, and the original hypothesis is older.
      priceHistory: [
        { ts: daysAgo(Math.max(sig.ageDays, (sig.dsm ?? 10) + 1)), price: intended, reason: 'first price hypothesis (day 0)' },
        ...(live !== intended ? [{ ts: daysAgo(sig.dsm ?? 10), price: live, reason: 'start price F + T (dual-price menu)' }] : []),
      ],
      signals: {
        ...sig,
        q0: sku.ordersAtLive,
        clicks: Math.round(sig.views * sig.ctr / 100),
      },
      stock: {
        units: sku.key === 'vase' ? 400 : sku.key === 'lunch' ? 96 : sku.key === 'kurti' ? 800 : 300,
        dailyUnits: sku.key === 'vase' ? 5.5 : sku.key === 'lunch' ? 12 : sku.ordersAtLive,
        leadTimeDays: 7,
      },
      reviews: {
        count: sku.key === 'kurti' ? 34 : sku.key === 'serum' ? 61 : 12,
        rating: sku.key === 'kurti' ? 4.2 : sku.key === 'serum' ? 4.0 : 4.3,
        negatives: sku.key === 'vase' ? [{ reason: 'size', share: 0.54 }, { reason: 'damage', share: 0.18 }, { reason: 'quality', share: 0.12 }] : [],
      },
      marketing: { adsPerKeptOrder: 12, promos: false },
      optIn: { rop: false, pool: false, weightAudit: false, packaging: false, credit: false, cod: false },
      createdAt: daysAgo(sig.ageDays),
    };
  });

  return {
    version: 3,
    createdAt: new Date().toISOString(),
    seed: 'deck-v1.0',
    sellers,
    listings,
    decisions: [],
    bandit: {},
    counters: { decisions: 0, moves: 0 },
    events: [],
  };
}

function daysAgo(n) {
  return new Date(Date.now() - n * 86400000).toISOString();
}
