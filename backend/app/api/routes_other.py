"""Demo, employee, customer and health endpoints (#19-#28)."""

from fastapi import APIRouter, Depends, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import settings
from ..database.models import Seller, Sku
from ..errors import ApiError
from ..services import audit_service, demo_service, employee_service
from ..services.runtime import bundle
from .deps import current_user, db, fault, require_role

demo_router = APIRouter(tags=["demo"])
employee_router = APIRouter(tags=["employee"])
customer_router = APIRouter(tags=["customer"])
health_router = APIRouter(tags=["health"])


@demo_router.get("/demo/scenarios")
def scenarios(user: dict = Depends(current_user)):
    return dict(scenarios=demo_service.list_scenarios(), label="synthetic")


@demo_router.post("/demo/scenario/{scenario_id}")
def apply_scenario(scenario_id: str, request: Request, user: dict = Depends(current_user),
                   session: Session = Depends(db)):
    out = demo_service.apply_scenario(session, scenario_id)
    if not out:
        raise ApiError(404, "Unknown demo scenario.")
    audit_service.write(session, action="demo_scenario", user_id=user["sub"], role=user["role"],
                        entity_type="scenario", entity_id=scenario_id,
                        request_id=getattr(request.state, "request_id", None))
    return out


@demo_router.post("/demo/reset")
def reset(request: Request, user: dict = Depends(current_user), session: Session = Depends(db)):
    result = demo_service.reset(session)
    audit_service.write(session, action="demo_reset", user_id=user["sub"], role=user["role"],
                        request_id=getattr(request.state, "request_id", None),
                        meta=dict(skus=result.get("skus", 0)))
    return result


@employee_router.get("/employee/overview")
def overview(user: dict = Depends(require_role("employee")), session: Session = Depends(db),
             _f: str | None = Depends(fault)):
    return employee_service.overview(session)


@employee_router.get("/employee/interventions")
def interventions(user: dict = Depends(require_role("employee")), session: Session = Depends(db)):
    return employee_service.interventions(session)


@employee_router.get("/employee/guardrails")
def guardrails(user: dict = Depends(require_role("employee")), session: Session = Depends(db)):
    return employee_service.guardrails(session)


@employee_router.get("/employee/model-health")
def model_health(user: dict = Depends(require_role("employee")), session: Session = Depends(db)):
    return employee_service.model_health(session)


@employee_router.get("/employee/experiments")
def experiments(user: dict = Depends(require_role("employee")), session: Session = Depends(db)):
    return employee_service.experiments(session)


@customer_router.get("/customer/listing/{sku_id}")
def listing(sku_id: str, user: dict = Depends(require_role("customer")), session: Session = Depends(db)):
    row = session.scalar(select(Sku).where(Sku.sku_id == sku_id))
    if row is None:
        raise ApiError(404, "That listing was not found.")
    seller = session.scalar(select(Seller).where(Seller.seller_id == row.seller_id))
    # customer-safe serializer: no cost, no contribution, no RTO, no seller economics
    return dict(
        listing=dict(sku_id=row.sku_id, name=row.name, category=row.category,
                     seller_city=seller.city if seller else None,
                     price=float(row.price), currency="INR",
                     rating=float(row.rating), review_count=int(row.review_count),
                     availability=("in stock" if row.inventory > 50 else "low stock"),
                     delivery_estimate="3–6 days (Illustrative)",
                     payment_options=[dict(id="prepaid", label="Pay online",
                                           note="Prepaid orders are delivered more reliably — no extra fee"),
                                      dict(id="cod", label="Cash on delivery",
                                           note="Available for this pin code")],
                     return_policy="7-day return window from delivery; size exchange free",
                     price_notice="Everyone sees the same price for this listing. Prices are not personalised."),
        label="synthetic", data_label="synthetic")


@health_router.get("/health")
def health():
    mb = bundle()
    return dict(status="ok", model_version=mb.version, data_label="synthetic",
                app_env=settings.app_env, bootstrap_members=mb.n_members,
                model_trained_at=mb.trained_at, data_hash=mb.data_hash)
