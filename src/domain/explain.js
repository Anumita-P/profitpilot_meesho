/**
 * MACHINE-READABLE EXPLAINABILITY (v2 phase 7).
 *
 * Every recommendation carries a structured explanation assembled from what the
 * engine actually computed - the diagnosis, the counterfactual, the inventory
 * state, the promotion, the portfolio, the guardrails - plus one plain sentence
 * for the seller (English and Hinglish, using the same evidence).
 *
 * The object is deliberately boring and checkable:
 *
 *   {
 *     decision, primary_bottleneck, confidence, evidence[],
 *     counterfactual_summary, recommended_action, price_action,
 *     seller_text: { en, hinglish },
 *     evidence_links: { ...where each claim came from... }
 *   }
 *
 * TWO RULES:
 *   1. Nothing is hardcoded per SKU. Every field is a function of the analysis
 *      passed in; the same listing with different signals produces a different
 *      explanation, and a test asserts that.
 *   2. Confidence is CATEGORICAL (high | medium | low). No made-up probabilities:
 *      a number here would imply a calibration nobody has measured.
 */

import { listing, hydrate } from '../store/db.js';

export const CONFIDENCE = ['low', 'medium', 'high'];
export const DECISIONS = ['CHANGE_PRICE', 'CHANGE_PROMOTION', 'HOLD', 'DO_NOTHING'];

/** Short, stable evidence tags derived from the diagnosis signals (not raw numbers). */
export function evidenceTags(diagnosis) {
  const s = diagnosis.signals || {};
  const tags = [];
  if (s.impressions_healthy) tags.push('healthy_impressions');
  if (s.impressions_low) tags.push('low_impressions');
  if (s.ctr_weak) tags.push('low_click_through');
  if (!s.ctr_weak && s.impressions_healthy) tags.push('healthy_click_through');
  if (s.conversion_weak) tags.push('low_conversion');
  if (!s.conversion_weak) tags.push('normal_conversion');
  if (s.price_out_of_position) tags.push('price_out_of_position');
  else tags.push('normal_price_competitiveness');
  if (s.returns_hot) tags.push('returns_above_category');
  if (s.rto_hot) tags.push('rto_above_category');
  if (s.delivery_slow) tags.push('delivery_slower_than_promise');
  if (diagnosis.inventory?.state?.key) tags.push(`inventory_${String(diagnosis.inventory.state.key).toLowerCase()}`);
  if (s.promotion_active) tags.push('active_promotion_present');
  if (s.promotion_contradiction) tags.push('promotion_already_discounted');
  if (diagnosis.category === 'MIXED_UNCERTAIN') tags.push('multiple_signals');
  return tags;
}

/** 'PRICE' -> 'price', 'RETURN_RTO' -> 'return_rto' */
const snake = (x) => String(x).toLowerCase();

/**
 * Summarise the counterfactual in words the seller can act on, WITHOUT claiming a
 * number that has not happened.
 */
export function counterfactualSummary(cf, live) {
  if (!cf) {
    return {
      price_cut_expected_value: 'not evaluated',
      price_raise_expected_value: 'not evaluated',
      why: 'no counterfactual was run: price is not the bottleneck for this listing',
      best_candidate: null,
    };
  }
  const rows = (cf.candidates || []).filter((r) => r.guardrails.eligible);
  const cuts = rows.filter((r) => r.candidate < live);
  const raises = rows.filter((r) => r.candidate > live);
  const liveRow = cf.candidates.find((r) => r.candidate === live) || null;
  const bestCut = cuts.sort((a, b) => b.expected_value.value - a.expected_value.value)[0] || null;
  const bestRaise = raises.sort((a, b) => b.expected_value.value - a.expected_value.value)[0] || null;

  const grade = (best, base) => {
    if (!best) return 'n/a';
    if (!base) return 'unknown';
    const deltaPct = base.expected_value.value ? ((best.expected_value.value - base.expected_value.value) / Math.abs(base.expected_value.value)) * 100 : 0;
    if (deltaPct <= 0) return 'low';
    if (deltaPct < 2) return 'medium';
    return 'high';
  };

  return {
    price_cut_expected_value: grade(bestCut, liveRow),
    price_raise_expected_value: grade(bestRaise, liveRow),
    best_cut: bestCut ? { price: bestCut.candidate, expected_contribution: bestCut.expected_value.value, guarded: true } : null,
    best_raise: bestRaise ? { price: bestRaise.candidate, expected_contribution: bestRaise.expected_value.value, guarded: true } : null,
    live_candidate: liveRow ? { price: liveRow.candidate, expected_contribution: liveRow.expected_value.value, contribution_per_kept_order: liveRow.economics.contribution_per_kept_order } : null,
    why: bestCut || bestRaise
      ? 'graded from the eligible candidates only: every price in the grid carries the same guardrails, so a sub-floor candidate can never be the "good news"'
      : 'no eligible candidate on the grid: the guardrails block every modelled move right now',
  };
}

/** The decision word: what the system is actually proposing to do. */
export function decide({ diagnosis, counterfactual, guardrail }) {
  const pa = diagnosis.price_action;
  const cfRec = counterfactual?.recommendation || null;
  const contradiction = counterfactual?.promotion_check?.contradictory;
  if (contradiction) return 'CHANGE_PROMOTION';
  if (pa === 'EVALUATE' && cfRec && cfRec.price_action !== 'HOLD') return 'CHANGE_PRICE';
  if (pa === 'EVALUATE' && cfRec && cfRec.price_action === 'HOLD') return 'HOLD';
  if (guardrail?.blocking?.length) return 'HOLD';
  if (pa === 'HOLD' || pa === 'HOLD_FIRST') return 'HOLD';
  return 'DO_NOTHING';
}

/**
 * Build the explanation.
 * @param {object} args { diagnosis, counterfactual, guardrail, portfolio }
 */
export function build({ diagnosis, counterfactual = null, guardrail = null, portfolio = null, existingBranches = null }) {
  const raw = listing(diagnosis.listing_id);
  const L = hydrate(raw);
  const live = raw.price;
  const cfSummary = counterfactualSummary(counterfactual, live);
  const decision = decide({ diagnosis, counterfactual, guardrail });
  const tags = evidenceTags(diagnosis);

  const priceAction = (() => {
    if (decision === 'CHANGE_PRICE') return counterfactual.recommendation.price_action === 'RAISE' ? 'raise' : 'reduce';
    if (diagnosis.price_action === 'EVALUATE') return 'evaluate';
    return 'none';
  })();

  const explanation = {
    listing_id: diagnosis.listing_id,
    sku: raw.skuKey,
    at: new Date().toISOString(),
    decision,
    primary_bottleneck: snake(diagnosis.category),
    primary_bottleneck_label: diagnosis.category_label,
    secondary_bottlenecks: (diagnosis.secondary || []).map(snake),
    confidence: CONFIDENCE.includes(diagnosis.confidence) ? diagnosis.confidence : 'low',
    confidence_kind: 'categorical (low | medium | high) - no probability is claimed, because no calibration has been measured',
    evidence: tags,
    evidence_detail: (diagnosis.evidence || []).map((e) => ({ key: e.key, value: e.value, reading: e.reading })),
    counterfactual_summary: cfSummary,
    recommended_action: diagnosis.recommended_action.key,
    recommended_action_line: diagnosis.recommended_action.line,
    price_action: priceAction,
    guardrail_result: guardrail ? { pass: guardrail.pass !== false && !(guardrail.blocking || []).length, blocking: (guardrail.blocking || []).map((c) => c.key || c) } : null,
    inventory: diagnosis.inventory?.state || null,
    promotion: diagnosis.promotion || null,
    portfolio: portfolio
      ? {
        net_portfolio_impact: portfolio.portfolio?.net ?? null,
        cannibalisation_risk: portfolio.portfolio?.cannibalisation_risk || 'none',
        line: portfolio.portfolio?.line || null,
      }
      : null,
    evidence_links: {
      signals: 'src/store/db.js hydrate() -> listing signals (observed events + category priors)',
      classification: 'src/domain/bottleneck.js analyse()',
      branches: 'src/engine/diagnose.js (unchanged)',
      counterfactual: counterfactual ? 'src/domain/counterfactual.js grid()' : null,
      inventory: 'src/domain/inventory.js stateOf()',
      promotion: 'src/domain/promotion.js composePrice()',
      portfolio: portfolio ? 'src/domain/portfolio.js impactOfMove()' : null,
      guardrails: guardrail ? 'src/engine/guardrails.js preflight() (unmodified)' : null,
    },
    seller_text: sellerText({ diagnosis, decision, cfSummary, portfolio, decision_existing: existingBranches }),
    note: 'Generated from the engine outputs above. Nothing in this object is written per SKU by hand.',
  };
  return explanation;
}

/**
 * One sentence a seller can act on, in English and Hinglish. The claim is tied to
 * the evidence that produced it: if the evidence is thin, the sentence says so.
 */
export function sellerText({ diagnosis, decision, cfSummary, portfolio }) {
  const cat = diagnosis.category;
  const inv = diagnosis.inventory?.state?.key || null;
  const promoLine = diagnosis.promotion?.active ? ' Aapke paas ek promotion chal rahi hai, isliye price aur kam karne se pehle usko dekhein.' : '';

  const en = {
    PRICE: `Price is the bottleneck here (${cfSummary.price_cut_expected_value === 'low' ? 'and the model does not expect a cut to pay' : 'and the model expects a controlled move to pay'}). ${cfSummary.why}`,
    CATALOGUE: 'Your product is getting views, but shoppers are not clicking. The stronger bottleneck appears to be catalogue quality rather than price, so improve the main image, title and product information first.',
    DEMAND: inv === 'NEW'
      ? 'The listing is new: it needs traffic and a few weeks of signals before a price decision means anything. Do not optimise price yet.'
      : 'The problem is impressions, not price: fewer shoppers are seeing this listing than comparable ones. Fix category mapping and attributes before discounting.',
    FULFILMENT: 'Delivery is slower than your promise. Discounting now would only buy more orders into a slow pipeline - fix dispatch and packaging first.',
    RETURN_RTO: 'Returns and RTO are the bottleneck, not the price. Fix sizing information, photos and COD handling before changing price: a discount would multiply the same problem.',
    INVENTORY: diagnosis.inventory?.stance?.why || 'Inventory is the bottleneck: the stock position decides the price stance here.',
    PROMOTION: 'A promotion is already giving shoppers most of the discount a price cut would. Change the promotion or leave both alone rather than discounting twice.',
    MIXED_UNCERTAIN: 'More than one thing is broken at once (see the evidence list). Fix the operational cause first; a price move would be a guess.',
  }[cat] || 'No action is justified by the current evidence.';

  const hinglish = {
    PRICE: cfSummary.price_cut_expected_value === 'low'
      ? 'Price yahan asli problem hai, lekin model ke hisaab se sirf price ghataane se fayda nahi milega. Pehle contribution per kept order dekhein, phir chhota step lein.'
      : 'Price yahan bottleneck hai. Model ek controlled step ka fayda dikha raha hai - par floor aur +/-8% rule hamesha lagu rahenge.',
    CATALOGUE: 'Price mat badhaiye/ghataiye abhi. Views aa rahe hain, par click nahi ho raha - problem catalogue quality lag rahi hai. Main image, title aur product information pehle sudhaarein.',
    DEMAND: inv === 'NEW'
      ? 'Listing nayi hai. Pehle 3-4 hafte ka traffic jama karein, tab price ka faisla karein.'
      : 'Problem price nahi, impressions hain - ke kam log ye listing dekh rahe hain. Category aur attributes theek karein, discount baad mein.',
    FULFILMENT: 'Delivery waade se dheemi hai. Ab discount dene se sirf dheemi pipeline mein zyada order aayenge - pehle dispatch/packaging theek karein.',
    RETURN_RTO: 'Returns aur RTO asli problem hain, price nahi. Size chart, photos aur COD handling pehle theek karein - warna discount se wahi problem badh jayegi.',
    INVENTORY: diagnosis.inventory?.stance?.why || 'Inventory position hi yahan price stance decide karti hai.',
    PROMOTION: `Promotion pehle se discount de rahi hai - price bhi ghataane ka matlab hai double discount. Promotion badlein ya dono ko chhodein.${promoLine}`,
    MIXED_UNCERTAIN: 'Ek saath do problem hain. Pehle operational wali theek karein, price baad mein - warna guess hoga.',
  }[cat] || 'Abhi ke evidence se koi action justify nahi hota.';

  const portfolioNote = portfolio?.portfolio?.cannibalisation_risk && portfolio.portfolio.cannibalisation_risk !== 'none'
    ? ` Note: part of this gain may just move demand from another of your own listings (estimated overlap, not a certainty).`
    : '';

  return {
    en: en + portfolioNote,
    hinglish: hinglish + (portfolioNote ? ' Dhyan dein: iska kuch hissa aapki doosri listing se demand kheench sakta hai (estimated overlap).' : ''),
    decision,
    evidence_backed: (diagnosis.evidence || []).length > 0,
    caveat: diagnosis.confidence === 'low'
      ? 'Confidence is low: this is what the current evidence supports, not a settled conclusion.'
      : null,
  };
}
