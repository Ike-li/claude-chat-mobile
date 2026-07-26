// spec: docs/testing.md
// helpers: tests/helpers/playwright.ts

import { test, expect, type Page } from '@playwright/test';
import { expectNoBrowserErrors, gotoMock, sendChatMessage } from '../../helpers/playwright';
import { ANOTHER_WORKSPACE, MAIN_WORKSPACE, expandWorkspace, expectSidebarClosed, openSessionsSidebar, openWorkspaceSession } from '../../helpers/p0-ui';

// 修「切到一个离开期间产生了很多聊天回复的会话时，从离开点逐条吐到最新（打字机效果）」：sync:since
// 是服务端先把该实例环形缓冲里离开期间攒的事件逐条 agent:event(replay:true) 发完才 ack；客户端在
// emit 'sync:since' 之前架起回放缓冲区（app.js + app/event-dispatch.js createReplayBuffer），命中的
// 事件先入队不渲染，ack 到达后按 resolveReplayBufferAction（logic.js）决定：
//   - 积压条数达到 REPLAY_BUFFER_RELOAD_THRESHOLD（100）→ 'reload'：丢弃缓冲，改走 session:history
//     的既有批量渲染路径（一次性 fragment + 单次落底）；
//   - 未达阈值 → 'flush'：按序正常派发缓冲事件，但抑制每条各自的滚动，派发完一次性强制落底。
//
// 断言"只落底一次/没有逐条吐"的方式（而非直接数 scrollBottom 调用次数，那是实现细节且难以从黑盒
// 稳定断言）：
//   1) 内容标记法——reload 与 flush 两条路径的"数据源"故意给了不同文案（mock 的 session:history
//      "磁盘权威内容" vs sync:since 回放的 165/21 条"live 内容"）。reload 场景只应看到磁盘内容、绝不
//      应看到任何一条 live 回放文案（证明缓冲队列被整批丢弃、从未逐条派发过，而不仅仅是"恰好没被
//      注意到"）；flush 场景则相反，应看到 live 内容与切走前的旧缓存内容共存（证明走的是增量派发、
//      DOM 没被清空重建）。这比数事件次数更贴近用户可观察的真实缺陷。
//   2) scrollTop 写次数法（辅助）——包一层 spy 在 #messages.scrollTop 的原生 setter 上（转发调用，
//      不影响真实滚动行为），只统计"实际发生了多少次滚动写入"。抑制生效时应只有个位数次（cache 恢复
//      落底 + 收尾强制落底，各 1-2 次）；若逐条吐消息，会话内几十条事件里大量 user_message/text_delta/
//      result handler 各自触发的滚动会显著推高这个数字。
//   3) 最终 scrollTop 距底部 <5px（沿用 switch-back-scroll.spec.ts 已验证的可靠判定）。
async function armScrollWriteCounter(page: Page) {
  await page.evaluate(() => {
    const el = document.querySelector('#messages') as HTMLElement;
    const desc = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
    const w = window as unknown as { __ccmScrollWrites?: number };
    w.__ccmScrollWrites = 0;
    if (!desc?.get || !desc?.set) return; // 拿不到原生描述符则跳过埋点，不影响其余断言
    const nativeGet = desc.get;
    const nativeSet = desc.set;
    Object.defineProperty(el, 'scrollTop', {
      configurable: true,
      get() { return nativeGet.call(el); },
      set(v: number) {
        w.__ccmScrollWrites = (w.__ccmScrollWrites || 0) + 1;
        nativeSet.call(el, v);
      },
    });
  });
}

async function readScrollWriteCount(page: Page) {
  return page.evaluate(() => (window as unknown as { __ccmScrollWrites?: number }).__ccmScrollWrites || 0);
}

async function distanceFromBottom(page: Page) {
  return page.evaluate(() => {
    const el = document.querySelector('#messages') as HTMLElement;
    return el.scrollHeight - el.scrollTop - el.clientHeight;
  });
}

test.describe('P0 回放缓冲：切会话/离开期间积压消息不逐条吐（打字机效果）', () => {
  test('P0-REPLAY-1 大量积压（165 条，超阈值）→ reload：清屏批量渲染，看不到任何一条被丢弃的 live 回放内容', async ({ page }) => {
    await gotoMock(page);

    // 1. 注册实例并首次冷切入（4 条基线，建立 DOM 缓存）。
    await sendChatMessage(page, 'test:replay-buffer-flood-setup');
    await openSessionsSidebar(page);
    await expandWorkspace(page, ANOTHER_WORKSPACE);
    await openWorkspaceSession(page, ANOTHER_WORKSPACE, 'Replay Flood Session');
    await expectSidebarClosed(page);
    await expect(page.locator('[data-testid="user-message"], [data-testid="assistant-message"]'))
      .toHaveCount(4, { timeout: 10_000 });

    // 2. 切回主会话（模拟"离开"）。
    await openSessionsSidebar(page);
    await expandWorkspace(page, MAIN_WORKSPACE);
    await openWorkspaceSession(page, MAIN_WORKSPACE, 'Visual Sandbox (Main)');
    await expectSidebarClosed(page);

    // 3. 再切回去：mock 这次会在 ack 之前先 emit 165 条 agent:event（55 轮 user_message+text_delta+
    // result），远超 REPLAY_BUFFER_RELOAD_THRESHOLD。装好落底次数探针后再触发这次切入。
    await armScrollWriteCounter(page);
    await openSessionsSidebar(page);
    await expandWorkspace(page, ANOTHER_WORKSPACE);
    await openWorkspaceSession(page, ANOTHER_WORKSPACE, 'Replay Flood Session');
    await expectSidebarClosed(page);

    // 核心断言 1：reload 分支的"磁盘权威内容"标记必须出现——证明真的清屏走了 session:history。
    const reloadMarker = page.locator('[data-testid="assistant-message"]', { hasText: 'Flood reload marker' });
    await expect(reloadMarker).toBeVisible({ timeout: 10_000 });

    // 核心断言 2：165 条缓冲事件里的 live 回放文案一条都不应该出现——它们应整批被丢弃，而不是被
    // 逐条派发到屏幕上（这正是用户报告的"打字机效果"的直接证据；若这条断言失败说明缓冲没生效）。
    await expect(page.locator('text=/Flood live reply #/')).toHaveCount(0);
    await expect(page.locator('text=/Flood live turn #/')).toHaveCount(0);

    // 核心断言 3：确实落底到真正的最新消息（沿用 switch-back-scroll.spec.ts 已验证的判定方式）。
    await expect.poll(() => distanceFromBottom(page), { timeout: 10_000 }).toBeLessThan(5);

    // 核心断言 4：整个切入过程只发生个位数次滚动写入（cache 恢复 1 次 + reload 批量渲染收尾 1 次，
    // 外加未读胶囊锚点定位等偶发的程序性滚动校正——阈值留够余量吸收这类边界抖动，实测偶发达到 6），
    // 远低于"165 条事件逐条各自触发滚动"会产生的数量级——佐证不是靠"侥幸没看见"过关。
    expect(await readScrollWriteCount(page)).toBeLessThanOrEqual(10);

    await expectNoBrowserErrors(page);
  });

  test('P0-REPLAY-2 少量积压（21 条，低于阈值）→ flush：正常增量渲染 + 抑制中间滚动，内容完整且顺序正确', async ({ page }) => {
    await gotoMock(page);

    // 1. 注册实例并首次冷切入（4 条基线，建立 DOM 缓存）。
    await sendChatMessage(page, 'test:replay-buffer-small-setup');
    await openSessionsSidebar(page);
    await expandWorkspace(page, ANOTHER_WORKSPACE);
    await openWorkspaceSession(page, ANOTHER_WORKSPACE, 'Replay Small Session');
    await expectSidebarClosed(page);
    await expect(page.locator('[data-testid="user-message"], [data-testid="assistant-message"]'))
      .toHaveCount(4, { timeout: 10_000 });

    // 2. 切回主会话（模拟"离开"）。
    await openSessionsSidebar(page);
    await expandWorkspace(page, MAIN_WORKSPACE);
    await openWorkspaceSession(page, MAIN_WORKSPACE, 'Visual Sandbox (Main)');
    await expectSidebarClosed(page);

    // 3. 再切回去：mock 这次会在 ack 之前先 emit 21 条 agent:event（7 轮 user_message+text_delta+
    // result），低于阈值。
    await armScrollWriteCounter(page);
    await openSessionsSidebar(page);
    await expandWorkspace(page, ANOTHER_WORKSPACE);
    await openWorkspaceSession(page, ANOTHER_WORKSPACE, 'Replay Small Session');
    await expectSidebarClosed(page);

    // 核心断言 1：flush 不清屏——切走前缓存的基线内容必须还在（证明 DOM 没被 clearView 抹掉重建）。
    await expect(page.getByText('Small baseline message #0')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Small baseline message #3')).toBeVisible();

    // 核心断言 2：flush 正常派发——21 条缓冲事件对应的 7 轮 live 内容应完整出现，且是最后一轮
    // （#6，seq 最大）而不是中途卡住，证明按到达顺序完整播放、没有半途而废。
    await expect(page.getByText('Small live turn #0')).toBeVisible();
    await expect(page.getByText('Small live reply #6 rendered via flush')).toBeVisible({ timeout: 10_000 });

    // 核心断言 3：不应该出现"reload 磁盘权威内容"的专属标记——证明没有误判成 reload 而多余清屏重载。
    await expect(page.locator('text=/reload marker/')).toHaveCount(0);

    // 核心断言 4：确实落底到真正的最新消息。
    await expect.poll(() => distanceFromBottom(page), { timeout: 10_000 }).toBeLessThan(5);

    // 核心断言 5：整个切入过程只发生个位数次滚动写入（cache 恢复 1 次 + flush 收尾强制落底 1-2 次，
    // 外加未读胶囊锚点定位等偶发的程序性滚动校正——阈值留够余量吸收这类边界抖动），而不是 21 条事件
    // 里的 user_message/text_delta/result 各自触发滚动累加出的数量级——直接验证"抑制中间滚动、只在
    // 收尾落底一次"这条要求，而不仅仅是内容顺序正确。
    expect(await readScrollWriteCount(page)).toBeLessThanOrEqual(10);

    await expectNoBrowserErrors(page);
  });
});
