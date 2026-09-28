"""Gate 2 acceptance: the fitted models are calibrated, directional and monotone.

Seller-facing numbers come from `ml/inference.py`, so these tests are what makes those numbers
trustworthy. `ml/world.py` is the ground truth used for comparison.
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / "backend"))

from app.database.seed import seed_all                        # noqa: E402
from app.database.session import get_session                  # noqa: E402
from app.ml import world as W                                 # noqa: E402
from app.services.runtime import bundle, sku_dict              # noqa: E402
from app.optimization import search as S                      # noqa: E402
from app.optimization.comparables import confidence_label     # noqa: E402

from sqlalchemy import select                                  # noqa: E402
from app.database.models import Sku                            # noqa: E402


@pytest.fixture(scope="module")
def skus():
    seed_all(reset=True, load_obs=False)
    session = get_session()
    out = {}
    for sku_id in ("K-101", "K-101B", "K-207", "K-330", "K-118"):
        row = session.scalar(select(Sku).where(Sku.sku_id == sku_id))
        out[sku_id] = sku_dict(row)
    session.close()
    return out


def test_calibration_within_budget():
    mb = bundle()
    for key, ceiling in (("M1", 0.05), ("M2", 0.05), ("M3", 0.05), ("M4", 0.05)):
        assert mb.metrics[key]["ece"] <= ceiling, f"{key} ECE {mb.metrics[key]['ece']}"
        assert mb.metrics[key]["auc"] >= 0.5, f"{key} AUC {mb.metrics[key]['auc']}"


def test_price_elasticity_sign_and_size():
    """The fitted demand elasticity must be negative, in a plausible range, and near the world's."""
    mb = bundle()
    names = mb.model_meta["M1"]["feature_names"]
    coef = np.median(mb.coefs["M1"], axis=0)
    ln_p = float(coef[names.index("ln_p_ref") + 1])          # +1: column 0 is the intercept
    assert -5.5 <= ln_p <= -2.0, f"price coefficient {ln_p} is not in a plausible range"
    assert abs(ln_p - W.BASE["beta"]) <= 1.0, "fitted elasticity should be near the world's -3.4"


def test_order_curve_is_monotone(skus):
    mb = bundle()
    prices = np.asarray([339.0, 359.0, 379.0, 399.0, 419.0, 439.0])
    for sku in skus.values():
        orders = np.median(mb.block(sku, prices)["orders_day"], axis=1)
        assert np.all(np.diff(orders) < 0), f"{sku['sku_id']} order curve is not decreasing in price"
        per_kept = np.median(mb.block(sku, prices)["per_kept"], axis=1)
        assert per_kept[-1] > per_kept[0], f"{sku['sku_id']} contribution does not rise with price"


def test_code_heavy_sku_has_steeper_cod_slope(skus):
    mb = bundle()
    prices = np.asarray([339.0, 399.0, 459.0])
    cod = np.median(mb.block(skus["K-101B"], prices)["cod_share"], axis=1)
    assert np.all(np.diff(cod) < 0), "COD share must fall as price rises"
    assert cod[0] - cod[-1] >= 0.15, f"COD contrast too small for the return-trap scenario: {cod}"


def test_fitted_matches_world_on_demo_cases(skus):
    """Fitted numbers should track the world within ~10% on the demo SKUs (SPEC 13.4 anchors)."""
    mb = bundle()
    cases = [("K-101", 399.0, None), ("K-207", 399.0, dict(img_delta=0.18)),
             ("K-118", 399.0, None)]
    for sku_id, price, iv in cases:
        sku = skus[sku_id]
        m = mb.block(sku, np.asarray([price]), iv)
        per_kept = float(np.median(m["per_kept"][0]))
        world_per_kept = float(W.econ(W.BASE if sku_id == "K-101" else
                                      (W.SKU_K207 if sku_id == "K-207" else W.SKU_K118), price, iv)["per_kept"])
        assert abs(per_kept - world_per_kept) <= 0.10 * abs(world_per_kept), (
            f"{sku_id}@{price}: fitted ₹{per_kept:.1f} vs world ₹{world_per_kept:.1f}")


def test_confidence_rule_is_enforced():
    assert str(confidence_label(n_eff=5000, gap=0.0, width=0.05, ece=0.01)[0]) == "High"
    assert str(confidence_label(n_eff=100, gap=0.0, width=0.05, ece=0.01)[0]) == "Low"
    assert str(confidence_label(n_eff=5000, gap=0.5, width=0.05, ece=0.01)[0]) == "Low"


def test_feasibility_band_for_scenario_a(skus):
    """K-101 (cap relaxed to 18% in the demo) has a narrow feasible band; the step cap lands at ₹390."""
    sku = skus["K-101"]
    goal = dict(target_contribution=60.0, min_orders=20.0, max_return_rto=0.18, cash_limit=120000.0,
                mode="margin")
    prices = S.in_corridor_grid((sku["corridor_low"], sku["corridor_high"]))
    ev = S.evaluate_candidate(bundle(), sku, None, prices, goal=goal, mode="margin",
                              cmp=__import__("app.services.runtime", fromlist=["comparables"]).comparables(),
                              ece=0.01)
    band = prices[ev["checks_anywhere"]]
    assert band.size > 0
    assert 370 <= band[0] <= 400 and 400 <= band[-1] <= 430, f"band {band[0]}..{band[-1]}"
    step = float(np.clip(band[-1], sku["price"] * 0.88, sku["price"] * 1.12))
    assert 388 <= step <= 392, f"step-1 price {step}"
