import { test, expect, type Page } from '@playwright/test';
import { expectNoBrowserErrors, gotoMock } from '../../helpers/playwright';

// 工作区 sheet 的「产出」tab：这个会话产出了哪些文件。这里守界面；判定规则在 tests/unit/session-outputs.test.mjs，
// 范围门在 tests/invariants/server-file-handlers.test.mjs，真 server 上的端到端在 tests/invariants/server/files-scope.test.mjs。
const tab = (page: Page) => page.locator('[data-testid="workspace-tab-outputs"]');
const rows = (page: Page) => page.locator('[data-testid="output-row"]');
const body = (page: Page) => page.locator('#outputsBody');
const setFixture = (page: Page, fixture: unknown) => page.request.post('/__session-outputs', { params: { fixture: JSON.stringify(fixture) } });

async function openOutputs(page: Page) {
  await page.locator('#topContextPill').click();
  await tab(page).click();
  await expect(tab(page)).toHaveAttribute('aria-selected', 'true');
}

test.describe('P0 产出', () => {
  test('P0-OUTPUTS-1 列出产出，点一行打开文件；范围外的收成一行数量', async ({ page }) => {
    await gotoMock(page);
    await openOutputs(page);
    await expect(rows(page)).toHaveCount(3);
    await expect(rows(page).nth(0)).toContainText('clip.mp4');
    await expect(rows(page).nth(0)).toContainText('media');
    await expect(rows(page).nth(0)).toContainText('🎬');
    await expect(page.locator('[data-testid="outputs-outside"]')).toHaveText('另有 2 个文件不在已连接的文件夹里');

    await rows(page).nth(1).click();
    await expect(page.locator('[data-testid="workspace-tab-files"]')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#fileBrowsePath')).toContainText('notes.md');
    await expectNoBrowserErrors(page);
  });

  test('P0-OUTPUTS-2 已删除的文件留在列表里，说明原因，点不了', async ({ page }) => {
    await gotoMock(page);
    await openOutputs(page);
    const gone = rows(page).nth(2);
    await expect(gone).toContainText('gone.png');
    await expect(gone).toContainText('已删除');
    await expect(gone).toBeDisabled();
    await expectNoBrowserErrors(page);
  });

  test('P0-OUTPUTS-3 没有产出：说明这里会列什么；范围外的数量仍然显示', async ({ page }) => {
    await gotoMock(page);
    await setFixture(page, { items: [], outsideCount: 0 });
    await openOutputs(page);
    await expect(body(page)).toContainText('助手新建的文件和贴出链接的文件会列在这里');

    await setFixture(page, { items: [], outsideCount: 4 });
    await page.locator('[data-testid="workspace-tab-files"]').click();
    await tab(page).click();
    await expect(page.locator('[data-testid="outputs-outside"]')).toHaveText('另有 4 个文件不在已连接的文件夹里');
    await expectNoBrowserErrors(page);
  });

  test('P0-OUTPUTS-4 新会话页还没有会话：不发请求，直接说明', async ({ page }) => {
    await gotoMock(page);
    await page.locator('#btnNew').dispatchEvent('click');
    await expect(page.locator('[data-testid="compose-surface"]')).toBeVisible();
    const sent: string[] = [];
    page.on('websocket', ws => ws.on('framesent', f => { if (String(f.payload).includes('session:outputs')) sent.push('x'); }));
    await openOutputs(page);
    await expect(body(page)).toContainText('发出第一条消息后');
    expect(sent).toEqual([]);
    await expectNoBrowserErrors(page);
  });

  test('P0-OUTPUTS-5 服务端报错或没有回音：说清楚，不留空白', async ({ page }) => {
    await page.clock.install();
    await gotoMock(page);
    await setFixture(page, { error: '会话不存在' });
    await openOutputs(page);
    await expect(body(page)).toContainText('会话不存在');

    await setFixture(page, { silent: true }); // 前端已 pull、后端没重启：旧后端不认这个事件
    await page.locator('[data-testid="workspace-tab-files"]').click();
    await tab(page).click();
    await expect(body(page)).toContainText('加载中');
    await page.clock.runFor(10_000);
    await expect(body(page)).toContainText('后端可能还没重启');
    await expectNoBrowserErrors(page);
  });

  test('P0-OUTPUTS-6 三个 tab 互斥：切走时产出的内容收起，切回重新拉', async ({ page }) => {
    await gotoMock(page);
    await openOutputs(page);
    await expect(rows(page)).toHaveCount(3);

    await page.locator('[data-testid="workspace-tab-changes"]').click();
    await expect(body(page)).toBeHidden();
    await expect(page.locator('#gitChangesBody')).toBeVisible();
    await expect(tab(page)).toHaveAttribute('aria-selected', 'false');

    await setFixture(page, { items: [], outsideCount: 0 });
    await tab(page).click();
    await expect(rows(page)).toHaveCount(0);
    await expect(page.locator('#gitChangesBody')).toBeHidden();
    await expectNoBrowserErrors(page);
  });
});
