"""The vectorised feasibility twin must agree with the scalar constraint set (SPEC 15.2).

`optimization.search.feasibility` is a vectorised copy of `optimization.constraints.evaluate`.
This test pins them together on real SKUs so the two can never drift apart.
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / "backend"))

from app.database.seed import seed_all                      # noqa: E402
from app.database.session import get_session                # noqa: E402
from app.optimization import constraints as K               # noqa: E402
from app.optimization import search as S                    # noqa: E402
from app.services.catalog_service import default_goal       # noqa: E402
from app.services.runtime import bundle, comparables, ece_worst, sku_dict   # noqa: E402

CASES = [("S-SUNITA", "K-101", "margin"), ("S-SUNITA", "K-207", "margin"),
         ("S-SUNITA", "K-118", "margin"), ("S-RAHUL", "K-101R", "clear"),
         ("S-SUNITA", "K-101S", "cash")]


@pytest.fixture(scope="module")
def session():
    seed_all(reset=True, load_obs=False)
    s = get_session()
    yield s
    s.close()


@pytest.mark.parametrize("seller,sku_id,mode", CASES)
def test_feasibility_matches_constraints(session, seller, sku_id, mode):
    from sqlalchemy import select
    from app.database.models import Sku

    row = session.scalar(select(Sku).where(Sku.sku_id == sku_id, Sku.seller_id == seller))
    sku = sku_dict(row)
    goal = default_goal(session, seller, sku_id)
    goal["mode"] = mode
    prices = S.in_corridor_grid((sku["corridor_low"], sku["corridor_high"]), step=3)
    ev = S.evaluate_candidate(bundle(), sku, None, prices, goal=goal, mode=mode,
                              cmp=comparables(), ece=ece_worst(), restrict_to_move_cap=False)
    for i, price in enumerate(prices):
        scalar = K.evaluate(
            price=float(price), corridor=(sku["corridor_low"], sku["corridor_high"]),
            current_price=float(sku["price"]), goal=goal, mode=mode,
            per_kept_p50=float(ev["sumr"]["per_kept"]["p50"][i]),
            per_kept_p10=float(ev["sumr"]["per_kept"]["p10"][i]),
            orders_day=float(ev["sumr"]["orders_day"]["p50"][i]),
            leakage=float(ev["sumr"]["leakage"]["p50"][i]),
            working_capital=float(ev["sumr"]["working_capital"]["p50"][i]),
            inventory_need_units_day=float(ev["sumr"]["inventory_need_units_day"]["p50"][i]),
            inventory=float(sku["inventory"]), confidence_label=str(ev["labels"][i]))
        by_id = {c["id"]: c["pass_"] for c in scalar}
        for cid, ok in by_id.items():
            assert bool(ev["checks"][cid][i]) == bool(ok), (
                f"{sku_id} ({mode}) ₹{price:.0f}: {cid} vectorised={bool(ev['checks'][cid][i])} "
                f"scalar={bool(ok)}")
        # the aggregate mask must agree too. `checks_anywhere` deliberately drops the 12% move
        # guardrail, so the comparable scalar call is the one *with* the move cap (checks["all"]).
        assert bool(ev["checks"]["all"][i]) == K.all_hard_pass(scalar), (
            f"{sku_id} ({mode}) ₹{price:.0f}: all_hard_pass disagrees")


def test_move_cap_is_the_only_difference(session):
    """`checks_anywhere` ignores the 12% guardrail; `checks.all` respects it."""
    from sqlalchemy import select
    from app.database.models import Sku

    row = session.scalar(select(Sku).where(Sku.sku_id == "K-101", Sku.seller_id == "S-SUNITA"))
    sku = sku_dict(row)
    goal = default_goal(session, "S-SUNITA", "K-101")
    prices = S.in_corridor_grid((sku["corridor_low"], sku["corridor_high"]), step=3)
    ev = S.evaluate_candidate(bundle(), sku, None, prices, goal=goal, mode="margin",
                              cmp=comparables(), ece=ece_worst())
    diff = np.flatnonzero(ev["checks"]["all"] != ev["checks_anywhere"])
    assert diff.size > 0, "the test SKU should have prices beyond one 12% step"
    assert all(not ev["checks"]["max_price_move"][i] for i in diff)
    assert all(ev["checks_anywhere"][i] for i in diff)
