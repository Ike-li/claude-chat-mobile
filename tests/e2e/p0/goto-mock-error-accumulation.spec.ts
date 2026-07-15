// Regression contract: docs/testing.md (Playwright test-infrastructure coverage).
// helpers: tests/helpers/playwright.ts
//
// TC-006 回归防护：captureBrowserErrors 曾经每次调用都重装监听器 + 把 page.__ccmErrors 指向新数组，
// 旧监听器仍写入旧数组、但该数组已不可达。permission-allow-deny 等多阶段 case 在同一 test 内二次调用
// gotoMock（allow 阶段 → fresh state → deny 阶段）时，第一阶段的 pageerror/console.error 就此漏检。

import { test, expect } from '@playwright/test';
import { expectNoBrowserErrors, gotoMock } from '../../helpers/playwright';

test.describe('P0 测试基建', () => {
  test('TC-006：同一 test 内二次 gotoMock 不丢失第一阶段浏览器错误', async ({ page }) => {
    await gotoMock(page);
    await page.evaluate(() => console.error('tc-006-phase1-marker'));

    // 第二次导航（模拟 permission-allow-deny 等 allow/deny 两阶段 case）。
    await gotoMock(page);

    await expect(expectNoBrowserErrors(page)).rejects.toThrow();
  });

  test('TC-006：无错误时二次 gotoMock 后 expectNoBrowserErrors 仍然通过', async ({ page }) => {
    await gotoMock(page);
    await gotoMock(page);

    await expectNoBrowserErrors(page);
  });
});
