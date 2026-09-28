"""Gate 1 acceptance: the ground-truth world must reproduce every SPEC 13.4 golden within ±10%.

The world is used ONLY for data generation and tests (never for seller-facing answers), so this file
is the anchor that keeps the synthetic data honest.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / "backend"))

from app.ml.world import BASE, SKU_K118, SKU_K207, SKU_K330, SKU_K330_FIX, econ   # noqa: E402

K101 = dict(BASE)
TOL = 0.10      # SPEC 13.4 tolerance


def close(got: float, want: float, tol: float = TOL) -> bool:
    return abs(got - want) <= tol * max(abs(want), 1e-9)


@pytest.mark.parametrize("price,orders,per_kept,contrib", [
    (349, 36.5, 24.7, 731), (399, 22.8, 71.3, 1325), (429, 17.7, 99.4, 1427)])
def test_scenario_a_discount_trap(price, orders, per_kept, contrib):
    e = econ(K101, price)
    assert close(e["orders"], orders), f"orders {e['orders']}"
    assert close(e["per_kept"], per_kept), f"per_kept {e['per_kept']}"
    assert close(e["contrib_day"], contrib), f"contrib_day {e['contrib_day']}"


@pytest.mark.parametrize("price,orders,per_kept", [(399, 19.2, 53.3), (389, 21.0, 44.0)])
def test_scenario_c_price_ceiling(price, orders, per_kept):
    e = econ(SKU_K207, price)
    assert close(e["orders"], orders), f"orders {e['orders']}"
    assert close(e["per_kept"], per_kept), f"per_kept {e['per_kept']}"


def test_scenario_c_interventions():
    img = econ(SKU_K207, 399, dict(img_delta=0.18))
    assert close(img["orders"], 25.4) and close(img["per_kept"], 56.1)
    assert close(img["leak"], 0.149, 0.15)

    pack = econ(SKU_K207, 399, dict(pack_delta=0.35, pack_cost_delta=4))
    assert close(pack["per_kept"], 54.4)

    bundle = econ(SKU_K207, 349.5, dict(bundle=2, bundle_ship_mult=1.35, demand_mult=0.72))
    assert close(bundle["per_kept"], 90.6) and close(bundle["leak"], 0.163, 0.15)

    both = econ(SKU_K207, 349.5, dict(bundle=2, bundle_ship_mult=1.35, demand_mult=0.72,
                                      pack_delta=0.35, pack_cost_delta=4))
    assert close(both["per_kept"], 93.4) and close(both["leak"], 0.137, 0.15)
    assert close(both["orders"], 22.0)


def test_scenario_d_parcel_and_packaging():
    before = econ(SKU_K330, 399)
    assert close(before["per_kept"], 27.2, 0.12) and close(before["leak"], 0.177, 0.12)
    fix = econ(SKU_K330_FIX, 399)
    assert close(fix["per_kept"], 62.1) and close(fix["leak"], 0.141, 0.15)
    assert close(fix["contrib_day"], 1089)
    assert close(econ(SKU_K330, 369)["per_kept"], -0.7, 1.0), "₹369 is loss-making per kept order"


def test_scenario_f_listing_quality():
    assert close(econ(SKU_K118, 399)["orders"], 11.7)
    assert close(econ(SKU_K118, 399)["per_kept"], 63.9)
    fixed = econ(SKU_K118, 399, dict(img_delta=0.35))
    assert close(fixed["orders"], 20.3) and close(fixed["contrib_day"], 1169)


def test_prepaid_incentive_moves_mix_off_cod():
    base = econ(K101, 399)
    nudge = econ(K101, 399, dict(prepaid_inc=20))
    assert close(nudge["cod"], 0.389, 0.05)
    assert nudge["cod"] < base["cod"]
    assert close(nudge["leak"], 0.146, 0.06)
    assert close(nudge["per_kept"], 61.4, 0.05)


def test_guardrail_facts():
    """The facts the UI copy depends on: order-max is not contribution-max."""
    assert econ(K101, 329)["orders"] > econ(K101, 399)["orders"] > econ(K101, 429)["orders"]
    assert econ(K101, 429)["per_kept"] > econ(K101, 399)["per_kept"] > econ(K101, 329)["per_kept"]
