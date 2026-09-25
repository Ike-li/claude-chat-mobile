import { test, expect } from '@playwright/test';
import { gotoMock, sendChatMessage, waitForIdle } from '../../helpers/playwright';
import { MAIN_WORKSPACE, expandWorkspace, openSessionsSidebar, sessionRowByInstance, workspaceRow } from '../../helpers/sidebar-ui';

// 「已连接的文件夹」（2026-09-24）：抽屉按项目分组，照官方桌面端的侧栏——
//   · 已连接文件夹里有会话的子文件夹自成一节，紧跟所属文件夹，标题「根 › 相对路径」；
//   · 仓库外的平级 worktree 不自成一节，会话挂在所属仓库下（真机 1c401b5d 就是这种会话从抽屉里消失）；
//   · 「无文件夹」有会话时垫底一节。
const SUB = `${MAIN_WORKSPACE}/packages/web`;
const SCRATCH = '/Users/you/Library/Application Support/claude-chat-mobile/scratch-workspaces';
const subtreeOf = (page, cwd: string) => workspaceRow(page, cwd).locator('xpath=following-sibling::*[1]');

test.describe('P0 日常零 token Mock UI 回归', () => {
  test.beforeEach(async ({ page }) => {
    await gotoMock(page);
  });

  test('P0-PROJ-1 抽屉按项目分组：子文件夹紧跟所属文件夹、平级 worktree 随仓库、无文件夹垫底', async ({ page }) => {
    await sendChatMessage(page, 'test:projects');
    await waitForIdle(page);
    await openSessionsSidebar(page);

    const order = await page.locator('#sessionPanel div[data-dir]').evaluateAll(els => els.map(e => e.getAttribute('data-dir')));
    expect(order.indexOf(SUB), `小节顺序：${JSON.stringify(order)}`).toBe(order.indexOf(MAIN_WORKSPACE) + 1);
    expect(order.at(-1)).toBe(SCRATCH);
    await expect(workspaceRow(page, SUB)).toContainText('claude-chat-mobile › packages/web');
    await expect(workspaceRow(page, SCRATCH)).toContainText('无文件夹');

    // 平级 worktree 的会话挂在仓库那一节，不进「不在已连接的文件夹里」
    await expandWorkspace(page, MAIN_WORKSPACE);
    await expect(subtreeOf(page, MAIN_WORKSPACE).locator('[data-testid="session-row"][data-instance-id="inst_sib_owned"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="unowned-live-section"]')).toHaveCount(0);

    await expandWorkspace(page, SUB);
    await expect(subtreeOf(page, SUB).locator('[data-testid="session-row"][data-instance-id="inst_sub"]')).toHaveCount(1);
    await expect(sessionRowByInstance(page, 'inst_sub'), '子文件夹的会话不能在所属文件夹那一节再出现一次').toHaveCount(1);

    await expandWorkspace(page, SCRATCH);
    const scratchRow = subtreeOf(page, SCRATCH).locator('[data-testid="session-row"][data-instance-id="inst_scratch"]');
    await expect(scratchRow).toHaveCount(1);
    await scratchRow.locator('button').first().click();
    await expect(page.locator('#topProjectText'), '顶栏写成 scratch 目录名，用户根本认不出这是哪').toHaveText('无文件夹');
  });

  test('P0-PROJ-2 删除「无文件夹」会话：确认框说清临时目录会一并删除，删完这一行不再出现', async ({ page }) => {
    await sendChatMessage(page, 'test:projects');
    await waitForIdle(page);
    await openSessionsSidebar(page);
    await expandWorkspace(page, SCRATCH);
    const row = subtreeOf(page, SCRATCH).locator('[data-testid="session-row"]', { hasText: '以前的无文件夹会话' });
    await expect(row).toHaveCount(1);
    await row.locator('[data-testid="session-delete"]').click();
    await expect(page.locator('#confirmBody'), '不说一声就把模型写在临时目录里的文件一起删了').toContainText('临时目录和里面的文件会一并删除');
    await page.locator('#confirmOk').click();
    await expect(subtreeOf(page, SCRATCH).locator('[data-testid="session-row"]', { hasText: '以前的无文件夹会话' })).toHaveCount(0);
    await expect(page.locator('#messages')).toContainText('临时目录已一并删除');
  });
});
