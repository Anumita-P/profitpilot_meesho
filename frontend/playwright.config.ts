import { defineConfig, devices } from '@playwright/test'

/**
 * End-to-end run against the real stack: the FastAPI app serves both /api and the built SPA
 * (frontend/dist). `npm run e2e` builds the SPA first, then starts the API if it is not already
 * running on :8000. Everything the tests assert is recomputed by the backend on every request —
 * there is no mock layer and no network access beyond 127.0.0.1.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 45_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:8000',
    trace: 'off',
    video: 'off',
    screenshot: 'only-on-failure',
    viewport: { width: 1440, height: 950 },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'python3 -m uvicorn app.main:app --host 127.0.0.1 --port 8000',
    cwd: '../backend',
    env: { PYTHONPATH: '../backend' },
    url: 'http://127.0.0.1:8000/api/health',
    reuseExistingServer: true,
    timeout: 120_000,
  },
})
