"""Catalog: seller-scoped SKU cards with estimated economics (SPEC 7.2)."""
from __future__ import annotations

import numpy as np
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..database.models import SellerGoal, Sku
from ..ml.serving import status_of
from ..optimization import search as S
from .runtime import bundle, comparables, ece_worst, goal_dict, sku_dict


def default_goal(session: Session, seller_id: str, sku_id: str | None) -> dict:
    if sku_id:
        row = session.scalar(select(SellerGoal).where(SellerGoal.seller_id == seller_id,
                                                      SellerGoal.sku_id == sku_id)
                             .order_by(SellerGoal.id.desc()))
        if row:
            return goal_dict(row)
    row = session.scalar(select(SellerGoal).where(SellerGoal.seller_id == seller_id,
                                                  SellerGoal.sku_id.is_(None))
                         .order_by(SellerGoal.id.desc()))
    return goal_dict(row)


def sku_card(session: Session, row: Sku, goal: dict) -> dict:
    sku = sku_dict(row)
    mb = bundle()
    price = float(sku["price"])
    metrics = mb.block(sku, np.asarray([price]))
    sumr = S.summaries(metrics, ("orders_day", "kept_orders_day", "leakage", "per_kept",
                                 "contribution_day", "nmv_day", "working_capital"))
    per_kept = sumr["per_kept"]["p50"][0]
    orders = sumr["orders_day"]["p50"][0]
    leak = sumr["leakage"]["p50"][0]
    status = status_of(float(per_kept), float(orders), float(leak), goal)
    return dict(
        sku_id=row.sku_id, name=row.name, category=row.category, seller_id=row.seller_id,
        price=price, corridor=[row.corridor_low, row.corridor_high],
        image_quality=row.image_quality, pack_quality=row.pack_quality, rating=row.rating,
        inventory=row.inventory, stock_age_days=row.stock_age_days,
        demo_role=row.demo_role, flags=row.flags,
        estimated=dict(per_kept=dict(p10=float(sumr["per_kept"]["p10"][0]), p50=float(per_kept),
                                     p90=float(sumr["per_kept"]["p90"][0])),
                       orders_day=dict(p10=float(sumr["orders_day"]["p10"][0]), p50=float(orders),
                                       p90=float(sumr["orders_day"]["p90"][0])),
                       leakage=dict(p10=float(sumr["leakage"]["p10"][0]), p50=float(leak),
                                    p90=float(sumr["leakage"]["p90"][0])),
                       contribution_day=dict(p10=float(sumr["contribution_day"]["p10"][0]),
                                             p50=float(sumr["contribution_day"]["p50"][0]),
                                             p90=float(sumr["contribution_day"]["p90"][0])),
                       nmv_day=dict(p10=float(sumr["nmv_day"]["p10"][0]),
                                    p50=float(sumr["nmv_day"]["p50"][0]),
                                    p90=float(sumr["nmv_day"]["p90"][0]))),
        status=status, label="estimated")


def list_skus(session: Session, seller_id: str, status: str | None = None,
              sort: str = "contribution") -> dict:
    rows = session.scalars(select(Sku).where(Sku.seller_id == seller_id)).all()
    out = []
    for row in rows:
        goal = default_goal(session, seller_id, row.sku_id)
        card = sku_card(session, row, goal)
        card["goal"] = goal
        out.append(card)
    if status and status != "all":
        out = [c for c in out if c["status"]["id"] == status]
    if sort == "orders":
        out.sort(key=lambda c: -c["estimated"]["orders_day"]["p50"])
    elif sort == "name":
        out.sort(key=lambda c: c["name"])
    else:
        out.sort(key=lambda c: -c["estimated"]["per_kept"]["p50"])
    losing = sum(1 for c in out if c["status"]["id"] == "losing")
    watch = sum(1 for c in out if c["status"]["id"] == "watch")
    return dict(skus=out[:12], total=len(out), losing=losing, watch=watch,
                summary=(f"{losing} of {len(out)} listings may be losing money after returns"
                         if losing else f"{len(out)} listings, none flagged as losing money"),
                label="estimated")


def sku_detail(session: Session, seller_id: str, sku_id: str) -> dict | None:
    row = session.scalar(select(Sku).where(Sku.sku_id == sku_id, Sku.seller_id == seller_id))
    if row is None:
        return None
    goal = default_goal(session, seller_id, sku_id)
    card = sku_card(session, row, goal)
    card["goal"] = goal
    card["observed"] = observed_stats(session, sku_id)
    return card


def observed_stats(session: Session, sku_id: str) -> dict:
    from ..database.models import SkuDailyObs
    rows = session.execute(
        select(SkuDailyObs.impressions, SkuDailyObs.clicks, SkuDailyObs.orders, SkuDailyObs.kept,
               SkuDailyObs.cod_orders, SkuDailyObs.rto, SkuDailyObs.delivered, SkuDailyObs.returned)
        .where(SkuDailyObs.sku_id == sku_id)).all()
    if not rows:
        return dict(days=0, note="no history — category prior only")
    arr = np.asarray(rows, dtype=float)
    impr, clicks, orders, kept, cod, rto, delivered, returned = arr.sum(axis=0)
    return dict(days=int(arr.shape[0]), impressions=int(impr), clicks=int(clicks), orders=int(orders),
                ctr=float(clicks / max(impr, 1)), conversion=float(orders / max(clicks, 1)),
                cod_share=float(cod / max(orders, 1)), kept_orders=int(kept),
                units_delivered=int(delivered), units_returned=int(returned),
                label="synthetic")
