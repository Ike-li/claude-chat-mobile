// app.js —— Express 静态托管 + Socket.IO 契约层；环境已由根 server.js 在动态导入前加载。
// 会话与 socket 解耦：AgentSession 挂在服务端（4c 物理不变量），事件 io.emit 广播（多设备同看）。
import { createServer } from 'node:http';
import { statSync, readFileSync, realpathSync, existsSync, mkdirSync, appendFileSync, unlinkSync } from 'node:fs';
import { maskToken } from '../shared/sanitizer.js';
import { writeOwnerOnlyFile, rejectableSymlinkComponent } from '../files/file-security.js';
import { homedir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import express from 'express';
import { Server } from 'socket.io';
import { AgentSession } from '../agent/agent.js';
import { deleteSession as sdkDeleteSession, resolveSettings as sdkResolveSettings } from '@anthropic-ai/claude-agent-sdk';
import { resolveFreshPrefs, defaultsFromEffectiveSettings } from '../agent/cli-settings-defaults.js';
import * as sessions from '../sessions/sessions.js';
import { getSessionHistory, listSessionsPage, sessionFileExists, sessionFileSize, sessionFileMtime, getProjectDir, invalidateListCache, catchUpStep, rebaselineAbsorbedExternal, mirrorReleaseStep, classifyTranscriptTail, mirrorEntryLock, mirrorStaleFlag, readLastPermissionMode } from '../sessions/history.js';
import { notificationForEvent, ntfyMetaFor, throttleNotify, clearNotifyPending, NOTIFY_CATEGORY, isValidPushSubscription } from '../ops/notifications.js';
import { createNotifyChannels } from '../ops/notify-channels.js';
import { attributePath, buildDiff, readPreview } from '../files/file-preview.js';
import { runDoctor, countConfigPermProblems } from '../ops/doctor-runtime.js';
import { buildWebStatusLine, buildCliStatusLine } from '../ops/statusline.js';
import { readCliObservedState } from '../agent/cli-mirror-state.js';
import { readCliStatusSnapshot, selectStatusOwner, selectStatusReplay, selectStatusSource } from '../ops/cli-statusline-bridge.js';
import { parseUsageForWeb } from '../../public/js/logic.js'; // ③ 额度窗：纯函数解析 SDK usage（防御 + 剔隐私 + 降级），与前端共用同一份
import { validateAttachments, saveAttachments, buildPromptText, toEventMeta } from '../files/uploads.js';
import * as interactionLog from '../agent/interaction-log.js';
import { createModelsCache, isCwdDefaultModel } from '../agent/models-cache.js';
import { initCfAccess, isAccessEnabled, isPublicHost, verifyAccessJwt } from '../auth/cf-access.js';
import { onAuthResult, freshState, rlSourceKey } from '../auth/rate-limiter.js';
import { deriveLatches } from './instance-latches.js';
import { deriveAttention } from '../sessions/attention.js';
import { listDir, readFile as browseReadFile } from '../files/file-browse.js';
import { isProcessed, commitProcessed } from '../agent/message-dedup.js';
import { resolveInstanceTarget, reselectViewingTarget } from './instance-routing.js';
import { watch } from 'node:fs';
import { DEFAULT_SESSION_LIMIT, MAX_SESSION_LIMIT, normalizeWorkdirEntries, loadWorkdirsFile, resolveWorkdirs, ensureWhitelisted, isWhitelisted } from '../sessions/workdirs.js';
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
import { createSocketEventRegistrar, registerSocketConnection } from './socket.js';
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
    const filePath = dirsFile.startsWith('/') ? dirsFile : join(HERE, dirsFile);
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
  if (!workDirs.includes(viewingCwd) && !viewingHasInstance) viewingCwd = workDirs[0];
  if (workDirs.join('|') !== prevKey) console.log(`[workdirs] 热加载生效：${workDirs.length} 个工作区`);
  broadcastInstances(); // dirs 变化 → 前端 structKey 变 → 目录面板全量重建（免重启）
}

// ---- 启动预检（验收 A9）----
// E9：必须用本机的 claude（你日常在终端用的那个），不用 SDK 捆绑副本——
// 版本、登录态、代理兼容性都以本机为准。
const versions = { sdk: 'unknown', cli: 'unknown' };
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
// 切 tab 只换视图、不 dispose（各实例后台并行存活，见 agents Map）。初值 null——启动不自动 resume，空首页手选。
let viewingInstanceId = null;
// viewingCwd = 当前查看实例的工作目录上下文（新建会话选目录 / statusline git 段 / 白名单维度）。
// 必须在 preflight 之后取（WORK_DIR 在 preflight 内才 realpathSync 规范化，否则 cwd 隔离失灵）。
let viewingCwd = WORK_DIR;
const viewingCwdOf = () => agents.get(viewingInstanceId)?.cwd ?? viewingCwd;
// BE-016：当前查看实例被移除（退出/dispose）后原子重选 viewing——落到剩余实例取其 cwd，落到空视图(null)保留
// 刚移除实例的 cwd（它是最后实际查看的），避免裸 viewingCwd 停在更早旧值致新会话选目录/statusline 跳回旧工作区。
// 调用点须在 agents.delete(退出实例) 之后调用（此时 [...agents.keys()] 已是剩余实例）。
const reselectViewingAfter = (removedCwd) => {
  const r = reselectViewingTarget([...agents.keys()], removedCwd, id => agents.get(id).cwd, viewingCwd);
  viewingInstanceId = r.viewingInstanceId;
  viewingCwd = r.viewingCwd;
};
// 白名单校验 + 缺省落 viewingCwd：cwd 维度的事件（setWorkdir/session:list/new）经此解析目标 cwd。
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
const resolveTarget = id => resolveInstanceTarget(id, viewingInstanceId, x => agents.has(x));
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
const httpAuth = createHttpAuth({
  authToken: AUTH_TOKEN,
  isPublicHost,
  verifyAccessJwt,
});

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
  getMetrics: () => {
    const counters = metrics.snapshot().counters;
    const failed = errorInstances.size;
    let awaiting = 0;
    for (const agent of agents.values()) {
      if (agent.pendingPermissions.size > 0 || agent.pendingQuestions.size > 0) awaiting += 1;
    }
    const notifyFailed = counters.push_failure ?? 0;
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
      },
      state: metrics.classifyState({ failed, awaiting, notifyFailed, mobileClients }),
      states: { failed, awaiting, notifyFailed, mobileClients },
      timestamp: Date.now(),
    };
  },
  push: {
    enabled: pushEnabled,
    publicKey: notify.vapidPublicKey,
    isValidSubscription: isValidPushSubscription,
    saveSubscription: savePushSubscription,
  },
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
  const wf = process.env.WORK_DIRS_FILE.startsWith('/') ? process.env.WORK_DIRS_FILE : join(HERE, process.env.WORK_DIRS_FILE);
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
// 无鉴权模式(!AUTH_TOKEN 且非公网) authPassed 恒真、永不计失败，天然不触发。sourceKey 只信 CF-Connecting-IP、
// 不信可伪造的 XFF。状态内存态 Map（重启清零 = 机主误锁时的逃生口，符合 docs/design.md 内存态取舍）；不特判本机绕过，
// 靠“成功清零”保护机主正常握手（连对 token 不累积失败）。
const rlStates = new Map(); // sourceKey → RateLimitState
// ---- 鉴权（公网 Host 强制 Access JWT、fail-closed；LAN/本机回退 token；无 token 时仅 localhost）----
io.use(async (socket, next) => {
  const ip = clientIp(socket.handshake.address);
  const rlActive = isPublicHost(socket.handshake.headers.host) || !!AUTH_TOKEN;
  const rlKey = rlSourceKey(socket.handshake, clientIp);
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

    if (isPublicHost(socket.handshake.headers.host)) {
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
      rlStates.set(rlKey, r.next);
      if (!authPassed && r.verdict === 'locked') {
        console.warn(`[conn] ${ip} 连续鉴权失败达阈值 → 锁定 ${Math.ceil(r.retryAfterMs / 1000)}s（source=${rlKey}）`);
        // FR-19 最小审计记录：只在"达阈值锁定"这个粒度写（本就限速到每锁定窗口一次），不逐次失败尝试都写——
        // 后者本身可被攻击者刷出高频事件、会把环形上限里的真实信号挤掉，锁定事件已足够代表"发生过暴破尝试"。
        audit.recordAudit({ actor: { deviceId: null, via: 'unauthenticated' }, action: 'auth_rate_limited', target: rlKey, outcome: 'locked', meta: { retryAfterMs: r.retryAfterMs } });
        metrics.inc('rate_limit_lockouts'); // NFR-15 限速触发数（与审计同粒度：每锁定窗口一次）
      }
    }

    if (!authPassed) {
      const got = socket.handshake.auth?.token;
      console.warn(`[conn] ${ip} 握手鉴权失败（token ${got ? '不匹配' : '缺失'}）`);
      return next(new Error('unauthorized'));
    }

    // 鉴权通过后，执行设备审批过滤（纵深防御）
    const isLocal = ['localhost', '127.0.0.1', '::1'].includes(clientIp(socket.handshake.address));
    if (accessEnabled || isLocal) {
      socket.deviceApproved = true;
      socket.trustBasis = 'bypass'; // SEC-03：本机/CF Access 直接批准，不受 trusted-devices.json 信任表控制——
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
const newInstanceId = instanceManager.nextId;
const permModeOf = instanceManager.permissionModeOf;
const effortOf = instanceManager.effortOf;
const inheritedMode = instanceManager.inheritedMode;
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
const cliDefaultsByCwd = new Map();           // cwd → { mode, effort, model }
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
      status = 'awaiting_input';
      for (const [, q] of a.pendingQuestions) {
        if (awaitingSince === undefined || q.createdAt < awaitingSince) awaitingSince = q.createdAt;
      }
    }
    sessionViews.push({ sessionId: a.sessionId, cwd: a.cwd, title, lastActiveAt, status, awaitingSince });
  }
  const { needsYou } = deriveAttention(sessionViews, pendingApprovals);
  // instanceId 是纯函数契约之外的接线专用字段（前端深链需要，复用 FR-14 applyDeepLink({instanceId,sessionId,cwd})）。
  return needsYou.map(item => ({ ...item, instanceId: instanceIdBySessionId.get(item.sessionId) ?? null }));
}
// 服务状态可见性（NFR-15/可维护性，与上面 computeNeedsYou 的 FR-21/注意力不对称是不同的轴，不混入其判定）：
// "ccm 这个服务本身有没有出过岔子"——目前收敛到两个此前从未有任何 UI 展示过的信号：推送投递健康（超窗自动
// 退场，不做不衰减的常驻布尔，见 recentDeliveryFailure）+ 服务启动时刻（供前端与本地基线比对判定重启）。
// 刻意不接 classifyState()：那是 /metrics 外部消费的粗分类，failed/awaiting 已被会话 ❗ 角标/需要你(N) 覆盖，
// mobile_offline 对正在看 UI 的设备是自指悖论——原样接入会制造重复信号，见方案 Context。
function computeServiceHealth() {
  const g = metrics.snapshot().gauges;
  const c = metrics.snapshot().counters;
  const failure = metrics.recentDeliveryFailure({
    pushFailureAt: g.push_failure_last_ts, ntfyFailureAt: g.ntfy_failure_last_ts, now: Date.now()
  });
  return {
    startedAt: SERVICE_STARTED_AT,
    deliveryFailure: failure
      ? { ...failure, count: (failure.channel === 'ntfy' ? c.ntfy_failure : c.push_failure) ?? 0 }
      : null
  };
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
      queueFull: a.pendingTurns >= 2, // 队列已满（1 运行中 + 1 排队），前端据此禁发送按钮
      // 切 tab 面板同步：携带各实例当前档，前端 setInstances 据此静默刷新顶部 permMode/effort/model select
      permissionMode: permModeOf(id), effort: effortOf(id), model: a.activeModel || a.reportedModel || null
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
      cliDefaultsByCwd.set(cwd, d);
      return d;
    } catch (err) {
      console.warn(`[cli-settings] resolveSettings 失败 (${cwd}):`, err?.message || err);
      return { mode: 'default', effort: null, model: undefined };
    } finally {
      if (cliDefaultsInflight.get(cwd) === p) cliDefaultsInflight.delete(cwd);
    }
  })();
  cliDefaultsInflight.set(cwd, p);
  return p;
}
function broadcastInstances() { // 多设备同步 tab 栏（当前查看 tab + 各实例角标状态，合成事件惯例）
  io.to('approved').emit('agent:event', { // SEC-01：仅广播给已批准设备
    seq: 0, epoch: 'server', sessionId: null, instanceId: viewingInstanceId, cwd: viewingCwd, ts: Date.now(),
    type: 'instances', payload: instancesPayload()
  });
}
// 后台任务集合变化 → 会话列表 ⏳ 重算的 500ms 合并节流：agent 侧 onBgTaskChange 只在"空↔非空/成员增删"时回调（稳态高频心跳不触发），
// 这里再合并同一 tick 内的多次变化（TTL 批量清 + 新任务同时到）成一次 broadcastInstances，避免重复全量广播。单飞：已排期则忽略。
let bgBroadcastTimer = null;
function scheduleBgBroadcast() {
  if (bgBroadcastTimer) return;
  bgBroadcastTimer = setTimeout(() => { bgBroadcastTimer = null; broadcastInstances(); }, 500);
}

// 只读「追平」：web 端续接「正在终端 CLI 里跑」的会话时，另起的 resume 进程无法 attach 终端活进程，
// 只能轮询磁盘 transcript，把终端【已落定】的新消息追加到 web。单定时器自适配当前查看会话（切会话即重置基线），
// 决策交纯函数 catchUpStep（history.js，单测覆盖）。看不到实时 thinking / 在跑子 agent——它们不落盘（已知边界）。
const CATCH_UP_INTERVAL_MS = 2500;          // 常态追平间隔
const CATCH_UP_MIRROR_INTERVAL_MS = 1000;   // 只读镜像中更勤：盯终端落盘时体感更跟手
const MIRROR_RELEASE_MS = 12_500;           // 终端静默多久自动解锁（与 history MIRROR_RELEASE_QUIET_TICKS×2.5s 同口径）
const statusBridgeOff = process.env.CLI_STATUSLINE_BRIDGE === 'off'; // 紧急回滚：恢复旧 SDK-only statusline
// 只读锁：仅当轮询【观察到外部真落定新消息】(catchUpStep emit 非空) ⇒ 判终端活跃 ⇒ 发 mirror_state 令前端
// 禁用输入，硬防「两进程并发写同一 JSONL 致会话分叉」。解锁：切会话重判 / 用户显式接管（前端 override）。
// 不用 transcript mtime 判活：web 端自己 resume 会话时 claude --resume 就写盘刷新 mtime（追加 mode 记录），
// 无法据此区分「己方续接」与「终端在跑」——曾致纯 web 打开/切换会话被误锁只读（切入即 mtime 判活口径已废弃）。
let mirrorReadonly = false;                         // 当前查看会话是否判「终端活跃、只读」（全局单值，非 per-连接）
// 【已评估：不做 AD-5 per-连接锁粒度（2026-07-12 机主确认，Phase 8 技术债）】mirrorReadonly 是全局单值 +
// io.to('approved') 全局广播 + viewingInstanceId 单例全局——docs/design.md 指出的已知缺陷：两台设备看不同会话时，
// 给会话 B 的 mirror_state 会误解锁正看会话 A 的另一端（前端 onMirrorState 注释同款登记）。AD-5 的完整修复
// （viewing/catchup/mirror 全改 per-(sessionId,connId) + readonly_changed 定向下发）是改动面很广的大改，触发
// 面窄（仅"同一人多设备同看不同会话"并发），n=1 单用户下不值，保留现状。别再因"AD-5 是改进方向"重启这个大改。
let mirrorStale = false;                            // stale=疑似终端中断（锁着+尾部 pending+超 MIRROR_STALE_PENDING_MS 零写入），前端换「可接管」文案
let mirrorObservedCli = { model: null, permissionMode: null, effort: null };
let mirrorSessionId = null, mirrorInstanceId = null; // 锁/观察态的归属；切视图空窗不得把 A 的全局锁套到 B
function normalizeMirrorObserved(observed, readonly) {
  if (!readonly) return { model: null, permissionMode: null, effort: null };
  return {
    model: observed?.model ?? null,
    permissionMode: observed?.permissionMode ?? null,
    effort: observed?.effort ?? null,
  };
}
function sameMirrorObserved(a, b) {
  return a.model === b.model && a.permissionMode === b.permissionMode && a.effort === b.effort;
}
function mirrorOwnedBy(sessionId, instanceId) {
  return mirrorReadonly && mirrorSessionId === sessionId && mirrorInstanceId === instanceId;
}
function readCliSnapshotForSession(sessionId, cwd) {
  const options = { cwd };
  if (process.env.CLI_STATUSLINE_DIR) options.dir = process.env.CLI_STATUSLINE_DIR;
  return readCliStatusSnapshot(sessionId, options);
}
function mergeCliObserved(transcriptObserved, sessionId, cwd) {
  const base = transcriptObserved || { model: null, permissionMode: null };
  if (statusBridgeOff) return { model: base.model ?? null, permissionMode: base.permissionMode ?? null, effort: null };
  const cliRead = readCliSnapshotForSession(sessionId, cwd);
  const snapshot = cliRead.state === 'fresh' ? cliRead.snapshot : null;
  return {
    model: snapshot?.model?.id ?? base.model ?? null,
    permissionMode: base.permissionMode ?? null,
    effort: snapshot?.effort ?? null,
  };
}
function catchUpIntervalMs(readonly = mirrorReadonly) {
  return readonly ? CATCH_UP_MIRROR_INTERVAL_MS : CATCH_UP_INTERVAL_MS;
}
function mirrorReleaseTicksNeeded(readonly = mirrorReadonly) {
  // 墙钟目标 MIRROR_RELEASE_MS：mirror 提速轮询时提高 tick 数，避免 1s×5=5s 过早解锁
  return Math.max(1, Math.ceil(MIRROR_RELEASE_MS / catchUpIntervalMs(readonly)));
}
function mirrorRemainingMs({ readonly = mirrorReadonly, quietTicks = Number(mirrorRelease?.quietTicks) || 0 } = {}) {
  if (!readonly) return 0;
  const interval = catchUpIntervalMs(readonly);
  const need = mirrorReleaseTicksNeeded(readonly);
  return Math.max(0, (need - quietTicks) * interval);
}
function setMirror(readonly, sessionId, force = false, stale = false, observedCli = mirrorObservedCli) {
  const nextObserved = normalizeMirrorObserved(observedCli, readonly);
  const nextSessionId = readonly ? (sessionId ?? null) : null;
  const nextInstanceId = readonly ? viewingInstanceId : null;
  const quietTicks = Number(mirrorRelease?.quietTicks) || 0;
  // 用【目标】readonly 算 remaining，勿读旧 mirrorReadonly（上锁瞬间旧值仍是 false 会算成 0）
  const remainingMs = mirrorRemainingMs({ readonly, quietTicks });
  // remainingMs 变化时也要推（倒计时 UI）；与 observedCli 同理
  if (!force && readonly === mirrorReadonly && stale === mirrorStale
      && nextSessionId === mirrorSessionId && nextInstanceId === mirrorInstanceId
      && sameMirrorObserved(nextObserved, mirrorObservedCli)
      && remainingMs === (mirrorLastEmittedRemainingMs ?? -1)) return;
  // observedCli 也参与变化判定：CLI 在同一只读轮次里 /model 或 /permissions 后，readonly/stale 不变，
  // 仍必须推一条 mirror_state；否则 Web 会永远停在旧模型/模式。
  mirrorReadonly = readonly; mirrorStale = stale; mirrorObservedCli = nextObserved;
  mirrorSessionId = nextSessionId; mirrorInstanceId = nextInstanceId;
  mirrorLastEmittedRemainingMs = remainingMs;
  io.to('approved').emit('agent:event', { // SEC-01：仅广播给已批准设备
    seq: 0, epoch: 'server', sessionId: sessionId ?? null, instanceId: viewingInstanceId, cwd: viewingCwd,
    ts: Date.now(), type: 'mirror_state',
    payload: { readonly, stale, observedCli: nextObserved, quietTicks, remainingMs },
  });
  scheduleStatusRefresh(); // 驾驶方或 CLI 观察态变化时立即切换/刷新 statusline 来源
  rescheduleCatchUp(); // 锁态变 → 追平间隔在 1s/2.5s 间切换
}
let mirrorLastEmittedRemainingMs = -1;
let catchUpKey = null;                              // `${cwd}\x00${sessionId}`：当前追平的会话
let catchUpState = { baseline: 0, wasBusy: false };
let catchUpRebaselineRequested = false;             // BE-009：客户端（重）连时置位，下一 tick 重定基线；先检测被吸收的外部增长再标 externalDirty，防分叉
// 只读锁释放状态机（history.js mirrorReleaseStep，含自动解锁计时）——修 code-review 发现 1：
// 原实现上锁后无任何自动释放路径，终端写一次就把移动端输入锁死到手动切会话/接管为止。现每 tick 据
// 「本 tick 有无外部写入 / web 是否在跑」推进 quietTicks：终端静默足够久（idle 且连续 N tick 无外部写入）自动解锁。
let mirrorRelease = { readonly: false, quietTicks: 0 };
let mirrorLastSize = -1;                            // 上一 tick 的 transcript 字节大小（keep-alive 判文件增长）；-1=基线未建立（切入 / localBusy 后首个正常 tick 只记 size 不判增长）
async function catchUpTickOnce() {
  const id = viewingInstanceId;
  const a = id ? agents.get(id) : null;
  if (!a || !a.sessionId) { catchUpKey = null; mirrorRelease = { readonly: false, quietTicks: 0 }; mirrorLastSize = -1; setMirror(false, null); return; } // 无查看会话：停、复位释放态
  const key = `${a.cwd}\x00${a.sessionId}`;
  const st = instanceState(id);
  const localBusy = st === 'busy' || st === 'permission';
  // BE-009：处理「客户端（重）连要求重定基线」。旧实现连接时直接 `catchUpKey = null` 强制下方 switch 分支重建
  // baseline，但会把「连接前终端写入、catchUpTick 尚未观察」的外部增长静默吸收——不标 externalDirty，SDK 内存
  // 上下文继续滞后 → 下条手机消息从旧位置分叉。此处在重建【之前】比较磁盘长度与旧 baseline：同一会话重连且磁盘
  // 更长 = 有被吸收的外部增长 → 标 externalDirty（下次发送前置换实例吸收），再置 catchUpKey=null 保留原「重连
  // 重渲无重复气泡」行为。真会话切换（key !== catchUpKey）不在此判、由下方 switch 分支按新会话正常重建。
  if (catchUpRebaselineRequested) {
    catchUpRebaselineRequested = false;
    if (key === catchUpKey) {                                        // 同一会话重连（非真切换）
      let curLen;
      try { curLen = (await getSessionHistory(a.sessionId, a.cwd)).length; } catch { curLen = -1; }
      if (viewingInstanceId === id && agents.get(id) === a && `${a.cwd}\x00${a.sessionId}` === key
          && rebaselineAbsorbedExternal({ sameSession: true, curLen, baseline: catchUpState.baseline })) {
        a.externalDirty = true; // 被 rebaseline 吸收的终端外部增长 → 标脏防分叉
      }
    }
    catchUpKey = null;                                               // 强制下方 switch 分支重建 baseline + 重评 mirror 入口锁
  }
  if (key !== catchUpKey) {                                           // 切了会话：以现有历史长度定基线，本 tick 不推
    let seedLen;
    try { seedLen = (await getSessionHistory(a.sessionId, a.cwd)).length; }
    catch { return; }
    catchUpKey = key;
    catchUpState = { baseline: seedLen, wasBusy: localBusy };
    mirrorLastSize = -1;                                 // 基线未建立：切入首个正常 tick 只记 size、不判增长
    // 切入预判（2026-07-12 单驾驶员）：按尾部形态立即预锁——PENDING=有人正驱动（终端轮次未完结），
    // 堵「切走再切回、终端还在跑但要等下一条 text 落盘才锁」的空窗。旧「切入不预锁」是因为当时唯一
    // 判据 mtime 不可信（web resume 自身刷 mtime）；尾部形态是语义判据、可信。localBusy 豁免见 mirrorEntryLock。
    let tail = { verdict: 'settled', lastChainTs: null };
    let observedCli = { model: null, permissionMode: null };
    try { tail = await classifyTranscriptTail(a.sessionId, a.cwd); } catch { /* 读失败保守不锁 */ }
    try { observedCli = await readCliObservedState(a.sessionId, a.cwd); } catch { /* 读失败显未知 */ }
    observedCli = mergeCliObserved(observedCli, a.sessionId, a.cwd);
    if (viewingInstanceId !== id || agents.get(id) !== a || `${a.cwd}\x00${a.sessionId}` !== key) return;
                                                              // await 让出后视图/实例/session 可能已变：旧观察结果全部作废
    const entryLock = mirrorEntryLock({
      tailVerdict: tail.verdict,
      localBusy,
      lastChainTs: tail.lastChainTs,
      now: Date.now(),
    });
    mirrorRelease = { readonly: entryLock, quietTicks: 0 };
    setMirror(entryLock, a.sessionId, true,              // force 清上个会话残留的锁/发权威态
      mirrorStaleFlag({ readonly: entryLock, tailPending: tail.verdict === 'pending', lastChainTs: tail.lastChainTs, now: Date.now() }),
      observedCli);
    return;
  }
  if (localBusy) {                                                    // 己方在跑：抑制追平、免读大文件；释放态保持锁不变、不借己方忙碌攒静默
    catchUpState = { baseline: catchUpState.baseline, wasBusy: true };
    mirrorLastSize = -1;                                             // 作废 size 基线：己方 turn 会写盘涨 size，不能算终端 keep-alive；localBusy 结束后首个正常 tick 重建
    const rel = mirrorReleaseStep(mirrorRelease, {
      externalWrite: false, localBusy: true, releaseTicks: mirrorReleaseTicksNeeded(),
    });
    mirrorRelease = rel.state;
    setMirror(rel.readonly, a.sessionId);
    return;
  }
  let messages, curSize, tail = { verdict: 'settled', lastChainTs: null };
  let observedCli = { model: null, permissionMode: null };
  try { messages = await getSessionHistory(a.sessionId, a.cwd); } catch { return; }
  try { curSize = await sessionFileSize(a.sessionId, a.cwd); } catch { curSize = -1; }
  // 尾部形态（2026-07-12 单驾驶员核心判据）：轮次未完结(pending)期间维持锁——罩住「终端卡在一条几分钟的
  // 长工具上、磁盘零写入」窗（keepAlive 罩不住，原 12.5s 静默窗在此误判解锁、横幅熄灭="感觉没在跑"真实报障）。
  try { tail = await classifyTranscriptTail(a.sessionId, a.cwd, { size: curSize >= 0 ? curSize : null }); } catch { /* 读失败保守 settled：不多锁 */ }
  try { observedCli = await readCliObservedState(a.sessionId, a.cwd, { size: curSize >= 0 ? curSize : null }); } catch { /* 读失败显未知 */ }
  observedCli = mergeCliObserved(observedCli, a.sessionId, a.cwd);
  const { emit, state } = catchUpStep(catchUpState, { messages, localBusy: false });
  if (viewingInstanceId !== id || agents.get(id) !== a || `${a.cwd}\x00${a.sessionId}` !== key) return;
                                                                    // await 让出后视图/实例/session 可能已变：作废旧 tick，不提交 baseline/size/观察态
  catchUpState = state;                                              // 视图仍在才提交 baseline——移到切走判断之后，防切走瞬间污染 baseline 致那段外部写入在 catchUp 路径漏推
  // keep-alive：transcript 文件比上 tick 大 = 终端在写盘（含跑工具/思考的 tool_use/tool_result，被 text-only 过滤挡在 catchUpStep len 外）。
  // 仅基线已建立(lastSize≥0)时判增长；切入 / localBusy 后首 tick 只记 size 不判（避免把切入前既有体量或己方写盘误当终端活跃）。
  const keepAlive = mirrorLastSize >= 0 && curSize > mirrorLastSize;
  if (curSize >= 0) mirrorLastSize = curSize; // 读取瞬时失败(curSize=-1)不覆盖基线：保留上次好值，避免把「基线未建立」哨兵误写回、平白吃掉 1-2 个 tick 的 keep-alive 信号
  const externalWrite = emit.length > 0;
  if (externalWrite) {                                               // 观察到外部写入 → 追平尾巴
    metrics.inc('catch_up_hits'); // NFR-15 补齐命中（catchUpTick 成功推了终端侧外部增量的次数）
    a.externalDirty = true; // 该实例的 SDK 子进程内存上下文已落后于磁盘（外部驱动方写了新轮次）——web 下次发送前须置换实例吸收，否则模型看不到这些轮次、语义分叉
    io.to('approved').emit('agent:event', { // SEC-01：会话内容，仅广播给已批准设备
      seq: 0, epoch: 'server', sessionId: a.sessionId, instanceId: id, cwd: a.cwd, ts: Date.now(),
      type: 'history_append', payload: { messages: emit, external: true }
    });
  }
  const tailPending = tail.verdict === 'pending';
  const rel = mirrorReleaseStep(mirrorRelease, {
    externalWrite, keepAlive, tailPending, localBusy: false,
    releaseTicks: mirrorReleaseTicksNeeded(),
  }); // 外部 text 写入→锁；文件仍在长/轮次未完结→维持锁；真静默→累计、达阈值自动解锁
  mirrorRelease = rel.state;
  setMirror(rel.readonly, a.sessionId, false,                       // 锁/stale/CLI 观察值任一变化都广播
    mirrorStaleFlag({ readonly: rel.readonly, tailPending, lastChainTs: tail.lastChainTs, now: Date.now() }),
    observedCli);
}
let catchUpInFlight = null;
function catchUpTick() {
  if (catchUpInFlight) return catchUpInFlight; // interval + 手动 syncNow 单飞，防旧观察晚到覆盖新状态
  const running = catchUpTickOnce();
  const wrapped = running.finally(() => { if (catchUpInFlight === wrapped) catchUpInFlight = null; });
  catchUpInFlight = wrapped;
  return wrapped;
}
// 动态追平调度：mirror 只读时 1s，常态 2.5s（墙钟解锁仍按 MIRROR_RELEASE_MS≈12.5s）
let catchUpTimer = null;
function rescheduleCatchUp() {
  if (catchUpTimer) clearTimeout(catchUpTimer);
  const ms = catchUpIntervalMs();
  catchUpTimer = setTimeout(() => {
    catchUpTick().catch(() => {}).finally(() => rescheduleCatchUp());
  }, ms);
  if (typeof catchUpTimer.unref === 'function') catchUpTimer.unref();
}
rescheduleCatchUp();

const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max']; // 5 档硬编码，漂移由 smoke-effort 的 CLI warning 检测
// 最近一次 init payload + 按 cwd 归键的 models 缓存：新连接重放，免发消息即得加载摘要、命令列表与模型候选。
// 持久化到 data/init-cache.json 跨重启读回（CLI 收到首条消息前不输出 init——init 是轮次开始信号，
// 预热 spawn 也等不来；缓存可能陈旧但每轮 init 覆盖刷新，文件可随时删除，损坏即当作没有）。
// modelsCache 按 cwd 归键：模型清单随工作区 settings.local.json 覆盖网关/模型名而变，非账号级全局量——
// 单全局缓存会跨工作区泄漏（切区点新会话冒出上个区 deepseek 名），同 lastInit 的 per-cwd 治理。详见 models-cache.js。
const INIT_CACHE = join(DATA_DIR, 'init-cache.json');
let lastInit = null;
const modelsCache = createModelsCache();
// per-cwd「CLI 默认模型」缓存：新会话/无记录续接在 init 返回前显它、而非笼统「沿用当前」（只显示、不改发送）。
// 仅由「未 resume 且未 pin model」的启动填充（scout / fresh 首 init，判据 isCwdDefaultModel）。
const defaultModelByCwd = new Map();
try {
  const c = JSON.parse(readFileSync(INIT_CACHE, 'utf8'));
  lastInit = c.init ?? null;
  modelsCache.load(c.modelsByCwd); // 旧格式 c.models（单全局）不迁移——缓存可弃、下轮 models 事件即重建本区清单
  if (c.defaultModelByCwd && typeof c.defaultModelByCwd === 'object' && !Array.isArray(c.defaultModelByCwd)) {
    for (const [cwd, m] of Object.entries(c.defaultModelByCwd)) if (cwd && typeof m === 'string' && m) defaultModelByCwd.set(cwd, m);
  }
} catch { /* 无缓存/损坏：保持空 */ }
function saveInitCache() {
  try {
    mkdirSync(dirname(INIT_CACHE), { recursive: true });
    writeOwnerOnlyFile(INIT_CACHE, JSON.stringify({ init: lastInit, modelsByCwd: modelsCache.toJSON(), defaultModelByCwd: Object.fromEntries(defaultModelByCwd) }));
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

// ---- statusline 单一来源路由：Web 驾驶用 SDK；CLI 镜像/外部脏上下文用按 session 隔离的 CLI 快照 ----
const statusOff = process.env.WEB_STATUSLINE === 'off'; // 禁用开关（默认启用，零 UI 痕迹）
let lastStatusLine = null;                             // 仅内存：结构化 payload，瞬时数据不持久化
let statusDebounce = null, statusInterval = null;
let isStatusRefreshing = false;                        // 防并发重叠锁

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
  if (isStatusRefreshing) return;
  isStatusRefreshing = true;
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
        // CLI 是当前唯一权威但快照缺失/过期：明确不可用，不偷混 SDK 陈值。
        payload = {
          ts: Date.now(), cwd,
          ...(cwd ? { project: cwd.replace(/\/+$/, '').split('/').pop() || cwd } : {}),
          ...(va.sessionId ? { session: { id: va.sessionId } } : {}),
          source: { kind: 'cli-unavailable', reason: selected.reason, ...(Number.isFinite(selected.ageMs) ? { ageMs: selected.ageMs } : {}) },
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
// （session:new/switch）负责去重（instanceForSession）与切 viewingInstanceId。返回实例。
// 同步建（resumeId 由调用方解析，无需 await）——故无台阶2 的「await 让出窗口双实例」重入竞态。
function openInstance({ cwd, resumeId = null, mode, effort, transcriptMode = null }) {
  const id = newInstanceId();
  const saved = resumeId ? (sessions.getSession(resumeId) || { id: resumeId }) : null;
  if (saved?.id) {
    interactionLog.addSessionLog(saved.id, 'sys_info', `[SYS] 启动/连接会话: instanceId=${id}, resumeId=${saved.id}, cwd=${cwd}`);
  }
  // 档位初值优先级：显式入参（mode/effort 已定义，如 setEffort 置换）>
  //   FRESH: L0 pending > L3 CLI settings（cliDefaultsByCwd）> L4 硬默认 ｜
  //   RESUME: saved 持久化值 > transcriptMode > 继承该 cwd 末实例档。
  // A1（2026-06-22）：新会话(FRESH)不继承 cwd 末实例档——贴终端等价（新起 claude 是干净默认）。
  // 2026-07-14：FRESH 的「干净默认」= resolveSettings 合并结果，不再写死 default/null。
  // resume 权限档：saved（sessions.json）> transcriptMode（CLI 末档）> inherited。
  // effort 无 transcript 对称恢复：CLI 常不落盘 effort → 纯 CLI 续接仍可能回落模型默认（已知边界）。
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
      mode = saved?.permissionMode || transcriptMode || inheritedMode(cwd);
    }
  }
  let eff;
  if (effort !== undefined) eff = effort;
  else if (isFresh) {
    eff = fresh.effort;
    pendingEffortByCwd.delete(cwd);
  } else {
    eff = saved?.effort !== undefined ? saved.effort : inheritedEffort(cwd);
  }
  permModeByInstance.set(id, mode);
  effortByInstance.set(id, eff);
  // 模型：resume 用会话指针；FRESH 仅当 L3 settings.model 有值才 pin（多数环境无此键 → undefined=CLI 自选）
  const startModel = saved?.model || (isFresh ? fresh?.model : undefined) || undefined;
  const instance = new AgentSession({
    instanceId: id,
    resumeId: saved?.id,
    cwd,
    claudeBin,
    // resume 时回传会话原模型名（CLI 自身恢复的是规范化裸名，部分网关不认）——来源仅会话指针
    model: startModel,
    permissionMode: mode,
    effort: eff,
    idleTimeoutMs,
    instanceIdleReclaimMs,
    approvalTtlMs,
    historicalCostUsd: saved?.cost || 0,
    onEvent: envelope => {
      metrics.inc('events'); // NFR-15 事件 seq 速率（累计事件数，速率由 /metrics 消费者按两次快照时间差算）
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
        io.to('approved').emit('agent:event', envelope); // SEC-01：主事件流含全部会话内容，仅广播给已批准设备
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
        let pn = notificationForEvent(envelope.type, envelope.payload, {
          // BE-007：能看到 result 的客户端 = 已加入 approved 房间的连接。待审批(deviceApproved=false)设备虽连着
          // 但没 join approved、看不到会话内容/result，不能算「有人在看」而抑制离线推送——否则唯一在线的是待审批
          // 设备时，真正该收到完成通知的离线已批准设备反而收不到。permission/question/task_notification 无条件推、不受此影响。
          hasClients: (io.sockets.adapter.rooms.get('approved')?.size ?? 0) > 0,
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
          pushNotify(pn.title, pn.body, pn.data);                              // Web Push（带 data 供 SW 深链）
          ntfyNotify(pn.title, pn.body, ntfyMetaFor(envelope.type, pn.data, notify.publicUrl)); // ntfy（click 深链，绕移动端限制）
        }
        broadcastInstances();
      }
    },
    // E16：assistant 边界刷新 statusline（仅当前查看 tab；scheduleStatusRefresh 有 300ms 防抖兜频率）——ctx 不等 result/10s tick
    onUsage: () => { if (id === viewingInstanceId) scheduleStatusRefresh(); },
    // 活后台任务集合变化 → 节流重算会话列表 ⏳（纯后台运行期 pendingTurns=0，这是唯一的 busy 触发源；scout 实例不接、不跑后台任务）
    onBgTaskChange: () => scheduleBgBroadcast(),
    onSessionId: (sid, firstMessage, model) => {
      // 新会话首次获得 id 时，写 entrypoint 元数据使 CLI /resume 可见（按本实例 cwd 落对应 project 目录）。
      // sessionId 已在 agent.js 先于 emit('init') 赋值 → 下方 init 边界的 broadcastInstances 自然带新 sid/title。
      if (!sessions.getSession(sid)) writeSessionEntrypoint(sid, cwd);
      // effort/permissionMode 一并持久化：init 事件到达时 agent 已完成漂移检测（permissionMode 为对账后真值），
      // effort 为构造时注入值（运行时不可改）。web 端续接恢复依赖这两字段。
      sessions.upsertSession({ id: sid, title: firstMessage, cwd, model, effort: instance.effort, permissionMode: instance.permissionMode });
      // fresh 会话（未 resume、未 pin model）首 init 的 model = cwd CLI 默认 → 缓存供后续新会话预显（判据排除 resume-no-record，防污染）
      recordCwdDefaultModel(cwd, { resumeId: instance.resumeId, pinnedModel: instance.defaultModel, reportedModel: model });
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
        abortedInstances.delete(id);
        if (viewingInstanceId === id) reselectViewingAfter(cwd); // BE-016：同步 viewingCwd（cwd=退出实例 cwd），落空视图保留最后查看 cwd
      }
      broadcastInstances(); // 实例退出 → 刷 tab 栏（角标回落 / 该 tab 消失）
    }
  });
  agents.set(id, instance);
  instance.start();
  return instance;
}

// resume 开实例的异步封装：新开前先读 transcript 末条 permission-mode 恢复权限档（纯 CLI 会话 sessions.json
// 无档时的恢复来源，见 readLastPermissionMode）。openInstance 本身保持同步（避免重入竞态）；读盘只在此异步前置。
// 仅 resume（resumeId 非空）才读——FRESH 无档可恢复、也不该读；已 live 实例由调用方 instanceForSession 去重、不覆盖运行时档。
async function openResumeInstance(cwd, resumeId, extra = {}) {
  const transcriptMode = resumeId ? await readLastPermissionMode(resumeId, cwd) : null;
  return openInstance({ cwd, resumeId, transcriptMode, ...extra });
}

// resume 并发去重：openResumeInstance 内部有 await（读 transcript 权限档），调用方常见写法是
// `instanceForSession(id) || await openResumeInstance(cwd, id)`——两个几乎同时到达、目标同一 sessionId
// 的请求（如 session:switch 被连点两次、两台设备同时切到同一会话）会双双通过 instanceForSession 检查
// （此时都还没人注册），双双落入 openResumeInstance，各自 spawn 一个 `claude --resume` 进程操作同一份
// 会话文件。用 sessionId 键的 in-flight map 把后到的请求收敛到同一个 Promise，只有一次真正 spawn。
// resumeId 为空（FRESH 新会话）不去重——那是另一套 justOpened 机制（S2）在管，语义不同、不在此处混入。
const resumeInFlight = new Map(); // sessionId → Promise<AgentSession>
function dedupedResume(cwd, resumeId, extra = {}) {
  if (!resumeId) return openResumeInstance(cwd, resumeId, extra);
  let p = resumeInFlight.get(resumeId);
  if (!p) {
    p = openResumeInstance(cwd, resumeId, extra).finally(() => resumeInFlight.delete(resumeId));
    resumeInFlight.set(resumeId, p);
  }
  return p;
}

// scout 实例：为工作区获取真实模型清单的临时代理。
// session:new / setWorkdir 到无缓存工作区时，没有活实例调 supportedModels()→前端无模型可选。
// scout 以「不留任何痕迹」的方式临时启动 CLI：模型一到即缓存 → 推送前端 → dispose → 删除 CLI 残留文件。
// 与缓存关系：缓存加速后续（免重复 spawn），但第一次靠 scout 保证确定性——不用猜、不等实例、不靠上区残留。
function openScoutInstance(cwd) {
  const id = newInstanceId();
  const instance = new AgentSession({
    instanceId: id, resumeId: null, cwd, claudeBin,
    model: undefined, permissionMode: 'default', effort: null, idleTimeoutMs, instanceIdleReclaimMs: 0, approvalTtlMs,
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
      // scout 恒 fresh（resumeId=null、未 pin model）→ 其 init.model 即 cwd CLI 默认，权威缓存之。
      // 若当前正查看本 cwd（空首页），补一次广播让默认名即时到达前端（不必等下次视图切换）。
      if (recordCwdDefaultModel(cwd, { resumeId: instance.resumeId, pinnedModel: instance.defaultModel, reportedModel: model }) && cwd === viewingCwd) broadcastInstances();
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
  instanceManager.remove(instanceId);
  if (viewingInstanceId === instanceId) reselectViewingAfter(a.cwd); // BE-016：同步 viewingCwd，落空视图保留最后查看 cwd
  broadcastInstances();
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

registerSocketConnection(io, socket => {
  console.log(`[conn] ${socket.id} 已连接（来自 ${clientIp(socket.handshake.address)}）`);
  // 只读追平：客户端（重）连时请求下一 tick 重定基线——重连会 loadHistory 重渲全量历史，若沿用滞后 baseline
  // 会把已显示的消息再 history_append 一遍成重复气泡。重定基线=不推、仅对齐，安全。
  // BE-009：改为置 catchUpRebaselineRequested 标志（而非直接 catchUpKey=null）——让下一 tick 在重建 baseline
  // 之【前】比较磁盘长度、把被吸收的终端外部增长标 externalDirty，防它被静默吞掉致下条手机消息分叉。
  catchUpRebaselineRequested = true;

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
    replayStatusLineTo(socket); // 仅 owner/instance/session/cwd 全匹配才即时上屏
    // 台阶3：重放当前查看 tab 的权限档（总是发，含 default）
    permModeTo(socket);
    // 重放当前查看 tab 的思考强度档（总是发，含 null=模型默认）
    effortTo(socket);
    // 台阶3：重放 tab 栏快照（viewingInstanceId + dirs + 各实例状态）
    instancesTo(socket);
    // 只读追平：向(重)连客户端补发当前只读态——setMirror 仅在变化时广播、不会自动补给新 socket，
    // 不补则重连客户端会以「可编辑」状态渲染一个终端正在跑的会话，留下并发写盘分叉的窗口。
    const currentMirrorAgent = agents.get(viewingInstanceId);
    if (currentMirrorAgent && mirrorOwnedBy(currentMirrorAgent.sessionId, viewingInstanceId)) socket.emit('agent:event', {
      seq: 0, epoch: 'server', sessionId: currentMirrorAgent.sessionId,
      instanceId: viewingInstanceId, cwd: viewingCwd, ts: Date.now(), type: 'mirror_state',
      payload: { readonly: true, stale: mirrorStale, observedCli: mirrorObservedCli }
    });
    // 可信端连入时重放当前待审批设备列表，使其可立即在 Web UI 远程审批
    socket.emit('agent:event', {
      seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
      type: 'pending_devices', payload: pendingDevicesPayload()
    });
    scheduleStatusRefresh(); // 300ms 后新鲜数据跟上
  }

  on(socket, 'user:message', async (payload, ack) => {
    // REL-01 幂等（离线重发/网络抖动可能致同一条消息被处理两次）：clientMessageId 由发送端生成，
    // 已处理过的直接 ack 放行、不重复执行任何副作用（不重发校验提示、不重复调用 a.send）。
    // 无 ID（旧客户端未升级）→ 不去重，向后兼容。
    const clientMessageId = (payload && typeof payload === 'object') ? payload.clientMessageId : undefined;
    // BE-002：这里只【查询】是否已处理过，登记推迟到消息真正成功入队之后（见下方 commitProcessed）。
    // 若在此提前登记（旧 checkAndRecord 行为），校验失败/队满失败的 ID 会被记入，第二次重发命中去重
    // 得到 {ok:true,deduped:true} 被客户端当成功删除 pending → 消息永久丢失（假成功丢消息根因）。
    if (isProcessed(clientMessageId, messageDedupState)) {
      if (typeof ack === 'function') ack({ ok: true, deduped: true }); return;
    }

    const text = typeof payload === 'string' ? payload : payload?.text;
    const attachments = (payload && typeof payload === 'object') ? payload.attachments : undefined;
    const hasText = typeof text === 'string' && text.trim().length > 0;
    const hasAttachments = Array.isArray(attachments) && attachments.length > 0;
    if (!hasText && !hasAttachments) {
      sysTo(socket, '消息为空或格式无效', true); // #12：不静默丢弃；用 system 不终结在途轮
      if (typeof ack === 'function') ack({ ok: false, error: '消息为空或格式无效', permanent: true }); // BE-002：永久校验失败，客户端应停止重试
      return;
    }
    if (typeof text === 'string' && text.length > 50000) {
      // system 而非 error：发送前校验，不应 finalize 正在流式的在途任务（前端已先行红字提示）
      sysTo(socket, `消息过长（${text.length} 字符，上限 50000），未发送`, true);
      if (typeof ack === 'function') ack({ ok: false, error: '消息过长', permanent: true }); // BE-002：内容超长重发必再失败，客户端应停止重试而非无限重发
      return;
    }
    // E17：附件校验（条数/单文件/总量）。失败用 system 提示、不发送、不终结在途轮。
    const attErr = validateAttachments(attachments);
    if (attErr) {
      sysTo(socket, attErr, true);
      if (typeof ack === 'function') ack({ ok: false, error: attErr, permanent: true }); // BE-002：附件非法重发必再失败，客户端应停止重试
      return;
    }

    const cleanText = hasText ? text.trim() : '';
    const model = (payload && typeof payload === 'object') ? payload.model : undefined;
    // 台阶3：路由到目标实例（instanceId 优先）；无可路由实例（首发/session:new 后/无 open tab）则懒开一个
    // （resume 该 cwd 当前会话，无则新建；该会话已 live 则聚焦去重），设为查看 tab。
    const rawInstanceId = payload && typeof payload === 'object' ? payload.instanceId : undefined;
    const target = resolveTarget(rawInstanceId);
    if (target.stale) {
      // BE-001：显式指定了一个已关闭 / 未知实例——fail-closed：不回退当前查看会话、不懒开，负 ACK 让客户端刷新后重发。
      // 不 commit 去重 ID（客户端刷新拿到有效 instanceId 后可用同一 clientMessageId 重发）。
      sysTo(socket, '目标会话已关闭，请刷新后重发', true);
      if (typeof ack === 'function') ack({ ok: false, error: 'stale_instance', stale: true });
      return;
    }
    let a = target.id ? (agents.get(target.id) ?? null) : null;
    if (!a) {
      // ensureWhitelisted 同 session:new(#8)/session:switch：routeCwd 缺省回退(viewingCwdOf)可能仍是
      // 热移除目录（该目录有 live 实例挂着未被 reloadWorkdirs 归位），不夯一次白名单会在其上新开 FRESH 会话。
      const cwd = ensureWhitelisted(routeCwd(payload && typeof payload === 'object' ? payload.cwd : undefined), workDirs);
      const saved = await currentSessionForCwd(cwd);
      // 并发懒开去重（S2）：currentSessionForCwd 的 await 间隙内，另一条并发首消息可能已为本 cwd 懒开了实例。
      // RESUME 靠 instanceForSession（sessionId）去重；FRESH 无 sessionId，改认「await 后 viewing 已是本 cwd 实例」
      // ——两条无 instanceId 的并发首消息都意在打开该 cwd 当前(空)会话，应收敛到同一实例，不重复 spawn 孤儿实例。
      const justOpened = agents.get(viewingInstanceId);
      a = (saved && instanceForSession(saved.id))
        || (justOpened && justOpened.cwd === cwd ? justOpened : null)
        || await dedupedResume(cwd, saved?.id ?? null); // resume 恢复 CLI 原生会话权限档（去重防并发双开）；saved 为空则 FRESH 懒开
      viewingInstanceId = a.instanceId;
      broadcastInstances();
    }
    // 陈旧上下文守卫（2026-07-12 单驾驶员，修「接管后的语义分叉」）：实例的 SDK 子进程上下文是进程内存态、
    // 只在启动(resume)那一刻读过磁盘；外部驱动方（终端 CLI）此后写的轮次，web 靠追平【显示】了、但子进程
    // 【内存里没有】——直接发送=模型看不到那些轮次、还从旧位置分叉出第二条 parentUuid 链。externalDirty 由
    // catchUpTick 观察到外部 text 写入时标记（其 localBusy 吸收逻辑已排除己方写入），此处先置换实例
    // （dispose+resume 冷读最新磁盘，同 effort 切档模式）再发送。标记时实例必然 idle（catchUpTick 的
    // externalWrite 只在 localBusy=false 分支产生），dispose 不杀在途任务。
    // 已知边界：catchUpTick 只盯当前查看会话——后台 tab 被外部写过、切入后首个 tick(≤2.5s)前极速发送不经
    // 此守卫（切入流程本身 1-2s，实际难触发）；接受，不为此每次发送读盘比对。
    if (a.externalDirty && a.sessionId) {
      const cwd = a.cwd, sid = a.sessionId, mode = a.permissionMode, eff = effortOf(a.instanceId), wasViewing = viewingInstanceId === a.instanceId;
      interactionLog.addSessionLog(sid, 'sys_info', '[SYS] 会话曾被外部（终端）驱动，发送前置换实例吸收外部轮次（防陈旧上下文分叉）');
      // 体感：置换会冷启动 resume，前端先收到 system 条再等 init，避免「点了没反应」
      socket.emit('agent:event', {
        seq: 0, epoch: 'server', sessionId: sid, instanceId: a.instanceId, ts: Date.now(),
        type: 'system', payload: { message: '正在续接会话（吸收终端写入）…', kind: 'resuming' }
      });
      disposeInstance(a.instanceId);
      a = openInstance({ cwd, resumeId: sid, mode, effort: eff });
      if (wasViewing) viewingInstanceId = a.instanceId;
      broadcastInstances();
    }
    // FRESH 首轮 sessionId 可能仍 null：走 agent.logKey()（provisionalKey）与 agent 内 userMessageOut/agentSend 对齐
    interactionLog.userMessageIn(a.logKey(), cleanText, model || a.activeModel || a.reportedModel || a.defaultModel, a.effort || 'model-default', a.permissionMode || 'default'); // 交互日志：client → server；model/effort/perm 走 chip 字段
    let sent;
    if (hasAttachments) {
      // 落盘 <cwd>/.ccm-uploads/ → 绝对路径注入 prompt → 送 SDK（claude 用 Read 读，白名单内免审批）；
      // 气泡走 displayText（原文，不含路径）+ 去完整 data 的元数据（含小 thumb，进缓冲供回放）
      const saved = await saveAttachments(a.cwd, attachments);
      sent = await a.send(buildPromptText(cleanText, saved), model, {
        displayText: cleanText, attachments: toEventMeta(saved)
      });
    } else {
      sent = await a.send(cleanText, model);               // F1：send 改 async（setModel 需 await）
    }
    // BE-002：send 返回 false = 队列已满或实例已弃用（可重试的临时失败），消息【未】入队。
    // 必须回传 ok:false + retryable 让客户端保留 pending、稍后重连重试，且【不能】commit 去重 ID——
    // 否则下次重发命中去重被假成功丢弃。旧代码无条件 ack{ok:true} 且忽略 send 返回值是「假成功丢消息」根因。
    if (!sent) {
      if (typeof ack === 'function') ack({ ok: false, error: '前面还有消息在排队，请稍后重试', retryable: true });
      return;
    }
    if (viewingInstanceId === a.instanceId && mirrorReadonly) {
      // 前端显式接管后第一条消息已成功入 Web SDK 队列：服务端此刻也切换驾驶方，避免 statusline 继续
      // 被旧 mirrorReadonly 锁在 CLI 来源。失败入队不清锁，仍保持终端权威。
      mirrorRelease = { readonly: false, quietTicks: 0 };
      mirrorLastSize = -1;
      setMirror(false, a.sessionId, true, false);
    }
    // 只在消息真正成功入队后才登记去重 ID（此后同 ID 重发才判 duplicate、幂等）。
    messageDedupState = commitProcessed(clientMessageId, messageDedupState);
    // 队列满（pendingTurns 1→2）时立即广播，前端禁发送按钮无延迟。
    if (a.pendingTurns >= 2) broadcastInstances();
    if (typeof ack === 'function') ack({ ok: true, instanceId: a.instanceId });
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
    const mode = payload?.mode;
    if (!['default', 'plan', 'acceptEdits', 'bypassPermissions', 'dontAsk', 'auto'].includes(mode)) {
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
    interactionLog.addSessionLog(a.logKey(), 'sys_info', `[SYS] 切换权限档 (user:setPermissionMode): mode=${mode}, instanceId=${id}`);
    permModeByInstance.set(id, mode);                  // 台阶3：档位 per-instance
    if (a.sessionId) sessions.updateSessionPrefs(a.sessionId, { permissionMode: mode }); // 持久化，resume 恢复用
    io.to('approved').emit('agent:event', { // SEC-01：仅广播给已批准设备
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
    // BE-008：后台任务(Workflow/后台 Agent/Bash)运行期 pendingTurns 为 0、挂起审批/问题同理，只查 pendingTurns
    // 会在这些非 turn 活动进行时 disposeInstance→abort 误杀。改用 isBusy() 综合判定：完全 idle 才允许置换实例。
    if (a.isBusy()) {
      sysTo(socket, '当前有任务在运行，请等结束后再切思考强度', true);
      return effortTo(socket);
    }
    const cwd = a.cwd, sid = a.sessionId, mode = a.permissionMode, wasViewing = viewingInstanceId === id;
    interactionLog.addSessionLog(sid, 'sys_info', `[SYS] 切换思考强度 (user:setEffort): level=${level || '模型默认'}, 正在置换实例...`);
    if (sid) sessions.updateSessionPrefs(sid, { effort: level }); // 持久化，resume 恢复用（先于 dispose，防崩溃丢档）
    // 体感：effort 换实例是冷启动，先推 system 让前端立刻显「正在续接」
    socket.emit('agent:event', {
      seq: 0, epoch: 'server', sessionId: sid, instanceId: id, ts: Date.now(),
      type: 'system', payload: { message: '正在切换思考强度并续接会话…', kind: 'resuming' }
    });
    disposeInstance(id);                                              // 关旧实例
    const ni = openInstance({ cwd, resumeId: sid, mode, effort: level }); // 开新实例 resume 同会话、带新 effort
    if (wasViewing) viewingInstanceId = ni.instanceId;
    io.to('approved').emit('agent:event', { // SEC-01：仅广播给已批准设备
      seq: 0, epoch: 'server', sessionId: null, instanceId: ni.instanceId, ts: Date.now(),
      type: 'effort_mode', payload: { level }
    });
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
    interactionLog.addSessionLog(a.logKey(), 'sys_info', `[SYS] 切换当前活动视图 (user:setViewing): instanceId=${id}, sessionId=${a.sessionId || '(pending)'}`);
    doneInstances.delete(id); errorInstances.delete(id); abortedInstances.delete(id);
    broadcastInstances();
    pushModelsForCwd(a.cwd); // 切视图到别区 tab：推该区清单刷新模型选择器（避免显另一 tab 工作区的候选）
    lastStatusLine = null;
    scheduleStatusRefresh();
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
  on(socket, 'task:stop', payload => routeInstance(payload?.instanceId)?.stopTask(payload?.taskId));

  // ③ 套餐额度窗：按需拉取（用户打开额度窗时前端发 usage:get）。usage 是账号级（非 per-instance），但取数
  // 要经某个活 agent 的 q——优先当前查看实例，无 / 无 q（fetchUsage→null）时回退任一活实例（fetchUsage 对
  // 无该方法者即时返回 null，开销小）。parseUsageForWeb 做防御性解析 + 剔除 behaviors 隐私 + 第三方 provider
  // 降级（available:false）。点对点回请求方（on-demand，不广播给未请求的设备）；鉴权由 on() 的 fail-closed 守卫。
  on(socket, 'usage:get', async payload => {
    const routed = routeInstance(payload?.instanceId);
    let usage = routed ? await routed.fetchUsage() : null;
    if (usage == null) {
      for (const cand of agents.values()) {
        if (cand === routed || cand.disposed) continue;
        usage = await cand.fetchUsage();
        if (usage != null) break;
      }
    }
    socket.emit('agent:event', {
      seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
      instanceId: payload?.instanceId ?? null,
      type: 'usage', payload: parseUsageForWeb(usage)
    });
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
    sessions.setCurrent(viewingCwd, null); // 空首页 compose → FRESH（与 session:new 同；列表进入仍 resume）
    // 已在首页也广播一帧：空首页 defaults / models 与 viewingCwd 对齐；前端 viewing 未变时自行 showDashboard 刷列表。
    broadcastInstances();
    pushModelsForCwd(viewingCwd);
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
    sessions.setCurrent(cwd, null); // 台阶3：清该 cwd 当前指针 → 下条消息懒开为 FRESH 会话（非 resume）
    viewingInstanceId = null;       // 清查看 tab（**不再 dispose 任何实例**——背景 tab 继续跑），首条消息懒开
    pendingModeByCwd.delete(cwd); pendingEffortByCwd.delete(cwd); // 重置 L0（防上次未发的残留被误消费）
    broadcastInstances(); // 先推一帧（可能仍是 L4 或旧 L3 缓存）；下方 force 刷新 L3 后再补广播
    pushModelsForCwd(cwd); // 有缓存即时推（快速路径），无缓存由下方 scout 补发
    if (!viewingInstanceId) openScoutInstance(cwd); // 无实例：scout 获取真实模型（不留幽灵会话）
    // L3：强制重读 CLI settings，空首页 defaultPermissionMode/defaultEffort 与终端对齐；完成后若仍停在本 cwd 空视图则补广播
    ensureCliDefaults(cwd, { force: true }).then(() => {
      if (viewingCwdOf() === cwd && !viewingInstanceId) broadcastInstances();
    }).catch(err => console.warn('[cli-settings] session:new 刷新失败:', err?.message || err));
    lastStatusLine = null;
    scheduleStatusRefresh();
    if (typeof ack === 'function') ack({ ok: true, instanceId: null, sessionId: null });
  });

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
    // 台阶3：打开或聚焦——已 live 实例承载该会话则聚焦不重开（去重，防同会话被两实例并发 resume）；
    // 否则 open 新实例 resume（openResumeInstance 先读 transcript 恢复权限档）。**不再 dispose 同 cwd**（其他 tab 后台继续）。
    const inst = instanceForSession(sessionId) || await dedupedResume(cwd, sessionId);
    viewingInstanceId = inst.instanceId;
    viewingCwd = cwd;
    sessions.setCurrent(cwd, sessionId); // 记为该 cwd 最后查看会话（session:list 的 currentSessionId 等）
    doneInstances.delete(inst.instanceId); errorInstances.delete(inst.instanceId); abortedInstances.delete(inst.instanceId);
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
    ack({ currentSessionId, sessions: list, hasMore: all ? false : hasMore });
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
    // 保护①：无活跃 web driver——该会话正被本产品的 canUseTool/turn 驱动中，此刻删文件必与写盘竞态。
    if (instanceForSession(sessionId)) {
      return ack({ ok: false, error: '会话正在被本产品驱动，请先结束或关闭该会话再删除' });
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
    audit.recordAudit({ actor: actorFromSocket(socket), action: 'session_delete_l2', target: sessionId, outcome: 'success', meta: { cwd } });
    ack({ ok: true });
  });

  registerFileSocketHandlers({
    socket,
    on,
    routeCwd,
    getWorkDirs: () => workDirs,
    listDir,
    browseReadFile,
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
      configPermsProblems: countConfigPermProblems(HERE), // BE-013：实际检查配置文件权限（number/null），不再缺省当 0 假绿
    }));
  });

  // 「刷新消息」（前端按钮文案）：mirror 横幅的确定性追平入口——强制触发一次 catchUpTick（正常 2.5s 自动跑，
  // 这里给「我要确定是最新的」一个即时按钮）。无 payload、无 ack：结果经既有 history_append/mirror_state 广播。
  on(socket, 'mirror:syncNow', () => { catchUpTick().catch(() => {}); });

  on(socket, 'sync:since', async (payload, ack) => {
    const { sessionId, lastSeq, instanceId } = payload || {};
    // ack {replayed, gap, found, diskLen}：replayed=0 表示该实例无可回放的缓冲（如刚 open 尚未跑/重启后空），
    // 客户端据此回落到 session:history 回显，避免整页刷新后空屏。found=false 专指「实例已没了」
    // （dispose/重启/effort 切档换 instanceId）——与「实例还在、只是没新事件」的 replayed=0 区分开，
    // 让重连客户端能据此清屏重载历史（connect 路径不像 bindView 那样先 clearView，无法靠 replayed 自辨）。
    // diskLen=磁盘 transcript 的 history 条数（仅 replayed=0 时读、带回）：供前端切入对账「离开期间被终端外部
    // 写入」的盲区——磁盘比前端已渲染长即清屏全量重载（见 logic.js shouldReloadOnEnter）。
    const done = (replayed, gap, found = true, pending = null, diskLen = null) => {
      if (typeof ack === 'function') ack({ replayed, gap: Boolean(gap), found: Boolean(found), pending, diskLen });
    };
    const a = routeInstance(instanceId); // 台阶3：续传指定 tab 实例的缓冲（缺省 viewingInstanceId）
    if (!a || a.sessionId !== sessionId) { metrics.inc('catch_up_reloads'); return done(0, false, false); } // 无匹配实例：客户端清屏重载历史（NFR-15 重载：仅计后端能确证的触发；前端因 diskLen 盲区的重载后端不可观测、不计）；亦会在下个 live 事件凭 epoch 自愈
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
    // 仅 replayed=0（活缓冲无可回放对话内容）时读磁盘 history 条数带回——正是「切入可能被外部写过的会话」候选；
    // replayed>0=web 活跃、信活缓冲、不必对账磁盘。getSessionHistory 有 mtime 缓存，成本可忽略。
    let diskLen = null;
    if (replayed === 0) {
      try { diskLen = (await getSessionHistory(a.sessionId, a.cwd)).length; } catch { diskLen = null; }
    }
    // 状态对账：随 ack 带回该实例当前未决审批/提问快照。pendingPermissions/pendingQuestions 是权威真相，
    // 原始 permission_request/question 事件可能已被环形缓冲 trim 或切视图时被前端分流丢弃——前端在视图稳定后
    // （所有 clearView 之后，尤其 gap→重载路径）据此重建卡片，杜绝「角标 ⚠️ 待审批但会话内无卡片」。
    done(replayed, gap, true, a.pendingRequestsSnapshot(), diskLen);
    // 切入/切回后 clearView 会先把 statusline 藏掉；setViewing/switch 的 300ms 防抖刷新可能已在 clearView
    // 之前发出并被清空。此处在 sync 完成后再强制重发一次（清 lastStatusLine 防 key 去重把「已发过但被 clearView 擦掉」的那次吞掉），
    // 保证冷路径/缓存路径都有 statusline 上屏，不依赖下一次 tool 事件。
    if (a.instanceId === viewingInstanceId) {
      lastStatusLine = null;
      scheduleStatusRefresh();
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
      return ack({ logs: [] });
    }
    // FRESH 首轮 sessionId 未到：读 provisional 缓冲；init rebind 后读真 sessionId
    const logs = interactionLog.getSessionLogs(a.logKey());
    ack({ logs });
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

// 重启 fail-closed 处置遗留 pending 审批（必须在 listen 之前：这之后 io 才可能接受连接、驱动新实例）
// + NFR-16 留存治理（启动即清一次 + 每 24h）。实现下沉 src/agent/approval-lifecycle.js。
expireOrphanedPending();
startApprovalRetentionSweep();

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

// 导出供集成测试使用
export { httpServer, io, port };
