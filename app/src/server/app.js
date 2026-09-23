// app.js —— Express 静态托管 + Socket.IO 契约层；环境已由根 server.js 在动态导入前加载。
// 会话与 socket 解耦：AgentSession 挂在服务端（4c 物理不变量），事件 io.emit 广播（多设备同看）。
//
// 分层边界（check-import-boundaries 硬闸）：本文件是唯一组装根——低耦合机制已下沉
// （notify-channels/device-gate/approval-lifecycle/http/socket/instance-*），留在这里的
// mirror/catchUp 同步引擎、openInstance 生命周期、契约路由共享同一组顶层可变状态
// （viewing*/mirror*/catchUp*），拆开只会把耦合变成上下文对象穿针——有意保留为组装根本体。
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { statSync, readFileSync, existsSync, mkdirSync, appendFileSync, unlinkSync, accessSync, openSync, readSync, closeSync, constants as fsConstants } from 'node:fs';
import { createConnection } from 'node:net';
import { parse as dotenvParse } from 'dotenv';
import { maskToken, sanitize } from '../shared/sanitizer.js';
import { setCapped } from '../shared/bounded-map.js';
import { resolveBindPlan } from '../shared/bind-host.js';
import { writeOwnerOnlyFile, rejectableSymlinkComponent, resolveExecutableViaPath } from '../files/file-security.js';
import { homedir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { execSync, execFile, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import express from 'express';
import { Server } from 'socket.io';
import { AgentSession } from '../agent/agent.js';
import { deleteSession as sdkDeleteSession, forkSession as sdkForkSession, resolveSettings as sdkResolveSettings } from '@anthropic-ai/claude-agent-sdk';
import { resolveFreshPrefs, resolveResumeEffort, defaultsFromEffectiveSettings, permissionRulesFromEffectiveSettings, normalizePermissionMode, normalizeEffortUiLevel, parseWorktreeCanonicalRoot, buildWorktreeGatewayEnv, countNeutralizableGatewayKeys, decideWorktreeSettingsAction } from '../agent/cli-settings-defaults.js';
import * as sessions from '../sessions/sessions.js';
import * as readState from '../sessions/read-state.js';
import { getSessionHistory, readSubagentFlow, listSessionsPage, listSessionsByIds, sessionFileExists, sessionExistsInWorkspace, sessionFileMtime, getProjectDir, invalidateListCache, readLastPermissionMode, readLastAssistantModel, peekSessionListTitleTimed, classifyTranscriptTail } from '../sessions/history.js';
import * as diagLog from '../agent/diag-log.js';
import { notificationForEvent, notificationForCliHook, notificationForDeviceRequest, ntfyMetaFor, throttleNotify, clearNotifyPending, NOTIFY_CATEGORY, DEVICE_NOTIFY_KEY, DEVICE_NOTIFY_INTERVAL_MS, STALL_NOTIFY_INTERVAL_MS, isValidPushSubscription, hasForegroundApprovedClient, shouldNotifyBackgroundRunning, notificationForBackgroundRunning, notifyHasClientsAtSend } from '../ops/notifications.js';
import { decideHookEventActions, resolveHookDirs, readHooksInstallState } from '../ops/cli-hooks-bridge.js';
import { startLogTerminal, stopLogTerminalSync } from '../ops/log-terminal.js';
import { createHooksInbox } from './hooks-inbox.js';
import { createNotifyChannels } from '../ops/notify-channels.js';
import { formatClientErrorLine, createSocketErrorLimiter } from '../ops/client-error-log.js';
import { attributePath, buildDiff, readPreview } from '../files/file-preview.js';
import { runDoctor, countConfigPermProblems } from '../ops/doctor-runtime.js';
import {
  applyConfigChanges,
  CONFIG_FILE_NAME,
  createConfigReloader,
  loadConfigSources,
  reloadKindOf,
  structuredToStringValues,
} from '../ops/config-file.js';
import { applyEnvChanges } from '../ops/env-file.js';
import { buildEnvView, validateEnvChanges } from '../ops/env-schema.js';
import { dataFile } from '../shared/data-dir.js';
import { isSupervised, parseLaunchctlList, willBeRespawned } from '../ops/service-units.js';
import { createServiceSampler } from '../ops/service-sampler.js';
import { buildWebStatusLine, buildCliStatusLine, projectNameFromCwd, getFallbackUsageRate, getFallbackUsageAgeMs, noteStatusRefreshBusy, strongerStatusRefreshReason, statusRefreshReasonForEnvelope } from '../ops/statusline.js';
import { encodeQr } from '../shared/qrcode.js';
import { resolvePublicTarget, isProxyFronted } from '../shared/public-target.js';
import { readCliStatusSnapshot, readStatuslineInstallState, selectStatusOwner, selectStatusReplay, selectStatusSource } from '../ops/cli-statusline-bridge.js';
import { validateAttachments, saveAttachments, buildPromptText, toEventMeta, locateStoredAttachment } from '../files/uploads.js';
import * as interactionLog from '../agent/interaction-log.js';
import {
  createModelsCache,
  createCwdKeyedCache,
  isCwdDefaultModel,
  modelListSignature,
  normalizeSlashCommands,
  resolveSlashCommandsForCwd,
} from '../agent/models-cache.js';
import { createCfAccessStrategy } from '../auth/auth-strategy.js';
import { originAllowedOnPublicHost } from '../auth/origin-gate.js';
import { onAuthResult, freshState, gateCheck, rlSourceKey, clientSourceAddress, authRejection, shouldTrustCfConnectingIp, shouldTrustForwardedFor, shouldBypassDeviceApproval } from '../auth/rate-limiter.js';
import { deriveLatches } from './instance-latches.js';
import { deriveAttention } from '../sessions/attention.js';
import { listTerminalSessionStates, applyTerminalStatesToSessions, hasBusyTerminalSessionForCwd, hasWaitingTerminalSessionForCwd, findBlockingLiveAgent } from '../sessions/session-registry.js';
import { planRewind, planFork, describeRewindBlocker, readSessionEntries, rewindOutcomeVerdict, createRewindLocks, extractPromptText, listRewindCandidates, rewindStepsFor, rewindConfirmBlocked } from '../sessions/rewind-plan.js';
import { listDir, readFile as browseReadFile, writeFileInScope } from '../files/file-browse.js';
import { listGitChanges, readGitDiff, gitRepoRoot, riskyUncommittedPaths, overlapRiskyFiles } from '../files/git-workspace.js';
import { listBranches, createSessionWorktree, worktreeNameFromMessage, inspectWorktreeCleanliness } from '../files/git-worktree.js';
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
import { DEFAULT_SESSION_LIMIT, MAX_SESSION_LIMIT, MAX_LIVE_SESSIONS, SEARCH_RESULT_LIMIT, resolveWorkdirs, ensureWhitelisted, isWhitelisted, resolveManagedWorktree, resolveDrivingCwd, resolveGoneWorktreeParent, instanceAuthorizedDirs, resolveWorkdirsFilePath, resolveWorkdirSource, resolveEnvPrimaryWorkdir } from '../sessions/workdirs.js';
import {
  isDeviceTrusted,
  isValidDeviceToken,
  noteAuditedExternally,
  addPendingDevice,
  getLatestPendingDevice,
  approveDevice,
  denyDevice,
  getPendingDevices,
  getTrustedCount,
  getTrustedDeviceIds,
  decideRevokeByShortId,
  resolveShortDeviceId,
  setDeviceAlias
} from '../auth/devices.js';
import { createDeviceGate } from '../auth/device-gate.js';
import * as approvalStore from '../agent/approval-store.js';
import { expireOrphanedPending, startApprovalRetentionSweep } from '../agent/approval-lifecycle.js';
import * as audit from '../ops/audit.js';
import * as metrics from '../ops/metrics.js';
import { getShellEnvSnapshot, parseServerConfig } from '../ops/config.js';
import {
  clientIp,
  configureHttpShell,
  createHttpAuth,
  registerOperationalRoutes,
  tokenMatches as secureTokenMatches,
} from './http.js';
import { reachableIPv4s } from '../shared/net-addr.js';
// 只要那个布尔值：判据与 initCfAccess 同源，两处各判一套的表现是「二维码扫开进不去」且无报错指向真因
import { accessConfigured } from '../auth/cf-access.js';
import { createInstanceManager } from './instance-manager.js';
import { isInstanceBeingWatched, resolveUnreadDelta, unreadOnEntryForSync } from './unread-tracker.js';
import { createSocketEventRegistrar, registerSocketConnection } from './socket.js';
import { createMirrorEngine } from './mirror-engine.js';
import { registerFileSocketHandlers } from './socket-files.js';
import { CLAUDE_PROJECTS_DIR } from '../shared/claude-home.js';

// 公网身份提供方策略（当前唯一实现是 Cloudflare Access）。init 必须在 env 规整之后——
// server.js 先跑 loadRuntimeEnvironment 再动态 import 本模块，那个顺序被
// tests/unit/source-layout.test.mjs 钉住。CF_ACCESS_* 三项齐全才启用；缺则 ownsHost 恒 false，
// 全部请求回退 AUTH_TOKEN 路。下面 HTTP 鉴权 / socket 握手 / index.html 注入 / doctor 都用它，
// 不再各自 import 具体实现（见 src/auth/auth-strategy.js 的说明）。
const authStrategy = createCfAccessStrategy();
authStrategy.init();

// 三层向上：本文件在 app/src/server/，仓库根在 app/ 之外——data/、scripts/、ccm.config.json
// 都住在仓库根，不随运行时代码进 app/。少一层会让它们全部解析到 app/ 下（且无语法错误）。
const HERE = join(import.meta.dirname, '..', '..', '..'); // 项目根；从任何 cwd 启动都一致
// 测试隔离覆盖（同 CCM_TRUSTED_DEVICES_FILE / CCM_AUDIT_FILE 等既有惯例）：生产上这两个路径
// 必须锚定仓库根（这正是"面板读写目标与启动时读的必须同源"这条不变量的落点，不能靠 cwd 或
// CCM_DATA_DIR 重定向——那样会削弱它），但集成测试若要真实验证 env:set 的写入路径，此前没有
// 任何隔离口子，一旦发送非空 changes 就会实打实地改到仓库根那份真实 ccm.config.json/.env。
const ENV_FILE_PATH = process.env.CCM_ENV_FILE_PATH || join(HERE, '.env'); // 旧格式；仅在尚未迁移时读写
const CONFIG_FILE_PATH = process.env.CCM_CONFIG_FILE_PATH || join(HERE, CONFIG_FILE_NAME); // 统一配置文件，优先于 .env

// 面板读写的目标必须与 src/ops/config.js 启动时**读的那一份**是同一个文件。
// 分流写错的后果不是报错而是假成功：用户改完看到「已写入」，重启后毫无变化 ——
// 与 CF_ACCESS_* 被 dotenv 吞掉那次是同一种失效形态（fail-open + 假成功）。
const usingConfigJson = () => existsSync(CONFIG_FILE_PATH);

const canAccessPath = (p, mode) => {
  try {
    accessSync(p, mode);
    return true;
  } catch {
    return false;
  }
};

// 纯 TCP 探测：不发 HTTP 请求行 ⇒ 不经过鉴权中间件 ⇒ 不计入登录限速。
// 只用于「改 PORT 前看新端口空不空」，500ms 截止。
const probeLocalPort = (port) => new Promise(resolve => {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return resolve(false);
  const conn = createConnection({ port, host: '127.0.0.1' });
  const done = (busy) => {
    try { conn.destroy(); } catch { /* noop */ }
    resolve(busy);
  };
  conn.on('connect', () => done(true));
  conn.on('error', () => done(false));
  setTimeout(() => done(false), 500);
});
const {
  port,
  authToken: AUTH_TOKEN,
  idleTimeoutMs,
  instanceIdleReclaimMs,
  approvalTtlMs,
  notifyThrottleMs,
  sessionDeleteQuietMs,
  devMode: DEV_MODE,
  bindMode: BIND_MODE,
  bindHost: BIND_HOST,
  trustedProxy: TRUSTED_PROXY,       // 采信 XFF 的开关，已归一（只可能是 '' 或 'loopback'）
  deviceApprovalScope: DEVICE_APPROVAL_SCOPE, // 设备审批管辖面，已归一（只可能是 '' 或 'all'）
  accessProfile: ACCESS_PROFILE,     // 声明的公网方案，已归一（未知值 = ''）
  dataDir: DATA_DIR,
} = parseServerConfig(process.env, { home: homedir(), projectRoot: HERE });

// 多 repo 台阶1：可在 web 内切换的工作目录白名单（preflight 内构建，热加载可变）。
// 各项已在 resolveWorkdirs 里经 realpathSync 规范化（与 CLI 的 ~/.claude/projects 命名一致，
// 令会话列表 cwd 隔离匹配稳健，如 /tmp→/private/tmp）。
let workDirs = [];
// 主工作目录 = 列表首项。2026-09-08 前它是独立配置项 WORK_DIR，与 WORKDIRS 在装机向导里
// 必然重复第一项（setup 写的就是 `{workDir: dirs[0], workDirs: dirs}`），用户打开配置只看到
// 同一个路径写了两遍。取派生量而非另存一份：两份就会分叉，而热加载只会更新其中一份。
const primaryWorkDir = () => workDirs[0];
// 每工作区历史会话显示条数（session:list 默认截断量）；未指定的目录用 DEFAULT_SESSION_LIMIT。
let sessionLimitByDir = new Map();

let notifyThrottleState = new Map(); // per-会话推送节流态，sessionId → {[category]:{notifiedAt,pending}}；
                                      // 纯函数返回全新 Map，直接整体替换引用（非 mutate）
// n1: N1-MSG-DEDUP 进程内单例、重启清零、不分账号——message-dedup.js 自身是纯函数，状态由这里持有。
//     重启后同一 clientMessageId 会被当成新消息（n=1 下可接受：重启本就中断在途轮）。
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
const { pushEnabled, pushNotify, ntfyNotify, savePushSubscription, removePushSubscription } = notify;

// 通知会话段对齐抽屉浏览标题（SDK summary / ai-title），不是 sessions.json 里截断的首条用户消息。
// 读盘/SDK 失败回落 firstMessage，不挡这条通知。节流仍在调用方同步完成，避免 peek 期间重复放行。
async function sessionTitleForNotify(cwd, sessionId) {
  const fallback = sessions.getSession(sessionId)?.title || '';
  const drawer = await peekSessionListTitleTimed(cwd, sessionId);
  return drawer || fallback;
}
function emitNotify(pn, ntfyType) {
  if (!pn) return;
  pushNotify(pn.title, pn.body, pn.data, pn.previewBody);
  ntfyNotify(pn.title, pn.body, ntfyMetaFor(ntfyType, pn.data, notify.publicUrl));
}

// ---- 工作区白名单：读取源 + 应用（preflight 与热加载共用）----
// 读取原始条目源：WORK_DIRS_FILE（JSON 数组文件，优先）或 WORK_DIRS（逗号分隔，向后兼容）。
// 文件读/解析失败 → 返回 null（调用方保留旧配置，不清空白名单）。
// 统一配置文件里的内联工作区列表（P1b）。返回 null = 没写这一项，回落到旧的两条路径。
//
// 每次调用重读文件而不是用启动时的快照：热加载路径本来就要重读，而这个 JSON 只有几 KB。
// 换来的是零新增模块级状态 —— 与 CLAUDE.md「新状态别再落 app.js 顶层」一致。
// 一次读出配置文件里跟工作区有关的两项：列表本身，以及退役中的 WORK_DIR。
// 分两次读文件会在编辑器保存到一半时读出互相矛盾的两半。
function readInlineWorkdirConfig() {
  if (!usingConfigJson()) return { list: null, primary: '' };
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_FILE_PATH, 'utf8'));
    return {
      list: Array.isArray(parsed?.WORKDIRS) ? parsed.WORKDIRS : null,
      primary: typeof parsed?.WORK_DIR === 'string' ? parsed.WORK_DIR : '',
    };
  } catch {
    return { list: null, primary: '' }; // 坏 JSON：启动期 loadConfigSources 已经 fail-loud 过，这里静默回落即可
  }
}

// 返回 { result, warnings }；result === null 表示读/解析失败（调用方保留旧白名单，不清空）。
//
// 优先级判定与主目录折叠都在 workdirs.js 的 resolveWorkdirSource（纯函数、有单测），
// 这里只负责读 env / 读文件这两件带副作用的事。CLI doctor 的 D3 走同一个函数 —— 判据分叉过一次，
// 那次是 doctor 自己写了 `if (Array.isArray(inline)) return`，把 WORK_DIRS env 吃掉了。
function readWorkdirSource() {
  const inline = readInlineWorkdirConfig();
  const { result, warnings } = resolveWorkdirSource({
    envList: (process.env.WORK_DIRS || '').split(',').map(s => s.trim()).filter(Boolean),
    envFile: process.env.WORK_DIRS_FILE,
    inline: inline.list,
    here: HERE,
    // 【不能裸读 process.env.WORK_DIR】loadRuntimeEnvironment 把配置文件的值也投影了进去，
    // 那时它可能是文件给的，而 pickPrimaryWorkdir 对 envPrimary 无条件放行 —— 结果是配置文件里
    // 留着退役的 WORK_DIR 时 `export WORK_DIRS=...` 收窄不掉授权面。判据见 resolveEnvPrimaryWorkdir。
    envPrimary: resolveEnvPrimaryWorkdir({
      shellEnv: getShellEnvSnapshot(),
      projectedPrimary: process.env.WORK_DIR || '',
    }),
    inlinePrimary: inline.primary,
  });
  return { result, warnings };
}
// 应用条目：realpath 校验 + 设 workDirs / sessionLimitByDir。列表首项即主工作目录。
// 返回 warnings[]（调用方决定打印）。
//
// 【这里曾经是 `const nextDirs = [WORK_DIR]`】那句无条件插入让显式 `export WORK_DIRS=...` 收窄不了
// 白名单的首位 —— 2026-09-01 修「内联 WORKDIRS 压过 env」时漏掉的同族分支，2026-09-08 容器内实测
// 确认仍在。顺序现在完全由来源决定，主目录的折叠在 workdirs.js 的 resolveWorkdirSource 里按来源分档。
function applyWorkdirs(source) {
  const { dirs, limits, warnings: rw } = resolveWorkdirs(source.entries);
  workDirs = dirs;
  sessionLimitByDir = limits;
  return [...source.warnings, ...rw];
}
// 热加载：重读 workdirs 源并应用。读取失败保留旧白名单；被移除目录上无 live 实例时把 viewingCwd 归位到
// 首个白名单目录（堵 routeCwd 缺省回退绕过白名单的洞）；末尾广播让前端立即刷新目录列表。免重启改工作区。
function reloadWorkdirs() {
  const { result: source, warnings: srcWarnings } = readWorkdirSource();
  if (source === null) { console.warn('⚠️  [workdirs 热加载] 读取/解析失败，保留旧白名单'); return; }
  for (const w of srcWarnings) console.warn(`⚠️  [workdirs 热加载] ${w}`);
  // 热加载路径上「一个都不剩」不能像启动期那样 exit —— 那会把正在跑的回合一起杀掉，
  // 而起因可能只是编辑器写到一半、或外置盘临时掉线。保留旧白名单是这里的正确失败方向
  //（与 source === null 同档）；SCOPE-03 的拒绝只发生在启动期，那时还没有东西可失去。
  const { dirs: probe } = resolveWorkdirs(source.entries);
  if (!probe.length) {
    console.warn('⚠️  [workdirs 热加载] 新配置里没有一个可用工作区，保留旧白名单（未生效）');
    return;
  }
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
  // 工作区白名单：条目支持 string 或 {path,sessionLimit}，来源优先级与主目录折叠都在 workdirs.js
  //（doctor.js D3 共用同一份）。单个无效项告警跳过、不挡启动；列表只剩一个的话目录切换器隐藏。
  const { result: source, warnings: srcWarnings } = readWorkdirSource();
  for (const w of srcWarnings) console.warn(`⚠️  ${w}`);
  for (const w of applyWorkdirs(source ?? { entries: [], warnings: ['WORK_DIRS_FILE 读取/解析失败'] })) {
    console.warn(`⚠️  ${w}`);
  }
  // SCOPE-03：一个可用工作区都没有时拒绝启动。
  //
  // 这里曾经不可能触发 —— WORK_DIR 无条件占首位，而它自己回落 $HOME，所以白名单最少也有一项，
  // 那一项恰好是整个家目录。删掉那条回落之后，「全部无效」就成了一个必须显式处理的真实状态：
  // 用户删了项目目录、外置盘没挂载、路径手滑写错。fail-loud 是唯一正确的方向 —— 静默起一个
  // 什么都打不开的 server，用户只会看到手机端空列表，无从知道是配置问题。
  if (!workDirs.length) {
    fail('没有可用的工作区：WORKDIRS 里的目录一个都不存在或不可达。\n'
      + `   请检查 ${CONFIG_FILE_NAME} 的 WORKDIRS，或用 node scripts/config.js set 重设。`);
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
  //
  // 【为什么这里是 execSync 而不是同文件下面那个 execFileSync】这行的 shell 拼接看着像注入面，
  // 但 claudeBin 不是请求输入：配置面板写 CLAUDE_BIN 要过 env-schema 的 mustExist + executable
  // 校验（注入串不是一个存在的可执行文件，写不进去），而直接写 env 的人就是本机所有者本人。
  // 换成 execFileSync 反而会真的坏掉一个平台——Windows 上 npm 装的 CLI 是 claude.cmd
  // （resolveExecutableViaPath 的 where 分支返回的就是它），而 execFile 不经 shell，Node 对
  // .cmd/.bat 要求 shell:true（见 child_process 文档 Windows 小节；未在 Windows 上实测）。
  // 失败被下面的 catch 吞掉不会崩，但 versions.cli 会恒为 unknown——而那一项的存在理由
  // 正是本段头注说的「升级后回归核对」。2026-09-17 安全审查评估后保留现状。
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
    // 三层向上：本文件在 app/src/server/，而 package.json 在仓库根（不随代码进 app/）。
    // 少一层会解析到并不存在的 app/package.json，被下面的 catch 静默吞掉 —— versions.server
    // 恒为 unknown，而它恰恰是本段头注说的「升级后回归核对」要用的那一项。
    versions.server = require('../../../package.json').version;
  } catch { /* 非致命 */ }
  if (!process.env.ANTHROPIC_AUTH_TOKEN && !process.env.ANTHROPIC_API_KEY) {
    console.warn('⚠️  未检测到 ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY，将依赖 claude CLI 自身的登录态');
  }
  return claudeBin;
}
const claudeBin = preflight();
// 多 repo 台阶3：viewingInstanceId = 前端当前查看的 tab 实例（台阶2 viewingCwd 的细化）。
// 切 tab 只换视图、不 dispose（各实例后台并行存活，见 agents Map）。初值 null——启动不自动 resume，空首页手选。
// n1: N1-VIEWING-INSTANCE 全服务端一个「当前查看」，非 per-连接：两台设备各看各的会话时，后切的那台会把
//     前一台的视图一起改掉。多用户/多机独立视图要先改 hard-rules §2 立场，再全链路改 per-(连接) 分流。
let viewingInstanceId = null;
// viewingCwd = 当前查看实例的工作目录上下文（新建会话选目录 / statusline git 段 / 白名单维度）。
// 必须在 preflight 之后取（workDirs 在 preflight 内才建好并经 realpathSync 规范化，否则 cwd 隔离失灵）。
// n1: N1-VIEWING-CWD 同上，全局单值：随 viewingInstanceId 一起被最后切换的那台设备决定。
let viewingCwd = primaryWorkDir();
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
  viewingCwd = workspaceCwdOf(r.viewingCwd); // 永远落工作区轴：托管 worktree 重选后不该把 viewingCwd 钉在 worktree 路径上
  // 被移除的实例若正被镜像锁，立即清全局锁；落到另一实例后由 catchUpTick 重判
  clearMirrorOnViewChange();
};
// 白名单校验 + 缺省落 viewingCwd：cwd 维度的事件（setWorkdir/session:list/new）经此解析目标 cwd。
// 合法路径 = workdirs 白名单本身（含用户把 git worktree 路径显式写入 workdirs.json 的条目），
// 外加一种派生形态：白名单目录下 `.claude/worktrees/<name>` 的托管 worktree（见下）。
const routeCwd = cwd => {
  if (isWhitelisted(cwd, workDirs)) return cwd;
  // 托管 worktree 的派生放行（2026-09-11）：CLI 的 EnterWorktree / --worktree / agent isolation
  // 把 worktree 建在 `<workdir>/.claude/worktrees/<name>`——**那条路径在白名单目录子树内**，
  // 所以这不是给范围门开口子，SCOPE-01 原样成立（判据与边界见 workdirs.js 的 resolveManagedWorktree）。
  // 不放行的话，这类会话即便列得出来也点不开：cwd 在这里被换成父仓，再拿父仓 cwd 去 resume 一个
  // transcript 根本不在那个 project 目录下的会话，症状是「点开一片空白」而不是任何报错。
  // 返回解析后的 path 而非原始入参：下游要拿它算 getProjectDir，未解析的路径在 macOS 上会静默查空。
  const managed = resolveManagedWorktree(cwd, workDirs);
  if (managed) return managed.path;
  // 越界审计信号：显式传了不在白名单的路径 → 记一条检测信号，再安全回退当前查看目录。
  // 不 fail-closed：回退本身已防越权（不访问越界目录），拒绝会破坏“传错自动纠正”顺手性 + #8 热移除回退。
  if (typeof cwd === 'string' && cwd) {
    console.warn(`[scope] 越界工作目录请求被拒：${cwd} 不在白名单，回退当前查看目录`);
    // 最小审计记录：routeCwd 调用点分散、多数无 socket 上下文可传 actor，
    // 此处 actor 留空——目录越界信号的价值在"发生过"本身，不在于精确到哪个连接（真正的访问控制
    // 已经生效，这里只是留痕，同 WorkdirScopeGuard 的既有 [scope] 日志一个粒度）。
    audit.recordAudit({ action: 'scope_violation', target: cwd, outcome: 'denied', meta: { via: 'routeCwd' } });
  }
  return viewingCwdOf();
};
// 台阶3：按实例路由（BE-001 fail-closed）——缺省（无 instanceId）落 viewingInstanceId（向后兼容缺参旧调用）；
// 显式命中 live 取该实例；显式但已关闭 → stale（id=null，绝不静默回退 viewing、绝不误投别的会话）。见 instance-routing.js。
const resolveTarget = (id, opts) => resolveInstanceTarget(id, viewingInstanceId, x => agents.has(x), opts);
const resolveInstanceId = id => resolveTarget(id).id;   // 仅取 id：显式 stale → null（不再回退 viewing），无实例的 handler 自然 no-op/echo 拨回
const routeInstance = id => { const rid = resolveInstanceId(id); return rid ? (agents.get(rid) ?? null) : null; };
// audit_record 的 actor 字段：deviceId 取握手带的 deviceToken（isLocal/CF Access
// 直连场景恒无 token，null 属正常）；via 复用既有 socket.trustBasis（'device-token'/'bypass'），
// 不新造一套分类，与 SEC-03 吊销对称逻辑用的是同一份信任来源判断。
const actorFromSocket = socket => ({ deviceId: socket?.handshake?.auth?.deviceToken ?? null, via: socket?.trustBasis ?? null });

// ---- HTTP ----
const app = express();
configureHttpShell({
  app,
  projectRoot: HERE,
  strategy: authStrategy,
});

const tokenMatches = provided => secureTokenMatches(AUTH_TOKEN, provided);
// 鉴权限速状态（socket + HTTP 共用）。仅鉴权门口，重启清零可接受。
// n1: N1-RATE-LIMIT 进程内单例、重启清零，且只挡鉴权口暴破——不对已鉴权的操作面限速（用户即 root，
//     给自己的操作限速违背产品目的，见 hard-rules §2.3）。多租户下这两条都得重来：状态要持久化，操作面要分账号配额。
const rlStates = new Map(); // sourceKey → RateLimitState
// 有界上限。这张表由【未鉴权的公网流量】驱动：服务挂在固定域名上，任何扫描器请求一次 /health
// （成功或 401 都写）就永久占一条，而全仓只有 get/set、没有任何 delete/TTL 清扫，decayMs 到期也不回收。
// 长期跑着的实例数月即单调增长。仓内其他表都有明确上限（NOTIFY_THROTTLE_CAP=500、MAX_SESSIONS=200
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
  strategy: authStrategy,
  // HTTP 与 socket 握手共享限速 Map，堵住 /health|/metrics|/push 无限试 token。
  rateLimit: {
    // AUTH-NEW-1：与 socket `publicHost || AUTH_TOKEN` 对齐——CF Access-only（空 AUTH_TOKEN）公网 Host
    // 上的 /health|/metrics|/push JWT 失败也须限速；纯本机无 token 仍不限。
    active: (req) => !!(AUTH_TOKEN || authStrategy.ownsHost(req?.headers?.host)),
    sourceKey: (req) => {
      // 公网 Host 且 peer=loopback（隧道）才采信 CF-Connecting-IP；
      // LAN 伪造 Host+CF-IP 只回落连接 IP，防拆限速桶。
      // XFF 末跳只在 TRUSTED_PROXY=loopback 显式声明 + peer=loopback 时采信（AUTH-04）。
      const publicHost = authStrategy.ownsHost(req.headers?.host);
      const peer = req.socket?.remoteAddress || req.ip || '';
      return rlSourceKey(
        { address: peer, headers: req.headers || {} },
        clientIp,
        {
          trustCfConnectingIp: shouldTrustCfConnectingIp({ publicHost, peerAddress: peer }, clientIp),
          trustForwardedFor: shouldTrustForwardedFor({ trustedProxy: TRUSTED_PROXY, peerAddress: peer }, clientIp),
        },
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
      metrics.label('rate_limit_last_source', key); // 面板据此分辨本机手滑 / 局域网 / 公网暴破（见 describeRateLimitSource）
    },
  },
  // 逐次失败也要留痕，与 socket 侧的 [conn] 日志对称。此前 HTTP 只在达阈值那一刻打一行，
  // 于是「谁把本机桶打到锁定」在日志里无迹可寻（2026-09-02 实例：审计有锁定记录，前后 10 分钟空白）。
  onAuthFailure: ({ path, key, reason }) => {
    console.warn(`[http-auth] 鉴权失败（${reason}）path=${path || '?'} source=${key || 'n/a'}`);
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
      // 两个旁路提问的触发次数（会花钱，所以要能长期巡检）。会话设置面板那份是 per-实例的、
      // 随实例消失；这里是进程级累计，「这两个功能到底触发了多少次」只有这里答得了。
      // ⚠️ 本映射表是【逐项显式】的：metrics.inc() 记下的计数器不在这里列一行就永远不会出现在
      // /metrics 输出里——记了等于没记，且没有任何报错。加计数器时必须同时加这一行。
      sideQuestionSuggestions: counters.side_question_suggestion ?? 0,
      sideQuestionRecaps: counters.side_question_recap ?? 0,
    },
    state: metrics.classifyProbeState({ failed, awaiting, notifyFailed, mobileClients }),
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
    // 只认在途轮，不是 stateOf==='busy'（后者含后台任务）。口径见 instance-manager.anyTurnRunning。
    busy: instanceManager.anyTurnRunning(),
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
    removeSubscription: removePushSubscription,
  },
  isDeviceTrusted,
  // 与 socket 握手侧 io.use 完全同源的 bypass 判据（CF Access 已验 / 真本机直连）。缺了它，
  // 走这两条路进来的设备因为从不进待审列表而永远无法被批准，/push/subscribe 恒 403。
  bypassDeviceApproval: req => shouldBypassDeviceApproval({
    accessEnabled: req.ccmAccessEnabled === true,
    deviceApprovalScope: DEVICE_APPROVAL_SCOPE,
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
const deviceGate = createDeviceGate({
  io, dataDir: DATA_DIR, onUnlockSocket: (socket) => unlockSocket(socket),
  accessBypassActive: authStrategy.isEnabled() && DEVICE_APPROVAL_SCOPE !== 'all',
});
const { unlockDeviceSockets, disconnectDeviceSockets, pendingDevicesPayload, broadcastPendingDevices,
  trustedDevicesPayload, broadcastTrustedDevices } = deviceGate;

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
    // terminalSlashCommands 一并剥离：它必须与 slashCommands 同源（见 resolveSlashCommandsForCwd
    // 头注），留着 lastInit 那份会与按 cwd 解析出的命令列表拼成错配的一对。
    const { slashCommands: _omitCmds, terminalSlashCommands: _omitTerm, ...initBase } = lastInit;
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
        ...(replayCmds ? { slashCommands: replayCmds.slashCommands, terminalSlashCommands: replayCmds.terminalSlashCommands } : {}),
      }
    });
  }
  // models 校正到当前查看 tab 的 cwd：未知工作区不重放，绝不回退别区清单（拿别的 cwd 的候选顶上
  // ＝谎报这个工作区能选什么）。不重放≠推空，理由同 pushModelsForCwd：推空会摧毁前端网格。
  // 注意前端此时确实是空的——modelsList 是内存态，localStorage 里没有 models 缓存（只存了
  // auth_token / current_session / slash_commands 等）。空网格由 #modelGridEmpty 就地说明，
  // 真 models 由后续 scout/实例 fetchModels 补发时校正。
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
  mirrorStateTo(socket); // 解锁这一刻起该 socket 才第一次拿到只读快照——不经过 connection 回调，漏了会一直假当成可写
  scheduleStatusRefresh();
}

// 配置类文件的变更监听（workdirs.json 与 ccm.config.json 共用）。
//
// 与 trusted-devices 直接 watch 文件不同：这两个都由人用编辑器改，而 VS Code/vim 默认原子写
// (rename 换 inode) 会让对旧 inode 的 watch 永久失聪 → 改为 watch 其目录并过滤 basename
// （对子文件替换免疫）。300ms 防抖。
//
// mtime 前置守卫：相对路径时 dirname 可能是整个项目根，且部分平台(Linux/网络 FS)不提供 filename
// → basename 过滤失效。每次事件比对 mtime，未变即跳过——消除根目录无关文件变动（如 dev 期编辑器
// swap）引发的重载风暴。
function watchFileDebounced(filePath, onChange, label) {
  const base = basename(filePath);
  let timer = null;
  let lastMtime = 0;
  try { lastMtime = statSync(filePath).mtimeMs; } catch { /* 文件暂不存在，首次变更时再取 */ }
  try {
    watch(dirname(filePath), (_evt, filename) => {
      if (filename && filename !== base) return;
      let m;
      try { m = statSync(filePath).mtimeMs; } catch { return; } // 不存在/不可读 → 跳过（保留旧配置）
      if (m === lastMtime) return;
      lastMtime = m;
      clearTimeout(timer);
      timer = setTimeout(onChange, 300);
    });
  } catch (err) {
    console.error(`[${label}] 无法监视文件所在目录:`, err.message);
  }
}

// workdirs.json 热加载（仅 WORK_DIRS_FILE 模式；逗号串 WORK_DIRS 无文件可 watch）。
if (process.env.WORK_DIRS_FILE) {
  watchFileDebounced(resolveWorkdirsFilePath(process.env.WORK_DIRS_FILE, HERE), reloadWorkdirs, 'workdirs');
}

// 统一配置文件热加载（P1b）：hot 项就地生效，restart 项只提示 —— 热应用一个需重启的项是假生效。
//
// **只在文件已存在时才装监听**：未迁移的部署一个 watch 都不多加，与 P1a 的零影响立场一致。
// 运行中才创建 ccm.config.json 的情况不被监听，这是对的：那时整个启动配置都还是从旧源读的，
// 换源本来就需要重启。
if (usingConfigJson()) {
  const configReloader = createConfigReloader({
    readConfig: () => {
      try {
        return JSON.parse(readFileSync(CONFIG_FILE_PATH, 'utf8'));
      } catch {
        return null; // 编辑器写到一半 → 保留旧快照，别把白名单判成全部删除
      }
    },
    onHot: (keys) => {
      console.log(`[config] 热加载生效：${keys.join(', ')}`);
      if (keys.includes('WORKDIRS')) reloadWorkdirs();
    },
    onRestart: (keys) => console.warn(`⚠️  [config] 这些改动需重启 server 才生效：${keys.join(', ')}`),
  });
  configReloader.prime();
  watchFileDebounced(CONFIG_FILE_PATH, () => configReloader.handleChange(), 'config');
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

// 握手拒绝：把 authRejection 的判定翻译成 socket.io 的错误对象。
// message 仍是原来的字符串（'unauthorized' / 'rate_limited'），前端既有判据不受影响；
// 新增的 err.data 让客户端能拿到重试提示——socket.io 会把 data 原样送到客户端的
// connect_error(err) 上，这是 socket 侧对应 HTTP `Retry-After` 头的唯一通道。
// 此前 socket 侧一个数字都不给，手机端只能盲目重连，而每次重连都只是撞在锁上。
function rejectHandshake(rlResult) {
  const rej = authRejection(rlResult);
  const err = new Error(rej.reason);
  err.data = { reason: rej.reason, ...(rej.retryAfterMs === null ? {} : { retryAfterMs: rej.retryAfterMs, retryAfterSeconds: rej.retryAfterSeconds }) };
  return err;
}

// 鉴权门口防暴破限速：仅当配了鉴权门（公网 CF Access 或 AUTH_TOKEN）时生效——
// 无鉴权模式(!AUTH_TOKEN 且非公网) authPassed 恒真、永不计失败，天然不触发。
// CF-Connecting-IP 仅公网 Host 采信；LAN 只认连接 IP（防伪造头拆分限速桶）。
// 状态内存态 Map（与 HTTP createHttpAuth 共用 rlStates；重启清零 = 用户误锁时的逃生口）。
// ---- 鉴权（公网 Host 强制 Access JWT、fail-closed；LAN/本机回退 token；无 token 时仅 localhost）----
io.use(async (socket, next) => {
  const ip = clientIp(socket.handshake.address);
  const publicHost = authStrategy.ownsHost(socket.handshake.headers.host);
  const rlActive = publicHost || !!AUTH_TOKEN;
  // AUTH-NEW-2：与 HTTP sourceKey 同判据——Host spoof 从 LAN 直连时不信 CF-IP；
  // XFF 末跳同样只在 TRUSTED_PROXY=loopback + peer loopback 时采信（AUTH-04）。
  const rlTrust = {
    trustCfConnectingIp: shouldTrustCfConnectingIp({
      publicHost,
      peerAddress: socket.handshake.address,
    }, clientIp),
    trustForwardedFor: shouldTrustForwardedFor({
      trustedProxy: TRUSTED_PROXY,
      peerAddress: socket.handshake.address,
    }, clientIp),
  };
  const rlKey = rlSourceKey(socket.handshake, clientIp, rlTrust);
  try {
    // 限速锁定门：退避/锁定期内直接拒、不做鉴权、不计数（避免攻击者持续戳把用户越锁越久 = 自我 DoS）
    // 两种锁对客户端说的话不同（gateCheck 判定）：'locked' 才是「尝试过多」，'cooldown' 只是上一次
    // 令牌不对顺带上的 500ms 短锁，仍按 unauthorized 回复——否则只错一次的用户会被告知「尝试过多」。
    if (rlActive) {
      const st = rlStates.get(rlKey) || freshState();
      const gated = gateCheck(st, Date.now());
      if (gated) {
        console.warn(gated.verdict === 'locked'
          ? `[conn] ${ip} 鉴权限速中，拒握手（retryAfter≈${Math.ceil(gated.retryAfterMs / 1000)}s，source=${rlKey}）`
          : `[conn] ${ip} 上次鉴权失败的退避冷却中（剩 ${gated.retryAfterMs}ms），拒握手（source=${rlKey}）`);
        return next(rejectHandshake(gated));
      }
    }

    let authPassed = false;
    let accessEnabled = false;

    if (publicHost) {
      // 跨站握手门（M3，2026-09-17 安全审查）。**只在这条路上判**：这里的凭据是边缘按 Cookie
      // 注入的 JWT，浏览器会自动带上；而 AUTH_TOKEN 那条路的令牌在 handshake.auth 的 JSON 里、
      // 由页面 JS 从 localStorage 读出来，浏览器不会自动附加，本来就不可 CSRF。判据与理由见
      // auth/origin-gate.js 头注。
      //
      // 放在验签**之前**：验签成功才是「边缘认可了这个 Cookie」，那正是要挡的那一格，
      // 挡在后面等于先把 CSRF 走通了再补一刀。不计入限速——它不是一次鉴权失败，
      // 而是一个来源不对的请求，计进去会让受害者被自己浏览器发出的跨站连接越锁越久。
      if (!originAllowedOnPublicHost(socket.handshake.headers.origin, authStrategy.publicHostname())) {
        console.warn(`[conn] ${ip} 公网 Host 上的握手 Origin 不符（${socket.handshake.headers.origin ?? '(无)'}），拒绝`);
        return next(new Error('forbidden origin'));
      }
      try {
        await authStrategy.verifyRequest(socket.handshake.headers);
        authPassed = true;
        accessEnabled = true;
      } catch {
        authPassed = false; // 公网 JWT 校验失败 → 落入统一限速计数 + fail-closed
      }
    // 同 HTTP 侧：不留「无 token 放行」的分支（§1.9 鉴权是启动前提，无 token 起不来）。
    } else if (tokenMatches(socket.handshake.auth?.token)) {
      authPassed = true;
    }

    // 限速计数：成功清零、失败退避/锁定
    let rlResult = null;
    if (rlActive) {
      const st = rlStates.get(rlKey) || freshState();
      rlResult = onAuthResult(st, authPassed, Date.now());
      setRlStateCapped(rlKey, rlResult.next); // F2：握手路径同样过 cap，不给扫描器绕出无界增长
      if (!authPassed && rlResult.verdict === 'locked') {
        console.warn(`[conn] ${ip} 连续鉴权失败达阈值 → 锁定 ${Math.ceil(rlResult.retryAfterMs / 1000)}s（source=${rlKey}）`);
        // 最小审计记录：只在"达阈值锁定"这个粒度写（本就限速到每锁定窗口一次），不逐次失败尝试都写——
        // 后者本身可被攻击者刷出高频事件、会把环形上限里的真实信号挤掉，锁定事件已足够代表"发生过暴破尝试"。
        // via 与 HTTP 侧对称（那边是 'socket' 的对家 'http'）：同一条 auth_rate_limited 记录，
        // 少了它就分不清这次暴破是打在握手上还是打在 /health|/metrics|/push 上。
        audit.recordAudit({ actor: { deviceId: null, via: 'unauthenticated' }, action: 'auth_rate_limited', target: rlKey, outcome: 'locked', meta: { retryAfterMs: rlResult.retryAfterMs, via: 'socket' } });
        metrics.inc('rate_limit_lockouts'); // 限速触发数（与审计同粒度：每锁定窗口一次）
        metrics.gauge('rate_limit_lockouts_last_ts', Date.now()); // 服务状态可见性：带时间戳，供 recentIncident 判定
        metrics.label('rate_limit_last_source', rlKey); // 与 HTTP 侧同一个键：面板文案按来源分叉的唯一判据
      }
    }

    if (!authPassed) {
      const got = socket.handshake.auth?.token;
      console.warn(`[conn] ${ip} 握手鉴权失败（token ${got ? '不匹配' : '缺失'}）`);
      // 本次失败若恰好触发锁定，要和 HTTP 侧一样报 rate_limited——此前这里恒回 unauthorized，
      // 于是同一次失败在 curl 上是「被限速了，等 15 分钟」，在手机上却是「令牌不对」，
      // 后者会让人反复重试，而每次重试都只是撞在那把刚上的锁上。
      return next(rejectHandshake(rlResult ?? {}));
    }

    // 鉴权通过后，执行设备审批过滤（纵深防御）
    // 反代 loopback：peer=127.0.0.1 但 Host 公网 → 仍须 deviceToken（见 shouldBypassDeviceApproval）
    const bypassDevice = shouldBypassDeviceApproval({
      accessEnabled,
      deviceApprovalScope: DEVICE_APPROVAL_SCOPE,
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
        // 卡片上给人核对的来源 IP 与限速桶同一份判据（AUTH-04）：反代已声明 TRUSTED_PROXY 时是 XFF 末跳，
        // 否则是 peer。此前直接取 peer，反代后每张卡都是 127.0.0.1，「核对再批」无从核对（2026-09-06 容器演练）。
        const ip = clientSourceAddress(socket.handshake, clientIp, rlTrust).address;
        const ua = socket.handshake.headers['user-agent'] || 'Unknown';
        // 【整段副作用都必须挂在「真的进了待审列表」这个前提下】addPendingDevice 内部会拒掉
        // 格式非法/缺失的 token（isValidDeviceToken 同一判据），但下面这一整套——广播、离线推送、
        // 控制台审批提示——此前无条件照跑，于是为一台【并不存在的待审设备】报了警：
        //  · TTY 提示写的是「按回车一键同意【此】设备」，而回车实际批的是 getLatestPendingDevice()，
        //    即【另一台】设备。攻击者（持 AUTH_TOKEN，正是设备审批这层要防的那种）先用合法 token
        //    排队一台，再用非法 token 触发这条提示，操作员核对的卡片与回车批准的对象就不是同一台，
        //    而 F2 那条「另有 N 个待审」的告警在只有一台待审时也不会响。
        //  · 推送节流是设备维度的【单一】窗口（DEVICE_NOTIFY_KEY / DEVICE_NOTIFY_INTERVAL_MS），
        //    且放行与否都写回状态——无效连接刷一下就占住它，随后真实的设备申请静默不推，
        //    而「人不在电脑前」恰是本项目的主用例。
        // 所以这里直接短路：只打一行拒绝记录，不广播、不推送、不给任何审批入口。
        if (!isValidDeviceToken(deviceToken)) {
          console.log(`\n⚠️  [安全] 拒绝一个设备 ID ${deviceToken ? '格式非法' : '缺失'} 的接入请求（来自 ${ip}），`
            + `未加入待审列表，不发广播与推送。\n`);
          return next();
        }
        addPendingDevice(deviceToken, { ip, userAgent: ua });
        broadcastPendingDevices(); // 通知已登录的可信设备来远程一键审批（免终端）
        // 离线唤醒：上面那条广播只发给【此刻在线且前台】的可信端，用户锁屏或在别的 app 时整道
        // 审批完全静默——而"人不在电脑前"恰是本项目的主用例。直推是安全的：/push/subscribe 对
        // 未批准设备恒 403（见 bypassDeviceApproval 注释），订阅表里只可能是已批准设备，不会把
        // "有新设备在等"告诉那台正在等批准的设备自己。
        // 节流键是设备维度的哨兵串、不是会话（见 notifications.js 的 DEVICE_NOTIFY_KEY）。
        {
          const r = throttleNotify(DEVICE_NOTIFY_KEY, 'device', Date.now(), notifyThrottleState, DEVICE_NOTIFY_INTERVAL_MS);
          notifyThrottleState = r.next; // 放行与否都写回（同 envelope 路径的幂等约定）
          if (!r.throttled) {
            const dn = notificationForDeviceRequest({ count: getPendingDevices().length });
            pushNotify(dn.title, dn.body); // 无 data：设备审批不属于任何会话，深链无处可去
            ntfyNotify(dn.title, dn.body, ntfyMetaFor('device_request', {}, notify.publicUrl));
          }
        }

        console.log('\n==================================================');
        console.log(`📢 [安全] 发现新设备请求公网/局域网接入！`);
        console.log(`   设备 ID: ${deviceToken}`);
        console.log(`   来自 IP: ${ip}`);
        console.log(`   User-Agent: ${ua}`);
        // 「电脑控制台」曾让用户满机器找窗口（2026-08-19 实录）——这条消息**就打印在**该按回车的
        // 那个窗口里，直接指认它即可。非交互分支同理带上项目目录：命令按当前目录的配置决定数据根，
        // 机器上装着不止一份时（fork / 演练用的 clone），在别处跑会如实报成功却批到另一个实例上。
        if (process.stdin.isTTY) {
          console.log(`   -> 就在这个窗口（跑着 npm start 的这个终端）里按【回车键 (Enter)】一键同意此设备`);
          console.log(`   -> 或输入【deny】拒绝并移除该设备（非拉黑：denyDevice 只是移出待审/信任列表，同一 token 之后仍可重新申请）`);
        } else {
          // 走到这里 deviceToken 必然已过 isValidDeviceToken（上面短路过了），拼进双引号是安全的。
          console.log(`   -> 当前运行在非交互模式下。请在电脑运行下方命令授权此设备（必须在本项目目录下跑）：`);
          console.log(`      cd ${HERE} && node scripts/device.js approve "${deviceToken}"`);
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
// "等我"跨会话聚合（AttentionDeriver）：跨全部 live 实例（不限 viewingCwd）
// 投影 needsYou。数据源=运行时 agents（读模型投影，非新数据源）：
//   ①审批维度——每个 live 实例的 pendingPermissions（已有 createdAt/expiresAt，承接审批 TTL 阶段），
//     此处过滤 now<=expiresAt（deriveAttention 契约要求调用方先过滤，保持纯函数不依赖 Date.now()）；
//   ②输入维度——pendingQuestions（本次新增 createdAt），仅当该实例无 pendingPermissions 时计入
//     awaiting_input（镜像 StatusDeriver 优先级：审批 > 输入，与 instanceState() 的 'permission' 判定一致）。
// 边界（已知盲区，如实登记）：纯终端会话的等待态不经此路径可见——本函数只覆盖 web 后端驱动的 live 实例。
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
    // hasLiveApproval：与下面 hasLiveQuestion 同一套写法——外层门槛不能只看 Map.size，
    // size>0 但里面全过期时这里会一条都不 push，若还按 size 做 if/else 门槛，会连带把
    // 同一实例真实存在的 pendingQuestions 分支也一起挡掉（两者互斥判据本该是"有没有活的"，
    // 不是"Map 是否非空"）。
    let hasLiveApproval = false;
    for (const [requestId, p] of a.pendingPermissions) {
      if (now > p.expiresAt) continue; // 已过期：不计入聚合（fail-closed 语义下过期即失效，见审批 TTL 阶段）
      hasLiveApproval = true;
      pendingApprovals.push({ sessionId: a.sessionId, cwd: a.cwd, title, requestId, createdAt: p.createdAt, toolName: p.name });
    }
    if (!hasLiveApproval && a.pendingQuestions.size > 0) {
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
  // instanceId 是纯函数契约之外的接线专用字段（前端深链需要，复用 applyDeepLink({instanceId,sessionId,cwd})）。
  return needsYou.map(item => ({ ...item, instanceId: instanceIdBySessionId.get(item.sessionId) ?? null }));
}
// 服务状态可见性（与上面 computeNeedsYou 的注意力不对称是不同的轴，不混入其判定）：
// "ccm 这个服务本身有没有出过岔子"——判定化信号，全部带时效窗自动退场（不做不衰减的常驻布尔）：
// 推送投递健康（recentDeliveryFailure）+ 服务启动时刻（供前端与本地基线比对判定重启）+ 登录限速锁定
// （=有人在暴力尝试入口，安全信号）+ 前端错误（=界面自身坏了，详情在日志面板）。
// 刻意不接 classifyProbeState()：那是 /metrics 外部消费的粗分类，failed/awaiting 已被会话 ❗ 角标/需要你(N) 覆盖，
// mobile_offline 对正在看 UI 的设备是自指悖论——原样接入会制造重复信号，见方案 Context。
// ── 桌面端服务的重启历史采样 ──────────────────────────────────────────────
//
// launchd 只保留「最后一次怎么退出的」，那是瞬时值。要回答「这正常吗」必须有时间序列 ——
// 实测环境中的实证：隧道的 LastExitStatus 恒为 -9，因为自建看门狗每天按 DHCP 漂移
// kickstart 一次。单看退出码会每天误报一次，而恒亮的告警比没有告警更糟。
//
// 采样放在 server 进程里而不是新起一个 LaunchAgent：这里本来就常驻，一次 `launchctl list`
// 约 5ms、不 spawn node。
//
// ## 快照必须落盘（2026-08-14 第三轮审查修复）
//
// 上一版把快照只放在内存里，加上「命内 com.ccm.server 的 pid 就是采样进程自己、恒定不变」，
// 两条叠加让 **server 自身的重启结构性永远记不到** —— 最该被抓到的崩溃循环恰恰是唯一的盲区。
// 当时那句取舍（「server 挂着那段时间 UI 也看不到，所以不是真的损失」）对别的 unit 成立，
// 对 server 自己不成立：重启完成那一刻 UI 恰恰是可达的。
// 落盘之后，新命的首次采样拿得到上一命的 pid，server 换命即产出一条 restarted。
// 判定在 src/ops/service-events.js，接线在 src/ops/service-sampler.js —— **本文件只提供 IO**。
// 上一版把 glue 全写在这里，而 app.js 是组装根、进不去单测，于是那批接线错误（快照只在内存、
// 缺 mkdir、写失败仍推进快照）一条都没被测试挡住。
const SERVICE_EVENTS_FILE = dataFile('service-events.json');
const SERVICE_SNAPSHOT_FILE = dataFile('service-snapshot.json');
const SERVICE_SAMPLE_INTERVAL_MS = 60_000;
let serviceSampleInterval;

const readJsonOrNull = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
};

// writeOwnerOnlyFile 不建父目录（realWriteManifest 就自己先 mkdir 了，这里上一版漏了）。
// 全新安装、用户还没聊过天时 dataDir 可能尚未被 sessions/approval-store 顺手创建 ⇒ 每次采样
// ENOENT，重启事件被静默吞掉。
function writeServiceStateFile(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeOwnerOnlyFile(path, content);
}

const serviceSampler = createServiceSampler({
  listUnits: () => {
    try {
      return parseLaunchctlList(execFileSync('launchctl', ['list'], { encoding: 'utf8', timeout: 5000 }));
    } catch {
      return null; // launchctl 挂了不该影响 server；下一轮再试
    }
  },
  readEventsRaw: () => readJsonOrNull(SERVICE_EVENTS_FILE),
  writeEvents: (arr) => writeServiceStateFile(SERVICE_EVENTS_FILE, JSON.stringify(arr, null, 2)),
  readSnapshotRaw: () => readJsonOrNull(SERVICE_SNAPSHOT_FILE),
  writeSnapshot: (obj) => writeServiceStateFile(SERVICE_SNAPSHOT_FILE, JSON.stringify(obj)),
  log: (m) => console.log(m),
  warn: (m) => console.warn(m),
});


function computeServiceHealth() {
  const g = metrics.snapshot().gauges;
  const c = metrics.snapshot().counters;
  const now = Date.now();
  const failure = metrics.recentDeliveryFailure({
    pushFailureAt: g.push_failure_last_ts, ntfyFailureAt: g.ntfy_failure_last_ts, now
  });
  const lockout = metrics.recentIncident({ at: g.rate_limit_lockouts_last_ts, now });
  const clientError = metrics.recentIncident({ at: g.client_errors_last_ts, now });
  // ★ restarts **刻意不在这份 payload 里**。本函数喂的是 instances 广播（41 处调用点，轮次边界
  // 就会触发），而前端只在 service:status 的 ack 里读 restarts —— 放广播里那份零消费者，白发
  // payload 给每台连着的设备，还每次同步 readFileSync + JSON.parse 一遍。面板那条路径在
  // service:status handler 里单独调 serviceSampler.summarize()。
  // reason / source 是 label（非数值上下文，见 metrics.js）：让面板从「失败了/有人在试」进一步
  // 说出「为什么/是谁」。都可能为 null——旧进程重启后 label 清零而计数时间戳仍在窗内，前端按缺席渲染。
  return {
    startedAt: SERVICE_STARTED_AT,
    // 这台 server 前面有没有中间节点。面板判「限速锁定来自 127.0.0.1」要不要断言
    // "多半是你自己的旧 token" 就靠它（见 service-diag.js 的 formatServiceNotices）。
    //
    // 【为什么不能只看 TRUSTED_PROXY】那个开关的语义是「允许采信反代追加的 XFF 末跳」，
    // 而本仓刻意不让它随 reverse-proxy 自动打开（XFF 是客户端可写的，采信必须用户明确声明）。
    // 于是最常见的反代/托管隧道部署恰恰是 TRUSTED_PROXY 未设、peer 恒 127.0.0.1——正是这句
    // 断言最危险的那一档：真·公网暴力尝试会被说成"多半是你自己的旧 token"。
    // 判据因此换成「拓扑上有没有中间节点」，三条来源任一成立即为 true：
    //   · TRUSTED_PROXY=loopback —— 用户明说了前面有可信反代；
    //   · ACCESS_PROFILE=reverse-proxy / cloudflare —— 声明的拓扑本身就含中间节点。
    //     托管隧道（ngrok / Quick Tunnel / Tailscale Funnel）并入 reverse-proxy，
    //     env-schema.js:69-72 明写它们的连带变化含「peer 是 loopback 导致限速桶全塌」；
    //   · 未声明 profile 但 CF_ACCESS_* 三项齐全 —— 按 schema 的「未声明时按 CF_ACCESS_* 推断」，
    //     流量经 cloudflared 进来，peer 同样是 loopback。
    // vpn / direct / lan 三档【不】算：它们的 peer 就是真实客户端地址（tailnet IP / 公网 IP /
    // 局域网 IP），此时 127.0.0.1 确实就是本机，原措辞成立、不该被改。
    proxyFronted: isProxyFronted({ trustedProxy: TRUSTED_PROXY, accessProfile: ACCESS_PROFILE, accessConfigured: accessConfigured() }),
    deliveryFailure: failure
      ? {
        ...failure,
        count: (failure.channel === 'ntfy' ? c.ntfy_failure : c.push_failure) ?? 0,
        reason: metrics.getLabel('delivery_failure_reason'),
      }
      : null,
    rateLimitLockout: lockout
      ? { ...lockout, count: c.rate_limit_lockouts ?? 0, source: metrics.getLabel('rate_limit_last_source') }
      : null,
    clientError: clientError ? { ...clientError, count: c.client_errors ?? 0 } : null,
    // hooks 桥安装态：前端据此在设置面板显示开关、在只读镜像页提示未装。缓存读盘结果——
    // 这个值只在用户装/卸时变，而 instances 广播很频繁。
    hooksBridge: { state: hooksInstallState, off: process.env.CLI_HOOKS_BRIDGE === 'off' },
    // statusline 桥同理。此前只有 hooks 桥有这个字段，于是面板上一个桥有安装态与一键安装、
    // 它的孪生兄弟整段隐身——两个桥在 CLAUDE.md 里是并列的，web 上待遇不该差一个量级。
    statuslineBridge: {
      state: statuslineInstallState,
      off: process.env.CLI_STATUSLINE_BRIDGE === 'off',
    },
  };
}

// 给面板用的重启摘要。flapping 走频率判据（1 小时内 ≥3 次），单次异常退出不算 ——
// 见 src/ops/service-events.js 的头注。

// 安装态缓存：启动时读一次，装/卸后由 refreshHooksInstallState 主动刷新。
let hooksInstallState = 'unknown';
function refreshHooksInstallState() {
  hooksInstallState = readHooksInstallState();
  return hooksInstallState;
}
let statuslineInstallState = 'unknown';
function refreshStatuslineInstallState() {
  statuslineInstallState = readStatuslineInstallState().state;
  return statuslineInstallState;
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
    // 驾驶轴与展示轴在「worktree 目录已删」这一档分叉（见 panelCwdOf）。两个都下发，前端的
    // 文件/改动面板走 panelCwd，而算 transcript 目录的那条路仍走 cwd —— 合成一个字段必然
    // 有一侧要错，且两种错法都静默（历史空白 / 面板报路径越界）。
    const panelCwd = panelCwdOf(a.cwd);
    list.push({
      instanceId: id, cwd: a.cwd, sessionId: a.sessionId,
      panelCwd, worktreeGone: panelCwd !== a.cwd,
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
      // 旁路提问（下一步建议 / 回来时的摘要）在本会话触发了几次。**只有次数没有金额**：
      // 那笔钱由 CLI 计入会话总成本、随 result 一起来，已经在成本行里了；单独再报一份金额
      // 只会出现两个对不上的数字。搭 instances 的便车而不新开一条入向事件——两个整数，
      // 而新事件要动入向白名单 + mock + 契约门禁三处，成本不成比例。
      sideQuestionCalls: { ...a.sideQuestionCalls },
      unreadCount: unreadCounts.get(id) || 0, // 未读角标活计数（预留会话列表徽标用；聊天页内胶囊走 sync:since ack 的 unreadOnEntry 冻结快照）
    });
  }
  // 【viewingCwd 是工作区轴，不是驾驶轴】viewingCwdOf() 优先取活实例的 cwd——托管 worktree 时
  // 那就是 `.claude/worktrees/<name>`。而前端拿这个字段决定：侧栏列哪一页、新会话开在哪、
  // 顶栏显示哪个工作区。session:switch 里刚把 viewingCwd 设成 workspaceCwdOf(cwd) 并留了一整段
  // 注释解释「worktree 是临时模式、不占抽屉条目」，广播时若又被实例 cwd 盖回去，那段逻辑等于白做
  // （症状：打开一个 worktree 会话后侧栏突然只剩那一条，看着像会话丢了）。
  // 驾驶轴仍由 instances[].cwd 逐条如实下发，前端的文件/改动面板走那一条（resolvePanelCwd）。
  const payload = { viewingInstanceId, viewingCwd: workspaceCwdOf(viewingCwdOf()), dirs: workDirs, instances: list, devMode: DEV_MODE, canRestart: canRestartNow(), needsYou: computeNeedsYou(), service: computeServiceHealth() };
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
// 「配置改完能不能就地重启生效」——判据是「退出后有人拉起」（托管或 npm run dev 的 watch），
// **不再看 DEV_MODE**：2026-08-19 真机实测 DEV_MODE=1 + 前台 npm start 时，按钮出现、点击后
// 进程退出、无人拉起、前端提示成功——假成功真死亡。DEV_MODE 保留其余能力面，但「重启」承诺
// 的兑现前提是拉起者存在，判据必须对准它。与 dev:restart handler 用同一个判据，两处不能分叉。
const canRestartNow = () => willBeRespawned();

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
    const ntfyType = push.hookEventName === 'Notification' ? 'cli_hook_notification'
      : push.hookEventName === 'Stop' ? 'cli_hook_stop' : 'result';
    void sessionTitleForNotify(push.cwd, push.sessionId).then(sessionTitle => {
      const pn = notificationForCliHook(push.hookEventName, {
        cwd: push.cwd, sessionId: push.sessionId, instanceId: inst?.instanceId, sessionTitle,
      });
      if (!pn) return;
      metrics.inc('hook_pushes');
      emitNotify(pn, ntfyType);
    }).catch(() => {});
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
// statusline 桥同理：读一次落进缓存，供 service:status 下发给面板。
// 只在装/卸时变，而 instances 广播很频繁——不能每次广播都去读盘。
refreshStatuslineInstallState();

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
    type: 'init', payload: {
      cwd: cwd || null,
      slashCommands: cmds.slashCommands,
      terminalSlashCommands: cmds.terminalSlashCommands, // 与命令列表同批下发，前端才不会拿旧名单过滤新列表
    },
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

async function refreshStatusLine(reason = 'event') {
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
    // statusline 里 cwd 的全部用途是 p.cwd / p.project / gitStatus（两个 build 函数里都只有这三处），
    // 全在展示轴上，所以走 panelCwdOf：worktree 目录被删之后驾驶轴悬空，gitStatus 的每条 git 命令
    // 都会失败 → 整个 git 段静默消失，而 project 名还挂着那棵已不存在的树。
    // readCliSnapshotForSession **不在此列**——它按 cwd 算 CLI 快照的落点，必须跟驾驶轴。
    const statusCwd = panelCwdOf(cwd);
    const owner = statusOwnerFor(va, currentInstanceId);
    let payload;
    if (owner === 'sdk') {
      const sdkPayload = await buildWebStatusLine({
        agent: va, cwd: statusCwd, versions, reason,
        onContextUsageAdopted: () => scheduleStatusRefresh('event'),
      });
      payload = { ...sdkPayload, source: { kind: 'sdk' } };
    } else {
      const cliRead = readCliSnapshotForSession(va.sessionId, cwd);
      const selected = selectStatusSource({ owner, cliRead });
      if (selected.kind === 'cli') {
        const cliPayload = await buildCliStatusLine({ snapshot: selected.value, cwd: statusCwd });
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
        const at = Date.now();
        const fallbackRate = getFallbackUsageRate(at);
        const fallbackAgeMs = fallbackRate ? getFallbackUsageAgeMs(at) : null; // 新鲜度与另两条路径同源（见 statusline.js applyRateFreshness）
        payload = {
          ts: at, cwd: statusCwd,
          ...(statusCwd ? { project: projectNameFromCwd(statusCwd) } : {}),
          ...(va.sessionId ? { session: { id: va.sessionId } } : {}),
          source: { kind: 'cli-unavailable', reason: selected.reason, ...(Number.isFinite(selected.ageMs) ? { ageMs: selected.ageMs } : {}) },
          ...(fallbackRate ? { rate: fallbackRate, rateFromSnapshot: true, ...(Number.isFinite(fallbackAgeMs) ? { rateAgeMs: fallbackAgeMs } : {}) } : {}),
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
let pendingStatusReason = 'tick';
function scheduleStatusRefresh(reason = 'event') {     // 300ms 防抖（合并高频 onUsage/init/result 触发）
  if (statusOff) return;
  pendingStatusReason = strongerStatusRefreshReason(pendingStatusReason, reason);
  clearTimeout(statusDebounce);
  statusDebounce = setTimeout(() => {
    const r = pendingStatusReason;
    pendingStatusReason = 'tick';
    refreshStatusLine(r).catch(err => console.error('[statusline]', err));
  }, 300);
}
if (!statusOff) {
  // 周期刷新让 git 段（外部 commit/改动无事件驱动）跟上。ctx% 走占用缓存，tick 不重打 getContextUsage。
  // DeepSeek: 统一路由到 scheduleStatusRefresh 以消除并发重叠与合并请求
  statusInterval = setInterval(() => scheduleStatusRefresh('tick'), 10_000);
}

// 桌面端服务的重启历史采样。**刻意不放进上面的 `if (!statusOff)`**：
// 上一版塞在那里，于是用户在手机配置面板关掉「Web 状态栏」（WEB_STATUSLINE 是可点的 toggle，
// src/ops/env-schema.js）就连带把重启历史采样一起关了 —— 面板「重启记录」从此永远「暂无记录」
// 且不说明原因。两个正交功能不共用一个开关。
// 不支持的平台由 sampler 内部早退（process.platform !== 'darwin'），零开销。
// 先立刻跑一次：盘上有上一条命的快照时，这一次就能认出 server 自己的重启。
serviceSampler.sample();
// 非 macOS 的重启历史唯一来源：上面那条 sample() 在这些平台上直接早退，面板「重启记录」段
// 因此一直是空的。server 自己知道自己什么时候起来的，这个事实与进程管理器无关。
// darwin 上此调用内部早退——两条路径互斥，双写会让同一次重启进两条、flapping 阈值虚高一倍。
serviceSampler.recordSelfStart();
serviceSampleInterval = setInterval(() => serviceSampler.sample(), SERVICE_SAMPLE_INTERVAL_MS);
serviceSampleInterval.unref?.(); // 不阻止进程退出

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
    const claudeDir = join(CLAUDE_PROJECTS_DIR, projectDir);
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
  // 本实例创建时所属的工作区（worktree 会话归父仓）。只用于 onCwdChanged 的热移除保护——
  // 该目录之后被移出 WORKDIRS 时，已发出去的授权不在会话半途收回（见 instanceAuthorizedDirs）。
  const authorizedRoot = workspaceCwdOf(cwd);
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
      metrics.inc('events'); // 事件 seq 速率（累计事件数，速率由 /metrics 消费者按两次快照时间差算）
      const drivingCwd = instance.cwd; // 见 onSessionId 里的说明：闭包 cwd 会在 EnterWorktree 后过期
      if (envelope.type === 'init') {
        lastInit = envelope.payload;
        // slash 命令按本实例 cwd 归键（project/local skill 随区变）；空列表不写，避免冲掉更好缓存
        const cmds = normalizeSlashCommands(envelope.payload?.slashCommands);
        // terminal 名单【只有 init 这条路带得到】（commands_changed 的 SlashCommand[] 无此标记），
        // 所以随命令一起落缓存，供下面 slash_commands 分支沿用。无名单显式落成 []（= 没有要隐藏的）。
        if (cmds) slashCommandsCache.set(drivingCwd, {
          slashCommands: cmds,
          terminalSlashCommands: normalizeSlashCommands(envelope.payload?.terminalSlashCommands) ?? [],
        });
        saveInitCache();
      }
      else if (envelope.type === 'models') { modelsCache.set(drivingCwd, envelope.payload); saveInitCache(); } // 按本实例 cwd 归键，防跨工作区泄漏
      // CLI 中途发现新命令/skill 的全量推送（SDK commands_changed）。缓存策略与上面 init 那条**共用同一条**：
      // 同样按 cwd 归键、同样「空列表不写」。故意不在这里为 REPLACE 语义单开一条清空路径——空推送
      // 只可能来自 skill 被删这种极罕见场景，而放行空写会让「CLI 未就绪时报空」也一并冲掉好缓存，
      // 两害相权取轻。前端那侧收到空数组仍会清当前补全列表，下次 init 修正。
      else if (envelope.type === 'slash_commands') {
        const cmds = normalizeSlashCommands(envelope.payload?.slashCommands);
        if (cmds) {
          // 【terminal 名单沿用上一条 init，不跟着一起重置】SDK 的 commands_changed 只带
          // SlashCommand[]（name/description/argumentHint/aliases），**不带** terminalOriented 标记——
          // 这条路根本拿不到名单。整条覆盖会把 init 存下的名单抹成空，于是 /color /statusline
          // 会在任何一次 skill 变动后重新冒回补全菜单（而那正是本功能要挡的）。
          // 名单是 CLI 版本级的量、不随 skill 增删而变，沿用是正确语义而非将就。
          const keptTerminal = normalizeSlashCommands(slashCommandsCache.get(drivingCwd)?.terminalSlashCommands) ?? [];
          slashCommandsCache.set(drivingCwd, { slashCommands: cmds, terminalSlashCommands: keptTerminal });
          saveInitCache();
        }
      }
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
      // E16：仅当前查看 tab 的轮次边界刷新状态行（后台实例的 init/result/compact 不抢占 viewingInstanceId 的 statusline）
      {
        const statusReason = statusRefreshReasonForEnvelope(envelope.type, envelope.payload);
        if (statusReason && id === viewingInstanceId) scheduleStatusRefresh(statusReason);
      }
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
        // system/gateway_stall（模型静默告警）同 result 口径：前台看着不推、离开才推（10min 专用窗见下）。
        // 先判断"若不考虑节流，本该不该推"（result 仅无客户端连时推等既有规则），
        // 只有确实要推送时才消费节流配额——避免"注定不推"的事件（如有客户端连的 result）白白占用节流窗口，
        // 致真正需要推送时被误判为"最近推过"。
        // approved 房间里的实际 Socket 对象（非仅 id）：喂给 hasForegroundApprovedClient 判定"前台可见"，
        // 而不只是"连着"——见下方注释与 PWA 后台推送修复（client:presence）。
        const approvedSockets = approvedSocketObjects();
        const notifyOpts = {
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
        };
        let pn = notificationForEvent(envelope.type, envelope.payload, notifyOpts);
        // per-会话节流：同一会话同一类别已有未决通知或未过最小间隔 → 抑制，不推送。
        if (pn) {
          const notifyCategory = NOTIFY_CATEGORY[envelope.type];
          if (notifyCategory) {
            // stall（网关静默告警）两处特判：① 专用 10min 窗——告警源坏天气下每 90–120s 一条，
            // 套 60s 通用窗≈每条都推；② sessionId 可能未落定（首轮请求就静默、init 未达），
            // 退用 instanceId 作节流键——throttleNotify 缺 key 是「保守放行」，告警多密推送就多密。
            const throttleKey = notifyCategory === 'stall' ? (envelope.sessionId || envelope.instanceId) : envelope.sessionId;
            const intervalMs = notifyCategory === 'stall' ? STALL_NOTIFY_INTERVAL_MS : notifyThrottleMs;
            const r = throttleNotify(throttleKey, notifyCategory, Date.now(), notifyThrottleState, intervalMs);
            if (r.throttled) pn = null;
            notifyThrottleState = r.next; // 无论放行与否都写回：next 在放行时含新记录，节流时等于原状态（幂等安全）
          }
        }
        if (pn) {
          // ⑧ previewBody 只喂 pushNotify（按订阅 prefs.preview 挑）；ntfy 恒收 body 最小化文案——
          // 第三方明文通道，不因用户开了预览开关就把正文送去 ntfy（SEC-04 红线不因这个开关松动）。
          // 会话标题异步对齐抽屉（getSessionInfo.summary）；节流已在上面同步消费，避免 peek 期间重复放行。
          const type = envelope.type;
          const payload = envelope.payload;
          void sessionTitleForNotify(notifyOpts.cwd, notifyOpts.sessionId).then(sessionTitle => {
            const liveHasClients = hasForegroundApprovedClient(approvedSocketObjects()) && viewingInstanceId === notifyOpts.instanceId;
            const hasClients = notifyHasClientsAtSend(type, notifyOpts.hasClients, liveHasClients);
            emitNotify(notificationForEvent(type, payload, { ...notifyOpts, sessionTitle, hasClients }), type);
          }).catch(() => {
            const liveHasClients = hasForegroundApprovedClient(approvedSocketObjects()) && viewingInstanceId === notifyOpts.instanceId;
            const hasClients = notifyHasClientsAtSend(type, notifyOpts.hasClients, liveHasClients);
            emitNotify(notificationForEvent(type, payload, {
              ...notifyOpts,
              sessionTitle: sessions.getSession(notifyOpts.sessionId)?.title,
              hasClients,
            }), type);
          });
        }
        broadcastInstances();
      }
    },
    // E16：assistant 边界刷新 statusline（仅当前查看 tab；scheduleStatusRefresh 有 300ms 防抖兜频率）——ctx 不等 result/10s tick
    onUsage: () => { if (id === viewingInstanceId) scheduleStatusRefresh('usage'); },
    // 活后台任务集合变化 → 节流重算会话列表 ⏳（纯后台运行期 pendingTurns=0，这是唯一的 busy 触发源；scout 实例不接、不跑后台任务）
    onBgTaskChange: () => scheduleBgBroadcast(),
    // 账面被兜底路径就地改写（interrupt 结算看门狗）——无伴随事件流，须显式重播 instances，
    // 否则前端要等下一次无关广播才知道该实例已不忙，spinner 一直挂着。
    onStateSettled: () => broadcastInstances(),
    // 会话中途换 cwd（EnterWorktree / ExitWorktree）。SDK 的 CwdChanged hook 报上来，这里裁决。
    //
    // 【为什么裁决在 server】nextCwd 源自 EnterWorktree 的 path 参数，是会话内可被引导的值，
    // 与前端传来的路径同属用户可控面 —— SCOPE-01 原样适用，而白名单的真相源在这里。
    // 合法集与 routeCwd 同源（白名单目录本身 + 其下的托管 worktree），差别只在失败方向：
    // 那边回退 viewingCwd 是「纠正传错」，这里没有安全回退可言，拒绝即保持原样。
    //
    // 采信之后 agent 会 onStateSettled → broadcastInstances，前端的 entry.cwd / panelCwd 随之跟上。
    //
    // 热移除保护：工作区被移出 WORKDIRS 后，其上的已开会话按产品判据「继续运行、仅拒新开」，
    // 所以校验要带上本实例创建时的授权根（instanceAuthorizedDirs）。只认当前 workDirs 的话，
    // 这类实例的 worktree 切换会被拒、instance.cwd 停在旧值，静默复发历史加载失败。
    onCwdChanged: (nextCwd, prevCwd) => {
      const resolved = resolveDrivingCwd(nextCwd, instanceAuthorizedDirs(workDirs, authorizedRoot));
      if (!resolved) {
        console.warn(`[scope] 会话中途换 cwd 被拒：${nextCwd} 不在白名单，实例保持 ${prevCwd}`);
        audit.recordAudit({ action: 'scope_violation', target: nextCwd, outcome: 'denied', meta: { via: 'cwd_changed' } });
        return null;
      }
      return resolved;
    },
    onSessionId: (sid, firstMessage, model) => {
      // 【闭包 cwd 与驾驶轴在这里会分叉】cwd 是开实例那一刻的值；会话中途 EnterWorktree 之后，
      // CLI 已经换到 worktree 并把 transcript 迁了过去，instance.cwd 随 CwdChanged 跟上，而 cwd 没有。
      // 凡是「transcript/CLI 解析落在哪个目录」语义的，必须读 instance.cwd；
      // 只有路由指针（currentByCwd / generation）留在工作区轴——worktree 不占抽屉条目。
      //
      // 最险的是下面这行 writeSessionEntrypoint：/clear 拿到新 sid 时 `!getSession(sid)` 会放行，
      // 用旧 cwd 就会在**父仓**的 project 目录里凭空造出一个只含 entrypoint-marker 的 <新sid>.jsonl。
      // 那之后 sessionFileExists(父仓) 变成 true——「查不到会话」退化成「查到一个空会话」，
      // 更隐蔽，且那个幽灵文件会让同一会话在父仓与 worktree 两个列表里各出现一次。
      const drivingCwd = instance.cwd;
      // 新会话首次获得 id 时，写 entrypoint 元数据使 CLI /resume 可见（按本实例 cwd 落对应 project 目录）。
      if (!sessions.getSession(sid)) writeSessionEntrypoint(sid, drivingCwd);
      // effort/permissionMode 一并持久化：init 事件到达时 agent 已完成漂移检测（permissionMode 为对账后真值），
      // effort 为构造时注入值（运行时不可改）。web 端续接恢复依赖这两字段。
      sessions.upsertSession({ id: sid, title: firstMessage, cwd: drivingCwd, routeCwd: cwd, model, effort: instance.effort, permissionMode: instance.permissionMode, generation: instance.routeGeneration });
      // fresh 会话（未 resume、未 pin model）首 init 的 model = cwd CLI 默认 → 缓存供后续新会话预显（判据排除 resume-no-record，防污染）
      // 归键用驾驶轴：消费方是 defaultModelByCwd.get(viewingCwdOf())，而 viewingCwdOf 取的就是实例 cwd。
      recordCwdDefaultModel(drivingCwd, { resumeId: instance.resumeId, pinnedModel: instance.defaultModel, reportedModel: model });
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
// 回退并发锁（G3）。键是 sessionId 而非实例 id——confirm 中途会置换实例，
// 挂在实例上的锁解锁时已不是同一个对象。状态与判据都在 sessions/rewind-plan.js。
const rewindLocks = createRewindLocks();
// rewindFiles 的超时上限。控制请求走 SDK 的 control_request 通道，限流重试期间它可能长时间挂起——
// 没有上限的话 handler 会一直等，锁的 TTL 到期后别人能进来、这一条却仍挂着。
// 对齐 Claude Desktop 的做法（它给 rewindFiles 包了超时，超时报 "Timed out"）。
const REWIND_REQUEST_TIMEOUT_MS = 20_000;
// 超时要和「真失败」分开：Promise.race 只是不再等，**底层 control_request 并没有被取消**，
// 它可能在几秒后才真正把文件改完。把这一档混进普通失败会让 handler 回一句「文件未改动」——
// 一个我们并不知道真假、用户却会当真的硬断言（然后他去重试，撞上第二次并发回滚）。
class RewindTimeoutError extends Error {
  constructor() { super('rewindFiles 超时'); this.name = 'RewindTimeoutError'; }
}
function withRewindTimeout(promise, ms = REWIND_REQUEST_TIMEOUT_MS) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new RewindTimeoutError()), ms).unref?.()),
  ]);
}
// 进程内：正在 deletePermanent 的会话 id。列表/搜索在删文件窗口内排除它们。
// 不落盘——崩溃后孤儿文件重新可见，与 CLI 等价、可重试。必须在 registerSocketConnection
// 之外：每条 socket 一份的话，另一台设备的 SWR 在删文件窗口内仍会把行吐回去。
const pendingDeleteIds = new Set();
// 「在新 worktree 里开」的懒创建（2026-09-11）。**只有真发出第一条消息才建**——勾了不发就什么
// 都没发生，磁盘上不留没人用过的空树。与 Claude Code Desktop 同构：它的 lazyWorktrees.prepare 同样
// 挂在 start_session 上（日志原文 `Lazy worktree: starting session … its worktree is being prepared
// for EnterWorktree`），不挂在勾选上。
//
// single-flight 按「父仓 + 源分支」：空首页上两条**不同**的消息并发懒开时，各算各的 cwd，
// 下游 dedupedResume 的 `fresh:${cwd}` 就合不掉它们——会各建一棵树、各开一个实例。
// 窗口很窄（第一条 ack 回来 UI 就进会话视图了），但合并的代价只有一个 Map。
const worktreeCreateInFlight = new Map(); // `${cwd}\u0000${sourceBranch}` → Promise<result>
function dedupedWorktreeCreate(cwd, sourceBranch, firstMessage) {
  // key 不含消息文本：并发首消息要共用同一棵树，否则各建一棵、下游 dedupedResume 也合不掉。
  // 名字取第一个到达的那条消息——后到的那条本来就该进同一个会话。
  const key = `${cwd}\u0000${sourceBranch ?? ''}`;
  let p = worktreeCreateInFlight.get(key);
  if (!p) {
    p = createSessionWorktree(cwd, { name: worktreeNameFromMessage(firstMessage), sourceBranch })
      .finally(() => worktreeCreateInFlight.delete(key));
    worktreeCreateInFlight.set(key, p);
  }
  return p;
}
// 工作区轴：托管 worktree 里的实例归其父仓。viewingCwd 是「新开会话落哪、侧栏列哪一页」的锚，
// 设成 worktree 路径等于让它事实上变成一个工作区条目——而 worktree 是临时模式，不占抽屉。
//
// 第二条回落管「worktree 目录已经被删掉」那一档（2026-09-13）：resolveManagedWorktree 先 realpath，
// 对悬空路径必然返回 null，于是 `|| c` 把实例归到一个不存在的「工作区」上——症状是抽屉里父仓
// 那一节再也看不到这个会话（用户报的「工作区抽屉没有会话」正是这条）。
const workspaceCwdOf = c => resolveManagedWorktree(c, workDirs)?.parent
  || resolveGoneWorktreeParent(c, workDirs) || c;
// 展示轴：文件面板 / 改动面板 / statusline 的 git 段该读哪个目录。与驾驶轴（instance.cwd）的**唯一**
// 分叉点是「worktree 目录已删」——那时驾驶轴必须原样保留（transcript 落在按它算出的 project 目录里，
// 改掉就是历史加载失败），而展示轴回落父仓，否则三个消费点各报一条互不相干的技术错误。
const panelCwdOf = c => resolveGoneWorktreeParent(c, workDirs) || c;

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
function disposeScoutFor(cwd, opts) { // config:refresh 用：清除旧 scout 再起新的（旧 scout 的 CLI 用旧 settings spawn，模型会过期）
  const old = activeScouts.get(cwd);
  // 走 scout 自己的 cleanup 而非裸 dispose：后者不清 20s 兜底定时器、也不删 CLI 建的 <sid>.jsonl 残留。
  // opts 透传给 cleanup（关闭路径传 { immediate: true }，见 cleanup 的注释）。
  if (old) { try { (old._scoutCleanup || ((() => old.dispose())))(opts); } finally { activeScouts.delete(cwd); } }
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
        // 清单与旧值不同 ⇒ 本区 CLI 配置已变（换网关 / 改模型别名）。此时 defaultModelByCwd 里那条
        // 是【旧配置下】记的，必须作废：它没有别的失效路径（scout 拿不到 init，见下面 onSessionId；
        // 普通实例只有 fresh 新会话才写），留着会让新会话页预显一个当前根本开不出来的模型名。
        // 方向是刻意的：宁可删成空（前端回落显示「默认」）也不显示错的——漏删给的是错误信息，
        // 误删只是少一行提示。取不到旧签名（首次填缓存）则跳过，"不知道"不等于"变了"。
        const prevSig = modelListSignature(modelsCache.get(cwd));
        modelsCache.set(cwd, envelope.payload);
        if (prevSig && prevSig !== modelListSignature(envelope.payload)) defaultModelByCwd.delete(cwd);
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
      // ★ 这里【不】调 recordCwdDefaultModel，也别再加回来。
      // 曾经这样写过，注释还宣称「scout 恒 fresh → 其 init.model 即 cwd CLI 默认，权威缓存之」——
      // 那段行为从未发生过。scout 从不发消息，而 CLI 在首条消息前不输出 init（见 agent.js#fetchModels
      // 的注释），本回调因此实际不会被触发：2026-09-10 实测，起 query 只调 supportedModels()，
      // 1.4s 拿到清单，此后 45s 内零消息、零 init。
      // 于是 defaultModelByCwd 只剩「用户亲手开新会话」一条更新路径，而 modelsCache 走的是
      // supportedModels() 的控制请求通道、不依赖消息流——这就是两个缓存能对同一次配置变更给出
      // 矛盾答案的物理原因。配置变更后的作废改由上面 models 分支按清单签名处理。
      interactionLog.addSessionLog(sid, 'sys_info', `[SYS] scout 获取模型（不留会话入口）: instanceId=${id}, sessionId=${sid}, model=${model || '默认'}, cwd=${cwd}`);
    }
    // 不设 onExit：cleanup 显式调 dispose，consume 循环以 disposed=true 结束并跳过 onExit。
  });

  // 防重入：models 事件与 20s 兜底定时器都可能进来，只做一次。
  // 旧实现用 `if (instance.disposed) return` 当重入闸，但 disposeScoutFor（config:refresh 换 scout）
  // 走的是 instance.dispose() 而非本函数——定时器没被清，20s 后照常进来，此时 disposed 已为 true
  // 便早早返回，连带跳过下面的 transcript 残留清理，留下这段注释自己声明要防的「(无标题)」幽灵条目。
  let cleanedUp = false;
  // immediate：同步删 transcript 残留，不走那条 300ms 延时。关闭路径必须用它——shutdown()
  // 末尾是 `io.close(() => process.exit(0))`，无长连接时 io.close 几乎立刻回调，进程在 300ms
  // 定时器 fire 之前就没了，残留照样留在盘上，而 shutdown 里那行注释声称的正是「裸退出留不下这些」。
  function cleanup({ immediate = false } = {}) {
    if (cleanedUp) return;
    cleanedUp = true;
    clearTimeout(timer);
    activeScouts.delete(cwd);
    const sid = instance._scoutSid;
    if (!instance.disposed) instance.dispose();
    // dispose 触发 abort → CLI 进程退出。CLI 启动时已在 ~/.claude/projects/<projectDir>/
    // 创建了 <sid>.jsonl 文件（含 init 系统消息等）；留之会在 listSessions 中出现「(无标题)」幽灵条目。
    // 异步延迟删除：给 CLI 进程一个信号处理的窗口，避免 unlink 与 CLI 写文件竞争。
    // immediate 下放弃这个窗口是刻意的：进程马上就要退出，「删不干净」的代价确定发生，
    // 而竞争的代价只是 unlink 早一点（POSIX 下 CLI 持有的 fd 不受影响，也不会把文件写回来）。
    if (sid) {
      const removeTranscript = () => {
        try {
          const projectDir = getProjectDir(cwd);
          const file = join(CLAUDE_PROJECTS_DIR, projectDir, `${sid}.jsonl`);
          // safe-path: projectDir 这一段【目录】是 getProjectDir(cwd) 算出来的。它若返回空串，
          // 路径就从 <根>/<项目>/<sid>.jsonl 塌成 <根>/<sid>.jsonl——打到 projects 根目录下。
          // 今天无害的唯一理由是这里用的是 unlinkSync（单文件）：目标不存在就抛、被 catch 吞掉，
          // 且它对目录会直接抛 EISDIR，删不动任何一棵树。
          // ⚠️ 谁要把这里改成 rmSync(..., { recursive: true })（比如为了顺带删子 agent 的 transcript
          // 子目录），先想清楚这一段：2026-08-02 删掉 70 个项目 / 291 memory / 2990 transcript 的，
          // 就是同一形态的递归版本——同一个 getProjectDir 被变异成恒返回 ''，join 塌成真实根本身。
          // 真要递归，必须先在删除点加护栏：resolve(target) === resolve(根) 就抛错。
          unlinkSync(file);
          invalidateListCache(cwd);
        } catch { /* 文件可能已被 CLI 清理或不存在——非致命 */ }
      };
      if (immediate) removeTranscript();
      else setTimeout(removeTranscript, 300);
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

  // !== true（非 === false）：未显式置位时也按「未批准」处理，SEC-01 隔离边界的 fail-closed 方向。
  if (socket.deviceApproved !== true) {
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
      // （terminalSlashCommands 同理一并剥离，两者必须同源，见 resolveSlashCommandsForCwd 头注）
      const { slashCommands: _omitCmds, terminalSlashCommands: _omitTerm, ...initBase } = lastInit;
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
          ...(replayCmds ? { slashCommands: replayCmds.slashCommands, terminalSlashCommands: replayCmds.terminalSlashCommands } : {}),
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
    mirrorStateTo(socket);
    // 可信端连入时重放当前待审批设备列表，使其可立即在 Web UI 远程审批
    socket.emit('agent:event', {
      seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
      type: 'pending_devices', payload: pendingDevicesPayload()
    });
    // 同上，已受信任设备列表（设置 › 访问与设备里的吊销面）。逐 socket 算 isCurrent。
    socket.emit('agent:event', {
      seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
      type: 'trusted_devices', payload: trustedDevicesPayload(socket.handshake.auth?.deviceToken)
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
        const workspaceCwd = ensureWhitelisted(routeCwd(rawCwd), workDirs);
        // 「在新 worktree 里开」：意图跟着这条消息传来，不在服务端留待决状态。建不出来**整条失败**
        // 而不是回落父仓——静默回落意味着用户以为改动隔离了、实际全落在主工作树上，要到 git status
        // 一堆意外改动时才发现。已经在 worktree 里的会话不再嵌套建（resolveManagedWorktree 非空即是）。
        const wantsWorktree = payload && typeof payload === 'object' && payload.useWorktree === true;
        let cwd = workspaceCwd;
        if (wantsWorktree && !resolveManagedWorktree(workspaceCwd, workDirs)) {
          const made = await dedupedWorktreeCreate(workspaceCwd, payload.sourceBranch, payload.text);
          if (!made.ok) {
            console.warn(`[worktree] 懒创建失败（${made.code}）：${made.error}`);
            audit.recordAudit({
              actor: actorFromSocket(socket), action: 'worktree_create', target: workspaceCwd,
              outcome: 'failed', meta: { code: made.code, sourceBranch: payload.sourceBranch ?? null },
            });
            sysTo(socket, `无法创建 worktree：${made.error || made.code}`, true);
            ack({ ok: false, error: made.error || '创建 worktree 失败' });
            return;
          }
          cwd = made.path;
          // 说一声建了什么：名字来自这条消息，但用户没见过生成结果，而它会成为分支名进 git。
          sysTo(socket, `已在新 worktree「${made.branch}」中打开（源分支 ${payload.sourceBranch || '当前分支'}）`);
          audit.recordAudit({
            actor: actorFromSocket(socket), action: 'worktree_create', target: made.path,
            outcome: 'ok', meta: { branch: made.branch, sourceBranch: payload.sourceBranch ?? null },
          });
        }
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
          // SRV-002：懒开须同步裸 viewingCwd——否则 envelopes / pendingModeByCwd 仍指向旧的主工作目录。
          // 托管 worktree 的实例归父仓（workspaceCwdOf）：驾驶在 worktree 里，工作区轴不跟着走。
          viewingCwd = workspaceCwdOf(a.cwd);
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
          viewingCwd = workspaceCwdOf(a.cwd);
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
    // op：客户端回传它渲染审批卡片时所见的 {tool,args,cwd}（端到端审批协议步骤5/6，
    // 审批完整性绑定）——allow 决策时 agent.js#resolvePermission 用它重算指纹比对 askPermission 时
    // 锚定的 fp，不一致 fail-closed 拒绝。deny 决策不校验（拒绝任何操作都安全，op 缺省或不传均可）。
    const { requestId, decision, alwaysThisSession, persistRules, instanceId, op, exitMode } = payload || {};
    if (typeof requestId !== 'string' || !['allow', 'deny'].includes(decision)) return;
    const a = routeInstance(instanceId);
    if (a) {
      interactionLog.addSessionLog(a.logKey(), 'sys_info', `[SYS] 许可决策 (user:approve): requestId=${requestId}, decision=${decision}, alwaysThisSession=${alwaysThisSession}${persistRules ? ', persistRules=true' : ''}${exitMode ? `, exitMode=${exitMode}` : ''}`);
      // persistRules：「永久不再问」。与 alwaysThisSession 不是互斥开关而是包含关系（永久蕴含本会话），
      // 故两个都原样透传，由 resolvePermission 里的那一处判据统一裁决——不在这里预先合并。
      const resolveOpts = { ...(exitMode ? { exitMode } : {}), ...(persistRules ? { persistRules: true } : {}) };
      const outcome = a.resolvePermission(requestId, decision, Boolean(alwaysThisSession), op, Object.keys(resolveOpts).length ? resolveOpts : undefined);
      // 最小审计记录：只在完整性校验失败时写——常规 allow/deny 已完整落在
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
      broadcastTrustedDevices();
      audit.recordAudit({ actor: actorFromSocket(socket), action: 'device_approved', target: deviceId, outcome: 'allowed', meta: { via: 'web' } });
      // 已在这里记过 via:'web'，登记一下免得文件监听器按差集再补一条 via:'cli'（同一动作两条记录、
      // 且归因是错的）。TTY 的回车批准【不】登记——它自己不记审计，监听器是它唯一的审计来源。
      noteAuditedExternally({ trustedAdded: [deviceId], pendingRemoved: [deviceId] });
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
    // 同 user:approveDevice 的纵深防御：只对「确在待审批列表里」的 deviceId 生效。denyDevice()
    // 对已信任 token 同样有效（从 trustedDevices 删除），而已批准客户端每次握手都带着自己完整
    // 的 deviceToken——没有这道守卫，它能拿这个事件传自己的 deviceId 自吊销，绕开
    // user:revokeTrustedDevice 专门加的 self 守卫（decideRevokeByShortId 的 requesterToken 检查）。
    if (!getPendingDevices().some(d => d.deviceToken === deviceId)) {
      console.warn(`[devices] 忽略远程拒绝：${deviceId} 不在待审批列表`);
      return;
    }
    console.log(`[devices] 已信任设备 ${socket.id} 远程拒绝 ${deviceId}`);
    const revoked = denyDevice(deviceId);
    disconnectDeviceSockets(deviceId); // 断连照做：即便落盘失败，也先切断该设备当前连接（纵深防御）
    broadcastPendingDevices();
    broadcastTrustedDevices();
    if (revoked) {
      audit.recordAudit({ actor: actorFromSocket(socket), action: 'device_denied', target: deviceId, outcome: 'denied', meta: { via: 'web' } });
      noteAuditedExternally({ trustedRemoved: [deviceId], pendingRemoved: [deviceId] }); // 同上：已记过，别让监听器再补

    } else {
      // BE-011：吊销落盘失败——磁盘仍含该设备，下次 isDeviceTrusted 重读会复活，不谎报成功，告警 + 提示重试。
      console.error(`[devices] 吊销 ${deviceId} 落盘失败，可能未生效`);
      audit.recordAudit({ actor: actorFromSocket(socket), action: 'device_denied', target: deviceId, outcome: 'error', meta: { via: 'web', persistFailed: true } });
      sysTo(socket, '设备吊销未能写入磁盘、可能未生效，请重试或检查服务端磁盘', true);
    }
  });

  // 给已受信任设备起别名。别名是**唯一对所有平台都成立的分辨手段**：iOS 拿不到机型，
  // 局域网 http:// 下 UA Client Hints 也不可用（非安全上下文），而同一部手机的微信 webview
  // 与 Chrome 本来就是两条独立记录（deviceToken 存在各自的 localStorage）。
  // 与吊销同一条寻址方式（shortId，DEVICE-03 不许下发全量 token），但**没有自改守卫**——
  // 给自己这台起名是正常操作，不像吊销那样会把自己踢下线。
  on(socket, 'user:renameTrustedDevice', payload => {
    const shortId = payload?.shortId;
    if (typeof shortId !== 'string' || !shortId) return;
    const token = resolveShortDeviceId(shortId, getTrustedDeviceIds());
    if (!token) {
      sysTo(socket, '找不到这台设备（列表可能已过期），已为你刷新', true);
      broadcastTrustedDevices();
      return;
    }
    setDeviceAlias(token, payload?.alias); // 归一与限长在 devices.js 里；写失败只是面板少个名字
    broadcastTrustedDevices();
  });

  // 吊销【已受信任】设备。与上面 user:denyDevice 分开是刻意的：那条处理的是待审设备
  // （拒绝一台还进不来的设备是安全方向，载荷里的 deviceId 本就已广播给可信端），
  // 这条处理的是已在用的设备（破坏性），且载荷只有 shortId——DEVICE-03 不许把全量信任表
  // 的 token 下发到网络上，否则一台被吊销的设备手里还攥着其余设备的凭据，吊销就没吊干净。
  // 两个风险档共用一个 handler 迟早写反，所以宁可多一个入向事件。
  on(socket, 'user:revokeTrustedDevice', payload => {
    const shortId = payload?.shortId;
    if (typeof shortId !== 'string' || !shortId) return;
    const d = decideRevokeByShortId({
      shortId,
      requesterToken: socket.handshake.auth?.deviceToken,
      trustedIds: getTrustedDeviceIds(),
    });
    if (!d.ok) {
      // 两种拒绝分开说：self 是「拦住了一次会把你自己锁在门外的操作」，
      // not_found 多半是手里那份列表过期了（别处刚吊过），刷新即可。
      if (d.reason === 'self') {
        sysTo(socket, '不能吊销你正在使用的这台设备——吊销会立刻断开你自己的连接。请在电脑上操作，或先用另一台已信任的设备。', true);
      } else {
        sysTo(socket, '找不到这台设备（列表可能已过期），已为你刷新', true);
      }
      broadcastTrustedDevices();
      return;
    }
    console.log(`[devices] 已信任设备 ${socket.id} 吊销 ${d.token}`);
    const revoked = denyDevice(d.token);
    disconnectDeviceSockets(d.token); // 同 denyDevice 路径：即便落盘失败也先切断（纵深防御）
    broadcastTrustedDevices();
    if (revoked) {
      audit.recordAudit({ actor: actorFromSocket(socket), action: 'device_revoked', target: d.token, outcome: 'denied', meta: { via: 'web' } });
      noteAuditedExternally({ trustedRemoved: [d.token], pendingRemoved: [d.token] }); // 同上：已记过，别让监听器再补

    } else {
      console.error(`[devices] 吊销 ${d.token} 落盘失败，可能未生效`);
      audit.recordAudit({ actor: actorFromSocket(socket), action: 'device_revoked', target: d.token, outcome: 'error', meta: { via: 'web', persistFailed: true } });
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

  // 台阶3：切思考强度档。
  // 【2026-09-03 实测更正】具体档之间互切走 apply_flag_settings 控制请求，运行时生效、不置换实例
  //（此前注释写的「SDK 无 effort 运行时控制」已不成立，见 agent.setEffort 注释）。
  // 唯一仍需置换的方向是「回模型默认档」(level===null)：CLI 的 applied.effort 恒是具体档，
  // 没有「未 pin」态可回，只有重开实例（不传 --effort）才能真正还原。
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
    // 【2026-09-09】busy 守卫下移到重路径分支（原先在此处无差别拦所有档位）。
    // 它是 7febabc（2026-07-28）加的，那时切档必然 dispose+resume，轮次进行中切会腰斩在途回合；
    // 439bb02 把具体档互切改成 apply_flag_settings 控制请求后轻路径不再置换实例，守卫对它就没了理由，
    // 但没跟着下移——于是「回合进行中切不动思考强度」一直留到今天。轻路径此刻放行是安全的：
    // 控制请求不碰实例生命周期，档位生效于 CLI 的下一次 API 请求。
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
    // 轻路径：具体档互切走控制请求。三条 SDK 静默失败边界由 agent.setEffort 统一挡住
    //（非法值 / ultracode 不回落 / null 清不回默认），这里只负责接线与广播。
    const light = await a.setEffort(level);
    if (light.ok) {
      effortByInstance.set(id, level);
      // 持久化只存 SDK effort；ultracode 不落盘（CLI: interactive toggles never persist）
      sessions.updateSessionPrefs(sid, { effort: sdkEffort });
      interactionLog.addSessionLog(sid, 'sys_info', `[SYS] 切换思考强度 (user:setEffort): level=${level}${ultracode ? ' (Settings.ultracode)' : ''}, 运行时生效（未置换实例）`);
      io.to('approved').emit('agent:event', {
        seq: 0, epoch: 'server', sessionId: sid, instanceId: id, ts: Date.now(),
        type: 'effort_mode', payload: { level }
      });
      broadcastInstances();
      return;
    }
    if (!light.needsSwap) {
      // 明确失败（超时 / CLI reject）：档位没动，如实拨回，不谎报成功
      sysTo(socket, `思考强度切换失败（${light.error}），仍为「${effortOf(id) ?? '模型默认'}」`, true);
      return effortTo(socket);
    }
    // needsSwap → 落到下面的置换实例路径（回模型默认档，或实例尚无控制通道）。
    // busy 守卫只守到这里：置换会 kill 在途 turn / bg / 审批，理由与 SRV-003 同源（那条锚在
    // externalDirty 路径上，这里是同一危害的另一个触发点）。文案给出替代路径——具体档位走轻路径，
    // 此刻就能切，不必等回合结束。
    if (a.isBusy()) {
      sysTo(socket, '回「模型默认」要重开会话实例，而当前有任务在运行。请等本轮结束，或改选一个具体档位（立即生效）', true);
      return effortTo(socket);
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
      viewingCwd = workspaceCwdOf(ni.cwd);
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
    viewingCwd = workspaceCwdOf(a.cwd);
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
    unreadCounts.delete(id); // 胶囊数字含 live；只清快照会在下次 sync 把活计数再送回去
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
    // 当前唯一前端调用点（session:home 恒发 {}）不带 cwd，这个分支走不到；仍按「viewingCwd 永远
    // 落工作区轴」这道不变量补 workspaceCwdOf 做防御性一致（同 reselectViewingAfter/setViewing 等处）。
    if (typeof obj.cwd === 'string' && obj.cwd) {
      viewingCwd = workspaceCwdOf(ensureWhitelisted(routeCwd(obj.cwd), workDirs));
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
    const obj = (payload && typeof payload === 'object') ? payload : null;
    const cwd = ensureWhitelisted(obj ? routeCwd(obj.cwd) : viewingCwdOf(), workDirs);

    // cwd（驾驶轴，供下面路由代次/当前指针/懒开使用）保持原样，可以是托管 worktree 路径；
    // viewingCwd（工作区展示轴）另外归一化——两个前端调用点目前只会传顶层工作区目录（抽屉按行 /
    // 全局 currentCwd），worktree 从不出现在这里，故此刻是无操作的防御性对齐，不改变现有行为。
    viewingCwd = workspaceCwdOf(cwd);
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
    // 【工作区轴 vs 驾驶轴】托管 worktree 的会话打开后，**工作区轴仍归父仓**：viewingCwd 是
    // 「新开会话落哪、侧栏列哪一页、顶栏显示哪个工作区」的锚，把它设成 worktree 路径等于让
    // worktree 事实上变成一个工作区条目——而产品判据恰恰是「worktree 是临时模式，不占抽屉条目，
    // 干完合并回父仓」。驾驶轴不受影响：inst.cwd 仍是 worktree，SDK 就在那儿跑。
    // 两轴合一的症状很隐蔽：打开一个 worktree 会话后侧栏突然只剩那一条，看着像会话丢了。
    const workspaceCwd = workspaceCwdOf(cwd);
    viewingCwd = workspaceCwd;
    sessions.setCurrent(workspaceCwd, sessionId); // 记为该工作区最后查看会话（session:list 的 currentSessionId 等）
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
    // 会话所在的 worktree 已被删掉（2026-09-13）。这类会话现在仍列在抽屉里（transcript 还在，
    // 见 history.js 的 listManagedWorktreeDirs），所以必须在这里给出真实原因——不拦的话
    // routeCwd 会把这条悬空路径记成一次 scope_violation 再回退父仓，用户拿到的是「会话不存在」
    //（会话明明还在），审计里还多一条并非越界的安全事件。
    //
    // 【为什么是拒绝而不是放行到父仓】cwd 已经不存在，SDK spawn 必然 ENOENT（实测：
    // spawn 到不存在的 cwd 直接抛 error 事件，进程起不来）。放行只是把同一个失败从一句话
    // 推迟成一个起不来的进程 + 一段读不懂的 stderr。历史仍在盘上，要救得先把那棵树建回来。
    //
    // ★ live 实例必须放行。worktree 被删的那一刻会话往往**正跑着**（真机就是这样：模型自己
    // `git worktree remove` 完，同一个会话继续在跑），此时点它只是切视图、不需要 spawn 任何东西。
    // 不放行等于把用户锁在自己正在跑的会话外面——比原来的「会话不存在」还糟。
    // forSession 已跳过 terminating/disposed；命中则是可续用 live，fresh resume 仅在无 live 时。
    // 提前到这里取，是因为下面两处判据都要用它区分「切视图」和「要 spawn」。
    const live = typeof sessionId === 'string' ? instanceForSession(sessionId) : null;
    const goneWorktree = resolveGoneWorktreeParent(payload?.cwd, workDirs);
    if (goneWorktree && !live) {
      ack?.({
        ok: false,
        error: `这个会话的 worktree「${projectNameFromCwd(payload.cwd)}」已被删除，所以打不开了。`
          + `对话记录还在磁盘上，把那棵 worktree 重新建回原路径即可恢复。`,
      });
      return;
    }
    // 台阶3：在指定 cwd 内打开/聚焦会话（缺省当前查看实例 cwd）。ensureWhitelisted 同 session:new(#8)：
    // routeCwd 的缺省回退(viewingCwdOf)可能仍是热移除目录（该目录有 live 实例挂着未被归位），不夯一次
    // 白名单会绕过「仅拒新开」——落到非白名单目录后 sessionFileExists 大概率会因该目录下无此 sessionId 而
    // 拒绝（ack 回 '会话不存在'），是安全的失败模式，不会误开其他目录下的会话。
    //
    // 树已删 + live：cwd 必须取实例自己的驾驶轴。走 routeCwd 的话那条悬空路径会被判越界、回退成父仓，
    // 紧接着的 sessionFileExists 按父仓的 project 目录去查必然查空 —— 用户被锁在一个自己正跑着的
    // 会话外面，拿到的还是「会话不存在」。这一支不新增授权面：live 实例的 CLI 本来就在那儿跑着。
    const cwd = goneWorktree ? live.cwd : ensureWhitelisted(routeCwd(payload?.cwd), workDirs);
    // 归属校验以「jsonl 存在于本 cwd 的 project 目录」为准：既拒跨 cwd / 失效 id，又接纳终端建的会话。
    if (typeof sessionId !== 'string' || !(await sessionFileExists(cwd, sessionId))) {
      if (typeof ack === 'function') ack({ ok: false, error: '会话不存在' });
      return;
    }
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
    // 【锚点由服务端算，不盲信前端送来的 uuid】前端能拿到的只有气泡的 uuid，而工具卡在 DOM 里
    // 没有 uuid（history.js 只给文本类挂），于是「保留轮的最后一条 entry 是 tool_result」这种
    // 形态在前端【结构上】就看不见。SDK 的规则是 fork at the KEPT turn's last chain entry，
    // 而 forkSession 的切片是纯 inclusive slice、零修正——锚早了它照切，tool_use 就悬空。
    // keepAnchorTurn：true=长按 assistant「从这里分叉」保留这一轮；false=长按 user「丢弃这条及之后」。
    // 缺省 true 是为兼容老前端（它送的就是 assistant uuid、语义正是保留到那条所在轮）。
    const keepAnchorTurn = payload?.keepAnchorTurn !== false;
    const plan = planFork(await readSessionEntries(cwd, sessionId), uuid, { keepAnchorTurn });
    if (!plan.ok) {
      if (typeof ack === 'function') ack({ ok: false, error: describeRewindBlocker(plan) || '无法确定分叉位置', reason: plan.reason });
      return;
    }
    const { sessionId: newId } = await sdkForkSession(sessionId, { dir: cwd, upToMessageId: plan.keepUuid });
    sessions.bumpGeneration(cwd);
    const inst = await dedupedResume(cwd, newId);
    finishOpenFocus(inst, cwd, newId, ack);
  });

  // 文件轴 Rewind 的预览：回答「这一轮能不能回退、回退会动哪些文件」，**只读，不动磁盘**。
  //
  // 守卫顺序不是随意的，两处必须按这个次序：
  //  ① 跨驾驶员检查【在懒唤醒之前】——否则会为一个必然被拒的请求 spawn 一个 CLI 子进程；
  //  ② 截断可行性（planRewind）【在 rewindFiles 之前】——CLI 对「丢弃区间混进了别的轮」是
  //     确定性拒绝且不可重试，等到 confirm 才发现时磁盘已经回滚过了，那个撕裂态无法自动恢复。
  //     判据 CCM 自己能复算（transcript 就在磁盘上），所以提前到这里，拒绝时一个字节都没动。
  // `/rewind` 第一步的清单：列出每一轮人类 prompt，供用户挑「回到哪一轮之前」。**只读**。
  //
  // 【为什么不复用 session:history】那份是展平后的气泡（一轮会展成多条 text/tool_use），
  // 且工具卡不带 uuid；回退锚点只认人类 prompt 自身的 uuid，得从原始 jsonl 条目上取。
  // 【text 在这里截断】清单只需要一行预览，而大会话有几百轮，整段正文传过去是白付流量。
  on(socket, 'session:rewind:candidates', async (payload, ack) => {
    const reply = (r) => { if (typeof ack === 'function') ack(r); };
    const sessionId = payload?.sessionId;
    const cwd = ensureWhitelisted(routeCwd(payload?.cwd), workDirs);
    if (typeof sessionId !== 'string' || !(await sessionFileExists(cwd, sessionId))) {
      reply({ ok: false, error: '会话不存在' });
      return;
    }
    let entries;
    try {
      entries = await readSessionEntries(cwd, sessionId);
    } catch (err) {
      console.error('[rewind] 读取候选失败', err?.message || err);
      reply({ ok: false, error: '无法读取会话历史' });
      return;
    }
    const items = listRewindCandidates(entries).map(c => ({
      ...c,
      text: c.text.length > 200 ? `${c.text.slice(0, 200)}…` : c.text,
    }));
    reply({ ok: true, items });
  });

  on(socket, 'session:rewind:preview', async (payload, ack) => {
    const reply = (r) => { if (typeof ack === 'function') ack(r); };
    const sessionId = payload?.sessionId;
    const promptUuid = payload?.promptUuid;
    const cwd = ensureWhitelisted(routeCwd(payload?.cwd), workDirs);
    if (typeof sessionId !== 'string' || !(await sessionFileExists(cwd, sessionId))) {
      reply({ ok: false, error: '会话不存在' });
      return;
    }
    if (typeof promptUuid !== 'string' || !promptUuid) {
      reply({ ok: false, error: '缺少回退锚点' });
      return;
    }

    // G2 跨驾驶员：终端在跑命令或卡在审批框上，手机端回退会破坏对端环境。fail-closed。
    let states = new Map();
    try { states = await listTerminalSessionStates({ classifyTail: classifyTranscriptTail }); } catch { /* fail-open 到空表 */ }
    if (hasBusyTerminalSessionForCwd(cwd, states) || hasWaitingTerminalSessionForCwd(cwd, states)) {
      reply({ ok: false, error: '终端会话正在运行或等待审批，暂时无法回退' });
      return;
    }

    // G4 冷会话：快照在磁盘上，实例被回收不影响可回退性——懒唤醒即可。
    const inst = instanceForSession(sessionId) || await dedupedResume(cwd, sessionId);
    // G1 本实例在跑：模型随时在写文件，此时回退必发写锁抢占。fail-closed。
    if (inst?.isBusy?.()) {
      reply({ ok: false, error: '当前会话正在执行中，无法回退文件' });
      return;
    }
    // G8 没有 Query 句柄（CLI 镜像会话等）：结构性无法发起回滚，不是「暂时不行」。
    if (!inst?.q?.rewindFiles) {
      reply({ ok: false, error: '该会话不支持文件回退' });
      return;
    }

    // G10 截断可行性预判（见上方 ②）。
    // 【只挡对话轴，别连文件轴一起挡】planRewind 回答的是「分叉时该保留到哪条」，首轮之前没有
    // 可保留的锚点所以它返回 first-turn。但「只恢复代码」根本不 fork，那一轮的文件快照照样能
    // 还原——在这里整体拒绝等于让单轮会话完全用不了 Restore code，而终端能（PR #102 review）。
    // 其余 reason（prompt-not-found 等）仍然是整体性失败，照旧拒绝。
    const entries = await readSessionEntries(cwd, sessionId);
    const plan = planRewind(entries, promptUuid);
    if (!plan.ok && plan.reason !== 'first-turn') {
      reply({ ok: false, error: describeRewindBlocker(plan), reason: plan.reason });
      return;
    }
    const canForkConversation = plan.ok;

    let res;
    try {
      res = await withRewindTimeout(inst.q.rewindFiles(promptUuid, { dryRun: true }));
    } catch (err) {
      reply({ ok: false, error: '无法读取回退预览', reason: 'rewind-failed' });
      console.error('[rewind] preview 失败', err?.message || err);
      return;
    }
    // G11：canRewind 只表示「找得到检查点」，不表示「回退会改变什么」——空轮次照样 true。
    // 判「值不值得弹确认框」看 filesChanged，否则用户会收到一个「将恢复 0 个文件」的确认框。
    const filesChanged = Array.isArray(res?.filesChanged) ? res.filesChanged : [];

    // G5：回退是覆盖式写文件，工作区里没提交的活会被无声冲掉。
    // 【只报真有风险的那部分】不是「工作区 dirty 就警告」——开发中 dirty 是常态，每次都弹
    // 用户三次之后就学会无视了。只报「回退会碰 且 改动没进 git 对象库」的交集，判据见
    // files/git-workspace.js 的 riskyUncommittedPaths。
    // 失败方向是【放行】：非 git 仓库、git 读失败、超时 —— 一律不拦也不警告。
    // 这条是知情提示不是安全闸，为它挡住一次合法回退才是更坏的结果。
    let dirtyOverlap = [];
    try {
      const repoRoot = await gitRepoRoot(cwd);
      if (repoRoot) {
        const changes = await listGitChanges(cwd);
        dirtyOverlap = overlapRiskyFiles(filesChanged, riskyUncommittedPaths(changes), repoRoot);
      }
    } catch (err) {
      console.error('[rewind] G5 脏改动检查失败（放行）', err?.message || err);
    }

    // 【为什么要分两种 reason】两者的出路相同（都能改用分叉），但成因不同、文案不能混：
    // no-file-changes 是本轮特性——找得到检查点，这一轮就是没往盘上写过东西（只跑 Bash 的轮次
    // 正是这一档，checkpoint 只在 Edit/Write 前快照）；no-checkpoint 是能力边界——SDK 说这条
    // 消息没有可用检查点。前端据此给不同说明，否则「没有文件改动」会扣到后者头上、是假话。
    const canRewind = !!res?.canRewind && filesChanged.length > 0;
    reply({
      ok: true,
      canRewind,
      ...(canRewind ? {} : { reason: res?.canRewind ? 'no-file-changes' : 'no-checkpoint' }),
      filesChanged,
      insertions: res?.insertions ?? 0,
      deletions: res?.deletions ?? 0,
      keepUuid: plan.keepUuid ?? null,
      // 对话轴单独回一个字段：首轮能恢复代码但不能分叉，前端据此只禁掉需要 fork 的那两个模式。
      canForkConversation,
      dirtyOverlap,
    });
  });

  // 文件轴 Rewind 的执行：回滚文件 + 分叉出一个「回到那一刻」的新会话。
  //
  // 【为什么是 fork 而不是原地截断】判据是失败后果是否可逆，详见 sessions/rewind-plan.js 头注：
  // 原地截断一旦判错就永久丢对话，而 fork 里原会话一个字节没动。Claude Desktop 在同一问题上
  // 也选了 fork（且全程不传 resumeDropsTurn），本仓对齐。
  //
  // 【顺序：先回滚文件，后分叉】两步之间崩溃的话：
  //   · 当前顺序 → 文件回退了、没建新会话。原会话还在，用户重来一次即可，磁盘可由 git 找回。
  //   · 反过来  → 建了新会话但文件还在未来，用户会在一个"看起来已回退"的会话里对着新代码说话。
  // 前者的中间态是自洽的，后者不是。
  on(socket, 'session:rewind:confirm', async (payload, ack) => {
    const reply = (r) => { if (typeof ack === 'function') ack(r); };
    const sessionId = payload?.sessionId;
    const promptUuid = payload?.promptUuid;
    const cwd = ensureWhitelisted(routeCwd(payload?.cwd), workDirs);
    if (typeof sessionId !== 'string' || !(await sessionFileExists(cwd, sessionId))) {
      reply({ ok: false, error: '会话不存在' });
      return;
    }
    if (typeof promptUuid !== 'string' || !promptUuid) {
      reply({ ok: false, error: '缺少回退锚点' });
      return;
    }

    // G3 并发锁。键是 sessionId：防连击与移动端网络重发把同一批文件回滚两次。
    if (!rewindLocks.tryAcquire(sessionId)) {
      reply({ ok: false, error: '该会话的回退正在进行中，请稍候' });
      return;
    }

    // 非 null = 底层回滚还在飞（超时分支设的）：锁跟着它放，不跟着本 handler 放。
    let holdLockUntil = null;
    try {
      // G2 重查（preview 到 confirm 之间用户可能回到电脑前敲了命令）
      //
      // 【这条路径 fail-CLOSED，与同一张表的其他消费者相反】别处（会话列表、rewind preview）
      // 拿它当加分信号：读不动就少标一个「运行中」，无害。这里它是**否定证据**——「表里没有
      // 终端驾驶员」被当成「可以安全覆盖工作区文件」。表读不全时那个结论不成立，而 rewind
      // 没有下游兜底（列表还有「点开后仍被拒」那一道，这里盖下去就是盖下去了），
      // 正是单驾驶员模型要防的两端同时写。宁可让用户重试。
      let states = new Map();
      let registryUnreadable = false;
      try {
        states = await listTerminalSessionStates({
          classifyTail: classifyTranscriptTail,
          onUnreadable: () => { registryUnreadable = true; },
        });
      } catch { registryUnreadable = true; }
      if (registryUnreadable) {
        reply({ ok: false, error: '读不到终端会话注册表，无法确认电脑上是否正在驾驶该工作区，已中止回退', reason: 'terminal-state-unknown' });
        return;
      }
      if (hasBusyTerminalSessionForCwd(cwd, states) || hasWaitingTerminalSessionForCwd(cwd, states)) {
        reply({ ok: false, error: '终端会话正在运行或等待审批，暂时无法回退' });
        return;
      }

      const inst = instanceForSession(sessionId) || await dedupedResume(cwd, sessionId);
      if (inst?.isBusy?.()) {
        reply({ ok: false, error: '当前会话正在执行中，无法回退文件' });
        return;
      }
      if (!inst?.q?.rewindFiles) {
        reply({ ok: false, error: '该会话不支持文件回退' });
        return;
      }

      const entries = await readSessionEntries(cwd, sessionId);
      const plan = planRewind(entries, promptUuid);

      // 终端 /rewind 第二步的三个模式：两样都做 / 只对话 / 只文件。未知值退化成「两样都做」，
      // 判据与理由见 sessions/rewind-plan.js 的 rewindStepsFor。
      // 【必须在 planRewind 的拒绝之前读】那是【对话轴】判据（first-turn＝之前没有可保留的锚点），
      // 而「只恢复代码」根本不 fork。preview 已经为此放行了首轮，confirm 这边若仍无条件拒绝，
      // 新暴露的那个按钮就是点了必然失败的假选项（PR #104 review）。
      const { restoreCode, forkConversation } = rewindStepsFor(payload?.mode);
      const blocked = rewindConfirmBlocked(plan, payload?.mode);
      if (blocked) {
        reply({ ok: false, error: describeRewindBlocker(plan), reason: blocked });
        return;
      }
      // 回退的下一步多半是把这句话改一改重说，所以把原话带回去回填输入框（edit-and-retry）。
      // 【必须在 fork 之前取】fork 后的新会话不含目标轮，那时再找就找不到了。
      const prefill = extractPromptText(entries.find(e => e?.uuid === promptUuid));

      // ── 第 1 步：物理回滚 ──
      // restoreCode=false（只回退对话）时整段跳过：一个字节都不该碰磁盘，连 dryRun 都不发——
      // 那是 control_request，会白白占住 CLI 一个往返。
      let real = null;
      if (restoreCode) {
      // 留住原始 promise：超时只是本 handler 不再等，那个 control_request 还在飞。
      const rollback = inst.q.rewindFiles(promptUuid, { dryRun: false });
      try {
        real = await withRewindTimeout(rollback);
      } catch (err) {
        if (err instanceof RewindTimeoutError) {
          // 文件到底改没改，此刻**不知道**——不能说「未改动」。
          // 锁也不能在 finally 里就放：一放用户就能重试，而第一次回滚可能正改到一半，
          // 那正是 G3 这把锁存在的理由。改成跟着底层操作走（TTL 仍是最后兜底）。
          holdLockUntil = rollback;
          console.error('[rewind] 回滚超时，控制请求仍在进行中', { sessionId });
          reply({
            ok: false,
            error: '回退请求超时，文件是否已改动尚不确定。请刷新文件列表确认后再决定是否重试',
            reason: 'rewind-timeout',
          });
          return;
        }
        console.error('[rewind] 回滚失败', err?.message || err);
        reply({ ok: false, error: '回退失败，文件未改动', reason: 'rewind-failed' });
        return;
      }
      if (!real?.canRewind) {
        reply({ ok: false, error: real?.error || '回退失败，文件未改动', reason: 'rewind-refused' });
        return;
      }
      }

      // ── 第 2 步：G6 复核 ── 不信 canRewind：per-file 失败既不计入 skippedLinks 也不抛错，
      // 「回退了一半」这一档接口是成功返回的。再 dryRun 一次，真恢复到位就该「无事可做」。
      // 没回滚过就没有可复核的，verdict 留空（下面 base 里按 restoreCode 决定要不要带它）。
      let verdict = null;
      if (restoreCode) {
        let recheck = null;
        try { recheck = await withRewindTimeout(inst.q.rewindFiles(promptUuid, { dryRun: true })); } catch { /* 保守判失败 */ }
        verdict = rewindOutcomeVerdict(recheck);
      }

      // ── 第 3 步：分叉出新会话（原会话完整保留）──
      // upToMessageId 是 inclusive slice：新会话保留到 keepUuid 为止，即目标轮之前的全部内容。
      // forkConversation=false（只回退文件）时不产生新会话：用户留在原会话里，对话一条没少。
      let newId = null, forkError = null;
      if (forkConversation) {
        try {
          ({ sessionId: newId } = await sdkForkSession(sessionId, { dir: cwd, upToMessageId: plan.keepUuid }));
          sessions.bumpGeneration(cwd);
        } catch (err) {
          forkError = err?.message || String(err);
          console.error('[rewind] 分叉失败', forkError);
        }
      }

      refreshStatusLine('rewind').catch(err => console.error('[statusline]', err));

      // 广播给该会话的其他连接：文件变了，且出现了一个新会话。SEC-01：只发已批准设备。
      io.to('approved').emit('agent:event', {
        seq: 0, epoch: 'server', sessionId, ts: Date.now(),
        type: 'rewind_applied',
        payload: {
          cwd, droppedFromUuid: promptUuid, forkedSessionId: newId,
          filesChanged: Array.isArray(real?.filesChanged) ? real.filesChanged : [],
          skippedLinks: real?.skippedLinks ?? 0,
          // 前端据此挑文案。少了它，「只恢复代码」这档（本来就不该有新会话）会被
          // 按 forkedSessionId 为空误报成「新会话创建失败」。
          mode: forkConversation ? (restoreCode ? 'code_and_conversation' : 'conversation') : 'code',
        },
      });

      const base = {
        ok: true,
        forkedSessionId: newId,
        prefill,
        filesChanged: Array.isArray(real?.filesChanged) ? real.filesChanged : [],
        skippedLinks: real?.skippedLinks ?? 0,
        unrestored: verdict?.unrestored ?? 0,
        // warning 只留【整体性】问题的整句。「哪几个文件没恢复」「几个软链接被跳过」是
        // 结构化数据（unrestored / skippedLinks），交给前端按 i18n 组装——服务端这边是裸中文，
        // 拼进去英文用户就只能看中文。见 public/js/logic/rewind.js。
        // 只回退对话时文件根本没动过，措辞不能照说「文件已回退」。
        warning: forkError
          ? `${restoreCode ? '文件已回退，但' : ''}新会话创建失败（${forkError}）。原会话未受影响，可重试。`
          : null,
        // 前端据此区分「没有新会话」是本来就不该有（只回退文件）还是 fork 失败了。
        mode: forkConversation ? (restoreCode ? 'code_and_conversation' : 'conversation') : 'code',
      };
      if (!newId) { reply(base); return; }
      // 复用 session:fork 的「打开/聚焦」收尾：切到新会话，与既有分叉体验一致。
      const fresh = await dedupedResume(cwd, newId);
      finishOpenFocus(fresh, cwd, newId, (r) => reply({ ...base, ...r, ok: true }));
    } finally {
      if (holdLockUntil) {
        // 回滚结果已经没人在等了，但不接住就是一条 unhandled rejection。
        holdLockUntil.catch(() => {}).finally(() => rewindLocks.release(sessionId));
      } else {
        rewindLocks.release(sessionId);
      }
    }
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

  // P1（7/26 CCD 调研吸收）：给会话列表行标注「外部驾驶员在驾驶」状态。数据源是进程注册表
  // （~/.claude/sessions/<PID>.json），一次扫盘标注整页——此前纯外部终端会话在列表里没有任何运行
  // 徽标（徽标只来自 live instances 条目，外部会话无 live 实例即无徽标）。注册表读不动 → 空 Map，
  // 返回不带 terminal 的克隆列表（fail-open，且不污染 listSessionsPage 的缓存对象）。
  //
  // classifyTranscriptTail 注入（2026-09-06）：桌面端 Code 模式（entrypoint=claude-desktop）写活体
  // 条目但不写 status，"在不在跑"只能看磁盘尾部形态。注入而非让 session-registry 直接 import，是为
  // 了保住它的叶子性（它现在只依赖 shared/claude-home）并让判定可注入假函数单测。
  // 成本：只对【无 status 自报且进程活着】的条目读一次尾窗（实测本机 6 个，远少于列表候选窗的 51 个），
  // 且与镜像锁走同一个 classifyTranscriptTail —— 判据同源，不另造一份 64KB 版本。
  async function annotateTerminalStates(cwd, list) {
    let states = new Map();
    try {
      states = await listTerminalSessionStates({ classifyTail: classifyTranscriptTail });
    } catch { /* fail-open */ }
    return {
      list: applyTerminalStatesToSessions(cwd, list, states),
      terminalBusy: hasBusyTerminalSessionForCwd(cwd, states),
      // terminalWaiting（2026-09-04）：该 cwd 下是否有终端卡在对话框上等人（含权限审批框）。
      // 与 terminalBusy 并列而非取代——同一 cwd 可能一个会话在跑、另一个在等人，合成一个字段会丢信息。
      terminalWaiting: hasWaitingTerminalSessionForCwd(cwd, states),
    };
  }

  on(socket, 'session:list', async (payload, maybeAck) => {
    // 兼容两种调用形态：emit('session:list', cb)（app.js 现状）与 emit('session:list', {cwd, all?, query?}, cb)
    const ack = typeof payload === 'function' ? payload : maybeAck;
    if (typeof ack !== 'function') return;
    const obj = payload && typeof payload === 'object' ? payload : {};
    const cwd = routeCwd(obj.cwd); // 缺省查看实例 cwd
    // 数据源 = 扫 ~/.claude/projects/<编码cwd>/（与 CLI /resume 同源，含终端会话），天然按 cwd 隔离。
    // currentSessionId 取该 cwd 指针，但仅当其 jsonl 属本 cwd 才回传（否则 null）。
    const id = sessions.getCurrent(cwd);
    // 工作区级判断：指针存在父仓名下，值可能是托管 worktree 里的会话（见 history.js 同名注释）
    const currentSessionId = (id && await sessionExistsInWorkspace(cwd, id)) ? id : null;
    const query = typeof obj.query === 'string' ? obj.query.trim() : '';
    // 每工作区历史会话默认截断到 sessionLimit（workdirs.json 可配，默认 6）；all:true（前端「显示全部」）用硬顶 MAX_SESSION_LIMIT。
    // query 非空走 SEARCH_RESULT_LIMIT（返回条数，与浏览硬顶同量级）。窗外旧会话能搜到靠的是
    // history.js 的 SEARCH_SCAN_LIMIT 全量 readdir，不是把 RESULT 抬过 50。
    const all = obj.all === true;
    const limit = query
      ? SEARCH_RESULT_LIMIT
      : (all ? MAX_SESSION_LIMIT : (sessionLimitByDir.get(cwd) ?? DEFAULT_SESSION_LIMIT));
    const { sessions: list, hasMore, total } = await listSessionsPage(cwd, {
      limit,
      query: query || undefined,
      excludeIds: pendingDeleteIds.size ? new Set(pendingDeleteIds) : undefined,
    });
    // 手动标「稍后再看」的会话不受分页截断（2026-09-08）：limit 只管时间序的那一页，而手动标记是
    // 用户显式输入的待办——长按确认框承诺「这一行会一直显示未读，直到你再次打开它」，被 limit 滑出
    // 窗口就是当场食言：标记还在 read-state 里，UI 上却再也找不回来，只能靠标题搜索。
    // 触发不需要极端条件——默认窗口只有 6 条（DEFAULT_SESSION_LIMIT），活跃工作区几天就能把一条
    // 标记挤出去；「显示全部」的 50 条硬顶只是把期限拉长。
    // 与 isSessionUnread 里 `if (manual) return true` 压过所有时间判据同向：显式标记同样压过时间截断。
    //
    // 搜索态不补：搜索是另一条轴，往结果里塞未匹配的行等于污染搜索语义（用户搜 "foo" 却看见 "bar"）。
    // 已在本页的不补：那条已经有行了，补进来就是同一会话两行。
    const inPage = new Set(list.map(s => s.id));
    // pendingDeleteIds 同样要排除：listSessionsPage 那条路径经 excludeIds 过滤了，这条独立的
    // pinned（手动标未读、不受分页截断）走的是 listSessionsByIds——它没有 excludeIds 形参，
    // 此前完全没挡，删除在途（sdkDeleteSession 的 await 窗口内）又恰好被手动标过未读的会话，
    // 会在并发的 session:list 响应里继续出现在 pinned 数组里。
    const pinnedIds = query ? [] : readState.manualUnreadIds().filter(id => !inPage.has(id) && !pendingDeleteIds.has(id));
    const pinned = pinnedIds.length ? await listSessionsByIds(cwd, pinnedIds) : [];
    // 拼成一趟标注：annotateTerminalStates 每次都要读一遍终端注册表（可能还带尾窗读盘），分两次调用
    // 等于把这个成本翻倍，而两组行本来就同属一个 cwd、同一时刻的状态。标完按长度切回来——
    // applyTerminalStatesToSessions 只做等长克隆映射，顺序与入参一致。
    const terminal = await annotateTerminalStates(cwd, pinned.length ? [...list, ...pinned] : list);
    const pinnedRows = pinned.length ? terminal.list.slice(list.length) : [];
    const pageRows = pinned.length ? terminal.list.slice(0, list.length) : terminal.list;
    // 诚实返回 hasMore：即便 all:true 也不得强制 false——否则「还有更早会话」对用户不可见。
    // readState 搭这趟车回去（不另开广播）：列表数据与已读位点必须同帧到达，否则会出现
    // 「行更新了、位点还是旧的」的撕裂——抽屉每次 SWR revalidate 都会重算未读，撕裂立刻可见。
    // terminalBusy / terminalWaiting 必须【成对】上线：前端 updateTerminalStateForDir 对每个字段各自
    // 判 `typeof === 'boolean'`，缺哪个就把哪个静默回落成「只扫本页返回行」——而这两个汇总存在的理由
    // 恰恰是覆盖页外条目。漏传不报错、页内场景照常显示，缺陷只在「等人的那个终端恰好在分页窗口外」
    // 时现形（waiting 半边曾这样漏了两天）。
    // pinned 与 sessions 分开回而不是拼进同一个数组：sessions 的语义是「时间序的这一页」，
    // hasMore/total 都是对它说的，混进去会让三个字段互相说不通；前端也要单独渲染成一组。
    // readState 必须覆盖两组行——pinned 行的 manual 位点若不搭车，前端拿不到判据，那一行反而不亮未读。
    ack({ currentSessionId, sessions: pageRows, pinned: pinnedRows, terminalBusy: terminal.terminalBusy, terminalWaiting: terminal.terminalWaiting, hasMore, total, readState: readStateForRows([...pageRows, ...pinnedRows]) });
  });

  // 跨设备已读位点（2026-09-03）。此前位点只在各设备的 localStorage 里，换一台设备 seen 表为空、
  // 全部回落到「本设备首次打开时刻」这个很老的基线 → 在另一台读过的会话整屏复亮。
  // read:sync = 连上时把本地表推来归并、取回权威态（升级前攒的记录与离线期间的记录都由这趟迁移）；
  // read:mark = 单条增量，刻意不带 ack——丢一条不致命，下次 read:sync 的全量归并会把它补回来。

  // session:list 搭车用的裁剪版：只回本页这些行的位点。全量表上限 500 条（约 27KB），而抽屉每 12 秒
  // 就 revalidate 一次、多目录并发，全量搭车纯属浪费手机流量。裁剪安全的前提是前端 hydrate 逐 key
  // 取 max、只增不减——少回的 key 不会把本地已有的位点抹掉，最坏只是这一趟没带来新信息。
  function readStateForRows(rows) {
    const state = readState.getReadState();
    const seen = {};
    const manual = {};
    for (const row of rows || []) {
      if (!row?.id) continue;
      if (state.seen[row.id] !== undefined) seen[row.id] = state.seen[row.id];
      if (state.manual[row.id] !== undefined) manual[row.id] = state.manual[row.id];
    }
    return { baselineTs: state.baselineTs, seen, manual };
  }
  on(socket, 'read:sync', (payload, ack) => {
    if (typeof ack !== 'function') return;
    ack({ ok: true, state: readState.applyClientReadState(payload) });
  });

  on(socket, 'read:mark', payload => {
    const sessionId = payload?.sessionId;
    if (typeof sessionId !== 'string' || !sessionId) return;
    if (typeof payload?.manual === 'boolean') readState.setManualUnread(sessionId, payload.manual, payload.at);
    else readState.markRead(sessionId, payload?.seenAt);
  });

  // 彻底删除：显式二次确认（前端弹窗把关）——真删底层 transcript 文件，不可恢复。
  // 活跃会话保护两道，任一不过 fail-closed 拒绝（防与 claude 侧并发写分叉，启发式非完备、已如实登记）。
  on(socket, 'session:deletePermanent', async (payload, ack) => {
    if (typeof ack !== 'function') return;
    const { sessionId } = payload || {};
    const cwd = routeCwd(payload?.cwd);
    if (typeof sessionId !== 'string' || !(await sessionFileExists(cwd, sessionId))) {
      return ack({ ok: false, error: '会话不存在' });
    }
    // 两道保护共用这一个出口。**拒绝也要留痕**：这两条路既不写日志也不写审计时，用户报
    // 「点了 🗑 没反应、会话还在」事后无法验尸——2026-09-12 那次只能靠"审计里没有 success 记录"
    // 反推是被拒了，分不出是哪道。收敛成一个出口而不是逐处 recordAudit：两处拒绝是同一件事的
    // 两个原因，分开写就会有一处被后来的人漏掉，而漏掉的那处和写对了看起来一模一样。
    const rejectDelete = (reason, error) => {
      audit.recordAudit({ actor: actorFromSocket(socket), action: 'session_delete_l2', target: sessionId, outcome: 'rejected', meta: { cwd, reason } });
      return ack({ ok: false, error });
    };
    // 保护① + SRV-NEW-004：无 live driver，且无 in-flight resume（switch/open 窗口）
    const delGuardL2 = canDeleteSessionGuard({
      liveInstance: !!instanceForSession(sessionId),
      resumeInFlight: resumeInFlight.has(sessionId),
    });
    if (!delGuardL2.ok) {
      return rejectDelete(delGuardL2.reason, delGuardL2.reason === 'opening'
        ? '会话正在打开中，请稍后再删除'
        : '会话正在被本产品驱动，请先结束或关闭该会话再删除');
    }
    // 保护②：transcript mtime 静默阈值——纯终端进程正驱动无法确证，mtime 新鲜即拒绝（启发式非完备）。
    const mtimeMs = await sessionFileMtime(sessionId, cwd);
    if (mtimeMs < 0) return ack({ ok: false, error: '会话不存在' });
    if (Date.now() - mtimeMs < sessionDeleteQuietMs) {
      return rejectDelete('quiet_period', '会话可能正被终端使用，请稍后再试');
    }
    // 原子性：先清当前指针 + 记入 pendingDeleteIds（列表临时排除），再删文件。
    // 崩溃窗口：pending 不落盘 → 孤儿文件重新可见，可重试；绝不会留下「指针指向已删文件」。
    if (sessions.getCurrent(cwd) === sessionId) sessions.setCurrent(cwd, null);
    pendingDeleteIds.add(sessionId);
    invalidateListCache(cwd);
    try {
      await sdkDeleteSession(sessionId, { dir: cwd }); // 官方 API：真删 {sessionId}.jsonl + 子 agent transcript 子目录
    } catch (err) {
      pendingDeleteIds.delete(sessionId);
      invalidateListCache(cwd);
      console.error(`[session-delete] 删除底层文件失败 sessionId=${sessionId}:`, err.message);
      audit.recordAudit({ actor: actorFromSocket(socket), action: 'session_delete_l2', target: sessionId, outcome: 'partial_failure', meta: { cwd } });
      return ack({ ok: false, error: `删除失败：${err.message}` });
    }
    pendingDeleteIds.delete(sessionId);
    // 必须【再失效一次】：上面那次 invalidate 发生在 sdkDeleteSession 之前，而真删要跑 git worktree list
    // 子进程、耗时可观。这段窗口里任何一次 session:list（另一台设备的 SWR revalidate、首页跨工作区聚合）
    // 都可能把「仍含该会话」的扫盘结果重新写进 4s TTL 的 _listCache；pending 清掉后就会变成幽灵行。
    invalidateListCache(cwd);
    audit.recordAudit({ actor: actorFromSocket(socket), action: 'session_delete_l2', target: sessionId, outcome: 'success', meta: { cwd } });
    // 会话在托管 worktree 里时一并报告那棵树的状态：transcript 删掉了，**worktree 还在磁盘上**，
    // 不说一声用户就不知道它在哪、里面还剩什么。
    // 这里只报告、**不删**——那棵树里可能是这份改动唯一的存在，而「查不到状态」与「真的干净」
    // 在返回值上必须区分得开（inspectWorktreeCleanliness 已对前者 fail-closed 报不干净）。
    // 自动回收是 Claude Desktop 那套 reaper 的事，它有 PR 合并状态可依据，本仓没有。
    let worktreeLeft = null;
    const managed = resolveManagedWorktree(cwd, workDirs);
    if (managed) {
      const c = await inspectWorktreeCleanliness(managed.path);
      worktreeLeft = {
        path: managed.path,
        clean: c.clean === true,
        dirtyCount: c.entries.length,
        unmergedCommits: c.unmergedCommits,
      };
    }
    ack({ ok: true, worktreeLeft });
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
    locateStoredAttachment,
    listGitChanges,
    readGitDiff,
    listGitBranches: listBranches,
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

  // web 端一键重启 server（改完配置/代码后免上电脑动手）。放行判据见 willBeRespawned；
  // 优雅退出复用 shutdown（flush sessions + dispose 实例 + close），靠拉起者（LaunchAgent
  // KeepAlive 或 npm run dev 的 watch）自动重启，前端 socket.io 自动重连 + epoch init 恢复。
  on(socket, 'dev:restart', (payload, ack) => {
    // 判据＝「退出后有人拉起」（willBeRespawned：托管或 npm run dev 的 watch）。此前是
    // DEV_MODE || isSupervised()，注释里就写着「太松」那侧没堵——DEV_MODE=1 + 前台 npm start
    // 会被停掉后永远起不来。2026-08-19 它在真机上炸了（假成功真死亡），故把 DEV_MODE 从
    // 本判据里拿掉：重启承诺的兑现前提是拉起者存在，与操作者是不是开发者无关。
    if (!willBeRespawned()) {
      audit.recordAudit({
        actor: actorFromSocket(socket), action: 'server_restart', target: 'server',
        outcome: 'denied', meta: { reason: 'not-supervised' },
      });
      if (typeof ack === 'function') {
        // 不点名具体的进程管理器：headless `npm start` 是本仓正当入口之一，说「你没用
        // LaunchAgent/systemd」会把用户支去装一套仓库并不提供的东西。要说的是后果。
        ack({ ok: false, error: '当前进程没有进程管理器托管（终端里直接 npm start 就是这样），停了不会自动拉起 —— 拒绝重启' });
      }
      return;
    }
    console.log('[dev] 收到 web 端重启请求，优雅退出（KeepAlive 将自动拉起）');
    // 与 env_changed 同理由进审计环：「服务什么时候被谁从手机重启过」是排障时的第一个问题，
    // 而 console 那条随进程日志轮转走、审计环是持久的。放在 shutdown 之前 ——
    // recordAudit 内部是防抖写，shutdown 里的 flush 会把它落盘。
    audit.recordAudit({
      actor: actorFromSocket(socket), action: 'server_restart', target: 'server',
      outcome: 'allowed', meta: { via: isSupervised() ? 'supervised' : 'dev-watch' },
    });
    // 声明「接下来那次换 pid 是用户按的」。采样器只看得见 pid 变了、看不出为什么变，而配置
    // 面板每次保存成功都给一个「立即重启」按钮 —— 不记这一条的话，手机上改三次配置就会被
    // 判成「1 小时内重启 3 次·疑似崩溃重启循环」。必须在退出**之前**落盘。
    //
    // 只在 launchd 托管时记。npm run dev 的 watch 拉起不经 launchd、采样器看不到那次 pid
    // 变化 —— 记一条 intent 只会留下一份孤儿声明，它会在 120s 窗口内认领掉恰好撞上来的
    // 下一条 restarted（比如你手动重开 server 那次），把一次真实重启从频率统计里抹掉。
    if (isSupervised()) serviceSampler.recordRestartIntent();
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

  // 子代理执行流水：历史回放时按需拉【一个】 agent 的内容。
  //
  // 【为什么必须有这条】主 transcript 里没有子代理的执行内容（2026-09-10 全库实证：
  // isSidechain 只出现在 subagents/agent-*.jsonl 内），所以刷新后前端预建的子代理卡是空壳。
  //
  // 【为什么按需而不是随 session:history 一起推】那批文件实测中位 360KB、最大 1.2MB
  // （本机 179 个、总 69MB）。整批推等于把一轮历史的体量放大一个数量级，而绝大多数卡
  // 用户根本不会展开。
  //
  // 【安全】同 tool:preview / tool:full 的范式：客户端只传 toolUseId，从不传路径——路径由
  // 服务端从 sessionId + cwd 自己算，且 readSubagentFlow 入口先过 isSafeSessionId（SS-003）。
  // 会话归属校验与 session:history 同款（按文件存在性裁决，接纳终端创建的会话）。
  on(socket, 'subagent:flow', async ({ cwd: reqCwd, sessionId, toolUseId } = {}, ack) => {
    if (typeof ack !== 'function') return;
    const cwd = routeCwd(reqCwd);
    if (typeof sessionId !== 'string' || !(await sessionFileExists(cwd, sessionId))) {
      return ack({ ok: false, error: '会话不存在' });
    }
    try {
      ack(await readSubagentFlow(sessionId, cwd, toolUseId));
    } catch (err) {
      ack({ ok: false, error: err.message });
    }
  });

  // ④ UI 安全体检：运行时检查 + 全局危险白名单审查（项数见 runDoctor）。走 on() 鉴权闸（deviceApproved fail-closed）。
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

  // statusline 桥的装/卸。与 hooks:setup 同构：走 execFile 调 scripts 下的安装器，而不是 import 它
  // （运行时禁止 import scripts/）。**读态不走这里**——那条在 ops/cli-statusline-bridge.js 里同步读，
  // service:status 每 5s 要用，spawn 一个 node 进程太贵。
  on(socket, 'statusline:setup', (payload, ack) => {
    if (typeof ack !== 'function') return;
    const action = payload?.action;
    if (!['install', 'uninstall'].includes(action)) return ack({ ok: false, error: '未知操作' });
    execFile(process.execPath, [join(HERE, 'scripts', 'statusline-bridge-setup.js'), action], {
      cwd: HERE, timeout: 20000, maxBuffer: 256 * 1024,
    }, (err, stdout, stderr) => {
      const state = refreshStatuslineInstallState();
      // 同 hooks:setup：这是 server 会改用户全局 ~/.claude/settings.json 的动作，服务日志要留痕
      console.log(`[statusline] 经 UI ${action} ${err ? '失败' : '完成'}，当前安装态=${state}`
        + (err ? `：${String(err.message || err).split('\n')[0]}` : ''));
      broadcastInstances();
      const report = String(stdout || '').split('\n').filter(l => l && !l.trim().startsWith('{')).join('\n').trim();
      ack({
        ok: !err,
        state,
        report: report || String(stderr || '').trim().split('\n').slice(-3).join('\n') || (err ? '执行失败' : ''),
      });
    });
  });

  // 测试推送：自己验"推送到底通不通"，不必等真事件。今晚的教训——曾一直以为推送在工作，
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
    // claudeVersion 传的是**启动时的快照**：runDoctor 自己会实时探一次 claude，两者不一致就报
    // 「CLI 升级过、重启才生效」。此前它是 CLAUDE_BIN 那一格的唯一判据，于是 claude 被升级/移走后
    // web 体检照样回放旧版本号并判 ok（2026-08-27 实测：装的 2.1.247，面板显示 2.1.246 绿灯）。
    ack(runDoctor({
      authToken: AUTH_TOKEN,
      claudeVersion: versions.cli,
      workDirs,
      home: homedir(),
      cfEnabled: authStrategy.isEnabled(),
      cfAudSet: !!process.env.CF_ACCESS_AUD,
      webStatuslineOff: process.env.WEB_STATUSLINE === 'off',
      pushEnabled,
      trustedDevices: getTrustedCount(),
      pendingDevices: getPendingDevices().length,
      // BE-013/L1：.env 在项目根、data/*.json 在实际数据目录（CCM_DATA_DIR 可把它移出仓库）——两者必须分开传。
      // 早前把 CCM_DATA_DIR 当 rootDir 传，拼出 <CCM_DATA_DIR>/data/... 永不存在 → 扫 0 个文件 → 恒报绿。
      configPermsProblems: countConfigPermProblems(HERE, { dataDir: process.env.CCM_DATA_DIR || null }),
      // D18：投影**之前**的 shell 快照。现读 process.env 是没用的——config.js 已经把文件值
      // 填了进去，来源分不开（那会做出一个永远报「全被覆盖」的假功能）。
      shellEnv: getShellEnvSnapshot(),
      // D20（R45，2026-08-30）：直写开关 + 公网声明信号。cfEnabled 上面已传（isAccessEnabled 权威判定），
      // 这里补 FILE_EDIT 与 PUBLIC_URL 两个输入；URL 值不进报告（runDoctor 只出布尔）。
      fileEditOff: process.env.FILE_EDIT === 'off',
      publicUrl: process.env.PUBLIC_URL || '',
      // D21：方案声明 + 「通知已配」判定（Web Push 或 ntfy 任一即算——两条通道都吃 PUBLIC_URL 深链）。
      accessProfile: ACCESS_PROFILE,
      notifyConfigured: pushEnabled || !!(process.env.NTFY_URL && process.env.NTFY_TOPIC),
      // 实际生效的监听计划（server 才拿得到）：让体检里「绑哪个地址」的措辞与真相一致。
      bindPlan,
      // 采信 XFF 的开关：传归一后的值——server 真正用的就是它，体检说的必须与限速真在做的一致。
      trustedProxy: TRUSTED_PROXY,
      // TAILSCALE 项的 serve 提示要带实际端口。
      port,
    }));
  });

  // ── 配置面板：读写 .env ────────────────────────────────────────────────
  //
  // 之所以开这个口子：ccm 的主界面在手机上，而改 .env 只能上电脑 —— 40 个配置项里绝大多数
  // 手机用户永远碰不到。与 hooks:setup 同一心智（那个开的是「写用户全局 settings.json」的口子）。
  //
  // 三条纪律：
  //   1. **只写文件，绝不动 process.env** —— 半生效的配置比不生效更糟；生效靠重启
  //   2. key 白名单（src/ops/env-schema.js），schema 之外一律拒绝：这不是通用 .env 编辑器
  //   3. 日志与 ack **只记 key 名不记值** —— changes 里可能有 VAPID 私钥、ntfy token
  // 已迁移到 ccm.config.json 时读它并投影成字符串态 —— buildEnvView / validateEnvChanges
  // 都是按 .env 时代的字符串写的，在边界上投影一次比为 JSON 再写一套校验安全（两套判据分叉
  // 正是本仓出过事的形态）。前端因此完全无感。
  // 原始结构化值。只供 list 档回显——其余项一律走投影后的字符串态，免得两套读法分叉。
  // .env 时代没有数组形态，回 null（编辑器据此显示空列表）。
  const readStructuredValues = () => {
    if (!usingConfigJson()) return null;
    try {
      return JSON.parse(readFileSync(CONFIG_FILE_PATH, 'utf8'));
    } catch {
      return null;
    }
  };
  const readEnvValues = () => {
    if (usingConfigJson()) {
      try {
        return structuredToStringValues(JSON.parse(readFileSync(CONFIG_FILE_PATH, 'utf8')));
      } catch {
        return {};
      }
    }
    try {
      return dotenvParse(readFileSync(ENV_FILE_PATH));
    } catch {
      return {};
    }
  };

  on(socket, 'env:get', (_payload, ack) => {
    if (typeof ack !== 'function') return;
    ack({
      ok: true,
      // 第二个参数不是可选的装饰：少了它，被 shell env 压过的行会跟正常行长得一模一样，
      // 用户改完保存成功、运行时仍用旧值（VC-D4-02）。快照取自投影之前，见 config.js。
      // structured 是给 list 编辑器回显用的旁路（投影规则未动，见 buildEnvView 里的说明）
      ...buildEnvView(readEnvValues(), { shellEnv: getShellEnvSnapshot(), structured: readStructuredValues() }),
      envFileExists: usingConfigJson() || existsSync(ENV_FILE_PATH),
      configFile: usingConfigJson() ? CONFIG_FILE_NAME : '.env',
    });
  });

  on(socket, 'env:set', async (payload, ack) => {
    if (typeof ack !== 'function') return;
    const changes = payload?.changes;
    if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
      return ack({ ok: false, results: [{ key: '', level: 'error', message: '缺少 changes' }] });
    }
    // 读不动当前配置就拒写（CONFIG-01）。下面写盘是「读出来 → 改几项 → 整份写回」，从 {} 长出来会把
    // 没改的项（AUTH_TOKEN / WORKDIRS …）一起抹掉，下次启动直接起不来。判据与启动侧同一份：
    // loadConfigSources 对坏 JSON / 顶层不是对象 fail-loud。CLI 的 config set 同场景同样拒写。
    // 放在校验之前：拿读失败回落出来的空配置去校验，报出来的错也是错的。
    const readConfigForWrite = () => loadConfigSources({ configPath: CONFIG_FILE_PATH, envPath: ENV_FILE_PATH }).fileValues;
    const refuseUnreadable = err => ack({ ok: false, results: [{ key: '', level: 'error',
      message: `${String(err?.message || err)}。已拒绝保存：从空配置重建会把其余配置项一起抹掉` }] });
    if (usingConfigJson()) {
      try { readConfigForWrite(); } catch (err) { return refuseUnreadable(err); }
    }
    const current = readEnvValues();

    // 端口占用只在**值真的变了**时才探：当前 server 正绑在旧 PORT 上，无条件探测会恒报占用
    // （那正是 doctor D4 修掉的那个 bug）。探测结果预先算好，喂给同步的 validateEnvChanges。
    let portBusy = false;
    const nextPort = changes.PORT;
    if (typeof nextPort === 'string' && nextPort !== String(current.PORT ?? '')) {
      portBusy = await probeLocalPort(Number(nextPort));
    }

    const verdict = validateEnvChanges(changes, {
      current,
      fileExists: existsSync,
      isExecutable: p => canAccessPath(p, fsConstants.X_OK),
      probePort: () => portBusy,
      usingConfigJson: usingConfigJson(),
    });
    if (!verdict.ok) return ack({ ok: false, results: verdict.results });

    // warn 不阻断，但要用户明确点头（UI 弹确认后带 acceptWarnings 重发）
    if (verdict.results.some(r => r.level === 'warn') && !payload?.acceptWarnings) {
      return ack({ ok: false, needsConfirm: true, results: verdict.results });
    }
    if (payload?.dryRun) return ack({ ok: true, dryRun: true, results: verdict.results, written: [] });

    // 写入目标与上面 readEnvValues 的读取目标严格同源，绝不能各判各的。
    const target = usingConfigJson() ? CONFIG_FILE_NAME : '.env';
    try {
      // 0600 + 唯一 tmp + fsync + rename：与 sessions / devices 同一个原子写
      if (usingConfigJson()) {
        // 写前重读：上面探端口有 await，这期间文件可能被改过。读不动同样拒写，理由见上。
        let currentConfig;
        try { currentConfig = readConfigForWrite(); } catch (err) { return refuseUnreadable(err); }
        writeOwnerOnlyFile(CONFIG_FILE_PATH, `${JSON.stringify(applyConfigChanges(currentConfig, changes), null, 2)}\n`);
      } else {
        let text = '';
        try {
          text = readFileSync(ENV_FILE_PATH, 'utf8');
        } catch { /* 没有 .env 就从空文件长出来 */ }
        writeOwnerOnlyFile(ENV_FILE_PATH, applyEnvChanges(text, changes));
      }
    } catch (err) {
      return ack({ ok: false, results: [{ key: '', level: 'error', message: `写入 ${target} 失败：${String(err?.message || err)}` }] });
    }

    const keys = Object.keys(changes);
    // 服务端留痕：事后要能查到「这台机器的配置是谁什么时候改的」。只记 key 名 —— 值里有密钥。
    console.log(`[env] 经 UI 修改 ${keys.length} 项：${keys.join(', ')}（需重启生效）`);
    // 进审计环而不只是 console：改写 CF_ACCESS_*（公网 2FA）/ WORKDIRS（claude 的文件作用域）
    // / CLAUDE_BIN（被执行的二进制）的安全含义不低于 device_approved，而后者一直在记。
    // 只记 key 名与「哪些是被清空的」，绝不记值 —— 那里面有 token 与密钥。
    audit.recordAudit({
      actor: actorFromSocket(socket),
      action: 'env_changed',
      target: keys.join(','),
      outcome: 'allowed',
      meta: {
        keys,
        cleared: keys.filter(k => changes[k] === null || changes[k] === ''),
        acceptedWarnings: verdict.results.filter(r => r.level === 'warn').map(r => r.key),
      },
    });
    // 【不能无条件 true】schema 里 WORKDIRS 标着 reload:'hot'（全表唯一），那条注释写得很清楚：
    // 「这个标记不是文档，是**行为**」。只改了热加载项还提示重启，会诱导用户去中断所有在跑的
    // 会话与后台任务，换来一次完全不必要的停机。判据复用 config-file.js 的 reloadKindOf，
    // 不在这里自己写一份（它缺省 restart，方向已经是保守的那边）。
    const restartRequired = keys.some(k => reloadKindOf(k) === 'restart');
    ack({ ok: true, results: verdict.results, written: keys, restartRequired });
  });

  // 服务状态面板：一次 ack 拼齐 基础(startedAt/versions) + 判定化告警(computeServiceHealth)。
  // 不带裸计数器——那是 /metrics 巡检端点的机器原料，对人无参照系不可解读（判定化改造，见 plans）。
  // 走 on() 鉴权闸（deviceApproved fail-closed，运行状态属敏感数据）；重启提示不进 payload——
  // 前端已有 _serviceRestartNoticeActive（instances 广播维护），面板直读，避免二次写 localStorage 基线。
  on(socket, 'service:status', (_payload, ack) => {
    if (typeof ack !== 'function') return;
    // 两个桥的安装态是**启动时读一次**的缓存（instances 广播很频繁，不能每次广播都去读盘）。
    // 但用户完全可能在 server 运行期间用文档里的 `npm run statusline:install|uninstall` /
    // `hooks:install|uninstall` 改掉它——此后这里会一直回答旧状态：给一个已经装好的桥继续显示
    // 「安装」，或者卸载完了还报着已安装，而且永远不会自愈。
    // service:status 是低频的面板请求（不是广播），在这一处读盘既廉价又准确。
    refreshStatuslineInstallState();
    refreshHooksInstallState();
    const health = computeServiceHealth();
    ack({
      ok: true,
      startedAt: SERVICE_STARTED_AT,
      versions,
      deliveryFailure: health.deliveryFailure,
      rateLimitLockout: health.rateLimitLockout,
      clientError: health.clientError,
      // 面板自己的「异常告警」小节走这条 ack（不是 instances 广播），得同样带上——否则顶栏/抽屉
      // 与「服务状态」面板对同一次限速锁定会显示不一致的措辞（见 app.js renderServiceStatus）。
      proxyFronted: health.proxyFronted,
      hooksBridge: health.hooksBridge, // 面板「终端会话推送」段：显示安装态 + 一键安装/卸载
      statuslineBridge: health.statuslineBridge, // 面板「终端状态栏」段：同上，此前整段没有下发面
      // 面板「重启记录」段：谁在什么时候重启过（判定化，不给裸计数器）。
      // 只在这条路径上算——它要读盘，而 instances 广播每轮都发、那边没有任何消费者。
      restarts: serviceSampler.summarize(),
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

  // 安全日志：审计记录的**唯一**读取面（2026-09-02）。此前 audit-records.json 只写不读——
  // 限速锁定的来源 IP、设备批准/拒绝、越界访问全都记着，但手机上一条也看不到，于是「⛔ 有人在
  // 暴力尝试你的入口」这类告警无从下钻（实测遇到的两次锁定来源都是 ip:127.0.0.1）。
  //
  // 只读、无副作用、走 on() 的 deviceApproved 闸（与其余 socket 事件同一道门）。不开 HTTP 端点：
  // 守「不开无鉴权数据端点」，且审计里有设备指纹与来源 IP，比会话列表更该留在鉴权面内。
  // limit 上限 200：手机上没人翻更多，而 records 环形上限是 5000，全量回传是几百 KB 的白发。
  // 局域网基址。与启动横幅同源（reachableIPv4s），且同样受 bindPlan.publiclyReachable 约束——
  // 显式绑了 loopback 时那些地址上根本没人在听，做出来的码扫开必然失败，不如直说取不到。
  const lanBaseUrlForQr = () => {
    if (!bindPlan.publiclyReachable) return null;
    const ip = reachableIPv4s()[0];
    return ip ? `http://${ip}:${port}` : null;
  };

  // 接入二维码：把连接地址（含 token）编成 QR 矩阵，让第二台设备扫一下就进来。
  // 此前这个能力只有终端有（node scripts/qr.js），而「人不在电脑前」正是这个产品的前提。
  //
  // 【token 为什么可以进码】它走 URL fragment（/#token=），fragment 不进任何中间层的访问日志——
  // 与 server 启动横幅、scripts/qr.js 同一条既有判据。
  // 【受 Access 保护的域名不带 token】那条路只认 Access 的 JWT、不回退 AUTH_TOKEN，
  // 带上去纯属泄漏。判据复用 resolvePublicTarget 的 includeToken，**不在这里另算一套**。
  // 【为什么必须显式请求】二维码没有「安全的默认档」：不含 token 的码没用，含 token 的码就是
  //   一把钥匙。投屏时人会本能遮挡一串明文 token，却不会去遮一个「看起来无害」的方块图案。
  //   同 scripts/qr.js 必须手敲的理由，前端那侧还要再加一道两步展开 + 定时自动隐藏。
  on(socket, 'connect:qr', (payload, ack) => {
    if (typeof ack !== 'function') return;
    // target 是客户端可控输入，显式白名单：两档的暴露面不同（局域网 vs 公网），
    // 静默把未知值当成某一档，等于让调用方以为自己选中了另一档。
    const target = payload?.target;
    if (target !== 'lan' && target !== 'public') {
      return ack({ ok: false, error: '未知的目标类型（只接受 lan / public）' });
    }
    const wantPublic = target === 'public';
    try {
      const token = process.env.AUTH_TOKEN || '';
      let base = null;
      let includeToken = true;
      let note = '';
      if (wantPublic) {
        const target = resolvePublicTarget({
          cfHostname: process.env.CF_ACCESS_HOSTNAME,
          accessEnabled: accessConfigured(),
          tailscaleDns: null, // Tailscale DNS 要 spawn 探测，不在这条同步路径上做；CLI 侧仍支持
          port,
        });
        if (!target) return ack({ ok: false, error: '没有可用的公网地址：先配 Cloudflare Access 域名，或在电脑上用 node scripts/qr.js --url <地址>' });
        base = target.url;
        includeToken = target.includeToken;
        note = target.note || '';
      } else {
        // 局域网：用本机在白名单网卡上的地址。取不到就让调用方改用公网档，不编一个。
        const lan = lanBaseUrlForQr();
        if (!lan) return ack({ ok: false, error: '取不到局域网地址：改用公网档，或在电脑上跑 node scripts/qr.js' });
        base = lan;
      }
      if (includeToken && !token) return ack({ ok: false, error: '未设置 AUTH_TOKEN' });
      const url = includeToken ? `${base}/#token=${encodeURIComponent(token)}` : base;
      const { matrix, size } = encodeQr(url);
      // url 一并回传：前端要显示「扫不出来时改用文字」的回退，且用户可能想复制
      ack({ ok: true, url, matrix, size, includeToken, note });
    } catch (err) {
      console.warn('[qr] 生成失败:', err?.message || err);
      ack({ ok: false, error: '二维码生成失败' });
    }
  });

  // 审批规则的只读面。agent.js:269 明写放行白名单完全交给 settingSources 的 permissions.allow——
  // 这份名单决定手机上哪些工具直接放行，而 web 端此前既读不到也写不了，「为什么这个老弹」无从回答。
  //
  // **刻意不塞进 instances 广播**：那条路每个轮次边界都触发，而这份名单只在设置面板打开时看一眼，
  // 放进去等于给每台连着的设备每轮白发一份（同 restarts 不进广播的理由）。
  // 数据来自 ensureCliDefaults 已经解析好的 effective settings，不额外 spawn CLI。
  on(socket, 'permissions:rules', async (payload, ack) => {
    if (typeof ack !== 'function') return;
    const cwd = ensureWhitelisted(routeCwd(payload?.cwd), workDirs);
    try {
      const resolved = await sdkResolveSettings({ cwd, settingSources: ['user', 'project', 'local'] });
      ack({ ok: true, cwd, rules: permissionRulesFromEffectiveSettings(resolved?.effective) });
    } catch (err) {
      // 读不出来就说读不出来：rules:null 让前端整段缺席，而不是显示一份空名单
      console.warn(`[cli-settings] 审批规则读取失败 (${cwd}):`, err?.message || err);
      ack({ ok: false, cwd, rules: null, error: '读取失败' });
    }
  });

  on(socket, 'audit:get', (payload, ack) => {
    if (typeof ack !== 'function') return;
    const raw = Number(payload?.limit);
    const limit = Number.isFinite(raw) && raw > 0 ? Math.min(raw, 200) : 50;
    ack({ ok: true, records: audit.listRecent({ limit }), capacity: audit.capacity() });
  });

  // server 进程自己的 stdout/stderr。**与 logs:get 是两条不同的日志**：
  // 那条合并的是前端 clientLogger + 会话交互日志（都在内存里），server 进程的输出一个字都不进去
  // （2026-09-02 实证）。于是「服务为什么起不来」「端口被占了吗」的答案在手机上根本读不到。
  //
  // 脱敏档位是**只截断限流、不改内容**（机主 2026-09-10 定）：这是自己的机器、自己的日志，
  // 且已过设备审批闸；改内容会让排障失去价值——看不到真实路径和错误原文就没法排。
  // 面板上直说「含路径与错误原文」。
  //
  // 三道限制：尾部 N 行（默认 200、上限 500）、字节上限（读文件尾部 256KB，不整份加载）、
  // 路径**不接受客户端传入**（只读配置里那个），从设计上排除路径穿越。
  on(socket, 'logs:server', (payload, ack) => {
    if (typeof ack !== 'function') return;
    const raw = Number(payload?.limit);
    const limit = Number.isFinite(raw) && raw > 0 ? Math.min(Math.trunc(raw), 500) : 200;
    // 与 log-terminal.js / doctor.js 同一份默认路径约定（macOS 部署约定），不另算一套
    const logFile = process.env.LOG_FILE || join(homedir(), 'Library', 'Logs', 'ccm-server.log');
    try {
      const st = statSync(logFile);
      if (!st.isFile()) return ack({ ok: false, path: logFile, lines: [], error: '日志路径不是普通文件' });
      const MAX_BYTES = 256 * 1024;
      const start = Math.max(0, st.size - MAX_BYTES);
      const fd = openSync(logFile, 'r');
      let text;
      try {
        const len = st.size - start;
        const buf = Buffer.allocUnsafe(len);
        // 【必须按 bytesRead 截断】日志在 statSync 与 readSync 之间被轮转/截断时读到的会少于 len，
        // 而 allocUnsafe 不清零——尾部就是复用的堆内存，会被当成日志正文发给客户端（可能夹带
        // 本进程其他请求的残留字符串）。这条路径本身是鉴权后的运维面板，但没有理由把未初始化
        // 内存送出去。
        const bytesRead = readSync(fd, buf, 0, len, start);
        text = buf.toString('utf8', 0, bytesRead);
      } finally {
        closeSync(fd);
      }
      // 【必须整段脱敏再切行，不能逐行脱敏】sanitizer 的 PEM 模式是跨行的
      // （`-----BEGIN … PRIVATE KEY-----[\s\S]+?-----END …`）。先 split 再逐行 sanitize 会让它
      // 永远匹配不上——日志里的私钥被原样回给客户端，而每一行 base64 单看也不命中任何别的模式。
      // 实测：整段一次 → '***'；逐行 → 私钥完整漏出。
      // 整段更快也顺带成立（256KB 实测 6.3ms vs 逐行 10.6ms），不存在拿性能换安全的取舍。
      const all = sanitize(text).split('\n');
      // 从中间截断时丢掉第一行残片——半行日志读起来像另一条记录
      if (start > 0 && all.length) all.shift();
      // 脱敏的理由（M1，2026-09-17 安全审查）。此前这里「只截断限流、不改内容」，于是日志文件里
      // 的任何凭据都会原样回给已鉴权会话。而经 Cloudflare Access 进来的会话默认**不需要**
      // AUTH_TOKEN（设备审批也 bypass），读一次这里就能把 token 拿走，之后可走 LAN、可在
      // Access 吊销后继续用。横幅那头已改成永不打完整 token，但日志文件里的历史行还在，
      // LOG_FILE 也可能收着别的进程写进来的凭据——两道各自独立，不能只做一头。
      // sanitize 是选择性的（判据见 shared/sanitizer.js 的 PATTERNS，配套单测里有边界用例），
      // 不会把地址、时间戳、报错正文一起抹掉，日志的排查价值保留。
      const lines = all.filter(l => l !== '').slice(-limit);
      ack({ ok: true, path: logFile, lines, truncated: start > 0, size: st.size });
    } catch (err) {
      // ENOENT 是最常见的一支：没配 LOG_FILE 且不是 macOS 默认部署。说清楚而不是给个空列表——
      // 空列表看起来像「服务很干净」，而实际是「我们压根没在看那个文件」。
      const code = err?.code === 'ENOENT' ? '日志文件不存在（未配置 LOG_FILE，或进程输出没有重定向到文件）' : '读取失败';
      ack({ ok: false, path: logFile, lines: [], error: code });
    }
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
      // 模型清单一律靠 scout 重新 spawn 去取，**绝不问活跃 agent**——哪怕这个 cwd 正开着会话。
      // 两个原因叠加，都不属于「缓存过期」那一类，加刷新次数、延长等待都解决不了：
      //   ① 子进程 env 是 spawn 那一刻注入的一次性快照（agent.js 的 `env: {...sdkChildEnv, ...resolvedEnv}`），
      //      POSIX 下父进程改不了已运行子进程的 env；
      //   ② SDK 的 supportedModels() 读的是 **spawn 时 initialize 响应里缓存的 models 字段**
      //      （sdk.mjs: `supportedModels(){return(await this.initialization).models}`），压根不发第二次 IPC。
      // 所以 a.fetchModels() 拿回来的必然是【旧配置】下的清单。而「该工作区有活跃会话」恰恰是用户最常
      // 点这个按钮的时候——2026-09-15 真机：用户把 settings.local.json 里的第三方网关整块删掉、点刷新，
      // 模型列表依旧显示网关的模型名，怎么点都不变。
      // 旧代码那道 5s 兜底（`if (!modelsCache.get(cwd))` 才补 scout）同样堵不住：fetchModels 读的是一个
      // 已经 resolve 的 Promise，必然「成功」，于是缓存非空、只是陈旧，判据永远不成立。
      // scout 则是在上面 ensureCliDefaults(force) 之后、用**重读后的** cliDefaultsByCwd.env 新 spawn 的
      // （见 openScoutInstance 的 resolvedEnv），是唯一能反映新配置的通道。
      // 【刻意不动活跃会话】它仍在用自己 spawn 时的那套网关。这与终端里改了 settings 不影响已在跑的
      // claude 进程是同一回事（终端等价性），换配置得开新会话。这里只负责让**清单**说真话，
      // 不去打断用户正跑着的回合。
      disposeScoutFor(cwd); // 旧 scout 的 CLI 也是用旧 settings spawn 的，一并作废
      openScoutInstance(cwd);
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
    // unreadOnEntry：进入/回到这个实例时应展示的未读胶囊数字 = 冻结快照 + 尚未 capture 的 live。
    // PWA 切后台 socket 未断时 capture 不会跑，只回快照会把离开期间的增量丢掉。
    const done = (replayed, gap, found = true, pending = null, diskLen = null, unreadOnEntry = 0) => {
      if (typeof ack === 'function') ack({ replayed, gap: Boolean(gap), found: Boolean(found), pending, diskLen, unreadOnEntry });
    };
    const a = routeInstance(instanceId); // 台阶3：续传指定 tab 实例的缓冲（缺省 viewingInstanceId）
    if (!a || a.sessionId !== sessionId) { metrics.inc('catch_up_reloads'); return done(0, false, false); } // 无匹配实例：客户端清屏重载历史（重载口径：仅计后端能确证的触发；前端因 diskLen 盲区的重载后端不可观测、不计）；亦会在下个 live 事件凭 epoch 自愈
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
    // 必须把 live 算进去：PWA 切后台 socket 未断时 capture 不会跑，增量只在 unreadCounts 里。
    const unreadOnEntry = unreadOnEntryForSync({
      instanceId: a.instanceId,
      viewingInstanceId,
      snapshot: unreadSnapshotOnEntry.get(a.instanceId) || 0,
      live: unreadCounts.get(a.instanceId) || 0,
    });
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
    if (!hidden) {
      // 「回来了」——这半边此前只是把标志翻回去就 return。会话摘要挂在这里，因为**只有这一处**
      // 知道离开了多久：CLI 那边靠终端焦点，本产品靠客户端主动上报的 presence，手机上「放下又拿起」
      // 只有后者看得见（终端从头到尾没失焦过）。
      const hiddenAt = socket.data.hiddenAt || 0;
      socket.data.hidden = false;
      socket.data.hiddenAt = 0;
      if (hiddenAt) maybeRecapOnReturn(Date.now() - hiddenAt);
      return;
    }
    const sockets = approvedSocketObjects(); // 真实 Socket 对象，mutate 前后复用同一批引用即可反映跳变前后状态
    const hadForeground = hasForegroundApprovedClient(sockets);
    socket.data.hidden = true;
    socket.data.hiddenAt = Date.now(); // 供回来时算离开时长；只在真正翻成 hidden 的那一拍写
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
      const agentCwd = agent.cwd;
      const agentSid = agent.sessionId;
      void sessionTitleForNotify(agentCwd, agentSid).then(sessionTitle => {
        emitNotify(notificationForBackgroundRunning({
          instanceId: id, sessionId: agentSid, cwd: agentCwd, sessionTitle,
        }), 'background_running');
      }).catch(() => {});
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

// 回到前台时的会话摘要。只针对【当前查看的那个实例】——摘要是给眼前这块屏幕的，给别的会话
// 生成既没人看又要花钱。准入判据（离开时长 / 轮数 / 最小间隔 / 是否在跑）全在 agent.maybeRecap 里，
// 这里只负责把"离开了多久"和开关递进去。fire-and-forget：presence 是高频上报，绝不能被一次
// 网络往返卡住；失败静默——摘要是锦上添花，没有它会话照常。
// 开关字面量必须与 env-schema 的 TOGGLE_ZERO 一致（off='0'）：写成别的值会让用户点了「关」却照样计费。
function maybeRecapOnReturn(awayMs) {
  if (process.env.CCM_SESSION_RECAP === '0') return;
  const agent = agents.get(viewingInstanceId);
  if (!agent || agent.disposed) return;
  void agent.maybeRecap({ awayMs, now: Date.now(), enabled: true })
    .catch(() => {}); // 已在 agent 内吞过一层，这里兜住判据本身抛出的意外
}

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

// 只读追平：单发当前查看 tab 的镜像只读快照给指定 socket。原来只内联在 registerSocketConnection
// 的已批准分支里（物理重连时才会跑到），unlockSocket()（批准待审批设备解锁已连接 socket，不经过
// 这条连接回调）漏了这一步——设备刚被批准那一刻，若当前查看的会话正被 CLI 驾驶，前端会一直不知道
// 自己该进只读态，直到用户手动刷新页面。抽成独立函数供两处共用，对齐 permModeTo/effortTo/instancesTo
// 的既有写法。
function mirrorStateTo(socket) {
  const currentMirrorAgent = agents.get(viewingInstanceId);
  const mirrorReadonly = Boolean(currentMirrorAgent && mirrorOwnedBy(currentMirrorAgent.sessionId, viewingInstanceId));
  const mirrorSnapshot = mirrorEngine.snapshot();
  socket.emit('agent:event', {
    seq: 0, epoch: 'server', sessionId: currentMirrorAgent?.sessionId ?? null,
    instanceId: viewingInstanceId, cwd: viewingCwdOf(), ts: Date.now(), type: 'mirror_state',
    payload: {
      readonly: mirrorReadonly,
      stale: mirrorReadonly && mirrorSnapshot.stale,
      ...(mirrorReadonly ? { observedCli: mirrorSnapshot.observedCli, autonomous: mirrorSnapshot.autonomous, waiting: mirrorSnapshot.waiting } : {}),
    }
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
// 判据走 src/shared/bind-host.js，不写内联三元：两个 doctor 要回答「这台机器对外可达吗」，
// 而它们够不到这一行，此前只能各自猜——纯空白 token 上 CLI doctor 就猜反了（说「仅监听
// 127.0.0.1」，实际绑的是 0.0.0.0）。同一个函数才没有分叉余地。
const bindPlan = resolveBindPlan({ authToken: AUTH_TOKEN, bindMode: BIND_MODE, bindHost: BIND_HOST });
// 显式要求绑到对外可达的地址却没有 AUTH_TOKEN（或 custom 没给地址、模式拼错）时拒绝启动。
// 不静默降级：那会让用户以为公网配好了，实际手机全部连不上且没有任何错误信息
// （config-file.js 已把这种「悄悄降级到 127.0.0.1」判为必须消除的失败形态）。
if (bindPlan.refuse) {
  console.error(`\n❌ 启动失败：${bindPlan.refuse.detail}\n`);
  process.exit(1);
}
const host = bindPlan.host;
// 启动期致命错误必须 fail-fast 并给可读提示（A9 精神），不能落进 uncaughtException 兜底静默退出
httpServer.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n❌ 启动失败：端口 ${port} 已被占用。`);
    console.error(`   查看占用者：lsof -nP -iTCP:${port} -sTCP:LISTEN`);
    console.error(`   或改用其他端口：node scripts/config.js set PORT=<新端口>\n`);
  } else {
    console.error(`\n❌ 启动失败：${err.message}\n`);
  }
  process.exit(1);
});

// 重启 fail-closed 处置遗留 pending 审批（必须在 listen 之前：这之后 io 才可能接受连接、驱动新实例）
// + 留存治理（启动即清一次 + 每 24h）。实现下沉 src/agent/approval-lifecycle.js。
expireOrphanedPending();
startApprovalRetentionSweep();

httpServer.listen(port, host, () => {
  // 日志窗口（LOG_TERMINAL=on 才开）：停止/重启时由 shutdown() 关掉。
  // **必须放在绑定成功之后**：早于此处会给一个根本没起来的 server（如端口被占）开出窗口，
  // 而那条路径退出太快、状态文件还没写完就没了，留下关不掉的孤儿窗口（实测踩到）。
  startLogTerminal({ home: homedir(), dataDir: DATA_DIR }).catch(() => {});
  console.log('========================================');
  console.log('  Claude Chat Mobile v2');
  console.log(`  工作目录: ${primaryWorkDir()}${workDirs.length > 1 ? `  (可切换 ${workDirs.length} 个: ${workDirs.join(', ')})` : ''}`);
  console.log(`  claude: ${claudeBin} (${versions.cli})`);
  console.log(`  工具放行: 由 .claude/settings.json 的 permissions 决定（投屏层不注入白名单）`);
  // 无 AUTH_TOKEN 的分支已删除：那个状态到不了这里——resolveBindPlan 会在 listen 之前
  // refuse('token_required') 并退出（§1.9 鉴权是启动前提）。
  if (!bindPlan.publiclyReachable) {
    // 有 token 但显式绑了 loopback（BIND_MODE=loopback / custom+本机地址）。
    // 此时**绝不能**再列局域网地址——那些地址上根本没有人在听，照着打开只会失败。
    console.log('  已启用鉴权，但按配置只监听本机：');
    console.log(`  [Token: ${maskToken(AUTH_TOKEN)}]`);
    console.log(`  本机:   http://localhost:${port}/#token=<YOUR_TOKEN>`);
    console.log(`  远程:   端口只在 ${host} 上，手机无法直连——请自行转发（SSH -L、Tailscale Serve、反代等）`);
    console.log('          要让手机同 WiFi 直连，把 BIND_MODE 改成 lan（或留空）后重启');
    console.log(`  💡 提示: Token 已掩码显示，完整 token 在 ${usingConfigJson() ? CONFIG_FILE_NAME : '.env'} 中查看`);
  } else {
    // 安全打印：**任何情况下都不打完整 token**（M1，2026-09-17 安全审查）。
    // 此前首次启动（无 sessions.json）会打印完整 `/#token=…` 便于扫码。它进 LOG_FILE、进
    // LOG_TERMINAL 窗口、进投屏；而经 Cloudflare Access 进来的会话默认不需要 AUTH_TOKEN
    // （设备审批也 bypass），读一次 logs:server 就能把它从那几行里抠出来，之后可走 LAN、
    // 可在 Access 吊销后继续用。
    // 免手输 token 的需求由 `node scripts/qr.js`（下面那行）与面板二维码覆盖，两者都要人主动敲，
    // 不像横幅每次启动都自动打印——这正是 scripts/config.js `--reveal` 的同一条口径。
    const maskedToken = maskToken(AUTH_TOKEN);
    const frag = '/#token=<YOUR_TOKEN>';

    console.log('  已启用鉴权，按场景任选一条打开（token 首次进入后存入浏览器，之后免带）：');
    console.log(`  [Token: ${maskedToken}]`);
    // 域名走 strategy 而非直读 env：策略内部会 trim + 小写归一，直读打印出来的可能与实际参与判定的字面不同。
    if (authStrategy.isEnabled()) console.log(`  🔒 Cloudflare Access 已启用：公网 ${authStrategy.publicHostname()} 强制 2FA（JWT 校验），AUTH_TOKEN 仅管 LAN/本机`);

    // 绑到具体地址（BIND_MODE=custom 指定某块网卡）时只列那一个——列出全部网卡地址会给出
    // 一串根本没人在听的 URL。通配符（0.0.0.0 / ::）才枚举本机地址。
    const isWildcard = host === '0.0.0.0' || host === '::';
    const reachable = isWildcard ? reachableIPv4s() : [host];

    // 公网那两行按声明的方案给：受管的只有 cloudflared（hard-rules §1「公网入口」），
    // 声明了别的拓扑还硬教 cloudflared 就是答非所问——那些方案产品不管进程，只指路文档。
    // 未声明时两条路并列：Cloudflare Quick Tunnel 最快能拿到 https，Tailscale 是不经 Cloudflare 的推荐路径。
    // 这里不探测 Tailscale（启动期不多 spawn），地址由 doctor 打印。
    const profile = ACCESS_PROFILE;
    const publicHint = (tokenPart) => (profile && profile !== 'cloudflare'
      ? [`  公网:   已声明 ACCESS_PROFILE=${profile}，落地要点见 docs/deployment.md「不用 Cloudflare 的公网入口」`]
      : [
        `  公网:   先跑 cloudflared tunnel --url http://localhost:${port}`,
        `          再开 https://<随机域名>.trycloudflare.com${tokenPart}  ← 装 PWA 走这条（需 https）`,
        `          不想经 Cloudflare：装 Tailscale 后 tailscale serve --bg ${port}，地址见 node scripts/doctor.js`,
      ]);

    console.log(`  本机:   http://localhost:${port}${frag}`);
    for (const ip of reachable) {
      console.log(`  可访问: http://${ip}:${port}${frag}  ← 同 WiFi 或已连隧道时可用`);
    }
    for (const line of publicHint(frag)) console.log(line);
    // 文件名按**实际生效的那份**给：写死 `.env` 会让用新格式的用户去翻一个不存在的文件
    // （2026-08-19 新装实测）。此前这里还写着「或删除 data/sessions.json 重启显示完整 URL」——
    // 那条路已经不存在了，而且「删掉状态文件来让服务端把凭据打进日志」本来也不该教给用户。
    console.log(`  💡 提示: Token 已掩码显示，完整 token 在 ${usingConfigJson() ? CONFIG_FILE_NAME : '.env'} 中查看`);
    // 只提命令名、不在这里打二维码：横幅每次启动都会跑，无人主动要求也打印凭据不合适
    // （口径同 scripts/config.js 的 --reveal）。而「知道有这么个命令」本身零暴露面——
    // 用户此刻正对着一串要在手机上手输的 URL，这是他最需要它的时刻。
    console.log('  扫码:   node scripts/qr.js  ← 免在手机上手输 token（二维码含凭据，投屏时勿用）');
  }
  console.log('========================================');
  // 启动不再自动 resume 上次会话为 viewing tab——产品决策：重启后永远停在空首页，
  // 由前端 showDashboard 展示跨工作区最近列表，用户手点才 session:switch。
  // 仍预取初始 cwd 的 CLI settings 默认，空首页 / FRESH 懒开不必等首条消息才 resolveSettings。
  // （历史：曾预热主工作目录指针并设 viewingInstanceId 省冷启动；现改为列表手选，首点会 resume 冷启。）
  ensureCliDefaults(primaryWorkDir()).then(() => {
    if (!viewingInstanceId) broadcastInstances();
  }).catch(err => console.warn('[cli-settings] 启动预取失败:', err?.message || err));
});

// #4：SIGINT 与 SIGTERM 都要清理（node --watch 重启、进程管理器、docker stop 走 SIGTERM）
function shutdown(sig) {
  console.log(`\n收到 ${sig}，正在关闭…`);
  sessions.flushSaveSync(); // B4：防抖窗口内未落盘的状态同步写入
  clearInterval(statusInterval);  // E16：node --watch 的 SIGTERM 重启路径必须清定时器
  clearTimeout(statusDebounce);   // （在途 git execFile 由 2s timeout 与进程退出收割）
  // 重启历史采样器：虽有 .unref() 不阻止退出，但关闭期间 fire 会同步 execFileSync('launchctl')
  // 卡住关闭路径（5s timeout）。与上面两条同一理由，一起清。
  clearInterval(serviceSampleInterval);
  mirrorEngine.stop();     // 只读追平定时器（.unref 不阻止退出，但清掉避免关闭期间噪音回调）
  hooksInbox.close();             // 关 hooks 投递箱 watcher + 防抖定时器（同上：避免关闭期间回调）
  stopLogTerminalSync({ dataDir: DATA_DIR }); // 同步关日志窗口：下面就 process.exit，异步来不及
  // SRV-NEW-007：清 bgBroadcast 合并定时器，防 agents.clear 后仍 fire broadcastInstances
  if (bgBroadcastTimer) { clearTimeout(bgBroadcastTimer); bgBroadcastTimer = null; }
  // 走 scout 自己的 cleanup：清 20s 兜底定时器 + 删 CLI 建的 <sid>.jsonl 残留，裸退出留不下这些。
  // immediate:true 不是可选的优化——cleanup 缺省把 unlink 挂在 300ms 定时器上，而本函数末尾
  // io.close 的回调随即 process.exit(0)，无长连接时几乎立即返回，定时器根本轮不到 fire。
  for (const cwd of [...activeScouts.keys()]) disposeScoutFor(cwd, { immediate: true });
  for (const a of agents.values()) a.dispose(); // 台阶2：遍历所有目录实例——各自杀子进程、deny 挂起审批
  agents.clear();
  // dispose() 内部对每条挂起审批调 resolvePermission('deny') → 触发 approval-store 的防抖写；必须在
  // dispose 循环之后 flush，早于 process.exit 落盘，否则这些"干净关闭时已 deny"的终态会连同其在途的
  // 200ms 防抖窗口一起丢失、变成下次启动时被误判为"崩溃遗留"的 pending（虽仍会被重启恢复兜底标 expired，
  // 但那本该是清晰的用户可见 deny，不该退化成一条不知情由的系统失效记录）。
  approvalStore.flushSaveSync();
  audit.flushSaveSync();
  readState.flushSaveSync(); // 同上：防抖窗内的已读位点不落盘，换设备就会看到一屏假未读
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
