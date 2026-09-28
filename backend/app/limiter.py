"""Rate limiting (SPEC 12/21): per-user when signed in, per-IP otherwise.

Lives in its own module so routers can decorate their endpoints at definition time without a
circular import back into `main`.
"""
from __future__ import annotations

from fastapi import Request
from slowapi import Limiter
from slowapi.util import get_remote_address

from .config import settings
from .security import decode_token


def limiter_key(request: Request) -> str:
    token = request.cookies.get("pp_session")
    if token:
        data = decode_token(token)
        if data:
            return f"user:{data['sub']}"
    return f"ip:{get_remote_address(request)}"


limiter = Limiter(key_func=limiter_key, default_limits=[settings.rate_limit_default])

auth_limit = limiter.limit(settings.rate_limit_auth)
sim_limit = limiter.limit(settings.rate_limit_sim)
