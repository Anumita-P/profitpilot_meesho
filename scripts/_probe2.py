import sys
sys.path.insert(0,"docs")
from reference_world import BASE, econ

K101 = dict(BASE)

print("== K-101 orders crossing 20/day (volume floor) ==")
prev=None
for p in range(400, 425):
    o = econ(K101,p)['orders']
    if o < 20 <= (prev or 0): print(f"   crosses 20 between {p-1} ({prev:.3f}) and {p} ({o:.3f})")
    prev = o
band=[p for p in range(349,430) if econ(K101,p)['per_kept']>=60 and econ(K101,p)['orders']>=20]
print(f"   feasible band: {band[0]}..{band[-1]}  best contrib/day in band: ",
      max((econ(K101,p)['contrib_day'],p) for p in band))

print("\n== Scenario B calibration: delta leak / delta cod / recommended price ==")
for rto_cod in (1.6, 2.0, 2.4, 2.8):
    B = dict(BASE, cod_slope=3.0, rto_cod=rto_cod)
    e349, e429 = econ(B,349), econ(B,429)
    dl=(e349['leak']-e429['leak'])*100; dc=(e349['cod']-e429['cod'])*100
    # recommended price proxy: argmax contrib/day s.t. per_kept>=60 and orders>=20 and leak<=cap
    for cap in (0.20,0.22,0.25):
        band=[p for p in range(349,430) if econ(B,p)['per_kept']>=60 and econ(B,p)['orders']>=20 and econ(B,p)['leak']<=cap]
        if band:
            best=max((econ(B,p)['contrib_day'],p) for p in band)[1]
            print(f"  rto_cod={rto_cod}: dLeak={dl:5.2f}pp dCOD={dc:5.2f}pp cap={cap:.0%} band={band[0]}..{band[-1]} argmax={best} (>= {349+20})")
            break
        else:
            print(f"  rto_cod={rto_cod}: dLeak={dl:5.2f}pp dCOD={dc:5.2f}pp cap={cap:.0%} NO FEASIBLE PRICE")

print("\n== B with pack protection / prepaid on COD-heavy ==")
B = dict(BASE, cod_slope=3.0, rto_cod=2.4)
for iv,tag in ((None,"none"),({"pack_delta":0.35,"pack_cost_delta":4},"PACK_PROTECT"),({"prepaid_inc":20},"PREPAID20")):
    e=econ(B,399,iv); print(f"  399 {tag:14s} per_kept={e['per_kept']:7.2f} orders={e['orders']:6.2f} leak={e['leak']*100:5.2f}% cod={e['cod']*100:5.1f}%")

print("\n== K-207 required price for per_kept>=60 (bisection, outside corridor) ==")
K207 = dict(BASE, cost=214, impr=640)
lo,hi=349.0,600.0
for _ in range(60):
    mid=(lo+hi)/2
    if econ(K207,mid)['per_kept']<60: lo=mid
    else: hi=mid
print(f"   p* = {(lo+hi)/2:.1f}  per_kept={econ(K207,(lo+hi)/2)['per_kept']:.2f} orders={econ(K207,(lo+hi)/2)['orders']:.2f} (corridor ceiling 399)")

print("\n== Scenario E: Cash vs Clear objective ==")
T_DELIV,T_SETTLE,T_RET,COC = 5,7,18,0.24
def wc(s,p,ed):
    o=ed['orders']; ret=o*ed['leak']
    flow = o*(s['cost']+s['pack_cost']+s['fwd'])*(T_DELIV+T_SETTLE)
    rl = ret*(s['cost'])*T_RET
    return flow+rl
for inv,age,cash in ((120,20,40000),(900,75,150000)):
    s=dict(K101)
    print(f" inventory={inv} age={age} cash={cash}:")
    for p in (349,369,379,390,399,409,429):
        e=econ(s,p); w=wc(s,p,e)+inv*s['cost']
        J_cash=e['contrib_day']/w if w>0 else 0
        cleared=min(e['orders'], inv/30.0)
        residual=max(0.0, inv-e['orders']*30)
        writeoff=residual*s['cost']*0.35/30
        J_clear=e['contrib_day']+6.0*cleared-writeoff
        print(f"   p={p} contrib={e['contrib_day']:7.1f} orders={e['orders']:5.2f} WC={w:8.0f} J_cash={J_cash:.5f} cleared={cleared:5.2f} resid={residual:6.0f} J_clear={J_clear:8.1f}")
