# ProfitPilot — Build Plan (≤1 page)

**Target:** runnable full-stack prototype (React+TS / FastAPI / SQLite / fitted sklearn models), offline, deterministic seed `20260928`.

## Phases and gates

| Phase | Deliverable | Gate (must pass before moving on) |
|---|---|---|
| 1 · Skeleton & data | repo layout (§28), `ml/world.py` ported from Appendix A + 10 categories, 40 sellers, ~600 SKUs, 8 demo SKUs, `sku_daily_obs` ≈36k rows, `order_events` ≈6k rows | `scripts/verify_scenarios.py` reproduces §13.4 A/C/D/F within ±10%; B and E assertions hold after calibration |
| 2 · Models & economics | M1–M4 logistic models (36k rows, 30 bootstrap members), NumPy inference, event-tree economics, WC, GST table, confidence | pytest: ranges, monotonicity, elasticity recovery ±25%, argmax ±₹15, golden numbers, determinism |
| 3 · Optimisation | candidates, constraints, mode objectives, verdict, reverse pricing, sensitivity, explanation | K-207 → PRICE_INFEASIBLE + bundle+pack FEASIBLE + bundle-alone VIOLATES; K-330 → packaging feasible, discount rejected; K-118 → NOT_A_PRICE_PROBLEM; K-101 → PRICE_WORKS w/ 12% step cap; Clear < Cash by ≥₹10 |
| 4 · API & security | 28 endpoints, JWT cookie, RBAC deny-by-default, seller scoping (404 cross-tenant), audit, rate limit, headers, CSP | auth/role matrix test; isolation test writes audit row; customer serializer leaks no economics |
| 5 · Frontend core | tokens/design system, api client, Login→Catalog→Goal→Snapshot→Simulator→Levers→Reverse→Diagnosis→History | manual walk of §29 in browser; screenshots per step |
| 6 · P1 | Model view (10 nodes), Demo panel (5 scenarios), Employee (5 tabs), confidence/sensitivity | all 5 scenarios land correctly with expected verdicts |
| 7 · P2 (if time) | customer transparency view, brand-new-SKU low-confidence demo | — |
| 8 · Hardening | E2E flow, axe-ish checks, perf (<300ms cold curve), empty/error/loading states, README, docker | FINAL_CHECK.md answered with evidence |

## Known risks and how they are handled

1. **Spec internal conflicts** (K-101 return cap vs §13.4 A band; §7.4 ₹25k vs §15.5 ₹75k cash default; service-worker/worker-mllib). → Choose the simplest option consistent with the *numerical* goldens, record in `docs/DECISIONS.md`.
2. **Golden numbers vs model output.** The product reads *fitted* models, not `world.py`, so fitted values will differ from the world by a few %. Gate 2 tolerance is ±10% on means (spec §32.6), and the UI always shows the fitted value with a range.
3. **Synthetic price correlation bias.** Naive regression on observational rows is biased by the hidden competitor-discount confounder; the randomised-ladder rows (±12%) must make β recoverable. → Test asserts recovery; if it fails, raise ladder share.
4. **Sandbox constraints.** 2 vCPU / ~1 GB RAM: bootstrap is 30 logistic fits on 36k×~15 (cheap); no deep learning; frontend build is code-split where possible.
5. **Scope.** P0 first. P1 is built but kept deliberately thin (aggregate views). P2 only if P0/P1 verified.

## Verification method per gate
Gate 1 `scripts/verify_scenarios.py` (prints world-level numbers vs spec targets) · Gates 2–4 `pytest` (unit + model + api) · Gate 5–6 Playwright/HTTP walkthrough + screenshots · Gate 8 `make test`, `make e2e`, perf timing script.
