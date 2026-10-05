# ProfitPilot — the deck's proposals, on a board

Meesho DICE Challenge S3 · Business Track · Team Fiery Diamonds, IIT Madras.

35 proposals from the deck, each with the slide it comes from, what it does, and the artefact that proves it. Cards under **Proposed next** are not built — the roadmap is shown honestly rather than claimed as shipped.

> The seller never asks "what price should I set?" — the system first asks **"what is actually hurting this product?"**

| | |
|---|---|
| 26 shipped & verified | built, served by the API, covered by tests |
| 4 in build | Decision Intelligence v2 pieces still being finished |
| 5 proposed next | deck roadmap — **not** shipped |

The rendered board (self-contained, offline, print-friendly): [`public/kanban.html`](../public/kanban.html) — also served at `http://localhost:8787/kanban.html` when the backend runs.

## Shipped & verified

Built, served by the API, and covered by the test suites.

| # | Proposal | Deck | What it is | Evidence |
|---|---|---|---|---|
| 1 | **Return-adjusted floor engine** | slide 2 · box 1–2 | F = C_s + C_pack + C_fwd + C_ret + C_RTO + other, divided by the kept-order rate k. Every cost is the seller's own input; the floor is never a market guess. | src/engine/floor.js · GET /api/floors · GET /api/skus/:key/floor |
| 2 | **The five category floors, to the rupee** | slide 2 · box 1/3 | ₹309 kurti · ₹346 lunch box · ₹166 serum · ₹266 romper · ₹367 vase. | src/config/deck.js · parity test asserts each |
| 3 | **Dual pricing: easy vs no-return** | slide 2 · box 5 | P_easy = F + T and P_no = F − C_ret + T, the gap ≈ C_ret, with the deck's assumption that >30% pick no-return and ~10% fewer returns come back. | src/engine/recommend.js · dualPriceMenu · kurti ₹369 / ₹339 |
| 4 | **COD share and RTO move with price** | slide 2 · box 3 | The payment mix is a function of price, so a discount raises RTO — the reason a cut is not a free win. | src/engine/demand.js · riskMixAtPrice |
| 5 | **Four goal modes on any SKU** | slide 2 · box 6 | cash · growth · margin · clear, each with its objective and its Why. | src/engine/modes.js · GET /api/listings/:id/recommendation?mode= |
| 6 | **Cold-start plan for day 0** | slide 3 · box 1–2 | Prior → comparables → features → risk → matrix → a price hypothesis, with every input named and sourced. | src/engine/launch.js · GET /api/listings/:id/launch-plan |
| 7 | **Lifecycle curve and stage windows** | slide 4 · box 1–2 | The deck's Bass-like curve q(t) verbatim, and stage windows that scale with the category's life (a 60-day kurti is mature; a 60-day lunch box is launching). | src/engine/lifecycle.js · test asserts the formula to 1e-12 |
| 8 | **Triggers, rival test, markdown ladder** | slide 4 · box 3–4 | Hold-versus-match answered on profit per day, and a ladder that never goes below the floor. | src/engine/lifecycle.js · priceLadder · M3 = max(F+, ceil9(M2 × 0.92)) |
| 9 | **Six exits, with the carry cost** | slide 4 · box 5 | Bundle · markdown · wider reach · B2B · return-donate · park, each with sell-through, net cash and ₹ recovered per unit. | src/engine/lifecycle.js · exits · ~2%/month carry |
| 10 | **Diagnose first — price last** | slide 5 · box 1–5 | Eight nodes: visibility → CTR → CVR → returns/RTO → cost, and the price node runs last. Rebuilt as a runtime bottleneck read in v2. | src/engine/diagnose.js · POST /api/listings/:id/diagnose |
| 11 | **The guardrail layer** | slide 6 · box 3 | Hard floor · ±8% per move · 7-day cooldown · ≤2 moves/month · 1,000-view sanity · 14-day auto-revert with 28-day confirmation. Enforced in the one function that writes a price. | src/domain/apply.js · below-floor publish → 409 + every failed check |
| 12 | **Panic brake and Loss Warning** | slide 5 · box 3, slide 6 | A cut without the price–value branch firing is blocked, and any below-floor price comes back with ₹ lost per kept order. | src/engine/guardrails.js · panicBrake · lossWarning |
| 13 | **Manual → Co-Pilot → Autopilot** | slide 6 · box 4 | Co-Pilot unlocks after 30 orders, Autopilot after 4 accepted wins against the holdout — derived from real accepted decisions, and it can never unlock the floor. | src/domain/trust.js · GET /api/actions/trust/:sellerId |
| 14 | **Constrained Thompson bandit + 5% holdout** | slide 7 · box 4 | Arms rotate by day, w = n / (n + n₀), and a permanent 5% holdout keeps a baseline. The sub-floor arm is blocked with zero pulls. | src/engine/bandit.js · POST /api/engine/bandit/run |
| 15 | **Pilot design: 250 vs 250, 12 weeks** | slide 8 · box 1–4 | n = 251 per arm from the deck's own formula, two cities with a backup, four stop rules and five rollout phases. | src/engine/pilot.js · GET /api/pilot/design |
| 16 | **Impact model and city scoring** | slide 8 · box 5–6, slide 9 · box 4 | Profit per kept order ₹84 → ₹104.5 (+24.4%), kept orders 28 → 31, cohort ₹65.5 cr → ₹90 cr; city scores Surat 4.55 / Rajkot 4.10 / Tiruppur 3.60. | src/engine/pilot.js · waterfallProfit · cityRanking |
| 17 | **The 2.0 programmes and reorder point** | slide 10 · box 1–4 | Starter pack · fast movers · maker programme · stock recovery, plus ROP = d × L + z·σ·√L, pooling and the packaging audit. | src/engine/programmes.js · routed, off by default until a seller opts in |
| 18 | **Legal and privacy guardrails** | slide 10 · box 6, slide 11 | SKU-week aggregates only, no shared rival data, no hub-and-spoke; Competition Act 2002 + 2023 amendment and DPDP Act 2023 stated in every payload's _meta. | src/config/deck.js · GET /api/meta · nothing in the API accepts a rival's price |
| 19 | **AI coach, English and Hinglish** | slide 11 · box 1 | 15+ intents, each answer carrying its source, a categorical confidence and the live floor — and tap-only money actions it never takes itself. | src/engine/coach.js · POST /api/coach/ask |
| 20 | **The prototype, wired to the API** | the demo itself | The same single-file prototype on the server, with the browser engine kept as the fallback so the offline demo still works. | public/index.html + public/api-bridge.js · 53 UI checks |
| 21 | **A closed seller loop around it** | extension beyond the deck | Sessions and scoping · 14-type event model · recommendation state machine · deterministic outcome calculator · experiments with a claim guard · scheduler · action queue with an audit trail · version registry · idempotency · health, jobs and metrics. | src/domain/* · src/jobs/* · 92 tests · 128 route checks |
| 22 | **v2 · diagnosis of the real bottleneck** | Decision Intelligence v2 | PRICE / CATALOGUE / DEMAND / FULFILMENT / RETURN_RTO / INVENTORY / PROMOTION / MIXED_UNCERTAIN, decided from evidence with price strictly last — and MIXED_UNCERTAIN when the evidence does not justify any move. | src/domain/bottleneck.js · scenario lab B reads CATALOGUE, not a discount |
| 23 | **v2 · counterfactual price curve** | Decision Intelligence v2 | Every candidate price with its funnel, economics and risk flags, the floor marked on the curve, and a recommendation that is neither the cheapest nor the highest-revenue candidate. | src/domain/counterfactual.js · labelled “Illustrative model estimate” |
| 24 | **v2 · simulator and scenario lab A–H** | Decision Intelligence v2 | A seeded seller/market simulator that emits into the real event pipeline, and eight resettable scenarios that each declare the bottleneck they should produce — checked from evidence, never relabelled. | src/sim/* · calibrate() → 8/8 match their intent |
| 25 | **v2 · inventory, promotion, portfolio, regional** | Decision Intelligence v2 | Stock age, cover, sell-through and stockout risk; effective price after promotions with contradiction detection; overlap between a seller's own SKUs; aggregated pincode clusters with operational (never personalised) advice. | src/domain/{inventory,promotion,portfolio,regions}.js |
| 26 | **v2 · baseline comparison** | Decision Intelligence v2 | Static price vs a rule-based discount vs the full engine, over the same simulated environment, with no manufactured superiority and no significance claim from a single run. | src/domain/baselines.js · honesty {runs_per_strategy: 1, significance: 'not established'} |

## In build

The pieces of Decision Intelligence v2 that are still being finished.

| # | Proposal | Deck | What it is | Evidence |
|---|---|---|---|---|
| 27 | **v2 · the HTTP surface** | Decision Intelligence v2 | The route modules that expose the v2 domain work: counterfactual, portfolio, inventory, promotion, regional, evaluation and the scenario lab, plus a price preview endpoint. | target: POST /api/listings/:id/counterfactual · /api/evaluation/compare · /api/lab/* |
| 28 | **Decision Lab / Scenario Lab screen** | Decision Intelligence v2 | A new screen beside the existing ones — no redesign — with the “WHY THIS DECISION?” card driven by real engine output in English and Hinglish. | target: public/ (existing screens untouched, badge and fallback preserved) |
| 29 | **The dedicated v2 test suites** | Decision Intelligence v2 | Seed determinism, event correctness, reset; counterfactuals; diagnosis; portfolio; inventory; promotion; baselines sharing one environment; and an end-to-end loop. | target: npm test, npm run smoke, npm run test:ui after each phase |
| 30 | **Architecture doc and the final report** | deliverables | BACKEND_ARCHITECTURE.md, the refreshed API reference, the 13-item report (files, routes, data structures, state machines, screens, test count, example outputs, simulated vs implemented, commands, 3-minute demo) — and this board. | target: docs/BACKEND_ARCHITECTURE.md |

## Proposed next

What the deck proposes beyond the built system — clearly not shipped.

| # | Proposal | Deck | What it is | Evidence |
|---|---|---|---|---|
| 31 | **Run the pilot (4 cities, 12 weeks)** | slide 8–9 · proposed | The design, the sample size and the stop rules are built and routed; the pilot itself needs real sellers and real traffic. The deck's roadmap is the next step, not a shipped claim. | needs: real traffic · GET /api/pilot/design is ready |
| 32 | **Reconcile the floor against settlements** | slide 8 · pilot gate | The pilot gate is that the computed floor lands within ±5% of the seller's actual settlement. That check can only run on real payouts. | needs: settlement data (seller's own) |
| 33 | **Ingest the seller's own catalogue** | slide 7 · box 3 | Today the simulator and seeds stand in for the feed. Reading a seller's own catalogue and order events is the same event interface, pointed at real data — still SKU-week aggregates, still no rival data. | needs: Meesho-side integration |
| 34 | **Fitted models behind the same interfaces** | slide 2.10 of the fidelity notes | Every model sits behind a declared replacement point. When the pilot produces data, the priors can be replaced by fitted models without touching the decision layer — no ML is claimed today. | src/models/interfaces.js · replacement points |
| 35 | **Switch on the 2.0 programmes** | slide 10 · proposed | Cost control, supply, lead times and cash flow are implemented and routed, but off by default: they change the seller's operations, so they need explicit opt-in. | implemented, deliberately not enabled |

## Deliberately not claimed

- No rival or competitor data anywhere — the market is a declared assumption of a stress test, never a rival's price.
- No personalised or discriminatory pricing: regional findings become operational advice, never a different price for a different shopper.
- No causal claims from simulation: simulated results are labelled simulated / illustrative, and real claims still need treatment-versus-holdout evidence.
- No fake machine learning: the models are deterministic, and each one declares what would replace it.

---

Source of truth: [`docs/DECK_FIDELITY.md`](DECK_FIDELITY.md) (slide-by-slide) and `src/config/deck.js` (every constant, with its slide).
Verify any "shipped" card yourself: `npm test`, `npm run smoke`, `npm run test:ui`, then open `http://localhost:8787`. All values are illustrative planning defaults from the deck.
