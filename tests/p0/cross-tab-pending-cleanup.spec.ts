// spec: specs/claude-chat-mobile-comprehensive-test-plan.md
// seed: tests/seed.goto-mock.spec.ts

import { test, expect } from '@playwright/test';
import { expectNoBrowserErrors, gotoMock, sendChatMessage, waitForIdle } from '../seed.goto-mock.spec';

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

  test('P0-13b 切回后台待审批实例后才显示并处理审批', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:permCrossTab');
    await expect(page.locator('#permModal')).toBeVisible();
    await expect(page.locator('#permTool')).toHaveText('run_command');
    await expect(page.locator('#permModal')).toBeHidden({ timeout: 8_000 });
    await expect(page.locator('#pillPermText')).toContainText('计划模式');

    await page.locator('#btnSessions').click();
    await expect(page.locator('#leftSidebar')).not.toHaveClass(/-translate-x-full/);
    await page.locator('div[data-dir="/Users/you/code/claude-chat-mobile"] button').first().click();
    await expect(page.locator('button[title="Visual Sandbox (Main)"]')).toBeVisible();
    await page.locator('button[title="Visual Sandbox (Main)"]').click();

    await expect(page.locator('#leftSidebar')).toHaveClass(/-translate-x-full/);
    await expect(page.locator('#pillPermText')).toContainText('默认审批');
    await expect(page.locator('#permModal')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#permCwd')).toContainText('/Users/you/code/claude-chat-mobile');
    await expect(page.locator('#permInput')).toContainText('git push origin main');

    await page.locator('#permDeny').click();
    await expect(page.locator('#permModal')).toBeHidden();
    await waitForIdle(page);
    await expect(page.locator('#pillPermText')).toContainText('默认审批');

    await expectNoBrowserErrors(page);
  });
});
