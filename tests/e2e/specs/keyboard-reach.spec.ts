// helpers: tests/helpers/playwright.ts

import { test, expect } from '@playwright/test';
import { ensureComposerReady, expectNoBrowserErrors, gotoMock } from '../../helpers/playwright';

// 验收 O11 / O13（AC-21-06、AC-21-07）：首页「最近会话」的行和模型磁贴原来都是带点击处理的 div，
// 没有 role、没有 tabindex——键盘走不到、按键点不动，读屏不认得是控件。通往模型磁贴的唯一入口——底栏
// 「会话设置」chip——也是 div，只改磁贴的话键盘用户连面板都打不开。权限六档早先已改成原生 button
// 加 aria-pressed（见 app.js rebuildPermissionModeUi 的注释），这三处照做。
// 断言只走键盘：聚焦后按键，看用户可见的结果（进了那个会话 / 选中了那个模型）。div 上 focus() 不生效，
// 按键落到别处，实现前会红在结果上。
test.describe('键盘可达：首页最近会话与模型磁贴', () => {
  test('P0-A11Y-KEY-1 首页最近会话行是按钮：键盘聚焦后按 Enter 进入该会话', async ({ page }) => {
    await gotoMock(page);
    await page.locator('#btnHome').click();
    await expect(page.locator('[data-testid="home-dashboard"]')).toBeVisible({ timeout: 5_000 });

    const row = page.locator('#dashRecentsList').getByRole('button', { name: /Archived Planning Session/ });
    await expect(row).toBeVisible();
    // 换成 button 后外观不变：仍占满整行（button 默认按内容收缩）
    const [rowBox, listBox] = await Promise.all([row.boundingBox(), page.locator('#dashRecentsList').boundingBox()]);
    expect(Math.round(rowBox?.width ?? 0)).toBe(Math.round(listBox?.width ?? -1));
    await row.focus();
    await expect(row).toBeFocused();
    await page.keyboard.press('Enter');

    await expect(page.locator('[data-testid="home-dashboard"]')).toHaveCount(0, { timeout: 5_000 });
    await expect(page.locator('#messages')).toContainText('Archived plan replay from session history.');
    await expectNoBrowserErrors(page);
  });

  test('P0-A11Y-KEY-2 全程键盘：Enter 打开会话设置，模型磁贴是带 aria-pressed 的按钮，空格选中', async ({ page }) => {
    await gotoMock(page);
    await ensureComposerReady(page);
    const chip = page.locator('#composerChips').getByRole('button', { name: /Manual/ });
    await expect(chip).toBeVisible();
    await chip.focus();
    await expect(chip).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('#settingsSheet')).not.toHaveClass(/translate-y-full/);

    const grid = page.locator('#customModelGrid');
    // 当前在用的那张（mock 实例的模型是 Claude 3.5 Sonnet）：读屏也要能知道当前是哪张
    const current = grid.locator('.model-tile[aria-pressed="true"]');
    await expect(current).toHaveCount(1);
    await expect(current).toContainText('Claude 3.5 Sonnet');
    const haiku = grid.getByRole('button', { name: /Claude 3\.5 Haiku/ });
    await expect(haiku).toHaveAttribute('aria-pressed', 'false');
    const haikuValue = await haiku.getAttribute('data-model');

    await haiku.focus();
    await expect(haiku).toBeFocused();
    await page.keyboard.press(' ');

    await expect(page.locator('#modelInput')).toHaveValue(haikuValue ?? '');
    await expect(haiku).toHaveAttribute('aria-pressed', 'true');
    await expect(current).toHaveCount(1);
    await expect(current).toContainText('Claude 3.5 Haiku');
    await expectNoBrowserErrors(page);
  });
});
