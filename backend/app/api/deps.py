"""FastAPI dependencies: session cookie auth, RBAC, seller scoping, rate limiting, fault injection."""
from __future__ import annotations

from fastapi import Depends, Request, Response
from sqlalchemy.orm import Session

from ..config import settings
from ..database.models import Sku, User
from ..database.session import get_session
from ..errors import ApiError
from ..security import COOKIE_NAME, decode_token, sliding_refresh


def db() -> Session:
    session = get_session()
    try:
        yield session
    finally:
        session.close()


def current_user(request: Request, response: Response, session: Session = Depends(db)) -> dict:
    token = request.cookies.get(COOKIE_NAME)
    if not token:
        raise ApiError(401, "Sign in to continue.")
    data = decode_token(token)
    if not data:
        raise ApiError(401, "Your session expired. Sign in again.")
    request.state.role = data.get("role")
    refreshed = sliding_refresh(token)
    if refreshed:
        response.set_cookie(COOKIE_NAME, refreshed, httponly=True, samesite="lax",
                            secure=settings.cookie_secure, max_age=settings.jwt_expire_minutes * 60)
    return data


def require_role(*roles: str):
    def _dep(user: dict = Depends(current_user)) -> dict:
        if user.get("role") not in roles:
            raise ApiError(403, "Your role cannot access this.")
        return user
    return _dep


def seller_scope(user: dict = Depends(require_role("seller"))) -> dict:
    """Sellers are always scoped to their own seller_id, taken from the session (never the request)."""
    if not user.get("seller_id"):
        raise ApiError(403, "No seller profile attached to this session.")
    return user


def owned_sku(user: dict, session: Session, sku_id: str) -> Sku:
    """Cross-tenant access returns 404 (never 403) so IDs cannot be enumerated (SPEC 21)."""
    row = session.query(Sku).filter(Sku.sku_id == sku_id, Sku.seller_id == user["seller_id"]).one_or_none()
    if row is None:
        from ..services import audit_service
        audit_service.write(session, action="authorization_denied", user_id=user["sub"],
                            role=user["role"], entity_type="sku", entity_id=sku_id,
                            meta=dict(reason="not_found_or_other_seller"))
        raise ApiError(404, "That listing was not found in your catalog.")
    return row


def fault(request: Request) -> str | None:
    """Demo-only fault injection so the error states in SPEC 24 can be exercised end to end."""
    if not (settings.allow_faults and settings.app_env == "demo"):
        return None
    value = request.query_params.get("fault")
    if value == "model_unavailable":
        raise ApiError(503, "The pricing model isn't available right now. Your goal is saved.")
    if value == "error":
        raise ApiError(500, "Something went wrong on our side. Retry")
    return value


def require_user_row(session: Session, user_id: str) -> User | None:
    return session.query(User).filter(User.user_id == user_id).one_or_none()
