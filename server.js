// server.js —— Express 静态托管 + Socket.IO 契约层。
// 会话与 socket 解耦：AgentSession 挂在服务端（4c 物理不变量），事件 io.emit 广播（多设备同看）。
import dotenv from 'dotenv'; // 不用 'dotenv/config'：需在 config() 前快照 shell 的 ANTHROPIC_*（见下方规整块）
import { createServer } from 'node:http';
import { statSync, readFileSync, writeFileSync, realpathSync, existsSync, mkdirSync, appendFileSync, unlinkSync } from 'node:fs';
import webpush from 'web-push';
import { maskToken } from './sanitizer.js';
import { writeOwnerOnlyFile } from './file-security.js';
import { homedir, networkInterfaces } from 'node:os';
import { join, dirname } from 'node:path';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { timingSafeEqual, createHash } from 'node:crypto';
import express from 'express';
import compression from 'compression';
import { Server } from 'socket.io';
import { AgentSession } from './agent.js';
import * as sessions from './sessions.js';
import { getSessionHistory, listSessions, sessionFileExists, getProjectDir, invalidateListCache } from './history.js';
import { buildWebStatusLine } from './statusline.js';
import { validateAttachments, saveAttachments, buildPromptText, toEventMeta } from './uploads.js';
import * as interactionLog from './interaction-log.js';
import { createModelsCache } from './models-cache.js';
import { initCfAccess, isAccessEnabled, isPublicHost, verifyAccessJwt } from './cf-access.js';
import { watch } from 'node:fs';
import {
  isDeviceTrusted,
  addPendingDevice,
  removePendingDevice,
  getLatestPendingDevice,
  approveDevice,
  denyDevice,
  getPendingDevices
} from './devices.js';

// #9：dotenv 后一次性剥除空串环境变量，使 .env 里的空行（WORK_DIR= 等）等价于"未设置"，
// 让下方解构默认值与 Number() 容错统一在一处生效，而非每个读取点各自 `|| / .trim() ||`。
// ANTHROPIC_*（凭据/网关/模型）只能来自终端环境（2026-06-12 机主决定）：
// config() 前快照 shell 已有键，加载后删除 .env 新注入的——web 与终端不得因 .env 分叉。
const shellAnthropicKeys = new Set(Object.keys(process.env).filter(k => k.startsWith('ANTHROPIC_')));
dotenv.config();
for (const k of Object.keys(process.env)) {
  if (process.env[k] === '') delete process.env[k];
  else if (k.startsWith('ANTHROPIC_') && !shellAnthropicKeys.has(k)) delete process.env[k];
}

// env 规整后初始化 Cloudflare Access（CF_ACCESS_* 三项齐全才启用；缺则 isPublicHost 恒 false=回退 token）。
initCfAccess();

const {
  PORT = 3000,
  AUTH_TOKEN = '',
  IDLE_TIMEOUT_MS = 600000
} = process.env;
// WORK_DIR 单列为 let：preflight 通过存在性检查后经 realpathSync 规范化（与 CLI 的
// ~/.claude/projects 命名一致，令会话列表 cwd 隔离匹配稳健，如 /tmp→/private/tmp）。
let WORK_DIR = process.env.WORK_DIR || homedir();
// 多 repo 台阶1：可在 web 内切换的工作目录白名单（WORK_DIR + WORK_DIRS，preflight 内构建）。
let workDirs = [];

const idleTimeoutMs = Number(IDLE_TIMEOUT_MS) > 0 ? Number(IDLE_TIMEOUT_MS) : 600000;
const port = Number(PORT) > 0 ? Number(PORT) : 3000;
const HERE = import.meta.dirname; // #14：所有相对路径锚定模块目录，从任何 cwd 启动都一致
// CCM_DATA_DIR 覆盖状态文件根目录——仅测试用：让 E2E 把 init-cache/devices/push-subscription/sessions
// 全部重定向到临时目录，与生产 data/ 彻底解耦（生产常驻 server 正读写 data/，测试绝不能碰）。
// 与 CCM_SESSIONS_FILE（sessions.js）同精神，皆为内部测试 hook，不对外暴露、不列入配置文档。
const DATA_DIR = process.env.CCM_DATA_DIR || join(HERE, 'data');

// ---- Web Push（E15）----
const VAPID_PUBLIC_KEY  = process.env.VAPID_PUBLIC_KEY  || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_SUBJECT     = process.env.VAPID_SUBJECT     || '';
const pushEnabled = !!(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY && VAPID_SUBJECT);
if (pushEnabled) webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

const PUSH_SUB_FILE = join(DATA_DIR, 'push-subscription.json');
// 多设备：按 endpoint 去重的订阅数组（旧版单对象格式向后兼容读入）。手机 + iPad 各留一条，
// 推送时遍历全部、按 410/404 单独剔除失效——不再"后订阅顶掉前订阅"只剩最后一台收推送。
let pushSubscriptions = [];
try {
  const raw = JSON.parse(readFileSync(PUSH_SUB_FILE, 'utf8'));
  if (Array.isArray(raw)) pushSubscriptions = raw.filter(s => s?.endpoint);
  else if (raw?.endpoint) pushSubscriptions = [raw]; // 向后兼容旧单对象格式
} catch {}

function persistPushSubscriptions() {
  try { writeFileSync(PUSH_SUB_FILE, JSON.stringify(pushSubscriptions)); } catch (e) {
    console.error('[push] 保存订阅失败:', e.message);
  }
}
function savePushSubscription(sub) {
  if (!sub?.endpoint) return;
  pushSubscriptions = pushSubscriptions.filter(s => s.endpoint !== sub.endpoint); // 同设备重订覆盖
  pushSubscriptions.push(sub);
  persistPushSubscriptions();
}

async function pushNotify(title, body) {
  if (!pushEnabled || pushSubscriptions.length === 0) return;
  const payload = JSON.stringify({ title, body });
  const expired = [];
  await Promise.all(pushSubscriptions.map(sub =>
    webpush.sendNotification(sub, payload).catch(e => {
      if (e.statusCode === 410 || e.statusCode === 404) expired.push(sub.endpoint); // 过期/注销
      else console.error('[push] 推送失败:', e.statusCode ?? '', e.message);
    })
  ));
  if (expired.length) {                       // 仅剔除失效的那几条，其余设备订阅保留
    pushSubscriptions = pushSubscriptions.filter(s => !expired.includes(s.endpoint));
    persistPushSubscriptions();
    console.warn(`[push] 清除 ${expired.length} 条失效订阅`);
  }
}

// ---- 启动预检（验收 A9）----
// E9：必须用本机的 claude（你日常在终端用的那个），不用 SDK 捆绑副本——
// 版本、登录态、代理兼容性都以本机为准。
const versions = { sdk: 'unknown', cli: 'unknown' };

function preflight() {
  const fail = msg => {
    console.error(`\n❌ 启动失败：${msg}\n`);
    process.exit(1);
  };
  try {
    if (!statSync(WORK_DIR).isDirectory()) fail(`WORK_DIR 不是目录：${WORK_DIR}`);
  } catch {
    fail(`WORK_DIR 不存在：${WORK_DIR}（请在 .env 中设置有效路径）`);
  }
  WORK_DIR = realpathSync(WORK_DIR); // 规范化（解符号链接/相对段）：存储与查找的 cwd 同 CLI 命名，cwd 隔离匹配稳健
  // 多 repo 台阶1：白名单 = WORK_DIR（首位）+ WORK_DIRS_FILE（JSON 数组文件，每个目录一个字符串元素），
  // 若未设 WORK_DIRS_FILE 则回退 WORK_DIRS（逗号分隔，向后兼容）。
  // 无效项告警跳过不挡启动，去重。只设 WORK_DIR 则 workDirs=[WORK_DIR]，前端目录切换器隐藏（退化单目录）。
  workDirs = [WORK_DIR];
  let rawDirs = [];
  const dirsFile = process.env.WORK_DIRS_FILE;
  if (dirsFile) {
    const filePath = dirsFile.startsWith('/') ? dirsFile : join(HERE, dirsFile);
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
      if (Array.isArray(parsed)) {
        rawDirs = parsed.filter(e => typeof e === 'string').map(s => s.trim()).filter(Boolean);
      } else {
        console.warn(`⚠️  WORK_DIRS_FILE 不是 JSON 数组：${filePath}`);
      }
    } catch (e) {
      console.warn(`⚠️  WORK_DIRS_FILE 读取/解析失败（${filePath}）：${e.message}`);
    }
  } else {
    rawDirs = (process.env.WORK_DIRS || '').split(',').map(s => s.trim()).filter(Boolean);
  }
  for (const raw of rawDirs) {
    try {
      const d = realpathSync(raw);
      if (!statSync(d).isDirectory()) { console.warn(`⚠️  WORK_DIRS 忽略（不是目录）：${raw}`); continue; }
      if (!workDirs.includes(d)) workDirs.push(d);
    } catch {
      console.warn(`⚠️  WORK_DIRS 忽略（不存在/不可达）：${raw}`);
    }
  }
  let claudeBin = process.env.CLAUDE_BIN || '';
  if (!claudeBin) {
    try {
      claudeBin = execSync('which claude', { encoding: 'utf8' }).trim();
    } catch {
      fail('未找到 claude 命令。请先安装 Claude Code，或在 .env 中用 CLAUDE_BIN 指定路径');
    }
  }
  try {
    statSync(claudeBin);
  } catch {
    fail(`CLAUDE_BIN 指向的文件不存在：${claudeBin}`);
  }
  // 版本采集（/health 暴露，用于升级后回归核对）
  try {
    versions.cli = execSync(`"${claudeBin}" --version`, { encoding: 'utf8' }).trim();
  } catch { /* 非致命 */ }
  try {
    const require = createRequire(import.meta.url);
    versions.sdk = require('@anthropic-ai/claude-agent-sdk/package.json').version;
  } catch { /* 非致命 */ }
  if (!process.env.ANTHROPIC_AUTH_TOKEN && !process.env.ANTHROPIC_API_KEY) {
    console.warn('⚠️  未检测到 ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY，将依赖 claude CLI 自身的登录态');
  }
  return claudeBin;
}
const claudeBin = preflight();
// 多 repo 台阶3：viewingInstanceId = 前端当前查看的 tab 实例（台阶2 viewingCwd 的细化）。
// 切 tab 只换视图、不 dispose（各实例后台并行存活，见 agents Map）。初值 null——启动预热后置为初始 tab。
let viewingInstanceId = null;
// viewingCwd = 当前查看实例的工作目录上下文（新建会话选目录 / statusline git 段 / 白名单维度）。
// 必须在 preflight 之后取（WORK_DIR 在 preflight 内才 realpathSync 规范化，否则 cwd 隔离失灵）。
let viewingCwd = WORK_DIR;
const viewingCwdOf = () => agents.get(viewingInstanceId)?.cwd ?? viewingCwd;
// 白名单校验 + 缺省落 viewingCwd：cwd 维度的事件（setWorkdir/session:list/new）经此解析目标 cwd。
const routeCwd = cwd => (typeof cwd === 'string' && workDirs.includes(cwd)) ? cwd : viewingCwdOf();
// 台阶3：按实例路由——instanceId ∈ live 则该实例，否则缺省落 viewingInstanceId（向后兼容缺参旧调用、防越界）。
const resolveInstanceId = id => agents.has(id) ? id : viewingInstanceId;
const routeInstance = id => agents.get(resolveInstanceId(id)) ?? null;

// ---- HTTP ----
const app = express();
app.use(compression());
app.use((_req, res, next) => {
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self'",                  // 前端库 vendored 到 public/vendor/、无内联脚本（SW 自注销外置 /js/sw-cleanup.js）
    "style-src 'self' 'unsafe-inline'",   // Tailwind 运行时注入内联 <style>，保留 unsafe-inline
    "img-src 'self' data:",
    "connect-src 'self' ws: wss:",
    "font-src 'self'",
    "frame-ancestors 'none'" // #8：不从 default-src 继承，必须显式声明，防审批弹窗被 iframe clickjack
  ].join('; '));
  res.setHeader('X-Frame-Options', 'DENY');           // #8：旧浏览器兜底
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  // HSTS（HTTPS 由 Cloudflare 提供；HTTP/局域网下浏览器自动忽略此头）。不加 preload——自由域名不宜做不可逆承诺。
  res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
  next();
});
// 来源 IP 规整（去 IPv4-mapped IPv6 前缀 ::ffff:）——用于 socket 连接/鉴权失败日志分辨手机/本机
const clientIp = v => (v || '').toString().replace(/^::ffff:/, '');
// 缓存分层：外壳 index.html 永不缓存（杜绝手机拿到旧 HTML/旧脚本引用）；自写 /js/*.js 用 no-cache
// （每次带 etag 验证、改了立即生效、未变则 304 省流量——根治“改了代码手机仍跑旧 app.js”，2026-06-15）；
// /vendor/* 第三方库版本固定，超长强缓存以支持 Immutable。
const VENDOR_DIR = join(HERE, 'public', 'vendor');
const SELF_JS_DIR = join(HERE, 'public', 'js'); // 自写脚本目录（app.js/sw-cleanup.js），区别于 /vendor/*
// 自写 /js/ 资源内容指纹（破 CDN/浏览器缓存，2026-06-17：CF 边缘缓存旧 app.js 致前端改动不生效）：
// 启动时按所有自写 JS 内容算短 hash；动态托管 index.html / app.js 时注入 ?v=<hash>，改代码即换 URL、缓存层必拿新。
const SELF_JS_FILES = ['app.js', 'logic.js', 'tw-config.js', 'sw-cleanup.js'];
function computeAssetVersion() {
  const h = createHash('sha256');
  for (const f of SELF_JS_FILES) { try { h.update(readFileSync(join(SELF_JS_DIR, f))); } catch { /* 缺文件忽略 */ } }
  return h.digest('hex').slice(0, 8);
}
const ASSET_VERSION = computeAssetVersion();
// P1 性能优化：启动期一次性完成 index.html / app.js 的版本注入与转换，缓存为内存常量。
// 输入全是启动期常量（ASSET_VERSION / isAccessEnabled()），重启才可能变化——重启即重算，与 ASSET_VERSION 同款生命周期。
// 消除每请求的同步 readFileSync（≈100KB）+ 正则；--watch 模式进程重启时自动重建，行为不变。
function buildIndexHtml() {
  try {
    return readFileSync(join(HERE, 'public', 'index.html'), 'utf8')
      .replace(/(\/js\/[\w-]+\.js)(?!\?)/g, `$1?v=${ASSET_VERSION}`)
      .replace('<body ', `<body data-cf-access="${isAccessEnabled() ? '1' : '0'}" `);
  } catch { return null; }
}
function buildAppJs() {
  try {
    return readFileSync(join(SELF_JS_DIR, 'app.js'), 'utf8')
      .replace(/from\s+['"]\.\/logic\.js['"]/g, `from './logic.js?v=${ASSET_VERSION}'`);
  } catch { return null; }
}
const INDEX_HTML_CACHED = buildIndexHtml();
const APP_JS_CACHED = buildAppJs();
// index.html：注入版本到 /js/*.js 引用（no-store，外壳每次新、避免 CF 缓存 HTML）。须在 static 之前。
app.get(['/', '/index.html'], (_req, res) => {
  if (!INDEX_HTML_CACHED) return res.status(500).send('index load error');
  res.setHeader('Cache-Control', 'no-store');
  res.type('html').send(INDEX_HTML_CACHED);
});
// app.js：把内部 import './logic.js' 也带上版本（ES module 子依赖否则仍走旧缓存）。须在 static 之前。
app.get('/js/app.js', (_req, res) => {
  if (!APP_JS_CACHED) return res.status(500).send('app.js load error');
  res.setHeader('Cache-Control', 'no-cache');
  res.type('application/javascript').send(APP_JS_CACHED);
});
app.use(express.static(join(HERE, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-store');
    else if (filePath.startsWith(SELF_JS_DIR) && filePath.endsWith('.js')) res.setHeader('Cache-Control', 'no-cache');
    else if (filePath.startsWith(VENDOR_DIR)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  }
}));
// ---- HTTP 鉴权（公网 Host 强制 Access JWT、fail-closed；LAN/本机回退 AUTH_TOKEN）----
// 常量时间比较，防计时侧信道（替代原 !== 短路比较）。按字节长度比，多字节 token 也安全。
function tokenMatches(got) {
  if (!AUTH_TOKEN || typeof got !== 'string') return false;
  const a = Buffer.from(got), b = Buffer.from(AUTH_TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}
// 统一 HTTP 鉴权（/health 与 /push/* 共用）：公网（经 CF 隧道、Host=CF_ACCESS_HOSTNAME）→ 强制验
// Access JWT、不接受 token 回退（堵"不发头改走 token 路"后门）；LAN/本机 → AUTH_TOKEN 闸（未设则放行，
// 仅 localhost 监听，便于本地冒烟探活）。Access 未启用时 isPublicHost 恒 false = 改造前行为（向后兼容）。
async function httpAuth(req, res, next) {
  try {
    if (isPublicHost(req.headers.host)) {
      await verifyAccessJwt(req.headers['cf-access-jwt-assertion']);
      return next();
    }
    if (!AUTH_TOKEN || tokenMatches(req.query.token) || tokenMatches(req.headers['x-auth-token'])) return next();
    return res.status(401).json({ status: 'unauthorized' });
  } catch {
    return res.status(401).json({ status: 'unauthorized' }); // 公网 JWT 校验失败 = fail-closed
  }
}
app.get('/health', httpAuth, (req, res) => {
  // 鉴权见 httpAuth（公网 Access JWT / LAN token）：未授权方不得读 sessionId/busy 等运行状态。
  res.json({
    status: 'ok',
    sessionId: agents.get(viewingInstanceId)?.sessionId ?? null, // 台阶3：报当前查看 tab 实例的会话
    busy: [...agents.values()].some(a => a.pendingTurns > 0), // 任一实例在跑即 busy
    versions, // { sdk, cli }，升级回归核对
    timestamp: Date.now()
  });
});
app.get('/push/vapid-public-key', httpAuth, (req, res) => {
  if (!pushEnabled) return res.status(503).json({ error: 'push not configured' });
  console.log('[push] 浏览器获取公钥 from', req.ip);
  res.json({ key: VAPID_PUBLIC_KEY });
});
app.post('/push/subscribe', httpAuth, express.json({ limit: '4kb' }), (req, res) => {
  if (!pushEnabled) return res.status(503).json({ error: 'push not configured' });
  if (!req.body?.endpoint) return res.status(400).json({ error: 'invalid subscription' });
  savePushSubscription(req.body);
  console.log('[push] 订阅已保存:', req.body.endpoint.slice(0, 60) + '…');
  res.json({ ok: true });
});

// 历史回显（E14）改走鉴权 socket 事件 session:history（见下方 io.on），不再开无鉴权 HTTP 端点：
// 本服务约定前后端唯一通道是 Socket.IO，HTTP 数据面既越契约、又绕过握手鉴权。

const httpServer = createServer(app);
// E17：maxHttpBufferSize 默认仅 1MB，会直接拒收带附件的消息。抬到 32MB——
// 附件总量上限 20MB（解码后），base64 上线 ~1.33x ≈ 27MB + JSON 开销，32MB 留足余量。
const io = new Server(httpServer, {
  perMessageDeflate: { threshold: 1024 },
  maxHttpBufferSize: 32 * 1024 * 1024
});

// ---- 设备审批辅助函数 ----
function getSocketsByDeviceToken(deviceToken) {
  const list = [];
  if (!deviceToken) return list;
  for (const socket of io.sockets.sockets.values()) {
    if (socket.handshake.auth?.deviceToken === deviceToken) {
      list.push(socket);
    }
  }
  return list;
}

function unlockSocket(socket) {
  if (socket.deviceApproved) return; // 已经批准了
  socket.deviceApproved = true;

  const deviceToken = socket.handshake.auth?.deviceToken;
  socket.emit('agent:event', {
    seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
    type: 'device_status', payload: { status: 'approved', deviceId: deviceToken }
  });

  // 无缝补发跳过的初始数据重放，使用户不需要刷新页面即可直入聊天界面
  if (lastInit) {
    const va = agents.get(viewingInstanceId);
    // #5：重放不带 slashCommands——lastInit 是全局最近一次任意实例 init，斜杠命令含 project 级项，
    // 跨 repo/tab 重放会串（前端会用别 repo 的命令覆盖提示）；剔除后前端保留 localStorage 缓存、真 init 到达即校正
    const { slashCommands: _omitCmds, ...initBase } = lastInit;
    socket.emit('agent:event', {
      seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
      type: 'init', payload: {
        ...initBase,
        permissionMode: permModeOf(viewingInstanceId),
        // model/cwd 校正到当前查看 tab：va 存在用实例值（FRESH 实例 activeModel 为空则 null，不回退 lastInit）；
        // va 为空（空首页）model 不下发=null（新会话模型=env 默认、服务端不可知，前端显「不指定」，A1）、cwd 用 viewingCwd
        ...(va ? { model: va.activeModel ?? null, cwd: va.cwd }
              : { model: null, cwd: viewingCwd })
      }
    });
  }
  // models 校正到当前查看 tab 的 cwd：未知工作区不重放（前端保留 localStorage 缓存、真 models 到达即校正），绝不回退别区清单
  const replayModels = modelsCache.get(agents.get(viewingInstanceId)?.cwd ?? viewingCwd);
  if (replayModels) {
    socket.emit('agent:event', {
      seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
      type: 'models', payload: replayModels
    });
  }
  if (lastStatusLine) {
    socket.emit('agent:event', {
      seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
      type: 'status_line', payload: lastStatusLine.payload
    });
  }
  permModeTo(socket);
  effortTo(socket);
  instancesTo(socket);
  scheduleStatusRefresh();
}

function unlockDeviceSockets(deviceToken) {
  const sockets = getSocketsByDeviceToken(deviceToken);
  for (const socket of sockets) {
    unlockSocket(socket);
  }
}

function disconnectDeviceSockets(deviceToken) {
  const sockets = getSocketsByDeviceToken(deviceToken);
  for (const socket of sockets) {
    socket.emit('agent:event', {
      seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
      type: 'device_status', payload: { status: 'denied', deviceId: deviceToken }
    });
    socket.disconnect(true);
  }
}

// 当前全量待审批设备列表（deviceToken→deviceId，幂等载体）。
function pendingDevicesPayload() {
  return { devices: getPendingDevices().map(d => ({ deviceId: d.deviceToken, ip: d.ip, userAgent: d.userAgent, ts: d.ts })) };
}
// 把待审批列表推给所有“已信任”Socket（deviceApproved===true），供其在 Web UI 远程审批。
// 新待批出现 / 批准 / 拒绝后调用，保持各可信端列表一致。
function broadcastPendingDevices() {
  const payload = pendingDevicesPayload();
  for (const socket of io.sockets.sockets.values()) {
    if (socket.deviceApproved === true) {
      socket.emit('agent:event', {
        seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
        type: 'pending_devices', payload
      });
    }
  }
}

// 确保数据文件存在，以便安全进行 watch 监听
const TRUSTED_DEVICES_FILE = join(DATA_DIR, 'trusted-devices.json');
const PENDING_DEVICES_FILE = join(DATA_DIR, 'pending-devices.json');
try {
  mkdirSync(DATA_DIR, { recursive: true });
  if (!existsSync(TRUSTED_DEVICES_FILE)) {
    writeOwnerOnlyFile(TRUSTED_DEVICES_FILE, JSON.stringify([], null, 2));
  }
  if (!existsSync(PENDING_DEVICES_FILE)) {
    writeOwnerOnlyFile(PENDING_DEVICES_FILE, JSON.stringify([], null, 2));
  }
} catch (err) {
  console.error('[devices] 初始化设备认证文件失败:', err.message);
}

// 文件变化监听器（用于在 CLI 执行批准操作时自动、即时解锁对应的客户端连接）
if (existsSync(TRUSTED_DEVICES_FILE)) {
  try {
    watch(TRUSTED_DEVICES_FILE, (eventType) => {
      if (eventType === 'change') {
        setTimeout(() => {
          for (const socket of io.sockets.sockets.values()) {
            if (socket.deviceApproved === false) {
              const token = socket.handshake.auth?.deviceToken;
              if (isDeviceTrusted(token)) {
                console.log(`[devices] 检测到 ${TRUSTED_DEVICES_FILE} 变更，自动解锁设备 ${token}`);
                unlockSocket(socket);
              }
            }
          }
          broadcastPendingDevices(); // CLI/TTY 审批后刷新各可信端的待批列表（移除已批准/拒绝项）
        }, 100);
      }
    });
  } catch (err) {
    console.error('[devices] 无法监视 trusted-devices.json 文件:', err.message);
  }
}

// 终端控制台交互：敲回车一键同意最新申请设备，或输入 deny 拒绝。
if (process.stdin.isTTY) {
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (data) => {
    const text = data.trim().toLowerCase();
    const latest = getLatestPendingDevice();
    if (text === '') {
      if (latest) {
        console.log(`\n[TTY] 收到回车！一键批准最新设备: ${latest}`);
        approveDevice(latest);
        unlockDeviceSockets(latest);
        broadcastPendingDevices();
      }
    } else if (text === 'deny') {
      if (latest) {
        console.log(`\n[TTY] 收到 deny！拒绝并移除最新设备: ${latest}`);
        denyDevice(latest);
        disconnectDeviceSockets(latest);
        broadcastPendingDevices();
      } else {
        console.log('\n[TTY] 当前没有等待审批的设备。');
      }
    }
  });
}

// ---- 鉴权（公网 Host 强制 Access JWT、fail-closed；LAN/本机回退 token；无 token 时仅 localhost）----
io.use(async (socket, next) => {
  try {
    let authPassed = false;
    let accessEnabled = false;

    if (isPublicHost(socket.handshake.headers.host)) {
      await verifyAccessJwt(socket.handshake.headers['cf-access-jwt-assertion']);
      authPassed = true;
      accessEnabled = true;
    } else if (!AUTH_TOKEN) {
      authPassed = true;
    } else if (tokenMatches(socket.handshake.auth?.token)) {
      authPassed = true;
    }

    if (!authPassed) {
      const got = socket.handshake.auth?.token;
      console.warn(`[conn] ${clientIp(socket.handshake.address)} 握手鉴权失败（token ${got ? '不匹配' : '缺失'}）`);
      return next(new Error('unauthorized'));
    }

    // 鉴权通过后，执行设备审批过滤（纵深防御）
    const isLocal = ['localhost', '127.0.0.1', '::1'].includes(clientIp(socket.handshake.address));
    if (accessEnabled || isLocal) {
      socket.deviceApproved = true;
    } else {
      const deviceToken = socket.handshake.auth?.deviceToken;
      if (isDeviceTrusted(deviceToken)) {
        socket.deviceApproved = true;
      } else {
        socket.deviceApproved = false;
        const ip = clientIp(socket.handshake.address);
        const ua = socket.handshake.headers['user-agent'] || 'Unknown';
        addPendingDevice(deviceToken, { ip, userAgent: ua });
        broadcastPendingDevices(); // 通知已登录的可信设备来远程一键审批（免终端）

        console.log('\n==================================================');
        console.log(`📢 [安全] 发现新设备请求公网/局域网接入！`);
        console.log(`   设备 ID: ${deviceToken || '（未提供）'}`);
        console.log(`   来自 IP: ${ip}`);
        console.log(`   User-Agent: ${ua}`);
        if (process.stdin.isTTY) {
          console.log(`   -> 请在电脑控制台直接按【回车键 (Enter)】一键同意此设备`);
          console.log(`   -> 或输入【deny】拒绝并拉黑该设备`);
        } else {
          console.log(`   -> 当前运行在非交互模式下。请在电脑运行下方命令授权此设备：`);
          console.log(`      node scripts/device.js approve "${deviceToken}"`);
        }
        console.log('==================================================\n');
      }
    }

    return next();
  } catch (e) {
    console.warn(`[conn] ${clientIp(socket.handshake.address)} 校验失败：${e.message}`);
    return next(new Error('unauthorized'));
  }
});

// ---- 实例并行内核（台阶3：每「会话/tab」一个常驻实例，显式 open、后台并行存活）----
let instanceCounter = 0;
const newInstanceId = () => `inst_${++instanceCounter}`; // 进程内唯一、永不变；前端分流锚点
const agents = new Map();                     // instanceId → AgentSession（台阶3 并发核心）
const permModeByInstance = new Map();         // instanceId → 权限档（per-instance）
const effortByInstance = new Map();           // instanceId → 思考强度档（per-instance）
// 新会话预设档（pending）：session:new / setWorkdir 到空 cwd 后 viewingInstanceId=null（懒创建无实例），
// 此空窗期切档无实例可作用——按 cwd 暂存，待首条消息 openInstance FRESH 懒开时消费（优先于 inherited）。
// effort 的 null（模型默认）是合法值，故消费时用 Map.has 判存在性而非真值。
const pendingModeByCwd = new Map();           // cwd → 待应用权限档（新会话懒创建期）
const pendingEffortByCwd = new Map();         // cwd → 待应用思考强度档（同上；null 合法）
const permModeOf = id => permModeByInstance.get(id) ?? 'default';
const effortOf = id => effortByInstance.get(id) ?? null;
// 决策 B：新实例初值继承该 cwd **最近**一个 live 实例的档（Map 保插入序，末个匹配=最近），无则默认。
function inheritedMode(cwd) { let m = 'default'; for (const a of agents.values()) if (a.cwd === cwd) m = a.permissionMode; return m; }
function inheritedEffort(cwd) { let e = null; for (const a of agents.values()) if (a.cwd === cwd) e = a.effort; return e; }
// 去重：同 sessionId 已有 live 实例则返回它（session:switch 聚焦不重开，防同会话被两实例并发 resume）。
function instanceForSession(sessionId) {
  if (!sessionId) return null;
  for (const a of agents.values()) if (a.sessionId === sessionId) return a;
  return null;
}
// 台阶3 Step B 角标：doneInstances = 后台（≠viewingInstanceId）完成但未查看的实例 latch
// （后台轮次 result 置位；该实例新活动 init/审批 或被切为 viewingInstanceId 时清）。instanceState 由实例
// 在途态 + latch 推导（无实例=idle）；broadcastInstances 在轮次/审批边界推送，前端据此渲染 tab 栏角标 + 通知。
const doneInstances = new Set();
const errorInstances = new Set(); // 后台（≠viewing）轮次 result.isError 置位的 latch（出错 ❗），清除点同 doneInstances
const STATE_BOUNDARY = new Set(['init', 'result', 'error', 'permission_request', 'question', 'request_resolved']);
function instanceState(id) {
  const a = agents.get(id);
  if (!a) return 'idle';
  if (a.pendingPermissions.size > 0 || a.pendingQuestions.size > 0) return 'permission'; // 需审批 ⚠️
  if (a.pendingTurns > 0) return 'busy';                                                  // 运行中 ⏳
  if (errorInstances.has(id)) return 'error';                                             // 后台出错 ❗
  if (doneInstances.has(id)) return 'done';                                               // 后台完成 ✅
  return 'idle';
}
function instancesPayload() {
  const list = [];
  for (const [id, a] of agents) list.push({
    instanceId: id, cwd: a.cwd, sessionId: a.sessionId,
    title: sessions.getSession(a.sessionId)?.title ?? null, state: instanceState(id),
    // 切 tab 面板同步：携带各实例当前档，前端 setInstances 据此静默刷新顶部 permMode/effort/model select
    permissionMode: permModeOf(id), effort: effortOf(id), model: a.activeModel || a.reportedModel || null
  });
  const payload = { viewingInstanceId, viewingCwd: viewingCwdOf(), dirs: workDirs, instances: list };
  // 空首页（viewingInstanceId 为空、无 live 实例）下发「下一条新会话(FRESH)将用的」权限/思考强度档
  // （= 该 cwd pending 预设 ?? CLI 启动默认：权限 default、effort null），供前端如实显示该工作区新会话将用的档
  // （终端等价），修「空首页残留上个会话档」。模型不下发——新会话模型=env 默认、服务端不可知，前端显「不指定」、
  // 首条消息后由 init.model 校正（A1：删原 defaultModel 推断字段）。有实例时省略，前端走实例自身档。
  if (!viewingInstanceId) {
    const cwd = viewingCwdOf();
    payload.defaultPermissionMode = pendingModeByCwd.get(cwd) ?? 'default';
    payload.defaultEffort = pendingEffortByCwd.has(cwd) ? pendingEffortByCwd.get(cwd) : null;
  }
  return payload;
}
function broadcastInstances() { // 多设备同步 tab 栏（当前查看 tab + 各实例角标状态，合成事件惯例）
  io.emit('agent:event', {
    seq: 0, epoch: 'server', sessionId: null, instanceId: viewingInstanceId, cwd: viewingCwd, ts: Date.now(),
    type: 'instances', payload: instancesPayload()
  });
}
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max']; // 5 档硬编码，漂移由 smoke-effort 的 CLI warning 检测
// 最近一次 init payload + 按 cwd 归键的 models 缓存：新连接重放，免发消息即得加载摘要、命令列表与模型候选。
// 持久化到 data/init-cache.json 跨重启读回（CLI 收到首条消息前不输出 init——init 是轮次开始信号，
// 预热 spawn 也等不来；缓存可能陈旧但每轮 init 覆盖刷新，文件可随时删除，损坏即当作没有）。
// modelsCache 按 cwd 归键：模型清单随工作区 settings.local.json 覆盖网关/模型名而变，非账号级全局量——
// 单全局缓存会跨工作区泄漏（切区点新会话冒出上个区 deepseek 名），同 lastInit 的 per-cwd 治理。详见 models-cache.js。
const INIT_CACHE = join(DATA_DIR, 'init-cache.json');
let lastInit = null;
const modelsCache = createModelsCache();
try {
  const c = JSON.parse(readFileSync(INIT_CACHE, 'utf8'));
  lastInit = c.init ?? null;
  modelsCache.load(c.modelsByCwd); // 旧格式 c.models（单全局）不迁移——缓存可弃、下轮 models 事件即重建本区清单
} catch { /* 无缓存/损坏：保持空 */ }
function saveInitCache() {
  try {
    mkdirSync(dirname(INIT_CACHE), { recursive: true });
    writeOwnerOnlyFile(INIT_CACHE, JSON.stringify({ init: lastInit, modelsByCwd: modelsCache.toJSON() }));
  }
  catch { /* 写失败不致命：缓存仅是重启后首轮前的体验增强 */ }
}

// 切 cwd 上下文（session:new/switch、setWorkdir/setViewing）后，按新 cwd 主动广播一条 models 事件：
// 有缓存推之；无缓存不推（而非推空——推空会清掉前端模型网格，session:new 懒开无实例永无真模型补发，
// 致用户切换工作区后模型选择消失且刷新也救不回）。
// 跨工作区候选泄漏的处理：active model pill 由前端 adoptPanelState 清为「默认」；模型候选网格短暂
// 残留上区列表，随后由实例 fetchModels() 推送的真模型覆盖（session:switch/setWorkdir 有实例、数秒内
// 纠正；session:new 等首条消息激发实例后纠正）。残留上区候选名的危害远轻于彻底无模型可选。
// io.emit：viewingCwd 是服务端全局单值、所有设备共享同一查看上下文（同 broadcastInstances），故全员刷新。
function pushModelsForCwd(cwd) {
  const p = modelsCache.get(cwd);
  if (!p) return; // 无缓存不推：不摧毁前端模型网格（真模型由后续实例 fetchModels 补发）
  io.emit('agent:event', {
    seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
    type: 'models', payload: p
  });
}

// ---- web 自有状态栏（E16）：SDK 自有数据 + 本机 git 结构化组装、不调脚本/快照、自包含开箱即用 ----
const statusOff = process.env.WEB_STATUSLINE === 'off'; // 禁用开关（默认启用，零 UI 痕迹）
let lastStatusLine = null;                             // 仅内存：结构化 payload，瞬时数据不持久化
let statusDebounce = null, statusInterval = null;
let isStatusRefreshing = false;                        // 防并发重叠锁

async function refreshStatusLine() {
  if (statusOff || io.engine.clientsCount === 0) return; // 禁用 / 无人连接零开销
  if (isStatusRefreshing) return;
  isStatusRefreshing = true;
  try {
    const currentInstanceId = viewingInstanceId;
    const currentCwd = viewingCwd;
    const va = agents.get(currentInstanceId); // 台阶3：当前查看 tab 的实例
    // cwd 取当前查看实例（per-instance）——va 为空（无 live 实例的工作区/新会话懒创建期）时不回退全局
    // lastInit（那是「最后一次任意实例 init」，会跨工作区泄漏上个会话的模型/目录）。
    const cwd = va?.cwd ?? currentCwd;
    const payload = await buildWebStatusLine({ agent: va, cwd, versions }); // SDK 自有数据 + git + CLI 版本，结构化、自包含
    
    // 校验在此期间有没有切换 tab 或 cwd (DeepSeek: 解决异步竞态旧 tab 数据污染新 tab)
    if (viewingInstanceId !== currentInstanceId || viewingCwd !== currentCwd) {
      return;
    }
    
    const key = JSON.stringify(payload, (k, v) => k === 'ts' ? undefined : v); // 排除每刷新都变的 ts 后去重
    if (lastStatusLine?.key === key) return;             // 同上次不重发
    lastStatusLine = { key, payload };
    io.emit('agent:event', {
      seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
      instanceId: currentInstanceId,                     // 供客户端 dispatcher 安全路由/分流
      type: 'status_line', payload: { ...payload, instanceId: currentInstanceId } // 供 status_line handler 安全校验
    });
  } finally {
    isStatusRefreshing = false;
  }
}
function scheduleStatusRefresh() {                     // 300ms 防抖（合并高频 onUsage/init/result 触发）
  if (statusOff) return;
  clearTimeout(statusDebounce);
  statusDebounce = setTimeout(() => refreshStatusLine().catch(err => console.error('[statusline]', err)), 300);
}
if (!statusOff) {
  // 周期刷新让 git 段（外部 commit/改动无事件驱动）跟上；去重 + clientsCount 守卫在 tick 内封顶开销
  // DeepSeek: 统一路由到 scheduleStatusRefresh 以消除并发重叠与合并请求
  statusInterval = setInterval(() => scheduleStatusRefresh(), 10_000);
}

// 当前会话指针经 cwd 归属校验：仅当其 jsonl 存在于该 cwd 的 project 目录才算「本 cwd 的当前」
// （切目录/跨 cwd 启动时指针可能指向别目录会话）。终端会话不在 sessions.json → 返回 {id} 仅凭 id resume
// （model 由 CLI 从 jsonl 恢复裸名；首轮 onSessionId 会把它 upsert 进 sessions.json「收编」）。
async function currentSessionForCwd(cwd) {
  const id = sessions.getCurrent(cwd);
  if (!id || !(await sessionFileExists(cwd, id))) return null;
  return sessions.getSession(id) || { id };
}

// 向会话 jsonl 文件开头写入 entrypoint 元数据，使 CLI /resume 能看到 Web UI 创建的会话。
// SDK 默认写 entrypoint:"sdk-cli"，CLI /resume 选择器可能过滤它；我们在文件头追加 entrypoint:"cli"，
// history.js 的 readHeadMeta 会优先读到我们写的值（扫描从第一行开始）。仅新会话首次调用，不重复写。
const wroteEntrypoint = new Set(); // 实例内去重：同一 session id 只写一次
function writeSessionEntrypoint(sessionId, cwd) {
  if (wroteEntrypoint.has(sessionId)) return;
  wroteEntrypoint.add(sessionId);
  try {
    const projectDir = getProjectDir(cwd);
    const claudeDir = join(homedir(), '.claude', 'projects', projectDir);
    const sessionFile = join(claudeDir, `${sessionId}.jsonl`);
    // SDK 可能还没创建文件，或已写入其他事件（queue-operation 等）；我们追加一行，readHeadMeta 扫描时会读到。
    // 格式：最小元数据行，仅 type/entrypoint/sessionId/timestamp，与 SDK 写的行同构（见 grep 结果）。
    const meta = {
      type: 'entrypoint-marker', // 自定义 type，CLI 忽略未知类型，不影响会话重放
      entrypoint: 'cli',         // 关键：让 CLI /resume 选择器认为这是终端创建的会话
      sessionId,
      timestamp: new Date().toISOString()
    };
    mkdirSync(join(sessionFile, '..'), { recursive: true });
    appendFileSync(sessionFile, JSON.stringify(meta) + '\n', { mode: 0o600 });
    invalidateListCache(cwd);
  } catch (err) {
    // 非致命：写失败不影响会话功能，仅 CLI /resume 选择器看不到（可用 --resume <id> 绕过）
    console.warn(`[writeSessionEntrypoint] 写入失败 ${sessionId}:`, err.message);
  }
}

// 台阶3：显式建一个新实例（分配 instanceId、后台并行存活）。`resumeId` 缺省=新会话；调用方
// （session:new/switch/启动预热）负责去重（instanceForSession）与切 viewingInstanceId。返回实例。
// 同步建（resumeId 由调用方解析，无需 await）——故无台阶2 的「await 让出窗口双实例」重入竞态。
function openInstance({ cwd, resumeId = null, mode, effort }) {
  const id = newInstanceId();
  const saved = resumeId ? (sessions.getSession(resumeId) || { id: resumeId }) : null;
  if (saved?.id) {
    interactionLog.addSessionLog(saved.id, 'sys_info', `[SYS] 启动/连接会话: instanceId=${id}, resumeId=${saved.id}, cwd=${cwd}`);
  }
  // 档位初值优先级：显式入参（mode/effort 已定义，如 setEffort 置换）> pending（空首页用户预设，用完即删）>
  //   FRESH:CLI 启动默认（权限 default / effort null 模型默认）｜ RESUME:saved 持久化值 > 继承该 cwd 末实例档。
  // A1（2026-06-22）：新会话(FRESH)用 CLI 启动默认、不再继承 cwd 末实例档——贴终端等价（新起 claude 是干净默认，
  // 不沿用另一会话的档）；原决策 B「fresh 也继承」已收窄为仅 resume 继承（per-instance 粒度不变）。effort 的 null
  // 合法 → 用 Map.has 判 pending 存在。
  // resume 时 saved 优先于 inherited：sessions.json 持久化了该会话最后生效的档（web 端增强，CLI 无此行为），
  // 冷启动无 live agents 时 inherited 回退 default/null，saved 能保持会话状态连续性。
  const isFresh = !resumeId;
  if (mode === undefined) {
    if (isFresh && pendingModeByCwd.has(cwd)) { mode = pendingModeByCwd.get(cwd); pendingModeByCwd.delete(cwd); }
    else if (isFresh) mode = 'default';        // 新会话：CLI 启动默认权限档
    else mode = saved?.permissionMode || inheritedMode(cwd); // resume：saved 优先，无则继承
  }
  let eff;
  if (effort !== undefined) eff = effort;
  else if (isFresh && pendingEffortByCwd.has(cwd)) { eff = pendingEffortByCwd.get(cwd); pendingEffortByCwd.delete(cwd); }
  else if (isFresh) eff = null;                // 新会话：模型默认 effort
  else eff = saved?.effort !== undefined ? saved.effort : inheritedEffort(cwd); // resume：saved 优先，无则继承
  permModeByInstance.set(id, mode);
  effortByInstance.set(id, eff);
  const instance = new AgentSession({
    instanceId: id,
    resumeId: saved?.id,
    cwd,
    claudeBin,
    // resume 时回传会话原模型名（CLI 自身恢复的是规范化裸名，部分网关不认）——来源仅会话指针
    model: saved?.model || undefined,
    permissionMode: mode,
    effort: eff,
    idleTimeoutMs,
    historicalCostUsd: saved?.cost || 0,
    onEvent: envelope => {
      if (envelope.type === 'init') { lastInit = envelope.payload; saveInitCache(); }
      else if (envelope.type === 'models') { modelsCache.set(cwd, envelope.payload); saveInitCache(); } // 按本实例 cwd 归键，防跨工作区泄漏
      // 批准内含的 mode 切换（ExitPlanMode 等经 agent.resolvePermission emit）：同步 per-instance 权威档，
      // 使重连 / instances 重放与手机端权限档图标一致（envelope 随后照常 io.emit → 前端 setPermMode）。
      else if (envelope.type === 'permission_mode') { permModeByInstance.set(id, envelope.payload?.mode); }
      // P2 性能优化：后台实例（id !== viewingInstanceId）的高频 text_delta/thinking_delta 不广播——
      // 仍入环形缓冲（agent.js buffer.push 先于此 onEvent），sync:since 切回时可完整回放；
      // 低频事件（tool_use/init/result/permission_request 等）维持广播（角标/状态/推送依赖）。
      const _isHighFreqDelta = envelope.type === 'text_delta' || envelope.type === 'thinking_delta';
      if (!_isHighFreqDelta || id === viewingInstanceId) {
        io.emit('agent:event', envelope);
      }
      // E16：仅当前查看 tab 的轮次边界刷新状态行（后台实例的 init/result 不抢占 viewingInstanceId 的 statusline）
      if ((envelope.type === 'init' || envelope.type === 'result') && id === viewingInstanceId) scheduleStatusRefresh();
      // 台阶3 Step B：轮次/审批边界 → 重算 per-instance 角标并广播。done latch：后台轮次 result 置位；
      // 该实例新活动 init/审批即清（新一轮活动取代「完成」标记）。
      if (STATE_BOUNDARY.has(envelope.type)) {
        // result latch 按 isError 分流（done/error 互斥）；裸 error 事件不 latch——部分是可恢复警告
        // （如模型切换失败仍续轮），稳妥信号是 result.isError。done/error 在新活动 init/审批时清。
        if (envelope.type === 'result') {
          if (instance.sessionId) {
            sessions.updateSessionCost(instance.sessionId, (instance.historicalCostUsd || 0) + (instance.totalCostUsd || 0));
          }
          if (id !== viewingInstanceId) {
            if (envelope.payload?.isError) { errorInstances.add(id); doneInstances.delete(id); }
            else { doneInstances.add(id); errorInstances.delete(id); }
          }
          // E15：result 仅在完全无客户端连接时推送（连着的客户端自己能看到）
          if (io.sockets.sockets.size === 0) {
            const p = envelope.payload;
            pushNotify(p?.isError ? '⚠️ 任务出错' : '✅ 任务完成',
              `用时 ${((p?.durationMs ?? 0) / 1000).toFixed(1)}s`);
          }
        } else if (envelope.type === 'init' || envelope.type === 'permission_request' || envelope.type === 'question') {
          doneInstances.delete(id); errorInstances.delete(id);
          // E15：permission_request / question 始终推（用户可能锁屏或在别的 app）
          if (envelope.type === 'permission_request') {
            const p = envelope.payload;
            pushNotify('⚠️ Claude 请求许可', `${p?.name ?? '工具'}：${JSON.stringify(p?.input ?? {}).slice(0, 80)}`);
          } else if (envelope.type === 'question') {
            const p = envelope.payload;
            pushNotify('❓ Claude 有问题', (p?.text ?? '').slice(0, 100) || 'Claude 需要你的回答');
          }
        }
        broadcastInstances();
      }
    },
    // E16：assistant 边界刷新 statusline（仅当前查看 tab；scheduleStatusRefresh 有 300ms 防抖兜频率）——ctx 不等 result/10s tick
    onUsage: () => { if (id === viewingInstanceId) scheduleStatusRefresh(); },
    onSessionId: (sid, firstMessage, model) => {
      // 新会话首次获得 id 时，写 entrypoint 元数据使 CLI /resume 可见（按本实例 cwd 落对应 project 目录）。
      // sessionId 已在 agent.js 先于 emit('init') 赋值 → 下方 init 边界的 broadcastInstances 自然带新 sid/title。
      if (!sessions.getSession(sid)) writeSessionEntrypoint(sid, cwd);
      // effort/permissionMode 一并持久化：init 事件到达时 agent 已完成漂移检测（permissionMode 为对账后真值），
      // effort 为构造时注入值（运行时不可改）。web 端续接恢复依赖这两字段。
      sessions.upsertSession({ id: sid, title: firstMessage, cwd, model, effort: instance.effort, permissionMode: instance.permissionMode });
      interactionLog.addSessionLog(sid, 'sys_info', `[SYS] 会话已获得 ID: sessionId=${sid}, 标题="${firstMessage || '未命名'}", model=${model || '默认'}`);
    },
    // 台阶3：实例意外退出/挂死自杀 → 从 Map 删该 instanceId（不影响其他实例）；resume 失败清该 cwd 指针
    // 打破"重试→resume 同一失效 id→循环"死锁；若退的是当前查看 tab，视图回落到任一存活实例。
    onExit: () => {
      if (instance.sessionId) {
        interactionLog.addSessionLog(instance.sessionId, 'sys_info', `[SYS] 实例已退出 (onExit): instanceId=${id}, resumeFailed=${instance.resumeFailed}`);
      }
      if (agents.get(id) === instance) {
        if (instance.resumeFailed) sessions.setCurrent(cwd, null);
        agents.delete(id);
        permModeByInstance.delete(id);
        effortByInstance.delete(id);
        doneInstances.delete(id);
        errorInstances.delete(id);
        if (viewingInstanceId === id) viewingInstanceId = agents.keys().next().value ?? null;
      }
      broadcastInstances(); // 实例退出 → 刷 tab 栏（角标回落 / 该 tab 消失）
    }
  });
  agents.set(id, instance);
  instance.start();
  return instance;
}

// scout 实例：为工作区获取真实模型清单的临时代理。
// session:new / setWorkdir 到无缓存工作区时，没有活实例调 supportedModels()→前端无模型可选。
// scout 以「不留任何痕迹」的方式临时启动 CLI：模型一到即缓存 → 推送前端 → dispose → 删除 CLI 残留文件。
// 与缓存关系：缓存加速后续（免重复 spawn），但第一次靠 scout 保证确定性——不用猜、不等实例、不靠上区残留。
function openScoutInstance(cwd) {
  const id = newInstanceId();
  const instance = new AgentSession({
    instanceId: id, resumeId: null, cwd, claudeBin,
    model: undefined, permissionMode: 'default', effort: null, idleTimeoutMs,
    historicalCostUsd: 0,
    onEvent: envelope => {
      if (envelope.type === 'models') {
        // 真模型到达：按 cwd 缓存 → 推送所有前端 → 清理
        modelsCache.set(cwd, envelope.payload);
        saveInitCache();
        pushModelsForCwd(cwd);
        cleanup();
      } else if (envelope.type === 'init') {
        // CLI 启动完成，init 已到 → 补调 fetchModels（首次在 start() 中可能因 CLI 未就绪静默失败）
        instance.fetchModels();
      }
      // 压制所有其他事件：scout 对前端完全不可见
    },
    onSessionId: (sid, firstMessage, model) => {
      // 仅记日志并暂存 sid——CLI 的 init 会在 ~/.claude/projects/<projectDir>/ 下创建 <sid>.jsonl，
      // dispose 后需删掉此残留文件以防幽灵会话出现在 listSessions 中。
      instance._scoutSid = sid;
      interactionLog.addSessionLog(sid, 'sys_info', `[SYS] scout 获取模型（不留会话入口）: instanceId=${id}, sessionId=${sid}, model=${model || '默认'}, cwd=${cwd}`);
    }
    // 不设 onExit：cleanup 显式调 dispose，consume 循环以 disposed=true 结束并跳过 onExit。
  });

  function cleanup() {
    clearTimeout(timer);
    const sid = instance._scoutSid;
    instance.dispose();
    // dispose 触发 abort → CLI 进程退出。CLI 启动时已在 ~/.claude/projects/<projectDir>/
    // 创建了 <sid>.jsonl 文件（含 init 系统消息等）；留之会在 listSessions 中出现「(无标题)」幽灵条目。
    // 异步延迟删除：给 CLI 进程一个信号处理的窗口，避免 unlink 与 CLI 写文件竞争。
    if (sid) {
      setTimeout(() => {
        try {
          const projectDir = getProjectDir(cwd);
          const file = join(homedir(), '.claude', 'projects', projectDir, `${sid}.jsonl`);
          unlinkSync(file);
          invalidateListCache(cwd);
        } catch { /* 文件可能已被 CLI 清理或不存在——非致命 */ }
      }, 300);
    }
  }

  // 20s 超时：CLI 卡死时释放资源 + 清理残留文件，避免僵尸实例/文件常驻
  const timer = setTimeout(() => {
    console.warn(`[scout] 模型获取超时 (${cwd})，释放实例`);
    cleanup();
  }, 20_000);

  instance.start();
  return instance;
}

// 显式关 tab：dispose 后同步删 Map（dispose 置 disposed=true，consume 的 onExit 不再触发——
// 与台阶2 disposeAgent 同款，不依赖 onExit）。viewingInstanceId 命中则回落到任一存活实例。
function disposeInstance(instanceId) {
  const a = agents.get(instanceId);
  if (!a) return;
  if (a.sessionId) {
    interactionLog.addSessionLog(a.sessionId, 'sys_info', `[SYS] 实例已手动销毁/关闭 (disposeInstance): instanceId=${instanceId}`);
  }
  a.dispose();
  agents.delete(instanceId);
  permModeByInstance.delete(instanceId);
  effortByInstance.delete(instanceId);
  doneInstances.delete(instanceId);
  errorInstances.delete(instanceId);
  if (viewingInstanceId === instanceId) viewingInstanceId = agents.keys().next().value ?? null;
  broadcastInstances();
}

// ---- 契约路由（客户端→服务端）----
// #6：统一包裹每个 handler，任一抛错只回该 socket 一条 error，绝不冒泡成 uncaughtException 崩进程。
function on(socket, event, handler) {
  socket.on(event, async (...args) => {
    try {
      // 纵深防御：如果设备尚未通过终端审批，丢弃所有上行的业务事件（fail-closed）
      if (socket.deviceApproved === false) {
        console.warn(`[devices] 丢弃未授权设备 ${socket.handshake.auth?.deviceToken || 'Unknown'} 的业务事件: ${event}`);
        return;
      }
      await handler(...args);
    } catch (err) {
      console.error(`[handler:${event}]`, err);
      socket.emit('agent:event', {
        seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
        type: 'error', payload: { message: `服务端处理 ${event} 出错：${err.message}`, recoverable: true }
      });
    }
  });
}

// 注册 Web 端实时流式日志广播回调
interactionLog.setCallback((sessionId, entry) => {
  for (const [instanceId, a] of agents) {
    if (a.sessionId === sessionId) {
      io.emit('agent:event', {
        seq: 0,
        epoch: 'server',
        sessionId,
        instanceId,
        cwd: a.cwd,
        ts: entry.ts,
        type: 'session_log',
        payload: {
          type: entry.type,
          text: entry.text,
          ts: entry.ts
        }
      });
      break;
    }
  }
});

io.on('connection', socket => {
  console.log(`[conn] ${socket.id} 已连接（来自 ${clientIp(socket.handshake.address)}）`);

  if (socket.deviceApproved === false) {
    // 未经授权的设备：跳过任何敏感信息重放，只推送 pending 状态
    socket.emit('agent:event', {
      seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
      type: 'device_status', payload: { status: 'pending', deviceId: socket.handshake.auth?.deviceToken }
    });
  } else {
    // 已授权的设备：重放最近 init/models（合成事件惯例：epoch:'server'、sessionId:null，不触发客户端会话切换）
    if (lastInit) {
      // 台阶3：lastInit 是全局最近一次（可能来自后台实例），重放时校正到当前查看 tab——
      // permissionMode 同理（否则前端先按陈旧档定基线、再被下方 permission_mode 重放纠正，冒出假「权限档→X」）；
      // model/cwd 一并校正，避免新设备连入时短暂显示后台实例的模型/目录（下一轮真 init 到达即自愈）。
      const va = agents.get(viewingInstanceId);
      // #5：重放不带 slashCommands（跨 repo/tab 串防护，同 unlockSocket）；前端保留缓存、真 init 到达即校正
      const { slashCommands: _omitCmds, ...initBase } = lastInit;
      socket.emit('agent:event', {
        seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
        type: 'init', payload: {
          ...initBase,
          permissionMode: permModeOf(viewingInstanceId),
          // model/cwd 校正到当前查看 tab：va 存在用实例值（FRESH 实例 activeModel 为空则 null，不回退 lastInit）；
          // va 为空（空首页）model 不下发=null（新会话模型=env 默认、服务端不可知，前端显「不指定」，A1）、cwd 用 viewingCwd
          ...(va ? { model: va.activeModel ?? null, cwd: va.cwd }
                : { model: null, cwd: viewingCwd })
        }
      });
    }
    // models 校正到当前查看 tab 的 cwd（同 unlockSocket）：未知工作区不重放，绝不回退别区清单
    const replayModels = modelsCache.get(agents.get(viewingInstanceId)?.cwd ?? viewingCwd);
    if (replayModels) {
      socket.emit('agent:event', {
        seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
        type: 'models', payload: replayModels
      });
    }
    if (lastStatusLine) {
      socket.emit('agent:event', {
        seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
        type: 'status_line', payload: lastStatusLine.payload // 即时上屏（陈旧但快）
      });
    }
    // 台阶3：重放当前查看 tab 的权限档（总是发，含 default）
    permModeTo(socket);
    // 重放当前查看 tab 的思考强度档（总是发，含 null=模型默认）
    effortTo(socket);
    // 台阶3：重放 tab 栏快照（viewingInstanceId + dirs + 各实例状态）
    instancesTo(socket);
    // 可信端连入时重放当前待审批设备列表，使其可立即在 Web UI 远程审批
    socket.emit('agent:event', {
      seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
      type: 'pending_devices', payload: pendingDevicesPayload()
    });
    scheduleStatusRefresh(); // 300ms 后新鲜数据跟上
  }

  on(socket, 'user:message', async payload => {
    const text = typeof payload === 'string' ? payload : payload?.text;
    const attachments = (payload && typeof payload === 'object') ? payload.attachments : undefined;
    const hasText = typeof text === 'string' && text.trim().length > 0;
    const hasAttachments = Array.isArray(attachments) && attachments.length > 0;
    if (!hasText && !hasAttachments) {
      return sysTo(socket, '消息为空或格式无效', true); // #12：不静默丢弃；用 system 不终结在途轮
    }
    if (typeof text === 'string' && text.length > 50000) {
      // system 而非 error：发送前校验，不应 finalize 正在流式的在途任务（前端已先行红字提示）
      return sysTo(socket, `消息过长（${text.length} 字符，上限 50000），未发送`, true);
    }
    // E17：附件校验（条数/单文件/总量）。失败用 system 提示、不发送、不终结在途轮。
    const attErr = validateAttachments(attachments);
    if (attErr) return sysTo(socket, attErr, true);

    const cleanText = hasText ? text.trim() : '';
    const model = (payload && typeof payload === 'object') ? payload.model : undefined;
    // 台阶3：路由到目标实例（instanceId 优先）；无可路由实例（首发/session:new 后/无 open tab）则懒开一个
    // （resume 该 cwd 当前会话，无则新建；该会话已 live 则聚焦去重），设为查看 tab。
    let a = routeInstance(payload && typeof payload === 'object' ? payload.instanceId : undefined);
    if (!a) {
      const cwd = routeCwd(payload && typeof payload === 'object' ? payload.cwd : undefined);
      const saved = await currentSessionForCwd(cwd);
      // 并发懒开去重（S2）：currentSessionForCwd 的 await 间隙内，另一条并发首消息可能已为本 cwd 懒开了实例。
      // RESUME 靠 instanceForSession（sessionId）去重；FRESH 无 sessionId，改认「await 后 viewing 已是本 cwd 实例」
      // ——两条无 instanceId 的并发首消息都意在打开该 cwd 当前(空)会话，应收敛到同一实例，不重复 spawn 孤儿实例。
      const justOpened = agents.get(viewingInstanceId);
      a = (saved && instanceForSession(saved.id))
        || (justOpened && justOpened.cwd === cwd ? justOpened : null)
        || openInstance({ cwd, resumeId: saved?.id });
      viewingInstanceId = a.instanceId;
      broadcastInstances();
    }
    interactionLog.userMessageIn(a.sessionId, cleanText, model || a.activeModel || a.defaultModel); // 交互日志：client → server；model=本轮目标模型
    if (hasAttachments) {
      // 落盘 <cwd>/.ccm-uploads/ → 绝对路径注入 prompt → 送 SDK（claude 用 Read 读，白名单内免审批）；
      // 气泡走 displayText（原文，不含路径）+ 去完整 data 的元数据（含小 thumb，进缓冲供回放）
      const saved = await saveAttachments(a.cwd, attachments);
      await a.send(buildPromptText(cleanText, saved), model, {
        displayText: cleanText, attachments: toEventMeta(saved)
      });
    } else {
      await a.send(cleanText, model);               // F1：send 改 async（setModel 需 await）
    }
  });

  on(socket, 'user:approve', payload => {
    const { requestId, decision, alwaysThisSession, instanceId } = payload || {};
    if (typeof requestId !== 'string' || !['allow', 'deny'].includes(decision)) return;
    const a = routeInstance(instanceId);
    if (a) {
      interactionLog.addSessionLog(a.sessionId, 'sys_info', `[SYS] 许可决策 (user:approve): requestId=${requestId}, decision=${decision}, alwaysThisSession=${alwaysThisSession}`);
      a.resolvePermission(requestId, decision, Boolean(alwaysThisSession));
    }
  });

  // 已信任设备远程审批待批设备（免终端）。这两个 handler 经 on() 统一闸保护——deviceApproved=false
  // 的待审批设备发来的审批会在 on() 入口被丢弃（无法自批），故审批权恒属已信任设备。复用既有 approve/deny 函数。
  on(socket, 'user:approveDevice', payload => {
    const deviceId = payload?.deviceId;
    if (typeof deviceId !== 'string' || !deviceId) return;
    // 纵深防御：只批准“确在待审批列表里”的设备 token，不凭一个事件把任意 token 加进信任表
    // （防可信端误传/点到陈旧卡片，使从未请求接入的 token 被预置信任）。授予信任收敛到真实请求。
    if (!getPendingDevices().some(d => d.deviceToken === deviceId)) {
      console.warn(`[devices] 忽略远程批准：${deviceId} 不在待审批列表`);
      return;
    }
    console.log(`[devices] 已信任设备 ${socket.id} 远程批准 ${deviceId}`);
    approveDevice(deviceId);
    unlockDeviceSockets(deviceId);
    broadcastPendingDevices();
  });
  on(socket, 'user:denyDevice', payload => {
    const deviceId = payload?.deviceId;
    if (typeof deviceId !== 'string' || !deviceId) return;
    console.log(`[devices] 已信任设备 ${socket.id} 远程拒绝 ${deviceId}`);
    denyDevice(deviceId);
    disconnectDeviceSockets(deviceId);
    broadcastPendingDevices();
  });

  // 台阶3：切权限档（作用于指定实例，缺省 viewingInstanceId）。即时切（成功才落库 + 广播，失败
  // 时 agent 已 emit error）。无实例则 echo 当前档拨回该 socket，不存储。bypassPermissions 已由前端二次确认。
  on(socket, 'user:setPermissionMode', async payload => {
    const mode = payload?.mode;
    if (!['default', 'plan', 'acceptEdits', 'bypassPermissions', 'dontAsk'].includes(mode)) {
      return sysTo(socket, `未知权限档：${mode}`, true);
    }
    const id = resolveInstanceId(payload?.instanceId); // 台阶3：作用实例（缺省 viewingInstanceId）
    const a = agents.get(id);
    if (!a) {
      // 新会话懒创建期（viewingInstanceId=null，无实例可作用）：暂存 pending（按 viewingCwd），首条消息
      // openInstance 消费；echo 新档让 select 立即上屏（不再 echo 旧档拨回——那才是「点了没反应」）。
      if (viewingInstanceId === null) {
        pendingModeByCwd.set(viewingCwd, mode);
        socket.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, instanceId: null, ts: Date.now(),
          type: 'permission_mode', payload: { mode }
        });
        return;
      }
      return permModeTo(socket);                       // 其他无实例情形：echo 拨回，不存储
    }
    const ok = await a.setPermissionMode(mode);
    if (!ok) return;
    interactionLog.addSessionLog(a.sessionId, 'sys_info', `[SYS] 切换权限档 (user:setPermissionMode): mode=${mode}, instanceId=${id}`);
    permModeByInstance.set(id, mode);                  // 台阶3：档位 per-instance
    if (a.sessionId) sessions.updateSessionPrefs(a.sessionId, { permissionMode: mode }); // 持久化，resume 恢复用
    io.emit('agent:event', {
      seq: 0, epoch: 'server', sessionId: null, instanceId: id, ts: Date.now(),
      type: 'permission_mode', payload: { mode }
    });
  });

  // 台阶3：切思考强度档（作用于指定实例）。SDK 无 effort 运行时控制 → 置换该实例（dispose +
  // open resume 同会话带新 --effort，迁移 viewingInstanceId），一次冷启动。busy（在途轮>0，含审批挂起）
  // 拒切不杀任务；拒切/非法/无实例 单发当前档拨回该 socket。
  on(socket, 'user:setEffort', payload => {
    const level = payload?.level ?? null;
    const id = resolveInstanceId(payload?.instanceId); // 台阶3：作用实例（缺省 viewingInstanceId）
    const a = agents.get(id);
    if (level !== null && !EFFORT_LEVELS.includes(level)) {
      sysTo(socket, `未知思考强度档：${level}`, true);
      return effortTo(socket);
    }
    if (!a) {
      // 新会话懒创建期：暂存 pending effort（按 viewingCwd）+ echo 新档。null（模型默认）合法。
      if (viewingInstanceId === null) {
        pendingEffortByCwd.set(viewingCwd, level);
        socket.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, instanceId: null, ts: Date.now(),
          type: 'effort_mode', payload: { level }
        });
        return;
      }
      return effortTo(socket);           // 其他无实例情形：echo 拨回
    }
    if (level === effortOf(id)) return;  // 幂等：同档不置换实例、不广播
    if (a.pendingTurns > 0) {
      sysTo(socket, '当前有任务在运行，请等结束后再切思考强度', true);
      return effortTo(socket);
    }
    const cwd = a.cwd, sid = a.sessionId, mode = a.permissionMode, wasViewing = viewingInstanceId === id;
    interactionLog.addSessionLog(sid, 'sys_info', `[SYS] 切换思考强度 (user:setEffort): level=${level || '模型默认'}, 正在置换实例...`);
    if (sid) sessions.updateSessionPrefs(sid, { effort: level }); // 持久化，resume 恢复用（先于 dispose，防崩溃丢档）
    disposeInstance(id);                                              // 关旧实例
    const ni = openInstance({ cwd, resumeId: sid, mode, effort: level }); // 开新实例 resume 同会话、带新 effort
    if (wasViewing) viewingInstanceId = ni.instanceId;
    io.emit('agent:event', {
      seq: 0, epoch: 'server', sessionId: null, instanceId: ni.instanceId, ts: Date.now(),
      type: 'effort_mode', payload: { level }
    });
    broadcastInstances();
  });

  // 台阶3：切 cwd 分组上下文（新建会话选目录维度）。校验白名单防穿越。聚焦该 cwd 已有 live 实例（最近一个），
  // 否则 open 其最后查看会话为一个 tab；全新空状态则 viewingInstanceId=null（前端清视图等首条消息懒开）。
  on(socket, 'user:setWorkdir', async payload => {
    const cwd = payload?.cwd;
    if (typeof cwd !== 'string' || !workDirs.includes(cwd)) {
      sysTo(socket, `未知工作目录：${cwd}`, true);
      return instancesTo(socket);
    }
    viewingCwd = cwd;
    let target = null;
    for (const [iid, a] of agents) if (a.cwd === cwd) target = iid; // 末个匹配=最近 live 实例
    if (!target) {
      const saved = await currentSessionForCwd(cwd);
      if (saved) {
        const opened = instanceForSession(saved.id) || openInstance({ cwd, resumeId: saved.id });
        target = opened.instanceId;
        interactionLog.addSessionLog(saved.id, 'sys_info', `[SYS] 工作目录切换 (user:setWorkdir): 恢复最近会话 resumeId=${saved.id}, cwd=${cwd}`);
      }
    }
    viewingInstanceId = target;          // 可能 null（该 cwd 全新）：前端清视图等首条消息懒开
    if (target) { doneInstances.delete(target); errorInstances.delete(target); }
    broadcastInstances();
    pushModelsForCwd(cwd); // 有缓存即时推（快速路径），无实例时由下方 scout 补发真实模型
    if (!viewingInstanceId) openScoutInstance(cwd); // 该 cwd 全新：scout 获取模型（不留幽灵会话）
    lastStatusLine = null;
    scheduleStatusRefresh();             // statusline git 段跟随新 cwd 刷新
  });

  // 台阶3 新增：切视图到指定 tab。校验 instanceId ∈ live → 改 viewingInstanceId + 清该实例 done + 广播。
  on(socket, 'user:setViewing', payload => {
    const id = payload?.instanceId;
    if (!agents.has(id)) return instancesTo(socket);         // 非法/已关：拨回当前快照
    if (id === viewingInstanceId) return instancesTo(socket); // 幂等
    viewingInstanceId = id;
    const a = agents.get(id);
    viewingCwd = a.cwd;
    interactionLog.addSessionLog(a.sessionId, 'sys_info', `[SYS] 切换当前活动视图 (user:setViewing): instanceId=${id}, sessionId=${a.sessionId}`);
    doneInstances.delete(id); errorInstances.delete(id);
    broadcastInstances();
    pushModelsForCwd(a.cwd); // 切视图到别区 tab：推该区清单刷新模型选择器（避免显另一 tab 工作区的候选）
    lastStatusLine = null;
    scheduleStatusRefresh();
  });

  on(socket, 'user:answer', payload => {
    const { requestId, optionIndex, instanceId } = payload || {};
    if (typeof requestId !== 'string' || typeof optionIndex !== 'number') return;
    routeInstance(instanceId)?.resolveQuestion(requestId, optionIndex); // 台阶3：按 instanceId 路由
  });

  on(socket, 'user:interrupt', payload => routeInstance(payload?.instanceId)?.interrupt()); // 台阶3：按 instanceId 路由

  on(socket, 'session:new', (payload, maybeAck) => {
    // 兼容两种调用形态：emit('session:new', cb) 与 emit('session:new', {cwd}, cb)
    const ack = typeof payload === 'function' ? payload : maybeAck;
    const cwd = (payload && typeof payload === 'object') ? routeCwd(payload.cwd) : viewingCwdOf();
    viewingCwd = cwd;
    sessions.setCurrent(cwd, null); // 台阶3：清该 cwd 当前指针 → 下条消息懒开为 FRESH 会话（非 resume）
    viewingInstanceId = null;       // 清查看 tab（**不再 dispose 任何实例**——背景 tab 继续跑），首条消息懒开
    pendingModeByCwd.delete(cwd); pendingEffortByCwd.delete(cwd); // 重置新会话预设档（防上次未发的残留被误消费）
    broadcastInstances();
    pushModelsForCwd(cwd); // 有缓存即时推（快速路径），无缓存由下方 scout 补发
    if (!viewingInstanceId) openScoutInstance(cwd); // 无实例：scout 获取真实模型（不留幽灵会话）
    lastStatusLine = null;
    scheduleStatusRefresh();
    if (typeof ack === 'function') ack({ ok: true, instanceId: null, sessionId: null });
  });

  on(socket, 'session:switch', async (payload, ack) => {
    const sessionId = payload?.sessionId;
    const cwd = routeCwd(payload?.cwd); // 台阶3：在指定 cwd 内打开/聚焦会话（缺省当前查看实例 cwd）
    // 归属校验以「jsonl 存在于本 cwd 的 project 目录」为准：既拒跨 cwd / 失效 id，又接纳终端建的会话。
    if (typeof sessionId !== 'string' || !(await sessionFileExists(cwd, sessionId))) {
      if (typeof ack === 'function') ack({ ok: false, error: '会话不存在' });
      return;
    }
    // 台阶3：打开或聚焦——已 live 实例承载该会话则聚焦不重开（去重，防同会话被两实例并发 resume）；
    // 否则 open 新实例 resume。**不再 dispose 同 cwd**（其他 tab 后台继续）。
    const inst = instanceForSession(sessionId) || openInstance({ cwd, resumeId: sessionId });
    viewingInstanceId = inst.instanceId;
    viewingCwd = cwd;
    sessions.setCurrent(cwd, sessionId); // 记为该 cwd 最后查看会话（重启预热用）
    doneInstances.delete(inst.instanceId); errorInstances.delete(inst.instanceId);
    broadcastInstances();
    pushModelsForCwd(cwd); // 切区即时推本区清单（无缓存→空）；随后 resume 实例的真 models 兜底
    lastStatusLine = null;
    scheduleStatusRefresh();
    if (typeof ack === 'function') ack({ ok: true, instanceId: inst.instanceId, sessionId });
  });

  // 台阶3 新增：关闭 tab。dispose 该实例（杀进程、deny 挂起审批、释放配额）；会话留盘可经 session:switch 再开。
  on(socket, 'session:close', (payload, ack) => {
    const id = payload?.instanceId;
    if (!agents.has(id)) { if (typeof ack === 'function') ack({ ok: false, error: '实例不存在' }); return; }
    disposeInstance(id); // 内含 viewingInstanceId 回落 + broadcastInstances
    lastStatusLine = null;
    scheduleStatusRefresh();
    if (typeof ack === 'function') ack({ ok: true, viewingInstanceId });
  });

  on(socket, 'session:list', async (payload, maybeAck) => {
    // 兼容两种调用形态：emit('session:list', cb)（app.js 现状）与 emit('session:list', {cwd}, cb)
    const ack = typeof payload === 'function' ? payload : maybeAck;
    if (typeof ack !== 'function') return;
    const cwd = routeCwd((payload && typeof payload === 'object') ? payload.cwd : undefined); // 缺省查看实例 cwd
    // 数据源 = 扫 ~/.claude/projects/<编码cwd>/（与 CLI /resume 同源，含终端会话），天然按 cwd 隔离。
    // currentSessionId 取该 cwd 指针，但仅当其 jsonl 属本 cwd 才回传（否则 null）。
    const id = sessions.getCurrent(cwd);
    const currentSessionId = (id && await sessionFileExists(cwd, id)) ? id : null;
    ack({ currentSessionId, sessions: await listSessions(cwd) });
  });

  // E14 历史回显（鉴权随握手；取代原无鉴权的 GET /sessions/:id/history）
  on(socket, 'session:history', async (payload, ack) => {
    const sessionId = payload?.sessionId;
    if (typeof ack !== 'function') return;
    // 归属校验与 session:switch 同款：jsonl 在本 cwd 的 project 目录即有效——接纳终端创建的
    // 会话（不在 sessions.json，原 getSession 守卫会把它们误判为「会话不存在」→ 切入后黑屏）。
    // 列表/切换/历史三环节统一按文件存在性裁决（双向互见互续）。
    const cwd = routeCwd(payload?.cwd); // 台阶2：读指定目录的历史（缺省 viewingCwd）
    if (typeof sessionId !== 'string' || !(await sessionFileExists(cwd, sessionId))) {
      return ack({ messages: [], error: '会话不存在' });
    }
    try {
      ack({ messages: await getSessionHistory(sessionId, cwd) }); // M6：async 避免阻塞事件循环
    } catch (err) {
      ack({ messages: [], error: err.message });
    }
  });

  on(socket, 'sync:since', (payload, ack) => {
    const { sessionId, lastSeq, instanceId } = payload || {};
    // ack {replayed, gap, found}：replayed=0 表示该实例无可回放的缓冲（如刚 open 尚未跑/重启后空），
    // 客户端据此回落到 session:history 回显，避免整页刷新后空屏。found=false 专指「实例已没了」
    // （dispose/重启/effort 切档换 instanceId）——与「实例还在、只是没新事件」的 replayed=0 区分开，
    // 让重连客户端能据此清屏重载历史（connect 路径不像 bindView 那样先 clearView，无法靠 replayed 自辨）。
    const done = (replayed, gap, found = true) => {
      if (typeof ack === 'function') ack({ replayed, gap: Boolean(gap), found: Boolean(found) });
    };
    const a = routeInstance(instanceId); // 台阶3：续传指定 tab 实例的缓冲（缺省 viewingInstanceId）
    if (!a || a.sessionId !== sessionId) return done(0, false, false); // 无匹配实例：客户端清屏重载历史；亦会在下个 live 事件凭 epoch 自愈
    const { events, gap } = a.eventsSince(Number(lastSeq) || 0);
    if (gap) { // #13：有缺口时明确告知，客户端可整段重渲染，不把残缺当完整
      socket.emit('agent:event', {
        seq: 0, epoch: 'server', sessionId, instanceId: a.instanceId, cwd: a.cwd, ts: Date.now(),
        type: 'system', payload: { message: '部分历史已超出缓冲窗口，可能有缺失' }
      });
    }
    for (const envelope of events) socket.emit('agent:event', envelope);
    // replayed 仅计“对话内容”事件：models 是 start() 里 fetchModels 推送的元数据（连接时按 cwd 已重放），
    // 若计入会把“刚 resume/预热、缓冲里只有一条 models”的实例误判为“已有内容”→ 前端 bindView
    // 跳过 loadHistory → 切入后聊天区空白（jsonl 历史从不加载）。排除后这类实例 replayed=0，前端正确回落
    // session:history。events 仍全量回放（前端要 models 填模型/effort 下拉），仅计数口径变。
    const replayed = events.filter(e => e.type !== 'models').length;
    done(replayed, gap);
  });

  on(socket, 'logs:get', (payload, ack) => {
    if (typeof ack !== 'function') return;
    const id = payload?.instanceId || viewingInstanceId;
    const a = agents.get(id);
    if (!a) {
      return ack({ logs: [] });
    }
    const logs = interactionLog.getSessionLogs(a.sessionId);
    ack({ logs });
  });

  // 主动拉取【当前查看工作区】的可用模型清单：回按 cwd 归键的缓存。模型清单随工作区 settings.local.json
  // 覆盖网关/模型名而变（非账号级全局量）——故按 viewingCwd 取，未知工作区诚实返回空、绝不回退别区清单
  // （防跨工作区泄漏 deepseek 等名）。不实时调 supportedModels()——它需活实例，新建会话时实例懒开尚未起；
  // session:switch 预热的实例其 models 事件已填本区缓存，故切区后通常已是本区清单。
  on(socket, 'models:get', (payload, ack) => {
    if (typeof ack !== 'function') return;
    ack({ models: modelsCache.get(viewingCwd)?.models ?? [] });
  });

  on(socket, 'disconnect', () => {
    console.log(`[conn] ${socket.id} 已断开`); // 4c：不动 agent——任务独立于连接存活
  });
});

// 台阶3：单发指定实例当前权限档给该 socket（重放/无实例/拒切拨回；缺省 viewingInstanceId）
function permModeTo(socket, id = viewingInstanceId) {
  socket.emit('agent:event', {
    seq: 0, epoch: 'server', sessionId: null, instanceId: id, ts: Date.now(),
    type: 'permission_mode', payload: { mode: permModeOf(id) }
  });
}

// 台阶3：单发指定实例当前思考强度档给该 socket（重放缺省 viewingInstanceId；拒切拨回）
function effortTo(socket, id = viewingInstanceId) {
  socket.emit('agent:event', {
    seq: 0, epoch: 'server', sessionId: null, instanceId: id, ts: Date.now(),
    type: 'effort_mode', payload: { level: effortOf(id) }
  });
}

// 台阶3：单发 tab 栏快照给指定 socket（重放 + 非法/幂等拨回用；广播走 broadcastInstances）
function instancesTo(socket) {
  socket.emit('agent:event', {
    seq: 0, epoch: 'server', sessionId: null, instanceId: viewingInstanceId, cwd: viewingCwd, ts: Date.now(),
    type: 'instances', payload: instancesPayload()
  });
}

function sysTo(socket, message, recoverable) {
  socket.emit('agent:event', {
    seq: 0, epoch: 'server', sessionId: null, instanceId: null, cwd: viewingCwd, ts: Date.now(),
    type: recoverable ? 'system' : 'error',
    payload: recoverable ? { message } : { message, recoverable: false }
  });
}

// ---- 进程级兜底（#6 backstop）：handler 已各自 try/catch，这里只做最后防线，记录不退出 ----
process.on('uncaughtException', err => console.error('[uncaughtException]', err));
process.on('unhandledRejection', err => console.error('[unhandledRejection]', err));

// ---- 监听 ----
const host = AUTH_TOKEN ? '0.0.0.0' : '127.0.0.1';
// 启动期致命错误必须 fail-fast 并给可读提示（A9 精神），不能落进 uncaughtException 兜底静默退出
httpServer.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n❌ 启动失败：端口 ${port} 已被占用。`);
    console.error(`   查看占用者：lsof -nP -iTCP:${port} -sTCP:LISTEN`);
    console.error(`   或在 .env 中改用其他 PORT\n`);
  } else {
    console.error(`\n❌ 启动失败：${err.message}\n`);
  }
  process.exit(1);
});
// 局域网 IPv4（手机同 WiFi 直连用）。排除：VPN/代理虚拟网卡（utun* 等，手机不可达）、
// link-local（169.254.*）、RFC 2544 基准段（198.18/15，TUN 代理常用假网段）。
function lanIPv4s() {
  return Object.entries(networkInterfaces())
    .filter(([name]) => !/^(utun|tun|tap|ppp)/.test(name))
    .flatMap(([, addrs]) => addrs)
    .filter(i => i?.family === 'IPv4' && !i.internal
      && !i.address.startsWith('169.254.')
      && !/^198\.1[89]\./.test(i.address))
    .map(i => i.address);
}

httpServer.listen(port, host, () => {
  console.log('========================================');
  console.log('  Claude Chat Mobile v2');
  console.log(`  工作目录: ${WORK_DIR}${workDirs.length > 1 ? `  (可切换 ${workDirs.length} 个: ${workDirs.join(', ')})` : ''}`);
  console.log(`  claude: ${claudeBin} (${versions.cli})`);
  console.log(`  工具放行: 由 .claude/settings.json 的 permissions 决定（投屏层不注入白名单）`);
  if (!AUTH_TOKEN) {
    console.log(`  本机: http://localhost:${port}`);
    console.warn('  ⚠️  未设置 AUTH_TOKEN —— 仅监听 127.0.0.1，不可走隧道对外。');
    console.warn('  ⚠️  需要手机访问请在 .env 设置 AUTH_TOKEN 后重启。');
  } else {
    // 安全打印：首次启动（无 sessions.json）打印完整 URL 便于扫码，后续用掩码（防录屏/日志泄露）
    const isFirstRun = !existsSync(join(DATA_DIR, 'sessions.json'));
    const maskedToken = maskToken(AUTH_TOKEN);
    const frag = `/#token=${encodeURIComponent(AUTH_TOKEN)}`;

    console.log('  已启用鉴权，按场景任选一条打开（token 首次进入后存入浏览器，之后免带）：');
    console.log(`  [Token: ${maskedToken}]`);
    if (isAccessEnabled()) console.log(`  🔒 Cloudflare Access 已启用：公网 ${process.env.CF_ACCESS_HOSTNAME} 强制 2FA（JWT 校验），AUTH_TOKEN 仅管 LAN/本机`);

    if (isFirstRun) {
      // 首次启动：完整 URL（便于扫码/点击）
      console.log(`  本机:   http://localhost:${port}${frag}`);
      for (const ip of lanIPv4s()) {
        console.log(`  局域网: http://${ip}:${port}${frag}  ← 手机同 WiFi 直接用`);
      }
      console.log(`  公网:   先跑 cloudflared tunnel --url http://localhost:${port}`);
      console.log(`          再开 https://<随机域名>.trycloudflare.com${frag}  ← 装 PWA 走这条（需 https）`);
    } else {
      // 后续启动：占位符（防泄露），token 已存浏览器可免带
      console.log(`  本机:   http://localhost:${port}/#token=<YOUR_TOKEN>`);
      for (const ip of lanIPv4s()) {
        console.log(`  局域网: http://${ip}:${port}/#token=<YOUR_TOKEN>  ← 手机同 WiFi 直接用`);
      }
      console.log(`  公网:   先跑 cloudflared tunnel --url http://localhost:${port}`);
      console.log(`          再开 https://<随机域名>.trycloudflare.com/#token=<YOUR_TOKEN>  ← 装 PWA 走这条（需 https）`);
      console.log(`  💡 提示: Token 已掩码显示，完整 token 在 .env 中查看（或删除 data/sessions.json 重启显示完整 URL）`);
    }
  }
  console.log('========================================');
  // 启动预热：有会话指针时提前 spawn CLI（resume），省掉首条消息的冷启动延迟（终端等价：
  // claude 启动后挂着等输入）。实测 CLI 首条消息前不输出 init，重放缓存空窗由 init-cache.json
  // 持久化解决，与预热无关。全新空状态不预热——会 spawn 新会话写入零消息的"幽灵会话"条目。
  // 失败走 onExit 懒重生兜底；空闲不被 checkIdle 误杀（pendingTurns=0 不计时）；不耗 token。
  // 台阶3：只预热初始 cwd（WORK_DIR）的最后查看会话为唯一恢复 tab，设为 viewingInstanceId；其余 tab
  // ephemeral（重启没了、从历史列表手动重开，守配额闸）。仅当该 cwd 指针确属本目录（jsonl 在本 project
  // 目录）才预热 resume，避免对别目录会话 resume 失败。全新空状态不预热（viewingInstanceId 保持 null、
  // 首条消息懒开）。失败走 onExit 兜底；空闲不被 checkIdle 误杀；不耗 token。
  currentSessionForCwd(WORK_DIR).then(s => {
    if (s) viewingInstanceId = openInstance({ cwd: WORK_DIR, resumeId: s.id }).instanceId;
  }).catch(err => console.error('[preheat]', err));
});

// #4：SIGINT 与 SIGTERM 都要清理（node --watch 重启、systemd、docker stop 走 SIGTERM）
function shutdown(sig) {
  console.log(`\n收到 ${sig}，正在关闭…`);
  sessions.flushSaveSync(); // B4：防抖窗口内未落盘的状态同步写入
  clearInterval(statusInterval);  // E16：node --watch 的 SIGTERM 重启路径必须清定时器
  clearTimeout(statusDebounce);   // （在途 git execFile 由 2s timeout 与进程退出收割）
  for (const a of agents.values()) a.dispose(); // 台阶2：遍历所有目录实例——各自杀子进程、deny 挂起审批
  agents.clear();
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// 导出供集成测试使用
export { httpServer, io, port };
