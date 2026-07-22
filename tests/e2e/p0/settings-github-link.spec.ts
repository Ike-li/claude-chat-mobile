// spec: 设置面板「访问与设备」分组的 GitHub 仓库外链（纯静态 <a>，无 app.js 接线）。
// helpers: tests/helpers/playwright.ts

import { test, expect } from '@playwright/test';
import { gotoMock, expectNoBrowserErrors } from '../../helpers/playwright';

test.describe('P0 日常零 token Mock UI 回归', () => {
  test('P0-23 设置面板：GitHub 仓库入口指向正确地址且新标签页打开', async ({ page }) => {
    await gotoMock(page);

    await page.locator('#btnSettings').click();
    await expect(page.locator('#settingsSheet')).not.toHaveClass(/translate-y-full/);

    const link = page.locator('#linkGithub');
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('href', 'https://github.com/Ike-li/claude-chat-mobile');
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');

    await expectNoBrowserErrors(page);
  });
});
