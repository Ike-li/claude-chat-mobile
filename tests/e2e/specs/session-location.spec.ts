import { test, expect } from '@playwright/test';
import { ensureComposerReady, expectNoBrowserErrors, gotoMock, sendChatMessage } from '../../helpers/playwright';
import { MAIN_WORKSPACE, expandWorkspace, openSessionsSidebar, openWorkspaceSession } from '../../helpers/sidebar-ui';

test('P0-473 外部搬家：同一实例刷新历史，代码面板跟目标 worktree，保留 ID', async ({ page }) => {
  await gotoMock(page);
  await ensureComposerReady(page);
  await openSessionsSidebar(page);
  await expandWorkspace(page, MAIN_WORKSPACE);
  await openWorkspaceSession(page, MAIN_WORKSPACE, 'Worktree Driving Session');
  await expect(page.locator('#messages')).toContainText('WORKTREE_HISTORY_LOADED');
  const sessionText = await page.locator('#pillSession').textContent();
  await sendChatMessage(page, 'test:relocate-worktree');
  await expect(page.locator('#messages')).toContainText('RELOCATED_WORKTREE_HISTORY');
  await expect(page.locator('#messages')).not.toContainText('历史消息加载失败');
  await expect(page.locator('#pillSession')).toHaveText(sessionText || '');
  await expect(page.locator('#pillEffortText')).toContainText('未知');
  await expect(page.locator('#pillModelText')).toContainText('external-model-473');
  await page.locator('#topContextPill').click();
  await expect(page.locator('#fileBrowsePath')).toContainText('wt-relocated');
  await page.locator('#workspaceClose').click();
  await openSessionsSidebar(page);
  await expandWorkspace(page, MAIN_WORKSPACE);
  await openWorkspaceSession(page, MAIN_WORKSPACE, 'Worktree Driving Session');
  await expect(page.locator('#messages')).toContainText('RELOCATED_WORKTREE_HISTORY');
  await expectNoBrowserErrors(page);
});

test('P0-473-LATE 点击已缓存会话时搬家，旧同步回执不得清掉新目录历史', async ({ page }) => {
  await gotoMock(page); await ensureComposerReady(page);
  await openSessionsSidebar(page); await expandWorkspace(page, MAIN_WORKSPACE);
  await openWorkspaceSession(page, MAIN_WORKSPACE, 'Worktree Driving Session');
  await expect(page.locator('#messages')).toContainText('WORKTREE_HISTORY_LOADED');
  await sendChatMessage(page, 'test:relocate-during-sync');
  await openSessionsSidebar(page); await expandWorkspace(page, MAIN_WORKSPACE);
  await openWorkspaceSession(page, MAIN_WORKSPACE, 'Visual Sandbox (Main)');
  await openSessionsSidebar(page); await expandWorkspace(page, MAIN_WORKSPACE);
  await openWorkspaceSession(page, MAIN_WORKSPACE, 'Worktree Driving Session');
  await expect(page.locator('#messages')).toContainText('RELOCATED_WORKTREE_HISTORY');
  await expect(page.locator('#messages')).not.toContainText('历史消息加载失败');
  await expectNoBrowserErrors(page);
});
