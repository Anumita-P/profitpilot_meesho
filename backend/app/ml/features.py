"""Shared feature builders: one definition used by both `train.py` and `inference.py`.

Keeping the builders in one place is what makes the fitted model reproducible at serving time
(same order, same transforms, same category dummy coding).
"""
from __future__ import annotations

import math

from .catalogue import CATEGORIES

CAT_ORDER = list(CATEGORIES)          # stable category order; first is the reference level
CAT_INDEX = {c: i for i, c in enumerate(CAT_ORDER)}


def cat_dummies(category: str) -> list[float]:
    """Reference-level coding (first category dropped)."""
    i = CAT_INDEX.get(category, 0)
    return [0.0] * (len(CAT_ORDER) - 1) if i == 0 else \
        [1.0 if j == i - 1 else 0.0 for j in range(len(CAT_ORDER) - 1)]


def ln(x: float) -> float:
    return math.log(max(x, 1e-9))


# --- feature definitions -------------------------------------------------------------------------
FEATURES = {
    # M1 demand: P(order | impression).  True world: a_cat + beta*ln(p/ref) + 0.9(rating-4)
    # + 1.6(img-0.5) + 0.25*comp_w*ln(comp/p)
    "M1": ["ln_p_ref", "ln_comp_p", "rating_c", "img_c"] + [f"cat_{c}" for c in CAT_ORDER[1:]],
    # M2 payment mix: P(COD | order)
    "M2": ["ln_p_ref", "ln_p_ref_x_z3", "z3", "prepaid_inc"] + [f"cat_{c}" for c in CAT_ORDER[1:]],
    # M3 delivery/RTO: P(RTO | shipped order, payment mode)
    "M3": ["cod_flag", "cod_flag_x_z3", "z3", "seller_hist"] + [f"cat_{c}" for c in CAT_ORDER[1:]],
    # M4 return: P(return | delivered, payment mode)
    "M4": ["cod_flag", "fit_risk", "ln_p_ref", "img", "pack_q", "seller_hist"]
          + [f"cat_{c}" for c in CAT_ORDER[1:]],
}


def m1_row(sku: dict, price: float, category: str | None = None) -> list[float]:
    cat = category or sku["category"]
    ref = sku["ref_price"]
    return [ln(price / ref), ln(sku["competitor_price"] / price),
            sku["rating"] - 4.0, sku["image_quality"] - 0.5] + cat_dummies(cat)


def m2_row(sku: dict, price: float, prepaid_inc: float = 0.0, category: str | None = None) -> list[float]:
    cat = category or sku["category"]
    z3 = float(sku.get("zone3_share", 0.0))
    lp = ln(price / sku["ref_price"])
    return [lp, lp * z3, z3, prepaid_inc] + cat_dummies(cat)


def m3_row(sku: dict, cod_flag: float, category: str | None = None) -> list[float]:
    cat = category or sku["category"]
    z3 = float(sku.get("zone3_share", 0.0))
    return [cod_flag, cod_flag * z3, z3, float(sku.get("seller_hist", 0.1))] + cat_dummies(cat)


def m4_row(sku: dict, cod_flag: float, price: float, image_quality: float | None = None,
           pack_quality: float | None = None, category: str | None = None) -> list[float]:
    """`image_quality` / `pack_quality` may be overridden to model interventions."""
    cat = category or sku["category"]
    img = sku["image_quality"] if image_quality is None else image_quality
    pq = sku["pack_quality"] if pack_quality is None else pack_quality
    return [cod_flag, float(CATEGORIES[cat]["fit_risk"]), ln(price / sku["ref_price"]), img, pq,
            float(sku.get("seller_hist", 0.1))] + cat_dummies(cat)
