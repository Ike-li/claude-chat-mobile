// helpers: tests/helpers/playwright.ts
// 顶部 pill → 工作区面板「改动」tab（git:status / git:diff mock）

import { test, expect } from '@playwright/test';
import { expectNoBrowserErrors, gotoMock } from '../../helpers/playwright';
import { openSessionsSidebar } from '../../helpers/p0-ui';

test.describe('P0 日常零 token Mock UI 回归', () => {
  test('P0-GIT-1 顶部 pill → 切「改动」tab → 列表与 diff', async ({ page }) => {
    await gotoMock(page);

    await page.locator('#topContextPill').click();
    await expect(page.locator('#workspaceModal')).toBeVisible();

    await page.locator('[data-testid="workspace-tab-changes"]').click();
    await expect(page.locator('#gitChangesBody')).toBeVisible();
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

    await page.locator('#workspaceClose').click();
    await expect(page.locator('#workspaceModal')).toBeHidden();

    await expectNoBrowserErrors(page);
  });

  test('P0-GIT-2 pill 直接落在「文件」tab，两个 tab 同屏可见且可互切', async ({ page }) => {
    await gotoMock(page);

    // 合并前这里要先过一层 chooser 二选一；现在点一次即到，且「改动」tab 同屏可见
    await page.locator('#topContextPill').click();
    await expect(page.locator('#workspaceModal')).toBeVisible();
    await expect(page.locator('#fileBrowseBody')).toBeVisible();
    await expect(page.locator('#fileBrowsePath')).not.toHaveText('');
    await expect(page.locator('[data-testid="workspace-tab-files"]')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('[data-testid="workspace-tab-changes"]')).toBeVisible();

    // 互切零成本：不必关面板重开
    await page.locator('[data-testid="workspace-tab-changes"]').click();
    await expect(page.locator('#gitChangesBody')).toBeVisible();
    await expect(page.locator('#fileBrowseBody')).toBeHidden();
    await expect(page.locator('[data-testid="workspace-tab-changes"]')).toHaveAttribute('aria-selected', 'true');

    await page.locator('[data-testid="workspace-tab-files"]').click();
    await expect(page.locator('#fileBrowseBody')).toBeVisible();
    await expect(page.locator('#gitChangesBody')).toBeHidden();

    await page.locator('#workspaceClose').click();
    await expect(page.locator('#workspaceModal')).toBeHidden();

    await openSessionsSidebar(page);
    await expect(page.locator('#sessionPanel button[title*="浏览项目文件"]')).toHaveCount(0);

    await expectNoBrowserErrors(page);
  });
});
