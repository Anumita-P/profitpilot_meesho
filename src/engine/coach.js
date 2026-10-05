/**
 * DELIVERABLE 3 - "how the seller hears from us" (deck slide 6 box 5/6/7,
 * slide 10 box 4). The Coach explains engine numbers and invents nothing:
 *
 *   - every answer carries its source and the engine numbers behind it
 *   - if the data is thin the answer says so (confidence Low)
 *   - it never shows another seller's details
 *   - money actions are tap-only: the Coach never changes a price, stock order or mode
 *
 * The intent router understands English and Hindi/Hinglish, because the deck's
 * explainer is in Hindi ("Returns kyun aa rahe hain?").
 */

import { CATEGORIES, ENGINE, MODES, SKUS } from '../config/deck.js';
import { computeFloor, floorWhy } from './floor.js';
import { ordersPerDay, profitPerDay, riskMixAtPrice } from './demand.js';
import { recommend } from './recommend.js';
import { diagnose } from './diagnose.js';
import { lifecycle } from './lifecycle.js';
import { reorderPoint } from './programmes.js';

const money = (v) => `${v < 0 ? '-' : ''}₹${Math.abs(Math.round(v)).toLocaleString('en-IN')}`;
const r2 = (x) => Math.round(x * 100) / 100;

const INTENTS = [
  { key: 'cut',       re: /(phir bhi|still|anyway).*(cut|kam)|cut.*(price|kar)|price kam|kya kam/i },
  { key: 'orders',    re: /orders? (kam|drop)|dropped|orders kam|why.*(orders|bik)/i },
  { key: 'nosell',    re: /(nahi bik|not selling|isn'?t selling|kuch nahi bik)/i },
  { key: 'floor',     re: /floor|laagat|lagat|cost kaise/i },
  { key: 'profit',    re: /profit|kamai|margin kitna|how much/i },
  { key: 'returns',   re: /return|wapas|vapas/i },
  { key: 'rto',       re: /\brto\b|refus|wapas nahi aaya|bina deliver/i },
  { key: 'comp',      re: /compet|rival|muqabl|market|sasta/i },
  { key: 'raise',     re: /(badha|raise|increase|change|badal).*(price|daam|rate)?|price.*(badh|badal)/i },
  { key: 'reorder',   re: /reorder|stock kab|kitna stock|inventory/i },
  { key: 'ads',       re: /\bads?\b|adverti|promo/i },
  { key: 'stuck',     re: /atak|stuck|dead stock|slow mov/i },
  { key: 'modes',     re: /mode|cash|clear|margin mode|growth mode|goal/i },
  { key: 'pilot',     re: /pilot|holdout|lift|impact|sample/i },
  { key: 'limits',    re: /limit|risk|drawback|kya nahi kar sakte|problem/i },
  { key: 'bands',     re: /band|p25|p75|median price/i },
];

export function routeIntent(question) {
  const q = String(question || '');
  for (const i of INTENTS) if (i.re.test(q)) return i.key;
  if (/कम|बिक|प्राइस|दाम/.test(q)) return 'orders';
  return null;
}

/**
 * @param {object} ctx { listing, mode, question, lang, signals }
 */
function answerInner(ctx) {
  const listing = ctx.listing;
  const mode = ctx.mode || listing.mode || 'growth';
  const lang = ctx.lang === 'hi' ? 'hi' : 'en';
  const intent = ctx.intent || routeIntent(ctx.question);
  const f = computeFloor(listing.sku.key, listing.costOverrides || {});
  const sku = listing.sku;
  const p = listing.price;
  const orders = ordersPerDay(listing, p);
  const perKept = p - f.F;

  const T = (en, hi) => (lang === 'hi' ? hi : en);
  const base = {
    intent,
    lang,
    listingId: listing.id,
    sku: sku.key,
    engine: { price: p, floor: f.F, buffer: f.B, keptRate: r2(f.k), ordersPerDay: r2(orders), profitPerKeptOrder: r2(perKept) },
    suggestions: [],
    moneyActionsRequireTap: true,
    neverChangesAnythingItself: true,
  };

  if (!intent) {
    return {
      ...base,
      confidence: 'High',
      answer: T(
        'I can answer with the engine numbers behind your pricing: floor, profit, returns, competitors, stock, modes, drops in orders, ads, the pilot. Ask in English or Hindi.',
        'Main aapke pricing ke engine numbers samjha sakta hoon: floor, kamai, returns, competitors, stock, modes, orders kam, ads, pilot. English ya Hindi mein poochhiye.',
      ),
      source: 'ProfitPilot Coach · intent not matched, nothing invented',
      suggestions: ['How is my floor made?', 'Returns kyun aa rahe hain?', 'My orders dropped', 'Can I raise my price?', 'When to reorder stock?'],
    };
  }

  switch (intent) {
    case 'orders':
    case 'nosell': {
      const d = diagnose(listing, ctx.signals || {});
      const top = d.biggestLoss;
      return {
        ...base,
        confidence: d.firedCount ? 'Medium' : 'High',
        answer: top
          ? T(
            `Let's check before touching the price. ${d.firedCount} of 8 signals fail; the largest ₹ loss is ${top.label} (about ₹${Math.round(top.impactPerWeek)}/week). ${top.fix}.`,
            `Price se pehle check karte hain. 8 mein se ${d.firedCount} signal fail hue; sabse bada nuksaan ${top.label} mein hai (lagbhag ₹${Math.round(top.impactPerWeek)}/hafte). ${top.fix}.`,
          )
          : T(
            `All five signal checks are clean, so a price cut would not fix anything: views, clicks, conversion, returns and stock are fine. Hold ${money(p)} and scale.`,
            `Saare signal theek hain - price kam karne se kuch fix nahi hoga. ${money(p)} rakho aur scale karo.`,
          ),
        source: `Diagnostic tree · last 7 days · ${d.firedCount}/8 checks fired`,
        why: { what: 'Diagnose before discount', why: d.firedOrder.map((b) => `${b.label}: ₹${Math.round(b.impactPerWeek)}/week at risk`), effect: `₹${Math.round(d.totalImpactPerWeek)}/week total at risk`, confidence: 'Medium', undo: 'Nothing changes from a diagnosis.' },
        suggestions: ['Why are returns coming?', 'What are competitors doing?', 'Should I run ads?'],
      };
    }

    case 'floor': {
      const w = floorWhy(sku.key, listing.costOverrides || {});
      return {
        ...base,
        confidence: 'High',
        answer: T(
          `F = ${money(f.F)}: sourcing ${money(f.cs)} + packaging ${money(f.pack)} + delivery ${money(f.fwd)} + return ${money(f.Cret)} + RTO ${money(f.Crto)} + other ${money(f.other)}. Return + RTO together (B) = ${money(f.B)} per kept order, already inside F - never added twice.`,
          `F = ${money(f.F)}: kharid ${money(f.cs)} + packing ${money(f.pack)} + delivery ${money(f.fwd)} + return ${money(f.Cret)} + RTO ${money(f.Crto)} + baaki ${money(f.other)} = F. Return + RTO (B) = ${money(f.B)} per kept order, F ke andar hi hai.`,
        ),
        source: 'Floor engine (M4, M6) · seller cost inputs + category priors',
        why: w,
        suggestions: ['How much profit?', 'Why are returns coming?', 'Can I change my price?'],
      };
    }

    case 'profit': {
      const d = profitPerDay(listing, p, f);
      return {
        ...base,
        confidence: sku.views >= 5000 ? 'High' : 'Medium',
        answer: T(
          `At ${money(p)} you earn ${money(perKept)} on every ${sku.short.toLowerCase()} that stays sold (naive check: ${money(p - f.cs)} if you only subtract sourcing - the return and RTO buffer of ${money(f.B)} is real money). About ${orders.toFixed(0)} orders a day, ${Math.round(f.k * 100)}% stay kept, so about ${money(d)} profit a day.`,
          `${money(p)} par har kept order par ${money(perKept)}. Lagbhag ${orders.toFixed(0)} order roz, ${Math.round(f.k * 100)}% kept, yani lagbhag ${money(d)} kamai roz.`,
        ),
        source: `Floor engine F ${money(f.F)} · k ${f.k.toFixed(2)} · demand model (b = -3)`,
        why: { what: 'Profit per kept order', why: [`Selling price ${money(p)}`, `Floor ${money(f.F)} (all costs / kept orders)`, `Kept rate k = ${f.k.toFixed(2)}, buffer B = ${money(f.B)}`], effect: `${money(perKept)} per kept order · about ${money(d)} per day at ${orders.toFixed(1)} orders/day`, confidence: 'Medium', undo: 'Nothing changes from an explanation.' },
        suggestions: ['How is my floor made?', 'Can I raise my price?', 'Should I run ads?'],
      };
    }

    case 'returns': {
      const cat = CATEGORIES[f.category];
      const dualEffect = ENGINE.NO_RETURN_RETURN_DROP * f.ret;
      return {
        ...base,
        confidence: 'Medium',
        answer: T(
          `${f.retN} of 100 placed ${sku.short.toLowerCase()} orders come back (${f.ret}%), and ${f.rtoN} never get accepted (RTO ${f.rto}%). Return cost is ${money(f.Cret)} and RTO cost ${money(f.Crto)} per kept order, inside your floor. Biggest seller-controllable reason: size. Platform-side: prepaid nudge and COD confirmation. Dual pricing alone is worth about ${dualEffect.toFixed(1)} pp fewer returns.`,
          `100 mein se ${f.retN} order wapas aate hain (${f.ret}%), ${f.rtoN} accept hi nahi hote (RTO ${f.rto}%). Floor ke andar return ${money(f.Cret)} aur RTO ${money(f.Crto)} per kept order. Aapke haath mein sabse bada reason: size. Dual pricing se lagbhag ${dualEffect.toFixed(1)} pp returns kam.`,
        ),
        source: `Returns & RTO tab · ${sku.name} · category prior ${cat.name} (${cat.ret}% returns, ${cat.rto}% RTO)`,
        why: {
          what: 'Two different problems, two different fixes', why: [
            'RTO: mostly Meesho-side levers (COD confirmation, prepaid nudge, delivery).',
            'Returns: mostly seller-side (size chart, true photos, quality check, packing).',
            `COD orders fail 20.9% vs 5.8% prepaid [Unicommerce] - the prepaid nudge is the cheapest lever here.`,
          ],
          effect: `Return + RTO buffer B = ${money(f.B)} per kept order`, confidence: 'Medium', undo: 'Listing edits are yours to revert.',
        },
        suggestions: ['Skip: what fixes size returns?', 'When to reorder stock?', 'Why is my floor this high?'],
      };
    }

    case 'rto': {
      const mix = riskMixAtPrice(listing, p, f);
      return {
        ...base,
        confidence: 'Medium',
        answer: T(
          `RTO is ${f.rto}% at the current price, and it moves with price: cheaper prices pull in more COD buyers, who refuse more (${money(p)} keeps the COD share around ${(mix.codShare * 100).toFixed(0)}%). Levers: COD confirmation, prepaid nudge for high-risk pincodes, dispatch speed.`,
          `RTO ${f.rto}% hai, aur price ke saath badalta hai: sasta price zyada COD buyers laata hai jo zyada refuse karte hain. Levers: COD confirmation, prepaid nudge, dispatch speed.`,
        ),
        source: 'Risk model · pincode + COD features (AUC >= 0.75 target)',
        suggestions: ['Why are returns coming?', 'Can I change my price?', 'Is my stock stuck?'],
      };
    }

    case 'comp': {
      const lo = Math.min(sku.closestRival, f.F) - 20;
      const hi = sku.band[1] + 30;
      const pos = Math.max(0, Math.min(100, (p - lo) / (hi - lo) * 100));
      return {
        ...base,
        confidence: 'Medium',
        answer: T(
          `There are ${sku.lookalikes} listings like yours; most sell between ${money(sku.band[0])} and ${money(sku.band[1])}, median ${money(sku.median)}. You are at ${money(p)}${pos > 60 ? ' (upper half of the band)' : ' (lower half of the band)'}. Do not copy the cheapest seller: at ${money(sku.closestRival)} you would lose ${money(f.F - sku.closestRival)} a piece.`,
          `${sku.lookalikes} milte-julte listings hain; zyada-tar ${money(sku.band[0])}-${money(sku.band[1])} mein bikte hain, median ${money(sku.median)}. Aap ${money(p)} par ho. Sabse saste ko copy mat karo: ${money(sku.closestRival)} par har piece par ${money(f.F - sku.closestRival)} nuksaan hoga.`,
        ),
        source: `Look-alike model · CLIP image + text embeddings, kNN (precision >= 85% target)`,
        why: { what: 'Band position', why: [`Band ${money(sku.band[0])}-${money(sku.band[1])} from ${sku.lookalikes} look-alikes`, `Median ${money(sku.median)}`, `Closest rival ${money(sku.closestRival)} (${sku.closestRival < f.F ? 'below your floor - they are losing money, not setting the market' : 'inside your floor'})`], effect: `You are ${money(perKept)} above your floor`, confidence: 'Medium', undo: 'A band is information, not an instruction.' },
        suggestions: ['Can I raise my price?', 'Skip: why not cut?', 'What are my modes?'],
      };
    }

    case 'raise': {
      const rec = recommend(listing, { mode });
      return {
        ...base,
        confidence: rec.confidence,
        answer: T(
          `${rec.headline}. ${rec.effect}`,
          `${rec.headline}. ${rec.effect}`,
        ),
        source: `Recommendation engine · mode ${MODES[mode].name} · stage ${rec.stage}`,
        why: { what: rec.what, why: rec.why, effect: rec.effect, confidence: rec.confidence, confidenceWhy: rec.confidenceWhy, undo: rec.undo, pf: rec.preflight },
        suggestions: ['What are my modes?', 'How is my floor made?', 'My orders dropped'],
      };
    }

    case 'reorder': {
      const rop = reorderPoint({ dailyUnits: Math.max(1, Math.round(orders)), leadTimeDays: 7 });
      return {
        ...base,
        confidence: 'High',
        answer: T(
          `Reorder point ROP = ${rop.inputs.dailyUnits}/day x ${rop.inputs.leadTimeDays} days + safety stock ${rop.safetyStock} = ${rop.reorderPoint} units. Order about ${rop.orderQuantity} units (2 weeks of sales). Cash needed ${money(rop.cashRequired)}; pooled with 4 other sellers ${money(rop.pooledCash)} - that is a saving of ${money(rop.poolingSaving)} (2.0, needs your opt-in).`,
          `ROP = ${rop.inputs.dailyUnits}/din x ${rop.inputs.leadTimeDays} din + safety stock ${rop.safetyStock} = ${rop.reorderPoint} units. Lagbhag ${rop.orderQuantity} units order karo. Cash ${money(rop.cashRequired)}; 4 sellers ke saath ${money(rop.pooledCash)} - bachat ${money(rop.poolingSaving)} (2.0, opt-in).`,
        ),
        source: 'Inventory signals · demand during lead time + safety stock (M28)',
        suggestions: ['Is my stock stuck?', 'How much profit?', 'What are my modes?'],
      };
    }

    case 'ads': {
      return {
        ...base,
        confidence: 'Medium',
        answer: T(
          `Ads cost ${money(f.otherLines.ads)} per kept order and that is already inside your floor. Spend more only if the ad ₹ per kept order stays below your profit per kept order (${money(perKept)}). Raising ads to ₹25 lifts the floor by about ₹13 and cuts profit to ${money(perKept - 13)}.`,
          `Ads ${money(f.otherLines.ads)} per kept order, floor ke andar. Tabhi badhao jab ad ₹ per kept order aapki kamai ${money(perKept)} se kam rahe. Ads ₹25 karne se floor ~₹13 badhega.`,
        ),
        source: 'Cost branch · ads attribution per kept order',
        why: { what: 'Ads rule', why: [`Ad ₹ per kept order ${money(f.otherLines.ads)} < profit per kept order ${money(perKept)}`, 'Raising ads ₹12 -> ₹25 lifts the floor by ₹13 (deck floor sensitivity)', 'Conversion and CTR are at the median: more reach is not the bottleneck'], effect: '₹0 change; avoids -₹13 per kept order', confidence: 'Medium', undo: 'Nothing changes.' },
        suggestions: ['My orders dropped', 'What are competitors doing?'],
      };
    }

    case 'stuck': {
      const lc = lifecycle(listing);
      return {
        ...base,
        confidence: 'Low',
        answer: T(
          `${listing.signals.doi} days of stock. Bundle first (recovers 50-80% of cost), then a markdown ladder in <= 8% steps: ${money(lc.priceLadder.M1)} -> ${money(lc.priceLadder.M2)} -> ${money(lc.priceLadder.M3)}, stopping above your floor ${money(f.F)}. Below that only at Exit with your consent, never below ${money(f.frec)}.`,
          `${listing.signals.doi} din ka stock. Pehle bundle (50-80% wapas), phir <= 8% steps ka ladder: ${money(lc.priceLadder.M1)} -> ${money(lc.priceLadder.M2)} -> ${money(lc.priceLadder.M3)}, floor ${money(f.F)} se upar. Neeche sirf Exit par aapki manzoori se, ${money(f.frec)} se neeche kabhi nahi.`,
        ),
        source: `Lifecycle engine (Decline) · stock ${listing.signals.doi} days > 60 limit`,
        suggestions: ['What are my exits?', 'How much profit?', 'When to reorder stock?'],
      };
    }

    case 'cut': {
      const d = diagnose(listing, ctx.signals || {});
      const target = Math.round(p * 0.85);
      return {
        ...base,
        confidence: 'High',
        answer: T(
          `${money(target)} is ${target >= f.F ? `still above your floor ${money(f.F)}` : `below your floor ${money(f.F)} - that is ${money(f.F - target)} lost on every kept order`}, but a cut is allowed only when the price-value branch fires. It ${d.priceValueFired ? 'has fired' : 'has not fired'}${d.biggestLoss ? `, and the biggest ₹ loss is ${d.biggestLoss.label} (about ₹${Math.round(d.biggestLoss.impactPerWeek)}/week)` : ''}. Fix that first; if you still want to cut, the engine shows the Loss Warning and Manual mode can publish.`,
          `${money(target)} ${target >= f.F ? `aapke floor ${money(f.F)} se upar hai` : `floor ${money(f.F)} se neeche hai - har kept order par ${money(f.F - target)} nuksaan`}, par cut tabhi allowed hai jab price-value branch fire ho. Wo ${d.priceValueFired ? 'fire hua hai' : 'fire nahi hua'}. Pehle wo theek karo; phir bhi cut karna ho to Loss Warning dikhega aur Manual mode publish kar sakta hai.`,
        ),
        source: `Panic Brake · diagnostic tree · ${d.firedCount}/8 checks fired`,
        why: { what: 'Panic Brake', why: d.firedOrder.map((b) => `${b.label}: ₹${Math.round(b.impactPerWeek)}/week at risk`), effect: `At ${money(target)}: ${money(target - f.F)} per kept order vs ${money(perKept)} now`, confidence: 'High', undo: 'Nothing was changed.' },
        suggestions: ['My orders dropped', 'What are competitors doing?', 'What are my modes?'],
      };
    }

    case 'modes':
      return {
        ...base,
        confidence: 'High',
        answer: T(
          `Four modes: CASH (paid sooner - cash mode leads with the no-return price), GROWTH (sales first, then step up 3-5%), MARGIN (only arms with >= ${money(f.T)} profit per kept order), CLEAR (sell fast, never below F ${money(f.F)}). You are in ${MODES[mode].name}: ${MODES[mode].definition}`,
          `Char modes: CASH (paisa jaldi), GROWTH (pehle sales, phir 3-5% step), MARGIN (>= ${money(f.T)} kamai per kept order), CLEAR (jaldi becho, F ${money(f.F)} se neeche nahi). Aap ${MODES[mode].name} mode mein ho.`,
        ),
        source: 'Goal modes · deck slide 6',
        suggestions: ['How much profit?', 'Can I raise my price?', 'When to reorder stock?'],
      };

    case 'pilot':
      return {
        ...base,
        confidence: 'Low',
        answer: T(
          'Two cities (Surat 4.55, Rajkot 4.10), 250 vs 250 sellers randomised by seller for 12 weeks, then a permanent 5% holdout. Targets: profit per kept order ₹84 -> ₹104.5 (+24%), kept orders 28 -> 31 (+10%). Every number is an illustrative target with a causal chain - the holdout decides what we may claim.',
          'Do shehar (Surat 4.55, Rajkot 4.10), 250 vs 250 sellers, 12 hafte, phir hamesha 5% holdout. Target: kamai per kept order ₹84 -> ₹104.5 (+24%), kept orders 28 -> 31 (+10%). Sab numbers target hain; holdout tay karega.',
        ),
        source: 'Pilot & impact engine · deck slide 8 (M22, M23, M24)',
        suggestions: ['What are the limits of 1.0?', 'How much profit?'],
      };

    case 'limits':
      return {
        ...base,
        confidence: 'High',
        answer: T(
          'ProfitPilot 1.0 prices only. It cannot cut your packaging, freight or sourcing cost, it has few external signals, and it does not check supply, lead times or cash flow. It also proves its own lift: no claim without the holdout. Those gaps are the 2.0 programmes, and they need your opt-in.',
          'ProfitPilot 1.0 sirf pricing karta hai. Packaging, freight ya sourcing cost kam nahi kar sakta, external signals kam hain, supply/cash flow check nahi karta. Apna lift bhi holdout se prove karta hai. Ye gaps 2.0 programmes mein hain, opt-in ke saath.',
        ),
        source: 'Limits & risks · deck slide 9',
        suggestions: ['What can 2.0 do?', 'What is my pilot?'],
      };

    case 'bands':
      return {
        ...base,
        confidence: 'Medium',
        answer: T(
          `Your band ${money(sku.band[0])}-${money(sku.band[1])} comes from ${sku.lookalikes} look-alike listings; the median is ${money(sku.median)}. Inside the band the engine does not chase price - it fixes the funnel first.`,
          `Aapka band ${money(sku.band[0])}-${money(sku.band[1])}, ${sku.lookalikes} look-alikes se; median ${money(sku.median)}. Band ke andar engine price nahi chhedta - pehle funnel theek karta hai.`,
        ),
        source: 'Look-alike model + price band',
        suggestions: ['What are competitors doing?', 'Can I raise my price?'],
      };

    default:
      return { ...base, confidence: 'Low', answer: T('I do not have a grounded answer for that yet.', 'Iska grounded jawab abhi nahi hai.'), source: 'ProfitPilot Coach' };
  }
}

/**
 * THE COACH NEVER GUESSES LOUDLY: below 1,000 impressions the answer still
 * comes back, but it is labelled Low and says why. (Deck slide 5 box 3: every
 * threshold is a default the pilot calibrates.)
 */
const DATA_INTENTS = new Set(['orders', 'returns', 'profit', 'raise', 'comp', 'stuck', 'ads', 'reorder', 'cut', 'money', 'cvr', 'cost']);

export function answer(ctx) {
  const res = answerInner(ctx);
  const views = ctx.listing?.signals?.views ?? 0;
  if (DATA_INTENTS.has(res.intent) && views < 1000) {
    res.confidence = 'Low';
    res.thinData = true;
    res.confidenceWhy = `Only ${views.toLocaleString('en-IN')} impressions so far (Medium needs 1,000+, High 5,000+). Treat this as a rough estimate, not a reading.`;
  }
  return res;
}

/** Regression helper used by the tests: every intent must be reachable by text. */
export function intents() {
  return INTENTS.map((i) => i.key);
}

export { SKUS, MODES, ENGINE };
