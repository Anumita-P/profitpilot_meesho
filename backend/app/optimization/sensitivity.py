"""Sensitivity analysis (SPEC 15.6): does the *intervention type* change under ±50% perturbations?"""
from __future__ import annotations

import copy
import itertools

import numpy as np

from . import search as S

PERTURBATIONS = [
    ("demand elasticity", "elasticity"),
    ("COD price slope", "cod_slope"),
    ("return-rate level", "return_level"),
    ("freight cost", "freight"),
]


def perturbed_bundle(mb, kind: str, factor: float):
    """Return a clone of the model bundle with one block perturbed by `factor`."""
    clone = copy.copy(mb)
    coefs = {k: v.copy() for k, v in mb.coefs.items()}
    if kind == "elasticity":                       # M1 coefficient on ln(p/ref)
        coefs["M1"][:, 1] *= factor
    elif kind == "cod_slope":                      # M2 coefficients on ln(p/ref) and its z3 interaction
        coefs["M2"][:, 1] *= factor
        coefs["M2"][:, 2] *= factor
    elif kind == "return_level":                   # M4 intercept (level of the return rate)
        coefs["M4"][:, 0] = coefs["M4"][:, 0] - np.abs(coefs["M4"][:, 0]) * (factor - 1.0) * 0.5
    clone.coefs = coefs
    return clone


def price_only_outcome(mb, sku: dict, goal: dict, mode: str, cmp, ece: float, probe: dict | None = None) -> dict:
    prices = S.in_corridor_grid((sku["corridor_low"], sku["corridor_high"]))
    ev = S.evaluate_candidate(mb, sku, None, prices, goal=goal, mode=mode, cmp=cmp, ece=ece,
                              probe=probe)
    best = S.best_feasible(ev)
    return dict(verdict=("PRICE_WORKS" if best else "PRICE_INFEASIBLE"), best=best, evaluated=ev)


def analyse(mb, sku: dict, goal: dict, mode: str, cmp, ece: float) -> dict:
    base = price_only_outcome(mb, sku, goal, mode, cmp, ece)
    flips: list[dict] = []
    for label, kind in PERTURBATIONS:
        for factor, direction in ((1.5, "up 50%"), (0.5, "down 50%")):
            if kind == "freight":
                out = price_only_outcome(mb, sku, goal, mode, cmp, ece, probe=dict(cost_scale=factor))
            else:
                out = price_only_outcome(perturbed_bundle(mb, kind, factor), sku, goal, mode, cmp, ece)
            verdict_changed = out["verdict"] != base["verdict"]
            price_moved = (base["best"] and out["best"] and
                           abs(out["best"]["price"] - base["best"]["price"]) > 15.0)
            if verdict_changed or price_moved:
                flips.append(dict(parameter=label, direction=direction,
                                  effect=("verdict flips to " + out["verdict"]) if verdict_changed
                                  else f"recommended price moves to ₹{out['best']['price']:.0f}"))
    return dict(robust=not flips,
                sensitive_to=sorted({f["parameter"] for f in flips}),
                details=flips,
                tested=[f"{label} ±50%" for label, _ in PERTURBATIONS],
                statement=("Robust across ±50% on elasticity, COD effect, return level and freight."
                           if not flips else
                           "Recommendation is sensitive to: " + ", ".join(sorted({f["parameter"] for f in flips})) + "."))


def pairs(items: list[str]) -> list[tuple[str, str]]:
    return list(itertools.combinations(items, 2))
