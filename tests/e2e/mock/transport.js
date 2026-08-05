import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server } from 'socket.io';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PUBLIC_DIR = join(HERE, '..', '..', '..', 'public');
const DEFAULT_REJECTED_TOKENS = ['bad-token', 'invalid-token', 'expired-token'];

function javascriptFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...javascriptFiles(path));
    else if (entry.isFile() && entry.name.endsWith('.js')) files.push(path);
  }
  return files.sort();
}

export function computeMockAssetVersion(publicDir = DEFAULT_PUBLIC_DIR) {
  const hash = createHash('sha256');
  for (const path of javascriptFiles(join(publicDir, 'js'))) {
    hash.update(readFileSync(path));
  }
  hash.update(readFileSync(join(publicDir, 'css', 'app.css')));
  return hash.digest('hex').slice(0, 8);
}

export function createMockTransport({
  publicDir = DEFAULT_PUBLIC_DIR,
  buildNonce = process.env.CCM_BUILD_NONCE || null,
  rejectedAuthTokens = DEFAULT_REJECTED_TOKENS,
} = {}) {
  const app = express();
  const httpServer = createServer(app);
  const io = new Server(httpServer, { cors: { origin: '*' } });
  const rejectedTokens = new Set(rejectedAuthTokens);
  const jsDir = join(publicDir, 'js');
  const assetVersion = computeMockAssetVersion(publicDir);

  io.use((socket, next) => {
    if (rejectedTokens.has(socket.handshake.auth?.token)) {
      next(new Error('unauthorized'));
      return;
    }
    next();
  });

  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  app.get('/__ready', (req, res) => {
    const requestedNonce = req.query?.nonce;
    if (requestedNonce !== undefined && requestedNonce !== buildNonce) {
      return res.status(409).json({ ok: false, nonce: buildNonce });
    }
    res.json({ ok: true, nonce: buildNonce });
  });

  app.get(['/', '/index.html'], (_req, res) => {
    try {
      const html = readFileSync(join(publicDir, 'index.html'), 'utf8')
        .replace(/(\/(?:js|css)\/[\w./-]+\.(?:js|css))(?!\?)/g, `$1?v=${assetVersion}`)
        .replace('</head>', '<script>window.SERVER_CF_ACCESS_ENABLED = false;</script></head>');
      res.setHeader('Cache-Control', 'no-store');
      res.type('html').send(html);
    } catch (error) {
      res.status(500).send(`index load error: ${error.message}`);
    }
  });

  // /js/** 全部子模块都要改写相对 import 的 ?v=，与真 server 的 rewriteAppModuleImports 同款正则
  // （src/server/http.js）—— 两处必须一致，否则 mock 下会出现真 server 没有的模块双实例：
  // app.js 引入的是 logic.js?v=xxx，而 app/*.js 里的 `../logic.js` 未戳版本 → 浏览器按 URL 缓存
  // 模块，两份 logic.js 各自 import 出一份 i18n.js，setLang() 只作用在其中一份。纯函数看不出问题，
  // 一旦子模块调到依赖 i18n 模块级 currentLang 的东西（如 t()），语言就永远停在默认值。
  // 正则须吃 `../`（`\.\.?\/`）：只认 `./` 会漏掉 app/*.js 里的 `../logic.js`，那正是本段要防的形态。
  app.get(/^\/js\/.+\.js$/, (req, res, next) => {
    const rel = req.path.slice('/js/'.length);
    if (rel.includes('..')) return next();
    let source;
    try {
      source = readFileSync(join(jsDir, rel), 'utf8');
    } catch {
      return next(); // 不存在 → 交给 static 出 404，别把读失败伪装成 500
    }
    res.setHeader('Cache-Control', 'no-cache');
    res.type('application/javascript')
      .send(source.replace(/from\s+(['"])(\.\.?\/[\w./-]+\.js)\1/g, `from '$2?v=${assetVersion}'`));
  });

  app.use(express.static(publicDir, {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-store');
      else if (filePath.startsWith(jsDir) && filePath.endsWith('.js')) res.setHeader('Cache-Control', 'no-cache');
    },
  }));

  return { app, httpServer, io, assetVersion };
}
