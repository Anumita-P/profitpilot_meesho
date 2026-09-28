"""Intervention catalogue (SPEC 15.1). Typed constants in code, never a database table.

Each entry knows: the world/counterfactual change it applies (`iv`), whether it applies to a SKU at
all (`applies_when`), what it costs, and how confident we are in the effect size.
"""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class Intervention:
    id: str
    label: str
    iv: dict = field(default_factory=dict)
    one_time_cost: float = 0.0
    amortise_days: int = 30
    confidence: str = "Medium"          # effect-size confidence class
    recommendable: bool = True
    tradeoff_note: str = ""
    why_template: str = ""

    def applies_when(self, sku: dict, goal: dict) -> tuple[bool, str]:
        return True, ""


@dataclass(frozen=True)
class PackProtect(Intervention):
    def applies_when(self, sku, goal):
        return True, ""


@dataclass(frozen=True)
class ParcelRedesign(Intervention):
    def applies_when(self, sku, goal):
        ok = bool(sku["flags"].get("volumetric_slab_penalty"))
        return ok, "" if ok else "SKU is not on a volumetric slab — no freight to recover"


@dataclass(frozen=True)
class ListingImage(Intervention):
    def applies_when(self, sku, goal):
        ok = float(sku["image_quality"]) < 0.70
        return ok, "" if ok else "Image quality is already good (≥0.70)"


@dataclass(frozen=True)
class Bundle2(Intervention):
    min_inventory_factor: int = 7

    def applies_when(self, sku, goal):
        need = 2.0 * float(goal.get("min_orders", 20)) * self.min_inventory_factor
        ok = float(sku["inventory"]) >= need
        return ok, "" if ok else f"Needs ≥ {need:.0f} units in stock for a 7-day bundle run"


@dataclass(frozen=True)
class PrepaidInc(Intervention):
    def applies_when(self, sku, goal):
        return True, ""


PACK_PROTECT = PackProtect(id="PACK_PROTECT", label="Upgrade protective packaging",
                           iv=dict(pack_delta=0.35, pack_cost_delta=4.0), confidence="Medium",
                           tradeoff_note="Adds ₹4 packing cost per order",
                           why_template="Better packaging cuts return damage; the ₹{cost} extra cost is "
                                        "smaller than the return loss it removes.")
PARCEL_REDESIGN = ParcelRedesign(id="PARCEL_REDESIGN", label="Lighter, right-sized parcel",
                                 iv=dict(fwd_delta=-24.0), confidence="Medium",
                                 tradeoff_note="Requires a change in how the order is packed (one-time ops work)",
                                 why_template="This SKU sits on a volumetric slab, so freight is charged on "
                                              "volume: the same parcel in a tighter box returns ₹{save} of freight.")
LISTING_IMAGE = ListingImage(id="LISTING_IMAGE", label="Improve primary image / size chart",
                             iv=dict(img_delta=0.18), one_time_cost=1500.0, amortise_days=30,
                             confidence="Medium",
                             tradeoff_note="₹1,500 one-time creative cost, amortised over 30 days",
                             why_template="Conversion rises because buyers can see the product; better images "
                                          "also reduce fit-related returns.")
LISTING_IMAGE_SEVERE = ListingImage(id="LISTING_IMAGE_SEVERE", label="Rebuild primary image (major fix)",
                                   iv=dict(img_delta=0.35), one_time_cost=1500.0, amortise_days=30,
                                   confidence="Medium",
                                   tradeoff_note="₹1,500 one-time creative cost, amortised over 30 days",
                                   why_template="The primary image is the binding constraint on conversion "
                                                "for this listing.")
BUNDLE2 = Bundle2(id="BUNDLE2", label="Bundle of 2 units", iv=dict(bundle=2, bundle_ship_mult=1.35,
                                                                  demand_mult=0.72), confidence="Medium",
                  tradeoff_note="Inventory need doubles; bundle demand is conservatively assumed at 72% of "
                                "single-unit demand",
                  why_template="One shipment carries two units, so freight and packing are shared and "
                               "contribution per kept order jumps.")
PREPAID_INC = PrepaidInc(id="PREPAID_INC", label="Prepaid incentive", iv=dict(prepaid_inc=20.0),
                         confidence="Medium",
                         tradeoff_note="The incentive is funded by the seller on every prepaid order",
                         why_template="A prepaid nudge shifts orders away from COD, which cuts RTO.")

# SPEC 15.1: bundle price = 2 x unit price x discount factor
BUNDLE_FACTORS = (1.0, 0.98, 0.96)
PREPAID_LEVELS = (10.0, 20.0, 30.0)

BASE_INTERVENTIONS = [PACK_PROTECT, PARCEL_REDESIGN, LISTING_IMAGE, LISTING_IMAGE_SEVERE, BUNDLE2]
# Combinations pair ONE cost/risk lever with ONE demand lever: two demand levers at once is a
# marketing plan, not a price/economics recommendation, and the seller cannot attribute the result.
COST_LEVERS = ("PACK_PROTECT", "PARCEL_REDESIGN")
DEMAND_LEVERS = ("LISTING_IMAGE", "LISTING_IMAGE_SEVERE", "BUNDLE2")
COMBINABLE = COST_LEVERS + DEMAND_LEVERS

BY_ID = {i.id: i for i in BASE_INTERVENTIONS + [PREPAID_INC]}


def merge_iv(*ivs: dict) -> dict:
    """Left-to-right merge; numeric deltas add, multipliers multiply, bundle takes the max."""
    out: dict = {}
    for iv in ivs:
        if not iv:
            continue
        for k, v in iv.items():
            if k in ("img_delta", "pack_delta", "pack_cost_delta", "fwd_delta", "prepaid_inc"):
                out[k] = out.get(k, 0.0) + float(v)
            elif k == "demand_mult":
                out[k] = out.get(k, 1.0) * float(v)
            elif k in ("bundle", "bundle_ship_mult", "bundle_price_factor"):
                out[k] = max(out.get(k, 0), v) if k == "bundle" else max(out.get(k, 1), v)
            else:
                out[k] = v
    return out


def label_for(*ids: str) -> str:
    return " + ".join(BY_ID[i].label if i in BY_ID else i.replace("_", " ").title() for i in ids)
