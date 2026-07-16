import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
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

function computeAssetVersion(selfJsDir, files) {
  const hash = createHash('sha256');
  for (const file of files) {
    try { hash.update(readFileSync(join(selfJsDir, file))); } catch { /* optional asset */ }
  }
  return hash.digest('hex').slice(0, 8);
}

export function configureHttpShell({
  app,
  projectRoot,
  isAccessEnabled,
  selfJsFiles = ['app.js', 'logic.js', 'tw-config.js', 'sw-cleanup.js'],
}) {
  app.use(compression());
  app.use((_req, res, next) => {
    setSecurityHeaders(res);
    next();
  });

  const publicDir = join(projectRoot, 'public');
  const vendorDir = join(publicDir, 'vendor');
  const selfJsDir = join(publicDir, 'js');
  const assetVersion = computeAssetVersion(selfJsDir, selfJsFiles);

  let indexHtml = null;
  let appJs = null;
  try {
    indexHtml = readFileSync(join(publicDir, 'index.html'), 'utf8')
      .replace(/(\/js\/[\w-]+\.js)(?!\?)/g, `$1?v=${assetVersion}`)
      .replace('<body ', `<body data-cf-access="${isAccessEnabled() ? '1' : '0'}" `);
  } catch { /* served as 500 below */ }
  try {
    appJs = readFileSync(join(selfJsDir, 'app.js'), 'utf8')
      .replace(/from\s+['"]\.\/logic\.js['"]/g, `from './logic.js?v=${assetVersion}'`);
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
