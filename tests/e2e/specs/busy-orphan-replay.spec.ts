// helpers: tests/helpers/playwright.ts

import { test, expect } from '@playwright/test';
import { expectNoBrowserErrors, gotoMock, sendChatMessage } from '../../helpers/playwright';
import { ANOTHER_WORKSPACE, MAIN_WORKSPACE, expandWorkspace, expectSidebarClosed, openSessionsSidebar, openWorkspaceSession } from '../../helpers/sidebar-ui';

// 守的不变量：**sync:since 回放批次对运行态完全中性**——既不点亮也不清除。运行态一律由 instances
// 决定（运行条看 state，停止钮与发送闸看 turnRunning，两者故意不同；见 logic/composer.js）。
//
// 起因是 2026-09-12 真机现场：一个 22:56 就跑完的会话，23:03 切回去仍挂着 `✻ Zigzagging… (92s)` 和
// 红色停止钮，而同一时刻抽屉里那一行没有运行中 chip（服务端 state=idle）。
//
// ⚠ 关于下面两条用例的形态，必须说清楚，否则会被读成比它实际更强的证据：
//
// · BUSY-ORPHAN（第一条）是**刻意构造的隔离形态**，不是对那次现场成因的复现。生产 sync:since 回放的是
//   AgentSession.eventsSince 返回的完整 FIFO：环形缓冲的 trim 从最旧开始，删不掉更新的 result 而保留
//   更旧的 delta；gap 与 reload 又是整批丢弃改走 history、不会 flush 出这个形状；而若 result 压根没
//   生成，pendingTurns 非零、实例就不会是 idle。所以「回放缺 result 且 state=idle」这个组合在生产上
//   并不可达（PR #38 review P2 指出）。它在这里的作用等同于单元测试喂一个不可能的输入来隔离单条分支：
//   证明「回放的 delta 不得点亮 busy」这条规则本身被执行。**那次真机现场的确切点亮路径至今未确证**
//   （证据窗口已关闭），对症它的是另一半修复——startLiveTicker 的每秒自检，不管谁点亮的，只要权威
//   state 说 idle 且超过宽限就清掉。那一半由 logic 层的 shouldForceClearBusyFromBroadcast 判据覆盖。
//
// · BUSY-ORPHAN-MIXED（第二条）用的才是**生产可达**的形状：完整 FIFO 里既有已结束的旧轮、又有当前
//   仍在跑的新轮。它守的是 P1 回归——只挡 delta 不挡 result 会把 bindView 刚播下的 busy 清掉。
test.describe('回放批次不得改写运行态', () => {
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

  // P1 回归（PR #38 review）：生产 sync:since 回放的是完整 FIFO，批次里完全可能【既有已结束的旧轮、
  // 又有当前仍在跑的新轮】。若只挡住 delta 不点亮、却让旧轮那条 result 照常 setBusy(false) +
  // _turnRunning=false，就会把 bindView 刚按权威 state='busy' 播下的运行态清掉，而属于新轮的 delta
  // 已不会再点亮它 —— 运行条与停止钮双双消失、主按钮回到「发送」，用户据此发出的消息会被服务端以
  // 在途轮为由拒掉。ticker 自检也救不回来：它只清不亮。
  test('BUSY-ORPHAN-MIXED 回放里旧轮的 result 不得清掉当前仍在跑的那一轮', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:busy-orphan-mixed');

    // 第一次冷切入：ack(0)，走 loadHistory 建 DOM 缓存。
    await openSessionsSidebar(page);
    await expandWorkspace(page, ANOTHER_WORKSPACE);
    await openWorkspaceSession(page, ANOTHER_WORKSPACE, 'Orphan Mixed Session');
    await expectSidebarClosed(page);

    // 切走。
    await openSessionsSidebar(page);
    await expandWorkspace(page, MAIN_WORKSPACE);
    await openWorkspaceSession(page, MAIN_WORKSPACE, 'Visual Sandbox (Main)');
    await expectSidebarClosed(page);

    // 再切回：回放旧轮完整 FIFO（含 result）+ 新轮 delta；实例 state 仍是 busy、turnRunning 仍是 true。
    await openSessionsSidebar(page);
    await expandWorkspace(page, ANOTHER_WORKSPACE);
    await openWorkspaceSession(page, ANOTHER_WORKSPACE, 'Orphan Mixed Session');
    await expectSidebarClosed(page);

    // 正对照：两轮内容都真的派发了（否则下面的断言是空过的）。
    await expect(page.locator('#messages')).toContainText('Mixed old-turn reply', { timeout: 10_000 });
    await expect(page.locator('#messages')).toContainText('Mixed new-turn chunk');

    // 核心断言 ①：轮次还在跑，运行条与停止钮必须都还在。修复前这里两条都红。
    await expect(page.locator('#streamLiveStatus')).toBeVisible();
    await expect(page.locator('#btnSend')).toHaveAttribute('data-mode', 'stop');

    // 核心断言 ②：回放对 live 行的【所有字段】中性，不只是 busy 布尔。这批回放里旧轮带了一条
    // thinking_delta，它绝不能渗进当前这一轮的 spinner——否则用户看到的是一个属于上一轮的思考计时
    // （formatCliSpinnerLine 的 thinking 段：进行中出 'thinking…'，已收尾出 'thought for Ns'）。
    // PR #38 review 第三轮 P2。
    await expect(page.locator('#streamLiveStatusText')).not.toContainText('thinking');
    await expect(page.locator('#streamLiveStatusText')).not.toContainText('thought for');

    await expectNoBrowserErrors(page);
  });

  // ⚠ 这里【缺一条】覆盖：真机那条最可能的路径——用户发消息后还没等到终止事件就切走，那条实时
  // result 被 shouldDropAgentEvent 按视图丢弃，_pendingSendBusySessionId 悬留，此后每次切回该会话
  // bindView 都拿这个过期 marker 假亮一次运行条（PR #38 review 第二轮指出，代码修复已在
  // clearBusyFromTurnEndEvent 与 startLiveTicker 两处落地）。
  //
  // 【为什么没有用例】写过一版，是假绿，已撤。注入旧行为后用反向断言实测：假亮**确实发生**，但它会在
  // 3～8 秒之间被某个东西自行清掉（不是看门狗也不是 ticker——那两条都要 30 秒宽限，而此处 turnStartTs
  // 就是切回时刻），而 toHaveCount(0) 的 8 秒轮询窗口正好把这段掩盖过去，于是注入前后一样绿。
  // 在查清那个清除者是谁之前，任何缩短 timeout 的写法都只是把断言压进一个来历不明的时间缝里。
  // 要补这条，先回答：切回后 3～8 秒之间是什么调用了 setBusy(false)。
});
