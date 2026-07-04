// spec: specs/claude-chat-mobile-comprehensive-test-plan.md
// seed: tests/seed.goto-mock.spec.ts

import { test, expect } from '@playwright/test';
import { expectNoBrowserErrors, gotoMock, sendChatMessage } from '../seed.goto-mock.spec';

test.describe('P0 日常零 token Mock UI 回归', () => {
  test('P0-13 跨 tab 审批弹窗清理与错路由防护', async ({ page }) => {
    await gotoMock(page);

    // 1. 当前 inst_1 出现权限弹窗，mock 自动切到 inst_2 后清除弹窗。
    await sendChatMessage(page, 'test:permCrossTab');
    await expect(page.locator('#permModal')).toBeVisible();
    await expect(page.locator('#permTool')).toHaveText('run_command');
    await expect(page.locator('#permModal')).toBeHidden({ timeout: 8_000 });

    // 2. 当前视图不保留 inst_1 的审批弹窗，不应可见地解决旧请求。
    await page.evaluate(() => document.getElementById('permAllow')?.click());
    await expect(page.locator('#permModal')).toBeHidden();
    await expect(page.locator('#pillPermText')).toContainText('计划模式');

    await expectNoBrowserErrors(page);
  });
});
