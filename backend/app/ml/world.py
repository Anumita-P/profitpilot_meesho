"""ProfitPilot ground-truth world (SYNTHETIC).

Faithful port of `docs/reference_world.py` (the spec's Appendix A) with documented, additive
extensions required by SPEC 13.1:

  * per-category parameters (a_cat, beta_cat, cat_rto, cat_ret, base impressions, reference price)
  * a zone-tier-3 exposure parameter (`z3`) that makes COD propensity, the price->COD slope and the
    COD->RTO penalty heterogeneous across SKUs. This is the observable structural marker that lets
    the fitted models recover the "COD-heavy market" variant (Scenario B) and gives the RTO model a
    legitimate input (SPEC 14.1 M3 lists `zone_tier` as an input).

All extensions are ZERO for the demo SKUs used by the verified goldens (they carry z3=0 and live in
BASE-consistent categories), so every golden number in SPEC 13.4 reproduces exactly.

This module is used ONLY by data generation and by tests. Seller-facing endpoints read the fitted
models in `ml/inference.py`, never this file.
"""
from __future__ import annotations

import math

_SIG = lambda x: 1.0 / (1.0 + math.exp(-x))  # noqa: E731


def sigmoid(x: float) -> float:
    return _SIG(x)


BASE = dict(cost=196, pack_cost=8, fwd=64, rev=70, restock=10, pay_var=0.015, ads=12, gst=0.05,
            pref=399, comp=389, comp_w=1.0, rating=4.1, img=0.62, impr=760, a0=-3.75, beta=-3.4,
            cod0=0.15, cod_slope=1.8, rto0=-3.3, rto_cod=1.15, ret0=-2.75, ret_cod=0.55,
            seller_hist=0.1, fit_risk=0.35, pack_q=0.5, canc=0.03)

# Documented extension coefficients (Illustrative calibration; see docs/DECISIONS.md D1).
# Calibrated so the COD-heavy variant (z3 = 0.9) satisfies SPEC 13.4 scenario B:
#   leakage(₹349) - leakage(₹429) = 3.8pp (>= 3pp) and COD(₹349) - COD(₹429) = 20.6pp (>= 10pp),
# while keeping the SKU's *level* of leakage realistic (21-26%) instead of an implausible 35%+.
# The gains hit the price *slope* rather than the intercept, which is what moves the contrast.
EXT = dict(cod_zone_gain=0.4444, cod_zone_slope_gain=3.0, rto_zone_gain=0.9444,
           cat_rto=0.0, cat_ret=0.0, z3=0.0)


def _eff(s: dict) -> dict:
    """Effective parameters after the additive extensions. z3 defaults to 0 => reference world."""
    z3 = float(s.get("z3", EXT["z3"]))
    return dict(
        cod0=s["cod0"] + EXT["cod_zone_gain"] * z3,
        cod_slope=s["cod_slope"] + EXT["cod_zone_slope_gain"] * z3,
        rto0=s["rto0"] + float(s.get("cat_rto", EXT["cat_rto"])),
        rto_cod=s["rto_cod"] + EXT["rto_zone_gain"] * z3,
        ret0=s["ret0"] + float(s.get("cat_ret", EXT["cat_ret"])),
    )


def world(s: dict, p: float, iv: dict | None = None) -> dict:
    """Reference world: probabilities for one SKU at per-unit price p under intervention iv."""
    iv = iv or {}
    eff = _eff(s)
    img = s["img"] + iv.get("img_delta", 0.0)
    pack_q = s["pack_q"] + iv.get("pack_delta", 0.0)
    z = (s["a0"] + s["beta"] * math.log(p / s["pref"]) + 0.9 * (s["rating"] - 4.0)
         + 1.6 * (img - 0.5) + 0.25 * s["comp_w"] * math.log(s["comp"] / p))
    q = _SIG(z)
    cod = _SIG(eff["cod0"] - eff["cod_slope"] * math.log(p / s["pref"]) - 0.03 * iv.get("prepaid_inc", 0.0))
    rto_m = lambda c: _SIG(eff["rto0"] + eff["rto_cod"] * c + 0.6 * s["seller_hist"])  # noqa: E731
    ret_m = lambda c: _SIG(eff["ret0"] + s["ret_cod"] * c + 0.9 * s["seller_hist"]        # noqa: E731
                           + 1.0 * (1 - img) + 0.8 * s["fit_risk"] - 1.2 * pack_q
                           + 0.5 * math.log(p / s["pref"]))
    rto = cod * rto_m(1) + (1 - cod) * rto_m(0)
    deliv_mass = cod * (1 - rto_m(1)) + (1 - cod) * (1 - rto_m(0))
    ret_c = (cod * (1 - rto_m(1)) * ret_m(1) + (1 - cod) * (1 - rto_m(0)) * ret_m(0)) / deliv_mass
    return dict(q=q, cod=cod, rto=rto, deliv=1 - rto, ret_c=ret_c, canc=s["canc"],
                rto_cod=rto_m(1.0), rto_pp=rto_m(0.0), ret_cod=ret_m(1.0), ret_pp=ret_m(0.0),
                deliv_mass=deliv_mass,
                orders=s["impr"] * q * iv.get("demand_mult", 1.0))


def econ(s: dict, p: float, iv: dict | None = None) -> dict:
    """p = per-unit listed price. Bundle: iv={'bundle':2,'bundle_ship_mult':1.35,'demand_mult':0.72}."""
    iv = iv or {}
    w = world(s, p, iv)
    n = iv.get("bundle", 1)
    price = p * n
    cost = s["cost"] * n
    pack = s["pack_cost"] + iv.get("pack_cost_delta", 0.0)
    m = 1 if n == 1 else iv["bundle_ship_mult"]
    fwd = (s["fwd"] + iv.get("fwd_delta", 0.0)) * m
    rev = (s["rev"] + iv.get("fwd_delta", 0.0)) * m
    v = price / (1 + s["gst"])
    pay = s["pay_var"] * price
    inc_cost = iv.get("prepaid_inc", 0.0) * (1 - w["cod"])
    kept_val = v - cost - pack - fwd - pay - s["ads"] - inc_cost
    ret_val = -(fwd + rev + s["restock"] * n + pack) - 0.5 * s["ads"]
    rto_val = -(fwd + pack)
    c, d, r = w["canc"], w["deliv"], w["ret_c"]
    kept = (1 - c) * d * (1 - r)
    per_order = kept * kept_val + (1 - c) * d * r * ret_val + (1 - c) * (1 - d) * rto_val
    leak = 1 - d * (1 - r)
    return dict(w, kept=kept, leak=leak, kept_val=kept_val, ret_val=ret_val, rto_val=rto_val,
                per_order=per_order, per_kept=per_order / kept, kept_orders=w["orders"] * kept,
                contrib_day=w["orders"] * per_order, units_per_order=n)


# --- Scenario SKUs used by the verified goldens (SPEC 13.3 / 13.4) -------------------------------
SKU_K207 = dict(BASE, cost=214, impr=640)                                     # Scenario C
SKU_K330 = dict(BASE, cost=205, fwd=88, rev=92, impr=700, pack_q=0.35)        # Scenario D (before fix)
SKU_K330_FIX = dict(SKU_K330, fwd=64, rev=68, pack_cost=12, pack_q=0.75)      # after parcel + packaging
SKU_K118 = dict(BASE, img=0.25, rating=4.0)                                   # Scenario F
