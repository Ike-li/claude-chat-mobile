import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '../playground/e2e',
  testMatch: 'app-*.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 8_000 },
  outputDir: '/tmp/playground-pw',
  reporter: [['list']],
  use: {
    // 不用 http://app:3000：`app` 在 Chromium HSTS 预载表里，见 docker-compose.playground.yml 的 aliases 注释。
    baseURL: 'http://ccm-app:3000',
    headless: true,
    viewport: { width: 375, height: 812 },
    isMobile: true,
    hasTouch: true,
  },
  projects: [{ name: 'app', testMatch: 'app-*.spec.ts' }],
});
