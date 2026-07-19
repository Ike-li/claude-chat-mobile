// spec: docs/testing.md
// helpers: tests/helpers/playwright.ts
// 排队可见性 + 撤回重编辑（对齐 CLI Queued/ESC）：busy 期第二条消息挂「排队中」标记；
// 撤回→文本回输入框、气泡落「已撤回」；停止→排队条连带「已随停止取消」；本轮 result→标记自动转正。

import { test, expect } from '@playwright/test';
import { expectNoBrowserErrors, gotoMock, sendChatMessage, waitForIdle } from '../../helpers/playwright';

test.describe('P0 消息排队可见性与撤回', () => {
  test('P0-QUEUE-1 busy 期入队显排队标记，撤回按钮/ESC 均回填输入框', async ({ page }) => {
    await gotoMock(page);
    await sendChatMessage(page, 'test:stream-long');
    await expect(page.locator('[data-testid="assistant-message"]').last()).toContainText('Chunk 1', { timeout: 10_000 });

    // busy 中发第二条 → 排队标记可见
    await sendChatMessage(page, 'please queue this');
    const queuedBubble = page.locator('[data-testid="user-message"]').filter({ hasText: 'please queue this' });
    await expect(queuedBubble.locator('.queued-indicator')).toBeVisible();
    await expect(queuedBubble.locator('.queued-indicator')).toContainText('排队中');

    // 点「撤回」→ 文本回输入框、气泡落灰终态
    await queuedBubble.locator('[data-testid="queued-cancel"]').click();
    await expect(page.locator('#input')).toHaveValue('please queue this');
    await expect(queuedBubble.locator('.queued-indicator')).toContainText('已撤回，未发送');

    // 对齐 CLI ESC：再排一条，焦点在输入框按 Escape 撤回最近排队条
    await page.locator('#input').fill('');
    await sendChatMessage(page, 'queue again via esc');
    const escBubble = page.locator('[data-testid="user-message"]').filter({ hasText: 'queue again via esc' });
    await expect(escBubble.locator('.queued-indicator')).toContainText('排队中');
    await page.locator('#input').press('Escape');
    await expect(page.locator('#input')).toHaveValue('queue again via esc');
    await expect(escBubble.locator('.queued-indicator')).toContainText('已撤回，未发送');

    // 收尾：清输入使发送钮 morph 停止，中止长流
    await page.locator('#input').fill('');
    await page.locator('#btnSend[data-mode="stop"]').click();
    await waitForIdle(page);
    await expectNoBrowserErrors(page);
  });

  test('P0-QUEUE-2 停止连带取消排队条（queue_dropped 终态）', async ({ page }) => {
    await gotoMock(page);
    await sendChatMessage(page, 'test:stream-long');
    await expect(page.locator('[data-testid="assistant-message"]').last()).toContainText('Chunk 1', { timeout: 10_000 });

    await sendChatMessage(page, 'queued then dropped');
    const bubble = page.locator('[data-testid="user-message"]').filter({ hasText: 'queued then dropped' });
    await expect(bubble.locator('.queued-indicator')).toContainText('排队中');

    await page.locator('#btnSend[data-mode="stop"]').click();
    await waitForIdle(page);
    await expect(bubble.locator('.queued-indicator')).toContainText('已随停止取消，未发送');
    await expect(page.locator('#messages')).toContainText('排队中的消息已随停止取消');
    await expectNoBrowserErrors(page);
  });

  test('P0-QUEUE-3 本轮 result 到达后排队标记自动转正', async ({ page }) => {
    await gotoMock(page);
    await sendChatMessage(page, 'test:queued-hold');
    await sendChatMessage(page, 'runs next turn');
    const bubble = page.locator('[data-testid="user-message"]').filter({ hasText: 'runs next turn' });
    await expect(bubble.locator('.queued-indicator')).toBeVisible();

    await waitForIdle(page); // queued-hold 4s 后正常收 result
    await expect(bubble.locator('.queued-indicator')).toHaveCount(0);
    await expectNoBrowserErrors(page);
  });
});
