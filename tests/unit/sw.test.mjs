// tests/unit/sw.test.mjs —— Service Worker & Push 辅助逻辑单测（零浏览器依赖）
// 覆盖：sw.js push/notificationclick 事件行为、sw-cleanup.js 自愈注销流程、SW 注册 scope。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Script, createContext } from 'node:vm';
import { createAppContext } from '../../app/public/js/app/context.js';
import { createNotificationController } from '../../app/public/js/app/notifications.js';

const HERE = import.meta.dirname;
// sw.js 住在 app/public/ 根而不是 app/public/js/：SW 的默认 scope 就是脚本所在目录，放根目录才能控制整站。
// 放 /js/ 下就得靠服务端发 Service-Worker-Allowed 头提权，而那个头会被 CDN 缓存吃掉（2026-07-27
// 真机实测：Cloudflare 后面浏览器只看到 max scope '/js/'，注册直接失败）。少一个中间层依赖 = 少一个故障点。
const swSrc = readFileSync(join(HERE, '..', '..', 'app', 'public', 'sw.js'), 'utf8');
const cleanupSrc = readFileSync(join(HERE, '..', '..', 'app', 'public', 'js', 'sw-cleanup.js'), 'utf8');

// ---- 辅助：在 mock 环境中执行脚本 ----
function runInMock(scriptSrc, globals = {}) {
  const ctx = createContext({
    ...globals,
    console: { log() {}, warn() {}, error() {} },
    URL, // 真实浏览器环境的标准全局；沙箱默认不带，脚本若用 URL 解析 scriptURL 需要它
  });
  new Script(scriptSrc).runInContext(ctx);
  return ctx;
}

// =========================================================================
// sw.js — push 事件行为
// =========================================================================
test.describe('sw.js — push 事件', () => {
  test('push 事件：触发 showNotification 并传标题与正文', async () => {
    let shownTitle = null;
    let shownOptions = null;

    const mockSelf = {
      addEventListener(event, handler) {
        if (event === 'push') this._pushHandler = handler;
        if (event === 'notificationclick') this._clickHandler = handler;
      },
      registration: {
        showNotification(title, options) {
          shownTitle = title;
          shownOptions = options;
          return Promise.resolve();
        },
      },
    };

    runInMock(swSrc, { self: mockSelf });

    // 模拟 push 事件
    const mockEvent = {
      data: { json: () => ({ title: '审批请求', body: '需要你的批准' }) },
      waitUntil: promise => promise,
    };

    assert.ok(mockSelf._pushHandler, 'push handler 已注册');
    await mockSelf._pushHandler(mockEvent);

    assert.equal(shownTitle, '审批请求');
    assert.equal(shownOptions.body, '需要你的批准');
    assert.equal(shownOptions.icon, '/icons/icon-192.png');
    assert.equal(shownOptions.tag, 'ccm-push'); // 无 sessionId 时的兜底
    assert.equal(shownOptions.renotify, true);
  });

  // 固定字面量 tag 让「同 tag 替换」语义跨会话生效：锁屏时项目 B 的「✅ 任务完成」会静默吃掉项目 A 的
  // 「⚠️ 请求许可」，用户只看到「完成了」就把手机放下，A 的审批一直卡到 TTL 过期。同会话内替换是有意
  // 设计（跑完把「运行中」换成「已完成」，见 app.js 注释），按 sessionId 分组正好保留它。
  test('push 事件：带 sessionId → tag 按会话分组，跨会话不互相覆盖', async () => {
    const shown = [];
    const mockSelf = {
      addEventListener(type, handler) { if (type === 'push') this._pushHandler = handler; },
      registration: {
        showNotification(title, options) { shown.push({ title, options }); return Promise.resolve(); },
      },
    };
    runInMock(swSrc, { self: mockSelf });

    await mockSelf._pushHandler({
      data: { json: () => ({ title: 'A', body: 'x', data: { sessionId: 'sess-a', instanceId: 'inst_1' } }) },
      waitUntil: p => p,
    });
    await mockSelf._pushHandler({
      data: { json: () => ({ title: 'B', body: 'y', data: { sessionId: 'sess-b', instanceId: 'inst_2' } }) },
      waitUntil: p => p,
    });

    assert.equal(shown[0].options.tag, 'ccm-sess-a');
    assert.equal(shown[1].options.tag, 'ccm-sess-b');
    assert.notEqual(shown[0].options.tag, shown[1].options.tag, '不同会话必须占不同 tag');
  });

  test('push 事件：空 data → 兜底标题 "Claude"、空正文', async () => {
    let shownTitle = null;
    let shownBody = null;

    const mockSelf = {
      addEventListener(event, handler) {
        if (event === 'push') this._pushHandler = handler;
      },
      registration: {
        showNotification(title, options) {
          shownTitle = title;
          shownBody = options.body;
          return Promise.resolve();
        },
      },
    };

    runInMock(swSrc, { self: mockSelf });

    const mockEvent = {
      data: null, // 无数据
      waitUntil: promise => promise,
    };

    await mockSelf._pushHandler(mockEvent);
    assert.equal(shownTitle, 'Claude');
    assert.equal(shownBody, '');
  });

  test('push 事件：携带 data.data → 进 showNotification options.data（②2c 深链锚点）', async () => {
    let shownOptions = null;
    const mockSelf = {
      addEventListener(event, handler) { if (event === 'push') this._pushHandler = handler; },
      registration: { showNotification(t, o) { shownOptions = o; return Promise.resolve(); } },
    };
    runInMock(swSrc, { self: mockSelf });
    await mockSelf._pushHandler({
      data: { json: () => ({ title: 'T', body: 'B', data: { instanceId: 'i1', sessionId: 's1', cwd: '/r' } }) },
      waitUntil: p => p,
    });
    assert.deepEqual(shownOptions.data, { instanceId: 'i1', sessionId: 's1', cwd: '/r' });
  });

  // ── 应用图标角标（Badging API）：SW 上下文挂在 self.registration 上，不是 navigator.setAppBadge ──
  test('push 事件：调用 self.registration.setAppBadge()（无参数=系统通用圆点，SW 侧不知道精确未读数不硬造）', async () => {
    let badgeCalledWithArgs = undefined;
    let badgeCallCount = 0;
    const mockSelf = {
      addEventListener(event, handler) { if (event === 'push') this._pushHandler = handler; },
      registration: {
        showNotification() { return Promise.resolve(); },
        setAppBadge(...args) { badgeCallCount++; badgeCalledWithArgs = args; return Promise.resolve(); },
      },
    };
    runInMock(swSrc, { self: mockSelf });
    await mockSelf._pushHandler({ data: { json: () => ({ title: 'T', body: 'B' }) }, waitUntil: p => p });
    assert.equal(badgeCallCount, 1, 'setAppBadge 应被调用恰好一次');
    assert.deepEqual(badgeCalledWithArgs, [], '不应硬造精确数字，无参数调用');
  });

  test('push 事件：registration 上没有 setAppBadge（不支持的平台）→ 不抛错，showNotification 仍正常触发', async () => {
    let shownTitle = null;
    const mockSelf = {
      addEventListener(event, handler) { if (event === 'push') this._pushHandler = handler; },
      registration: { showNotification(t) { shownTitle = t; return Promise.resolve(); } }, // 无 setAppBadge
    };
    runInMock(swSrc, { self: mockSelf });
    // handler 本身不保证返回 Promise（e.waitUntil 内部才是异步的），直接调用——若同步抛错测试自然失败，
    // 不用 assert.doesNotReject（那要求一个 Promise/返回 Promise 的函数，这里两者都不是）。
    await mockSelf._pushHandler({ data: { json: () => ({ title: 'T', body: 'B' }) }, waitUntil: p => p });
    assert.equal(shownTitle, 'T', '角标不支持不应影响通知本身正常显示');
  });

  // badge API reject 不得毒化 Promise.all：部分平台（权限边界/半支持）setAppBadge 会 reject，
  // 若不 .catch，waitUntil 整段失败，可能拖累 SW 生命周期。
  test('push 事件：setAppBadge reject → showNotification 仍成功，waitUntil 不失败', async () => {
    let shownTitle = null;
    let waitUntilResult;
    const mockSelf = {
      addEventListener(event, handler) { if (event === 'push') this._pushHandler = handler; },
      registration: {
        showNotification(t) { shownTitle = t; return Promise.resolve(); },
        setAppBadge() { return Promise.reject(new Error('badge denied')); },
      },
    };
    runInMock(swSrc, { self: mockSelf });
    await mockSelf._pushHandler({
      data: { json: () => ({ title: 'T', body: 'B' }) },
      waitUntil: (p) => { waitUntilResult = p; return p; },
    });
    await assert.doesNotReject(waitUntilResult);
    assert.equal(shownTitle, 'T');
  });
});

// =========================================================================
// sw.js — notificationclick 事件行为
// =========================================================================
test.describe('sw.js — notificationclick 事件', () => {
  test('notificationclick：关闭通知 + 聚焦已有窗口', async () => {
    let closed = false;
    let focused = false;

    const targetOrigin = 'https://chat.example.com';

    const mockSelf = {
      location: { origin: targetOrigin },
      addEventListener(event, handler) {
        if (event === 'notificationclick') this._clickHandler = handler;
      },
    };

    const mockClient = {
      url: targetOrigin + '/some-page',
      focus: () => { focused = true; return Promise.resolve(mockClient); },
    };

    const mockEvent = {
      notification: { close: () => { closed = true; } },
      waitUntil: promise => promise,
    };

    const globals = {
      self: mockSelf,
      clients: {
        matchAll: () => Promise.resolve([mockClient]),
        openWindow: () => Promise.resolve({}),
      },
      URL,
    };

    runInMock(swSrc, globals);

    assert.ok(mockSelf._clickHandler, 'notificationclick handler 已注册');
    await mockSelf._clickHandler(mockEvent);

    assert.ok(closed, '通知已关闭');
    assert.ok(focused, '已有窗口已聚焦');
  });

  test('notificationclick：无已有窗口 → 打开新窗口', async () => {
    let openedUrl = null;
    const targetOrigin = 'https://chat.example.com';

    const mockSelf = {
      location: { origin: targetOrigin },
      addEventListener(event, handler) {
        if (event === 'notificationclick') this._clickHandler = handler;
      },
    };

    const mockEvent = {
      notification: { close: () => {} },
      waitUntil: promise => promise,
    };

    const globals = {
      self: mockSelf,
      clients: {
        matchAll: () => Promise.resolve([]),
        openWindow: (url) => { openedUrl = url; return Promise.resolve({}); },
      },
      URL,
    };

    runInMock(swSrc, globals);
    await mockSelf._clickHandler(mockEvent);

    assert.equal(openedUrl, '/');
  });

  test('notificationclick：有 data + 有窗口 → focus + postMessage(ccm:deeplink)', async () => {
    let posted = null, focused = false;
    const origin = 'https://chat.example.com';
    const mockSelf = { location: { origin }, addEventListener(e, h) { if (e === 'notificationclick') this._clickHandler = h; } };
    const mockClient = { url: origin + '/', focus: () => { focused = true; return Promise.resolve(mockClient); }, postMessage: (m) => { posted = m; } };
    const mockEvent = { notification: { close: () => {}, data: { instanceId: 'i1', sessionId: 's1', cwd: '/r' } }, waitUntil: p => p };
    runInMock(swSrc, { self: mockSelf, clients: { matchAll: () => Promise.resolve([mockClient]), openWindow: () => Promise.resolve({}) }, URL, URLSearchParams });
    await mockSelf._clickHandler(mockEvent);
    assert.ok(focused, '窗口已聚焦');
    assert.equal(posted.type, 'ccm:deeplink');
    assert.equal(posted.instanceId, 'i1');
  });

  test('notificationclick：有 data + 无窗口 → openWindow 带 #instance=（深链）', async () => {
    let openedUrl = null;
    const origin = 'https://chat.example.com';
    const mockSelf = { location: { origin }, addEventListener(e, h) { if (e === 'notificationclick') this._clickHandler = h; } };
    const mockEvent = { notification: { close: () => {}, data: { instanceId: 'i1', sessionId: 's1' } }, waitUntil: p => p };
    runInMock(swSrc, { self: mockSelf, clients: { matchAll: () => Promise.resolve([]), openWindow: (u) => { openedUrl = u; return Promise.resolve({}); } }, URL, URLSearchParams });
    await mockSelf._clickHandler(mockEvent);
    assert.match(openedUrl, /#instance=i1/);
    assert.match(openedUrl, /session=s1/);
  });

  // ── 应用图标角标：用户点开通知即回到 app，角标应清除（self.registration.clearAppBadge，非 navigator）──
  test('notificationclick：调用 self.registration.clearAppBadge()（用户点开通知即回到 app，角标应清除）', async () => {
    let clearCallCount = 0;
    const origin = 'https://chat.example.com';
    const mockSelf = {
      location: { origin },
      addEventListener(e, h) { if (e === 'notificationclick') this._clickHandler = h; },
      registration: { clearAppBadge() { clearCallCount++; return Promise.resolve(); } },
    };
    const mockEvent = { notification: { close: () => {} }, waitUntil: p => p };
    runInMock(swSrc, { self: mockSelf, clients: { matchAll: () => Promise.resolve([]), openWindow: () => Promise.resolve({}) }, URL });
    await mockSelf._clickHandler(mockEvent);
    assert.equal(clearCallCount, 1, 'clearAppBadge 应被调用恰好一次');
  });

  // 回归保护：sw.js 曾一度写成 self.registration.clearAppBadge?.()（只在方法调用上加 optional chaining，
  // 未保护 registration 本身）——若 self.registration 整体缺失（旧 mock/不支持角标的实现），
  // `self.registration.clearAppBadge` 这一步本身就会先抛 TypeError，深链 focus/openWindow 逻辑
  // 永远执行不到。必须用 self.registration?.clearAppBadge?.()（两段都要 optional chaining）。
  test('notificationclick：clearAppBadge reject → 深链 openWindow 仍正常触发', async () => {
    let openedUrl = null;
    let waitUntilResult;
    const origin = 'https://chat.example.com';
    const mockSelf = {
      location: { origin },
      addEventListener(e, h) { if (e === 'notificationclick') this._clickHandler = h; },
      registration: { clearAppBadge() { return Promise.reject(new Error('badge denied')); } },
    };
    const mockEvent = {
      notification: { close: () => {}, data: { instanceId: 'i1' } },
      waitUntil: (p) => { waitUntilResult = p; return p; },
    };
    runInMock(swSrc, {
      self: mockSelf,
      clients: { matchAll: () => Promise.resolve([]), openWindow: (u) => { openedUrl = u; return Promise.resolve({}); } },
      URL, URLSearchParams,
    });
    await mockSelf._clickHandler(mockEvent);
    await assert.doesNotReject(waitUntilResult);
    assert.match(openedUrl, /#instance=i1/);
  });

  test('notificationclick：self.registration 整体缺失 → 不抛错，深链 openWindow 仍正常触发', async () => {
    let openedUrl = null;
    const origin = 'https://chat.example.com';
    const mockSelf = {
      location: { origin },
      addEventListener(e, h) { if (e === 'notificationclick') this._clickHandler = h; },
      // 故意不定义 registration，模拟"角标挂点缺失/旧沙箱"场景
    };
    const mockEvent = { notification: { close: () => {}, data: { instanceId: 'i1' } }, waitUntil: p => p };
    runInMock(swSrc, { self: mockSelf, clients: { matchAll: () => Promise.resolve([]), openWindow: (u) => { openedUrl = u; return Promise.resolve({}); } }, URL, URLSearchParams });
    // 同上一测试：直接调用，同步抛错会让测试自然失败，不套 assert.doesNotReject。
    await mockSelf._clickHandler(mockEvent);
    assert.match(openedUrl, /#instance=i1/, 'registration 缺失不应影响深链 openWindow 正常触发');
  });
});

// =========================================================================
// sw-cleanup.js — 自愈注销残留 SW
// =========================================================================
test.describe('sw-cleanup.js — 自愈注销', () => {
  test('有残留注册 → unregister + 清缓存 + reload', async () => {
    let unregistered = 0;
    let cacheDeleted = false;
    let reloaded = false;

    const globals = {
      navigator: {
        serviceWorker: {
          getRegistrations: () => Promise.resolve([
            { unregister: () => { unregistered++; return Promise.resolve(true); } },
          ]),
        },
      },
      window: { caches: {} },
      caches: {
        keys: () => Promise.resolve(['v1-cache']),
        delete: () => { cacheDeleted = true; return Promise.resolve(true); },
      },
      location: { reload: () => { reloaded = true; } },
    };

    runInMock(cleanupSrc, globals);
    // 脚本是异步的（getRegistrations().then(...)），等待 microtask
    await new Promise(r => setTimeout(r, 100));

    assert.ok(unregistered > 0, '至少一次 unregister 被调用');
    assert.ok(cacheDeleted, 'caches.delete 被调用');
    assert.ok(reloaded, 'location.reload 被调用');
  });

  test('无残留注册 → 不触发任何操作', async () => {
    let unregisterCalled = false;
    let reloaded = false;

    const globals = {
      navigator: {
        serviceWorker: {
          getRegistrations: () => Promise.resolve([]),
        },
      },
      window: { caches: {} },
      caches: { keys: () => Promise.resolve([]), delete: () => Promise.resolve(true) },
      location: { reload: () => { reloaded = true; } },
    };

    runInMock(cleanupSrc, globals);
    await new Promise(r => setTimeout(r, 100));

    assert.equal(unregisterCalled, false, 'unregister 不应被调用');
    assert.equal(reloaded, false, 'reload 不应被调用');
  });

  test('只有当前 push SW（/sw.js）→ 放过，不注销、不 reload', async () => {
    let unregistered = 0;
    let reloaded = false;

    const globals = {
      navigator: {
        serviceWorker: {
          getRegistrations: () => Promise.resolve([
            { active: { scriptURL: 'https://host/sw.js' }, unregister: () => { unregistered++; return Promise.resolve(true); } },
          ]),
        },
      },
      window: { caches: {} },
      caches: { keys: () => Promise.resolve([]), delete: () => Promise.resolve(true) },
      location: { reload: () => { reloaded = true; } },
    };

    runInMock(cleanupSrc, globals);
    await new Promise(r => setTimeout(r, 100));

    assert.equal(unregistered, 0, '合法 push SW 不应被注销');
    assert.equal(reloaded, false, '仅 push SW 时不应 reload');
  });

  test('push SW 的 scriptURL 带 query string/hash → 仍应放过（code-review P1：不能只做字面 endsWith）', async () => {
    let unregistered = 0;
    let reloaded = false;

    const globals = {
      navigator: {
        serviceWorker: {
          getRegistrations: () => Promise.resolve([
            { active: { scriptURL: 'https://host/sw.js?v=2' }, unregister: () => { unregistered++; return Promise.resolve(true); } },
            { active: { scriptURL: 'https://host/sw.js#x' }, unregister: () => { unregistered++; return Promise.resolve(true); } },
          ]),
        },
      },
      window: { caches: {} },
      caches: { keys: () => Promise.resolve([]), delete: () => Promise.resolve(true) },
      location: { reload: () => { reloaded = true; } },
    };

    runInMock(cleanupSrc, globals);
    await new Promise(r => setTimeout(r, 100));

    assert.equal(unregistered, 0, '带 query string/hash 的合法 push SW 不应被误判为遗留而注销');
    assert.equal(reloaded, false);
  });

  // 旧路径 /js/sw.js 现在正是"遗留"：脚本迁到站点根后，手机上那个 scope=/js/ 的旧注册
  // 会被这里自动注销掉——省掉一次手工清理，也避免两个 registration 并存。
  test('混合：遗留 SW（旧 /js/sw.js） + push SW → 只注销遗留、放过 push、reload', async () => {
    const unregistered = [];
    let reloaded = false;

    const globals = {
      navigator: {
        serviceWorker: {
          getRegistrations: () => Promise.resolve([
            { active: { scriptURL: 'https://host/js/sw.js' }, unregister: () => { unregistered.push('legacy'); return Promise.resolve(true); } },
            { active: { scriptURL: 'https://host/sw.js' }, unregister: () => { unregistered.push('push'); return Promise.resolve(true); } },
          ]),
        },
      },
      window: { caches: {} },
      caches: { keys: () => Promise.resolve(['v1']), delete: () => Promise.resolve(true) },
      location: { reload: () => { reloaded = true; } },
    };

    runInMock(cleanupSrc, globals);
    await new Promise(r => setTimeout(r, 100));

    assert.deepEqual(unregistered, ['legacy'], '只注销遗留 SW，放过 push SW');
    assert.equal(reloaded, true, '有遗留 SW 时应 reload');
  });

  test('getRegistrations 抛错 → 静默吞噬', async () => {
    const globals = {
      navigator: {
        serviceWorker: {
          getRegistrations: () => Promise.reject(new Error('SW disabled')),
        },
      },
      window: { caches: {} },
      caches: { keys: () => Promise.resolve([]), delete: () => Promise.resolve(true) },
      location: { reload: () => {} },
    };

    // 不应抛错
    runInMock(cleanupSrc, globals);
    await new Promise(r => setTimeout(r, 100));
    // 只要不抛错就通过
    assert.ok(true);
  });
});

// =========================================================================
// SW 注册路径 —— 推送订阅静默挂死的根因（2026-07-27 真机实测）
// =========================================================================
// 脚本原先在 /js/ 下，浏览器默认把 scope 限死在脚本所在目录，于是 registration 只覆盖 /js/、
// 控制不到页面所在的 /。而 navigator.serviceWorker.ready 的语义是"等**控制当前页面**的
// registration 激活"——scope 不覆盖页面时它**永不 resolve 也永不 reject**，subscribe() 就
// 挂死在那个 await 上：按钮 disabled 后不恢复、一个错误提示都不弹，推送从未订阅成功过。
//
// 试过用服务端发 Service-Worker-Allowed: / 提权，origin 上实测有这个头，但浏览器在 Cloudflare
// 后面只看到 "max scope allowed ('/js/')" —— 头被 CDN 缓存层吃掉了。改为把脚本放到站点根：
// 默认 scope 即 '/'，不再需要任何头，也就没有中间层能破坏它。
test.describe('subscribe() 的 SW 注册路径', () => {
  test('注册站点根下的 /sw.js（默认 scope 即 /，不依赖任何响应头）', async () => {
    const registerCalls = [];
    const fakeSubscription = {
      endpoint: 'https://push.example/scope',
      toJSON() { return { endpoint: this.endpoint, keys: { p256dh: 'a', auth: 'b' } }; },
    };
    const registration = { pushManager: { getSubscription: async () => fakeSubscription } };
    const context = createAppContext({
      dom: { btnPush: { classList: { add() {}, remove() {} } } },
      dependencies: {
        navigator: {
          serviceWorker: {
            register: async (url, opts) => { registerCalls.push({ url, opts }); return registration; },
            ready: Promise.resolve(registration),
          },
        },
        window: {},
        fetch: async () => ({ ok: true, json: async () => ({ ok: true }) }),
        storage: { getItem: () => null, setItem() {} },
      },
    });
    const notifications = createNotificationController(context, { autoBind: false, getToken: () => '' });

    await notifications.subscribe();
    assert.equal(registerCalls.length, 1);
    assert.equal(
      registerCalls[0].url,
      '/sw.js',
      'SW 必须在站点根——放 /js/ 下就得靠 Service-Worker-Allowed 头提权，而那个头会被 CDN 吃掉',
    );
  });
});

// =========================================================================
// 订阅失败必须说清为什么 —— 2026-07-27 真机：只弹"请稍后重试"，排查无从下手
// =========================================================================
// subscribe() 的两条失败路径原先都只写 console.warn 就 return false，UI 一律显示同一句
// "⚠️ 订阅未成功，请稍后重试"。手机上看不到 console，用户和维护者都拿不到任何线索。
// 失败原因（FCM 连不上 / VAPID 无效 / POST 被鉴权拦）必须出现在用户看得见的地方。
// 仅需能被 urlBase64ToUint8Array 解码（合法 base64url 字符集即可）——mock 的 pushManager
// 不校验它。绝不要贴真实 VAPID 公钥：本仓库是 public，生产配置值不该进版本库。
const VAPID_SAMPLE = 'test-vapid-public-key-not-a-real-secret';

// userAgent / standalone 可覆写：订阅失败的解释按平台分岔（Chromium 系走 FCM、iOS 走 Apple），
// 只有从 UA 走通 environment() → describeSubscribeError 这条链，才验得到分岔接线是对的。
function pushReadyContext({ serviceWorker, fetch: fetchFn, alerts, userAgent = 'Mozilla/5.0 (Linux; Android 14)', standalone }) {
  return createAppContext({
    dom: { btnPush: { classList: { add() {}, remove() {} } } },
    dependencies: {
      navigator: { serviceWorker, userAgent, ...(standalone === undefined ? {} : { standalone }) },
      window: { isSecureContext: true, PushManager: function () {} },
      Notification: { permission: 'default', requestPermission: async () => 'granted' },
      fetch: fetchFn,
      alert: message => alerts.push(message),
      console: { warn() {}, log() {}, error() {} },
      storage: { getItem: () => null, setItem() {} },
    },
  });
}

test.describe('订阅失败的可诊断性', () => {
  // 归类不出来的错误必须原样带到 UI。这是本段的原始契约（2026-07-27 真机：只弹"请稍后重试"，
  // 排查无从下手），加了 FCM 分类之后依然成立——分类只该拦它认得的那一类，其余一律放行原文。
  async function subscribeAndCollectAlert(errorMessage, ctxOverrides = {}) {
    const alerts = [];
    const registration = {
      pushManager: {
        getSubscription: async () => null,
        subscribe: async () => { throw new Error(errorMessage); },
      },
    };
    const context = pushReadyContext({
      serviceWorker: { register: async () => registration, ready: Promise.resolve(registration) },
      fetch: async () => ({ ok: true, json: async () => ({ key: VAPID_SAMPLE }) }),
      alerts,
      ...ctxOverrides,
    });
    const notifications = createNotificationController(context, { autoBind: false, getToken: () => '' });
    await notifications.setup();
    await notifications.requestSubscription();
    return alerts.join('\n');
  }

  test('归类不出的错误 → 原文出现在用户可见的提示里', async () => {
    const shown = await subscribeAndCollectAlert('QuotaExceededError: registration limit reached');
    assert.match(shown, /QuotaExceededError: registration limit reached/, `真实错误必须带到 UI，实际提示：${shown}`);
  });

  // 中国大陆网络下 Chromium 系卡的就是这一句。原文 'push service error' 对用户是天书，且它有
  // 明确的下一步；更要紧的是当场回答"是不是得一直开着代理"——不答这句，人会以为推送要长期挂梯子。
  test('连不上 FCM → 说人话 + 给下一步，且讲明代理只需订阅那一次', async () => {
    const shown = await subscribeAndCollectAlert('Registration failed - push service error');
    assert.match(shown, /连不上推送服务/, `实际提示：${shown}`);
    assert.match(shown, /重试一次/, `必须给出下一步动作，实际提示：${shown}`);
    assert.match(shown, /关掉代理仍能正常收推送/, `必须回答"要不要一直挂着代理"，实际提示：${shown}`);
  });

  // iOS 的 endpoint 在 Apple，压根不经 Google。给 iPhone 用户提代理是把人指向完全错误的
  // 排查方向，比不解释更糟——这里验的是 UA → environment() → describeSubscribeError 的分岔接线。
  test('同一句错误在 iOS 上不提代理（那条路走 Apple，不经 Google）', async () => {
    const shown = await subscribeAndCollectAlert('Registration failed - push service error', {
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
      standalone: true,
    });
    assert.doesNotMatch(shown, /代理/, `iOS 不该被指向代理，实际提示：${shown}`);
    assert.match(shown, /push service error/, `归类不出就带原文，实际提示：${shown}`);
  });

  test('POST /push/subscribe 返回非 2xx 时，HTTP 状态码出现在提示里', async () => {
    const alerts = [];
    const fakeSubscription = { endpoint: 'https://push.example/a', toJSON() { return { endpoint: this.endpoint, keys: { p256dh: 'a', auth: 'b' } }; } };
    const registration = { pushManager: { getSubscription: async () => fakeSubscription } };
    const context = pushReadyContext({
      serviceWorker: { register: async () => registration, ready: Promise.resolve(registration) },
      fetch: async url => (String(url).includes('vapid')
        ? { ok: true, json: async () => ({ key: VAPID_SAMPLE }) }
        : { ok: false, status: 403, json: async () => ({}) }),
      alerts,
    });
    const notifications = createNotificationController(context, { autoBind: false, getToken: () => '' });

    await notifications.setup();
    await notifications.requestSubscription();

    const shown = alerts.join('\n');
    assert.match(shown, /403/, `HTTP 状态码必须带到 UI，实际提示：${shown}`);
  });
});
