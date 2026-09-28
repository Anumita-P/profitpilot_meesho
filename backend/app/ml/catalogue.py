"""ProfitPilot catalogue: 10 categories, 40 sellers, 9 hand-authored demo SKUs + ~590 generated SKUs.

Every attribute here is SYNTHETIC or ILLUSTRATIVE. Category economics (return/RTO risk, fit risk,
elasticity, base price) are Illustrative stand-ins for a Meesho-like apparel marketplace.

The demo SKUs carry `z3 = 0` and live in BASE-consistent categories, so the reference goldens in
SPEC 13.4 reproduce exactly from `ml/world.py`.
"""
from __future__ import annotations

import random

SEED = 20260928

# a0/beta for the two BASE-consistent families are the reference world's values; every other
# category varies beta within [-2.4, -4.2] as required by SPEC 13.1.
CATEGORIES: dict[str, dict] = {
    "kurti":         dict(a0=-3.75, beta=-3.4, base_price=399, fit_risk=0.35, impr=760, cost=196,
                          cat_rto=0.00, cat_ret=0.00, gst=0.05, pack=8, fwd=64, rev=70),
    "palazzo_set":   dict(a0=-3.75, beta=-3.4, base_price=399, fit_risk=0.35, impr=700, cost=205,
                          cat_rto=0.00, cat_ret=0.00, gst=0.05, pack=8, fwd=64, rev=70),
    "saree":         dict(a0=-3.85, beta=-3.0, base_price=549, fit_risk=0.30, impr=520, cost=310,
                          cat_rto=0.15, cat_ret=0.10, gst=0.05, pack=10, fwd=78, rev=84),
    "lehenga":       dict(a0=-4.05, beta=-2.6, base_price=1299, fit_risk=0.45, impr=280, cost=640,
                          cat_rto=0.25, cat_ret=0.20, gst=0.05, pack=18, fwd=132, rev=146),
    "mens_tee":      dict(a0=-3.55, beta=-3.9, base_price=299, fit_risk=0.20, impr=900, cost=135,
                          cat_rto=0.10, cat_ret=0.05, gst=0.05, pack=6, fwd=56, rev=62),
    "top":           dict(a0=-3.65, beta=-3.7, base_price=349, fit_risk=0.28, impr=820, cost=170,
                          cat_rto=0.08, cat_ret=0.06, gst=0.05, pack=7, fwd=60, rev=66),
    "kidswear":      dict(a0=-3.70, beta=-3.3, base_price=279, fit_risk=0.30, impr=700, cost=120,
                          cat_rto=0.12, cat_ret=0.10, gst=0.05, pack=6, fwd=52, rev=58),
    "home_textile":  dict(a0=-3.90, beta=-2.9, base_price=449, fit_risk=0.15, impr=600, cost=210,
                          cat_rto=0.20, cat_ret=0.18, gst=0.12, pack=12, fwd=72, rev=78),
    "dupatta_scarf": dict(a0=-3.60, beta=-4.2, base_price=199, fit_risk=0.22, impr=950, cost=75,
                          cat_rto=0.06, cat_ret=0.05, gst=0.05, pack=5, fwd=46, rev=50),
    "night_suit":    dict(a0=-3.80, beta=-3.2, base_price=379, fit_risk=0.33, impr=560, cost=165,
                          cat_rto=0.10, cat_ret=0.08, gst=0.05, pack=7, fwd=60, rev=66),
}

CATEGORY_LABELS = {
    "kurti": "Kurti", "palazzo_set": "Palazzo / Co-ord set", "saree": "Saree", "lehenga": "Lehenga",
    "mens_tee": "Men's T-shirt", "top": "Top", "kidswear": "Kidswear",
    "home_textile": "Home textile", "dupatta_scarf": "Dupatta / Scarf", "night_suit": "Night suit",
}

# SPEC 16.4: GST read from a table keyed by category + price threshold; never hard-coded at call sites.
TAX_RULES = {
    "apparel": dict(rate=0.05, threshold_inr=2500, rate_above=0.18),   # Research-backed slab (PDF 2.2)
    "home_textile": dict(rate=0.12, threshold_inr=1000, rate_above=0.12),
    "default": dict(rate=0.05, threshold_inr=2500, rate_above=0.18),
}
CATEGORY_TAX_FAMILY = {c: ("home_textile" if c == "home_textile" else "apparel") for c in CATEGORIES}


def gst_rate_for(category: str, unit_price: float) -> float:
    """Illustrative implementation of the GST slab lookup."""
    rule = TAX_RULES[CATEGORY_TAX_FAMILY.get(category, "default")]
    return rule["rate_above"] if unit_price > rule["threshold_inr"] else rule["rate"]


SELLERS = [
    dict(seller_id="S-SUNITA", name="Sunita (Jaipur Kurtis)", quality=0.55, hist=0.10,
         cash_limit=75000, default_mode="margin", city="Jaipur", user_id="U-SUNITA"),
    dict(seller_id="S-RAHUL", name="Rahul (Surat Wholesale)", quality=0.62, hist=0.18,
         cash_limit=150000, default_mode="clear", city="Surat", user_id="U-RAHUL"),
]
for _i in range(2, 40):
    _rnd = random.Random(SEED + _i)
    SELLERS.append(dict(
        seller_id=f"S-{_i:03d}", name=f"Seller {_i:03d}", quality=round(_rnd.uniform(0.35, 0.85), 3),
        hist=round(_rnd.uniform(-0.25, 0.45), 3), cash_limit=_rnd.choice([50000, 75000, 100000, 150000, 250000]),
        default_mode=_rnd.choice(["margin", "growth", "cash"]),
        city=_rnd.choice(["Jaipur", "Surat", "Tirupur", "Ludhiana", "Kolkata", "Noida"]),
        user_id=None))

# --- Demo SKUs (SPEC 13.3). current price = what the seller has listed today. ---------------------
DEMO_SKUS = [
    dict(sku_id="K-101", name="Jaipur Print Straight Kurti", seller_id="S-SUNITA", category="kurti",
         cost=196, price=349, ref_price=399, competitor_price=389, corridor=(349, 429), rating=4.1,
         review_count=418, image_quality=0.62, pack_quality=0.50, fwd_shipping=64, rev_shipping=70,
         pack_cost=8, ad_cost=12, restock_cost=10, pay_var=0.015, impressions_per_day=760,
         inventory=400, stock_age_days=28, zone3_share=0.0, flags={"volumetric_slab_penalty": False},
         cancel_rate=0.03, demo_role="A volume trap / B return trap"),
    dict(sku_id="K-101B", name="Jaipur Print Straight Kurti (COD-heavy market)", seller_id="S-SUNITA",
         category="kurti", cost=196, price=349, ref_price=399, competitor_price=389, corridor=(349, 429),
         rating=4.1, review_count=402, image_quality=0.62, pack_quality=0.50, fwd_shipping=64,
         rev_shipping=70, pack_cost=8, ad_cost=12, restock_cost=10, pay_var=0.015,
         impressions_per_day=760, inventory=420, stock_age_days=31, zone3_share=0.9,
         flags={"volumetric_slab_penalty": False}, cancel_rate=0.03,
         demo_role="B return trap (cod_slope 3.0 / rto_cod 2.7 effective via z3=0.9)"),
    dict(sku_id="K-101S", name="Jaipur Print Straight Kurti (Geometric Print)", seller_id="S-SUNITA",
         category="kurti", cost=196, price=399, ref_price=399, competitor_price=389, corridor=(349, 429),
         rating=4.1, review_count=361, image_quality=0.62, pack_quality=0.50, fwd_shipping=64,
         rev_shipping=70, pack_cost=8, ad_cost=12, restock_cost=10, pay_var=0.015,
         impressions_per_day=760, inventory=420, stock_age_days=33, zone3_share=0.0,
         flags={"volumetric_slab_penalty": False}, cancel_rate=0.03,
         demo_role="E cash-constrained twin (mode=cash)"),
    dict(sku_id="K-207", name="Heavy Embroidered Anarkali Set", seller_id="S-SUNITA", category="kurti",
         cost=214, price=379, ref_price=399, competitor_price=389, corridor=(349, 399), rating=4.1,
         review_count=312, image_quality=0.62, pack_quality=0.50, fwd_shipping=64, rev_shipping=70,
         pack_cost=8, ad_cost=12, restock_cost=10, pay_var=0.015, impressions_per_day=640,
         inventory=700, stock_age_days=34, zone3_share=0.0, flags={"volumetric_slab_penalty": False},
         cancel_rate=0.03, demo_role="C no feasible price"),
    dict(sku_id="K-330", name="Cotton Palazzo Set", seller_id="S-SUNITA", category="palazzo_set",
         cost=205, price=399, ref_price=399, competitor_price=389, corridor=(349, 429), rating=4.1,
         review_count=287, image_quality=0.62, pack_quality=0.35, fwd_shipping=88, rev_shipping=92,
         pack_cost=8, ad_cost=12, restock_cost=10, pay_var=0.015, impressions_per_day=700,
         inventory=450, stock_age_days=41, zone3_share=0.0,
         flags={"volumetric_slab_penalty": True}, cancel_rate=0.03,
         demo_role="D packaging beats discounting"),
    dict(sku_id="K-118", name="Floral Straight Kurti", seller_id="S-SUNITA", category="kurti",
         cost=196, price=399, ref_price=399, competitor_price=389, corridor=(349, 429), rating=4.0,
         review_count=241, image_quality=0.25, pack_quality=0.50, fwd_shipping=64, rev_shipping=70,
         pack_cost=8, ad_cost=12, restock_cost=10, pay_var=0.015, impressions_per_day=760,
         inventory=300, stock_age_days=52, zone3_share=0.0, flags={"volumetric_slab_penalty": False},
         cancel_rate=0.03, demo_role="F price isn't the problem"),
    dict(sku_id="K-101R", name="Jaipur Print Straight Kurti (Bulk Lot)", seller_id="S-RAHUL",
         category="kurti", cost=196, price=399, ref_price=399, competitor_price=389, corridor=(349, 429),
         rating=4.1, review_count=1_204, image_quality=0.62, pack_quality=0.50, fwd_shipping=64,
         rev_shipping=70, pack_cost=8, ad_cost=12, restock_cost=10, pay_var=0.015,
         impressions_per_day=760, inventory=900, stock_age_days=75, zone3_share=0.0,
         flags={"volumetric_slab_penalty": False}, cancel_rate=0.03,
         demo_role="E inventory-constrained (mode=clear)"),
    dict(sku_id="K-402", name="Chikankari Embroidered Kurti", seller_id="S-SUNITA", category="kurti",
         cost=168, price=449, ref_price=449, competitor_price=439, corridor=(399, 479), rating=4.4,
         review_count=806, image_quality=0.78, pack_quality=0.62, fwd_shipping=58, rev_shipping=66,
         pack_cost=8, ad_cost=11, restock_cost=9, pay_var=0.015, impressions_per_day=880,
         inventory=520, stock_age_days=22, zone3_share=0.0, flags={"volumetric_slab_penalty": False},
         cancel_rate=0.03, demo_role="catalog realism (healthy)"),
    dict(sku_id="K-415", name="Rayon Printed A-line Kurti", seller_id="S-SUNITA", category="kurti",
         cost=172, price=399, ref_price=399, competitor_price=399, corridor=(349, 429), rating=4.3,
         review_count=512, image_quality=0.72, pack_quality=0.58, fwd_shipping=60, rev_shipping=68,
         pack_cost=8, ad_cost=11, restock_cost=9, pay_var=0.015, impressions_per_day=810,
         inventory=380, stock_age_days=26, zone3_share=0.0, flags={"volumetric_slab_penalty": False},
         cancel_rate=0.03, demo_role="catalog realism (healthy/watch)"),
]

DEMO_SKU_IDS = [s["sku_id"] for s in DEMO_SKUS]

# --- Generated catalogue (SPEC 13.1: ~600 SKUs, 40 sellers, 10 categories) ------------------------
_NAME_TOKENS = {
    "kurti": ["Jaipur Print", "Anarkali", "Chikankari", "Rayon", "Cotton Straight", "Embroidered",
              "Floral", "Geometric", "Bandhani", "Kalamkari"],
    "palazzo_set": ["Cotton Palazzo", "Co-ord", "Printed Palazzo", "Rayon Palazzo"],
    "saree": ["Banarasi", "Kanjivaram", "Georgette", "Cotton Handloom", "Chiffon"],
    "lehenga": ["Bridal", "Sequin", "Georgette", "Velvet", "Mirror Work"],
    "mens_tee": ["Round Neck", "Polo", "Graphic", "Solid", "Oversized"],
    "top": ["Crop", "Peplum", "Tunic", "Puff Sleeve", "Shirt"],
    "kidswear": ["Kids Frock", "Kids Set", "Kids Ethnic", "Kids T-shirt"],
    "home_textile": ["Bedsheet", "Cushion Cover", "Curtain", "Table Runner"],
    "dupatta_scarf": ["Phulkari Dupatta", "Cotton Stole", "Printed Scarf", "Bandhani Dupatta"],
    "night_suit": ["Cotton Night Suit", "Satin Night Set", "Printed Night Suit"],
}


def generate_catalogue(n_skus: int = 590, seed: int = SEED) -> list[dict]:
    """Deterministic generated SKUs (plus the 9 hand-authored demo SKUs)."""
    rnd = random.Random(seed)
    cats = list(CATEGORIES)
    per_cat = n_skus // len(cats)
    out: list[dict] = []
    idx = 0
    for cat in cats:
        cfg = CATEGORIES[cat]
        for _ in range(per_cat):
            idx += 1
            seller = rnd.choice(SELLERS[2:])
            base = cfg["base_price"]
            ref = float(round(base * rnd.uniform(0.9, 1.1)))
            price = float(round(ref * rnd.uniform(0.92, 1.06)))
            corridor_low = round(ref * rnd.uniform(0.86, 0.92))
            corridor_high = round(ref * rnd.uniform(1.04, 1.12))
            cost = cfg["cost"] * rnd.uniform(0.9, 1.12)
            img = round(rnd.uniform(0.30, 0.85), 2)
            pack_q = round(rnd.uniform(0.30, 0.75), 2)
            out.append(dict(
                sku_id=f"G-{idx:03d}",
                name=f"{rnd.choice(_NAME_TOKENS[cat])} {CATEGORY_LABELS[cat]}",
                seller_id=seller["seller_id"], category=cat,
                cost=round(cost, 2), price=price, ref_price=ref,
                competitor_price=round(ref * rnd.uniform(0.94, 1.06)),
                corridor=(corridor_low, corridor_high), rating=round(rnd.uniform(3.6, 4.6), 1),
                review_count=int(rnd.choice([18, 42, 96, 180, 260, 410, 720, 1150])),
                image_quality=img, pack_quality=pack_q,
                fwd_shipping=round(cfg["fwd"] * rnd.uniform(0.9, 1.15), 1),
                rev_shipping=round(cfg["rev"] * rnd.uniform(0.9, 1.15), 1),
                pack_cost=round(cfg["pack"] * rnd.uniform(0.8, 1.3), 1),
                ad_cost=round(rnd.uniform(7, 18), 1), restock_cost=round(cost * 0.05, 1),
                pay_var=0.015, impressions_per_day=int(max(60, cfg["impr"] * rnd.uniform(0.55, 1.5))),
                inventory=int(rnd.choice([60, 120, 180, 260, 340, 420, 600, 900])),
                stock_age_days=int(rnd.choice([8, 15, 22, 34, 47, 62, 88])),
                zone3_share=round(rnd.uniform(0.05, 0.85), 3),
                flags={"volumetric_slab_penalty": bool(rnd.random() < 0.12)},
                cancel_rate=round(rnd.uniform(0.01, 0.06), 3), demo_role=None))
    return out


def all_skus(n_generated: int = 590) -> list[dict]:
    return list(DEMO_SKUS) + generate_catalogue(n_generated)


def seller_mode_default(seller_id: str) -> str:
    for s in SELLERS:
        if s["seller_id"] == seller_id:
            return s["default_mode"]
    return "margin"
