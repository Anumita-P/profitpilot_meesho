# ProfitPilot

**Profit-aware pricing recommendations for marketplace sellers — and an honest answer when no
price works.**

A seller sets one goal (retained contribution per kept order, a volume floor, a return+RTO cap,
a working-capital limit). ProfitPilot then either finds a price that reaches it, proves that no
price inside the market corridor can, or shows that price is not the problem at all — and ranks
the operational changes that would fix the economics instead.

Everything is computed live by the backend on every request: four fitted logistic models (30-member
bootstrap) → an event tree of order outcomes → a constrained optimizer → a verdict → a template
explanation. There is no mock layer, no hard-coded number in the UI, and no network call anywhere
at runtime.

---

## 1. Quick start (5 commands)

```bash
# 0. requirements: Python 3.11+ (tested on 3.13) and Node 20+
make setup          # pip install -r backend/requirements.txt  +  npm install (frontend)
make demo           # builds the SPA if needed, then serves app + API on :8000

# open http://localhost:8000   → login screen with four demo personas
```

`make demo` is idempotent: it installs the frontend dependencies only if `node_modules` is missing,
builds `frontend/dist` only if it is not there, then starts uvicorn. `Ctrl-C` stops it.
On the first boot the SQLite file `data/profitpilot.db` is created and seeded (599 listings,
40 sellers, 35,940 SKU-days, 4 login personas).

**Windows / no `make`:** run the underlying commands:

```powershell
python -m pip install -r backend/requirements.txt
cd frontend; npm install; npm run build; cd ..
cd backend; $env:PYTHONPATH="..\backend"; python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

---

## 2. What ships in the box

| Path | What it is |
| --- | --- |
| `docs/SPEC.md` | the source of truth (product, models, API, security, acceptance criteria) |
| `docs/BUILD_PLAN.md`, `docs/DECISIONS.md` | build order; every judgement call with the reason |
| `docs/FINAL_CHECK.md`, `docs/DATA_LABELS.md` | self-review with evidence; the honesty-labelling rules |
| `backend/app/` | FastAPI app: `ml/`, `optimization/`, `services/`, `api/`, `database/` |
| `frontend/` | React 18 + TypeScript + Vite SPA (seller, employee and customer lanes) |
| `data/synthetic/*.csv` | the synthetic dataset (~17 MB) — committed, so nothing has to be generated |
| `data/models/v1.json` | the fitted models `pp-synth-1.0.0` (30 bootstrap members) — committed |
| `scripts/` | `generate_data.py`, `train_models.py`, `api_smoke.py`, `verify_scenarios.py` |
| `docs/screenshots/` | the screenshots quoted in `FINAL_CHECK.md` |

Data and model files are committed deliberately: a fresh clone runs offline with no extra step.

---

## 3. Running it

### Option A — one port (production-style, what the demo uses)

```bash
make build && make api        # SPA at http://localhost:8000, API docs at http://localhost:8000/api/docs
```

The API serves `frontend/dist` **if it exists at start-up**, so build first if you start uvicorn by
hand. Client-side routes (`/seller/sku/K-101`) are served `index.html` at the same URL.

### Option B — two ports (frontend hot reload)

```bash
make api                      # terminal 1 → uvicorn on :8000
make dev                      # terminal 2 → Vite on :5173, proxies /api → :8000
```

### Everyday commands

```bash
make help                     # list every target
make test                     # pytest: goldens, model calibration, constraint parity, API acceptance (25 tests)
make smoke                    # runs the acceptance script: 5 demo scenarios, verdict + numbers
make e2e                      # Playwright end-to-end (builds the SPA, starts the API itself)
make shots                    # regenerate docs/screenshots (needs the e2e browsers)
make data && make train       # regenerate the dataset and refit the models (deterministic seed)
make reset                    # wipe data/profitpilot.db and re-seed from scratch
```

One-time Playwright setup (browsers live outside the repo):

```bash
cd frontend && npx playwright install --with-deps chromium
```

### Configuration

Everything has a working default in demo mode — no secrets required. Copy `.env.example` to `.env`
to change ports-free settings such as `APP_ENV`, `JWT_SECRET` (required when `APP_ENV != demo`),
`CORS_ORIGINS`, `DATA_SEED`, rate limits or `MAX_PRICE_MOVE`.

---

## 4. Demo script

Sign in as **Sunita (seller)** on the login screen. Two ways to drive it: the **Demo scenarios**
button in the top bar (it switches persona + goal and lands you on the right screen), or the manual
route below.

**5 minutes — the centrepiece (Revenue Manager's question: "what price do I need?")**

1. **Scenario "No profitable price"** (K-207) → `/seller/sku/K-207/recommendation`.
   The banner says *"No price in the current market corridor meets your target."* It shows the best
   in-corridor price (₹399 → ₹54/kept order), the exact shortfall (₹6/kept order, 1.4 orders/day),
   *which* constraint is binding, and then five ranked ways to fix the economics — packaging +
   bundle is feasible at ₹117/kept order and 12.7% return+RTO. Rejected options each state their
   reason ("bundle alone → 15.4% return+RTO exceeds your 15% cap").
2. **Reverse pricing** on the same listing (`/seller/sku/K-207/reverse`) → target-first: the price
   you would need, whether it is inside the corridor, and how many guarded 12% steps away it is.
3. **Diagnosis** on K-118 → *"Price is probably NOT your main problem"*: the funnel shows
   click-through in the bottom percentile of 67 comparable listings; the fix (rebuild the primary
   image) is worth **+₹587/day**, while a price cut is rejected with numbers.

**10 minutes — add the economics and the guardrails**

4. **Simulator** on K-101 (`/seller/sku/K-101/simulate`) → move the slider to ₹349: orders rise ~60%
   while contribution/day falls ~45%. The chart marks *highest orders* and *highest contribution*
   separately, hatches everything outside the corridor, and the constraint list turns red one line at
   a time. "Why this number?" opens the attribution drawer (event tree + contribution per branch).
5. **Step cap** → the recommendation is ₹390, never ₹409: a 12% step is the maximum, and the next
   step is offered as a ladder. Anything further is plotted but never recommended.
6. **Employee view** (persona Priya, `/employee/overview`) → the simulated fleet rollout: how many
   recommendations were generated, how many were withheld and why (below floor / step cap /
   low confidence / corridor), plus model health (ECE, AUC) and the experiment design that was
   written but never run on real traffic.
7. **Customer view** (persona "A buyer") → the same listing from the buyer's side: one price for
   everyone, no personalisation, return window, prepaid-vs-COD.

---

## 5. What is real here, and what is not

| Label | Meaning |
| --- | --- |
| **Synthetic** | produced by the offline simulator (`data/synthetic`, seed `20260928`) |
| **Illustrative** | an input assumption (unit costs, freight slabs, cost of capital) |
| **Estimated** | model output, always with a p10–p90 range and a confidence badge |

No Meesho data, systems or internal APIs are used, and no Meesho number is reproduced anywhere
except one company-reported figure quoted once as motivation (FY26 NMV ≈ 58.8% of GMV, on the About
footnote). Models are interpretable logistic regressions — no RL, no bandit, no LLM, no
buyer-level pricing; prices are never personalised, and ProfitPilot never writes a price anywhere.

---

## 6. How it works

```
data (synthetic world) → M1 order prob · M2 COD share · M3 return · M4 RTO  (30 bootstrap members)
      → event tree of an order's endings → constrained optimizer over the price corridor
      → verdict (PRICE_WORKS / PRICE_INFEASIBLE / NEEDS_EVIDENCE / NOT_A_PRICE_PROBLEM)
      → recommendation + template explanation + ranked interventions
```

* **Corridor** — the market range around comparables; prices outside it are drawn, never recommended.
* **Guards** — contribution floor, volume floor, return+RTO cap, 12% max price move per step,
  14-day inventory cover, working-capital limit, confidence rule.
* **Interventions** — cost levers (packaging, parcel redesign) × demand levers (image, bundle,
  prepaid incentive), paired only where the combination makes sense.
* **Verdicts** drive the UI: a verdict is a different screen, not a different colour.
* **API** — 35 endpoints under `/api` (`/api/docs` has the full schema). Seller endpoints are scoped
  from the session cookie; cross-seller access returns 404, never 403.

Architecture, and the reasoning behind every threshold, are in `docs/SPEC.md` and
`docs/DECISIONS.md`.

---

## 7. Tests

```bash
make test     # 25 passed — goldens ±10%, ECE ≤ 0.05, elasticity sign/size, constraint parity,
              #              API acceptance (runs the smoke script + scenario verifier as subprocesses)
make smoke    # human-readable acceptance report for the 5 scenarios
make e2e      # 16 browser tests: seller journey, guardrail behaviour, all 5 scenarios, roles
```

Tests use a throwaway SQLite file (`backend/app/tests/conftest.py`), so they never touch the demo
database. Everything is deterministic: same seed, same numbers on every run.

---

## 8. Troubleshooting

| Symptom | Fix |
| --- | --- |
| `Model file data/models/v1.json is missing` | run `make train` (or restore the committed file) |
| Opening `/` shows JSON, not the app | `frontend/dist` was missing when uvicorn started → `make build`, then restart |
| `make e2e` fails to launch a browser | `cd frontend && npx playwright install chromium` (already part of `make setup`); on Debian/Ubuntu also install the system libs printed by `npx playwright install-deps chromium --dry-run` |
| `429 Too Many Requests` after clicking logins quickly | demo login is rate limited to 10/min by design (SPEC 21); wait a minute |
| Demo numbers look wrong / database half-seeded | `make reset` |
| Port 8000 already in use | stop the other process, or run `cd backend && uvicorn app.main:app --port 8010` |

---

## 9. Known limitations (stated, not hidden)

* Costs and freight are **Illustrative** inputs; in production they come from the seller's ledger.
* Calibration is measured on synthetic hold-outs — the number that matters is ECE on real data,
  which this prototype cannot show.
* The employee view is a **simulated** rollout with a heuristic accept/apply rule: it demonstrates
  governance, not measured lift.
* No live monitoring, no retraining pipeline, no shadow-mode comparison against an incumbent price
  engine; experiments are designed but never run on real traffic.
* Customer view is intentionally minimal (P2 scope).
