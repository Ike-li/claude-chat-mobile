// agent.js —— claude 会话桥：
// 每个会话 = 一个长驻 SDK query（streaming input 模式，interrupt/canUseTool 可用），
// SDK 消息 → agent:event 统一信封，seq 单调 + 环形缓冲。
import { query } from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'node:crypto';
import * as interactionLog from './interaction-log.js';
import * as diagLog from './diag-log.js';
import { sanitize } from '../shared/sanitizer.js';
import { sdkChildEnv } from '../shared/child-env.js';
import { truncate, stringify, redactBase64, TOOL_SUMMARY_CAP } from '../shared/tool-summary.js';
import { AGENT_EVENT_TYPES } from '../shared/protocol.js';
import { fingerprintSync, verifyIntegritySync } from '../auth/fingerprint.js';
import * as approvalStore from './approval-store.js';
import { formatSessionLockError } from '../ops/cli-bg-session-lock.js';
import { normalizePermissionMode } from './cli-settings-defaults.js';

// 出向 type 自检：契约（src/shared/protocol.js）此前只被 npm run check 的门禁脚本消费，运行时看不见它，
// 漏登记的 type 会一路发到前端再被 handle 表静默丢弃。这里【只记录不拦截】——门禁负责挡提交，运行时
// 只负责让问题在日志里可见；拦截等于让一个登记疏漏直接吃掉用户的一条消息，代价不对等。
// 覆盖面仅限经 AgentSession 发出的 17 型；device_status/instances/mirror_state 等 9 型走 src/server/*
// 与 src/auth/device-gate.js 的服务端广播路径，不经过本类，仍只由门禁静态扫描把关。
const KNOWN_EVENT_TYPES = new Set(AGENT_EVENT_TYPES);
function assertKnownEventType(type) {
  if (KNOWN_EVENT_TYPES.has(type)) return;
  console.error(`[event-contract] 未登记的 agent:event type「${type}」：仍照常发出，但前端多半没有对应 handler；请补进 src/shared/protocol.js`);
}

const BUFFER_CAP = 2000;      // 环形缓冲条数（抬高：长 ultracode/多工具轮少 gap 闪屏；transient 仍不进 buffer）
// 额度类型标签：语义逐条对齐 CLI bundle 的同源映射表（five_hour="session limit" 等），
// 保终端等价性；未知枚举回落「用量」而非把裸枚举名甩给用户。
const RATE_LIMIT_LABELS = Object.freeze({
  five_hour: '会话额度',
  seven_day: '周额度',
  seven_day_opus: 'Opus 周额度',
  seven_day_sonnet: 'Sonnet 周额度',
  seven_day_overage_included: 'Fable 5 额度',
  overage: '用量信用额度',
});
const TOOL_SUMMARY_CAP_BASH = 2000; // Bash/命令类输出用户常要多看几行
// ③：文件类工具——tool_use 额外缓存完整 input（供预览无损重建 diff）+ emit 未截断 path（供前端给预览入口）。
const FILE_TOOLS = new Set(['Edit', 'Write', 'Read', 'MultiEdit', 'NotebookEdit']);
const TOOL_INPUT_TTL_MS = 10 * 60 * 1000; // 缓存 input 存活 10 分钟
// _raceControlRequest 的 tag → 诊断时间线 subsystem 归类：interrupt/stop_task 属于"停止"，
// set_model/set_permission_mode 走同一条通道但不属于停止，归入诚实的第三档 control，
// 不强行塞进"停止"致使语义失真。
const CONTROL_TAG_SUBSYSTEM = {
  interrupt: 'interrupt',
  stop_task: 'interrupt',
  set_model: 'control',
  set_permission_mode: 'control',
};

// fetchUsage 节流窗。SDK get_usage 不是"读一个内存里的百分比"：CLI 2.1.220 实测，它在 CLI 侧
// = 一次真实网络请求 + 一次全量 transcript 扫盘（includeBehaviors 默认 true，SDK 侧无参数可传），
// 而我们只用其中的 rate_limits 百分比与 session.lines。CLI 自己的 statusline 走的是另一条路：
// 从 API 响应头 anthropic-ratelimit-unified-* 解析进内存后同步读，成本为零。
// 既然拿不到便宜那条，就把昂贵这条的频率压到与数据变化率匹配——5h/7d 窗口按分钟变化，
// 而 statusline 每 10s 兜底轮询 + 每个 assistant usage 边界都会拉起它。
// 代价：同一次 RPC 带回的 session.lines(+A/−R) 一并滞后 ≤60s（会话累计计数器，只在展开面板可见）。
export const USAGE_MIN_INTERVAL_MS = 60_000;

// 第三方鉴权（API Key / Bedrock / Vertex / 代理网关）档：那边根本没有 claude 订阅额度可显示，
// 常规频率纯属白问。判据用 CLI 自己的权威自报 rate_limits_available:false——不猜
// ANTHROPIC_BASE_URL（既盖不住 Bedrock/Vertex，也可能指向仍走 OAuth 的官方代理）。
// 不硬熔断到零的两个理由：同一次 RPC 还带回 session.lines(+A/−B)，且鉴权换回订阅时要能
// 自动感知、不必等 agent 实例重建（切工作区/切 effort/resume/server 重启才会重建）。
export const USAGE_THIRD_PARTY_INTERVAL_MS = 10 * 60 * 1000;

// 会话生命周期用户可见文案（可恢复类 error）。统一前缀，避免「会话已结束」歧义：
// 磁盘会话通常还在，掐掉的是子进程 / 在途轮。前端 error bar 原样展示。
export function formatLifecycleIdleTimeout(mins) {
  const n = Math.max(1, Number(mins) || 1);
  // 判定口径：consume() 任意 SDK 消息（含 thinking_tokens）都会刷 lastActivity；
  // 触发 = 在途轮期间连续 N 分钟「零消息」——不是「模型想得久」，是「进程无任何输出」。
  return `任务已中断：超过 ${n} 分钟未收到 Claude 的任何消息（含思考/工具进度），已按挂死中断（可重新发送继续）`;
}
export function formatLifecycleIdleReclaim(mins) {
  const n = Math.max(1, Number(mins) || 1);
  return `进程已回收：会话空闲超过 ${n} 分钟（再发送或切换回来会自动续接）`;
}
// 模型静默早期告警（2026-07-28 真机 b06fb05d 前情：第三方网关零响应，用户等到 idleTimeoutMs 中断前
// 全程零反馈）。只告警不中断——本轮继续等，给用户「停止重发/换模型」的主动权。
// 归因收敛（2026-07-30 排查 0f82d2e7）：旧文案断言「多为第三方网关限流/挂起」，而真机 6 次触发全是
// 本地前台工具在跑（那批误报已由 hasRunningForegroundTool 豁免修掉）。看门狗只知道「没收到消息」、
// 不知道为什么——文案只陈述观测事实与可操作项，不替它猜因。
export function formatLifecycleGatewayStall(seconds, timeoutMins) {
  const s = Math.max(1, Math.round(Number(seconds) || 1));
  const m = Math.max(1, Number(timeoutMins) || 1);
  return `模型已 ${s} 秒无响应（本轮继续等待，${m} 分钟仍零消息将自动中断）——可点「停止」后重发，或换模型再试`;
}
export function formatLifecycleProcessExited() {
  return '进程已退出：可重新发送消息继续（会话历史仍在）';
}
export function formatLifecycleSessionError(detail) {
  const d = detail != null ? String(detail).trim() : '';
  return d ? `进程异常：${d}` : '进程异常：未知错误（可重新发送继续）';
}

// resolvedEnv 白名单：只放行网关/模型相关变量，防 worktree settings 覆盖 PORT/AUTH_TOKEN/CCM_DATA_DIR 等服务端关键变量。
function filterSafeResolvedEnv(env) {
  if (!env || typeof env !== 'object') return undefined;
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (k.startsWith('ANTHROPIC_') || k.startsWith('CLAUDE_CODE_')) out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

// SDK query options 纯函数（可单测）：集中「与 CLI 对齐的桥接开关」，避免 start() 内联大对象难测。
// agentProgressSummaries：默认开——子 agent ~30s AI 进度写 task_progress.summary，刷新 lastSeenAt + 横幅文案；
// 关：CCM_AGENT_PROGRESS_SUMMARIES=0（省 fork token；静默期只靠 tool description 变化）。
export function buildAgentQueryOptions(session, env = process.env) {
  const progressOn = env.CCM_AGENT_PROGRESS_SUMMARIES !== '0';
  // flag settings 两个来源，二者形式不同（2026-07-30 实证）：
  //  · worktree 网关隔离的 env → 只能走 flag settings（往 options.env 注入压不过 CLI 自己的
  //    settings.env），但**必须用文件路径形式**：对象形式会被 SDK 序列化成 `--settings <json>`
  //    拼进子进程 argv，worktree 自配的 ANTHROPIC_AUTH_TOKEN 会在 ps 输出里明文可见。
  //    该文件由 server worktreeSettingsFileFor 落成 0600，且已把 ultracode 一并写入。
  //  · ultracode 会话 flag → 不含机密，无 worktree 文件时按老样子内联对象下发。
  const flagSettings = {};
  if (session.ultracode) flagSettings.ultracode = true;
  const settings = session.worktreeSettingsPath
    || (Object.keys(flagSettings).length ? flagSettings : undefined);
  return {
    cwd: session.cwd,
    pathToClaudeCodeExecutable: session.claudeBin, // E9：用本机 claude，不用 SDK 捆绑副本
    model: session.activeModel || undefined,
    resume: session.sessionId || undefined,
    abortController: session.abort,
    includePartialMessages: true,                        // E4 流式
    forwardSubagentText: true,                           // 子 agent 正文/thinking 转发进主流（带 parent_tool_use_id）
    agentProgressSummaries: progressOn,                  // ~30s AI 进度 → task_progress.summary（默认开）
    effort: session.effort || undefined,                 // SDK 0.3+ 一等 Options.effort；null=模型默认不传
    // flag settings 叠加，不替代 user/project/local（与 CLI /effort ultracode 同语义）；两者皆无则整个不传
    ...(settings ? { settings } : {}),
    permissionMode: session.sdkPermissionMode(),         // bypass 映射为 SDK default
    // 不注入 options.allowedTools：放行白名单完全交给 settingSources 的 permissions.allow
    canUseTool: (name, input, opts) => session.handleCanUseTool(name, input, opts),
    settingSources: ['user', 'project', 'local'],
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    env: { ...sdkChildEnv(env), ...filterSafeResolvedEnv(session.resolvedEnv) },
    stderr: data => { if (env.LOG_STDERR) console.error('[claude]', sanitize(data)); },
  };
}
const TOOL_INPUT_MAX = 40;                // LRU 上限，防内存涨
const TOOL_CHANGE_KIND = { Edit: 'edit', Write: 'write', Read: 'read', MultiEdit: 'multiedit', NotebookEdit: 'notebook' };
const toolFilePath = (input) => input?.file_path ?? input?.notebook_path ?? null;
// AskUserQuestion 选项归一：字符串 → {label}；对象保留 description/preview（对齐 CLI 自动 Other 之外的完整呈现）
function normalizeQuestionOption(o) {
  if (typeof o === 'string') return { label: o };
  if (!o || typeof o !== 'object') return { label: String(o ?? '') };
  const out = { label: o.label != null ? String(o.label) : '' };
  if (o.description != null && String(o.description)) out.description = String(o.description);
  if (o.preview != null && String(o.preview)) out.preview = String(o.preview);
  return out;
}
const AUTO_TURN_ARM_TTL_MS = 120000; // 后台任务通知武装 pendingAutoTurn 的有效期（2min）：宽于任何真实自动汇报延迟、
                                     // 窄于长尾——超时不合成，防滞留 flag 被无关的 message_start（如 auto-compact fork）误触发。
// 后台任务 TTL 分两档（按 key 是否为真实 SDK task_id，而非 taskType）：
// · 合成键 __notask_*（progress 缺 task_id）→ 短 TTL：无完成通道可对账，3min 无刷新即清孤儿。
// · 真实 task_id（bash/agent/workflow）→ 长兜底 2h：完成权威是 background_tasks_changed（CLI 文档：
//   membership 变化才发的 level signal）+ task_notification。task_progress 本身非 membership 心跳；
//   默认另开 agentProgressSummaries（~30s AI summary）刷新 lastSeenAt。2h 仅防漏完成信号时 ⏳ 永挂。
const BG_TASK_ORPHAN_TTL_MS = 180000;           // 合成键孤儿 3min
const BG_TASK_LIFECYCLE_TTL_MS = 2 * 60 * 60 * 1000; // 真实 task_id 2h 兜底
const DEFAULT_APPROVAL_TTL_MS = 1800000; // 审批悬置默认上限 30min（部署可配置，见 server.js APPROVAL_TTL_MS；
                                          // docs/design.md/OQ-05 已决：不预置具体数值，此为实现落地的合理默认）
const GATEWAY_STALL_WARN_MS = 90_000;     // 在途轮静默早期告警线（只提示不中断，见 formatLifecycleGatewayStall）：
                                          // 宽于正常首 token 延迟 + 30s checkIdle tick 粒度，远窄于 idleTimeoutMs 中断阈
// 前台工具在途豁免上限（2026-07-30 排查真机会话 0f82d2e7）：tool_use 发出到 tool_result 回来之间 SDK 流
// 零消息，lastActivity 冻结——跑 E2E/测试套的前台 Bash 因此被误告「模型无响应」（该会话一小时内 6 次，
// 最长 602s；同期等模型方向的空档一次都没到 60s）。更险的是前台 Bash 硬超时 600s ≈ idleTimeoutMs 600s，
// 30s tick 相位一偏就会 interrupt 掉一个本来好好的轮次。
// 上限而非无限豁免：工具真挂死（进程僵死、tool_result 永不回）时看护必须能接回来。15min 宽于 CLI 侧
// Bash 600s 硬超时的最坏情况（含转后台收尾），窄到不会让挂死会话空转太久。
const FOREGROUND_TOOL_GRACE_MS = 15 * 60 * 1000;


// epoch：每个 AgentSession 实例一个跨重启唯一标识。基于 wall-clock + 进程内计数，
// 保证服务重启后新实例的 epoch 严格大于旧实例 → 客户端据此区分"新流"并重置 seq 去重基线。
let instanceCounter = 0;
function nextEpoch() {
  return `${Date.now()}.${++instanceCounter}`;
}

// 模型展示名「原样透传」（机主 2026-06-15 决定）：不再维护项目自己的友好名映射表——
// web 端 select 直接显示 SDK supportedModels() 返回的 displayName/value、init.model 用裸名。
// 理由：手维护的映射会跑偏（曾把裸 claude-opus-4-8 误标「(1M context)」与真 [1m] 变体撞车成双 Opus）；
// 模型「值」本就经 settingSources 与终端 /model 同步，显示层不应再叠加项目默认。终端友好名不再复刻。

// message_delta 常只带 output_tokens；整对象覆盖会抹掉 input/cache → statusline uncached 0。
// 白名单合并：只写入下一帧里出现的非负有限数字段，保留 prev 其余字段。
const MESSAGE_USAGE_KEYS = Object.freeze([
  'input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens',
]);
export function mergeMessageUsage(prev, next) {
  if (!next || typeof next !== 'object') return prev && typeof prev === 'object' ? { ...prev } : null;
  const out = prev && typeof prev === 'object' ? { ...prev } : {};
  for (const k of MESSAGE_USAGE_KEYS) {
    if (Number.isFinite(next[k]) && next[k] >= 0) out[k] = next[k];
  }
  return out;
}

export class AgentSession {
  constructor({ instanceId, resumeId, cwd, claudeBin, model, permissionMode, effort, ultracode = false, idleTimeoutMs, instanceIdleReclaimMs, approvalTtlMs, onEvent, onSessionId, onExit, onUsage, onBgTaskChange, onStateSettled, historicalCostUsd, resolvedEnv, worktreeSettingsPath }) {
    // 台阶3：进程内唯一、永不变的实例句柄。前端按 viewingInstanceId 分流（新会话 init 前
    // sessionId=null，故分流/路由用 instanceId 而非 sessionId）。server 生成并传入（inst_${n}）。
    this.instanceId = instanceId;
    this.cwd = cwd;
    this.claudeBin = claudeBin;
    this.idleTimeoutMs = idleTimeoutMs;
    // 完全空闲（!isBusy）超过此阈值则回收子进程；0/负数 = 禁用。与 idleTimeoutMs（在途轮静默挂死）正交。
    this.instanceIdleReclaimMs = Number(instanceIdleReclaimMs) > 0 ? Number(instanceIdleReclaimMs) : 0;
    this.approvalTtlMs = Number(approvalTtlMs) > 0 ? Number(approvalTtlMs) : DEFAULT_APPROVAL_TTL_MS; // 审批悬置上限（部署可配置）
    this.onEvent = onEvent;           // (envelope) => void，由 server 广播
    this.onSessionId = onSessionId;   // (sessionId, firstMessage, model) => void，登记 sessions.json
    this.onExit = onExit;             // () => void，进程意外退出/挂死自杀时通知 server 置空
    this.onUsage = onUsage;           // () => void，assistant message（含工具调用间）更新 usage 后触发——驱动 statusline 实时刷 ctx；不进事件流、不占 seq/buffer
    this.onBgTaskChange = onBgTaskChange; // () => void，活的后台任务集合"空↔非空/成员增删"时触发——驱动 server 节流重算会话列表 ⏳ 角标
    this.onStateSettled = onStateSettled || (() => {}); // () => void，账面被兜底路径就地改写（无伴随事件流）时触发——驱动 server 立刻重播 instances，否则前端只能等下一次无关广播
    // worktree 的 settings.local.json env 块（SDK resolveSettings 按 cwd 正确读出，CLI 自己读不到）。
    // 注意边界（2026-07-30 实证更正）：注入子进程环境**管不住网关**——CLI 的 settings.env 优先级高于
    // 继承环境，它从 canonical repo root 误读到的 ANTHROPIC_BASE_URL 等会盖掉这里注入的同名值。
    // 网关/模型映射的隔离改走 worktreeSettingsPath（flag settings 文件），见 buildAgentQueryOptions。
    this.resolvedEnv = resolvedEnv || undefined;
    // worktree 网关隔离的 flag settings **文件路径**（0600，由 server worktreeSettingsFileFor 落盘）。
    // 内含中和后的 env（canonical 独有的网关键置空串，worktree 自配的照常生效）+ ultracode。
    // 走文件而非内联对象，是因为对象形式会被 SDK 拼进子进程 argv、令自配凭据在 ps 里明文可见。
    this.worktreeSettingsPath = worktreeSettingsPath || undefined;

    this.sessionId = resumeId || null;
    this.resumeId = resumeId || null;   // F4：resume 失败检测基准
    this.sawInit = false;               // F4：init 事件到达置 true；未到即结束 → resume 失败
    this.resumeFailed = false;          // F4：onExit 时通知 server 清当前会话，打破死循环
    this.epoch = nextEpoch();
    this.seq = 0;
    // 真环形：固定 cap + head 下标，驱逐 O(1)。this.buffer 是惰性物化的线性视图（eventsSince /
    // 单测读 buffer[0]/length）；emit 热路径只写环、不 shift、不每条复制。
    this._ring = new Array(BUFFER_CAP);
    this._ringHead = 0;
    this._ringLen = 0;
    this._bufferView = []; // 惰性缓存；_ringPush 置脏为 null
    this.toolInputs = new Map(); // ③：toolUseId → {name, input, ts}（文件类工具完整 input，供 tool:preview 重建 diff）
    this.toolOutputs = new Map(); // 工具完整 output（截断前），供 tool:full 展开；TTL/LRU 与 toolInputs 同口径
    this.toolNames = new Map();   // toolUseId → name（tool_result 选 cap 用，短命）
    this.bufferTrimmed = false;
    this.pendingTurns = 0;             // 在途轮数，仅由 send(+1) 与 result(-1) 改写
    this.pendingAutoTurn = false;      // 后台任务通知已到、下个轮次由非用户输入（task-notification 注入）启动的信号——
                                       // 轮次真正开始（message_start/assistant）时合成 pendingTurns=1，让 busy/看护/角标接回。
                                       // 只武装 flag 不直接 ++：N 条通知未必对应 N 轮（合并轮会卡死 busy → checkIdle 误杀）。
    this.pendingAutoTurnAt = 0;        // flag 武装时刻（Date.now）：合成前校验未超 AUTO_TURN_ARM_TTL_MS，防滞留 flag 长尾误触发。
    this.pendingToolUses = new Map();   // toolUseId → startedAt：主会话在途前台工具（tool_use 发出、tool_result 未回）。
                                       // 静默看护据此豁免——工具在跑就是本轮在推进，只是 SDK 流此刻无消息。
                                       // 只记主会话：子 agent 内部工具由父 Task 的 tool_use 代表（见 map 子分支）。
    this.stallWarnedForActivity = 0;   // 网关挂起告警去重锚：告警时记当时的 lastActivity——同段静默不重复告，
                                       // 有新消息（lastActivity 前移）后的新静默段可再告。不动 lastActivity 本身（那会推迟真中断）。
    this._awaitingInterruptResult = false; // P1-4：interrupt() 成功后置真，标记"下一条 result 是这次中断的终态确认"
                                            // ——一次性消费。不能靠嗅探 SDK 的 result.subtype（如 'error_during_execution'）
                                            // 反推"是不是用户中断"：该 subtype 是"执行过程中出错"的泛化分类，与
                                            // error_max_turns/error_max_budget_usd 同级，也可能是真实的独立异常。
    // 在途轮 settle 槽（FIFO）。send/auto-turn 开槽；result 出槽。interrupt force-settle 把槽标 forceSettled，
    // 迟到 result 只消耗 force 槽、不得再 --pendingTurns（否则 watchdog 清账后又发新轮会被迟到 result 误扣成假 idle）。
    // 单测若只改 pendingTurns 不入槽，result 走「无槽」回落仍 --pendingTurns，保持旧测试语义。
    this._openTurns = [];
    this._turnIdSeq = 0;
    // await q.interrupt() 安全超时（ms）。限流重试时 control_request 可能挂起；超时后强制 abort 收口。
    // 可在单测里覆盖为更短值。0/负数 = 不超时（仅测试用）。
    this.interruptTimeoutMs = typeof this.interruptTimeoutMs === 'number' ? this.interruptTimeoutMs : 10_000;
    // interrupt() 成功后等待 SDK 配对 result 的宽限期（ms）。到期未等到即就地清账，见
    // _armInterruptSettleWatchdog。可在单测里覆盖为更短值。
    this.interruptSettleGraceMs = typeof this.interruptSettleGraceMs === 'number' ? this.interruptSettleGraceMs : 8_000;
    // force 槽的存活上限（ms）。force 槽是留给「迟到 result」的占位，但 watchdog 的触发前提恰恰是配对
    // result 永不到达——那种情况下槽会永久堵在队首、把此后每一轮真 result 都吸收掉，pendingTurns 再也回
    // 不到 0（恒 busy + 恒排队 + 发送禁用，且每次静默 interrupt 再造一个，自我复现）。给它一个宽于任何真实
    // SDK 迟到（秒级）、又远窄于用户可感知卡死的 TTL；过期即回收。可在单测里覆盖为更短值。
    this.forceSlotTtlMs = typeof this.forceSlotTtlMs === 'number' ? this.forceSlotTtlMs : 60_000;
    this._interruptSettleTimer = null;
    this.pendingPermissions = new Map(); // requestId → { resolve, suggestions, input }
    this.pendingQuestions = new Map();   // toolUseID → { resolve, questions, answers, remaining }
    this.denyKinds = new Map();          // toolUseID → 'answered'|'denied'|'cancelled'：deny+message 通道的真实语义，供前端区分 ☑️/🚫（is_error 不足以分辨）
    this.permSeq = 0;
    this.lastActivity = Date.now();
    this.currentMessageId = null;
    this.sawTextDelta = false;
    this.firstMessage = null;
    this.disposed = false;
    this.assistantResponseBuffer = '';
    this.terminating = false;
    // 最终退出确认：dispose/abort 后等待 consume 自然结束（SDK/CLI 子进程真正退出）才 resolve。
    // 生产 shutdown 用它等最终退出确认，避免 process.exit 时留下孤儿 CLI 子进程。
    this.exitPromise = new Promise(resolve => { this._exitResolve = resolve; });

    // F1：defaultModel = 启动时配置的模型（会话原模型，sessions.json 指针——唯一来源）。
    // 消息不带 model（"默认"）时 target 回退到它，而非 SDK 裸默认——否则空选择会把
    // 配置的网关模型 setModel(undefined) 重置掉（实测：init 从 mimo 变成 opus 并报错）。
    this.defaultModel = model || undefined;
    this.activeModel = model || undefined;   // 已确认生效的模型（仅 setModel 成功后推进）——UI/日志显示用
    // 最近一次已「尝试下发」的目标（成功或失败都记）——差分基准，与 activeModel 分离：
    // setModel 失败/超时时 activeModel 不动（不对前端谎报未生效的模型），但 attemptedModel 已推进，
    // 同一目标不再每轮重试。否则遇到 set_model 恒超时的第三方网关，每条消息都白等
    // interruptTimeoutMs(10s) 并重复弹错（真机 2026-07-30）。
    this.attemptedModel = model || undefined;
    // A5：init 报告的真实运行模型名，仅供交互日志/statusline 显示真实生效模型。
    // 绝不入 activeModel/attemptedModel：它只是「init 那一刻」的快照，用户切过模型后即 stale，
    // 拿它当差分依据会让「切走再切回」被误判为无变化而跳过 setModel（真切不回去）。
    this.reportedModel = null;
    // 当前权限档（default/plan/acceptEdits/bypassPermissions/dontAsk），可运行时切；差分决定是否调 setPermissionMode
    // dontAsk = 非交互严格档：白名单外终端层直接 deny、不走 canUseTool（手机不弹窗），sdkPermissionMode 原样透传（不映射）
    this.permissionMode = permissionMode || 'default';
    // 思考强度档（spawn 时注入 --effort），null=模型默认不传。运行时不可改——
    // SDK 无 effort 控制请求，切档由 server 置换实例（dispose + 下条消息懒重生 resume）
    // ultracode：CLI /effort 菜单最高档；SDK Options.effort 不认该字面量——正式路径是
    // Settings.ultracode + effort xhigh（会话级 flag，不落盘），禁止改写用户消息塞关键词。
    this.ultracode = Boolean(ultracode);
    this.effort = this.ultracode ? 'xhigh' : (effort || null);

    // E16 statusline 数据源（server 构造 status_line 时只读，不进事件契约）：
    this.lastUsage = null;        // 最近主线程 assistant 的 message.usage（ctx 占用口径：in/out/w/r）
    this.ctxWindowCache = null;   // {model, maxTokens}：本会话拿到过的上下文窗口【真值】(getContextUsage)，供 RPC 短暂不可用时垫底；带 model 指纹，模型一变即作废。绝不按模型名猜窗口，见 statusline.js readCachedCtxWindow
    this.lastRateUnavailableReason = null; // 额度(5h/7d)不可用原因去重锚点。【唯一写者 = ops/statusline.js】——判定要看快照回落后 p.rate 的最终值，本层看不到
    this.lastUsageFetchFailure = null;     // 最近一次 fetchUsage 失败的结构化原因 {reason,message,timedOut,ms}，供 statusline 判定；本身不写日志
    this.lastUsageOkMs = null;             // 最近一次 fetchUsage 成功耗时：get_usage 在 CLI 侧含网络请求+全量 transcript 扫盘，给"超时值是否太紧"留实测依据
    this._usageFetchAt = 0;                // 节流窗起点（见 USAGE_MIN_INTERVAL_MS）
    this._usageCached = null;              // 节流窗内复用的上次结果
    this._usageThirdParty = false;         // 上次 CLI 自报 rate_limits_available:false（无订阅额度）→ 降到 USAGE_THIRD_PARTY_INTERVAL_MS 档
    // per-turn 秒表/输出 token（CLI 式动态状态行 ✻ Verb… (Ns · ↓ tokens)，经 status_line.turn 透出）：
    this.turnStartedAt = null;    // 本轮开始时间戳（send/合成轮置位，result 无排队轮清 null）
    this.turnOutputTokens = 0;    // 本轮累计输出 token（跨 message 累加）
    this._msgOutBase = 0;         // 当前 message 已计入的 output_tokens 水位（message 内 usage 为累计值，取增量防重复计）
    this.historicalCostUsd = historicalCostUsd || 0; // 以前各次会话连接/恢复历史的累计成本
    this.totalCostUsd = 0;        // result.total_cost_usd 最新值（SDK 已是会话累计，勿 +=）
    this.totalDurationMs = 0;     // += result.duration_ms（活跃轮次累计，非墙钟——实例懒重生不暴露给用户）
    this.totalApiDurationMs = 0;  // += result.duration_api_ms
    this.lastToolName = null;     // 最后使用的工具名（Bash/Agent/Write 等），供后台 tab 角标细化
    this.bgTasks = new Map();     // 活的后台任务注册表 key → { taskType, message, lastSeenAt }——task_progress upsert / 完成 or TTL 清；驱动"纯后台运行中"⏳
    // 子 agent 类型缓存 parent_tool_use_id → subagent_type：probe 实证只有 assistant 消息带 subagent_type，
    // stream_event（text/thinking delta）与 user（tool_result）都不带。缓存供后二者补标签——否则纯文本子 agent
    // （无 tool_use、只走 stream_event）的卡片永远没有 🤖 类型名。换会话/dispose 清空，不跨会话/实例串标签。
    this.subagentTypeByParent = new Map();

    // SDK 输入泵（inputStream）的缓冲，不是"消息排队"：排队已于 2026-07-30 移除，在途轮期间
    // send() 直接拒收。SDK 泵是贪婪拉取（实证 2026-07-18 探针），send 后消息几乎立即被取走，
    // 故这里通常长度 ≤1，只在 send 完成到泵取走之间的窄窗内非空。
    this.queue = [];
    this.notifyInput = null;
    this.inputEnded = false;

    // B1：流式 delta 批量缓冲（20ms 时间窗 + 2048 字节阈值）
    this._textBuf = '';
    this._textTimer = null;
    this._thinkBuf = '';
    this._thinkTimer = null;
  }

  // ---- streaming input：用户消息队列 → AsyncIterable<SDKUserMessage> ----
  async *inputStream() {
    while (!this.inputEnded) {
      while (this.queue.length > 0) {
        const item = this.queue.shift();
        yield {
          type: 'user',
          message: { role: 'user', content: [{ type: 'text', text: item.text }] },
          parent_tool_use_id: null,
          session_id: this.sessionId || '',
          uuid: item.uuid // CLI 用它索引内部队列（实证 CLI 认自打 uuid）
          // 注：SDKUserMessage 上的 model 字段被 CLI 完全忽略（F1 根因）；模型切换走 q.setModel()
        };
      }
      if (this.inputEnded) break;
      await new Promise(resolve => { this.notifyInput = resolve; });
      this.notifyInput = null;
    }
  }

  start() {
    this.abort = new AbortController();
    const q = query({
      prompt: this.inputStream(),
      options: buildAgentQueryOptions(this),
    });
    this.q = q;
    this.idleTimer = setInterval(() => this.checkIdle(), 30_000);
    this.fetchModels(); // 提前拉取模型列表，不依赖 init 事件（CLI 首条消息前不输出 init）
    this.consume(q); // 后台消费，不阻塞调用方
  }

  // 拉取并广播可用模型列表。fire-and-forget：CLI 未启动完成时 supportedModels 可能不可用（静默跳过），
  // init 事件到达后会再调用一次兜底。原样透传 SDK 返回（不叠加项目友好名，2026-06-15）。
  fetchModels() {
    this.q?.supportedModels?.()
      ?.then?.(ms => {
        if (this.disposed) return;
        this.emit('models', { models: Array.isArray(ms) ? ms : [] });
      })
      ?.catch?.(() => {});
  }

  async consume(q) {
    let caught = null;
    try {
      for await (const msg of q) {
        if (this.disposed) break;
        this.lastActivity = Date.now();
        // 诊断 tap（DEBUG_SDK_MESSAGES=1 开启）：map 前打印原始消息骨架，
        // 用于排查"后台任务完成通知在 web 端丢失"——观察 SDK 到底投不投递、以什么 type/subtype/parent 投递。
        // 独立 try/catch：JSON.stringify 遇循环引用会抛，绝不让诊断插桩反噬主消息泵（否则被外层 catch 当流错误中断会话）。
        if (process.env.DEBUG_SDK_MESSAGES) {
          try {
            console.log('[sdk-msg]', msg.type, msg.subtype ?? '', msg.parent_tool_use_id ?? '-',
              JSON.stringify(msg).slice(0, 300));
          } catch { console.log('[sdk-msg]', msg.type, msg.subtype ?? '', msg.parent_tool_use_id ?? '-', '(unstringifiable)'); }
        }
        this.map(msg);
      }
    } catch (err) {
      caught = err; // 实测：resume 失败表现为 throw（"process exited with code 1"），需与正常结束统一处理
    }
    if (!this.disposed && !this.terminating) {
      if (!this.sawInit && this.resumeId) {
        // F4：resume 失败（CLI 未吐 init 即退出）——无论优雅结束还是抛错，均明确提示并设
        // resumeFailed 让 server 清 currentSessionId，打破"重试→resume 同一失效 id→循环"死锁。
        // sessionFileExists 已通过时「历史被清理」常误导：优先透传 CLI 真实原因（含 background agent 独占）。
        this.resumeFailed = true;
        const reason = caught?.message ? sanitize(String(caught.message)).slice(0, 200) : '';
        let message;
        if (/background agent/i.test(reason)) {
          // 只透传 stderr 原文，不硬塞 kind：这里唯一的证据就是那句报错，占用者的真实 kind
          // （注册表口径 'bg' / agents 口径 'background'）在此不可知，塞死会让文案说得比证据更满。
          message = formatSessionLockError({ rawMessage: reason });
        } else if (reason) {
          message = `无法恢复会话：${reason.slice(0, 120)}。请新建会话或从列表选择其他会话`;
        } else {
          message = '无法恢复会话（CLI 未完成初始化），请新建会话或从列表选择其他会话';
        }
        this.emit('error', {
          message,
          recoverable: false
        });
      } else if (caught) {
        this.emit('error', { message: formatLifecycleSessionError(sanitize(caught.message)), recoverable: true });
      } else {
        this.emit('error', { message: formatLifecycleProcessExited(), recoverable: true });
      }
    }
    // 清理（无论正常结束/抛错/resume 失败都执行；异常已被上方 catch 收口，不会跳过）
    clearInterval(this.idleTimer); this.idleTimer = null;
    this._clearInterruptSettleWatchdog(); // 实例已终，不留跨实例悬挂计时
    this.pendingTurns = 0;
    this._openTurns = [];
    this.queue = [];
    this.pendingAutoTurn = false; // 实例结束不留滞留 flag，防重开实例后残留状态误合成
    this._awaitingInterruptResult = false;
    this.bgTasks.clear();         // 实例结束清空活后台注册表，防残留误亮 ⏳
    for (const [id] of this.pendingPermissions) this.resolvePermission(id, 'deny');
    // F2：清理挂起的 AskUserQuestion（直接 resolve，不走 resolveQuestion 避免重复逻辑）
    for (const [toolUseID, pending] of this.pendingQuestions) {
      pending.signal?.removeEventListener('abort', pending.abortHandler);
      if (pending.expiryTimer) clearTimeout(pending.expiryTimer); // AG-001
      for (let i = 0; i < pending.questions.length; i++) {
        this.emit('request_resolved', { requestId: `${toolUseID}#${i}`, kind: 'question', outcome: 'aborted' });
      }
      pending.resolve({ behavior: 'deny', message: '问题已取消', interrupt: true });
    }
    this.pendingQuestions.clear();
    this.denyKinds.clear(); // 与 dispose 路径对称：无论哪种退出，denyKind 残留都应清理
    // AG-005：自然退出（CLI 进程结束）也要标 disposed/inputEnded——否则 onExit 删 Map 前的竞态窗口里
    // 陈旧引用仍可 send()，且与 dispose 路径不对称。
    if (!this.disposed) {
      this.disposed = true;
      this.inputEnded = true;
      this.onExit?.();
    }
  }

  // ---- 对外操作 ----
  // F1：model 变化时调 setModel()（SDKUserMessage.model 被 CLI 忽略，此为唯一有效切换路径）
  // E17：opts.displayText/attachments——附件场景下 text=注入路径后的 promptText（送 SDK），
  // displayText=原文（气泡 + 会话标题，不含路径），attachments=去完整 data 的元数据（含小 thumb）。
  // 排队已移除（2026-07-30）：一轮跑完才收下一条。三层各一道闸——前端提示 / 服务端拒绝 / 这里兜底。
  async send(text, model, opts = {}) {
    if (this.pendingTurns >= 1) {
      this.emit('system', { message: '当前任务运行中，请等待完成' });
      return false;
    }
    const displayText = opts.displayText ?? text;

    // 空选择（"默认"）回退到 defaultModel，不是 SDK 裸默认——只有真正切换才调 setModel。
    // F1：target 为空（FRESH 会话不 pin 模型 + 用户没选）时绝不下发——setModel(undefined) 会把
    // 网关模型重置成 CLI 裸默认（实测：init 从 mimo 变成 opus 并报错）。
    // 差分基准是 attemptedModel 而非 activeModel：失败/超时后同一目标不再每轮重试（见构造函数注释）。
    // setModel 是 await 让出点，之后须重检 disposed/pendingTurns（S3 + 双重检查）。
    const target = model || this.defaultModel;
    if (target !== undefined && target !== this.attemptedModel) {
      this.attemptedModel = target; // await 之前置位：并发 send 不重复下发，失败也不再重试
      try {
        await this._raceControlRequest(() => this.q?.setModel(target), 'set_model');
        this.activeModel = target;
      } catch (err) {
        // 区分两类失败：超时=CLI 侧可能已切也可能没切（诚实说"未确认"）；
        // 明确 reject（如 model not found）=确定没切，原模型继续。两者都不动 activeModel。
        const timedOut = /_timeout$/.test(String(err?.message || ''));
        this.emit('error', {
          message: timedOut
            ? `模型切换未确认（${err.message}），已继续发送`
            : `模型切换失败（${err.message}），已用原模型发送`,
          recoverable: true,
        });
      }
    }

    if (this.disposed) return false; // S3：setModel 的 await 间隙实例可能已被 dispose，勿再往弃用实例排队
    // 双重检查：setModel 是 await 让出点，间隙内其他 send 可能已经开了一轮
    if (this.pendingTurns >= 1) {
      this.emit('system', { message: '当前任务运行中，请等待完成' });
      return false;
    }

    // #2：确认能发送（过了 disposed + 双重检查）后才记 firstMessage、emit user_message 气泡、记日志——
    // 否则拒绝路径会把气泡推上屏却没真正发送（用户以为发了、实际被拒）。
    if (this.firstMessage === null) this.firstMessage = displayText;
    // FE-002：透传 clientMessageId，供前端离线乐观气泡精确对账（含纯附件无文本）。
    this.emit('user_message', {
      text: displayText,
      attachments: opts.attachments,
      ...(opts.clientMessageId ? { clientMessageId: opts.clientMessageId } : {}),
    }); // F3 + E17：入缓冲并广播，多设备/重载后均可回放
    // 日志模型/effort/perm 走统一 logMeta()（消除 send vs result 的模型解析漂移，见 logMeta 注释）。
    // 日志键走 logKey()：FRESH 首轮 sessionId 未到时用 provisional，init 后 rebind，避免首跳蒸发。
    const { model: metaModel, effort: effortStr, permissionMode: permStr } = this.logMeta();
    interactionLog.userMessageOut(this.logKey(), displayText, metaModel, effortStr, permStr); // 交互日志：server → client（user_message 广播）
    this._openTurnSlot();
    this.pendingTurns++;
    if (this.pendingTurns === 1) { this.turnStartedAt = Date.now(); this.turnOutputTokens = 0; this._msgOutBase = 0; } // 本轮开表
    // model/effort/permission 各走独立 chip 字段（text 不再内联），日志逐条显示「那一刻」的具体模型 + 档位
    interactionLog.agentSend(this.logKey(), text, metaModel, effortStr, permStr); // 交互日志：agent → SDK（text=promptText 含路径）
    // uuid 随消息透传 CLI（SDKUserMessage.uuid），CLI 以它索引内部队列
    const msgUuid = randomUUID();
    this.queue.push({ text, clientMessageId: opts.clientMessageId || null, uuid: msgUuid, displayText });
    this.notifyInput?.();
    this.lastActivity = Date.now(); // 续期静默看护：send 是用户活动，防 idle 误判
    return true;
  }

  // 与 SDK 的 control_request 通道共享同一条底层连接：限流重试期间任何一个 control_request（不只
  // interrupt）都可能永不回包。本方法给 promiseFactory() 产生的调用套一层超时，超时后 reject
  // Error(`${tag}_timeout`)，交给调用方既有的 try/catch 当成一次普通的 SDK 失败处理——不新增分支，
  // 只是把「永远不 settle」转成「有限时间内必定 settle（成功或超时失败）」。
  async _raceControlRequest(promiseFactory, tag) {
    const p = promiseFactory?.();
    if (!p || typeof p.then !== 'function') return p; // 非 promise 的退化路径：不记录
    const ms = Number(this.interruptTimeoutMs);
    if (!(ms > 0)) return p; // 测试用的"禁用超时"路径：不记录，避免污染大量既有用例
    const startedAt = Date.now();
    let timer = null;
    try {
      const result = await Promise.race([
        p,
        new Promise((_, rej) => {
          timer = setTimeout(() => rej(new Error(`${tag}_timeout`)), ms);
        }),
      ]);
      diagLog.record(this.logKey(), CONTROL_TAG_SUBSYSTEM[tag] || 'control', 'race_settle',
        { tag, ok: true, ms: Date.now() - startedAt });
      return result;
    } catch (err) {
      diagLog.record(this.logKey(), CONTROL_TAG_SUBSYSTEM[tag] || 'control', 'race_settle', {
        tag, ok: false, ms: Date.now() - startedAt,
        error: sanitize(String(err?.message || err)).slice(0, 200),
      });
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // 在途轮 settle 槽：与 pendingTurns 配平。forceSettled 槽吸收「已 force 清账后迟到的 result」。
  _openTurnSlot() {
    const id = ++this._turnIdSeq;
    this._openTurns.push({ id, forceSettled: false });
    return id;
  }

  _forceSettleOpenTurns() {
    const at = Date.now();
    for (const t of this._openTurns) { t.forceSettled = true; t.forceSettledAt = at; }
  }

  // 取消/丢弃不会产生 result 的在途槽（从队尾摘非 force 槽，对齐排队条后进先消）。
  _dropOpenTurnSlots(n) {
    let left = Math.max(0, n | 0);
    for (let i = this._openTurns.length - 1; i >= 0 && left > 0; i--) {
      if (!this._openTurns[i].forceSettled) {
        this._openTurns.splice(i, 1);
        left--;
      }
    }
  }

  // result 到达时结算一槽。返回 { applied, forceSettled }：applied=true 表示本次对 pendingTurns 做了 --。
  _settleOneResultTurn() {
    // 回收过期 force 槽：它只是「等一个可能到来的迟到 result」的占位，而 watchdog 的触发前提就是那个
    // result 永不到达。超过 TTL 仍没被消耗 = 它不会再来了，此时必须让位，否则真 result 全被它吸收成
    // applied:false，pendingTurns 永挂（回归见 agent-control「迟到 result 永不到达」）。
    const now = Date.now();
    while (this._openTurns.length
        && this._openTurns[0].forceSettled
        && this._openTurns[0].forceSettledAt != null
        && now - this._openTurns[0].forceSettledAt > this.forceSlotTtlMs) {
      this._openTurns.shift();
    }
    const t = this._openTurns.shift();
    if (!t) {
      // 无槽（旧单测只改 pendingTurns / SDK 多吐 result）：回落旧语义，防负值
      this.pendingTurns = Math.max(0, this.pendingTurns - 1);
      return { applied: true, forceSettled: false };
    }
    if (t.forceSettled) {
      // 已 force 清账：迟到 result 只出槽，绝不再 --（防新轮假 idle）
      return { applied: false, forceSettled: true };
    }
    this.pendingTurns = Math.max(0, this.pendingTurns - 1);
    return { applied: true, forceSettled: false };
  }

  // interrupt() 成功 ≠ SDK 侧真有在途轮。账面 pendingTurns 与 SDK 实际状态脱节时（2026-07-26 现场：
  // web 发 /clear 后账面卡在 1、SDK 那轮 10 分钟前就结束了），q.interrupt() 照样 resolve，却永不产生
  // 配对 result → pendingTurns 永挂、前端 busy 反复被 instances 广播拉回，实际无解：idleTimeoutMs
  // (10min) 是唯一兜底，而用户每次切进该 tab 都会刷新 lastActivity 给它续命。
  // 这里给成功路径补一层：宽限期内 result 没来就地清账。与 settleForce 的关键区别是【不 abort 子进程】
  // ——SDK 本就空闲，杀进程会把一个可用会话变成「会话已中断」，代价远大于收益；也不重发 interrupted
  // （成功路径已发过一次），只补一次广播让 server 把 idle 态推给前端。
  // force 清账时把 openTurns 标 forceSettled，迟到 result 只消耗 force 槽，不会误扣 force 之后新发的轮。
  _armInterruptSettleWatchdog() {
    this._clearInterruptSettleWatchdog();
    const ms = Number(this.interruptSettleGraceMs);
    if (!(ms > 0)) return; // 0/负数 = 禁用（测试用）
    this._interruptSettleTimer = setTimeout(() => {
      this._interruptSettleTimer = null;
      if (this.disposed || !this._awaitingInterruptResult || this.pendingTurns <= 0) return;
      const stranded = this.pendingTurns;
      this._forceSettleOpenTurns();
      this.pendingTurns = 0;
      this._awaitingInterruptResult = false;
      diagLog.record(this.logKey(), 'interrupt', 'settle_watchdog', { strandedTurns: stranded, graceMs: ms });
      interactionLog.addSessionLog(this.logKey(), 'sys_info',
        `[SYS] 中断后 ${Math.round(ms / 1000)}s 未收到配对 result，已就地清账（在途轮 ${stranded} → 0），子进程保留`);
      this.onStateSettled();
    }, ms);
  }

  _clearInterruptSettleWatchdog() {
    if (this._interruptSettleTimer) { clearTimeout(this._interruptSettleTimer); this._interruptSettleTimer = null; }
  }

  async interrupt() {
    this._flushText(); this._flushThink();
    this.pendingAutoTurn = false; // 用户显式停止：作废任何待合成的后台自动汇报轮
    // S7：先同步把队列「换成新空数组」并快照旧队列——await q.interrupt() 是让出点，期间用户若在
    // 「点停止后、中断未完成」时又发消息，该消息会 push 进新队列，不被本次中断卷入丢弃；
    // toDrop 才是本次要丢的「中断发起时已排队」。修原竞态：旧实现 await 后才 this.queue=[]，
    // 会连 await 间隙新发的一起清空（静默丢消息）+ pendingTurns 按旧 dropped 少扣。
    // 排队移除后 toDrop 最多 1 条：send 完成到 SDK 输入泵取走之间的窄窗。它已记账（pendingTurns++）
    // 却还没送达 SDK，停止时必须丢弃并补扣，否则账面泄漏 1、busy 卡到 idle 看护兜底才清。
    const toDrop = this.queue;
    const dropped = toDrop.length;
    this.queue = [];
    const droppedIds = toDrop.map(it => it.clientMessageId).filter(Boolean);
    // 限流重试时 q.interrupt() 的 control_request 可能永不回包 → await 永挂 → 前端「正在停止…」卡死。
    // 超时后按失败路径强制收口（见 settleForce / catch）。
    const raceInterrupt = () => this._raceControlRequest(() => this.q?.interrupt?.(), 'interrupt');
    // 强制结算：账面有在途轮但 SDK 拒中断/超时 → 把 pendingTurns 收口并发 interrupted，
    // 否则前端 busy 与 interruptPending 永挂（限流重试 8/10 点停止复现）。
    const settleForce = () => {
      this.pendingTurns = Math.max(0, this.pendingTurns - dropped);
      this._dropOpenTurnSlots(dropped);
      // 在途主轮也收掉：SDK 拒中断/超时说明它已无法正常产生 result 配平
      if (this.pendingTurns > 0) {
        this._forceSettleOpenTurns();
        this.pendingTurns = 0;
      }
      this._awaitingInterruptResult = false; // 无伴随 result 可消费
      for (const id of [...this.pendingPermissions.keys()]) this.resolvePermission(id, 'deny');
      for (const [toolUseID, pending] of [...this.pendingQuestions.entries()]) {
        pending.signal?.removeEventListener('abort', pending.abortHandler);
        if (pending.expiryTimer) clearTimeout(pending.expiryTimer);
        this.pendingQuestions.delete(toolUseID);
        for (let i = 0; i < pending.questions.length; i++) {
          this.emit('request_resolved', { requestId: `${toolUseID}#${i}`, kind: 'question', outcome: 'aborted' });
        }
        this.denyKinds.set(toolUseID, 'cancelled');
        try { pending.resolve({ behavior: 'deny', message: '问题已取消', interrupt: true }); } catch { /* noop */ }
      }
      if (droppedIds.length > 0) {
        this.emit('system', { message: '尚未送达的消息已随停止取消', kind: 'queue_dropped', clientMessageIds: droppedIds });
      }
      this.emit('system', { message: '已中断', kind: 'interrupted' });
      // 超时路径：再 abort 子进程，防止 CLI 仍在限流重试里挂着
      this.terminating = true;
      try { this.abort?.abort(); } catch { /* noop */ }
    };
    const _diagStartedAt = Date.now();
    let _diagOutcome = null, _diagTimedOut = false;
    try {
    try {
      await raceInterrupt();
      // AG-NEW-004：await 间隙若实例已被 dispose，仍须结算 pending 与 pendingTurns 账面，
      // 再 return——勿静默丢 toDrop 账面/挂起审批；emit 仅在未 dispose 时发（弃用实例无监听者）。
      if (this.disposed) {
        this.pendingTurns = Math.max(0, this.pendingTurns - dropped);
        this._dropOpenTurnSlots(dropped);
        for (const id of [...this.pendingPermissions.keys()]) this.resolvePermission(id, 'deny');
        for (const [toolUseID, pending] of [...this.pendingQuestions.entries()]) {
          pending.signal?.removeEventListener('abort', pending.abortHandler);
          if (pending.expiryTimer) clearTimeout(pending.expiryTimer);
          this.pendingQuestions.delete(toolUseID);
          this.denyKinds.set(toolUseID, 'cancelled');
          try { pending.resolve({ behavior: 'deny', message: '问题已取消', interrupt: true }); } catch { /* noop */ }
        }
        _diagOutcome = 'disposed';
        return;
      }
      // 成功中断：丢弃 toDrop（尚未送达 SDK 的），pendingTurns 减 dropped；await 期间新发的留在 this.queue。
      this.pendingTurns = Math.max(0, this.pendingTurns - dropped);
      this._dropOpenTurnSlots(dropped);
      this._awaitingInterruptResult = true; // 真中断了在途任务：SDK 消息流即将吐出对应的终态 result
      if (this.pendingTurns > 0) this._armInterruptSettleWatchdog(); // …但"即将"不保证到达，见方法注释
      // AG-004：Stop 应对齐「取消在途工具审批/提问」——不依赖 SDK 是否 abort canUseTool signal。
      // 若 signal 已 abort，abortHandler 会先清 Map，下面 resolve/expire 幂等（pending 不在则 no-op）。
      // 注意：Map.keys() 的元素是字符串，for-of 解构 for (const [id] of keys) 会把 't1' 拆成字符 't'——
      // 必须 for (const id of keys) 或 entries() 解构。
      for (const id of [...this.pendingPermissions.keys()]) this.resolvePermission(id, 'deny');
      for (const [toolUseID, pending] of [...this.pendingQuestions.entries()]) {
        pending.signal?.removeEventListener('abort', pending.abortHandler);
        if (pending.expiryTimer) clearTimeout(pending.expiryTimer);
        this.pendingQuestions.delete(toolUseID);
        for (let i = 0; i < pending.questions.length; i++) {
          this.emit('request_resolved', { requestId: `${toolUseID}#${i}`, kind: 'question', outcome: 'aborted' });
        }
        this.denyKinds.set(toolUseID, 'cancelled');
        pending.resolve({ behavior: 'deny', message: '问题已取消', interrupt: true });
      }
      // 被丢弃消息的可见性：前端据 clientMessageIds 把对应气泡标「已取消」（含 buffer 回放收敛）
      if (droppedIds.length > 0) {
        this.emit('system', { message: '尚未送达的消息已随停止取消', kind: 'queue_dropped', clientMessageIds: droppedIds });
      }
      this.emit('system', { message: '已中断', kind: 'interrupted' }); // M7：kind 字段，勿靠字符串匹配
      _diagOutcome = 'success';
    } catch (err) {
      _diagTimedOut = !!(err && /interrupt_timeout/.test(String(err.message || err)));
      // 账面仍有在途轮（含限流重试挂着）→ 强制收口；纯空闲拒中断才走「无可中断任务」旧路径。
      // 注意：不把 dropped（本地 queue 快照）单独当 in-flight——单测/竞态下 queue 与 pendingTurns 可能脱节，
      // 旧语义是「SDK 说没任务就把 toDrop 放回」；只有 pendingTurns>0 才强制收口。
      const hadInFlight = this.pendingTurns > 0;
      if (this.disposed) {
        this.pendingTurns = Math.max(0, this.pendingTurns - dropped);
        this._dropOpenTurnSlots(dropped);
        if (hadInFlight) {
          this._forceSettleOpenTurns();
          this.pendingTurns = 0;
        }
        _diagOutcome = 'disposed';
        return;
      }
      if (hadInFlight || _diagTimedOut) {
        _diagOutcome = 'forced_settle';
        settleForce();
        return;
      }
      // SDK 无在途任务 → 不丢消息：把 toDrop 放回队列头部（await 期间新发的接其后），pendingTurns 不动。
      this.queue = toDrop.concat(this.queue);
      this.emit('system', { kind: 'no_interruptible_task', message: '当前没有可中断的任务' });
      _diagOutcome = 'no_task';
    }
    } finally {
      diagLog.record(this.logKey(), 'interrupt', 'settled', {
        outcome: _diagOutcome, ms: Date.now() - _diagStartedAt, pendingTurnsAfter: this.pendingTurns,
        droppedCount: dropped, timedOut: _diagTimedOut,
      });
    }
  }

  // 停止单个运行中的后台任务（子 agent / 后台 Bash），对应终端 Ctrl+X Ctrl+K 停某个任务。
  // taskId 来自 task_notification / task_progress / background_tasks_changed 事件。SDK stopTask 成功后会
  // 自发 status='stopped' 的 task_notification（经 map() 走 bgTaskDone 清理 bgTasks、熄 ⏳、广播）——故此处
  // 【不】额外 emit，避免与 SDK 通道重复。与 interrupt()（停整轮 + 清主队列 + 减 pendingTurns）不同：
  // stopTask 只停单个后台任务，不碰主队列 / pendingTurns。返回 true=已请求停止；false=disposed / 无有效
  // taskId / 无 q / SDK 抛错（幂等——重复点停止或任务已结束都安全返回 false，不抛）。
  async stopTask(taskId) {
    if (this.disposed) return false;                          // 弃用实例不发
    if (typeof taskId !== 'string' || !taskId) return false;  // 无有效 taskId 不调 SDK
    if (!this.q?.stopTask) return false;                      // 无 q（实例未 start）/ SDK 无该方法：显式判，勿靠 ?. 静默通过
    try {
      await this._raceControlRequest(() => this.q.stopTask(taskId), 'stop_task');
      return true;
    } catch {
      return false; // SDK 无该任务 / 已结束 / 挂起超时：静默吞（幂等）
    }
  }

  // statusline 5h/7d 额度 + 会话 lines 数据源：SDK 实验性 usage RPC（与 CLI /usage 同源）。
  // 超时 / 无 q / 无方法 / 抛错 → null（statusline 字段省略，不崩）。
  // 原始对象交给 statusline.usageBitsForStatusLine 解析；API 标 EXPERIMENTAL_MAY_CHANGE、会漂。
  // 本方法只留【结构化事实】（lastUsageFetchFailure / lastUsageOkMs），自己不写 diag——
  // "额度是否不可用"要看用户在状态栏上有没有看见 5h/7d（含快照回落），那个结果只有下游
  // statusline.buildWebStatusLine 才知道。判定点见 ops/statusline.js#resolveRateReason。
  async fetchUsage(timeoutMs = 1500, { minIntervalMs, now = Date.now() } = {}) {
    if (typeof this.q?.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET !== 'function') {
      this.lastUsageFetchFailure = { reason: 'rpc_no_method' };
      return null;
    }
    // 显式传参优先（测试绕开节流用 0）；否则按上次 CLI 自报的鉴权类型选档。
    const windowMs = minIntervalMs
      ?? (this._usageThirdParty ? USAGE_THIRD_PARTY_INTERVAL_MS : USAGE_MIN_INTERVAL_MS);
    // 成败都占用节流窗：RPC 挂住时更不该继续给同一条 stdio control 通道加压。
    // 窗内早退不碰 lastUsageFetchFailure——沿用上次判定依据，与快照回落配合保持状态稳定。
    if (this._usageFetchAt && now - this._usageFetchAt < windowMs) return this._usageCached;
    this._usageFetchAt = now;
    const startedAt = Date.now();
    let timer = null;
    try {
      const usage = await Promise.race([
        this.q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(),
        new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('usage timeout')), timeoutMs); }),
      ]);
      this.lastUsageFetchFailure = null;
      this.lastUsageOkMs = Date.now() - startedAt;
      this._usageCached = usage;
      // 鉴权类型双向自适应：CLI 说没有订阅额度就降档，说有就回常规档。只读 CLI 的权威自报，
      // 不做展示层判定（额度到底显不显示仍由 ops/statusline.js#resolveRateReason 决定）。
      this._usageThirdParty = usage?.rate_limits_available === false;
      return usage;
    } catch (err) {
      this.lastUsageFetchFailure = {
        reason: 'rpc_error', message: String(err?.message || err),
        timedOut: err?.message === 'usage timeout', ms: Date.now() - startedAt,
      };
      this._usageCached = null;
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // 权限档切换（与 send 的 setModel 同型，差分——仅档位真变才调 SDK）。
  // 成功后由 server 广播 permission_mode 合成事件（不走 emit/seq 流，符合本服务事件契约）。
  // 给 SDK 的 permissionMode——bypass 映射为 default。SDK 原生 bypassPermissions 需危险全局
  // flag（allowDangerouslySkipPermissions），那会连 default 审批一起跳过；bypass 改由 handleCanUseTool 放行。
  sdkPermissionMode() {
    return this.permissionMode === 'bypassPermissions' ? 'default' : this.permissionMode;
  }

  async setPermissionMode(mode) {
    // 白名单 = SDK PermissionMode（CCM_PERMISSION_MODES）；manual → default 见 normalizePermissionMode
    const normalized = normalizePermissionMode(mode);
    if (!normalized) {
      this.emit('error', { message: `未知权限档：${mode}`, recoverable: true });
      return false;
    }
    mode = normalized;
    if (mode === this.permissionMode) return true; // 差分：无变化不调 SDK
    const sdkMode = mode === 'bypassPermissions' ? 'default' : mode;
    // 从 bypassPermissions 降出去必须【立即】本地生效，不等 SDK 回包：闸门读的就是 this.permissionMode，
    // 而 _raceControlRequest 最长可挂 interruptTimeoutMs(10s)（限流重试时常见），且本方法没有 busy 守卫、
    // 轮次进行中可被调用。这段窗口里模型发起的任何工具仍会命中 bypass 分支零弹窗放行 —— 用户主动降权的
    // 意图被推迟最多 10 秒。其余方向（升权 / 切 dontAsk）保持「SDK 确认后才生效」，那些方向的在飞窗口是
    // fail-safe。失败也不回滚：用户的意图是降权，退回宽档比停在严档危险。
    const leavingBypass = this.permissionMode === 'bypassPermissions' && mode !== 'bypassPermissions';
    if (leavingBypass) this.permissionMode = mode;
    try {
      await this._raceControlRequest(() => this.q?.setPermissionMode(sdkMode), 'set_permission_mode');
      if (this.disposed) return false; // S3：await 间隙实例可能已被 dispose
      this.permissionMode = mode;                  // 实例记真实档（含 bypass），canUseTool 据此放行
      return true;
    } catch (err) {
      this.emit('error', { message: `权限档切换失败（${err.message}），仍为「${this.permissionMode}」`, recoverable: true });
      return false;
    }
  }

  // ---- 权限闸门（第二层）+ AskUserQuestion 特判（F2）----
  handleCanUseTool(name, input, { suggestions, signal, toolUseID }) {
    // F2：canAskUserQuestion 在 SDK 0.1.77 不存在（静默被忽略），AskUserQuestion 走此统一入口。
    // ⚠️ 必须在 bypass 短路之前：AskUserQuestion 是模型「向用户提问」，与「绕过工具权限审批」正交——
    // bypass 也应弹窗作答。若放在 bypass 之后，bypass 档会先 return allow 把提问当普通工具放行，
    // 不发 question 事件 → 前端无弹窗 → 问题被静默跳过（2026-06-22 实证；原顺序倒置）。
    if (name === 'AskUserQuestion') return this.handleQuestion(input, { signal, toolUseID });
    // dontAsk 防御纵深：SDK 契约保证 dontAsk 不调 canUseTool，此处防御 SDK 版本/bug 的误调
    if (this.permissionMode === 'dontAsk') return { behavior: 'deny', message: '当前模式禁止执行此操作', interrupt: true };
    // bypass 档自实现放行。不用 SDK allowDangerouslySkipPermissions——实测 2026-06-12 该 flag=true
    // 是全局 skip，会连 default 档的审批一起废掉（default 假安全），故 bypass 改在此直接 allow。
    if (this.permissionMode === 'bypassPermissions') return { behavior: 'allow', updatedInput: input };
    return this.askPermission(name, input, { suggestions, signal, toolUseID });
  }

  askPermission(name, input, { suggestions, signal, toolUseID }) {
    // 实证日志：已证实 SDK 的 ExitPlanMode 不经 suggestions 给 setMode（headless 路径 permission_suggestions
    // 恒空，见 resolvePermission 兜底注释）；保留此日志以便 SDK 版本变更后能第一时间发现 setMode 开始下发。
    if (suggestions?.length) console.log(`[canUseTool] ${name} suggestions: ${JSON.stringify(suggestions)}`);
    const requestId = toolUseID || `perm_${++this.permSeq}`;
    // 审批 TTL（docs/design.md，承接 OQ-05）：createdAt=悬置起点，expiresAt=过期时刻；
    // 事件携带二者供前端未来展示悬置时长/倒计时（FR-22），即使本轮不接 UI 也先备好契约字段。
    const createdAt = Date.now();
    const expiresAt = createdAt + this.approvalTtlMs;
    // 审批完整性绑定（docs/design.md，承接 AD-7/NFR-17，"所批即所行"）：canUseTool 收到 op 的这一刻
    // 就是完整性锚点的源头——op={tool,args,cwd} 越晚计算，越可能与用户最终看到/批准的内容脱节。
    // 指纹随 permission_request 下发供手机端渲染前重算比对（协议步骤4）；resolvePermission 收到客户端
    // 回传的 op 后重算比对本处存的 fp（协议步骤6），不一致 fail-closed 拒绝。用同步 fingerprintSync
    // （node:crypto）而非前端那份异步 crypto.subtle 版本——askPermission/resolvePermission 必须保持
    // 同步：调用方（含既有测试）习惯不 await 就紧接着同步调 resolvePermission，插入一次 await 会在
    // pendingPermissions.set() 真正执行前的窗口让 resolvePermission 扑空、返回的 Promise 永远不 resolve。
    const fp = fingerprintSync({ tool: name, args: input, cwd: this.cwd });
    this.emit('permission_request', { requestId, name, input, cwd: this.cwd, fp, createdAt, expiresAt });
    // 持久化台账（docs/design.md approval_request 表，承接 NFR-16/19/22，Phase 4）：只是台账记录，写入失败
    // 不影响审批流程本身（recordCreated 内部已捕获落盘错误、不向上抛，见 approval-store.js 头部注释）。
    approvalStore.recordCreated({ reqId: requestId, sessionId: this.sessionId, tool: name, args: input, cwd: this.cwd, fingerprint: fp, risk: null, createdAt, expiresAt });
    return new Promise(resolve => {
      const abortHandler = () => {
        const p = this.pendingPermissions.get(requestId);
        if (this.pendingPermissions.delete(requestId)) {
          if (p?.expiryTimer) clearTimeout(p.expiryTimer); // BE-003：取消到期 timer，防僵尸回调
          this.emit('request_resolved', { requestId, kind: 'permission', outcome: 'aborted' }); // M4
          approvalStore.recordDecided(requestId, { status: 'aborted', decidedBy: 'system:abort', decidedAt: Date.now() });
          this.denyKinds.set(requestId, 'cancelled'); // requestId===toolUseID：供 tool_result 显 🚫 而非红 ❌
          resolve({ behavior: 'deny', message: '请求已取消', interrupt: true });
        }
      };
      // BE-003：到期 timer 主动结算——无人处理审批时（无提交者，且 checkIdle 因 pending 持续刷新 lastActivity
      // 顶住静默判定），SDK canUseTool 的这个 Promise 会永久悬置、turn 永挂。到 approvalTtlMs 自动 fail-closed
      // deny + emit expired（与 resolvePermission 的惰性过期分支同义，只是这里「到时主动」而非「有人提交才发现」）。
      const expiryTimer = setTimeout(() => this._expirePermission(requestId), this.approvalTtlMs);
      expiryTimer.unref?.(); // 不阻止进程退出
      this.pendingPermissions.set(requestId, { resolve, name, suggestions, input, signal, abortHandler, createdAt, expiresAt, fp, expiryTimer });
      // AG-002：与 handleQuestion 一致，signal 可能缺失（测试桩/SDK 形态漂移）；硬调用 addEventListener 会在
      // Map 插入之后仍抛——其实 set 已在前；但若未来挪序或 signal 在 set 前访问仍炸。统一可选链。
      signal?.addEventListener('abort', abortHandler);
    });
  }

  // BE-003：审批到期无人处理时的主动结算（由 askPermission 的 expiryTimer 触发）。fail-closed deny + emit
  // expired + 台账记 expired，与 resolvePermission 的惰性 expired 分支等义。已被用户/abort 结算则 pending
  // 不在、直接返回（幂等）。
  _expirePermission(requestId) {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) return;
    pending.signal?.removeEventListener('abort', pending.abortHandler);
    this.pendingPermissions.delete(requestId);
    this.denyKinds.set(requestId, 'denied');
    this.emit('request_resolved', { requestId, kind: 'permission', outcome: 'expired' });
    approvalStore.recordDecided(requestId, { status: 'expired', decidedBy: 'system:timeout', decidedAt: Date.now() });
    pending.resolve({ behavior: 'deny', message: '审批已过期，操作未执行，请重新触发', interrupt: false });
  }

  // 返回值 = 本次落定的 outcome 字符串（与 emit('request_resolved') 的 outcome 一致），供 server.js
  // 的 user:approve handler 判断是否需要额外写 audit_record（目前只在 integrity_mismatch 时写，
  // 见 server.js 注释）——resolvePermission 本身不知道调用方是哪个设备/socket，无法自己写 audit_record
  // （actor 归属信息只有 server.js 层有），故只把结果吐出去，把"要不要审计"的判断留给上层。
  // 找不到 pending（已被 abort/consume 清理）时返回 undefined，调用方不应据此写审计。
  // opts.exitMode：对齐 CLI plan-exit——批准 ExitPlanMode 时用户选的退出后权限档
  // （default / acceptEdits / bypassPermissions）；非法或缺省回落 default。
  resolvePermission(requestId, decision, alwaysThisSession, clientOp, opts = {}) {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) return undefined;
    // 移除 abort 监听器防僵尸累积（SDK 可能为多个 canUseTool 复用同一 signal）
    pending.signal?.removeEventListener('abort', pending.abortHandler);
    if (pending.expiryTimer) clearTimeout(pending.expiryTimer); // BE-003：用户/系统提交决定，取消到期 timer
    this.pendingPermissions.delete(requestId);
    this.lastActivity = Date.now(); // 用户审批是主动操作，续期静默看护
    // 审批 TTL fail-closed（OQ-05 已决）：过期后不可再兑现同一请求——不论传入的 decision 是什么，一律按
    // 拒绝处理，避免对一个可能已失去语境（主机/会话状态已变化）的操作误批。outcome 标 'expired' 以区别于
    // 用户主动 allow/deny，供前端提示"已过期，请重新触发"而非误显示为一次正常的拒绝。
    if (Date.now() > pending.expiresAt) {
      this.denyKinds.set(requestId, 'denied');
      this.emit('request_resolved', { requestId, kind: 'permission', outcome: 'expired' });
      approvalStore.recordDecided(requestId, { status: 'expired', decidedBy: 'user', decidedAt: Date.now() });
      pending.resolve({ behavior: 'deny', message: '审批已过期，操作未执行，请重新触发', interrupt: false });
      return 'expired';
    }
    // 审批完整性绑定（docs/design.md 步骤6/§5.5，承接 AD-7/NFR-17，"所批即所行"）：仅在 allow 时校验——
    // deny 不存在"拒绝了错误操作"这种需要防范的风险。clientOp 缺失或与 askPermission 时锚定的 fp
    // 不符，一律 fail-closed 拒绝 + 高优审计告警——不假设"服务端自己存的副本在等待期间没被动过"。
    if (decision === 'allow') {
      const integrityOk = clientOp ? verifyIntegritySync(pending.fp, clientOp) : false;
      if (!integrityOk) {
        console.error(`[integrity] 审批完整性校验失败 requestId=${requestId} name=${pending.name}：客户端回传操作与原始锚定指纹不符或缺失，fail-closed 拒绝`);
        this.denyKinds.set(requestId, 'denied');
        this.emit('request_resolved', { requestId, kind: 'permission', outcome: 'integrity_mismatch' });
        approvalStore.recordDecided(requestId, { status: 'integrity_mismatch', decidedBy: 'system:integrity-check', decidedAt: Date.now() });
        pending.resolve({ behavior: 'deny', message: '完整性校验失败，操作已拒绝执行', interrupt: false });
        return 'integrity_mismatch';
      }
    }
    this.emit('request_resolved', { requestId, kind: 'permission', outcome: decision }); // M4
    approvalStore.recordDecided(requestId, { status: decision, decidedBy: 'user', decidedAt: Date.now() });
    if (decision === 'allow') {
      const suggestions = pending.suggestions || [];
      // setMode：批准内含的「模式切换」（如 ExitPlanMode 退出 plan）。它是工具批准的内在部分，应始终
      // 应用（非「始终允许」可选项）；优先跟随 SDK 的 suggestion、不硬编码切到哪档。
      let modeUpdate = suggestions.find(u => u.type === 'setMode');
      // 兜底：实测 SDK 的 ExitPlanMode 工具 checkPermissions 只回 {behavior:'ask'}、不带任何 suggestions
      // （交互式 CLI 的切档由 plan-exit 弹窗用户选 default/acceptEdits/bypass 时补 setMode；headless/
      // canUseTool 路径没有那个弹窗 → permission_suggestions 为 undefined）。若不兜底，批准后 updatedPermissions
      // 为空 → SDK 内部 toolPermissionContext.mode 仍停在 plan。web 现支持 opts.exitMode 对齐 CLI 三档；
      // 非法/缺省 → default（=终端平按 yes）。destination:'session' 只改本会话、不落盘 settings。
      // SDK 未来若开始发 setMode suggestion，则上面的 suggestion 优先、此兜底不触发。
      if (!modeUpdate && pending.name === 'ExitPlanMode') {
        const EXIT_MODES = new Set(['default', 'acceptEdits', 'bypassPermissions']);
        const exitMode = EXIT_MODES.has(opts?.exitMode) ? opts.exitMode : 'default';
        modeUpdate = { type: 'setMode', mode: exitMode, destination: 'session' };
      }
      // 「始终允许本会话」额外应用 session 范围的规则更新（原行为；排除已单列的 setMode 防重复）。
      const sessionRules = alwaysThisSession
        ? suggestions.filter(u => u.destination === 'session' && u.type !== 'setMode')
        : [];
      const updates = [...(modeUpdate ? [modeUpdate] : []), ...sessionRules];
      pending.resolve({
        behavior: 'allow',
        updatedInput: pending.input,
        updatedPermissions: updates.length ? updates : undefined
      });
      // 模式切换同步：更新本实例档 + emit permission_mode → server onEvent 更新 permModeByInstance 并广播，
      // 使手机端权限档图标跟随（否则图标停在旧档）。
      if (modeUpdate && modeUpdate.mode !== this.permissionMode) {
        this.permissionMode = modeUpdate.mode;
        this.emit('permission_mode', { mode: modeUpdate.mode });
      }
    } else {
      this.denyKinds.set(requestId, 'denied'); // requestId===toolUseID：拒绝是有意操作非工具报错，前端显 🚫
      pending.resolve({ behavior: 'deny', message: '用户拒绝了此操作', interrupt: false });
    }
    return decision;
  }

  // ---- AskUserQuestion（F2）：实验证明 deny+message 通道有效（2026-06-11）----
  // 模型将 tool_result 的 error content 识别为答案（is_error:true, content:'用户选择了：「…」'）
  handleQuestion(input, { signal, toolUseID }) {
    const rawQuestions = input?.questions;
    if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) {
      return { behavior: 'allow', updatedInput: input };
    }
    // 归一 + 过滤空 label 只做【一次】，下发与回读共用同一份。此前 emit 用过滤后的数组、resolveQuestion
    // 却回读原始数组：模型只要给出一个不带 label 的选项（normalizeQuestionOption 产出 ''），后续所有项
    // 下标整体前移，两侧下标空间错位 —— 用户点「取消」，模型收到「删除全部」。multiSelect 与快照重建同源。
    const questions = rawQuestions.map(q => ({
      ...q,
      options: (q?.options || []).map(normalizeQuestionOption).filter(o => o.label),
    }));
    return new Promise(resolve => {
      const answers = new Array(questions.length).fill(null);
      let remaining = questions.length;
      const abortHandler = () => {
        const p = this.pendingQuestions.get(toolUseID);
        if (this.pendingQuestions.delete(toolUseID)) {
          if (p?.expiryTimer) clearTimeout(p.expiryTimer); // AG-001：取消到期 timer
          for (let i = 0; i < questions.length; i++) {
            this.emit('request_resolved', { requestId: `${toolUseID}#${i}`, kind: 'question', outcome: 'aborted' }); // M4
          }
          this.denyKinds.set(toolUseID, 'cancelled'); // 取消≠已回答：前端显 🚫 而非 ☑️
          resolve({ behavior: 'deny', message: '问题已取消', interrupt: true });
        }
      };
      // AG-001：提问 TTL（镜像 BE-003 审批 TTL）——无人作答时 canUseTool Promise 永久悬置、checkIdle
      // 因 pendingQuestions 持续刷新 lastActivity → 实例永不 idle-reclaim。复用 approvalTtlMs。
      const createdAt = Date.now();
      const expiresAt = createdAt + this.approvalTtlMs;
      const expiryTimer = setTimeout(() => this._expireQuestion(toolUseID), this.approvalTtlMs);
      expiryTimer.unref?.();
      // createdAt：供 AD-11/§3.2.5 AttentionDeriver 的"等我输入"悬置起点（waitingSince），镜像 pendingPermissions 已有的 createdAt 模式。
      this.pendingQuestions.set(toolUseID, { resolve, questions, answers, remaining, signal, abortHandler, createdAt, expiresAt, expiryTimer });

      for (let i = 0; i < questions.length; i++) {
        const q = questions[i];
        // 对齐 CLI：保留 header / multiSelect / option.description|preview，前端才能完整呈现
        const options = q.options; // 已在入口归一+过滤，与 resolveQuestion 回读的是同一份
        this.emit('question', {
          requestId: `${toolUseID}#${i}`,
          text: q.question,
          header: q.header ? String(q.header) : undefined,
          multiSelect: Boolean(q.multiSelect),
          options,
          createdAt,
          expiresAt,
        });
      }

      signal?.addEventListener('abort', abortHandler);
    });
  }

  // AG-001：提问到期无人作答时的主动结算（由 handleQuestion 的 expiryTimer 触发）。fail-closed deny +
  // emit expired，与 _expirePermission 等义。已被用户/abort 结算则 pending 不在、直接返回（幂等）。
  _expireQuestion(toolUseID) {
    const pending = this.pendingQuestions.get(toolUseID);
    if (!pending) return;
    pending.signal?.removeEventListener('abort', pending.abortHandler);
    if (pending.expiryTimer) clearTimeout(pending.expiryTimer);
    this.pendingQuestions.delete(toolUseID);
    this.denyKinds.set(toolUseID, 'denied');
    for (let i = 0; i < pending.questions.length; i++) {
      if (pending.answers[i] === null) {
        this.emit('request_resolved', { requestId: `${toolUseID}#${i}`, kind: 'question', outcome: 'expired' });
      }
    }
    this.emit('request_resolved', { requestId: toolUseID, kind: 'question', outcome: 'expired' });
    pending.resolve({ behavior: 'deny', message: '提问已过期，操作未作答', interrupt: false });
  }

  // requestId 格式：`${toolUseID}#${questionIndex}`（server 的 user:answer handler 透传）
  // opts.freeText：对齐 CLI 自动提供的 Other——自由文本作答，不依赖 options 下标。
  // opts.optionIndexes：对齐 multiSelect——多个选项下标，合并为一条答案。
  resolveQuestion(requestId, optionIndex, opts = {}) {
    const hash = requestId.lastIndexOf('#');
    if (hash === -1) return;
    const toolUseID = requestId.slice(0, hash);
    const qIdx = parseInt(requestId.slice(hash + 1), 10);
    const pending = this.pendingQuestions.get(toolUseID);
    if (!pending || isNaN(qIdx) || qIdx >= pending.questions.length) return;
    if (pending.answers[qIdx] !== null) return; // 防重复
    // AG-001：过期后不可再作答（fail-closed），与 resolvePermission 对称
    if (pending.expiresAt != null && Date.now() > pending.expiresAt) {
      this._expireQuestion(toolUseID);
      return;
    }

    const freeText = typeof opts?.freeText === 'string' ? opts.freeText.trim() : '';
    let label;
    if (freeText) {
      // Other：自由文本优先（即使同时传了 optionIndex 也用 freeText，对齐「用户最终写的内容」）
      label = freeText;
    } else if (Array.isArray(opts?.optionIndexes)) {
      const q = pending.questions[qIdx];
      const qopts = q.options || [];
      const labels = [];
      const seen = new Set();
      for (const idx of opts.optionIndexes) {
        if (!Number.isInteger(idx) || idx < 0 || idx >= qopts.length || seen.has(idx)) continue;
        seen.add(idx);
        const opt = qopts[idx];
        labels.push(typeof opt === 'string' ? opt : (opt?.label ?? String(idx)));
      }
      if (!labels.length) return; // 空/全非法 multiSelect 不作答
      label = labels.join('、');
    } else {
      const q = pending.questions[qIdx];
      const qopts = q.options || [];
      if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= qopts.length) return; // S6：越界 optionIndex 不作答
      const opt = qopts[optionIndex];
      label = typeof opt === 'string' ? opt : (opt?.label ?? String(optionIndex));
    }
    pending.answers[qIdx] = label;
    pending.remaining--;

    // 单题落定立刻广播（requestId=toolUseID#i）。multi-Q 只答了一题时若等整组 remaining===0 才
    // emit，切会话/sync:since 回放缓冲里的 question 会把已答项再弹一次（用户报告）。pending 快照
    // 虽已跳过 answers[i]!=null，但 buffer 回放仍会送 question——单题 resolved + eventsSince 过滤双保险。
    this.emit('request_resolved', { requestId, kind: 'question', outcome: 'answered' });

    if (pending.remaining === 0) {
      // 移除 abort 监听器防僵尸累积
      pending.signal?.removeEventListener('abort', pending.abortHandler);
      if (pending.expiryTimer) clearTimeout(pending.expiryTimer); // AG-001
      this.pendingQuestions.delete(toolUseID);
      this.lastActivity = Date.now(); // 用户答题是主动操作，续期静默看护
      const msg = '用户选择了：' + pending.answers.map(a => `「${a}」`).join('、');
      this.emit('request_resolved', { requestId: toolUseID, kind: 'question', outcome: msg }); // M4 整组终态
      this.denyKinds.set(toolUseID, 'answered'); // 已回答：前端显 ☑️（is_error 来自 deny 通道、非真错误）
      pending.resolve({ behavior: 'deny', message: msg, interrupt: false });
    }
  }

  // 用户显式活动续期：切回/打开本实例（setViewing / session:switch）时调用。
  // 不进事件流——只刷新 lastActivity。
  touchActivity() {
    this.lastActivity = Date.now();
  }

  // 当前是否为前端 viewing 实例。true 时跳过空闲回收（用户正在看历史也不该被 30min 清屏）。
  // 在途轮静默超时仍生效（pendingTurns>0 时用户仍需要挂死保护）。
  setViewed(viewed) {
    this.viewed = Boolean(viewed);
    if (this.viewed) this.lastActivity = Date.now();
  }

  // ---- 静默看护 + 空闲实例回收 ----
  // ① 在途轮静默挂死（idleTimeoutMs）：pendingTurns>0 且无审批/提问、且无活后台任务时，
  //    长时间零活动 → abort。活的 bgTasks（workflow/后台 agent/后台 bash）视为仍在干活，
  //    刷新 lastActivity 豁免——否则多子代理并行时长主流通零消息会被 10 分钟误杀。
  // ② 空闲真回收（instanceIdleReclaimMs）：完全 !isBusy 且超阈 → abort 释放子进程；会话盘上仍在，
  //    下次发送/切换会 resume 重建。0 = 禁用。等审批/后台任务/提问都算 busy，不回收。
  //    当前 viewing 实例（this.viewed）也不回收——用户在读历史时 lastActivity 不会因 SDK 消息刷新。
  checkIdle() {
    // 后台任务 TTL 清扫须在下方分支之前——后台任务运行时 pendingTurns 正是 0，
    // 放 return 之后就永远清不到（漏收完成信号的任务会把 ⏳ 永挂）。清出变化即回调重算角标 +
    // 推全量快照（含空表），前端列表与 bgActive 立刻对齐（不必等下拍心跳 / 仅靠 instances hide）。
    // 亦保证下方 hasBgTasks() 只认「仍活」的任务（过期的已清）。
    if (this.sweepBgTasks()) {
      this.onBgTaskChange?.();
      this.emitBgTasksSnapshot();
    } else if (this.hasBgTasks()) {
      // 活任务 30s tick 软补推全量快照：task_progress 是 transient，前端可能因切视图/误清丢横幅；
      // 不刷新 lastSeenAt（完成权威仍靠 lifecycle；补推只修展示粘性）。
      this.emitBgTasksSnapshot();
    }
    if (this.pendingPermissions.size > 0 || this.pendingQuestions.size > 0) {
      this.lastActivity = Date.now();
      return;
    }
    // 在途轮 + 活后台任务：主流通可长时间无 delta（子代理内部跑），不得按 idleTimeout 误杀。
    // 前台工具同理：tool_use 到 tool_result 之间 SDK 流零消息，但本轮正在推进（见 FOREGROUND_TOOL_GRACE_MS）。
    // 与 pendingPermissions 同口径：刷新 lastActivity 后返回（不进静默中断、也不进空闲回收）。
    if (this.pendingTurns > 0 && (this.hasBgTasks() || this.hasRunningForegroundTool())) {
      this.lastActivity = Date.now();
      return;
    }
    const idleFor = Date.now() - this.lastActivity;
    if (this.pendingTurns === 0) {
      // 用户正查看本实例：不回收（读历史/停在会话页不应被 30min 空闲清屏）
      if (this.viewed) return;
      // 完全空闲回收：isBusy 还含 bgTasks（刚 sweep 后可能仍有活任务）
      if (this.instanceIdleReclaimMs > 0 && !this.isBusy() && idleFor > this.instanceIdleReclaimMs) {
        const mins = Math.max(1, Math.round(this.instanceIdleReclaimMs / 60000));
        this.emit('error', {
          message: formatLifecycleIdleReclaim(mins),
          recoverable: true
        });
        this.terminating = true;
        try { this.abort?.abort(); } catch { /* noop */ }
      }
      return;
    }
    if (idleFor > this.idleTimeoutMs) {
      this.emit('error', {
        message: formatLifecycleIdleTimeout(Math.round(this.idleTimeoutMs / 60000)),
        recoverable: true
      });
      // 终端等价性：CLI 里请求挂死只是停在原地报错（用户可 Esc 中断本轮），从不自杀会话。
      // 看门狗替用户按这个「Esc」——q 可达就走 interrupt()（失败/超时它自己的 settleForce
      // 兜底会强杀），只有 q 本身不可达（启动早期等边缘态，无法发中断请求）才直接强杀防僵尸。
      this.lastActivity = Date.now(); // 防中断未决期间 30s tick 重复触发
      if (this.q && typeof this.q.interrupt === 'function') {
        this.interrupt();
      } else {
        this.terminating = true;
        try { this.abort?.abort(); } catch { /* noop */ }
      }
    } else if (
      // 网关挂起早期告警（只提示不中断）：idleTimeoutMs 中断前用户原本全程零反馈，真机（2026-07-28
      // b06fb05d）等 3 分钟就被逼去终端接手。idleTimeoutMs 配得比告警线短时不叠告警（直接走上面中断）。
      idleFor > GATEWAY_STALL_WARN_MS
      && GATEWAY_STALL_WARN_MS < this.idleTimeoutMs
      && this.stallWarnedForActivity !== this.lastActivity
    ) {
      this.stallWarnedForActivity = this.lastActivity;
      this.emit('error', {
        message: formatLifecycleGatewayStall(Math.round(idleFor / 1000), Math.round(this.idleTimeoutMs / 60000)),
        recoverable: true
      });
    }
  }

  // ---- 活的后台任务注册表（Workflow / 后台 Agent / 后台 Bash）----
  // task_progress：tool description/last_tool 变化时推；agentProgressSummaries 开时另有 ~30s AI summary。
  // upsert 刷新 lastSeenAt。完成走 task_notification / user 注入 → bgTaskDone。TTL 兜底见 sweepBgTasks。
  // size 变化才回调 onBgTaskChange（稳态同 id progress 只刷时间戳、不广播——节流关键）。
  // meta: { lastToolName?, description?, subagentType? } — 供前端任务明细行展示（不进角标判定）
  bgTaskUpsert(taskId, taskType, message, meta = {}) {
    const key = taskId ?? `__notask_${taskType ?? 'x'}`; // taskId 缺失用稳定合成键，避免 null 键互相覆盖多任务
    const prev = this.bgTasks.get(key);
    const type = taskType ?? null;
    const descRaw = meta.description ?? prev?.description ?? null;
    this.bgTasks.set(key, {
      taskType: type,
      message: message ?? '',
      lastSeenAt: Date.now(),
      lastToolName: meta.lastToolName ?? prev?.lastToolName ?? null,
      description: descRaw,
      subagentType: meta.subagentType ?? prev?.subagentType ?? null,
      truncated: meta.truncated || prev?.truncated || false,
    });
    // 新任务 或 taskType 变化才回调重算角标（稳态同 id 同 type 心跳只刷 message/lastSeenAt、不广播——节流关键）。
    // taskType 变化也回调：同一任务首条无 subagent_type（→null→⏳）、后续带（→local_agent→🤖）时会话列表图标需随之刷新。
    if (!prev || prev.taskType !== type) this.onBgTaskChange?.();
  }
  bgTaskDone(taskId) {
    const had = this.bgTasks.size;
    // 实测：完成信号可靠带 task_id（system task_notification 41/41 + user 注入 <task-id>），且 workflow/agent 的完成 id
    // 与心跳 id 一致 → 精确删。关键：未及心跳就完成的快任务（实测 bedkhlnbd：progress=0/notification=1）其 id 不在表内，
    // delete 自然 no-op——【绝不能】"id 不在表就整清"，否则每个快任务完成都误清其他仍在跑者的 ⏳（频繁闪断）。孤儿由 TTL 兜底。
    // 用 `!= null` 而非真值判断：空串 '' 是畸形/空 <task-id> 标签，delete('') 天然 no-op 不误清；仅真 null/undefined 才整清。
    if (taskId != null) this.bgTasks.delete(taskId);
    else this.bgTasks.clear(); // 仅 null/undefined（真无 id 注入）才整清兜底：仍在跑者下拍 progress 即复亮，比长兜底 TTL 收敛快
    if (this.bgTasks.size !== had) {
      this.onBgTaskChange?.();
      // 完成/停止后推全量，前端列表立刻去掉该行（不必等下一拍心跳）
      this.emitBgTasksSnapshot();
    }
  }
  sweepBgTasks() {
    // 惰性 TTL：超阈无刷新即判失效。由 checkIdle 的 30s tick 驱动，返回是否清出过。
    // 分档见文件顶 BG_TASK_ORPHAN_TTL_MS / BG_TASK_LIFECYCLE_TTL_MS：真实 id 走长兜底，合成键走短清。
    if (this.bgTasks.size === 0) return false;
    const now = Date.now();
    let removed = false;
    for (const [k, t] of this.bgTasks) {
      const orphan = typeof k === 'string' && k.startsWith('__notask_');
      const ttl = orphan ? BG_TASK_ORPHAN_TTL_MS : BG_TASK_LIFECYCLE_TTL_MS;
      if (now - t.lastSeenAt > ttl) { this.bgTasks.delete(k); removed = true; }
    }
    return removed;
  }
  // background_tasks_changed 全量快照 → 同步 bgTasks：快照内 upsert、快照外删除。
  // probe 实证该事件是【全量】（开始 tasks=[N] / stopTask 停止 tasks=[]），故"不在快照即已停止/完成"成立。
  // value 结构对齐 bgTaskUpsert（{taskType,message,lastSeenAt}）。size 变化才 onBgTaskChange（节流，同 bgTaskDone）。
  reconcileBgTasks(tasks) {
    const arr = Array.isArray(tasks) ? tasks : [];
    const had = this.bgTasks.size;
    const seen = new Set();
    for (const t of arr) {
      const id = t?.task_id ?? t?.taskId ?? null;
      if (id == null) continue;
      seen.add(id);
      const prev = this.bgTasks.get(id);
      const desc = t.description ?? t.message ?? prev?.description ?? '';
      const lastTool = t.last_tool_name ?? t.lastToolName ?? prev?.lastToolName ?? null;
      const subType = t.subagent_type ?? t.subagentType ?? prev?.subagentType ?? null;
      const msgStr = String(desc || prev?.message || '');
      const descStr = desc ? String(desc) : '';
      const messageTruncated = msgStr.length > TOOL_SUMMARY_CAP;
      const descTruncated = descStr.length > TOOL_SUMMARY_CAP;
      this.bgTasks.set(id, {
        taskType: t.task_type ?? t.taskType ?? (subType ? 'local_agent' : prev?.taskType) ?? null,
        message: truncate(msgStr, TOOL_SUMMARY_CAP),
        lastSeenAt: Date.now(),
        lastToolName: lastTool,
        description: desc ? truncate(descStr, TOOL_SUMMARY_CAP) : prev?.description ?? null,
        subagentType: subType,
        truncated: messageTruncated || descTruncated || false,
      });
    }
    for (const k of [...this.bgTasks.keys()]) if (!seen.has(k)) this.bgTasks.delete(k);
    if (this.bgTasks.size !== had) this.onBgTaskChange?.();
    // 全量快照同步到前端：否则 web 只攒到「最新一条 task_progress」，看不到并行任务列表
    this.emitBgTasksSnapshot();
  }

  // 把当前 bgTasks 全量推给前端（瞬时，不进 buffer）。空表也推 → 前端可立刻收起横幅。
  emitBgTasksSnapshot(extra = {}) {
    const tasks = this.bgTasksList();
    const latest = tasks[0] || null;
    this.emitTransient('task_progress', {
      taskId: latest?.taskId ?? null,
      taskType: latest?.taskType ?? null,
      message: latest?.message ?? '',
      description: latest?.description ?? null,
      lastToolName: latest?.lastToolName ?? null,
      subagentType: latest?.subagentType ?? null,
      truncated: latest?.truncated || false,
      tasks, // 全量明细：前端以它为准 reconcile
      ...extra,
    });
  }

  hasBgTasks() { return this.bgTasks.size > 0; }

  // 是否有仍在跑的主会话前台工具（超 FOREGROUND_TOOL_GRACE_MS 的不再算「在干活」，见常量注释）。
  // 顺带清掉超限条目：它们已不影响判定，留着只会在长会话里堆成垃圾。
  hasRunningForegroundTool() {
    const now = Date.now();
    let alive = false;
    for (const [id, startedAt] of this.pendingToolUses) {
      if (now - startedAt < FOREGROUND_TOOL_GRACE_MS) alive = true;
      else this.pendingToolUses.delete(id);
    }
    return alive;
  }
  // BE-008：实例是否处于「不可安全 dispose」的活动态——供 effort 切档等需置换实例（dispose+resume）的操作判定。
  // 后台任务(bgTasks)、挂起审批(pendingPermissions)、挂起问题(pendingQuestions)都【不】计入 pendingTurns，
  // 只查 pendingTurns 会在这些非 turn 活动进行时 disposeInstance→abort 误杀它们。
  isBusy() {
    return this.pendingTurns > 0 || this.hasBgTasks() || this.pendingPermissions.size > 0 || this.pendingQuestions.size > 0;
  }
  bgTaskSummary() { // 取 lastSeenAt 最新一条 + 总数：server 据 taskType 映射 activeTool 图标（🤖/🖥），横幅显 message
    if (this.bgTasks.size === 0) return null;
    let latest = null;
    for (const t of this.bgTasks.values()) if (!latest || t.lastSeenAt >= latest.lastSeenAt) latest = t; // >= ：lastSeenAt 平局（同毫秒）取后迭代者，确定性
    return { taskType: latest.taskType, message: latest.message, count: this.bgTasks.size };
  }
  // 活后台任务列表（供前端多任务明细/停止）：按 lastSeenAt 降序
  bgTasksList() {
    return [...this.bgTasks.entries()]
      .map(([taskId, t]) => ({
        taskId,
        taskType: t.taskType,
        message: t.message,
        lastSeenAt: t.lastSeenAt,
        lastToolName: t.lastToolName ?? null,
        description: t.description ?? null,
        subagentType: t.subagentType ?? null,
        truncated: t.truncated || false,
      }))
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  }

  _flushText() {
    clearTimeout(this._textTimer);
    this._textTimer = null;
    if (!this._textBuf) return;
    this.emit('text_delta', { messageId: this.currentMessageId, text: this._textBuf });
    this._textBuf = '';
  }

  _flushThink() {
    clearTimeout(this._thinkTimer);
    this._thinkTimer = null;
    if (!this._thinkBuf) return;
    this.emit('thinking_delta', { messageId: this.currentMessageId, text: this._thinkBuf });
    this._thinkBuf = '';
  }

  // toolNames（toolUseId→name，tool_result 选 cap 用、短命）：正常靠 tool_result 配对 delete + dispose clear
  // 收敛；此处补 LRU 上限（同 toolInputs/toolOutputs 的 TOOL_INPUT_MAX），防异常 SDK 流下大量 tool_use 无
  // 配对 tool_result 时无界增长。删最旧仅在 >40 并发未配对工具的极端场景触发（几乎不可达）。
  rememberToolName(id, name) {
    this.toolNames.set(id, name);
    if (this.toolNames.size > TOOL_INPUT_MAX) {
      this.toolNames.delete(this.toolNames.keys().next().value);
    }
  }

  // ③：缓存文件类工具完整 input（LRU + TTL），供 tool:preview 无损重建 diff（避开 tool_use 的 600 字截断）。
  cacheToolInput(id, name, input) {
    this.toolInputs.set(id, { name, input, ts: Date.now() });
    if (this.toolInputs.size > TOOL_INPUT_MAX) {
      this.toolInputs.delete(this.toolInputs.keys().next().value); // 删最老（Map 保持插入序）
    }
  }
  getToolInput(id) {
    const e = this.toolInputs.get(id);
    if (!e) return null;
    if (Date.now() - e.ts > TOOL_INPUT_TTL_MS) { this.toolInputs.delete(id); return null; }
    return { name: e.name, input: e.input };
  }

  // 工具完整输出缓存：缓存原始结构（raw），返回时红线。live 卡片只推 600 字摘要，
  // 点「展开全文」经 tool:full 取此处。base64 图片等大载荷在返回时被 redactBase64 替换，
  // 防止整串原样进 DOM 打爆手机标签页；纯文本工具输出不受影响。
  // 与 toolInputs 同 TTL/LRU；非文件工具也能展开（Bash/MCP 长输出是主场景）。
  cacheToolOutput(id, raw) {
    if (!id || raw == null) return;
    // 超大载荷（如 base64 图片）不缓存：摘要层已红线，展开也无法展示有意义内容。
    // 用 stringify()（try/catch 兜底）而非裸 JSON.stringify——raw 结构不受本项目控制（MCP/SDK 工具
    // 输出），循环引用等不可序列化值绝不能让这条体积检查抛错打断 map() 消息泵。
    if (stringify(raw).length > 256 * 1024) return;
    this.toolOutputs.set(id, { raw, ts: Date.now() });
    if (this.toolOutputs.size > TOOL_INPUT_MAX) {
      this.toolOutputs.delete(this.toolOutputs.keys().next().value);
    }
  }
  getToolOutput(id) {
    const e = this.toolOutputs.get(id);
    if (!e) return null;
    if (Date.now() - e.ts > TOOL_INPUT_TTL_MS) { this.toolOutputs.delete(id); return null; }
    // 返回时红线：纯文本不受影响（BASE64_REDACT_MIN_LEN=500），base64 载荷被替换
    return stringify(redactBase64(e.raw));
  }

  dispose() {
    this._flushText(); this._flushThink();
    this.toolInputs.clear(); // ③：释放缓存的 tool input
    this.toolOutputs.clear();
    this.toolNames.clear();
    this.disposed = true;
    this.inputEnded = true;
    this.pendingAutoTurn = false; // 实例销毁：作废滞留 flag，防重开实例后误合成
    // dispose 即终态：账面/队列/槽一并收口，不再等 consume 自然退出（swap/externalDirty 窗口里
    // 持有陈旧引用的路径只见 disposed 不够，还可能读到非零 pendingTurns/非空 queue）。
    this.pendingTurns = 0;
    this._openTurns = [];
    this.queue = [];
    this._awaitingInterruptResult = false;
    this.notifyInput?.();
    clearInterval(this.idleTimer); this.idleTimer = null;
    this._clearInterruptSettleWatchdog(); // 实例销毁：不留跨实例悬挂计时
    if (this._textTimer) { clearTimeout(this._textTimer); this._textTimer = null; }
    if (this._thinkTimer) { clearTimeout(this._thinkTimer); this._thinkTimer = null; }
    for (const [id] of this.pendingPermissions) this.resolvePermission(id, 'deny');
    // F2：清理挂起的 AskUserQuestion——与 consume 清理路径一致：先 emit request_resolved 再 resolve，
    // 保证多设备收到问题取消通知（否则前端弹窗永远不消失）
    for (const [toolUseID, pending] of this.pendingQuestions) {
      pending.signal?.removeEventListener('abort', pending.abortHandler);
      if (pending.expiryTimer) clearTimeout(pending.expiryTimer); // AG-001
      for (let i = 0; i < pending.questions.length; i++) {
        this.emit('request_resolved', { requestId: `${toolUseID}#${i}`, kind: 'question', outcome: 'aborted' });
      }
      this.denyKinds.set(toolUseID, 'cancelled');
      pending.resolve({ behavior: 'deny', message: '问题已取消', interrupt: true });
    }
    this.pendingQuestions.clear();
    this.denyKinds.clear(); // 防 dispose 后残留（实例即弃，无 tool_result 来消费）
    this.lastToolName = null;
    this.bgTasks.clear(); // dispose 清空活后台注册表
    this.subagentTypeByParent.clear(); // dispose 清空子 agent 类型缓存（不跨实例串标签）
    try { this.abort?.abort(); } catch { /* noop */ }
  }

  // ---- 事件信封与缓冲 ----
  _ringPush(envelope) {
    const cap = BUFFER_CAP;
    if (cap <= 0) {
      this._ringLen = 0;
      this._bufferView = [];
      return;
    }
    if (this._ringLen < cap) {
      this._ring[(this._ringHead + this._ringLen) % cap] = envelope;
      this._ringLen++;
    } else {
      // 满窗：覆盖最旧槽，head 前移——O(1)，不再 Array.shift
      this._ring[this._ringHead] = envelope;
      this._ringHead = (this._ringHead + 1) % cap;
      this.bufferTrimmed = true;
    }
    this._bufferView = null; // 脏：下次读 buffer getter 时物化
  }

  // 线性视图（插入序最旧→最新）。getter 供单测/eventsSince 与旧 this.buffer 语义兼容。
  get buffer() {
    if (this._bufferView) return this._bufferView;
    const cap = BUFFER_CAP;
    const out = new Array(this._ringLen);
    for (let i = 0; i < this._ringLen; i++) out[i] = this._ring[(this._ringHead + i) % cap];
    this._bufferView = out;
    return out;
  }

  emit(type, payload) {
    assertKnownEventType(type);
    const envelope = {
      seq: ++this.seq,
      epoch: this.epoch,
      sessionId: this.sessionId,
      instanceId: this.instanceId, // 台阶3：事件所属实例，前端分流权威锚点（按 viewingInstanceId）
      cwd: this.cwd,            // 台阶2：事件所属工作目录，台阶3 降为分组/历史属性
      ts: Date.now(),
      type,
      payload
    };
    this._ringPush(envelope);
    this.onEvent(envelope);
  }

  // SDK 里一批带用户可见正文的 system 子类型（informational / mirror_error / notification /
  // model_refusal_* / status.compact_error）统一收敛到 system + kind:'notice' + level。
  // 【为什么不用 error 事件】前端 error(p) 会 finalizeStreams + failPendingToolCards + setBusy(false)，
  // 把这些非终态提示当成回合终点，会错杀正在跑的轮次。notice 只落一条按 level 配色的条。
  // 【为什么不新增 event type】26 种契约表不必为「一段文本 + 一个级别」再开一路；system 已有 kind 分流位。
  // 空正文直接丢弃——宁可无声，也不产一条空白条。
  emitNotice(message, level = 'info') {
    const text = truncate(stringify(message).trim(), TOOL_SUMMARY_CAP);
    if (!text) return;
    this.emit('system', { message: text, kind: 'notice', level });
  }

  // 瞬时事件旁路：广播给前端做即时 UI 更新，但【不进 replay buffer、不递增 seq】。
  // 用于后台任务进度这类高频心跳——进 buffer 会挤爆环形缓冲、占 seq 会制造空洞被 eventsSince 误判为 gap。
  // 语义：重连不重放（进度是瞬时的、旧进度无回放价值；前端按 transient 标志带外分流、不更新 lastSeq）。
  emitTransient(type, payload) {
    assertKnownEventType(type);
    this.onEvent({
      seq: this.seq,            // 复用当前值、不递增：不占序列
      epoch: this.epoch,
      sessionId: this.sessionId,
      instanceId: this.instanceId,
      cwd: this.cwd,
      ts: Date.now(),
      type,
      payload,
      transient: true
    });
  }

  // question 是否仍待回答（权威=pendingQuestions）。已答/已整组结束/非法 id → false。
  // 供 eventsSince 过滤：缓冲里的历史 question 事件在作答后不应再被 sync:since 回放弹窗。
  isQuestionStillPending(requestId) {
    if (typeof requestId !== 'string' || !requestId) return false;
    const hash = requestId.lastIndexOf('#');
    if (hash === -1) return this.pendingQuestions.has(requestId);
    const toolUseID = requestId.slice(0, hash);
    const qIdx = parseInt(requestId.slice(hash + 1), 10);
    const pending = this.pendingQuestions.get(toolUseID);
    if (!pending || Number.isNaN(qIdx) || qIdx < 0 || qIdx >= pending.questions.length) return false;
    return pending.answers[qIdx] === null;
  }

  eventsSince(lastSeq) {
    // pending* 是未决审批/提问的权威真相；环形缓冲里的 permission_request/question 在 resolve 后
    // 仍可能残留。sync:since 若原样回放会把已答提问/已批审批再弹一次（切会话、前台 probe、整页刷新
    // 均走此路径）。过滤掉已不再 pending 的两类事件；其余（含 request_resolved）照常回放。
    const events = this.buffer.filter(e => {
      if (e.seq <= lastSeq) return false;
      if (e.type === 'question') return this.isQuestionStillPending(e.payload?.requestId);
      if (e.type === 'permission_request') {
        const id = e.payload?.requestId;
        return typeof id === 'string' && this.pendingPermissions.has(id);
      }
      return true;
    });
    const oldest = this.buffer.length ? this.buffer[0].seq : this.seq + 1;
    const gap = lastSeq > 0 && this.bufferTrimmed && oldest > lastSeq + 1;
    return { events, gap, epoch: this.epoch };
  }

  // 未决审批/提问快照——供 server 在 sync:since 时让客户端重建卡片。pendingPermissions/pendingQuestions
  // 是权威真相；原始 permission_request/question 事件可能被环形缓冲 trim 或切视图时被前端分流丢弃，仅靠
  // buffer 回放无法保证卡片重建（= 会话列表 ⚠️ 待审批却点进去无卡片）。只读、不改状态；payload 与
  // askPermission 的 emit('permission_request')、handleQuestion 的 emit('question') 逐字段一致（前端复用同一 handler）。
  pendingRequestsSnapshot() {
    const permissions = [];
    for (const [requestId, p] of this.pendingPermissions) {
      // fp（NFR-17 完整性绑定）+ createdAt/expiresAt（FR-22 悬置时长/TTL）：补全字段，兑现上方注释
      // "逐字段一致"的承诺——此前只带 name/input/cwd 三者，切会话重建的卡片会跳过完整性预检
      // （p.fp undefined）且悬置时长/倒计时展示落空，虽不影响后端 fail-closed 门槛（那边独立按
      // requestId 存 fp），但会让前端这条支线体验缺失。
      permissions.push({ requestId, name: p.name, input: p.input, cwd: this.cwd, fp: p.fp, createdAt: p.createdAt, expiresAt: p.expiresAt });
    }
    const questions = [];
    for (const [toolUseID, p] of this.pendingQuestions) {
      for (let i = 0; i < p.questions.length; i++) {
        if (p.answers[i] !== null) continue; // 已答的不补发（切入只重建仍待回答的问题）
        const q = p.questions[i];
        const options = (q.options || []).map(normalizeQuestionOption).filter(o => o.label);
        questions.push({
          requestId: `${toolUseID}#${i}`,
          text: q.question,
          header: q.header ? String(q.header) : undefined,
          multiSelect: Boolean(q.multiSelect),
          options,
          // AG-NEW-001：与 live emit('question') / permissions 快照对称，切会话重建卡片可显 TTL
          createdAt: p.createdAt,
          expiresAt: p.expiresAt,
        });
      }
    }
    return { permissions, questions };
  }

  // ---- SDK 消息 → 契约事件映射 ----
  map(msg) {
    switch (msg.type) {
      case 'system':
        if (msg.subtype === 'init') {
          this.sawInit = true; // F4
          // /clear 等使 CLI 换会话：标题改由新会话首条消息决定（先占位，下条消息回填）
          if (this.sessionId && msg.session_id !== this.sessionId) {
            this.firstMessage = null;
            this.lastUsage = null; // E16：换会话上下文清零，旧 ctx% 不得残留显示
            this.lastRateUnavailableReason = null; // 换会话清零，避免新会话被旧会话的"未变化"误判吞掉首次诊断
            this.lastToolName = null;      // 切换会话清工具名
            this.bgTasks.clear();          // 换会话清空活后台注册表（旧会话后台任务不串到新会话）
            this.pendingToolUses.clear();  // 同理：旧会话在途工具账不串新会话（否则新会话首轮被无依据豁免看护）
            this.subagentTypeByParent.clear(); // 换会话清空子 agent 类型缓存（旧会话子 agent 类型不串到新会话）
          }
          // FRESH 首轮：init 前的日志写在 provisionalKey(instanceId) 下，先并入真 sessionId 再记后续 sys_info。
          const prevLogKey = this.logKey();
          this.sessionId = msg.session_id;
          if (prevLogKey && prevLogKey !== this.sessionId) {
            interactionLog.rebindSessionLogs(prevLogKey, this.sessionId);
            diagLog.rebindDiagLogs(prevLogKey, this.sessionId);
          }
          // 权限档以 SDK init 上报的 msg.permissionMode 为权威「实际生效档」——这是唯一能证明
          // setPermissionMode/ExitPlanMode 等是否真被 SDK 应用的 SDK 源头凭证（模型同理走 msg.model）。
          // bypass 例外：用户档 bypass 时 SDK 实为 default（bypass 由 handleCanUseTool 自放行），保留用户档、
          // 不被 default 覆盖。其余档若 SDK 实际值 ≠ 本地 shadow = 漂移（「我们以为切了、SDK 没应用」那类 bug，
          // 如修复前的 ExitPlanMode）→ 告警 + 留痕交互日志 + 以 SDK 为准对账，使前端图标如实反映 SDK 真值、
          // 内部状态不再分叉。msg.permissionMode 缺失（旧 CLI）则跳过、维持 shadow。
          const sdkMode = msg.permissionMode;
          if (sdkMode && this.permissionMode !== 'bypassPermissions' && sdkMode !== this.permissionMode) {
            console.warn(`[perm-drift] 权限档漂移：本地「${this.permissionMode}」≠ SDK 实际「${sdkMode}」，以 SDK 为准对账`);
            interactionLog.addSessionLog(this.logKey(), 'sys_info',
              `[SYS] ⚠️ 权限档漂移：本地档=${this.permissionMode} ≠ SDK 实际档=${sdkMode}（已以 SDK 为准对账，前端图标随之校正）`);
            this.permissionMode = sdkMode;
          }
          if (msg.model) this.reportedModel = msg.model; // A5：交互日志显真实运行模型，不再记 'default'
          this.onSessionId?.(msg.session_id, this.firstMessage, msg.model);
          this.emit('init', {
            model: msg.model,
            cwd: msg.cwd,
            claudeVersion: msg.claude_code_version,
            mcpServers: msg.mcp_servers,
            skillsCount: msg.skills?.length ?? 0,
            permissionMode: this.permissionMode,  // 已与 SDK init 对账的实际生效档（bypass 例外，仍为用户档）
            slashCommands: msg.slash_commands ?? []
          });
          // F1：fire-and-forget 拉取模型列表（init 到达时兜底；start 中已提前调用，此轮通常幂等）
          this.fetchModels();
        } else if (msg.subtype === 'status' && msg.status === 'compacting' && !msg.compact_error) {
          // !compact_error：万一同一条消息既报 compacting 又带失败原因，别把失败截胡成「正在压缩…」
          this.emit('system', { message: '正在压缩会话上下文…' });
        } else if (msg.subtype === 'compact_boundary') {
          this.emit('system', { message: '上下文已压缩' });
        } else if (msg.subtype === 'task_notification') {
          // 后台任务（Workflow/后台 Agent/后台 Bash）完成的专用 SDK 通道（CLI 交互/SDK 模式）。
          // 通知本身不启轮，但会触发模型自动重调汇报——武装 pendingAutoTurn，待该轮 message_start/assistant 合成 pendingTurns。
          this.pendingAutoTurn = true;
          this.pendingAutoTurnAt = Date.now();
          this.emit('task_notification', {
            source: 'system',
            taskId: msg.task_id ?? null,
            status: msg.status ?? null,
            summary: truncate(stringify(msg.summary), TOOL_SUMMARY_CAP),
            toolUseId: msg.tool_use_id ?? null,
            outputFile: msg.output_file || null
          });
          this.bgTaskDone(msg.task_id ?? msg.taskId ?? null); // 完成：从活后台注册表清除（id 不匹配/缺失则整清，见 bgTaskDone）
        } else if (msg.subtype === 'task_progress') {
          // 后台任务进行中进度。瞬时广播——emitTransient 不进 buffer、不占 seq；不武装 pendingAutoTurn。
          // 字段：description/last_tool_name（tool 活动）+ summary（agentProgressSummaries 时 ~30s AI 短句）。
          // 文案优先：description（即时 tool 态）> message > last_tool > summary（静默期 AI 兜底）。
          // 字段名两读兼容内部/旧形状（taskId/message/task_type）。
          const bgTaskId = msg.task_id ?? msg.taskId ?? null;
          const bgSubagent = msg.subagent_type ?? null;
          const bgTaskType = msg.task_type ?? msg.taskType ?? (bgSubagent ? 'local_agent' : null); // 无 task_type：有 subagent_type 即代理任务 → 🤖
          const bgLastTool = msg.last_tool_name ?? msg.lastToolName ?? null;
          const bgAiSummary = msg.summary != null ? stringify(msg.summary).trim() : '';
          const bgDesc = msg.description
            || (msg.message != null ? stringify(msg.message) : '')
            || bgLastTool
            || bgAiSummary
            || '';
          const bgMessage = truncate(bgSubagent ? `${bgSubagent}：${bgDesc}` : bgDesc, TOOL_SUMMARY_CAP);
          const bgDescTruncated = String(bgDesc).length > TOOL_SUMMARY_CAP;
          this.bgTaskUpsert(bgTaskId, bgTaskType, bgMessage, {
            lastToolName: bgLastTool,
            description: bgDesc ? truncate(String(bgDesc), TOOL_SUMMARY_CAP) : null,
            subagentType: bgSubagent,
            truncated: bgDescTruncated,
          });
          // 附带全量 tasks 快照：前端据此画「跑了哪些任务 + 每条详情」，而非只显示最新一句
          this.emitBgTasksSnapshot({
            taskId: bgTaskId,
            taskType: bgTaskType,
            message: bgMessage,
            description: bgDesc ? truncate(String(bgDesc), TOOL_SUMMARY_CAP) : null,
            lastToolName: bgLastTool,
            subagentType: bgSubagent,
          });
        } else if (msg.subtype === 'background_tasks_changed') {
          // CLI 2.1.209 起后台任务（local_bash/local_agent 等）的权威【全量快照】通道。
          // probe 实证：开始发 tasks=[N]、stopTask/完成发 tasks=[]（全量，非增量）。全量 reconcile
          // bgTasks（快照内 upsert、快照外删除）——修 background bash 从不进 bgTasks 的 bug（旧 map
          // 只认 task_progress，而 background bash 不发它）、供 stopTask 的 taskId、停止/完成自动熄 ⏳。
          // reconcile 末尾 emitBgTasksSnapshot → 前端任务列表与 CLI 权威态对齐。
          this.reconcileBgTasks(msg.tasks);
        } else if (msg.subtype === 'task_started' || msg.subtype === 'task_updated') {
          // 后台任务开始 / 状态变更（task_updated.patch.status: killed/…）的细粒度事件。
          // background_tasks_changed 全量快照紧邻投递、已覆盖增删，故此二者显式识别静默吞——
          // 不重复处理、也不落 else 兜底刷「未映射 system 子类型」交互日志（每个后台任务都会发）。
        } else if (msg.subtype === 'api_retry') {
          // CLI 会在 TUI 显示 "Retrying in Ns · attempt i/max"。web 对齐为瞬时横幅：
          // emitTransient（不进 buffer、不占 seq），前端原地覆盖同一条，避免聊天流堆重试行。
          // 字段名兼容 SDK 官方（retry_delay_ms/max_retries）与旧测试/投递（delay_ms）。
          this.emitTransient('api_retry', {
            attempt: typeof msg.attempt === 'number' ? msg.attempt : null,
            maxRetries: typeof msg.max_retries === 'number' ? msg.max_retries : null,
            delayMs: typeof msg.retry_delay_ms === 'number' ? msg.retry_delay_ms
              : (typeof msg.delay_ms === 'number' ? msg.delay_ms : null),
            errorStatus: msg.error_status == null ? null : msg.error_status,
            error: msg.error ?? null,
          });
        } else if (msg.subtype === 'informational') {
          // 通用文本横幅（level: info/notice/suggestion/warning）。CLI 会在终端显示，web 同步。
          this.emitNotice(msg.content, msg.level === 'warning' ? 'warning' : 'info');
        } else if (msg.subtype === 'mirror_error') {
          // transcript 落盘失败：不影响本轮对话，但会让「刷新后历史缺失」，属必须让用户知道的降级。
          this.emitNotice(msg.error, 'warning');
        } else if (msg.subtype === 'notification') {
          // 严重度只认 color，【不能用 priority 推】——实测 CLI bundle 里两者正交：priority:"immediate"
          // 出现 53 次仅 5 次带 color（大量是「Fast mode is now available」这类普通公告），
          // priority:"high" 26 次一次都不带 color，反而 priority:"medium" 有带 color:"warning" 的。
          // sdk.d.ts 亦写明 priority 属「REPL notification queue (key/priority/timeout)」的队列语义。
          this.emitNotice(msg.text, msg.color === 'error' ? 'error' : (msg.color === 'warning' ? 'warning' : 'info'));
        } else if (msg.subtype === 'model_refusal_fallback' || msg.subtype === 'model_refusal_no_fallback') {
          // 拒绝原因（api_refusal_explanation）是关键诊断信息——user-facing content 常常只说「已回落」。
          this.emitNotice(
            [stringify(msg.content).trim(), stringify(msg.api_refusal_explanation).trim()].filter(Boolean).join('：'),
            'warning',
          );
        } else if (msg.subtype === 'status' && msg.compact_error) {
          // 压缩失败。上面的 compacting 分支判据是 status==='compacting'，compact_result:'failed' 会漏掉。
          this.emitNotice(msg.compact_error, 'warning');
        } else if (typeof msg.subtype === 'string' && (msg.subtype.startsWith('hook_') || msg.subtype === 'thinking_tokens')) {
          // 已知生命周期/进度噪声——显式识别后静默吞，不落交互日志抽屉（否则连续刷屏）、
          // 不进 buffer、不启轮、不广播。这不违背下面「不静默蒸发」的初衷：那条是给【未知】子类型兜底的，
          // 这里是我们已认出并有意丢弃。需观察原始投递时用 DEBUG_SDK_MESSAGES=1 看 [sdk-msg] 裸流。
          //   · hook_*（hook_started/hook_progress/hook_response，后者高频）：SessionStart 等钩子生命周期
          //   · thinking_tokens：推理 token 计数心跳（每条 +1~3，单轮几十上百条，纯进度无展示价值）
          // api_retry 已上提到独立分支（有展示价值）。若日后某个子类型有展示价值，在此分支之上单独加 else if。
        } else {
          // 未识别的 system 子类型不再静默蒸发：记入交互日志抽屉，保留可观测性（本次通知丢失的教训）
          interactionLog.addSessionLog(this.logKey(), 'sys_info', `[SYS] 未映射 system 子类型: ${msg.subtype ?? '(空)'}`);
        }
        break;

      case 'stream_event': {
        const ev = msg.event;
        if (msg.parent_tool_use_id) {
          // 子 agent 流式增量：独立 emit（带 parentToolUseId），【不碰主 agent buffer/state】防污染主线正文。
          // forwardSubagentText:true 下 SDK 才投递子 agent 的 text/thinking delta——移动端子 agent 可见的实时来源。
          if (ev?.type === 'content_block_delta') {
            const subType = this.subagentTypeByParent.get(msg.parent_tool_use_id) ?? null; // assistant 已 set 则补类型标签；未 set（首批 delta 早于 assistant）→ null，前端后续补
            if (ev.delta?.type === 'text_delta' && ev.delta.text) {
              this.emit('text_delta', { messageId: msg.uuid, text: ev.delta.text, parentToolUseId: msg.parent_tool_use_id, subagentType: subType });
            } else if (ev.delta?.type === 'thinking_delta' && ev.delta.thinking) {
              this.emit('thinking_delta', { messageId: msg.uuid, text: ev.delta.thinking, parentToolUseId: msg.parent_tool_use_id, subagentType: subType });
            }
          }
          break;
        }
        if (ev.type === 'message_start') {
          this.maybeSynthesizeAutoTurn(); // 后台任务触发的非用户轮：轮次开始即合成 pendingTurns
          this.currentMessageId = ev.message?.id || msg.uuid;
          this.sawTextDelta = false;
          this.assistantResponseBuffer = '';
          this._msgOutBase = 0; // 新 message：output_tokens 累计水位归零（turn 内跨 message 续累计）
        } else if (ev.type === 'content_block_delta') {
          if (ev.delta?.type === 'text_delta' && ev.delta.text) {
            this.sawTextDelta = true;
            this.assistantResponseBuffer += ev.delta.text;
            this._textBuf += ev.delta.text;
            if (this._textBuf.length >= 2048) {
              this._flushText();
            } else if (!this._textTimer) {
              this._textTimer = setTimeout(() => this._flushText(), 20);
            }
          } else if (ev.delta?.type === 'thinking_delta' && ev.delta.thinking) {
            this._thinkBuf += ev.delta.thinking;
            if (this._thinkBuf.length >= 2048) {
              this._flushThink();
            } else if (!this._thinkTimer) {
              this._thinkTimer = setTimeout(() => this._flushThink(), 20);
            }
          }
        } else if (ev.type === 'message_delta' && ev.usage) {
          // E16：流式 message_delta 的 usage 常只有 output_tokens（见 agent-events 单测 fixture）。
          // 合并进 lastUsage，禁止整对象覆盖把 input/cache 抹成 0（statusline uncached 0 / left 假满窗）。
          this.lastUsage = mergeMessageUsage(this.lastUsage, ev.usage);
          // per-turn 输出 token：message 内 usage.output_tokens 是累计值，对水位取增量（防同 message 重复计）
          const out = Number.isFinite(ev.usage.output_tokens) ? ev.usage.output_tokens : 0;
          this.turnOutputTokens += Math.max(0, out - this._msgOutBase);
          this._msgOutBase = Math.max(this._msgOutBase, out);
          // 此处只更新 lastUsage 供 ctx% 即时刷新（不等 assistant 边界）
          this.onUsage?.();
        }
        break;
      }

      case 'assistant': {
        this._flushText(); this._flushThink();
        // 子 agent（Task 工具内部）消息分流：emit tool_use（带 parentToolUseId+subagentType）供移动端嵌套展示。
        // 【必须在 msg.error 判断之前分流并 break】——子 agent 自己的一次 API 报错（如限流）只属于该子 agent，
        // 绝不能走下面主会话 error 分支误报（code-review P0）。子 agent 正文/thinking 走 stream_event 分流，
        // 故此处只取 tool_use（避免与流式文本重复 emit）；也【不】碰 pendingTurns/usage（那是主轮口径）。
        if (msg.parent_tool_use_id) {
          const subType = msg.subagent_type ?? null;
          // 记住该子 agent 的类型：后续 stream_event（delta）/ user（tool_result）都不带 subagent_type，靠此缓存补标签。
          // 非 null 保护：一旦记住有效类型，不被后续不带 subagent_type 的同 parent 消息抹成 null。
          if (subType != null) this.subagentTypeByParent.set(msg.parent_tool_use_id, subType);
          // msg.error：子 agent 自身 API 失败【仍不发 error 事件】——前端 error(p) 会 setBusy(false)，
          // 会把主轮次一起杀掉（这就是这道 P0 守卫的由来）。但也不能像从前那样整条吞掉：子 agent 被限流
          // 时手机端会完全无感，只看到卡片停在那里。改走 notice（只落一条带级别的条，不动 busy 态），
          // 正文透传上游原文（SDK 已加 "API Error:" 前缀），枚举桶仅在 content 缺失时兜底。
          // 也不把错误正文当 text_delta 灌进折叠卡 body。
          if (msg.error) {
            const detail = asArray(msg.message?.content)
              .filter(b => b?.type === 'text' && b.text)
              .map(b => b.text).join('\n').trim();
            const who = subType ? `子 agent ${subType}` : '子 agent';
            this.emitNotice(`${who}：${detail || `API 错误：${msg.error}`}`, 'warning');
            break;
          }
          for (const block of msg.message?.content ?? []) {
            if (block.type === 'text' && block.text) {
              this.emit('text_delta', {
                messageId: msg.uuid,
                text: block.text,
                parentToolUseId: msg.parent_tool_use_id,
                subagentType: subType,
              });
            } else if (block.type === 'thinking' && block.thinking) {
              this.emit('thinking_delta', {
                messageId: msg.uuid,
                text: block.thinking,
                parentToolUseId: msg.parent_tool_use_id,
                subagentType: subType,
              });
            } else if (block.type === 'tool_use') {
              this.rememberToolName(block.id, block.name);
              let file; // E2：子 agent 内文件工具也要缓存 input + file 字段，否则嵌套预览永不可用
              if (FILE_TOOLS.has(block.name)) {
                const pth = toolFilePath(block.input);
                if (pth) {
                  this.cacheToolInput(block.id, block.name, block.input);
                  const stats = estimateMutationLineStats(block.name, block.input);
                  file = {
                    path: truncate(String(pth), 1024),
                    changeKind: TOOL_CHANGE_KIND[block.name],
                    added: stats.added,
                    removed: stats.removed,
                  };
                }
              }
              this.emit('tool_use', {
                toolUseId: block.id,
                name: block.name,
                inputSummary: truncate(stringify(redactBase64(block.input)), TOOL_SUMMARY_CAP),
                parentToolUseId: msg.parent_tool_use_id,
                subagentType: subType,
                ...(file ? { file } : {}),
              });
            }
          }
          break;
        }
        if (msg.error) {
          // msg.error 只是 SDK 归类枚举桶（unknown/rate_limit/invalid_request/…），不是上游原文；
          // 真正的上游报文在 message.content 文本块里（SDK 已加 "API Error:" 前缀）。终端等价 =
          // 上游返回什么显示什么，故透传 content 原文；枚举桶仅在 content 意外缺失时兜底。
          const detail = asArray(msg.message?.content)
            .filter(b => b?.type === 'text' && b.text)
            .map(b => b.text).join('\n').trim();
          this.emit('error', { message: detail || `API 错误：${msg.error}`, recoverable: true });
          // ⚠️ 此处【不】减 pendingTurns——整套配平依赖「轮⇒result 假设」：每个已启动轮次恰好产出一个
          // result（成功/报错/被中断都算），由随后的 result 事件减掉本轮。若某 SDK/网关版本把终态 API 错误
          // 只发 assistant{error} 不发 result，pendingTurns 会泄漏 → 排队提示早一轮 / idle 仍 busy（idle
          // 看护 idleTimeoutMs 后 abort 兜底、但活跃交互会一直刷新 lastActivity 使其不触发）。见 test
          // 'agent.test.mjs 回归锚点(轮⇒result 假设)'——该假设一破即红，作 CLI 升级预警。
          break;
        }
        this.maybeSynthesizeAutoTurn(); // 非流式网关无 message_start，assistant 边界兜底合成（flag 已被 message_start 消费则 no-op）
        // E16：单次 API 调用口径的 usage（stream_event 在非流式网关缺席、result.usage 轮内聚合高估 ctx）；
        // subagent 消息已被上方 parent_tool_use_id 守卫排除
        if (msg.message?.usage) {
          // 完整帧通常带齐字段；仍走合并，避免网关残缺帧抹掉此前 cache 读/写
          this.lastUsage = mergeMessageUsage(this.lastUsage, msg.message.usage); // 单轮口径（ctx% / in:out:w:r:）
          // per-turn 输出 token 兜底：非流式网关无 message_delta，在 assistant 边界补增量；
          // 流式路径 message_delta 已计到同水位 → 增量为 0 不双计。message 收尾，水位归零。
          const out = msg.message.usage.output_tokens || 0;
          this.turnOutputTokens += Math.max(0, out - this._msgOutBase);
          this._msgOutBase = 0;
          this.onUsage?.(); // E16：assistant 边界即刷 statusline ctx（不等 result/10s tick）
        }
        const mid = this.currentMessageId || msg.uuid;
        for (const block of msg.message?.content ?? []) {
          if (block.type === 'tool_use') {
            this.lastToolName = block.name; // 跟踪最后使用的工具名，供后台 tab 角标细化
            let file; // ③：文件类工具附未截断 path + changeKind + 行统计，并缓存完整 input 供预览
            if (FILE_TOOLS.has(block.name)) {
              const p = toolFilePath(block.input);
              if (p) {
                this.cacheToolInput(block.id, block.name, block.input);
                const stats = estimateMutationLineStats(block.name, block.input);
                file = {
                  path: truncate(String(p), 1024),
                  changeKind: TOOL_CHANGE_KIND[block.name],
                  added: stats.added,
                  removed: stats.removed,
                };
              }
            }
            this.rememberToolName(block.id, block.name);
            this.pendingToolUses.set(block.id, Date.now()); // 静默看护豁免起点：工具在跑 = 本轮在推进
            this.emit('tool_use', {
              toolUseId: block.id,
              name: block.name,
              inputSummary: truncate(stringify(redactBase64(block.input)), TOOL_SUMMARY_CAP),
              file
            });
          } else if (block.type === 'text' && block.text && !this.sawTextDelta) {
            // 网关不流式时用完整 assistant 文本兜底
            this.assistantResponseBuffer += block.text;
            this.emit('text_delta', { messageId: mid, text: block.text });
          }
        }
        break;
      }

      case 'user': {
        if (msg.parent_tool_use_id) {
          // 子 agent 的 tool_result 分流（带 parentToolUseId + subagentType）供移动端嵌套展示——
          // 【必须在主 <task-notification> 注入判断之前分流并 break】：子 agent 消息不发主任务自动汇报注入。
          // 不带 denyKind：那是主会话审批（deny+message 通道，requestId===toolUseID）的语义，子 agent 内部
          // 工具结果未经 canUseTool 闸门、无审批语义。raw/脱敏/截断复用主 tool_result 同一形态（见下方主分支）。
          const subType = this.subagentTypeByParent.get(msg.parent_tool_use_id) ?? null;
          for (const block of asArray(msg.message?.content)) {
            if (block?.type === 'tool_result') {
              const raw = msg.tool_use_result ?? block.content;
              this.cacheToolOutput(block.tool_use_id, raw);        // 缓存原始结构，getToolOutput 返回时红线
              const fullRedacted = stringify(redactBase64(raw));    // 摘要层红线（结构层递归替换嵌套 base64）
              const cap = toolResultCap(this.toolNames.get(block.tool_use_id));
              this.toolNames.delete(block.tool_use_id);
              const outputSummary = truncate(fullRedacted, cap);
              this.emit('tool_result', {
                toolUseId: block.tool_use_id,
                ok: !block.is_error,
                outputSummary,
                truncated: fullRedacted.length > cap,
                parentToolUseId: msg.parent_tool_use_id,
                subagentType: subType,
              });
            }
          }
          break;
        }
        // 后台任务完成后，CLI 以 user 角色消息注入 <task-notification> XML 触发模型自动汇报。
        // 实证：content 常是纯字符串（终端 jsonl），旧代码只遍历数组 → 全丢。这里两种形态都拍平识别。
        const content = msg.message?.content;
        const flat = typeof content === 'string'
          ? content
          : asArray(content).filter(b => b?.type === 'text' && b.text).map(b => b.text).join('\n');
        // 要求成对闭合，降低误伤：用户若随口发以裸 <task-notification> 开头的消息（少含闭合标签）不误判为注入。
        if (flat.trimStart().startsWith('<task-notification>') && flat.includes('</task-notification>')) {
          this.pendingAutoTurn = true; // 武装：轮次真正开始时合成 pendingTurns（不直接 ++，见构造函数注释）
          this.pendingAutoTurnAt = Date.now();
          const pick = tag => new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(flat)?.[1]?.trim() ?? null;
          this.emit('task_notification', {
            source: 'user_injection',
            taskId: pick('task-id'),
            status: pick('status'),
            summary: truncate(pick('summary') ?? '', TOOL_SUMMARY_CAP),
            toolUseId: pick('tool-use-id'),
            outputFile: pick('output-file')
          });
          // BUG-1 修复：pick('task-id') 为 null 时跳过 bgTaskDone——缺 <task-id> 的 <task-notification>
          // 不应触发 null→clear() 清空全部在跑后台任务。整清兜底仅留给 bgTaskDone 直接调用方（SDK
          // system/task_notification 路径，41/41 实测必带 task_id）。user 注入走正则提取、可靠性低一档。
          const doneTaskId = pick('task-id');
          if (doneTaskId != null) this.bgTaskDone(doneTaskId);
          break; // 注入消息不含 tool_result，独立分支返回
        }
        for (const block of asArray(msg.message?.content)) {
          if (block?.type === 'tool_result') {
            const raw = msg.tool_use_result ?? block.content;
            // denyKind：deny+message 通道（审批拒绝/取消、AskUserQuestion 作答/取消）的真实语义，
            // 这类结果 is_error=true 但非工具报错——前端据此显 ☑️/🚫 并剥 "Error:" 前缀，不靠字符串匹配。
            const denyKind = this.denyKinds.get(block.tool_use_id);
            this.denyKinds.delete(block.tool_use_id);
            this.cacheToolOutput(block.tool_use_id, raw);        // 缓存原始结构，getToolOutput 返回时红线
            const fullRedacted = stringify(redactBase64(raw));    // 摘要层红线（结构层递归替换嵌套 base64）
            const cap = toolResultCap(this.toolNames.get(block.tool_use_id));
            this.toolNames.delete(block.tool_use_id);
            this.pendingToolUses.delete(block.tool_use_id); // 工具收工，豁免销账
            const outputSummary = truncate(fullRedacted, cap);
            this.emit('tool_result', {
              toolUseId: block.tool_use_id,
              ok: !block.is_error,
              outputSummary,
              truncated: fullRedacted.length > cap,
              denyKind
            });
          }
        }
        break;
      }

      case 'result': {
        this._flushText(); this._flushThink();
        // settle 槽优先：forceSettled 迟到 result 不 --pendingTurns（watchdog/settleForce 已清账）
        this._settleOneResultTurn();
        // 本轮收表：账面仍有在途轮（后台任务合成轮等）→ 立即重开；否则清零（status_line 不再带 turn 段）
        if (this.pendingTurns > 0) { this.turnStartedAt = Date.now(); } else { this.turnStartedAt = null; }
        this.turnOutputTokens = 0;
        this._msgOutBase = 0;
        this.lastToolName = null; // 清空工具名跟踪
        // 在途前台工具随本轮收尾清账：工具不可能跨轮存活。中断/审批取消时 tool_result 可能永不回来，
        // 只靠上面的 delete 会留下残条目，让下一轮被无依据地豁免看护。
        this.pendingToolUses.clear();
        if (typeof msg.total_cost_usd === 'number') this.totalCostUsd = msg.total_cost_usd;
        this.totalDurationMs += msg.duration_ms || 0;
        this.totalApiDurationMs += msg.duration_api_ms || 0;
        const wasInterrupted = this._awaitingInterruptResult; // P1-4：一次性消费，防误标到后续无关的 result
        this._awaitingInterruptResult = false;
        this._clearInterruptSettleWatchdog(); // 配对 result 已到：撤销兜底，否则悬挂计时会误清后续轮次的账
        diagLog.record(this.logKey(), 'queue', 'turn_settled', {
          pendingTurnsAfter: this.pendingTurns, wasInterrupted, isError: !!msg.is_error, durationMs: msg.duration_ms,
        });
        this.emit('result', {
          messageId: this.currentMessageId,
          durationMs: msg.duration_ms,
          costUsd: msg.total_cost_usd,
          isError: msg.is_error,
          errors: msg.subtype === 'success' ? undefined : msg.errors,
          models: Object.keys(msg.modelUsage ?? {}), // F1：语义断言用
          text: this.assistantResponseBuffer || undefined, // 完整回复文本：供前端断网恢复后校正截断的 s.raw
          interrupted: wasInterrupted // 这条 result 是否由用户主动中止直接导致（区别于独立的真实错误/完成）
        });
        const { model: modelStr, effort: effortStr, permissionMode: permStr } = this.logMeta(); // 统一解析，消除与 send 的漂移
        const durationStr = `[result] ${msg.subtype} duration=${msg.duration_ms}ms`; // model/effort/permission 走独立 chip 字段，不再进文本
        const responseText = this.assistantResponseBuffer ? `${durationStr}\n${this.assistantResponseBuffer}` : durationStr;
        interactionLog.agentResult(this.logKey(), responseText, modelStr, effortStr, permStr);
        this.assistantResponseBuffer = '';
        this.currentMessageId = null;
        this.sawTextDelta = false;
        break;
      }

      case 'rate_limit_event': {
        // 只有 rejected 才上屏——额度真耗尽、下一条消息发不出去，用户必须知道。
        // allowed / allowed_warning 的额度百分比已有 status_line.rate 专用通道，重复上屏是噪音。
        const info = msg.rate_limit_info || {};
        if (info.status === 'rejected') {
          this.emitNotice(`已达${RATE_LIMIT_LABELS[info.rateLimitType] || '用量'}上限`, 'warning');
        }
        break;
      }

      default:
        // 未映射的 SDK 消息类型不再静默蒸发：记入交互日志抽屉（三重 cap，无膨胀风险），保留可观测性
        interactionLog.addSessionLog(this.logKey(), 'sys_info', `[SYS] 未映射 SDK 消息 type=${msg.type ?? '(空)'}`);
        break;
    }
  }

  // 后台任务通知触发的"非用户输入轮次"：轮次真正开始（message_start/assistant）时把 pendingTurns 合成到 1，
  // 让 busy 显示、result 正常回落、checkIdle 看护、后台 tab 角标、busy→done 推送全部免费接回。
  // flag 门控（只在 pendingAutoTurn 时合成）：避免 auto-compact 等内部 fork 泄漏 message_start 却无 result 导致 busy 永挂。
  // TTL 门：滞留 flag（通知到达却无紧邻自动汇报）超 AUTO_TURN_ARM_TTL_MS 即失效清除，不让无关的 message_start 误合成。
  maybeSynthesizeAutoTurn() {
    if (!this.pendingAutoTurn) return;
    if (Date.now() - this.pendingAutoTurnAt >= AUTO_TURN_ARM_TTL_MS) { this.pendingAutoTurn = false; return; } // 超时作废
    if (this.pendingTurns === 0) {
      this._openTurnSlot();
      this.pendingTurns = 1;
      this.pendingAutoTurn = false;
      this.turnStartedAt = Date.now(); this.turnOutputTokens = 0; this._msgOutBase = 0; // 合成轮同样开表
    }
  }

  // 交互日志缓冲键：有真 sessionId 用它；FRESH 首轮 init 前用 provisionalKey(instanceId)。
  // 与 interactionLog.rebindSessionLogs 配对——init 到真 id 后把 provisional 缓冲并入。
  logKey() {
    return this.sessionId || interactionLog.provisionalKey(this.instanceId);
  }

  // 交互日志的模型/思考强度/权限档三元组（单一来源，供 send/result 共用）。
  // 模型解析：activeModel（本轮目标）> reportedModel（SDK init 上报的真实运行模型）> defaultModel（会话原模型）> 'default'。
  // 消除 send 用 defaultModel、result 用字面量 'default' 的漂移（同轮日志曾可能记出两个不同模型名）。
  logMeta() {
    return {
      model: this.activeModel || this.reportedModel || this.defaultModel || 'default',
      // UI/日志显 ultracode；SDK 实际 effort 仍是 this.effort（xhigh）
      effort: this.ultracode ? 'ultracode' : (this.effort || 'model-default'),
      permissionMode: this.permissionMode || 'default'
    };
  }
}

function toolResultCap(name) {
  const n = String(name || '');
  if (n === 'Bash' || n === 'bash' || n === 'run_command' || n === 'Shell') return TOOL_SUMMARY_CAP_BASH;
  return TOOL_SUMMARY_CAP;
}

// 从完整 tool input 估 +/- 行（与前端 summarize 同源口径：块级行数，非精细 diff）。
function estimateMutationLineStats(name, input = {}) {
  const lines = (t) => {
    if (t == null) return 0;
    const s = String(t);
    return s ? s.split('\n').length : 0;
  };
  if (name === 'Edit') return { added: lines(input?.new_string), removed: lines(input?.old_string) };
  if (name === 'MultiEdit') {
    const edits = Array.isArray(input?.edits) ? input.edits : [];
    let added = 0, removed = 0;
    for (const e of edits) {
      added += lines(e?.new_string);
      removed += lines(e?.old_string);
    }
    return { added, removed };
  }
  if (name === 'Write') return { added: lines(input?.content), removed: 0 };
  if (name === 'NotebookEdit') return { added: lines(input?.new_source), removed: 0 };
  return { added: 0, removed: 0 };
}

function asArray(v) {
  return Array.isArray(v) ? v : [];
}
