"""Comparable-observation evidence and the confidence system (SPEC 14.2 / 20).

`n_eff(price)` = kernel-weighted count of SKU-days in the same category whose listed price is within
±10% of the query price. It drives both the evidence badge and the NEEDS_EVIDENCE verdict.
"""
from __future__ import annotations

from functools import lru_cache
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[3]
DATA = ROOT / "data" / "synthetic" / "sku_daily_obs.csv"
SKUS = ROOT / "data" / "synthetic" / "skus.csv"
PRICE_WINDOW = 0.10
MIN_COMPARABLE = 30


class Comparables:
    """Precomputed per-category price arrays so n_eff is one vectorised comparison per price grid."""

    def __init__(self, daily: pd.DataFrame):
        self.by_cat: dict[str, np.ndarray] = {}
        self.cat_range: dict[str, tuple[float, float]] = {}
        self.counts = daily.groupby("category").size().to_dict()
        for cat, grp in daily.groupby("category"):
            prices = grp["price"].to_numpy(float)
            self.by_cat[cat] = np.sort(prices)
            self.cat_range[cat] = (float(np.percentile(prices, 2)), float(np.percentile(prices, 98)))

    def n_eff(self, category: str, prices: np.ndarray, kernel: bool = True) -> np.ndarray:
        ref = self.by_cat.get(category)
        if ref is None or ref.size == 0:
            return np.zeros_like(prices)
        prices = np.atleast_1d(np.asarray(prices, dtype=float))
        rel = np.abs(prices[:, None] - ref[None, :]) / np.maximum(prices[:, None], 1e-9)
        inside = rel <= PRICE_WINDOW
        if not kernel:
            return inside.sum(axis=1).astype(float)
        w = np.clip(1.0 - (rel / PRICE_WINDOW) ** 2, 0.0, None)      # Epanechnikov-ish kernel
        return (w * inside).sum(axis=1)

    def n_comparable(self, category: str, price: float) -> int:
        return int(self.n_eff(category, np.asarray([price]), kernel=False)[0])

    def extrapolation_pct(self, category: str, prices: np.ndarray) -> np.ndarray:
        lo, hi = self.cat_range.get(category, (0.0, 1e9))
        width = max(hi - lo, 1e-9)
        p = np.atleast_1d(np.asarray(prices, dtype=float))
        gap = np.where(p < lo, lo - p, np.where(p > hi, p - hi, 0.0))
        return gap / width


@lru_cache(maxsize=1)
def load_comparables() -> Comparables:
    daily = pd.read_csv(DATA, usecols=["sku_id", "price"])
    skus = pd.read_csv(SKUS, usecols=["sku_id", "category"])
    return Comparables(daily.merge(skus, on="sku_id", how="left"))


def confidence_label(*, n_eff: np.ndarray | float, gap: np.ndarray | float, width: np.ndarray | float,
                     ece: float) -> np.ndarray:
    """Vectorised SPEC 20 label rule."""
    n_eff = np.atleast_1d(np.asarray(n_eff, dtype=float))
    gap = np.atleast_1d(np.asarray(gap, dtype=float)) * np.ones_like(n_eff)     # scalar -> vector
    width = np.atleast_1d(np.asarray(width, dtype=float)) * np.ones_like(n_eff)
    high = (n_eff >= 1000) & (gap <= 0.0) & (width <= 0.15) & (ece <= 0.03)
    low = (n_eff < 300) | (gap > 0.15) | (width > 0.40) | (ece > 0.06)
    out = np.where(high, "High", np.where(low, "Low", "Medium"))
    return out


def as_plain(label: str) -> str:
    return label if label in ("Low", "Medium", "High") else "Low"
