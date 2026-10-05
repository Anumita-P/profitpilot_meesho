# API reference

`profitpilot-backend v1.0.0` · 62 routes. Every response carries `_meta` with the engine name and the disclaimer, and every payload that contains numbers also says where the numbers come from.

Start the server (`npm start`) and try any of these with curl. Replace `L-kurti` with `L-lunch`, `L-serum`, `L-romper` or `L-vase`.

## Catalogue & price science

| Method | Path | What it returns |
|---|---|---|
| `GET` | `/api/health` | Liveness + what this service is |
| `GET` | `/api/meta` | Engine constants, guardrails, modes, stages, limits and the slide-provenance map |
| `GET` | `/api/routes` | Self-documenting endpoint index |
| `GET` | `/api/skus` | The SKU library with floors (deck slide 2 box 1) |
| `GET` | `/api/floors` | Every SKU floor in one call (full breakdown, arms, dual price, recovery floor) |
| `GET` | `/api/skus/:key` | One SKU: costs, floor breakdown, band, target-margin prices |
| `GET` | `/api/skus/:key/floor` | Return-adjusted floor F for a SKU, with seller cost overrides |
| `POST` | `/api/skus/:key/floor` | Floor for a set of cost inputs (the First price screen) - two numbers required, the rest prefilled |
| `GET` | `/api/skus/:key/floor/sensitivity` | What moves F: sourcing, returns, weight, RTO, COD, ads (deck slide 2 box 2) |

## First price / launch

| Method | Path | What it returns |
|---|---|---|
| `POST` | `/api/launch/plan` | The cold-start path: category prior -> look-alikes -> features -> risk -> launch-play -> price hypothesis |
| `GET` | `/api/launch/examples` | The three worked examples from deck slide 3 box 4, computed end to end |
| `GET` | `/api/launch/matrix` | The launch-play matrix (competition x stock depth) |

## Risk models

| Method | Path | What it returns |
|---|---|---|
| `GET` | `/api/risk/pincodes` |  |
| `POST` | `/api/risk/return` | Return / RTO risk per SKU x pincode (AUC >= 0.75 target) |
| `POST` | `/api/risk/cod` | COD risk score and the prepaid action (2.0 module) |
| `GET` | `/api/risk/keep-probability` | Keep-probability by pincode cluster (which price to show first) |

## Seller & listings

| Method | Path | What it returns |
|---|---|---|
| `GET` | `/api/sellers` | All sellers in this instance (one seeded demo seller) |
| `GET` | `/api/sellers/:id` |  |
| `GET` | `/api/sellers/:id/dashboard` | Home screen: KPIs, product health, control split, trust ladder, pending cards |
| `GET` | `/api/sellers/:id/listings` |  |
| `GET` | `/api/bootstrap` | Everything a client needs on boot: seller, listings, floors, recommendations, guardrails |
| `GET` | `/api/listings` |  |
| `GET` | `/api/listings/:id` |  |
| `PATCH` | `/api/listings/:id` | Update cost inputs, goal mode, control level or exit consent for one listing |
| `POST` | `/api/listings/:id/costs` | Seller types the two numbers (C_s and T); the rest stays prefilled from category defaults |
| `POST` | `/api/listings/:id/simulate` | What-if simulator: price -> orders/day, ₹ per kept order, ₹/day, plus the Loss Warning |
| `GET` | `/api/listings/:id/recommendation` | The weekly card: what / why / ₹ effect / confidence / undo + pre-flight + panic brake |
| `GET` | `/api/recommendations` | One card per listing (the Home feed) |
| `POST` | `/api/listings/:id/diagnose` | The 8-node scan: which branch fires, the ₹ at risk, the fix, and whether a cut is allowed |
| `GET` | `/api/listings/:id/lifecycle` | Price across the product's life: stage, triggers, ladder, exits and recovery |
| `POST` | `/api/listings/:id/publish` | Publish a price: hard floor, panic brake, pre-flight, Loss Warning, cooldown, undo window |
| `GET` | `/api/decisions` | Action tracking - every card accepted, skipped or overridden (fixes 1.0 limit 5) |
| `POST` | `/api/listings/:id/decisions` | Accept / reject / override a card. Accept applies the move through the guardrails; override is logged as an override |
| `POST` | `/api/decisions/:id/undo` | Undo a move within the 24-hour window (deck slide 6 box 3) |
| `POST` | `/api/decisions/:id/observe` | Day-14 auto-revert: worse on profit per impression -> the price goes back |
| `GET` | `/api/listings/:id/why` | The Why payload for a listing: what / why / ₹ effect / confidence / undo |

## Engine lab

| Method | Path | What it returns |
|---|---|---|
| `GET` | `/api/engine/bandit` | Current bandit state: arms, posteriors, pulls, holdout, lift |
| `POST` | `/api/engine/bandit/run` | Run N days of constrained Thompson sampling and return arms, lift and the pre-flight proposal |
| `POST` | `/api/engine/bandit/reset` | Reset the arms (fresh prior, new seed) |
| `GET` | `/api/engine/bandits` |  |
| `GET` | `/api/engine/maths` | The bandit maths, exactly as on deck slide 7 box 4 |

## Pilot & impact

| Method | Path | What it returns |
|---|---|---|
| `GET` | `/api/pilot/design` | Cities, scoring, randomisation, metrics, roadmap and stop rules |
| `GET` | `/api/pilot/cities` | City scoring S = sum w_t x_t (M24) |
| `POST` | `/api/pilot/sample-size` | n = 2 (z_a/2 + z_b)^2 s^2 / d^2 (M23) |
| `GET` | `/api/pilot/sample-size` |  |
| `GET` | `/api/pilot/impact` | Impact waterfalls + metrics (deck slide 8) |
| `POST` | `/api/pilot/cohort` | Cohort maths for 10,000 new sellers (deck slide 8 box 6) |
| `POST` | `/api/pilot/claim` | Claims guard: no lift is published without a holdout comparison |
| `GET` | `/api/pilot/live` | Ops view: what is live, what the holdout sees, and the stop rules |

## Coach

| Method | Path | What it returns |
|---|---|---|
| `POST` | `/api/coach/ask` | Ask the coach in English or Hindi - grounded answers with source, confidence and a Why payload |
| `GET` | `/api/coach/intents` | Intents the coach understands, with a sample phrasing each |
| `GET` | `/api/coach/sellers-talk` | Maps the eight seller questions from deck slide 2 to live engine answers |

## 2.0 programmes

| Method | Path | What it returns |
|---|---|---|
| `GET` | `/api/programmes` | ProfitPilot 2.0 modules: who does the work, how it runs, what it is worth, which limit it fixes |
| `POST` | `/api/programmes/reorder-point` | Reorder point = demand during lead time + safety stock (M28) |
| `POST` | `/api/programmes/pooled-procurement` | Pool 5 sellers to meet a 300-unit MOQ (2.0, opt-in) |
| `POST` | `/api/programmes/packaging-audit` | Valmo scan station: declared vs actual size/weight |

## Audit & ops

| Method | Path | What it returns |
|---|---|---|
| `GET` | `/api/system/status` | Ops view: which listings sit below the floor, guardrails on/off, bandit rotation state |
| `GET` | `/api/audit` | Action + guardrail audit trail |
| `GET` | `/api/guardrails` | The profit-protection layer: hard floor, panic brake, loss warning, auto-revert |
| `GET` | `/api/economy` | The economics behind the problem, with the deck's sources |
| `POST` | `/api/admin/reset` | Reset the demo database back to the deck seed |
| `GET` | `/api/admin/export` | Full JSON snapshot (what the prototype persists) |

## Examples

```bash
curl -s localhost:8787/api/bootstrap | python3 -m json.tool | head -40        # everything the UI needs at boot
curl -s localhost:8787/api/floors                                             # the five return-adjusted floors
curl -s "localhost:8787/api/listings/L-kurti/recommendation?mode=growth"      # the weekly card + its Why blocks
curl -s -X POST localhost:8787/api/listings/L-kurti/diagnose -d '{}'          # the 8-node diagnose-first tree
curl -s localhost:8787/api/listings/L-kurti/lifecycle                        # stages, ladder, rival test, exits
curl -s -X POST localhost:8787/api/engine/bandit/run -d '{"listing":"L-kurti","days":30}' -H 'content-type: application/json'
curl -s -X POST localhost:8787/api/pilot/cohort -d '{}' -H 'content-type: application/json'
curl -s -X POST localhost:8787/api/coach/ask -H 'content-type: application/json' -d '{"question":"Returns kyun aa rahe hain?","lang":"hi"}'
curl -s -X POST localhost:8787/api/listings/L-kurti/publish -H 'content-type: application/json' -d '{"price":249}'   # -> 409 with the Loss Warning
curl -s localhost:8787/api/audit                                             # every suggestion, acceptance and block
```
