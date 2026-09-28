"""Seller-mode objectives (SPEC 15.4) — transparent, and displayed in the UI.

λ = 1.0 (risk aversion), μ = ₹4 per order (growth), ν = ₹6 per unit cleared (clear),
write-down = 35% of unit cost (Illustrative) for stock not cleared inside the horizon.
"""
from __future__ import annotations

import numpy as np

LAMBDA = 1.0
MU_GROWTH = 4.0
NU_CLEAR = 6.0
WRITE_DOWN_RATIO = 0.35
CLEAR_HORIZON_DAYS = 30

MODE_LABELS = {
    "margin": "Margin — protect contribution per kept order",
    "growth": "Growth — contribution plus a bonus for volume",
    "cash": "Cash — contribution per rupee of working capital",
    "clear": "Clear — recover stock without losing money (30-day horizon)",
}
MODE_DESCRIPTIONS = {
    "margin": "J = Π/day − λ·σ   (λ = 1.0)",
    "growth": "J = Π/day − λ·σ + μ·orders/day   (λ = 1.0, μ = ₹4/order)",
    "cash": "J = (Π/day − λ·σ) / working capital   (contribution per ₹ tied up, per day)",
    "clear": "J = Π/day − λ·σ + ν·cleared units − write-down of unsold stock   (ν = ₹6/unit, 30-day horizon)",
}


def sigma_from_band(p10: np.ndarray, p90: np.ndarray) -> np.ndarray:
    return (p90 - p10) / 2.56


def clear_terms(inventory: float, orders_day: np.ndarray, units_per_order: int) -> tuple[np.ndarray, np.ndarray]:
    """(cleared_units_per_day, daily write-down of stock that will not clear inside the horizon)."""
    capacity = inventory / CLEAR_HORIZON_DAYS
    cleared = np.minimum(orders_day * units_per_order, capacity)
    residual = np.maximum(0.0, inventory - orders_day * units_per_order * CLEAR_HORIZON_DAYS)
    return cleared, residual


def objective(mode: str, *, contribution_p10: np.ndarray, contribution_p50: np.ndarray,
              contribution_p90: np.ndarray, orders_day: np.ndarray, working_capital: np.ndarray,
              inventory: float, units_per_order: int, unit_cost: float) -> np.ndarray:
    """Mode objective J for each candidate. Higher is better."""
    lam_sigma = LAMBDA * sigma_from_band(contribution_p10, contribution_p90)
    core = contribution_p50 - lam_sigma
    if mode == "growth":
        return core + MU_GROWTH * orders_day
    if mode == "cash":
        return core / np.maximum(working_capital, 1.0)
    if mode == "clear":
        cleared, residual = clear_terms(inventory, orders_day, units_per_order)
        return core + NU_CLEAR * cleared - (residual * unit_cost * WRITE_DOWN_RATIO) / CLEAR_HORIZON_DAYS
    return core


def mode_weights(mode: str) -> list[dict]:
    """What the UI shows in the 'How we rank' expander."""
    base = [dict(name="Risk aversion λ", value=LAMBDA, unit="",
                 note="contribution/day p50 minus λ × σ, where σ = (p90 − p10) / 2.56"),
            dict(name="Working capital cost", value=0.24, unit="% p.a.",
                 note="Illustrative cost of capital charged in contribution/impression")]
    if mode == "growth":
        base.append(dict(name="Volume bonus μ", value=MU_GROWTH, unit="₹/order", note="added per expected order/day"))
    if mode == "clear":
        base += [dict(name="Clearing value ν", value=NU_CLEAR, unit="₹/unit", note="value of moving one unit out of stock"),
                 dict(name="Write-down on unsold stock", value=WRITE_DOWN_RATIO, unit="× cost",
                      note=f"applied to units not cleared inside {CLEAR_HORIZON_DAYS} days"),
                 dict(name="Clearing horizon", value=CLEAR_HORIZON_DAYS, unit="days", note="recovery floor replaces the contribution target")]
    return base
