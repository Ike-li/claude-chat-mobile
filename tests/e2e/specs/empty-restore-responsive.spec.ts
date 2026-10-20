// helpers: tests/helpers/playwright.ts

import { test, expect, type Locator, type Page } from '@playwright/test';
import { closeGeneralSettings, closeSettings, ensureComposerReady, expectNoBrowserErrors, gotoMock, openGeneralPage, openGeneralSettings, sendChatMessage, waitForIdle } from '../../helpers/playwright';

async function expectWithinViewport(page: Page, locator: Locator) {
  await expect(locator).toBeVisible();
  await expect.poll(async () => {
    const box = await locator.boundingBox();
    const viewport = page.viewportSize();
    return Boolean(
      box &&
      viewport &&
      box.x >= 0 &&
      box.y >= 0 &&
      box.x + box.width <= viewport.width + 1 &&
      box.y + box.height <= viewport.height + 1
    );
  }).toBe(true);
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
      await page.locator('#pillDefaults').click();
      await expect(page.locator('#settingsSheet')).not.toHaveClass(/translate-y-full/);
      await closeSettings(page);
      await page.locator('#btnSessions').click();
      await expect(page.locator('#leftSidebar')).not.toHaveClass(/-translate-x-full/);
      await page.locator('#sidebarClose').click();
    }
    const manifest = await page.request.get('/manifest.webmanifest');
    expect(manifest.ok()).toBe(true);

    await expectNoBrowserErrors(page);
  });

  // 验收 O76（AC-21-08）：手机宽度下顶栏「回首页」「会话日志」「新建会话」与抽屉按钮的可点范围只有 36×36，
  // 而输入区的按钮都扩到了 44 以上。每个按钮的可点范围要到 44×44（视觉不变），且相邻按钮的热区不能互相压住。
  test('P0-19e 手机顶栏按钮的可点范围到 44×44，且不压住相邻按钮', async ({ page }) => {
    await gotoMock(page);
    const ids = ['btnSessions', 'btnHome', 'btnConsole', 'btnNew'];
    const report = await page.evaluate((list) => list.map(id => {
      const btn = document.getElementById(id);
      if (!btn || btn.offsetParent === null) return { id, visible: false };
      const r = btn.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const hit = (x, y) => document.elementFromPoint(x, y)?.closest('button')?.id || null;
      return {
        id, visible: true,
        // 按钮边框外 3px（44 的热区比 36 的按钮每边多 4px）
        above: hit(cx, r.top - 3), below: hit(cx, r.bottom + 3),
        left: hit(r.left - 3, cy), right: hit(r.right + 3, cy),
      };
    }), ids);
    for (const r of report.filter(x => x.visible)) {
      expect(r.above, `${r.id} 上沿外 3px 点不到它`).toBe(r.id);
      expect(r.below, `${r.id} 下沿外 3px 点不到它`).toBe(r.id);
      expect([r.id, null], `${r.id} 左边外 3px 落到了别的按钮上`).toContain(r.left);
      expect([r.id, null], `${r.id} 右边外 3px 落到了别的按钮上`).toContain(r.right);
    }
    expect(report.filter(x => x.visible).length, '顶栏按钮一个都没找到').toBeGreaterThanOrEqual(3);
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

    // 站点根而非 /js/ 下：SW 的默认 scope 即脚本所在目录，只有根目录的脚本能控制整站（订阅流程依赖它）
    const serviceWorker = await page.request.get('/sw.js');
    expect(serviceWorker.ok()).toBe(true);
    expect(serviceWorker.headers()['content-type']).toContain('javascript');

    await expectNoBrowserErrors(page);
  });

  test('P0-19d 窄屏和横屏下 settings 与 console sheet 滚动后关键控件可达', async ({ page }) => {
    await gotoMock(page);
    await ensureComposerReady(page);

    for (const viewport of [{ width: 320, height: 700 }, { width: 812, height: 375 }]) {
      await page.setViewportSize(viewport);

      await page.locator('#pillDefaults').click();
      await expect(page.locator('#settingsSheet')).not.toHaveClass(/translate-y-full/);
      // 内容区内部滚动；标题栏固定在 sheet 顶部，背后主页面被 ccm-sheet-open 锁住
      await page.locator('#settingsSheetBody').evaluate(el => { el.scrollTop = el.scrollHeight; });
      await expectWithinViewport(page, page.locator('#settingsSheetTitle'));
      await expectWithinViewport(page, page.locator('#permSection'));
      await closeSettings(page);
      await expect(page.locator('#settingsSheet')).toHaveClass(/translate-y-full/);

      // 通用设置两级化后 L1 目录只有六行、滚不动；内容最长、底部控件最容易被顶出视口的是
      // 「通知」页（推送状态 + 四个开关 + 两个试一下按钮）。
      await openGeneralPage(page, 'notify');
      await page.locator('#generalSheetBody').evaluate(el => { el.scrollTop = el.scrollHeight; });
      await expectWithinViewport(page, page.locator('#generalSheetTitle'));
      await expectWithinViewport(page, page.locator('#btnPushTest'));
      await closeGeneralSettings(page);
      await expect(page.locator('#generalSheet')).toHaveClass(/translate-y-full/);

      await page.locator('#btnConsole').click();
      await expect(page.locator('#consoleModal')).toBeVisible();
      await page.locator('#consoleLogArea').evaluate(el => { el.scrollTop = el.scrollHeight; });
      await expectWithinViewport(page, page.locator('#consoleClose'));
      await expectWithinViewport(page, page.locator('#consoleClear'));
      await page.locator('#consoleClose').click();
      await expect(page.locator('#consoleModal')).toBeHidden();
    }

    await expectNoBrowserErrors(page);
  });
});
