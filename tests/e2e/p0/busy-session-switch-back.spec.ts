// spec: docs/testing.md
// helpers: tests/helpers/playwright.ts

import { test, expect } from '@playwright/test';
import { ensureComposerReady, expectNoBrowserErrors, gotoMock, sendChatMessage, waitForIdle } from '../../helpers/playwright';
import { ANOTHER_WORKSPACE, openSessionsSidebar, openWorkspaceSession } from '../../helpers/p0-ui';

test.describe('P0 切回运行中会话恢复运行指示', () => {
  // 回归：会话在后端在跑但正处静默窗口（无 delta/result），切走再切回后运行条应重新出现。
  // 缺陷路径：bindView 入场按 state='busy' seed 运行条 → 随后 sync:since 判 reload → clearView 抹掉、不重种。
  test('P0-BR1 切回 busy 静默窗口会话后重新显示运行条', async ({ page }) => {
    await gotoMock(page);
    await ensureComposerReady(page);

    // inst_2 置 busy 静默窗口；当前视图 inst_1 收尾以便 waitForIdle。
    await sendChatMessage(page, 'test:busy-silent-switch');
    await waitForIdle(page);
    await expect(page.locator('#streamLiveStatus')).toHaveCount(0);

    // 切到后端在跑的 inst_2（sync 只回放 user_message → 命中 reload 分支）。
    await openSessionsSidebar(page);
    await openWorkspaceSession(page, ANOTHER_WORKSPACE, 'Another App Concurrency');

    // 先等 reload 的 loadHistory 渲染出历史消息，确保断言发生在 reload 之后（越过入场 seed 的瞬现窗口）。
    await expect(page.locator('[data-testid="assistant-message"]').last())
      .toContainText('Another App Concurrency', { timeout: 10_000 });

    // 修复点：reload 清屏后按 server 权威 state='busy' 重种运行条（未修则此处已被抹掉、断言必红）。
    await expect(page.locator('#streamLiveStatus')).toBeVisible();
    await expect(page.locator('#btnSend')).toHaveAttribute('data-mode', 'stop');

    await expectNoBrowserErrors(page);
  });
});
