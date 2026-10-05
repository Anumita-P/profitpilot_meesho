# Deck fidelity — what the backend reproduces, and where it deliberately differs

This backend exists to serve the ProfitPilot 1.0 prototype with the deck's own
engine. This document says, claim by claim, what is reproduced, how it is proven,
and every place where the code does something the slides do not literally say.

**Proven automatically, not by reading:**

| check | command | what it proves |
|---|---|---|
| `npm test` | `node --test test/parity.test.js test/engine.test.js` | 77 tests (13 parity + 64 engine). The parity suite extracts the **prototype's own engine** out of `reference/index.v1.1.original.html`, runs it in isolation, and compares it with the backend field by field: floors (24 fields × 5 SKUs), cost-input overrides, the six sensitivity levers, demand and profit per day across 9 prices × 5 SKUs, mode prices (5 SKUs × 4 modes), the six pre-flight checks (labels, `ok`, `na` **and** the exact detail strings), and the weekly recommendation (5 SKUs × 4 modes). |
| `npm run smoke` | `node scripts/smoke-routes.mjs` | calls 61 of the 62 routes (all but the destructive reset) and fails on anything 5xx. |
| `npm run test:ui` | `node test/ui-smoke.mjs` | boots the wired page in a headless DOM against the live server, walks all 12 screens, accepts a card (price really moves on the server), undoes it, and checks that a below-floor publish is refused with the guardrail sheet. |

## 1. Slide by slide

| Deck (Meesho DICE S3 · Fiery Diamonds) | Backend | Reproduced |
|---|---|---|
| **Slide 2 box 1** 100 placed → 97 dispatched → 89 delivered → 78 kept | `src/engine/floor.js` | `9702` carried through; kurti: `100 → 97 → 8 RTO → 89 → 11 returned → 78`, `k = 0.78` |
| **Slide 2 box 2** `F = C_s + C_pack + C_fwd + C_ret + C_RTO + other`, `P* = F ÷ (1 − m)` | `floor.js` `computeFloor`, `priceAtMargin` | kurti `180 + 10 + 25 + 32 + 18 + 44 = ₹309`; `309 ÷ 0.85 = ₹364` |
| **Slide 2 box 1/3** the five category floors | `config/deck.js` + `floor.js` | `₹309 / ₹346 / ₹166 / ₹266 / ₹367` — exactly the deck's table |
| **Slide 2 box 2** sensitivity: sourcing +₹30, returns +₹25, weight +₹20, RTO +₹18, COD +₹15, ads +₹12 | `floor.js` `sensitivity` (route `/api/skus/:key/floor/sensitivity`) | `+40 / +27 / +20 / +17 / +15 / +13` — five of six inside the deck's rounding, sourcing differs (see §2.1) |
| **Slide 2 box 5** dual pricing: `P_easy = F + T`, `P_no = F − C_ret + T`, gap ≈ C_ret, >30% pick no-return, ~10% fewer returns | `floor.js`, `recommend.js` `dualPriceMenu`, `config/deck.js` (`SHARE_NO_RETURN_PICK = 0.30`, `NO_RETURN_RETURN_DROP = 0.10`) | kurti: `₹369 / ₹339`, gap `₹30` vs C_ret `₹32`, and the deck's own box — easy `₹309 + ₹60`, no-return `₹277 + ₹62` — is the engine's arithmetic |
| **Slide 2 box 3** COD share falls as price rises (`₹299: 78% COD, 13.4% RTO`) | `demand.js` `riskMixAtPrice` | the mix is a function of price, so a cut raises RTO exactly as the slide says |
| **Slide 2 box 6** modes: CASH ₹339 · GROWTH ₹369–429 · MARGIN ₹364 · CLEAR ₹319 | `modes.js` `modePrice` | `cash / growth / margin / clear` lead prices for every SKU, with the mode objective and its Why |
| **Slide 3 box 1** cold-start path: prior → comparables → features → risk → matrix → price hypothesis | `launch.js` `launchPlan`, `deckExamples` | Bangalore kurti `F ₹309 + ₹18 margin = ₹327 min → open ₹369, menu ₹369/₹339`; Jaipur hand-block `F ₹429 → ₹549, no discount`; Rajkot lunch box `F ₹346 → ₹449 today, ₹469/₹479 discovery from day 15` |
| **Slide 3 box 2** every input exists on day 0 | `launch.js` + `risk.js` | the plan names each input, its source and its output; nothing needs history |
| **Slide 4 box 1** Bass-like curve `q(t) = 0.04 + 0.86 ÷ (1 + e^(−11(t − 0.3))) − 2.6·max(0, t − 0.62)^1.7` | `lifecycle.js` `orderCurve` | the formula is implemented verbatim (test asserts it to 1e-12) |
| **Slide 4 box 2** stage windows per category (a 60-day kurti is mature, a 60-day lunch box is launching) | `lifecycle.js` `stageWindows`, `classifyStage` | windows scale with the category life (`kurti` 30/60/120/155 days → `lunch` doubles), and the classifier moves on kept-unit trend and DOI, not age alone |
| **Slide 4 box 3/4** triggers, rival test, markdown ladder `≥ F` | `lifecycle.js` `triggers`, `rivalTest`, `priceLadder` | rival hold-vs-match on profit/day; `M1 = ceil9(Pm × 0.92)`, `M2`, `M3 = max(F⁺, ceil9(M2 × 0.92))` |
| **Slide 4 box 5** exits: bundle, markdown, wider reach, B2B, return/donate, park ≈ 2%/month | `lifecycle.js` `exits` | six exits with sell-through, net cash and ₹ recovered per unit; parking is negative by the carry cost |
| **Slide 5 boxes 1–5** diagnose-first tree: visibility → CTR → CVR → returns/RTO → cost, price **last** | `diagnose.js` `diagnose`, `sellerCard` | 8 nodes; the price node runs last; serum: `CTR 2.5% vs 4.0% (z = −1.9)` fires clicks, the fix is the main image, not a discount |
| **Slide 5 box 3** panic brake needs the price–value branch | `guardrails.js` `panicBrake` | a cut without that branch is blocked and the seller gets the Yes/No line |
| **Slide 6 box 3** 8 pre-flight checks, hard floor, ±8% step, 7-day cooldown, ≤2 moves/month, 1,000-view sanity check, 14/28-day revert, Loss Warning | `guardrails.js` `preflight`, `enginePreflight`, `autoRevert`, `lossWarning` | 6 trigger-hygiene + 4 engine-lab checks; a blocked publish returns **409** with every failed check and the Loss Warning (`₹249 loses ₹60 per kept order`) |
| **Slide 6 box 4** Manual → Co-Pilot after 30 orders → Autopilot after 4 accepted wins vs holdout | `guardrails.js` `trustLadder`, `store` (`wins`), `/api/sellers/:id/dashboard` | the ladder is derived from real accepted decisions; it can never unlock the floor |
| **Slide 7 box 1/2** five layers: DATA, FEATURES, MODELS, DECISION, ACTION | `src/engine/*` + `src/store/*` + `src/api/*` | each layer is a module with one job; `/api/meta` publishes the constants and the provenance map |
| **Slide 7 box 3** rules use only SKU-week aggregates, never rival data | `floor.js`, `risk.js` | floors come from the seller's own inputs plus category priors; nothing in the API accepts a competitor's cost or price |
| **Slide 7 box 4** constrained Thompson bandit, arms rotate by day, `w = n / (n + n₀)`, β = −3 | `bandit.js` (routes `/api/engine/bandit*`) | 30 simulated days on the kurti: `₹299 BLOCKED (0 pulls)`, `₹369 104,880`, `₹399 22,800`, `₹429 9,120`; holdout at `₹399`, 6,840 impressions = 5% of traffic |
| **Slide 8 design** 250 vs 250 sellers, 12 weeks, detect ₹10, permanent 5% holdout, stop rules | `pilot.js`, `config/deck.js PILOT` | `n = 251 per arm` with the deck's own formula `2 × (1.96 + 0.84)² × 40² / 10² = 250.88`; two cities, a backup, four stop rules, five roadmap phases |
| **Slide 8 box 5/6** impact: profit/kept order ₹84 → ₹104.5 (+24%), kept orders 28 → 31 (+10%), cohort NMV ₹65 cr → ₹90 cr (+37%) | `pilot.js` `waterfallProfit`, `waterfallKeptOrders`, `cohort` | +24.4% and the deck's own multiplier chain; cohort ₹65.5 cr → ₹90 cr (+37.4%) with the deck's rounded figures returned as `deckClaim` |
| **Slide 9 box 4** city scoring (Surat 4.55, Rajkot 4.10, Tiruppur 3.60 backup) | `pilot.js` `cityRanking` | the weighted 1–5 score with the deck's factors and weights |
| **Slide 10 box 1/2** four programmes and their triggers | `programmes.js` `routeProgramme` | starter pack / fast movers / maker programme / stock recovery, routed from sales history, artisan score, look-alikes and DOI |
| **Slide 10 box 4** ROP `d × L + z·σ·√L`, pooling, packaging audit | `programmes.js` | `84 + 18 = 102 units`, order 170, pooled ₹188 vs ₹210, fragile-kit slab recharge |
| **Slide 10 box 6 / slide 11** legal and privacy guardrails | `config/deck.js` (`PROVENANCE`, `SERVICE`), every response's `_meta`, `scripts/reset-db.js` | SKU-week aggregates only, no shared rival data, no hub-and-spoke, DPDP-shaped retention story, and every payload carries the "illustrative, not real Meesho data" banner |
| **Slide 11 box 1** AI coach with chips, Hindi/English, sources, tap-only money actions | `coach.js` + `/api/coach/*` | 15+ intents in both languages, each answer carries `source`, `confidence` and the live floor; `moneyActionsRequireTap: true`, `neverChangesAnythingItself: true` |

## 2. Deliberate differences (and why)

### 2.1 Sourcing sensitivity: engine +₹40, deck prints +₹30
The floor moves 1:1 with the sourcing input (`C_s` is paid on every kept order),
so `₹180 → ₹220` must move F by ₹40 on the deck's own 12% / 8% priors. The other
five levers land within the deck's rounding. The API returns both numbers
(`dF`, `dF_deck`, `matchesDeck`) instead of hiding the mismatch.

### 2.2 Kept orders: chain 30.55, deck prints 31 (+10%)
Multiplying the deck's own factors (`×1.10 ×1.08 ×0.964 ×84/82 ×0.93`) gives
30.55 = +9.1%. The engine reports the exact chain and returns the deck's rounded
claim as `deckClaim: { to: 31, liftPct: 10 }`.

### 2.3 Cohort NMV: ₹65.5 cr computed, ₹65 cr printed
`5,000 × ₹1.31 L = ₹65.5 cr` and `6,000 × ₹1.50 L = ₹90 cr` → +37.4%, which
rounds to the deck's +37%. The deck's own ₹65 cr / ₹90 cr figures are returned as
`deckClaim` so a judge can quote either.

### 2.4 Profit per adopter: +36.4% (deck: +37%)
`1.24 × 1.10 = 1.364`. Same rounding, reported as a percentage rather than a
multiplier.

### 2.5 Dual-price gap ₹30 vs C_ret ₹32
The deck says "the ₹30 gap is computed from the return cost" and its own box
shows the result (`₹309 + ₹60` easy, `₹277 + ₹62` no-return). The engine follows
the box: the gap is `max(10, 10 × round(C_ret / 10))`, and the ₹2 knife-edge is
disclosed in `gapMinusReturnCost` and in the card's Why.

### 2.6 Exit consent usually lands *above* F
The markdown ladder lives on the margin price (`Pm = F ÷ 0.78`) and steps down
8% at a time, so its last rung sits at ~1.03–1.14 × F; the consent step (0.94 off
that rung) often does not need to break the floor. The response says so
(`aboveFloorInThisCase`), and the recovery floor (variable costs only) is the
guard for the cases where it does. Return/donate and park carry the negative
numbers the deck lists.

### 2.7 Holdout: 5% share, not 5 impressions a day
The prototype simulated a 5-impression daily holdout. The pilot design (slide 8)
specifies a **permanent 5% holdout**, so the engine's day-block traffic model is
`48 blocks × (95 treated + 5 holdout)` and `/api/engine/bandit` reports
`holdoutSharePct: 0.05`.

### 2.8 A single listing cannot reach pilot power — and the code says so
After 30 simulated days the kurti's observed lift is +40.8% with a 95% interval
of `[−47.5%, +129.2%]`: it contains 0. The engine returns `noisy: true`, the
reason (`holdout has 6,840 impressions (>= 2 × n0)`), and the noise-free expected
lift (+8.16%). `claimGuard` refuses any lift claim without a holdout, which is
exactly the deck's "we prove our own lift" promise.

### 2.9 Two levers the prototype could not test
`ads` and `COD` are computed from rate cards in the prototype, so its First-price
screen cannot change them. The backend accepts both as inputs (COD mapped to
+6 pp RTO using the deck's cited Unicommerce failure rates: 20.9% COD vs 5.8%
prepaid) so the deck's two remaining sensitivity levers are testable.

### 2.10 The intelligence layer is the deck's, not a trained model yet
LightGBM, the CLIP-style look-alike encoder and the HMM stage smoother are
implementation choices of the real product. Here they are the deck's specified
priors and update rules behind the same interface: `betaPrior()`, shrinkage
`w = n / (n + n0)`, the penalty term, the risk model and the stage classifier.
Every response names its method, so replacing a rule with a trained model is a
drop-in at the module boundary — no API change, no UI change.

## 3. Non-negotiables the code enforces

1. **Nothing publishes below `F` without an explicit Exit consent** — the floor
   check is server-side (`409` + Loss Warning), not a UI hint.
2. **Every suggestion carries its five Why blocks** (what, why, ₹ effect,
   confidence *with its reason*, undo) — the `recommend()` contract, asserted by
   the tests for all 5 SKUs × 4 modes.
3. **The seller only ever sees ✔ / ✘** — the logic tree is returned for the Why
   sheet the seller can open, never as a decision they must interpret.
4. **No claim without a holdout** (`claimGuard`).
5. **Every number is labelled illustrative** — `_meta` on every response, plus
   the banner in `/api/meta`.
