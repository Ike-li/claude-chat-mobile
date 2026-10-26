import { expect, type Locator, type Page } from '@playwright/test';

export const MAIN_WORKSPACE = '/Users/you/code/claude-chat-mobile';
export const ANOTHER_WORKSPACE = '/Users/you/code/another-react-project';

function cssAttr(value: string) {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export async function openSessionsSidebar(page: Page) {
  await page.locator('#btnSessions').click();
  await expectSidebarOpen(page);
}

export async function expectSidebarOpen(page: Page) {
  await expect(page.locator('#leftSidebar')).not.toHaveClass(/-translate-x-full/);
}

export async function expectSidebarClosed(page: Page) {
  await expect(page.locator('#leftSidebar')).toHaveClass(/-translate-x-full/);
}

export function workspaceRow(page: Page, cwd: string) {
  return page.locator(`#sessionPanel div[data-dir="${cssAttr(cwd)}"]`);
}

export async function expandWorkspace(page: Page, cwd: string) {
  const row = workspaceRow(page, cwd);
  // UX-007：当前工作区默认展开；幂等展开，已展开则不点（否则 toggle 会折叠）
  const subtree = row.locator('xpath=following-sibling::*[1]');
  const alreadyOpen = await subtree.evaluate((el) => el.classList.contains('expanded')).catch(() => false);
  if (!alreadyOpen) {
    await row.locator('button').first().click();
  }
  return row;
}

export function workspaceSubtree(page: Page, cwd: string) {
  return workspaceRow(page, cwd).locator('xpath=following-sibling::*[1]');
}

// 点 times 次「显示更多」，每次等新的一档真画出来（行数变多）再点下一次——按钮点下去先变「加载中…」，
// 连点会点在被禁用的旧按钮上。
export async function showMoreSessions(page: Page, cwd: string, times = 1) {
  const subtree = workspaceSubtree(page, cwd);
  const rows = subtree.locator('[data-testid="session-row"]');
  for (let i = 0; i < times; i += 1) {
    const before = await rows.count();
    await subtree.getByTestId('session-show-more').click();
    await expect.poll(() => rows.count()).toBeGreaterThan(before);
  }
}

export function sessionButtonByTitle(page: Page, title: string) {
  return page.locator(`button[title="${cssAttr(title)}"]`);
}

export async function openSessionByTitle(page: Page, title: string) {
  const button = sessionButtonByTitle(page, title);
  await expect(button).toBeVisible();
  await button.click();
}

export async function openWorkspaceSession(page: Page, cwd: string, title: string) {
  await expandWorkspace(page, cwd);
  await openSessionByTitle(page, title);
}

export async function startNewSessionInWorkspace(page: Page, cwd: string) {
  await workspaceRow(page, cwd).locator('button[title="\u5728\u6b64\u5de5\u4f5c\u533a\u65b0\u5efa\u4f1a\u8bdd"]').click();
}

export function sessionRowByInstance(page: Page, instanceId: string) {
  return page.locator(`[data-testid="session-row"][data-instance-id="${cssAttr(instanceId)}"]`);
}

// 会话行只有一个入口：行尾「⋯」打开底部菜单（#sessionMenuModal），关闭 / 删除 / 标已读未读都在里面
export function sessionMenuItem(page: Page, action: 'toggle-read' | 'close' | 'delete') {
  return page.locator(`#sessionMenuModal [data-menu-action="${action}"]`);
}

export async function openSessionMenu(page: Page, row: Locator) {
  await row.getByTestId('session-menu').click();
  await expect(page.locator('#sessionMenuModal')).toHaveClass(/sheet-open/);
}

export async function chooseSessionMenuItem(page: Page, row: Locator, action: 'toggle-read' | 'close' | 'delete') {
  await openSessionMenu(page, row);
  await sessionMenuItem(page, action).click();
}

// 文件夹行的「⋯」与会话行共用同一个菜单 sheet（#sessionMenuModal）
export function folderMenuItem(page: Page, action: 'mark-all-read' | 'disconnect') {
  return page.locator(`#sessionMenuModal [data-menu-action="${action}"]`);
}

export async function openFolderMenu(page: Page, cwd: string) {
  await workspaceRow(page, cwd).getByTestId('dir-menu').click();
  await expect(page.locator('#sessionMenuModal')).toHaveClass(/sheet-open/);
}

export async function chooseFolderMenuItem(page: Page, cwd: string, action: 'mark-all-read' | 'disconnect') {
  await openFolderMenu(page, cwd);
  await folderMenuItem(page, action).click();
}

// 长按文件夹行拖到另一行的上半 / 下半再松手（鼠标；触屏见 drawer-folder-actions 的 CDP 用例）。
// 抽屉刚打开时还在滑入：先等行稳定（trial 只做可操作性检查）再量坐标，否则按下去落在行外。
// 拖起来之后各节的展开区收起，行跟着手指的【位移】走（folder-drag.js）：在拖起来之后量被拖的行与目标行，
// 手指挪「目标位置 - 被拖行中线」那么多。
export async function dragFolderWithMouse(page: Page, cwd: string, targetCwd: string, edge: 'above' | 'below') {
  const handle = workspaceRow(page, cwd).locator('button').first();
  await handle.hover({ trial: true });
  const from = await handle.boundingBox();
  if (!from) throw new Error(`${cwd} 的文件夹行不可见`);
  const x = from.x + 24;
  const y = from.y + from.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await expect(page.locator('#sessionPanel'), '长按没拖起来').toHaveClass(/folder-dragging/);
  await page.mouse.move(x, y + await folderDragDelta(page, cwd, targetCwd, edge), { steps: 6 });
  await page.mouse.up();
  await expect(page.locator('#sessionPanel')).not.toHaveClass(/folder-dragging/);
}

// 拖起来之后，手指要挪多少才能让被拖的行中线落到目标行的上沿 / 下沿附近
export async function folderDragDelta(page: Page, cwd: string, targetCwd: string, edge: 'above' | 'below') {
  const lifted = await workspaceRow(page, cwd).boundingBox();
  const to = await workspaceRow(page, targetCwd).boundingBox();
  if (!lifted || !to) throw new Error('拖起来之后文件夹行不可见');
  return (edge === 'above' ? to.y + 3 : to.y + to.height - 3) - (lifted.y + lifted.height / 2);
}

export function sessionStatusChipByInstance(page: Page, instanceId: string) {
  return sessionRowByInstance(page, instanceId).locator('[data-session-status]');
}

export async function expectSessionStatusChip(page: Page, instanceId: string, text: string) {
  const chip = sessionStatusChipByInstance(page, instanceId);
  await expect(chip).toBeVisible();
  await expect(chip).toHaveText(text);
  await expect(chip).toHaveAttribute('aria-label', text);
}

export async function expectNoSessionStatusChip(page: Page, instanceId: string) {
  await expect(sessionStatusChipByInstance(page, instanceId)).toHaveCount(0);
}
