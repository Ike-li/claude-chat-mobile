import { createHash, timingSafeEqual } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join, relative, sep } from 'node:path';
import compression from 'compression';
import express from 'express';

export const clientIp = value => (value || '').toString().replace(/^::ffff:/, '');

// 局域网 IPv4（手机同 WiFi 直连用）。排除：VPN/代理虚拟网卡（utun* 等，手机不可达）、
// link-local（169.254.*）、RFC 2544 基准段（198.18/15，TUN 代理常用假网段）。
// interfaces 可注入（默认 os.networkInterfaces()）便于单测。
export function lanIPv4s(interfaces = networkInterfaces()) {
  return Object.entries(interfaces)
    .filter(([name]) => !/^(utun|tun|tap|ppp)/.test(name))
    .flatMap(([, addrs]) => addrs || [])
    .filter(i => i?.family === 'IPv4' && !i.internal
      && !i.address.startsWith('169.254.')
      && !/^198\.1[89]\./.test(i.address))
    .map(i => i.address);
}

export function setSecurityHeaders(res) {
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self' ws: wss:",
    "font-src 'self'",
    "frame-ancestors 'none'",
    // form-action 与 base-uri 都【不】回落到 default-src（CSP 规范），不显式声明即完全无限制：
    // 注入的 <form action="https://evil/"> 提交是导航、不走 connect-src，script-src 同样拦不住，
    // 用户被诱导填进去的 AUTH_TOKEN 会直接 POST 到外域。<base> 目前被 DOMPurify 剥掉，base-uri 是纵深。
    "form-action 'self'",
    "base-uri 'none'",
  ].join('; '));
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
}

export function tokenMatches(expected, provided) {
  if (!expected || typeof provided !== 'string') return false;
  const actual = Buffer.from(provided);
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

// HTTP 鉴权与 Socket 握手共用限速——否则 /health|/metrics|/push/* 可无限试 AUTH_TOKEN，
// 而同 IP 的 socket 已被 lock。rateLimit 可选；不传则行为与改造前一致（仅鉴权）。
// rateLimit = { active, sourceKey, getState, setState, onResult, now?, onLocked? }
// rateLimit.active：boolean 或 (req) => boolean。AUTH-NEW-1：公网 Host 即使无 AUTH_TOKEN 也须限速，
// 与 socket `publicHost || AUTH_TOKEN` 对齐；函数形可按请求 Host 判定。
function rateLimitActive(rl, req) {
  if (!rl) return false;
  const a = rl.active;
  if (typeof a === 'function') return !!a(req);
  return !!a;
}

export function createHttpAuth({ authToken, isPublicHost, verifyAccessJwt, rateLimit = null }) {
  return async function httpAuth(req, res, next) {
    try {
      const publicHost = isPublicHost(req.headers.host);
      const rl = rateLimit;
      if (rateLimitActive(rl, req)) {
        const key = rl.sourceKey(req);
        const st = rl.getState(key) || { failCount: 0, lockUntil: 0, lastFailTs: 0 };
        const now = rl.now ? rl.now() : Date.now();
        if (now < st.lockUntil) {
          res.setHeader?.('Retry-After', String(Math.ceil((st.lockUntil - now) / 1000)));
          return res.status(429).json({ status: 'rate_limited' });
        }
      }

      let authPassed = false;
      if (publicHost) {
        await verifyAccessJwt(req.headers['cf-access-jwt-assertion']);
        authPassed = true;
        // 供下游 handler 判「设备审批 bypass」：与 socket 侧 io.use 的 shouldBypassDeviceApproval
        // 同源判据（accessEnabled）。CF Access 已是更强的边界（2FA），走它进来的设备结构上不可能
        // 出现在待审列表里，见 /push/subscribe 的说明。
        req.ccmAccessEnabled = true;
      } else if (
        !authToken
        || tokenMatches(authToken, req.query.token)
        || tokenMatches(authToken, req.headers['x-auth-token'])
      ) {
        authPassed = true;
      }

      if (rateLimitActive(rl, req)) {
        const key = rl.sourceKey(req);
        const st = rl.getState(key) || { failCount: 0, lockUntil: 0, lastFailTs: 0 };
        const now = rl.now ? rl.now() : Date.now();
        const r = rl.onResult(st, authPassed, now);
        rl.setState(key, r.next);
        if (!authPassed && r.verdict === 'locked') {
          rl.onLocked?.(key, r);
          res.setHeader?.('Retry-After', String(Math.ceil((r.retryAfterMs || 0) / 1000)));
          return res.status(429).json({ status: 'rate_limited' });
        }
      }

      if (!authPassed) return res.status(401).json({ status: 'unauthorized' });
    } catch {
      // JWT 失败等：若启用了限速，计一次失败（与 socket 失败路径对齐）
      const rl = rateLimit;
      if (rateLimitActive(rl, req)) {
        try {
          const key = rl.sourceKey(req);
          const st = rl.getState(key) || { failCount: 0, lockUntil: 0, lastFailTs: 0 };
          const now = rl.now ? rl.now() : Date.now();
          if (now >= st.lockUntil) {
            const r = rl.onResult(st, false, now);
            rl.setState(key, r.next);
            if (r.verdict === 'locked') {
              rl.onLocked?.(key, r);
              res.setHeader?.('Retry-After', String(Math.ceil((r.retryAfterMs || 0) / 1000)));
              return res.status(429).json({ status: 'rate_limited' });
            }
          }
        } catch { /* 限速辅助失败不挡 401 */ }
      }
      return res.status(401).json({ status: 'unauthorized' });
    }
    // 鉴权已通过。next() 必须在 try 外（R6/2026-08-06）：下游 handler 的同步抛错不是鉴权失败——
    // 圈进上面的 catch 会给已通过鉴权的来源计一次失败（连续 8 次即 15min 锁定，机主被自家某个
    // handler 的 bug 锁在门外、审计被污染成「有人暴破」），并在响应可能已写出后二次 res.status(401)。
    // 下游异常原样向外传播，交给 Express 5 的错误处理（async 中间件的 rejection 会被其接住）。
    return next();
  };
}

// 递归收集 public/js 下全部 .js（含 app/* 子模块），供 assetVersion 哈希。
// 只哈希根层几个文件时，改 connection-sync.js 不会换 ?v=，手机继续吃缓存。
function listJsFilesRecursive(dir) {
  const out = [];
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listJsFilesRecursive(path));
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(path);
  }
  return out.sort();
}

function computeAssetVersion(selfJsDir, publicDir, files) {
  const hash = createHash('sha256');
  if (files?.length) {
    for (const file of files) {
      try { hash.update(readFileSync(join(selfJsDir, file))); } catch { /* optional */ }
    }
  } else {
    for (const path of listJsFilesRecursive(selfJsDir)) {
      try { hash.update(readFileSync(path)); } catch { /* optional */ }
    }
  }
  // css 进版本链：顶栏胶囊样式改完也能逼浏览器换新
  try { hash.update(readFileSync(join(publicDir, 'css', 'app.css'))); } catch { /* optional */ }
  return hash.digest('hex').slice(0, 8);
}

// index.html：/js/**/*.js 与 /css/**/*.css 统一打 ?v=（已带 query 的不重复追加）。
export function rewriteIndexAssetUrls(html, assetVersion) {
  return html.replace(
    /(\/(?:js|css)\/[\w./-]+\.(?:js|css))(?!\?)/g,
    `$1?v=${assetVersion}`,
  );
}

// app.js（及将来其它壳模块）：所有相对 ESM import 打 ?v=，含 ./app/*.js 与 ../logic.js。
// 只改 logic.js 会漏掉子模块——生产曾因此让 connection-sync 改动在手机上不生效。
export function rewriteAppModuleImports(source, assetVersion) {
  return source.replace(
    /from\s+(['"])(\.\.?\/[\w./-]+\.js)\1/g,
    `from '$2?v=${assetVersion}'`,
  );
}

export function configureHttpShell({
  app,
  projectRoot,
  isAccessEnabled,
  // 默认 null：哈希 public/js 全树 + css/app.css。传数组则仅哈希这些相对 selfJsDir 的路径（单测用）。
  selfJsFiles = null,
  // /js/** 子模块是否逐请求读盘（开发期改完刷新即生效）。默认关，专用开关 ASSET_HOT_RELOAD=1 打开。
  //
  // 为什么另起一个变量而不复用 DEV_MODE：① DEV_MODE 还管着 dev:restart（远程重启常驻服务），
  // 静态资源热读不该顺带把那个能力面一起打开；② 本仓 env-schema 把 DEV_MODE 定位成
  // 「dogfooding 常驻部署也可以开」，机主的生产配置里就是开着的 —— 拿它当判据等于在生产悄悄
  // 把启动预读撤回去，那正是这次优化想避免的。
  // 也不去嗅 node --watch：实测 --watch 被 node 自己消费掉，子进程的 process.execArgv 是空数组。
  hotReloadJs = process.env.ASSET_HOT_RELOAD === '1',
}) {
  app.use(compression());
  app.use((_req, res, next) => {
    setSecurityHeaders(res);
    next();
  });

  const publicDir = join(projectRoot, 'public');
  const vendorDir = join(publicDir, 'vendor');
  const selfJsDir = join(publicDir, 'js');
  // SW 必须在站点根才能拿到覆盖 / 的 scope（见 public/sw.js 与 app/notifications.js 的注释）
  const swScriptPath = join(publicDir, 'sw.js');
  const assetVersion = computeAssetVersion(selfJsDir, publicDir, selfJsFiles);

  // 三个读盘口。热读档（ASSET_HOT_RELOAD=1）逐请求调；生产档启动时调一次、请求期只查表。
  // ★ index.html 与 /js/app.js 必须和子模块【走同一档】：只给子模块接热读时，开发者改了
  // public/js/app.js（约 7000 行、前端改动的主要落点）刷新拿到的仍是启动快照，而子模块却真更新了
  // ——半新半旧比整体不更新更难判，且那句「改前端需重启」的横幅恰好只在生产档打印，热读档下
  // 没有任何线索能解释陈旧（2026-08-04 code review 实测）。
  const readSelfJsSource = (rel) => {
    try {
      return rewriteAppModuleImports(readFileSync(join(selfJsDir, rel), 'utf8'), assetVersion);
    } catch {
      return undefined; // 读不出就当它不存在，落到下面的 static 404
    }
  };
  const readIndexHtml = () => {
    try {
      return rewriteIndexAssetUrls(
        readFileSync(join(publicDir, 'index.html'), 'utf8'),
        assetVersion,
      ).replace('<body ', `<body data-cf-access="${isAccessEnabled() ? '1' : '0'}" `);
    } catch {
      return null; // served as 500 below
    }
  };

  const indexHtml = hotReloadJs ? null : readIndexHtml();
  const appJs = hotReloadJs ? null : readSelfJsSource('app.js');

  app.get(['/', '/index.html'], (_req, res) => {
    const html = hotReloadJs ? readIndexHtml() : indexHtml;
    if (!html) return res.status(500).send('index load error');
    res.setHeader('Cache-Control', 'no-store');
    return res.type('html').send(html);
  });
  app.get('/js/app.js', (_req, res) => {
    const source = hotReloadJs ? readSelfJsSource('app.js') : appJs;
    if (!source) return res.status(500).send('app.js load error');
    res.setHeader('Cache-Control', 'no-cache');
    return res.type('application/javascript').send(source);
  });
  // 子模块也改写相对 import 的 ?v=，避免 connection-sync 拉到未戳版本的 logic.js 双实例。
  // 生产档与上面的 indexHtml/appJs 同档：启动时读完、请求期只查表。这条路由排在鉴权之前
  // （静态资源必须登录前可取），每请求 readFileSync 会让未鉴权的高频请求同步阻塞事件循环。
  //
  // ★ 冻结【是】新增约束，别照 2026-08-02 那版注释理解：public/js 下除 app.js 外的全部子模块
  // （logic.js barrel / logic/*.js / i18n.js / app/*.js / 其余顶层 .js，由下面的递归扫描决定，
  // 不在此处写死数量——写死的计数会随目录增删静默失真）此前是逐请求读盘的，改完刷新就生效。
  // 冻结之后 `npm run dev`
  // 也救不了——node --watch 只监视被 import 的模块，public/js/** 不在服务端的 import 图里。
  // 所以开发档留了热读口子（hotReloadJs），并且两档各自把状态打印出来，别让人对着旧代码调半天。
  const selfJsSources = new Map();
  if (hotReloadJs) {
    // 热读档也要把状态说出来：横幅只在生产档打印时，开着开关的人看不到任何输出，
    // 一旦某处没接上热读就完全无从判断（这正是 /js/app.js 漏接时的处境）。
    console.log(`[assets] ASSET_HOT_RELOAD=1：index.html / /js/app.js / /js/** 全部逐请求读盘，改完刷新即生效（版本戳 ${assetVersion} 仍是启动时算的）`);
  } else {
    for (const path of listJsFilesRecursive(selfJsDir)) {
      const rel = relative(selfJsDir, path).split(sep).join('/');
      const source = readSelfJsSource(rel);
      // 读失败不能静默：那个文件此后会一路落到 static 被原样发出（相对 import 没戳 ?v=，
      // 正是本段要防的双实例形态），而没有任何东西会再提起它。
      if (source === undefined) console.warn(`[assets] 预读 /js/${rel} 失败，该子模块将由 static 原样发出（相对 import 不带 ?v=）`);
      else selfJsSources.set(rel, source);
    }
    console.log(`[assets] /js/** ${selfJsSources.size} 个子模块已在启动时读入并戳版本 ${assetVersion}；`
      + '改前端源码需重启本进程才生效（开发期设 ASSET_HOT_RELOAD=1 可改为逐请求读盘）');
  }
  app.get(/^\/js\/.+\.js$/, (req, res, next) => {
    if (req.path === '/js/app.js') return next(); // 上面专用路由已处理
    const rel = req.path.replace(/^\/js\//, '');
    if (rel.includes('..')) return res.status(400).end();
    const source = hotReloadJs ? readSelfJsSource(rel) : selfJsSources.get(rel);
    if (source === undefined) return next(); // 交给 static 404
    res.setHeader('Cache-Control', 'no-cache');
    return res.type('application/javascript').send(source);
  });
  app.use(express.static(publicDir, {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-store');
      // SW 脚本恒回源：它是推送链路的根，被任何中间层（CDN/浏览器）缓存住就会让修复送不到设备。
      // 2026-07-27 实测过一次同类事故——Cloudflare 缓存让 Service-Worker-Allowed 头到不了浏览器。
      else if (filePath === swScriptPath) res.setHeader('Cache-Control', 'no-store');
      else if (filePath.startsWith(selfJsDir) && filePath.endsWith('.js')) res.setHeader('Cache-Control', 'no-cache');
      else if (filePath.startsWith(vendorDir)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    },
  }));

  return { assetVersion, publicDir, selfJsDir, vendorDir };
}

export function registerOperationalRoutes({
  app,
  httpAuth,
  getHealth,
  getMetrics,
  push,
  isDeviceTrusted, // optional (token)=>bool；提供时 /push/subscribe 须绑已信任设备（A1）
  // optional (req)=>bool：该请求是否属于「设备审批 bypass」级信任（CF Access 已验 / 真本机直连）。
  // 与 socket 握手侧同源，见 /push/subscribe 里的说明。
  bypassDeviceApproval = null,
}) {
  app.get('/health', httpAuth, (_req, res) => res.json(getHealth()));
  app.get('/metrics', httpAuth, (_req, res) => res.json(getMetrics()));

  app.get('/push/vapid-public-key', httpAuth, (req, res) => {
    if (!push.enabled) return res.status(503).json({ error: 'push not configured' });
    console.log('[push] 浏览器获取公钥 from', req.ip);
    return res.json({ key: push.publicKey });
  });
  app.post('/push/subscribe', httpAuth, express.json({ limit: '4kb' }), (req, res) => {
    if (!push.enabled) return res.status(503).json({ error: 'push not configured' });
    if (!push.isValidSubscription(req.body)) return res.status(400).json({ error: 'invalid subscription' });
    // 第二因子：仅已批准设备可登记推送（A1）。deviceToken 来自身体或头，与 socket auth 同源。
    // bypass 级信任必须同样放行 —— 否则这道 fail-closed 用错了地方：socket 侧 io.use 对
    // 「CF Access 已验」与「真本机直连」走 bypass 分支，那条分支【不调 addPendingDevice】，于是这类设备
    // 永远进不了待审列表；而 approveDevice 的三个入口都要求先在待审列表里，机主在 UI/CLI 上根本看不到它、
    // 无从批准。结果：只从公网装 PWA 的手机（deployment.md 主推拓扑）POST /push/subscribe 恒 403，
    // 前端只把 'HTTP 403' 写进日志、按钮无提示 —— 推送在旗舰拓扑下静默失效。纯 localhost 部署同理。
    const bypassTrusted = typeof bypassDeviceApproval === 'function' && bypassDeviceApproval(req) === true;
    if (typeof isDeviceTrusted === 'function' && !bypassTrusted) {
      const deviceToken = (req.body && req.body.deviceToken)
        || req.get('x-device-token')
        || '';
      if (!isDeviceTrusted(deviceToken)) {
        return res.status(403).json({ error: 'device not trusted' });
      }
    }
    // 不把 deviceToken 写入订阅文件（非 web-push 字段）
    const { deviceToken: _dt, ...sub } = req.body && typeof req.body === 'object' ? req.body : {};
    push.saveSubscription(sub.endpoint ? sub : req.body);
    console.log('[push] 订阅已保存:', (req.body.endpoint || '').slice(0, 60) + '…');
    return res.json({ ok: true });
  });
}
