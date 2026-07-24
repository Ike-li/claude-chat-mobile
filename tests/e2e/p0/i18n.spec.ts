// spec: docs/testing.md
// helpers: tests/helpers/playwright.ts

import { test, expect } from '@playwright/test';
import { ensureComposerReady, expectNoBrowserErrors, gotoMock } from '../../helpers/playwright';

// ⑨ i18n 阶段 1：zh 原文即词典 key 的运行时 t()，en locale 静默回落中文未收录串。本 spec 是唯一跑 en 的
// 冒烟用例，其余 P0 spec 全部保持 zh 断言不变（见 public/js/i18n.js 头注 + scripts/i18n-check.js 孤儿扫描）。
test.describe('P0 日常零 token Mock UI 回归', () => {
  test('P0-I18N en 冒烟：语言偏好设为 en 后静态串与 placeholder 切换为英文', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('ccm_lang', 'en'));
    await gotoMock(page);
    await ensureComposerReady(page);

    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.locator('#input')).toHaveAttribute('placeholder', 'Message Claude...');

    await page.locator('#btnSettings').click();
    await expect(page.locator('#settingsSheet')).not.toHaveClass(/translate-y-full/);
    await expect(page.locator('#settingsSheet')).toContainText('Select model');
    await expect(page.locator('#settingsSheet')).toContainText('Sound');

    await expectNoBrowserErrors(page);
  });
});
