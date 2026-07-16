import { expect, type Page } from '@playwright/test';

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

export async function expectSessionBadge(page: Page, instanceId: string, text: string, title?: string) {
  const badge = sessionRowByInstance(page, instanceId).locator('[data-instance-badge]');
  await expect(badge).toHaveText(text);
  if (title) await expect(badge).toHaveAttribute('title', title);
}
