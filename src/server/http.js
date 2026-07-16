import { createHash, timingSafeEqual } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
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

// AUTH-001：HTTP 鉴权与 Socket 握手共用限速——否则 /health|/metrics|/push/* 可无限试 AUTH_TOKEN，
// 而同 IP 的 socket 已被 lock。rateLimit 可选；不传则行为与改造前一致（仅鉴权）。
// rateLimit = { active, sourceKey, getState, setState, onResult, now?, onLocked? }
export function createHttpAuth({ authToken, isPublicHost, verifyAccessJwt, rateLimit = null }) {
  return async function httpAuth(req, res, next) {
    try {
      const publicHost = isPublicHost(req.headers.host);
      const rl = rateLimit;
      if (rl?.active) {
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
      } else if (
        !authToken
        || tokenMatches(authToken, req.query.token)
        || tokenMatches(authToken, req.headers['x-auth-token'])
      ) {
        authPassed = true;
      }

      if (rl?.active) {
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
      return next();
    } catch {
      // JWT 失败等：若启用了限速，计一次失败（与 socket 失败路径对齐）
      const rl = rateLimit;
      if (rl?.active) {
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
  };
}

// 递归收集 public/js 下全部 .js（含 app/* 子模块），供 assetVersion 哈希。
// 只哈希根层几个文件时，改 connection-sync.js 不会换 ?v=，手机继续吃缓存。
function listJsFilesRecursive(dir) {
  const out = [];
  let entries = [];
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
}) {
  app.use(compression());
  app.use((_req, res, next) => {
    setSecurityHeaders(res);
    next();
  });

  const publicDir = join(projectRoot, 'public');
  const vendorDir = join(publicDir, 'vendor');
  const selfJsDir = join(publicDir, 'js');
  const assetVersion = computeAssetVersion(selfJsDir, publicDir, selfJsFiles);

  let indexHtml = null;
  let appJs = null;
  try {
    indexHtml = rewriteIndexAssetUrls(
      readFileSync(join(publicDir, 'index.html'), 'utf8'),
      assetVersion,
    ).replace('<body ', `<body data-cf-access="${isAccessEnabled() ? '1' : '0'}" `);
  } catch { /* served as 500 below */ }
  try {
    appJs = rewriteAppModuleImports(
      readFileSync(join(selfJsDir, 'app.js'), 'utf8'),
      assetVersion,
    );
  } catch { /* served as 500 below */ }

  app.get(['/', '/index.html'], (_req, res) => {
    if (!indexHtml) return res.status(500).send('index load error');
    res.setHeader('Cache-Control', 'no-store');
    return res.type('html').send(indexHtml);
  });
  app.get('/js/app.js', (_req, res) => {
    if (!appJs) return res.status(500).send('app.js load error');
    res.setHeader('Cache-Control', 'no-cache');
    return res.type('application/javascript').send(appJs);
  });
  // 子模块也改写相对 import 的 ?v=，避免 connection-sync 拉到未戳版本的 logic.js 双实例。
  app.get(/^\/js\/.+\.js$/, (req, res, next) => {
    if (req.path === '/js/app.js') return next(); // 上面专用路由已处理
    const rel = req.path.replace(/^\/js\//, '');
    if (rel.includes('..')) return res.status(400).end();
    try {
      const source = rewriteAppModuleImports(
        readFileSync(join(selfJsDir, rel), 'utf8'),
        assetVersion,
      );
      res.setHeader('Cache-Control', 'no-cache');
      return res.type('application/javascript').send(source);
    } catch {
      return next(); // 交给 static 404
    }
  });
  app.use(express.static(publicDir, {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-store');
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
    push.saveSubscription(req.body);
    console.log('[push] 订阅已保存:', req.body.endpoint.slice(0, 60) + '…');
    return res.json({ ok: true });
  });
}
