// agent.js —— claude 会话桥：
// 每个会话 = 一个长驻 SDK query（streaming input 模式，interrupt/canUseTool 可用），
// SDK 消息 → agent:event 统一信封，seq 单调 + 环形缓冲。
import { query } from '@anthropic-ai/claude-agent-sdk';
import * as interactionLog from './interaction-log.js';
import { sanitize } from './sanitizer.js';
import { fingerprintSync, verifyIntegritySync } from './fingerprint.js';
import * as approvalStore from './approval-store.js';

const BUFFER_CAP = 500;       // 环形缓冲条数
const TOOL_SUMMARY_CAP = 600; // 工具卡片摘要截断；permission_request 永不截断（4a）
// ③：文件类工具——tool_use 额外缓存完整 input（供预览无损重建 diff）+ emit 未截断 path（供前端给预览入口）。
const FILE_TOOLS = new Set(['Edit', 'Write', 'Read', 'MultiEdit', 'NotebookEdit']);
const TOOL_INPUT_TTL_MS = 10 * 60 * 1000; // 缓存 input 存活 10 分钟
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
const BG_TASK_TTL_MS = 180000;       // 活的后台任务（bgTasks）无心跳的失效期（3min）：SDK getProgressMessage 无增量时不推，
                                     // 心跳可能稀疏——取值须宽于最大真实心跳间隔，防误清仍在跑的静默任务。漏收完成信号时它是主力清除。
const DEFAULT_APPROVAL_TTL_MS = 1800000; // 审批悬置默认上限 30min（部署可配置，见 server.js APPROVAL_TTL_MS；
                                          // LLD §3.5.2/OQ-05 已决：不预置具体数值，此为实现落地的合理默认）

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

export class AgentSession {
  constructor({ instanceId, resumeId, cwd, claudeBin, model, permissionMode, effort, idleTimeoutMs, approvalTtlMs, onEvent, onSessionId, onExit, onUsage, onBgTaskChange, historicalCostUsd }) {
    // 台阶3：进程内唯一、永不变的实例句柄。前端按 viewingInstanceId 分流（新会话 init 前
    // sessionId=null，故分流/路由用 instanceId 而非 sessionId）。server 生成并传入（inst_${n}）。
    this.instanceId = instanceId;
    this.cwd = cwd;
    this.claudeBin = claudeBin;
    this.idleTimeoutMs = idleTimeoutMs;
    this.approvalTtlMs = Number(approvalTtlMs) > 0 ? Number(approvalTtlMs) : DEFAULT_APPROVAL_TTL_MS; // 审批悬置上限（部署可配置）
    this.onEvent = onEvent;           // (envelope) => void，由 server 广播
    this.onSessionId = onSessionId;   // (sessionId, firstMessage, model) => void，登记 sessions.json
    this.onExit = onExit;             // () => void，进程意外退出/挂死自杀时通知 server 置空
    this.onUsage = onUsage;           // () => void，assistant message（含工具调用间）更新 usage 后触发——驱动 statusline 实时刷 ctx；不进事件流、不占 seq/buffer
    this.onBgTaskChange = onBgTaskChange; // () => void，活的后台任务集合"空↔非空/成员增删"时触发——驱动 server 节流重算会话列表 ⏳ 角标

    this.sessionId = resumeId || null;
    this.resumeId = resumeId || null;   // F4：resume 失败检测基准
    this.sawInit = false;               // F4：init 事件到达置 true；未到即结束 → resume 失败
    this.resumeFailed = false;          // F4：onExit 时通知 server 清当前会话，打破死循环
    this.epoch = nextEpoch();
    this.seq = 0;
    this.buffer = [];
    this.toolInputs = new Map(); // ③：toolUseId → {name, input, ts}（文件类工具完整 input，供 tool:preview 重建 diff）
    this.bufferTrimmed = false;
    this.pendingTurns = 0;             // 在途轮数，仅由 send(+1) 与 result(-1) 改写
    this.pendingAutoTurn = false;      // 后台任务通知已到、下个轮次由非用户输入（task-notification 注入）启动的信号——
                                       // 轮次真正开始（message_start/assistant）时合成 pendingTurns=1，让 busy/看护/角标接回。
                                       // 只武装 flag 不直接 ++：N 条通知未必对应 N 轮（合并轮会卡死 busy → checkIdle 误杀）。
    this.pendingAutoTurnAt = 0;        // flag 武装时刻（Date.now）：合成前校验未超 AUTO_TURN_ARM_TTL_MS，防滞留 flag 长尾误触发。
    this._awaitingInterruptResult = false; // P1-4：interrupt() 成功后置真，标记"下一条 result 是这次中断的终态确认"
                                            // ——一次性消费。不能靠嗅探 SDK 的 result.subtype（如 'error_during_execution'）
                                            // 反推"是不是用户中断"：该 subtype 是"执行过程中出错"的泛化分类，与
                                            // error_max_turns/error_max_budget_usd 同级，也可能是真实的独立异常。
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
    // F1：defaultModel = 启动时配置的模型（会话原模型，sessions.json 指针——唯一来源）。
    // 消息不带 model（"默认"）时 target 回退到它，而非 SDK 裸默认——否则空选择会把
    // 配置的网关模型 setModel(undefined) 重置掉（实测：init 从 mimo 变成 opus 并报错）。
    this.defaultModel = model || undefined;
    this.activeModel = model || undefined;   // 当前生效模型，差分决定是否调 setModel
    // A5：init 报告的真实运行模型名，仅供交互日志显示真实生效模型（不入 activeModel——否则 fresh 会话
    // 下条空发会 target=undefined≠activeModel → setModel(undefined) 把网关模型重置，即 F1 事故）
    this.reportedModel = null;
    // 当前权限档（default/plan/acceptEdits/bypassPermissions/dontAsk），可运行时切；差分决定是否调 setPermissionMode
    // dontAsk = 非交互严格档：白名单外终端层直接 deny、不走 canUseTool（手机不弹窗），sdkPermissionMode 原样透传（不映射）
    this.permissionMode = permissionMode || 'default';
    // 思考强度档（spawn 时注入 --effort），null=模型默认不传。运行时不可改——
    // SDK 无 effort 控制请求，切档由 server 置换实例（dispose + 下条消息懒重生 resume）
    this.effort = effort || null;

    // E16 statusline 数据源（server 构造脚本 stdin 时只读，不进事件契约）：
    this.lastUsage = null;        // 最近主线程 assistant 的 message.usage（ctx 占用口径）
    this.historicalCostUsd = historicalCostUsd || 0; // 以前各次会话连接/恢复历史的累计成本
    this.totalCostUsd = 0;        // result.total_cost_usd 最新值（SDK 已是会话累计，勿 +=）
    this.totalDurationMs = 0;     // += result.duration_ms（活跃轮次累计，非墙钟——实例懒重生不暴露给用户）
    this.totalApiDurationMs = 0;  // += result.duration_api_ms（增量 = 脚本 cache-TTL 段的活动信号）
    // E16 reused 指标 + 缓存失效倒计时数据源（皆从 assistant.usage.cache_read 派生）：
    this.totalCacheReadTokens = 0; // += cache_read_input_tokens —— 本会话累计复用 token（区别于 lastUsage 的单轮覆盖口径）
    this.lastCacheHitAt = 0;       // 最后一次 cache_read>0 的 Date.now()；statusline 据此推算 ephemeral cache 失效 deadline，每次命中滑动重置
    this.currentTask = null;      // 当前活跃的 Agent/Task 工具描述（tool_use 设，result/dispose 清）——供 statusline 显示
    this.lastToolName = null;     // 最后使用的工具名（Bash/Agent/Write 等），供后台 tab 角标细化
    this.bgTasks = new Map();     // 活的后台任务注册表 key → { taskType, message, lastSeenAt }——task_progress upsert / 完成 or TTL 清；驱动"纯后台运行中"⏳
    // 子 agent 类型缓存 parent_tool_use_id → subagent_type：probe 实证只有 assistant 消息带 subagent_type，
    // stream_event（text/thinking delta）与 user（tool_result）都不带。缓存供后二者补标签——否则纯文本子 agent
    // （无 tool_use、只走 stream_event）的卡片永远没有 🤖 类型名。换会话/dispose 清空，不跨会话/实例串标签。
    this.subagentTypeByParent = new Map();

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
          session_id: this.sessionId || ''
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
      options: {
        cwd: this.cwd,
        pathToClaudeCodeExecutable: this.claudeBin, // E9：用本机 claude，不用 SDK 捆绑副本
        model: this.activeModel || undefined,
        resume: this.sessionId || undefined,
        abortController: this.abort,
        includePartialMessages: true,                        // E4 流式
        forwardSubagentText: true,                           // 子 agent 正文/thinking 转发进主流（带 parent_tool_use_id），移动端才看得到子 agent 活动；默认 false 只给 tool_use 心跳
        effort: this.effort || undefined,                    // SDK 0.3+ 一等 Options.effort（low/medium/high/xhigh/max，与终端 /effort 同旋钮）。null=模型默认不传
        permissionMode: this.sdkPermissionMode(),            // bypass 映射为 SDK default（bypass 放行由 handleCanUseTool 自实现）
        // 不注入 options.allowedTools（2026-06-22 解耦）：放行白名单完全交给 settingSources 加载的
        // .claude/settings.json 的 permissions.allow（与终端 claude 同源、用户自管），投屏层不再耦合自家白名单。
        // 实测 SDK 把 settings 的 allow 当「自动放行、不触发 canUseTool」的第一层；未命中即触发下方 canUseTool。
        canUseTool: (name, input, opts) => this.handleCanUseTool(name, input, opts), // 白名单外统一闸门
        settingSources: ['user', 'project', 'local'],        // 加载"我的"全部配置
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        env: Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== '')),
        stderr: data => { if (process.env.LOG_STDERR) console.error('[claude]', sanitize(data)); }
      }
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
        // F4：resume 失败（CLI 端 session 已失效）——无论优雅结束还是抛错，均明确提示并设
        // resumeFailed 让 server 清 currentSessionId，打破"重试→resume 同一失效 id→循环"死锁
        this.resumeFailed = true;
        this.emit('error', {
          message: '无法恢复会话（历史可能已被清理），请新建会话或从列表选择其他会话',
          recoverable: false
        });
      } else if (caught) {
        this.emit('error', { message: `会话异常：${sanitize(caught.message)}`, recoverable: true });
      } else {
        this.emit('error', { message: 'claude 进程已退出，可重新发送消息继续', recoverable: true });
      }
    }
    // 清理（无论正常结束/抛错/resume 失败都执行；异常已被上方 catch 收口，不会跳过）
    clearInterval(this.idleTimer); this.idleTimer = null;
    this.pendingTurns = 0;
    this.pendingAutoTurn = false; // 实例结束不留滞留 flag，防重开实例后残留状态误合成
    this.bgTasks.clear();         // 实例结束清空活后台注册表，防残留误亮 ⏳
    for (const [id] of this.pendingPermissions) this.resolvePermission(id, 'deny');
    // F2：清理挂起的 AskUserQuestion（直接 resolve，不走 resolveQuestion 避免重复逻辑）
    for (const [toolUseID, pending] of this.pendingQuestions) {
      pending.signal?.removeEventListener('abort', pending.abortHandler);
      for (let i = 0; i < pending.questions.length; i++) {
        this.emit('request_resolved', { requestId: `${toolUseID}#${i}`, kind: 'question', outcome: 'aborted' });
      }
      pending.resolve({ behavior: 'deny', message: '问题已取消', interrupt: true });
    }
    this.pendingQuestions.clear();
    this.denyKinds.clear(); // 与 dispose 路径对称：无论哪种退出，denyKind 残留都应清理
    if (!this.disposed) this.onExit?.();
  }

  // ---- 对外操作 ----
  // F1：model 变化时调 setModel()（SDKUserMessage.model 被 CLI 忽略，此为唯一有效切换路径）
  // E17：opts.displayText/attachments——附件场景下 text=注入路径后的 promptText（送 SDK），
  // displayText=原文（气泡 + 会话标题，不含路径），attachments=去完整 data 的元数据（含小 thumb）。
  async send(text, model, opts = {}) {
    if (this.pendingTurns >= 2) {
      this.emit('system', { message: '前面还有消息在排队，请等当前任务结束' });
      return false;
    }
    const displayText = opts.displayText ?? text;

    // 空选择（"默认"）回退到 defaultModel，不是 SDK 裸默认——只有真正切换才调 setModel。
    // setModel 是 await 让出点，之后须重检 disposed/pendingTurns（S3 + 双重检查）。
    const target = model || this.defaultModel;
    if (target !== this.activeModel) {
      try {
        await this.q?.setModel(target);
        this.activeModel = target;
      } catch (err) {
        this.emit('error', { message: `模型切换失败（${err.message}），已用原模型发送`, recoverable: true });
      }
    }

    if (this.disposed) return false; // S3：setModel 的 await 间隙实例可能已被 dispose，勿再往弃用实例排队
    // 双重检查：setModel await 期间其他 send 可能已把 pendingTurns 推到上限
    if (this.pendingTurns >= 2) {
      this.emit('system', { message: '前面还有消息在排队，请等当前任务结束' });
      return false;
    }

    // #2：确认能发送（过了 disposed + 双重检查）后才记 firstMessage、emit user_message 气泡、记日志——
    // 否则拒绝路径会把气泡推上屏却没真正发送（用户以为发了、实际被拒）。
    if (this.firstMessage === null) this.firstMessage = displayText;
    this.emit('user_message', { text: displayText, attachments: opts.attachments }); // F3 + E17：入缓冲并广播，多设备/重载后均可回放
    // 日志模型/effort/perm 走统一 logMeta()（消除 send vs result 的模型解析漂移，见 logMeta 注释）。
    // 日志键走 logKey()：FRESH 首轮 sessionId 未到时用 provisional，init 后 rebind，避免首跳蒸发。
    const { model: metaModel, effort: effortStr, permissionMode: permStr } = this.logMeta();
    interactionLog.userMessageOut(this.logKey(), displayText, metaModel, effortStr, permStr); // 交互日志：server → client（user_message 广播）
    this.pendingTurns++;
    // model/effort/permission 各走独立 chip 字段（text 不再内联），日志逐条显示「那一刻」的具体模型 + 档位
    interactionLog.agentSend(this.logKey(), text, metaModel, effortStr, permStr); // 交互日志：agent → SDK（text=promptText 含路径）
    this.queue.push({ text });
    this.notifyInput?.();
    this.lastActivity = Date.now(); // 续期静默看护：send 是用户活动，防 idle 误判
    return true;
  }

  async interrupt() {
    this._flushText(); this._flushThink();
    this.pendingAutoTurn = false; // 用户显式停止：作废任何待合成的后台自动汇报轮
    // S7：先同步把队列「换成新空数组」并快照旧队列——await q.interrupt() 是让出点，期间用户若在
    // 「点停止后、中断未完成」时又发消息，该消息会 push 进新队列，不被本次中断卷入丢弃；
    // toDrop 才是本次要丢的「中断发起时已排队」。修原竞态：旧实现 await 后才 this.queue=[]，
    // 会连 await 间隙新发的一起清空（静默丢消息）+ pendingTurns 按旧 dropped 少扣。
    const toDrop = this.queue;
    const dropped = toDrop.length;
    this.queue = [];
    try {
      await this.q?.interrupt();
      if (this.disposed) return; // S3：await 间隙实例可能已被 dispose，勿往弃用实例发事件
      // 成功中断：丢弃 toDrop（中断前排队的），pendingTurns 减 dropped；await 期间新发的留在 this.queue。
      this.pendingTurns = Math.max(0, this.pendingTurns - dropped);
      this._awaitingInterruptResult = true; // 真中断了在途任务：SDK 消息流即将吐出对应的终态 result
      this.emit('system', { message: '已中断', kind: 'interrupted' }); // M7：kind 字段，勿靠字符串匹配
    } catch {
      // SDK 无在途任务 → 不丢消息：把 toDrop 放回队列头部（await 期间新发的接其后），pendingTurns 不动。
      this.queue = toDrop.concat(this.queue);
      this.emit('system', { message: '当前没有可中断的任务' });
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
      await this.q.stopTask(taskId);
      return true;
    } catch {
      return false; // SDK 无该任务 / 已结束：静默吞（幂等）
    }
  }

  // ③ 套餐额度窗数据源：调 SDK 实验性 usage RPC（session 成本 + claude.ai 套餐额度利用率窗）。带超时
  // （照 statusline getContextUsageSafe 1500ms 模式：cold RPC 可能慢，不阻塞调用方）——超时 / 无 q / 无该
  // 方法（旧 CLI / 网关不支持）/ 抛错一律返回 null 降级（server 侧 parseUsageForWeb(null) → available:false 隐藏额度窗）。
  // 只取原始对象、解析交给纯函数 parseUsageForWeb：运行时结构比 .d.ts 富且标记 EXPERIMENTAL_MAY_CHANGE、会漂。
  async fetchUsage(timeoutMs = 1500) {
    if (typeof this.q?.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET !== 'function') return null;
    try {
      return await Promise.race([
        this.q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('usage timeout')), timeoutMs)),
      ]);
    } catch { return null; }
  }

  // 权限档切换（与 send 的 setModel 同型，差分——仅档位真变才调 SDK）。
  // 成功后由 server 广播 permission_mode 合成事件（不走 emit/seq 流，符合本服务事件契约）。
  // 给 SDK 的 permissionMode——bypass 映射为 default。SDK 原生 bypassPermissions 需危险全局
  // flag（allowDangerouslySkipPermissions），那会连 default 审批一起跳过；bypass 改由 handleCanUseTool 放行。
  sdkPermissionMode() {
    return this.permissionMode === 'bypassPermissions' ? 'default' : this.permissionMode;
  }

  async setPermissionMode(mode) {
    const VALID = ['default', 'plan', 'acceptEdits', 'bypassPermissions', 'dontAsk', 'auto']; // 'auto'：SDK 用模型分类器自动批准/拒绝权限请求
    if (!VALID.includes(mode)) {
      this.emit('error', { message: `未知权限档：${mode}`, recoverable: true });
      return false;
    }
    if (mode === this.permissionMode) return true; // 差分：无变化不调 SDK
    const sdkMode = mode === 'bypassPermissions' ? 'default' : mode;
    try {
      await this.q?.setPermissionMode(sdkMode);
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
    // 审批 TTL（LLD §3.5.2/§4，承接 OQ-05）：createdAt=悬置起点，expiresAt=过期时刻；
    // 事件携带二者供前端未来展示悬置时长/倒计时（FR-22），即使本轮不接 UI 也先备好契约字段。
    const createdAt = Date.now();
    const expiresAt = createdAt + this.approvalTtlMs;
    // 审批完整性绑定（LLD §3.1.3/§5.5，承接 AD-7/NFR-17，"所批即所行"）：canUseTool 收到 op 的这一刻
    // 就是完整性锚点的源头——op={tool,args,cwd} 越晚计算，越可能与用户最终看到/批准的内容脱节。
    // 指纹随 permission_request 下发供手机端渲染前重算比对（协议步骤4）；resolvePermission 收到客户端
    // 回传的 op 后重算比对本处存的 fp（协议步骤6），不一致 fail-closed 拒绝。用同步 fingerprintSync
    // （node:crypto）而非前端那份异步 crypto.subtle 版本——askPermission/resolvePermission 必须保持
    // 同步：调用方（含既有测试）习惯不 await 就紧接着同步调 resolvePermission，插入一次 await 会在
    // pendingPermissions.set() 真正执行前的窗口让 resolvePermission 扑空、返回的 Promise 永远不 resolve。
    const fp = fingerprintSync({ tool: name, args: input, cwd: this.cwd });
    this.emit('permission_request', { requestId, name, input, cwd: this.cwd, fp, createdAt, expiresAt });
    // 持久化台账（LLD §4 approval_request 表，承接 NFR-16/19/22，Phase 4）：只是台账记录，写入失败
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
      signal.addEventListener('abort', abortHandler);
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
    // 审批完整性绑定（LLD §3.1.3 步骤6/§5.5，承接 AD-7/NFR-17，"所批即所行"）：仅在 allow 时校验——
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
    const questions = input?.questions;
    if (!Array.isArray(questions) || questions.length === 0) {
      return { behavior: 'allow', updatedInput: input };
    }
    return new Promise(resolve => {
      const answers = new Array(questions.length).fill(null);
      let remaining = questions.length;
      const abortHandler = () => {
        if (this.pendingQuestions.delete(toolUseID)) {
          for (let i = 0; i < questions.length; i++) {
            this.emit('request_resolved', { requestId: `${toolUseID}#${i}`, kind: 'question', outcome: 'aborted' }); // M4
          }
          this.denyKinds.set(toolUseID, 'cancelled'); // 取消≠已回答：前端显 🚫 而非 ☑️
          resolve({ behavior: 'deny', message: '问题已取消', interrupt: true });
        }
      };
      // createdAt：供 AD-11/§3.2.5 AttentionDeriver 的"等我输入"悬置起点（waitingSince），镜像 pendingPermissions 已有的 createdAt 模式。
      this.pendingQuestions.set(toolUseID, { resolve, questions, answers, remaining, signal, abortHandler, createdAt: Date.now() });

      for (let i = 0; i < questions.length; i++) {
        const q = questions[i];
        // 对齐 CLI：保留 header / multiSelect / option.description|preview，前端才能完整呈现
        const options = (q.options || []).map(normalizeQuestionOption).filter(o => o.label);
        this.emit('question', {
          requestId: `${toolUseID}#${i}`,
          text: q.question,
          header: q.header ? String(q.header) : undefined,
          multiSelect: Boolean(q.multiSelect),
          options,
        });
      }

      signal?.addEventListener('abort', abortHandler);
    });
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

    if (pending.remaining === 0) {
      // 移除 abort 监听器防僵尸累积
      pending.signal?.removeEventListener('abort', pending.abortHandler);
      this.pendingQuestions.delete(toolUseID);
      this.lastActivity = Date.now(); // 用户答题是主动操作，续期静默看护
      const msg = '用户选择了：' + pending.answers.map(a => `「${a}」`).join('、');
      this.emit('request_resolved', { requestId: toolUseID, kind: 'question', outcome: msg }); // M4
      this.denyKinds.set(toolUseID, 'answered'); // 已回答：前端显 ☑️（is_error 来自 deny 通道、非真错误）
      pending.resolve({ behavior: 'deny', message: msg, interrupt: false });
    }
  }

  // ---- 静默看护（4c）：等审批不计时；活动静默超限判挂死 ----
  checkIdle() {
    // 后台任务 TTL 清扫须在下方 pendingTurns===0 提前返回之前——后台任务运行时 pendingTurns 正是 0，
    // 放 return 之后就永远清不到（漏收完成信号的任务会把 ⏳ 永挂）。清出变化即回调重算角标。
    if (this.sweepBgTasks()) this.onBgTaskChange?.();
    if (this.pendingTurns === 0) return;
    if (this.pendingPermissions.size > 0 || this.pendingQuestions.size > 0) {
      this.lastActivity = Date.now();
      return;
    }
    if (Date.now() - this.lastActivity > this.idleTimeoutMs) {
      this.emit('error', {
        message: `任务静默超过 ${Math.round(this.idleTimeoutMs / 60000)} 分钟，已中断（可重新发送继续）`,
        recoverable: true
      });
      this.terminating = true;
      try { this.abort?.abort(); } catch { /* noop */ }
    }
  }

  // ---- 活的后台任务注册表（Workflow / 后台 Agent / 后台 Bash）----
  // SDK 对每个 running 后台任务周期性推 task_progress 心跳（实测 ~5-10s/次）→ upsert 刷新 lastSeenAt；
  // 完成走 system task_notification / <task-notification> user 注入 → bgTaskDone。实测（生产日志）完成信号可靠带 task_id、
  // 且与心跳 id 一致（含 workflow 用自身启动 id 报进度与完成）→ 精确删是主力清除。TTL(sweepBgTasks) 为兜底：清「未及心跳
  // 就完成的快任务」（其完成 id 不在表→bgTaskDone 天然 no-op）与漏收的完成信号。size 变化才回调 onBgTaskChange（稳态同 id 心跳只刷时间戳、不广播——节流关键）。
  bgTaskUpsert(taskId, taskType, message) {
    const key = taskId ?? `__notask_${taskType ?? 'x'}`; // taskId 缺失用稳定合成键，避免 null 键互相覆盖多任务
    const prev = this.bgTasks.get(key);
    const type = taskType ?? null;
    this.bgTasks.set(key, { taskType: type, message: message ?? '', lastSeenAt: Date.now() });
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
    else this.bgTasks.clear(); // 仅 null/undefined（真无 id 注入）才整清兜底：仍在跑者下拍心跳（≤~10s）即复亮，比 180s TTL 收敛快
    if (this.bgTasks.size !== had) this.onBgTaskChange?.();
  }
  sweepBgTasks() { // 惰性 TTL：超 BG_TASK_TTL_MS 无心跳即判失效清除。由 checkIdle 的 30s tick 驱动，返回是否清出过
    if (this.bgTasks.size === 0) return false;
    const now = Date.now();
    let removed = false;
    for (const [k, t] of this.bgTasks) if (now - t.lastSeenAt > BG_TASK_TTL_MS) { this.bgTasks.delete(k); removed = true; }
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
      this.bgTasks.set(id, {
        taskType: t.task_type ?? t.taskType ?? prev?.taskType ?? null,
        message: truncate(String(t.description ?? prev?.message ?? ''), TOOL_SUMMARY_CAP),
        lastSeenAt: Date.now(),
      });
    }
    for (const k of [...this.bgTasks.keys()]) if (!seen.has(k)) this.bgTasks.delete(k);
    if (this.bgTasks.size !== had) this.onBgTaskChange?.();
  }

  hasBgTasks() { return this.bgTasks.size > 0; }
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

  dispose() {
    this._flushText(); this._flushThink();
    this.toolInputs.clear(); // ③：释放缓存的 tool input
    this.disposed = true;
    this.inputEnded = true;
    this.pendingAutoTurn = false; // 实例销毁：作废滞留 flag，防重开实例后误合成
    this.notifyInput?.();
    clearInterval(this.idleTimer); this.idleTimer = null;
    for (const [id] of this.pendingPermissions) this.resolvePermission(id, 'deny');
    // F2：清理挂起的 AskUserQuestion——与 consume 清理路径一致：先 emit request_resolved 再 resolve，
    // 保证多设备收到问题取消通知（否则前端弹窗永远不消失）
    for (const [toolUseID, pending] of this.pendingQuestions) {
      pending.signal?.removeEventListener('abort', pending.abortHandler);
      for (let i = 0; i < pending.questions.length; i++) {
        this.emit('request_resolved', { requestId: `${toolUseID}#${i}`, kind: 'question', outcome: 'aborted' });
      }
      this.denyKinds.set(toolUseID, 'cancelled');
      pending.resolve({ behavior: 'deny', message: '问题已取消', interrupt: true });
    }
    this.pendingQuestions.clear();
    this.denyKinds.clear(); // 防 dispose 后残留（实例即弃，无 tool_result 来消费）
    this.currentTask = null;
    this.lastToolName = null;
    this.bgTasks.clear(); // dispose 清空活后台注册表
    this.subagentTypeByParent.clear(); // dispose 清空子 agent 类型缓存（不跨实例串标签）
    try { this.abort?.abort(); } catch { /* noop */ }
  }

  // ---- 事件信封与缓冲 ----
  emit(type, payload) {
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
    this.buffer.push(envelope);
    if (this.buffer.length > BUFFER_CAP) {
      this.buffer.shift();
      this.bufferTrimmed = true;
    }
    this.onEvent(envelope);
  }

  // 瞬时事件旁路：广播给前端做即时 UI 更新，但【不进 replay buffer、不递增 seq】。
  // 用于后台任务进度这类高频心跳——进 buffer 会挤爆环形缓冲、占 seq 会制造空洞被 eventsSince 误判为 gap。
  // 语义：重连不重放（进度是瞬时的、旧进度无回放价值；前端按 transient 标志带外分流、不更新 lastSeq）。
  emitTransient(type, payload) {
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

  eventsSince(lastSeq) {
    const events = this.buffer.filter(e => e.seq > lastSeq);
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
            this.totalCacheReadTokens = 0; // E16：reused 是本会话累计 → 换会话清零（与 lastUsage 同步）
            this.lastCacheHitAt = 0;       // 倒计时起点随之清零，避免旧会话 deadline 串到新会话
            this.currentTask = null;       // 切换会话清任务名，旧任务不残留
            this.lastToolName = null;      // 切换会话清工具名
            this.bgTasks.clear();          // 换会话清空活后台注册表（旧会话后台任务不串到新会话）
            this.subagentTypeByParent.clear(); // 换会话清空子 agent 类型缓存（旧会话子 agent 类型不串到新会话）
          }
          // FRESH 首轮：init 前的日志写在 provisionalKey(instanceId) 下，先并入真 sessionId 再记后续 sys_info。
          const prevLogKey = this.logKey();
          this.sessionId = msg.session_id;
          if (prevLogKey && prevLogKey !== this.sessionId) {
            interactionLog.rebindSessionLogs(prevLogKey, this.sessionId);
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
        } else if (msg.subtype === 'status' && msg.status === 'compacting') {
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
          // 后台任务「进行中」的周期性进度心跳（SDK 对每个 running 任务持续推送，高频）。
          // 瞬时广播给前端原地刷新进度横幅——走 emitTransient 而非 emit：不进 replay buffer、不占 seq
          // （高频，进 buffer 会挤爆环形缓冲 / seq 空洞误判 gap）；不武装 pendingAutoTurn（进度不启汇报轮，
          // 完成信号仍走上面的 task_notification）；更不落下面的 else 记「未映射」。
          // 实测生产日志（DEBUG_SDK_MESSAGES）真实投递字段 = task_id / description / subagent_type / last_tool_name / usage，
          // 【无 task_type、无 message】。旧代码读 msg.message → 恒 undefined → 进度横幅恒空（"看不到活动"的第二元凶）。
          // 故文案优先真实 description（如 "Reading app.js" / "Synthesize: synthesize"，正是用户想看的"在干嘛"）；
          // 字段名两读兼容内部/旧形状（taskId/message/task_type）防投递层版本差异。
          const bgTaskId = msg.task_id ?? msg.taskId ?? null;
          const bgSubagent = msg.subagent_type ?? null;
          const bgTaskType = msg.task_type ?? msg.taskType ?? (bgSubagent ? 'local_agent' : null); // 无 task_type：有 subagent_type 即代理任务 → 🤖
          const bgDesc = msg.description || (msg.message != null ? stringify(msg.message) : '') || msg.last_tool_name || stringify(msg.summary) || '';
          const bgMessage = truncate(bgSubagent ? `${bgSubagent}：${bgDesc}` : bgDesc, TOOL_SUMMARY_CAP);
          this.bgTaskUpsert(bgTaskId, bgTaskType, bgMessage); // 注册"活的后台任务"→ 驱动纯后台 busy 角标（⏳/🤖/🖥）+ 横幅进度文案
          this.emitTransient('task_progress', { taskId: bgTaskId, taskType: bgTaskType, message: bgMessage });
        } else if (msg.subtype === 'background_tasks_changed') {
          // CLI 2.1.209 起后台任务（local_bash/local_agent 等）的权威【全量快照】通道。
          // probe 实证：开始发 tasks=[N]、stopTask/完成发 tasks=[]（全量，非增量）。全量 reconcile
          // bgTasks（快照内 upsert、快照外删除）——修 background bash 从不进 bgTasks 的 bug（旧 map
          // 只认 task_progress，而 background bash 不发它）、供 stopTask 的 taskId、停止/完成自动熄 ⏳。
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
          // E16：流式模式下从 message_delta 提取 usage（SDK 在此事件返回 input/cache tokens）
          this.lastUsage = ev.usage;
          // 不累加 totalCacheReadTokens——assistant 事件会携带同一轮的 usage 再报一次，
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
          for (const block of msg.message?.content ?? []) {
            if (block.type === 'tool_use') {
              this.emit('tool_use', {
                toolUseId: block.id,
                name: block.name,
                inputSummary: truncate(stringify(redactBase64(block.input)), TOOL_SUMMARY_CAP),
                parentToolUseId: msg.parent_tool_use_id,
                subagentType: subType,
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
          this.lastUsage = msg.message.usage; // 单轮口径（ctx% / in:w:r:）
          const cr = msg.message.usage.cache_read_input_tokens || 0;
          if (cr > 0) { this.totalCacheReadTokens += cr; this.lastCacheHitAt = Date.now(); } // E16：累计复用量 + 记命中墙钟（倒计时起点，滑动重置）
          this.onUsage?.(); // E16：assistant 边界即刷 statusline ctx（不等 result/10s tick）
        }
        const mid = this.currentMessageId || msg.uuid;
        for (const block of msg.message?.content ?? []) {
          if (block.type === 'tool_use') {
            if (block.name === 'Agent') this.currentTask = block.input?.description || null;
            this.lastToolName = block.name; // 跟踪最后使用的工具名，供后台 tab 角标细化
            let file; // ③：文件类工具附未截断 path + changeKind，并缓存完整 input 供预览
            if (FILE_TOOLS.has(block.name)) {
              const p = toolFilePath(block.input);
              if (p) {
                this.cacheToolInput(block.id, block.name, block.input);
                file = { path: truncate(String(p), 1024), changeKind: TOOL_CHANGE_KIND[block.name] };
              }
            }
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
              this.emit('tool_result', {
                toolUseId: block.tool_use_id,
                ok: !block.is_error,
                outputSummary: truncate(stringify(redactBase64(raw)), TOOL_SUMMARY_CAP),
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
          this.bgTaskDone(pick('task-id')); // 完成：从活后台注册表清除（id 缺失/不匹配则整清，见 bgTaskDone）
          break; // 注入消息不含 tool_result，独立分支返回
        }
        for (const block of asArray(msg.message?.content)) {
          if (block?.type === 'tool_result') {
            const raw = msg.tool_use_result ?? block.content;
            // denyKind：deny+message 通道（审批拒绝/取消、AskUserQuestion 作答/取消）的真实语义，
            // 这类结果 is_error=true 但非工具报错——前端据此显 ☑️/🚫 并剥 "Error:" 前缀，不靠字符串匹配。
            const denyKind = this.denyKinds.get(block.tool_use_id);
            this.denyKinds.delete(block.tool_use_id);
            this.emit('tool_result', {
              toolUseId: block.tool_use_id,
              ok: !block.is_error,
              outputSummary: truncate(stringify(redactBase64(raw)), TOOL_SUMMARY_CAP),
              denyKind
            });
          }
        }
        break;
      }

      case 'result':
        this._flushText(); this._flushThink();
        this.pendingTurns = Math.max(0, this.pendingTurns - 1);
        this.currentTask = null; // 任务完成/结束即清
        this.lastToolName = null; // 清空工具名跟踪
        if (typeof msg.total_cost_usd === 'number') this.totalCostUsd = msg.total_cost_usd;
        this.totalDurationMs += msg.duration_ms || 0;
        this.totalApiDurationMs += msg.duration_api_ms || 0;
        const wasInterrupted = this._awaitingInterruptResult; // P1-4：一次性消费，防误标到后续无关的 result
        this._awaitingInterruptResult = false;
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
      this.pendingTurns = 1;
      this.pendingAutoTurn = false;
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
      effort: this.effort || 'model-default',
      permissionMode: this.permissionMode || 'default'
    };
  }
}

function truncate(s, cap) {
  if (typeof s !== 'string') return '';
  return s.length > cap ? s.slice(0, cap) + ' …（已截断）' : s;
}

function stringify(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}

// 长 base64/二进制载荷脱敏（Read 读图片等场景，tool_result 会带回原始字节供模型"看见"图片）：
// 不猜 SDK 具体字段名（同 file-preview.js 的二进制探测思路，防 SDK 版本漂移改字段名致失效）——
// 整串纯 base64 字符集且达到阈值长度才判定；真实代码/路径/命令几乎不可能连续 500+ 字符不含
// 空白或标点，故不会误伤 Edit/Write 预览 diff。脱敏须在 truncate() 之前，否则大 base64 会把
// TOOL_SUMMARY_CAP 截断额度提前占满，挤掉真正有用的字段。
const BASE64_REDACT_MIN_LEN = 500;
const BASE64_ONLY_RE = /^[A-Za-z0-9+/]+={0,2}$/;
function redactBase64(value) {
  if (typeof value === 'string') {
    if (value.length >= BASE64_REDACT_MIN_LEN && BASE64_ONLY_RE.test(value)) {
      return `（base64 数据，约 ${Math.ceil(value.length / 1024)}KB，已省略）`;
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(redactBase64);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) out[k] = redactBase64(value[k]);
    return out;
  }
  return value;
}

function asArray(v) {
  return Array.isArray(v) ? v : [];
}
