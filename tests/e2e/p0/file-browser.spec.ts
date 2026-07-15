// helpers: tests/helpers/playwright.ts

import { test, expect } from '@playwright/test';
import { expectNoBrowserErrors, gotoMock } from '../../helpers/playwright';
import { expectSidebarClosed, openSessionsSidebar } from '../../helpers/p0-ui';

test.describe('P0 日常零 token Mock UI 回归', () => {
  test('P0-21 顶部工作区入口打开文件浏览且侧栏不重复提供入口', async ({ page }) => {
    await gotoMock(page);

    await page.locator('#topContextPill').click();
    await expect(page.locator('#fileBrowseModal')).toBeVisible();
    await expect(page.locator('#fileBrowsePath')).not.toHaveText('');
    await expectSidebarClosed(page);

    await page.locator('#fileBrowseClose').click();
    await expect(page.locator('#fileBrowseModal')).toBeHidden();

    await openSessionsSidebar(page);
    await expect(page.locator('#sessionPanel button[title*="浏览项目文件"]')).toHaveCount(0);

    await expectNoBrowserErrors(page);
  });
});
