"""Bridge between catalogue/DB rows and the model's feature inputs."""
from __future__ import annotations

from .catalogue import CATEGORIES, SELLERS, gst_rate_for

_SELLER_HIST = {s["seller_id"]: s["hist"] for s in SELLERS}


def seller_hist(seller_id: str) -> float:
    return float(_SELLER_HIST.get(seller_id, 0.10))


def serving_sku(row: dict) -> dict:
    """Normalise a SKU row (catalogue dict or DB row dict) into the dict the models consume."""
    category = row["category"]
    cfg = CATEGORIES.get(category, CATEGORIES["kurti"])
    ref = float(row.get("ref_price") or row.get("price") or cfg["base_price"])
    return dict(
        sku_id=row["sku_id"], name=row.get("name", row["sku_id"]), seller_id=row["seller_id"],
        category=category, cost=float(row["cost"]), price=float(row.get("price", ref)),
        ref_price=ref, competitor_price=float(row.get("competitor_price", ref * 0.97)),
        corridor_low=float(row.get("corridor_low", ref * 0.87)),
        corridor_high=float(row.get("corridor_high", ref * 1.08)),
        rating=float(row.get("rating", 4.1)), review_count=int(row.get("review_count", 100)),
        image_quality=float(row.get("image_quality", 0.6)), pack_quality=float(row.get("pack_quality", 0.5)),
        fwd_shipping=float(row.get("fwd_shipping", cfg["fwd"])),
        rev_shipping=float(row.get("rev_shipping", cfg["rev"])),
        pack_cost=float(row.get("pack_cost", cfg["pack"])),
        ad_cost=float(row.get("ad_cost", 12.0)), restock_cost=float(row.get("restock_cost", 10.0)),
        pay_var=float(row.get("pay_var", 0.015)),
        gst_rate=float(row.get("gst_rate") or gst_rate_for(category, ref)),
        impressions_per_day=int(row.get("impressions_per_day", cfg["impr"])),
        inventory=int(row.get("inventory", 200)), stock_age_days=int(row.get("stock_age_days", 20)),
        zone3_share=float(row.get("zone3_share", 0.0)),
        seller_hist=seller_hist(row["seller_id"]),
        cancel_rate=float(row.get("cancel_rate", 0.03)),
        flags=row.get("flags") or {},
        data_label="synthetic",
    )


def status_of(per_kept: float, orders_day: float, leakage: float, goal: dict) -> dict:
    """Catalog status pill: icon + text (never colour alone)."""
    target = float(goal.get("target_contribution", 60.0))
    min_orders = float(goal.get("min_orders", 20.0))
    cap = float(goal.get("max_return_rto", 0.15))
    if per_kept < 0 or per_kept < 0.5 * target:
        return dict(id="losing", label="Losing money", icon="alert")
    if per_kept < target or orders_day < min_orders or leakage > cap:
        return dict(id="watch", label="Watch", icon="eye")
    return dict(id="healthy", label="Healthy", icon="check")
