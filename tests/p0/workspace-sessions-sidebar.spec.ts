// spec: specs/claude-chat-mobile-comprehensive-test-plan.md
// seed: tests/seed.goto-mock.spec.ts

import { test, expect } from '@playwright/test';
import { expectNoBrowserErrors, gotoMock, sendChatMessage, waitForIdle } from '../seed.goto-mock.spec';

test.describe('P0 日常零 token Mock UI 回归', () => {
  test('P0-11 多工作区、多会话 tab、sidebar 与 history replay', async ({ page }) => {
    await gotoMock(page);

    // 1. 发送 test:tab 后出现第二个工作区/会话实例。
    await sendChatMessage(page, 'test:tab');
    await waitForIdle(page);
    await page.locator('#btnSessions').click();
    await expect(page.locator('#leftSidebar')).not.toHaveClass(/-translate-x-full/);
    await expect(page.locator('#sessionPanel')).toContainText('claude-chat-mobile');
    await expect(page.locator('#sessionPanel')).toContainText('another-react-project');

    // 2. 展开第二工作区并切换到 live 会话，验证 history replay。
    await page.locator('div[data-dir="/Users/you/code/another-react-project"] button').first().click();
    await expect(page.locator('button[title="Another App Concurrency"]')).toBeVisible();
    await page.locator('button[title="Another App Concurrency"]').click();
    await expect(page.locator('#leftSidebar')).toHaveClass(/-translate-x-full/);
    await expect(page.locator('[data-testid="assistant-message"]').last()).toContainText('Another App Concurrency', { timeout: 10_000 });
    await expect(page.locator('#pillPermText')).toContainText('计划模式');

    await expectNoBrowserErrors(page);
  });
});
