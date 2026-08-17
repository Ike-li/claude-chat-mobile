// CLI hooks 桥核心：把 claude CLI 的 hook 事件（Stop / Notification）规范化成投递箱文件，
// server 侧 fs.watch 扫描消费 → 外部终端会话的「回合结束 / 需要你」由轮询变推送。
//
// 为什么是文件投递箱不是 HTTP 端点：hook 命令要写进用户全局 ~/.claude/settings.json，走 HTTP
// 就得把 AUTH_TOKEN 写进那条命令串（该文件常被 dotfiles 仓库同步、ps 可见）；文件通道本身无
// 秘密，权限模型就是 0700/0600。且 server 离线时事件仍落盘，安装器才能做"文件级"回环验证。
//
// 与 cli-statusline-bridge.js 同构（原子写 / 权限校验 / schema 版本化），但语义不同：statusline
// 快照是【状态】（按 sessionId 覆盖、TTL 判新鲜），hook 事件是【信号】（一次性、消费即删）。
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, platform } from 'node:os';
import { join, resolve } from 'node:path';

import { throttleNotify } from './notifications.js';

export const CLI_HOOKS_SCHEMA_VERSION = 1;
const DEFAULT_CLI_HOOKS_ROOT = join(homedir(), '.claude', 'ccm', 'hooks-v1');
export const DEFAULT_CLI_HOOKS_EVENTS_DIR = join(DEFAULT_CLI_HOOKS_ROOT, 'events');
export const DEFAULT_CLI_HOOKS_ACKS_DIR = join(DEFAULT_CLI_HOOKS_ROOT, 'acks');
// 陈旧事件阈值：合盖睡一夜再打开，攒下的事件既不该刷镜像（启动后首个 catchUpTick 本就全量重建）
// 也不该补推通知（那是噪音）——直接删。
export const HOOK_EVENT_TTL_MS = 5 * 60_000;
// 推送另设更严的年龄闸（server 侧决策用）：旧事件仍可触发刷新，但不补推通知。
export const HOOK_PUSH_MAX_AGE_MS = 90_000;
const MAX_HOOK_EVENT_BYTES = 16 * 1024;
// 目录容量上限：runner 写入前自清；server 单次 scan 处理上限（超出直接删，不留到下次）。
const HOOK_EVENTS_CAP = 256;
const HOOK_SCAN_MAX_FILES = 100;
// 安装回环验证用的 sessionId 前缀：server 见到只写 ack 回执，不推送、不刷镜像。
export const HOOK_VERIFY_PREFIX = 'ccm-verify-';

// 投递箱路径的单一事实源：runner（CLI 侧）、安装器、server inbox 三方必须解析出同一对目录，
// 否则事件写到 A、server 盯着 B，表现为"装了却永远收不到"。自定义 events 目录时 acks 默认取其
// 兄弟目录，保持一处配置即可。
export function resolveHookDirs(env = process.env) {
  const customEvents = nonEmptyString(env.CLI_HOOKS_DIR);
  const eventsDir = resolve(customEvents || DEFAULT_CLI_HOOKS_EVENTS_DIR);
  const customAcks = nonEmptyString(env.CLI_HOOKS_ACKS_DIR);
  const acksDir = resolve(customAcks
    || (customEvents ? join(eventsDir, '..', 'acks') : DEFAULT_CLI_HOOKS_ACKS_DIR));
  return { eventsDir, acksDir };
}

// 只收这两个事件：Stop=一轮结束、Notification=CLI 在等你（权限请求/长时间无输入）。
// 其余 hook（PreToolUse 等）频次高且价值低，装了只会放大 settings.json 手术面与验证面。
const HOOK_EVENT_NAMES = new Set(['Stop', 'Notification']);

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function nonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

// CLI 经 stdin 传入的 hook JSON → 版本化白名单事件。刻意不收 message / transcript_path：
// server 的决策只需要"哪个会话、什么事件"，正文落进投递箱等于把会话内容写到第二处磁盘（SEC-04）。
export function normalizeCliHookInput(raw, { capturedAt = Date.now() } = {}) {
  let input;
  try {
    input = JSON.parse(typeof raw === 'string' ? raw : String(raw ?? ''));
  } catch {
    return null;
  }
  if (!input || typeof input !== 'object') return null;
  const hookEventName = nonEmptyString(input.hook_event_name);
  const sessionId = nonEmptyString(input.session_id);
  const cwd = nonEmptyString(input.cwd);
  const at = nonNegative(capturedAt);
  if (!hookEventName || !HOOK_EVENT_NAMES.has(hookEventName) || !sessionId || !cwd || at === null) return null;
  return {
    schemaVersion: CLI_HOOKS_SCHEMA_VERSION,
    source: 'claude-cli-hook',
    hookEventName,
    sessionId,
    cwd,
    capturedAt: at,
  };
}

export function isVerifyEvent(event) {
  return Boolean(event && typeof event.sessionId === 'string' && event.sessionId.startsWith(HOOK_VERIFY_PREFIX));
}

// server 启动时自建投递箱目录：目录存在 watch 才建得起来，否则"装完 hooks 得重启 server 才生效"。
// 注意这只创建 ccm 自己命名空间下的目录（~/.claude/ccm/hooks-v1/）。
// 写用户 CLI 配置（~/.claude/settings.json）的红线是：**只在用户显式动作时写**——CLI 侧跑安装器，
// 或已鉴权设备在服务状态面板点「开启终端会话推送」（socket hooks:setup，2026-07-26 机主批准开的口子，
// 理由：手机上跑不了 npm，只留 CLI 入口等于让移动端用户永远发现不了这个能力）。
// 启动、连接、任何后台时机一律不写。
export function ensureHooksDirectory(dir) {
  return ensurePrivateDirectory(dir);
}

function ensurePrivateDirectory(dir) {
  const resolved = resolve(dir);
  mkdirSync(resolved, { recursive: true, mode: 0o700 });
  const stat = lstatSync(resolved);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error('hooks directory must be a real directory');
  }
  if (platform() !== 'win32') chmodSync(resolved, 0o700);
  return resolved;
}

function atomicWriteJson(dir, filename, payload) {
  const destination = join(dir, filename);
  const temporary = join(dir, `.${filename}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  let fd;
  let renamed = false;
  try {
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    writeFileSync(fd, JSON.stringify(payload), 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, destination);
    renamed = true;
    if (platform() !== 'win32') chmodSync(destination, 0o600);
    return destination;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* preserve the original write error */ }
    }
    if (!renamed) {
      try { unlinkSync(temporary); } catch { /* absent / already cleaned */ }
    }
  }
}

// 只认下方 eventFileName 写出的命名形态（<capturedAt>-<事件名>-<pid>-<hex6>.json）。
// 扫描/启动清扫/容量修剪的删除面都以此为界（R5/2026-08-06）：CLI_HOOKS_DIR 是用户可配路径
// （env-schema 文档化），指到含无关 *.json 的目录时，旧判据「目录下所有 json」会把别人的文件
// 当作坏事件读掉、删光。非自家形态的文件读、删、计数都不许碰。
const HOOK_EVENT_FILE_RE = /^\d+-[A-Za-z][A-Za-z0-9_-]*-\d+-[0-9a-f]{6}\.json$/;

function eventFileNames(dir) {
  // .tmp（别人正在写的半成品）与非自家命名形态（别人的文件）都不属于扫描面
  return readdirSync(dir).filter(name => HOOK_EVENT_FILE_RE.test(name));
}

// 事件文件名：时间可排序 + pid/随机后缀防同毫秒冲突。改形状必须同步上方 HOOK_EVENT_FILE_RE。
function eventFileName(event) {
  return `${event.capturedAt}-${event.hookEventName}-${process.pid}-${randomBytes(3).toString('hex')}.json`;
}

export function writeCliHookEvent(event, { dir = DEFAULT_CLI_HOOKS_EVENTS_DIR, cap = HOOK_EVENTS_CAP } = {}) {
  if (!event || event.schemaVersion !== CLI_HOOKS_SCHEMA_VERSION || event.source !== 'claude-cli-hook') {
    throw new TypeError('invalid CLI hook event');
  }
  const privateDir = ensurePrivateDirectory(dir);
  // 容量护栏：server 长期不在（没人消费）时不能把目录撑爆。先清过期，仍然满就跳过本次写入——
  // hook 是加分信号，宁可丢事件也不能让 CLI 侧的写入变成负担。
  let names = eventFileNames(privateDir);
  if (names.length >= cap) {
    const now = Date.now();
    for (const name of names) {
      const path = join(privateDir, name);
      try {
        if (now - statSync(path).mtimeMs > HOOK_EVENT_TTL_MS) unlinkSync(path);
      } catch { /* 已被 server 消费 */ }
    }
    names = eventFileNames(privateDir);
    if (names.length >= cap) return null;
  }
  return atomicWriteJson(privateDir, eventFileName(event), event);
}

// 扫描并消费：返回有效事件，同时把读到的文件全部删掉（删除即 ack）。任何异常按"该文件不存在"跳过。
export function scanHookEvents({
  dir = DEFAULT_CLI_HOOKS_EVENTS_DIR,
  now = Date.now(),
  ttlMs = HOOK_EVENT_TTL_MS,
  maxFiles = HOOK_SCAN_MAX_FILES,
} = {}) {
  const events = [];
  let expired = 0;
  let invalid = 0;
  let names;
  const resolvedDir = resolve(dir);
  try {
    names = eventFileNames(resolvedDir);
  } catch {
    return { events, expired, invalid };
  }
  names.sort(); // 文件名以 capturedAt 起头：按时间序消费
  let processed = 0;
  for (const name of names) {
    const path = join(resolvedDir, name);
    // 超出单次处理上限的一并删除，不留到下次——积压只会越滚越大，且旧信号本就无价值
    if (processed >= maxFiles) {
      try { unlinkSync(path); } catch { /* ignore */ }
      continue;
    }
    processed += 1;
    let event = null;
    try {
      const stat = lstatSync(path);
      if (!stat.isSymbolicLink() && stat.isFile() && stat.size <= MAX_HOOK_EVENT_BYTES) {
        event = JSON.parse(readFileSync(path, 'utf8'));
      }
    } catch {
      event = null;
    }
    try { unlinkSync(path); } catch { /* 已被并发消费 */ }
    if (!event || typeof event !== 'object'
        || event.schemaVersion !== CLI_HOOKS_SCHEMA_VERSION
        || event.source !== 'claude-cli-hook'
        || !HOOK_EVENT_NAMES.has(event.hookEventName)
        || !nonEmptyString(event.sessionId) || !nonEmptyString(event.cwd)
        || nonNegative(event.capturedAt) === null) {
      invalid += 1;
      continue;
    }
    if (now - event.capturedAt > ttlMs) { expired += 1; continue; }
    events.push(event);
  }
  return { events, expired, invalid };
}

// server 启动时全清扫：积压事件零重放（刷镜像由启动后首个 catchUpTick 全量重建覆盖；
// 补推旧通知是噪音）。返回删除数量，供日志。
export function sweepHookEvents({ dir = DEFAULT_CLI_HOOKS_EVENTS_DIR } = {}) {
  let removed = 0;
  try {
    for (const name of eventFileNames(resolve(dir))) {
      try { unlinkSync(join(resolve(dir), name)); removed += 1; } catch { /* ignore */ }
    }
  } catch { /* 目录不存在 */ }
  return removed;
}

// ── 安装态（读侧）─────────────────────────────────────────────────────────────
// 判定逻辑放在 ops 而非安装器脚本里：server 也要知道装没装（启动日志、UI 提示、一键安装按钮），
// 而模块边界守卫禁止运行时源码 import scripts/。安装器改为复用这里，保证两边判定永不分叉。
export const HOOK_EVENT_LIST = ['Stop', 'Notification'];
export const HOOK_TIMEOUT_SEC = 10; // CLI 侧硬保险；runner 自带 2s 看门狗，正常 <100ms

export function hooksPathsForHome(home = homedir()) {
  return {
    settings: join(home, '.claude', 'settings.json'),
    manifest: join(home, '.claude', 'ccm', 'hooks-v1', 'install-manifest.json'),
  };
}

function lstatIfPresent(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

// settings.json 不存在是合法起点（新装 claude 的用户可能还没这个文件）→ 视作 {}。
export function readClaudeSettings(path) {
  const stat = lstatIfPresent(path);
  if (!stat) return {};
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Claude settings must be a JSON object');
  }
  return parsed;
}

export function readHooksManifest(path) {
  const stat = lstatIfPresent(path);
  if (!stat) return null;
  if (stat.isSymbolicLink()) throw new Error(`hooks bridge refused symbolic link path: ${path}`);
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
      || typeof parsed.installedCommand !== 'string' || !Array.isArray(parsed.events)) {
    throw new Error('hooks bridge manifest is invalid');
  }
  return parsed;
}

// 我们自己写的条目长什么样（形状完全吻合才算，多一个 matcher 都不算——那是用户自己加的）
export function matchingHookIndexes(settings, event, installedCommand) {
  const list = Array.isArray(settings?.hooks?.[event]) ? settings.hooks[event] : [];
  const hits = [];
  list.forEach((entry, index) => {
    const hooks = Array.isArray(entry?.hooks) ? entry.hooks : [];
    if (hooks.length === 1 && hooks[0]?.type === 'command'
        && hooks[0]?.command === installedCommand && hooks[0]?.timeout === HOOK_TIMEOUT_SEC
        && !Object.hasOwn(entry, 'matcher')) {
      hits.push(index);
    }
  });
  return hits;
}

// 已安装 = manifest 记录的每个事件下【恰好一条】完全吻合的条目。多于一条 / 被改 / 缺失都算漂移，
// 交给用户决断（不猜、不强行覆盖）。
export function hooksInstalledStateMatches(settings, manifest) {
  return manifest.events.every(e => matchingHookIndexes(settings, e, manifest.installedCommand).length === 1);
}

// 三态安装状态；任何读失败一律按 'unknown' 上报，绝不让它影响调用方主流程。
export function readHooksInstallState({ home = homedir() } = {}) {
  try {
    const paths = hooksPathsForHome(home);
    const manifest = readHooksManifest(paths.manifest);
    if (!manifest) return 'not-installed';
    return hooksInstalledStateMatches(readClaudeSettings(paths.settings), manifest) ? 'installed' : 'drifted';
  } catch {
    return 'unknown';
  }
}

// 节流类别：**必须**是 pending:false 的一次性类别，绝不能复用 'approval'/'input'——后两者被
// throttleNotify 置 pending:true，靠 request_resolved 清除；hook 世界没有对应的"已处理"事件，
// 复用会让该会话的后续推送被永久吞掉。
const HOOK_NOTIFY_CATEGORY = Object.freeze({
  Stop: 'hook-finished',
  Notification: 'hook-attention',
});

// 一批 hook 事件 → 要执行的动作（纯函数，便于单测覆盖推送/白名单/节流的全部分支）。
// 返回 { catchUp, invalidateCwds, pushes, acks, ignored, nextThrottleState }；调用方负责真正的
// IO（写 ack / 触发 catchUpTick / 失效缓存 / 发推送）与节流态的持有。
export function decideHookEventActions(events, {
  viewingSessionId = null,
  viewingCwd = null,
  workDirs = [],
  hasForegroundClient = false,
  now = Date.now(),
  throttleState = new Map(),
  throttleMs = 60_000,
  pushMaxAgeMs = HOOK_PUSH_MAX_AGE_MS,
  throttle = throttleNotify, // 同层直接用；可注入便于测试极端节流参数
} = {}) {
  const allowed = new Set((Array.isArray(workDirs) ? workDirs : []).map(d => resolve(String(d))));
  const invalidate = new Set();
  const pushes = [];
  const acks = [];
  let catchUp = false;
  let ignored = 0;
  let state = throttleState;
  for (const event of Array.isArray(events) ? events : []) {
    if (!event || !nonEmptyString(event.sessionId) || !nonEmptyString(event.cwd)) { ignored += 1; continue; }
    // verify 事件不受工作区白名单约束：安装回环验证可能在任意目录执行
    if (isVerifyEvent(event)) { acks.push(event.sessionId); continue; }
    const cwd = resolve(event.cwd);
    if (!allowed.has(cwd)) { ignored += 1; continue; }
    invalidate.add(event.cwd);
    if (viewingSessionId && event.sessionId === viewingSessionId
        && viewingCwd && resolve(viewingCwd) === cwd) {
      catchUp = true;
    }
    const category = HOOK_NOTIFY_CATEGORY[event.hookEventName];
    if (!category) { ignored += 1; continue; }
    // Stop = 回合结束：前台有人在看就不必打扰（对齐 result 的既有规则）。
    // Notification = CLI 在等你：可能锁屏或在别的会话，无条件推。
    if (event.hookEventName === 'Stop' && hasForegroundClient) continue;
    if (now - event.capturedAt > pushMaxAgeMs) continue; // 旧事件仍刷新，但不补推通知
    if (typeof throttle === 'function') {
      const { throttled, next } = throttle(event.sessionId, category, now, state, throttleMs);
      state = next;
      if (throttled) continue;
    }
    pushes.push({ hookEventName: event.hookEventName, sessionId: event.sessionId, cwd: event.cwd, category });
  }
  return {
    catchUp,
    invalidateCwds: [...invalidate],
    pushes,
    acks,
    ignored,
    nextThrottleState: state,
  };
}

function ackFilePath(dir, verifyId) {
  const key = createHash('sha256').update(String(verifyId), 'utf8').digest('hex');
  return join(resolve(dir), `${key}.json`);
}

// 回环验证回执：server 消费到 verify 事件后写这个文件，安装器轮询它。
// 为什么不让安装器直接看"事件文件消失了"——文件消失无法区分「被 server 消费」和「压根没写成功」，
// 回执是确定性的正向证据，且让安装器↔server 的契约保持纯文件系统（与鉴权配置完全解耦）。
export function writeHookVerifyAck(verifyId, { dir = DEFAULT_CLI_HOOKS_ACKS_DIR, ackedAt = Date.now() } = {}) {
  const privateDir = ensurePrivateDirectory(dir);
  const key = createHash('sha256').update(String(verifyId), 'utf8').digest('hex');
  return atomicWriteJson(privateDir, `${key}.json`, { schemaVersion: CLI_HOOKS_SCHEMA_VERSION, ackedAt });
}

export function readHookVerifyAck(verifyId, { dir = DEFAULT_CLI_HOOKS_ACKS_DIR } = {}) {
  try {
    const payload = JSON.parse(readFileSync(ackFilePath(dir, verifyId), 'utf8'));
    return payload?.schemaVersion === CLI_HOOKS_SCHEMA_VERSION;
  } catch {
    return false;
  }
}
