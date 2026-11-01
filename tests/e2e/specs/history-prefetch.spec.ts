// helpers: tests/helpers/playwright.ts

import { test, expect, type Locator, type Page } from '@playwright/test';
import { expectNoBrowserErrors, gotoMock } from '../../helpers/playwright';
import { MAIN_WORKSPACE, expandWorkspace, expectSidebarClosed, openSessionsSidebar, openWorkspaceSession } from '../../helpers/sidebar-ui';

// 性能改造 Stage 3b：点开非活会话时，session:history 在点击那一刻和 session:switch 并行发出
// （app/public/js/app/history-prefetch.js），不再排在切换回执、instances 广播、sync:since 三段往返之后。
// bindView 拿到 sync:since 的 diskLen 后，条数对得上就直接画预取那份，对不上照常重新拉（prefetchedHistoryFits）；
// 磁盘到了截顶线（2000 条）条数恒等，改比 sync:since 的 diskTotal 与预取回执的 total（削顶前的总条数）。
// mock 的长会话默认按截顶摆（2000 条、total 2100），PF1–PF3 用 /__arm-uncapped-long-history 改成 1999 条。
// 不测什么：判据本身的各个分支（变长、变短、diskLen 为空、旧 server 不报 diskTotal、失败）在
// tests/unit/logic-history-prefetch.test.mjs；
// 凭打开凭据认领（A→B→A、后点顶掉先点）在 tests/unit/frontend-history-prefetch.test.mjs。
// mock 只有长会话的 sync:since 报 diskLen，其余会话的预取一律回空、判作废（见 mock 的 session:history）。

const LONG = 'mock-session-long-history';
const UNCAPPED = 1999;
const bubbles = (page: Page) => page.locator('#messages [data-testid="user-message"], #messages [data-testid="assistant-message"]');
const finalMarker = (page: Page) => page.locator('[data-testid="assistant-message"]', { hasText: 'Long history final message marker' });

// 同时观察 polling 与 websocket，避免首连尚未升级时漏掉请求（同 history-render-stall.spec.ts）
function captureHistoryLoads(page: Page) {
  const loads: Array<{ sessionId: string; cwd?: string; prefetch?: boolean }> = [];
  const take = (payload: string) => {
    for (const packet of payload.split('\x1e')) {
      if (packet.includes('"session:history"')) loads.push(JSON.parse(packet.slice(packet.indexOf('[')))[1]);
    }
  };
  page.on('websocket', ws => ws.on('framesent', frame => { if (typeof frame.payload === 'string') take(frame.payload); }));
  page.on('request', req => { if (req.method() === 'POST' && req.url().includes('/socket.io/')) take(req.postData() || ''); });
  return loads;
}

// 打开会话的 [PERF] 行（client_perf），机主「复制全部」导出的就是这些。读控制台面板（内存缓冲、开着时实时追加）：
// localStorage 那份落盘有 2s 节流，刚写的一行可能还没落
async function openConsole(page: Page) {
  await page.locator('#btnConsole').click();
  await expect(page.locator('#consoleModal')).toBeVisible();
  return page.locator('#consoleLogArea');
}
const perfRows = (log: Locator, text: RegExp) => log.locator(':scope > div', { hasText: text });

async function clickLongHistoryInSidebar(page: Page) {
  await openSessionsSidebar(page);
  await expandWorkspace(page, MAIN_WORKSPACE);
  await openWorkspaceSession(page, MAIN_WORKSPACE, 'Long History Session');
  await expectSidebarClosed(page);
}

test.describe('Stage 3b 点开非活会话时并行预取历史', () => {
  test('P0-PREFETCH-1 切换回执还没回来，历史已经在拉；sync:since 报的条数对得上就直接画，不再拉第二次', async ({ page }) => {
    const loads = captureHistoryLoads(page);
    await gotoMock(page);
    await page.request.post('/__arm-uncapped-long-history');
    await page.request.post('/__hold-next-switch');
    await clickLongHistoryInSidebar(page);

    await expect.poll(() => loads.filter(p => p.sessionId === LONG).length, '切换回执扣着的时候历史就该发出去了').toBe(1);
    expect(loads[loads.length - 1].prefetch, '点击时发出的那次应带预取标记').toBe(true);
    expect((await (await page.request.post('/__release-switch')).json()).released, '前提：切换一直扣着').toBe(1);

    await expect(finalMarker(page)).toBeVisible({ timeout: 15_000 });
    await expect(bubbles(page)).toHaveCount(UNCAPPED);
    expect(loads.filter(p => p.sessionId === LONG), '预取对得上还重新拉了一次').toHaveLength(1);
    // 预取的回执记在这次点击的打开上，只记一次（冷启动那次「视图切入」不能沾上它）
    const log = await openConsole(page);
    const prefetchRows = perfRows(log, /历史回执 \+\d+（预取；1999 条/);
    await expect(prefetchRows, '历史回执一段应标明用的是预取那份，且只有一行').toHaveCount(1, { timeout: 10_000 });
    await expect(prefetchRows, '预取记到了别的那次打开上').toContainText('[PERF] 打开会话');
    await expect(prefetchRows).toContainText('（点击）');
    await page.locator('#consoleClose').click();
    await expectNoBrowserErrors(page);
  });

  test('P0-PREFETCH-2 预取读完终端又写了：sync:since 报的条数对不上，照常重新拉，画的是新的那份', async ({ page }) => {
    const loads = captureHistoryLoads(page);
    await gotoMock(page);
    await page.request.post('/__arm-uncapped-long-history');
    await page.request.post('/__arm-stale-long-history');
    await clickLongHistoryInSidebar(page);

    await expect(finalMarker(page)).toBeVisible({ timeout: 15_000 });
    await expect(bubbles(page)).toHaveCount(UNCAPPED);
    await expect(page.locator('#messages').getByText('STALE_PREFETCH_MUST_NOT_APPEAR'), '画了过期的预取').toHaveCount(0);
    const longLoads = loads.filter(p => p.sessionId === LONG);
    expect(longLoads.map(p => Boolean(p.prefetch)), '应是一次预取、一次重新拉').toEqual([true, false]);
    const log = await openConsole(page);
    await expect(perfRows(log, /历史回执 \+\d+（预取对不上，重新拉；1999 条/), '[PERF] 行应记下预取作废、重新拉的那份').toHaveCount(1, { timeout: 10_000 });
    await page.locator('#consoleClose').click();
    await expectNoBrowserErrors(page);
  });

  test('P0-PREFETCH-3 从首页最近列表点开：同样并行预取并复用', async ({ page }) => {
    const loads = captureHistoryLoads(page);
    await gotoMock(page);
    await page.request.post('/__arm-uncapped-long-history');
    await page.locator('#btnHome').click();
    await expect(page.locator('[data-testid="home-dashboard"]')).toBeVisible({ timeout: 5_000 });
    const row = page.locator(`#dashRecentsList .dash-recent-item[data-session-id="${LONG}"]`);
    await expect(row, '前提：长会话在首页最近列表里').toBeVisible();
    await page.request.post('/__hold-next-switch');
    await row.click();

    await expect.poll(() => loads.filter(p => p.sessionId === LONG).length, '切换回执扣着的时候历史就该发出去了').toBe(1);
    expect(loads[loads.length - 1].prefetch).toBe(true);
    expect((await (await page.request.post('/__release-switch')).json()).released, '前提：切换一直扣着').toBe(1);
    await expect(finalMarker(page)).toBeVisible({ timeout: 15_000 });
    await expect(bubbles(page)).toHaveCount(UNCAPPED);
    expect(loads.filter(p => p.sessionId === LONG), '预取对得上还重新拉了一次').toHaveLength(1);
    await expectNoBrowserErrors(page);
  });

  // 截顶时两次都只读回最近 2000 条：终端写过，窗口往后滑了，条数照样相等。画了旧窗口，镜像引擎切入时又以
  // 当时的磁盘长度定基线、不推，中间那几条要等终端再写一条、满窗滑动整窗替换才补上（PR #491 review）
  test('P0-PREFETCH-4 截顶的会话：预取读完终端又写了，条数照样 2000、总条数对不上，照常重新拉，旧窗口不画', async ({ page }) => {
    const loads = captureHistoryLoads(page);
    await gotoMock(page);
    await page.request.post('/__arm-stale-long-history?same_length=1');
    await clickLongHistoryInSidebar(page);

    await expect(finalMarker(page)).toBeVisible({ timeout: 15_000 });
    await expect(bubbles(page)).toHaveCount(2000);
    await expect(page.locator('#messages').getByText('STALE_PREFETCH_MUST_NOT_APPEAR'), '画了滑动前的旧窗口').toHaveCount(0);
    const longLoads = loads.filter(p => p.sessionId === LONG);
    expect(longLoads.map(p => Boolean(p.prefetch)), '应是一次预取、一次重新拉').toEqual([true, false]);
    const log = await openConsole(page);
    await expect(perfRows(log, /历史回执 \+\d+（预取对不上，重新拉；2000 条/), '[PERF] 行应记下预取作废、重新拉的那份').toHaveCount(1, { timeout: 10_000 });
    await page.locator('#consoleClose').click();
    await expectNoBrowserErrors(page);
  });

  // 截顶的会话正是最长、最需要省掉第二次下行的那些：2026-10-31 生产实测，这一拉在重新拉那支上占 2.9s
  test('P0-PREFETCH-5 截顶的会话：总条数对得上就直接画预取那份，不再拉第二次', async ({ page }) => {
    const loads = captureHistoryLoads(page);
    await gotoMock(page);
    await clickLongHistoryInSidebar(page);

    await expect(finalMarker(page)).toBeVisible({ timeout: 15_000 });
    await expect(bubbles(page)).toHaveCount(2000);
    expect(loads.filter(p => p.sessionId === LONG), '截顶的预取对得上还重新拉了一次').toHaveLength(1);
    const log = await openConsole(page);
    await expect(perfRows(log, /历史回执 \+\d+（预取；2000 条/), '历史回执一段应标明用的是预取那份').toHaveCount(1, { timeout: 10_000 });
    await page.locator('#consoleClose').click();
    await expectNoBrowserErrors(page);
  });
});
