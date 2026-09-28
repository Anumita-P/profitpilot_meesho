"""Event-tree economics (SPEC 16.2-16.5) over fitted-model probabilities.

Everything is vectorised over (P prices, M bootstrap members). Every cost has exactly one owner, and
`leakage = 1 - d*(1-r_bar)` is the "return + RTO rate" the seller sees.
"""
from __future__ import annotations

import numpy as np

from ..config import settings

COST_OF_CAPITAL_ANNUAL = 0.24        # Illustrative (SPEC 15.5)
RESTOCK_PER_UNIT_RATIO = 0.0         # restock cost is carried explicitly on the SKU

# --- intervention -> effective SKU features -------------------------------------------------------
DEFAULT_IV = dict(img_delta=0.0, pack_delta=0.0, pack_cost_delta=0.0, fwd_delta=0.0, prepaid_inc=0.0,
                  bundle=1, bundle_ship_mult=1.35, demand_mult=1.0, bundle_price_factor=1.0,
                  one_time_cost=0.0, amortise_days=30, units_per_order=None)


def effective_sku(sku: dict, iv: dict | None = None) -> dict:
    """Apply an intervention to the SKU's decision-relevant features."""
    v = dict(DEFAULT_IV)
    if iv:
        v.update({k: val for k, val in iv.items() if val is not None})
    n = int(v["bundle"])
    img = float(min(1.0, sku["image_quality"] + v["img_delta"]))
    pack_q = float(min(1.0, sku["pack_quality"] + v["pack_delta"]))
    ship_mult = 1.0 if n == 1 else float(v["bundle_ship_mult"])
    out = dict(sku)
    out.update(
        image_quality=img, pack_quality=pack_q,
        pack_cost=float(sku["pack_cost"] + v["pack_cost_delta"]),
        fwd_shipping=float((sku["fwd_shipping"] + v["fwd_delta"]) * ship_mult),
        rev_shipping=float((sku["rev_shipping"] + v["fwd_delta"]) * ship_mult),
        units_per_order=n,
        **{k: v[k] for k in ("prepaid_inc", "demand_mult", "bundle_price_factor", "one_time_cost",
                             "amortise_days")})
    return out


def event_tree(sku_eff: dict, prices: np.ndarray, probs: dict[str, np.ndarray]) -> dict[str, np.ndarray]:
    """Compute every SPEC 16 metric. Shapes are (P prices, M members).

    probs: q, cod, rto_cod, rto_pp, ret_cod, ret_pp each shaped (P, M) in [0,1].
    """
    n = int(sku_eff["units_per_order"])
    price = prices[:, None] * n * float(sku_eff["bundle_price_factor"])
    q, cod = probs["q"], probs["cod"]
    rto_cod, rto_pp = probs["rto_cod"], probs["rto_pp"]
    ret_cod, ret_pp = probs["ret_cod"], probs["ret_pp"]
    canc = float(sku_eff["cancel_rate"])
    gst = float(sku_eff["gst_rate"])

    rto_mix = cod * rto_cod + (1 - cod) * rto_pp
    d = 1.0 - rto_mix
    deliv_mass = cod * (1 - rto_cod) + (1 - cod) * (1 - rto_pp)
    ret_bar = (cod * (1 - rto_cod) * ret_cod + (1 - cod) * (1 - rto_pp) * ret_pp) / np.maximum(deliv_mass, 1e-9)
    leak = 1.0 - d * (1.0 - ret_bar)
    kept = (1.0 - canc) * d * (1.0 - ret_bar)

    v = price / (1.0 + gst) - float(sku_eff["pay_var"]) * price \
        - float(sku_eff["prepaid_inc"]) * (1.0 - cod)
    kept_val = v - n * float(sku_eff["cost"]) - float(sku_eff["pack_cost"]) \
        - float(sku_eff["fwd_shipping"]) - float(sku_eff["ad_cost"])
    ret_val = -(float(sku_eff["fwd_shipping"]) + float(sku_eff["rev_shipping"])
                + n * float(sku_eff["restock_cost"]) + float(sku_eff["pack_cost"])) \
        - 0.5 * float(sku_eff["ad_cost"])
    rto_val = -(float(sku_eff["fwd_shipping"]) + float(sku_eff["pack_cost"]))

    per_order = kept * kept_val + (1 - canc) * d * ret_bar * ret_val + (1 - canc) * rto_mix * rto_val
    orders_day = float(sku_eff["impressions_per_day"]) * q * float(sku_eff["demand_mult"])
    kept_orders_day = orders_day * kept
    contrib_day = orders_day * per_order \
        - float(sku_eff["one_time_cost"]) / max(float(sku_eff["amortise_days"]), 1.0)
    per_kept = per_order / np.maximum(kept, 1e-9)
    returns_day = orders_day * leak

    wc_flow = orders_day * (n * float(sku_eff["cost"]) + float(sku_eff["pack_cost"])
                            + float(sku_eff["fwd_shipping"])) * (settings.t_deliv_days + settings.t_settle_days) \
        + returns_day * (n * float(sku_eff["cost"])) * settings.t_return_loop_days
    capital_tied = float(sku_eff["inventory"]) * n * float(sku_eff["cost"]) + wc_flow
    capital_cost_day = wc_flow * (COST_OF_CAPITAL_ANNUAL / 365.0)

    return dict(price=price, order_probability=q, orders_day=orders_day, cod_share=cod,
                rto=rto_mix, rto_cod=rto_cod, rto_pp=rto_pp, return_rate=ret_bar,
                deliv_mass=deliv_mass, leakage=leak, kept_prob=kept,
                kept_orders_day=kept_orders_day, contribution_day=contrib_day,
                per_kept=per_kept, per_order=per_order, kept_val=kept_val, ret_val=ret_val,
                rto_val=rto_val, gmv_day=orders_day * price, nmv_day=kept_orders_day * price / (1.0 + gst),
                working_capital=wc_flow, capital_tied=capital_tied,
                capital_cost_day=capital_cost_day,
                contribution_per_impression=q * per_order - capital_cost_day / float(sku_eff["impressions_per_day"]),
                inventory_need_units_day=orders_day * n)


def quantiles(arr: np.ndarray) -> dict[str, np.ndarray]:
    """p10/p50/p90 across the bootstrap (member) axis."""
    lo, mid, hi = np.percentile(arr, [10, 50, 90], axis=1)
    return dict(p10=lo, p50=mid, p90=hi)


def sample_days(sku_eff: dict, metrics: dict[str, np.ndarray], n_days: int = 600,
                seed: int = 20260928) -> dict[str, np.ndarray]:
    """Day-level outcome noise for the single-price endpoint (Poisson orders, binomial lifecycle).

    Returns arrays shaped (M * n_days,) of the empirical daily distribution, so the ranges shown in
    the UI include both parameter and outcome uncertainty (SPEC 20: never show a bare number).
    """
    rng = np.random.default_rng(seed)
    m = metrics["orders_day"].shape[1]
    orders_rate = metrics["orders_day"][0, :]                     # (M,)
    canc = float(sku_eff["cancel_rate"])
    cod = metrics["cod_share"][0, :]
    rto_mix = metrics["rto"][0, :] if np.ndim(metrics["rto"]) == 2 else np.full(m, metrics["rto"])
    ret_bar = metrics["return_rate"][0, :]
    flat = lambda x: np.full(m, float(np.asarray(x).reshape(-1)[0]))   # noqa: E731
    kept_val = flat(metrics["kept_val"])        # per-order branch values are scalars per price
    ret_val = flat(metrics["ret_val"])
    rto_val = flat(metrics["rto_val"])

    orders = rng.poisson(np.repeat(orders_rate, n_days))           # (M*n_days,)
    cancelled = rng.binomial(orders, canc)
    shipped = orders - cancelled
    rto = rng.binomial(shipped, np.repeat(rto_mix, n_days))
    delivered = shipped - rto
    returned = rng.binomial(delivered, np.repeat(ret_bar, n_days))
    kept = delivered - returned
    contribution = (kept * np.repeat(kept_val, n_days) + returned * np.repeat(ret_val, n_days)
                    + rto * np.repeat(rto_val, n_days))
    per_kept = contribution / np.maximum(kept, 1)
    return dict(orders_day=orders.astype(float), kept_orders_day=kept.astype(float),
                contribution_day=contribution, per_kept=per_kept,
                leakage=np.repeat(metrics["leakage"][0, :], n_days))
