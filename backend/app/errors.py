"""Error envelope (SPEC 12): {"error": {code, message, field_errors, request_id}}."""
from __future__ import annotations

from fastapi import Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

CODES = {
    400: "BAD_REQUEST", 401: "UNAUTHENTICATED", 403: "FORBIDDEN", 404: "NOT_FOUND",
    409: "CONFLICT", 422: "VALIDATION_ERROR", 429: "RATE_LIMITED", 500: "INTERNAL",
    503: "MODEL_UNAVAILABLE",
}


class ApiError(Exception):
    def __init__(self, status_code: int, message: str, code: str | None = None,
                 field_errors: dict | None = None):
        self.status_code = status_code
        self.code = code or CODES.get(status_code, "INTERNAL")
        self.message = message
        self.field_errors = field_errors or {}
        super().__init__(message)


def _envelope(request: Request, status: int, code: str, message: str,
              field_errors: dict | None = None) -> JSONResponse:
    body = dict(error=dict(code=code, message=message, field_errors=field_errors or {},
                           request_id=getattr(request.state, "request_id", None)))
    headers = {}
    if status == 429:
        headers["Retry-After"] = "60"
    return JSONResponse(status_code=status, content=body, headers=headers)


def install(app) -> None:
    @app.exception_handler(ApiError)
    async def _api_error(request: Request, exc: ApiError):
        return _envelope(request, exc.status_code, exc.code, exc.message, exc.field_errors)

    @app.exception_handler(RequestValidationError)
    async def _validation(request: Request, exc: RequestValidationError):
        field_errors: dict[str, str] = {}
        for err in exc.errors():
            loc = ".".join(str(p) for p in err.get("loc", []) if p not in ("body", "query", "path"))
            field_errors[loc or "body"] = err.get("msg", "invalid")
        first = next(iter(field_errors.items()), ("body", "invalid request"))
        return _envelope(request, 422, "VALIDATION_ERROR", f"{first[0]}: {first[1]}", field_errors)

    @app.exception_handler(StarletteHTTPException)
    async def _http(request: Request, exc: StarletteHTTPException):
        code = CODES.get(exc.status_code, "INTERNAL")
        return _envelope(request, exc.status_code, code, str(exc.detail))

    @app.exception_handler(Exception)
    async def _unhandled(request: Request, exc: Exception):
        # Details stay in the logs; the client gets a generic message plus the request id.
        import logging
        logging.getLogger("profitpilot").exception("unhandled error: %s", exc)
        return _envelope(request, 500, "INTERNAL",
                         "Something went wrong on our side. Quote the request id if you report it.")
