"""Application settings (SPEC 27). Secrets come from the environment only; nothing is hard-coded."""
from __future__ import annotations

import os
import secrets
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_SECRET = "CHANGE_ME_32_BYTES_MIN"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=str(ROOT / ".env"), extra="ignore")

    app_env: str = "demo"                      # demo | dev | prod
    database_url: str = f"sqlite:///{ROOT/'data'/'profitpilot.db'}"
    jwt_secret: str = DEFAULT_SECRET
    jwt_expire_minutes: int = 60
    cors_origins: str = "http://localhost:5173,http://127.0.0.1:5173"
    cookie_secure: bool = False
    rate_limit_auth: str = "10/minute"
    rate_limit_sim: str = "60/minute"
    rate_limit_default: str = "300/minute"
    max_price_move: float = 0.12
    bootstrap_members: int = 30
    cost_of_capital_annual: float = 0.24
    t_deliv_days: int = 5
    t_settle_days: int = 7
    t_return_loop_days: int = 18
    model_path: str = str(ROOT / "data" / "models" / "v1.json")
    data_seed: int = 20260928
    log_level: str = "INFO"
    # demo-only fault injection for exercising error states (see scripts/../api/faults)
    allow_faults: bool = True

    @property
    def origins(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    def resolve_secret(self) -> str:
        """Refuse to boot in dev/prod with the placeholder secret; generate an ephemeral one in demo."""
        if self.jwt_secret and self.jwt_secret != DEFAULT_SECRET and len(self.jwt_secret) >= 32:
            return self.jwt_secret
        if self.app_env == "demo":
            return os.environ.get("JWT_SECRET_EPHEMERAL") or secrets.token_hex(32)
        raise RuntimeError(
            "JWT_SECRET must be set to at least 32 bytes (see .env.example) when APP_ENV != demo. "
            "Refusing to start.")


settings = Settings()
MODEL_VERSION = "pp-synth-1.0.0"
