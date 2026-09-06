// helpers: tests/helpers/playwright.ts

import { test, expect } from '@playwright/test';
import { ensureComposerReady, expectNoBrowserErrors, gotoMock, sendChatMessage, waitForIdle } from '../../helpers/playwright';

test.describe('P0 日常零 token Mock UI 回归', () => {
  test('P0-04 长流式输出与停止/中断', async ({ page }) => {
    await gotoMock(page);

    // 1. 起始状态/假设：fresh state。发送 test:stream-long，等待至少一个 Chunk 出现。
    await sendChatMessage(page, 'test:stream-long');
    await expect(page.locator('#streamLiveStatus')).toBeVisible();
    await expect(page.locator('#btnSend')).toHaveAttribute('data-mode', 'stop');
    await expect(page.locator('[data-testid="assistant-message"]').last()).toContainText('Chunk 1', { timeout: 10_000 });

    // 2. 空输入时发送钮 morph 为停止，点击中止。
    await page.locator('#btnSend[data-mode="stop"]').click();
    await waitForIdle(page);
    await page.locator('#input').fill('hello after interrupt');
    await expect(page.locator('#btnSend')).toBeEnabled();

    await expectNoBrowserErrors(page);
  });

  test('P0-04b 停止后旧长流不再继续追加到旧消息', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:stream-long');
    const interruptedReply = page.locator('[data-testid="assistant-message"]').filter({ hasText: 'Chunk 1' }).first();
    await expect(interruptedReply).toContainText('Chunk 1', { timeout: 10_000 });
    await page.locator('#btnSend[data-mode="stop"]').click();
    await waitForIdle(page);
    await expect(page.locator('#messages')).toContainText('已中断');

    await sendChatMessage(page, 'test:tool');
    await waitForIdle(page);
    await expect(page.locator('[data-testid="assistant-message"]').last()).toContainText('All tools executed cleanly');
    await expect(interruptedReply).not.toContainText('Chunk 4');

    await expectNoBrowserErrors(page);
  });

  test('P0-04c 连续点击停止只显示一次中断反馈', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:stream-long');
    await expect(page.locator('[data-testid="assistant-message"]').last()).toContainText('Chunk 1', { timeout: 10_000 });

    await page.locator('#btnSend[data-mode="stop"]').dblclick();
    await waitForIdle(page);
    await expect(page.locator('#messages .msg-frame.text-center').filter({ hasText: '已中断' })).toHaveCount(1);

    await page.locator('#input').fill('hello after double interrupt');
    await expect(page.locator('#btnSend')).toBeEnabled();

    await expectNoBrowserErrors(page);
  });

  // VC-D1-03（2026-08-26 探索性测试）：点停止之后，**动态行的秒数必须停止增长**。
  // 上面 P0-04/04b/04c 断的是「出现已中断」「输入框可用」「不重复提示」——都成立时，
  // 仍可能是 UI 放弃了这个回合而后台还在跑（本项目历史上出现过看门狗兜底的 10 分钟假 busy）。
  // 秒数是唯一能把这两种情形分开的屏幕信号，所以这里先证明它**确实在涨**，再证明它停了。
  test('P0-04d 点停止后动态行秒数停止增长（不是只把按钮换回箭头）', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:stream-long');
    const live = page.locator('#streamLiveStatusText');
    await expect(live).toBeVisible();

    // 1. 先自证这条断言不是空过：秒数真的在往上走。
    //    toPass 轮询而不是固定 sleep —— 固定延时既慢又会在慢机器上假红。
    const first = await live.textContent();
    await expect(async () => {
      const now = await live.textContent();
      expect(now).not.toBe(first);
    }).toPass({ timeout: 10_000 });

    // 2. 点停止 → 动态行整个退场（秒数无处可涨），并留下明确的中断痕迹。
    await page.locator('#btnSend[data-mode="stop"]').click();
    await expect(page.locator('#streamLiveStatus')).toHaveCount(0, { timeout: 20_000 });
    await expect(page.locator('#messages')).toContainText('已中断');
    await expect(page.locator('#btnSend')).not.toHaveAttribute('data-mode', 'stop');
    await expect(page.locator('#input')).toBeEditable();

    await expectNoBrowserErrors(page);
  });
});
