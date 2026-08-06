// app.js —— Express 静态托管 + Socket.IO 契约层；环境已由根 server.js 在动态导入前加载。
// 会话与 socket 解耦：AgentSession 挂在服务端（4c 物理不变量），事件 io.emit 广播（多设备同看）。
//
// 分层边界（check-import-boundaries 硬闸）：本文件是唯一组装根——低耦合机制已下沉
// （notify-channels/device-gate/approval-lifecycle/http/socket/instance-*），留在这里的
// mirror/catchUp 同步引擎、openInstance 生命周期、契约路由共享同一组顶层可变状态
// （viewing*/mirror*/catchUp*），拆开只会把耦合变成上下文对象穿针——有意保留为组装根本体。
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { statSync, readFileSync, realpathSync, existsSync, mkdirSync, appendFileSync, unlinkSync } from 'node:fs';
import { maskToken } from '../shared/sanitizer.js';
import { setCapped } from '../shared/bounded-map.js';
import { writeOwnerOnlyFile, rejectableSymlinkComponent, resolveExecutableViaPath } from '../files/file-security.js';
import { homedir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { execSync, execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import express from 'express';
import { Server } from 'socket.io';
import { AgentSession } from '../agent/agent.js';
import { deleteSession as sdkDeleteSession, forkSession as sdkForkSession, resolveSettings as sdkResolveSettings } from '@anthropic-ai/claude-agent-sdk';
import { resolveFreshPrefs, resolveResumeEffort, defaultsFromEffectiveSettings, normalizePermissionMode, normalizeEffortUiLevel, parseWorktreeCanonicalRoot, buildWorktreeGatewayEnv, countNeutralizableGatewayKeys, decideWorktreeSettingsAction } from '../agent/cli-settings-defaults.js';
import * as sessions from '../sessions/sessions.js';
import { getSessionHistory, listSessionsPage, sessionFileExists, sessionFileMtime, getProjectDir, invalidateListCache, readLastPermissionMode, readLastAssistantModel } from '../sessions/history.js';
import * as diagLog from '../agent/diag-log.js';
import { notificationForEvent, notificationForCliHook, ntfyMetaFor, throttleNotify, clearNotifyPending, NOTIFY_CATEGORY, isValidPushSubscription, hasForegroundApprovedClient, shouldNotifyBackgroundRunning, notificationForBackgroundRunning } from '../ops/notifications.js';
import { decideHookEventActions, resolveHookDirs, readHooksInstallState } from '../ops/cli-hooks-bridge.js';
import { startLogTerminal, stopLogTerminalSync } from '../ops/log-terminal.js';
import { createHooksInbox } from './hooks-inbox.js';
import { createNotifyChannels } from '../ops/notify-channels.js';
import { formatClientErrorLine, createSocketErrorLimiter } from '../ops/client-error-log.js';
import { attributePath, buildDiff, readPreview } from '../files/file-preview.js';
import { runDoctor, countConfigPermProblems } from '../ops/doctor-runtime.js';
import { buildWebStatusLine, buildCliStatusLine, projectNameFromCwd, getFallbackUsageRate, noteStatusRefreshBusy } from '../ops/statusline.js';
import { readCliStatusSnapshot, selectStatusOwner, selectStatusReplay, selectStatusSource } from '../ops/cli-statusline-bridge.js';
import { validateAttachments, saveAttachments, buildPromptText, toEventMeta } from '../files/uploads.js';
import * as interactionLog from '../agent/interaction-log.js';
import {
  createModelsCache,
  createCwdKeyedCache,
  isCwdDefaultModel,
  normalizeSlashCommands,
  resolveSlashCommandsForCwd,
} from '../agent/models-cache.js';
import { initCfAccess, isAccessEnabled, isPublicHost, verifyAccessJwt } from '../auth/cf-access.js';
import { onAuthResult, freshState, rlSourceKey, shouldTrustCfConnectingIp, shouldBypassDeviceApproval } from '../auth/rate-limiter.js';
import { deriveLatches } from './instance-latches.js';
import { deriveAttention } from '../sessions/attention.js';
import { listTerminalSessionStates, applyTerminalStatesToSessions, hasBusyTerminalSessionForCwd, findBlockingLiveAgent } from '../sessions/session-registry.js';
import { listDir, readFile as browseReadFile, writeFileInScope } from '../files/file-browse.js';
import { listGitChanges, readGitDiff } from '../files/git-workspace.js';
import { searchFiles } from '../files/file-search.js';
import { isProcessed, commitProcessed, isInFlight, claimInFlight, releaseInFlight } from '../agent/message-dedup.js';
import {
  resolveInstanceTarget,
  shouldRejectOutboxLazyOpen,
  reselectViewingTarget,
  shouldClaimViewingAfterSwap,
  shouldClaimViewingAfterLazyOpen,
  canDeleteSessionGuard,
  externalDirtyBusyNack,
  resolveEffortBroadcast,
} from './instance-routing.js';
import { formatSessionLockError } from '../ops/cli-bg-session-lock.js';
import { watch } from 'node:fs';
import { DEFAULT_SESSION_LIMIT, MAX_SESSION_LIMIT, MAX_LIVE_SESSIONS, normalizeWorkdirEntries, loadWorkdirsFile, resolveWorkdirs, ensureWhitelisted, isWhitelisted, resolveWorkdirsFilePath } from '../sessions/workdirs.js';
import {
  isDeviceTrusted,
  addPendingDevice,
  getLatestPendingDevice,
  approveDevice,
  denyDevice,
  getPendingDevices,
  getTrustedCount
} from '../auth/devices.js';
import { createDeviceGate } from '../auth/device-gate.js';
import * as approvalStore from '../agent/approval-store.js';
import { expireOrphanedPending, startApprovalRetentionSweep } from '../agent/approval-lifecycle.js';
import * as audit from '../ops/audit.js';
import * as metrics from '../ops/metrics.js';
import { parseServerConfig } from './config.js';
import {
  clientIp,
  configureHttpShell,
  createHttpAuth,
  lanIPv4s,
  registerOperationalRoutes,
  tokenMatches as secureTokenMatches,
} from './http.js';
import { createInstanceManager } from './instance-manager.js';
import { isInstanceBeingWatched, resolveUnreadDelta } from './unread-tracker.js';
import { createSocketEventRegistrar, registerSocketConnection } from './socket.js';
import { createMirrorEngine } from './mirror-engine.js';
import { registerFileSocketHandlers } from './socket-files.js';

// env 规整后初始化 Cloudflare Access（CF_ACCESS_* 三项齐全才启用；缺则 isPublicHost 恒 false=回退 token）。
initCfAccess();

const HERE = join(import.meta.dirname, '..', '..'); // 项目根；从任何 cwd 启动都一致
const {
  port,
  authToken: AUTH_TOKEN,
  idleTimeoutMs,
  instanceIdleReclaimMs,
  approvalTtlMs,
  notifyThrottleMs,
  sessionDeleteQuietMs,
  devMode: DEV_MODE,
  workDir: configuredWorkDir,
  dataDir: DATA_DIR,
} = parseServerConfig(process.env, { home: homedir(), projectRoot: HERE });

// WORK_DIR 单列为 let：preflight 通过存在性检查后经 realpathSync 规范化（与 CLI 的
// ~/.claude/projects 命名一致，令会话列表 cwd 隔离匹配稳健，如 /tmp→/private/tmp）。
let WORK_DIR = configuredWorkDir;
// 多 repo 台阶1：可在 web 内切换的工作目录白名单（WORK_DIR + WORK_DIRS，preflight 内构建）。
let workDirs = [];
// 每工作区历史会话显示条数（session:list 默认截断量）；WORK_DIR 及未指定的目录用 DEFAULT_SESSION_LIMIT。
let sessionLimitByDir = new Map();

let notifyThrottleState = new Map(); // per-会话推送节流态（docs/design.md），sessionId → {[category]:{notifiedAt,pending}}；
                                      // 纯函数返回全新 Map，直接整体替换引用（非 mutate）
let messageDedupState = new Map(); // clientMessageId → ts（REL-01：离线重发/网络抖动幂等，见 message-dedup.js）
// isProcessed/commitProcessed 之间横跨多个 await，不是原子的：断线重连重发可能让同一 clientMessageId
// 的第二个请求在第一个请求 commit 之前就跑到同一段代码，两边各自调一次 a.send() 真实重复发送。
// 这里补一层"眼下有没有人正处理这条、尚未落定成败"的占用（见 message-dedup.js 的 isInFlight 一族）。
let messageInFlightIds = new Set();

// ---- 通知发送通道（Web Push E15 + ntfy ②2b）：实现下沉至 ops/notify-channels.js ----
// onDeliveryFailure 延迟绑定 scheduleBgBroadcast（定义在下方）——真失败时广播服务健康。
const notify = createNotifyChannels({
  dataDir: DATA_DIR,
  env: process.env,
  onDeliveryFailure: () => scheduleBgBroadcast(),
});
const { pushEnabled, pushNotify, ntfyNotify, savePushSubscription } = notify;

// ---- 工作区白名单：读取源 + 应用（preflight 与热加载共用）----
// 读取原始条目源：WORK_DIRS_FILE（JSON 数组文件，优先）或 WORK_DIRS（逗号分隔，向后兼容）。
// 文件读/解析失败 → 返回 null（调用方保留旧配置，不清空白名单）。
function readWorkdirSource() {
  const dirsFile = process.env.WORK_DIRS_FILE;
  if (dirsFile) {
    const filePath = resolveWorkdirsFilePath(dirsFile, HERE);
    return loadWorkdirsFile(filePath); // null=读/解析失败
  }
  const raw = (process.env.WORK_DIRS || '').split(',').map(s => s.trim()).filter(Boolean);
  return normalizeWorkdirEntries(raw);
}
// 应用条目：realpath 校验 + 设 workDirs / sessionLimitByDir。WORK_DIR 恒首位（其 limit 若在文件里指定则采用）。
// 返回 warnings[]（调用方决定打印）。
function applyWorkdirs(source) {
  const { dirs, limits, warnings: rw } = resolveWorkdirs(source.entries);
  const nextDirs = [WORK_DIR];
  const nextLimits = new Map([[WORK_DIR, limits.get(WORK_DIR) ?? DEFAULT_SESSION_LIMIT]]);
  for (const d of dirs) {
    if (nextLimits.has(d)) continue;
    nextDirs.push(d);
    nextLimits.set(d, limits.get(d));
  }
  workDirs = nextDirs;
  sessionLimitByDir = nextLimits;
  return [...source.warnings, ...rw];
}
// 热加载：重读 workdirs 源并应用。读取失败保留旧白名单；被移除目录上无 live 实例时把 viewingCwd 归位到
// 首个白名单目录（堵 routeCwd 缺省回退绕过白名单的洞）；末尾广播让前端立即刷新目录列表。免重启改工作区。
function reloadWorkdirs() {
  const source = readWorkdirSource();
  if (source === null) { console.warn('⚠️  [workdirs 热加载] 读取/解析失败，保留旧白名单'); return; }
  const prevKey = workDirs.join('|');
  for (const w of applyWorkdirs(source)) console.warn(`⚠️  [workdirs 热加载] ${w}`);
  // 被移除目录的已开实例保留运行、新开被拒；但若 viewingCwd 停在已移除目录且其上无实例，
  // 缺省路由(routeCwd)会把新会话仍落进已移除目录 → 归位到首个白名单目录。
  const viewingHasInstance = agents.get(viewingInstanceId)?.cwd === viewingCwd;
  // 被热移除且无 live 实例时归位：只认 workDirs 白名单（git worktree 须显式列入 workdirs.json）。
  if (!isWhitelisted(viewingCwd, workDirs) && !viewingHasInstance) viewingCwd = workDirs[0];
  if (workDirs.join('|') !== prevKey) console.log(`[workdirs] 热加载生效：${workDirs.length} 个工作区`);
  broadcastInstances(); // dirs 变化 → 前端 structKey 变 → 目录面板全量重建（免重启）
}

// ---- 启动预检（验收 A9）----
// E9：必须用本机的 claude（你日常在终端用的那个），不用 SDK 捆绑副本——
// 版本、登录态、代理兼容性都以本机为准。
const versions = { sdk: 'unknown', cli: 'unknown', server: 'unknown' };
// 服务状态可见性（第一性原理重新设计）：本进程启动时刻，模块加载时算一次、恒定不变。用于让每台设备
// 独立感知"服务是否在我不知情时重启过"（LaunchAgent 静默拉起 / 意外崩溃恢复）——见 computeServiceHealth()。
const SERVICE_STARTED_AT = Date.now();

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
  // 多 repo 台阶1：白名单 = WORK_DIR（首位）+ WORK_DIRS_FILE（JSON 数组文件，条目支持 string 或 {path,sessionLimit}），
  // 若未设 WORK_DIRS_FILE 则回退 WORK_DIRS（逗号分隔，向后兼容）。解析/校验/去重逻辑在 workdirs.js（doctor.js D3 共用）。
  // 无效项告警跳过不挡启动。只设 WORK_DIR 则 workDirs=[WORK_DIR]，前端目录切换器隐藏（退化单目录）。
  const source = readWorkdirSource();
  for (const w of applyWorkdirs(source ?? { entries: [], warnings: ['WORK_DIRS_FILE 读取/解析失败，仅用 WORK_DIR'] })) {
    console.warn(`⚠️  ${w}`);
  }
  let claudeBin = process.env.CLAUDE_BIN || '';
  if (!claudeBin) {
    claudeBin = resolveExecutableViaPath('claude'); // POSIX which / win32 where
    if (!claudeBin) {
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
  // 三段各自独立 try：任一来源失败只让自己留 unknown，不连坐其余（曾把 server 版本挂在 SDK 同块里被连坐跳过）。
  const require = createRequire(import.meta.url);
  try {
    // SDK 0.3.x 的 exports 不暴露 ./package.json（直接 require 抛 ERR_PACKAGE_PATH_NOT_EXPORTED，
    // versions.sdk 曾因此恒为 unknown）——经入口文件反查包根再读。
    versions.sdk = JSON.parse(readFileSync(join(dirname(require.resolve('@anthropic-ai/claude-agent-sdk')), 'package.json'), 'utf8')).version;
  } catch { /* 非致命 */ }
  try {
    versions.server = require('../../package.json').version;
  } catch { /* 非致命 */ }
  if (!process.env.ANTHROPIC_AUTH_TOKEN && !process.env.ANTHROPIC_API_KEY) {
    console.warn('⚠️  未检测到 ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY，将依赖 claude CLI 自身的登录态');
  }
  return claudeBin;
}
const claudeBin = preflight();
// 多 repo 台阶3：viewingInstanceId = 前端当前查看的 tab 实例（台阶2 viewingCwd 的细化）。
// 切 tab 只换视图、不 dispose（各实例后台并行存活，见 agents Map）。初值 null——启动不自动 resume，空首页手选。
let viewingInstanceId = null;
// viewingCwd = 当前查看实例的工作目录上下文（新建会话选目录 / statusline git 段 / 白名单维度）。
// 必须在 preflight 之后取（WORK_DIR 在 preflight 内才 realpathSync 规范化，否则 cwd 隔离失灵）。
let viewingCwd = WORK_DIR;
const viewingCwdOf = () => agents.get(viewingInstanceId)?.cwd ?? viewingCwd;
// BE-016：当前查看实例被移除（退出/dispose）后原子重选 viewing——落到剩余实例取其 cwd，落到空视图(null)保留
// 刚移除实例的 cwd（它是最后实际查看的），避免裸 viewingCwd 停在更早旧值致新会话选目录/statusline 跳回旧工作区。
// 调用点须在 agents.delete(退出实例) 之后调用（此时 [...agents.keys()] 已是剩余实例）。
// opts.allowCrossWorkspace：仅用户主动关 tab 为 true；进程退出 / resumeFailed 默认 false，禁止闪回其它工作区。
const reselectViewingAfter = (removedCwd, opts = {}) => {
  const r = reselectViewingTarget(
    [...agents.keys()], removedCwd, id => agents.get(id).cwd, viewingCwd, opts,
  );
  viewingInstanceId = r.viewingInstanceId;
  viewingCwd = r.viewingCwd;
  // 被移除的实例若正被镜像锁，立即清全局锁；落到另一实例后由 catchUpTick 重判
  clearMirrorOnViewChange();
};
// 白名单校验 + 缺省落 viewingCwd：cwd 维度的事件（setWorkdir/session:list/new）经此解析目标 cwd。
// 合法路径 = workdirs 白名单本身（含用户把 git worktree 路径显式写入 workdirs.json 的条目）。
const routeCwd = cwd => {
  if (isWhitelisted(cwd, workDirs)) return cwd;
  // FR-23 越界审计信号：显式传了不在白名单的路径 → 记一条检测信号，再安全回退当前查看目录。
  // 不 fail-closed：回退本身已防越权（不访问越界目录），拒绝会破坏“传错自动纠正”顺手性 + #8 热移除回退。
  if (typeof cwd === 'string' && cwd) {
    console.warn(`[scope] 越界工作目录请求被拒：${cwd} 不在白名单，回退当前查看目录`);
    // FR-19 最小审计记录（承接 Phase 4）：routeCwd 调用点分散、多数无 socket 上下文可传 actor，
    // 此处 actor 留空——目录越界信号的价值在"发生过"本身，不在于精确到哪个连接（真正的访问控制
    // 已经生效，这里只是留痕，同 §3.4.1 WorkdirScopeGuard 的既有 [scope] 日志一个粒度）。
    audit.recordAudit({ action: 'scope_violation', target: cwd, outcome: 'denied', meta: { via: 'routeCwd' } });
  }
  return viewingCwdOf();
};
// 台阶3：按实例路由（BE-001 fail-closed）——缺省（无 instanceId）落 viewingInstanceId（向后兼容缺参旧调用）；
// 显式命中 live 取该实例；显式但已关闭 → stale（id=null，绝不静默回退 viewing、绝不误投别的会话）。见 instance-routing.js。
const resolveTarget = (id, opts) => resolveInstanceTarget(id, viewingInstanceId, x => agents.has(x), opts);
const resolveInstanceId = id => resolveTarget(id).id;   // 仅取 id：显式 stale → null（不再回退 viewing），无实例的 handler 自然 no-op/echo 拨回
const routeInstance = id => { const rid = resolveInstanceId(id); return rid ? (agents.get(rid) ?? null) : null; };
// audit_record 的 actor 字段（FR-19，承接 Phase 4）：deviceId 取握手带的 deviceToken（isLocal/CF Access
// 直连场景恒无 token，null 属正常）；via 复用既有 socket.trustBasis（'device-token'/'bypass'），
// 不新造一套分类，与 SEC-03 吊销对称逻辑用的是同一份信任来源判断。
const actorFromSocket = socket => ({ deviceId: socket?.handshake?.auth?.deviceToken ?? null, via: socket?.trustBasis ?? null });

// ---- HTTP ----
const app = express();
configureHttpShell({
  app,
  projectRoot: HERE,
  isAccessEnabled,
});

const tokenMatches = provided => secureTokenMatches(AUTH_TOKEN, provided);
// 鉴权限速状态（socket + HTTP 共用，AUTH-001）。NFR-03：仅鉴权门口，重启清零可接受。
const rlStates = new Map(); // sourceKey → RateLimitState
// 有界上限。这张表由【未鉴权的公网流量】驱动：服务挂在固定域名上，任何扫描器请求一次 /health
// （成功或 401 都写）就永久占一条，而全仓只有 get/set、没有任何 delete/TTL 清扫，decayMs 到期也不回收。
// 常驻 LaunchAgent 跑数月即单调增长。仓内其他表都有明确上限（NOTIFY_THROTTLE_CAP=500、MAX_SESSIONS=200
// 等），只有这里没有。淘汰最坏只是让那个来源重新从 0 计数——与「重启即清零」的既有语义同级。
const RL_STATES_CAP = 5000;
// 写入的唯一入口（2026-08-03 F2）：cap 淘汰必须对 HTTP 与 socket 握手两条路径同时生效——
// 此前只有 createHttpAuth 的 setState 回调做淘汰，io.use 里是裸 rlStates.set，socket.io 握手
// （/socket.io/?EIO=4 polling 对扫描器同样可达）驱动的条目绕过上限，与上面「有界」的承诺矛盾。
function setRlStateCapped(key, st) {
  // Map 保持插入顺序：超限时从最早的开始淘汰（近似 FIFO，足够——限速状态本就是短时的）
  setCapped(rlStates, key, st, RL_STATES_CAP);
}
const httpAuth = createHttpAuth({
  authToken: AUTH_TOKEN,
  isPublicHost,
  verifyAccessJwt,
  // AUTH-001：HTTP 与 socket 握手共享限速 Map，堵住 /health|/metrics|/push 无限试 token。
  rateLimit: {
    // AUTH-NEW-1：与 socket `publicHost || AUTH_TOKEN` 对齐——CF Access-only（空 AUTH_TOKEN）公网 Host
    // 上的 /health|/metrics|/push JWT 失败也须限速；纯本机无 token 仍不限。
    active: (req) => !!(AUTH_TOKEN || isPublicHost(req?.headers?.host)),
    sourceKey: (req) => {
      // AUTH-002 + AUTH-NEW-2：公网 Host 且 peer=loopback（隧道）才采信 CF-Connecting-IP；
      // LAN 伪造 Host+CF-IP 只回落连接 IP，防拆限速桶。
      const publicHost = isPublicHost(req.headers?.host);
      const peer = req.socket?.remoteAddress || req.ip || '';
      return rlSourceKey(
        { address: peer, headers: req.headers || {} },
        clientIp,
        { trustCfConnectingIp: shouldTrustCfConnectingIp({ publicHost, peerAddress: peer }, clientIp) },
      );
    },
    getState: (key) => rlStates.get(key),
    setState: setRlStateCapped,
    onResult: onAuthResult,
    onLocked: (key, r) => {
      console.warn(`[http-auth] 连续鉴权失败达阈值 → 锁定 ${Math.ceil((r.retryAfterMs || 0) / 1000)}s（source=${key}）`);
      audit.recordAudit({
        actor: { deviceId: null, via: 'unauthenticated' },
        action: 'auth_rate_limited',
        target: key,
        outcome: 'locked',
        meta: { retryAfterMs: r.retryAfterMs, via: 'http' },
      });
      metrics.inc('rate_limit_lockouts');
      metrics.gauge('rate_limit_lockouts_last_ts', Date.now()); // 服务状态可见性：带时间戳，供 recentIncident 判定
    },
  },
});

// 具名提取（原 registerOperationalRoutes 内联箭头）：仅 HTTP /metrics 巡检端点消费（机器可读原料）。
// 面板 service:status ack 已判定化改造，不再带裸计数器（见 computeServiceHealth）。
const getMetricsPayload = () => {
  const counters = metrics.snapshot().counters;
  const failed = errorInstances.size;
  let awaiting = 0;
  for (const agent of agents.values()) {
    if (agent.pendingPermissions.size > 0 || agent.pendingQuestions.size > 0) awaiting += 1;
  }
  // OPS-3：StateProbe notify_failed 必须覆盖双通道——仅计 push 时，纯 ntfy 用户失败永不翻状态。
  const notifyFailed = (counters.push_failure ?? 0) + (counters.ntfy_failure ?? 0);
  const mobileClients = io.sockets.adapter.rooms.get('approved')?.size ?? 0;
  return {
    metrics: {
      activeSessions: agents.size,
      events: counters.events ?? 0,
      catchUpHits: counters.catch_up_hits ?? 0,
      catchUpReloads: counters.catch_up_reloads ?? 0,
      rateLimitLockouts: counters.rate_limit_lockouts ?? 0,
      pushSuccess: counters.push_success ?? 0,
      pushFailure: counters.push_failure ?? 0,
      ntfyFailure: counters.ntfy_failure ?? 0,
      clientErrors: counters.client_errors ?? 0,
      // CLI hooks 桥（与 catchUpHits 同属"同步管道健康"）：装了却收不到时，consumed 恒 0 一眼可辨；
      // ignored 高说明事件多来自工作区白名单外的项目（正常，不是故障）。
      hookEventsConsumed: counters.hook_events_consumed ?? 0,
      hookEventsIgnored: counters.hook_events_ignored ?? 0,
      hookPushes: counters.hook_pushes ?? 0,
    },
    state: metrics.classifyState({ failed, awaiting, notifyFailed, mobileClients }),
    states: { failed, awaiting, notifyFailed, mobileClients },
    timestamp: Date.now(),
  };
};

registerOperationalRoutes({
  app,
  httpAuth,
  getHealth: () => ({
    status: 'ok',
    sessionId: agents.get(viewingInstanceId)?.sessionId ?? null,
    busy: [...agents.values()].some(agent => agent.pendingTurns > 0),
    versions,
    buildNonce: process.env.CCM_BUILD_NONCE || null,
    timestamp: Date.now(),
  }),
  getMetrics: getMetricsPayload,
  push: {
    enabled: pushEnabled,
    publicKey: notify.vapidPublicKey,
    isValidSubscription: isValidPushSubscription,
    saveSubscription: savePushSubscription,
  },
  isDeviceTrusted,
  // 与 socket 握手侧 io.use 完全同源的 bypass 判据（CF Access 已验 / 真本机直连）。缺了它，
  // 走这两条路进来的设备因为从不进待审列表而永远无法被批准，/push/subscribe 恒 403。
  bypassDeviceApproval: req => shouldBypassDeviceApproval({
    accessEnabled: req.ccmAccessEnabled === true,
    peerAddress: req.socket?.remoteAddress || '',
    hostHeader: req.headers?.host || '',
  }, clientIp),
});

// Historical replay stays on the authenticated session:history socket event;
// the HTTP data plane intentionally exposes no unauthenticated transcript route.
const httpServer = createServer(app);
// E17：maxHttpBufferSize 默认仅 1MB，会直接拒收带附件的消息。抬到 32MB——
// 附件总量上限 20MB（解码后），base64 上线 ~1.33x ≈ 27MB + JSON 开销，32MB 留足余量。
const io = new Server(httpServer, {
  perMessageDeflate: { threshold: 1024 },
  maxHttpBufferSize: 32 * 1024 * 1024
});

// ---- 设备审批网关：socket 分组解锁/断连、待批广播、trusted-devices.json CLI 审批监听 ----
// 机制下沉 src/auth/device-gate.js；unlockSocket（重放 init/models/statusline 初始态）
// 耦合组装根状态（lastInit/viewing*/replay*），留在本文件、经回调注入。
const deviceGate = createDeviceGate({ io, dataDir: DATA_DIR, onUnlockSocket: (socket) => unlockSocket(socket) });
const { unlockDeviceSockets, disconnectDeviceSockets, pendingDevicesPayload, broadcastPendingDevices } = deviceGate;

function unlockSocket(socket) {
  if (socket.deviceApproved) return; // 已经批准了
  socket.deviceApproved = true;
  socket.trustBasis = 'device-token'; // SEC-03：待审批→批准走的就是设备信任表，受该表控制（吊销须能断连）
  socket.join('approved'); // SEC-01：批准后补入下行隔离房间，同 io.on('connection') 分支的即时批准路径
  // 未读角标：不在此 capture——批准另一台设备 ≠ 当前会话「重新进入查看」。
  // capture 会并入/清零活计数；若 viewing 会话已有未 ack 快照，新设备 join 不应触发多余状态机跳变。
  // 真正进入查看仍走 setViewing / session:switch / 本 socket 首次 connect 路径。

  const deviceToken = socket.handshake.auth?.deviceToken;
  socket.emit('agent:event', {
    seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
    type: 'device_status', payload: { status: 'approved', deviceId: deviceToken }
  });

  // 无缝补发跳过的初始数据重放，使用户不需要刷新页面即可直入聊天界面
  if (lastInit) {
    const va = agents.get(viewingInstanceId);
    // #5：全局 lastInit 的 slashCommands 可能来自别 cwd（含 project skill）→ 先剥离，再按 viewing cwd 注入 per-cwd 缓存
    // （有缓存才注入；无则省略字段，前端保留 localStorage，真 init 到达即校正）
    const { slashCommands: _omitCmds, ...initBase } = lastInit;
    const replayCwd = va?.cwd ?? viewingCwd;
    const replayCmds = resolveSlashCommandsForCwd(slashCommandsCache, replayCwd, lastInit);
    socket.emit('agent:event', {
      seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
      type: 'init', payload: {
        ...initBase,
        permissionMode: permModeOf(viewingInstanceId),
        // model/cwd 校正到当前查看 tab：va 存在用实例值（FRESH 实例 activeModel 为空则 null，不回退 lastInit）；
        // va 为空（空首页）model 不下发=null（新会话模型=env 默认、服务端不可知，前端显「不指定」，A1）、cwd 用 viewingCwd
        ...(va ? { model: va.activeModel ?? null, cwd: va.cwd }
              : { model: null, cwd: viewingCwd }),
        ...(replayCmds ? { slashCommands: replayCmds } : {}),
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
  replayStatusLineTo(socket);
  permModeTo(socket);
  effortTo(socket);
  instancesTo(socket);
  scheduleStatusRefresh();
}

// workdirs.json 热加载监听（仅 WORK_DIRS_FILE 模式；逗号串 WORK_DIRS 无文件可 watch）。
// 与 trusted-devices 直接 watch 文件不同：workdirs.json 由人用编辑器改，VS Code/vim 默认原子写(rename 换 inode)
// 会让对旧 inode 的 watch 永久失聪 → 改为 watch 其目录并过滤 basename（对子文件替换免疫）。300ms 防抖。
if (process.env.WORK_DIRS_FILE) {
  const wf = resolveWorkdirsFilePath(process.env.WORK_DIRS_FILE, HERE);
  const wbase = basename(wf);
  let wtimer = null;
  // mtime 前置守卫：相对路径时 dirname(wf) 可能是整个项目根，且部分平台(Linux/网络 FS)不提供 filename→basename 过滤失效。
  // 每次事件比对 workdirs 文件 mtime，未变即跳过——消除根目录无关文件变动（如 dev 期编辑器 swap）引发的重载风暴。
  let lastWorkdirsMtime = 0;
  try { lastWorkdirsMtime = statSync(wf).mtimeMs; } catch { /* 文件暂不存在，首次变更时再取 */ }
  try {
    watch(dirname(wf), (_evt, filename) => {
      if (filename && filename !== wbase) return; // 有 filename 时直接按 basename 过滤
      let m;
      try { m = statSync(wf).mtimeMs; } catch { return; } // 文件不存在/不可读 → 跳过（保留旧白名单）
      if (m === lastWorkdirsMtime) return;               // mtime 未变 = 非本文件变动，忽略
      lastWorkdirsMtime = m;
      clearTimeout(wtimer);
      wtimer = setTimeout(reloadWorkdirs, 300);
    });
  } catch (err) {
    console.error('[workdirs] 无法监视 workdirs 文件所在目录:', err.message);
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
        // F2（code-review #5）：回车批准的是「Enter 那刻的最新」待审设备——若你看提示到按回车之间又来了新设备，
        // 批准的可能已不是你以为的那个。这里若尚有其他待审设备就告警，让你察觉可能的竞态、必要时 deny 复核。
        const others = getPendingDevices().filter(d => d.deviceToken !== latest).length;
        if (others > 0) {
          console.log(`   ⚠️ 另有 ${others} 个待审设备未处理——请确认刚批准的正是你想放行的那台（如有疑虑，运行 node scripts/device.js deny "${latest}" 撤销）`);
        }
        if (approveDevice(latest)) {
          unlockDeviceSockets(latest);
          broadcastPendingDevices();
        } else {
          console.error(`   ❌ 批准 ${latest} 落盘失败、未生效，请检查服务端磁盘后重试`); // BE-011：不静默当成功
        }
      }
    } else if (text === 'deny') {
      if (latest) {
        console.log(`\n[TTY] 收到 deny！拒绝并移除最新设备: ${latest}`);
        const denied = denyDevice(latest);
        disconnectDeviceSockets(latest); // 断连照做（纵深防御）
        broadcastPendingDevices();
        if (!denied) console.error(`   ❌ 吊销 ${latest} 落盘失败、可能未生效（设备重连会复活），请检查服务端磁盘后重试`); // BE-011
      } else {
        console.log('\n[TTY] 当前没有等待审批的设备。');
      }
    }
  });
}

// 鉴权门口防暴破限速（NFR-03 / docs/design.md）：仅当配了鉴权门（公网 CF Access 或 AUTH_TOKEN）时生效——
// 无鉴权模式(!AUTH_TOKEN 且非公网) authPassed 恒真、永不计失败，天然不触发。
// AUTH-002：CF-Connecting-IP 仅公网 Host 采信；LAN 只认连接 IP（防伪造头拆分限速桶）。
// 状态内存态 Map（与 HTTP createHttpAuth 共用 rlStates；重启清零 = 机主误锁时的逃生口）。
// ---- 鉴权（公网 Host 强制 Access JWT、fail-closed；LAN/本机回退 token；无 token 时仅 localhost）----
io.use(async (socket, next) => {
  const ip = clientIp(socket.handshake.address);
  const publicHost = isPublicHost(socket.handshake.headers.host);
  const rlActive = publicHost || !!AUTH_TOKEN;
  // AUTH-NEW-2：与 HTTP sourceKey 同判据——Host spoof 从 LAN 直连时不信 CF-IP
  const rlKey = rlSourceKey(socket.handshake, clientIp, {
    trustCfConnectingIp: shouldTrustCfConnectingIp({
      publicHost,
      peerAddress: socket.handshake.address,
    }, clientIp),
  });
  try {
    // 限速锁定门：退避/锁定期内直接拒、不做鉴权、不计数（避免攻击者持续戳把机主越锁越久 = 自我 DoS）
    if (rlActive) {
      const st = rlStates.get(rlKey) || freshState();
      const now = Date.now();
      if (now < st.lockUntil) {
        console.warn(`[conn] ${ip} 鉴权限速中，拒握手（retryAfter≈${Math.ceil((st.lockUntil - now) / 1000)}s，source=${rlKey}）`);
        return next(new Error('rate_limited'));
      }
    }

    let authPassed = false;
    let accessEnabled = false;

    if (publicHost) {
      try {
        await verifyAccessJwt(socket.handshake.headers['cf-access-jwt-assertion']);
        authPassed = true;
        accessEnabled = true;
      } catch {
        authPassed = false; // 公网 JWT 校验失败 → 落入统一限速计数 + fail-closed
      }
    } else if (!AUTH_TOKEN) {
      authPassed = true;
    } else if (tokenMatches(socket.handshake.auth?.token)) {
      authPassed = true;
    }

    // 限速计数：成功清零、失败退避/锁定（docs/design.md onAuthResult）
    if (rlActive) {
      const st = rlStates.get(rlKey) || freshState();
      const r = onAuthResult(st, authPassed, Date.now());
      setRlStateCapped(rlKey, r.next); // F2：握手路径同样过 cap，不给扫描器绕出无界增长
      if (!authPassed && r.verdict === 'locked') {
        console.warn(`[conn] ${ip} 连续鉴权失败达阈值 → 锁定 ${Math.ceil(r.retryAfterMs / 1000)}s（source=${rlKey}）`);
        // FR-19 最小审计记录：只在"达阈值锁定"这个粒度写（本就限速到每锁定窗口一次），不逐次失败尝试都写——
        // 后者本身可被攻击者刷出高频事件、会把环形上限里的真实信号挤掉，锁定事件已足够代表"发生过暴破尝试"。
        audit.recordAudit({ actor: { deviceId: null, via: 'unauthenticated' }, action: 'auth_rate_limited', target: rlKey, outcome: 'locked', meta: { retryAfterMs: r.retryAfterMs } });
        metrics.inc('rate_limit_lockouts'); // NFR-15 限速触发数（与审计同粒度：每锁定窗口一次）
        metrics.gauge('rate_limit_lockouts_last_ts', Date.now()); // 服务状态可见性：带时间戳，供 recentIncident 判定
      }
    }

    if (!authPassed) {
      const got = socket.handshake.auth?.token;
      console.warn(`[conn] ${ip} 握手鉴权失败（token ${got ? '不匹配' : '缺失'}）`);
      return next(new Error('unauthorized'));
    }

    // 鉴权通过后，执行设备审批过滤（纵深防御）
    // 反代 loopback：peer=127.0.0.1 但 Host 公网 → 仍须 deviceToken（见 shouldBypassDeviceApproval）
    const bypassDevice = shouldBypassDeviceApproval({
      accessEnabled,
      peerAddress: socket.handshake.address,
      hostHeader: socket.handshake.headers.host,
    }, clientIp);
    if (bypassDevice) {
      socket.deviceApproved = true;
      socket.trustBasis = 'bypass'; // SEC-03：真本机/CF Access 直接批准，不受 trusted-devices.json 信任表控制——
                                     // CLI 吊销某 deviceToken 时绝不能因此误断这类连接（它们与该表无关）
    } else {
      const deviceToken = socket.handshake.auth?.deviceToken;
      if (isDeviceTrusted(deviceToken)) {
        socket.deviceApproved = true;
        socket.trustBasis = 'device-token'; // SEC-03：受信任表控制——CLI 从表中移除该 token 时须检测并断连（见文件监听器）
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
          console.log(`   -> 或输入【deny】拒绝并移除该设备（非拉黑：denyDevice 只是移出待审/信任列表，同一 token 之后仍可重新申请）`);
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
const instanceManager = createInstanceManager();
const agents = instanceManager.agents;
const permModeByInstance = instanceManager.permissionModes;
const effortByInstance = instanceManager.efforts;
const doneInstances = instanceManager.done;
const errorInstances = instanceManager.errors;
const abortedInstances = instanceManager.aborted;
const unreadCounts = instanceManager.unreadCounts;
const unreadSnapshotOnEntry = instanceManager.unreadSnapshotOnEntry;
const lastCountedTopLevelMessageId = instanceManager.lastCountedTopLevelMessageId;
const captureUnreadSnapshot = instanceManager.captureUnreadSnapshot;
const newInstanceId = instanceManager.nextId;
const permModeOf = instanceManager.permissionModeOf;
const effortOf = instanceManager.effortOf;
const inheritedEffort = instanceManager.inheritedEffort;
const instanceForSession = instanceManager.forSession;
const instanceState = instanceManager.stateOf;
// 新会话预设档（pending = L0）：session:new / 空 cwd 后 viewingInstanceId=null（懒创建无实例），
// 此空窗期切档无实例可作用——按 cwd 暂存，待首条消息 openInstance FRESH 懒开时消费。
// 权威源：L0 pending > L3 CLI settings（cliDefaultsByCwd / resolveSettings）> L4 硬默认；
// resume 走会话数据(L2)，不读本 pending/cliDefaults。effort 的 null（模型默认）合法 → Map.has 判存在。
const pendingModeByCwd = new Map();           // cwd → 待应用权限档（新会话懒创建期，L0）
const pendingEffortByCwd = new Map();         // cwd → 待应用思考强度档（同上；null 合法）
// L3：按 cwd 缓存的 CLI settings 默认（resolveSettings 合并 user/project/local）。失败不缓存以便重试。
const cliDefaultsByCwd = new Map();           // cwd → { mode, effort, model, env }
const cliDefaultsInflight = new Map();        // cwd → Promise（并发去重）
// 台阶3 Step B 角标：doneInstances = 后台（≠viewingInstanceId）完成但未查看的实例 latch
// （后台轮次 result 置位；该实例新活动 init/审批 或被切为 viewingInstanceId 时清）。instanceState 由实例
// 在途态 + latch 推导（无实例=idle）；broadcastInstances 在轮次/审批边界推送，前端据此渲染 tab 栏角标 + 通知。
const STATE_BOUNDARY = new Set(['init', 'result', 'error', 'permission_request', 'question', 'request_resolved', 'tool_use', 'task_notification', 'system']);
const BG_TYPE_TO_TOOL = { local_agent: 'Agent', local_bash: 'Bash' }; // 后台任务类型 → 前端 TOOL_BADGE 键（🤖 Agent / 🖥 Bash）；未知类型 → null → ⏳
// "等我"跨会话聚合（AD-11/§3.2.5 AttentionDeriver，承接 FR-21/FR-22）：跨全部 live 实例（不限 viewingCwd）
// 投影 needsYou。数据源=运行时 agents（读模型投影，非新数据源，EP-1）：
//   ①审批维度——每个 live 实例的 pendingPermissions（已有 createdAt/expiresAt，承接审批 TTL 阶段），
//     此处过滤 now<=expiresAt（deriveAttention 契约要求调用方先过滤，保持纯函数不依赖 Date.now()）；
//   ②输入维度——pendingQuestions（本次新增 createdAt），仅当该实例无 pendingPermissions 时计入
//     awaiting_input（镜像 StatusDeriver 优先级：审批 > 输入，与 instanceState() 的 'permission' 判定一致）。
// 边界（继承 AD-3，如实登记）：纯终端会话的等待态不经此路径可见——本函数只覆盖 web 后端驱动的 live 实例。
function computeNeedsYou() {
  const sessionViews = [];
  const pendingApprovals = [];
  const instanceIdBySessionId = new Map();
  const now = Date.now();
  for (const [instanceId, a] of agents) {
    if (a.sessionId) instanceIdBySessionId.set(a.sessionId, instanceId);
    const title = sessions.getSession(a.sessionId)?.title ?? null;
    const lastActiveAt = sessions.getSession(a.sessionId)?.lastUsedAt ?? 0;
    let status; let awaitingSince;
    if (a.pendingPermissions.size > 0) {
      for (const [requestId, p] of a.pendingPermissions) {
        if (now > p.expiresAt) continue; // 已过期：不计入聚合（fail-closed 语义下过期即失效，见审批 TTL 阶段）
        pendingApprovals.push({ sessionId: a.sessionId, cwd: a.cwd, title, requestId, createdAt: p.createdAt, toolName: p.name });
      }
    } else if (a.pendingQuestions.size > 0) {
      // AG-NEW-003：与 permissions 对称过滤 expiresAt（timer 已删 Map 时此窗极短，仍防 residual）
      let hasLiveQuestion = false;
      for (const [, q] of a.pendingQuestions) {
        if (typeof q.expiresAt === 'number' && now > q.expiresAt) continue;
        hasLiveQuestion = true;
        if (awaitingSince === undefined || q.createdAt < awaitingSince) awaitingSince = q.createdAt;
      }
      if (hasLiveQuestion) status = 'awaiting_input';
    }
    sessionViews.push({ sessionId: a.sessionId, cwd: a.cwd, title, lastActiveAt, status, awaitingSince });
  }
  const { needsYou } = deriveAttention(sessionViews, pendingApprovals);
  // instanceId 是纯函数契约之外的接线专用字段（前端深链需要，复用 FR-14 applyDeepLink({instanceId,sessionId,cwd})）。
  return needsYou.map(item => ({ ...item, instanceId: instanceIdBySessionId.get(item.sessionId) ?? null }));
}
// 服务状态可见性（NFR-15/可维护性，与上面 computeNeedsYou 的 FR-21/注意力不对称是不同的轴，不混入其判定）：
// "ccm 这个服务本身有没有出过岔子"——判定化信号，全部带时效窗自动退场（不做不衰减的常驻布尔）：
// 推送投递健康（recentDeliveryFailure）+ 服务启动时刻（供前端与本地基线比对判定重启）+ 登录限速锁定
// （=有人在暴力尝试入口，安全信号）+ 前端错误（=界面自身坏了，详情在日志面板）。
// 刻意不接 classifyState()：那是 /metrics 外部消费的粗分类，failed/awaiting 已被会话 ❗ 角标/需要你(N) 覆盖，
// mobile_offline 对正在看 UI 的设备是自指悖论——原样接入会制造重复信号，见方案 Context。
function computeServiceHealth() {
  const g = metrics.snapshot().gauges;
  const c = metrics.snapshot().counters;
  const now = Date.now();
  const failure = metrics.recentDeliveryFailure({
    pushFailureAt: g.push_failure_last_ts, ntfyFailureAt: g.ntfy_failure_last_ts, now
  });
  const lockout = metrics.recentIncident({ at: g.rate_limit_lockouts_last_ts, now });
  const clientError = metrics.recentIncident({ at: g.client_errors_last_ts, now });
  return {
    startedAt: SERVICE_STARTED_AT,
    deliveryFailure: failure
      ? { ...failure, count: (failure.channel === 'ntfy' ? c.ntfy_failure : c.push_failure) ?? 0 }
      : null,
    rateLimitLockout: lockout ? { ...lockout, count: c.rate_limit_lockouts ?? 0 } : null,
    clientError: clientError ? { ...clientError, count: c.client_errors ?? 0 } : null,
    // hooks 桥安装态：前端据此在设置面板显示开关、在只读镜像页提示未装。缓存读盘结果——
    // 这个值只在用户装/卸时变，而 instances 广播很频繁。
    hooksBridge: { state: hooksInstallState, off: process.env.CLI_HOOKS_BRIDGE === 'off' },
  };
}

// 安装态缓存：启动时读一次，装/卸后由 refreshHooksInstallState 主动刷新。
let hooksInstallState = 'unknown';
function refreshHooksInstallState() {
  hooksInstallState = readHooksInstallState();
  return hooksInstallState;
}
// approved 房间里的实际 Socket 对象（非仅 id/size）：喂给 hasForegroundApprovedClient 判定"前台可见"，
// 而不只是"连着"。两处复用：onEvent 的 result 完成通知 hasClients 计算 + client:presence 的"跳变检测"
// （PWA 后台运行中提示）——抽成 helper 防同一段"room ids → 映射真实 socket → 过滤 undefined"逻辑抄两遍走样。
function approvedSocketObjects() {
  const ids = io.sockets.adapter.rooms.get('approved');
  return ids ? [...ids].map(sid => io.sockets.sockets.get(sid)).filter(Boolean) : [];
}
function instancesPayload() {
  const list = [];
  for (const [id, a] of agents) {
    const state = instanceState(id);
    list.push({
      instanceId: id, cwd: a.cwd, sessionId: a.sessionId,
      title: sessions.getSession(a.sessionId)?.title ?? null, state,
      // busy 时携带当前活跃工具信息，供后台 tab 角标细化（🤖 Agent / 🖥 Bash / ⏳ 其他）。
      // 前台轮（pendingTurns>0）优先真实 lastToolName；纯后台任务用 task_type 映射 → 前端 TOOL_BADGE 出 🤖/🖥，未知→null→⏳。
      activeTool: state === 'busy'
        ? (a.pendingTurns > 0 ? (a.lastToolName || null) : (BG_TYPE_TO_TOOL[a.bgTaskSummary?.()?.taskType] || null))
        : null,
      // 是否有活的后台任务（≠ busy：前台轮 busy 但无后台任务时为 false）——前端据此收敛进度横幅可见性：
      // 当前查看实例 bgActive=false 即隐藏横幅，统一覆盖「切会话/TTL 清/完成/前台轮残留」所有隐藏场景（权威状态驱动，非零散事件）。
      bgActive: a.hasBgTasks?.() || false,
      // 排队已移除（2026-07-30）：有在途轮就不收新消息，前端据此禁发送按钮 + 出「运行中」提示。
      // 判据刻意只认在途轮而非 isBusy()——后台任务挂着时仍可发送，否则长任务会让人永远发不出字。
      turnRunning: a.pendingTurns > 0,
      // 切 tab 面板同步：携带各实例当前档，前端 setInstances 据此静默刷新顶部 permMode/effort/model select。
      // transcriptModel：resume 冷读的会话末条 assistant 模型（纯展示回落，填 init 未到的空窗；
      // 不入 activeModel/defaultModel、不参与 setModel 差分）。
      permissionMode: permModeOf(id), effort: effortOf(id), model: a.activeModel || a.reportedModel || a.transcriptModel || null,
      unreadCount: unreadCounts.get(id) || 0, // 未读角标活计数（预留会话列表徽标用；聊天页内胶囊走 sync:since ack 的 unreadOnEntry 冻结快照）
    });
  }
  const payload = { viewingInstanceId, viewingCwd: viewingCwdOf(), dirs: workDirs, instances: list, devMode: DEV_MODE, needsYou: computeNeedsYou(), service: computeServiceHealth() };
  // 当前 cwd 的「CLI 默认模型」（scout / fresh 首 init 探得，非推断——A1 删的是旧的推断字段，此为实测值）：
  // 供新会话/无记录续接在 init 前显真实默认名而非笼统「沿用当前」（前端只改标签、发送仍不带 --model）。
  // 无条件下发（每次 cwd/视图切换均随 broadcastInstances 按 viewingCwd 归键，防跨区泄漏；查看真实 resumed
  // 实例时也带，覆盖无记录续接显示）；未探到→null，前端回落「沿用当前」。
  payload.defaultModel = defaultModelByCwd.get(viewingCwdOf()) ?? null;
  // 空首页（viewingInstanceId 为空、无 live 实例）另下发「下一条新会话(FRESH)将用的」权限/思考强度档
  // （L0 pending > L3 CLI settings > L4 硬默认），修「空首页残留上个会话档」+ 与终端 settings 对齐。
  if (!viewingInstanceId) {
    const cwd = viewingCwdOf();
    const fresh = resolveFreshPrefs({
      hasPendingMode: pendingModeByCwd.has(cwd),
      pendingMode: pendingModeByCwd.get(cwd),
      hasPendingEffort: pendingEffortByCwd.has(cwd),
      pendingEffort: pendingEffortByCwd.get(cwd),
      cliDefaults: cliDefaultsByCwd.get(cwd) || null,
    });
    payload.defaultPermissionMode = fresh.mode;
    payload.defaultEffort = fresh.effort;
  }
  return payload;
}

// worktree 网关隔离的 IO 层：定位 canonical repo root 并补读它的 settings，算出「要中和哪些网关键」。
// 为什么需要：CLI 2.1.211+ 在 linked worktree 里把 local settings source 解析到 canonical repo root，
// 主 checkout 的 .claude/settings.local.json 的 env 块会污染所有 worktree 的会话（2026-07-30 实证复现：
// third-party 的会话打到主 checkout 配的第三方网关 → 503）。判定与中和规则见 buildWorktreeGatewayEnv。
// 非 linked worktree（.git 是目录）直接返回空结果——不给普通工作区平添一次 resolveSettings。
//
// 返回 `{ env, settled }` 而非光秃秃的 env：settled=false 表示「这次判不出来」（IO 失败），
// 与 settled=true + env=undefined 的「判定为无需隔离」是两回事。调用方据此决定要不要动磁盘上的
// 隔离文件——把前者误当后者，会在一次瞬时失败里删掉仍有效的中和文件，见 decideWorktreeSettingsAction。
async function resolveWorktreeGatewayEnv(cwd, worktreeEnv) {
  let canonicalRoot = null;
  try {
    const dotGit = join(cwd, '.git');
    if (statSync(dotGit).isFile()) canonicalRoot = parseWorktreeCanonicalRoot(readFileSync(dotGit, 'utf8'));
  } catch (err) {
    // ENOENT/ENOTDIR = 没有 .git（非 git 仓）或父路径不是目录：绝大多数工作区的正常形态，
    // 是确定的「不是 worktree」，settled 照常为真。
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return { env: undefined, settled: true };
    // 其余（EACCES/EIO…）= .git 在却读不到，worktree 判定被整个跳过、隔离静默失效——这才是
    // 「本该生效却没生效」的分支，既要留痕也不能让调用方据此清文件。
    console.warn(`[cli-settings] 读取 ${cwd}/.git 失败，本次跳过 worktree 网关判定:`, err?.message || err);
    return { env: undefined, settled: false };
  }
  if (!canonicalRoot || canonicalRoot === cwd) return { env: undefined, settled: true };
  // canonical 的 settings **每次实时读，绝不复用 cliDefaultsByCwd 的缓存**：它是污染源，必须准确。
  // 曾为省这一次调用而复用缓存，结果引入一整类静默失效——缓存里的 env 若为空/过期，
  // buildWorktreeGatewayEnv(worktreeEnv, undefined) 会返回 undefined，隔离静默不生效且零日志。
  // 实测这次调用仅 ~2ms（远小于 CLI_DEFAULTS_RESUME_BUDGET_MS=1200ms），省它换正确性风险不划算。
  try {
    const canon = await sdkResolveSettings({ cwd: canonicalRoot, settingSources: ['user', 'project', 'local'] });
    const canonEnv = defaultsFromEffectiveSettings(canon?.effective).env;
    const gatewayEnv = buildWorktreeGatewayEnv(worktreeEnv, canonEnv);
    // canonical 干净时算不出中和块是**正常**的（没东西要中和）。此前这里一律 warn，等于每开一次
    // 会话就刷一条假告警（2026-08-01 实测：canonical 的 env 块清空后就一直在报）。
    // 下面这条是**哨兵**，按当前实现不可达——countNeutralizableGatewayKeys 与 buildWorktreeGatewayEnv
    // 共用 shouldNeutralizeEnvKey，polluting>0 必然产出非空中和块（等价性由
    // cli-settings-defaults.test.mjs「判据一致」一例锁住）。留着是为了那条等价性哪天被改断时能出声，
    // 而不是靠人重新读一遍两个函数。真正的失效路径是本函数的两个 settled=false 分支，那里各有日志。
    const polluting = countNeutralizableGatewayKeys(canonEnv);
    if (!gatewayEnv && polluting) {
      console.warn(`[cli-settings] worktree ${cwd} 的 canonical 有 ${polluting} 个网关键却未产出中和块`
        + `（canonical=${canonicalRoot}）——该 worktree 的会话将不做网关隔离，可能被主 checkout 的网关污染`);
    }
    return { env: gatewayEnv, settled: true };
  } catch (err) {
    // 读不到 canonical settings：本次判不出来，绝不因此拖垮开实例，也绝不让调用方据此清掉
    // 上一次算对的隔离文件——settled=false 就是这个意思。
    console.warn(`[cli-settings] canonical root 读取失败 (${canonicalRoot}):`, err?.message || err);
    return { env: undefined, settled: false };
  }
}

// 网关隔离的下发载体：0600 settings 文件。
// 为什么不内联对象：SDK 会把 options.settings 的对象形式 JSON.stringify 成 `--settings <json>` 拼进
// 子进程 argv（实测 ps -ax 可读到明文），而这个块可能含 worktree 自配的 ANTHROPIC_AUTH_TOKEN。
// SDK 的 Options.settings 同时接受「settings 文件路径」，改用它把暴露面收回到文件权限位。
// 按 cwd + ultracode 归键：每工作区最多两个文件、总数随 workdirs 有界，每次开实例覆盖写
// （settings 变更由 ensureCliDefaults 的 force 刷新带出）。
const WORKTREE_SETTINGS_DIR = join(DATA_DIR, 'worktree-settings');
const worktreeSettingsKeyFor = (cwd) => createHash('sha256').update(cwd).digest('hex').slice(0, 16);

// 入参是 cliDefaultsByCwd 的整条记录而非光秃秃的 gatewayEnv：三态判断（write/prune/skip）交给
// decideWorktreeSettingsAction 这个纯函数，它有单测锁着——尤其是「判定失败必须 skip 而非 prune」
// 那条，靠可选链隐式表达时曾在 review 里被抓出会误删有效隔离文件。
function worktreeSettingsFileFor(cwd, defaults, ultracode = false) {
  const action = decideWorktreeSettingsAction(defaults);
  if (action === 'skip') return undefined;
  // 该 cwd 已无需隔离：把旧文件删干净。此前这里只 return，一份含明文 ANTHROPIC_AUTH_TOKEN 的快照
  // 会在 worktree 撤掉网关配置后永久躺在磁盘上，没有任何东西再清理它（2026-08-01 实测残留）。
  // 两档一起清（plain + -uc）——隔离既然不需要，两个档都不该留；写分支则不碰另一档，那是并存的另一档。
  // 已 spawn 的会话在子进程启动时就读完了文件，事后删除不影响它；新会话此时本就不传 settings。
  if (action === 'prune') {
    for (const suffix of ['', '-uc']) {
      try {
        unlinkSync(join(WORKTREE_SETTINGS_DIR, `${worktreeSettingsKeyFor(cwd)}${suffix}.json`));
      } catch (err) {
        // ENOENT = 本来就没有，已达终态。其余（EACCES/EPERM/EBUSY…）意味着含明文 token 的快照
        // 删不掉却无人知晓——与上面 .git 那条同一口径：留痕，别把失败伪装成成功。
        if (err?.code !== 'ENOENT') {
          console.warn(`[cli-settings] 清理 ${cwd} 的旧 worktree settings 失败（明文快照可能仍在磁盘上）:`, err?.message || err);
        }
      }
    }
    return undefined;
  }
  try {
    mkdirSync(WORKTREE_SETTINGS_DIR, { recursive: true });
    const key = worktreeSettingsKeyFor(cwd) + (ultracode ? '-uc' : '');
    const path = join(WORKTREE_SETTINGS_DIR, `${key}.json`);
    writeOwnerOnlyFile(path, JSON.stringify({ ...(ultracode ? { ultracode: true } : {}), env: defaults.gatewayEnv }));
    return path;
  } catch (err) {
    // 写不成就放弃本次隔离（退回未修复行为），绝不改用会泄漏进 argv 的内联对象兜底
    console.warn('[cli-settings] worktree settings 文件写入失败，本次放弃网关隔离:', err?.message || err);
    return undefined;
  }
}

// L3：解析 cwd 的 CLI settings 默认并缓存。force 时强制重读（session:new 后拾取磁盘变更）。
// 不 spawn CLI；与 AgentSession 的 settingSources 一致。失败返回 L4 形状且不写入缓存。
async function ensureCliDefaults(cwd, { force = false } = {}) {
  if (!cwd) return { mode: 'default', effort: null, model: undefined };
  if (!force && cliDefaultsByCwd.has(cwd)) return cliDefaultsByCwd.get(cwd);
  if (!force && cliDefaultsInflight.has(cwd)) return cliDefaultsInflight.get(cwd);
  if (force) cliDefaultsInflight.delete(cwd); // 允许与进行中的非 force 请求并行；结果以本次 force 为准写入
  const p = (async () => {
    try {
      const resolved = await sdkResolveSettings({
        cwd,
        settingSources: ['user', 'project', 'local'],
      });
      const d = defaultsFromEffectiveSettings(resolved?.effective);
      // settled 必须一并落缓存：本函数的 catch 只兜得住「worktree 自己的 settings 读失败」，
      // canonical 侧的失败在 resolveWorktreeGatewayEnv 内部就被吞了、照样会走到这里写缓存，
      // 只有 settled 能让下游区分「已判定无需隔离」与「这次没判出来」。
      const gw = await resolveWorktreeGatewayEnv(cwd, d.env);
      d.gatewayEnv = gw.env;
      d.gatewayEnvSettled = gw.settled;
      cliDefaultsByCwd.set(cwd, d);
      return d;
    } catch (err) {
      console.warn(`[cli-settings] resolveSettings 失败 (${cwd}):`, err?.message || err);
      return { mode: 'default', effort: null, model: undefined, env: undefined };
    } finally {
      if (cliDefaultsInflight.get(cwd) === p) cliDefaultsInflight.delete(cwd);
    }
  })();
  cliDefaultsInflight.set(cwd, p);
  return p;
}
function broadcastInstances() { // 多设备同步 tab 栏（当前查看 tab + 各实例角标状态，合成事件惯例）
  // 与 viewing 对齐：当前查看实例豁免空闲回收（用户读历史时 lastActivity 不会因 SDK 刷新）。
  // 放在每次 broadcast 前扫一遍——viewing 变更路径多（switch/setViewing/reselect/lazy open），
  // 统一在此收敛比在每个赋值点手写 setViewed 更不易漏。
  for (const [id, a] of agents) {
    a.setViewed?.(id === viewingInstanceId);
  }
  io.to('approved').emit('agent:event', { // SEC-01：仅广播给已批准设备
    // SRV-NEW-006：信封 cwd 与 payload.viewingCwd 同源（viewingCwdOf），避免 dispose/reselect 窗内裸 viewingCwd 漂移
    seq: 0, epoch: 'server', sessionId: null, instanceId: viewingInstanceId, cwd: viewingCwdOf(), ts: Date.now(),
    type: 'instances', payload: instancesPayload()
  });
}
// 后台任务集合变化 → 会话列表 ⏳ 重算的 500ms 合并节流：agent 侧 onBgTaskChange 只在"空↔非空/成员增删"时回调（稳态高频心跳不触发），
// 这里再合并同一 tick 内的多次变化（TTL 批量清 + 新任务同时到）成一次 broadcastInstances，避免重复全量广播。单飞：已排期则忽略。
// 顺带对【当前查看】实例补推 task_progress 全量快照：instances 只带 bgActive 布尔、横幅明细靠 transient，
// 集合变化后若前端横幅被误藏/未建，靠这次快照复亮（与 sync:since 切入补推同契约）。
let bgBroadcastTimer = null;
function scheduleBgBroadcast() {
  if (bgBroadcastTimer) return;
  bgBroadcastTimer = setTimeout(() => {
    bgBroadcastTimer = null;
    broadcastInstances();
    const a = agents.get(viewingInstanceId);
    if (a?.hasBgTasks?.()) a.emitBgTasksSnapshot();
  }, 500);
}

// 只读「追平」：web 端续接「正在终端 CLI 里跑」的会话时，另起的 resume 进程无法 attach 终端活进程，
const statusBridgeOff = process.env.CLI_STATUSLINE_BRIDGE === 'off'; // 紧急回滚：恢复旧 SDK-only statusline
// CLI statusline 快照读取器：statusline 路由与镜像引擎的 CLI 观察态合并共用同一份。
function readCliSnapshotForSession(sessionId, cwd) {
  const options = { cwd };
  if (process.env.CLI_STATUSLINE_DIR) options.dir = process.env.CLI_STATUSLINE_DIR;
  return readCliStatusSnapshot(sessionId, options);
}

// 只读镜像 / catchUp 追平引擎：15 个状态与整套编排已归 src/server/mirror-engine.js 所有，
// 此处只做装配。注入面即本引擎与 app.js 的全部耦合点。
const mirrorEngine = createMirrorEngine({
  io,
  agents,
  instanceState,
  getViewingInstanceId: () => viewingInstanceId,
  viewingCwdOf,
  serviceStartedAt: SERVICE_STARTED_AT,
  scheduleStatusRefresh,            // hoisted function，声明在下方、此处取值安全
  readCliSnapshotForSession,
  statusBridgeOff,
});
const { catchUpTick, mirrorOwnedBy, clearMirrorOnViewChange } = mirrorEngine;
mirrorEngine.start();

// ── CLI hooks 投递箱（终端直跑会话的即时信号）──────────────────────────────────────
// 用户在电脑终端里直接跑 claude 时，ccm 此前只能靠上面这个 2.5s 轮询发现变化。装了 hooks 桥后
// CLI 会在回合结束（Stop）/ 等你回应（Notification）时主动落一个事件文件，这里监听并即时反应。
// 定位是**加速器不是新事实源**：轮询照旧跑，watch 失效只是退回原延迟，功能不缺。
let hooksNotifyThrottleState = new Map();
function processHookEvents(events) {
  const viewing = viewingInstanceId ? agents.get(viewingInstanceId) : null;
  const decision = decideHookEventActions(events, {
    viewingSessionId: viewing?.sessionId ?? null,
    viewingCwd: viewing?.cwd ?? null,
    workDirs,
    hasForegroundClient: hasForegroundApprovedClient(approvedSocketObjects()),
    now: Date.now(),
    throttleState: hooksNotifyThrottleState,
    throttleMs: notifyThrottleMs,
  });
  hooksNotifyThrottleState = decision.nextThrottleState;
  metrics.inc('hook_events_consumed', events.length);
  if (decision.ignored) metrics.inc('hook_events_ignored', decision.ignored);
  for (const cwd of decision.invalidateCwds) invalidateListCache(cwd);
  if (decision.catchUp) catchUpTick().catch(() => {}); // 单飞已防叠；插队一次，不动轮询节奏
  for (const push of decision.pushes) {
    // 深链只在该会话恰好有 live 实例时给得出（纯外部终端会话没有 instanceId）
    const inst = instanceForSession(push.sessionId);
    const pn = notificationForCliHook(push.hookEventName, {
      cwd: push.cwd, sessionId: push.sessionId, instanceId: inst?.instanceId,
    });
    if (!pn) continue;
    metrics.inc('hook_pushes');
    pushNotify(pn.title, pn.body, pn.data);
    const ntfyType = push.hookEventName === 'Notification' ? 'cli_hook_notification'
      : push.hookEventName === 'Stop' ? 'cli_hook_stop' : 'result';
    ntfyNotify(pn.title, pn.body, ntfyMetaFor(ntfyType, pn.data, notify.publicUrl));
  }
  if (decision.invalidateCwds.length) broadcastInstances(); // 列表徽标/最近列表随之刷新
}
const hooksInbox = createHooksInbox({
  ...resolveHookDirs(process.env), // 与 runner/安装器共用同一份解析，防"事件写 A、server 盯 B"
  enabled: process.env.CLI_HOOKS_BRIDGE !== 'off',
  onEvents: processHookEvents,
});
// 启动时把安装态说清楚。这一行专治"装了 hooks 却跑着旧 server"——那种情况下 CLI 一直往投递箱写、
// 没人消费，用户只看到"装了没反应"；升级重启后这行日志就是接上了的凭据。
refreshHooksInstallState();
if (process.env.CLI_HOOKS_BRIDGE === 'off') {
  console.log('[hooks] CLI hooks 桥已由 CLI_HOOKS_BRIDGE=off 停用（事件不消费）');
} else if (hooksInstallState === 'installed') {
  console.log('[hooks] CLI hooks 桥已安装，投递箱监听中——终端会话回合结束/需要你会即时刷新并推送');
} else if (hooksInstallState === 'drifted') {
  console.log('[hooks] ⚠️ CLI hooks 桥安装记录与 ~/.claude/settings.json 已漂移，运行 npm run hooks:status 检查');
} else {
  console.log('[hooks] CLI hooks 桥未安装：终端直跑的会话仅靠轮询、无推送（npm run hooks:install 或在设置面板一键启用）');
}

// effort UI 归一：normalizeEffortUiLevel（cli-settings-defaults.js）——ultracode → xhigh + Settings.ultracode。
// 最近一次 init payload + 按 cwd 归键的 models / slashCommands 缓存：新连接重放，免发消息即得加载摘要、命令列表与模型候选。
// 持久化到 data/init-cache.json 跨重启读回（CLI 收到首条消息前不输出 init——init 是轮次开始信号，
// 预热 spawn 也等不来；缓存可能陈旧但每轮 init 覆盖刷新，文件可随时删除，损坏即当作没有）。
// modelsCache / slashCommandsCache 按 cwd 归键：二者都随工作区 settings/skills 而变，非账号级全局量——
// 单全局缓存会跨工作区泄漏（模型 deepseek 名串区；斜杠 skill 串区）。详见 models-cache.js。
const INIT_CACHE = join(DATA_DIR, 'init-cache.json');
let lastInit = null;
const modelsCache = createModelsCache();
const slashCommandsCache = createCwdKeyedCache(); // cwd → { slashCommands: string[] }
// per-cwd「CLI 默认模型」缓存：新会话/无记录续接在 init 返回前显它、而非笼统「沿用当前」（只显示、不改发送）。
// 仅由「未 resume 且未 pin model」的启动填充（scout / fresh 首 init，判据 isCwdDefaultModel）。
const defaultModelByCwd = new Map();
try {
  const c = JSON.parse(readFileSync(INIT_CACHE, 'utf8'));
  lastInit = c.init ?? null;
  modelsCache.load(c.modelsByCwd); // 旧格式 c.models（单全局）不迁移——缓存可弃、下轮 models 事件即重建本区清单
  slashCommandsCache.load(c.slashCommandsByCwd);
  // 旧缓存只有 lastInit.slashCommands、无 per-cwd 表：用 lastInit.cwd 种一棵，覆盖该 cwd 冷启动「只剩 /model」
  if (slashCommandsCache.size === 0 && lastInit?.cwd) {
    const seed = normalizeSlashCommands(lastInit.slashCommands);
    if (seed) slashCommandsCache.set(lastInit.cwd, { slashCommands: seed });
  }
  if (c.defaultModelByCwd && typeof c.defaultModelByCwd === 'object' && !Array.isArray(c.defaultModelByCwd)) {
    for (const [cwd, m] of Object.entries(c.defaultModelByCwd)) if (cwd && typeof m === 'string' && m) defaultModelByCwd.set(cwd, m);
  }
} catch { /* 无缓存/损坏：保持空 */ }
function saveInitCache() {
  try {
    mkdirSync(dirname(INIT_CACHE), { recursive: true });
    writeOwnerOnlyFile(INIT_CACHE, JSON.stringify({
      init: lastInit,
      modelsByCwd: modelsCache.toJSON(),
      slashCommandsByCwd: slashCommandsCache.toJSON(),
      defaultModelByCwd: Object.fromEntries(defaultModelByCwd),
    }));
  }
  catch { /* 写失败不致命：缓存仅是重启后首轮前的体验增强 */ }
}
// scout / fresh 首 init 采纳 cwd 默认模型（判据把 resume-no-record 排除，防污染）；变化才落盘。
function recordCwdDefaultModel(cwd, { resumeId, pinnedModel, reportedModel }) {
  if (!cwd || !isCwdDefaultModel({ resumeId, pinnedModel, reportedModel })) return false;
  if (defaultModelByCwd.get(cwd) === reportedModel) return false;
  defaultModelByCwd.set(cwd, reportedModel);
  saveInitCache();
  return true;
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
  io.to('approved').emit('agent:event', { // SEC-01：仅广播给已批准设备
    seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
    type: 'models', payload: p
  });
}

// 切 cwd 上下文后按新 cwd 注入 slashCommands（合成 init，只带 slashCommands + cwd；其它字段不动）。
// 有缓存才推——无缓存不推空数组（会把前端 localStorage 里的好缓存冲成空，只剩本地 /model）。
// 跨区防护：resolveSlashCommandsForCwd 只认本 cwd 缓存 / lastInit.cwd 命中，绝不用别区 lastInit。
function pushSlashCommandsForCwd(cwd) {
  const cmds = resolveSlashCommandsForCwd(slashCommandsCache, cwd, lastInit);
  if (!cmds) return;
  io.to('approved').emit('agent:event', {
    seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
    type: 'init', payload: { cwd: cwd || null, slashCommands: cmds },
  });
}

// ---- statusline 单一来源路由：Web 驾驶用 SDK；CLI 镜像/外部脏上下文用按 session 隔离的 CLI 快照 ----
const statusOff = process.env.WEB_STATUSLINE === 'off'; // 禁用开关（默认启用，零 UI 痕迹）
let lastStatusLine = null;                             // 仅内存：结构化 payload，瞬时数据不持久化
let statusDebounce = null, statusInterval = null;
// 防并发重叠 + 忙时排队（noteStatusRefreshBusy）：await getContextUsage 期间丢刷新会让 ctx 停更到 10s tick
let statusRefreshState = { busy: false, queued: false };

function statusOwnerFor(agent, instanceId = viewingInstanceId) {
  if (statusBridgeOff || !agent?.sessionId) return 'sdk';
  // 只看 mirror 锁：externalDirty 管发送前置换，不把 statusline 锁到 CLI（见 selectStatusOwner 注释）。
  return selectStatusOwner({
    mirrorReadonly: mirrorOwnedBy(agent.sessionId, instanceId),
    externalDirty: agent.externalDirty === true, // 兼容形参，selectStatusOwner 忽略
  });
}

function replayStatusLineTo(socket) {
  const instanceId = viewingInstanceId ?? null;
  const agent = agents.get(instanceId) ?? null;
  const cwd = agent?.cwd ?? viewingCwd ?? null;
  const payload = selectStatusReplay(lastStatusLine, {
    owner: statusOwnerFor(agent, instanceId),
    instanceId,
    sessionId: agent?.sessionId ?? null,
    cwd,
  });
  if (!payload) return;
  socket.emit('agent:event', {
    seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
    instanceId,
    type: 'status_line', payload,
  });
}

async function refreshStatusLine() {
  if (statusOff || io.engine.clientsCount === 0) return; // 禁用 / 无人连接零开销
  statusRefreshState = noteStatusRefreshBusy(statusRefreshState, 'enter');
  if (!statusRefreshState.proceed) return; // 忙：已记 queued，leave 时补跑
  try {
    const currentInstanceId = viewingInstanceId;
    const currentCwd = viewingCwd;
    const va = agents.get(currentInstanceId); // 台阶3：当前查看 tab 的实例
    // cwd 取当前查看实例（per-instance）——va 为空（无 live 实例的工作区/新会话懒创建期）时不回退全局
    // lastInit（那是「最后一次任意实例 init」，会跨工作区泄漏上个会话的模型/目录）。
    const cwd = va?.cwd ?? currentCwd;
    const owner = statusOwnerFor(va, currentInstanceId);
    let payload;
    if (owner === 'sdk') {
      const sdkPayload = await buildWebStatusLine({ agent: va, cwd, versions });
      payload = { ...sdkPayload, source: { kind: 'sdk' } };
    } else {
      const cliRead = readCliSnapshotForSession(va.sessionId, cwd);
      const selected = selectStatusSource({ owner, cliRead });
      if (selected.kind === 'cli') {
        const cliPayload = await buildCliStatusLine({ snapshot: selected.value, cwd });
        payload = {
          ...cliPayload,
          source: { kind: 'cli', capturedAt: selected.value.capturedAt, ageMs: selected.ageMs },
        };
      } else {
        // CLI 是当前唯一权威但快照缺失/过期：明确不可用，不偷混 SDK 陈值——source.kind 仍诚实报
        // cli-unavailable，不因为下面垫了 rate 就冒充"可用"。但 buildCliStatusLine 整个没被调用，
        // 意味着它内部那两个回落点（写入点 B / 回落点）都摸不到：此前这一分支组装的 payload 100%
        // 没有 rate 字段——即使账号级快照里还留着最近一次温热数据。这里额外叠一层同源回落，
        // 与 buildWebStatusLine/buildCliStatusLine 共享同一账号级单例（见 statusline.js）。
        const fallbackRate = getFallbackUsageRate(Date.now());
        payload = {
          ts: Date.now(), cwd,
          ...(cwd ? { project: projectNameFromCwd(cwd) } : {}),
          ...(va.sessionId ? { session: { id: va.sessionId } } : {}),
          source: { kind: 'cli-unavailable', reason: selected.reason, ...(Number.isFinite(selected.ageMs) ? { ageMs: selected.ageMs } : {}) },
          ...(fallbackRate ? { rate: fallbackRate, rateFromSnapshot: true } : {}),
        };
      }
    }

    // await 期间切 tab/cwd/驾驶方都可能变化：旧来源结果作废，另排一次新鲜刷新。
    if (viewingInstanceId !== currentInstanceId || viewingCwd !== currentCwd || agents.get(currentInstanceId) !== va) {
      scheduleStatusRefresh();
      return;
    }
    if (statusOwnerFor(va, currentInstanceId) !== owner) { scheduleStatusRefresh(); return; }

    const key = JSON.stringify(payload, (k, v) => k === 'ts' ? undefined : v); // 排除每刷新都变的 ts 后去重
    if (lastStatusLine?.key === key) return;             // 同上次不重发
    lastStatusLine = {
      key, payload, owner,
      instanceId: currentInstanceId ?? null,
      sessionId: va?.sessionId ?? null,
      cwd: cwd ?? null,
    };
    io.to('approved').emit('agent:event', { // SEC-01：含 cwd/git 状态，仅广播给已批准设备
      seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
      instanceId: currentInstanceId,                     // 供客户端 dispatcher 安全路由/分流
      type: 'status_line', payload: { ...payload, instanceId: currentInstanceId } // 供 status_line handler 安全校验
    });
  } finally {
    statusRefreshState = noteStatusRefreshBusy(statusRefreshState, 'leave');
    if (statusRefreshState.reschedule) scheduleStatusRefresh(); // 忙时排队的那次补跑
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
// （session:new/switch）负责去重（instanceForSession）与切 viewingInstanceId。返回实例。
// 同步建（resumeId 由调用方解析，无需 await）——故无台阶2 的「await 让出窗口双实例」重入竞态。
function openInstance({ cwd, resumeId = null, mode, effort, transcriptMode = null, transcriptModel = null }) {
  if (agents.size >= MAX_LIVE_SESSIONS) {
    // permanent：重试多少次都还是满，标不可重试，免得客户端离线队列空转（见 socket.js 负 ack）
    const err = new Error(`超过最大活跃会话数量 ${MAX_LIVE_SESSIONS}，请关闭一些会话后再尝试`);
    err.permanent = true;
    throw err;
  }
  const id = newInstanceId();
  // 路由代次快照：本实例的 onSessionId 之后只有在该 cwd 代次未前进（未被 session:new/home/switch 作废）
  // 时才允许覆写 currentByCwd——防止本实例后台活动复活一个用户已明确放弃的路由指针。
  const generation = sessions.getGeneration(cwd);
  // B1：可被 session:switch 聚焦 live 时刷新；闭包 const 无法在 switch 后对齐 getGeneration
  const saved = resumeId ? (sessions.getSession(resumeId) || { id: resumeId }) : null;
  if (saved?.id) {
    interactionLog.addSessionLog(saved.id, 'sys_info', `[SYS] 启动/连接会话: instanceId=${id}, resumeId=${saved.id}, cwd=${cwd}`);
  }
  // 档位初值优先级：显式入参（mode/effort 已定义，如 setEffort 置换）>
  //   FRESH: L0 pending > L3 CLI settings（cliDefaultsByCwd）> L4 硬默认 ｜
  //   RESUME mode: saved 持久化值 > transcriptMode > L4 硬默认（不继承 cwd 末实例档——CLI 原生无此层）｜
  //   RESUME effort: saved 持久化值 > 继承该 cwd 末实例档 > L3 CLI settings > null（resolveResumeEffort）。
  // A1（2026-06-22）：新会话(FRESH)不继承 cwd 末实例档——贴终端等价（新起 claude 是干净默认）。
  // 2026-07-14：FRESH 的「干净默认」= resolveSettings 合并结果，不再写死 default/null。
  // resume 权限档：saved（sessions.json）> transcriptMode（CLI 末档）> L4 硬默认。
  // 2026-07-29：删除 inheritedMode——CLI 新起 claude --resume 不从别的活进程继承 mode，
  // transcriptMode 已覆盖"这个会话上次用什么档"场景，inherited 只在 transcript 无 mode 时触发
  // （极窄窗口），且与 CLI 行为不对齐（用户在终端跑 plan、Web resume 另一个旧会话会意外继承 plan）。
  // resume 思考强度：CLI 无对称 transcript 恢复手段（已知边界），2026-07-21 起 saved/inherited 都空时
  // 改读 L3 CLI settings 兜底，不再硬 null——effort 没有比 L3 更权威、可能被误盖的历史信号。
  // effort 入参/存储可为 UI 档 ultracode（会话 flag，不落 sessions.json 为 ultracode 字面量）。
  const isFresh = !resumeId;
  const fresh = isFresh
    ? resolveFreshPrefs({
        hasPendingMode: pendingModeByCwd.has(cwd),
        pendingMode: pendingModeByCwd.get(cwd),
        hasPendingEffort: pendingEffortByCwd.has(cwd),
        pendingEffort: pendingEffortByCwd.get(cwd),
        cliDefaults: cliDefaultsByCwd.get(cwd) || null,
      })
    : null;
  if (mode === undefined) {
    if (isFresh) {
      mode = fresh.mode;
      pendingModeByCwd.delete(cwd); // 消费 L0（无 pending 时 delete 无害）
    } else {
      mode = saved?.permissionMode || transcriptMode || 'default';
    }
  }
  let effUi;
  if (effort !== undefined) effUi = effort;
  else if (isFresh) {
    effUi = fresh.effort;
    pendingEffortByCwd.delete(cwd);
  } else {
    effUi = resolveResumeEffort({
      savedEffort: saved?.effort,
      inheritedEffortValue: inheritedEffort(cwd),
      cliDefaults: cliDefaultsByCwd.get(cwd) || null,
    });
  }
  // resume 持久化不会保存 ultracode（CLI never persist）→ 规范化后 SDK effort + flag
  // FRESH pending ultracode：resolveFreshPrefs 已拆 sdk+flag；effUi 可能是 sdk 五档或仍带 ui 字面量
  const freshUltra = isFresh && fresh?.ultracode === true;
  const rawEffForNorm = freshUltra ? 'ultracode' : (effUi === undefined ? null : effUi);
  const effNorm = normalizeEffortUiLevel(rawEffForNorm)
    || { ui: null, sdk: null, ultracode: false };
  permModeByInstance.set(id, mode);
  effortByInstance.set(id, effNorm.ui); // 广播/UI 用（可含 ultracode）
  // 模型：resume 用会话指针；FRESH 不 pin——让 CLI 按原生优先级自行解析
  // （/model > --model > ANTHROPIC_MODEL > settings.model），不再用 effective.model 覆盖。
  // resolvedEnv 可含 ANTHROPIC_MODEL（worktree 的 settings.local.json env 块），
  // CLI 会自动采纳（优先级在 --model 之下、settings.model 之上），与 startModel=undefined 不冲突。
  const startModel = saved?.model || undefined;
  const instance = new AgentSession({
    instanceId: id,
    resumeId: saved?.id,
    cwd,
    claudeBin,
    // resume 时回传会话原模型名（CLI 自身恢复的是规范化裸名，部分网关不认）——来源仅会话指针
    model: startModel,
    permissionMode: mode,
    effort: effNorm.sdk,
    ultracode: effNorm.ultracode,
    idleTimeoutMs,
    instanceIdleReclaimMs,
    approvalTtlMs,
    historicalCostUsd: saved?.cost || 0,
    resolvedEnv: cliDefaultsByCwd.get(cwd)?.env, // worktree env 块，注入子进程环境
    // worktree 网关隔离：经 0600 settings 文件下发，压住 CLI 从 canonical repo root 误读的网关配置
    worktreeSettingsPath: worktreeSettingsFileFor(cwd, cliDefaultsByCwd.get(cwd), effNorm.ultracode),
    onEvent: envelope => {
      metrics.inc('events'); // NFR-15 事件 seq 速率（累计事件数，速率由 /metrics 消费者按两次快照时间差算）
      if (envelope.type === 'init') {
        lastInit = envelope.payload;
        // slash 命令按本实例 cwd 归键（project/local skill 随区变）；空列表不写，避免冲掉更好缓存
        const cmds = normalizeSlashCommands(envelope.payload?.slashCommands);
        if (cmds) slashCommandsCache.set(cwd, { slashCommands: cmds });
        saveInitCache();
      }
      else if (envelope.type === 'models') { modelsCache.set(cwd, envelope.payload); saveInitCache(); } // 按本实例 cwd 归键，防跨工作区泄漏
      // 批准内含的 mode 切换（ExitPlanMode 等经 agent.resolvePermission emit）：同步 per-instance 权威档，
      // 使重连 / instances 重放与手机端权限档图标一致（envelope 随后照常 io.emit → 前端 setPermMode）。
      else if (envelope.type === 'permission_mode') { permModeByInstance.set(id, envelope.payload?.mode); }
      // P2 性能优化：后台实例（id !== viewingInstanceId）的高频 text_delta/thinking_delta 不广播——
      // 仍入环形缓冲（agent.js buffer.push 先于此 onEvent），sync:since 切回时可完整回放；
      // 低频事件（tool_use/init/result/permission_request 等）维持广播（角标/状态/推送依赖）。
      const _isHighFreqDelta = envelope.type === 'text_delta' || envelope.type === 'thinking_delta';
      if (!_isHighFreqDelta || id === viewingInstanceId) {
        io.to('approved').emit('agent:event', envelope); // SEC-01：主事件流含全部会话内容，仅广播给已批准设备
      }
      // 未读计数：故意独立于上面的 _isHighFreqDelta 广播闸门之外——后台实例的 text_delta 本就不广播（P2 性能优化），
      // 但仍要计未读，否则"挂着跑的会话"这个未读角标最核心的场景会永远显示 0。resolveUnreadDelta 判断这条 envelope
      // 是否算一条新顶层消息（颗粒度=用户消息+assistant文字回复，与前端渲染出的顶层气泡一一对应）；
      // isInstanceBeingWatched 判断当前是否需要计数（镜像视图架构下，同会话锁屏/断线也判定为未在看，见该函数注释）。
      {
        const delta = resolveUnreadDelta({
          eventType: envelope.type, payload: envelope.payload,
          lastCountedMessageId: lastCountedTopLevelMessageId.get(id) ?? null,
        });
        lastCountedTopLevelMessageId.set(id, delta.lastCountedMessageId);
        // 判据与推送侧统一为「有没有【前台可见】的连接」：只看房间连接数会把 PWA 切后台后
        // 那段 socket 未断的窗口误判成「有人在看」，于是收到了完成推送、回来却是 0 未读。
        if (delta.counts && !isInstanceBeingWatched(id, viewingInstanceId, hasForegroundApprovedClient(approvedSocketObjects()))) {
          unreadCounts.set(id, (unreadCounts.get(id) || 0) + 1);
        }
      }
      // E16：仅当前查看 tab 的轮次边界刷新状态行（后台实例的 init/result 不抢占 viewingInstanceId 的 statusline）
      if ((envelope.type === 'init' || envelope.type === 'result') && id === viewingInstanceId) scheduleStatusRefresh();
      // lastUsedAt 对齐消息活动：用户发送 / 轮次结束时刷新（init/onSessionId 的 upsert 不再刷）
      if (instance.sessionId && (envelope.type === 'user_message' || envelope.type === 'result')) {
        sessions.touchSessionActivity(instance.sessionId, envelope.ts);
      }
      // 台阶3 Step B：轮次/审批边界 → 重算 per-instance 角标并广播。done latch：后台轮次 result 置位；
      // 该实例新活动 init/审批即清（新一轮活动取代「完成」标记）。三个 latch（done/error/aborted）互斥，
      // 完整置位/清除规则见 instance-latches.js#deriveLatches（P1-4：抽纯函数防在此大回调里遗漏边界）。
      if (STATE_BOUNDARY.has(envelope.type)) {
        let latchEventType = null;
        if (envelope.type === 'result') {
          latchEventType = 'result';
          if (instance.sessionId) {
            sessions.updateSessionCost(instance.sessionId, (instance.historicalCostUsd || 0) + (instance.totalCostUsd || 0));
          }
        } else if (envelope.type === 'init' || envelope.type === 'permission_request' || envelope.type === 'question') {
          latchEventType = 'new_activity';
          // task_notification 在 STATE_BOUNDARY 里但【不】映射到 new_activity：它到达时 pendingTurns 仍 0（合成发生在
          // 后续 message_start），此刻清 error latch 会吞掉后台实例先前未确认的失败 ❗；且忙碌显示由合成的 pendingTurns
          // 驱动（instanceState busy 优先级本就盖过 done/error/aborted），自动汇报轮的 result 再正确重估 latch——无需在此清。
        } else if (envelope.type === 'system' && envelope.payload?.kind === 'interrupted') {
          latchEventType = 'system_interrupted'; // P1-4：用户主动中止（agent.js interrupt() 成功分支）
        }
        if (latchEventType) {
          const next = deriveLatches({
            inDone: doneInstances.has(id), inError: errorInstances.has(id), inAborted: abortedInstances.has(id),
            eventType: latchEventType, isError: envelope.payload?.isError, isViewing: id === viewingInstanceId,
            wasInterrupted: envelope.payload?.interrupted, // P1-4：result 是否由用户主动中止直接导致（agent.js 标记）
          });
          next.done ? doneInstances.add(id) : doneInstances.delete(id);
          next.error ? errorInstances.add(id) : errorInstances.delete(id);
          next.aborted ? abortedInstances.add(id) : abortedInstances.delete(id);
        }
        // request_resolved：审批/提问已被处理 → 清除该会话对应类别的"未决"标记（P1-5），
        // 使下一次同类别通知不再被①层"未决不重复推"拦截（②层最小间隔仍照常生效，不因此重置）。
        if (envelope.type === 'request_resolved' && envelope.sessionId) {
          const category = envelope.payload?.kind === 'permission' ? 'approval'
            : envelope.payload?.kind === 'question' ? 'input' : null;
          if (category) notifyThrottleState = clearNotifyPending(envelope.sessionId, category, notifyThrottleState);
        }
        // E15 离线 web-push：文案映射抽到 notificationForEvent（纯函数、tests/unit/notifications 覆盖）。
        // result 仅无客户端连时推（连着的自己看得到）；permission/question/task_notification 无条件推
        // （用户可能锁屏/在别的 app）。task_notification=后台任务（Workflow/后台 Agent/Bash）完成——
        // 此前落到这里两分支都不命中、从不推，手机锁屏收不到完成通知，本次补齐。
        // 先判断"若不考虑节流，本该不该推"（result 仅无客户端连时推等既有规则），
        // 只有确实要推送时才消费节流配额——避免"注定不推"的事件（如有客户端连的 result）白白占用节流窗口，
        // 致真正需要推送时被误判为"最近推过"。
        // approved 房间里的实际 Socket 对象（非仅 id）：喂给 hasForegroundApprovedClient 判定"前台可见"，
        // 而不只是"连着"——见下方注释与 PWA 后台推送修复（client:presence）。
        const approvedSockets = approvedSocketObjects();
        let pn = notificationForEvent(envelope.type, envelope.payload, {
          // BE-007 + PWA 后台推送修复：能看到 result 的客户端 = 已加入 approved 房间【且前台可见】的连接。
          // 待审批(deviceApproved=false)设备虽连着但没 join approved、看不到会话内容/result，不能算「有人在看」
          // 而抑制离线推送——否则唯一在线的是待审批设备时，真正该收到完成通知的离线已批准设备反而收不到。
          // 仅"已加入 approved"仍不够：PWA 切后台后 socket 常常还没断（要等 OS 冻结页面才真正断连），
          // 单纯按房间是否有 socket 判定会把"背景里还连着但看不见"误判为「有人在看」，把 result 永久吞掉
          // （用户反馈"切后台收不到完成通知"的根因）。hasForegroundApprovedClient 改按 socket.data.hidden
          // （client:presence 上报，见上方 on(socket,'client:presence',…)）判定，未上报过的连接保守按前台算。
          // permission/question/task_notification 无条件推、不受此影响。
          // 还要限定「看的是不是【这条】会话」：hasForegroundApprovedClient 是全局判定（房间里任一
          // 前台连接即为真），而投递是 per-订阅的，粒度不匹配。document.hidden 只表示标签页可见性、
          // 不含窗口焦点，所以电脑上一个被 IDE 盖住、但标签页处于活动状态的窗口就恒为「前台」——
          // 于是人拿着手机出门、PWA 切后台，会话跑完的 result 被判成「有人在看」而一条都不推。
          // 那正是本项目的主用例。限定到 viewingInstanceId 后，至少只有「确实在看这条会话」才抑制。
          hasClients: hasForegroundApprovedClient(approvedSockets) && viewingInstanceId === envelope.instanceId,
          instanceId: envelope.instanceId, sessionId: envelope.sessionId, cwd: envelope.cwd,
        });
        // P1-5 per-会话节流（docs/design.md）：同一会话同一类别已有未决通知或未过最小间隔 → 抑制，不推送。
        if (pn) {
          const notifyCategory = NOTIFY_CATEGORY[envelope.type];
          if (notifyCategory) {
            const r = throttleNotify(envelope.sessionId, notifyCategory, Date.now(), notifyThrottleState, notifyThrottleMs);
            if (r.throttled) pn = null;
            notifyThrottleState = r.next; // 无论放行与否都写回：next 在放行时含新记录，节流时等于原状态（幂等安全）
          }
        }
        if (pn) {
          // ⑧ previewBody 只喂 pushNotify（按订阅 prefs.preview 挑）；ntfy 恒收 body 最小化文案——
          // 第三方明文通道，不因用户开了预览开关就把正文送去 ntfy（SEC-04 红线不因这个开关松动）。
          pushNotify(pn.title, pn.body, pn.data, pn.previewBody);              // Web Push（带 data 供 SW 深链）
          ntfyNotify(pn.title, pn.body, ntfyMetaFor(envelope.type, pn.data, notify.publicUrl)); // ntfy（click 深链，绕移动端限制）
        }
        broadcastInstances();
      }
    },
    // E16：assistant 边界刷新 statusline（仅当前查看 tab；scheduleStatusRefresh 有 300ms 防抖兜频率）——ctx 不等 result/10s tick
    onUsage: () => { if (id === viewingInstanceId) scheduleStatusRefresh(); },
    // 活后台任务集合变化 → 节流重算会话列表 ⏳（纯后台运行期 pendingTurns=0，这是唯一的 busy 触发源；scout 实例不接、不跑后台任务）
    onBgTaskChange: () => scheduleBgBroadcast(),
    // 账面被兜底路径就地改写（interrupt 结算看门狗）——无伴随事件流，须显式重播 instances，
    // 否则前端要等下一次无关广播才知道该实例已不忙，spinner 一直挂着。
    onStateSettled: () => broadcastInstances(),
    onSessionId: (sid, firstMessage, model) => {
      // 新会话首次获得 id 时，写 entrypoint 元数据使 CLI /resume 可见（按本实例 cwd 落对应 project 目录）。
      if (!sessions.getSession(sid)) writeSessionEntrypoint(sid, cwd);
      // effort/permissionMode 一并持久化：init 事件到达时 agent 已完成漂移检测（permissionMode 为对账后真值），
      // effort 为构造时注入值（运行时不可改）。web 端续接恢复依赖这两字段。
      sessions.upsertSession({ id: sid, title: firstMessage, cwd, model, effort: instance.effort, permissionMode: instance.permissionMode, generation: instance.routeGeneration });
      // fresh 会话（未 resume、未 pin model）首 init 的 model = cwd CLI 默认 → 缓存供后续新会话预显（判据排除 resume-no-record，防污染）
      recordCwdDefaultModel(cwd, { resumeId: instance.resumeId, pinnedModel: instance.defaultModel, reportedModel: model });
      interactionLog.addSessionLog(sid, 'sys_info', `[SYS] 会话已获得 ID: sessionId=${sid}, 标题="${firstMessage || '未命名'}", model=${model || '默认'}`);
      // 显式广播：此前靠「init 边界的 broadcastInstances 自然带新 sid/title」搭便车，而 sessionId 现在
      // 可能远早于 init 到达（本地 slash 命令下实测早 122s，见 agent.js#_claimSessionIdEarly）。不显式推
      // 一次的话，前端要一直等到 init 才知道会话有了 id——「会话设置无 session id、标题恒『新会话』」
      // 那组症状照旧。init 时会再调一次本回调，届时多一次全量广播，幂等无害。
      broadcastInstances();
    },
    // 台阶3：实例意外退出/挂死自杀 → 从 Map 删该 instanceId（不影响其他实例）；resume 失败清该 cwd 指针
    // 打破"重试→resume 同一失效 id→循环"死锁；若退的是当前查看 tab，重选：优先同 cwd，默认不跨工作区
    // （resumeFailed 尤其禁止闪回 mimo 等其它 live tab；用户主动关 tab 走 disposeInstance allowCross）。
    onExit: () => {
      if (instance.sessionId) {
        interactionLog.addSessionLog(instance.sessionId, 'sys_info', `[SYS] 实例已退出 (onExit): instanceId=${id}, resumeFailed=${instance.resumeFailed}`);
      }
      if (agents.get(id) === instance) {
        if (instance.resumeFailed) sessions.setCurrent(cwd, null);
        // 只清表、不 dispose（实例已在退出路径上）。与 remove() 共用 clearTables，防再漏表。
        instanceManager.clearTables(id);
        // 默认 allowCrossWorkspace=false：同 cwd tab 或空表面保留本工作区，不弹到异 cwd live 实例
        if (viewingInstanceId === id) reselectViewingAfter(cwd);
      }
      broadcastInstances(); // 实例退出 → 刷 tab 栏（角标回落 / 该 tab 消失）
    }
  });
  // resume 冷读的会话末条 assistant 模型：作为最低优先级展示回落挂在实例上（instancesPayload 的
  // model 取 activeModel > reportedModel > transcriptModel）。不入 activeModel、不参与 setModel 差分——
  // init 权威模型到达后前二者自然盖过它（见 sessions/history.js lastAssistantModel 注释）。
  instance.transcriptModel = transcriptModel;
  instance.routeGeneration = generation; // B1：switch 聚焦 live 可刷新
  agents.set(id, instance);
  instance.start();
  return instance;
}

// L3 CLI settings（ensureCliDefaults）只为 effort 的 resume 兜底展示/取值服务（resolveResumeEffort），
// 不是 resume 必须等待的强依赖——SDK resolveSettings 文档标注首次调用可能触发 MDM 查询子进程
// （macOS plutil / Windows reg.exe），超预算就放弃这次的 L3 值（照旧落 null，即改动前的既有行为），
// 不能让一次异常慢的 settings 读拖住 resume。超时不取消该 Promise：settle 后仍会写入
// cliDefaultsByCwd，供同 cwd 下一次 resume 命中缓存。
const CLI_DEFAULTS_RESUME_BUDGET_MS = 1200;

// resume 开实例的异步封装：新开前先读 transcript 末条 permission-mode 恢复权限档（纯 CLI 会话 sessions.json
// 无档时的恢复来源，见 readLastPermissionMode）。openInstance 本身保持同步（避免重入竞态）；读盘只在此异步前置。
// 仅 resume（resumeId 非空）才读——FRESH 无档可恢复、也不该读；已 live 实例由调用方 instanceForSession 去重、不覆盖运行时档。
//
// 2026-07-30：这里曾在 resume 前无条件 SIGTERM（350ms 后升级 SIGKILL）掉 `claude agents` 里同 sessionId
// 的 background 条目，理由是「CLI 拒绝 resume 被 bg 占用的会话 → 先释放锁，保证 CLI 会话 web 能开」。
// 该做法已整体删除，因为它把「点开看一眼」变成了破坏性操作：判据只看 sessionId+kind，不看那个后台任务
// 是否正在干活（实测杀中过 state=working 的真实任务），CLI 侧表现为会话被中断。
// 现在的契约：resume 前不碰任何 CLI 进程。被占用的会话由 session:switch 前置判定后明说打不开
//（findBlockingLiveAgent + formatSessionLockError），漏网的走 agent.js F4 的 resume 失败兜底文案。
// CLI 官方给的出路是 `claude agents` attach 或 `--fork-session` 分叉副本，杀掉占用者不在其中。
async function openResumeInstance(cwd, resumeId, extra = {}) {
  const t0 = Date.now();
  let transcriptMode = null, transcriptModel = null;
  if (resumeId) {
    // 读末条权限档 / 读末条模型 / L3 CLI settings 兜底三路互无数据依赖，从入口就并发。
    const [[mode, model]] = await Promise.all([
      Promise.all([readLastPermissionMode(resumeId, cwd), readLastAssistantModel(resumeId, cwd)]),
      Promise.race([
        ensureCliDefaults(cwd),
        new Promise(resolve => setTimeout(resolve, CLI_DEFAULTS_RESUME_BUDGET_MS)),
      ]),
    ]);
    transcriptMode = mode;
    transcriptModel = model;
  } else {
    // FRESH 也要等 L3 落定：worktreeGatewayEnv 只在 AgentSession 构造时读一次，冷缓存下不等的话
    // 该会话整个生命周期都拿不到 worktree 网关隔离（正是 503 的原场景：重启后首次切到 worktree 就发消息）。
    // 同样套 resume 的预算上限，绝不让一次异常慢的 settings 读拖住首条消息。
    await Promise.race([
      ensureCliDefaults(cwd),
      new Promise(resolve => setTimeout(resolve, CLI_DEFAULTS_RESUME_BUDGET_MS)),
    ]);
  }
  const instance = openInstance({ cwd, resumeId, transcriptMode, transcriptModel, ...extra });
  diagLog.record(resumeId, 'resume', 'settled', { ms: Date.now() - t0 }); // Part C：resume 总耗时
  return instance;
}

// resume 并发去重：openResumeInstance 内部有 await（读 transcript 权限档），调用方常见写法是
// `instanceForSession(id) || await openResumeInstance(cwd, id)`——两个几乎同时到达、目标同一 sessionId
// 的请求（如 session:switch 被连点两次、两台设备同时切到同一会话）会双双通过 instanceForSession 检查
// （此时都还没人注册），双双落入 openResumeInstance，各自 spawn 一个 `claude --resume` 进程操作同一份
// 会话文件。用 sessionId 键的 in-flight map 把后到的请求收敛到同一个 Promise，只有一次真正 spawn。
//
// SRV-001：FRESH（resumeId 空）同样需要 single-flight——旧实现「FRESH 不去重、靠 justOpened」只在
// 第一条 open 完成后 viewingInstanceId 才有值；await currentSessionForCwd 间隙内两条并发首消息都会
// miss justOpened 并各 spawn 一个孤儿 CLI。键用 `fresh:${cwd}`，与 resume sessionId 空间隔离。
const resumeInFlight = new Map(); // key → Promise<AgentSession>
function dedupedResume(cwd, resumeId, extra = {}) {
  const key = resumeId || `fresh:${cwd}`;
  let p = resumeInFlight.get(key);
  if (!p) {
    p = openResumeInstance(cwd, resumeId, extra).finally(() => resumeInFlight.delete(key));
    resumeInFlight.set(key, p);
  }
  return p;
}

// scout 实例：为工作区获取真实模型清单的临时代理。
// session:new / setWorkdir 到无缓存工作区时，没有活实例调 supportedModels()→前端无模型可选。
// scout 以「不留任何痕迹」的方式临时启动 CLI：模型一到即缓存 → 推送前端 → dispose → 删除 CLI 残留文件。
// 与缓存关系：缓存加速后续（免重复 spawn），但第一次靠 scout 保证确定性——不用猜、不等实例、不靠上区残留。
const activeScouts = new Map(); // cwd → AgentSession：去重，防连点刷新/并发触发重复 spawn
function disposeScoutFor(cwd) { // config:refresh 用：清除旧 scout 再起新的（旧 scout 的 CLI 用旧 settings spawn，模型会过期）
  const old = activeScouts.get(cwd);
  // 走 scout 自己的 cleanup 而非裸 dispose：后者不清 20s 兜底定时器、也不删 CLI 建的 <sid>.jsonl 残留。
  if (old) { try { (old._scoutCleanup || (() => old.dispose()))(); } finally { activeScouts.delete(cwd); } }
}
function openScoutInstance(cwd) {
  if (activeScouts.has(cwd)) return activeScouts.get(cwd); // 已有同 cwd scout 在跑，复用
  const id = newInstanceId();
  const instance = new AgentSession({
    instanceId: id, resumeId: null, cwd, claudeBin,
    model: undefined, permissionMode: 'default', effort: null, idleTimeoutMs, instanceIdleReclaimMs: 0, approvalTtlMs,
    historicalCostUsd: 0,
    resolvedEnv: cliDefaultsByCwd.get(cwd)?.env, // worktree env 块，scout 也须注入才能拿到正确网关的模型列表
    // 同上：scout 的模型清单也须来自隔离后的网关（scout 不走 ultracode）
    worktreeSettingsPath: worktreeSettingsFileFor(cwd, cliDefaultsByCwd.get(cwd)),
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
      // scout 恒 fresh（resumeId=null、未 pin model）→ 其 init.model 即 cwd CLI 默认，权威缓存之。
      // 若当前正查看本 cwd（空首页），补一次广播让默认名即时到达前端（不必等下次视图切换）。
      if (recordCwdDefaultModel(cwd, { resumeId: instance.resumeId, pinnedModel: instance.defaultModel, reportedModel: model }) && cwd === viewingCwd) broadcastInstances();
      interactionLog.addSessionLog(sid, 'sys_info', `[SYS] scout 获取模型（不留会话入口）: instanceId=${id}, sessionId=${sid}, model=${model || '默认'}, cwd=${cwd}`);
    }
    // 不设 onExit：cleanup 显式调 dispose，consume 循环以 disposed=true 结束并跳过 onExit。
  });

  // 防重入：models 事件与 20s 兜底定时器都可能进来，只做一次。
  // 旧实现用 `if (instance.disposed) return` 当重入闸，但 disposeScoutFor（config:refresh 换 scout）
  // 走的是 instance.dispose() 而非本函数——定时器没被清，20s 后照常进来，此时 disposed 已为 true
  // 便早早返回，连带跳过下面的 transcript 残留清理，留下这段注释自己声明要防的「(无标题)」幽灵条目。
  let cleanedUp = false;
  function cleanup() {
    if (cleanedUp) return;
    cleanedUp = true;
    clearTimeout(timer);
    activeScouts.delete(cwd);
    const sid = instance._scoutSid;
    if (!instance.disposed) instance.dispose();
    // dispose 触发 abort → CLI 进程退出。CLI 启动时已在 ~/.claude/projects/<projectDir>/
    // 创建了 <sid>.jsonl 文件（含 init 系统消息等）；留之会在 listSessions 中出现「(无标题)」幽灵条目。
    // 异步延迟删除：给 CLI 进程一个信号处理的窗口，避免 unlink 与 CLI 写文件竞争。
    if (sid) {
      setTimeout(() => {
        try {
          const projectDir = getProjectDir(cwd);
          const file = join(homedir(), '.claude', 'projects', projectDir, `${sid}.jsonl`);
          // safe-path: projectDir 这一段【目录】是 getProjectDir(cwd) 算出来的。它若返回空串，
          // 路径就从 <根>/<项目>/<sid>.jsonl 塌成 <根>/<sid>.jsonl——打到 projects 根目录下。
          // 今天无害的唯一理由是这里用的是 unlinkSync（单文件）：目标不存在就抛、被 catch 吞掉，
          // 且它对目录会直接抛 EISDIR，删不动任何一棵树。
          // ⚠️ 谁要把这里改成 rmSync(..., { recursive: true })（比如为了顺带删子 agent 的 transcript
          // 子目录），先想清楚这一段：2026-08-02 删掉机主 70 个项目 / 291 memory / 2990 transcript 的，
          // 就是同一形态的递归版本——同一个 getProjectDir 被变异成恒返回 ''，join 塌成真实根本身。
          // 真要递归，必须先在删除点加护栏：resolve(target) === resolve(根) 就抛错。
          unlinkSync(file);
          invalidateListCache(cwd);
        } catch { /* 文件可能已被 CLI 清理或不存在——非致命 */ }
      }, 300);
    }
  }

  instance._scoutCleanup = cleanup; // 供 disposeScoutFor 走完整清理（清定时器 + 删 transcript 残留）

  // 20s 超时：CLI 卡死时释放资源 + 清理残留文件，避免僵尸实例/文件常驻
  const timer = setTimeout(() => {
    console.warn(`[scout] 模型获取超时 (${cwd})，释放实例`);
    cleanup();
  }, 20_000);

  activeScouts.set(cwd, instance); // 去重：同 cwd 并发请求复用此实例
  instance.start();
  return instance;
}

// 显式关 tab：dispose 后同步删 Map（dispose 置 disposed=true，consume 的 onExit 不再触发——
// 与台阶2 disposeAgent 同款，不依赖 onExit）。viewing 命中则优先同 cwd，否则允许跨工作区（P0-11g）。
// opts.reselect（默认 true）：用户关 tab / 真移除 → reselect + clearMirror + broadcast。
  // opts.reselect=false：internal 置换（externalDirty / setEffort）——只 remove，viewing 保持死指针，
  // 不 clearMirror、不 broadcast 中间态；调用方 await 新实例后按 shouldClaimViewingAfterSwap 原子接管。
  function disposeInstance(instanceId, { reselect = true } = {}) {
    const a = agents.get(instanceId);
    if (!a) return;
    if (a.sessionId) {
      interactionLog.addSessionLog(a.sessionId, 'sys_info', `[SYS] 实例已手动销毁/关闭 (disposeInstance): instanceId=${instanceId}`);
    }
    instanceManager.remove(instanceId);
    if (reselect) {
      // 用户主动关 tab：允许跨工作区落到剩余 live（与 onExit/resumeFailed 默认禁止跨区不同）
      if (viewingInstanceId === instanceId) reselectViewingAfter(a.cwd, { allowCrossWorkspace: true });
      broadcastInstances();
    }
    // silent：viewingInstanceId 可仍等于已删 id（死指针），供 shouldClaimViewingAfterSwap 识别「用户未切走」
  }

// ---- 契约路由（客户端→服务端）----
const on = createSocketEventRegistrar();

// 注册 Web 端实时流式日志广播回调
// key 可能是真 sessionId，也可能是 FRESH 首轮的 provisionalKey(instanceId)=`inst:${id}`
interactionLog.setCallback((key, entry) => {
  const payload = interactionLog.sessionLogPayload(entry); // 含 model/effort/permissionMode，与 logs:get 对齐
  if (!payload) return;
  for (const [instanceId, a] of agents) {
    if (a.logKey() === key || a.sessionId === key || interactionLog.provisionalKey(instanceId) === key) {
      io.to('approved').emit('agent:event', { // SEC-01：交互日志内容，仅广播给已批准设备
        seq: 0,
        epoch: 'server',
        sessionId: a.sessionId || null,
        instanceId,
        cwd: a.cwd,
        ts: entry.ts,
        type: 'session_log',
        payload,
      });
      break;
    }
  }
});

// 镜像/排队/停止诊断时间线：同款 seq:0/epoch:'server' 旁路广播，不占用 AgentSession 的 seq/环形
// 缓冲（诊断事件不需要参与 eventsSince 重放/gap 披露那套面向"重建聊天 UI"设计的机制）。
diagLog.setCallback((key, entry) => {
  for (const [instanceId, a] of agents) {
    if (a.logKey() === key || a.sessionId === key || diagLog.provisionalKey(instanceId) === key) {
      io.to('approved').emit('agent:event', { // SEC-01：仅广播给已批准设备
        seq: 0, epoch: 'server', sessionId: a.sessionId || null, instanceId, cwd: a.cwd,
        ts: entry.ts, type: 'diag_log', payload: entry,
      });
      break;
    }
  }
});

registerSocketConnection(io, socket => {
  console.log(`[conn] ${socket.id} 已连接（来自 ${clientIp(socket.handshake.address)}）`);
  // 只读追平：客户端（重）连时请求下一 tick 重定基线——重连会 loadHistory 重渲全量历史，若沿用滞后 baseline
  // 会把已显示的消息再 history_append 一遍成重复气泡。重定基线=不推、仅对齐，安全。
  // BE-009：改为置 catchUpRebaselineRequested 标志（而非直接 catchUpKey=null）——让下一 tick 在重建 baseline
  // 之【前】比较磁盘长度、把被吸收的终端外部增长标 externalDirty，防它被静默吞掉致下条手机消息分叉。
  mirrorEngine.requestRebaseline();

  if (socket.deviceApproved === false) {
    // 未经授权的设备：跳过任何敏感信息重放，只推送 pending 状态
    socket.emit('agent:event', {
      seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
      type: 'device_status', payload: { status: 'pending', deviceId: socket.handshake.auth?.deviceToken }
    });
  } else {
    // SEC-01：批准设备加入下行隔离房间——本函数下方全部 io.emit 已改 io.to('approved').emit，
    // 待审批 socket（deviceApproved===false）不在此房间，故收不到任何敏感广播，只收上面的 device_status。
    socket.join('approved');
    // 未读角标：覆盖"同一会话内断线重连"场景（镜像视图架构下最常见的"切出去"形态——锁屏/切后台冻结页面
    // 断开 socket，但 viewingInstanceId 全程不变，前端不会重新 emit user:setViewing）。幂等、null 安全，
    // 无关紧要的网络抖动重连也可放心无脑调用。
    captureUnreadSnapshot(viewingInstanceId);
    // 已授权的设备：重放最近 init/models（合成事件惯例：epoch:'server'、sessionId:null，不触发客户端会话切换）
    if (lastInit) {
      // 台阶3：lastInit 是全局最近一次（可能来自后台实例），重放时校正到当前查看 tab——
      // permissionMode 同理（否则前端先按陈旧档定基线、再被下方 permission_mode 重放纠正，冒出假「权限档→X」）；
      // model/cwd 一并校正，避免新设备连入时短暂显示后台实例的模型/目录（下一轮真 init 到达即自愈）。
      const va = agents.get(viewingInstanceId);
      // #5：全局 lastInit 的 slashCommands 可能来自别 cwd → 先剥离，再按 viewing cwd 注入 per-cwd 缓存
      const { slashCommands: _omitCmds, ...initBase } = lastInit;
      const replayCwd = va?.cwd ?? viewingCwd;
      const replayCmds = resolveSlashCommandsForCwd(slashCommandsCache, replayCwd, lastInit);
      socket.emit('agent:event', {
        seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
        type: 'init', payload: {
          ...initBase,
          permissionMode: permModeOf(viewingInstanceId),
          // model/cwd 校正到当前查看 tab：va 存在用实例值（FRESH 实例 activeModel 为空则 null，不回退 lastInit）；
          // va 为空（空首页）model 不下发=null（新会话模型=env 默认、服务端不可知，前端显「不指定」，A1）、cwd 用 viewingCwd
          ...(va ? { model: va.activeModel ?? null, cwd: va.cwd }
                : { model: null, cwd: viewingCwd }),
          ...(replayCmds ? { slashCommands: replayCmds } : {}),
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
    replayStatusLineTo(socket); // 仅 owner/instance/session/cwd 全匹配才即时上屏
    // 台阶3：重放当前查看 tab 的权限档（总是发，含 default）
    permModeTo(socket);
    // 重放当前查看 tab 的思考强度档（总是发，含 null=模型默认）
    effortTo(socket);
    // 台阶3：重放 tab 栏快照（viewingInstanceId + dirs + 各实例状态）
    instancesTo(socket);
    // 只读追平：向(重)连客户端补发权威完整快照（含 readonly=false）。setMirror 仅在变化时广播，
    // 若空闲态省略事件，断线前残留 readonly=true 的客户端会在重连后继续假锁；实例 ID 重启复用时尤其明显。
    const currentMirrorAgent = agents.get(viewingInstanceId);
    const mirrorReadonly = Boolean(currentMirrorAgent && mirrorOwnedBy(currentMirrorAgent.sessionId, viewingInstanceId));
    const mirrorSnapshot = mirrorEngine.snapshot();
    socket.emit('agent:event', {
      seq: 0, epoch: 'server', sessionId: currentMirrorAgent?.sessionId ?? null,
      instanceId: viewingInstanceId, cwd: viewingCwdOf(), ts: Date.now(), type: 'mirror_state',
      payload: {
        readonly: mirrorReadonly,
        stale: mirrorReadonly && mirrorSnapshot.stale,
        ...(mirrorReadonly ? { observedCli: mirrorSnapshot.observedCli, autonomous: mirrorSnapshot.autonomous } : {}),
      }
    });
    // 可信端连入时重放当前待审批设备列表，使其可立即在 Web UI 远程审批
    socket.emit('agent:event', {
      seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
      type: 'pending_devices', payload: pendingDevicesPayload()
    });
    scheduleStatusRefresh(); // 300ms 后新鲜数据跟上
  }

  on(socket, 'user:message', async (payload, rawAck) => {
    const t0 = Date.now(); // Part C：端到端入队耗时，覆盖去重检查/校验/懒开会话/externalDirty 换实例/附件落盘全链路
    // REL-01 幂等（离线重发/网络抖动可能致同一条消息被处理两次）：clientMessageId 由发送端生成，
    // 已处理过的直接 ack 放行、不重复执行任何副作用（不重发校验提示、不重复调用 a.send）。
    // 无 ID（旧客户端未升级）→ 不去重，向后兼容。
    const clientMessageId = (payload && typeof payload === 'object') ? payload.clientMessageId : undefined;
    // BE-002：这里只【查询】是否已处理过，登记推迟到消息真正成功入队之后（见下方 commitProcessed）。
    // 若在此提前登记（旧 checkAndRecord 行为），校验失败/队满失败的 ID 会被记入，第二次重发命中去重
    // 得到 {ok:true,deduped:true} 被客户端当成功删除 pending → 消息永久丢失（假成功丢消息根因）。
    if (isProcessed(clientMessageId, messageDedupState)) {
      if (typeof rawAck === 'function') rawAck({ ok: true, deduped: true }); return;
    }
    // 并发去重：另一个请求（多半断线重连重发撞上原请求仍处理中）正处理同一条、尚未落定成败——
    // 不重复调用 a.send()，负 ack 可重试，client 既有重试机制稍后会再次命中（那时原请求已
    // commit/release，走上面的 isProcessed 快路径或正常处理）。
    if (isInFlight(clientMessageId, messageInFlightIds)) {
      if (typeof rawAck === 'function') rawAck({ ok: false, error: '正在处理中，请稍后重试', retryable: true });
      return;
    }
    if (clientMessageId) messageInFlightIds = claimInFlight(clientMessageId, messageInFlightIds);
    // 包一层 ack：本函数下方所有分支都经既有的「ack(...)」调用退出（校验失败/stale/忙碌拒绝/send
    // 异常/队满/成功），借这层包装统一在【每个】退出点释放上面的 claim，不必逐个分支手动补释放
    // （手动补容易漏掉未来新增的退出点）。无论成功失败都要 release，否则失败重试会被误判为仍在处理中。
    let released = false;
    const ack = (result) => {
      if (!released) {
        released = true;
        if (clientMessageId) messageInFlightIds = releaseInFlight(clientMessageId, messageInFlightIds);
      }
      if (typeof rawAck === 'function') rawAck(result);
    };

    try {
      const text = typeof payload === 'string' ? payload : payload?.text;
      const attachments = (payload && typeof payload === 'object') ? payload.attachments : undefined;
      const hasText = typeof text === 'string' && text.trim().length > 0;
      const hasAttachments = Array.isArray(attachments) && attachments.length > 0;
      if (!hasText && !hasAttachments) {
        sysTo(socket, '消息为空或格式无效', true); // #12：不静默丢弃；用 system 不终结在途轮
        ack({ ok: false, error: '消息为空或格式无效', permanent: true }); // BE-002：永久校验失败，客户端应停止重试
        return;
      }
      if (typeof text === 'string' && text.length > 50000) {
        // system 而非 error：发送前校验，不应 finalize 正在流式的在途任务（前端已先行红字提示）
        sysTo(socket, `消息过长（${text.length} 字符，上限 50000），未发送`, true);
        ack({ ok: false, error: '消息过长', permanent: true }); // BE-002：内容超长重发必再失败，客户端应停止重试而非无限重发
        return;
      }
      // E17：附件校验（条数/单文件/总量）。失败用 system 提示、不发送、不终结在途轮。
      const attErr = validateAttachments(attachments);
      if (attErr) {
        sysTo(socket, attErr, true);
        ack({ ok: false, error: attErr, permanent: true }); // BE-002：附件非法重发必再失败，客户端应停止重试
        return;
      }

      const cleanText = hasText ? text.trim() : '';
      const model = (payload && typeof payload === 'object') ? payload.model : undefined;
      // 台阶3：路由到目标实例（instanceId 优先）；无可路由实例（首发/session:new 后/无 open tab）则懒开一个
      // （resume 该 cwd 当前会话，无则新建；该会话已 live 则聚焦去重），设为查看 tab。
      const rawInstanceId = payload && typeof payload === 'object' ? payload.instanceId : undefined;
      // 离线 outbox 重发（客户端 deliverOutboxItem 置位）：payload 里的 instanceId/cwd 是【入队时刻】的
      // 快照，而断线期间服务端 viewing 可能已换到别的工作区/会话。此时缺省回退 viewing 会把一条旧消息
      // 投给它从没指向过的会话，故关掉回退；交互式首发不置此位，回退仍是正确行为。
      const fromOutbox = payload && typeof payload === 'object' && payload.fromOutbox === true;
      const target = resolveTarget(rawInstanceId, fromOutbox ? { allowViewingFallback: false } : undefined);
      if (target.stale) {
        // BE-001：显式指定了一个已关闭 / 未知实例——fail-closed：不回退当前查看会话、不懒开，负 ACK 让客户端刷新后重发。
        // 不 commit 去重 ID（客户端刷新拿到有效 instanceId 后可用同一 clientMessageId 重发）。
        sysTo(socket, '目标会话已关闭，请刷新后重发', true);
        ack({ ok: false, error: 'stale_instance', stale: true });
        return;
      }
      let a = target.id ? (agents.get(target.id) ?? null) : null;
      if (!a) {
        const rawCwd = payload && typeof payload === 'object' ? payload.cwd : undefined;
        // outbox 重发既无 live 实例、又没带入队时刻的 cwd → 目标无从确定。下面 routeCwd 的缺省回退会落到
        // 服务端当前 viewingCwd（多半已是别的工作区），那就换条路径误投了。同 BE-001 fail-closed。
        if (shouldRejectOutboxLazyOpen({ fromOutbox, cwd: rawCwd })) {
          sysTo(socket, '目标会话已关闭，请刷新后重发', true);
          ack({ ok: false, error: 'stale_instance', stale: true });
          return;
        }
        // ensureWhitelisted 同 session:new(#8)/session:switch：routeCwd 缺省回退(viewingCwdOf)可能仍是
        // 热移除目录（该目录有 live 实例挂着未被 reloadWorkdirs 归位），不夯一次白名单会在其上新开 FRESH 会话。
        const cwd = ensureWhitelisted(routeCwd(rawCwd), workDirs);
        // SRV-NEW-001：记录 await 前 viewing；open 期间用户 switch/home 则不得抢回 UI。
        const viewingAtStart = viewingInstanceId;
        const saved = await currentSessionForCwd(cwd);
        // 并发懒开去重（S2 + SRV-001）：currentSessionForCwd 的 await 间隙内，另一条并发首消息可能已为本 cwd
        // 懒开了实例。RESUME 靠 instanceForSession；FRESH 另走 dedupedResume(`fresh:${cwd}`) single-flight。
        // justOpened 仍作二次收敛（已完成的 open 但尚未写入 inFlight 清理窗口）。
        const justOpened = agents.get(viewingInstanceId);
        a = (saved && instanceForSession(saved.id))
          || (justOpened && justOpened.cwd === cwd ? justOpened : null)
          || await dedupedResume(cwd, saved?.id ?? null); // resume / FRESH 均 single-flight
        if (shouldClaimViewingAfterLazyOpen({ viewingAtStart, viewingNow: viewingInstanceId })) {
          viewingInstanceId = a.instanceId;
          // SRV-002：懒开须同步裸 viewingCwd——否则 envelopes / pendingModeByCwd 仍指向旧 WORK_DIR。
          viewingCwd = a.cwd;
          broadcastInstances();
        }
        // 用户已切走：实例仍留在 agents Map，不写 viewing、不 broadcast 抢焦点
      }
      // 陈旧上下文守卫（2026-07-12 单驾驶员，修「接管后的语义分叉」）：实例的 SDK 子进程上下文是进程内存态、
      // 只在启动(resume)那一刻读过磁盘；外部驱动方（终端 CLI）此后写的轮次，web 靠追平【显示】了、但子进程
      // 【内存里没有】——直接发送=模型看不到那些轮次、还从旧位置分叉出第二条 parentUuid 链。externalDirty 由
      // catchUpTick 观察到外部 text 写入时标记（其 localBusy 吸收逻辑已排除己方写入），此处先置换实例
      // （dispose+resume 冷读最新磁盘，同 effort 切档模式）再发送。
      // 已知边界：catchUpTick 只盯当前查看会话——后台 tab 被外部写过、切入后首个 tick(≤2.5s)前极速发送不经
      // 此守卫（切入流程本身 1-2s，实际难触发）；接受，不为此每次发送读盘比对。
      if (a.externalDirty && a.sessionId) {
        // SRV-003：忙碌中禁止置换（会 kill 在途 canUseTool / turn）；可重试 ack，客户端保留 pending。
        // 文案区分「吸收终端写入」与具体忙因（turn / 审批 / 后台任务），避免 UI 已「完成」仍见笼统「会话正在处理」。
        if (a.isBusy()) {
          const nack = externalDirtyBusyNack({
            pendingTurns: a.pendingTurns,
            bgTaskCount: a.bgTasks?.size ?? 0,
            pendingPermissionCount: a.pendingPermissions?.size ?? 0,
            pendingQuestionCount: a.pendingQuestions?.size ?? 0,
          });
          interactionLog.addSessionLog(
            a.sessionId,
            'sys_info',
            `[SYS] externalDirty 置换被拒（${nack.reason}）：${nack.detail}`,
          );
          ack({ ok: false, error: nack.error, busy: nack.busy === true, retryable: nack.retryable, reason: nack.reason });
          return;
        }
        const cwd = a.cwd, sid = a.sessionId, mode = a.permissionMode, eff = effortOf(a.instanceId);
        const disposedId = a.instanceId;
        interactionLog.addSessionLog(sid, 'sys_info', '[SYS] 会话曾被外部（终端）驱动，发送前置换实例吸收外部轮次（防陈旧上下文分叉）');
        // 体感：置换会冷启动 resume，前端先收到 system 条再等 init，避免「点了没反应」
        socket.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: sid, instanceId: disposedId, ts: Date.now(),
          type: 'system', payload: { message: '正在续接会话（吸收终端写入）…', kind: 'resuming' }
        });
        // SS-NEW-001 / SRV-NEW-002：silent dispose——不 reselect 到 remaining[0]、不 clearMirror、不中间 broadcast；
        // viewing 保持死指针，await 后按 shouldClaimViewingAfterSwap 决定是否原子接管（用户切走则不抢）。
        disposeInstance(disposedId, { reselect: false });
        // SRV-003：走 dedupedResume 而非裸 openInstance，并发 swap 收敛到同一 resume Promise。
        // R1（2026-08-06）：与 setEffort 同款收口——silent dispose 后 viewing 是死指针，await 抛错
        // 会被 socket.js 兜底 catch 接走，下面的 claim/reselect/broadcast 全不执行、死指针永久留存。
        try {
          a = await dedupedResume(cwd, sid, { mode, effort: eff });
        } catch (err) {
          if (viewingInstanceId === disposedId) reselectViewingAfter(cwd);
          broadcastInstances();
          throw err;
        }
        if (shouldClaimViewingAfterSwap({ disposedId, viewingNow: viewingInstanceId })) {
          viewingInstanceId = a.instanceId;
          viewingCwd = a.cwd;
        } else if (viewingInstanceId === disposedId) {
          // 安全网：理论上 silent 后 viewing 应仍是 disposedId 或用户已改；若仍死指针却未 claim，落 reselect
          reselectViewingAfter(cwd);
        }
        broadcastInstances();
      }
      // 在途轮拒收（排队已移除 2026-07-30）：判据只认在途轮，不用 isBusy()——后台任务挂着仍可发送。
      // 放在 send() 之前而非依赖其返回值，是为了让拒绝理由精确：send() 返回 false 还covers disposed
      // 与窄竞态，那些是可重试的，而"任务运行中"要的是【不】自动重试（否则等于把排队搬到客户端）。
      // 不 commit 去重 ID、不记 userMessageIn：同一 clientMessageId 稍后重发必须还能成功。
      if (a.pendingTurns > 0) {
        ack({ ok: false, error: '当前任务运行中，请等待完成后再发送', busy: true, retryable: false });
        return;
      }
      // FRESH 首轮 sessionId 可能仍 null：走 agent.logKey()（provisionalKey）与 agent 内 userMessageOut/agentSend 对齐
      interactionLog.userMessageIn(a.logKey(), cleanText, model || a.activeModel || a.reportedModel || a.defaultModel, a.effort || 'model-default', a.permissionMode || 'default'); // 交互日志：client → server；model/effort/perm 走 chip 字段
      let sent;
      try {
        if (hasAttachments) {
          // 落盘 <cwd>/.ccm-uploads/ → 绝对路径注入 prompt → 送 SDK（claude 用 Read 读，白名单内免审批）；
          // 气泡走 displayText（原文，不含路径）+ 去完整 data 的元数据（含小 thumb，进缓冲供回放）
          // SRV-004：saveAttachments 抛错必须结构化 ack（permanent 磁盘类），避免离线队列永久重试。
          const saved = await saveAttachments(a.cwd, attachments);
          sent = await a.send(buildPromptText(cleanText, saved), model, {
            displayText: cleanText,
            attachments: toEventMeta(saved),
            clientMessageId, // FE-002：离线乐观气泡对账
          });
        } else {
          // F1：send 改 async（setModel 需 await）；clientMessageId 供前端对账
          sent = await a.send(cleanText, model, { clientMessageId });
        }
      } catch (err) {
        // SRV-004：附件落盘失败 / 其它同步抛错 → 负 ACK；附件失败多半 permanent（权限/symlink/满盘）
        const msg = err?.message || String(err);
        const permanent = hasAttachments; // 附件校验已过、落盘仍失败 → 重试通常无意义
        sysTo(socket, hasAttachments ? `附件保存失败：${msg}` : `发送失败：${msg}`, true);
        ack({ ok: false, error: msg, permanent, retryable: !permanent });
        return;
      }
      // BE-002：send 返回 false = 实例已弃用，或上面那道在途轮闸到 send 之间的窄竞态（setModel await
      // 让出点里另一条抢先开了轮）——都是可重试的临时失败，消息【未】入队。
      // 必须回传 ok:false + retryable 让客户端保留 pending、稍后重连重试，且【不能】commit 去重 ID——
      // 否则下次重发命中去重被假成功丢弃。旧代码无条件 ack{ok:true} 且忽略 send 返回值是「假成功丢消息」根因。
      if (!sent) {
        ack({ ok: false, error: '发送失败，请重试', retryable: true });
        return;
      }
      // 只在消息真正成功入队后才登记去重 ID（此后同 ID 重发才判 duplicate、幂等）。
      // 【必须排在下面所有副作用之前】send 已 resolve = 消息确实进了 SDK 队列，从这一刻起它就是
      // 「已处理」。排在 diagLog / takeOver 之后的话，那两步任一抛异常都会走 finally 释放 in-flight
      // 而去重 ID 未登记 → 客户端收负 ack 重发 → isProcessed 与 isInFlight 双双为假 → handler 整条
      // 重跑并二次 a.send()，同一条 prompt 投给 Claude 两次。加 try/finally 之前那条陈旧的 in-flight
      // 占用反而会挡住重试（卡到重启，但至多一次），即修 F1 时把「卡死」换成了「可能重复投递」。
      // 顺序不变量由 tests/unit/message-dedup.test.mjs 的源码级断言钉住（2026-08-04 code review）。
      messageDedupState = commitProcessed(clientMessageId, messageDedupState);
      diagLog.record(a.logKey(), 'message', 'enqueued', { ms: Date.now() - t0, hasAttachments }); // Part C
      if (viewingInstanceId === a.instanceId && mirrorEngine.isReadonly()) {
        // 前端显式接管后第一条消息已成功入 Web SDK 队列：服务端此刻也切换驾驶方，避免 statusline 继续
        // 被旧 mirrorReadonly 锁在 CLI 来源。失败入队不清锁，仍保持终端权威。
        mirrorEngine.takeOver(a.sessionId);
      }
      // 入队即在跑：立即广播 turnRunning=true，多端禁发送按钮无延迟（本端已乐观置位，这条管其它端）。
      broadcastInstances();
      ack({ ok: true, instanceId: a.instanceId });
    } finally {
      // 异常冒出本 handler 时（socket.js on() 包装器只负责 rawAck 负 ack），这里兜底释放 in-flight
      // 占用——否则同一 clientMessageId 的重发会被上方 isInFlight 永久拒为「正在处理中」，这条消息
      // 直到 server 重启都发不出（message-dedup.js 头注释要求的 try/finally release；2026-08-03 F1）。
      // 正常路径 ack() 已释放（released=true），此处幂等跳过。只 release 不 ack：负 ack 归 on() 包装器。
      if (!released && clientMessageId) {
        released = true;
        messageInFlightIds = releaseInFlight(clientMessageId, messageInFlightIds);
      }
    }
  });

  on(socket, 'user:approve', payload => {
    // op：客户端回传它渲染审批卡片时所见的 {tool,args,cwd}（承接 docs/design.md 端到端协议步骤5/6，NFR-17
    // 审批完整性绑定）——allow 决策时 agent.js#resolvePermission 用它重算指纹比对 askPermission 时
    // 锚定的 fp，不一致 fail-closed 拒绝。deny 决策不校验（拒绝任何操作都安全，op 缺省或不传均可）。
    const { requestId, decision, alwaysThisSession, instanceId, op, exitMode } = payload || {};
    if (typeof requestId !== 'string' || !['allow', 'deny'].includes(decision)) return;
    const a = routeInstance(instanceId);
    if (a) {
      interactionLog.addSessionLog(a.logKey(), 'sys_info', `[SYS] 许可决策 (user:approve): requestId=${requestId}, decision=${decision}, alwaysThisSession=${alwaysThisSession}${exitMode ? `, exitMode=${exitMode}` : ''}`);
      const outcome = a.resolvePermission(requestId, decision, Boolean(alwaysThisSession), op, exitMode ? { exitMode } : undefined);
      // FR-19 最小审计记录（承接 Phase 4）：只在完整性校验失败时写——常规 allow/deny 已完整落在
      // approval_request 台账里（含 op 全量），这里重复记一条只会用日常噪音挤占 audit_record 的环形
      // 上限；actor 归属信息只有这层（socket）有，agent.js 保持设备无关，故写点放在这里而非 agent.js。
      if (outcome === 'integrity_mismatch') {
        audit.recordAudit({ actor: actorFromSocket(socket), action: 'approval_integrity_mismatch', target: requestId, outcome: 'denied', meta: { tool: op?.tool ?? null } });
      }
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
    if (approveDevice(deviceId)) {
      unlockDeviceSockets(deviceId);
      broadcastPendingDevices();
      audit.recordAudit({ actor: actorFromSocket(socket), action: 'device_approved', target: deviceId, outcome: 'allowed', meta: { via: 'web' } });
    } else {
      // BE-011：批准落盘失败——设备并未真正信任（isDeviceTrusted 每次重读磁盘），不解锁、不谎报成功，告警并提示重试。
      broadcastPendingDevices();
      audit.recordAudit({ actor: actorFromSocket(socket), action: 'device_approved', target: deviceId, outcome: 'error', meta: { via: 'web', persistFailed: true } });
      sysTo(socket, '设备批准未能写入磁盘、未生效，请重试', true);
    }
  });
  on(socket, 'user:denyDevice', payload => {
    const deviceId = payload?.deviceId;
    if (typeof deviceId !== 'string' || !deviceId) return;
    console.log(`[devices] 已信任设备 ${socket.id} 远程拒绝 ${deviceId}`);
    const revoked = denyDevice(deviceId);
    disconnectDeviceSockets(deviceId); // 断连照做：即便落盘失败，也先切断该设备当前连接（纵深防御）
    broadcastPendingDevices();
    if (revoked) {
      audit.recordAudit({ actor: actorFromSocket(socket), action: 'device_denied', target: deviceId, outcome: 'denied', meta: { via: 'web' } });
    } else {
      // BE-011：吊销落盘失败——磁盘仍含该设备，下次 isDeviceTrusted 重读会复活，不谎报成功，告警 + 提示重试。
      console.error(`[devices] 吊销 ${deviceId} 落盘失败，可能未生效`);
      audit.recordAudit({ actor: actorFromSocket(socket), action: 'device_denied', target: deviceId, outcome: 'error', meta: { via: 'web', persistFailed: true } });
      sysTo(socket, '设备吊销未能写入磁盘、可能未生效，请重试或检查服务端磁盘', true);
    }
  });

  // 台阶3：切权限档（作用于指定实例，缺省 viewingInstanceId）。即时切（成功才落库 + 广播，失败
  // 时 agent 已 emit error）。无实例则 echo 当前档拨回该 socket，不存储。bypassPermissions 已由前端二次确认。
  on(socket, 'user:setPermissionMode', async payload => {
    // 白名单 = SDK PermissionMode（CCM_PERMISSION_MODES）；manual 别名 → default
    const mode = normalizePermissionMode(payload?.mode);
    if (!mode) {
      return sysTo(socket, `未知权限档：${payload?.mode}`, true);
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
    interactionLog.addSessionLog(a.logKey(), 'sys_info', `[SYS] 切换权限档 (user:setPermissionMode): mode=${mode}, instanceId=${id}`);
    permModeByInstance.set(id, mode);                  // 台阶3：档位 per-instance
    if (a.sessionId) sessions.updateSessionPrefs(a.sessionId, { permissionMode: mode }); // 持久化，resume 恢复用
    io.to('approved').emit('agent:event', { // SEC-01：仅广播给已批准设备
      seq: 0, epoch: 'server', sessionId: null, instanceId: id, ts: Date.now(),
      type: 'permission_mode', payload: { mode }
    });
  });

  // 台阶3：切思考强度档。SDK 无 effort 运行时控制 → 置换实例（dispose+resume）。
  // level：SDK 五档 | ultracode（→ xhigh + Settings.ultracode，不落盘）| null（模型默认）。
  on(socket, 'user:setEffort', async payload => {
    const rawLevel = payload?.level ?? null;
    const norm = normalizeEffortUiLevel(rawLevel);
    if (!norm) {
      sysTo(socket, `未知思考强度档：${rawLevel}`, true);
      return effortTo(socket);
    }
    const { ui: level, sdk: sdkEffort, ultracode } = norm;
    const id = resolveInstanceId(payload?.instanceId);
    const a = agents.get(id);
    if (!a) {
      if (viewingInstanceId === null) {
        pendingEffortByCwd.set(viewingCwd, level);
        socket.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, instanceId: null, ts: Date.now(),
          type: 'effort_mode', payload: { level }
        });
        return;
      }
      return effortTo(socket);
    }
    if (level === effortOf(id)) return; // UI 档幂等（xhigh ↔ ultracode 不同，须置换）
    if (a.isBusy()) {
      sysTo(socket, '当前有任务在运行，请等结束后再切思考强度', true);
      return effortTo(socket);
    }
    const cwd = a.cwd, sid = a.sessionId, mode = a.permissionMode, disposedId = id;
    // B3：FRESH 尚无 sessionId 时 dispose+resume(null) 会丢掉在途首条/半开实例——只记 pending，等懒开消费
    if (!sid) {
      pendingEffortByCwd.set(cwd, level);
      effortByInstance.set(id, level);
      socket.emit('agent:event', {
        seq: 0, epoch: 'server', sessionId: null, instanceId: id, ts: Date.now(),
        type: 'effort_mode', payload: { level }
      });
      sysTo(socket, '会话尚未分配 ID，思考强度将在下一条消息生效', false);
      return;
    }
    interactionLog.addSessionLog(sid, 'sys_info', `[SYS] 切换思考强度 (user:setEffort): level=${level || '模型默认'}${ultracode ? ' (Settings.ultracode)' : ''}, 正在置换实例...`);
    // 持久化只存 SDK effort；ultracode 不落盘（CLI: interactive toggles never persist）
    if (sid) sessions.updateSessionPrefs(sid, { effort: sdkEffort });
    socket.emit('agent:event', {
      seq: 0, epoch: 'server', sessionId: sid, instanceId: id, ts: Date.now(),
      type: 'system', payload: { message: '正在切换思考强度并续接会话…', kind: 'resuming' }
    });
    disposeInstance(disposedId, { reselect: false });
    let ni;
    try {
      ni = await dedupedResume(cwd, sid, { mode, effort: level });
    } catch (err) {
      // R1（2026-08-06）：silent dispose 不 reselect，viewing 故意停在死指针上等 await 结果。
      // 这里若抛出（openInstance 的 MAX_LIVE_SESSIONS、query()/start() 同步失败），控制流会被
      // socket.js 的兜底 catch 接走——下面的 claim/reselect/broadcast 全不执行，viewing 永久
      // 指向已删 id：instancesPayload 报一个不存在的 tab、catchUpTick 走 no_session 分支、镜像锁不清。
      // 必须在此就地收口：把 viewing 从死指针上摘下来并广播，再把错误交回原有链路。
      if (viewingInstanceId === disposedId) reselectViewingAfter(cwd);
      broadcastInstances();
      throw err;
    }
    if (shouldClaimViewingAfterSwap({ disposedId, viewingNow: viewingInstanceId })) {
      viewingInstanceId = ni.instanceId;
      viewingCwd = ni.cwd;
    } else if (viewingInstanceId === disposedId) {
      reselectViewingAfter(cwd);
    }
    // R7（2026-08-06）：dedupedResume 按 resumeId 合流且只有首个调用的 extra 生效——与
    // session:switch / externalDirty 置换并发时会拿到别人参数构造的实例。按实例真实档位广播，
    // 不谎报；不一致时明确告诉用户重试（否则 UI 说切成功了，而下次切回该档会被幂等闸挡掉）。
    const broadcast = resolveEffortBroadcast({ requested: level, actual: effortOf(ni.instanceId) });
    io.to('approved').emit('agent:event', {
      seq: 0, epoch: 'server', sessionId: null, instanceId: ni.instanceId, ts: Date.now(),
      type: 'effort_mode', payload: { level: broadcast.level }
    });
    if (broadcast.mismatch) {
      sysTo(socket, '思考强度切换被并发的会话操作合流，未生效，请重试', true);
    }
    broadcastInstances();
  });

  // 台阶3 新增：切视图到指定 tab。校验 instanceId ∈ live → 改 viewingInstanceId + 清该实例 done + 广播。
  on(socket, 'user:setViewing', payload => {
    const id = payload?.instanceId;
    if (!agents.has(id)) return instancesTo(socket);         // 非法/已关：拨回当前快照
    if (id === viewingInstanceId) return instancesTo(socket); // 幂等
    viewingInstanceId = id;
    const a = agents.get(id);
    viewingCwd = a.cwd;
    // B2：列表/tab 聚焦也要更新 currentByCwd（此前只 session:switch/finishOpenFocus 写指针）
    if (a.sessionId) sessions.setCurrent(a.cwd, a.sessionId);
    // 用户正在看 → 续期空闲看护，避免切入后仍因旧 lastActivity 被 30min 回收清屏
    a.touchActivity?.();
    // 切视图立即清全局 mirror（否则 catchUpTick 切换分支完成前，A 的锁仍挂着）
    clearMirrorOnViewChange();
    interactionLog.addSessionLog(a.logKey(), 'sys_info', `[SYS] 切换当前活动视图 (user:setViewing): instanceId=${id}, sessionId=${a.sessionId || '(pending)'}`);
    doneInstances.delete(id); errorInstances.delete(id); abortedInstances.delete(id);
    captureUnreadSnapshot(id); // 未读角标：进入查看 → 冻结当前累计值供前端展示 + 清零活计数器
    broadcastInstances();
    pushModelsForCwd(a.cwd); // 切视图到别区 tab：推该区清单刷新模型选择器（避免显另一 tab 工作区的候选）
    pushSlashCommandsForCwd(a.cwd); // 同 models：按区刷新 slash 提示，防别区 skill 残留
    lastStatusLine = null;
    scheduleStatusRefresh();
  });

  // 未读角标：用户点掉悬浮胶囊 / 手动翻到锚点消息附近时上报，清掉冻结快照。只认「当前正在看的实例」，
  // 防止误清后台会话（例如迟到的旧 ack、或客户端状态与服务端 viewingInstanceId 短暂不同步）。
  // 镜像视图架构下多端应一致：清除后 broadcastInstances() 让其他设备的胶囊也同步消失。
  on(socket, 'user:ackUnread', payload => {
    const id = payload?.instanceId;
    if (id == null || id !== viewingInstanceId) return;
    unreadSnapshotOnEntry.delete(id);
    broadcastInstances();
  });

  on(socket, 'user:answer', payload => {
    const { requestId, optionIndex, optionIndexes, freeText, instanceId } = payload || {};
    if (typeof requestId !== 'string') return;
    // 三选一：optionIndex / optionIndexes(multiSelect) / freeText(Other)
    const hasIdx = typeof optionIndex === 'number';
    const hasMulti = Array.isArray(optionIndexes) && optionIndexes.length > 0;
    const hasFree = typeof freeText === 'string' && freeText.trim();
    if (!hasIdx && !hasMulti && !hasFree) return;
    const opts = {};
    if (hasFree) opts.freeText = freeText;
    else if (hasMulti) opts.optionIndexes = optionIndexes;
    routeInstance(instanceId)?.resolveQuestion(requestId, hasIdx && !hasMulti && !hasFree ? optionIndex : null, Object.keys(opts).length ? opts : undefined); // 台阶3
  });

  on(socket, 'user:interrupt', payload => routeInstance(payload?.instanceId)?.interrupt()); // 台阶3：按 instanceId 路由
  // 停单个后台任务（子 agent / 后台 Bash），对应终端 Ctrl+X Ctrl+K；按 instanceId 路由。taskId 来自
  // task_notification / task_progress / background_tasks_changed 事件。stopTask 内部 disposed / 无效
  // taskId / 无 q / SDK 抛错均幂等吞掉（返回 false 不抛），故无实例（routeInstance→null）时 ?. 安全 no-op。
  // 回 ack：agent.stopTask 在 disposed / 无 taskId / 无 q / control_request 超时（10s）时返回 false，
  // 而此前这个返回值无处可去 —— 前端无条件打「已请求停止后台任务…」，任务已结束或停不掉时同样谎报成功，
  // 行继续挂到生命周期兜底（真实 id 2h / 合成键 3min）。ack 可选：旧客户端不传回调时行为不变。
  on(socket, 'task:stop', async (payload, ack) => {
    const ok = await routeInstance(payload?.instanceId)?.stopTask(payload?.taskId);
    if (typeof ack === 'function') ack({ ok: ok === true });
  });

  // 回空首页枢纽（与 session:new 分工）：
  //   home = 去看最近列表 / 换会话；live tab 全保留；**不**重置 pending mode/effort；
  //   new  = 同上 + 重置 pending + scout 强制刷模型。
  // 二者都会清 viewing + 清该 cwd 的 current 指针：空首页输入框发消息 = FRESH，避免「只想回枢纽却把字续到旧会话」。
  // 点最近列表仍走 session:switch resume。
  on(socket, 'session:home', (payload, maybeAck) => {
    const ack = typeof payload === 'function' ? payload : maybeAck;
    const obj = payload && typeof payload === 'object' ? payload : {};
    // 可选 cwd：在指定工作区上下文下开空首页（白名单内）；默认保留当前 viewingCwd。
    if (typeof obj.cwd === 'string' && obj.cwd) {
      viewingCwd = ensureWhitelisted(routeCwd(obj.cwd), workDirs);
    }
    const wasViewing = viewingInstanceId != null;
    viewingInstanceId = null;
    sessions.bumpGeneration(viewingCwd); // 该 cwd 路由代次前进：未 dispose 的旧实例后续活动不得复活指针
    sessions.setCurrent(viewingCwd, null); // 空首页 compose → FRESH（与 session:new 同；列表进入仍 resume）
    // 回空首页立即清全局 mirror，防 A 工作区 CLI 驾驶锁挂到空首页/下一会话
    clearMirrorOnViewChange();
    // 已在首页也广播一帧：空首页 defaults / models 与 viewingCwd 对齐；前端 viewing 未变时自行 showDashboard 刷列表。
    broadcastInstances();
    pushModelsForCwd(viewingCwd);
    pushSlashCommandsForCwd(viewingCwd);
    lastStatusLine = null;
    scheduleStatusRefresh();
    ensureCliDefaults(viewingCwd).then(() => {
      if (!viewingInstanceId) broadcastInstances();
    }).catch(err => console.warn('[cli-settings] session:home 刷新失败:', err?.message || err));
    if (wasViewing) {
      interactionLog.addSessionLog('server', 'sys_info', `[SYS] 回空首页 (session:home), viewingCwd=${viewingCwd}`);
    }
    if (typeof ack === 'function') ack({ ok: true, instanceId: null, sessionId: null });
  });

  on(socket, 'session:new', (payload, maybeAck) => {
    // 兼容两种调用形态：emit('session:new', cb) 与 emit('session:new', {cwd}, cb)
    const ack = typeof payload === 'function' ? payload : maybeAck;
    // #8 灰边界修：热移除目录上「仅拒新开」。若正查看该目录的 live 实例，viewingCwd 会停在已移除目录
    // （reloadWorkdirs 有实例时不归位），routeCwd 缺省回退又会返回它 → 新会话仍落非白名单目录。
    // ensureWhitelisted 归位到白名单首位（同 reloadWorkdirs 无实例时的归位）。只挡新建；继续查看/读取该
    // 目录现有会话不受影响。session:switch / user:message 共用同一份归位逻辑，见其调用点注释。
    const cwd = ensureWhitelisted((payload && typeof payload === 'object') ? routeCwd(payload.cwd) : viewingCwdOf(), workDirs);
    viewingCwd = cwd;
    sessions.bumpGeneration(cwd); // 该 cwd 路由代次前进：未 dispose 的旧实例后续活动不得复活指针
    sessions.setCurrent(cwd, null); // 台阶3：清该 cwd 当前指针 → 下条消息懒开为 FRESH 会话（非 resume）
    viewingInstanceId = null;       // 清查看 tab（**不再 dispose 任何实例**——背景 tab 继续跑），首条消息懒开
    // 新会话空窗口立即清全局 mirror（跨工作区新建最易撞「A 驾驶锁挂到 B」）
    clearMirrorOnViewChange();
    pendingModeByCwd.delete(cwd); pendingEffortByCwd.delete(cwd); // 重置 L0（防上次未发的残留被误消费）
    broadcastInstances(); // 先推一帧（可能仍是 L4 或旧 L3 缓存）；下方 force 刷新 L3 后再补广播
    pushModelsForCwd(cwd); // 有缓存即时推（快速路径），无缓存由下方 scout 补发
    pushSlashCommandsForCwd(cwd); // 有缓存即时推 slash 提示；无缓存保留前端 localStorage，首条消息真 init 校正
    // L3：强制重读 CLI settings，空首页 defaultPermissionMode/defaultEffort 与终端对齐；完成后若仍停在本 cwd 空视图则补广播。
    // scout 必须等 L3 落定后再起（对齐 config:refresh 的既有写法）：worktreeGatewayEnv 在 AgentSession
    // 构造时一次性读取、事后补不回来，冷缓存下先起 scout 会让它用被污染的网关去探模型清单。
    ensureCliDefaults(cwd, { force: true })
      .catch(err => console.warn('[cli-settings] session:new 刷新失败:', err?.message || err))
      .finally(() => {
        if (!viewingInstanceId) openScoutInstance(cwd); // 无实例：scout 获取真实模型（不留幽灵会话）
        if (viewingCwdOf() === cwd && !viewingInstanceId) broadcastInstances();
      });
    lastStatusLine = null;
    scheduleStatusRefresh();
    if (typeof ack === 'function') ack({ ok: true, instanceId: null, sessionId: null });
  });

  // session:switch 与 session:fork 的「打开/聚焦」收尾——两者此前是逐行复制的同一段（13 组语句、
  // 顺序全同），改一处必须记得改另一处。差异只在前半段（fork 多一步 sdkForkSession、用新 id；switch
  // 有 instanceForSession 去重短路），故只抽收尾，前半段留在各自调用侧。
  // 注：session:new / session:home 看似也有重复，但它们是「不带实例的空首页」语义（viewingInstanceId=null、
  // 无 inst 相关调用），且共享的 6 个调用在两处穿插位置不同（new 里夹着 pendingMode 清理与 openScoutInstance），
  // 合并需重排调用顺序——为观感冒行为风险，有意不动。
  function finishOpenFocus(inst, cwd, sessionId, ack) {
    viewingInstanceId = inst.instanceId;
    viewingCwd = cwd;
    sessions.setCurrent(cwd, sessionId); // 记为该 cwd 最后查看会话（session:list 的 currentSessionId 等）
    // 用户打开/切回本会话 → 续期空闲看护（含刚 resume 的新实例，避免随后立刻被旧时钟误判）
    inst.touchActivity?.();
    // 切会话立即清全局 mirror；catchUpTick 切换分支会按新会话尾部形态重判预锁
    clearMirrorOnViewChange();
    doneInstances.delete(inst.instanceId); errorInstances.delete(inst.instanceId); abortedInstances.delete(inst.instanceId);
    // 未读角标：与 user:setViewing 对称——首页最近列表/未打开会话走这里聚焦 live 实例时也要冻结未读，
    // 否则 sync:since 的 unreadOnEntry 恒 0、胶囊永不出现（侧栏 live 走 setViewing 已有此调用）。
    captureUnreadSnapshot(inst.instanceId);
    broadcastInstances();
    pushModelsForCwd(cwd); // 切区即时推本区清单（无缓存→空）；随后 resume 实例的真 models 兜底
    pushSlashCommandsForCwd(cwd); // 同 models：切区推本区 slash；无缓存保留前端缓存，resume 真 init 校正
    lastStatusLine = null;
    scheduleStatusRefresh();
    if (typeof ack === 'function') ack({ ok: true, instanceId: inst.instanceId, sessionId });
  }

  on(socket, 'session:switch', async (payload, ack) => {
    const sessionId = payload?.sessionId;
    // 台阶3：在指定 cwd 内打开/聚焦会话（缺省当前查看实例 cwd）。ensureWhitelisted 同 session:new(#8)：
    // routeCwd 的缺省回退(viewingCwdOf)可能仍是热移除目录（该目录有 live 实例挂着未被归位），不夯一次
    // 白名单会绕过「仅拒新开」——落到非白名单目录后 sessionFileExists 大概率会因该目录下无此 sessionId 而
    // 拒绝（ack 回 '会话不存在'），是安全的失败模式，不会误开其他目录下的会话。
    const cwd = ensureWhitelisted(routeCwd(payload?.cwd), workDirs);
    // 归属校验以「jsonl 存在于本 cwd 的 project 目录」为准：既拒跨 cwd / 失效 id，又接纳终端建的会话。
    if (typeof sessionId !== 'string' || !(await sessionFileExists(cwd, sessionId))) {
      if (typeof ack === 'function') ack({ ok: false, error: '会话不存在' });
      return;
    }
    // forSession 已跳过 terminating/disposed；命中则是可续用 live，fresh resume 仅在无 live 时。
    const live = instanceForSession(sessionId);
    // 被 CLI 后台任务占用的会话：明说打不开，不 spawn、更不杀占用者（2026-07-30，见 openResumeInstance 注释）。
    // 只在需要新 spawn 时查——已 live 说明 ccm 早就开着这个会话，此刻只是切视图，与占用无关。
    // 判据与 CLI 的 resume 前置检查同源，所以这里拒绝的正是 CLI 那边同样会拒绝的集合：不新增拦截面，
    // 只是把「白 spawn 一个必然失败的进程、再从 stderr 反解原因」提前成一次读注册表。
    if (!live) {
      const blocker = await findBlockingLiveAgent(sessionId).catch(() => null); // fail-open：读不动注册表照旧尝试
      if (blocker) {
        if (typeof ack === 'function') ack({ ok: false, error: formatSessionLockError(blocker) });
        return;
      }
    }
    // 台阶3：打开或聚焦——已 live 实例承载该会话则聚焦不重开（去重，防同会话被两实例并发 resume）；
    // 否则 open 新实例 resume（openResumeInstance 先读 transcript 恢复权限档）。**不再 dispose 同 cwd**（其他 tab 后台继续）。
    // 必须在 dedupedResume 之前 bump：若下面需要新 spawn 实例，openInstance 内会同步捕获代次快照——
    // bump 放这之后会让刚 spawn 的、本该是"当前权威"的实例反而捕获到旧代次，被自己后续 onSessionId 误判陈旧。
    sessions.bumpGeneration(cwd);
    const inst = live || await dedupedResume(cwd, sessionId);
    // B1：live 复用时把代次快照拉到当前——否则 /clear 后 onSessionId 因 generation 陈旧不写 currentByCwd
    if (inst) inst.routeGeneration = sessions.getGeneration(cwd);
    finishOpenFocus(inst, cwd, sessionId, ack);
  });

  // 从历史消息某点分叉新会话：官方 forkSession 复制 transcript 到新文件（重映射 uuid、保留 parentUuid
  // 链），upToMessageId 截到该消息为止（inclusive）；之后走与 session:switch 相同的「打开/聚焦」收尾。
  // 源会话本身不受影响（只读复制），故不需要 session:switch 那样的 liveInstance/resumeInFlight 并发守卫。
  on(socket, 'session:fork', async (payload, ack) => {
    const sessionId = payload?.sessionId;
    const uuid = payload?.uuid;
    const cwd = ensureWhitelisted(routeCwd(payload?.cwd), workDirs);
    if (typeof sessionId !== 'string' || !(await sessionFileExists(cwd, sessionId))) {
      if (typeof ack === 'function') ack({ ok: false, error: '会话不存在' });
      return;
    }
    if (typeof uuid !== 'string' || !uuid) {
      if (typeof ack === 'function') ack({ ok: false, error: '缺少分叉锚点' });
      return;
    }
    const { sessionId: newId } = await sdkForkSession(sessionId, { dir: cwd, upToMessageId: uuid });
    sessions.bumpGeneration(cwd);
    const inst = await dedupedResume(cwd, newId);
    finishOpenFocus(inst, cwd, newId, ack);
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

  // P1（7/26 CCD 调研吸收）：给会话列表行标注「终端直跑」状态。数据源是 CLI 自报的进程注册表
  // （~/.claude/sessions/<PID>.json），一次扫盘标注整页——此前纯外部终端会话在列表里没有任何运行
  // 徽标（徽标只来自 live instances 条目，外部会话无 live 实例即无徽标）。注册表读不动 → 空 Map，
  // 返回不带 terminal 的克隆列表（fail-open，且不污染 listSessionsPage 的缓存对象）。
  async function annotateTerminalStates(cwd, list) {
    let states = new Map();
    try {
      states = await listTerminalSessionStates();
    } catch { /* fail-open */ }
    return {
      list: applyTerminalStatesToSessions(cwd, list, states),
      terminalBusy: hasBusyTerminalSessionForCwd(cwd, states),
    };
  }

  on(socket, 'session:list', async (payload, maybeAck) => {
    // 兼容两种调用形态：emit('session:list', cb)（app.js 现状）与 emit('session:list', {cwd, all?}, cb)
    const ack = typeof payload === 'function' ? payload : maybeAck;
    if (typeof ack !== 'function') return;
    const obj = payload && typeof payload === 'object' ? payload : {};
    const cwd = routeCwd(obj.cwd); // 缺省查看实例 cwd
    // 数据源 = 扫 ~/.claude/projects/<编码cwd>/（与 CLI /resume 同源，含终端会话），天然按 cwd 隔离。
    // currentSessionId 取该 cwd 指针，但仅当其 jsonl 属本 cwd 才回传（否则 null）。
    const id = sessions.getCurrent(cwd);
    const currentSessionId = (id && await sessionFileExists(cwd, id)) ? id : null;
    // 每工作区历史会话默认截断到 sessionLimit（workdirs.json 可配，默认 6）；all:true（前端「显示全部」）用硬顶 MAX_SESSION_LIMIT。
    const all = obj.all === true;
    const limit = all ? MAX_SESSION_LIMIT : (sessionLimitByDir.get(cwd) ?? DEFAULT_SESSION_LIMIT);
    // hiddenIds（FR-20 两级删除 L1）：L1 删除的会话从这里过滤掉，不出现在列表里（transcript 仍在盘上）。
    const { sessions: list, hasMore } = await listSessionsPage(cwd, { limit, hiddenIds: new Set(sessions.getHiddenIds()) });
    const terminal = await annotateTerminalStates(cwd, list);
    ack({ currentSessionId, sessions: terminal.list, terminalBusy: terminal.terminalBusy, hasMore: all ? false : hasMore });
  });

  // 两级删除 L1（FR-20，承接 docs/design.md）：默认删——只从产品可见列表移除，transcript 原样保留在主机磁盘，
  // 可从终端 `claude --resume` 或再次经本产品扫盘找回（"隐藏"而非"删除"，但对用户呈现为"删除"）。
  on(socket, 'session:delete', async (payload, ack) => {
    if (typeof ack !== 'function') return;
    const { sessionId } = payload || {};
    const cwd = routeCwd(payload?.cwd);
    if (typeof sessionId !== 'string' || !(await sessionFileExists(cwd, sessionId))) {
      return ack({ ok: false, error: '会话不存在' });
    }
    // SRV-005 + SRV-NEW-004：live 驱动或 resumeInFlight 中均拒删（防 switch 打开窗口 TOCTOU）
    const delGuardL1 = canDeleteSessionGuard({
      liveInstance: !!instanceForSession(sessionId),
      resumeInFlight: resumeInFlight.has(sessionId),
    });
    if (!delGuardL1.ok) {
      return ack({
        ok: false,
        error: delGuardL1.reason === 'opening'
          ? '会话正在打开中，请稍后再从列表移除'
          : '会话正在被本产品驱动，请先结束或关闭该会话再从列表移除',
      });
    }
    sessions.hideSession(sessionId);
    if (sessions.getCurrent(cwd) === sessionId) sessions.setCurrent(cwd, null); // 别让指针继续指向一个刚被隐藏的会话
    invalidateListCache(cwd);
    audit.recordAudit({ actor: actorFromSocket(socket), action: 'session_delete_l1', target: sessionId, outcome: 'success', meta: { cwd } });
    ack({ ok: true });
  });

  // 两级删除 L2（FR-20，承接 docs/design.md）：显式二次确认（前端二次弹窗把关，本端不重复校验"是否已二次确认"
  // 这种 UI 语义——收到这个事件本身就代表用户已经过确认）——真删底层 transcript 文件，不可恢复。
  // 活跃会话保护两道，任一不过 fail-closed 拒绝（防与 claude 侧并发写分叉，§8.3 已登记启发式非完备）。
  on(socket, 'session:deletePermanent', async (payload, ack) => {
    if (typeof ack !== 'function') return;
    const { sessionId } = payload || {};
    const cwd = routeCwd(payload?.cwd);
    if (typeof sessionId !== 'string' || !(await sessionFileExists(cwd, sessionId))) {
      return ack({ ok: false, error: '会话不存在' });
    }
    // 保护① + SRV-NEW-004：无 live driver，且无 in-flight resume（switch/open 窗口）
    const delGuardL2 = canDeleteSessionGuard({
      liveInstance: !!instanceForSession(sessionId),
      resumeInFlight: resumeInFlight.has(sessionId),
    });
    if (!delGuardL2.ok) {
      return ack({
        ok: false,
        error: delGuardL2.reason === 'opening'
          ? '会话正在打开中，请稍后再删除'
          : '会话正在被本产品驱动，请先结束或关闭该会话再删除',
      });
    }
    // 保护②：transcript mtime 静默阈值——纯终端进程正驱动无法确证，mtime 新鲜即拒绝（启发式非完备）。
    const mtimeMs = await sessionFileMtime(sessionId, cwd);
    if (mtimeMs < 0) return ack({ ok: false, error: '会话不存在' });
    if (Date.now() - mtimeMs < sessionDeleteQuietMs) {
      return ack({ ok: false, error: '会话可能正被终端使用，请稍后再试' });
    }
    // 原子性：先删指针（隐藏 + 清当前指针），后删文件——万一进程在两步之间崩溃，宁可留一个"已隐藏但
    // 文件还在"的孤儿文件（用户看不到、无害），也不要出现"指针还在指向一个已被删文件"的悬空引用。
    sessions.hideSession(sessionId);
    if (sessions.getCurrent(cwd) === sessionId) sessions.setCurrent(cwd, null);
    invalidateListCache(cwd);
    try {
      await sdkDeleteSession(sessionId, { dir: cwd }); // 官方 API：真删 {sessionId}.jsonl + 子 agent transcript 子目录
    } catch (err) {
      console.error(`[session-delete] L2 删除底层文件失败 sessionId=${sessionId}:`, err.message);
      audit.recordAudit({ actor: actorFromSocket(socket), action: 'session_delete_l2', target: sessionId, outcome: 'partial_failure', meta: { cwd } });
      return ack({ ok: false, error: `已从列表移除，但底层文件删除失败：${err.message}` });
    }
    sessions.unhideSession(sessionId); // 文件已真删，隐藏名单不必再为它长期占位
    // 必须【再失效一次】：上面那次 invalidate 发生在 sdkDeleteSession 之前，而真删要跑 git worktree list
    // 子进程、耗时可观。这段窗口里任何一次 session:list（另一台设备的 SWR revalidate、首页跨工作区聚合）
    // 都会把「仍含该会话」的扫盘结果重新写进 4s TTL 的 _listCache——那次响应因 hiddenIds 还在而看不出异常，
    // 但 unhideSession 之后隐藏名单没了，缓存里的它就变成正常行返回，点开报「会话不存在」。
    invalidateListCache(cwd);
    audit.recordAudit({ actor: actorFromSocket(socket), action: 'session_delete_l2', target: sessionId, outcome: 'success', meta: { cwd } });
    ack({ ok: true });
  });

  // 保守部署一键回只读：.env FILE_EDIT=off 即不传 writeFileInScope，files:write 走 unavailable
  // （同 statusOff/statusBridgeOff 的「=== 'off'」既有开关惯例，默认启用）。
  const fileEditOff = process.env.FILE_EDIT === 'off';
  registerFileSocketHandlers({
    socket,
    on,
    routeCwd,
    getWorkDirs: () => workDirs,
    listDir,
    browseReadFile,
    listGitChanges,
    readGitDiff,
    searchFiles,
    writeFileInScope: fileEditOff ? undefined : writeFileInScope,
    audit,
    actorFromSocket,
    routeInstance,
    attributePath,
    rejectableSymlinkComponent,
    buildDiff,
    readPreview,
  });

  // 开发者模式：web 端一键重启常驻 server（dogfooding 改代码/.env 后免上电脑 kickstart）。
  // 仅 DEV_MODE=1 放行；优雅退出复用 shutdown（flush sessions + dispose 实例 + close），
  // 靠 LaunchAgent/systemd 的 KeepAlive 自动拉起，前端 socket.io 自动重连 + epoch init 恢复。
  on(socket, 'dev:restart', (payload, ack) => {
    if (!DEV_MODE) {
      if (typeof ack === 'function') ack({ ok: false, error: 'DEV_MODE 未开启，拒绝重启' });
      return;
    }
    console.log('[dev] 收到 web 端重启请求，优雅退出（KeepAlive 将自动拉起）');
    if (typeof ack === 'function') ack({ ok: true });
    // 稍延后再退出，确保 ack 先发回客户端（客户端据此显示「重启中…」并等待重连）
    setTimeout(() => shutdown('DEV_RESTART'), 200);
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

  // ④ UI 安全体检：6 项运行时检查 + 全局危险白名单审查。走 on() 鉴权闸（deviceApproved fail-closed）。
  // 全程脱敏（runDoctor 只出布尔/计数/危险规则串，绝不回显明文 token/绝对路径/AUD/密钥）。
  // CLI hooks 桥的一键安装/卸载。**这是 server 唯一会写用户全局 ~/.claude/settings.json 的路径**，
  // 且只在已鉴权设备显式点击时执行——绝不在启动、连接或任何后台时机自动触发。
  // 之所以开这个口子：ccm 的主界面在手机上，而 npm 命令只能在电脑终端跑；只留 CLI 入口等于让手机
  // 用户永远发现不了这个功能（它又恰恰是终端会话能推手机的唯一通道）。
  // 实现上不复用内存里的函数，而是 spawn 安装器脚本：安装器已有全套纪律（symlink fail-closed /
  // 原子写 / 先 manifest 后 settings / 幂等 / CAS 卸载 / 回环验证），进程隔离也保证它崩了不掀翻 server。
  on(socket, 'hooks:setup', (payload, ack) => {
    if (typeof ack !== 'function') return;
    const action = payload?.action;
    if (!['install', 'uninstall', 'verify'].includes(action)) return ack({ ok: false, error: '未知操作' });
    execFile(process.execPath, [join(HERE, 'scripts', 'hooks-bridge-setup.js'), action], {
      cwd: HERE, timeout: 20000, maxBuffer: 256 * 1024,
    }, (err, stdout, stderr) => {
      const state = refreshHooksInstallState();
      // 服务端留痕：这是 server 唯一会改用户全局 ~/.claude/settings.json 的动作，只有前端弹报告
      // 不够——事后想查"这台机器上的 hooks 是谁什么时候装的"，得能在服务日志里翻到。
      console.log(`[hooks] 经 UI ${action} ${err ? '失败' : '完成'}，当前安装态=${state}`
        + (err ? `：${String(err.message || err).split('\n')[0]}` : ''));
      broadcastInstances(); // 安装态变了 → 面板/镜像提示即时跟上
      // 报告直接回传安装器的人类可读输出（含四种结局文案），前端原样展示，不在两处各写一套话术
      const report = String(stdout || '').split('\n').filter(l => l && !l.trim().startsWith('{')).join('\n').trim();
      ack({
        ok: !err,
        state,
        report: report || String(stderr || '').trim().split('\n').slice(-3).join('\n') || (err ? '执行失败' : ''),
      });
    });
  });

  // 测试推送：自己验"推送到底通不通"，不必等真事件。今晚的教训——机主一直以为推送在工作，
  // 实际上从未订阅成功过，而界面上没有任何办法自证。与「▶ 试听提示音」同一心智（那个验本地
  // 提示音，这个验远端推送链路）。没有订阅时如实回报"没有收件人"，这本身就是最有用的诊断。
  on(socket, 'push:test', async (_payload, ack) => {
    if (typeof ack !== 'function') return;
    const before = metrics.snapshot().counters;
    const title = '🔔 测试推送 · ccm';
    await pushNotify(title, '如果你看到这条，推送链路是通的');
    ntfyNotify(title, '如果你看到这条，推送链路是通的', ntfyMetaFor('result', {}, notify.publicUrl));
    const after = metrics.snapshot().counters;
    const sent = (after.push_success ?? 0) - (before.push_success ?? 0);
    const failed = (after.push_failure ?? 0) - (before.push_failure ?? 0);
    console.log(`[push] 测试推送：成功 ${sent} 条、失败 ${failed} 条`);
    ack({ ok: true, sent, failed, subscribed: sent + failed > 0 });
  });

  on(socket, 'doctor:run', (_payload, ack) => {
    if (typeof ack !== 'function') return;
    ack(runDoctor({
      authToken: AUTH_TOKEN,
      claudeVersion: versions.cli,
      workDirs,
      home: homedir(),
      cfEnabled: isAccessEnabled(),
      cfAudSet: !!process.env.CF_ACCESS_AUD,
      webStatuslineOff: process.env.WEB_STATUSLINE === 'off',
      pushEnabled,
      trustedDevices: getTrustedCount(),
      pendingDevices: getPendingDevices().length,
      // BE-013/L1：.env 在项目根、data/*.json 在实际数据目录（CCM_DATA_DIR 可把它移出仓库）——两者必须分开传。
      // 早前把 CCM_DATA_DIR 当 rootDir 传，拼出 <CCM_DATA_DIR>/data/... 永不存在 → 扫 0 个文件 → 恒报绿。
      configPermsProblems: countConfigPermProblems(HERE, { dataDir: process.env.CCM_DATA_DIR || null }),
    }));
  });

  // 服务状态面板（NFR-15 可见性）：一次 ack 拼齐 基础(startedAt/versions) + 判定化告警(computeServiceHealth)。
  // 不带裸计数器——那是 /metrics 巡检端点的机器原料，对人无参照系不可解读（判定化改造，见 plans）。
  // 走 on() 鉴权闸（deviceApproved fail-closed，运行状态属敏感数据）；重启提示不进 payload——
  // 前端已有 _serviceRestartNoticeActive（instances 广播维护），面板直读，避免二次写 localStorage 基线。
  on(socket, 'service:status', (_payload, ack) => {
    if (typeof ack !== 'function') return;
    const health = computeServiceHealth();
    ack({
      ok: true,
      startedAt: SERVICE_STARTED_AT,
      versions,
      deliveryFailure: health.deliveryFailure,
      rateLimitLockout: health.rateLimitLockout,
      clientError: health.clientError,
      hooksBridge: health.hooksBridge, // 面板「终端会话推送」段：显示安装态 + 一键安装/卸载
      // 日志开关可见性：DEBUG_SDK_MESSAGES 长开曾把日志刷到 149M 而无任何界面可见——
      // 面板「日志开关」行据此渲染（sdkDebug 开着标黄）。env 启动时定死，ack 时读即最新。
      logging: {
        interactions: process.env.LOG_INTERACTIONS === '1', // 同 interaction-log.js:11 的判定
        sdkDebug: !!process.env.DEBUG_SDK_MESSAGES,         // 同 agent.js 诊断 tap 的 truthy 判定
        stderr: !!process.env.LOG_STDERR,                   // 同 agent.js:187 的 truthy 判定
      },
      timestamp: Date.now(),
    });
  });

  // 「刷新消息」（前端按钮文案）：mirror 横幅的确定性追平入口——强制触发一次 catchUpTick（正常 2.5s 自动跑，
  // 这里给「我要确定是最新的」一个即时按钮）。无 payload、无 ack：结果经既有 history_append/mirror_state 广播。
  on(socket, 'mirror:syncNow', () => { catchUpTick().catch(() => {}); });

  // 「刷新配置」（CLI 配置刷新按钮）：ensureCliDefaults 结果按 cwd 缓存，只在启动预取 / session:new /
  // session:home 才 force 重读；用户在终端侧改了 ~/.claude/settings.json 后，web 端 compose 页默认档
  // 摘要不会自动感知——这里给一个手动兜底入口：force 重读该 cwd 的 CLI settings 并广播，前端摘要经
  // 既有 instances 广播路径（refreshComposeDefaultsSummary）自动刷新，不需要新的渲染逻辑。
  // ensureCliDefaults 内部已 try/catch 不抛（失败落 L4 硬默认形状），这里的 try/catch 是双重兜底，
  // 保证 broadcastInstances/ack 本身出岔子时也不把 socket 处理器崩掉。
  on(socket, 'config:refresh', async (payload, ack) => {
    const cwd = routeCwd(payload?.cwd); // 缺省/越界回落 viewingCwd（含白名单校验，同 session:history）
    try {
      await ensureCliDefaults(cwd, { force: true });
      // 模型缓存也须刷新：modelsCache / defaultModelByCwd / init-cache.json 可能因终端侧改 settings 而过期。
      // 先清旧缓存（前端立即知道模型列表不可用），再由活跃 agent fetchModels 或 scout 补新值。
      modelsCache.delete(cwd);
      defaultModelByCwd.delete(cwd);
      saveInitCache();
      // 有活跃 agent → 调其 fetchModels 刷新；无 → 先清除旧 scout（其 CLI 用旧 settings spawn），再起新 scout
      // fetchModels 是 fire-and-forget（agent.js:307 静默吞错），失败时缓存永久空——5s 后兜底检查，
      // 若缓存仍空则启动 scout 补救（scout 20s 超时，不依赖活跃 agent 的 SDK 调用）。
      let usedAgent = false;
      for (const a of agents.values()) {
        if (a.cwd === cwd && !a.disposed) { a.fetchModels(); usedAgent = true; break; }
      }
      if (!usedAgent) { disposeScoutFor(cwd); openScoutInstance(cwd); }
      else setTimeout(() => { if (!modelsCache.get(cwd)) { disposeScoutFor(cwd); openScoutInstance(cwd); } }, 5000);
      broadcastInstances();
      if (typeof ack === 'function') ack({ ok: true }); // ack 表示「刷新已启动」，模型可能数秒后才到达（scout/agent 异步）
    } catch (err) {
      console.warn('[cli-settings] config:refresh 失败:', err?.message || err);
      if (typeof ack === 'function') ack({ ok: false });
    }
  });

  on(socket, 'sync:since', async (payload, ack) => {
    const { sessionId, lastSeq, instanceId } = payload || {};
    // ack {replayed, gap, found, diskLen}：replayed=0 表示该实例无可回放的缓冲（如刚 open 尚未跑/重启后空），
    // 客户端据此回落到 session:history 回显，避免整页刷新后空屏。found=false 专指「实例已没了」
    // （dispose/重启/effort 切档换 instanceId）——与「实例还在、只是没新事件」的 replayed=0 区分开，
    // 让重连客户端能据此清屏重载历史（connect 路径不像 bindView 那样先 clearView，无法靠 replayed 自辨）。
    // diskLen=磁盘 transcript 的 history 条数（仅 replayed=0 时读、带回）：供前端切入对账「离开期间被终端外部
    // 写入」的盲区——磁盘比前端已渲染长即清屏全量重载（见 logic.js shouldReloadOnEnter）。
    // unreadOnEntry：进入/回到这个实例时应展示的未读胶囊数字，取自 captureUnreadSnapshot 冻结的快照
    // （user:setViewing / session:switch / 断线重连 / 设备批准写入）。默认 0（未指定不展示）。
    const done = (replayed, gap, found = true, pending = null, diskLen = null, unreadOnEntry = 0) => {
      if (typeof ack === 'function') ack({ replayed, gap: Boolean(gap), found: Boolean(found), pending, diskLen, unreadOnEntry });
    };
    const a = routeInstance(instanceId); // 台阶3：续传指定 tab 实例的缓冲（缺省 viewingInstanceId）
    if (!a || a.sessionId !== sessionId) { metrics.inc('catch_up_reloads'); return done(0, false, false); } // 无匹配实例：客户端清屏重载历史（NFR-15 重载：仅计后端能确证的触发；前端因 diskLen 盲区的重载后端不可观测、不计）；亦会在下个 live 事件凭 epoch 自愈
    const { events, gap } = a.eventsSince(Number(lastSeq) || 0);
    if (gap) { // #13：有缺口时明确告知，客户端可整段重渲染，不把残缺当完整
      socket.emit('agent:event', {
        seq: 0, epoch: 'server', sessionId, instanceId: a.instanceId, cwd: a.cwd, ts: Date.now(),
        type: 'system', payload: { message: '部分历史已超出缓冲窗口，可能有缺失' }, replay: true,
      });
    }
    // replay:true：标记这批是补发而非实时到达，前端 dispatch() 据此置位 isReplayBatch 供 alertCue 静音判断
    // （防"切回会话把离开期间攒的多轮 result/error 逐条连响"）。必须 clone，不能原地改 envelope——
    // 该对象存于环形缓冲，可能被其他 socket 的后续 sync:since 调用复用，原地写会互相污染。
    // 转发已有类型的 envelope（非内联构造新事件），拆成具名变量而非内联字面量，避免 agent-event-contract
    // 静态扫描器把它误判为"缺 type 字段的新事件类型"（type 其实继承自 envelope.type，已在源头登记过）。
    for (const envelope of events) {
      const replayEnvelope = { ...envelope, replay: true };
      socket.emit('agent:event', replayEnvelope);
    }
    // replayed 仅计“对话内容”事件：models 是 start() 里 fetchModels 推送的元数据（连接时按 cwd 已重放），
    // 若计入会把“刚 resume/预热、缓冲里只有一条 models”的实例误判为“已有内容”→ 前端 bindView
    // 跳过 loadHistory → 切入后聊天区空白（jsonl 历史从不加载）。排除后这类实例 replayed=0，前端正确回落
    // session:history。events 仍全量回放（前端要 models 填模型/effort 下拉），仅计数口径变。
    const replayed = events.filter(e => e.type !== 'models').length;
    // 仅 replayed=0（活缓冲无可回放对话内容）时读磁盘 history 条数带回——正是「切入可能被外部写过的会话」候选；
    // replayed>0=web 活跃、信活缓冲、不必对账磁盘。getSessionHistory 有 mtime 缓存，成本可忽略。
    let diskLen = null;
    if (replayed === 0) {
      try { diskLen = (await getSessionHistory(a.sessionId, a.cwd)).length; } catch { diskLen = null; }
    }
    // 状态对账：随 ack 带回该实例当前未决审批/提问快照。pendingPermissions/pendingQuestions 是权威真相，
    // 原始 permission_request/question 事件可能已被环形缓冲 trim 或切视图时被前端分流丢弃——前端在视图稳定后
    // （所有 clearView 之后，尤其 gap→重载路径）据此重建卡片，杜绝「角标 ⚠️ 待审批但会话内无卡片」。
    // unreadOnEntry 只在这就是当前查看实例时才有意义——captureUnreadSnapshot 只对 viewingInstanceId 写入，
    // 非当前查看实例的快照要么不存在要么是上一轮陈旧值，不应被当前这次 sync:since 误报出去。
    const unreadOnEntry = a.instanceId === viewingInstanceId ? (unreadSnapshotOnEntry.get(a.instanceId) || 0) : 0;
    done(replayed, gap, true, a.pendingRequestsSnapshot(), diskLen, unreadOnEntry);
    // 切入/切回后 clearView 会先把 statusline 藏掉；setViewing/switch 的 300ms 防抖刷新可能已在 clearView
    // 之前发出并被清空。此处在 sync 完成后再强制重发一次（清 lastStatusLine 防 key 去重把「已发过但被 clearView 擦掉」的那次吞掉），
    // 保证冷路径/缓存路径都有 statusline 上屏，不依赖下一次 tool 事件。
    if (a.instanceId === viewingInstanceId) {
      lastStatusLine = null;
      scheduleStatusRefresh();
      // 切回/重连：task_progress 是 transient（不进环形缓冲、上面 events 回放拿不到）→ 有活后台任务时
      // 重发全量快照，前端 onProgress 按 tasks 数组幂等 reconcile 重建任务明细横幅（否则要等下一次心跳）。
      if (a.hasBgTasks?.()) a.emitBgTasksSnapshot();
    }
  });

  // 连接 RTT 探活：客户端定时 emit，服务端立即 ack。无业务副作用、不进缓冲。
  // 走裸 socket.on（不经 on() 的 deviceApproved 闸）——待审批设备也能看到网络延迟，与「已连上但等审批」语义一致。
  socket.on('conn:ping', (_payload, ack) => {
    if (typeof ack === 'function') ack({ ok: true, t: Date.now() });
  });

  on(socket, 'logs:get', (payload, ack) => {
    if (typeof ack !== 'function') return;
    const id = payload?.instanceId || viewingInstanceId;
    const a = agents.get(id);
    if (!a) {
      // 实例已不存在（tab 已关闭/实例被回收）：诊断记录挂在 sessionId 上不随实例销毁而销毁，
      // 显式传 sessionId 仍可查——只有 interactionLog 依赖 provisional key 体系，实例没了查不到。
      const sid = typeof payload?.sessionId === 'string' ? payload.sessionId : null;
      return ack({ logs: [], diagLogs: sid ? diagLog.getDiagLogs(sid) : [] });
    }
    // FRESH 首轮 sessionId 未到：读 provisional 缓冲；init rebind 后读真 sessionId
    const logs = interactionLog.getSessionLogs(a.logKey());
    const diagLogs = diagLog.getDiagLogs(a.logKey());
    ack({ logs, diagLogs });
  });

  // PWA 后台推送修复：前台/后台切换时客户端上报 presence（见 public/js/app.js 的 visibilitychange/
  // pagehide/connect handler），记在 socket.data.hidden，供 result 完成通知判定"approved 房间里是否
  // 还有前台连接"使用（hasForegroundApprovedClient，src/ops/notifications.js；用法见下方 onEvent 里
  // 对 hasClients 的计算）。fire-and-forget，无 ack；未上报过 presence 的连接 socket.data.hidden 保持
  // undefined（按该函数的保守默认视为前台）。
  //
  // 「后台运行中」低优先级提示（补"切后台锁屏看不到应用还活着"的部分反馈；硬边界：PWA 做不到锁屏常驻
  // 实时指示，这里只是有活轮次时补一条"别担心，跑完会通知你"）。只在 hidden:true 上报【恰好】构成
  // "approved 房间从有前台变为无前台"的跳变、且此刻确有实例在跑（busy）时才推——判定纯函数
  // shouldNotifyBackgroundRunning（notifications.js，单测覆盖）。天然节流：同一 socket 反复上报
  // hidden:true 时，第二次调用前 hadForeground 已经因上一次上报而为 false（该 socket 早已不算前台），
  // 跳变条件不会再次成立，不需要额外的时间窗节流状态机。与 result 完成通知共用 web-push/sw.js 的
  // tag:'ccm-push'——真正跑完后系统通知栏/锁屏会自动把这条"运行中"替换成"已完成"，这里不需要手动
  // 撤旧推新。
  on(socket, 'client:presence', (p) => {
    const hidden = !!p?.hidden;
    if (!hidden) { socket.data.hidden = false; return; }
    const sockets = approvedSocketObjects(); // 真实 Socket 对象，mutate 前后复用同一批引用即可反映跳变前后状态
    const hadForeground = hasForegroundApprovedClient(sockets);
    socket.data.hidden = true;
    const hasForeground = hasForegroundApprovedClient(sockets);
    const hasBusyInstance = [...agents.keys()].some(id => instanceState(id) === 'busy');
    if (!shouldNotifyBackgroundRunning({ hadForeground, hasForeground, hasBusyInstance })) return;
    for (const [id, agent] of agents) {
      if (instanceState(id) !== 'busy') continue;
      // 与 result 完成通知同款 per-会话节流：重连/新 socket 会再次构成"有前台→无前台"跳变，
      // 跳变本身挡不住跨 socket 的重复；ntfy 又没有 web-push 的 tag 覆盖——不节流会在短时间内
      // 堆多条"仍在运行"。category='background' 走 finished 同款 pending:false，只受最小间隔约束。
      const sid = agent.sessionId;
      if (sid) {
        const r = throttleNotify(sid, 'background', Date.now(), notifyThrottleState, notifyThrottleMs);
        notifyThrottleState = r.next;
        if (r.throttled) continue;
      }
      const pn = notificationForBackgroundRunning({ instanceId: id, sessionId: agent.sessionId, cwd: agent.cwd });
      pushNotify(pn.title, pn.body, pn.data);
      ntfyNotify(pn.title, pn.body, ntfyMetaFor('background_running', pn.data, notify.publicUrl));
    }
  });

  // 前端全局 JS 错误上报：手机浏览器无 devtools，前端运行期错误经此落服务端日志。
  // 载荷是不可信客户端输入——校验/钳制/脱敏在 formatClientErrorLine（非法返回 null 丢弃），
  // per-socket 限流兜前端去重门失效的底。fire-and-forget，无 ack。
  const clientErrorLimiter = createSocketErrorLimiter();
  on(socket, 'logs:clientError', payload => {
    if (!clientErrorLimiter.allow()) return;
    const line = formatClientErrorLine(payload);
    if (!line) return;
    console.warn('[client-error]', socket.id, line);
    metrics.inc('client_errors'); // 服务状态可见性：手机端对这类错误的告警入口（详情在日志面板）
    metrics.gauge('client_errors_last_ts', Date.now()); // 带时间戳，供 recentIncident 判定
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
    seq: 0, epoch: 'server', sessionId: null, instanceId: viewingInstanceId, cwd: viewingCwdOf(), ts: Date.now(),
    type: 'instances', payload: instancesPayload()
  });
}

function sysTo(socket, message, recoverable) {
  socket.emit('agent:event', {
    seq: 0, epoch: 'server', sessionId: null, instanceId: null, cwd: viewingCwdOf(), ts: Date.now(),
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

// 重启 fail-closed 处置遗留 pending 审批（必须在 listen 之前：这之后 io 才可能接受连接、驱动新实例）
// + NFR-16 留存治理（启动即清一次 + 每 24h）。实现下沉 src/agent/approval-lifecycle.js。
expireOrphanedPending();
startApprovalRetentionSweep();

httpServer.listen(port, host, () => {
  // 常驻部署的日志窗口（LOG_TERMINAL=on 才开）：停止/重启时由 shutdown() 关掉。
  // **必须放在绑定成功之后**：早于此处会给一个根本没起来的 server（如端口被占）开出窗口，
  // 而那条路径退出太快、状态文件还没写完就没了，留下关不掉的孤儿窗口（实测踩到）。
  startLogTerminal({ home: homedir(), dataDir: DATA_DIR }).catch(() => {});
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
  // 启动不再自动 resume 上次会话为 viewing tab——产品决策：重启后永远停在空首页，
  // 由前端 showDashboard 展示跨工作区最近列表，用户手点才 session:switch。
  // 仍预取初始 cwd 的 CLI settings 默认，空首页 / FRESH 懒开不必等首条消息才 resolveSettings。
  // （历史：曾预热 WORK_DIR 指针并设 viewingInstanceId 省冷启动；现改为列表手选，首点会 resume 冷启。）
  ensureCliDefaults(WORK_DIR).then(() => {
    if (!viewingInstanceId) broadcastInstances();
  }).catch(err => console.warn('[cli-settings] 启动预取失败:', err?.message || err));
});

// #4：SIGINT 与 SIGTERM 都要清理（node --watch 重启、systemd、docker stop 走 SIGTERM）
function shutdown(sig) {
  console.log(`\n收到 ${sig}，正在关闭…`);
  sessions.flushSaveSync(); // B4：防抖窗口内未落盘的状态同步写入
  clearInterval(statusInterval);  // E16：node --watch 的 SIGTERM 重启路径必须清定时器
  clearTimeout(statusDebounce);   // （在途 git execFile 由 2s timeout 与进程退出收割）
  mirrorEngine.stop();     // 只读追平定时器（.unref 不阻止退出，但清掉避免关闭期间噪音回调）
  hooksInbox.close();             // 关 hooks 投递箱 watcher + 防抖定时器（同上：避免关闭期间回调）
  stopLogTerminalSync({ dataDir: DATA_DIR }); // 同步关日志窗口：下面就 process.exit，异步来不及
  // SRV-NEW-007：清 bgBroadcast 合并定时器，防 agents.clear 后仍 fire broadcastInstances
  if (bgBroadcastTimer) { clearTimeout(bgBroadcastTimer); bgBroadcastTimer = null; }
  for (const a of agents.values()) a.dispose(); // 台阶2：遍历所有目录实例——各自杀子进程、deny 挂起审批
  agents.clear();
  // dispose() 内部对每条挂起审批调 resolvePermission('deny') → 触发 approval-store 的防抖写；必须在
  // dispose 循环之后 flush，早于 process.exit 落盘，否则这些"干净关闭时已 deny"的终态会连同其在途的
  // 200ms 防抖窗口一起丢失、变成下次启动时被误判为"崩溃遗留"的 pending（虽仍会被重启恢复兜底标 expired，
  // 但那本该是清晰的用户可见 deny，不该退化成一条不知情由的系统失效记录）。
  approvalStore.flushSaveSync();
  audit.flushSaveSync();
  io.close(() => process.exit(0)); // 主动关所有 socket 连接再关底层 http server；否则 WS 长连接把 close 回调拖到 3s 兜底才退（实测断连窗口 ~3.5s → 近乎即时）
  setTimeout(() => process.exit(0), 3000).unref(); // 兜底：io.close 万一挂起仍强退
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
// 兜底：端口被占、未捕获异常等路径不走 shutdown()，日志窗口会留到下次启动才被清。
// 'exit' 只允许同步收尾，stopLogTerminalSync 正好是同步的；与 shutdown() 里那次幂等（状态文件已清则直接返回）。
process.on('exit', () => { try { stopLogTerminalSync({ dataDir: DATA_DIR, log: { log() {} } }); } catch { /* 退出中，尽力而为 */ } });

// 导出供集成测试使用
export { httpServer, io, port };
