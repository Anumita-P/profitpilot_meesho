/**
 * The Coach (deck slide 6 box 5/6/7, slide 10 box 4) plus service endpoints.
 * Grounded answers only: every reply carries the engine numbers and its source,
 * and nothing here can change a price - that needs a tap on a card.
 */

import { GUARDRAILS } from '../config/deck.js';
import { answer, intents, routeIntent } from '../engine/coach.js';
import { diagnose, normaliseSignals } from '../engine/diagnose.js';
import { hydrate, listing, hydratedListings, logEvent } from '../store/db.js';
import { ok, fail } from '../http/respond.js';

export function register(router) {
  router.post('/api/coach/ask', (ctx) => {
    try {
      const b = ctx.body || {};
      const question = String(b.question || '').trim();
      if (!question && !b.intent) return fail(ctx.res, 400, 'question (or intent) is required');
      const l = hydrate(listing(b.listing || 'L-kurti'));
      const intent = b.intent || routeIntent(question);
      const res = answer({
        listing: l,
        mode: b.mode || l.mode,
        question,
        intent,
        lang: b.lang || l.language || 'en',
        signals: b.signals ? normaliseSignals({ ...l.signals, ...b.signals }) : l.signals,
      });
      logEvent('coach.asked', { listingId: l.id, intent, lang: res.lang, matched: !!intent });
      return ok(ctx.res, {
        ...res,
        question,
        matchedIntent: intent,
        rules: [
          'I never change a price, a stock order or a mode: only your tap does.',
          'Every number comes from a ProfitPilot engine; the source is shown.',
          'If the data is thin I say so (confidence Low).',
          'I never show another seller\'s details.',
          'Money actions are tap-only, never voice.',
          'Expected means expected: no guarantees.',
        ],
      });
    } catch (e) { return fail(ctx.res, e.status || 500, e.message); }
  }, { summary: 'Ask the coach in English or Hindi - grounded answers with source, confidence and a Why payload' });

  router.get('/api/coach/intents', () => ({ intents: intents(), examples: {
    orders: 'My orders dropped / Orders kam ho gaye',
    returns: 'Why are returns coming? / Returns kyun aa rahe hain?',
    floor: 'How is my floor made?',
    raise: 'Can I change my price?',
    stuck: 'My stock is stuck / Stock atak gaya hai',
    cut: 'I still want to cut price / Phir bhi price kam karna hai',
    reorder: 'When to reorder stock?',
    ads: 'Should I run ads?',
    modes: 'What are my modes?',
    pilot: 'What is the pilot?',
    limits: 'What are the limits of 1.0?',
  } }), { summary: 'Intents the coach understands, with a sample phrasing each' });

  router.get('/api/coach/sellers-talk', (ctx) => {
    const l = hydrate(listing(ctx.query.listing || 'L-kurti'));
    const d = diagnose(l, l.signals);
    return ok(ctx.res, {
      listingId: l.id,
      topSellerQuestions: [
        'How much should I sell it for?',
        'Will it actually make a profit?',
        'Others already sell it. What now?',
        'Why are buyers not ordering?',
        'Why do buyers return it?',
        'Where is the demand?',
        'Stock is stuck. Discount or wait?',
        'Should I pay for ads?',
      ],
      currentAnswers: {
        'How much should I sell it for?': `Dual price ${l.price} easy-returns / ${l.price - l.floor.gap} no-return; floor ${l.floor.F}.`,
        'Will it actually make a profit?': `${(l.price - l.floor.F).toFixed(0)} per kept order at ${l.price}, after returns and RTO.`,
        'Why are buyers not ordering?': d.biggestLoss ? `${d.biggestLoss.label}: about ₹${Math.round(d.biggestLoss.impactPerWeek)}/week at risk. ${d.biggestLoss.fix}` : 'All checks clean: hold and scale.',
        'Why do buyers return it?': `${l.signals.returnsPct}% returns vs ${l.signals.categoryReturnsPct}% category; size is the biggest seller-controllable reason.`,
        'Stock is stuck. Discount or wait?': `${l.signals.doi} days of stock: bundle first, then a markdown ladder in <= 8% steps.`,
        'Should I pay for ads?': `Ads cost ₹${l.floor.otherLines.ads} per kept order and are already in the floor; only spend more if ad ₹ per kept order stays below the margin.`,
      },
      coachRules: 'Tap-only money actions; sources shown; no other seller\'s data.',
    });
  }, { summary: 'Maps the eight seller questions from deck slide 2 to live engine answers' });

  router.get('/api/guardrails', () => ({
    guardrails: GUARDRAILS,
    preflightChecks: [
      'Floor: never below F silently',
      'Step <= 8% per move',
      'Views >= 1,000: sanity check',
      'Cooldown 7 days per SKU',
      '<= 2 moves a month per SKU',
      'Auto-revert: judge day 14, confirm day 28',
    ],
    engineLabExtras: ['Range <= 15% outside prices already seen', 'Cost sanity', 'Dispersion: no herding', 'Fairness: one price per day for every buyer'],
  }), { summary: 'The profit-protection layer: hard floor, panic brake, loss warning, auto-revert' });

  router.get('/api/economy', () => {
    const all = hydratedListings();
    const totals = all.reduce((acc, l) => {
      acc.listings += 1;
      acc.floorSum += l.floor.F;
      acc.bufferSum += l.floor.B;
      acc.belowFloor += l.price < l.floor.F ? 1 : 0;
      return acc;
    }, { listings: 0, floorSum: 0, bufferSum: 0, belowFloor: 0 });
    return ({
      deckEconomics: {
        nmvOfGmv: '58.8% of Meesho GMV survives as NMV (delivered and not returned) [Choice Broking, May 2026 (FY26)]',
        annualTransactingSellers: '7.06 lakh annual transacting sellers [Axis Capital IPO note]',
        returnsOnlineApparel: '25-40% of clothes bought online in India are returned [Rest of World]',
        tier2Share: '~80% of Indian online shoppers live in Tier-2 cities and beyond [Meesho report / YourStory]',
        dualPricing: '>30% of delivered orders pick no-return, ~10% fewer returns [Pricing]',
        codFailure: 'COD orders fail 20.9% vs prepaid 5.8% [Unicommerce]',
      },
      engineTotals: {
        ...totals,
        averageBufferPerKeptOrder: Math.round(totals.bufferSum / (totals.listings || 1)),
        sellerGuessBuffer: 15,
        note: 'The flat ₹15 guess under-prices every kept order by roughly the difference between the two lines above.',
      },
    });
  }, { summary: 'The economics behind the problem, with the deck\'s sources' });
}
