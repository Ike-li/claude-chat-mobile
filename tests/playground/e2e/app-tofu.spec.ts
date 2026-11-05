import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { CLIP_WEBM } from '../../fixtures/media.mjs';

const TOKEN = 'playground-local-not-a-secret';
const WORKSPACE = '/home/ccm-test/workspace';
const PROJECT_DIR = '/home/ccm-test/.claude/projects/-home-ccm-test-workspace';

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

  // tests/e2e 里的 file:open 和 /f/ 都是 mock。这条看真 ack、真票据、真响应头交给真前端和 <video> 之后，用户能不能拿到文件。
  test('file links in a message open through the real server', async () => {
    const sessionId = randomUUID();
    const question = randomUUID();
    const turn = (type: 'user' | 'assistant', uuid: string, parentUuid: string | null, text: string) => JSON.stringify({
      type, uuid, parentUuid, sessionId, cwd: WORKSPACE, timestamp: new Date().toISOString(),
      message: { role: type, content: [{ type: 'text', text }] },
    });
    mkdirSync(`${WORKSPACE}/media`, { recursive: true });
    writeFileSync(`${WORKSPACE}/media/clip.webm`, CLIP_WEBM);
    mkdirSync(PROJECT_DIR, { recursive: true });
    writeFileSync(`${PROJECT_DIR}/${sessionId}.jsonl`, [
      turn('user', question, null, 'where is the clip'),
      turn('assistant', randomUUID(), question, '[clip](media/clip.webm) and [script](hello.js:1)'),
    ].join('\n') + '\n');

    await page.reload();
    await page.locator('#btnSessions').click();
    await page.locator('[data-testid="session-row"]', { hasText: 'where is the clip' }).click();

    const fileStatuses: number[] = [];
    page.on('response', response => {
      if (new URL(response.url()).pathname.startsWith('/f/')) fileStatuses.push(response.status());
    });
    await page.getByRole('link', { name: 'clip', exact: true }).click();
    const video = page.locator('#fileBrowseBody video');
    await expect.poll(() => video.evaluate((el: HTMLVideoElement) => el.readyState)).toBeGreaterThan(0);
    expect(fileStatuses, 'Chromium 的媒体请求带 Range，没回 206 手机上就拖不动').toContain(206);

    const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#fileBrowseDownload').click()]);
    expect(download.suggestedFilename()).toBe('clip.webm');
    expect(readFileSync(await download.path()).equals(CLIP_WEBM), '下载回来的字节和原文件不一样').toBe(true);

    await page.locator('#workspaceClose').click();
    await page.getByRole('link', { name: 'script', exact: true }).click();
    await expect(page.locator('#fileBrowsePath')).toContainText('hello.js');
    await expect(page.locator('#fileBrowseBody .file-target-line')).toHaveCount(1);
  });
});
