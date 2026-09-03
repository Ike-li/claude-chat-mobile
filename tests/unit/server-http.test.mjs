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

// AUTH-001：HTTP 鉴权失败计入共享限速，达阈值 → 429
test('createHttpAuth rateLimit：连续失败锁定 → 429（AUTH-001）', async () => {
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
// 机主被自家某个 handler 的 bug 锁在门外），且在响应可能已写出后二次 res.status(401)。
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
  assert.equal((states.get('ip:7.7.7.7')?.failCount ?? 0), 0, '失败计数必须为 0——否则 8 个下游 bug 就把机主锁 15 分钟');
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
// 结构上永远进不了待审列表；approveDevice 的三个入口又都要求先在待审列表里，机主在 UI/CLI 上看不到它、
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
    const app = { use: () => {}, get: (p, ...h) => routes.set(String(p), h) };
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
    return { root, run, invoke };
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

  // 判据必须是专用开关，不能是 DEV_MODE：机主的生产 .env 里 DEV_MODE=1（.env.example 明确说
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
