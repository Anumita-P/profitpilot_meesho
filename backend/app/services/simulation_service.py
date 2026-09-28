"""What-if simulator: the full price grid (curve) and a single exact point (SPEC 7.6 / 12 #9-#10)."""
from __future__ import annotations

import copy

import numpy as np
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..database.models import Simulation, Sku
from ..ml.economics import effective_sku
from ..optimization import search as S
from .runtime import bundle, comparables, ece_worst, hash_key, iv_hash, sku_dict

CURVE_KEYS = ("orders_day", "contribution_day", "per_kept", "leakage", "cod_share", "rto",
              "return_rate", "kept_orders_day", "nmv_day", "order_probability",
              "contribution_per_impression", "working_capital")
CONSTRAINT_IDS = ("contribution_floor", "volume_floor", "return_cap", "corridor", "max_price_move",
                  "inventory", "cash", "confidence")
LABEL_CHIP = "estimated"


def _risk_adjusted(sumr: dict) -> dict:
    p10, p50, p90 = (sumr["contribution_day"][q] for q in ("p10", "p50", "p90"))
    sigma = (p90 - p10) / 2.56
    ra = p50 - sigma
    return dict(p10=ra - sigma, p50=ra, p90=ra + sigma)


def curve(session: Session, seller_id: str, sku_id: str, goal: dict, iv: dict | None = None,
          price_min: float | None = None, price_max: float | None = None, step: int = 1) -> dict:
    row = session.scalar(select(Sku).where(Sku.sku_id == sku_id, Sku.seller_id == seller_id))
    if row is None:
        return {}
    sku = sku_dict(row)
    mode = goal.get("mode", "margin")
    prices = S.curve_grid((sku["corridor_low"], sku["corridor_high"]), price_min, price_max, step)
    key = hash_key("curve", sku_id, goal, iv_hash(iv), list(prices), bundle().version)
    cached = session.scalar(select(Simulation).where(Simulation.sku_id == sku_id,
                                                     Simulation.goal_hash == key,
                                                     Simulation.intervention_hash == iv_hash(iv),
                                                     Simulation.model_version == bundle().version))
    if cached:
        return cached.result_json

    evaluated = S.evaluate_candidate(bundle(), sku, iv, prices, goal=goal, mode=mode,
                                     cmp=comparables(), ece=ece_worst())
    sumr = evaluated["sumr"]
    sumr["risk_adjusted_contribution_day"] = _risk_adjusted(sumr)
    checks = evaluated["checks"]

    best = S.best_feasible(evaluated)
    argmax_orders = float(prices[int(np.argmax(sumr["orders_day"]["p50"]))])
    argmax_contrib = float(prices[int(np.argmax(sumr["contribution_day"]["p50"]))])
    annotation = ("Highest orders ≠ highest retained contribution."
                  if abs(argmax_orders - argmax_contrib) > 12 else None)

    payload = dict(
        sku_id=sku_id, price_current=float(sku["price"]),
        corridor=[float(sku["corridor_low"]), float(sku["corridor_high"])],
        model_version=bundle().version, label=LABEL_CHIP, goal=goal, mode=mode,
        intervention=iv or {}, prices=[float(p) for p in prices],
        series={k: {q: [float(v) for v in sumr[k][q]] for q in ("p10", "p50", "p90")}
                for k in CURVE_KEYS + ("risk_adjusted_contribution_day",)},
        constraints={cid: [bool(checks[cid][i]) for i in range(len(prices))] for cid in CONSTRAINT_IDS
                     if cid in checks},
        markers=dict(
            current=dict(price=float(sku["price"])),
            recommended=(dict(price=best["price"], objective=best["objective"],
                              confidence=best["confidence"]) if best else None),
            argmax_orders=argmax_orders, argmax_contribution=argmax_contrib, annotation=annotation),
        evidence=dict(n_eff_p50=float(np.median(evaluated["n_eff"])),
                      extrapolation_band=dict(
                          outside_low=[float(p) for p in prices if p < sku["corridor_low"]][:3],
                          outside_high=[float(p) for p in prices if p > sku["corridor_high"]][:3])),
        meta=dict(points=int(len(prices)), max_price_move=0.12, bootstrap_members=bundle().n_members))
    try:
        session.add(Simulation(sku_id=sku_id, goal_hash=key, intervention_hash=iv_hash(iv),
                               model_version=bundle().version, mode=mode, result_json=payload))
        session.commit()
    except Exception:                      # concurrent identical request: the cache row already exists
        session.rollback()
    return payload


def point(session: Session, seller_id: str, sku_id: str, price: float, goal: dict,
          iv: dict | None = None) -> dict:
    from ..optimization import constraints as K
    row = session.scalar(select(Sku).where(Sku.sku_id == sku_id, Sku.seller_id == seller_id))
    if row is None:
        return {}
    sku = sku_dict(row)
    mode = goal.get("mode", "margin")
    mb = bundle()
    out = mb.point(sku, price, iv)
    members = out["_members"]

    # confidence (SPEC 20)
    cmp = comparables()
    n_eff = float(cmp.n_eff(sku["category"], np.asarray([price]))[0])
    gap = float(cmp.extrapolation_pct(sku["category"], np.asarray([price]))[0])
    width = float((members["per_kept"].max() - members["per_kept"].min()))
    width_rel = float((np.percentile(members["per_kept"], 90) - np.percentile(members["per_kept"], 10))
                      / max(abs(np.median(members["per_kept"])), 1e-9))
    from ..optimization.comparables import confidence_label
    label = str(confidence_label(n_eff=n_eff, gap=gap, width=width_rel, ece=ece_worst())[0])

    checks = K.evaluate(price=float(price), corridor=(sku["corridor_low"], sku["corridor_high"]),
                        current_price=float(sku["price"]), goal=goal, mode=mode,
                        per_kept_p50=out["per_kept"]["p50"], per_kept_p10=out["per_kept"]["p10"],
                        orders_day=out["orders_day"]["p50"], leakage=out["leakage"]["p50"],
                        working_capital=out["working_capital"]["p50"],
                        inventory_need_units_day=out["inventory_need_units_day"]["p50"],
                        inventory=float(sku["inventory"]), confidence_label=label)

    metrics = {k: v for k, v in out.items() if not k.startswith("_")}
    sigma = (members["contribution_day"].max() - members["contribution_day"].min()) / 2.56
    metrics["risk_adjusted_contribution_day"] = dict(
        p10=metrics["contribution_day"]["p10"] - sigma,
        p50=metrics["contribution_day"]["p50"] - sigma,
        p90=metrics["contribution_day"]["p90"] - sigma)
    return dict(price=float(price), sku_id=sku_id, model_version=mb.version, label=LABEL_CHIP,
                goal=goal, mode=mode, intervention=iv or {}, metrics=metrics,
                constraints=checks, confidence=_confidence_block(label, n_eff, gap, width_rel,
                                                                 sku, price, iv, mode, goal),
                event_tree=event_tree_block(sku, price, iv, mode, goal, label),
                elasticity=mb.elasticity(sku, price, iv))


def _confidence_block(label: str, n_eff: float, gap: float, width: float, sku: dict, price: float,
                      iv: dict | None, mode: str, goal: dict) -> dict:
    return dict(label=label, n_eff=n_eff, n_comparable=int(n_eff), extrapolation_pct=gap,
                band_width=width, drivers=uncertainty_drivers(sku, price, iv),
                rule=("High: n_eff ≥ 1000, no extrapolation, band ≤ 15%, ECE ≤ 0.03 · "
                      "Low: n_eff < 300 or extrapolation > 15% or band > 40% or ECE > 0.06"))


def uncertainty_drivers(sku: dict, price: float, iv: dict | None, top: int = 4) -> list[dict]:
    """One-at-a-time variance decomposition over the five model blocks (SPEC 20)."""
    mb = bundle()
    base_coefs = mb.coefs
    price_arr = np.asarray([price])
    names = {"M1": "demand elasticity", "M2": "COD slope", "M3": "RTO", "M4": "return rate"}
    shares = []
    for key, label in names.items():
        coefs = dict(base_coefs)
        for other in base_coefs:
            m = np.median(base_coefs[other], axis=0)
            coefs[other] = np.tile(m, (base_coefs[other].shape[0], 1))
        coefs[key] = base_coefs[key]
        clone = copy.copy(mb)
        clone.coefs = coefs
        metrics = clone.block(sku, price_arr, iv)
        shares.append((label, float(np.var(metrics["contribution_day"][0, :]))))
    # freight sensitivity (cost side, not a model block)
    sku_shift = dict(sku)
    sku_shift["fwd_shipping"] = sku["fwd_shipping"] * 1.5
    sku_shift["rev_shipping"] = sku["rev_shipping"] * 1.5
    m_hi = mb.block(sku_shift, price_arr, iv)["contribution_day"][0, :]
    sku_shift2 = dict(sku)
    sku_shift2["fwd_shipping"] = sku["fwd_shipping"] * 0.5
    sku_shift2["rev_shipping"] = sku["rev_shipping"] * 0.5
    m_lo = mb.block(sku_shift2, price_arr, iv)["contribution_day"][0, :]
    shares.append(("freight", float(np.var(np.concatenate([m_hi, m_lo])))))
    total = sum(s for _, s in shares) or 1.0
    ranked = sorted(((n, s / total) for n, s in shares), key=lambda t: -t[1])[:top]
    return [dict(name=n, share=round(s, 3)) for n, s in ranked]


def event_tree_block(sku: dict, price: float, iv: dict | None, mode: str, goal: dict,
                     label: str) -> dict:
    """Branch probabilities and per-branch ₹ for the Why? drawer (SPEC 19)."""
    mb = bundle()
    metrics = mb.block(sku, np.asarray([price]), iv)
    sku_eff = effective_sku(sku, iv)
    def p(k):
        return float(np.median(np.asarray(metrics[k], dtype=float)))
    kept = p("kept_prob")
    canc = float(sku_eff["cancel_rate"])
    delivered = p("deliv_mass")
    return_p = p("return_rate")
    rto = p("rto")
    kept_val = p("kept_val")
    ret_val = p("ret_val")
    rto_val = p("rto_val")
    per_order = p("per_order")
    branches = [
        dict(id="kept", label="Delivered and kept", probability=kept * (1 - canc) if False else kept,
             value_inr=kept_val),
        dict(id="returned", label="Delivered then returned", probability=delivered * (1 - canc) * return_p,
             value_inr=ret_val),
        dict(id="rto", label="RTO (refused / undelivered)", probability=(1 - delivered) * (1 - canc),
             value_inr=rto_val),
        dict(id="cancelled", label="Cancelled before shipping", probability=canc, value_inr=0.0),
    ]
    total_p = sum(b["probability"] for b in branches)
    for b in branches:
        b["probability"] = float(b["probability"] / total_p) if total_p else 0.0
        b["share_of_orders"] = b["probability"]
    return dict(price=float(price), units_per_order=int(sku_eff["units_per_order"]),
                probabilities=dict(kept=kept, delivered=delivered, returned=return_p, rto=rto,
                                   cancelled=canc, cod_share=p("cod_share")),
                per_order_inr=dict(kept_val=kept_val, returned_val=ret_val, rto_val=rto_val,
                                   expected=per_order),
                branches=branches, label=label, mode=mode)


def snapshot(session: Session, seller_id: str, sku_id: str, goal: dict) -> dict:
    """Current-price economics + the 'where each ₹ goes' waterfall (SPEC 7.5)."""
    row = session.scalar(select(Sku).where(Sku.sku_id == sku_id, Sku.seller_id == seller_id))
    if row is None:
        return {}
    sku = sku_dict(row)
    price = float(sku["price"])
    pt = point(session, seller_id, sku_id, price, goal, None)
    et = pt["event_tree"]
    per_order = et["per_order_inr"]
    gst = price - price / (1 + float(sku["gst_rate"]))
    payment = float(sku["pay_var"]) * price
    steps = [
        dict(label="List price", value=price, kind="start"),
        dict(label=f"GST ({float(sku['gst_rate'])*100:.0f}%, treated as a cost)", value=-gst, kind="cost"),
        dict(label="Product cost", value=-float(sku["cost"]), kind="cost"),
        dict(label="Packaging", value=-float(sku["pack_cost"]), kind="cost"),
        dict(label="Forward freight", value=-float(sku["fwd_shipping"]), kind="cost"),
        dict(label="Payment fee + ads", value=-(payment + float(sku["ad_cost"])), kind="cost"),
        dict(label="Expected return / RTO / cancellation loss",
             value=per_order["expected"] - per_order["kept_val"], kind="loss"),
    ]
    subtotal = sum(s["value"] for s in steps)
    steps.append(dict(label="Contribution per placed order", value=subtotal, kind="subtotal"))
    kept_rate = float(pt["metrics"]["kept_orders_day"]["p50"] / max(pt["metrics"]["orders_day"]["p50"], 1e-9))
    steps.append(dict(label=f"÷ kept rate {kept_rate*100:.0f}% (orders that survive)",
                      value=float(pt["metrics"]["per_kept"]["p50"]) - subtotal, kind="adjust"))
    steps.append(dict(label="Contribution per kept order", value=float(pt["metrics"]["per_kept"]["p50"]),
                      kind="total"))
    return dict(
        sku_id=sku_id, price=price, corridor=[float(sku["corridor_low"]), float(sku["corridor_high"])],
        hero=dict(metric="contribution per kept order",
                  value=pt["metrics"]["per_kept"],
                  confidence=pt["confidence"], label="estimated"),
        kept_rate=kept_rate,
        waterfall=steps,
        secondary=dict(orders_day=pt["metrics"]["orders_day"],
                       kept_orders_day=pt["metrics"]["kept_orders_day"],
                       leakage=pt["metrics"]["leakage"],
                       nmv_day=pt["metrics"]["nmv_day"],
                       working_capital=pt["metrics"]["working_capital"],
                       capital_tied=pt["metrics"]["capital_tied"]),
        observed=observed_row(session, sku_id),
        footnotes=["Unit costs are Illustrative seller inputs. In production these come from the seller's ledger.",
                   "Ranges are p10–p90 across 30 bootstrap model members and day-level outcome noise (Synthetic data).",
                   f"Model {bundle().version} · trained on {bundle().n_members} bootstrap members"],
        label="estimated")


def observed_row(session: Session, sku_id: str) -> dict:
    """Latest observed SKU-day (Synthetic) so the seller can compare model vs history."""
    from ..database.models import SkuDailyObs
    row = session.scalars(select(SkuDailyObs).where(SkuDailyObs.sku_id == sku_id)
                          .order_by(SkuDailyObs.date.desc()).limit(1)).first()
    if row is None:
        return {}
    return dict(date=row.date, price=row.price, impressions=row.impressions, clicks=row.clicks,
                orders=row.orders, kept=row.kept, rto=row.rto, returned=row.returned, nmv=row.nmv,
                label="synthetic")
