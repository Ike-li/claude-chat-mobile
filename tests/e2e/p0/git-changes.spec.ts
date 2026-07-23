// helpers: tests/helpers/playwright.ts
// 顶部 pill → chooser → 工作区改动面板（git:status / git:diff mock）

import { test, expect } from '@playwright/test';
import { expectNoBrowserErrors, gotoMock } from '../../helpers/playwright';
import { openSessionsSidebar } from '../../helpers/p0-ui';

test.describe('P0 日常零 token Mock UI 回归', () => {
  test('P0-GIT-1 顶部 pill 打开 chooser → 工作区改动 → 列表与 diff', async ({ page }) => {
    await gotoMock(page);

    await page.locator('#topContextPill').click();
    await expect(page.locator('#workspaceChooserModal')).toBeVisible();

    await page.locator('[data-testid="workspace-chooser-changes"]').click();
    await expect(page.locator('#gitChangesModal')).toBeVisible();
    await expect(page.locator('#gitChangesBranch')).toContainText('dev');

    const body = page.locator('#gitChangesBody');
    await expect(body).toContainText('已暂存');
    await expect(body).toContainText('staged.js');
    await expect(body).toContainText('未暂存');
    await expect(body).toContainText('work.js');
    await expect(body).toContainText('未跟踪');
    await expect(body).toContainText('new-file.js');

    // 点未暂存文件 → 懒加载 diff 红绿行
    await page.locator('[data-testid="git-change-row"]', { hasText: 'work.js' }).locator('button').first().click();
    const preview = page.locator('[data-testid="git-change-preview"]').filter({ hasText: 'new line' });
    await expect(preview).toBeVisible();
    await expect(preview).toContainText('-old line');
    await expect(preview).toContainText('+new line');

    await page.locator('#gitChangesClose').click();
    await expect(page.locator('#gitChangesModal')).toBeHidden();

    await expectNoBrowserErrors(page);
  });

  test('P0-GIT-2 chooser 浏览文件仍打开 fileBrowseModal', async ({ page }) => {
    await gotoMock(page);

    await page.locator('#topContextPill').click();
    await page.locator('[data-testid="workspace-chooser-browse"]').click();
    await expect(page.locator('#fileBrowseModal')).toBeVisible();
    await expect(page.locator('#fileBrowsePath')).not.toHaveText('');

    await page.locator('#fileBrowseClose').click();
    await expect(page.locator('#fileBrowseModal')).toBeHidden();

    await openSessionsSidebar(page);
    await expect(page.locator('#sessionPanel button[title*="浏览项目文件"]')).toHaveCount(0);

    await expectNoBrowserErrors(page);
  });
});
