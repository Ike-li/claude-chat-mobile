// helpers: tests/helpers/playwright.ts
//
// #302 设置页底部两档：「重新加载」（不丢数据）与「重置本机数据」（危险）。
// 判定逻辑在 tests/unit/logic-local-reset.test.mjs，对浏览器的副作用（放过 /sw.js、只删白名单键、先后顺序）在
// tests/unit/local-reset.test.mjs；这里只验 app.js 的接线：拒绝的时机、确认框里的条数、pagehide 回写的闸。
// Access 路径（没令牌也能握手）在 mock 的 localhost 上造不出来，只在单测里验文案。

import { test, expect, type Page } from '@playwright/test';
import {
  captureBrowserErrors, captureUserMessages, ensureComposerReady, expectNoBrowserErrors, gotoMock, openGeneralSettings,
  sendChatMessage, waitForIdle, waitUntilConnected, waitUntilDisconnected,
} from '../../helpers/playwright';
import { MAIN_WORKSPACE, expandWorkspace, expectSidebarClosed, openSessionsSidebar, openWorkspaceSession } from '../../helpers/sidebar-ui';

const DEAD_LETTER_KEY = 'ccm-outbox-dead-letters-v1';
// 发往 Archived Planning Session 的拒收暂存：带会话号，只在看那个会话时交还，开页不会被顺手取走
const DEAD_LETTER = JSON.stringify([{
  instanceId: 'inst_gone', sessionId: 'mock-session-archived', cwd: '/Users/you/code/claude-chat-mobile',
  text: '拒收暂存的那条', message: '⚠️ 已停止重试', at: 1,
}]);

// 页面被换掉了没有：真 reload 之后 window 上的标记就没了
const markPage = (page: Page) => page.evaluate(() => { (window as unknown as { __ccmMarker?: number }).__ccmMarker = 1; });
const pageWasReloaded = (page: Page) => page.evaluate(() => (window as unknown as { __ccmMarker?: number }).__ccmMarker !== 1);
// 不收 ccm_client_logs：日志节流写盘，随时可能落进两次快照之间，与取消/重置无关（负载高时 P0-RESET-4 因此偶发红）
const storageSnapshot = (page: Page) => page.evaluate(() => Object.fromEntries(Object.keys(localStorage).filter(k => k !== 'ccm_client_logs').sort().map(k => [k, localStorage.getItem(k)])));

async function sendOffline(page: Page, texts: string[]) {
  await page.context().setOffline(true);
  await waitUntilDisconnected(page);
  for (const text of texts) {
    await page.locator('#input').fill(text);
    await page.locator('#btnSend').click();
    await expect(page.locator('#input')).toHaveValue('');
  }
}

async function goOnline(page: Page) {
  await page.context().setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await waitUntilConnected(page);
}

async function expectReloadRefused(page: Page) {
  await markPage(page);
  await openGeneralSettings(page);
  await page.locator('#btnReloadApp').click();
  await expect(page.locator('#localResetHint')).toHaveText('有消息正在发送，稍后再试');
  await expect(page.locator('#localResetHint')).toBeVisible();
  expect(await pageWasReloaded(page), '有消息正在发送时不该刷新').toBe(false);
  await page.keyboard.press('Escape');
}

test.describe('#302 重新加载与重置本机数据', () => {
  test('P0-RESET-1 重新加载：拒收暂存原样还在、回到它的会话照常交还；推送 SW 没被注销或退订；Cache 清空；令牌保留不用重输', async ({ page }) => {
    // 只在第一次加载时写：reload 不碰 sessionStorage，第二次加载不再写，暂存若被清掉就真的没了
    await page.addInitScript(([key, value]) => {
      if (sessionStorage.getItem('__seeded')) return;
      sessionStorage.setItem('__seeded', '1');
      localStorage.setItem(key, value);
    }, [DEAD_LETTER_KEY, DEAD_LETTER]);
    // 数合法 SW 的注销与推送退订：只查「注册还在」不够，setup() 会再注册一个，误注销也照样绿
    await page.addInitScript(() => {
      const record = (what: string) => { try { sessionStorage.setItem('__spy', `${sessionStorage.getItem('__spy') || ''}${what};`); } catch { /* noop */ } };
      const unregister = ServiceWorkerRegistration.prototype.unregister;
      ServiceWorkerRegistration.prototype.unregister = function (this: ServiceWorkerRegistration) {
        record(`unregister:${(this.active || this.waiting || this.installing)?.scriptURL}`);
        return unregister.call(this);
      };
      if (typeof PushSubscription !== 'undefined') {
        const unsubscribe = PushSubscription.prototype.unsubscribe;
        PushSubscription.prototype.unsubscribe = function (this: PushSubscription) { record('unsubscribe'); return unsubscribe.call(this); };
      }
    });
    await gotoMock(page);
    expect(await page.evaluate(k => localStorage.getItem(k), DEAD_LETTER_KEY), '前提：暂存在').toBe(DEAD_LETTER);
    await page.evaluate(async () => {
      await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
      await (await caches.open('legacy-v1')).put('/legacy', new Response('stale'));
    });
    const tokenBefore = await page.evaluate(() => localStorage.getItem('auth_token'));

    await markPage(page);
    await openGeneralSettings(page);
    await page.locator('#btnReloadApp').click();
    await expect.poll(() => pageWasReloaded(page).catch(() => false), { message: '点了没刷新' }).toBe(true);
    await waitUntilConnected(page);
    await expect(page.locator('#authGate'), '令牌被清了，要重新输入').toBeHidden();

    expect(await page.evaluate(() => localStorage.getItem('auth_token'))).toBe(tokenBefore);
    expect(await page.evaluate(k => localStorage.getItem(k), DEAD_LETTER_KEY), '拒收暂存被清了').toBe(DEAD_LETTER);
    expect(await page.evaluate(() => sessionStorage.getItem('__spy') || ''), '合法的推送 SW 被注销或退订了').toBe('');
    expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).map(r => new URL(r.active?.scriptURL || '').pathname))).toEqual(['/sw.js']);
    expect(await page.evaluate(() => caches.keys()), 'Cache Storage 没清').toEqual([]);

    await openSessionsSidebar(page);
    await expandWorkspace(page, MAIN_WORKSPACE);
    await openWorkspaceSession(page, MAIN_WORKSPACE, 'Archived Planning Session');
    await expectSidebarClosed(page);
    await expect(page.locator('#input'), '暂存的正文或目标会话丢了').toHaveValue('拒收暂存的那条');
    await expectNoBrowserErrors(page);
  });

  test('P0-RESET-2 重新加载：离线消息正在重发（等 ack）时拒绝，放行后那条照常送达', async ({ page }) => {
    await gotoMock(page);
    await ensureComposerReady(page);
    await page.request.post('/__hold-outbox-acks');
    await sendOffline(page, ['重发中的那条']);
    await goOnline(page);
    await expect.poll(async () => (await (await page.request.get('/__outbox-received')).json()).map((r: { text: string }) => r.text),
      { message: '前提：重放已经发出、ack 被压住' }).toEqual(['重发中的那条']);

    await expectReloadRefused(page);

    // 放行只回 ok、不补回显（见 mock 的 outboxAckHold），所以看 outbox 清空：那条有了「已送达」的结论
    await page.request.post('/__release-outbox-acks');
    await expect.poll(() => page.evaluate(() => localStorage.getItem('ccm-outbox-v1')), { message: '放行后那条没有落成已送达' }).toBe('[]');
    await expectNoBrowserErrors(page);
  });

  test('P0-RESET-3 重新加载：离线消息排着等本轮结束时拒绝，本轮结束后照常续发', async ({ page }) => {
    await gotoMock(page);
    await ensureComposerReady(page);
    await sendChatMessage(page, 'test:arm-outbox-turns');
    await waitForIdle(page);
    await sendOffline(page, ['排队问一', '排队问二']);
    await goOnline(page);
    const queued = page.locator('[data-testid="user-message"].opacity-70');
    await expect(queued, '前提：第 2 条撞上第 1 条那一轮，在排队').toHaveCount(1);
    await expect(queued).toContainText('本轮结束后自动发送');

    await expectReloadRefused(page);
    // 排着的那条已经取出了队列、只在「取出了还没结论」里：确认框也得把它数进去
    await openGeneralSettings(page);
    await page.locator('#btnResetLocal').click();
    await expect(page.locator('#confirmBody')).toContainText('1 条待发送或未确认送达的消息会丢失');
    await page.locator('#confirmCancel').click();
    await page.keyboard.press('Escape');

    await page.request.post('/__outbox-turn-end');
    await expect(page.locator('[data-testid="assistant-message"]').filter({ hasText: '答：排队问二' })).toBeVisible();
    await page.request.post('/__outbox-turn-end');
    await expectNoBrowserErrors(page);
  });

  test('P0-RESET-4 重置本机数据：确认框写明会丢几条；取消没有副作用；确认后回到令牌门，旧 outbox 经过 pagehide 也不复活，重新连上不发已丢弃的消息', async ({ page }) => {
    // 握手请求回 503 让它连不上（socket.io 的客户端脚本同在 /socket.io/ 下，只拦带 EIO 的握手）
    captureBrowserErrors(page, { ignoredResourceStatusCodes: [503] });
    const sent = captureUserMessages(page);
    // 只在带 #token= 的那次加载写暂存：重置后 reload 到的是 /，sessionStorage 也清了，不能拿它当闸
    await page.addInitScript(([key, value]) => {
      if (location.hash.startsWith('#token=')) localStorage.setItem(key, value);
    }, [DEAD_LETTER_KEY, DEAD_LETTER]);
    // 不走 gotoMock：它的 init script 在令牌缺失时补一个，重置后就看不到令牌门了
    await page.request.post('/__reset');
    await page.goto('/#token=mock-token');
    await waitUntilConnected(page);
    // 停在一个真实会话里：pagehide 会给它记已读位点（markActiveSessionSeen），重置时这一笔也不许写回
    await openSessionsSidebar(page);
    await expandWorkspace(page, MAIN_WORKSPACE);
    await openWorkspaceSession(page, MAIN_WORKSPACE, 'Visual Sandbox (Main)');
    await expectSidebarClosed(page);
    await ensureComposerReady(page);

    await sendOffline(page, ['重置会丢的一', '重置会丢的二']);
    const handshake = (url: URL) => url.pathname.startsWith('/socket.io/') && url.searchParams.has('EIO');
    await page.route(handshake, route => route.fulfill({ status: 503, body: '' }));
    await page.context().setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));

    await markPage(page);
    await openGeneralSettings(page);
    const before = await storageSnapshot(page);
    expect(JSON.parse(before['ccm-outbox-v1'] || '[]').map((i: { text: string }) => i.text), '前提：两条在 outbox 里').toEqual(['重置会丢的一', '重置会丢的二']);

    await page.locator('#btnResetLocal').click();
    await expect(page.locator('#confirmTitle')).toHaveText('重置本机数据');
    const body = page.locator('#confirmBody');
    await expect(body).toContainText('2 条待发送或未确认送达的消息会丢失');
    await expect(body).toContainText('1 条被拒收暂存的消息会丢失');
    await expect(body).toContainText('重新输入访问令牌或扫码');
    await expect(body).toContainText('服务端的已读位点和设备信任表不受影响');
    await page.locator('#confirmCancel').click();
    await expect(page.locator('#confirmModal')).toBeHidden();
    expect(await storageSnapshot(page), '取消后本地数据变了').toEqual(before);
    expect(await pageWasReloaded(page), '取消后页面被刷新了').toBe(false);

    await page.locator('#btnResetLocal').click();
    await page.locator('#confirmOk').click();
    await expect.poll(() => pageWasReloaded(page).catch(() => false), { message: '确认后没刷新' }).toBe(true);
    await expect(page.locator('#authGate'), '令牌路径重置后应回到令牌门').toBeVisible();
    const after = await storageSnapshot(page);
    expect(after.auth_token ?? null, '令牌没清').toBeNull();
    expect(after[DEAD_LETTER_KEY] ?? null, '拒收暂存没清').toBeNull();
    expect(after['ccm-outbox-v1'] ?? '[]', '旧 outbox 在 pagehide 时被写回来了').toBe('[]');
    expect(after['ccm-unread-v1'] ?? '', '旧已读表在 pagehide 时被写回来了').not.toContain('mock-session-visual-test');

    await page.unroute(handshake);
    await page.locator('#authToken').fill('mock-token');
    await page.locator('#authSubmit').click();
    await waitUntilConnected(page);
    await ensureComposerReady(page);
    // 连上时的离线重放先于这条：它发出去了，要重放的早就发了
    await sendChatMessage(page, '重置之后的新消息');
    await expect.poll(() => sent.map(m => m.text)).toContain('重置之后的新消息');
    expect(sent.map(m => m.text), '重新连上后发出了已丢弃的消息').toEqual(['重置之后的新消息']);
    expect(await (await page.request.get('/__outbox-received')).json(), '服务端收到了已丢弃的离线重放').toEqual([]);
    await expectNoBrowserErrors(page);
  });

  // #352 review：确认之前一刻排上的前台重连（200ms 定时器）活过了 beforeReset。重置在等推送退订的那几秒里它照样
  // forceReconnect，连上后 processOfflineQueue 把刚确认要丢弃的消息发了出去。
  test('P0-RESET-5 确认前已排上的前台重连，在重置等推送退订期间不再握手，已丢弃的消息不会发出去', async ({ page }) => {
    captureBrowserErrors(page, { ignoredResourceStatusCodes: [503] });
    await page.request.post('/__reset');
    await page.goto('/#token=mock-token');
    await waitUntilConnected(page);
    await ensureComposerReady(page);

    await sendOffline(page, ['重置会丢的三']);
    // 确认之前握手一律 503（连不上、outbox 留着）；确认之后放行：此时还能握上手的只有绕过了重置的那一次
    let allowHandshake = false;
    const handshake = (url: URL) => url.pathname.startsWith('/socket.io/') && url.searchParams.has('EIO');
    await page.route(handshake, route => (allowHandshake ? route.continue() : route.fulfill({ status: 503, body: '' })));
    await page.context().setOffline(false);

    await openGeneralSettings(page);
    await page.locator('#btnResetLocal').click();
    await expect(page.locator('#confirmTitle')).toHaveText('重置本机数据');
    // 推送退订挂住：重置停在「已断开、还没清存储」这一段，等满退订超时
    await page.evaluate(() => {
      const pm = (window as unknown as { PushManager: { prototype: { getSubscription: () => Promise<unknown> } } }).PushManager;
      pm.prototype.getSubscription = () => new Promise(() => {});
    });
    await markPage(page);
    await page.evaluate(() => {
      window.dispatchEvent(new Event('online'));
      document.getElementById('confirmOk')?.click();
    });
    allowHandshake = true;

    await expect.poll(() => pageWasReloaded(page).catch(() => false), { message: '退订超时后没走完重置', timeout: 15_000 }).toBe(true);
    await expect(page.locator('#authGate')).toBeVisible();
    expect(await (await page.request.get('/__outbox-received')).json(), '重置期间排上的重连把已丢弃的消息发出去了').toEqual([]);
    await expectNoBrowserErrors(page);
  });
});
