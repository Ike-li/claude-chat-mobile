// spec: specs/claude-chat-mobile-comprehensive-test-plan.md
// seed: tests/seed.goto-mock.spec.ts

import { test, expect, type Locator, type Page } from '@playwright/test';
import { expectNoBrowserErrors, gotoMock, sendChatMessage, waitForIdle } from '../seed.goto-mock.spec';

async function expectWithinViewport(page: Page, locator: Locator) {
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  const viewport = page.viewportSize();
  expect(box).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width + 1);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport!.height + 1);
}

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

  test('P0-19b 窄屏和横屏下权限审批 sheet 按钮可达', async ({ page }) => {
    await gotoMock(page);

    for (const viewport of [{ width: 320, height: 700 }, { width: 812, height: 375 }]) {
      await page.setViewportSize(viewport);
      await sendChatMessage(page, 'test:permission');
      await expect(page.locator('#permModal')).toBeVisible();

      await expectWithinViewport(page, page.locator('#permTool'));
      await expectWithinViewport(page, page.locator('#permDeny'));
      await expectWithinViewport(page, page.locator('#permAllow'));
      await expect(page.locator('#permInput')).toContainText('git push origin main');

      await page.locator('#permDeny').click();
      await expect(page.locator('#permModal')).toBeHidden();
      await waitForIdle(page);
    }

    await expectNoBrowserErrors(page);
  });

  test('P0-19c PWA manifest 图标与本地 shell 资源可加载', async ({ page }) => {
    await gotoMock(page);

    const manifestResponse = await page.request.get('/manifest.webmanifest');
    expect(manifestResponse.ok()).toBe(true);
    const manifest = await manifestResponse.json();
    expect(manifest.name).toBe('Claude Chat Mobile');
    expect(Array.isArray(manifest.icons)).toBe(true);

    for (const icon of manifest.icons) {
      const response = await page.request.get(icon.src);
      expect(response.ok()).toBe(true);
      expect(response.headers()['content-type']).toContain(icon.type);
    }

    const serviceWorker = await page.request.get('/js/sw.js');
    expect(serviceWorker.ok()).toBe(true);
    expect(serviceWorker.headers()['content-type']).toContain('javascript');

    await expectNoBrowserErrors(page);
  });
});
