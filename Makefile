# ProfitPilot — one command for every step of the demo.
PY := python3
export PYTHONPATH := backend

.PHONY: help setup data train dev api demo test smoke e2e shots build clean reset

help:
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-10s\033[0m %s\n", $$1, $$2}'

setup: ## install backend + frontend dependencies
	$(PY) -m pip install -r backend/requirements.txt
	cd frontend && npm install

data: ## regenerate the synthetic dataset (deterministic seed)
	$(PY) scripts/generate_data.py

train: ## fit M1-M4 + the 30-member bootstrap and persist data/models/v1.json
	$(PY) scripts/train_models.py

api: ## run the API on :8000 (demo env, seeds the SQLite file on first boot)
	cd backend && $(PY) -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload

demo: ## one command: install + build the SPA if needed, then serve everything on :8000
	@test -d frontend/node_modules || (cd frontend && npm install)
	@test -f frontend/dist/index.html || (cd frontend && npm run build)
	@echo "ProfitPilot -> http://localhost:8000   (API docs at /api/docs)"
	cd backend && $(PY) -m uvicorn app.main:app --host 0.0.0.0 --port 8000

dev: ## run the frontend dev server on :5173 (proxies /api to :8000)
	cd frontend && npm run dev

test: ## pytest: goldens, models, constraints parity, API acceptance
	cd backend && $(PY) -m pytest app/tests -q

smoke: ## print the acceptance report for the 5 demo scenarios
	$(PY) scripts/api_smoke.py

e2e: ## Playwright end-to-end run (builds the SPA, starts the API itself)
	cd frontend && npm run e2e

shots: ## regenerate the screenshots quoted in docs/FINAL_CHECK.md
	cd frontend && SHOTS=1 npx playwright test screenshots.spec.ts

build: ## production build of the SPA into frontend/dist (served by the API)
	cd frontend && npm run build

reset: ## wipe the SQLite demo database and re-seed
	rm -f data/profitpilot.db && $(PY) -c "import sys; sys.path.insert(0,'backend'); from app.database.seed import seed_all; print(seed_all())"

clean: ## remove build artefacts and caches
	rm -rf frontend/dist frontend/node_modules/.vite frontend/test-results frontend/playwright-report .pytest_cache backend/**/__pycache__
