"""Auth + identity endpoints (#1-#3)."""

from fastapi import APIRouter, Depends, Request, Response
from sqlalchemy.orm import Session

from ..config import settings
from ..database.models import Seller, Sku, User
from ..database.seed import DEMO_USERS
from ..errors import ApiError
from ..limiter import auth_limit
from ..security import COOKIE_NAME, create_token
from ..services import audit_service
from .deps import current_user, db
from .schemas import LoginIn

router = APIRouter(tags=["auth"])


@router.post("/auth/demo-login")
@auth_limit
def demo_login(payload: LoginIn, request: Request, response: Response, session: Session = Depends(db)):
    if settings.app_env != "demo":
        raise ApiError(404, "Demo login is disabled in this environment.")
    user = session.query(User).filter(User.persona == payload.persona).one_or_none()
    if user is None:
        raise ApiError(404, "Unknown demo persona.")
    token = create_token(user_id=user.user_id, role=user.role, seller_id=user.seller_id,
                         persona=user.persona, name=user.name)
    response.set_cookie(COOKIE_NAME, token, httponly=True, samesite="lax",
                        secure=settings.cookie_secure, max_age=settings.jwt_expire_minutes * 60)
    audit_service.write(session, action="login", user_id=user.user_id, role=user.role,
                        entity_type="user", entity_id=user.user_id,
                        request_id=getattr(request.state, "request_id", None))
    return dict(user=dict(id=user.user_id, role=user.role, name=user.name, seller_id=user.seller_id,
                          persona=user.persona),
                redirect=dict(seller="/seller/catalog", employee="/employee/overview",
                              customer="/customer/listing/K-101")[user.role])


@router.post("/auth/logout", status_code=204)
def logout(request: Request, response: Response, session: Session = Depends(db)):
    user = request.cookies.get(COOKIE_NAME)
    from ..security import decode_token
    data = decode_token(user) if user else None
    if data:
        audit_service.write(session, action="logout", user_id=data["sub"], role=data.get("role"),
                            request_id=getattr(request.state, "request_id", None))
    response.delete_cookie(COOKIE_NAME)
    return Response(status_code=204)


@router.get("/me")
def me(user: dict = Depends(current_user), session: Session = Depends(db)):
    seller = None
    if user.get("seller_id"):
        row = session.query(Seller).filter(Seller.seller_id == user["seller_id"]).one_or_none()
        if row:
            count = session.query(Sku).filter(Sku.seller_id == row.seller_id).count()
            seller = dict(seller_id=row.seller_id, name=row.name, city=row.city,
                          default_mode=row.default_mode, cash_limit=row.cash_limit, sku_count=count)
    return dict(user=dict(id=user["sub"], role=user["role"], name=user.get("name"),
                          seller_id=user.get("seller_id"), persona=user.get("persona")),
                seller=seller, env=settings.app_env,
                persona_options=[dict(persona=u["persona"], name=u["name"], role=u["role"])
                                 for u in DEMO_USERS])
