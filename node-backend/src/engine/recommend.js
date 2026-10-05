/**
 * LAYER: DECISION - the weekly recommendation.
 * Deck slide 6 ("ProfitPilot: two numbers required, a dual price out"):
 * the seller sees ONE Yes / No card per SKU per week, and every card carries
 * what / why (the signals that fired, with numbers) / ₹ effect / confidence /
 * undo + auto-revert.
 *
 * The branches below are the deck's decision rules, per goal mode:
 *   cooldown -> CASH -> MARGIN -> CLEAR -> GROWTH -> MATURITY -> DECLINE -> LAUNCH
 */

import { ENGINE, MODES } from '../config/deck.js';
import { computeFloor, ceil9, floor9 } from './floor.js';
import { ordersPerDay } from './demand.js';
import { cashComparison, clearStep } from './modes.js';
import { preflight, trustLadder } from './guardrails.js';

export const money = (v) => `${v < 0 ? '\u2212' : ''}₹${Math.abs(Math.round(v)).toLocaleString('en-IN')}`;
export const pct = (v, d = 1) => `${v > 0 ? '+' : v < 0 ? '\u2212' : ''}${Math.abs(v).toFixed(d)}%`;
const r2 = (x) => Math.round(x * 100) / 100;

/**
 * Confidence is the prototype's own rule (front-end confOf): the badge follows
 * how much traffic the listing has seen.
 *   >= 5,000 views -> High | 1,000-5,000 -> Medium | < 1,000 -> Low
 * The amount of own-price evidence (shrinkage w = n / (n + n0), deck slide 7)
 * sharpens the demand estimate and is reported in confidenceWhy, but it does
 * not re-label a card the prototype would show as High.
 */
export function confidence(views, priceTestImpressions = 0) {
  void priceTestImpressions;
  if (views >= 5000) return 'High';
  if (views >= 1000) return 'Medium';
  return 'Low';
}

export function confidenceWhy(views, priceTestImpressions = 0) {
  const v = (views || 0).toLocaleString('en-IN');
  const volume = views >= 5000 ? '>= 5,000' : views >= 1000 ? '1,000-5,000' : '< 1,000';
  const w = (priceTestImpressions / (priceTestImpressions + ENGINE.N0)).toFixed(2);
  return `${v} views (${volume}) -> ${confidence(views, priceTestImpressions).toLowerCase()}. Price evidence: ${priceTestImpressions.toLocaleString('en-IN')} impressions earned at prices other than today's, shrinkage w = n / (n + n0) = ${w} with n0 = ${ENGINE.N0.toLocaleString('en-IN')} - until n >= 2 x n0 the category prior (b = -3) still carries most of the demand weight. The badge tracks traffic; the engine lab earns the SKU its own elasticity.`;
}

/**
 * @param {object} listing - listing row (with .sku, .signals, .price, .costOverrides, .dsm, .movesThisMonth, .stage)
 * @param {object} opts    - { mode, floor, now }
 * @returns structured recommendation card
 */
export function recommend(listing, opts = {}) {
  const sku = listing.sku;
  const mode = opts.mode || listing.mode || 'growth';
  const f = opts.floor || computeFloor(sku.key, listing.costOverrides || {});
  const sig = listing.signals;
  const p = listing.price;
  const F = f.F;
  const kr = sig.keptRatePct ?? Math.round(f.k * 100);
  const assumedKept = Math.round(f.k * 100);
  const stage = listing.stage || sig.stage;
  const dsm = listing.daysSinceMove ?? 0;
  const mpm = listing.movesThisMonth ?? 0;
  const cooldown = dsm < 7 || mpm >= 2;

  const card = (o) => finalise({ listing, f, mode, stage, views: sig.views, ...o });

  const effect = (to) => {
    const o1 = ordersPerDay(listing, p);
    const o2 = ordersPerDay(listing, to);
    const d1 = o1 * f.k * (p - F);
    const d2 = o2 * f.k * (to - F);
    return {
      ordersFrom: r2(o1), ordersTo: r2(o2),
      profitPerKeptFrom: r2(p - F), profitPerKeptTo: r2(to - F),
      profitPerDayFrom: r2(d1), profitPerDayTo: r2(d2),
      deltaPct: r2((d2 - d1) / Math.abs(d1 || 1) * 100),
      text: `${money(to - F)} profit per kept order (was ${money(p - F)}) · orders ${o1.toFixed(1)} -> ${o2.toFixed(1)}/day · profit/day ${money(d1)} -> ${money(d2)} (${pct((d2 - d1) / Math.abs(d1 || 1) * 100)})`,
    };
  };

  const baseEvidence = [
    `Floor F = ${money(F)} (return-adjusted, kept rate k = ${f.k.toFixed(2)}, buffer B = ${money(f.B)})`,
    `${(sig.views || 0).toLocaleString('en-IN')} views at ${money(p)} (sanity threshold 1,000 views ~ 5 orders)`,
  ];

  const undoMove = (to) => `Nothing changes until the seller taps YES. Undo within ${24} h. Auto-revert check at 14 days: if profit per impression at ${money(to)} is worse than at ${money(p)}, the price goes back to ${money(p)}.`;

  /* ---------------------------------------------------------------- *
   * 1. Cooldown: one card a week per SKU, <= 2 moves a month
   * ---------------------------------------------------------------- */
  if (cooldown) {
    return card({
      kind: 'hold', from: p, to: p,
      headline: `Hold ${money(p)}: cooldown`,
      sub: `Last move ${dsm} day(s) ago · ${mpm} move(s) this month.`,
      why: [
        `Trigger hygiene: cooldown is 7 days per SKU (one full weekday + weekend cycle) and <= 2 moves a month. This SKU moved ${dsm} day(s) ago (${mpm} this month).`,
        ...baseEvidence,
      ],
      effect: { text: '₹0 now. The 14-day auto-revert check on the last move is still running.' },
      undo: 'Nothing to undo. Next weekly check in 7 days.',
    });
  }

  /* ---------------------------------------------------------------- *
   * 2. CLEAR mode: sell fast, never below cost
   * ---------------------------------------------------------------- */
  if (mode === 'clear') {
    if (p > f.Fplus) {
      const step = clearStep(f, p);
      return card({
        kind: 'down', from: p, to: step.price,
        headline: `Bundle first, then ${money(p)} -> ${money(step.price)}`,
        sub: `CLEAR mode: sell fast, never below your cost ${money(F)}.`,
        why: [
          `Goal mode CLEAR: objective = kept orders per impression, never below F ${money(F)}.`,
          `Step capped at 8%: ${money(p)} x 0.92 -> ${money(step.price)} (${pct((step.price - p) / p * 100)}).`,
          `Clearance target ${money(f.Fplus)} = F / 0.97 (m = 3%). Deeper recovery floor ${money(f.frec)} only at Exit with explicit consent.`,
          ...baseEvidence,
        ],
        effect: effect(step.price),
        undo: undoMove(step.price),
        logic: tree('CLEAR mode guard', [
          { q: 'Bundle with a fast mover possible?', yes: 'offer bundle first (recovers 50-80%)', no: 'continue', v: 'yes', d: 'demo: yes' },
          { q: 'Next step >= floor F?', yes: 'markdown <= 8% step', no: 'stop at F; recovery floor needs consent at Exit', v: step.price >= F ? 'yes' : 'no', d: `${money(step.price)} vs ${money(F)}` },
        ], 'bundle + step'),
      });
    }
    return card({
      kind: 'hold', from: p, to: p,
      headline: `Hold ${money(p)}: already at the clearance floor`,
      why: [`Price ${money(p)} is at F / 0.97 = ${money(f.Fplus)}. CLEAR never goes below F ${money(F)} without Exit-stage consent.`, ...baseEvidence],
      effect: { text: '₹0' }, undo: 'Nothing changes.',
    });
  }

  /* ---------------------------------------------------------------- *
   * 3. CASH mode: lead with the no-return price
   * ---------------------------------------------------------------- */
  if (mode === 'cash' && stage !== 'decline') {
    const pn = p - f.gap;
    const cash = cashComparison(f, p);
    return card({
      kind: 'dual', from: p, to: pn,
      headline: `Lead with no-return ${money(pn)} + prepaid nudge`,
      sub: `Easy-returns ${money(p)} stays on. No-return orders cannot come back, so cash is final sooner.`,
      why: [
        `Goal mode CASH: objective = ₹ profit per rupee-day.`,
        `No-return floor = F - C_ret = ${money(F)} - ${money(f.Cret)} = ${money(f.Fno)}; profit per kept order ${money(pn - f.Fno)} (vs ${money(p - F)} easy-returns).`,
        ...cash.why,
        ...baseEvidence,
      ],
      effect: {
        ...effect(pn),
        text: `Profit per rupee-day: ${(cash.easy.perRupeeDay * 100).toFixed(2)}% -> ${(cash.noReturn.perRupeeDay * 100).toFixed(2)}% (${cash.multiple}x)`,
      },
      undo: 'Uses Meesho\'s existing dual-pricing field; the lead can switch back to easy-returns any time. 14-day check on the cash cycle and returns.',
      logic: tree('CASH mode routing', [
        { q: 'Is the no-return price >= its own floor (F - C_ret)?', yes: 'lead with no-return + prepaid nudge', no: 'keep easy-returns', v: pn >= f.Fno ? 'yes' : 'no', d: `${money(pn)} vs ${money(f.Fno)}` },
      ], 'dual price, no-return first'),
    });
  }

  /* ---------------------------------------------------------------- *
   * 4. MARGIN mode: target profit per kept order, never a markdown
   * ---------------------------------------------------------------- */
  if (mode === 'margin') {
    if (stage === 'decline') {
      return card({
        kind: 'hold', from: p, to: p,
        headline: `Hold ${money(p)} · bundle instead of a markdown`,
        sub: 'MARGIN mode accepts lower volume; no markdowns.',
        why: [
          `Goal mode MARGIN: only prices with >= ${money(f.T)} profit per kept order.`,
          `Stock is stuck (DOI ${sig.doi} days), but a markdown would break the margin rule. A bundle keeps the unit price.`,
          ...baseEvidence,
        ],
        effect: { text: `Keeps ${money(p - F)} per kept order; stock clears slower (about ${Math.round(sig.doi * 0.8)} days with a bundle).` },
        undo: 'Nothing changes on price.',
        logic: declineTree(listing, f, p, stage),
      });
    }
    const target = f.Pm;
    if (p < target) {
      let to = Math.min(target, floor9(p * 1.08)); // round DOWN so the raise never overshoots the target
      if (to <= p) to = Math.round(p * 1.08);
      return card({
        kind: 'up', from: p, to,
        headline: `Raise ${money(p)} -> ${money(to)} (margin target)`,
        sub: `MARGIN mode: target ${money(target)} (m = 22%), capped at 8% per step.`,
        why: [
          `Goal mode MARGIN: target P* = F / (1 - m) = ${money(F)} / 0.78 = ${money(r2(F / 0.78))} -> ${money(target)}.`,
          `Only arms with >= ${money(f.T)} profit per kept order are allowed (${money(f.Pe)}-${money(f.arms[4])}).`,
          `Max step 8%: ${money(p)} x 1.08 = ${money(p * 1.08)} -> ${money(to)}. Lower volume is accepted in this mode.`,
          ...baseEvidence,
        ],
        effect: effect(to),
        undo: undoMove(to),
      });
    }
    return card({
      kind: 'hold', from: p, to: p,
      headline: `Hold ${money(p)}: margin already met`,
      why: [`Profit per kept order ${money(p - F)} >= target ${money(f.T)}; m = ${((1 - F / p) * 100).toFixed(0)}%.`, ...baseEvidence],
      effect: { text: '₹0 · no change' },
      undo: 'Nothing changes. Next weekly check in 7 days.',
    });
  }

  /* ---------------------------------------------------------------- *
   * 5. GROWTH stage (default branch)
   * ---------------------------------------------------------------- */
  if (stage === 'growth') {
    const A = sig.cvr >= sig.cvrMedian && sig.cvrHoldWeeks >= 2;   // conversion holds 2 weeks
    const B = sig.doi >= 30;                                        // stock cover
    const C = sig.rivalGapPct > 5;                                   // rival undercuts > 5%
    const K = kr >= assumedKept;                                     // kept rate >= what F assumes
    if (A && B && K && !C) {
      const to = Math.round(p * 1.04);
      return card({
        kind: 'up', from: p, to,
        headline: `Step up ${money(p)} -> ${money(to)} (+4%)`,
        sub: 'Demand is growing and conversion held 2 weeks.',
        why: [
          `Stage GROWTH: kept units ${pct(sig.keptUnitTrendPct)} in 4 weeks (Growth line +15%).`,
          `Conversion ${sig.cvr}% vs median ${sig.cvrMedian}% for ${sig.cvrHoldWeeks} weeks -> step +3-5%.`,
          `Kept rate on matured orders ${kr}% >= ${assumedKept}% assumed in the floor.`,
          `Stock cover ${sig.doi} days (>= 30). No rival undercut > 5%.`,
          `${money(p)} x 1.04 = ${money(to)}: inside the 8% limit and above floor ${money(F)}.`,
          ...baseEvidence,
        ],
        effect: effect(to),
        undo: undoMove(to),
        logic: growthTree(listing, f, p, stage, true),
      });
    }
    const why = !A
      ? `Conversion has not held 2 weeks (${sig.cvr}% vs ${sig.cvrMedian}%).`
      : !B
        ? `Only ${sig.doi} days of stock: replenish first.`
        : !K
          ? `Kept rate ${kr}% is below the ${assumedKept}% the floor assumes: fix returns first.`
          : `Rival undercut ${sig.rivalGapPct}%: see the Lifecycle screen for the match test.`;
    return card({
      kind: 'hold', from: p, to: p,
      headline: `Hold ${money(p)}`,
      why: [why, ...baseEvidence],
      effect: { text: '₹0' },
      undo: 'Nothing changes.',
      logic: growthTree(listing, f, p, stage, false),
    });
  }

  /* ---------------------------------------------------------------- *
   * 6. MATURITY: protect margin
   * ---------------------------------------------------------------- */
  if (stage === 'maturity') {
    if (sig.rivalGapPct < 0) {
      const to = Math.round(p * 1.04);
      return card({
        kind: 'up', from: p, to,
        headline: `Raise ${money(p)} -> ${money(to)}: rivals moved up`,
        sub: `The closest rivals moved to ${money(sku.band[1] - 20)}-${money(sku.band[1])}. You stay below them.`,
        why: [
          `Stage MATURITY: demand steady (${pct(sig.keptUnitTrendPct)}).`,
          `Closest rivals moved UP ${Math.abs(sig.rivalGapPct)}% this week; the market median is now ${money(sku.median)}.`,
          `${money(p)} x 1.04 = ${money(to)} (+4%, limit 8%), ${money(to - F)} above floor ${money(F)}.`,
          ...baseEvidence,
        ],
        effect: effect(to),
        undo: undoMove(to),
      });
    }
    return card({
      kind: 'hold', from: p, to: p,
      headline: `Hold ${money(p)}: no trigger crossed`,
      sub: sig.doi < 30 ? `Stock is low (${sig.doi} days): reorder before any price move.` : 'Steady demand. Margin is protected, not chased.',
      why: [
        `Stage MATURITY: demand ${pct(sig.keptUnitTrendPct)} (inside +-15%).`,
        sig.doi < 30
          ? `Stock cover ${sig.doi} days is below 30: a price step now would sell out faster. Reorder point ROP = 84 + 18 = 102 units (2.0 reorder alert).`
          : `Stock ${sig.doi} days, healthy.`,
        'No rival undercut > 5% for 7 days.',
        ...baseEvidence,
      ],
      effect: { text: '₹0 · holding avoids resetting learning and uses none of the 2 moves/month.' },
      undo: 'Nothing changes. Next weekly check in 7 days.',
    });
  }

  /* ---------------------------------------------------------------- *
   * 7. DECLINE: recover value, bundle before markdown
   * ---------------------------------------------------------------- */
  if (stage === 'decline') {
    const to = Math.max(f.Fplus, ceil9(p * 0.92));
    return card({
      kind: 'down', from: p, to,
      headline: `Bundle first, then ${money(p)} -> ${money(to)}`,
      sub: `${sig.doi} days of stock. Price is not the main problem; free the cash safely.`,
      why: [
        `Stage DECLINE: kept units ${pct(sig.keptUnitTrendPct)} in 4 weeks (line -15%); days of inventory ${sig.doi} (limit 60).`,
        'A bundle with a fast mover recovers 50-80% of cost vs 40-70% for a markdown.',
        `Markdown step ${pct((to - p) / p * 100)} (<= 8%), stays >= F ${money(F)}. Below F only at Exit with consent, never below ${money(f.frec)}.`,
        ...baseEvidence,
      ],
      effect: effect(to),
      undo: undoMove(to),
      logic: declineTree(listing, f, p, stage),
    });
  }

  /* ---------------------------------------------------------------- *
   * 8. LAUNCH: dual-price menu + sanity check, no price change
   * ---------------------------------------------------------------- */
  return card({
    kind: 'launch', from: p, to: p,
    headline: `Launch: dual-price menu ${money(f.Pe)} easy-returns / ${money(f.Pn)} no-return`,
    why: [
      `Listing is ${listing.ageDays} days old (< ${listing.stageWindow?.launch ?? 30}): no own history yet.`,
      `The buyer picks: easy-returns ${money(f.Pe)} or no-return ${money(f.Pn)}. The ${money(f.gap)} gap is about the ${money(f.Cret)} return cost saved, so profit per kept order is about the same either way.`,
      '1,000 views = about 5 orders (4% CTR x 12% CVR): enough to check that buyers are ordering, too few to measure price sensitivity. That is learned across similar products (pooled).',
      `From day 15: price menus rotate by day (e.g. ${money(f.Pe)}/${money(f.Pn)} vs ${money(f.arms[3])}/${money(f.arms[3] - f.gap)}); every buyer sees the same price at any moment.`,
      `Prices below F ${money(F)} are filtered out before testing.`,
    ],
    effect: { text: `Learning cost is bounded: every price earns >= ${money(f.Pn - f.Fno)} per kept order.` },
    undo: 'Nothing to undo. The lift is measured against holdout sellers (similar sellers without ProfitPilot).',
    confidence: 'Low',
  });
}

/* ------------------------------------------------------------------ *
 * Decision trees (deck slide 2 box 4, slide 5 box 1, slide 6)
 * ------------------------------------------------------------------ */
export function growthTree(listing, f, p, stage, hit) {
  const sig = listing.signals;
  const kr = sig.keptRatePct ?? Math.round(f.k * 100);
  return tree('Growth decision tree', [
    { q: 'Conversion holds 2 weeks? (CVR >= median)', no: 'hold price, fix the funnel (Diagnose)',
      yes: 'continue', v: sig.cvr >= sig.cvrMedian && sig.cvrHoldWeeks >= 2 ? 'yes' : 'no',
      d: `CVR ${sig.cvr}% vs median ${sig.cvrMedian}% for ${sig.cvrHoldWeeks} wk` },
    { q: 'Stock cover >= 30 days?', no: 'replenish first (reorder alert, 2.0)', yes: 'continue',
      v: sig.doi >= 30 ? 'yes' : 'no', d: `${sig.doi} days of stock` },
    { q: 'Kept rate on matured orders >= what the floor assumes?', no: 'fix returns first (Diagnose)', yes: 'continue',
      v: kr >= Math.round(f.k * 100) ? 'yes' : 'no', d: `${kr}% kept vs ${Math.round(f.k * 100)}% assumed in F` },
    { q: 'Rival undercuts > 5%?', yes: 'compare profit/day: partial match (never below floor) only if it beats holding',
      no: 'step +3-5%; Meesho can widen reach to similar regions (seller approves)',
      v: sig.rivalGapPct > 5 ? 'yes' : 'no',
      d: sig.rivalGapPct > 0 ? `closest rival ${sig.rivalGapPct}% lower` : sig.rivalGapPct < 0 ? `rivals moved UP ${-sig.rivalGapPct}%` : 'no undercut' },
  ], hit ? 'step +4%' : 'hold');
}

export function declineTree(listing, f, p, stage) {
  const sig = listing.signals;
  const on = stage === 'decline' || stage === 'exit';
  return tree('Decline decision tree', [
    { q: 'Kept units -15% over 4 weeks, or DOI > 60?', no: 'stay mature: protect margin', yes: 'continue',
      v: (sig.keptUnitTrendPct < -15 || sig.doi > 60) ? 'yes' : 'no', d: `g = ${pct(sig.keptUnitTrendPct)}, DOI ${sig.doi} days` },
    { q: 'Seasonal dip?', yes: 'park for next season, or Meesho widens reach (seller approves)', no: 'continue',
      v: 'no', d: 'demand fell outside the category\'s seasonal pattern (demo)' },
    { q: `Price > recovery floor ${money(f.frec)}?`, yes: 'bundle first -> markdown (<= 8% steps, never below F without consent)', no: 'B2B lot / delist',
      v: p > f.frec ? 'yes' : 'no', d: `${money(p)} vs recovery floor ${money(f.frec)}` },
  ], on ? 'bundle -> markdown' : 'stay mature');
}

export function tree(title, nodes, out) {
  return { title, nodes, outcome: out };
}

/** Finalise: attach pre-flight, confidence, undo and the one-line "what". */
function finalise(r) {
  const { listing, f, mode, stage, views, kind, from, to } = r;
  const pre = to !== from && kind !== 'dual'
    ? preflight({ floor: f, from, to, views, daysSinceMove: listing.daysSinceMove ?? 0, movesThisMonth: listing.movesThisMonth ?? 0, consent: !!listing.consent })
    : null;
  const priceTest = r.priceTestImpressions ?? listing.priceTestImpressions ?? 0;
  const conf = r.confidence || confidence(views, priceTest);
  return {
    cardId: `${listing.id}:${mode}:${from}>${to}:${kind}`,
    listingId: listing.id,
    sku: listing.sku.key,
    mode,
    modeName: MODES[mode]?.name,
    stage,
    kind, from, to,
    headline: r.headline,
    sub: r.sub || null,
    what: r.headline + (r.sub ? `. ${r.sub}` : ''),
    why: r.why,
    effect: r.effect?.text ?? r.effect,
    effectDetail: r.effect?.ordersFrom != null ? r.effect : null,
    confidence: conf,
    confidenceWhy: confidenceWhy(views, priceTest),
    undo: r.undo,
    logic: r.logic || null,
    preflight: pre,
    preflightPass: pre ? pre.pass : null,
    floor: { F: f.F, B: f.B, k: f.k, recoveryFloor: f.frec, noReturnFloor: f.Fno },
    guardrails: {
      canPublish: !pre || pre.pass,
      hardFloor: true,
      maxStepPct: 8,
      undoHours: 24,
      autoRevertDay: 14,
      confirmDay: 28,
    },
    createdAt: new Date().toISOString(),
  };
}

export { trustLadder };

/** All five SKUs, one card each - the Home screen feed. */
export function recommendAll(listings, opts = {}) {
  return listings.map((l) => recommend(l, opts));
}

/** The dual-price menu the seller publishes (deck slide 6 box 2). */
export function dualPriceMenu(listing, opts = {}) {
  const f = opts.floor || computeFloor(listing.sku.key, listing.costOverrides || {});
  const p = listing.price;
  return {
    floor: f.F,
    noReturnFloor: f.Fno,
    easyReturns: { price: p, profitPerKeptOrder: r2(p - f.F) },
    noReturn: { price: p - f.gap, profitPerKeptOrder: r2(p - f.gap - f.Fno) },
    gap: f.gap,
    returnCostPerKeptOrder: f.Cret,
    gapMinusReturnCost: r2(f.gap - f.Cret),
    gapEqualsReturnCost: f.Cret,
    gapNote: `The gap is computed from the return cost a no-return buyer never triggers (C_ret ${'₹'}${f.Cret}), rounded to a ${'₹'}10 step -> ${'₹'}${f.gap}. It is a knife-edge: because of that rounding the no-return side is ${'₹'}${r2((p - f.gap - f.Fno) - (p - f.F))} per kept order better, exactly as the deck's own box shows (${'₹'}309 + ${'₹'}60 easy vs ${'₹'}277 + ${'₹'}62 no-return).`,
    engineBuffer: f.B,
    publishedThrough: 'Meesho\'s existing dual-pricing field',
    note: 'The gap goes to the buyer; the seller\'s ₹ per kept order is unchanged and returns fall (deck slide 8: -1.8 pp from dual pricing).',
    shareAssumption: ENGINE.SHARE_NO_RETURN_PICK,
  };
}
