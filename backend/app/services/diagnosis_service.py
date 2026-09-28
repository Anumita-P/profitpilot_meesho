"""Diagnosis: 'Why are sales low?' — funnel vs comparables + ranked bottlenecks (SPEC 7.9, M7)."""
from __future__ import annotations

import numpy as np
import pandas as pd
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..database.models import Sku, SkuDailyObs
from ..optimization import search as S
from ..optimization.comparables import load_comparables
from .runtime import bundle, comparables, ece_worst, sku_dict

BENCH = None
CAT_FEATURES = None
STAGES = [("impressions", "Impressions"), ("clicks", "Clicks"), ("orders", "Orders"),
          ("delivered", "Delivered"), ("kept", "Kept (not returned)")]


def _bench() -> pd.DataFrame:
    """Per-SKU rates for the whole synthetic fleet, used as the comparison distribution."""
    global BENCH
    if BENCH is None:
        from pathlib import Path as _P
        base = _P(__file__).resolve().parents[3] / "data" / "synthetic"
        df = pd.read_csv(base / "sku_daily_obs.csv")
        df = df.merge(pd.read_csv(base / "skus.csv", usecols=["sku_id", "category"]), on="sku_id",
                      how="left")
        agg = df.groupby(["sku_id", "category"]).agg(
            impressions=("impressions", "sum"), clicks=("clicks", "sum"), orders=("orders", "sum"),
            delivered=("delivered", "sum"), kept=("kept", "sum"), rto=("rto", "sum"),
            returned=("returned", "sum"), cod=("cod_orders", "sum"), shipped=("shipped", "sum"),
            days=("date", "count")).reset_index()
        agg["ctr"] = agg["clicks"] / agg["impressions"].clip(lower=1)
        agg["conversion"] = agg["orders"] / agg["clicks"].clip(lower=1)
        agg["leakage"] = 1 - (agg["kept"] / agg["orders"].clip(lower=1))
        agg["cod_share"] = agg["cod"] / agg["orders"].clip(lower=1)
        BENCH = agg
    return BENCH


def _cat_features() -> pd.DataFrame:
    """Category-level medians for image quality / rating (catalogue facts, Synthetic)."""
    global CAT_FEATURES
    if CAT_FEATURES is None:
        from pathlib import Path as _P
        skus = pd.read_csv(_P(__file__).resolve().parents[3] / "data" / "synthetic" / "skus.csv")
        CAT_FEATURES = skus.groupby("category").agg(image_quality=("image_quality", "median"),
                                                    rating=("rating", "median"),
                                                    listings=("sku_id", "count"))
    return CAT_FEATURES


def _pct(series: pd.Series, value: float) -> float:
    return float((series <= value).mean())


def funnel(session: Session, sku: dict) -> list[dict]:
    rows = session.execute(select(SkuDailyObs.impressions, SkuDailyObs.clicks, SkuDailyObs.orders,
                                  SkuDailyObs.delivered, SkuDailyObs.kept)
                           .where(SkuDailyObs.sku_id == sku["sku_id"])).all()
    bench = _bench()
    cat = bench[bench.category == sku["category"]]
    totals = dict(zip(["impressions", "clicks", "orders", "delivered", "kept"],
                      np.asarray(rows, dtype=float).sum(axis=0) if rows else [0] * 5))
    out = []
    for i, (key, label) in enumerate(STAGES):
        value = float(totals[key])
        rate = None if i == 0 else value / max(totals[STAGES[i - 1][0]], 1e-9)
        bench_pct = None
        flag = None
        if i == 1:
            bench_pct = _pct(cat["ctr"], totals["clicks"] / max(totals["impressions"], 1))
            flag = "unusually low" if bench_pct < 0.25 else None
        elif i == 2:
            bench_pct = _pct(cat["conversion"], totals["orders"] / max(totals["clicks"], 1))
            flag = "unusually low" if bench_pct < 0.25 else None
        elif i == 4:
            bench_pct = _pct(cat["leakage"], 1 - totals["kept"] / max(totals["orders"], 1))
            flag = "unusually high" if bench_pct > 0.75 else None
        out.append(dict(stage=label, value=value, rate=rate,
                        benchmark_percentile=bench_pct, comparable_skus=int(len(cat)), flag=flag))
    return out


def diagnose_sku(session: Session, seller_id: str, sku_id: str, goal: dict, mode: str | None = None) -> dict:
    row = session.scalar(select(Sku).where(Sku.sku_id == sku_id, Sku.seller_id == seller_id))
    if row is None:
        return {}
    sku = sku_dict(row)
    mode = mode or goal.get("mode", "margin")
    bench = _bench()
    cat = bench[bench.category == sku["category"]]
    f = funnel(session, sku)

    # --- price/margin bottleneck: can any in-corridor price reach the target contribution? -------
    prices = S.in_corridor_grid((sku["corridor_low"], sku["corridor_high"]))
    ev = S.evaluate_candidate(bundle(), sku, None, prices, goal=goal, mode=mode, cmp=comparables(),
                              ece=ece_worst())
    best_kept = float(np.max(ev["sumr"]["per_kept"]["p50"]))
    target = float(goal.get("target_contribution", 60.0))
    price_shortfall = max(0.0, target - best_kept)
    price_gap_z = abs(float(sku["price"]) - float(sku["competitor_price"])) / max(float(sku["price"]), 1)

    # --- demand-side signals ----------------------------------------------------------------------
    ctr_pct = f[1]["benchmark_percentile"] or 0.5
    conv_pct = f[2]["benchmark_percentile"] or 0.5
    img = float(sku["image_quality"])
    rating = float(sku["rating"])
    reviews = int(sku["review_count"])
    leak = float(np.median(ev["sumr"]["leakage"]["p50"]))
    cod = float(np.median(ev["sumr"]["cod_share"]["p50"]))
    cat_med = _cat_features().loc[sku["category"]] if sku["category"] in _cat_features().index else None
    bottles = []

    def add(id_, label, strength, evidence: list[str], action: str, intervention: str | None):
        bottles.append(dict(id=id_, label=label, strength=float(np.clip(strength, 0, 1)),
                            evidence=evidence, action=action, intervention=intervention))

    if img < 0.55 and ctr_pct < 0.4:
        add("listing_image", "Listing image", 1 - ctr_pct,
            [f"Click-through rate is in the bottom {max(1, int(ctr_pct*100))}% of {len(cat)} comparable listings",
             (f"Primary image quality is {img:.2f}; comparable listings in {sku['category']} average "
              f"{cat_med.image_quality:.2f}" if cat_med is not None else
              f"Primary image quality is {img:.2f}"),
             "Impressions and price gap are normal — the listing is seen but not clicked"],
            "Improve the primary image and add a size chart", "LISTING_IMAGE_SEVERE" if img < 0.4 else "LISTING_IMAGE")
    if rating < 4.05 and _pct(cat["leakage"], leak) > 0.5:
        add("rating", "Ratings and reviews", 0.45,
            [f"Rating {rating:.1f} sits below the category median",
             f"{reviews} reviews — thin review base weakens conversion"],
            "Collect reviews on recent orders; fix fit/size complaints first", None)
    if price_shortfall > 0:
        add("price_margin", "Margin vs market ceiling", min(1.0, price_shortfall / max(0.15 * target, 1e-9)),
            [f"Best contribution available inside the corridor is ₹{best_kept:,.0f} per kept order",
             f"That is ₹{price_shortfall:,.0f} short of your ₹{target:,.0f} target",
             f"Your price sits {price_gap_z*100:.1f}% away from the comparable price"],
            "Change the economics of the parcel/bundle rather than the price", "PARCEL_REDESIGN")
    leak_pct = _pct(cat["leakage"], leak)
    if leak_pct > 0.7:
        add("return_risk", "Return / RTO risk", (leak_pct - 0.5),
            [f"Return+RTO is {leak*100:.1f}%, above {int(leak_pct*100)}% of comparable listings",
             f"COD share is {cod*100:.0f}% — COD orders drive most of the RTO",
             "Packaging and prepaid nudges cut this; a discount makes it worse"],
            "Upgrade protective packaging or nudge prepaid", "PACK_PROTECT")
    cover = float(sku["inventory"]) / max(1.0, float(np.median(ev["sumr"]["orders_day"]["p50"])))
    if cover < 10:
        add("inventory", "Inventory cover", 0.6,
            [f"Only {cover:.0f} days of cover at current run-rate",
             "Stock-outs suppress ranking and kill momentum"],
            "Restock before pushing price or ads", None)
    if int(sku["stock_age_days"]) > 60:
        add("stock_age", "Ageing stock", min(1.0, (int(sku["stock_age_days"]) - 60) / 60),
            [f"{int(sku['stock_age_days'])} days since the lot was produced",
             "Ageing stock ties up working capital"],
            "Consider a Clear-mode markdown ladder", None)
    if not bottles:
        add("product_market", "Product-market mismatch", 0.35,
            ["Every measured stage is normal, yet demand is low",
             "Low confidence: this diagnosis is the residual after every other signal came back normal"],
            "Test a different design/style with a small no-ads batch", None)

    bottles.sort(key=lambda b: -b["strength"])
    top = bottles[0]
    is_demand_side = top["id"] not in ("price_margin", "stock_age")
    verdict = dict(
        id="NOT_A_PRICE_PROBLEM" if is_demand_side and top["strength"] >= 0.75 else
           ("MARGIN_ECONOMICS" if top["id"] == "price_margin" else "MIXED"),
        title=("Price is probably NOT your main problem" if is_demand_side and top["strength"] >= 0.75
               else ("Your price cannot reach the target inside the market corridor"
                     if top["id"] == "price_margin" else "Several levers are pulling at once")),
        subtitle=(f"Bottleneck: {top['label']}. A price cut would cost you more contribution than it "
                  f"recovers." if is_demand_side and top["strength"] >= 0.75 else
                  f"Bottleneck: {top['label']}."),
        bottleneck=top["label"], action=top["action"], confidence=("High" if top["strength"] >= 0.8 else "Medium"))

    # expected effect of the recommended action (Estimated, from the same engine)
    expected = None
    if top.get("intervention") and top["intervention"] in ("LISTING_IMAGE", "LISTING_IMAGE_SEVERE",
                                                           "PACK_PROTECT", "PARCEL_REDESIGN"):
        from ..optimization.catalogue import BY_ID
        iv = BY_ID[top["intervention"]].iv
        c_ev = S.evaluate_candidate(bundle(), sku, iv, prices, goal=goal, mode=mode,
                                    cmp=comparables(), ece=ece_worst())
        got = S.best_feasible(c_ev) or S.best_by_objective(c_ev)
        cur = S.pick(ev, int(np.argmin(np.abs(prices - float(sku["price"])))))
        expected = dict(
            action=top["action"], price=got["price"],
            per_kept=got["metrics"]["per_kept"], orders_day=got["metrics"]["orders_day"],
            leakage=got["metrics"]["leakage"], contribution_day=got["metrics"]["contribution_day"],
            delta_contribution_day=got["metrics"]["contribution_day"]["p50"] - cur["metrics"]["contribution_day"]["p50"],
            confidence=got["confidence"], label="Estimated")

    return dict(sku_id=sku_id, mode=mode, goal=goal, funnel=f, bottlenecks=bottles, verdict=verdict,
                expected_effect=expected, price_only=dict(best_in_corridor_kept=best_kept,
                                                          target=target, shortfall=price_shortfall),
                evidence=dict(comparable_listings=int(len(cat)), category=sku["category"]),
                label="estimated", data_label="synthetic")
