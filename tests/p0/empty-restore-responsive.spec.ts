// spec: specs/claude-chat-mobile-comprehensive-test-plan.md
// seed: tests/seed.goto-mock.spec.ts

import { test, expect } from '@playwright/test';
import { expectNoBrowserErrors, gotoMock, sendChatMessage, waitForIdle } from '../seed.goto-mock.spec';

test.describe('P0 日常零 token Mock UI 回归', () => {
  test('P0-19 空状态、恢复与移动端响应式/PWA 外壳', async ({ page }) => {
    await gotoMock(page);

    // 1. 发送 test:empty 后进入空窗口路径，仍可恢复。
    await sendChatMessage(page, 'test:empty');
    await expect(page.locator('#messages')).toContainText('Empty start screen activated');
    await expect(page.locator('#btnSessions')).toBeVisible();
    await sendChatMessage(page, 'test:restore');
    await waitForIdle(page);
    await expect(page.locator('#messages')).not.toHaveClass(/empty-start/);
    await expect(page.locator('#topProjectText')).toContainText('claude-chat-mobile');

    // 2. 移动端窄屏与横屏下核心抽屉/面板不溢出，PWA manifest 可加载。
    for (const viewport of [{ width: 320, height: 700 }, { width: 812, height: 375 }]) {
      await page.setViewportSize(viewport);
      await expect(page.locator('#input')).toBeVisible();
      await page.locator('#btnSettings').click();
      await expect(page.locator('#settingsSheet')).not.toHaveClass(/translate-y-full/);
      await page.locator('#settingsClose').click();
      await page.locator('#btnSessions').click();
      await expect(page.locator('#leftSidebar')).not.toHaveClass(/-translate-x-full/);
      await page.locator('#sidebarClose').click();
    }
    const manifest = await page.request.get('/manifest.webmanifest');
    expect(manifest.ok()).toBe(true);

    await expectNoBrowserErrors(page);
  });
});
