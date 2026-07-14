import { expect, type Page } from '@playwright/test';

type BrowserErrorCaptureOptions = {
  ignoredResourceStatusCodes?: number[];
};

export function captureBrowserErrors(page: Page, options: BrowserErrorCaptureOptions = {}) {
  // TC-006：同一 page 在一个 test 内可能被 gotoMock 多次导航（如 permission-allow-deny 的 allow/deny
  // 两阶段）。若每次都重装监听器 + 把 __ccmErrors 指向新数组，旧监听器仍会写入旧数组、但该数组已不可达，
  // 第一阶段的 pageerror/console.error 就此永久漏检。改为每个 page 只装一次监听器、后续调用直接复用同一
  // 数组引用，跨导航累积、只在 expectNoBrowserErrors 断言时读取全量。
  const target = page as Page & { __ccmErrors?: string[]; __ccmErrorsInstalled?: boolean };
  if (target.__ccmErrorsInstalled) return;
  target.__ccmErrorsInstalled = true;

  const errors: string[] = [];
  target.__ccmErrors = errors;
  const ignoredResourceStatusCodes = new Set([404, ...(options.ignoredResourceStatusCodes || [])]);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    const text = message.text();
    if (text.includes('Blocked call to navigator.vibrate')) return;
    const resourceStatus = text.match(/Failed to load resource: the server responded with a status of (\d+)/);
    if (resourceStatus && ignoredResourceStatusCodes.has(Number(resourceStatus[1]))) return;
    if (message.type() === 'error') errors.push(text);
  });
}

export async function gotoMock(page: Page) {
  captureBrowserErrors(page);
  await page.request.post('/__reset');
  await page.goto('/');
  await expect(page.locator('#input')).toBeVisible();
  await expect(page.locator('#btnSend')).toBeVisible();
  await expect(page.locator('#connDot')).toHaveClass(/bg-success/, { timeout: 10_000 });
}

export async function sendChatMessage(page: Page, text: string) {
  const input = page.locator('#input');
  await input.fill(text);
  await expect(page.locator('#btnSend')).toBeEnabled();
  await page.locator('#btnSend').click();
}

export async function waitForIdle(page: Page) {
  await expect(page.locator('#activeStatusPill')).toBeHidden({ timeout: 20_000 });
}

export async function expectNoBrowserErrors(page: Page) {
  const errors = (page as Page & { __ccmErrors?: string[] }).__ccmErrors || [];
  expect(errors).toEqual([]);
}
