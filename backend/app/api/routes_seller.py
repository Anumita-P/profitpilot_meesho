"""Seller endpoints (#4-#18): catalog, goals, simulator, recommendation, reverse pricing, diagnosis,
model pipeline, saved recommendations."""

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import settings
from ..database.models import Recommendation, SellerGoal, Sku
from ..errors import ApiError
from ..limiter import sim_limit
from ..optimization import constraints as K
from ..services import (catalog_service, demo_service, diagnosis_service, explain_service,
                        recommendation_service, reverse_pricing, simulation_service)
from ..services.audit_service import write as audit
from ..services.runtime import bundle, comparables, ece_worst, goal_dict, goal_public
from ..services.runtime import sku_dict
from .deps import db, fault, owned_sku, seller_scope
from .schemas import (CurveIn, ExplanationIn, ModelIn, PointIn, RecommendationIn, ReverseIn,
                      SaveRecommendationIn, SkuGoalIn)

router = APIRouter(tags=["seller"])


@router.get("/skus")
def list_skus(status: str | None = Query(None, pattern="^(all|losing|watch|healthy)$"),
              sort: str = Query("contribution", pattern="^(contribution|orders|name)$"),
              user: dict = Depends(seller_scope), session: Session = Depends(db),
              _f: str | None = Depends(fault)):
    return catalog_service.list_skus(session, user["seller_id"], status, sort)


@router.get("/skus/{sku_id}")
def get_sku(sku_id: str, user: dict = Depends(seller_scope), session: Session = Depends(db)):
    owned_sku(user, session, sku_id)
    data = catalog_service.sku_detail(session, user["seller_id"], sku_id)
    if not data:
        raise ApiError(404, "That listing was not found in your catalog.")
    return data


@router.get("/skus/{sku_id}/snapshot")
def snapshot(sku_id: str, user: dict = Depends(seller_scope), session: Session = Depends(db),
             _f: str | None = Depends(fault)):
    owned_sku(user, session, sku_id)
    goal = catalog_service.default_goal(session, user["seller_id"], sku_id)
    return simulation_service.snapshot(session, user["seller_id"], sku_id, goal)


@router.get("/skus/{sku_id}/diagnosis")
def diagnosis(sku_id: str, user: dict = Depends(seller_scope), session: Session = Depends(db),
              _f: str | None = Depends(fault)):
    owned_sku(user, session, sku_id)
    goal = catalog_service.default_goal(session, user["seller_id"], sku_id)
    return diagnosis_service.diagnose_sku(session, user["seller_id"], sku_id, goal)


@router.post("/goals/preview")
def goal_preview(payload: SkuGoalIn, user: dict = Depends(seller_scope), session: Session = Depends(db),
                 _f: str | None = Depends(fault)):
    owned_sku(user, session, payload.sku_id)
    goal = goal_public(payload.goal) | {"mode": payload.mode or payload.goal.mode}
    from ..optimization import search as S
    sku = sku_dict(session.scalar(select(Sku).where(Sku.sku_id == payload.sku_id)))
    po = recommendation_service.price_only_search(sku, goal, goal["mode"])
    best = po["best"]
    return dict(verdict_hint=("PRICE_WORKS" if best else "PRICE_INFEASIBLE"),
                best_in_corridor=dict(price=(best or po["best_any"])["price"],
                                      per_kept=(best or po["best_any"])["metrics"]["per_kept"]["p50"],
                                      orders_day=(best or po["best_any"])["metrics"]["orders_day"]["p50"]),
                shortfall=S.shortfall_against(po["evaluated"], goal=goal), label="estimated")


@router.post("/goals")
def save_goal(payload: SkuGoalIn, request: Request, user: dict = Depends(seller_scope),
              session: Session = Depends(db)):
    owned_sku(user, session, payload.sku_id)
    row = SellerGoal(seller_id=user["seller_id"], sku_id=payload.sku_id, is_default=False,
                     target_contribution=payload.goal.target_contribution,
                     min_orders=payload.goal.min_orders,
                     max_return_rto=payload.goal.max_return_rto,
                     cash_limit=payload.goal.cash_limit,
                     mode=payload.mode or payload.goal.mode)
    session.add(row)
    session.commit()
    audit(session, action="goal_saved", user_id=user["sub"], role=user["role"], entity_type="sku",
          entity_id=payload.sku_id, request_id=getattr(request.state, "request_id", None),
          meta=dict(target=payload.goal.target_contribution, min_orders=payload.goal.min_orders,
                    cap=payload.goal.max_return_rto, mode=row.mode))
    return dict(saved=True, goal=goal_dict(row), goal_id=row.id)


@router.post("/simulate/curve")
@sim_limit
def simulate_curve(payload: CurveIn, request: Request, user: dict = Depends(seller_scope),
                   session: Session = Depends(db), _f: str | None = Depends(fault)):
    owned_sku(user, session, payload.sku_id)
    goal = goal_public(payload.goal) | {"mode": payload.goal.mode}
    iv = payload.intervention.model_dump() if payload.intervention else None
    out = simulation_service.curve(session, user["seller_id"], payload.sku_id, goal, iv,
                                   payload.price_min, payload.price_max, payload.step)
    if not out:
        raise ApiError(404, "That listing was not found in your catalog.")
    return out


@router.post("/simulate/point")
@sim_limit
def simulate_point(payload: PointIn, request: Request, user: dict = Depends(seller_scope),
                   session: Session = Depends(db), _f: str | None = Depends(fault)):
    owned_sku(user, session, payload.sku_id)
    goal = goal_public(payload.goal) | {"mode": payload.goal.mode}
    iv = payload.intervention.model_dump() if payload.intervention else None
    out = simulation_service.point(session, user["seller_id"], payload.sku_id, payload.price, goal, iv)
    if not out:
        raise ApiError(404, "That listing was not found in your catalog.")
    return out


@router.post("/recommendation")
@sim_limit
def recommendation(payload: RecommendationIn, request: Request, user: dict = Depends(seller_scope),
                   session: Session = Depends(db), _f: str | None = Depends(fault)):
    owned_sku(user, session, payload.sku_id)
    goal = goal_public(payload.goal) | {"mode": payload.goal.mode}
    out = recommendation_service.recommend(session, user["seller_id"], payload.sku_id, goal,
                                          payload.mode, payload.include_interventions)
    if not out:
        raise ApiError(404, "That listing was not found in your catalog.")
    audit(session, action="recommendation_generated", user_id=user["sub"], role=user["role"],
          entity_type="sku", entity_id=payload.sku_id, model_version=bundle().version,
          request_id=getattr(request.state, "request_id", None),
          meta=dict(verdict=out["verdict"], interventions=len(out.get("interventions", []))))
    return out


@router.post("/reverse-pricing")
@sim_limit
def reverse_pricing_endpoint(payload: ReverseIn, request: Request, user: dict = Depends(seller_scope),
                             session: Session = Depends(db), _f: str | None = Depends(fault)):
    owned_sku(user, session, payload.sku_id)
    goal = goal_public(payload.goal) | {"mode": payload.goal.mode}
    out = reverse_pricing.reverse(session, user["seller_id"], payload.sku_id, goal,
                                  payload.inventory_units, payload.stock_age_days)
    if not out:
        raise ApiError(404, "That listing was not found in your catalog.")
    audit(session, action="recommendation_generated", user_id=user["sub"], role=user["role"],
          entity_type="sku", entity_id=payload.sku_id, model_version=bundle().version,
          request_id=getattr(request.state, "request_id", None), meta=dict(kind="reverse_pricing"))
    return out


@router.post("/recommendations")
def save_recommendation(payload: SaveRecommendationIn, request: Request,
                        user: dict = Depends(seller_scope), session: Session = Depends(db)):
    owned_sku(user, session, payload.sku_id)
    goal = goal_public(payload.goal) | {"mode": payload.mode}
    # server recomputes the expected metrics: the client's numbers are never trusted
    iv = payload.intervention.model_dump() if payload.intervention else {}
    point = simulation_service.point(session, user["seller_id"], payload.sku_id, payload.price, goal, iv)
    if not point:
        raise ApiError(404, "That listing was not found in your catalog.")
    verdict = "PRICE_WORKS" if payload.intervention_id == "PRICE" else "INTERVENTION_SELECTED"
    row = Recommendation(
        seller_id=user["seller_id"], sku_id=payload.sku_id, verdict=verdict,
        intervention=dict(id=payload.intervention_id, price=payload.price, iv=iv),
        expected={k: point["metrics"][k] for k in ("per_kept", "orders_day", "leakage",
                                                   "contribution_day", "nmv_day")},
        why=dict(confidence=point["confidence"]["label"],
                 constraints=[c for c in point["constraints"] if not c["pass_"]]),
        confidence=point["confidence"]["label"], model_version=bundle().version, status="saved",
        note=payload.note, created_by=user["sub"])
    session.add(row)
    session.commit()
    audit(session, action="intervention_selected", user_id=user["sub"], role=user["role"],
          entity_type="sku", entity_id=payload.sku_id, model_version=bundle().version,
          request_id=getattr(request.state, "request_id", None),
          meta=dict(intervention=payload.intervention_id, price=payload.price))
    return dict(id=row.id, status=row.status, created_at=row.created_at.isoformat(),
                expected=row.expected, confidence=row.confidence, label="estimated")


@router.get("/recommendations")
def history(limit: int = Query(20, ge=1, le=100), user: dict = Depends(seller_scope),
            session: Session = Depends(db)):
    rows = session.scalars(select(Recommendation).where(Recommendation.seller_id == user["seller_id"])
                           .order_by(Recommendation.created_at.desc()).limit(limit)).all()
    return dict(items=[dict(id=r.id, sku_id=r.sku_id, verdict=r.verdict, intervention=r.intervention,
                            expected=r.expected, confidence=r.confidence, status=r.status,
                            note=r.note, created_at=r.created_at.isoformat(),
                            model_version=r.model_version) for r in rows], label="estimated")


@router.post("/recommendations/{rec_id}/rollback")
def rollback(rec_id: int, request: Request, user: dict = Depends(seller_scope),
             session: Session = Depends(db)):
    row = session.scalar(select(Recommendation).where(Recommendation.id == rec_id,
                                                      Recommendation.seller_id == user["seller_id"]))
    if row is None:
        raise ApiError(404, "That recommendation was not found.")
    if row.status == "rolled_back":
        raise ApiError(409, "That recommendation was already rolled back.")
    row.status = "rolled_back"
    session.commit()
    audit(session, action="recommendation_rolled_back", user_id=user["sub"], role=user["role"],
          entity_type="recommendation", entity_id=str(rec_id),
          request_id=getattr(request.state, "request_id", None))
    return dict(id=row.id, status=row.status, note="Guardrail demo only: nothing was changed on Meesho.")


@router.post("/recommendations/{rec_id}/apply")
def apply_simulated(rec_id: int, request: Request, user: dict = Depends(seller_scope),
                    session: Session = Depends(db)):
    row = session.scalar(select(Recommendation).where(Recommendation.id == rec_id,
                                                      Recommendation.seller_id == user["seller_id"]))
    if row is None:
        raise ApiError(404, "That recommendation was not found.")
    row.status = "applied_simulated"
    session.commit()
    return dict(id=row.id, status=row.status,
                note="Demo state only. ProfitPilot never changes a live price.")


@router.get("/model/pipeline")
def model_pipeline(sku_id: str = Query(min_length=1, max_length=16),
                   user: dict = Depends(seller_scope), session: Session = Depends(db)):
    owned_sku(user, session, sku_id)
    return explain_service.pipeline(session, user["seller_id"], sku_id)


@router.get("/model/explanation")
def model_explanation(sku_id: str = Query(min_length=1, max_length=16),
                      price: float = Query(ge=1, le=100_000),
                      compare_price: float | None = Query(None, ge=1, le=100_000),
                      user: dict = Depends(seller_scope), session: Session = Depends(db)):
    owned_sku(user, session, sku_id)
    return explain_service.explanation(session, user["seller_id"], sku_id, price,
                                       compare_price=compare_price)
