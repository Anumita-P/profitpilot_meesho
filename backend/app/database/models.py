"""SQLAlchemy models — the 11 tables of SPEC 11 (and deliberately nothing else)."""
from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import (JSON, Boolean, DateTime, Float, ForeignKey, Index, Integer, String, Text,
                        UniqueConstraint)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[str] = mapped_column(String(32), unique=True, index=True)
    role: Mapped[str] = mapped_column(String(16))          # seller | employee | customer
    name: Mapped[str] = mapped_column(String(80))
    persona: Mapped[str | None] = mapped_column(String(32), nullable=True)   # demo persona key
    password_hash: Mapped[str | None] = mapped_column(String(200), nullable=True)  # nullable in demo
    seller_id: Mapped[str | None] = mapped_column(String(32), ForeignKey("sellers.seller_id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class Seller(Base):
    __tablename__ = "sellers"
    seller_id: Mapped[str] = mapped_column(String(32), primary_key=True)
    name: Mapped[str] = mapped_column(String(120))
    quality: Mapped[float] = mapped_column(Float, default=0.5)
    hist: Mapped[float] = mapped_column(Float, default=0.1)
    cash_limit: Mapped[float] = mapped_column(Float, default=75000)
    default_mode: Mapped[str] = mapped_column(String(16), default="margin")
    city: Mapped[str] = mapped_column(String(60), default="")
    skus: Mapped[list["Sku"]] = relationship(back_populates="seller")


class Sku(Base):
    __tablename__ = "skus"
    sku_id: Mapped[str] = mapped_column(String(16), primary_key=True)
    name: Mapped[str] = mapped_column(String(120))
    seller_id: Mapped[str] = mapped_column(String(32), ForeignKey("sellers.seller_id"), index=True)
    category: Mapped[str] = mapped_column(String(24), index=True)
    cost: Mapped[float] = mapped_column(Float)
    price: Mapped[float] = mapped_column(Float)
    ref_price: Mapped[float] = mapped_column(Float)
    competitor_price: Mapped[float] = mapped_column(Float)
    corridor_low: Mapped[float] = mapped_column(Float)
    corridor_high: Mapped[float] = mapped_column(Float)
    rating: Mapped[float] = mapped_column(Float)
    review_count: Mapped[int] = mapped_column(Integer)
    image_quality: Mapped[float] = mapped_column(Float)
    pack_quality: Mapped[float] = mapped_column(Float)
    fwd_shipping: Mapped[float] = mapped_column(Float)
    rev_shipping: Mapped[float] = mapped_column(Float)
    pack_cost: Mapped[float] = mapped_column(Float)
    ad_cost: Mapped[float] = mapped_column(Float)
    restock_cost: Mapped[float] = mapped_column(Float)
    pay_var: Mapped[float] = mapped_column(Float)
    gst_rate: Mapped[float] = mapped_column(Float)
    impressions_per_day: Mapped[int] = mapped_column(Integer)
    inventory: Mapped[int] = mapped_column(Integer)
    stock_age_days: Mapped[int] = mapped_column(Integer)
    zone3_share: Mapped[float] = mapped_column(Float, default=0.0)
    cancel_rate: Mapped[float] = mapped_column(Float, default=0.03)
    flags: Mapped[dict] = mapped_column(JSON, default=dict)
    demo_role: Mapped[str | None] = mapped_column(String(120), nullable=True)
    data_label: Mapped[str] = mapped_column(String(16), default="synthetic")

    seller: Mapped[Seller] = relationship(back_populates="skus")


class SkuDailyObs(Base):
    __tablename__ = "sku_daily_obs"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    sku_id: Mapped[str] = mapped_column(String(16), index=True)
    date: Mapped[str] = mapped_column(String(10))
    price: Mapped[float] = mapped_column(Float)
    price_source: Mapped[str] = mapped_column(String(20))
    impressions: Mapped[int] = mapped_column(Integer)
    clicks: Mapped[int] = mapped_column(Integer)
    orders: Mapped[int] = mapped_column(Integer)
    cod_orders: Mapped[int] = mapped_column(Integer)
    cancelled: Mapped[int] = mapped_column(Integer)
    shipped: Mapped[int] = mapped_column(Integer)
    rto: Mapped[int] = mapped_column(Integer)
    delivered: Mapped[int] = mapped_column(Integer)
    returned: Mapped[int] = mapped_column(Integer)
    kept: Mapped[int] = mapped_column(Integer)
    nmv: Mapped[float] = mapped_column(Float)

    __table_args__ = (Index("ix_obs_sku_date", "sku_id", "date"),)


class OrderEvent(Base):
    __tablename__ = "order_events"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    order_id: Mapped[str] = mapped_column(String(48), unique=True)
    sku_id: Mapped[str] = mapped_column(String(16), index=True)
    ts: Mapped[str] = mapped_column(String(20))
    price: Mapped[float] = mapped_column(Float)
    payment_mode: Mapped[str] = mapped_column(String(10))
    zone_tier: Mapped[int] = mapped_column(Integer)
    cancelled: Mapped[int] = mapped_column(Integer)
    shipped: Mapped[int] = mapped_column(Integer)
    delivered: Mapped[int] = mapped_column(Integer)
    rto: Mapped[int] = mapped_column(Integer)
    returned: Mapped[int] = mapped_column(Integer)
    kept: Mapped[int] = mapped_column(Integer)
    customer_pseudo_id: Mapped[str] = mapped_column(String(40))     # random UUID, no PII


class SellerGoal(Base):
    __tablename__ = "seller_goals"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    seller_id: Mapped[str] = mapped_column(String(32), index=True)
    sku_id: Mapped[str | None] = mapped_column(String(16), nullable=True)
    target_contribution: Mapped[float] = mapped_column(Float, default=60)
    min_orders: Mapped[float] = mapped_column(Float, default=20)
    max_return_rto: Mapped[float] = mapped_column(Float, default=0.15)
    cash_limit: Mapped[float | None] = mapped_column(Float, nullable=True)
    mode: Mapped[str] = mapped_column(String(16), default="margin")
    is_default: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class Simulation(Base):
    __tablename__ = "simulations"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    sku_id: Mapped[str] = mapped_column(String(16), index=True)
    goal_hash: Mapped[str] = mapped_column(String(32))
    intervention_hash: Mapped[str] = mapped_column(String(32))
    model_version: Mapped[str] = mapped_column(String(32))
    mode: Mapped[str] = mapped_column(String(16), default="margin")
    result_json: Mapped[dict] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    __table_args__ = (UniqueConstraint("sku_id", "goal_hash", "intervention_hash", "model_version",
                                       name="uq_simulation_key"),)


class Recommendation(Base):
    __tablename__ = "recommendations"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    seller_id: Mapped[str] = mapped_column(String(32), index=True)
    sku_id: Mapped[str] = mapped_column(String(16), index=True)
    verdict: Mapped[str] = mapped_column(String(24))
    intervention: Mapped[dict] = mapped_column(JSON)          # {id,label,params,price,iv}
    expected: Mapped[dict] = mapped_column(JSON)              # metrics with ranges
    why: Mapped[dict] = mapped_column(JSON)                   # what/why/impact/risk/what_would_change
    confidence: Mapped[str] = mapped_column(String(8))
    model_version: Mapped[str] = mapped_column(String(32))
    status: Mapped[str] = mapped_column(String(20), default="saved")
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_by: Mapped[str] = mapped_column(String(32))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)

    __table_args__ = (Index("ix_reco_seller_created", "seller_id", "created_at"),)


class AuditLog(Base):
    __tablename__ = "audit_logs"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    role: Mapped[str | None] = mapped_column(String(16), nullable=True)
    action: Mapped[str] = mapped_column(String(48), index=True)
    entity_type: Mapped[str | None] = mapped_column(String(32), nullable=True)
    entity_id: Mapped[str | None] = mapped_column(String(48), nullable=True)
    model_version: Mapped[str | None] = mapped_column(String(32), nullable=True)
    request_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    meta: Mapped[dict] = mapped_column(JSON, default=dict)     # counts/ids only, never bodies
    ts: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)


class Experiment(Base):
    __tablename__ = "experiments"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(120))
    status: Mapped[str] = mapped_column(String(24), default="design")
    arms: Mapped[dict] = mapped_column(JSON)
    metric_summary: Mapped[dict] = mapped_column(JSON, default=dict)
    min_sample: Mapped[int] = mapped_column(Integer, default=1200)
    rollback_rule: Mapped[str] = mapped_column(String(200), default="")
    data_label: Mapped[str] = mapped_column(String(16), default="synthetic")


class ModelRegistry(Base):
    __tablename__ = "model_registry"
    version: Mapped[str] = mapped_column(String(32), primary_key=True)
    trained_at: Mapped[str] = mapped_column(String(32))
    metrics: Mapped[dict] = mapped_column(JSON)
    data_hash: Mapped[str] = mapped_column(String(32))
    label: Mapped[str] = mapped_column(String(16), default="synthetic")
    n_members: Mapped[int] = mapped_column(Integer, default=30)
