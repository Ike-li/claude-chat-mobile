// 推送通知控制器（app/public/js/app/notifications.js）的行为域单测。
// 从 frontend-app-modules.test.mjs 分出来：按行为域拆分是硬门禁（见 tests/unit/source-layout.test.mjs），
// 通知这一域已自成一块——订阅 POST 体、前台通知门槛、铃铛显隐与去向。

import assert from 'node:assert/strict';
import test from 'node:test';

import { createAppContext } from '../../app/public/js/app/context.js';
import { createNotificationController } from '../../app/public/js/app/notifications.js';

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
// 服务端按它决定这条订阅该收 body 还是 previewBody（见 app/src/ops/notify-channels.js pushNotify）。
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

// 退订此前根本不存在：订上之后前端没有任何地方能关掉推送，用户唯一的办法是去浏览器站点设置里
// 把权限改成「阻止」，而那会让状态行翻成「已被拒绝」——把主动关闭说成了拒绝。
//
// 【顺序有判据，不是随手写的】必须先本地 unsubscribe() 再 POST 服务端：
//   · 先本地后服务端：POST 失败 → 本地已退订、服务端残留一条 —— 下次推送必然 410，服务端自己清掉（可自愈）。
//   · 先服务端后本地：本地 unsubscribe() 失败 → 服务端名单里没了、浏览器还订着 —— UI 读 getSubscription()
//     显示「已开启」，人却再也收不到任何推送，且没有任何一侧会去纠正它（不可自愈）。
test('notification controller unsubscribe() 先退本地再通知服务端，POST 带上 endpoint', async () => {
  const order = [];
  const fakeSubscription = {
    endpoint: 'https://push.example/abc',
    toJSON() { return { endpoint: this.endpoint, keys: {} }; },
    unsubscribe: async () => { order.push('local'); return true; },
  };
  const registration = { pushManager: { getSubscription: async () => fakeSubscription } };
  const fetchCalls = [];
  const context = createAppContext({
    dom: { btnPush: { classList: { add() {}, remove() {} } } },
    dependencies: {
      navigator: { serviceWorker: { register: async () => registration, ready: Promise.resolve() } },
      window: {},
      fetch: async (url, init) => {
        order.push('server');
        fetchCalls.push({ url, init });
        return { ok: true, json: async () => ({ ok: true }) };
      },
      storage: { getItem: () => null, setItem() {} },
    },
  });
  const notifications = createNotificationController(context, { autoBind: false, getToken: () => '' });

  assert.equal(await notifications.unsubscribe(), true);
  assert.deepEqual(order, ['local', 'server'], '顺序反了会造成不可自愈的「显示已开启但收不到」');
  assert.equal(fetchCalls.length, 1);
  assert.match(fetchCalls[0].url, /\/push\/unsubscribe/);
  assert.equal(JSON.parse(fetchCalls[0].init.body).endpoint, 'https://push.example/abc');
});

test('notification controller unsubscribe() 在本来就没订阅时是幂等的，不发空 POST', async () => {
  const fetchCalls = [];
  const registration = { pushManager: { getSubscription: async () => null } };
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

  assert.equal(await notifications.unsubscribe(), true);
  assert.equal(fetchCalls.length, 0, '没有 endpoint 可退时，服务端不该收到一条空退订');
});

// H2（2026-09-17 安全审查）：push 的三条 HTTP 此前把 AUTH_TOKEN 拼在 `?token=` 上。它是**控制面
// 密钥**，而 query 会原样落进 nginx / Caddy / cloudflared / CDN 的访问日志——首页用 `/#token=`
// 走 fragment 正是为了躲开中间层日志，push 这条又把同一个秘密放回了 query。
// `Referrer-Policy: no-referrer` 管的是浏览器侧外泄，管不到服务端 access log。
// 服务端 createHttpAuth 早就认 `x-auth-token` 头（app/src/server/http.js），前端从没用过。
//
// 【这条路为什么一直零覆盖】上面所有 subscribe/unsubscribe 用例都写 `getToken: () => ''`——
// 空令牌时 authQuery 恰好是空串，URL 看起来干干净净。不喂非空令牌就永远碰不到这个分支。
// 三条一起断言：它们是同一个判据的三个落点，分开写会给「改了两处漏一处」留缝。
test('push 的三条 HTTP 用 x-auth-token 头带令牌，URL 里不得出现 token=', async () => {
  const calls = [];
  const fakeSubscription = {
    endpoint: 'https://push.example/abc',
    toJSON() { return { endpoint: this.endpoint, keys: { p256dh: 'a', auth: 'b' } }; },
    unsubscribe: async () => true,
  };
  const registration = { pushManager: { getSubscription: async () => fakeSubscription } };
  const makeCtl = () => createNotificationController(createAppContext({
    dom: { btnPush: { classList: { add() {}, remove() {} } } },
    dependencies: {
      navigator: { serviceWorker: { register: async () => registration, ready: Promise.resolve() } },
      window: {},
      fetch: async (url, init) => {
        calls.push({ url: String(url), init });
        return { ok: true, json: async () => ({ key: 'vapid-pub' }) };
      },
      storage: { getItem: () => null, setItem() {}, removeItem() {} },
    },
  }), { autoBind: false, getToken: () => 'SECRET_TOKEN' });

  await makeCtl().subscribe();
  await makeCtl().unsubscribe();
  // setup() 先取 VAPID 公钥再看环境；这里的 deps 不含 PushManager，hint 是 unsupported，
  // 取完密钥就返回——正好只留下待测的那一条请求。
  await makeCtl().setup();

  assert.equal(calls.length, 3, '应恰好命中 subscribe / unsubscribe / vapid-public-key 三条');
  const paths = calls.map(c => c.url);
  assert.ok(paths.some(u => u.includes('/push/subscribe')), 'subscribe 未发出');
  assert.ok(paths.some(u => u.includes('/push/unsubscribe')), 'unsubscribe 未发出');
  assert.ok(paths.some(u => u.includes('/push/vapid-public-key')), 'vapid-public-key 未发出');

  for (const { url, init } of calls) {
    assert.ok(!url.includes('token='), `令牌不得出现在 URL 里（会进访问日志）：${url}`);
    assert.ok(!url.includes('SECRET_TOKEN'), `令牌明文不得出现在 URL 里：${url}`);
    assert.equal(init?.headers?.['x-auth-token'], 'SECRET_TOKEN', `${url} 缺 x-auth-token 头`);
  }
});

// 令牌为空时不该凭空造一个空头出来：服务端 tokenMatches 对空串走的是拒绝路径，发一个
// `x-auth-token: ''` 只会把「没带令牌」的失败原因（no_token）记成「带了但不对」（bad_token），
// 而 http.js 里那两个类别是分开报的，用来区分「配置漂移」和「扫描器」。
test('push 请求在无令牌时不带 x-auth-token 头', async () => {
  const calls = [];
  const fakeSubscription = {
    endpoint: 'https://push.example/abc',
    toJSON() { return { endpoint: this.endpoint, keys: {} }; },
  };
  const registration = { pushManager: { getSubscription: async () => fakeSubscription } };
  const context = createAppContext({
    dom: { btnPush: { classList: { add() {}, remove() {} } } },
    dependencies: {
      navigator: { serviceWorker: { register: async () => registration, ready: Promise.resolve() } },
      window: {},
      fetch: async (url, init) => { calls.push({ url: String(url), init }); return { ok: true, json: async () => ({ ok: true }) }; },
      storage: { getItem: () => null, setItem() {} },
    },
  });

  await createNotificationController(context, { autoBind: false, getToken: () => '' }).subscribe();
  assert.equal(calls.length, 1);
  assert.ok(!Object.hasOwn(calls[0].init.headers ?? {}, 'x-auth-token'), '空令牌时不该带这个头');
});

// 【把令牌从 query 搬进头，对一类令牌是回归】Headers 对首尾空白**静默 trim**、对非 Latin-1 直接
// 抛 TypeError，而服务端 tokenMatches 是逐字节精确比较、不 trim。两者一撞就是「app 照常能用、
// 只有推送静默失效」——socket 那条路把令牌放在 handshake.auth 的 JSON 里，完全不受影响，
// 所以用户看不出是令牌的问题。
//
// 这类令牌确实存在：AUTH_TOKEN 没有字符集校验（env-file.js 的 isSerializableEnvValue 只拦控制
// 字符、单引号、尾随反斜杠），手改过 ccm.config.json 的人可能就持有一个。而**他们在改动前是
// 能用的**（query 走 encodeURIComponent，服务端 Express 解回来精确匹配）。
//
// 故这一档回落 query：对他们不是回归（与改动前等价），对其余所有人令牌不再进访问日志。
// 判据不自己写字符集正则——正则会与浏览器实现漂移，直接问平台那句 Headers 往返不会。
test.describe('push：令牌无法走请求头时回落 query（不制造静默失效）', () => {
  const makeCalls = async (token) => {
    const calls = [];
    const warns = [];
    const fakeSubscription = {
      endpoint: 'https://push.example/abc',
      toJSON() { return { endpoint: this.endpoint, keys: {} }; },
    };
    const registration = { pushManager: { getSubscription: async () => fakeSubscription } };
    const context = createAppContext({
      dom: { btnPush: { classList: { add() {}, remove() {} } } },
      dependencies: {
        navigator: { serviceWorker: { register: async () => registration, ready: Promise.resolve() } },
        window: {},
        console: { warn: (...a) => warns.push(a.join(' ')), log() {}, error() {} },
        fetch: async (url, init) => { calls.push({ url: String(url), init }); return { ok: true, json: async () => ({ ok: true }) }; },
        storage: { getItem: () => null, setItem() {} },
      },
    });
    await createNotificationController(context, { autoBind: false, getToken: () => token }).subscribe();
    return { calls, warns };
  };

  // 尾随空格：Headers 会 trim 成 'tok...'，而服务端比的是带空格的原值 → 精确比较必失配
  test('令牌带尾随空白 → 回落 query，不发一个会被 trim 掉的头', async () => {
    const token = `${'b'.repeat(40)} `;
    const { calls, warns } = await makeCalls(token);
    assert.equal(calls.length, 1);
    assert.ok(!Object.hasOwn(calls[0].init.headers ?? {}, 'x-auth-token'),
      '这个头会被 Headers 静默 trim，发出去等于发了个错令牌');
    assert.ok(calls[0].url.includes(`token=${encodeURIComponent(token)}`),
      '必须回落 query，否则推送对这类令牌静默失效');
    assert.ok(warns.some(w => w.includes('AUTH_TOKEN')), '回落要告诉用户为什么，并给出下一步');
  });

  // 非 Latin-1：new Headers() 直接抛，不判就会被 subscribe 的 catch 吞成「订阅失败」
  test('令牌含非 Latin-1 字符 → 回落 query，不让 Headers 抛进 catch', async () => {
    const token = `令牌${'c'.repeat(30)}`;
    const { calls } = await makeCalls(token);
    assert.equal(calls.length, 1, 'Headers 抛错会让请求根本发不出去');
    assert.ok(!Object.hasOwn(calls[0].init.headers ?? {}, 'x-auth-token'));
    assert.ok(calls[0].url.includes('token='));
  });

  // 反向：正常 hex 令牌绝不能因为这道判据被误判成「不安全」而漏回 query 去
  test('正常 hex 令牌不受影响，仍然只走头', async () => {
    const token = 'd'.repeat(64);
    const { calls, warns } = await makeCalls(token);
    assert.equal(calls[0].init.headers['x-auth-token'], token);
    assert.ok(!calls[0].url.includes('token='), '正常令牌一旦回落 query 就等于这个修复没做');
    assert.equal(warns.length, 0, '正常令牌不该产生告警噪音');
  });
});

// setup() 不是 subscribe() 的唯一调用者：改「锁屏带内容预览」也会调它（app.js 的 pushPreview.set
// 要把新 prefs.preview 带给服务端）。而退订不改通知权限、那个 checkbox 也没有禁用（"不禁用它——只说明"），
// 于是关掉推送之后勾一下预览就会重新订阅、推送整个恢复 —— 偏偏旁边那句 pushPreviewInertNote
// 承诺的是「不产生任何效果（偏好只存在本机）」。把判据放进 subscribe() 而不是某一个调用点：
// 挡在调用点上只挡得住今天数得出来的那几个。
test('notification controller subscribe() 在用户关过推送后不订阅——改预览开关不得把推送偷偷打开', async () => {
  const posts = [];
  const store = new Map([['ccm_push_opt_out', '1']]);
  const fakeSubscription = { endpoint: 'https://push.example/abc', toJSON() { return { endpoint: this.endpoint, keys: {} }; } };
  const registration = { pushManager: { getSubscription: async () => fakeSubscription } };
  const context = createAppContext({
    dom: { btnPush: { classList: { add() {}, remove() {} } } },
    dependencies: {
      navigator: { serviceWorker: { register: async () => registration, ready: Promise.resolve() } },
      window: {},
      fetch: async (url, init) => { posts.push({ url, init }); return { ok: true, json: async () => ({ ok: true }) }; },
      storage: { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: k => store.delete(k) },
    },
  });
  const notifications = createNotificationController(context, { autoBind: false, getToken: () => '' });

  assert.equal(await notifications.subscribe(), false, '关过推送时 subscribe() 必须拒绝');
  assert.equal(posts.length, 0, '一条都不该发给服务端');
  assert.equal(store.get('ccm_push_opt_out'), '1', 'opt-out 意图不得被悄悄抹掉');
});

// 上面那道闸不能把正门也锁上：用户显式点「开启」时必须能重新订上，否则关一次就再也开不回来。
test('notification controller requestSubscription() 是显式启用：清掉 opt-out 并重新订上', async () => {
  const posts = [];
  const store = new Map([['ccm_push_opt_out', '1']]);
  class NotificationMock {
    static permission = 'granted';
    static async requestPermission() { return 'granted'; }
  }
  const fakeSubscription = { endpoint: 'https://push.example/abc', toJSON() { return { endpoint: this.endpoint, keys: {} }; } };
  const registration = { pushManager: { getSubscription: async () => fakeSubscription } };
  const context = createAppContext({
    dom: { btnPush: { classList: { add() {}, remove() {} } } },
    dependencies: {
      navigator: {
        serviceWorker: { register: async () => registration, ready: Promise.resolve() },
        userAgent: 'Mozilla/5.0 (Linux; Android 14)',
      },
      window: { isSecureContext: true, PushManager: function () {}, matchMedia: () => ({ matches: false }) },
      Notification: NotificationMock,
      fetch: async (url, init) => {
        if (String(url).includes('/push/subscribe')) { posts.push(init); return { ok: true, json: async () => ({ ok: true }) }; }
        return { ok: true, json: async () => ({ key: 'test-vapid-key' }) };
      },
      storage: { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: k => store.delete(k) },
      alert: () => {},
    },
  });
  const notifications = createNotificationController(context, { autoBind: false, getToken: () => '' });

  await notifications.setup(); // 取 vapidKey；opt-out 下它自己不会去订阅
  assert.equal(posts.length, 0, '前置条件：setup() 没有自动订回来');

  await notifications.requestSubscription();
  assert.equal(posts.length, 1, '显式点开启必须真的订上——否则关一次就再也开不回来');
  assert.equal(store.has('ccm_push_opt_out'), false, '显式启用后 opt-out 意图应当作废');
});

// 只有「关」的按钮还不够：setup() 在 permission === 'granted' 时**无条件**调 subscribe()，
// 而通知权限在用户关掉推送后仍然是 granted —— 于是关掉之后随便刷一下页面就自动订回来了，
// 那个按钮等于没有。关闭必须是一个被记住的意图，而不是一次会被下次启动抹掉的瞬时动作。
// 【对照组是仪器校验】同一份夹具只改 opt-out 标志：不带标志那次必须真的发生自动订阅，
// 否则「没发生订阅」可能只是夹具根本走不到那条路径，测试恒绿。
test('notification controller setup() 不把用户主动关掉的推送自动订回来', async () => {
  const makeCtl = optedOut => {
    const posts = [];
    class NotificationMock {
      static permission = 'granted';
    }
    const store = new Map(optedOut ? [['ccm_push_opt_out', '1']] : []);
    const fakeSubscription = { endpoint: 'https://push.example/abc', toJSON() { return { endpoint: this.endpoint, keys: {} }; } };
    const registration = { pushManager: { getSubscription: async () => fakeSubscription } };
    const context = createAppContext({
      dom: { btnPush: { classList: { add() {}, remove() {} } } },
      dependencies: {
        navigator: {
          serviceWorker: { register: async () => registration, ready: Promise.resolve() },
          userAgent: 'Mozilla/5.0 (Linux; Android 14)',
        },
        window: { isSecureContext: true, PushManager: function () {}, matchMedia: () => ({ matches: false }) },
        Notification: NotificationMock,
        fetch: async (url, init) => {
          if (String(url).includes('/push/subscribe')) { posts.push(init); return { ok: true, json: async () => ({ ok: true }) }; }
          return { ok: true, json: async () => ({ key: 'test-vapid-key' }) };
        },
        storage: { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: k => store.delete(k) },
      },
    });
    return { ctl: createNotificationController(context, { autoBind: false, getToken: () => '' }), posts };
  };

  const fresh = makeCtl(false);
  await fresh.ctl.setup();
  await new Promise(r => setTimeout(r, 0)); // setup() 里是 void subscribe()，不等它
  assert.equal(fresh.posts.length, 1, '对照组：没关过推送时 setup() 本来就会自动订阅——这条保证下面那句不是恒绿');

  const optedOut = makeCtl(true);
  await optedOut.ctl.setup();
  await new Promise(r => setTimeout(r, 0));
  assert.equal(optedOut.posts.length, 0, '用户主动关过推送 → 刷新页面不得偷偷订回来');
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
