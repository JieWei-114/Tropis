import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright E2E suite for the full Tropis.
 *
 * The stack is EXTERNAL — this config deliberately has no `webServer`.
 * Before running, the caller (Makefile `test-e2e` target or CI) must have:
 *   - infra up (docker compose)
 *   - backend listening on http://localhost:3100 (health: /api/health)
 *   - frontend served at E2E_BASE_URL (default http://localhost:5173,
 *     `vite preview` for determinism)
 */
export default defineConfig({
  testDir: './tests',
  fullyParallel: false, // flows share backend state (users, analytics); keep serial-ish
  workers: 1,
  retries: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [['html', { outputFolder: 'report', open: 'never' }], ['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:5173',
    trace: 'on-first-retry',
  },
  // Chromium-only by default so CI stays fast. Set E2E_ALL_BROWSERS=1 to also
  // run Firefox + WebKit (pre-release cross-browser pass):
  //   E2E_ALL_BROWSERS=1 npx playwright test
  // First time, install the extra engines: npx playwright install firefox webkit
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    ...(process.env.E2E_ALL_BROWSERS === '1'
      ? [
          { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
          { name: 'webkit', use: { ...devices['Desktop Safari'] } },
        ]
      : []),
  ],
});
