import { AsyncLocalStorage } from 'node:async_hooks';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server } from 'socket.io';
import {
  computeAssetVersion,
  injectModulePreloads,
  listAppModuleGraph,
  rewriteAppModuleImports,
  rewriteCssAssetUrls,
  rewriteIndexAssetUrls,
  setSecurityHeaders,
  versionedAssetCacheControl,
} from '../../../app/src/server/http.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PUBLIC_DIR = join(HERE, '..', '..', '..', 'app', 'public');
const DEFAULT_REJECTED_TOKENS = ['bad-token', 'invalid-token', 'expired-token'];
// 带这个令牌的握手按「来源已被长锁」拒（P0-20g）。
const RATE_LIMITED_TOKEN = 'rate-limited-token';

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

// 用例边界的时间闸。上面那条形状闸只管「发出去的是不是真 server 发得出的事件」，管不了「该不该由这条用例发」：
// /__reset 能复位模块状态，复位不了已经在途的 async 尾巴。场景开头从上下文快照了 viewingInstanceId，睡几秒
// 醒来再 io.emit——广播落到下一条用例的新页面上，把它刚切过去的视图拽回 inst_1。P0-SYNC-ACK-TIMEOUT 长期
// 间歇红就是这个（2026-10-19 查实：同片排在它前面的 RECAP-2 发了 test:tool，场景要跑 ~4.4s，用例 0.7s 就结束；
// 两条连跑 4/4 复现）。
// 做法：客户端每个事件进来时，用 AsyncLocalStorage 记下当时的用例代数（caseGeneration，即 /__reset 的计数）；
// 处理函数 await 之后 emit 时，代数已经变了就丢弃。ALS 跨 await / 定时器传递，各场景不必各自判断，新写的场景
// 自动受管。不在任何客户端事件里发出的（连接时的 hydration、HTTP 端点）不带代数，照常放行。
const caseScope = new AsyncLocalStorage();

function guardAgentEvents(emitter, caseGeneration) {
  const original = emitter.emit.bind(emitter);
  emitter.emit = (eventName, ...args) => {
    const born = caseScope.getStore();
    if (born !== undefined && born !== caseGeneration()) {
      console.log(`[mock] 丢弃上一条用例的尾巴：${eventName} ${args[0]?.type ?? ''}（代数 ${born} → ${caseGeneration()}）`);
      return false;
    }
    if (eventName === 'agent:event') assertOutboundShape(args[0]);
    return original(eventName, ...args);
  };
}

export function createMockTransport({
  publicDir = DEFAULT_PUBLIC_DIR,
  buildNonce = process.env.CCM_BUILD_NONCE || null,
  rejectedAuthTokens = DEFAULT_REJECTED_TOKENS,
  caseGeneration = () => 0, // 当前用例的代数（server.js 传 /__reset 计数），见 caseScope
} = {}) {
  const app = express();
  const httpServer = createServer(app);
  const io = new Server(httpServer, { cors: { origin: '*' } });
  const rejectedTokens = new Set(rejectedAuthTokens);
  const jsDir = join(publicDir, 'js');
  // 版本戳、index 的模块预载与 ?v= 改写、子模块改写、缓存头判据都直接用真 server 那一份：桌面性能对照
  // 跑在 mock 上，这几处一分叉，量出来的冷/热启动就不是生产那条路径。
  const assetVersion = computeAssetVersion(jsDir, publicDir, null, join(publicDir, 'vendor'));
  const modulePreloads = listAppModuleGraph(jsDir);

  guardAgentEvents(io, caseGeneration);
  // 验收 O83：模拟真 server 的退避短锁。上锁后窗口内的握手一律回 cooldown（令牌不校验），
  // err.data 的形状与真 server 的 rejectHandshake 一致。
  let authCooldownUntil = 0;
  io.use((socket, next) => {
    const cooldownLeft = authCooldownUntil - Date.now();
    if (cooldownLeft > 0) {
      const err = new Error('cooldown');
      err.data = { reason: 'cooldown', retryAfterMs: cooldownLeft, retryAfterSeconds: Math.max(1, Math.ceil(cooldownLeft / 1000)) };
      next(err);
      return;
    }
    const token = socket.handshake.auth?.token;
    // 不带令牌一律拒：真 server 在非公网 Host 上不留「无 token 放行」的分支（AUTH_TOKEN 是启动前提）。
    // mock 此前放行无令牌握手，「开页没令牌也照样连上」在 E2E 里成立、在真机上不成立（验收 O20）。
    if (!token || rejectedTokens.has(token)) {
      next(new Error('unauthorized'));
      return;
    }
    // 被防暴破长锁拦下：与真 server 的 rejectHandshake 同形（message + data.retryAfterSeconds）。
    if (token === RATE_LIMITED_TOKEN) {
      const err = new Error('rate_limited');
      err.data = { reason: 'rate_limited', retryAfterMs: 900_000, retryAfterSeconds: 900 };
      next(err);
      return;
    }
    guardAgentEvents(socket, caseGeneration); // 单播也要过闸：hydration 的 instances 走的就是 socket.emit
    // 每个入向事件在「收到时的用例代数」里派发；socket.io 经 process.nextTick 调处理函数，ALS 随之传递
    socket.use((_packet, nextPacket) => caseScope.run(caseGeneration(), nextPacket));
    next();
  });

  // 复用真 server 的同一份安全头函数（含 CSP），不再手写一份子集——此前只带
  // X-Content-Type-Options/Referrer-Policy 两个头，整套 E2E 套件在零 CSP 下跑，前端代码
  // 哪怕不小心引入了内联脚本/eval/越权外部资源，这类违规只有真实生产环境才会拦，
  // 测试永远不会红。
  app.use((req, res, next) => {
    setSecurityHeaders(res, req.headers?.host);
    next();
  });
  app.use(versionedAssetCacheControl(() => assetVersion));

  app.post('/__auth-cooldown', (req, res) => {
    authCooldownUntil = Date.now() + Math.max(0, Number(req.query?.ms) || 0);
    res.json({ ok: true });
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
      const html = rewriteIndexAssetUrls(
        injectModulePreloads(readFileSync(join(publicDir, 'index.html'), 'utf8'), modulePreloads),
        assetVersion,
      );
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
      .send(rewriteAppModuleImports(source, assetVersion));
  });

  // css 里 url() 的字体引用同样戳 ?v=，与真 server 同一份 rewriteCssAssetUrls；漏了字体就一直 304 重验。
  app.get(/^\/css\/.+\.css$/i, (req, res, next) => {
    const rel = req.path.slice('/css/'.length);
    if (rel.includes('..')) return next();
    let source;
    try {
      source = readFileSync(join(publicDir, 'css', rel), 'utf8');
    } catch {
      return next();
    }
    res.type('text/css').send(rewriteCssAssetUrls(source, assetVersion));
  });

  app.use(express.static(publicDir, {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-store');
    },
  }));

  const resetAuthCooldown = () => { authCooldownUntil = 0; };
  return { app, httpServer, io, assetVersion, resetAuthCooldown };
}
