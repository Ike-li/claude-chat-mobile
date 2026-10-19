// helpers: tests/helpers/playwright.ts

import { test, expect } from '@playwright/test';
import { captureBrowserErrors, expectNoBrowserErrors, waitUntilConnected } from '../../helpers/playwright';

test.describe('P0 日常零 token Mock UI 回归', () => {
  test('P0-20 安全与鉴权可观测 UI 行为', async ({ page }) => {
    const consoleText: string[] = [];
    captureBrowserErrors(page);
    page.on('console', message => consoleText.push(message.text()));
    await page.request.post('/__reset');

    // 1. URL hash #token=mock-token 打开后 token 存入 localStorage，地址栏清理。
    await page.goto('/#token=mock-token');
    await expect(page.locator('#input')).toBeVisible();
    await expect.poll(() => page.url()).not.toContain('mock-token');
    expect(await page.evaluate(() => localStorage.getItem('auth_token'))).toBe('mock-token');
    await expect(page.locator('body')).not.toContainText('mock-token');

    // 2. 日志只允许脱敏 token，不应泄露完整 token。
    await page.locator('#btnConsole').click();
    await expect(page.locator('#consoleModal')).toBeVisible();
    await expect(page.locator('#consoleModal')).not.toContainText('mock-token');
    expect(consoleText.join('\n')).not.toContain('mock-token');

    await expectNoBrowserErrors(page);
  });

  test('P0-20b 鉴权失败显示令牌输入页且重输后恢复连接', async ({ page }) => {
    const consoleText: string[] = [];
    captureBrowserErrors(page, { ignoredResourceStatusCodes: [400] });
    page.on('console', message => consoleText.push(message.text()));
    await page.request.post('/__reset');

    await page.goto('/#token=bad-token');
    await expect.poll(() => page.url()).not.toContain('bad-token');
    await expect(page.locator('#authGate')).toBeVisible();
    await expect(page.locator('#authError')).toContainText('令牌无效，请重新输入');
    await expect(page.locator('#connDotWrap')).not.toHaveAttribute('data-conn', 'online');
    await expect(page.locator('[data-testid="user-message"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="assistant-message"]')).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText('bad-token');
    expect(consoleText.join('\n')).not.toContain('bad-token');

    await page.locator('#authToken').fill('mock-token');
    await page.locator('#authSubmit').click();
    await expect(page.locator('#authGate')).toBeHidden();
    await waitUntilConnected(page);
    await expect(page.locator('#input')).toBeVisible();
    await expect(page.locator('body')).not.toContainText('mock-token');
    expect(await page.evaluate(() => localStorage.getItem('auth_token'))).toBe('mock-token');
    expect(consoleText.join('\n')).not.toContain('mock-token');

    await expectNoBrowserErrors(page);
  });

  test('P0-20c 鉴权失败页可打开访问帮助且不泄露令牌', async ({ page }) => {
    const consoleText: string[] = [];
    captureBrowserErrors(page, { ignoredResourceStatusCodes: [400] });
    page.on('console', message => consoleText.push(message.text()));
    await page.request.post('/__reset');

    await page.goto('/#token=expired-token');
    await expect.poll(() => page.url()).not.toContain('expired-token');
    await expect(page.locator('#authGate')).toBeVisible();
    await expect(page.locator('#authError')).toContainText('令牌无效，请重新输入');

    await page.locator('#authHelpLink').click();
    await expect(page.locator('#accessHelp')).toBeVisible();
    await expect(page.locator('#accessHelp')).toContainText('访问令牌在哪');
    await expect(page.locator('#accessHelp')).toContainText('新设备怎么获批');
    await expect(page.locator('body')).not.toContainText('expired-token');
    expect(consoleText.join('\n')).not.toContain('expired-token');

    await page.locator('#accessHelpClose').click();
    await expect(page.locator('#accessHelp')).toBeHidden();
    await expect(page.locator('#authGate')).toBeVisible();

    await expectNoBrowserErrors(page);
  });

  test('P0-20d 鉴权失败页按 Enter 可重输令牌恢复连接', async ({ page }) => {
    const consoleText: string[] = [];
    captureBrowserErrors(page, { ignoredResourceStatusCodes: [400] });
    page.on('console', message => consoleText.push(message.text()));
    await page.request.post('/__reset');

    await page.goto('/#token=invalid-token');
    await expect.poll(() => page.url()).not.toContain('invalid-token');
    await expect(page.locator('#authGate')).toBeVisible();
    await expect(page.locator('#authError')).toContainText('令牌无效，请重新输入');

    await page.locator('#authToken').fill('mock-token');
    await page.locator('#authToken').press('Enter');
    await expect(page.locator('#authGate')).toBeHidden();
    await waitUntilConnected(page);
    await expect(page.locator('#input')).toBeVisible();
    await expect(page.locator('body')).not.toContainText('invalid-token');
    await expect(page.locator('body')).not.toContainText('mock-token');
    expect(consoleText.join('\n')).not.toContain('invalid-token');
    expect(consoleText.join('\n')).not.toContain('mock-token');

    await expectNoBrowserErrors(page);
  });

  // 验收 O83（AC-22-09）：输错一次后紧接着输对，正确令牌撞进服务端的退避短锁（这次根本没校验）。此前服务端回
  // unauthorized，界面说「令牌无效」，用户会怀疑自己输对的令牌；现在服务端回 cooldown + 毫秒数，前端说清在等、到点自动重试。
  test('P0-20i 输错后紧接着输对：冷却期内不说令牌无效，到点自动重试进去', async ({ page }) => {
    captureBrowserErrors(page, { ignoredResourceStatusCodes: [400] });
    await page.request.post('/__reset');

    await page.goto('/#token=bad-token');
    await expect(page.locator('#authGate')).toBeVisible();
    await expect(page.locator('#authError')).toContainText('令牌无效，请重新输入');

    // 真 server 上这把短锁是上一次失败顺带上的；mock 里由用例显式上锁，窗口从这一刻算，不赌页面耗时
    await page.request.post('/__auth-cooldown?ms=1500');
    await page.locator('#authToken').fill('mock-token');
    await page.locator('#authSubmit').click();
    await expect(page.locator('#authError')).toContainText('秒后自动重试');
    await expect(page.locator('#authError')).not.toContainText('令牌无效');
    await expect(page.locator('#authError')).not.toContainText('尝试过多');

    await expect(page.locator('#authGate')).toBeHidden({ timeout: 10_000 });
    await waitUntilConnected(page);
    expect(await page.evaluate(() => localStorage.getItem('auth_token'))).toBe('mock-token');
    await expectNoBrowserErrors(page);
  });

  test('P0-20e token 重试成功后不会把失败令牌留在本地输入状态', async ({ page }) => {
    const consoleText: string[] = [];
    captureBrowserErrors(page, { ignoredResourceStatusCodes: [400] });
    page.on('console', message => consoleText.push(message.text()));
    await page.request.post('/__reset');

    await page.goto('/#token=bad-token');
    await expect.poll(() => page.url()).not.toContain('bad-token');
    await expect(page.locator('#authGate')).toBeVisible();
    await expect(page.locator('#authError')).toContainText('令牌无效，请重新输入');
    await expect(page.locator('#authToken')).toHaveValue('');

    await page.locator('#authToken').fill('invalid-token');
    await page.locator('#authSubmit').click();
    await expect(page.locator('#authGate')).toBeVisible();
    await expect(page.locator('#authError')).toContainText('令牌无效，请重新输入');

    await page.locator('#authToken').fill('mock-token');
    await page.locator('#authSubmit').click();
    await expect(page.locator('#authGate')).toBeHidden();
    await waitUntilConnected(page);
    await expect(page.locator('#input')).toBeVisible();
    await expect(page.locator('#authToken')).toHaveValue('');

    expect(await page.evaluate(() => localStorage.getItem('auth_token'))).toBe('mock-token');
    await expect(page.locator('body')).not.toContainText('bad-token');
    await expect(page.locator('body')).not.toContainText('invalid-token');
    await expect(page.locator('body')).not.toContainText('mock-token');
    expect(consoleText.join('\n')).not.toContain('bad-token');
    expect(consoleText.join('\n')).not.toContain('invalid-token');
    expect(consoleText.join('\n')).not.toContain('mock-token');
    expect(consoleText.join('\n')).not.toContain('bad-***');
    expect(consoleText.join('\n')).not.toContain('inva***');

    await expectNoBrowserErrors(page);
  });
});
