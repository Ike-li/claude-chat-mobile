// tests/acceptance/replay/playwright.config.ts —— A 档脚本重放（零 token）
//
// 由 run.mjs 调起：npx playwright test -c tests/acceptance/replay/playwright.config.ts --grep <选中的 AC 编号>，
// 并把 CCM_ACCEPT_RUN_DIR 设成 local/runs/<UTC 时间戳>/。手动跑时缺省落 local/runs/adhoc/。
// 产物（trace、截图、JSON 报告）只写进 local/（gitignore）：trace 里可能带着令牌，不能落在 git add 够得着的地方。
//
// 与 tests/infra/playwright.config.ts 的区别：
//   - 只认 *.accept.ts。重放脚本刻意不叫 .spec.ts，免得在仓库根裸跑 npx playwright test 时被默认规则收进去
//   - 没有 webServer：被测环境由 env/up.mjs 起在容器里，这里只连（地址见 fixtures.ts）
//   - workers 1：E1 mock 与 E2 server 都是单份有状态进程，并发会互相踩
import { defineConfig, devices } from '@playwright/test';
import { join } from 'node:path';

const runDir = process.env.CCM_ACCEPT_RUN_DIR || '../local/runs/adhoc';

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.accept.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  outputDir: join(runDir, 'artifacts'),
  reporter: [['list'], ['json', { outputFile: join(runDir, 'replay.json') }]],
  use: {
    headless: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      // 视口与触屏参数取 iPhone 13，浏览器用 chromium：本机只装了 chromium，webkit 也替代不了真 iOS Safari（那归 E 档真机）
      name: 'iphone-13-chromium',
      use: { ...devices['iPhone 13'], browserName: 'chromium' },
    },
  ],
});
