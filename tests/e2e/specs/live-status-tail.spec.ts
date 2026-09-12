// helpers: tests/helpers/playwright.ts

import { test, expect } from '@playwright/test';
import { ensureComposerReady, expectNoBrowserErrors, gotoMock, sendChatMessage, waitForIdle } from '../../helpers/playwright';
import { ANOTHER_WORKSPACE, openSessionsSidebar, openWorkspaceSession } from '../../helpers/sidebar-ui';

// 流内 live 活动行（✻ Perusing… (14s)）语义上是「流的最后一行」——CLI 里 spinner 就跟在输出末尾。
// 它靠 pinStreamLiveStatus() 维持，而那要求【每个往 #messages 塞节点的地方都记得调它】。
// appendMessage / addBar 之外还有 8 个直接 messagesEl.appendChild 的点，2026-09-11 实测其中
// 4 个漏了，症状是 live 行卡在消息流【顶部】，且只有下一条 assistant 内容到达才会自愈——
// 正好是「消息发出去、还没收到回复」这段时间用户盯着看的那一屏。
//
// 这两条用的都是"没有任何 assistant 内容"的窗口：有内容就会走 appendMessage 把 live 顶回去，
// 断言会在缺陷仍在时变绿（用例建在缺陷窗口之外，本仓踩过的假绿形态之一）。
test.describe('P0 流内 live 活动行恒在消息流末尾', () => {
  // 新会话首发：懒开实例 → clearView 清屏 → 补 busy（live 落进空容器）→ 放回未确认气泡。
  // 未修时最后那步直插 messagesEl，气泡落在 live 【下面】。
  test('P0-33 新会话首发且回显未到时 live 行仍在末尾', async ({ page }) => {
    await gotoMock(page);
    await page.locator('#btnNew').click();
    await expect(page.locator('#messages')).toHaveClass(/empty-start/);

    // test:slow-echo 把「已发出、服务端回显还没到」的窗口撑到 2s，可稳定断言。
    await page.locator('#input').fill('test:slow-echo');
    await page.locator('#btnSend').click();

    await expect(page.locator('#streamLiveStatus')).toBeVisible();
    await expect(page.locator('[data-testid="user-message"]')).toHaveCount(1);
    // 核心：用户气泡必须在 live 行【上面】。未修时这里是 streamLiveStatus | user-message。
    await expect(page.locator('#messages > *:last-child')).toHaveAttribute('id', 'streamLiveStatus');

    await expectNoBrowserErrors(page);
  });

  // busy 静默窗口切回：sync 判 reload → clearView → 按 server 权威 state=busy 重种 live 行 →
  // loadHistory 的 fragment 一次性落地。未修时整段历史插在 live 行【下面】。
  test('P0-33b busy 会话切回历史重载后 live 行仍在末尾', async ({ page }) => {
    await gotoMock(page);
    await ensureComposerReady(page);
    await sendChatMessage(page, 'test:busy-silent-switch');
    await waitForIdle(page);

    await openSessionsSidebar(page);
    await openWorkspaceSession(page, ANOTHER_WORKSPACE, 'Another App Concurrency');
    // 等 reload 的历史真正落地，断言才发生在缺陷窗口内（入场 seed 的瞬现窗口里容器是空的，恒绿）。
    await expect(page.locator('[data-testid="assistant-message"]').last())
      .toContainText('Another App Concurrency', { timeout: 10_000 });
    await expect(page.locator('#streamLiveStatus')).toBeVisible();

    await expect(page.locator('#messages > *:last-child')).toHaveAttribute('id', 'streamLiveStatus');

    await expectNoBrowserErrors(page);
  });
});
