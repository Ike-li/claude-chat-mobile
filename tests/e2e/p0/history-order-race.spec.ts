// spec: docs/testing.md
// helpers: tests/helpers/playwright.ts

import { test, expect } from '@playwright/test';
import { ensureComposerReady, expectNoBrowserErrors, gotoMock, sendChatMessage } from '../../helpers/playwright';
import { MAIN_WORKSPACE, expandWorkspace, openSessionsSidebar, openWorkspaceSession } from '../../helpers/p0-ui';

// 「拉历史在途时镜像追平插队」的 DOM 顺序竞态。
//
// loadHistory 是异步的：发 session:history → 等 ack → renderHistoryBubbles 分块渲染（chunk=40、
// idle timeout=200ms，2000 条约 50 块，最坏可达秒级）→ 最后一次性把 fragment 插入 #messages。
// 这整段窗口里，server 的 catchUpTick（mirror-engine 常态 2500ms 一轮）完全可能检出终端刚落定的
// 消息并推 history_append —— 它是 out-of-band，不进 replay buffer（见 event-dispatch.js 的
// DEFAULT_REPLAY_OOB_TYPES），也就是说 buffer 挡不住它，任何时候都直接渲染。
//
// 于是增量先落地、历史后落地。若历史只会 appendChild 到尾部，用户看到的就是
// 「新消息在最上面、整段旧历史堆在它下面」。这是 ccm 核心场景（终端里跑、手机上看）够得着的。
test.describe('P0 日常零 token Mock UI 回归', () => {
  test('P0-ORDER 拉历史在途时到达的镜像增量，必须排在这批历史之后', async ({ page }) => {
    await gotoMock(page);
    await ensureComposerReady(page);
    await sendChatMessage(page, 'test:arm-history-order-race');

    await openSessionsSidebar(page);
    await expandWorkspace(page, MAIN_WORKSPACE);
    await openWorkspaceSession(page, MAIN_WORKSPACE, 'Timeline Session');

    // 两者都得在：历史本体 + 窗口期插队的增量
    await expect(page.locator('#messages')).toContainText('Timeline today follow-up', { timeout: 10_000 });
    await expect(page.locator('#messages')).toContainText('RACE_LATE_ARRIVAL');

    // 核心断言：按 DOM 顺序，插队的增量必须排在整批历史【之后】
    const order = await page.evaluate(() => {
      const bubbles = [...document.querySelectorAll('#messages > [data-top-level="1"]')];
      const idxRace = bubbles.findIndex(b => b.textContent?.includes('RACE_LATE_ARRIVAL'));
      const idxLastHistory = bubbles.map(b => b.textContent || '')
        .reduce((acc, t, i) => (t.includes('Timeline ') ? i : acc), -1);
      return { idxRace, idxLastHistory, total: bubbles.length };
    });
    expect(order.idxRace).toBeGreaterThan(-1);
    expect(order.idxLastHistory).toBeGreaterThan(-1);
    expect(order.idxRace).toBeGreaterThan(order.idxLastHistory);

    // 光把气泡挪对位置不够：marker 必须相对【最终顺序】的上一条主链气泡重新判定。
    // 插队消息到达时 #messages 刚被 clearView 清空，若拿那一刻的空 DOM 算，它会命中
    // 「会话首条」规则而带上一条 day 行——于是同一天出现两条日期分隔，看起来像会话
    // 在这里重新开始了。这条断言锁死「顺序与打戳原子一致」。
    const dayTexts = await page.locator('[data-marker-kind="day"]').allTextContents();
    const todayCount = dayTexts.filter(t => t.includes('今天')).length;
    expect(todayCount, `同一天只该有一条日期分隔，实得 ${JSON.stringify(dayTexts)}`).toBe(1);

    // 插队消息（今天 08:40）与它前一条历史（今天 08:30）同日、user、间隔 10 分钟 ≥ 阈值
    // → 必须是 time 行。这里断言 toBe('time') 而不是 not.toBe('day')：后者对「压根没有 marker」
    // 的 null 也成立，是个假绿口子——竞态消息若被判成时间倒流而不插行，就悄悄溜过去了。
    const markerBeforeRace = await page.evaluate(() => {
      const el = [...document.querySelectorAll('#messages > [data-top-level="1"]')]
        .find(n => n.textContent?.includes('RACE_LATE_ARRIVAL'));
      const prev = el?.previousElementSibling as HTMLElement | null;
      return prev?.dataset.markerKind ?? null;
    });
    expect(markerBeforeRace).toBe('time');

    await expectNoBrowserErrors(page);
  });
});
