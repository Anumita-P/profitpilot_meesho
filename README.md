# ProfitPilot — the backend

The engine behind the ProfitPilot prototype: **pricing across a product's
lifecycle** for new-to-online Meesho sellers — and an honest answer when price is
not the problem.

Meesho DICE Challenge Season 3 · Business Track · Team Fiery Diamonds, IIT Madras.

The single-file prototype runs the whole engine in the browser. This service is
that engine **on a server**: behind an API, with persistence, an audit trail, a
closed seller loop, and guardrails enforced where they cannot be skipped. It
serves the same prototype — wired to the API — at `/`, and falls back to the
in-browser engine automatically if the server is unreachable, so the offline demo
(and the QR code on the pitch slide) still works.

No dependencies. The service imports nothing outside the Node 20 standard
library; there is no install step.

```
UI (public/index.html)                 ── the v1.1 prototype, unchanged except one <script> tag
   │  api-bridge.js                    ── adapter: server results in, local results as fallback
   ▼
HTTP API (server.js, 124 routes)       ── zero dependencies, node:http
   │  sessions · scoping · idempotency · validation · request ids · no stack traces
   ▼
──────────────────────────── the seller loop ────────────────────────────
events (src/domain/events.js)          ── 14 event types → feature fold → signals
recommendations (src/domain/recommendations.js)  ── persistent state machine
outcomes · experiments · actions       ── measured result, holdout claim guard,
                                          action queue with an audit trail
scheduler (src/jobs/scheduler.js)      ── deterministic run-cycle: recalc, observe,
                                          cooldown, auto-revert, queue
──────────────────────── the pricing engine ─────────────────────────────
engine (src/engine/*)                  ── floor · demand · modes · guardrails · recommend ·
                                          diagnose · lifecycle · bandit · risk · launch ·
                                          programmes · coach   (deck slides 2–11)
──────────────────── decision intelligence v2 (in progress) ─────────────
sim (src/sim/*)                        ── seeded seller/market simulator that emits into
                                          the real ingestion path; scenario lab A–H
domain v2 (src/domain/*)               ── counterfactual · bottleneck · inventory ·
                                          promotion · portfolio · regions · explain ·
                                          baselines
   ▼
store (src/store/*)                    ── JSON + append-only event log under data/
```

## Run it

```bash
npm start                 # http://localhost:8787  (nothing to install)
```

Open <http://localhost:8787>. The page boots with a **🟢 Engine server** badge in
the top bar, and every screen is computed by the API — floors, recommendations,
diagnose, lifecycle, the Thompson bandit, the coach — with the prototype's own
engine still there as the fallback.

```bash
npm test                  # 92 tests: prototype-parity + engine invariants + closed loop + security + idempotency
npm run smoke             # 128 route checks (all HTTP verbs incl. HEAD probes); fails on any 5xx
npm run test:ui           # 53 checks: headless walk-through of the wired page against a live server
npm run demo              # 12-step closed-loop demo (findings → recommendation → action → audit)
npm run shots             # freeze the server-rendered screens into docs/snapshots/
npm run reset             # reseed the demo data
```

Environment: `PORT` (default 8787), `HOST` (default 0.0.0.0), `PP_DATA_DIR`
(default `./data`), `PP_LOG=off` to silence the request log.

## Endpoints at a glance

| Group | Examples |
|---|---|
| Boot & meta | `GET /api/bootstrap`, `GET /api/meta`, `GET /api/routes`, `GET /api/health` |
| Catalogue & pricing | `GET /api/floors`, `GET /api/listings/:id`, `GET /api/listings/:id/recommendation?mode=`, `POST /api/listings/:id/publish` |
| Diagnose & explain | `POST /api/listings/:id/diagnose`, `GET /api/listings/:id/why` |
| Lifecycle | `GET /api/lifecycle/listings/:id/state\|window\|metrics`, `POST …/generate` |
| Events | `POST /api/events`, `POST /api/events/batch`, `POST /api/events/simulate`, `GET /api/events/stats` |
| Closed loop | `GET /api/closed-loop/status`, `GET /api/lifecycle/outcomes`, `POST /api/lifecycle/recommendations/:id/measure` |
| Experiments | `POST /api/experiments`, `POST /api/experiments/:id/start\|observe\|claim`, `GET …/impact` |
| Actions & trust | `POST /api/actions/step`, `POST /api/actions/:id/:step`, `GET /api/actions/trust/:sellerId` |
| Ops | `GET/POST /api/jobs*`, `GET /api/metrics`, `GET /api/admin/audit\|export\|docs` |
| Sessions | `POST /api/session` (seller scoping; cross-seller reads are 403) |
| Static pages | `GET /` (the wired prototype), `GET /kanban.html` (the proposal board), `GET /index.offline.html` (offline demo) |

Full list with one-line summaries: [`docs/API.md`](docs/API.md) or `GET /api/routes`.

```bash
curl -s localhost:8787/api/floors                    # F = 309 / 346 / 166 / 266 / 367
curl -s "localhost:8787/api/listings/L-kurti/recommendation?mode=growth"
curl -s -X POST localhost:8787/api/listings/L-kurti/publish \
     -H 'content-type: application/json' -d '{"price":249}'   # 409 + the Loss Warning
curl -s localhost:8787/api/audit                     # every suggestion, acceptance, block
```

## The closed loop

The seller never asks "what price should I set?" — the system first asks **"what
is actually hurting this product?"**. One pass through the loop:

```
simulated/ingested market events → features → diagnosis → counterfactual options
   → portfolio / inventory / promotion context → recommendation → guardrails
   → action → observed outcome → baseline comparison → learning
```

* **Recommendations** are persistent state machines (`RECOMMENDATION → … →
  AUDIT`), and outcomes are computed by a deterministic calculator whose primary
  metric is the seller's own economics, not revenue.
* **Experiments** carry a holdout and a claim guard: no causal claim without
  treatment/holdout evidence, and the interval is printed even when it contains 0.
* **The scheduler** (`POST /api/jobs/run`, or `start` it) does recalc → observe →
  cooldown → auto-revert → queue, and is idempotent: re-running the same cycle
  changes nothing and reports `changed: 0`.
* **Every state-changing action is auditable**, and the guardrails sit in the one
  function that writes a price (`src/domain/apply.js`), so nothing can bypass
  them.

## Decision Intelligence v2 — where it stands

| Piece | State |
|---|---|
| Seeded seller/SKU/market simulator emitting into the real event ingestion; scenario CRUD, run, advance, reset, metrics | **done** (engine + lab) |
| Evidence-first diagnosis: PRICE / CATALOGUE / DEMAND / FULFILMENT / RETURN_RTO / INVENTORY / PROMOTION / MIXED_UNCERTAIN, with price strictly last | **done** |
| Counterfactual price curve with the floor marked, "Illustrative model estimate", and a recommendation that is neither the cheapest nor the highest-revenue candidate | **done** |
| Inventory posture, promotion composition/contradiction, portfolio overlap, regional clusters, baseline A/B/C comparison | **done** |
| Scenario lab A–H with per-scenario intent checking (`calibrate()` reports 8/8 matching their intended bottleneck from evidence) | **done** |
| HTTP surface for the v2 routes (counterfactual, portfolio, inventory, promotion, regional, lab, evaluation) | **in progress** |
| Decision Lab UI + "WHY THIS DECISION?" card (no redesign of the existing screens) | **in progress** |
| Dedicated v2 test suites | **in progress** |

Everything simulated is labelled as such: simulated outcomes say *simulated /
illustrative*, counterfactuals say *Illustrative model estimate*, and overlap
wording is *estimated overlap / potential cannibalisation*. There are no
competitor prices anywhere in the system and no statistical claims from a single
run.

## Where the numbers come from

Every constant lives in `src/config/deck.js`, next to the slide it came from, and
`/api/meta` publishes that provenance map. Highlights, all verified by the tests:

* **Floors** `₹309 / ₹346 / ₹166 / ₹266 / ₹367` — the deck's table, to the rupee.
* **Kurti walk** `100 → 97 → 8 RTO → 89 → 11 returned → 78`, `k = 0.78`,
  `F ₹309`, `B ₹50`, `P_easy ₹369`, `P_no ₹339`, `F_no ₹277`, `F⁺ ₹319`, `Pm ₹399`.
* **Weekly card** `₹369 → ₹384` (+₹15 per kept order, CVR held 2 weeks), as on the
  deck's card; the vase follows the deck's ladder `₹499 → ₹469 → ₹439`.
* **Launch examples** Bangalore kurti `F 309 + 18 = 327 min → ₹369 / ₹339`;
  Jaipur hand-block `F 429 → ₹549`; Rajkot lunch box `F 346 → ₹449`, then
  discovery at `₹469 / ₹479`.
* **Bandit** 30 days on the kurti: `₹299` blocked with zero pulls, traffic drifts
  to `₹369`; holdout 6,840 impressions = 5% of traffic; observed lift +40.8% with
  the 95% interval `[−47.5%, +129.2%]` — an honest interval that still contains 0.
* **Pilot** `n = 251` per arm from the deck's formula, Surat 4.55 / Rajkot 4.10 with
  Tiruppur as backup, waterfall `84 → 104.5` (+24.4%) and cohort `₹65.5 cr → ₹90 cr`.

Deviations, rounding differences and judgement calls are listed one by one in
[`docs/DECK_FIDELITY.md`](docs/DECK_FIDELITY.md) — including the one sensitivity
lever that does not land on the slide's figure (+₹40 vs +₹30 on sourcing) and why.

## Guardrails (enforced server-side, not advisory)

Hard floor (return-adjusted, per SKU) · ±8% per move · 7-day cooldown · at most
2 moves/month · 1,000-view sanity check before a move · 14-day auto-revert with
28-day confirmation · the Loss Warning on any below-floor price · the panic brake.
Counterfactual analysis may *evaluate* sub-floor prices to show the seller what a
discount would cost; an actual move can never execute below the floor without the
recorded override and consent rules.

## Repository map

```
server.js                  HTTP entry: router, static UI, admin reset/export, graceful shutdown
public/index.html          the v1.1 prototype with one added <script> tag (served at /)
public/index.offline.html  the same file, untouched: hand it out for offline demos
public/api-bridge.js       the adapter: patches FL / recFor / decide / lcModel / enStep /
                           cAns …, converts server payloads to the prototype's shapes,
                           and falls back to the local engine on any error
reference/                 frozen original prototype + the submitted deck + the prototype's
                           own guide (source of truth)
src/config/deck.js         every deck constant, with slide provenance
src/engine/                floor · demand · modes · guardrails · recommend · diagnose ·
                           lifecycle · bandit · risk · launch · programmes · coach
src/domain/                the closed loop: events · recommendations · outcomes · apply ·
                           experiments · versions · trust · actions
                           the v2 intelligence: bottleneck · counterfactual · inventory ·
                           promotion · portfolio · regions · explain · baselines
src/jobs/                  recalc (features, cooldowns, windows) · scheduler (run cycle)
src/sim/                   random · scenario · market (day loop) · lab (scenarios A–H)
src/http/                  router · respond · validate · idempotency · session
src/auth/scope.js          seller scoping rules
src/models/interfaces.js   every model behind an explicit replacement point
src/store/                 JSON store, event log, seed data, view-model hydration
src/api/                   HTTP surface: catalogue · listings/decisions · engine/pilot · coach ·
                           events · lifecycle · experiments · actions · jobs · versions ·
                           models · admin
scripts/reset-db.js        reseed the demo data
scripts/smoke-routes.mjs   call every route (plus HEAD probes), fail on 5xx
scripts/demo-closed-loop.mjs  12-step end-to-end walk-through of the loop
scripts/snapshot.mjs       freeze the server-computed screens into self-contained HTML
test/parity.test.js        the backend vs the prototype's own engine, field by field
test/engine.test.js        guardrails, bandit, lifecycle, pilot maths, coach, store
test/closed-loop.test.js   events → recommendation → outcome → experiment → learning
test/security.test.js      sessions, scoping, cross-seller 403s, validation, no stack traces
test/idempotency.test.js   replay, conflicting bodies, in-flight keys
test/ui-smoke.mjs          headless walk-through of the wired page against a live server
docs/API.md                route reference
docs/KANBAN.md             the board: every deck proposal, its slide, and where it stands
                           (rendered twin: public/kanban.html)
docs/DECK_FIDELITY.md      what matches the deck, and every deliberate difference
docs/snapshots/*.html      what the wired app looks like right now, with the server's
                           numbers baked in - viewable with no server running
```

The front-end prototype itself — what each screen does, a five-minute demo script,
the file map, where to change constants, and its honest limits — is documented in
[`reference/README.prototype.md`](reference/README.prototype.md).

## How to look at it

1. **The 60-second version for a reviewer:** open
   <http://localhost:8787/kanban.html> (or [`public/kanban.html`](public/kanban.html)
   with no server at all) — every proposal in the deck on one board, each card
   naming its slide, what it does, the artefact that proves it, and whether it is
   shipped, in build, or still proposed. The same content inside the repo is
   [`docs/KANBAN.md`](docs/KANBAN.md).
2. **Live, on your machine:** `npm start` then <http://localhost:8787>.
3. **No server at all:** open `public/index.offline.html` (the original
   single-file demo) or any file in `docs/snapshots/` — the snapshots are frozen
   pictures of the wired app with the API's numbers already rendered.

## What this deliberately is not

ProfitPilot prices first, then tells you when price is not the problem. Cost
control, supply, lead times and cash flow are the 2.0 programmes and need the
seller's opt-in — the modules are implemented and routed, but they are off by
default. All numbers are illustrative planning defaults from the deck; there is no
real Meesho data anywhere in this repository, no rival price is read from any
source, the analysis uses SKU-week aggregates and the seller's own inputs, and the
legal guardrails (Competition Act 2002 + 2023 amendment, DPDP Act 2023) are stated
in `/api/meta` and enforced by what the API refuses to accept.
