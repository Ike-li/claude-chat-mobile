// test/sw.test.mjs —— Service Worker & Push 辅助逻辑单测（零浏览器依赖）
// 覆盖：sw.js push/notificationclick 事件行为、sw-cleanup.js 自愈注销流程。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Script, createContext } from 'node:vm';

const HERE = import.meta.dirname;
const swSrc = readFileSync(join(HERE, '..', 'public', 'js', 'sw.js'), 'utf8');
const cleanupSrc = readFileSync(join(HERE, '..', 'public', 'js', 'sw-cleanup.js'), 'utf8');

// ---- 辅助：在 mock 环境中执行脚本 ----
function runInMock(scriptSrc, globals = {}) {
  const ctx = createContext({
    ...globals,
    console: { log() {}, warn() {}, error() {} },
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
    assert.equal(shownOptions.tag, 'ccm-push');
    assert.equal(shownOptions.renotify, true);
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
