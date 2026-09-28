"""Binomial GLM (logistic regression) fitted by IRLS in NumPy.

Why not sklearn for the fit itself: the product needs B = 30 bootstrap coefficient vectors evaluated
vectorised at serving time. IRLS gives the exact MLE, is deterministic, needs no pickled estimator,
and keeps `data/models/v1.json` a plain, inspectable file. `tests/model/test_glm.py` cross-checks the
fitted coefficients against `sklearn.linear_model.LogisticRegression` (sklearn stays in requirements).
"""
from __future__ import annotations

import numpy as np


def fit_glm(X: np.ndarray, y: np.ndarray, n_trials: np.ndarray | None = None,
            max_iter: int = 60, tol: float = 1e-9, ridge: float = 1e-8,
            coef_bounds: dict[int, tuple[float, float | None]] | None = None) -> np.ndarray:
    """Binomial GLM MLE via IRLS with an intercept.

    X: (N, K) features (intercept added internally), y: (N,) successes, n_trials: (N,) trials.
    coef_bounds: optional {index: (lo, hi)} applied to the *feature* (not intercept) after each step,
    used to enforce economics-sign constraints (e.g. price coefficient <= 0).
    """
    N, K = X.shape
    A = np.hstack([np.ones((N, 1)), X])
    n = np.ones(N) if n_trials is None else n_trials.astype(float)
    y = y.astype(float)
    beta = np.zeros(K + 1)
    # sensible start: intercept = logit(base rate)
    p0 = float(np.clip(y.sum() / max(n.sum(), 1.0), 1e-4, 1 - 1e-4))
    beta[0] = np.log(p0 / (1 - p0))
    for _ in range(max_iter):
        eta = np.clip(A @ beta, -35, 35)
        mu = 1.0 / (1.0 + np.exp(-eta))
        w = n * mu * (1 - mu)
        # guard against zero weights (perfect separation on tiny cells)
        w = np.maximum(w, 1e-8)
        z = eta + (y - n * mu) / np.maximum(n * mu * (1 - mu), 1e-9)
        Aw = A * w[:, None]
        H = A.T @ Aw + ridge * np.eye(K + 1)
        g = A.T @ (w * (z - eta))
        try:
            step = np.linalg.solve(H, g)
        except np.linalg.LinAlgError:  # pragma: no cover - numerically degenerate
            step = np.linalg.lstsq(H, g, rcond=None)[0]
        beta = beta + step
        if coef_bounds:
            for j, (lo, hi) in coef_bounds.items():
                idx = j + 1
                if lo is not None:
                    beta[idx] = max(beta[idx], lo)
                if hi is not None:
                    beta[idx] = min(beta[idx], hi)
        if np.max(np.abs(step)) < tol:
            break
    return beta


def predict(X: np.ndarray, beta: np.ndarray) -> np.ndarray:
    A = np.hstack([np.ones((X.shape[0], 1)), X])
    return 1.0 / (1.0 + np.exp(-np.clip(A @ beta, -35, 35)))


def ece(y: np.ndarray, n: np.ndarray, p_hat: np.ndarray, bins: int = 10) -> float:
    """Expected calibration error for aggregated binomial cells.

    `y` = successes (count or 0/1), `n` = trials, `p_hat` = predicted probability per trial.
    """
    y = y.astype(float)
    n = n.astype(float)
    order = np.argsort(p_hat)
    p_hat = p_hat[order]
    y_s, n_s = y[order], n[order]
    cum = np.cumsum(n_s)
    edges = np.linspace(0, cum[-1], bins + 1)
    total = max(cum[-1], 1e-9)
    err = 0.0
    for b in range(bins):
        lo, hi = edges[b], edges[b + 1]
        mask = (cum > lo) & (cum <= hi)
        wb = n_s[mask].sum()
        if wb <= 0:
            continue
        obs = float(y_s[mask].sum() / wb)
        pred = float((p_hat[mask] * n_s[mask]).sum() / wb)
        err += (wb / total) * abs(obs - pred)
    return float(err)


def auc(y: np.ndarray, n: np.ndarray, p_hat: np.ndarray) -> float:
    """Weighted AUC that works for both binary rows (n=1) and aggregated cells (counts)."""
    y = y.astype(float)
    w_pos = float(y.sum())
    neg_w = n.astype(float) - y
    w_neg = float(neg_w.sum())
    if w_pos <= 0 or w_neg <= 0:
        return 0.5
    order = np.argsort(p_hat)
    p_sorted, y_s, neg_s = p_hat[order], y[order], neg_w[order]
    num, neg_before, i = 0.0, 0.0, 0
    while i < len(p_sorted):
        j = i
        while j + 1 < len(p_sorted) and p_sorted[j + 1] == p_sorted[i]:
            j += 1
        grp_y, grp_neg = float(y_s[i:j + 1].sum()), float(neg_s[i:j + 1].sum())
        num += grp_y * (neg_before + 0.5 * grp_neg)
        neg_before += grp_neg
        i = j + 1
    return float(num / (w_pos * w_neg))
