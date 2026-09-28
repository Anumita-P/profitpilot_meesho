"""NumPy-only evaluation of the fitted models (SPEC 14.1 / 14.2).

Loads `data/models/v1.json` (30 bootstrap coefficient vectors per model) and evaluates a whole price
grid for one SKU in a handful of matrix multiplies: q(P,M), cod(P,M), rto(P,M), ret(P,M).
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from . import features as F
from .economics import effective_sku, event_tree, quantiles, sample_days

MODEL_VERSION_DEFAULT = "pp-synth-1.0.0"


def _logit(p: np.ndarray) -> np.ndarray:
    p = np.clip(p, 1e-9, 1 - 1e-9)
    return np.log(p / (1 - p))


class ModelBundle:
    def __init__(self, path: str | Path):
        self.path = Path(path)
        if not self.path.exists():
            raise FileNotFoundError(
                f"Model file {self.path} not found. Run `python scripts/train_models.py` first.")
        raw = json.loads(self.path.read_text())
        self.version: str = raw["version"]
        self.trained_at: str = raw["trained_at"]
        self.data_hash: str = raw["data_hash"]
        self.metrics: dict = raw["metrics"]
        self.n_members: int = raw["n_members"]
        self.recovered: dict = raw.get("recovered", {})
        self.coefs: dict[str, np.ndarray] = {
            k: np.asarray(v["coef"], dtype=float) for k, v in raw["models"].items()
        }          # each (M, K+1)
        self.model_meta: dict = {k: {kk: vv for kk, vv in v.items() if kk != "coef"}
                                 for k, v in raw["models"].items()}

    # --- features -------------------------------------------------------------------------------
    @staticmethod
    def _mat(rows: list[list[float]]) -> np.ndarray:
        return np.asarray(rows, dtype=float)

    def _x1(self, sku: dict, prices: np.ndarray) -> np.ndarray:
        return self._mat([F.m1_row(sku, float(p)) for p in prices])

    def _x2(self, sku: dict, prices: np.ndarray, prepaid_inc: float) -> np.ndarray:
        return self._mat([F.m2_row(sku, float(p), prepaid_inc) for p in prices])

    def _x3(self, sku: dict, prices: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        return (self._mat([F.m3_row(sku, 1.0)] * len(prices)),
                self._mat([F.m3_row(sku, 0.0)] * len(prices)))

    def _x4(self, sku_eff: dict, prices: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        return (self._mat([F.m4_row(sku_eff, 1.0, float(p), sku_eff["image_quality"],
                                    sku_eff["pack_quality"]) for p in prices]),
                self._mat([F.m4_row(sku_eff, 0.0, float(p), sku_eff["image_quality"],
                                    sku_eff["pack_quality"]) for p in prices]))

    @staticmethod
    def _sigmoid(z: np.ndarray) -> np.ndarray:
        return 1.0 / (1.0 + np.exp(-np.clip(z, -35, 35)))

    def _apply(self, key: str, X: np.ndarray) -> np.ndarray:
        """(P, K) @ (M, K).T -> (P, M) probabilities."""
        B = self.coefs[key]                      # (M, K+1), first column = intercept
        A = np.hstack([np.ones((X.shape[0], 1)), X])
        return self._sigmoid(A @ B.T)

    # --- public API ------------------------------------------------------------------------------
    def probabilities(self, sku: dict, prices: np.ndarray, sku_eff: dict) -> dict[str, np.ndarray]:
        prices = np.asarray(prices, dtype=float)
        q = self._apply("M1", self._x1(sku_eff, prices))
        cod = self._apply("M2", self._x2(sku, prices, float(sku_eff["prepaid_inc"])))
        x3_cod, x3_pp = self._x3(sku_eff, prices)
        x4_cod, x4_pp = self._x4(sku_eff, prices)
        return dict(q=q, cod=cod, rto_cod=self._apply("M3", x3_cod), rto_pp=self._apply("M3", x3_pp),
                    ret_cod=self._apply("M4", x4_cod), ret_pp=self._apply("M4", x4_pp))

    def block(self, sku: dict, prices: np.ndarray, iv: dict | None = None,
              probe: dict | None = None) -> dict[str, np.ndarray]:
        """All event-tree metrics for `sku` across `prices`, shaped (P, M).

        `probe` is a sensitivity hook used by the explain/sensitivity services: it can shift the
        return or RTO logit, scale demand, or scale freight costs without changing the fitted model.
        """
        sku_eff = effective_sku(sku, iv)
        probs = self.probabilities(sku, prices, sku_eff)
        if probe:
            probs = dict(probs)
            for key in ("ret_cod", "ret_pp"):
                if probe.get("ret_logit_delta"):
                    probs[key] = self._sigmoid(_logit(probs[key]) + float(probe["ret_logit_delta"]))
            for key in ("rto_cod", "rto_pp"):
                if probe.get("rto_logit_delta"):
                    probs[key] = self._sigmoid(_logit(probs[key]) + float(probe["rto_logit_delta"]))
            if probe.get("demand_mult_extra"):
                probs["q"] = np.clip(probs["q"] * float(probe["demand_mult_extra"]), 0.0, 1.0)
            if probe.get("cost_scale"):
                sku_eff = dict(sku_eff)
                for k in ("fwd_shipping", "rev_shipping", "pack_cost", "cost"):
                    sku_eff[k] = float(sku_eff[k]) * float(probe["cost_scale"])
        return event_tree(sku_eff, np.asarray(prices, dtype=float), probs)

    def point(self, sku: dict, price: float, iv: dict | None = None, n_days: int = 600,
              seed: int = 20260928) -> dict:
        """Single-price evaluation with p10/p50/p90 from the bootstrap AND day-level outcome noise."""
        sku_eff = effective_sku(sku, iv)
        prices = np.asarray([float(price)])
        metrics = self.block(sku, prices, iv)
        draws = sample_days(sku_eff, metrics, n_days=n_days, seed=seed)
        out = {}
        for key in ("orders_day", "kept_orders_day", "contribution_day", "per_kept", "leakage"):
            lo, mid, hi = np.percentile(draws[key], [10, 50, 90])
            out[key] = dict(p10=float(lo), p50=float(mid), p90=float(hi))
        # probability/rational metrics: bootstrap spread only (no day-level draw needed)
        for key in ("order_probability", "cod_share", "rto", "return_rate", "nmv_day",
                    "working_capital", "capital_tied", "gmv_day", "contribution_per_impression",
                    "inventory_need_units_day"):
            q = quantiles(metrics[key])
            out[key] = {k: float(v[0]) for k, v in q.items()}
        # per-member day-level distribution (for risk-adjusted objectives and uncertainty drivers)
        out["_members"] = {k: metrics[k][0, :] for k in
                           ("orders_day", "contribution_day", "per_kept", "leakage", "per_order",
                            "working_capital", "kept_orders_day", "inventory_need_units_day")}
        out["_sku_eff"] = sku_eff
        return out

    def day_distribution(self, sku: dict, price: float, iv: dict | None = None, n_days: int = 600
                         ) -> dict[str, np.ndarray]:
        sku_eff = effective_sku(sku, iv)
        metrics = self.block(sku, np.asarray([float(price)]), iv)
        return sample_days(sku_eff, metrics, n_days=n_days)

    def elasticity(self, sku: dict, price: float, iv: dict | None = None, dp: float = 1.0) -> dict:
        """Local elasticity and marginal contribution, derived numerically (SPEC 16.6)."""
        a = self.block(sku, np.asarray([price - dp]), iv)
        b = self.block(sku, np.asarray([price + dp]), iv)
        lo, hi = a["orders_day"][0, :], b["orders_day"][0, :]
        eps = ((hi - lo) / np.maximum(lo, 1e-9)) / ((2 * dp) / price)
        dprod = (b["contribution_day"][0, :] - a["contribution_day"][0, :]) / (2 * dp)
        return dict(elasticity_p50=float(np.median(eps)),
                    marginal_contribution_p50=float(np.median(dprod)),
                    marginal_contribution_p10=float(np.percentile(dprod, 10)),
                    marginal_contribution_p90=float(np.percentile(dprod, 90)))
