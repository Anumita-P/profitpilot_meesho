"""ProfitPilot API (SPEC 10 / 12). Offline, deterministic, demo-first."""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from slowapi.errors import RateLimitExceeded

from . import errors, middleware
from .api import routes_auth, routes_other, routes_seller
from .config import settings
from .limiter import limiter
from .database.seed import db_is_empty, seed_all
from .services.runtime import bundle

log = logging.getLogger("profitpilot")
logging.basicConfig(level=settings.log_level,
                    format="%(asctime)s %(levelname)s %(name)s %(message)s")

ROOT = Path(__file__).resolve().parents[2]
FRONTEND_DIST = ROOT / "frontend" / "dist"


@asynccontextmanager
async def lifespan(app: FastAPI):
    if not Path(settings.model_path).exists():
        raise RuntimeError(
            f"Model file {settings.model_path} is missing. Run `python scripts/train_models.py` "
            f"(or `make train`) before starting in {settings.app_env}. Refusing to serve a "
            f"pricing product without a pricing model.")
    try:
        bundle()
    except FileNotFoundError as exc:      # pragma: no cover - guarded above
        raise RuntimeError(str(exc)) from exc
    if db_is_empty():
        log.warning("database empty -> seeding demo catalog")
        seed_all(reset=True, load_obs=True)
    log.info("ProfitPilot ready · model %s · env %s", bundle().version, settings.app_env)
    yield


app = FastAPI(title="ProfitPilot API", version="1.0.0", lifespan=lifespan,
              docs_url="/api/docs", openapi_url="/api/openapi.json")
app.state.limiter = limiter

app.add_middleware(middleware.RequestContextMiddleware)
app.add_middleware(middleware.SecurityHeadersMiddleware)
app.add_middleware(middleware.WriteGuardMiddleware)
app.add_middleware(CORSMiddleware, allow_origins=settings.origins, allow_credentials=True,
                   allow_methods=["GET", "POST", "OPTIONS"], allow_headers=["Content-Type",
                                                                             "X-Requested-With"])

errors.install(app)


@app.exception_handler(RateLimitExceeded)
async def _rate_limited(request: Request, exc: RateLimitExceeded):
    return JSONResponse(status_code=429, content=dict(error=dict(
        code="RATE_LIMITED", message="Too many requests — slow down for a moment.",
        field_errors={}, request_id=getattr(request.state, "request_id", None))),
        headers={"Retry-After": "60"})


app.include_router(routes_auth.router, prefix="/api")
app.include_router(routes_seller.router, prefix="/api")
app.include_router(routes_other.demo_router, prefix="/api")
app.include_router(routes_other.employee_router, prefix="/api")
app.include_router(routes_other.customer_router, prefix="/api")
app.include_router(routes_other.health_router, prefix="/api")


@app.get("/api")
def api_root():
    return dict(name="ProfitPilot API", version="1.0.0",
                note="Prototype for a Meesho-themed competition. Synthetic data only; not connected "
                     "to Meesho systems.",
                docs="/api/docs", health="/api/health")


if FRONTEND_DIST.exists():      # single-image demo mode: serve the built SPA from the API
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIST), html=True), name="spa")

    @app.exception_handler(404)
    async def spa_fallback(request: Request, exc):
        """Client-side routes are not files: hand them index.html at the same URL so the router
        can render the deep link instead of redirecting the browser back to the root."""
        if request.url.path.startswith("/api/"):
            return JSONResponse(status_code=404, content=dict(error=dict(
                code="NOT_FOUND", message="Not found", field_errors={},
                request_id=getattr(request.state, "request_id", None))))
        return FileResponse(FRONTEND_DIST / "index.html")


@app.get("/")
def root():
    return RedirectResponse("/api/docs")
