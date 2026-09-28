import sys; from pathlib import Path
import numpy as np
ROOT = Path(__file__).resolve().parents[1]; sys.path.insert(0, str(ROOT/"backend")); sys.path.insert(0, str(ROOT/"docs"))
from app.ml.catalogue import DEMO_SKUS
from app.ml.inference import ModelBundle
from app.ml.serving import serving_sku
from app.ml.world import econ, BASE
mb = ModelBundle(ROOT/"data"/"models"/"v1.json")
S = {s["sku_id"]: serving_sku(s) for s in DEMO_SKUS}
B = S["K-101B"]; W = dict(BASE, z3=0.9)
print("K-101B (COD-heavy) fitted vs world")
print(f"{'price':>6} | {'fit orders':>10} {'w orders':>9} | {'fit cod':>8} {'w cod':>7} | {'fit rto':>7} {'w rto':>7} | {'fit leak':>8} {'w leak':>7} | {'fit/kept':>8} {'w/kept':>8}")
for p in (349, 369, 390, 399, 414, 429):
    m = mb.block(B, np.array([p])); me = {k: float(np.median(v[0])) for k, v in m.items() if k in ("orders_day","cod_share","rto","leakage","per_kept")}
    w = econ(W, p)
    print(f"{p:>6} | {me['orders_day']:>10.2f} {w['orders']:>9.2f} | {me['cod_share']:>8.3f} {w['cod']:>7.3f} | {me['rto']:>7.3f} {w['rto']:>7.3f} | {me['leakage']:>8.3f} {w['leak']:>7.3f} | {me['per_kept']:>8.2f} {w['per_kept']:>8.2f}")
band=[p for p in range(329,445) if (lambda me: me["per_kept"]>=60 and me["orders_day"]>=20 and me["leakage"]<=0.25)({k: float(np.median(v[0])) for k,v in mb.block(B, np.array([p])).items() if k in ("orders_day","per_kept","leakage")})]
print("fitted feasible band under B goal (60 / 20 / le 25%):", (band[0], band[-1]) if band else "EMPTY")
print("\nK-101B fitted coefficients: M2", np.round(np.median(mb.coefs['M2'],axis=0)[:5],3), " M3", np.round(np.median(mb.coefs['M3'],axis=0)[:5],3))
print("world truth            : M2 [0.55,-1.8,-2.7,0.444,0]  M3 [-3.3,1.15,0.85,0,0.6]")
