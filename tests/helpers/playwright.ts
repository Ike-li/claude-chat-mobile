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
  // Composer C：空闲无内容时 #btnSend 可能 hidden，附件钮始终在
  await expect(page.locator('#btnAttach')).toBeVisible();
}

/** 关闭配置面板。勿点 #settingsScrim 中心——面板盖住中部会拦截点击；Escape / 遮罩顶部空白均可。 */
export async function closeSettings(page: Page) {
  const sheet = page.locator('#settingsSheet');
  if (await sheet.evaluate(el => el.classList.contains('translate-y-full')).catch(() => true)) return;
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveClass(/translate-y-full/);
}

/**
 * 展开会话设置里的某一折叠块（模型 / 思考强度 / 权限）。
 * 三块默认收起（紧凑列表 + 手风琴），磁贴要先展开才点得到。调用方须已打开 #settingsSheet。
 */
/** 会话设置入口：底栏合并摘要 chip（模型 · 权限 · 思考）。 */
export async function openSessionSettings(page: Page) {
  await page.locator('#pillDefaults').click();
  await expect(page.locator('#settingsSheet')).not.toHaveClass(/translate-y-full/);
}

/**
 * 滚到会话设置里的对应分区。方案 A 后三块始终展开磁贴，不再点 summary 开合；
 * 保留此 helper 是为了既有用例「先定位到某块再点磁贴」的可读性。
 */
export async function openSettingsSection(page: Page, key: 'model' | 'effort' | 'perm') {
  const section = page.locator(`#${key}Section`);
  await section.scrollIntoViewIfNeeded();
  await expect(section).toBeVisible();
}

/**
 * 打开通用设置（📱 本机偏好 + 🖥 主机与服务 + 🔑 访问与帮助）。
 * 入口在侧栏底部而非 composer——那几段跟会话无关，不该随 composer 一起隐藏（见 P0-28）。
 */
export async function openGeneralSettings(page: Page) {
  await page.locator('#btnSessions').click();
  await page.locator('#btnGeneralSettings').click();
  await expect(page.locator('#generalSheet')).not.toHaveClass(/translate-y-full/);
}

/** 关闭通用设置，同 closeSettings 的理由走 Escape。 */
export async function closeGeneralSettings(page: Page) {
  const sheet = page.locator('#generalSheet');
  if (await sheet.evaluate(el => el.classList.contains('translate-y-full')).catch(() => true)) return;
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveClass(/translate-y-full/);
}

export async function sendChatMessage(page: Page, text: string) {
  await ensureComposerReady(page);
  const input = page.locator('#input');
  await input.fill(text);
  // Composer C：空闲无内容时发送钮 .hidden；确保 input 事件把钮露出后再点
  await expect(page.locator('#btnSend')).toBeVisible({ timeout: 5_000 });
  await expect(page.locator('#btnSend')).toBeEnabled();
  await page.locator('#btnSend').click();
}

export async function waitForIdle(page: Page) {
  // busy 结束：流内 live 行移除，发送钮不再处于 stop 模式（空闲后钮可能 hidden，仍可读 data-mode）
  await expect(page.locator('#streamLiveStatus')).toHaveCount(0, { timeout: 20_000 });
  await expect(page.locator('#btnSend')).not.toHaveAttribute('data-mode', 'stop', { timeout: 20_000 });
}

export async function expectNoBrowserErrors(page: Page) {
  const errors = (page as Page & { __ccmErrors?: string[] }).__ccmErrors || [];
  expect(errors).toEqual([]);
}
