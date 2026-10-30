import { test, expect } from '@playwright/test';
import { ensureComposerReady, expectNoBrowserErrors, gotoMock, sendChatMessage } from '../../helpers/playwright';
import { MAIN_WORKSPACE, expandWorkspace, openSessionsSidebar, openWorkspaceSession, sessionButtonByTitle } from '../../helpers/sidebar-ui';

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

// 已开会话走 user:setViewing：session:switch 的聚焦收尾会清镜像锁，终端驾驶时点一下当前行就会先解锁
test('P0-473-SIDEBAR 侧栏点已开会话只切视图，点正在看的那行什么都不发', async ({ page }) => {
  const sent: string[] = [];
  page.on('websocket', ws => ws.on('framesent', frame => {
    const name = typeof frame.payload === 'string' && /^\d+\["(session:switch|user:setViewing)"/.exec(frame.payload)?.[1];
    if (name) sent.push(name);
  }));
  await gotoMock(page); await ensureComposerReady(page);
  await openSessionsSidebar(page); await expandWorkspace(page, MAIN_WORKSPACE);
  await openWorkspaceSession(page, MAIN_WORKSPACE, 'Archived Planning Session');
  await expect.poll(() => sent).toEqual(['session:switch']);
  await openSessionsSidebar(page); await expandWorkspace(page, MAIN_WORKSPACE);
  await expect(sessionButtonByTitle(page, 'Archived Planning Session').locator('xpath=ancestor::*[@data-testid="session-row"][1]')).not.toHaveAttribute('data-instance-id', '');
  await openWorkspaceSession(page, MAIN_WORKSPACE, 'Archived Planning Session');
  await openSessionsSidebar(page); await expandWorkspace(page, MAIN_WORKSPACE);
  await openWorkspaceSession(page, MAIN_WORKSPACE, 'Visual Sandbox (Main)');
  await expect.poll(() => sent).toEqual(['session:switch', 'user:setViewing']);
  await expectNoBrowserErrors(page);
});

// 外部模型只做展示：面板显示 external-model-473，续聊仍带网页自己在跑的模型，否则服务端会 setModel 切过去。
// 搬家命令在另一个会话里发：test:relocate-worktree 不收尾回合，在本会话发会让发送钮一直停在 stop。
test('P0-473-MODEL 搬家后续聊不把外部模型带进发送', async ({ page }) => {
  const sent: { text?: string; model?: string }[] = [];
  page.on('websocket', ws => ws.on('framesent', frame => {
    const m = typeof frame.payload === 'string' && /^\d+(\["user:message",.*)$/s.exec(frame.payload);
    if (m) sent.push(JSON.parse(m[1])[1]);
  }));
  const echoes = page.locator('#messages').getByText(/^设置回显：/);
  await gotoMock(page); await ensureComposerReady(page);
  await openSessionsSidebar(page); await expandWorkspace(page, MAIN_WORKSPACE);
  await openWorkspaceSession(page, MAIN_WORKSPACE, 'Worktree Driving Session');
  await expect(page.locator('#messages')).toContainText('WORKTREE_HISTORY_LOADED');
  await sendChatMessage(page, 'test:settings-echo');
  await expect(echoes).toHaveCount(1);
  await openSessionsSidebar(page); await expandWorkspace(page, MAIN_WORKSPACE);
  await openWorkspaceSession(page, MAIN_WORKSPACE, 'Visual Sandbox (Main)');
  await sendChatMessage(page, 'test:relocate-worktree');
  await openSessionsSidebar(page); await expandWorkspace(page, MAIN_WORKSPACE);
  await openWorkspaceSession(page, MAIN_WORKSPACE, 'Worktree Driving Session');
  await expect(page.locator('#pillModelText')).toContainText('external-model-473');
  await sendChatMessage(page, 'test:settings-echo');
  await expect.poll(() => sent.filter(p => p.text === 'test:settings-echo').length).toBe(2);
  const [before, after] = sent.filter(p => p.text === 'test:settings-echo');
  expect(before.model).toBeTruthy();
  expect(after.model).toBe(before.model);
  await expectNoBrowserErrors(page);
});
