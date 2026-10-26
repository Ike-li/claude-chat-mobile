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
