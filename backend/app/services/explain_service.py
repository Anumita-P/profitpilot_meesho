"""Explainability: the 10 pipeline nodes (SPEC 7.10/14.6) and the counterfactual attribution (SPEC 19)."""
from __future__ import annotations

import numpy as np
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..database.models import Sku
from ..ml import features as F
from ..ml.economics import effective_sku, event_tree
from ..optimization import search as S
from .runtime import bundle, comparables, ece_worst, sku_dict

NODE_LABELS = [
    "SKU + seller context", "Demand", "Payment mix", "Delivery / RTO", "Returns",
    "Lifecycle economics", "Counterfactual simulator", "Constraint optimiser", "Recommendation",
    "Explanation + confidence",
]
MODEL_META = {
    "M1": dict(name="Demand model", target="P(order | impression)", form="Binomial GLM (logistic)",
               sentence="How likely a shopper who sees the listing is to order, given price, image, rating and competition."),
    "M2": dict(name="Payment-mix model", target="P(COD | order)",
               form="Binomial GLM (logistic)",
               sentence="How the price and any prepaid incentive change the share of cash-on-delivery orders."),
    "M3": dict(name="RTO model", target="P(RTO | shipped order, payment mode)", form="Binomial GLM (logistic)",
               sentence="How likely a shipped COD order is to come back undelivered."),
    "M4": dict(name="Return model", target="P(return | delivered, payment mode)", form="Binomial GLM (logistic)",
               sentence="How likely a delivered order is to be returned, given fit risk, image and packaging quality."),
}


def _drivers(model_key: str, row: list[float], names: list[str], top: int = 4) -> list[dict]:
    coefs = np.median(bundle().coefs[model_key], axis=0)[1:]
    contrib = np.asarray(row[:len(coefs)], dtype=float) * coefs[:len(row)]
    total = float(np.sum(np.abs(contrib))) or 1.0
    idx = np.argsort(-np.abs(contrib))[:top]
    return [dict(name=names[i], direction=("up" if contrib[i] > 0 else "down"),
                 share=round(abs(float(contrib[i])) / total, 3), effect_logit=round(float(contrib[i]), 3))
            for i in idx]


def pipeline(session: Session, seller_id: str, sku_id: str) -> dict:
    row = session.scalar(select(Sku).where(Sku.sku_id == sku_id, Sku.seller_id == seller_id))
    if row is None:
        return {}
    sku = sku_dict(row)
    mb = bundle()
    price = float(sku["price"])
    prices = np.asarray([price])
    m = mb.block(sku, prices)
    med = lambda k: float(np.median(m[k][0]))  # noqa: E731
    q_row = F.m1_row(sku, price)
    x2_row = F.m2_row(sku, price)
    x3_row = F.m3_row(sku, 1.0)
    x4_row = F.m4_row(sku, 1.0, price)
    po = S.evaluate_candidate(mb, sku, None,
                              S.in_corridor_grid((sku["corridor_low"], sku["corridor_high"])),
                              goal=dict(target_contribution=60, min_orders=20, max_return_rto=0.15,
                                        cash_limit=None), mode="margin",
                              cmp=comparables(), ece=ece_worst())
    best = S.best_by_objective(po)
    metrics = {k: dict(ece=mb.metrics[k]["ece"], auc=mb.metrics[k]["auc"],
                       log_loss=mb.metrics[k]["log_loss"], n_train=mb.metrics[k]["n_train"]) for k in mb.metrics}

    def node(i, label, prediction, inputs, output, confidence, interpretation, drivers=None, model=None,
             extra=None):
        d = dict(index=i, label=label, prediction=prediction, inputs=inputs, output_for_sku=output,
                 confidence=confidence, interpretation=interpretation, drivers=drivers or [], model=model,
                 model_type=(MODEL_META[model]["form"] if model else "Deterministic (event tree)"),
                 n_train=(metrics[model]["n_train"] if model else None),
                 calibration_error=(round(metrics[model]["ece"], 4) if model else None))
        if extra:
            d.update(extra)
        return d

    nodes = [
        node(1, NODE_LABELS[0], "Context for this listing",
             ["category", "cost", "corridor", "rating", "image_quality", "pack_quality",
              "seller return history", "inventory", "stock age"],
             f"{sku['category']} · ₹{sku['price']:,.0f} · image {sku['image_quality']:.2f} · pack {sku['pack_quality']:.2f}",
             "High", "Nothing is predicted here — this is the row every later node reads."),
        node(2, NODE_LABELS[1], MODEL_META["M1"]["sentence"],
             F.FEATURES["M1"], f"order probability {med('order_probability')*100:.2f}% → "
                               f"{med('orders_day'):.1f} orders/day at ₹{price:,.0f}",
             "High" if mb.metrics["M1"]["ece"] <= 0.03 else "Low",
             "Demand falls as price rises; image quality and ratings shift the whole curve.",
             _drivers("M1", q_row, F.FEATURES["M1"]), "M1"),
        node(3, NODE_LABELS[2], MODEL_META["M2"]["sentence"], F.FEATURES["M2"],
             f"COD share {med('cod_share')*100:.0f}% at ₹{price:,.0f}",
             "Medium", "Lower prices attract more COD orders, and COD orders fail delivery far more often.",
             _drivers("M2", x2_row, F.FEATURES["M2"]), "M2"),
        node(4, NODE_LABELS[3], MODEL_META["M3"]["sentence"], F.FEATURES["M3"],
             f"RTO {med('rto')*100:.1f}% (COD {med('rto_cod')*100:.1f}% vs prepaid {med('rto_pp')*100:.1f}%)",
             "Medium", "The COD flag is the single biggest driver of failed deliveries.",
             _drivers("M3", x3_row, F.FEATURES["M3"]), "M3"),
        node(5, NODE_LABELS[4], MODEL_META["M4"]["sentence"], F.FEATURES["M4"],
             f"return rate {med('return_rate')*100:.1f}% of delivered orders",
             "Medium", "Better images and packaging reduce returns; COD orders return more often.",
             _drivers("M4", x4_row, F.FEATURES["M4"]), "M4"),
        node(6, NODE_LABELS[5], "Deterministic event tree over the four models above",
             ["kept/returned/RTO/cancelled branch probabilities", "GST", "product, packing, freight, ad costs"],
             f"₹{med('per_kept'):,.0f} per kept order · ₹{med('contribution_day'):,.0f}/day at ₹{price:,.0f}",
             "High", "Every cost has exactly one owner, and a return costs twice: forward and reverse freight."),
        node(7, NODE_LABELS[6], "Re-prices the whole lifecycle for every candidate price and lever",
             ["intervention catalogue", "price grid inside the corridor", "1,000s of counterfactual evaluations"],
             f"{len(S.in_corridor_grid((sku['corridor_low'], sku['corridor_high'])))} prices × "
             f"intervention grid evaluated", "Medium",
             "This is what a calculator cannot do: return and COD rates move with the price."),
        node(8, NODE_LABELS[7], "Applies the seller's goal and guardrails",
             ["contribution floor", "volume floor", "return cap", "corridor", "max price move",
              "inventory", "cash", "confidence"],
             f"best in-corridor contribution ₹{best['metrics']['per_kept']['p50']:,.0f} per kept order at ₹{best['price']:,.0f}",
             "Medium", "A candidate must clear every constraint to be recommended."),
        node(9, NODE_LABELS[8], "Ranks feasible options by the seller-mode objective",
             ["mode objective", "risk adjustment", "trade-offs"],
             "see the Levers tab", "Medium",
             "Ties break toward lower uncertainty and fewer changes required."),
        node(10, NODE_LABELS[9], "Turns the numbers into the five answers and a confidence label",
             ["bootstrap ranges", "comparable-observation counts", "±50% sensitivity"],
             "see any recommendation card", "Medium",
             "If confidence is Low, the product refuses to recommend and asks for a controlled test."),
    ]
    return dict(sku_id=sku_id, version=mb.version, nodes=nodes,
                technical=dict(metrics=metrics, n_members=mb.n_members, data_hash=mb.data_hash,
                               trained_at=mb.trained_at, label="synthetic", recovered=mb.recovered,
                               n_train_rows=mb.metrics and {k: mb.metrics[k]["n_train"] for k in mb.metrics}))


def _event_tree_from_blocks(q, cod, rto_cod, rto_pp, ret_cod, ret_pp, sku_eff, price: float) -> dict:
    probs = dict(q=q, cod=cod, rto_cod=rto_cod, rto_pp=rto_pp, ret_cod=ret_cod, ret_pp=ret_pp)
    return event_tree(sku_eff, np.asarray([price]), probs)


def explanation(session: Session, seller_id: str, sku_id: str, price: float, iv: dict | None = None,
                compare_price: float | None = None, compare_iv: dict | None = None) -> dict:
    row = session.scalar(select(Sku).where(Sku.sku_id == sku_id, Sku.seller_id == seller_id))
    if row is None:
        return {}
    sku = sku_dict(row)
    mb = bundle()
    a_price, b_price = (compare_price if compare_price is not None else float(sku["price"])), float(price)
    a_iv, b_iv = (compare_iv or None), iv
    a_eff, b_eff = effective_sku(sku, a_iv), effective_sku(sku, b_iv)
    pa = mb.probabilities(sku, np.asarray([a_price]), a_eff)
    pb = mb.probabilities(sku, np.asarray([b_price]), b_eff)
    block_a = {k: v[0] for k, v in pa.items()}
    block_b = {k: v[0] for k, v in pb.items()}
    cur = _event_tree_from_blocks(**block_a, sku_eff=a_eff, price=a_price)
    tgt = _event_tree_from_blocks(**block_b, sku_eff=b_eff, price=b_price)

    # sequential one-block-at-a-time attribution in a fixed order (SPEC 19)
    state = dict(block_a)
    cost_eff = dict(a_eff)
    cost_eff["fwd_shipping"] = b_eff["fwd_shipping"]
    cost_eff["rev_shipping"] = b_eff["rev_shipping"]
    cost_eff["pack_cost"] = b_eff["pack_cost"]
    steps, prev = [], float(np.median(cur["per_order"][0]))
    plan = [
        ("price effect on demand", "q", a_eff, b_price),
        ("COD-mix effect", "cod", cost_eff, b_price),
        ("RTO effect", "rto", cost_eff, b_price),
        ("return effect", "ret", cost_eff, b_price),
        ("freight effect", "fwd", cost_eff, b_price),
        ("packaging cost", "pack", cost_eff, b_price),
    ]
    for label, key, eff_used, price_now in plan:
        if key in ("q", "cod"):
            state[key] = block_b[key]
        elif key in ("rto", "ret"):
            state[f"{key}_cod"] = block_b[f"{key}_cod"]
            state[f"{key}_pp"] = block_b[f"{key}_pp"]
        elif key == "fwd":
            eff_used = dict(eff_used)
            eff_used["fwd_shipping"] = b_eff["fwd_shipping"]
            eff_used["rev_shipping"] = b_eff["rev_shipping"]
        elif key == "pack":
            eff_used = dict(eff_used)
            eff_used["pack_cost"] = b_eff["pack_cost"]
        et = _event_tree_from_blocks(**state, sku_eff=eff_used, price=price_now)
        now = float(np.median(et["per_order"][0]))
        steps.append(dict(block=label, delta_inr=now - prev))
        prev = now

    total = float(np.median(tgt["per_order"][0]) - np.median(cur["per_order"][0])) or 1e-9
    attribution = [dict(block=s["block"], delta_inr=round(s["delta_inr"], 2),
                        share=round(s["delta_inr"] / total, 3)) for s in steps]
    return dict(sku_id=sku_id, from_=dict(price=a_price, iv=a_iv or {}), to=dict(price=b_price, iv=b_iv or {}),
                current=dict(probabilities=dict(kept=float(np.median(cur["kept_prob"][0])),
                                                leaked=float(np.median(cur["leakage"][0])),
                                                rto=float(np.median(cur["rto"][0])),
                                                returned=float(np.median(cur["return_rate"][0]))),
                             per_order=float(np.median(cur["per_order"][0])),
                             per_kept=float(np.median(cur["per_kept"][0])),
                             contribution_day=float(np.median(cur["contribution_day"][0]))),
                recommended=dict(probabilities=dict(kept=float(np.median(tgt["kept_prob"][0])),
                                                    leaked=float(np.median(tgt["leakage"][0])),
                                                    rto=float(np.median(tgt["rto"][0])),
                                                    returned=float(np.median(tgt["return_rate"][0]))),
                                 per_order=float(np.median(tgt["per_order"][0])),
                                 per_kept=float(np.median(tgt["per_kept"][0])),
                                 contribution_day=float(np.median(tgt["contribution_day"][0]))),
                attribution=attribution, label="estimated")
