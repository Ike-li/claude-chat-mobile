// helpers: tests/helpers/playwright.ts

import { test, expect, type Page } from '@playwright/test';
import { expectNoBrowserErrors, gotoMock } from '../../helpers/playwright';
import { MAIN_WORKSPACE, expandWorkspace, expectSidebarClosed, openSessionsSidebar, openWorkspaceSession } from '../../helpers/sidebar-ui';

// 前端性能上报（app/public/js/app/perf-report.js）：启动 / 打开会话 / 切回前台记录连同掉帧、点击响应攒成一批，
// 切到后台时经 logs:clientPerf 发给服务端，落成 ccm-server.log 的 [client-perf] 行。
// mock 不接这个事件（fire-and-forget，无回执可断言，见 agent-event-contract 的豁免），这里直接嗅出向帧。
// 不测什么：攒批、上限、自身耗时预算、断线不发在 tests/unit/frontend-perf-report.test.mjs；
// 服务端清洗在 tests/unit/client-perf-log.test.mjs；切回前台各段怎么记在 tests/unit/frontend-perf-trace.test.mjs。

// 同时观察 polling 与 websocket，避免首连尚未升级时漏掉（同 history-prefetch.spec.ts）
function capturePerfBatches(page: Page) {
  const batches: any[] = [];
  const take = (payload: string) => {
    for (const packet of payload.split('\x1e')) {
      if (!packet.includes('"logs:clientPerf"')) continue;
      batches.push(JSON.parse(packet.slice(packet.indexOf('[')))[1]);
    }
  };
  page.on('websocket', ws => ws.on('framesent', frame => { if (typeof frame.payload === 'string') take(frame.payload); }));
  page.on('request', req => { if (req.method() === 'POST' && req.url().includes('/socket.io/')) take(req.postData() || ''); });
  return batches;
}

// 无头浏览器的页面恒可见：改写 visibilityState 再派发事件，走的是 app.js 里同一条监听
async function setVisibility(page: Page, state: 'hidden' | 'visible') {
  await page.evaluate(next => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => next });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => next === 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  }, state);
}

// 控制台面板开着时实时追加 client_perf 行（localStorage 那份落盘有 2s 节流）
async function openConsole(page: Page) {
  await page.locator('#btnConsole').click();
  await expect(page.locator('#consoleModal')).toBeVisible();
  return page.locator('#consoleLogArea');
}

test.describe('前端性能上报', () => {
  test('P0-CLIENT-PERF-1 切到后台时把攒着的一批发给服务端：带启动那一条、当时的维度和设备上下文', async ({ page }) => {
    const batches = capturePerfBatches(page);
    await gotoMock(page);
    const log = await openConsole(page);
    await expect(log.locator(':scope > div', { hasText: /\[PERF\] 启动 \d+ms/ }), '前提：启动行已经出了').toHaveCount(1, { timeout: 10_000 });
    await page.locator('#consoleClose').click();
    expect(batches, '切走之前不该发（30s 定时还没到）').toHaveLength(0);

    await setVisibility(page, 'hidden');
    await expect.poll(() => batches.length, '切到后台应当场发一批').toBe(1);
    const [batch] = batches;
    expect(batch.v).toBe(1);
    const startup = batch.events.filter((event: any) => event.k === 'startup');
    expect(startup, '启动记录只该有一条').toHaveLength(1);
    // mock 首屏停在哪个视图由 mock 的默认实例决定；view 取值的接线由 P0-CLIENT-PERF-2 钉住
    expect(startup[0]).toMatchObject({ view: expect.stringMatching(/^(home|session)$/), busy: expect.any(Boolean), nav: 'navigate', discarded: false });
    expect(startup[0].total).toBeGreaterThan(0);
    expect(typeof startup[0].marks.connect, '启动分段应带「连上」').toBe('number');
    expect(batch.ctx).toMatchObject({ standalone: false, vw: expect.any(Number), dpr: expect.any(Number) });
    expect(batch.ctx.build, '应带资源版本戳，对得上是哪一版前端').toMatch(/\S/);
    expect(batch.self).toMatchObject({ ms: expect.any(Number), n: expect.any(Number) });
    await expectNoBrowserErrors(page);
  });

  test('P0-CLIENT-PERF-2 会话里切走再切回：记一条「切回前台」（连接还在、不拉历史），下次切走随批发出', async ({ page }) => {
    const batches = capturePerfBatches(page);
    await gotoMock(page);
    await openSessionsSidebar(page);
    await expandWorkspace(page, MAIN_WORKSPACE);
    await openWorkspaceSession(page, MAIN_WORKSPACE, 'Archived Planning Session');
    await expectSidebarClosed(page);
    await expect(page.locator('#messages')).toContainText('Archived plan replay from session history.', { timeout: 10_000 });

    await setVisibility(page, 'hidden');
    await expect.poll(() => batches.length).toBe(1);
    await setVisibility(page, 'visible');
    const log = await openConsole(page);
    await expect(log.locator(':scope > div', { hasText: /\[PERF\] 切回前台 \d+ms（离开 \d+s · 连接还在 · 不拉历史）：同步回执 \+\d+（keep）/ }))
      .toHaveCount(1, { timeout: 10_000 });
    await page.locator('#consoleClose').click();

    await setVisibility(page, 'hidden');
    await expect.poll(() => batches.length).toBe(2);
    const resume = batches[1].events.filter((event: any) => event.k === 'resume');
    expect(resume).toHaveLength(1);
    expect(resume[0]).toMatchObject({ outcome: 'keep', connected: true, view: 'session', steps: [{ n: 'sync', note: 'keep' }] });
    await expectNoBrowserErrors(page);
  });
});
