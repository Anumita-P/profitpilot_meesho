"""Request id, security headers, CSRF-ish origin check and structured request logging (SPEC 21)."""
from __future__ import annotations

import json
import logging
import time
import uuid

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse

from .config import settings

log = logging.getLogger("profitpilot")

SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}


class RequestContextMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        request.state.request_id = uuid.uuid4().hex[:12]
        start = time.perf_counter()
        response = await call_next(request)
        duration_ms = (time.perf_counter() - start) * 1000
        response.headers["X-Request-ID"] = request.state.request_id
        log.info(json.dumps(dict(event="request", path=request.url.path, method=request.method,
                                 status=response.status_code, ms=round(duration_ms, 1),
                                 request_id=request.state.request_id,
                                 role=getattr(request.state, "role", None))))
        return response


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("X-Frame-Options", "DENY")
        response.headers.setdefault("Referrer-Policy", "no-referrer")
        response.headers.setdefault("Permissions-Policy", "geolocation=(), microphone=(), camera=()")
        response.headers.setdefault(
            "Content-Security-Policy",
            "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; "
            "script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'")
        if settings.app_env == "prod":
            response.headers.setdefault("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
        if request.url.path.startswith("/api/") and not request.url.path.startswith("/api/health"):
            response.headers.setdefault("Cache-Control", "no-store")
        return response


class WriteGuardMiddleware(BaseHTTPMiddleware):
    """Writes need the custom header (CSRF) and, when an Origin is present, an allowlisted origin."""

    async def dispatch(self, request: Request, call_next):
        if request.method not in SAFE_METHODS and request.url.path.startswith("/api/"):
            if request.headers.get("X-Requested-With") != "profitpilot":
                return JSONResponse(status_code=403, content=dict(error=dict(
                    code="FORBIDDEN", message="Missing X-Requested-With header on a write request",
                    field_errors={}, request_id=getattr(request.state, "request_id", None))))
            origin = request.headers.get("Origin")
            if origin and origin not in settings.origins and settings.app_env != "demo":
                return JSONResponse(status_code=403, content=dict(error=dict(
                    code="FORBIDDEN", message="Origin not allowed", field_errors={},
                    request_id=getattr(request.state, "request_id", None))))
        return await call_next(request)
