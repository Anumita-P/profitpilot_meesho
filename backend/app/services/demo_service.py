"""Demo Mode: five scripted scenarios that drive the real engine (SPEC 23)."""
from __future__ import annotations

from sqlalchemy.orm import Session

from ..database.seed import DEMO_GOALS, seed_all

SCENARIOS = [
    dict(id="volume_trap", name="Lower price, lower profit", persona="sunita", sku_id="K-101",
         goal=DEMO_GOALS["K-101"], mode="margin", route="/seller/sku/K-101/simulate",
         story="Slide the price to ₹349: orders rise about 60% while contribution/day falls about 45%. "
               "The recommendation is capped at +12% per step (≈₹390), then ≈₹409 next step.",
         look_for="Highest orders ≠ highest retained contribution (annotation on the chart).",
         cap_note="Return+RTO cap relaxed to 18% for this scenario: at 16.2% leakage this listing can "
                  "never satisfy the 15% default (see docs/DECISIONS.md D2)."),
    dict(id="no_profitable_price", name="No profitable price", persona="sunita", sku_id="K-207",
         goal=DEMO_GOALS["K-207"], mode="margin", route="/seller/sku/K-207/levers",
         story="The red banner: no price inside the ₹349–₹399 corridor keeps ₹60. Bundle + packaging is "
               "feasible; the bundle alone violates the 15% return cap.",
         look_for="Feasible ✓ vs Violates ✗ badges with reasons, and the ₹3.9 shortfall on the image fix.",
         cap_note=""),
    dict(id="packaging_beats_discounting", name="Packaging beats discounting", persona="sunita",
         sku_id="K-330", goal=DEMO_GOALS["K-330"], mode="margin", route="/seller/sku/K-330/reverse",
         story="A ₹369 discount leaves roughly nothing per kept order. The right-sized parcel plus "
               "protective packaging reaches ₹62 per kept order at the current price.",
         look_for="The elimination narrative and the 'required change' solver.",
         cap_note=""),
    dict(id="inventory_constrained", name="Inventory-constrained seller", persona="rahul",
         sku_id="K-101R", goal=DEMO_GOALS["K-101R"], mode="clear", route="/seller/sku/K-101R/levers",
         story="The same kurti, two sellers: Rahul clears 900 ageing units (Clear mode), Sunita protects "
               "margin on her cash-constrained listing. The mode changes the objective and the price.",
         look_for="Clear vs Cash: days-to-clear and a recovery floor instead of the ₹60 target.",
         cap_note=""),
    dict(id="price_not_the_problem", name="Price isn't the problem", persona="sunita", sku_id="K-118",
         goal=DEMO_GOALS["K-118"], mode="margin", route="/seller/sku/K-118/diagnose",
         story="Impressions and price gap are normal, click-through is in the bottom decile: the primary "
               "image is the bottleneck. The discount is rejected with numbers.",
         look_for="Funnel vs comparables, then the image fix nearly doubling contribution/day.",
         cap_note=""),
]


def list_scenarios() -> list[dict]:
    return SCENARIOS


def apply_scenario(session: Session, scenario_id: str) -> dict:
    s = next((x for x in SCENARIOS if x["id"] == scenario_id), None)
    if not s:
        return {}
    return dict(scenario=s["id"], name=s["name"], seller_persona=s["persona"], sku_id=s["sku_id"],
                goal=s["goal"], mode=s["mode"], route=s["route"], story=s["story"], look_for=s["look_for"])


def reset(session: Session) -> dict:
    result = seed_all(reset=True, load_obs=True)
    return dict(reset=True, **result)
