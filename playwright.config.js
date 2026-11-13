// Playwright smoke tests: iPhone-sized Chromium against the local static server.
// Locally (agent workspace) it uses /usr/bin/google-chrome; in CI the bundled Chromium.
import { defineConfig } from 'playwright/test';
import { existsSync } from 'node:fs';

const PORT = Number(process.env.E2E_PORT || 4173);
const localChrome = !process.env.CI && existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined;

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: /.*\.spec\.js$/,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : 4,
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
  timeout: 20_000,
  expect: { timeout: 5_000 },
  use: {
    baseURL: `http://127.0.0.1:${PORT}/`,
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    locale: 'es-CO',
    timezoneId: 'America/Bogota',
    colorScheme: 'light',
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
    launchOptions: localChrome ? { executablePath: localChrome } : {},
  },
  webServer: {
    command: `node scripts/serve.mjs --port ${PORT}`,
    url: `http://127.0.0.1:${PORT}/index.html`,
    reuseExistingServer: !process.env.CI,
    timeout: 15_000,
  },
});
