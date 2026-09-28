"""Constraint set (SPEC 15.2). Every constraint returns pass/fail *and a margin* so the UI can show
what a relaxation would unlock."""
from __future__ import annotations

from ..config import settings

RISK_TOLERANCE_INR = 5.0          # p10 may sit this far below target for "feasible with risk"
INVENTORY_HORIZON_DAYS = 14


def _c(cid: str, label: str, ok: bool, margin: float, actual: float, required: float, unit: str,
       note: str = "") -> dict:
    return dict(id=cid, label=label, pass_=bool(ok), margin=float(margin), actual=float(actual),
                required=float(required), unit=unit, note=note)


def evaluate(*, price: float, corridor: tuple[float, float], current_price: float, goal: dict,
             mode: str, per_kept_p50: float, per_kept_p10: float, orders_day: float,
             leakage: float, working_capital: float, inventory_need_units_day: float,
             inventory: float, confidence_label: str, max_price_move: float | None = None) -> list[dict]:
    move_cap = settings.max_price_move if max_price_move is None else max_price_move
    lo, hi = corridor
    target = float(goal.get("target_contribution", 60.0))
    min_orders = float(goal.get("min_orders", 20.0))
    cap = float(goal.get("max_return_rto", 0.15))
    cash_limit = goal.get("cash_limit")

    out = [
        _c("contribution_floor", "Contribution floor", per_kept_p50 >= target, per_kept_p50 - target,
           per_kept_p50, target, "₹/kept order",
           note=("recovery floor replaces the target in Clear mode" if mode == "clear" else "")),
        _c("volume_floor", "Volume floor", orders_day >= min_orders, orders_day - min_orders,
           orders_day, min_orders, "orders/day"),
        _c("return_cap", "Return + RTO cap", leakage <= cap, cap - leakage, leakage, cap, "share"),
        _c("corridor", "Market corridor", lo <= price <= hi, min(price - lo, hi - price), price, hi, "₹",
           note=f"corridor ₹{lo:.0f}–₹{hi:.0f}"),
        _c("max_price_move", "Max price move", abs(price - current_price) <= move_cap * current_price,
           move_cap * current_price - abs(price - current_price), abs(price - current_price),
           move_cap * current_price, "₹", note=f"cap {move_cap:.0%} of ₹{current_price:.0f} per step"),
        _c("confidence", "Confidence", confidence_label in ("Medium", "High"), 0.0,
           {"Low": 0, "Medium": 1, "High": 2}.get(confidence_label, 0), 1, "level",
           note="Low confidence cannot be recommended"),
        _c("no_buyer_pricing", "One price for every buyer", True, 0.0, 1.0, 1.0, "structural",
           note="prices are never personalised to a buyer"),
    ]
    if mode == "clear":
        out[5] = _c("confidence", "Confidence", confidence_label in ("Medium", "High"), 0.0,
                    {"Low": 0, "Medium": 1, "High": 2}.get(confidence_label, 0), 1, "level",
                    note="Low confidence cannot be recommended")
        # Clear mode uses the recovery floor: unit cost + forward freight must come back
        floor = 0.0
        out[0] = _c("contribution_floor", "Recovery floor (cost + freight)", per_kept_p50 >= floor,
                    per_kept_p50 - floor, per_kept_p50, floor, "₹/kept order",
                    note="Clear mode replaces your contribution target with the recovery floor")
    else:
        need = inventory_need_units_day * INVENTORY_HORIZON_DAYS
        out.append(_c("inventory", "Inventory cover", need <= inventory, inventory - need, inventory, need,
                      "units", note=f"units needed for the next {INVENTORY_HORIZON_DAYS} days"))
    if cash_limit is not None:
        out.append(_c("cash", "Working capital", working_capital <= float(cash_limit),
                      float(cash_limit) - working_capital, working_capital, float(cash_limit), "₹"))
    return out


def all_hard_pass(results: list[dict]) -> bool:
    return all(r["pass_"] for r in results if r["id"] != "confidence") and \
        any(r["id"] == "confidence" and r["pass_"] for r in results)


def failing(results: list[dict]) -> list[dict]:
    return [r for r in results if not r["pass_"]]


def summary(results: list[dict]) -> dict:
    """Shortfall summary used by the verdict banner and the 'relax which constraint?' chips."""
    fails = failing(results)
    return dict(
        pass_=not fails,
        binding=[r["id"] for r in fails],
        shortfalls={r["id"]: dict(actual=r["actual"], required=r["required"], margin=r["margin"],
                                  unit=r["unit"], label=r["label"]) for r in fails})
