"""Shared runtime singletons: the fitted model bundle and the comparable-observation index."""
from __future__ import annotations

import hashlib
import json
from functools import lru_cache

from ..config import settings
from ..ml.economics import effective_sku
from ..ml.inference import ModelBundle
from ..ml.serving import serving_sku
from ..optimization.comparables import load_comparables


@lru_cache(maxsize=1)
def bundle() -> ModelBundle:
    return ModelBundle(settings.model_path)


@lru_cache(maxsize=1)
def comparables():
    return load_comparables()


def ece_worst() -> float:
    """Worst held-out calibration error across M1-M4 (feeds the confidence rule)."""
    meta = bundle().metrics
    return max(meta[k]["ece"] for k in ("M1", "M2", "M3", "M4"))


def sku_dict(row) -> dict:
    """SQLAlchemy Sku row -> plain dict the models consume."""
    if isinstance(row, dict):
        return serving_sku(row)
    data = {c.name: getattr(row, c.name) for c in row.__table__.columns}
    return serving_sku(data)


def goal_dict(row) -> dict:
    if row is None:
        return dict(target_contribution=60.0, min_orders=20.0, max_return_rto=0.15,
                    cash_limit=75000.0, mode="margin")
    if isinstance(row, dict):
        return dict(target_contribution=float(row.get("target_contribution", 60)),
                    min_orders=float(row.get("min_orders", 20)),
                    max_return_rto=float(row.get("max_return_rto", 0.15)),
                    cash_limit=(None if row.get("cash_limit") is None else float(row["cash_limit"])),
                    mode=str(row.get("mode", "margin")))
    return dict(target_contribution=float(row.target_contribution), min_orders=float(row.min_orders),
                max_return_rto=float(row.max_return_rto),
                cash_limit=(None if row.cash_limit is None else float(row.cash_limit)),
                mode=str(row.mode))


def goal_public(goal) -> dict:
    """Goal as the UI carries it (mode is separate from the numeric goal).

    Accepts a pydantic model (API request body) or a plain dict (tests/services).
    """
    if hasattr(goal, "model_dump"):
        goal = goal.model_dump()
    return dict(target_contribution=goal["target_contribution"], min_orders=goal["min_orders"],
                max_return_rto=goal["max_return_rto"], cash_limit=goal["cash_limit"])


def hash_key(*parts) -> str:
    return hashlib.md5(json.dumps(parts, sort_keys=True, default=str).encode()).hexdigest()[:16]


def iv_hash(iv: dict | None) -> str:
    return hash_key(iv or {})


def iv_label(iv: dict | None) -> str:
    if not iv:
        return "no intervention"
    bits = []
    for k, v in sorted(iv.items()):
        if v in (0, 0.0, 1.0, None) and k not in ("bundle",):
            continue
        bits.append(f"{k}={v}")
    return ", ".join(bits) or "no intervention"


def effective(sku: dict, iv: dict | None) -> dict:
    return effective_sku(sku, iv)
