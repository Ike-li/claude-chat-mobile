import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server } from 'socket.io';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PUBLIC_DIR = join(HERE, '..', '..', '..', 'app', 'public');
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

// 出向事件的形状闸。真 server 的 instances 载荷只有 instancesPayload() 一个产地（app/src/server/app.js），
// service / canRestart 恒在；mock 却是 100 多处手写字面量，漏一处就是一条真 server 发不出来的事件。
// 前端对这两个字段都是**无条件覆盖**（`p?.service ?? null`、`p?.canRestart === true`），所以漏带不是
// "少一点信息"，是"把已有状态擦掉"：漏 service ⇒ latestServiceHealth 变 null ⇒ 配置面板「终端会话推送」
// 整段 classList.add('hidden') 且此后无人再喂；漏 canRestart ⇒ 「立即重启」入口消失。
//
// 2026-09-11 的 P0-25c 间歇失败就是 service 这一路：某个用例的异步尾巴在它自己的 test 结束后才 io.emit，
// 广播落到**下一个**用例的页面上（mock 的模块级状态与 io 都跨 test 存活，/__reset 复位不了已经在途的
// async 尾巴）。canRestart 是同形的第二路，env-config-panel 的 P0-31f/31g 分别钉住它的两侧取值。
//
// 【为什么是抛异常不是补默认值】补默认值等于让 mock 自己造一份，那是把分歧藏起来——下次真 server 改了
// 形状，mock 照样自洽地绿。抛异常则让"写了一条真 server 发不出的事件"当场可见：栈顶直接指向那行 emit。
// 夹具里响亮地炸掉，比悄悄发一条假事件便宜得多。
//
// 【只守这两个字段】needsYou / devMode / defaultModel 是全 mock 一致地不带（server.js 的 78 处也没有），
// 那是夹具的既有简化、不是两半之间的漂移，扩进来会改动多条 spec 的行为。
const REQUIRED_INSTANCES_FIELDS = ['service', 'canRestart'];

function assertOutboundShape(event) {
  if (event?.type !== 'instances') return;
  const payload = event?.payload;
  const missing = REQUIRED_INSTANCES_FIELDS.filter(field => !payload || !(field in payload));
  if (!missing.length) return;
  throw new Error(
    `mock transport: instances 事件缺少 ${missing.join(' / ')} 字段。真 server 的 instancesPayload() 恒带它们，`
    + '漏带会把前端已有状态擦掉（service→latestServiceHealth 变 null，配置面板「终端会话推送」整段消失；'
    + 'canRestart→「立即重启」入口消失）。请在该 payload 里补 service: mockServicePayload() / '
    + 'canRestart: getMockCanRestart()。'
  );
}

function guardAgentEvents(emitter) {
  const original = emitter.emit.bind(emitter);
  emitter.emit = (eventName, ...args) => {
    if (eventName === 'agent:event') assertOutboundShape(args[0]);
    return original(eventName, ...args);
  };
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

  guardAgentEvents(io);
  io.use((socket, next) => {
    if (rejectedTokens.has(socket.handshake.auth?.token)) {
      next(new Error('unauthorized'));
      return;
    }
    guardAgentEvents(socket); // 单播也要过闸：hydration 的 instances 走的就是 socket.emit
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
  // （app/src/server/http.js）—— 两处必须一致，否则 mock 下会出现真 server 没有的模块双实例：
  // app.js 引入的是 logic.js?v=xxx，而 app/*.js 里的 `../logic.js` 未戳版本 → 浏览器按 URL 缓存
  // 模块，两份 logic.js 各自 import 出一份 i18n.js，setLang() 只作用在其中一份。纯函数看不出问题，
  // 一旦子模块调到依赖 i18n 模块级 currentLang 的东西（如 t()），语言就永远停在默认值。
  // 正则须吃 `../`（`\.\.?\/`）：只认 `./` 会漏掉 app/*.js 里的 `../logic.js`，那正是本段要防的形态。
  app.get(/^\/js\/.+\.js$/i, (req, res, next) => {
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
