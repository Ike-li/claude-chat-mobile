// helpers: tests/helpers/playwright.ts

import { test, expect } from '@playwright/test';
import { expectNoBrowserErrors, gotoMock, sendChatMessage } from '../../helpers/playwright';
import { ANOTHER_WORKSPACE, MAIN_WORKSPACE, expandWorkspace, expectSidebarClosed, openSessionsSidebar, openWorkspaceSession } from '../../helpers/sidebar-ui';

// 现场（2026-09-12 真机）：一个 22:56 就跑完的会话，23:03 切回去时底部仍挂着 `✻ Zigzagging… (92s)`、
// 右下角仍是红色停止钮，而同一时刻抽屉里那一行是「已打开」、没有运行中 chip（服务端 state=idle）。
//
// 链条上唯一没被实证的一环就是这条：**回放流里有 text_delta、却缺配对的轮次终止事件**时会怎样。
// 这个形态在真实链路上可达——轮次结束时用户已经切走，result 被 shouldDropAgentEvent 按视图丢弃，
// 之后能补上它的只有切回时的 sync:since 回放；那批回放一旦不含 result（环形缓冲 trim / epoch 换代 /
// 回放缓冲判 reload 整批丢弃），清 busy 的两条通道就同时断了：
//   ① 轮次终止事件——不在这批里；
//   ② instances 广播上的看门狗 shouldForceClearBusyFromBroadcast——state 是 idle 它确实会清，
//      但它只在【收到广播】时才跑，系统一安静就再没人来纠正。
test.describe('切回已结束的会话：回放缺 result 时运行条不得永久卡住', () => {
  test('BUSY-ORPHAN 回放只有 text_delta 没有 result → 运行条与停止钮不得留在屏幕上', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:busy-orphan-replay');

    // 第一次冷切入：ack(0)，走 loadHistory 建 DOM 缓存。
    await openSessionsSidebar(page);
    await expandWorkspace(page, ANOTHER_WORKSPACE);
    await openWorkspaceSession(page, ANOTHER_WORKSPACE, 'Orphan Replay Session');
    await expectSidebarClosed(page);

    // 切走（模拟「发完就去看别的会话」）。
    await openSessionsSidebar(page);
    await expandWorkspace(page, MAIN_WORKSPACE);
    await openWorkspaceSession(page, MAIN_WORKSPACE, 'Visual Sandbox (Main)');
    await expectSidebarClosed(page);

    // 再切回：这次 mock 回放 user_message + 3 条 text_delta，故意不发 result。
    await openSessionsSidebar(page);
    await expandWorkspace(page, ANOTHER_WORKSPACE);
    await openWorkspaceSession(page, ANOTHER_WORKSPACE, 'Orphan Replay Session');
    await expectSidebarClosed(page);

    // 先确认回放真的派发了（否则下面两条断言是空过的——flush 没发生的话 busy 本来就不会被点亮）。
    await expect(page.locator('#messages')).toContainText('Orphan live chunk #2', { timeout: 10_000 });

    // 核心断言：服务端 state=idle，屏幕上不该有任何「这个会话在跑」的表达。
    await expect(page.locator('#streamLiveStatus')).toHaveCount(0);
    await expect(page.locator('#btnSend')).not.toHaveAttribute('data-mode', 'stop');

    await expectNoBrowserErrors(page);
  });
});
