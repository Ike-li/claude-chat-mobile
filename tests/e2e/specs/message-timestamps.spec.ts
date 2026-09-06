// helpers: tests/helpers/playwright.ts

import { test, expect } from '@playwright/test';
import { ensureComposerReady, expectNoBrowserErrors, gotoMock, sendChatMessage } from '../../helpers/playwright';
import { MAIN_WORKSPACE, expandWorkspace, openSessionsSidebar, openWorkspaceSession } from '../../helpers/p0-ui';

// 消息流时间戳（稀疏式）：跨天插日期分隔行，用户发言间隔 ≥5 分钟插一次 HH:mm。
// 只作用于主链 user/assistant 气泡；工具卡 / thinking / 子 agent 正文 / 系统条一律不夹。
// 判定规则与文案的穷举在 tests/unit/logic-message-timeline.test.mjs，这里只验端到端接线。
//
// fixture「Timeline Session」的 9 条消息跨前天/昨天/今天，逐条期望见 mock/server.js 的注释。
// 期望不硬编码日历串：fixture 按「相对今天」构造，「前天」的 label 每天都变（跨年还会带年份），
// 只断 data-marker-kind 与「今天 / 昨天」这两个稳定标签。

const markers = '[data-testid="msg-time-marker"]';

async function openTimelineSession(page: import('@playwright/test').Page) {
  await openSessionsSidebar(page);
  await expandWorkspace(page, MAIN_WORKSPACE);
  await openWorkspaceSession(page, MAIN_WORKSPACE, 'Timeline Session');
  await expect(page.locator('#messages')).toContainText('Timeline today follow-up', { timeout: 10_000 });
}

test.describe('P0 日常零 token Mock UI 回归', () => {
  test('P0-TS1 历史回放：跨天插日期行，同轮与短间隔不重复插', async ({ page }) => {
    await gotoMock(page);
    await openTimelineSession(page);

    // 3 个 day（首条 / 跨午夜的 assistant / 今天第一条）+ 2 个 time（昨晚 22:00 / 今天 08:30）
    await expect(page.locator(markers)).toHaveCount(5);
    const kinds = await page.locator(markers).evaluateAll(
      ns => ns.map(n => (n as HTMLElement).dataset.markerKind));
    expect(kinds).toEqual(['day', 'day', 'time', 'day', 'time']);

    const texts = await page.locator(markers).allTextContents();
    expect(texts[1]).toContain('昨天');   // assistant 跨午夜 → day 行不受同轮抑制
    expect(texts[2]).toBe('22:00');       // 同属昨天 → 只能是 time，「昨天」已被上一行消耗
    expect(texts[3]).toContain('今天');
    expect(texts[4]).toBe('08:30');

    await expectNoBrowserErrors(page);
  });

  test('P0-TS2 时间行只夹主链气泡，且同轮的 Claude 回复不触发', async ({ page }) => {
    await gotoMock(page);
    await openTimelineSession(page);

    // 每个 marker 的下一个兄弟必须是主链气泡。判据用 data-top-level 而不是 data-testid——
    // 离线占位气泡（app.js send()）没有 testid，只有 topLevel 才三条创建路径全覆盖。
    const nextSiblings = await page.locator(markers).evaluateAll(
      ns => ns.map(n => (n.nextElementSibling as HTMLElement | null)?.dataset.topLevel ?? null));
    expect(nextSiblings).toEqual(['1', '1', '1', '1', '1']);

    // 子 agent 卡内部不得出现时间行（那条正文走 appendNode 进卡片 body，不经接线点）
    await expect(page.locator(`.sa-body ${markers}`)).toHaveCount(0);
    // 工具卡自身也不带戳，故不会推进判定基准
    await expect(page.locator(`details.toolcard[data-ts]`)).toHaveCount(0);

    // 同轮抑制：今天 08:00 提问 → 08:20 回复（超 5 分钟阈值）不得插行，
    // 否则长回合下几乎每轮一行，稀疏方案退化成「每条都显」。
    const beforeLongReply = await page.evaluate(() => {
      const bubbles = [...document.querySelectorAll('[data-testid="assistant-message"]')];
      const target = bubbles.find(b => b.textContent?.includes('long-turn reply'));
      return (target?.previousElementSibling as HTMLElement | null)?.dataset.markerKind ?? null;
    });
    expect(beforeLongReply).toBeNull();

    await expectNoBrowserErrors(page);
  });

  test('P0-TS3 实时发送打戳，切走再切回后时间行不重复也不丢失', async ({ page }) => {
    await gotoMock(page);
    await openTimelineSession(page);

    const before = await page.locator(markers).count();
    const stamped = await page.locator('#messages > [data-ts]').count();
    expect(stamped).toBeGreaterThan(0);

    // 离开再回来：sessionDomCache 存的是整棵 #messages 子树，marker 作为普通节点随气泡来回。
    // 中转用「点 ＋ 回空首页」（session:new）而不是切到另一个会话——本用例是全 P0 里在 P0-13
    // 之前唯一会在单个 test 内反复开侧栏切会话的，实测那种走法会在 100+ 用例的长序列里让后面的
    // P0-13 翻车（P0-13 依赖「停止→立刻再发」的时序窗口）。回首页同样走 bindView 存取缓存，
    // 验证目标不变，但不往 mock 的实例表里反复折腾。
    await page.locator('#btnNew').click();
    await expect(page.locator('#messages')).toHaveClass(/empty-start/);

    await openTimelineSession(page);
    await expect(page.locator(markers)).toHaveCount(before);
    await expect(page.locator('#messages > [data-ts]')).toHaveCount(stamped);

    await expectNoBrowserErrors(page);
  });

  // 「用信封 ts 而不是客户端 Date.now()」是本功能的关键决策：sync:since 补发的是环形缓冲里的旧信封，
  // 若按当下时刻记，离开三小时后切回的那整批消息会全部盖成「现在」——跨天分隔不出现、HH:mm 全错，
  // 而刷新页面后同一批消息改从磁盘 timestamp 渲染，时间当场变了。这条用 26 小时前的信封守住它。
  test('P0-TS5 信封 ts 保真：跨天的补发事件显示「昨天」而非「今天」', async ({ page }) => {
    await gotoMock(page);
    await ensureComposerReady(page);
    await sendChatMessage(page, 'test:stale-ts');

    // 触发消息自己带当下时刻（第一个 marker 是「今天」），跨天那条是随后补发的第二个 marker。
    // 客户端若用 Date.now() 顶替信封 ts，补发的两条都算「今天」→ 第二个 marker 根本不会出现。
    await expect(page.locator(markers)).toHaveCount(2, { timeout: 10_000 });
    await expect(page.locator(markers).nth(1)).toContainText('昨天');

    await expectNoBrowserErrors(page);
  });

  // 只读镜像的增量追平：每批 history_append 都进一个新的空 fragment 再插入 #messages。
  // 判定基准必须能从空 frag 回落读 #messages 的尾巴，否则每批都被当成「会话首条」各插一条日期行。
  test('P0-TS6 镜像增量追加：跨批次基准连续，不会每批各插一条日期行', async ({ page }) => {
    await gotoMock(page);
    await ensureComposerReady(page);
    await sendChatMessage(page, 'test:history-append-ts');

    await expect(page.locator('#messages')).toContainText('Mirror batch three', { timeout: 10_000 });

    // 逐条推演（触发本场景的那条消息 ts 是当下，镜像追平读的是磁盘历史、必然更早）：
    //   触发消息 今天当下  → day   会话首条
    //   批一 昨天 21:00   → 无    早于上一条 → 规则3「时间倒流不插行」，但仍打 data-ts
    //   批二 昨天 21:01   → 无    ★ 靠回落读到批一的戳才判成「同日 1 分钟」；回落一失效就成了
    //                             prevTs==null → 会被当作会话首条而插一条 day 行
    //   批三 今天 08:00   → day   相对批二跨天
    await expect(page.locator(markers)).toHaveCount(2);
    const kinds = await page.locator(markers).evaluateAll(
      ns => ns.map(n => (n as HTMLElement).dataset.markerKind));
    expect(kinds).toEqual(['day', 'day']);

    // 三批的气泡都要打上戳——批一虽因倒流不插行，但必须打戳，否则批二的回落就读不到基准
    await expect(page.locator('#messages > [data-ts]')).toHaveCount(4);

    // 批二气泡前面不得有 marker
    const beforeBatchTwo = await page.evaluate(() => {
      const el = [...document.querySelectorAll('[data-testid="assistant-message"]')]
        .find(n => n.textContent?.includes('Mirror batch two'));
      return (el?.previousElementSibling as HTMLElement | null)?.dataset.markerKind ?? null;
    });
    expect(beforeBatchTwo).toBeNull();

    await expectNoBrowserErrors(page);
  });

  test('P0-TS4 英文界面显示 Today / Yesterday，不残留中文日期', async ({ page }) => {
    // 语言在页面脚本启动时就要读到（resolveInitialLang），故用 addInitScript 而非 evaluate
    await page.addInitScript(() => localStorage.setItem('ccm_lang', 'en'));
    await gotoMock(page);

    await openTimelineSession(page);
    const texts = (await page.locator(markers).allTextContents()).join(' | ');
    expect(texts).toContain('Today');
    expect(texts).toContain('Yesterday');
    expect(texts).not.toContain('今天');
    expect(texts).not.toContain('昨天');

    await expectNoBrowserErrors(page);
  });
});
