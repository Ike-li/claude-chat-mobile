// helpers: tests/helpers/playwright.ts

import { test, expect, type Page } from '@playwright/test';
import { expectNoBrowserErrors, gotoMock } from '../../helpers/playwright';
import { MAIN_WORKSPACE, expandWorkspace, expectSidebarClosed, openSessionsSidebar, openWorkspaceSession } from '../../helpers/sidebar-ui';

// Part B 性能优化：长会话（2000 条，触达 app/src/sessions/history.js 的 HISTORY_MAX_MESSAGES 上限）切入时
// renderHistoryBubbles 改成分块渲染（app/public/js/app.js），验证：①最终结果与同步版等价（不丢/不重复）；
// ②分块确实多次让出主线程（而非一次性同步任务）；③渲染中途切走不残留半渲染气泡。
// LH5 起：长会话先画、先插最近一段（切在回合边界上，不切断工具配对），更早那段在空闲里画完再插到前面。

const bubbles = (page: Page) => page.locator('#messages [data-testid="user-message"], #messages [data-testid="assistant-message"]');
const finalMarker = (page: Page) => page.locator('[data-testid="assistant-message"]', { hasText: 'Long history final message marker' });

async function openLongHistory(page: Page) {
  await openSessionsSidebar(page);
  await expandWorkspace(page, MAIN_WORKSPACE);
  await openWorkspaceSession(page, MAIN_WORKSPACE, 'Long History Session');
  await expectSidebarClosed(page);
}

type IdleQueue = { __idleQueue: IdleRequestCallback[]; __idlePass: boolean };

// 分块与高亮都排在 requestIdleCallback 上：全攥在手里，测试一次放一个，确定性地停在两段之间
async function holdIdle(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as IdleQueue;
    const original = window.requestIdleCallback.bind(window);
    w.__idleQueue = [];
    w.__idlePass = false;
    window.requestIdleCallback = ((cb: IdleRequestCallback, opts?: IdleRequestOptions) => {
      if (w.__idlePass) return original(cb, opts);
      w.__idleQueue.push(cb);
      return 0;
    }) as typeof window.requestIdleCallback;
  });
}

const heldIdle = (page: Page) => page.evaluate(() => (window as unknown as IdleQueue).__idleQueue.length);

async function runOneIdle(page: Page) {
  await page.evaluate(() => (window as unknown as IdleQueue).__idleQueue.shift()?.({ didTimeout: false, timeRemaining: () => 0 } as IdleDeadline));
}

async function runAllIdle(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as IdleQueue;
    w.__idlePass = true;
    for (let cb = w.__idleQueue.shift(); cb; cb = w.__idleQueue.shift()) cb({ didTimeout: false, timeRemaining: () => 0 } as IdleDeadline);
  });
}

// 最近一段两块（同步一块 + 空闲一块）：放掉第二块就插进去了，更早那段的第一块排上队
async function openUntilRecentInserted(page: Page) {
  await openLongHistory(page);
  await expect.poll(() => heldIdle(page), '最近一段的第二块没排上空闲').toBe(1);
  await expect(bubbles(page), '最近一段画完之前一条都不该进 DOM').toHaveCount(0);
  await runOneIdle(page);
  await expect(finalMarker(page)).toBeVisible();
  await expect.poll(() => heldIdle(page), '更早那段没排上空闲').toBe(1);
}

// 气泡按 DOM 顺序取回下标：「…#N」取 N，结尾那条是 #1999
const bubbleIndexes = (page: Page) => bubbles(page).evaluateAll(els => els.map(el => {
  const text = el.textContent || '';
  if (text.includes('Long history final message marker')) return 1999;
  const m = text.match(/Long history stress message #(\d+)/);
  return m ? Number(m[1]) : -1;
}));

const atBottom = (page: Page) => page.locator('#messages').evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight < 2);

// 把第 index 条气泡滚到离 #messages 顶端 40px 处，返回它此刻离顶多少。
// 先等刚插进来的气泡入场动画走完：动画带位移，量到的位置会在随后几百毫秒里自己漂几像素
async function scrollBubbleNearTop(page: Page, index: number) {
  await page.locator('#messages').evaluate(m => Promise.all(m.getAnimations({ subtree: true }).map(a => a.finished)));
  await page.locator('#messages').evaluate((m, idx) => {
    const target = [...m.querySelectorAll('[data-testid="user-message"], [data-testid="assistant-message"]')]
      .find(b => (b.textContent || '').includes(`Long history stress message #${idx}`))!;
    m.scrollTop += target.getBoundingClientRect().top - m.getBoundingClientRect().top - 40;
  }, index);
  return bubbleTop(page, index);
}

const bubbleTop = (page: Page, index: number) => page.locator('#messages').evaluate((m, idx) => {
  const target = [...m.querySelectorAll('[data-testid="user-message"], [data-testid="assistant-message"]')]
    .find(b => (b.textContent || '').includes(`Long history stress message #${idx}`))!;
  return target.getBoundingClientRect().top - m.getBoundingClientRect().top;
}, index);
test.describe('P0 长会话切入分块渲染', () => {
  test('P0-LH1 渲染完毕消息总数与输入等价，不丢不重复', async ({ page }) => {
    await gotoMock(page);
    await openSessionsSidebar(page);
    await expandWorkspace(page, MAIN_WORKSPACE);
    await openWorkspaceSession(page, MAIN_WORKSPACE, 'Long History Session');
    await expectSidebarClosed(page);

    await expect(page.locator('[data-testid="assistant-message"]', { hasText: 'Long history final message marker' }))
      .toBeVisible({ timeout: 15000 });
    await expect(page.locator('[data-testid="user-message"], [data-testid="assistant-message"]')).toHaveCount(2000);

    await expectNoBrowserErrors(page);
  });

  // 验收 O44 / AC-06-13：只回最近 2000 条时，提示若仍写「加载了 2000 条历史消息」，读起来像全部，
  // 用户会以为会话就从这里开始，更早的那些既看不到也不知道它们存在。
  test('P0-LH4 削顶的会话说清只显示了最近的多少条、一共多少条', async ({ page }) => {
    await gotoMock(page);
    await openSessionsSidebar(page);
    await expandWorkspace(page, MAIN_WORKSPACE);
    await openWorkspaceSession(page, MAIN_WORKSPACE, 'Long History Session');
    await expect(page.locator('#messages')).toContainText('仅显示最近 2000 条历史消息（共 2100 条），更早的没有加载', { timeout: 15000 });
    await expect(page.locator('#messages')).not.toContainText('加载了 2000 条历史消息');
    await expectNoBrowserErrors(page);
  });

  test('P0-LH2 分块渲染多次让出主线程，而非一次性同步任务跑完', async ({ page }) => {
    await gotoMock(page);

    // 用调用次数（而非墙钟计时）判定是否让出——不依赖机器速度，避免时间竞争型断言的固有 flaky 风险。
    // 2000 条/每块 40 条 ≈ 50 块：分块实现应触发数十次 requestIdleCallback；一次性同步实现只会为
    // 收尾高亮调用 1 次。
    await page.evaluate(() => {
      const w = window as unknown as { __idleCallCount: number };
      w.__idleCallCount = 0;
      const orig = window.requestIdleCallback?.bind(window);
      window.requestIdleCallback = ((cb: IdleRequestCallback, opts?: IdleRequestOptions) => {
        w.__idleCallCount++;
        return orig ? orig(cb, opts) : window.setTimeout(() => cb({ didTimeout: false, timeRemaining: () => 0 } as IdleDeadline), 0);
      }) as typeof window.requestIdleCallback;
    });

    await openSessionsSidebar(page);
    await expandWorkspace(page, MAIN_WORKSPACE);
    await openWorkspaceSession(page, MAIN_WORKSPACE, 'Long History Session');
    await expectSidebarClosed(page);

    // 最近一段先插，看到末条时更早那段还没画：等齐 2000 条再数
    await expect(bubbles(page)).toHaveCount(2000, { timeout: 15000 });

    const idleCallCount = await page.evaluate(() => (window as unknown as { __idleCallCount: number }).__idleCallCount);
    expect(idleCallCount).toBeGreaterThan(10);

    await expectNoBrowserErrors(page);
  });

  test('P0-LH3 渲染中途切走不残留半渲染气泡，迟到的续块回调也不污染当前会话', async ({ page }) => {
    await gotoMock(page);

    // 冻结分块调度：只捕获第一次 requestIdleCallback 的回调、不执行，让渲染确定性地卡在第一块（40 条）
    // 之后——不依赖真实时间竞争去猜「切走时是否恰好还没渲染完」。
    await page.evaluate(() => {
      const w = window as unknown as { __frozenIdleCallback: IdleRequestCallback | null };
      w.__frozenIdleCallback = null;
      window.requestIdleCallback = ((cb: IdleRequestCallback) => {
        if (w.__frozenIdleCallback === null) w.__frozenIdleCallback = cb;
        return 0;
      }) as typeof window.requestIdleCallback;
    });

    await openSessionsSidebar(page);
    await expandWorkspace(page, MAIN_WORKSPACE);
    await openWorkspaceSession(page, MAIN_WORKSPACE, 'Long History Session');
    await expectSidebarClosed(page);

    // 不在这里断言「DOM 仍是 0 条」——那会和「session:history 还没回来」抢同一个假窗口，
    // 同步实现下也会碰巧通过。真正有区分力的是：分块中途切走后目标会话正确，且迟到的
    // 续块回调不污染新会话（displayedInstanceId 守卫）。
    // 等第一块同步处理完并调度过被冻结的 idle 回调（不依赖墙钟 waitForTimeout）。
    await expect.poll(async () => page.evaluate(() => {
      const w = window as unknown as { __frozenIdleCallback: IdleRequestCallback | null };
      return w.__frozenIdleCallback !== null;
    })).toBe(true);

    await openSessionsSidebar(page);
    await openWorkspaceSession(page, MAIN_WORKSPACE, 'Archived Planning Session');
    await expectSidebarClosed(page);
    await expect(page.locator('#messages')).toContainText('Summarize archived plan', { timeout: 10000 });
    await expect(page.locator('#messages')).not.toContainText('Long history stress message');

    // 即使浏览器之后才姗姗来迟地触发那个被冻结的续块回调，也不该污染已经切换到的会话 DOM
    // （displayedInstanceId 快照守卫，见 app/public/js/app.js renderHistoryBubbles 的 processChunk）。
    await page.evaluate(() => {
      const w = window as unknown as { __frozenIdleCallback: IdleRequestCallback | null };
      w.__frozenIdleCallback?.({ didTimeout: false, timeRemaining: () => 0 } as IdleDeadline);
    });
    await expect(page.locator('#messages')).not.toContainText('Long history stress message');
    await expect(page.locator('#messages')).toContainText('Summarize archived plan');

    await expectNoBrowserErrors(page);
  });

  test('P0-LH5 最近一段先插进来，更早那段空闲里补到前面：顺序不乱、跨切点的工具配对没被切断、日期线不多不少', async ({ page }) => {
    await gotoMock(page);
    expect((await page.request.post('/__arm-long-history-shape')).ok(), '长会话形状夹具没有生效').toBe(true);
    await holdIdle(page);
    await openUntilRecentInserted(page);

    // 2000 - 60 = #1940 被 #1937 的 tool_use 与 #1943 的结果跨着，切点退到 #1936；这两条是工具卡，不算气泡
    const notBubble = (i: number) => i !== 1937 && i !== 1943;
    expect(await bubbleIndexes(page), '最近一段不是从切点画到末尾').toEqual(Array.from({ length: 64 }, (_, k) => 1936 + k).filter(notBubble));
    await expect(page.locator('#messages [data-history-pending]'), '更早那段还没进来，提示条得还算没画完（#307）').toHaveCount(1);
    const card = page.locator('#messages details.toolcard[data-tool-use-id="toolu_lh_cross"]');
    await expect(card).toHaveCount(1);
    await expect(card.locator('.t-out')).toContainText('cross-cut result');
    await expect(page.locator('#messages details.toolcard:not([data-tool-use-id])'), '结果没配上卡，成了孤儿卡').toHaveCount(0);

    await runAllIdle(page);
    await expect(page.locator('#messages [data-history-pending]')).toHaveCount(0);
    expect(await bubbleIndexes(page), '补齐后顺序不对，或丢了、重复了').toEqual(Array.from({ length: 2000 }, (_, k) => k).filter(notBubble));
    await expect(page.locator('#messages details.toolcard')).toHaveCount(1);
    await expect(card.locator('.t-out')).toContainText('cross-cut result');
    // 三天各一条日期线：会话首条、#1000、#1970。最近一段要是没拿到切点前一条的时间，会在 #1936 前多出一条
    await expect(page.locator('#messages [data-testid="msg-time-marker"][data-marker-kind="day"]')).toHaveCount(3);
    await expect(page.locator('#messages [data-testid="msg-time-marker"][data-marker-kind="time"]')).toHaveCount(0);
    await expectNoBrowserErrors(page);
  });

  // 更早那段插在最近一段前面，上方一下多出近 2000 条：插入后按位置差手动补 scrollTop，不靠浏览器的滚动锚定。
  // 关掉锚定（Safari 就不锚定）验补偿本身；默认锚定下验没有补两遍
  for (const variant of [
    { id: 'LH6', noAnchor: true, title: '关掉浏览器滚动锚定' },
    { id: 'LH6b', noAnchor: false, title: '浏览器默认滚动锚定' },
  ]) {
    test(`P0-${variant.id} 更早那段补进来时，翻上去正在看的那条原地不动：${variant.title}`, async ({ page }) => {
      await gotoMock(page);
      if (variant.noAnchor) await page.addStyleTag({ content: '#messages { overflow-anchor: none !important; }' });
      await holdIdle(page);
      await openUntilRecentInserted(page);
      await expect.poll(() => atBottom(page), '最近一段插进来后没落到底').toBe(true);
      const before = await scrollBubbleNearTop(page, 1950);
      expect(Math.abs(before - 40), '前提：#1950 没滚到离顶 40px').toBeLessThanOrEqual(1);

      await runAllIdle(page);
      await expect(page.locator('#messages [data-history-pending]')).toHaveCount(0);
      await expect(bubbles(page)).toHaveCount(2000);
      expect(Math.abs((await bubbleTop(page, 1950)) - before), '正在看的那条被顶走了').toBeLessThanOrEqual(1);
      await expectNoBrowserErrors(page);
    });
  }

  test('P0-LH6c 停在底部时更早那段补进来，仍停在底部', async ({ page }) => {
    await gotoMock(page);
    await page.addStyleTag({ content: '#messages { overflow-anchor: none !important; }' });
    await holdIdle(page);
    await openUntilRecentInserted(page);
    await expect.poll(() => atBottom(page), '最近一段插进来后没落到底').toBe(true);

    await runAllIdle(page);
    await expect(bubbles(page)).toHaveCount(2000);
    expect(await atBottom(page), '补进更早那段后离开了底部').toBe(true);
    await expectNoBrowserErrors(page);
  });

  test('P0-LH7 两段之间切到别的会话：更早那段作废、不进当前会话，切回重新完整加载', async ({ page }) => {
    await gotoMock(page);
    await holdIdle(page);
    await openUntilRecentInserted(page);

    await openSessionsSidebar(page);
    await openWorkspaceSession(page, MAIN_WORKSPACE, 'Archived Planning Session');
    await expectSidebarClosed(page);
    await expect(page.locator('#messages')).toContainText('Summarize archived plan', { timeout: 10000 });
    await runAllIdle(page);
    await expect(page.locator('#messages')).not.toContainText('Long history stress message');

    // 提示条还带着 data-history-pending，切走时没进缓存：切回只能重新拉、完整画一遍
    await openSessionsSidebar(page);
    await openWorkspaceSession(page, MAIN_WORKSPACE, 'Long History Session');
    await expectSidebarClosed(page);
    await expect(finalMarker(page)).toBeVisible({ timeout: 15000 });
    await expect(bubbles(page)).toHaveCount(2000);
    expect(await bubbleIndexes(page)).toEqual(Array.from({ length: 2000 }, (_, k) => k));
    await expect(page.locator('#messages [data-history-pending]')).toHaveCount(0);
    await expectNoBrowserErrors(page);
  });

  test('P0-LH8 两段之间从「⋯」重新加载：上一轮的更早那段作废，不插进新一轮，结果恰好一份', async ({ page }) => {
    await gotoMock(page);
    await holdIdle(page);
    await openUntilRecentInserted(page);
    // 上一轮更早那段的第一块留着最后再放；新一轮照常走空闲
    await page.evaluate(() => {
      const w = window as unknown as IdleQueue & { __staleIdle: IdleRequestCallback[] };
      w.__staleIdle = w.__idleQueue.splice(0);
      w.__idlePass = true;
    });

    await page.locator('#btnMore').click();
    await page.locator('#moreReloadSession').click();
    await expect(page.locator('#messages [data-history-pending]')).toHaveCount(0, { timeout: 15000 });
    await expect(bubbles(page)).toHaveCount(2000);
    await page.evaluate(() => {
      for (const cb of (window as unknown as { __staleIdle: IdleRequestCallback[] }).__staleIdle) cb({ didTimeout: false, timeRemaining: () => 0 } as IdleDeadline);
    });
    await expect(bubbles(page)).toHaveCount(2000);
    expect(await bubbleIndexes(page)).toEqual(Array.from({ length: 2000 }, (_, k) => k));
    await expectNoBrowserErrors(page);
  });

  // 历史分两次传（app/src/sessions/history.js 的 historyPage）：先只拉最近 300 条，最近一段从里面切出来先画；
  // 更早那段另一个往返要，到了接在这 300 条的前头一起补进去。手机经隧道下行一两百 KB/s，整窗 2000 条要等两三秒
  const reloadButton = (page: Page) => page.locator('#messages [data-testid="history-reload"]');
  const releaseHeldHistory = async (page: Page) => (await (await page.request.post('/__release-history-ack')).json()).released;

  test('P0-LH9 更早那段还在路上时最近一段已经看得到；到了补齐整窗，顺序不乱、仍停在底部', async ({ page }) => {
    await gotoMock(page);
    await page.request.post('/__hold-next-older-history-ack');
    await openLongHistory(page);

    await expect(finalMarker(page)).toBeVisible({ timeout: 15_000 });
    expect(await bubbleIndexes(page), '最近一段应从 #1940 画到末尾').toEqual(Array.from({ length: 60 }, (_, k) => 1940 + k));
    await expect(page.locator('#messages [data-history-pending]'), '更早那段没到，提示条得还算没画完（#307）').toHaveCount(1);
    await expect.poll(() => atBottom(page), '最近一段插进来后没落到底').toBe(true);

    await expect.poll(() => releaseHeldHistory(page), '前提：更早那段的回执扣着').toBe(1);
    await expect(page.locator('#messages [data-history-pending]')).toHaveCount(0, { timeout: 15_000 });
    expect(await bubbleIndexes(page), '补齐后顺序不对，或丢了、重复了').toEqual(Array.from({ length: 2000 }, (_, k) => k));
    expect(await atBottom(page), '补进更早那段后离开了底部').toBe(true);
    await expectNoBrowserErrors(page);
  });

  // 两次之间 rewind 过、或截顶窗口滑过了这 300 条的头：server 回 stale，不交一段和已画的尾巴拼不起来的消息
  test('P0-LH10 更早那段对不上：最近 300 条照常画完，提示条给「重新加载」、不算画完，点了恢复整窗', async ({ page }) => {
    await gotoMock(page);
    await page.request.post('/__arm-older-history-stale');
    await openLongHistory(page);

    await expect(reloadButton(page)).toBeVisible({ timeout: 15_000 });
    expect(await bubbleIndexes(page), '拿到的最近 300 条应该都留着').toEqual(Array.from({ length: 300 }, (_, k) => 1700 + k));
    await expect(page.locator('#messages [data-history-pending]'), '没补齐的不能被当成整份存进缓存（#307）').toHaveCount(1);
    await page.locator('#btnConsole').click();
    const log = page.locator('#consoleLogArea');
    await expect(log.locator(':scope > div', { hasText: /\[PERF\] 打开会话.*更早回执 \+\d+（对不上）/ }), '[PERF] 行应记下更早那段对不上').toHaveCount(1, { timeout: 10_000 });
    await page.locator('#consoleClose').click();

    // 重新加载先清屏：提示条一摘 pending 就没了，得等新一轮画满
    await reloadButton(page).click();
    await expect(bubbles(page)).toHaveCount(2000, { timeout: 15_000 });
    await expect(page.locator('#messages [data-history-pending]')).toHaveCount(0);
    expect(await bubbleIndexes(page)).toEqual(Array.from({ length: 2000 }, (_, k) => k));
    await expect(reloadButton(page), '恢复之后不该还挂着「重新加载」').toHaveCount(0);
    await expectNoBrowserErrors(page);
  });

  // #1650 起都是 assistant：最近 300 条里没有回合边界。整窗的切点退到 #1648，最近一段 352 条
  test('P0-LH11 最近 300 条里切不开（一轮跑得很长）：等更早那段到了拼成整窗再画，一条都不先画', async ({ page }) => {
    await gotoMock(page);
    await page.request.post('/__arm-long-history-long-turn');
    await page.request.post('/__hold-next-older-history-ack');
    await holdIdle(page);
    await openLongHistory(page);

    // 提示条和第一块同在回执那个任务里：提示条出来时，先开画的话第二块已经排上空闲了
    await expect(page.locator('#messages [data-history-pending]'), '前提：最近那段的回执到了').toHaveCount(1, { timeout: 15_000 });
    expect(await heldIdle(page), '最近 300 条先开画了').toBe(0);
    await expect(bubbles(page)).toHaveCount(0);
    await expect.poll(() => releaseHeldHistory(page), '前提：更早那段的回执扣着').toBe(1);
    await runAllIdle(page);
    await expect(page.locator('#messages [data-history-pending]')).toHaveCount(0, { timeout: 15_000 });
    expect(await bubbleIndexes(page)).toEqual(Array.from({ length: 2000 }, (_, k) => k));
    await expectNoBrowserErrors(page);
  });
});
