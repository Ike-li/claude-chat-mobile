import { spawnSync } from 'node:child_process';
import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';

const TOKEN = 'playground-local-not-a-secret';
const WORKSPACE = '/home/ccm-test/workspace';

test('static shell is reachable without a token and without opening a socket', async ({ request }) => {
  const res = await request.get('/');
  expect(res.status()).toBe(200);
  expect(await res.text()).toContain('id="authGate"');
});

test.describe.serial('playground app TOFU', () => {
  let context: BrowserContext;
  let page: Page;

  test.beforeAll(async ({ browser }: { browser: Browser }) => {
    context = await browser.newContext();
    page = await context.newPage();
  });

  test.afterAll(async () => {
    await context?.close();
  });

  test('token URL shows the device-approval overlay', async () => {
    await page.goto(`/#token=${TOKEN}`);
    await expect(page.locator('#deviceModal')).toBeVisible();
    await expect(page.locator('#input')).toBeDisabled();
    await expect(page.locator('#deviceModal')).toContainText('scripts/device.js approve');
  });

  test('approve from the browser container unlocks the UI', async () => {
    const id = (await page.locator('#deviceModalId').textContent())?.trim();
    expect(id && id !== 'generating...').toBeTruthy();
    const result = spawnSync(process.execPath, ['/app/scripts/device.js', 'approve', id], {
      cwd: '/app',
      env: process.env,
      encoding: 'utf8',
    });
    expect(result.status, result.stderr || result.stdout).toBe(0);

    const modal = page.locator('#deviceModal');
    try {
      await expect(modal).toBeHidden({ timeout: 8000 });
    } catch {
      await page.reload();
      await expect(modal).toBeHidden();
    }
    await expect(page.locator('#btnNew')).toBeVisible();
  });

  test('first chat turn traverses browser -> real app -> Agent SDK -> deterministic Claude fixture -> browser', async () => {
    const userText = 'hello from real app e2e';
    const expectedReply = `CCM deterministic fake reply: ${userText}`;

    await page.locator('#btnNew').click();
    const input = page.locator('#input');
    await expect(input).toBeVisible();
    await expect(input).toBeEditable();
    await input.fill(userText);

    const send = page.locator('#btnSend');
    await expect(send).toBeVisible();
    await expect(send).toBeEnabled();
    await send.click();

    // 这两条一起证明不是浏览器本地造假：user bubble 先走 production socket，assistant 文本由
    // deterministic stream-json CLI fixture 根据收到的 user payload 回显，再经 AgentSession 映射回浏览器。
    await expect(page.locator('[data-testid="user-message"]').last()).toContainText(userText);
    await expect(page.locator('[data-testid="assistant-message"]').last()).toContainText(expectedReply, { timeout: 15_000 });
    await expect(send).not.toHaveAttribute('data-mode', 'stop', { timeout: 10_000 });
  });

  test('workspace is the seeded container project', async () => {
    await page.locator('#btnSessions').click();
    await expect(page.locator(`#sessionPanel div[data-dir="${WORKSPACE}"]`)).toBeVisible();
  });

  test('restart control stays hidden', async () => {
    await expect(page.locator('#devModeGroup')).toHaveClass(/hidden/);
    await expect(page.locator('#btnRestartServer')).toBeHidden();
  });
});
