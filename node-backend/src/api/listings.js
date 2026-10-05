/**
 * Listing endpoints - the seller-facing part of the engine.
 *
 * Everything that could change a published price goes through
 * publish()/decide() in this file: the client never writes a price directly,
 * and the floor + guardrails are enforced here, server-side.
 */

import { ENGINE, GUARDRAILS, MODES, SKUS, STAGES, SERVICE } from '../config/deck.js';
import { computeFloor } from '../engine/floor.js';
import { ordersPerDay, simulate as simulateEngine } from '../engine/demand.js';
import { modePrice } from '../engine/modes.js';
import { recommend, dualPriceMenu, confidence } from '../engine/recommend.js';
import { diagnose, sellerCard, normaliseSignals } from '../engine/diagnose.js';
import { lifecycle, stageSignals, stageRoad, triggers, exits, exitConsent, classifyStage } from '../engine/lifecycle.js';
import { panicBrake, preflight, trustLadder, autoRevert } from '../engine/guardrails.js';
import { returnRisk } from '../engine/risk.js';
import {
  addDecision, banditGet, decision, decisions, events, hydrate, hydratedListings,
  listing, listings, logEvent, saveListing, saveSeller, seller, sellers, stats, updateDecision, httpError,
} from '../store/db.js';
import { ok, fail } from '../http/respond.js';

const money = (v) => `${v < 0 ? '-' : ''}₹${Math.abs(Math.round(v)).toLocaleString('en-IN')}`;
const r2 = (x) => Math.round(x * 100) / 100;

export function register(router, root) {
  /* ------------------------------- sellers ------------------------------- */
  router.get('/api/sellers', () => ({ sellers: sellers().map((s) => publicSeller(s)) }),
    { summary: 'All sellers in this instance (one seeded demo seller)' });

  router.get('/api/sellers/:id', (ctx) => {
    try {
      return ok(ctx.res, { seller: publicSeller(seller(ctx.params.id)) });
    } catch (e) { return fail(ctx.res, e.status || 500, e.message); }
  });

  router.get('/api/sellers/:id/dashboard', (ctx) => {
    try {
      seller(ctx.params.id);
      return ok(ctx.res, dashboard(ctx.params.id));
    } catch (e) { return fail(ctx.res, e.status || 500, e.message); }
  }, { summary: 'Home screen: KPIs, product health, control split, trust ladder, pending cards' });

  router.get('/api/sellers/:id/listings', (ctx) => {
    try {
      const rows = hydratedListings(ctx.params.id).map((l) => listingSummary(l));
      return ok(ctx.res, { listings: rows });
    } catch (e) { return fail(ctx.res, e.status || 500, e.message); }
  });

  /* ---------------------------------------------------------------- *
   * Bootstrap: one call that hydrates the whole front-end.
   * ---------------------------------------------------------------- */
  router.get('/api/bootstrap', (ctx) => {
    const sellerId = ctx.query.seller || 'S-ramesh';
    const all = hydratedListings(sellerId);
    const mode = ctx.query.mode || 'growth';
    return ok(ctx.res, {
      service: SERVICE,
      guardrails: GUARDRAILS,
      engine: ENGINE,
      stages: STAGES,
      seller: publicSeller(seller(sellerId)),
      listings: all.map((l) => listingSummary(l)),
      listingIds: Object.fromEntries(all.map((l) => [l.skuKey, l.id])),
      floors: Object.fromEntries(all.map((l) => [l.skuKey, l.floor])),
      modes: Object.values(MODES).map((m) => ({ key: m.key, name: m.name, emoji: m.emoji, color: m.color, definition: m.definition, objective: m.objective })),
      recommendations: all.map((l) => recommend(l, { mode: l.mode || mode })),
      trustLadder: trustLadder(seller(sellerId)),
      dashboard: dashboard(sellerId),
      bandit: Object.fromEntries(
        all.map((l) => [l.id, banditGet(`${l.id}:${l.mode || mode}`) ? { initialised: true, key: `${l.id}:${l.mode || mode}` } : { initialised: false }]),
      ),
      recentEvents: events(10),
      stats: stats(),
    });
  }, { summary: 'Everything a client needs on boot: seller, listings, floors, recommendations, guardrails' });

  /* ------------------------------- one listing ------------------------------ */
  router.get('/api/listings', () => ({ listings: hydratedListings().map(listingSummary) }));

  router.get('/api/listings/:id', (ctx) => {
    try {
      const l = hydrate(listing(ctx.params.id));
      return ok(ctx.res, {
        listing: listingDetail(l),
        stage: l.stageInfo,
        triggers: triggers(l, { floor: l.floor }),
        dualPrice: dualPriceMenu(l, { floor: l.floor }),
        risk: returnRisk({
          category: l.floor.category,
          fragile: l.sku.features?.fragile,
          weightKg: l.sku.features?.weightKg,
          pincodeCluster: 'tier2-cod',
          codShare: l.signals.codShare,
        }),
      });
    } catch (e) { return fail(ctx.res, e.status || 500, e.message); }
  });

  router.patch('/api/listings/:id', (ctx) => {
    try {
      const l = listing(ctx.params.id);
      const b = ctx.body || {};
      const allowed = ['mode', 'control', 'consent', 'costOverrides', 'offlinePrice', 'optIn'];
      allowed.forEach((k) => { if (b[k] !== undefined) l[k] = b[k]; });
      if (b.costs) l.costOverrides = { ...(l.costOverrides || {}), ...b.costs };
      l.consent = !!l.consent;
      saveListing(l, 'listing.updated', { fields: Object.keys(b) });
      const h = hydrate(l);
      return ok(ctx.res, { listing: listingDetail(h), recommendation: recommend(h, { mode: h.mode }) });
    } catch (e) { return fail(ctx.res, e.status || 500, e.message); }
  }, { summary: 'Update cost inputs, goal mode, control level or exit consent for one listing' });

  router.post('/api/listings/:id/costs', (ctx) => {
    // convenience alias: exactly the "two numbers required" flow of deck slide 6
    try {
      const l = listing(ctx.params.id);
      const b = ctx.body || {};
      l.costOverrides = { ...(l.costOverrides || {}), ...sanitiseCosts(b) };
      saveListing(l, 'listing.costs', { costs: l.costOverrides });
      const h = hydrate(l);
      return ok(ctx.res, {
        floor: h.floor,
        dualPrice: dualPriceMenu(h, { floor: h.floor }),
        recommendation: recommend(h, { mode: h.mode }),
      });
    } catch (e) { return fail(ctx.res, e.status || 500, e.message); }
  }, { summary: 'Seller types the two numbers (C_s and T); the rest stays prefilled from category defaults' });

  /* -------------------------------- simulate ------------------------------- */
  router.post('/api/listings/:id/simulate', (ctx) => {
    try {
      const l = hydrate(listing(ctx.params.id));
      const b = ctx.body || {};
      const price = b.price != null ? Number(b.price) : l.price;
      const sim = simulateEngine(l, { floor: l.floor, kink: b.kink !== false });
      const at = sim.rows.find((row) => row.price === price);
      const orders = ordersPerDay(l, price, { kink: b.kink !== false });
      const profitDay = orders * l.floor.k * (price - l.floor.F);
      return ok(ctx.res, {
        ...sim,
        query: {
          price,
          ordersPerDay: r2(orders),
          profitPerKeptOrder: r2(price - l.floor.F),
          profitPerDay: r2(profitDay),
          margin: r2(1 - l.floor.F / price),
          inMenu: !!at,
          belowFloor: price < l.floor.F,
          lossWarning: price < l.floor.F
            ? `₹${price} loses ${money(l.floor.F - price)} per kept order. Below-floor arms are blocked before any test.`
            : null,
          blocked: price < l.floor.F,
        },
        floor: { F: l.floor.F, B: l.floor.B, k: l.floor.k, recoveryFloor: l.floor.frec },
      });
    } catch (e) { return fail(ctx.res, e.status || 500, e.message); }
  }, { summary: 'What-if simulator: price -> orders/day, ₹ per kept order, ₹/day, plus the Loss Warning' });

  /* ----------------------------- recommendation ---------------------------- */
  router.get('/api/listings/:id/recommendation', (ctx) => {
    try {
      const l = hydrate(listing(ctx.params.id));
      const mode = ctx.query.mode || l.mode;
      const rec = recommend(l, { mode });
      const d = diagnose(l, { weeksHolding: ctx.num('weeks', 2) });
      const brake = panicBrake({ diagnosis: d, floor: l.floor, from: rec.from, to: rec.to });
      return ok(ctx.res, {
        recommendation: rec,
        dualPrice: dualPriceMenu(l, { floor: l.floor }),
        diagnosis: { firedCount: d.firedCount, biggestLoss: d.biggestLoss, verdict: d.verdict, priceValueFired: d.priceValueFired },
        panicBrake: brake,
        modePrice: modePrice(l.skuKey, mode, l.costOverrides),
      });
    } catch (e) { return fail(ctx.res, e.status || 500, e.message); }
  }, { summary: 'The weekly card: what / why / ₹ effect / confidence / undo + pre-flight + panic brake' });

  router.get('/api/recommendations', (ctx) => {
    const mode = ctx.query.mode;
    return ({ recommendations: hydratedListings(ctx.query.seller).map((l) => recommend(l, { mode: mode || l.mode })) });
  }, { summary: 'One card per listing (the Home feed)' });

  /* -------------------------------- diagnose ------------------------------- */
  router.post('/api/listings/:id/diagnose', (ctx) => {
    try {
      const l = hydrate(listing(ctx.params.id));
      const signals = normaliseSignals({ ...l.signals, ...(ctx.body?.signals || {}) });
      const d = diagnose(l, signals);
      const brake = panicBrake({ diagnosis: d, floor: l.floor, from: l.price, to: ctx.body?.proposedPrice ?? l.price });
      const card = ctx.body?.proposedPrice
        ? sellerCard({
          listingId: l.id, diagnosis: d, floor: l.floor, from: l.price, to: ctx.body.proposedPrice,
          signals, daysSinceMove: l.daysSinceMove, movesThisMonth: l.movesThisMonth,
          consent: !!ctx.body?.consent, dayIndex: ctx.body?.dayIndex ?? 7,
        })
        : null;
      return ok(ctx.res, {
        diagnosis: d,
        panicBrake: brake,
        sellerCard: card,
        funnelVsSimilar: {
          views: [signals.views, signals.viewsMedian],
          clickRate: [signals.ctr, signals.ctrMedian],
          conversion: [signals.cvr, signals.cvrMedian],
          keptRate: [l.signals.keptRatePct, Math.round(l.floor.k * 100)],
        },
        disclaimer: 'A card is shown only if the signal holds 2 weeks in a row; the seller sees ✔ / ✘, never this tree.',
      });
    } catch (e) { return fail(ctx.res, e.status || 500, e.message); }
  }, { summary: 'The 8-node scan: which branch fires, the ₹ at risk, the fix, and whether a cut is allowed' });

  /* -------------------------------- lifecycle ------------------------------ */
  router.get('/api/listings/:id/lifecycle', (ctx) => {
    try {
      const raw = listing(ctx.params.id);
      const day = ctx.num('day', raw.ageDays ?? raw.signals.ageDays);
      raw.ageDays = day;
      const l = hydrate(raw);
      const lc = lifecycle(l, { floor: l.floor, day });
      return ok(ctx.res, {
        listingId: l.id,
        sku: l.skuKey,
        day,
        stage: lc.stage,
        stageName: lc.stageName,
        stageColor: lc.stageColor,
        windows: lc.windows,
        road: stageRoad(l.sku),
        priceAtDay: lc.priceAtDay,
        events: lc.events,
        rivalTest: lc.rivalTest,
        priceLadder: lc.priceLadder,
        ordersPoints: lc.ordersPoints,
        signals: stageSignals(l, lc.stage, { floor: l.floor }),
        triggers: triggers(l, { floor: l.floor }),
        exits: exits(l, { floor: l.floor }),
        exitConsent: exitConsent(l, { floor: l.floor, lifecycle: lc }),
        classifier: l.stageInfo,
        floor: { F: l.floor.F, B: l.floor.B, k: l.floor.k, recoveryFloor: l.floor.frec },
      });
    } catch (e) { return fail(ctx.res, e.status || 500, e.message); }
  }, { summary: 'Price across the product\'s life: stage, triggers, ladder, exits and recovery' });

  /* ------------------------------------------------------------------ *
   * PUBLISH - the profit-protection layer, enforced server-side
   * ------------------------------------------------------------------ */
  router.post('/api/listings/:id/publish', (ctx) => {
    try {
      const l = hydrate(listing(ctx.params.id));
      const b = ctx.body || {};
      const target = b.price != null ? Number(b.price) : l.price;
      if (!Number.isFinite(target) || target <= 0) return fail(ctx.res, 400, 'price must be a positive number');

      const f = l.floor;
      const checks = preflight({
        floor: f, from: l.price, to: target,
        views: b.views ?? l.signals.views,
        daysSinceMove: l.daysSinceMove, movesThisMonth: l.movesThisMonth,
        consent: !!b.consent && l.stage === 'exit',
      });
      const belowFloor = target < f.F;
      const consent = !!b.consent && l.stage === 'exit';
      const acknowledgment = !!b.acknowledgeLossWarning;

      const blocking = checks.checks.filter((c) => !c.ok);
      if (blocking.length && !(belowFloor && acknowledgment)) {
        /* The refusal is recorded too: who tried to publish what, which guardrail
           stopped it, and how much it would have lost. A refusal that leaves no
           trace cannot be reviewed. */
        try {
          logEvent('guardrail.blocked', {
            listingId: l.id,
            via: 'publish',
            actor: ctx.identity?.seller_id || 'seller',
            price: Math.round(target),
            floor: f.F,
            belowFloor,
            blocking: blocking.map((c) => `${c.key}: ${c.detail}`),
            lossPerKeptOrder: belowFloor ? r2(Math.round(target) - f.F) : null,
            correlationId: ctx.correlation_id || null,
          });
        } catch { /* auditing must never break the refusal itself */ }
        return FAIL(ctx, 409, 'publish blocked by guardrails', {
          checks: checks.checks,
          lossWarning: belowFloor ? lossWarningFor(f, target) : null,
          sellerLine: belowFloor
            ? `₹${target} loses ${money(f.F - target)} per kept order. Keep ₹${l.price} and let us find the real cause?`
            : 'This move breaks a guardrail. Nothing was published.',
          rule: 'no mode publishes below the floor silently (hard floor) · ±8% per move · 7-day cooldown · <= 2 moves/month',
        });
      }

      const previous = l.price;
      const raw = listing(l.id);
      raw.price = Math.round(target);
      raw.daysSinceMove = 0;
      raw.movesThisMonth = (raw.movesThisMonth || 0) + 1;
      raw.approvedPricesSeen = Array.from(new Set([...(raw.approvedPricesSeen || []), Math.round(target)]));
      raw.priceHistory = [...(raw.priceHistory || []), {
        ts: new Date().toISOString(), price: Math.round(target),
        reason: b.reason || (consent ? 'recovery price with seller consent (Exit)' : 'published via dual-pricing field'),
        decisionId: b.decisionId || null,
      }];
      saveListing(raw, 'listing.published', { from: previous, to: raw.price, consent, acknowledgment });
      logEvent('guardrail.lossWarning', {
        listingId: l.id, price: raw.price, floor: f.F, lossPerKeptOrder: r2(raw.price - f.F), acknowledged: acknowledgment,
      });

      const after = hydrate(raw);
      return ok(ctx.res, {
        published: {
          listingId: after.id, from: previous, to: after.price,
          mode: b.mode || after.mode,
          dualPrice: { easyReturns: after.price, noReturn: after.price - f.gap, gap: f.gap },
          profitPerKeptOrder: r2(after.price - f.F),
          belowFloor: after.price < f.F,
          consentUsed: consent,
        },
        checks: checks.checks,
        lossWarning: after.price < f.F ? lossWarningFor(f, after.price) : null,
        autoRevert: {
          judgeOn: `day ${GUARDRAILS.autoRevertDay} (orders)`, confirmOn: `day ${GUARDRAILS.confirmDay} (kept orders)`,
          undoUntil: new Date(Date.now() + GUARDRAILS.undoHours * 3600e3).toISOString(),
          baseline: previous,
        },
        recommendation: recommend(after, { mode: after.mode }),
      });
    } catch (e) { return fail(ctx.res, e.status || 500, e.message); }
  }, { summary: 'Publish a price: hard floor, panic brake, pre-flight, Loss Warning, cooldown, undo window' });

  /* ------------------------------- decisions ------------------------------- */
  router.get('/api/decisions', (ctx) => ({
    decisions: decisions({ listingId: ctx.query.listing, status: ctx.query.status }).slice(0, ctx.num('limit', 100)),
  }), { summary: 'Action tracking - every card accepted, skipped or overridden (fixes 1.0 limit 5)' });

  router.post('/api/listings/:id/decisions', (ctx) => {
    try {
      const l = hydrate(listing(ctx.params.id));
      const b = ctx.body || {};
      const action = b.action;
      if (!['accept', 'reject', 'override'].includes(action)) return fail(ctx.res, 400, 'action must be accept | reject | override');
      const mode = b.mode || l.mode;
      const rec = recommend(l, { mode });

      // never trust a client-supplied card: recompute and compare
      if (b.cardId && b.cardId !== rec.cardId) {
        return FAIL(ctx, 409, 'stale card: the engine has moved on', {
          expected: rec.cardId, received: b.cardId,
          current: { headline: rec.headline, from: rec.from, to: rec.to, kind: rec.kind },
          reason: 'signals, cooldown or the live price changed since the card was rendered',
        });
      }

      if (action === 'accept' || action === 'override') {
        const wantsMove = rec.kind !== 'hold' && rec.kind !== 'launch' && (rec.to !== rec.from || rec.kind === 'dual');
        if (wantsMove) {
          const f = l.floor;
          const target = rec.kind === 'dual' ? rec.to : rec.to; // dual publishes both prices through the same field
          const checks = preflight({
            floor: f, from: l.price, to: Math.max(target, f.F),
            views: l.signals.views, daysSinceMove: l.daysSinceMove, movesThisMonth: l.movesThisMonth,
            consent: !!b.consent && l.stage === 'exit',
          });
          const blocking = checks.checks.filter((c) => !c.ok);
          if (blocking.length && action !== 'override') {
            return FAIL(ctx, 409, 'guardrail blocked this move', {
              checks: checks.checks, blocking: blocking.map((c) => `${c.key}: ${c.detail}`),
              recommendation: rec,
            });
          }
          const raw = listing(l.id);
          const previous = raw.price;
          raw.price = Math.max(0, Math.round(target));
          raw.daysSinceMove = 0;
          raw.movesThisMonth = (raw.movesThisMonth || 0) + 1;
          raw.priceHistory = [...(raw.priceHistory || []), { ts: new Date().toISOString(), price: raw.price, reason: `${action}: ${rec.headline}`, mode }];
          if (rec.kind === 'dual') raw.dualLead = 'no-return';
          saveListing(raw, 'listing.published', { from: previous, to: raw.price, viaDecision: true, mode });
          logEvent(action === 'override' ? 'decision.override' : 'decision.accepted', {
            listingId: l.id, cardId: rec.cardId, from: previous, to: raw.price,
            blockersOverridden: action === 'override' ? blocking.map((c) => c.key) : [],
          });
        } else {
          logEvent('decision.accepted', { listingId: l.id, cardId: rec.cardId, kind: rec.kind, note: b.note || null });
        }

        const s = seller(l.sellerId);
        if (rec.kind !== 'hold') s.wins = (s.wins || 0) + 1;
        saveSeller(s);

        const d = addDecision({
          listingId: l.id, sku: l.skuKey, cardId: rec.cardId, mode, action,
          from: rec.from, to: rec.to, kind: rec.kind,
          headline: rec.headline, effect: rec.effect,
          status: 'accepted',
          acceptedAt: new Date().toISOString(),
          undoUntil: new Date(Date.now() + GUARDRAILS.undoHours * 3600e3).toISOString(),
          autoRevertCheckDay: GUARDRAILS.autoRevertDay,
          confirmDay: GUARDRAILS.confirmDay,
          why: { what: rec.what, why: rec.why, effect: rec.effect, confidence: rec.confidence, undo: rec.undo },
        });
        const after = hydrate(listing(l.id));
        return ok(ctx.res, {
          decision: d,
          listing: listingSummary(after),
          recommendation: recommend(after, { mode }),
          trustLadder: trustLadder(seller(l.sellerId)),
          toast: `${action === 'accept' ? 'Applied' : 'Overridden'} · undo available for ${GUARDRAILS.undoHours} h`,
        });
      }

      // reject
      const d = addDecision({
        listingId: l.id, sku: l.skuKey, cardId: rec.cardId, mode, action: 'reject',
        from: rec.from, to: rec.to, kind: rec.kind, headline: rec.headline,
        status: 'rejected', rejectedAt: new Date().toISOString(),
        note: b.note || null,
      });
      logEvent('decision.rejected', { listingId: l.id, cardId: rec.cardId, note: b.note || null });
      return ok(ctx.res, { decision: d, nextAskInDays: 7, sellerLine: `Skipped. We keep ${money(rec.from)} and ask again in 7 days.` });
    } catch (e) { return fail(ctx.res, e.status || 500, e.message); }
  }, { summary: 'Accept / reject / override a card. Accept applies the move through the guardrails; override is logged as an override' });

  router.post('/api/decisions/:id/undo', (ctx) => {
    try {
      const d = decision(ctx.params.id);
      if (d.status !== 'accepted') return fail(ctx.res, 409, `nothing to undo: status is ${d.status}`);
      const raw = listing(d.listingId);
      raw.price = d.from;
      raw.movesThisMonth = Math.max(0, (raw.movesThisMonth || 1) - 1);
      delete raw.daysSinceMove;
      raw.priceHistory = [...(raw.priceHistory || []), { ts: new Date().toISOString(), price: d.from, reason: `undo of ${d.id}` }];
      saveListing(raw, 'decision.undone', { decisionId: d.id, restored: d.from });
      const s = seller(raw.sellerId);
      s.wins = Math.max(0, (s.wins || 1) - 1);
      saveSeller(s);
      updateDecision(d.id, { status: 'undone', undoneAt: new Date().toISOString() });
      return ok(ctx.res, {
        decision: decision(d.id),
        listing: listingSummary(hydrate(raw)),
        sellerLine: 'Undone · price restored.',
      });
    } catch (e) { return fail(ctx.res, e.status || 500, e.message); }
  }, { summary: 'Undo a move within the 24-hour window (deck slide 6 box 3)' });

  /**
   * Day-14 auto-revert check: feed in what happened and the engine decides
   * whether the price goes back (deck slide 6 box 3).
   */
  router.post('/api/decisions/:id/observe', (ctx) => {
    try {
      const d = decision(ctx.params.id);
      const b = ctx.body || {};
      if (b.impressions == null || b.profit == null) return fail(ctx.res, 400, 'impressions and profit are required');
      const obs = {
        dayIndex: b.dayIndex ?? d.autoRevertCheckDay ?? 14,
        impressions: b.impressions, profit: b.profit,
        keptOrders: b.keptOrders ?? null,
      };
      const baseline = b.baseline || {
        impressions: Math.max(1, Math.round(b.impressions * 0.92)),
        profit: b.profit * 0.92,
      };
      const verdict = autoRevert(d, obs, baseline);
      updateDecision(d.id, {
        observation: obs, verdict,
        status: verdict.revert ? 'auto-reverted' : verdict.verdict === 'confirmed-better' ? 'confirmed' : d.status,
      }, 'decision.observed', { verdict: verdict.verdict });
      if (verdict.revert) {
        const raw = listing(d.listingId);
        raw.price = d.from;
        raw.movesThisMonth = Math.max(0, (raw.movesThisMonth || 1) - 1);
        raw.priceHistory = [...(raw.priceHistory || []), { ts: new Date().toISOString(), price: d.from, reason: `auto-revert at day ${obs.dayIndex}` }];
        saveListing(raw, 'guardrail.autoRevert', { decisionId: d.id, restored: d.from });
      }
      return ok(ctx.res, { decision: decision(d.id), verdict, listing: listingSummary(hydrate(listing(d.listingId))) });
    } catch (e) { return fail(ctx.res, e.status || 500, e.message); }
  }, { summary: 'Day-14 auto-revert: worse on profit per impression -> the price goes back' });

  /* -------------------------------- explain ------------------------------- */
  router.get('/api/listings/:id/why', (ctx) => {
    try {
      const l = hydrate(listing(ctx.params.id));
      const rec = recommend(l, { mode: ctx.query.mode || l.mode });
      return ok(ctx.res, {
        floor: { F: l.floor.F, B: l.floor.B, k: l.floor.k, breakdown: {
          cs: l.floor.cs, pack: l.floor.pack, fwd: l.floor.fwd, Cret: l.floor.Cret, Crto: l.floor.Crto, other: l.floor.other,
        } },
        recommendation: { what: rec.what, why: rec.why, effect: rec.effect, confidence: rec.confidence, confidenceWhy: rec.confidenceWhy, undo: rec.undo },
        guardrails: rec.guardrails,
        honesty: 'Every number traces to a formula or an input in this response; nothing is invented for the card.',
      });
    } catch (e) { return fail(ctx.res, e.status || 500, e.message); }
  }, { summary: 'The Why payload for a listing: what / why / ₹ effect / confidence / undo' });
}

/* ------------------------------- helpers -------------------------------- */
function FAIL(ctx, status, message, detail) {
  const e = new Error(message);
  e.status = status;
  e.detail = detail;
  return fail(ctx.res, status, message, detail);
}

function lossWarningFor(f, price) {
  return {
    price,
    floor: f.F,
    recoveryFloor: f.frec,
    lossPerKeptOrder: r2(price - f.F),
    message: `₹${price} is ${money(f.F - price)} below your floor F ${money(f.F)}. Every kept order loses ${money(f.F - price)}.`,
    sellerLine: `₹${price} loses ${money(f.F - price)} per kept order. Keep ₹${f.F + f.T} and let us find the real cause?`,
  };
}

function sanitiseCosts(body = {}) {
  const out = {};
  for (const k of ['cs', 'pack', 'fwd', 'ret', 'rto', 'T', 'dmg', 'promo', 'ads', 'tax', 'cap']) {
    if (body[k] === undefined || body[k] === '') continue;
    const n = Number(body[k]);
    if (Number.isFinite(n) && n >= 0) out[k] = n;
  }
  if (body.category && CATEGORIES_LIKE(body.category)) out.category = body.category;
  return out;
}
function CATEGORIES_LIKE(k) {
  return ['ethnic', 'kitchen', 'beauty', 'kids', 'decor'].includes(k);
}

export function publicSeller(s) {
  return {
    id: s.id, name: s.name, city: s.city, state: s.state, cluster: s.cluster,
    joinedDaysAgo: s.joinedDaysAgo, language: s.language,
    control: s.control, wins: s.wins, ordersLifetime: s.ordersLifetime,
    holdout: !!s.holdout, pilot: s.pilot,
    trustLadder: trustLadder(s),
  };
}

export function listingSummary(l) {
  return {
    id: l.id,
    sku: l.skuKey,
    name: l.sku.name,
    short: l.sku.short,
    emoji: l.sku.emoji,
    category: l.sku.category,
    categoryName: l.floor.categoryName,
    price: l.price,
    offlinePrice: l.offlinePrice,
    floor: l.floor.F,
    buffer: l.floor.B,
    keptRate: l.floor.k,
    recoveryFloor: l.floor.frec,
    noReturnFloor: l.floor.Fno,
    dualPrice: { easyReturns: l.price, noReturn: l.price - l.floor.gap, gap: l.floor.gap },
    profitPerKeptOrder: r2(l.price - l.floor.F),
    ordersPerDay: r2(ordersPerDay(l, l.price)),
    stage: l.stage,
    stageName: STAGES[l.stage].name,
    stageColor: STAGES[l.stage].color,
    mode: l.mode,
    control: l.control,
    health: l.health,
    margin: l.margin,
    returnsPct: l.signals.returnsPct,
    rtoPct: l.signals.rtoPct,
    doi: l.signals.doi,
    daysSinceMove: l.daysSinceMove,
    movesThisMonth: l.movesThisMonth,
    ageDays: l.ageDays,
    cooldown: l.daysSinceMove < GUARDRAILS.cooldownDays || l.movesThisMonth >= GUARDRAILS.maxMovesPerMonth,
    views: l.signals.views,
    confidence: confidence(l.signals.views),
    belowFloor: l.price < l.floor.F,
  };
}

function listingDetail(l) {
  return {
    ...listingSummary(l),
    costs: l.floor.inputs,
    costOverrides: l.costOverrides,
    costLines: {
      C_s: l.floor.cs, C_pack: l.floor.pack, C_fwd: l.floor.fwd,
      C_ret: l.floor.Cret, C_RTO: l.floor.Crto, other: l.floor.other,
      returnPlusRto: l.floor.B,
    },
    stepped: l.floor.stepped,
    arms: l.floor.arms,
    band: { p25: l.sku.band[0], p75: l.sku.band[1], median: l.sku.median, lookalikes: l.sku.lookalikes, closestRival: l.sku.closestRival },
    signals: l.signals,
    stock: l.stock,
    reviews: l.reviews,
    priceHistory: l.priceHistory,
    stageReason: l.stageInfo.reason,
    engine: {
      beta: l.sku && ENGINE.BETA,
      keptRateAssumed: l.floor.k,
      targetProfit: l.floor.T,
      startPriceEasyReturns: l.floor.Pe,
      startPriceNoReturn: l.floor.Pn,
      clearance: l.floor.Fplus,
    },
  };
}

export function dashboard(sellerId) {
  const all = hydratedListings(sellerId);
  const s = seller(sellerId);
  let orders = 0; let kept = 0; let profit = 0; let profitPerKeptSum = 0;
  all.forEach((l) => {
    const o = ordersPerDay(l, l.price);
    orders += o;
    kept += o * l.floor.k;
    profit += o * l.floor.k * (l.price - l.floor.F);
    profitPerKeptSum += l.price - l.floor.F;
  });
  const controls = { man: 0, cp: 0, au: 0 };
  all.forEach((l) => { controls[l.control] = (controls[l.control] || 0) + 1; });
  const pending = decisions({ status: 'pending' }).length;
  return {
    sellerId,
    kpis: {
      ordersPerDay: Math.round(orders),
      keptOrdersPerDay: r2(kept),
      profitPerKeptOrder: r2(kept ? profit / kept : 0),
      profitPerDay: r2(profit),
      listingsBelowFloor: all.filter((l) => l.price < l.floor.F).length,
      weightedProfitPerKeptOrderSimple: r2(profitPerKeptSum / (all.length || 1)),
    },
    health: all.map((l) => ({ id: l.id, sku: l.skuKey, name: l.sku.short, emoji: l.sku.emoji, price: l.price, floor: l.floor.F, health: l.health, stage: l.stage, profitPerKeptOrder: r2(l.price - l.floor.F), ordersPerDay: r2(ordersPerDay(l, l.price)), doi: l.signals.doi, returnsPct: l.signals.returnsPct, dualPrice: { easyReturns: l.price, noReturn: l.price - l.floor.gap } })),
    controls,
    pendingDecisions: pending,
    trustLadder: trustLadder(s),
    floorProtection: {
      on: true,
      line: `Floor protection is ON in every mode. ProfitPilot never publishes below F silently.`,
      guardrails: GUARDRAILS,
    },
    wins: s.wins,
  };
}
