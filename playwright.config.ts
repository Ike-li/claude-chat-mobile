import { defineConfig } from '@playwright/test';

const port = Number(process.env.CCM_PLAYWRIGHT_PORT || 33341);
const baseURL = process.env.CCM_PLAYWRIGHT_BASE_URL || `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.ts',
  testIgnore: ['**/seed.*.spec.ts'],
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: {
    timeout: 8_000
  },
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  use: {
    baseURL,
    headless: true,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    viewport: { width: 375, height: 812 },
    isMobile: true,
    hasTouch: true
  },
  webServer: {
    command: `PORT=${port} node scripts/visual-mock-server.js`,
    url: baseURL,
    timeout: 30_000,
    reuseExistingServer: !process.env.CI
  }
});
