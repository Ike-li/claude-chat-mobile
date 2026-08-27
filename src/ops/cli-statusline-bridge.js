// CLI statusline bridge core: normalize the CLI's stdin JSON into a small,
// versioned snapshot that is safe for the Web mirror to consume.

import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, platform } from 'node:os';
import { join, resolve } from 'node:path';
import { ccmUnderClaudeHome } from '../shared/claude-home.js';

const CLI_STATUSLINE_SCHEMA_VERSION = 1;
const MAX_CLI_STATUSLINE_SNAPSHOT_BYTES = 64 * 1024;
const DEFAULT_CLI_STATUSLINE_DIR = join(
  ccmUnderClaudeHome(homedir(), 'statusline-v1', 'snapshots'),
);

export function cliStatuslineTtlMs(refreshIntervalSec = 60) {
  const candidate = nonNegative(refreshIntervalSec);
  const intervalSec = candidate !== null && candidate > 0 ? candidate : 60;
  return Math.min(180_000, Math.max(30_000, intervalSec * 2_000 + 5_000));
}

const EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function nonNegative(value) {
  const n = finite(value);
  return n !== null && n >= 0 ? n : null;
}

function percentage(value) {
  const n = nonNegative(value);
  return n !== null && n <= 100 ? n : null;
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function optionalNonNegative(target, key, value) {
  const n = nonNegative(value);
  if (n !== null) target[key] = n;
}

function normalizeRateWindow(value) {
  if (!value || typeof value !== 'object') return null;
  const out = {};
  const usedPercent = percentage(value.used_percentage);
  if (usedPercent !== null) out.usedPercent = usedPercent;
  // CLI statusline stdin uses Unix epoch *seconds*. Agent SDK fetchUsage uses
  // ISO strings for a similarly named field; downstream adapters must not mix them.
  optionalNonNegative(out, 'resetsAt', value.resets_at);
  return Object.keys(out).length ? out : null;
}

export function normalizeCliStatusInput(raw, {
  capturedAt = Date.now(),
  refreshIntervalSec,
} = {}) {
  let input;
  try {
    input = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;

  const sessionId = nonEmptyString(input.session_id);
  const cwd = nonEmptyString(input.workspace?.current_dir)
    || nonEmptyString(input.workspace?.project_dir)
    || nonEmptyString(input.cwd);
  const timestamp = nonNegative(capturedAt);
  if (!sessionId || !cwd || timestamp === null) return null;

  const snapshot = {
    schemaVersion: CLI_STATUSLINE_SCHEMA_VERSION,
    source: 'claude-cli',
    capturedAt: timestamp,
  };
  const refresh = nonNegative(refreshIntervalSec);
  if (refresh !== null && refresh > 0) snapshot.refreshIntervalSec = refresh;
  snapshot.sessionId = sessionId;
  snapshot.cwd = cwd;

  if (input.model && typeof input.model === 'object') {
    const id = nonEmptyString(input.model.id);
    const displayName = nonEmptyString(input.model.display_name);
    if (id || displayName) snapshot.model = {
      ...(id ? { id } : {}),
      ...(displayName ? { displayName } : {}),
    };
  } else {
    const id = nonEmptyString(input.model);
    if (id) snapshot.model = { id };
  }

  if (EFFORT_LEVELS.has(input.effort?.level)) snapshot.effort = input.effort.level;
  if (typeof input.thinking?.enabled === 'boolean') {
    snapshot.thinking = { enabled: input.thinking.enabled };
  }

  const cw = input.context_window;
  if (cw && typeof cw === 'object') {
    const usage = cw.current_usage && typeof cw.current_usage === 'object'
      ? cw.current_usage
      : {};
    const ctx = {};
    optionalNonNegative(ctx, 'tokens', cw.total_input_tokens);
    optionalNonNegative(ctx, 'in', usage.input_tokens);
    optionalNonNegative(ctx, 'out', usage.output_tokens);
    optionalNonNegative(ctx, 'w', usage.cache_creation_input_tokens);
    optionalNonNegative(ctx, 'r', usage.cache_read_input_tokens);
    const currentTotal = (nonNegative(usage.input_tokens) || 0)
      + (nonNegative(usage.cache_creation_input_tokens) || 0)
      + (nonNegative(usage.cache_read_input_tokens) || 0);
    if (currentTotal > 0) {
      ctx.currentTotal = currentTotal;
      ctx.cacheHitPct = (nonNegative(usage.cache_read_input_tokens) || 0) / currentTotal * 100;
    }
    optionalNonNegative(ctx, 'windowSize', cw.context_window_size);
    const usedPercent = percentage(cw.used_percentage);
    if (usedPercent !== null) ctx.usedPercent = usedPercent;
    if (Object.keys(ctx).length) snapshot.ctx = ctx;
  }

  const cost = input.cost;
  if (cost && typeof cost === 'object') {
    const totalCost = nonNegative(cost.total_cost_usd);
    if (totalCost !== null) snapshot.cost = totalCost;
    const duration = {};
    optionalNonNegative(duration, 'wallMs', cost.total_duration_ms);
    optionalNonNegative(duration, 'apiMs', cost.total_api_duration_ms);
    if (Object.keys(duration).length) snapshot.duration = duration;
    const lines = {};
    optionalNonNegative(lines, 'added', cost.total_lines_added);
    optionalNonNegative(lines, 'removed', cost.total_lines_removed);
    if (Object.keys(lines).length) snapshot.lines = lines;
  }

  const fiveHour = normalizeRateWindow(input.rate_limits?.five_hour);
  const sevenDay = normalizeRateWindow(input.rate_limits?.seven_day);
  if (fiveHour || sevenDay) snapshot.rate = {
    ...(fiveHour ? { fiveHour } : {}),
    ...(sevenDay ? { sevenDay } : {}),
  };

  const cliVersion = nonEmptyString(input.version);
  if (cliVersion) snapshot.cliVersion = cliVersion;
  return snapshot;
}

// 快照保留窗（R9/2026-08-06）。一个会话一个文件（名=sha256(sessionId)），会话删了快照不删——
// 真机实测 22 天攒 248 个。而超过 readCliStatusSnapshot 的 TTL 后快照读出来必是 {state:'stale'}，
// 留着零价值。取 24h 远宽于任何 refreshIntervalSec 推出的读 TTL（分钟级），只清真正的死文件；
// 对齐 hooks 投递箱的 HOOK_EVENT_TTL_MS 治理形态（此前两个同构模块只有一边有闸）。
export const STATUSLINE_SNAPSHOT_TTL_MS = 24 * 60 * 60_000;

// 只认自家命名形态（sha256 十六进制 + .json）。删除面纪律同 hooks 侧 R5：目录是用户可配的
// （CLI_STATUSLINE_DIR），绝不能把别人的 *.json 卷进来。
const SNAPSHOT_FILE_RE = /^[0-9a-f]{64}\.json$/;

// 清扫过期快照，返回删除数量。写入路径顺带调用——CLI 每次刷 statusline 都会写，不需要额外调度。
// 判据用 capturedAt（文件内容）而非 mtime：与 readCliStatusSnapshot 的过期判据同源。
// 读不动/解析失败的按「不认识」跳过，不删——宁可留垃圾也不误删。
export function sweepStatusSnapshots({ dir = DEFAULT_CLI_STATUSLINE_DIR, now = Date.now(), ttlMs = STATUSLINE_SNAPSHOT_TTL_MS, skip = null } = {}) {
  let removed = 0;
  const resolvedDir = resolve(dir);
  let names;
  try { names = readdirSync(resolvedDir).filter(name => SNAPSHOT_FILE_RE.test(name)); }
  catch { return 0; } // 目录不存在（首次运行 / 桥未安装）
  for (const name of names) {
    // skip：写入路径传本次的目标文件名。清扫绝不能删自己正要写的那个——CLI 若缓冲后才落盘，
    // capturedAt 可能已略旧，会变成「删了又写」；多进程同 session 争写时还会与别人的 rename 竞态。
    if (skip && name === skip) continue;
    const path = join(resolvedDir, name);
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'));
      const capturedAt = nonNegative(parsed?.capturedAt);
      if (capturedAt === null || now - capturedAt <= ttlMs) continue;
      unlinkSync(path); // safe-path: 目录段是 resolve(dir) 常量，文件名经 SNAPSHOT_FILE_RE 限定为自家 sha256 形态
      removed += 1;
    } catch { /* 读不动/坏 JSON：不认识就不删 */ }
  }
  return removed;
}

export function snapshotFilePath(dir = DEFAULT_CLI_STATUSLINE_DIR, sessionId) {
  if (typeof dir !== 'string' || !dir || typeof sessionId !== 'string' || !sessionId) {
    throw new TypeError('snapshot dir and sessionId must be non-empty strings');
  }
  const key = createHash('sha256').update(sessionId, 'utf8').digest('hex');
  return join(resolve(dir), `${key}.json`);
}

function ensurePrivateDirectory(dir) {
  const resolved = resolve(dir);
  mkdirSync(resolved, { recursive: true, mode: 0o700 });
  const stat = lstatSync(resolved);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error('snapshot directory must be a real directory');
  }
  if (platform() !== 'win32') chmodSync(resolved, 0o700);
  return resolved;
}

function assertSnapshotForWrite(snapshot) {
  if (!snapshot || typeof snapshot !== 'object'
      || snapshot.schemaVersion !== CLI_STATUSLINE_SCHEMA_VERSION
      || snapshot.source !== 'claude-cli'
      || !nonEmptyString(snapshot.sessionId)
      || !nonEmptyString(snapshot.cwd)
      || nonNegative(snapshot.capturedAt) === null) {
    throw new TypeError('invalid CLI statusline snapshot');
  }
}

export function writeCliStatusSnapshot(snapshot, {
  dir = DEFAULT_CLI_STATUSLINE_DIR,
  now = Date.now(),
} = {}) {
  assertSnapshotForWrite(snapshot);
  const privateDir = ensurePrivateDirectory(dir);
  const destination = snapshotFilePath(privateDir, snapshot.sessionId);
  // R9：写入即清扫过期快照。挂在这条路径上是因为 CLI 每次刷 statusline 都会写——不必新增调度，
  // 也不会在 server 侧读路径上加开销。skip 掉本次目标（见 sweepStatusSnapshots 内注释）。
  // 清扫失败不得影响写入（它是加分项）。
  try { sweepStatusSnapshots({ dir: privateDir, now, skip: basenameForTemp(destination) }); } catch { /* 清扫失败不挡写入 */ }
  const temporary = join(privateDir, `.${basenameForTemp(destination)}.${process.pid}.${randomUUID()}.tmp`);
  let fd;
  let renamed = false;
  try {
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    writeFileSync(fd, JSON.stringify(snapshot), 'utf8');
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

export function readCliStatusSnapshot(sessionId, {
  dir = DEFAULT_CLI_STATUSLINE_DIR,
  cwd,
  now = Date.now(),
  ttlMs,
  maxBytes = MAX_CLI_STATUSLINE_SNAPSHOT_BYTES,
} = {}) {
  let snapshot;
  try {
    const resolvedDir = resolve(dir);
    const dirStat = lstatSync(resolvedDir);
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()
        || (platform() !== 'win32' && (dirStat.mode & 0o777) !== 0o700)) {
      return { state: 'insecure' };
    }
    const path = snapshotFilePath(resolvedDir, sessionId);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()
        || (platform() !== 'win32' && (stat.mode & 0o777) !== 0o600)) {
      return { state: 'insecure' };
    }
    const limit = nonNegative(maxBytes);
    if (limit === null || limit === 0) return { state: 'invalid' };
    if (stat.size > limit) return { state: 'oversized' };
    snapshot = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return { state: error?.code === 'ENOENT' ? 'missing' : 'invalid' };
  }
  if (!snapshot || snapshot.schemaVersion !== CLI_STATUSLINE_SCHEMA_VERSION
      || snapshot.source !== 'claude-cli') {
    return { state: 'invalid' };
  }
  if (snapshot.sessionId !== sessionId) return { state: 'session-mismatch' };
  if (!nonEmptyString(snapshot.cwd) || !nonEmptyString(cwd)) return { state: 'invalid' };
  if (resolve(snapshot.cwd) !== resolve(cwd)) return { state: 'cwd-mismatch' };
  const currentTime = nonNegative(now);
  const ttl = ttlMs === undefined
    ? cliStatuslineTtlMs(snapshot.refreshIntervalSec)
    : nonNegative(ttlMs);
  const capturedAt = nonNegative(snapshot.capturedAt);
  if (currentTime === null || ttl === null || capturedAt === null) return { state: 'invalid' };
  const ageMs = currentTime - capturedAt;
  if (ageMs < 0) return { state: 'invalid' };
  if (ageMs > ttl) return { state: 'stale', ageMs };
  return { state: 'fresh', ageMs, snapshot };
}

// 状态栏事实源：仅当 Web 处于只读镜像（mirrorReadonly=终端真在驾驶/尾部 pending）时走 CLI 快照。
// externalDirty 故意不参与——它只表示「SDK 子进程内存滞后于磁盘、下次发送前须置换实例」，
// 不表示 CLI 此刻仍是驾驶员。mirror 自动解锁后 Web 已可输入；若仍因 externalDirty 锁在 CLI
// 来源，而 Web 会话从不写 CLI 快照（CCM_STATUSLINE_ORIGIN=web-sdk 跳过 capture），会长期显示
// 「CLI 状态暂不可用 (missing)」。形参保留以兼容旧调用方，忽略其值。
export function selectStatusOwner({
  mirrorReadonly = false,
  externalDirty: _externalDirty = false,
} = {}) {
  return mirrorReadonly ? 'cli' : 'sdk';
}

export function selectStatusSource({ owner, cliRead, sdkPayload } = {}) {
  if (owner === 'sdk') return { kind: 'sdk', value: sdkPayload };
  if (cliRead?.state === 'fresh' && cliRead.snapshot) {
    return { kind: 'cli', ageMs: cliRead.ageMs, value: cliRead.snapshot };
  }
  const unavailable = {
    kind: 'cli-unavailable',
    reason: cliRead?.state || 'missing',
    value: null,
  };
  if (nonNegative(cliRead?.ageMs) !== null) unavailable.ageMs = cliRead.ageMs;
  return unavailable;
}

// 连接/设备解锁的即时重放只能消费与“当前驾驶方 + 当前视图”完全一致的缓存。
// owner 不同会把上一驾驶方的状态短暂冒充当前事实；instance/session/cwd 不同则会串 tab 或会话。
export function selectStatusReplay(cache, current = {}) {
  if (!cache || typeof cache !== 'object' || !cache.payload || typeof cache.payload !== 'object') return null;
  const owner = current.owner;
  if (cache.owner !== owner
      || (cache.instanceId ?? null) !== (current.instanceId ?? null)
      || (cache.sessionId ?? null) !== (current.sessionId ?? null)
      || (cache.cwd ?? null) !== (current.cwd ?? null)) return null;
  const kind = cache.payload.source?.kind;
  if ((owner === 'sdk' && kind !== 'sdk')
      || (owner === 'cli' && kind !== 'cli' && kind !== 'cli-unavailable')) return null;
  return {
    ...cache.payload,
    ...(typeof current.instanceId === 'string' && current.instanceId
      ? { instanceId: current.instanceId }
      : {}),
  };
}

function basenameForTemp(path) {
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return slash === -1 ? path : path.slice(slash + 1);
}
