// 推送通知控制器（public/js/app/notifications.js）的行为域单测。
// 从 frontend-app-modules.test.mjs 分出来：按行为域拆分是硬门禁（见 tests/unit/source-layout.test.mjs），
// 通知这一域已自成一块——订阅 POST 体、前台通知门槛、铃铛显隐与去向。

import assert from 'node:assert/strict';
import test from 'node:test';

import { createAppContext } from '../../public/js/app/context.js';
import { createNotificationController } from '../../public/js/app/notifications.js';

test('notification controller only raises foreground notifications when explicitly forced', () => {
  const raised = [];
  class NotificationMock {
    static permission = 'granted';
    constructor(title, options) { raised.push({ title, options }); }
  }
  const context = createAppContext({
    dependencies: {
      document: { hidden: false },
      window: { Notification: NotificationMock },
      navigator: {},
      Notification: NotificationMock,
    },
  });
  const notifications = createNotificationController(context, { autoBind: false });

  assert.equal(notifications.notify('done', 'body'), false);
  assert.equal(notifications.notify('done', 'body', { force: true }), true);
  assert.equal(raised.length, 1);
  assert.equal(raised[0].options.tag, 'ccm-push');
  assert.equal(notifications.notify('done', 'body', { force: true, tag: 'ccm-sess-1' }), true);
  assert.equal(raised.at(-1).options.tag, 'ccm-sess-1');
});

test('notification controller falls back to identity when sensitive body is stripped', () => {
  const raised = [];
  class NotificationMock {
    static permission = 'granted';
    constructor(title, options) { raised.push({ title, options }); }
  }
  const context = createAppContext({
    dependencies: {
      document: { hidden: true },
      window: { Notification: NotificationMock },
      navigator: {},
      Notification: NotificationMock,
    },
  });
  const notifications = createNotificationController(context, { autoBind: false });
  notifications.notify('⚠️ 等待审批', 'Bash：{"command":"rm -rf /"}', {
    sensitive: true,
    identity: 'claude-chat-mobile · 修登录',
  });
  assert.equal(raised.at(-1).options.body, 'claude-chat-mobile · 修登录');
  assert.ok(!String(raised.at(-1).options.body).includes('rm -rf'), '预览关闭时命令正文不得上锁屏');
});

// 隐私：页面自己 new Notification 这条旁路此前完全不读「推送内容预览」开关（只判 document.hidden 与
// permission），而调用点直接传 safeJsonPreview(p.input, 80) —— Bash 的 command 原文、Write 的
// file_path/content 头部。开关默认关、设置面板也显示关，命令正文照样出现在锁屏上。
// Web Push（notify-channels 按 sub.prefs.preview 挑 body）与 ntfy（恒最小化）两条路径都做对了。
test('notification controller strips sensitive body when content preview is off', () => {
  const raised = [];
  class NotificationMock {
    static permission = 'granted';
    constructor(title, options) { raised.push({ title, options }); }
  }
  const store = new Map();
  const makeCtl = () => createNotificationController(createAppContext({
    dependencies: {
      document: { hidden: true },
      window: { Notification: NotificationMock },
      navigator: {},
      Notification: NotificationMock,
      storage: { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) },
    },
  }), { autoBind: false });

  // 默认关：敏感正文必须被剥掉，只留标题
  makeCtl().notify('⚠️ 等待审批', 'Bash：{"command":"gh auth token | pbcopy"}', { sensitive: true });
  assert.equal(raised.at(-1).options.body, '', '开关关闭时不得把命令正文放上锁屏');

  // 非敏感文案不受影响
  makeCtl().notify('✅ 任务完成', '用时 3.2s');
  assert.equal(raised.at(-1).options.body, '用时 3.2s');

  // 显式开启预览后才带正文
  store.set('ccm_push_preview', '1');
  makeCtl().notify('⚠️ 等待审批', 'Bash：{"command":"ls"}', { sensitive: true });
  assert.match(raised.at(-1).options.body, /ls/, '用户显式开启预览后应带正文');
});

// ⑧ 推送内容预览：subscribe() 把 storage 里的本地偏好一并 POST 给服务端（per-device prefs.preview），
// 服务端按它决定这条订阅该收 body 还是 previewBody（见 src/ops/notify-channels.js pushNotify）。
test('notification controller subscribe() includes prefs.preview from storage in the POST body', async () => {
  const fetchCalls = [];
  const fakeSubscription = {
    endpoint: 'https://push.example/abc',
    toJSON() { return { endpoint: this.endpoint, keys: { p256dh: 'a', auth: 'b' } }; },
  };
  const registration = { pushManager: { getSubscription: async () => fakeSubscription } };
  const context = createAppContext({
    dom: { btnPush: { classList: { add() {}, remove() {} } } },
    dependencies: {
      navigator: { serviceWorker: { register: async () => registration, ready: Promise.resolve() } },
      window: {},
      fetch: async (url, init) => { fetchCalls.push({ url, init }); return { ok: true, json: async () => ({ ok: true }) }; },
      storage: { getItem: key => (key === 'ccm_push_preview' ? '1' : null), setItem() {} },
    },
  });
  const notifications = createNotificationController(context, { autoBind: false, getToken: () => '' });

  const ok = await notifications.subscribe();
  assert.equal(ok, true);
  assert.equal(fetchCalls.length, 1);
  const sentBody = JSON.parse(fetchCalls[0].init.body);
  assert.equal(sentBody.endpoint, 'https://push.example/abc');
  assert.deepEqual(sentBody.prefs, { preview: true });
});

test('notification controller subscribe() defaults prefs.preview to false when storage has no opt-in', async () => {
  const fetchCalls = [];
  const fakeSubscription = { endpoint: 'https://push.example/xyz', toJSON() { return { endpoint: this.endpoint, keys: {} }; } };
  const registration = { pushManager: { getSubscription: async () => fakeSubscription } };
  const context = createAppContext({
    dom: { btnPush: { classList: { add() {}, remove() {} } } },
    dependencies: {
      navigator: { serviceWorker: { register: async () => registration, ready: Promise.resolve() } },
      window: {},
      fetch: async (url, init) => { fetchCalls.push({ url, init }); return { ok: true, json: async () => ({ ok: true }) }; },
      storage: { getItem: () => null, setItem() {} },
    },
  });
  const notifications = createNotificationController(context, { autoBind: false, getToken: () => '' });

  await notifications.subscribe();
  const sentBody = JSON.parse(fetchCalls[0].init.body);
  assert.deepEqual(sentBody.prefs, { preview: false });
});

// 推送铃铛与配置面板「推送内容」段职责重叠，且铃铛这套显隐分支自相矛盾：setup() 在 permission
// 为 denied 时**显示**铃铛（"denied 直接隐藏＝死路一条，用户永远查不出自己为什么收不到推送"），
// 而 requestSubscription() 在用户点完被拒时又把它**隐藏**——点一下就消失、刷新才回来。
// 被拒恰恰是最需要那个入口的时刻：它是用户查"为什么收不到推送"的唯一可见落点。
test('notification controller keeps the push bell reachable after permission is denied', async () => {
  const bell = new Set(['hidden']);
  class NotificationMock {
    static permission = 'default';
    static async requestPermission() { return 'denied'; }
  }
  const context = createAppContext({
    dom: {
      btnPush: {
        classList: {
          add: (...names) => names.forEach(n => bell.add(n)),
          remove: (...names) => names.forEach(n => bell.delete(n)),
        },
      },
    },
    dependencies: {
      navigator: { serviceWorker: {}, userAgent: 'Mozilla/5.0 (Linux; Android 14)' },
      window: { isSecureContext: true, PushManager: function () {}, matchMedia: () => ({ matches: false }) },
      Notification: NotificationMock,
      fetch: async () => ({ ok: true, json: async () => ({ key: 'test-vapid-key' }) }),
      alert: () => {},
    },
  });
  const notifications = createNotificationController(context, { autoBind: false, getToken: () => '' });

  await notifications.setup();
  assert.equal(bell.has('hidden'), false, 'permission=default 时铃铛应可见（引导用户开启）');

  await notifications.requestSubscription();
  assert.equal(bell.has('hidden'), false, '被拒后铃铛必须还在——否则用户失去唯一的排查入口');
});

// 铃铛不再自己跑一套「解释 + 订阅」分支：配置面板的 #pushStatusRow 已是更完整的权威版本
// （状态文案 + hint + 订阅按钮）。铃铛只负责把人带到那一处，避免两套解释各说各话。
test('notification controller routes the bell to the injected action instead of subscribing inline', () => {
  const clicks = [];
  const btnPush = { classList: { add() {}, remove() {} } };
  const context = createAppContext({
    dom: { btnPush },
    dependencies: { navigator: {}, window: {}, alert: () => {} },
  });
  createNotificationController(context, { bellAction: () => clicks.push('routed') });

  btnPush.onclick();
  assert.deepEqual(clicks, ['routed']);
});
