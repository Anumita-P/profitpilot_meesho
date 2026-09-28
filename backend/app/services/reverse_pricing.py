"""Reverse pricing: 'what do I need to change to make my target possible?' (SPEC 17)."""
from __future__ import annotations

import math

import numpy as np
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..database.models import Sku
from ..optimization import catalogue as C
from ..optimization import search as S
from ..optimization.objective import mode_weights
from .recommendation_service import _intervention_candidates, intervention_card, price_only_search
from .runtime import bundle, comparables, ece_worst, sku_dict

STEPS = "steps beyond the 12% per-step guardrail"


def _required_price(sku: dict, goal: dict, mode: str) -> dict:
    """Smallest price where per-kept contribution reaches the target (bisection, may be out of corridor)."""
    target = float(goal.get("target_contribution", 60.0))
    lo, hi = 10.0, 3000.0

    def per_kept(p: float) -> float:
        return float(np.median(bundle().block(sku, np.asarray([p]))["per_kept"][0]))

    if per_kept(hi) < target:
        return dict(found=False, reason="even a very high price cannot reach the target (volume at that price collapses)")
    for _ in range(40):
        mid = (lo + hi) / 2
        if per_kept(mid) < target:
            lo = mid
        else:
            hi = mid
    p_star = (lo + hi) / 2
    orders_at = float(np.median(bundle().block(sku, np.asarray([p_star]))["orders_day"][0]))
    return dict(found=True, price=p_star, orders_day=orders_at,
                in_corridor=bool(sku["corridor_low"] <= p_star <= sku["corridor_high"]),
                ceiling=float(sku["corridor_high"]), floor=float(sku["corridor_low"]),
                meets_volume=bool(orders_at >= float(goal.get("min_orders", 20))),
                line=(f"You would need ₹{p_star:,.0f} per unit to keep ₹{target:,.0f} — "
                      f"{'above' if p_star > sku['corridor_high'] else 'below'} the ₹{sku['corridor_high']:,.0f} "
                      f"market ceiling, and it would leave {orders_at:.1f} orders/day."))


def _required_cost_reduction(sku: dict, goal: dict, mode: str) -> dict:
    """How much cheaper would sourcing have to be for a price-only answer to exist?"""
    target = float(goal.get("target_contribution", 60.0))
    min_orders = float(goal.get("min_orders", 20.0))
    lo, hi = 0.0, float(sku["cost"]) * 0.9
    prices = S.in_corridor_grid((sku["corridor_low"], sku["corridor_high"]))
    orig = float(sku["cost"])

    def feasible_with(delta_cost: float) -> bool:
        s = dict(sku, cost=max(1.0, orig - delta_cost))
        ev = S.evaluate_candidate(bundle(), s, None, prices, goal=goal, mode=mode, cmp=comparables(),
                                  ece=ece_worst())
        return S.best_feasible(ev) is not None

    if not feasible_with(hi):
        return dict(found=False, note=f"no feasible price even with a ₹{hi:,.0f} cost reduction")
    for _ in range(30):
        mid = (lo + hi) / 2
        if feasible_with(mid):
            hi = mid
        else:
            lo = mid
    return dict(found=True, cost_reduction=(lo + hi) / 2, unit=f"₹ per unit ({mode} objective)",
                note="Illustrative target — not a recommendation. Meesho cannot change your sourcing cost.")


def reverse(session: Session, seller_id: str, sku_id: str, goal: dict,
            inventory_units: float | None = None, stock_age_days: int | None = None) -> dict:
    row = session.scalar(select(Sku).where(Sku.sku_id == sku_id, Sku.seller_id == seller_id))
    if row is None:
        return {}
    sku = sku_dict(row)
    if inventory_units is not None:
        sku["inventory"] = float(inventory_units)
    if stock_age_days is not None:
        sku["stock_age_days"] = int(stock_age_days)
    mode = goal.get("mode", "margin")
    mb = bundle()
    prices = S.in_corridor_grid((sku["corridor_low"], sku["corridor_high"]))

    current = S.pick(S.evaluate_candidate(mb, sku, None, np.asarray([float(sku["price"])]), goal=goal,
                                          mode=mode, cmp=comparables(), ece=ece_worst(),
                                          restrict_to_move_cap=False), 0)
    po = price_only_search(sku, goal, mode)
    best_price_only = po["best"]
    req = _required_price(sku, goal, mode)
    cost_req = _required_cost_reduction(sku, goal, mode)

    solutions, elimination = [], []
    if best_price_only is not None:
        solutions.append(dict(rank=0, id="PRICE", label="Price change only", price=best_price_only["price"],
                              iv={}, status="FEASIBLE", steps=1,
                              metrics=best_price_only["metrics"], objective=best_price_only["objective"],
                              confidence=best_price_only["confidence"],
                              why="A price inside the corridor already clears every constraint."))
        elimination.append("Price-only already works, so no other lever is needed.")
    else:
        best_any = po["best_any"]
        s_kept = max(0.0, float(goal["target_contribution"]) - best_any["metrics"]["per_kept"]["p50"])
        s_ord = max(0.0, float(goal["min_orders"]) - best_any["metrics"]["orders_day"]["p50"])
        leak_excess = max(0.0, best_any["metrics"]["leakage"]["p50"] - float(goal["max_return_rto"]))
        elimination.append(
            f"Price-only rejected: best in-corridor ₹{best_any['price']:,.0f} keeps "
            f"₹{best_any['metrics']['per_kept']['p50']:,.0f} per kept order "
            f"({'' if s_kept == 0 else f'₹{s_kept:,.0f} short; '}"
            f"{'' if s_ord == 0 else f'{s_ord:.1f} orders short; '}"
            f"{'' if leak_excess == 0 else f'{leak_excess*100:.1f}pp over the return cap'}"
            ").")

    for cand in _intervention_candidates(sku, goal):
        if not cand.get("applicable", True):
            if cand.get("reason"):
                elimination.append(f"{cand['label']} rejected: {cand['reason'].lower()}.")
            continue
        c_ev = S.evaluate_candidate(mb, sku, cand["iv"], prices, goal=goal, mode=mode,
                                    cmp=comparables(), ece=ece_worst(), restrict_to_move_cap=False)
        got = S.best_feasible(c_ev)
        if got is not None:      # keep the price where it is when the lever alone is enough
            idx_now = int(np.argmin(np.abs(c_ev["prices"] - float(sku["price"]))))
            if c_ev["checks"]["all"][idx_now]:
                got = S.pick(c_ev, idx_now)
        steps = 1
        if got is None:
            got = S.pick(c_ev, S.closest_index(c_ev))
        move = abs(got["price"] - float(sku["price"])) / max(float(sku["price"]), 1e-9)
        steps = max(1, math.ceil(move / 0.12))
        card = intervention_card(sku, goal, mode, cand, c_ev, current,
                                 "FEASIBLE" if S.best_feasible(c_ev) else "NEAR_MISS", {}, got)
        entry = dict(rank=0, id=cand["id"], label=cand["label"], price=got["price"], iv=cand["iv"],
                     status="FEASIBLE" if S.best_feasible(c_ev) else "NEAR_MISS", steps=steps,
                     metrics=got["metrics"], objective=got["objective"], confidence=got["confidence"],
                     constraints=got["checks"],
                     inventory_need_units=got["metrics"]["inventory_need_units_day"]["p50"],
                     cash_need=got["metrics"]["working_capital"]["p50"],
                     why=card["why"])
        solutions.append(entry)
        if entry["status"] == "NEAR_MISS":
            elimination.append(f"{cand['label']} is close but does not clear every constraint at once.")

    def score(e: dict) -> float:
        return float(e["objective"])

    feasible = sorted([s for s in solutions if s["status"] == "FEASIBLE"], key=score, reverse=True)[:6]
    near = sorted([s for s in solutions if s["status"] != "FEASIBLE"], key=score, reverse=True)[:2]
    ranked = feasible + near
    for i, e in enumerate(ranked):
        e["rank"] = i + 1
    winner = ranked[0] if ranked else None
    if winner:
        elimination.append(f"{winner['label']} works because {winner['why']}")
    return dict(sku_id=sku_id, mode=mode, goal=goal, solutions=ranked,
                price_only=dict(best_price=po["best_any"]["price"],
                                per_kept=po["best_any"]["metrics"]["per_kept"]["p50"],
                                orders_day=po["best_any"]["metrics"]["orders_day"]["p50"],
                                leakage=po["best_any"]["metrics"]["leakage"]["p50"],
                                feasible=best_price_only is not None),
                required_price=req, required_cost_reduction=cost_req,
                elimination=elimination[:8],
                objective=dict(mode=mode, weights=mode_weights(mode)),
                current=dict(price=float(sku["price"]), metrics=current["metrics"]),
                label="estimated")
