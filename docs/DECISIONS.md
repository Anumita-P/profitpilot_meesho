# Decisions, deviations and conflicts (append-only)

Every entry: what the spec said → what we did → why. Numerical goldens in §13.4 always win.

## D1 — Scenario B calibration: `rto_cod` 1.6 → 2.4
Spec §13.3 sets the B variant to `cod_slope=3.0, rto_cod=1.6`; §13.4 asserts return+RTO leakage at ₹349 is ≥3pp above ₹429.
With `rto_cod=1.6` we measured **1.56pp** (fail). Spec explicitly instructs the agent to calibrate B (§13.4). With
`rto_cod=2.4` → **3.51pp** and COD share delta **15.1pp** (≥10pp required); recommended price ≈₹414 vs max-orders
price ₹349 (≥₹20 required). Recorded in `data/scenarios/b_return_trap.json`.

## D2 — Scenario A/B cannot use the 15% default return cap
For K-101 the world leakage is 16.19–16.31% at *every* price, so a ≤15% cap makes **no price feasible** and scenario A
would emit `PRICE_INFEASIBLE`, contradicting §13.4 A ("feasible band ≈₹386–409", recommended ₹390). The same sentence in
§13.4 computes A's band from **only** the contribution and volume constraints. Decision: keep the engine's constraint set
exactly as §15.2 (including the cap), but give demo scenarios A and B a cap of **18%** and **25%** respectively
(scenario C keeps **15%** — its whole punchline depends on it: bundle-alone leaks 16.3% → VIOLATES). Scenario cards show the cap.

## D3 — Working capital: which terms feed the cash constraint
§15.5 gives WC = flow·(T_deliv+T_settle) + returns·T_return_loop + inventory·cost (last term "only in Cash/Clear modes"),
then says K-101 @20 orders/day ≈ ₹60–70k. The §31 sample response shows K-207 WC = ₹71,600 at ₹399 with the cash
constraint **pass** at a ₹75k limit — that matches flow + return-loop only (inventory would add ₹55,640).
Decision: the **cash constraint** uses flow + return-loop; the inventory term is reported separately and added to the
Cash-mode capital figure (`capital_tied`), where funding stock is the actual decision. Cleared inventory in Clear mode is
treated as sunk (documented in the UI "How we rank" expander).

## D4 — Cash limits in demo scenarios are set so the intended constraint binds (or does not)
Engine-minimum WC for K-101 at 20 orders/day is ≈₹90k, so §13.3's ₹40,000 for K-101S would make *every* price violate the
cash guardrail and scenario E's assertion (a recommended price in both modes) impossible. Demo goals: A ₹1,20,000
(non-binding, so the price story is clean) · B ₹1,20,000 · C ₹1,50,000 (sample's ₹75k is a price-only goal; bundle
needs ≈₹1.38L and must be FEASIBLE) · D ₹1,20,000 · E K-101S (Cash) ₹1,35,000, K-101R (Clear) ₹1,50,000 · F ₹1,00,000.
Every card states its numbers.

## D5 — Goal-form cash default
§7.4 says ₹25,000, §15.5 says the goal-screen default should be ₹75,000. §15.5 is the derived value; the form defaults
to **₹75,000** with a "No limit" toggle. The brief's ₹25,000 remains valid user input (range ₹0–₹10,00,000).

## D6 — Clear mode objective
§15.4: `J = −inv_loss + ν·units_cleared_by_horizon − λσ`. Implemented as a daily rate with transparent weights:
`J_clear = Π_day − λσ + ν·cleared_units_per_day − write_down·residual_units_30d/30`, ν = ₹6/unit cleared (Illustrative),
write-down = 35% of unit cost (Illustrative), horizon 30 days. The contribution floor is replaced by the **recovery
floor** (per-kept ≥ 0 after all variable costs, i.e. costs+freight recovered), and "What would change this"/"days to
clear" are reported. Weights are shown in the UI expander.

## D7 — Feasible band for K-101 in scenario A
Spec §13.4 says the band is ≈₹386–409 with the unconstrained in-corridor optimum at ₹409 (20.9 orders, ₹1,373/day).
Raw world arithmetic gives **₹387–414** (orders cross the 20/day floor at ₹414.5; the fact that ₹409 is where
contribution flattens in the spec's run suggests their optimum was computed on a risk-adjusted or rounded path). The
step-1 recommendation is unchanged (₹349 ×1.12 → ₹390 at ≈₹1,270/day ✓). Our engine reports what it computes
(risk-adjusted objective, λσ from the bootstrap), and the test asserts the *narrative*: step-1 ≈₹390, contribution/day
rises, orders fall, and cutting to ₹349 raises orders ≥50% while cutting contribution/day ≥40%.

## D8 — Python 3.13 in this environment
Spec §10 says Python 3.11. The sandbox has 3.13.14; all pinned dependencies install and the code avoids 3.11-only APIs.
`requirements.txt` keeps released pins; the Makefile uses whatever `python3` is on PATH (≥3.11).

## D9 — `INTERVENTION` catalogue is code, not a table
Spec §11 already forbids an `interventions` table; the typed catalogue lives in `backend/app/optimization/catalogue.py`
with an `applies_when` predicate, cost model, and confidence class.

## D10 — Employee "adoption %" and simulated-rollout aggregates
No real rollout exists. `/employee/overview` computes aggregates over the synthetic fleet by *replaying* the fitted
models on every seller's SKUs (deterministic, seeded), labels them **Synthetic — simulated rollout**, and never claims
Meesho adoption numbers. `adoption` = share of simulated recommendations the seller accepts under a stated rule.
