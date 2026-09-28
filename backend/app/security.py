"""AuthN/AuthZ primitives (SPEC 21). Secrets come from settings only; nothing is hard-coded."""
from __future__ import annotations

import hashlib
import hmac
import os
import secrets
from datetime import datetime, timedelta, timezone

import jwt

from .config import settings

COOKIE_NAME = "pp_session"
ALGO = "HS256"


def _secret() -> str:
    cached = getattr(_secret, "_cache", None)
    if cached:
        return cached
    value = settings.resolve_secret()
    _secret._cache = value       # type: ignore[attr-defined]
    return value


def create_token(*, user_id: str, role: str, seller_id: str | None, persona: str | None,
                 name: str) -> str:
    now = datetime.now(timezone.utc)
    payload = dict(sub=user_id, role=role, seller_id=seller_id, persona=persona, name=name,
                   iat=int(now.timestamp()), exp=int((now + timedelta(minutes=settings.jwt_expire_minutes)).timestamp()),
                   jti=secrets.token_hex(8))
    return jwt.encode(payload, _secret(), algorithm=ALGO)


def decode_token(token: str) -> dict | None:
    try:
        return jwt.decode(token, _secret(), algorithms=[ALGO])
    except jwt.PyJWTError:
        return None


def sliding_refresh(token: str) -> str | None:
    """Re-issue a token when it is more than half-way through its life (SPEC 21)."""
    data = decode_token(token)
    if not data:
        return None
    exp = datetime.fromtimestamp(data["exp"], tz=timezone.utc)
    remaining = exp - datetime.now(timezone.utc)
    if remaining < timedelta(minutes=settings.jwt_expire_minutes / 2):
        return create_token(user_id=data["sub"], role=data["role"], seller_id=data.get("seller_id"),
                            persona=data.get("persona"), name=data.get("name", ""))
    return None


# --- password hashing for non-demo users (demo personas never have a password) --------------------
def hash_password(password: str) -> str:
    salt = os.urandom(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, n=2 ** 14, r=8, p=1, dklen=32)
    return f"scrypt$ {salt.hex()}${digest.hex()}".replace(" ", "")


def verify_password(password: str, stored: str) -> bool:
    try:
        _, salt_hex, digest_hex = stored.split("$")
        salt = bytes.fromhex(salt_hex)
        expected = bytes.fromhex(digest_hex)
        got = hashlib.scrypt(password.encode(), salt=salt, n=2 ** 14, r=8, p=1, dklen=32)
        return hmac.compare_digest(got, expected)
    except Exception:      # pragma: no cover - malformed hash
        return False
