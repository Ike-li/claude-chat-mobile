// helpers: tests/helpers/playwright.ts
// 顶部 pill → 工作区面板「改动」tab（git:status / git:diff mock）

import { test, expect } from '@playwright/test';
import { expectNoBrowserErrors, gotoMock } from '../../helpers/playwright';
import { openSessionsSidebar } from '../../helpers/sidebar-ui';

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

  // 新会话页（点 ＋ 后的 session 懒创建窗口）：session 还没有，工作区已经有了。
  // 这两个 tab 背后的 git:status / files:browse 都只要 cwd（socket-files.js 两个 handler 不碰 sessionId），
  // 所以它们在这里必须照常可用——此前整个 pill 跟着「没有 session」一起被隐藏，等于开工前最该看的
  // git status 恰恰看不到，而同一张页面早就在读同一个仓库的 git（worktree 源分支选择器走 git:branches）。
  test('P0-GIT-3 compose 新会话页：pill 可点，文件与改动两个 tab 都能用', async ({ page }) => {
    await gotoMock(page);

    await page.locator('#btnNew').click();
    await expect(page.locator('[data-testid="compose-surface"]')).toBeVisible();
    // 前提确认：确实停在「还没有 session」的那一格——否则下面测的就是普通会话页，白测
    await expect(page.locator('#messages')).toHaveClass(/empty-start/);

    await page.locator('#topContextPill').click();
    await expect(page.locator('#workspaceModal')).toBeVisible();
    await expect(page.locator('#fileBrowseBody')).toBeVisible();
    await expect(page.locator('#fileBrowsePath')).not.toHaveText('');

    await page.locator('[data-testid="workspace-tab-changes"]').click();
    await expect(page.locator('#gitChangesBody')).toBeVisible();
    await expect(page.locator('#gitChangesBranch')).toContainText('dev');
    await expect(page.locator('#gitChangesBody')).toContainText('work.js');

    await expectNoBrowserErrors(page);
  });
});
