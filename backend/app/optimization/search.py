"""Counterfactual search over price x intervention (SPEC 15).

The search is vectorised: for each intervention candidate the whole price grid is evaluated at once
(P prices x M bootstrap members), so ~7k candidate evaluations cost milliseconds.
"""
from __future__ import annotations

import numpy as np

from ..config import settings
from ..ml.economics import effective_sku
from . import catalogue as C
from . import constraints as K
from .comparables import Comparables, confidence_label
from .objective import objective, sigma_from_band

EPS = 1e-9


def in_corridor_grid(corridor: tuple[float, float], step: int = 1) -> np.ndarray:
    lo, hi = corridor
    return np.arange(np.ceil(lo), np.floor(hi) + 1, step, dtype=float)


def curve_grid(corridor: tuple[float, float], price_min: float | None = None,
               price_max: float | None = None, step: int = 1) -> np.ndarray:
    lo = float(price_min if price_min is not None else max(250.0, corridor[0] - 20))
    hi = float(price_max if price_max is not None else min(700.0, corridor[1] + 70))
    lo, hi = max(250.0, lo), min(700.0, hi)
    grid = np.arange(lo, hi + 1, max(1, int(step)), dtype=float)
    if grid.size > 400:
        grid = grid[:400]
    return grid


def summaries(metrics: dict[str, np.ndarray], keys: tuple[str, ...]) -> dict[str, dict[str, np.ndarray]]:
    """Per-price p10/p50/p90 for the requested metric keys. Arrays shaped (P,)."""
    out: dict[str, dict[str, np.ndarray]] = {}
    for k in keys:
        arr = metrics[k]
        lo, mid, hi = np.percentile(arr, [10, 50, 90], axis=1)
        out[k] = dict(p10=lo, p50=mid, p90=hi)
    return out


def feasibility(price: np.ndarray, *, corridor: tuple[float, float], current_price: float, goal: dict,
                mode: str, sumr: dict, inventory: float, units_per_order: np.ndarray | float,
                labels: np.ndarray, max_price_move: float | None = None) -> dict[str, np.ndarray]:
    """Vectorised twin of `constraints.evaluate`.

    `backend/app/tests/unit/test_constraints_parity.py` asserts the two agree price-by-price, so if a
    constraint changes here it must change there too.
    """
    move_cap = settings.max_price_move if max_price_move is None else max_price_move
    target = float(goal.get("target_contribution", 60.0))
    min_orders = float(goal.get("min_orders", 20.0))
    cap = float(goal.get("max_return_rto", 0.15))
    cash_limit = goal.get("cash_limit")
    per_kept = sumr["per_kept"]["p50"]
    orders = sumr["orders_day"]["p50"]
    leak = sumr["leakage"]["p50"]
    wc = sumr["working_capital"]["p50"]
    # inventory_need_units_day is already orders/day x units per order; the horizon turns it into units
    need = sumr["inventory_need_units_day"]["p50"] * K.INVENTORY_HORIZON_DAYS

    floor_ok = per_kept >= (0.0 if mode == "clear" else target)
    checks = {
        "contribution_floor": floor_ok,
        "volume_floor": orders >= min_orders,
        "return_cap": leak <= cap,
        "corridor": (price >= corridor[0]) & (price <= corridor[1]),
        "max_price_move": np.abs(price - current_price) <= move_cap * current_price,
        "confidence": np.isin(labels, ["Medium", "High"]),
        "no_buyer_pricing": np.ones_like(price, dtype=bool),
    }
    if mode != "clear":
        checks["inventory"] = need <= inventory
    if cash_limit is not None:
        checks["cash"] = wc <= float(cash_limit)
    # `all_no_move` is the feasibility set WITHOUT the 12%-per-step guardrail; callers that care
    # about "can any price reach this goal?" read it, while `all` is the today-actionable set.
    core = [v for k, v in checks.items() if k not in ("all", "confidence", "max_price_move")]
    checks["all_no_move"] = np.logical_and.reduce(core) & checks["confidence"]
    checks["all"] = checks["all_no_move"] & checks["max_price_move"]
    return checks


def objective_vector(mode: str, sumr: dict, sku: dict, units_per_order: int) -> np.ndarray:
    return objective(
        mode, contribution_p10=sumr["contribution_day"]["p10"], contribution_p50=sumr["contribution_day"]["p50"],
        contribution_p90=sumr["contribution_day"]["p90"], orders_day=sumr["orders_day"]["p50"],
        working_capital=sumr["working_capital"]["p50"], inventory=float(sku["inventory"]),
        units_per_order=units_per_order, unit_cost=float(sku["cost"]))


METRIC_KEYS = ("order_probability", "orders_day", "cod_share", "rto", "return_rate", "leakage",
               "kept_orders_day", "nmv_day", "per_kept", "contribution_day",
               "contribution_per_impression", "working_capital", "capital_tied",
               "inventory_need_units_day")


def evaluate_candidate(mb, sku: dict, iv: dict | None, prices: np.ndarray, *, goal: dict, mode: str,
                       cmp: Comparables, ece: float, max_price_move: float | None = None,
                       restrict_to_move_cap: bool = True, probe: dict | None = None) -> dict:
    """Evaluate one intervention across a price grid. Returns summaries + masks (no Python loops)."""
    metrics = mb.block(sku, prices, iv, probe=probe)
    sumr = summaries(metrics, METRIC_KEYS)
    units = effective_sku(sku, iv)["units_per_order"]
    width = (sumr["per_kept"]["p90"] - sumr["per_kept"]["p10"]) / np.maximum(np.abs(sumr["per_kept"]["p50"]), EPS)
    n_eff = cmp.n_eff(sku["category"], prices)
    gap = cmp.extrapolation_pct(sku["category"], prices)
    labels = confidence_label(n_eff=n_eff, gap=gap, width=width, ece=ece)
    checks = feasibility(prices, corridor=(sku["corridor_low"], sku["corridor_high"]),
                         current_price=float(sku["price"]), goal=goal, mode=mode, sumr=sumr,
                         inventory=float(sku["inventory"]), units_per_order=units, labels=labels,
                         max_price_move=max_price_move)
    # `checks_anywhere` ignores the 12%-per-step guardrail: it answers "can any price reach the goal?"
    checks_anywhere = np.array(checks["all_no_move"], copy=True)
    if restrict_to_move_cap:
        checks["all"] = checks["all"] & checks["max_price_move"]
    obj = objective_vector(mode, sumr, sku, units)
    return dict(prices=prices, metrics=metrics, sumr=sumr, checks=checks, objective=obj, labels=labels,
                checks_anywhere=checks_anywhere, n_eff=n_eff, gap=gap, width=width,
                units_per_order=units, iv=iv or {}, sku_eff=effective_sku(sku, iv))


def failing_counts(evaluated: dict) -> np.ndarray:
    """How many constraints each price fails (used to fall back to the closest-to-feasible price)."""
    keys = [k for k in evaluated["checks"] if k not in ("all", "all_no_move")]
    stack = np.stack([np.asarray(evaluated["checks"][k], dtype=bool) for k in keys])
    return (~stack).sum(axis=0)


def closest_index(evaluated: dict) -> int:
    """Index of the price that fails the fewest constraints, breaking ties on the objective."""
    fail = failing_counts(evaluated)
    pool = np.flatnonzero(fail == fail.min())
    return int(pool[np.argmax(evaluated["objective"][pool])])


def best_feasible(evaluated: dict, anywhere: bool = False) -> dict | None:
    """Best price that passes every constraint. `anywhere=True` ignores the per-step move cap."""
    mask = evaluated["checks_anywhere"] if anywhere else evaluated["checks"]["all"]
    if not np.any(mask):
        return None
    idx = int(np.argmax(np.where(mask, evaluated["objective"], -np.inf)))
    return pick(evaluated, idx)


def step_towards(evaluated: dict, target_price: float, current_price: float,
                 move_cap: float | None = None) -> tuple[dict, dict]:
    """Highest-objective grid price that respects the per-step guardrail, plus ladder metadata."""
    cap = settings.max_price_move if move_cap is None else move_cap
    lo, hi = current_price * (1 - cap), current_price * (1 + cap)
    wanted = float(np.clip(target_price, lo, hi))
    idx = int(np.argmin(np.abs(evaluated["prices"] - wanted)))
    steps = int(np.ceil(abs(target_price - current_price) / max(cap * current_price, EPS)))
    return pick(evaluated, idx), dict(step=1, steps=max(steps, 2), target_price=float(target_price),
                                      step_cap=cap)


def pick(evaluated: dict, idx: int) -> dict:
    return dict(
        price=float(evaluated["prices"][idx]),
        objective=float(evaluated["objective"][idx]),
        confidence=str(evaluated["labels"][idx]),
        n_eff=float(evaluated["n_eff"][idx]),
        extrapolation_pct=float(evaluated["gap"][idx]),
        width=float(evaluated["width"][idx]),
        iv=evaluated["iv"],
        units_per_order=evaluated["units_per_order"],
        sku_eff=evaluated["sku_eff"],
        metrics={k: {q: float(evaluated["sumr"][k][q][idx]) for q in ("p10", "p50", "p90")}
                 for k in METRIC_KEYS},
        checks={k: bool(v[idx]) for k, v in evaluated["checks"].items() if k != "all"},
        passes=bool(evaluated["checks"]["all"][idx]))


def best_by_objective(evaluated: dict) -> dict:
    idx = int(np.argmax(evaluated["objective"]))
    return pick(evaluated, idx)


# --- status + tradeoffs ---------------------------------------------------------------------------
def status_for(price_checks: dict, *, goal: dict, metrics: dict, iv: dict) -> tuple[str, dict]:
    """FEASIBLE | NEAR_MISS | VIOLATES (SPEC 18) with a shortfall dict for the card."""
    target = float(goal.get("target_contribution", 60.0))
    min_orders = float(goal.get("min_orders", 20.0))
    guardrails = ("return_cap", "corridor", "inventory", "cash", "max_price_move", "confidence")
    guard_fail = [k for k in guardrails if price_checks.get(k) is False]
    short_kept = max(0.0, target - metrics["per_kept"]["p50"])
    short_orders = max(0.0, min_orders - metrics["orders_day"]["p50"])
    near = short_kept <= 0.10 * max(target, EPS) and short_orders <= 0.10 * max(min_orders, EPS)
    if not guard_fail and short_kept <= 0 and short_orders <= 0:
        return "FEASIBLE", {}
    if guard_fail:
        return "VIOLATES", dict(guardrails=guard_fail, per_kept=short_kept, orders_day=short_orders)
    if near:
        return "NEAR_MISS", dict(per_kept=short_kept, orders_day=short_orders)
    return "VIOLATES", dict(guardrails=[], per_kept=short_kept, orders_day=short_orders)


def tradeoffs(metrics: dict, base: dict) -> list[str]:
    """The two largest signed deltas vs the current state (SPEC 18).

    Both arguments are p10/p50/p90 summaries (as returned by `pick` / `summaries`).
    """
    med = lambda d, k: float(d[k]["p50"] if isinstance(d.get(k), dict) else d[k])   # noqa: E731
    deltas = [
        ("contribution per kept order", med(metrics, "per_kept"), med(base, "per_kept"), "₹", False),
        ("orders/day", med(metrics, "orders_day"), med(base, "orders_day"), "", False),
        ("return + RTO rate", med(metrics, "leakage") * 100, med(base, "leakage") * 100, "pp", True),
        ("working capital", med(metrics, "working_capital"), med(base, "working_capital"), "₹", True),
        ("inventory need", med(metrics, "inventory_need_units_day"),
         med(base, "inventory_need_units_day"), "units/day", True),
    ]
    scored = []
    for name, new, old, unit, lower_better in deltas:
        rel = (new - old) / max(abs(old), EPS)
        scored.append((abs(rel), name, new, old, unit, lower_better))
    scored.sort(reverse=True)
    out = []
    for _, name, new, old, unit, lower_better in scored[:2]:
        arrow = "higher" if new > old else "lower"
        good = (new < old) if lower_better else (new > old)
        if unit == "₹":
            txt = f"{name.capitalize()} {'+' if new > old else '−'}₹{abs(new-old):,.0f} ({arrow} than now)"
        elif unit == "pp":
            txt = f"{name.capitalize()} {new:.1f}% ({arrow} than the current {old:.1f}%)"
        elif unit == "units/day":
            txt = f"{name.capitalize()} {new:,.0f} units/day"
        else:
            txt = f"{name.capitalize()} {new:,.1f}/day ({arrow} than {old:,.1f})"
        out.append(("✓ " if good else "• ") + txt)
    return out


def shortfall_against(evaluated: dict, *, goal: dict) -> dict:
    """Best in-corridor row for the 'what's the shortfall?' line of the verdict banner."""
    best = best_by_objective(evaluated)
    target = float(goal.get("target_contribution", 60.0))
    min_orders = float(goal.get("min_orders", 20.0))
    best_pass = best_feasible(evaluated)
    binding = []
    if best["metrics"]["per_kept"]["p50"] < target:
        binding.append("contribution")
    if best["metrics"]["orders_day"]["p50"] < min_orders:
        binding.append("volume")
    return dict(best_in_corridor_price=best["price"], per_kept=best["metrics"]["per_kept"]["p50"],
                target=target, orders_day=best["metrics"]["orders_day"]["p50"], min_orders=min_orders,
                contribution_shortfall_abs=max(0.0, target - best["metrics"]["per_kept"]["p50"]),
                volume_shortfall_abs=max(0.0, min_orders - best["metrics"]["orders_day"]["p50"]),
                binding=binding, best_feasible_price=(best_pass or {}).get("price"))
