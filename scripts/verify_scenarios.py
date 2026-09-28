"""Gate 1 verification: reproduce SPEC 13.4 golden numbers from the ground-truth world."""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
sys.path.insert(0, str(ROOT / "docs"))

from app.ml.world import BASE, SKU_K118, SKU_K207, SKU_K330, SKU_K330_FIX, econ  # noqa: E402

FAILS: list[str] = []


def check(name: str, got: float, want: float, tol: float = 0.10, unit: str = "") -> None:
    ok = abs(got - want) <= abs(want) * tol + 1e-9
    if not ok:
        FAILS.append(f"{name}: got {got:.3f}{unit}, want {want}{unit} (±{tol:.0%})")
    print(f"  {'PASS' if ok else 'FAIL'}  {name:58s} got={got:8.3f}{unit:3s} want={want:8.3f}{unit}")


def check_bool(name: str, cond: bool, detail: str = "") -> None:
    if not cond:
        FAILS.append(f"{name}: {detail}")
    print(f"  {'PASS' if cond else 'FAIL'}  {name:58s} {detail}")


K101 = dict(BASE)
K101B = dict(BASE, z3=0.9)      # COD-heavy market variant (SPEC 13.3 B; calibration in D1)
K101R = dict(BASE)

print("\n=== Scenario A — volume trap (K-101) ===")
for p, o, k, c in ((349, 36.5, 24.7, 731.4), (399, 22.8, 71.3, 1324.7), (429, 17.7, 99.4, 1427.3)):
    e = econ(K101, p)
    check(f"A orders/day @₹{p}", e["orders"], o)
    check(f"A contrib/kept @₹{p}", e["per_kept"], k)
    check(f"A contrib/day @₹{p}", e["contrib_day"], c)
e349, e399 = econ(K101, 349), econ(K101, 399)
check_bool("A volume trap: cutting 399->349 raises orders >40%", e349["orders"] / e399["orders"] - 1 > 0.40,
           f"+{(e349['orders']/e399['orders']-1)*100:.0f}% orders")
check_bool("A volume trap: cutting 399->349 cuts contrib/day >35%", 1 - e349["contrib_day"] / e399["contrib_day"] > 0.35,
           f"-{(1-e349['contrib_day']/e399['contrib_day'])*100:.0f}% contrib/day")
band = [p for p in range(349, 430) if econ(K101, p)["per_kept"] >= 60 and econ(K101, p)["orders"] >= 20]
check_bool("A feasible band contains SPEC's 386..409", band and band[0] <= 388 and band[-1] >= 409,
           f"band={band[0]}..{band[-1]} (SPEC 386..409; see DECISIONS D7)")
capped = 349 * 1.12
step1 = max((econ(K101, p)["contrib_day"], p) for p in range(349, int(capped) + 1)
            if econ(K101, p)["per_kept"] >= 60 and econ(K101, p)["orders"] >= 20)[1]
check(f"A step-1 recommendation (12% cap) @₹", step1, 390, tol=0.02)
check("A step-1 contrib/day", econ(K101, step1)["contrib_day"], 1270, tol=0.05)

print("\n=== Scenario C — no feasible price (K-207) ===")
for p, o, k in ((399, 19.2, 53.3), (389, 21.0, 44.0)):
    e = econ(SKU_K207, p)
    check(f"C orders/day @₹{p}", e["orders"], o)
    check(f"C contrib/kept @₹{p}", e["per_kept"], k)
eb = econ(SKU_K207, 349.5, {"bundle": 2, "bundle_ship_mult": 1.35, "demand_mult": 0.72,
                            "pack_delta": 0.35, "pack_cost_delta": 4})
check("C bundle+pack orders/day", eb["orders"], 22.0)
check("C bundle+pack contrib/kept", eb["per_kept"], 93.4)
check("C bundle+pack leakage", eb["leak"], 0.137, tol=0.05)
ea = econ(SKU_K207, 349.5, {"bundle": 2, "bundle_ship_mult": 1.35, "demand_mult": 0.72})
check("C bundle alone contrib/kept", ea["per_kept"], 90.6)
check("C bundle alone leakage", ea["leak"], 0.163, tol=0.05)
check_bool("C bundle alone VIOLATES the 15% cap", ea["leak"] > 0.15, f"leak={ea['leak']*100:.1f}% > 15%")
eli = econ(SKU_K207, 399, {"img_delta": 0.18})
check("C listing image orders/day", eli["orders"], 25.4)
check("C listing image contrib/kept", eli["per_kept"], 56.1)
check("C listing image leakage", eli["leak"], 0.149, tol=0.05)
check_bool("C listing image is a near-miss (₹<6 short)", 0 < 60 - eli["per_kept"] <= 6,
           f"short ₹{60-eli['per_kept']:.2f}")
epk = econ(SKU_K207, 399, {"pack_delta": 0.35, "pack_cost_delta": 4})
check("C pack-protect contrib/kept", epk["per_kept"], 54.4)
check("C pack-protect leakage", epk["leak"], 0.135, tol=0.05)
check_bool("C pack-protect misses volume", epk["orders"] < 20, f"orders={epk['orders']:.2f} < 20")

print("\n=== Scenario D — packaging beats discounting (K-330) ===")
for p, o, k, l in ((399, 21.0, 27.2, 0.177), (369, 27.7, -0.68, 0.177), (429, 16.3, 55.2, 0.176)):
    e = econ(SKU_K330, p)
    check(f"D orders/day @₹{p}", e["orders"], o)
    check(f"D contrib/kept @₹{p}", e["per_kept"], k)
ef = econ(SKU_K330_FIX, 399)
check("D after fix contrib/kept", ef["per_kept"], 62.1)
check("D after fix leakage", ef["leak"], 0.141, tol=0.05)
check("D after fix contrib/day", ef["contrib_day"], 1088.7)
check_bool("D discounting loses money", econ(SKU_K330, 369)["per_kept"] < 0, "₹-0.7/kept")

print("\n=== Scenario F — price isn't the problem (K-118) ===")
for p, o, k in ((399, 11.7, 63.9), (369, 15.5, 36.1)):
    e = econ(SKU_K118, p)
    check(f"F orders/day @₹{p}", e["orders"], o)
    check(f"F contrib/kept @₹{p}", e["per_kept"], k)
check("F discount contrib/day", econ(SKU_K118, 369)["contrib_day"], 437, tol=0.05)
ei = econ(SKU_K118, 399, {"img_delta": 0.35})
check("F image fix orders/day", ei["orders"], 20.3)
check("F image fix contrib/kept", ei["per_kept"], 71.0)
check("F image fix leakage", ei["leak"], 0.163, tol=0.05)
check("F image fix contrib/day (2x)", ei["contrib_day"], 1169, tol=0.05)

print("\n=== Rejection example — ₹20 prepaid incentive on K-101 @₹399 ===")
ep = econ(K101, 399, {"prepaid_inc": 20})
check("PREPAID_20 COD share", ep["cod"], 0.39, tol=0.05)
check("PREPAID_20 leakage", ep["leak"], 0.146, tol=0.05)
check("PREPAID_20 contrib/kept", ep["per_kept"], 61.4, tol=0.05)
check_bool("PREPAID_20 lowers contribution vs no intervention",
           ep["per_kept"] < econ(K101, 399)["per_kept"], "optimiser must be able to reject it")

print("\n=== Scenario B — return trap (K-101B, COD-heavy via z3=0.9) ===")
b349, b429 = econ(K101B, 349), econ(K101B, 429)
check_bool("B leakage at ₹349 >= 3pp above ₹429", (b349["leak"] - b429["leak"]) * 100 >= 3.0,
           f"{(b349['leak']-b429['leak'])*100:.2f}pp")
check_bool("B COD share at ₹349 >= 10pp above ₹429", (b349["cod"] - b429["cod"]) * 100 >= 10.0,
           f"{(b349['cod']-b429['cod'])*100:.2f}pp")
max_orders_price = min(range(329, 445), key=lambda p: -econ(K101B, p)["orders"])
band = [p for p in range(329, 445)
        if econ(K101B, p)["per_kept"] >= 60 and econ(K101B, p)["orders"] >= 20
        and econ(K101B, p)["leak"] <= 0.25]
check_bool("B feasible price band exists under a 25% cap", bool(band),
           f"band={band[0]}..{band[-1]}" if band else "none")
if band:
    rec = max((econ(K101B, p)["contrib_day"], p) for p in band)[1]
    check_bool("B recommended price >= max-orders price + ₹20", rec >= max_orders_price + 20,
               f"rec=₹{rec} vs max-orders ₹{max_orders_price}")
    print(f"  B leakage: ₹349 {econ(K101B,349)['leak']*100:.1f}%  ₹399 {econ(K101B,399)['leak']*100:.1f}%  "
          f"₹429 {econ(K101B,429)['leak']*100:.1f}%   COD: {econ(K101B,349)['cod']*100:.0f}% -> "
          f"{econ(K101B,429)['cod']*100:.0f}%")
print(f"  (world params at z3=0.9: cod0_eff={0.15+0.4444*0.9:.2f}, cod_slope_eff={1.8+3.0*0.9:.2f}, "
      f"rto_cod_eff={1.15+0.9444*0.9:.2f})")

print("\n=== Scenario E — Clear vs Cash world-level economics (K-101) ===")
for p in (349, 369, 390, 414, 429):
    e = econ(K101R, p)
    print(f"  p=₹{p}  contributing/day=₹{e['contrib_day']:7.1f}  orders={e['orders']:5.2f}  "
          f"per_kept=₹{e['per_kept']:6.2f}  WC_flow=₹{(e['orders']*(196+8+64)*12 + e['orders']*e['leak']*196*18):9,.0f}")

print("\n" + ("=" * 78))
if FAILS:
    print(f"GATE 1 FAILED — {len(FAILS)} check(s):")
    for f in FAILS:
        print("  -", f)
    sys.exit(1)
print("GATE 1 PASSED — world reproduces every SPEC 13.4 golden within tolerance.")
