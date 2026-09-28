"""Seed SQLite from the synthetic catalogue + dataset (SPEC 26 `make data`)."""
from __future__ import annotations

from pathlib import Path

import pandas as pd
from sqlalchemy import delete, func, select

from ..ml import catalogue as cat
from ..ml.serving import serving_sku
from .models import (AuditLog, Experiment, ModelRegistry, OrderEvent, Recommendation, Seller,
                     SellerGoal, Simulation, Sku, SkuDailyObs, User)
from .session import SessionLocal, engine, init_db

ROOT = Path(__file__).resolve().parents[3]
DATA = ROOT / "data" / "synthetic"

DEMO_USERS = [
    dict(user_id="U-SUNITA", role="seller", name="Sunita (Jaipur Kurtis)", persona="sunita",
         seller_id="S-SUNITA"),
    dict(user_id="U-RAHUL", role="seller", name="Rahul (Surat Wholesale)", persona="rahul",
         seller_id="S-RAHUL"),
    dict(user_id="U-EMPLOYEE", role="employee", name="Meesho Marketplace Analyst", persona="employee",
         seller_id=None),
    dict(user_id="U-CUSTOMER", role="customer", name="Shopper", persona="customer", seller_id=None),
]

# Default goals per demo scenario (SPEC 23, calibrated in docs/DECISIONS.md D1-D4)
DEMO_GOALS = {
    "K-101": dict(target_contribution=60, min_orders=20, max_return_rto=0.18, cash_limit=120000, mode="margin"),
    "K-101B": dict(target_contribution=60, min_orders=20, max_return_rto=0.25, cash_limit=120000, mode="margin"),
    "K-101S": dict(target_contribution=60, min_orders=20, max_return_rto=0.18, cash_limit=135000, mode="cash"),
    "K-207": dict(target_contribution=60, min_orders=20, max_return_rto=0.15, cash_limit=150000, mode="margin"),
    "K-330": dict(target_contribution=60, min_orders=20, max_return_rto=0.15, cash_limit=120000, mode="margin"),
    "K-118": dict(target_contribution=60, min_orders=20, max_return_rto=0.18, cash_limit=100000, mode="margin"),
    "K-101R": dict(target_contribution=0, min_orders=30, max_return_rto=0.18, cash_limit=150000, mode="clear"),
}


def seed_all(reset: bool = True, load_obs: bool = True) -> dict:
    init_db()
    session = SessionLocal()
    try:
        if reset:
            for model in (AuditLog, Recommendation, Simulation, SellerGoal, OrderEvent, SkuDailyObs,
                          Sku, Seller, User, Experiment, ModelRegistry):
                session.execute(delete(model))
            session.commit()

        session.add_all([Seller(**{k: v for k, v in s.items() if k != "user_id"}) for s in cat.SELLERS])
        session.commit()

        skus = cat.all_skus()
        session.add_all([Sku(**{**{k: v for k, v in s.items() if k != "corridor"},
                                "corridor_low": s["corridor"][0], "corridor_high": s["corridor"][1],
                                "gst_rate": cat.gst_rate_for(s["category"], s["ref_price"]),
                                "data_label": "synthetic"}) for s in skus])
        session.commit()

        session.add_all([User(**u) for u in DEMO_USERS])   # only the 4 demo personas can log in
        session.commit()

        for sku_id, goal in DEMO_GOALS.items():
            seller_id = next(s["seller_id"] for s in cat.DEMO_SKUS if s["sku_id"] == sku_id)
            session.add(SellerGoal(seller_id=seller_id, sku_id=sku_id, is_default=True, **goal))
        for seller in cat.SELLERS:
            if seller["seller_id"] in ("S-SUNITA", "S-RAHUL"):
                session.add(SellerGoal(seller_id=seller["seller_id"], sku_id=None, is_default=True,
                                       target_contribution=60, min_orders=20, max_return_rto=0.15,
                                       cash_limit=seller["cash_limit"], mode=seller["default_mode"]))
        session.commit()

        obs_rows = 0
        if load_obs and (DATA / "sku_daily_obs.csv").exists():
            daily = pd.read_csv(DATA / "sku_daily_obs.csv")
            cols = ["sku_id", "date", "price", "price_source", "impressions", "clicks", "orders",
                    "cod_orders", "cancelled", "shipped", "rto", "delivered", "returned", "kept", "nmv"]
            session.bulk_insert_mappings(SkuDailyObs, daily[cols].to_dict("records"))
            obs_rows = len(daily)
            events = pd.read_csv(DATA / "order_events.csv")
            events = events[events.sku_id.isin(cat.DEMO_SKU_IDS)]        # demo SKUs kept at full fidelity
            ecols = ["order_id", "sku_id", "ts", "price", "payment_mode", "zone_tier", "cancelled",
                     "shipped", "delivered", "rto", "returned", "kept", "customer_pseudo_id"]
            session.bulk_insert_mappings(OrderEvent, events[ecols].to_dict("records"))
            session.commit()

        session.add(Experiment(
            name="Randomised price test — Jaipur kurti family (proposed)",
            status="design", min_sample=1200,
            arms={"arms": [{"id": "control", "price_delta_pct": 0},
                           {"id": "arm_up_8", "price_delta_pct": 8},
                           {"id": "arm_down_8", "price_delta_pct": -8}],
                  "opt_in": "seller must opt in per SKU", "randomisation": "SKU-day, randomised price ladder",
                  "primary_metric": "retained contribution per kept order",
                  "guardrail": "return + RTO rate must not exceed the seller's cap by more than 2pp"},
            metric_summary={"status": "not run", "note": "Simulated results are labelled Synthetic; "
                                                        "no experiment has been run on real traffic."},
            rollback_rule="Roll back an arm if its return+RTO rate exceeds the cap for 5 consecutive days",
            data_label="synthetic"))
        session.commit()

        return dict(sellers=len(cat.SELLERS), skus=len(skus), obs_rows=obs_rows,
                    users=len(DEMO_USERS), goals=len(DEMO_GOALS))
    finally:
        session.close()


def db_is_empty() -> bool:
    init_db()
    session = SessionLocal()
    try:
        return session.scalar(select(func.count()).select_from(Sku)) == 0
    finally:
        session.close()


if __name__ == "__main__":
    print(seed_all())
