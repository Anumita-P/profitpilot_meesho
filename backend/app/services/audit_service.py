"""Audit logging (SPEC 21): actions and identifiers only — never request bodies, never PII."""
from __future__ import annotations

from sqlalchemy.orm import Session

from ..database.models import AuditLog

ALLOWED = {
    "login", "logout", "demo_reset", "demo_scenario", "recommendation_generated",
    "intervention_selected", "recommendation_rolled_back", "goal_saved", "authorization_denied",
    "model_unavailable", "rate_limited",
}


def write(session: Session, *, action: str, user_id: str | None = None, role: str | None = None,
          entity_type: str | None = None, entity_id: str | None = None, model_version: str | None = None,
          request_id: str | None = None, meta: dict | None = None) -> None:
    if action not in ALLOWED:
        raise ValueError(f"unknown audit action {action!r}")
    safe = {k: v for k, v in (meta or {}).items() if isinstance(v, (int, float, bool, str))}
    session.add(AuditLog(user_id=user_id, role=role, action=action, entity_type=entity_type,
                         entity_id=entity_id, model_version=model_version, request_id=request_id,
                         meta=safe))
    session.commit()


def recent(session: Session, limit: int = 50) -> list[dict]:
    rows = session.query(AuditLog).order_by(AuditLog.ts.desc()).limit(limit).all()
    return [dict(id=r.id, ts=r.ts.isoformat(), action=r.action, role=r.role, entity_type=r.entity_type,
                 entity_id=r.entity_id, meta=r.meta) for r in rows]


def counts(session: Session) -> dict:
    out: dict[str, int] = {}
    for action in sorted(ALLOWED):
        out[action] = session.query(AuditLog).filter(AuditLog.action == action).count()
    return out
