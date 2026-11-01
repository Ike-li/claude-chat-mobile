// helpers: tests/helpers/playwright.ts
//
// #307「只有『加载了 N 条历史消息』提示条、下面没有气泡」。
// 历史是分块渲染的（每块 40 条）。长会话先画最近一段（2000 条里是 #1940 起的 60 条）、画完一次性插入，更早的那段
// 在空闲里画完再插到前面。最近一段没落地前中途放弃或某条抛错，都会停在只有提示条的样子。
//   · 已修的一条（1b/1d/1e）：分块没画完、或回执还在路上（只有加载卡）时切走或同会话换实例，这份半成品曾被存进
//     sessionDomCache，切回时原样贴回，sync:since 判 keep、不再拉历史。现在半成品不进缓存，切回会重新完整加载。
//   · 观测：中途放弃、某条抛错各记一条客户端日志（日志面板里看得到），带会话号、两个实例号、已渲染条数。
//   · 缓解：某条抛错停住时（根因未知），提示条上原地给「重新加载」，重新拉一次历史（不刷新整页），不重复渲染。

import { test, expect, type Page } from '@playwright/test';
import { expectNoBrowserErrors, gotoMock, sendChatMessage, waitForIdle } from '../../helpers/playwright';
import { MAIN_WORKSPACE, expandWorkspace, expectSidebarClosed, openSessionsSidebar, openWorkspaceSession } from '../../helpers/sidebar-ui';

const LONG_NOTICE = '仅显示最近 2000 条历史消息（共 2100 条），更早的没有加载';
const bubbles = (page: Page) => page.locator('#messages [data-testid="user-message"], #messages [data-testid="assistant-message"]');

async function openLongHistory(page: Page) {
  await openSessionsSidebar(page);
  await expandWorkspace(page, MAIN_WORKSPACE);
  await openWorkspaceSession(page, MAIN_WORKSPACE, 'Long History Session');
  await expectSidebarClosed(page);
}

async function consoleLogText(page: Page) {
  await page.locator('#btnConsole').click();
  await expect(page.locator('#consoleModal')).toBeVisible();
  return page.locator('#consoleLogArea');
}

function pageErrorsExcept(page: Page, injected: string) {
  return ((page as unknown as { __ccmErrors?: string[] }).__ccmErrors ?? []).filter(e => !e.includes(injected));
}

// 同时观察 polling 与 websocket，避免首连尚未升级时漏掉请求。
// 点击时并行发出的预取（payload.prefetch，Stage 3b）也算：长会话截顶也凭总条数核对得上，页面直接画它、不再拉第二次
// （history-prefetch.spec.ts 的 PF5），这里数的是页面真正拿来画的那几次
function captureHistoryLoads(page: Page, eventName = 'session:history') {
  const loads: Array<{ sessionId: string; instanceId?: string; prefetch?: boolean }> = [];
  const take = (payload: string) => {
    for (const packet of payload.split('\x1e')) {
      if (!packet.includes(JSON.stringify(eventName))) continue;
      loads.push(JSON.parse(packet.slice(packet.indexOf('[')))[1]);
    }
  };
  page.on('websocket', ws => ws.on('framesent', frame => { if (typeof frame.payload === 'string') take(frame.payload); }));
  page.on('request', req => { if (req.method() === 'POST' && req.url().includes('/socket.io/')) take(req.postData() || ''); });
  return loads;
}

type HistoryIdleGate = {
  __heldHistoryChunks: IdleRequestCallback[];
  __passHistoryChunks: boolean;
  __pendingHistoryChunks: number;
};

async function holdHistoryChunks(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as HistoryIdleGate;
    const original = window.requestIdleCallback.bind(window);
    w.__heldHistoryChunks = [];
    w.__passHistoryChunks = false;
    w.__pendingHistoryChunks = 0;
    window.requestIdleCallback = ((cb: IdleRequestCallback, opts?: IdleRequestOptions) => {
      if (!w.__passHistoryChunks) { w.__heldHistoryChunks.push(cb); return 0; }
      w.__pendingHistoryChunks++;
      return original(deadline => { w.__pendingHistoryChunks--; cb(deadline); }, opts);
    }) as typeof window.requestIdleCallback;
  });
}

async function releaseHistoryChunks(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as HistoryIdleGate;
    w.__passHistoryChunks = true;
    for (const cb of w.__heldHistoryChunks.splice(0)) cb({ didTimeout: false, timeRemaining: () => 0 } as IdleDeadline);
  });
  await expect.poll(() => page.evaluate(() => (window as unknown as HistoryIdleGate).__pendingHistoryChunks)).toBe(0);
}

async function expectCompleteLongHistory(page: Page) {
  await expect(page.locator('[data-testid="assistant-message"]', { hasText: 'Long history final message marker' })).toBeVisible({ timeout: 15_000 });
  await expect(bubbles(page)).toHaveCount(2000);
  await expect(page.locator('#messages').getByText(LONG_NOTICE)).toHaveCount(1);
  await expect(page.locator('#messages [data-testid="history-reload"]')).toHaveCount(0);
}

test.describe('#307 历史渲染停在提示条：观测与原地重新加载', () => {
  test('P0-HIST-STALL-1b 分块渲染途中同会话更换实例：记中断坐标，新实例自动重新加载出完整历史，不刷新页面', async ({ page }) => {
    const loads = captureHistoryLoads(page);
    const syncs = captureHistoryLoads(page, 'sync:since');
    const navigations: string[] = [];
    await gotoMock(page);
    page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigations.push(frame.url()); });
    await holdHistoryChunks(page);
    await openLongHistory(page);
    await expect.poll(() => page.evaluate(() => (window as unknown as HistoryIdleGate).__heldHistoryChunks.length)).toBeGreaterThan(0);
    await expect(bubbles(page)).toHaveCount(0);

    const response = await page.request.post('/__replace-history-instance');
    expect(response.ok(), '同会话实例置换夹具没有生效').toBe(true);
    const replacement = await response.json();
    expect(replacement.sessionId).toBe('mock-session-long-history');
    expect(replacement.instanceId).not.toBe(replacement.previousInstanceId);
    // 先等浏览器收到置换后的实例，再放旧回调；不靠 HTTP 请求与 socket 广播的到达顺序。
    await expect.poll(() => syncs.some(p => p.instanceId === replacement.instanceId && p.sessionId === replacement.sessionId)).toBe(true);
    await releaseHistoryChunks(page);

    // 半成品（只有提示条）不能被当成缓存贴回新实例，否则 sync:since 判 keep、不再拉历史
    await expectCompleteLongHistory(page);
    expect(loads.filter(p => p.sessionId === replacement.sessionId), '新实例应自动再拉一次历史').toHaveLength(2);
    const log = await consoleLogText(page);
    await expect(log).toContainText(`session=${replacement.sessionId} instance=${replacement.previousInstanceId}→${replacement.instanceId} 已渲染 40/2000`);
    await page.locator('#consoleClose').click();
    await expectCompleteLongHistory(page);
    expect(navigations, '重新加载历史不应刷新整页').toEqual([]);
    await expectNoBrowserErrors(page);
  });

  test('P0-HIST-STALL-1d 分块渲染途中切到别的会话再切回：重新加载出完整历史，不停在只有提示条', async ({ page }) => {
    const loads = captureHistoryLoads(page);
    await gotoMock(page);
    await holdHistoryChunks(page);
    await openLongHistory(page);
    await expect.poll(() => page.evaluate(() => (window as unknown as HistoryIdleGate).__heldHistoryChunks.length)).toBeGreaterThan(0);
    await expect(page.locator('#messages').getByText(LONG_NOTICE), '前提：提示条已插入').toHaveCount(1);
    await expect(bubbles(page), '前提：分块还没落地').toHaveCount(0);

    await openSessionsSidebar(page);
    await openWorkspaceSession(page, MAIN_WORKSPACE, 'Archived Planning Session');
    await expectSidebarClosed(page);
    await expect(page.locator('#messages')).toContainText('Summarize archived plan', { timeout: 10_000 });
    // 旧的分块在别的会话期间跑完：发现实例变了，整段作废
    await releaseHistoryChunks(page);

    await openSessionsSidebar(page);
    await openWorkspaceSession(page, MAIN_WORKSPACE, 'Long History Session');
    await expectSidebarClosed(page);
    await expectCompleteLongHistory(page);
    expect(loads.filter(p => p.sessionId === 'mock-session-long-history'), '切回时应重新拉历史').toHaveLength(2);
    await expectNoBrowserErrors(page);
  });

  test('P0-HIST-STALL-1e 历史回执还在路上就切到别的会话、回执作废后切回：重新加载出完整历史，不停在空白', async ({ page }) => {
    const loads = captureHistoryLoads(page);
    await gotoMock(page);
    await page.request.post('/__hold-next-history-ack');
    await openLongHistory(page);
    await expect(page.locator('#historyLoadingCard'), '前提：回执扣着，停在加载卡').toBeVisible();

    await openSessionsSidebar(page);
    await openWorkspaceSession(page, MAIN_WORKSPACE, 'Archived Planning Session');
    await expectSidebarClosed(page);
    await expect(page.locator('#messages')).toContainText('Summarize archived plan', { timeout: 10_000 });
    expect((await (await page.request.post('/__release-history-ack')).json()).released, '前提：长会话的回执一直扣着').toBe(1);
    // 看到作废日志，迟到的回执就处理完了：切回时不会被它碰巧补上
    const log = await consoleLogText(page);
    await expect(log).toContainText('上一轮历史回执迟到，已作废（之后又发起了新一轮加载） session=mock-session-long-history', { timeout: 10_000 });
    await page.locator('#consoleClose').click();

    await openSessionsSidebar(page);
    await openWorkspaceSession(page, MAIN_WORKSPACE, 'Long History Session');
    await expectSidebarClosed(page);
    await expectCompleteLongHistory(page);
    await expect(page.locator('#historyLoadingCard')).toHaveCount(0);
    expect(loads.filter(p => p.sessionId === 'mock-session-long-history'), '切回时应重新拉历史').toHaveLength(2);
    await expectNoBrowserErrors(page);
  });

  test('P0-HIST-STALL-1c 同会话新实例的重载已完成：旧续块不能再插入或给新提示条挂重试按钮', async ({ page }) => {
    const syncs = captureHistoryLoads(page, 'sync:since');
    await gotoMock(page);
    await holdHistoryChunks(page);
    await openLongHistory(page);
    await expect.poll(() => page.evaluate(() => (window as unknown as HistoryIdleGate).__heldHistoryChunks.length)).toBeGreaterThan(0);
    const response = await page.request.post('/__replace-history-instance');
    expect(response.ok()).toBe(true);
    const replacement = await response.json();
    expect(replacement.sessionId).toBe('mock-session-long-history');
    expect(replacement.instanceId).not.toBe(replacement.previousInstanceId);
    await expect.poll(() => syncs.some(p => p.instanceId === replacement.instanceId && p.sessionId === replacement.sessionId)).toBe(true);

    await page.evaluate(() => { (window as unknown as HistoryIdleGate).__passHistoryChunks = true; });
    await page.locator('#btnMore').click();
    await page.locator('#moreReloadSession').click();
    await expectCompleteLongHistory(page);
    await releaseHistoryChunks(page);
    await expectCompleteLongHistory(page);
    const log = await consoleLogText(page);
    await expect(log).toContainText(`session=${replacement.sessionId} instance=${replacement.previousInstanceId}→${replacement.instanceId} 已渲染 40/2000`);
    await page.locator('#consoleClose').click();
    await expectCompleteLongHistory(page);
    await expectNoBrowserErrors(page);
  });

  for (const scenario of [
    // 最近一段从 #1940 起：#1941 在同步跑的第一块里，#1981 在第二块里
    { id: '2b', index: 1941, rendered: 1, persistent: false, title: '第一块同步抛错' },
    { id: '2c', index: 1981, rendered: 41, persistent: true, title: '第二块持续抛错' },
  ]) {
    test(`P0-HIST-STALL-${scenario.id} ${scenario.title}：保留异常和精确进度，重试入口可再次使用`, async ({ page }) => {
      const failures: Array<{ message: string; stack?: string }> = [];
      page.on('pageerror', error => failures.push({ message: error.message, stack: error.stack }));
      await gotoMock(page);
      await page.evaluate(({ index, persistent }) => {
        const w = window as unknown as { marked: { parse: (s: string, ...rest: unknown[]) => string }; __restoreHistoryParse: () => void };
        const m = w.marked;
        const parse = m.parse;
        w.__restoreHistoryParse = () => { m.parse = parse; };
        let thrown = false;
        m.parse = function (this: unknown, src: string, ...rest: unknown[]) {
          if (src === `Long history stress message #${index}` && (persistent || !thrown)) {
            thrown = true;
            throw new Error('injected history assertion failure');
          }
          return parse.call(this, src, ...rest);
        };
      }, scenario);
      await openLongHistory(page);
      const reload = page.locator('#messages [data-testid="history-reload"]');
      await expect(reload).toBeVisible();
      await expect(bubbles(page)).toHaveCount(0);
      const log = await consoleLogText(page);
      await expect(log).toContainText(`渲染第 ${scenario.index + 1}/2000 条历史时抛错`);
      await expect(log).toContainText(`session=mock-session-long-history instance=inst_long_history 当前=inst_long_history 已渲染 ${scenario.rendered}/2000`);
      await expect(log).toContainText(/\[JS_ERROR\] (?:Uncaught Error: )?injected history assertion failure/);
      await expect.poll(() => failures.filter(e => e.message === 'injected history assertion failure').length).toBe(1);
      expect(failures[0].stack, '原异常的渲染堆栈不能被吞掉').toContain('processChunk');
      await page.locator('#consoleClose').click();

      await reload.click();
      if (scenario.persistent) {
        await expect.poll(() => failures.filter(e => e.message === 'injected history assertion failure').length).toBe(2);
        await expect(reload).toBeVisible();
        await expect(bubbles(page)).toHaveCount(0);
        await expect(page.locator('#messages').getByText(LONG_NOTICE)).toHaveCount(1);
        // 连续失败后先移除注入，再点原地重试：入口没有卡死，也没有用缺失正文冒充成功。
        await page.evaluate(() => {
          (window as unknown as { __restoreHistoryParse: () => void }).__restoreHistoryParse();
        });
        await reload.click();
      }
      await expectCompleteLongHistory(page);
      expect(pageErrorsExcept(page, 'injected history assertion failure')).toEqual([]);
    });
  }

  test('P0-HIST-STALL-2d 更早那段抛错：最近一段照常看得到，提示条仍算没画完，原地重新加载后恰好 2000 条', async ({ page }) => {
    await gotoMock(page);
    await page.evaluate(() => {
      const m = (window as unknown as { marked: { parse: (s: string, ...rest: unknown[]) => string } }).marked;
      const parse = m.parse;
      let thrown = false;
      m.parse = function (this: unknown, src: string, ...rest: unknown[]) {
        if (!thrown && src === 'Long history stress message #61') { thrown = true; throw new Error('injected render failure'); }
        return parse.call(this, src, ...rest);
      };
    });
    await openLongHistory(page);
    const reload = page.locator('#messages [data-testid="history-reload"]');
    await expect(reload).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-testid="assistant-message"]', { hasText: 'Long history final message marker' })).toBeVisible();
    await expect(bubbles(page), '最近一段已经插进去了，更早那段一条都没进来').toHaveCount(60);
    // 没画完的提示条不能让 bindView 把这份半成品存进缓存（#307）
    await expect(page.locator('#messages [data-history-pending]')).toHaveCount(1);

    const log = await consoleLogText(page);
    await expect(log).toContainText('渲染第 62/2000 条历史时抛错');
    await expect(log).toContainText('已渲染 121/2000');
    await page.locator('#consoleClose').click();

    await reload.click();
    await expectCompleteLongHistory(page);
    await expect(page.locator('#messages [data-history-pending]')).toHaveCount(0);
    expect(pageErrorsExcept(page, 'injected render failure')).toEqual([]);
  });

  test('P0-HIST-STALL-1 渲染第 2 块时切到别的会话：日志记下中途放弃，带会话号、两个实例号、已渲染条数', async ({ page }) => {
    await gotoMock(page);
    // 冻结分块调度：第一块同步画完后，第二块的回调攥在手里，切走之后再放（同 P0-LH3）
    await page.evaluate(() => {
      const w = window as unknown as { __frozenIdleCallback: IdleRequestCallback | null };
      w.__frozenIdleCallback = null;
      window.requestIdleCallback = ((cb: IdleRequestCallback) => {
        if (w.__frozenIdleCallback === null) w.__frozenIdleCallback = cb;
        return 0;
      }) as typeof window.requestIdleCallback;
    });
    await openLongHistory(page);
    await expect.poll(() => page.evaluate(() => (window as unknown as { __frozenIdleCallback: unknown }).__frozenIdleCallback !== null)).toBe(true);

    await openSessionsSidebar(page);
    await openWorkspaceSession(page, MAIN_WORKSPACE, 'Archived Planning Session');
    await expectSidebarClosed(page);
    await expect(page.locator('#messages')).toContainText('Summarize archived plan', { timeout: 10_000 });
    await page.evaluate(() => {
      const w = window as unknown as { __frozenIdleCallback: IdleRequestCallback | null };
      w.__frozenIdleCallback?.({ didTimeout: false, timeRemaining: () => 0 } as IdleDeadline);
    });

    const log = await consoleLogText(page);
    await expect(log).toContainText('[HISTORY_RENDER]');
    const line = (await log.innerText()).split('\n').find(l => l.includes('[HISTORY_RENDER]')) || '';
    expect(line, '没写会话号').toContain('mock-session-long-history');
    expect(line, '没写已渲染条数').toContain('40/2000');
    const ids = line.match(/instance=(\S+?)→(\S+?)(\s|$)/);
    expect(ids, `没写两个实例号：${line}`).not.toBeNull();
    expect(ids![1], '两个实例号应当不同').not.toBe(ids![2]);
  });

  test('P0-HIST-STALL-2 最近一段第 2 块里的一条渲染抛错：日志记下是哪条、带齐字段；提示条上点「重新加载」后消息完整恢复，不重复', async ({ page }) => {
    await gotoMock(page);
    // #1981（最近一段的第 2 块里）让 marked.parse 抛一次：之后照常，好让「重新加载」那一趟画得出来
    await page.evaluate(() => {
      const m = (window as unknown as { marked: { parse: (s: string, ...rest: unknown[]) => string } }).marked;
      const parse = m.parse;
      let thrown = false;
      m.parse = function (this: unknown, src: string, ...rest: unknown[]) {
        if (!thrown && src === 'Long history stress message #1981') { thrown = true; throw new Error('injected render failure'); }
        return parse.call(this, src, ...rest);
      };
    });
    await openLongHistory(page);
    await expect(page.locator('#messages')).toContainText(LONG_NOTICE, { timeout: 15_000 });
    const reload = page.locator('#messages [data-testid="history-reload"]');
    await expect(reload, '停在只有提示条时没有原地「重新加载」').toBeVisible();
    await expect(bubbles(page), '前提：注入后停在只有提示条').toHaveCount(0);

    const log = await consoleLogText(page);
    await expect(log).toContainText('[HISTORY_RENDER]');
    const line = (await log.innerText()).split('\n').find(l => l.includes('[HISTORY_RENDER]')) || '';
    expect(line, '没写是第几条').toContain('第 1982/2000 条');
    expect(line, '没写会话号').toContain('mock-session-long-history');
    expect(line, '没写已渲染条数').toContain('已渲染 41/2000');
    expect(line, '没写错误原文').toContain('injected render failure');
    expect(line, `没写两个实例号：${line}`).toMatch(/instance=\S+ 当前=\S+/);
    await page.locator('#consoleClose').click();

    await reload.click();
    await expect(page.locator('[data-testid="assistant-message"]', { hasText: 'Long history final message marker' })).toBeVisible({ timeout: 15_000 });
    await expect(bubbles(page), '重新加载后条数不对（丢了或重复了）').toHaveCount(2000);
    await expect(page.locator('#messages').getByText(LONG_NOTICE), '提示条重复了').toHaveCount(1);
    await expect(reload, '恢复之后不该还挂着「重新加载」').toHaveCount(0);
    expect(pageErrorsExcept(page, 'injected render failure')).toEqual([]);
  });

  // 原地按钮只挂在已知的两处停下的地方上；别的路径（正文假设 3）停住时，靠顶栏「⋯」里常驻的那一项
  test('P0-HIST-STALL-3 顶栏「⋯」→「重新加载本会话」：停住后同样能恢复、不重复；没打开会话时这一项不可点', async ({ page }) => {
    await gotoMock(page);
    await page.locator('#btnHome').click();
    await expect(page.locator('#messages')).toHaveClass(/empty-start/);
    await page.locator('#btnMore').click();
    await expect(page.locator('#moreModal')).toBeVisible();
    await expect(page.locator('#moreReloadSession'), '首页没有会话，不该能点').toBeDisabled();
    await page.locator('#moreCancel').click();
    await expect(page.locator('#moreModal')).toBeHidden();

    await page.evaluate(() => {
      const m = (window as unknown as { marked: { parse: (s: string, ...rest: unknown[]) => string } }).marked;
      const parse = m.parse;
      let thrown = false;
      m.parse = function (this: unknown, src: string, ...rest: unknown[]) {
        if (!thrown && src === 'Long history stress message #1981') { thrown = true; throw new Error('injected render failure'); }
        return parse.call(this, src, ...rest);
      };
    });
    await openLongHistory(page);
    await expect(page.locator('#messages')).toContainText(LONG_NOTICE, { timeout: 15_000 });
    await expect(bubbles(page), '前提：注入后停在只有提示条').toHaveCount(0);

    await page.locator('#btnMore').click();
    await page.locator('#moreReloadSession').click();
    await expect(page.locator('#moreModal')).toBeHidden();
    await expect(page.locator('[data-testid="assistant-message"]', { hasText: 'Long history final message marker' })).toBeVisible({ timeout: 15_000 });
    await expect(bubbles(page), '重新加载后条数不对（丢了或重复了）').toHaveCount(2000);
    await expect(page.locator('#messages').getByText(LONG_NOTICE), '提示条重复了').toHaveCount(1);
    expect(pageErrorsExcept(page, 'injected render failure')).toEqual([]);
  });

  // #354 review：手动重新加载时实例没变，上一轮还在分块渲染的话，实例守卫拦不住它——画完会把自己那份也插进来
  test('P0-HIST-STALL-4 长历史还在分块渲染时从「⋯」重新加载：上一轮作废，不会和新一轮叠成两份', async ({ page }) => {
    await gotoMock(page);
    // 三段式调度：先全部攥住（上一轮停在第 2 块）→ 放行新排的（重新加载那一轮照常画完）→ 再把攥住的放出去，
    // 数着还没跑的空闲回调，等它们清空再数气泡，不靠固定等待
    await page.evaluate(() => {
      const w = window as unknown as { __held: IdleRequestCallback[]; __passThrough: boolean; __idlePending: number };
      const original = window.requestIdleCallback.bind(window);
      w.__held = [];
      w.__passThrough = false;
      w.__idlePending = 0;
      window.requestIdleCallback = ((cb: IdleRequestCallback, opts?: IdleRequestOptions) => {
        if (!w.__passThrough) { w.__held.push(cb); return 0; }
        w.__idlePending++;
        return original(deadline => { w.__idlePending--; cb(deadline); }, opts);
      }) as typeof window.requestIdleCallback;
    });
    await openLongHistory(page);
    await expect(page.locator('#messages')).toContainText(LONG_NOTICE, { timeout: 15_000 });
    await expect.poll(() => page.evaluate(() => (window as unknown as { __held: unknown[] }).__held.length)).toBeGreaterThan(0);
    await expect(bubbles(page), '前提：上一轮停在半路，还没插入').toHaveCount(0);

    await page.evaluate(() => { (window as unknown as { __passThrough: boolean }).__passThrough = true; });
    await page.locator('#btnMore').click();
    await page.locator('#moreReloadSession').click();
    await expect(page.locator('[data-testid="assistant-message"]', { hasText: 'Long history final message marker' })).toBeVisible({ timeout: 15_000 });
    await expect(bubbles(page)).toHaveCount(2000);

    await page.evaluate(() => {
      const w = window as unknown as { __held: IdleRequestCallback[] };
      for (const cb of w.__held.splice(0)) cb({ didTimeout: false, timeRemaining: () => 0 } as IdleDeadline);
    });
    await expect.poll(() => page.evaluate(() => (window as unknown as { __idlePending: number }).__idlePending), { timeout: 15_000 }).toBe(0);
    await expect(bubbles(page), '上一轮画完又插了一份').toHaveCount(2000);
    await expect(page.locator('#messages').getByText(LONG_NOTICE), '提示条重复了').toHaveCount(1);
    expect((page as unknown as { __ccmErrors?: string[] }).__ccmErrors ?? []).toEqual([]);
  });

  test('P0-HIST-STALL-4b 历史回执还在路上就从「⋯」重新加载：迟到的上一份回执作废并记日志，提示条不重复', async ({ page }) => {
    await gotoMock(page);
    await page.request.post('/__hold-next-history-ack');
    await openLongHistory(page);
    await expect(page.locator('#moreReloadSession')).toBeAttached();

    await page.locator('#btnMore').click();
    await page.locator('#moreReloadSession').click();
    await expect(page.locator('[data-testid="assistant-message"]', { hasText: 'Long history final message marker' })).toBeVisible({ timeout: 15_000 });
    await expect(bubbles(page)).toHaveCount(2000);

    expect((await (await page.request.post('/__release-history-ack')).json()).released, '前提：第一份回执一直扣着').toBe(1);
    // 日志与作废在同一个回调里：看到这一行，迟到的回执就已经处理完了，再数提示条不会抢跑
    const log = await consoleLogText(page);
    await expect(log).toContainText('上一轮历史回执迟到，已作废', { timeout: 10_000 });
    await page.locator('#consoleClose').click();
    await expect(page.locator('#messages').getByText(LONG_NOTICE), '迟到的回执又插了一条提示条').toHaveCount(1);
    await expect(bubbles(page)).toHaveCount(2000);
    expect((page as unknown as { __ccmErrors?: string[] }).__ccmErrors ?? []).toEqual([]);
  });

  // #354 review：重新加载会 clearView（连审批 / 提问卡一起清），而 session:history 不带待办——得像重连那条路一样，
  // 画完后用 sync:since 回执里的 pending 快照补回来，否则服务端还在等批、手机上却没了卡
  test('P0-HIST-STALL-5 有待审批时从「⋯」重新加载：审批卡按服务端快照补回来，不会凭空消失', async ({ page }) => {
    await gotoMock(page);
    await sendChatMessage(page, 'test:tab');
    await waitForIdle(page);
    await sendChatMessage(page, 'test:pendingsnapshot');
    await expect(page.locator('#permModal')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#permInput')).toContainText('rm -rf /tmp/stale');

    // 审批挂起时顶栏抬在 sheet 之上（body.nav-escape），「⋯」点得到
    await page.locator('#btnMore').click();
    await page.locator('#moreReloadSession').click();
    await expect(page.locator('#moreModal')).toBeHidden();
    await expect(page.locator('#historyLoadingCard'), '前提：重新加载那一趟走完').toHaveCount(0, { timeout: 15_000 });
    await expect(page.locator('#permModal'), '重新加载后审批卡没了').toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#permInput')).toContainText('rm -rf /tmp/stale');
    await expectNoBrowserErrors(page);
  });
});
