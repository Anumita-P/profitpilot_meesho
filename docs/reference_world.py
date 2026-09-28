"""ProfitPilot reference ground-truth world (SYNTHETIC). Port to backend/ml/world.py."""
import math
sig = lambda x: 1 / (1 + math.exp(-x))

BASE = dict(cost=196, pack_cost=8, fwd=64, rev=70, restock=10, pay_var=0.015, ads=12, gst=0.05,
            pref=399, comp=389, comp_w=1.0, rating=4.1, img=0.62, impr=760, a0=-3.75, beta=-3.4,
            cod0=0.15, cod_slope=1.8, rto0=-3.3, rto_cod=1.15, ret0=-2.75, ret_cod=0.55,
            seller_hist=0.1, fit_risk=0.35, pack_q=0.5, canc=0.03)

def world(s, p, iv=None):
    iv = iv or {}
    img = s['img'] + iv.get('img_delta', 0.0)
    pack_q = s['pack_q'] + iv.get('pack_delta', 0.0)
    z = (s['a0'] + s['beta'] * math.log(p / s['pref']) + 0.9 * (s['rating'] - 4.0)
         + 1.6 * (img - 0.5) + 0.25 * s['comp_w'] * math.log(s['comp'] / p))
    q = sig(z)
    cod = sig(s['cod0'] - s['cod_slope'] * math.log(p / s['pref']) - 0.03 * iv.get('prepaid_inc', 0.0))
    rto_m = lambda c: sig(s['rto0'] + s['rto_cod'] * c + 0.6 * s['seller_hist'])
    ret_m = lambda c: sig(s['ret0'] + s['ret_cod'] * c + 0.9 * s['seller_hist'] + 1.0 * (1 - img)
                          + 0.8 * s['fit_risk'] - 1.2 * pack_q + 0.5 * math.log(p / s['pref']))
    rto = cod * rto_m(1) + (1 - cod) * rto_m(0)
    deliv_mass = cod * (1 - rto_m(1)) + (1 - cod) * (1 - rto_m(0))
    ret_c = (cod * (1 - rto_m(1)) * ret_m(1) + (1 - cod) * (1 - rto_m(0)) * ret_m(0)) / deliv_mass
    return dict(q=q, cod=cod, rto=rto, deliv=1 - rto, ret_c=ret_c, canc=s['canc'],
                orders=s['impr'] * q * iv.get('demand_mult', 1.0))

def econ(s, p, iv=None):
    """p = per-unit listed price. Bundle: iv={'bundle':2,'bundle_ship_mult':1.35,'demand_mult':0.72}"""
    iv = iv or {}
    w = world(s, p, iv)
    n = iv.get('bundle', 1)
    price = p * n
    cost = s['cost'] * n
    pack = s['pack_cost'] + iv.get('pack_cost_delta', 0.0)
    m = 1 if n == 1 else iv['bundle_ship_mult']
    fwd = (s['fwd'] + iv.get('fwd_delta', 0.0)) * m
    rev = (s['rev'] + iv.get('fwd_delta', 0.0)) * m
    v = price / (1 + s['gst'])
    pay = s['pay_var'] * price
    inc_cost = iv.get('prepaid_inc', 0.0) * (1 - w['cod'])          # prepaid discount funded by seller
    kept_val = v - cost - pack - fwd - pay - s['ads'] - inc_cost
    ret_val = -(fwd + rev + s['restock'] * n + pack) - 0.5 * s['ads']
    rto_val = -(fwd + pack)
    c, d, r = w['canc'], w['deliv'], w['ret_c']
    kept = (1 - c) * d * (1 - r)
    per_order = kept * kept_val + (1 - c) * d * r * ret_val + (1 - c) * (1 - d) * rto_val
    leak = 1 - d * (1 - r)
    return dict(w, kept=kept, leak=leak, kept_val=kept_val, per_order=per_order,
                per_kept=per_order / kept, kept_orders=w['orders'] * kept, contrib_day=w['orders'] * per_order)

SKU_K207 = dict(BASE, cost=214, impr=640)                                   # Scenario C
SKU_K330 = dict(BASE, cost=205, fwd=88, rev=92, impr=700, pack_q=0.35)       # Scenario D (before fix)
SKU_K330_FIX = dict(SKU_K330, fwd=64, rev=68, pack_cost=12, pack_q=0.75)     # after parcel+packaging fix
SKU_K118 = dict(BASE, img=0.25, rating=4.0)                                   # Scenario F
