"""Throwaway probe: reproduce SPEC 13.4 / 31 golden numbers from Appendix A world."""
import sys, json
sys.path.insert(0, "/home/user/profitpilot/docs")
from reference_world import BASE, world, econ, SKU_K207, SKU_K330, SKU_K330_FIX, SKU_K118

K101 = dict(BASE)                                     # Scenario A/B (Sunita, current price 349)

def line(tag, s, p, iv=None):
    e = econ(s, p, iv)
    print(f"{tag:52s} p={p:6.1f} orders={e['orders']:6.2f} per_kept={e['per_kept']:7.2f} "
          f"per_order={e['per_order']:6.2f} contrib_day={e['contrib_day']:8.1f} "
          f"leak={e['leak']*100:5.2f}% cod={e['cod']*100:5.1f}% rto={e['rto']*100:5.2f}% ret={e['ret_c']*100:5.2f}%")
    return e

print("== Scenario A: K-101 (Kurti, current 349) ==")
for p in (349, 369, 386, 390, 399, 409, 429, 449):
    line("A", K101, p)
print("  target: 349 -> 36.5 / 24.7 / 731 | 399 -> 22.8 / 71.3 / 1325 | 429 -> 17.7 / 99.4 / 1427")

print("\n== argmax checks (K-101) ==")
best_o = max((econ(K101, p)['orders'], p) for p in range(329, 500))[1]
best_c = max((econ(K101, p)['contrib_day'], p) for p in range(329, 500))[1]
best_k = max((econ(K101, p)['per_kept'], p) for p in range(329, 500))[1]
print(f"  argmax orders={best_o}  argmax contrib/day={best_c}  argmax per_kept={best_k}")
feas = [p for p in range(349, 430) if econ(K101, p)['per_kept'] >= 60 and econ(K101, p)['orders'] >= 20]
print(f"  feasible band (>=60 per_kept & >=20 orders, corridor 349-429): {feas[0] if feas else None}..{feas[-1] if feas else None}")

print("\n== Scenario C: K-207 ==")
for p in (349, 359, 369, 379, 389, 399):
    line("C", SKU_K207, p)
print("  target: 399 -> 19.2 / 53.3 | 389 -> 21.0 / 44.0")
print("  -- alternatives --")
line("C LISTING_IMAGE(+0.18) @399", SKU_K207, 399, {"img_delta": 0.18})
print("  target: 25.4 orders / 56.1 per_kept / 14.9% leak")
line("C PACK_PROTECT(+0.35,+4) @399", SKU_K207, 399, {"pack_delta": 0.35, "pack_cost_delta": 4})
print("  target: 19.2 / 54.4 / 13.5%")
line("C BUNDLE2 @699 + PACK @399", SKU_K207, 399, {"bundle": 2, "bundle_ship_mult": 1.35, "demand_mult": 0.72, "pack_delta": 0.35, "pack_cost_delta": 4})
line("C BUNDLE2 @699 + PACK @349.5", SKU_K207, 349.5, {"bundle": 2, "bundle_ship_mult": 1.35, "demand_mult": 0.72, "pack_delta": 0.35, "pack_cost_delta": 4})
line("C BUNDLE2 @699 alone @349.5", SKU_K207, 349.5, {"bundle": 2, "bundle_ship_mult": 1.35, "demand_mult": 0.72})
line("C BUNDLE2 @798 (2x399) + PACK", SKU_K207, 399, {"bundle": 2, "bundle_ship_mult": 1.35, "demand_mult": 0.72, "pack_delta": 0.35, "pack_cost_delta": 4})
print("  targets: bundle+pack 22.0 orders / 93.4 per_kept / 13.7% leak ; bundle alone 90.6 / 16.3%")

print("\n== Scenario D: K-330 ==")
for p in (369, 399, 429):
    line("D before", SKU_K330, p)
print("  targets: 399 -> 21.0 / 27.2 / 17.7% ; 369 -> -0.7 per_kept ; 429 -> 16.3 orders")
line("D after fix @399", SKU_K330_FIX, 399)
print("  target: 21.0 / 62.1 / 14.1% / 1089 per day")

print("\n== Scenario F: K-118 ==")
for p in (369, 399):
    line("F", SKU_K118, p)
line("F img fix(+0.35) @399", SKU_K118, 399, {"img_delta": 0.35})
print("  targets: 399 -> 11.7 / 63.9 / 19.5% | 369 -> 15.5 / 36.1 / 437d | imgfix -> 20.3 / 71.0 / 16.3% / 1169d")

print("\n== K-101 prepaid incentive 20 @399 ==")
line("A prepaid_inc=20 @399", K101, 399, {"prepaid_inc": 20})
print("  target: cod 54->39%, leak 16.2->14.6%, per_kept 71.3 -> 61.4")

print("\n== Scenario B: K-101 COD-heavy (cod_slope=3.0, rto_cod=1.6) ==")
K101B = dict(BASE, cod_slope=3.0, rto_cod=1.6)
for p in (349, 369, 390, 399, 429):
    line("B", K101B, p)
e349, e429 = econ(K101B, 349), econ(K101B, 429)
print(f"  leak(349)-leak(429) = {(e349['leak']-e429['leak'])*100:.2f} pp (need >= 3)")
print(f"  cod(349)-cod(429)   = {(e349['cod']-e429['cod'])*100:.2f} pp (need >= 10)")
bo = max((econ(K101B, p)['orders'], p) for p in range(329, 500))[1]
print(f"  argmax orders = {bo}")

print("\n== Scenario E: modes on K-101 ==")
for p in (349, 379, 399, 429):
    e = econ(K101, p)
    print(f"  p={p} contrib_day={e['contrib_day']:8.1f} orders={e['orders']:5.2f} per_kept={e['per_kept']:6.2f}")
