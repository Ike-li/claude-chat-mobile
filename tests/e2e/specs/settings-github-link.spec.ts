// spec: GitHub 仓库外链的两个入口——设置「帮助」页里的一条，和侧栏标题行常驻的图标（都是纯静态 <a>，无 app.js 接线）。
// helpers: tests/helpers/playwright.ts

import { test, expect } from '@playwright/test';
import { expectNoBrowserErrors, gotoMock, openGeneralPage } from '../../helpers/playwright';

test.describe('P0 日常零 token Mock UI 回归', () => {
  test('P0-23 设置面板：GitHub 仓库入口指向正确地址且新标签页打开', async ({ page }) => {
    await gotoMock(page);

    await openGeneralPage(page, 'help');

    const link = page.locator('#linkGithub');
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('href', 'https://github.com/Ike-li/claude-chat-mobile');
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');

    await expectNoBrowserErrors(page);
  });

  test('P0-23b 侧栏标题行：GitHub 仓库入口打开侧栏即可见，指向同一地址且新标签页打开', async ({ page }) => {
    await gotoMock(page);

    await page.locator('#btnSessions').click();
    await expect(page.locator('#leftSidebar')).not.toHaveClass(/-translate-x-full/);

    // 不进任何二层页面就要看得到：P0-23 那条藏在「设置与状态 → 帮助」里，要点三下才到
    const link = page.locator('#leftSidebar #drawerGithubLink');
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('href', 'https://github.com/Ike-li/claude-chat-mobile');
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    // 只有图标没有文字，读屏器全靠 aria-label；中英文两份译文都含 GitHub
    await expect(link).toHaveAccessibleName(/GitHub/);

    await expectNoBrowserErrors(page);
  });
});
