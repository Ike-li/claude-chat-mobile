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
  // 空首页枢纽默认隐藏底部输入条；就绪信号改为顶栏 + 连接点。
  await expect(page.locator('#btnNew')).toBeVisible();
  await expect(page.locator('#btnSessions')).toBeVisible();
  await expect(page.locator('#messages')).toBeVisible();
  await expect(page.locator('#connDot')).toHaveClass(/bg-success/, { timeout: 10_000 });
}

/** 进入可发消息态：空首页须先点 ＋（composeReady）才露出输入条；已在会话内则 no-op。 */
export async function ensureComposerReady(page: Page) {
  const input = page.locator('#input');
  if (await input.isVisible()) return;
  await page.locator('#btnNew').click();
  await expect(input).toBeVisible();
  await expect(page.locator('#btnSend')).toBeVisible();
}

/** 关闭配置面板。勿点 #settingsScrim 中心——面板盖住中部会拦截点击；Escape / 遮罩顶部空白均可。 */
export async function closeSettings(page: Page) {
  const sheet = page.locator('#settingsSheet');
  if (await sheet.evaluate(el => el.classList.contains('translate-y-full')).catch(() => true)) return;
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveClass(/translate-y-full/);
}

export async function sendChatMessage(page: Page, text: string) {
  await ensureComposerReady(page);
  const input = page.locator('#input');
  await input.fill(text);
  await expect(page.locator('#btnSend')).toBeEnabled();
  await page.locator('#btnSend').click();
}

export async function waitForIdle(page: Page) {
  // busy 结束：流内 live 行移除，发送钮不再处于 stop 模式
  await expect(page.locator('#streamLiveStatus')).toHaveCount(0, { timeout: 20_000 });
  await expect(page.locator('#btnSend')).not.toHaveAttribute('data-mode', 'stop');
}

export async function expectNoBrowserErrors(page: Page) {
  const errors = (page as Page & { __ccmErrors?: string[] }).__ccmErrors || [];
  expect(errors).toEqual([]);
}
