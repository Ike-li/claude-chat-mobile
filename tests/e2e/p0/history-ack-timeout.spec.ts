// helpers: tests/helpers/playwright.ts

import { test, expect } from '@playwright/test';
import { ensureComposerReady, expectNoBrowserErrors, gotoMock, sendChatMessage } from '../../helpers/playwright';
import { MAIN_WORKSPACE, expandWorkspace, openSessionsSidebar, openWorkspaceSession } from '../../helpers/p0-ui';

// 「session:history 的 ACK 失败」这条早退路径，不该顺手丢掉窗口期已经扣住的镜像追平。
//
// 拉历史在途期间，historyLoadGate 会把到达的 history_append 扣住（顺序/打戳竞态，见 history-order-race.spec.ts）。
// 这些事件是 out-of-band 的单程票：不进 replay buffer，server 的 catch-up 基线又已前移，客户端手上
// 就这一份副本。于是 err 分支怎么收尾就成了消息存亡问题——abort 是丢弃，release+drain 才是放行。
//
// 关键在于 ACK 失败 ≠ 视图已切走：15s 超时触发时连接常常还活着，用户还盯着这个会话，
// 那些被扣住的增量仍然属于当前视图。旧代码无条件 abort，表现为「终端在跑、手机上少了几条」，
// 而且没有任何报错——直到用户重进会话或刷新才补上。
//
// 【为什么必须真等 15s】用断线来更快触发 err 是行不通的：断线会引发重连 + 全量历史加载，
// 那条消息会从别的路径回到页面上，用例就假绿了。要锁的恰恰是「连接未断的纯 ACK 超时」这一格。
// 【为什么看门狗救不了】abort() 内部会 disarm 闸门的 20s 兜底定时器，所以旧代码下这条消息是
// 真的永久消失，不是「晚 5s 出现」——本用例因此对修复前后有确定的区分度。
test.describe('P0 日常零 token Mock UI 回归', () => {
  test('P0-ACK-TIMEOUT 历史 ACK 超时后，窗口期扣住的镜像增量必须放行而非丢弃', async ({ page }) => {
    test.setTimeout(60_000); // 前端 HISTORY_ACK_TIMEOUT_MS = 15s，压不下去，理由见上
    await gotoMock(page);
    await ensureComposerReady(page);
    await sendChatMessage(page, 'test:arm-history-ack-timeout');

    await openSessionsSidebar(page);
    await expandWorkspace(page, MAIN_WORKSPACE);
    await openWorkspaceSession(page, MAIN_WORKSPACE, 'Timeline Session');

    // 核心断言：历史本体永不到达，这条增量只能靠 err 分支放行才会落地。
    await expect(page.locator('#messages')).toContainText('ACK_TIMEOUT_HELD_APPEND', { timeout: 30_000 });

    // 防假绿：确认历史本体确实没回来。否则这条消息可能是被一次正常的历史加载顺带带出来的，
    // 那样测的就不是 err 分支了。'Timeline today follow-up' 是同一 fixture 的历史文案。
    await expect(page.locator('#messages')).not.toContainText('Timeline today follow-up');

    await expectNoBrowserErrors(page);
  });
});
