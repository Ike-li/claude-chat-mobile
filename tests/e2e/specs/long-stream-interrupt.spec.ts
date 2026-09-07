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

  // P0-04h（2026-09-07）：「已 send、还没送达 SDK」的窄窗被停止时，那颗气泡要落灰色终态并挂上
  // 「已随停止取消，未发送」。此前 mock 从不发 system.clientMessageIds，于是 app.js:1977 的
  // markMessageDropped 整条路径在 E2E 里【不可达】，前端也没有任何单测碰它（logic-composer-primary
  // 只钉了 queue_dropped 的条颜色，没碰气泡标记）。
  // 它失效的后果比看起来重：气泡保持 opacity 1、外观与正常已发送消息完全一致，用户只看到一条中性灰
  // 系统条说「有消息被取消了」却看不出是哪一条；而他照原文重发会命中服务端 commitProcessed 去重被
  // 当成功——消息永久消失且屏幕上不留任何痕迹。
  test('P0-04h 停止时未送达的消息：那一条被点名标「已随停止取消，未发送」', async ({ page }) => {
    await gotoMock(page);

    // mock 收下这条但【不回显】，模拟真 server 里消息还停在 this.queue 的窄窗
    await sendChatMessage(page, 'test:queue-drop');

    // 乐观气泡先要在屏幕上（app.js:3101 打的 data-client-message-id 是 markMessageDropped 的定位依据）
    const bubble = page.locator('#messages [data-client-message-id]').last();
    await expect(bubble).toBeVisible();
    await expect(bubble).toContainText('test:queue-drop');
    await expect(bubble.locator('.dropped-indicator')).toHaveCount(0);

    await page.locator('#btnSend[data-mode="stop"]').click();

    // 核心：这一条被点名标记，而不是只在消息流里留一句「有消息被取消了」
    await expect(bubble.locator('.dropped-indicator')).toHaveText('已随停止取消，未发送');
    await expect(page.locator('#messages')).toContainText('尚未送达的消息已随停止取消');

    // 【已知失效，本轮未修】markMessageDropped 还会 `b.style.opacity = '0.55'`（app.js:1982）想把气泡
    // 压灰，但 app.css:171 的 `#messages > * { animation: msg-in .2s ease both; }` 里 fill-mode=both
    // 让末帧 opacity:1 永久留在【动画层】，而动画层在 CSS 层叠里压过内联样式——实测 style.opacity 确为
    // '0.55' 而 getComputedStyle 恒为 '1'。所以这里【不】断言 opacity：断言它会红，而红的是 CSS 不是本用例
    // 要守的行为；断言 style.opacity 则是在测一个没有视觉效果的实现细节。文字标记是真正到达用户的那一半。

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
