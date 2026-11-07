import { test, expect, type Page } from '@playwright/test';
import { expectNoBrowserErrors, gotoMock, sendChatMessage, waitForIdle } from '../../helpers/playwright';

// 上下文面板：状态栏 ctx 段点进去。显示规则在 tests/unit/logic-context-panel.test.mjs，取数在
// tests/unit/context-usage-socket.test.mjs；这里守界面。状态栏文案不动（P0-10 守着）。
const modal = (page: Page) => page.locator('#contextModal');
const note = (page: Page) => page.locator('#contextNote');
const setFixture = (page: Page, fixture: unknown) => page.request.post('/__context-usage', { params: { fixture: JSON.stringify(fixture) } });

async function openPanel(page: Page, scenario = 'test:statusline') {
  await gotoMock(page);
  await sendChatMessage(page, scenario);
  await waitForIdle(page);
  await page.locator('#cliStatusWrap summary').click();
  await page.locator('[data-testid="status-ctx"]').click();
  await expect(modal(page)).toBeVisible();
}

test.describe('P0 上下文面板', () => {
  test('P0-CTX-1 点 ctx 打开：用量、距自动压缩，明细默认折叠，展开看到类别', async ({ page }) => {
    await openPanel(page);
    await expect(page.locator('#contextUsed')).toHaveText('已用 77%');
    await expect(page.locator('#contextTokens')).toHaveText('770k / 1.0m');
    await expect(page.locator('#contextCompactLine')).toHaveText('距自动压缩还剩 197k');
    await expect(page.locator('#contextRows')).toBeHidden();
    await page.locator('#contextDetails summary').click();
    await expect(page.locator('#contextRows')).toContainText('Messages');
    await expect(page.locator('#contextRows')).toContainText('684k');
    await expect(page.locator('#contextRows')).not.toContainText('deferred');
    await expect(note(page)).toBeHidden();

    await page.locator('#contextClose').click();
    await expect(modal(page)).toBeHidden();
    await expectNoBrowserErrors(page);
  });

  test('P0-CTX-2 summary 先出并标估算，full 到了校准，说明消失', async ({ page }) => {
    await gotoMock(page);
    await setFixture(page, { holdFull: true });
    await sendChatMessage(page, 'test:statusline');
    await waitForIdle(page);
    await page.locator('#cliStatusWrap summary').click();
    await page.locator('[data-testid="status-ctx"]').click();
    await expect(page.locator('#contextUsed')).toHaveText('已用 91%');
    await expect(note(page)).toContainText('估算');

    await page.request.post('/__release-context-full');
    await expect(page.locator('#contextUsed')).toHaveText('已用 77%');
    await expect(note(page)).toBeHidden();
    await expectNoBrowserErrors(page);
  });

  test('P0-CTX-3 CLI 驾驶的会话：不向实例要数据，只显示总量并说明', async ({ page }) => {
    await gotoMock(page);
    await setFixture(page, { countCalls: true });
    await sendChatMessage(page, 'test:cli-statusline');
    await waitForIdle(page);
    await page.locator('#cliStatusWrap summary').click();
    await page.locator('[data-testid="status-ctx"]').click();
    await expect(modal(page)).toBeVisible();
    await expect(note(page)).toContainText('电脑终端');
    await expect(page.locator('#contextUsed')).toContainText('已用');
    await expect(page.locator('#contextDetails')).toBeHidden();
    const calls = await (await page.request.get('/__context-usage-calls')).json();
    expect(calls).toEqual([]);
    await expectNoBrowserErrors(page);
  });

  test('P0-CTX-4 拿不到明细：说清楚原因，状态栏的总量留着', async ({ page }) => {
    await gotoMock(page);
    await setFixture(page, { unavailable: true });
    await sendChatMessage(page, 'test:statusline');
    await waitForIdle(page);
    await page.locator('#cliStatusWrap summary').click();
    await page.locator('[data-testid="status-ctx"]').click();
    await expect(note(page)).toContainText('没有运行中的进程');
    await expect(page.locator('#contextUsed')).toHaveText('已用 23%');
    await page.locator('#contextClose').click();

    await setFixture(page, { fullFails: true });
    await page.locator('[data-testid="status-ctx"]').click();
    await expect(page.locator('#contextUsed')).toHaveText('已用 91%');
    await expect(note(page)).toContainText('估算');
    await expect(note(page)).toContainText('没拿到');
    await expectNoBrowserErrors(page);
  });

  test('P0-CTX-5 旧后端不回音：给提示，不留转圈', async ({ page }) => {
    await page.clock.install();
    await gotoMock(page);
    await setFixture(page, { silent: true });
    await sendChatMessage(page, 'test:statusline');
    await waitForIdle(page);
    await page.locator('#cliStatusWrap summary').click();
    await page.locator('[data-testid="status-ctx"]').click();
    await expect(note(page)).toContainText('加载中');
    await page.clock.runFor(10_000);
    await expect(note(page)).toContainText('后端可能还没重启');
    await expectNoBrowserErrors(page);
  });

  test('P0-CTX-6 压缩：确认后发 /compact，面板收起，打了一半的草稿还在', async ({ page }) => {
    await openPanel(page);
    await page.locator('#contextClose').click();
    await page.locator('#input').fill('打了一半的话');
    await page.locator('[data-testid="status-ctx"]').click();

    await page.locator('#contextCompact').click();
    await expect(page.locator('#confirmModal')).toBeVisible();
    await page.locator('#confirmOk').click();
    await expect(modal(page)).toBeHidden();
    await expect(page.locator('#messages')).toContainText('/compact');
    await expect(page.locator('#input')).toHaveValue('打了一半的话');
    await expectNoBrowserErrors(page);
  });

  test('P0-CTX-7 取消确认：不发，面板留着', async ({ page }) => {
    await openPanel(page);
    await page.locator('#contextCompact').click();
    await page.locator('#confirmCancel').click();
    await expect(modal(page)).toBeVisible();
    await expect(page.locator('#messages')).not.toContainText('/compact');
    await expectNoBrowserErrors(page);
  });

  test('P0-CTX-8 有待发附件时按钮不可点并说明：否则附件会跟着 /compact 发出去', async ({ page }) => {
    await gotoMock(page);
    await sendChatMessage(page, 'test:statusline');
    await waitForIdle(page);
    await page.locator('#fileInput').setInputFiles({ name: 'a.txt', mimeType: 'text/plain', buffer: Buffer.from('x') });
    await page.locator('#cliStatusWrap summary').click();
    await page.locator('[data-testid="status-ctx"]').click();
    await expect(page.locator('#contextCompact')).toBeDisabled();
    await expect(page.locator('#contextCompactHint')).toHaveText('有待发附件，发出或移除后再压缩');
    await expectNoBrowserErrors(page);
  });
});
