"""Request schemas: strict validation with `extra="forbid"` and explicit bounds (SPEC 21)."""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

Mode = Literal["margin", "growth", "cash", "clear"]
Persona = Literal["sunita", "rahul", "employee", "customer"]


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class GoalIn(Strict):
    target_contribution: float = Field(60, ge=0, le=1000)
    min_orders: float = Field(20, ge=1, le=500)
    max_return_rto: float = Field(0.15, ge=0.05, le=0.40)
    cash_limit: float | None = Field(75000, ge=0, le=10_000_000)
    mode: Mode = "margin"


class LoginIn(Strict):
    persona: Persona


class SkuGoalIn(Strict):
    sku_id: str = Field(min_length=1, max_length=16)
    goal: GoalIn
    mode: Mode | None = None


class InterventionIn(Strict):
    """Explicit intervention parameters (mirrors the typed catalogue)."""

    img_delta: float = Field(0, ge=0, le=0.6)
    pack_delta: float = Field(0, ge=0, le=0.6)
    pack_cost_delta: float = Field(0, ge=0, le=100)
    fwd_delta: float = Field(0, ge=-60, le=0)
    prepaid_inc: float = Field(0, ge=0, le=100)
    bundle: int = Field(1, ge=1, le=4)
    bundle_ship_mult: float = Field(1.35, ge=1, le=2)
    demand_mult: float = Field(1.0, ge=0.3, le=1.0)
    bundle_price_factor: float = Field(1.0, ge=0.8, le=1.2)

    @field_validator("bundle")
    @classmethod
    def _bundle_ok(cls, v: int) -> int:
        if v not in (1, 2, 3, 4):
            raise ValueError("bundle must be 1, 2, 3 or 4")
        return v


class CurveIn(Strict):
    sku_id: str = Field(min_length=1, max_length=16)
    goal: GoalIn
    intervention: InterventionIn | None = None
    price_min: float | None = Field(None, ge=250, le=700)
    price_max: float | None = Field(None, ge=250, le=700)
    step: int = Field(1, ge=1, le=10)

    @field_validator("price_max")
    @classmethod
    def _range_ok(cls, v, info):
        lo = info.data.get("price_min")
        if v is not None and lo is not None and v <= lo:
            raise ValueError("price_max must be greater than price_min")
        return v


class PointIn(Strict):
    sku_id: str = Field(min_length=1, max_length=16)
    price: float = Field(ge=1, le=100_000)
    goal: GoalIn
    intervention: InterventionIn | None = None


class RecommendationIn(Strict):
    sku_id: str = Field(min_length=1, max_length=16)
    goal: GoalIn
    mode: Mode | None = None
    include_interventions: bool = True


class ReverseIn(Strict):
    sku_id: str = Field(min_length=1, max_length=16)
    goal: GoalIn
    inventory_units: float | None = Field(None, ge=0, le=1_000_000)
    stock_age_days: int | None = Field(None, ge=0, le=3650)


class SaveRecommendationIn(Strict):
    sku_id: str = Field(min_length=1, max_length=16)
    mode: Mode = "margin"
    goal: GoalIn
    intervention_id: str = Field(min_length=1, max_length=64)
    price: float = Field(ge=1, le=100_000)
    intervention: InterventionIn | None = None
    note: str | None = Field(None, max_length=200)


class ModelIn(Strict):
    sku_id: str = Field(min_length=1, max_length=16)


class ExplanationIn(Strict):
    sku_id: str = Field(min_length=1, max_length=16)
    price: float = Field(ge=1, le=100_000)
    intervention: InterventionIn | None = None
