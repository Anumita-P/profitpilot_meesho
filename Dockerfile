# ProfitPilot — one image that builds the SPA and serves it together with the API (SPEC 26).
# Two stages: Node builds the frontend, Python serves it. No network access at runtime.

# ---------- stage 1: build the SPA ----------
FROM node:20-alpine AS web

WORKDIR /web
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
# tsc + vite build → /web/dist (offline: no CDN, no external fonts)
RUN npm run build

# ---------- stage 2: API + SPA ----------
FROM python:3.13-slim AS app

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app/backend \
    APP_ENV=demo \
    PORT=8000

WORKDIR /app

COPY backend/requirements.txt /app/backend/requirements.txt
RUN pip install --no-cache-dir -r /app/backend/requirements.txt

COPY backend/ /app/backend/
COPY scripts/ /app/scripts/
COPY data/synthetic/ /app/data/synthetic/
COPY data/models/ /app/data/models/
COPY docs/ /app/docs/

# the SPA the API mounts at "/" (only mounted when this directory exists)
COPY --from=web /web/dist /app/frontend/dist

# the demo database is created on first boot by the app's lifespan hook
RUN mkdir -p /data

EXPOSE 8000

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD python3 -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=3).status==200 else 1)"

CMD ["sh", "-c", "cd /app/backend && python3 -m uvicorn app.main:app --host 0.0.0.0 --port ${PORT}"]
