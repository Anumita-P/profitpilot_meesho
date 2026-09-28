"""Gate-2 spot check: do the FITTED models reproduce the world's golden numbers?"""
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
sys.path.insert(0, str(ROOT / "docs"))

from app.ml.catalogue import DEMO_SKUS  # noqa: E402
from app.ml.inference import ModelBundle  # noqa: E402
from app.ml.serving import serving_sku  # noqa: E402
from app.ml.world import econ  # noqa: E402

mb = ModelBundle(ROOT / "data" / "models" / "v1.json")
sku_by_id = {s["sku_id"]: serving_sku(s) for s in DEMO_SKUS}

print("=== fitted coefficients (p50 across 30 bootstrap members) ===")
for name, feats in (("M1", ["ln_p_ref", "ln_comp_p", "rating_c", "img_c"]),
                    ("M2", ["ln_p_ref", "ln_p_ref_x_z3", "z3", "prepaid_inc"]),
                    ("M3", ["cod_flag", "cod_flag_x_z3", "z3", "seller_hist"]),
                    ("M4", ["cod_flag", "fit_risk", "ln_p_ref", "img", "pack_q", "seller_hist"])):
    coefs = mb.coefs[name]
    med = np.median(coefs, axis=0)
    print(f"  {name}: intercept={med[0]:+.3f} " + "  ".join(f"{f}={med[i+1]:+.3f}" for i, f in enumerate(feats)))

CASES = [
    ("K-101", 349, None, 36.5, 24.66, 731.4),
    ("K-101", 399, None, 22.8, 71.35, 1324.7),
    ("K-101", 429, None, 17.65, 99.38, 1427.3),
    ("K-101", 399, {"prepaid_inc": 20}, 22.8, 61.42, 1162.0),
    ("K-207", 399, None, 19.2, 53.35, 834.1),
    ("K-207", 389, None, 21.0, 44.01, 752.4),
    ("K-207", 349.5, {"bundle": 2, "bundle_ship_mult": 1.35, "demand_mult": 0.72,
                      "pack_delta": 0.35, "pack_cost_delta": 4}, 22.0, 93.45, 1725.0),
    ("K-207", 349.5, {"bundle": 2, "bundle_ship_mult": 1.35, "demand_mult": 0.72}, 22.0, 90.58, 1620.9),
    ("K-207", 399, {"img_delta": 0.18}, 25.4, 56.09, 1175.8),
    ("K-207", 399, {"pack_delta": 0.35, "pack_cost_delta": 4}, 19.23, 54.43, 878.7),
    ("K-330", 399, None, 21.04, 27.25, 457.7),
    ("K-330", 369, None, 27.71, -0.68, -14.9),
    ("K-330", 399, {"fwd_delta": -24, "pack_delta": 0.40, "pack_cost_delta": 4}, 21.04, 62.1, 1088.7),
    ("K-118", 399, None, 11.72, 63.94, 585.2),
    ("K-118", 369, None, 15.51, 36.05, 436.7),
    ("K-118", 399, {"img_delta": 0.35}, 20.29, 71.01, 1168.9),
    ("K-101B", 349, None, None, 20.94, None),
]

print("\n=== fitted vs world (median across members) ===")
worst = 0.0
worst_tag = ""
for sku_id, price, iv, w_ord, w_kept, w_day in CASES:
    sku = sku_by_id[sku_id]
    m = mb.block(sku, np.array([price]), iv)
    o, k, d = np.median(m["orders_day"][0]), np.median(m["per_kept"][0]), np.median(m["contribution_day"][0])
    parts = []
    for label, got, want in (("orders", o, w_ord), ("per_kept", k, w_kept), ("contrib/day", d, w_day)):
        if want is None:
            parts.append(f"{label}={got:8.2f} (world n/a)")
            continue
        err = abs(got - want) / max(abs(want), 0.5) * 100
        if want > 0 and label != "orders":
            err = abs(got - want) / abs(want) * 100
        parts.append(f"{label}={got:8.2f} vs {want:8.2f} ({err:5.1f}%)")
        if err > worst:
            worst, worst_tag = err, f"{sku_id}@{price} {label}"
    tag = f"{sku_id}@{price}" + (f" {sorted(iv)}" if iv else "")
    print(f"  {tag:58s} " + " | ".join(parts))
print(f"\nworst relative deviation: {worst:.1f}% ({worst_tag})  [SPEC 32.6 tolerance: 10%]")
