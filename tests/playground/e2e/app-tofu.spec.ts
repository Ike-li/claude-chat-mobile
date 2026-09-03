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

  test('workspace is the seeded container project', async () => {
    await page.locator('#btnSessions').click();
    await expect(page.locator(`#sessionPanel div[data-dir="${WORKSPACE}"]`)).toBeVisible();
  });

  test('restart control stays hidden', async () => {
    await expect(page.locator('#devModeGroup')).toHaveClass(/hidden/);
    await expect(page.locator('#btnRestartServer')).toBeHidden();
  });
});
