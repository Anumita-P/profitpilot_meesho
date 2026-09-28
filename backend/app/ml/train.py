"""Fit M1-M4 on the synthetic dataset with a seed-fixed cluster bootstrap (SPEC 14.1 / 14.5).

M1 demand         P(order | impression)          binomial GLM, counts as weights
M2 payment mix    P(COD | order)                 binomial GLM
M3 delivery/RTO   P(RTO | shipped, payment)      binomial GLM (order-level rows)
M4 returns        P(return | delivered, payment) binomial GLM (order-level rows)

Monotonicity is enforced by bounded coefficients: price coefficient <= 0 (M1, M2), COD coefficient
>= 0 (M3), pack/image coefficients <= 0 (M4). B = 30 cluster-bootstrap members (resampling SKUs
within category) so serving-time ranges reflect SKU-level, not row-level, uncertainty.
"""
from __future__ import annotations

import hashlib
import json
import time
from pathlib import Path

import numpy as np
import pandas as pd

from . import features as F
from .features import CAT_ORDER
from .glm import auc, ece, fit_glm, predict
from .serving import serving_sku

SEED = 20260928
N_MEMBERS = 30
VERSION = "pp-synth-1.0.0"

# index of each constrained coefficient inside the *feature* vector (intercept handled separately)
BOUNDS = {
    "M1": {0: (None, 0.0)},                       # ln(p/ref) <= 0
    "M2": {0: (None, 0.0)},                       # ln(p/ref) <= 0
    "M3": {0: (0.0, None)},                       # cod_flag >= 0
    "M4": {0: (0.0, None), 3: (None, 0.0), 4: (None, 0.0)},   # cod>=0, img<=0, pack_q<=0
}


def _sku_maps(skus: pd.DataFrame) -> dict:
    """Normalise every SKU row through serving_sku so the feature builders see the same keys
    the models were trained on (and at serving time)."""
    return {r["sku_id"]: serving_sku(r.to_dict()) for _, r in skus.iterrows()}


def _design_m1(daily: pd.DataFrame, smap: dict) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    X = np.array([F.m1_row(smap[r.sku_id], r.price) for r in daily.itertuples()])
    return X, daily["orders"].to_numpy(float), daily["impressions"].to_numpy(float)


def _design_m2(daily: pd.DataFrame, smap: dict) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    X = np.array([F.m2_row(smap[r.sku_id], r.price) for r in daily.itertuples()])
    return X, daily["cod_orders"].to_numpy(float), daily["orders"].to_numpy(float)


def _design_m3(orders: pd.DataFrame, smap: dict) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    X = np.array([F.m3_row(smap[r.sku_id], 1.0 if r.payment_mode == "COD" else 0.0)
                  for r in orders.itertuples()])
    shipped = orders["shipped"].to_numpy(float)
    return X, orders["rto"].to_numpy(float), shipped


def _design_m4(orders: pd.DataFrame, smap: dict) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    X = np.array([F.m4_row(smap[r.sku_id], 1.0 if r.payment_mode == "COD" else 0.0, r.price)
                  for r in orders.itertuples()])
    return X, orders["returned"].to_numpy(float), orders["delivered"].to_numpy(float)


def _cluster_bootstrap_indices(clusters: np.ndarray, rng: np.random.Generator) -> np.ndarray:
    """Resample SKU-clusters with replacement, preserving roughly the original row count."""
    rows = np.arange(len(clusters))
    pieces = []
    uniq = np.unique(clusters)
    by_cluster = {c: rows[clusters == c] for c in uniq}
    target = len(rows)
    total = 0
    while total < target:
        c = uniq[rng.integers(0, len(uniq))]
        idx = by_cluster[c]
        pieces.append(idx)
        total += len(idx)
    return np.concatenate(pieces)


def fit_family(name: str, X: np.ndarray, y: np.ndarray, n: np.ndarray, clusters: np.ndarray,
               n_members: int = N_MEMBERS, seed: int = SEED) -> dict:
    rng = np.random.default_rng(seed + abs(hash(name)) % 10000)
    bounds = BOUNDS.get(name)
    full = fit_glm(X, y, n, coef_bounds=bounds)
    members = [full]
    while len(members) < n_members:
        idx = _cluster_bootstrap_indices(clusters, rng)
        if np.sum(n[idx] > 0) < 50:
            continue
        members.append(fit_glm(X[idx], y[idx], n[idx], coef_bounds=bounds))
    return dict(coef=np.array(members).tolist(), full=full)


def holdout_metrics(X: np.ndarray, y: np.ndarray, n: np.ndarray, beta: np.ndarray) -> dict:
    """Held-out weighted log-loss, AUC and ECE (trials as weights)."""
    p_hat = predict(X, beta)
    p_hat_c = np.clip(p_hat, 1e-9, 1 - 1e-9)
    wll = float(-np.sum(n * (p_hat * 0 + (y / np.maximum(n, 1)) * np.log(p_hat_c)
                             + (1 - y / np.maximum(n, 1)) * np.log(1 - p_hat_c))) / np.sum(n))
    return dict(ece=float(ece(y, n, p_hat)), auc=float(auc(y, n, p_hat)), log_loss=wll)


def main(data_dir: str | Path, out_path: str | Path) -> dict:
    data_dir, out_path = Path(data_dir), Path(out_path)
    t0 = time.time()
    skus = pd.read_csv(data_dir / "skus.csv")
    daily = pd.read_csv(data_dir / "sku_daily_obs.csv")
    orders = pd.read_csv(data_dir / "order_events.csv")
    smap = _sku_maps(skus)

    # train/holdout split by SKU (80/20) so calibration is measured on unseen SKUs
    rng = np.random.default_rng(SEED)
    sku_ids = skus["sku_id"].to_numpy()
    hold = set(rng.choice(sku_ids, size=int(0.2 * len(sku_ids)), replace=False))
    d_tr, d_ho = daily[~daily.sku_id.isin(hold)], daily[daily.sku_id.isin(hold)]
    o_tr, o_ho = orders[~orders.sku_id.isin(hold)], orders[orders.sku_id.isin(hold)]

    specs = {
        "M1": (*_design_m1(d_tr, smap), *_design_m1(d_ho, smap)),
        "M2": (*_design_m2(d_tr, smap), *_design_m2(d_ho, smap)),
        "M3": (*_design_m3(o_tr, smap), *_design_m3(o_ho, smap)),
        "M4": (*_design_m4(o_tr, smap), *_design_m4(o_ho, smap)),
    }
    clusters = {
        "M1": d_tr["sku_id"].to_numpy(), "M2": d_tr["sku_id"].to_numpy(),
        "M3": o_tr["sku_id"].to_numpy(), "M4": o_tr["sku_id"].to_numpy(),
    }

    models, metrics = {}, {}
    for name in ("M1", "M2", "M3", "M4"):
        Xtr, ytr, ntr, Xho, yho, nho = specs[name]
        fitted = fit_family(name, Xtr, ytr, ntr, clusters[name])
        models[name] = dict(coef=fitted["coef"], n_train=int(len(Xtr)), n_features=int(Xtr.shape[1]),
                            feature_names=F.FEATURES[name], **holdout_metrics(Xho, yho, nho, fitted["full"]))
        metrics[name] = dict(ece=models[name]["ece"], auc=models[name]["auc"],
                             log_loss=models[name]["log_loss"], n_train=models[name]["n_train"])

    # --- recoverability diagnostics (SPEC 14.1 / 25) ----------------------------------------------
    recovered = {}
    for name, idx in (("M1", 0), ("M2", 0)):
        coefs = np.asarray(models[name]["coef"])
        recovered[name] = dict(
            coef_p50=float(np.median(coefs[:, idx + 1])),
            coef_p10=float(np.percentile(coefs[:, idx + 1], 10)),
            coef_p90=float(np.percentile(coefs[:, idx + 1], 90)))
    # pooled vs randomised-only price coefficient in M1 (the causal-humility disclosure in the UI)
    Xr = np.array([F.m1_row(smap[r.sku_id], r.price) for r in d_tr.itertuples()])
    mask = d_tr["price_source"].to_numpy() == "randomised_ladder"
    beta_rand = fit_glm(Xr[mask], d_tr["orders"].to_numpy(float)[mask],
                        d_tr["impressions"].to_numpy(float)[mask], coef_bounds=BOUNDS["M1"])
    recovered["M1"]["coef_randomised_only"] = float(beta_rand[1])
    recovered["M1"]["hidden_beta_kurti"] = -3.4
    recovered["M1"]["randomised_share"] = float(mask.mean())

    data_hash = hashlib.sha256(
        (data_dir / "sku_daily_obs.csv").read_bytes() + (data_dir / "order_events.csv").read_bytes()
    ).hexdigest()[:16]

    payload = dict(version=VERSION, trained_at=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                   seed=SEED, n_members=N_MEMBERS, data_hash=data_hash, categories=CAT_ORDER,
                   models=models, metrics=metrics, recovered=recovered,
                   train_rows=dict(M1=int(len(d_tr)), M2=int(len(d_tr)), M3=int(len(o_tr)), M4=int(len(o_tr))),
                   label="synthetic")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, indent=1))
    print(f"trained in {time.time()-t0:.1f}s -> {out_path}")
    for name in ("M1", "M2", "M3", "M4"):
        m = metrics[name]
        print(f"  {name}: ECE={m['ece']:.4f}  AUC={m['auc']:.4f}  logloss={m['log_loss']:.4f}  "
              f"n={m['n_train']}")
    print(f"  M1 price coef p50={recovered['M1']['coef_p50']:.3f} "
          f"(randomised-only {recovered['M1']['coef_randomised_only']:.3f}, hidden kurti beta "
          f"{recovered['M1']['hidden_beta_kurti']})")
    return payload


if __name__ == "__main__":
    ROOT = Path(__file__).resolve().parents[3]
    main(ROOT / "data" / "synthetic", ROOT / "data" / "models" / "v1.json")
