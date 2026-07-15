// app.js —— 契约客户端：agent:event 渲染 + 审批弹窗 + epoch 感知续传。
// 纯决策逻辑（effort 档位 / 状态聚合 / ANSI / esc）抽到 logic.js，浏览器 import + node:test 共用。
/* global io, marked, DOMPurify, hljs */
import { esc, formatToolSummary, toolPreviewLabel, effortLevelsFor, effortUiState, resolvePanelState, aggregateStates, summarizeOtherWorkspaces, projectDisplayName, shouldShowStartScreen, shouldRestoreOptimisticBusy, planSessionDraftSwap, foregroundReconnectAction, syncAckAction, shouldReloadOnEnter, sessionDomCachePlan, keyboardInsetPadding, logEntryVisibleForInstance, consoleLogEntryLayout, defaultModelTileLabel, withUltracodeKeyword, withUltracodeTier, resolveEffortSelection, resolveDeepLinkTarget, armedTakeoverStep, presentTurnResult, detectServiceRestart, formatServiceNotices, shouldSendOnEnter, summarizeInstanceStates, whatNeedsAttention, userBubbleFold, mergeRecentSessionsAcrossWorkspaces, isSubagentPayload, formatSubagentCardTitle, isToolSummaryTruncated, formatMirrorBannerText, formatUsageWindowLines } from './logic.js';
import { verifyIntegrity } from './canonicalize.js';
import { createAppContext } from './app/context.js';
import { createClientLogger } from './app/client-log.js';
import { createAlertController } from './app/alerts.js';
import { createAttachmentController } from './app/attachments.js';
import { createRttMonitor } from './app/connection-sync.js';
import { createMessageRenderer } from './app/message-renderer.js';
import { createAgentEventDispatcher } from './app/event-dispatch.js';
import { createFileBrowser } from './app/file-browser.js';
import { createSettingsController } from './app/settings.js';
import { createNotificationController } from './app/notifications.js';
import { createTaskStatusController } from './app/task-status.js';
import { createSessionWorkspaceState } from './app/session-workspaces.js';
import { createInteractionQueueState } from './app/approval-questions.js';
(() => {
  // ---- token 注入（4a：#token= → localStorage → 立即清地址栏）----
  const hashMatch = location.hash.match(/#token=(.+)/);
  if (hashMatch) {
    localStorage.setItem('auth_token', decodeURIComponent(hashMatch[1]));
    history.replaceState(null, '', location.pathname);
  }
  let token = localStorage.getItem('auth_token') || '';

  // ---- 设备指纹生成与获取 (TOFU) ----
  let deviceToken = localStorage.getItem('device_token');
  if (!deviceToken) {
    const array = new Uint8Array(16);
    if (window.crypto && window.crypto.getRandomValues) {
      window.crypto.getRandomValues(array);
    } else {
      for (let i = 0; i < 16; i++) array[i] = Math.floor(Math.random() * 256);
    }
    deviceToken = Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
    localStorage.setItem('device_token', deviceToken);
  }

  // ---- DOM ----
  const $ = id => document.getElementById(id);
  const messagesEl = $('messages'), inputEl = $('input'), statusEl = $('statusLine'), connDot = $('connDot'), connRttEl = $('connRtt'), connDotWrap = $('connDotWrap');
  const btnSend = $('btnSend'), btnStop = $('btnStop'), btnNew = $('btnNew'), btnHome = $('btnHome'), btnSessions = $('btnSessions');
  const activeStatusPill = $('activeStatusPill'), activeStatusText = $('activeStatusText'), btnStopNew = $('btnStopNew');
  const activityBanner = $('activityBanner'), activityBannerText = $('activityBannerText');
  const mirrorBanner = $('mirrorBanner'), btnMirrorOverride = $('btnMirrorOverride');
  const mirrorBannerText = $('mirrorBannerText'), mirrorBannerIcon = $('mirrorBannerIcon'), btnMirrorSync = $('btnMirrorSync');
  const taskProgressBanner = $('taskProgressBanner'), taskProgressText = $('taskProgressText'), btnTaskStop = $('btnTaskStop');
  let pendingUsageRender = null; // 额度窗一次消费：usage:get 后等 agent:event type=usage
  const sessionPanel = $('sessionPanel');
  const sessionsDot = $('sessionsDot');  // 台阶2 Step B：后台目录动静汇总角标

  // ---- 极简触觉交互及抽屉式元素 DOM 绑定 ----
  const sidebarScrim = $('sidebarScrim'), leftSidebar = $('leftSidebar'), sidebarClose = $('sidebarClose');
  const btnSettings = $('btnSettings'), settingsScrim = $('settingsScrim'), settingsSheet = $('settingsSheet'), settingsClose = $('settingsClose');
  const pillModel = $('pillModel'), pillModelText = $('pillModelText');
  const pillPerm = $('pillPerm'), pillPermText = $('pillPermText'), pillEffort = $('pillEffort'), pillEffortText = $('pillEffortText');
  const topContextPill = $('topContextPill'), topTitleText = $('topTitleText'), topProjectText = $('topProjectText');
  const customModelGrid = $('customModelGrid'), customPermGrid = $('customPermGrid'), customEffortGrid = $('customEffortGrid'), customEffortGroup = $('customEffortGroup');

  const modelInput = $('modelInput');   // 模型 select：候选由 models 事件填充；任意名走 /model 拦截动态插入
  const cliStatusEl = $('cliStatus');   // E16：web 状态栏容器（status_line 事件填充，原生 DOM 结构化渲染非 ANSI）
  const cliStatusWrapEl = $('cliStatusWrap'); // E16：状态栏折叠包裹（<details>，揭示=去 hidden）
  const cliSummaryEl = $('cliSummary'); // E16：折叠条一行摘要（客户端据 status_line 字段拼出）
  const permModeSelect = $('permModeSelect');  // 权限档切换器（6 档：default/plan/acceptEdits/dontAsk/auto/bypass；dontAsk+auto 终端交互切不到，属 setPermissionMode/agent 能力）
  const effortSelect = $('effortSelect');      // 思考强度档切换器（档位按当前模型 supportedEffortLevels 动态渲染）
  const effortRow = $('effortRow');            // effort 整行容器：当前模型不支持 effort（如 haiku）时隐藏
  const btnAttach = $('btnAttach'), fileInput = $('fileInput'), attachTray = $('attachTray'); // E17：附件
  const attachPreviewModal = $('attachPreviewModal'), attachPreviewImg = $('attachPreviewImg'),
        attachPreviewName = $('attachPreviewName'), attachPreviewClose = $('attachPreviewClose');
  // ultracode 已从独立按钮并入「思考」档最高档（见 rebuildEffortOptions / ultracodeArmed），不再取独立按钮
  const btnPush = $('btnPush'); // E15：推送订阅入口
  // 候选之外的模型名（/model 手设、或重建时需保留的当前值）插入为带标注的 option
  function ensureModelOption(value, note) {
    if ([...modelInput.options].some(o => o.value === value)) return;
    const opt = document.createElement('option');
    opt.value = value;
    // 原样透传（2026-06-15）：标签即裸名/SDK 值，不再叠加项目友好名映射。
    opt.textContent = note ? `${value}（${note}）` : value;
    modelInput.appendChild(opt);

    // 同时也加到自定义模型网格中以保证同步和完备性
    // WS-007：value 可能含引号/反斜杠/方括号（用户自定义模型名或恶意服务端下发）。用 CSS.escape 保护属性选择器
    // （否则 querySelector 抛 DOMException、留半更新 UI），用 DOM API + textContent + dataset 构造卡片、绝不把原值
    // 插进 CSS selector 或 HTML 串。
    if (customModelGrid && !customModelGrid.querySelector(`[data-model="${CSS.escape(value)}"]`)) {
      const card = el(`
        <div class="model-tile p-2.5 rounded-xl border border-line bg-surface active:bg-sunk cursor-pointer transition-all">
          <div class="text-xs font-semibold truncate text-ink"></div>
          <div class="text-[9.5px] text-ink-soft truncate mt-0.5"></div>
        </div>
      `);
      card.dataset.model = value;                 // 属性走 dataset，不进 HTML 串
      const [nameDiv, noteDiv] = card.children;   // 两个内层 div，textContent 赋值（自动转义）
      nameDiv.textContent = value;
      noteDiv.textContent = note || '当前加载模型';
      card.onclick = () => {
        if (mirrorReadonlySid) { addBar('终端驾驶中，设置已冻结——接管后可调', 'text-info'); return; } // 单驾驶员：驾驶期设置冻结
        haptic('tap');
        modelInput.value = value;
        syncModelUI(value);
      };
      customModelGrid.appendChild(card);
    }
  }
  const permModal = $('permModal'), permTool = $('permTool'), permCwd = $('permCwd'),
        permInput = $('permInput'), permAlways = $('permAlways'), permIntegrityWarn = $('permIntegrityWarn'),
        permExitModeWrap = $('permExitModeWrap');
  const questionModal = $('questionModal'), questionText = $('questionText'), questionOptions = $('questionOptions'),
        questionHeader = $('questionHeader'), questionMultiHint = $('questionMultiHint'),
        questionMultiSubmit = $('questionMultiSubmit'),
        questionSkip = $('questionSkip'), questionOtherToggle = $('questionOtherToggle'),
        questionOtherPanel = $('questionOtherPanel'), questionOtherInput = $('questionOtherInput'),
        questionOtherSubmit = $('questionOtherSubmit');
  const permInterrupt = $('permInterrupt');
  // ExitPlanMode 退出后权限档（对齐 CLI plan-exit）；默认 default
  let selectedExitMode = 'default';
  // multiSelect 当前题勾选的下标
  let multiSelectedIndexes = new Set();
  const deleteSessionModal = $('deleteSessionModal'), deleteSessionTitle = $('deleteSessionTitle'), deleteL1Btn = $('deleteL1Btn'), deleteL2Btn = $('deleteL2Btn'), deleteSessionCancel = $('deleteSessionCancel');
  const authGate = $('authGate'), authToken = $('authToken'), authSubmit = $('authSubmit'), authError = $('authError'); // 访问令牌输入页
  const accessRelogin = $('accessRelogin'), accessReloginBtn = $('accessReloginBtn'); // Access 会话过期重登浮层
  // 远程设备审批 + 访问帮助 UI
  const deviceRequests = $('deviceRequests'); // 已信任设备上的待审批请求卡片栈
  const deviceDenied = $('deviceDenied'), deviceDeniedRetry = $('deviceDeniedRetry'), deviceDeniedHelp = $('deviceDeniedHelp');
  const accessHelp = $('accessHelp'), accessHelpClose = $('accessHelpClose'), accessHelpOpen = $('accessHelpOpen'), authHelpLink = $('authHelpLink');
  const btnConsole = $('btnConsole'), consoleModal = $('consoleModal'),
        consoleClose = $('consoleClose'), consoleClear = $('consoleClear'),
        consoleLogArea = $('consoleLogArea');
  // 项目文件只读浏览（FR-07）
  const fileBrowseModal = $('fileBrowseModal'), fileBrowseBack = $('fileBrowseBack'),
        fileBrowsePath = $('fileBrowsePath'), fileBrowseClose = $('fileBrowseClose'),
        fileBrowseBody = $('fileBrowseBody');

  // ---- 状态 ----
  let currentSessionId = localStorage.getItem('current_session') || null;
  // per-session 未发送草稿 {text, attachments}（切会话存/切回恢复；同会话静默换实例不读写，见 planSessionDraftSwap）。
  // 仅内存、不落盘——刷新页面后丢失可接受（与 sessionDomCache 同寿）。
  // per-session「上次为该会话渲染到的磁盘 history 条数」（history 口径，非活缓冲 seq）。切入时与 server 报的
  // diskLen 比对，判「离开期间被终端外部写过」→ 清屏重载（见 shouldReloadOnEnter）。独立于 sessionDomCache：
  // 后者只在切走时 set 一次（DOM 快照），这里要在每次 loadHistory/onHistoryAppend 渲染后累积。
  // 这些状态会被早期 socket/DOM 回调触达，必须先于回调注册声明，避免首连事件抢跑触发 TDZ。
  let _busyState = false;
  let interruptPending = false;
  let _queueFull = false;        // 当前查看实例队列已满（pendingTurns>=2），发送按钮禁用；由 setInstances 按 queueFull 字段驱动
  let _pendingFirstSend = false; // 新会话首发乐观 busy 需跨越懒开后的 bindView→clearView(setBusy(false))；见 send()/setInstances
  // mirrorReadonlySid=当前只读会话（null=可编辑）；mirrorOverriddenSid=用户已显式接管、忽略其只读；
  // armedTakeoverSid=已排队接管、等终端本轮完结/疑似中断再自动放行（见 logic.js armedTakeoverStep）；
  // mirrorStaleFlag=当前只读会话是否处于疑似中断态（供点击「接管 CLI 会话」时判定走排队还是即时确认）。
  let mirrorReadonlySid = null, mirrorOverriddenSid = null, armedTakeoverSid = null, mirrorStaleFlag = false;
  let mirrorObservedCli = { model: null, permissionMode: null, effort: null };
  let mirrorWebPanelSnapshot = null; // CLI 观察态只负责展示；接管时恢复进入镜像前的 Web 选择，绝不写回实例偏好

  // 斜杠命令提示：init 事件推送 + localStorage 缓存（init 每轮到达并刷新缓存；页面刷新后、下一轮 init 前靠缓存提示）
  try {
    const cachedCmds = JSON.parse(localStorage.getItem('slash_commands'));
    if (Array.isArray(cachedCmds)) window.availableSkills = cachedCmds;
  } catch { /* 缓存损坏等价于无缓存 */ }
  function slashCommandName(cmd) {
    if (typeof cmd === 'string') return cmd;
    if (cmd && typeof cmd.name === 'string') return cmd.name;
    return '';
  }
  let lastSeq = 0;
  let curEpoch = null;
  let currentModel = '';                // 当前生效模型（init 事件的 model 字段），/model 无参时展示
  let cwdDefaultModel = '';             // 当前 cwd 的 CLI 默认模型（instances.defaultModel，服务端 scout 探得）：
                                        // currentModel 空时默认磁贴显它而非笼统「沿用当前」；只影响标签、不影响发送
  let currentGatewaySuffix = '';        // 保存第三方网关的特殊后缀（如 [1m]）进行无感适配，保持 Web 选项名称干净
  let activeSpeechBtn = null;           // 语音朗读当前播放的按钮
  let currentSessionIdForCopy = null;   // 当前查看会话完整 id（供 pillSession 点按复制）

  // 短 session_id 胶囊：显前 8 位、点按复制完整 id；无会话隐藏。便于对照 CLI /resume、日志、多设备定位同一会话。
  function updatePillSession(sid) {
    const pill = $('pillSession'), txt = $('pillSessionText'), row = $('settingsSessionRow');
    if (!pill || !txt) return;
    currentSessionIdForCopy = sid || null;
    if (sid) {
      txt.textContent = sid.slice(0, 8);
      pill.classList.remove('hidden');
      if (row) row.classList.remove('hidden');
    } else {
      txt.textContent = '';
      pill.classList.add('hidden');
      if (row) row.classList.add('hidden');
    }
  }

  function syncModelUI(model) {
    // 底栏模型 chip：显完整真名（含网关后缀 [1m]）；未选具体模型时优先显 CLI 列表里 value=default 的 displayName，
    // 否则回落 scout 探得的 cwd 默认名 /「默认」。不再渲染 Web 自造的「默认模型」磁贴。
    const cliDefault = (modelsList || []).find(m => (typeof m === 'string' ? m : m?.value) === 'default');
    const cliDefaultLabel = cliDefault && typeof cliDefault === 'object'
      ? (cliDefault.displayName || 'Default (recommended)')
      : null;
    const modelPillText = model ? model + currentGatewaySuffix
      : (cliDefaultLabel
        || (cwdDefaultModel ? cwdDefaultModel.replace(/\[[^\]]+\]$/, '') : '默认'));
    if (pillModelText) pillModelText.textContent = modelPillText;
    if (pillModel) pillModel.title = (model || cliDefaultLabel || cwdDefaultModel) ? modelPillText : '选择模型';
    if (customModelGrid) {
      // 空选中时高亮 CLI 的 default 项（与终端 /model 列表一致），不靠 data-model="" 伪项
      const activeVal = model || (cliDefault ? 'default' : '');
      customModelGrid.querySelectorAll('.model-tile').forEach(tile => {
        const tileVal = tile.dataset.model;
        const isCurrent = tileVal === activeVal || (!!model && tileVal === model);
        const title = tile.querySelector('.text-xs');
        if (isCurrent) {
          tile.classList.add('ring-1', 'ring-accent', 'border-accent', 'text-accent', 'bg-accent-wash/30');
          if (title) {
            title.classList.add('text-accent');
            title.classList.remove('text-ink');
          }
        } else {
          tile.classList.remove('ring-1', 'ring-accent', 'border-accent', 'text-accent', 'bg-accent-wash/30');
          if (title) {
            title.classList.remove('text-accent');
            title.classList.add('text-ink');
          }
        }
      });
    }
  }

  function rebuildCustomModelGrid(models) {
    if (!customModelGrid) return;
    customModelGrid.innerHTML = '';
    // 终端等价：只渲染 CLI/SDK supportedModels 列表，不自造「默认模型」空磁贴。
    // CLI 列表自带 value:"default" / "Default (recommended)"；空首页未选时高亮该项。
    const list = models || [];
    const hasCliDefault = list.some(m => (typeof m === 'string' ? m : m?.value) === 'default');
    // 选中规则：已有具体 currentModel → 精确/别名命中；否则 FRESH 高亮 CLI default 项
    const selectedVal = currentModel
      || (modelInput?.value || '')
      || (hasCliDefault ? 'default' : '');

    list.forEach(m => {
      const val = typeof m === 'string' ? m : m.value;
      const display = typeof m === 'string' ? m : (m.displayName || m.value);
      const desc = typeof m === 'string' ? '' : (m.description || '');
      const active = val === selectedVal
        || (!!currentModel && val === currentModel)
        || (!currentModel && val === 'default' && selectedVal === 'default');
      const card = el(`
        <div data-model="${esc(val)}" class="model-tile p-2.5 rounded-xl border border-line bg-surface active:bg-sunk cursor-pointer transition-all ${active ? 'ring-1 ring-accent border-accent text-accent bg-accent-wash/30' : ''}">
          <div class="text-xs font-semibold truncate ${active ? 'text-accent' : 'text-ink'}">${esc(display)}</div>
          <div class="text-[9.5px] text-ink-soft truncate mt-0.5">${esc(desc || val)}</div>
        </div>
      `);
      card.onclick = () => {
        if (mirrorReadonlySid) { addBar('终端驾驶中，设置已冻结——接管后可调', 'text-info'); return; }
        haptic('tap');
        // value=default 是 CLI /model 「不 pin」语义：select 置空（发消息=undefined→CLI 自选），
        // 不把字面 'default' 写进 select（否则发消息会带 model:'default' 让后端误 setModel 字面值）。
        modelInput.value = val === 'default' ? '' : val;
        delete modelInput.dataset.fullModel;
        if (val === 'default') {
          syncModelUI('');
          if (pillModelText && display) pillModelText.textContent = display;
        } else {
          syncModelUI(val);
        }
        rebuildEffortOptions(val === 'default' ? (cwdDefaultModel || currentModel) : val);
      };
      customModelGrid.appendChild(card);
    });
  }

  function updateModelAndSuffix(rawModel) {
    if (!rawModel) {
      currentModel = '';
      currentGatewaySuffix = '';
      syncModelUI('');
      return '';
    }
    const match = rawModel.match(/\[[^\]]+\]$/);
    if (match) {
      currentGatewaySuffix = match[0];
      currentModel = rawModel.replace(/\[[^\]]+\]$/, '');
    } else {
      currentGatewaySuffix = '';
      currentModel = rawModel;
    }
    syncModelUI(currentModel);
    return currentModel;
  }
  let modelsList = [];                   // 最近一次 models 事件的原始候选（含 SDK 的 supportedEffortLevels），驱动 effort 下拉
  const streams = new Map();
  const thinkings = new Map();
  const toolCards = new Map();
  const agentToolIds = new Set(); // 跟踪 Agent/Task 工具的 toolUseId，用于在 tool_result 时隐藏活动横幅
  // 子 agent 可折叠卡：parentToolUseId → { el, body, titleEl, type, running, streams, thinkings }
  // 键 = 主会话 Agent/Task 的 toolUseId（后端 parent_tool_use_id）。默认 <details> 收起。
  const subagentCards = new Map();
  // 从工具 inputSummary（可能被 agent.js truncate）中安全提取字段；JSON 解析失败时回退 fallback
  // candidateKeys 按优先级排列，返回第一个非空 key 的值
  function extractInput(inputSummary, candidateKeys, fallback) {
    if (typeof inputSummary !== 'string') return fallback;
    let parsed = null;
    try { parsed = JSON.parse(inputSummary); } catch {}
    if (!parsed || typeof parsed !== 'object') return fallback;
    for (const k of candidateKeys) { if (parsed[k] != null && parsed[k] !== '') return parsed[k]; }
    return fallback;
  }
  let activePerm = null;
  let permExpandBtn = null;             // M1：展开按钮引用，showNextPerm 前清除
  let activeQuestion = null;
  // 本端已答/已决提问 requestId（含整组 toolUseID）。乐观作答后 sync 竞态或缓冲回放时防重弹；
  // server eventsSince 已过滤已答项，此集合补作答→ack 窗口与 request_resolved 关窗标记。
  let currentPermMode = 'default';      // 当前权限档；onchange 取消时回退、避免重复 emit
  let permModeSeen = false;             // 首次服务端同步只定基线不上屏（刷新/重连不冒「切换」假象）
  let currentEffort = null;             // 当前思考强度档（null=模型默认）；onchange 同值不重发
  let effortSeen = false;               // 首次服务端同步只定基线不上屏（同 permModeSeen）
  let ultracodeArmed = false;           // ultracode 档（=xhigh+workflow）本地武装态：借道 xhigh 发 effort，
                                        // 由本标志驱动「发送时注入关键词」+ pill/磁贴显示 ultracode。不跨实例（CLI: never persist）
  let currentCwd = null;                // 当前查看 cwd 上下文（instances.viewingCwd），目录切换器高亮 + 新建会话选目录
  let availableDirs = [];               // WORK_DIRS 白名单，会话面板目录切换器候选
  let cwdSeen = false;                  // 首次服务端同步只定基线不切视图（刷新/重连不清空）
  let workdirStates = {};               // {[cwd]:'idle'|'busy'|'permission'|'done'} 目录切换器角标（台阶3 由 instances 按 cwd 聚合）
  // 台阶3：viewingInstanceId = 当前查看 tab 实例（前端分流锚点）；displayedInstanceId/Session =
  // 已绑定渲染的实例/会话（viewingInstanceId 变了才切视图，避免每个 instances 边界广播都重载）。
  let viewingInstanceId = null;
  // 是否已收到过首个 instances 广播（视图状态已知）。区分「视图未知（连接初期，应放行重放）」与
  // 「viewingInstanceId 确为 null（新会话懒开空窗口，须丢弃后台实例事件防污染）」——见 logic.js shouldDropAgentEvent。
  let instancesReady = false;
  let displayedInstanceId = undefined;  // undefined 确保首次 viewingInstanceId=null 也会 bind 空启动页
  let displayedSessionId = null;
  let instancesList = [];               // 最近 instances 事件的实例列表（含 per-instance state）
  let needsYouList = [];                // "等我"聚合（AD-11/§3.2.5，承接 FR-21/FR-22），按 waitingSince 升序（等得越久排越前）
  // 服务状态可见性（第一性原理重新设计，与上面 needsYouList 是不同轴——这条答"服务本身有没有出过岔子"）：
  // latestServiceHealth = 最近一次 instances 广播里的 service 字段；_serviceRestartNoticeActive 一旦本次
  // 页面生命周期内命中过重启就保持 true，防止下一次不相关广播里 detectServiceRestart 判回 changed:false
  // 导致提示瞬间消失——重启提示应持续到用户主动离开/刷新页面，不是那种毫秒级归零的一次性事件。
  let latestServiceHealth = null;
  let _serviceRestartNoticeActive = false;
  let expandedDirs = new Set();         // 工作区面板中展开的目录（初始空，首 instances 事件填充；切 cwd 重置）
  // P3：面板结构指纹（dirs + 实例集 + viewingInstanceId + viewingCwd）；纯状态变化时不重建面板。
  let _lastPanelStructKey = null;
  let offlineQueue = [];                // 弱网离线发送队列：重连后 processOfflineQueue 逐条补发

  // 所有拆出的浏览器模块只通过显式 context 读取共享 DOM、状态和依赖。
  const appContext = createAppContext({
    dom: {
      messages: messagesEl,
      input: inputEl,
      status: statusEl,
      connRtt: connRttEl,
      connDotWrap,
      consoleModal,
      consoleLogArea,
      btnAttach,
      fileInput,
      attachTray,
      attachPreviewModal,
      attachPreviewImg,
      attachPreviewName,
      attachPreviewClose,
      fileBrowseModal,
      fileBrowseBack,
      fileBrowsePath,
      fileBrowseClose,
      fileBrowseBody,
      btnSettings,
      settingsScrim,
      settingsSheet,
      settingsClose,
      prefAlertSound: $('prefAlertSound'),
      prefAlertVibrate: $('prefAlertVibrate'),
      prefAlertForeground: $('prefAlertFgComplete'),
      btnAlertPreview: $('btnAlertPreview'),
      btnPush,
      activityBanner,
      activityBannerText,
      taskProgressBanner,
      taskProgressText,
      btnTaskStop,
    },
    state: {},
    dependencies: {
      now: Date.now,
      random: Math.random,
      window,
      navigator,
      storage: localStorage,
      document,
      FileReader,
      Image,
      URL,
      performance,
      marked,
      DOMPurify,
      Notification: window.Notification,
      fetch: window.fetch.bind(window),
      alert: window.alert.bind(window),
      console,
    },
  });
  Object.defineProperties(appContext.state, {
    viewingInstanceId: { enumerable: true, get: () => viewingInstanceId },
    currentModel: { enumerable: true, get: () => currentModel },
    instancesReady: { enumerable: true, get: () => instancesReady },
    curEpoch: { enumerable: true, get: () => curEpoch, set: value => { curEpoch = value; } },
    lastSeq: { enumerable: true, get: () => lastSeq, set: value => { lastSeq = value; } },
    currentSessionId: { enumerable: true, get: () => currentSessionId, set: value => { currentSessionId = value; } },
  });
  const sessionWorkspaceState = createSessionWorkspaceState(appContext);
  const {
    sessionDomCache,
    sessionDraftCache,
    seenDiskLenBySession,
    sessionsCache,
  } = sessionWorkspaceState;
  const interactionState = createInteractionQueueState(appContext);
  const {
    permissionQueue: permQueue,
    questionQueue,
    markQuestionAnswered,
  } = interactionState;
  const clientLogger = createClientLogger(appContext, {
    onEntry(entry) {
      if (consoleModal?.classList.contains('sheet-open')) appendLogEntry(entry);
    },
  });
  const logClientEvent = clientLogger.log;
  const alerts = createAlertController(appContext);
  const haptic = alerts.haptic;
  const alertCue = alerts.cue;
  const ensureAlertAudio = alerts.ensureAudio;
  const messageRenderer = createMessageRenderer(appContext, { scrollBottom: () => scrollBottom() });
  const render = messageRenderer.renderMarkdown;
  const el = messageRenderer.createElement;
  const setStatus = messageRenderer.setStatus;
  const leaveStartScreen = messageRenderer.leaveStartScreen;
  const appendMessage = messageRenderer.appendMessage;
  const addBar = messageRenderer.addBar;
  const notifications = createNotificationController(appContext, {
    addBar,
    getToken: () => token,
  });
  const notify = notifications.notify;
  const setupPush = notifications.setup;
  const taskStatus = createTaskStatusController(appContext, {
    addBar,
    alertCue,
    alerts,
    createElement: el,
    haptic,
    notify,
  });
  const showActivityBanner = taskStatus.showActivity;
  const hideActivityBanner = taskStatus.hideActivity;
  const clearApiRetryBanner = taskStatus.clearApiRetry;
  const onApiRetry = taskStatus.onApiRetry;
  const onTaskProgress = taskStatus.onProgress;
  const hideTaskProgress = taskStatus.hideProgress;
  const onTaskNotification = taskStatus.onComplete;

  // ---- socket ----
  const socket = appContext.setSocket(io({
    auth: { token, deviceToken },
    // 移动端常切后台/息屏，断开后想尽快回来：调小重连退避（默认 1000/5000ms 太久）
    reconnectionDelay: 500,
    reconnectionDelayMax: 2000,
  }));

  let initialLoad = true;
  let connectErrorCount = 0;  // 公网 socket 连续失败计数，攒够再探测 Access 是否过期
  
  const OFFLINE_RESEND_ACK_MS = 8000; // 慢移动网络 RTT 留余地（同 cf-access 2s→8s 超时教训，见项目 memory）
  function processOfflineQueue() {
    if (offlineQueue.length === 0) return;
    const items = offlineQueue;
    offlineQueue = []; // 乐观清空：未确认送达的会在下方 ack 失败回调里重新 push 回来
    addBar(`正在重发离线发送队列中的 ${items.length} 条消息...`, 'text-info');
    logClientEvent('send', `[WEB_SEND] 正在重发离线发送队列中的 ${items.length} 条消息`);
    for (const item of items) {
      const indicator = item.bubbleEl?.querySelector('.pending-indicator');
      if (indicator) {
        indicator.textContent = '🕐 正在发送...';
      }
      logClientEvent('send', `[WEB_SEND] 重发离线消息: "${item.text.slice(0, 100)}" (${item.text.length} 字符)`);
      // REL-01：用入队时刻保存的目标（item.instanceId/item.cwd），不用重发时的当下 viewingInstanceId/
      // currentCwd——否则离线期间切换了查看会话，消息会错发到现在正看的会话而非当初想发的那个。
      // 带 clientMessageId + ack：未确认送达（超时/服务端拒绝）则重新排队，等下次重连再试，不原地无限重试。
      socket.timeout(OFFLINE_RESEND_ACK_MS).emit('user:message', {
        text: item.text,
        model: item.model,
        attachments: item.attachments,
        instanceId: item.instanceId,
        cwd: item.cwd,
        clientMessageId: item.clientMessageId,
      }, (err, ack) => {
        if (!err && ack && ack.ok === false && ack.permanent) {
          // BE-002：服务端判定永久失败（空/超长/附件非法）——重发必再失败，停止重试、标记失败，不再 re-push。
          if (indicator) indicator.textContent = `⚠️ ${ack.error || '发送失败'}，已停止重试`;
          logClientEvent('send', `[WEB_SEND] 离线消息被服务端永久拒绝（${ack.error || ''}），停止重试`);
        } else if (err || !ack?.ok) {
          // 超时或可重试失败（如服务端队列已满 retryable）：重新排队，等下次重连重试。
          if (indicator) indicator.textContent = '🕐 未确认送达，等待重连重试...';
          offlineQueue.push(item);
          logClientEvent('send', `[WEB_SEND] 离线消息重发未确认（${err ? '超时' : '服务端拒绝'}），已重新排队`);
        } else if (indicator) {
          indicator.remove();
        }
      });
    }
    setBusy(true);
  }

  // 移动端切前台/重连后的统一 sync 入口（命中根因 A/B）。复用 clearView（清 DOM + 重置 lastSeq/curEpoch
  // 去重基线）→ loadHistory（默认 cwd=currentCwd、ack 内 hideLoadingCard）。connect 路径不像 bindView 那样
  // 先 clearView，loadHistory 是 appendChild 不清空，故重载前必须先 clearView 防重复整段对话。
  const PROBE_MS = 5000; // 探测 ack 超时：远低于 socket.io 被动心跳超时窗口(~45s)，又容忍移动端慢 RTT
  let _probeInFlight = false;
  function reloadCurrentFromHistory() {
    if (!displayedSessionId) return;
    // 与 bindView reload 同理：clearView 前的 lastSeq/curEpoch 可能刚被 sync 回放推进；
    // 归零后若再 sync 会把环形缓冲整段再叠到磁盘历史上。恢复基线，仅丢未落盘的实时中间态。
    const keepSeq = lastSeq;
    const keepEpoch = curEpoch;
    clearView(displayedSessionId, null);
    lastSeq = keepSeq;
    curEpoch = keepEpoch;
    showLoadingCard();
    loadHistory(displayedSessionId); // cwd 默认 currentCwd
  }
  // 状态对账：用 sync:since ack 带回的 pending 快照重建未决审批/提问卡片。走既有 handler（自带 requestId
  // 去重 + 弹窗/通知）。修「角标 ⚠️ 待审批但会话内无卡片」——原始事件可能被环形缓冲 trim 或切视图分流丢弃，
  // pendingPermissions/pendingQuestions 才是权威真相。视图稳定后调用（bindView / connect 两路径）。
  function applyPendingSnapshot(pending) {
    if (!pending) return;
    for (const p of pending.permissions || []) handle.permission_request(p);
    for (const q of pending.questions || []) handle.question(q);
  }
  function requestSync({ probe }) {
    if (!displayedInstanceId || !displayedSessionId) return;
    const reqInstanceId = displayedInstanceId, reqSessionId = displayedSessionId; // WS-002：捕获发起时的视图目标（代次）
    const payload = { instanceId: reqInstanceId, sessionId: reqSessionId, lastSeq };
    const act = (err, res) => {
      // WS-002：迟到 ACK 守卫——发起后若已切到别的会话/实例，丢弃本回调。否则 A 的 sync ACK 会在当前 B 上
      // reload（清空 B）或 applyPendingSnapshot 弹出 A 的审批/问题卡。对齐 bindView 的 sync:since 守卫。
      if (displayedInstanceId !== reqInstanceId || displayedSessionId !== reqSessionId) return;
      const a = syncAckAction(err, res);
      if (a === 'reconnect') { if (socket.connected) socket.disconnect(); socket.connect(); return; }
      if (a === 'reload') reloadCurrentFromHistory();
      // 'none'：回放走正常 agent:event 经 epoch/seq 去重增量渲染
      // 状态对账：重连/probe 补传后用快照重建未决审批卡片（reload 的 clearView 已同步执行完、不被清）；
      // reconnect 已 return——它触发干净重连，届时新一轮 sync 会带新快照。
      applyPendingSnapshot(res?.pending);
    };
    if (probe) {
      if (_probeInFlight) return;       // ack 异步，防 200ms debounce 外的并发探测
      _probeInFlight = true;
      socket.timeout(PROBE_MS).emit('sync:since', payload, (err, res) => {
        _probeInFlight = false;
        act(err, res);
      });
    } else {
      socket.emit('sync:since', payload, res => act(null, res));
    }
  }


  // ---- 连接同步：RTT 旁路监测由独立 controller 管理 ----
  const rttMonitor = createRttMonitor(appContext, { setStatus });
  const clearRttDisplay = rttMonitor.clear;
  const measureRtt = rttMonitor.measure;
  const startRttLoop = rttMonitor.start;
  const stopRttLoop = rttMonitor.stop;
  socket.on('connect', () => {
    authGate?.classList.add('hidden');           // 鉴权通过：收起令牌输入页
    if (authToken) authToken.value = '';         // 成功后不把令牌留在本地表单状态里
    accessRelogin?.classList.add('hidden');      // 连上即收起重登浮层
    connectErrorCount = 0;
    if (authSubmit) { authSubmit.disabled = false; authSubmit.textContent = '进入'; }
    connDot.className = 'w-2 h-2 rounded-full bg-success shrink-0';
    setStatus('已连接');
    startRttLoop(); // 连上即开始测 RTT（立即一次 + 周期）
    cliStatusWrapEl?.classList.remove('opacity-40'); // E16：重连恢复（折叠条整体：summary + ANSI 行，重放/刷新马上跟上）
    logClientEvent('conn', `连接成功！Socket ID = ${socket.id}。当前使用 token: ${token ? token.slice(0, 4) + '***' : '无（本机/公网）'}`);
    // 台阶3：首连由 instances 事件驱动加载当前查看实例（见 setInstances）；重连（非首连、已有绑定实例）
    // 续传该实例缓冲补齐断线期间漏掉的事件。
    if (!initialLoad && displayedInstanceId && displayedSessionId) requestSync({ probe: false });
    initialLoad = false;
    setupPush();
    initDeepLinkOnce();  // ②2c：深链入口（幂等，仅首次 connect 生效）
    
    // 触发离线发送队列重发
    processOfflineQueue();
  });
  socket.on('disconnect', (reason) => {
    connDot.className = 'w-2 h-2 rounded-full bg-danger shrink-0';
    setStatus('连接断开，自动重连中…');
    stopRttLoop();
    clearRttDisplay();
    cliStatusWrapEl?.classList.add('opacity-40'); // E16：置灰示陈旧（折叠条整体：summary + ANSI 行；内容含 🕐，不另发明离线文案）
    logClientEvent('conn', `网络连接断开，原因: ${reason || '未知'}`);
  });
  socket.on('connect_error', async err => {
    logClientEvent('conn', `连接尝试失败: ${err.message || err}`);
    if (err.message === 'unauthorized') {
      if (isLanOrLocal() || !document.body.dataset.cfAccess) {
        setStatus('需要访问令牌');
        showAuthGate(socket.auth?.token ? '令牌无效，请重新输入' : ''); // 有 token 仍失败 = 无效
      } else {
        setStatus('需要重新登录');                 // 公网无 token 可输，走 Access 重登
        maybeAccessRelogin();
      }
    } else {
      setStatus(`连接失败：${err.message}`);
      // 公网：传输错误攒几次后探测是不是 Access 会话过期（被 302 到登录页），是则提示手动重登。
      if (!isLanOrLocal() && document.body.dataset.cfAccess && ++connectErrorCount >= 3) {
        connectErrorCount = 0;
        maybeAccessRelogin();
      }
    }
  });

  // 移动端：切后台/息屏会冻结页面并断开 socket。回前台 / 网络恢复 / bfcache 恢复时主动尽快重连，
  // 不傻等 socket.io 被动超时退避；已连接则 connect() 为 no-op。重连后 connect handler 走 sync:since 补传断线期间事件。
  let _reconnectTimer;
  function reconnectIfNeeded() {
    clearTimeout(_reconnectTimer);
    _reconnectTimer = setTimeout(() => {
      // 半开连接下 socket.connected 会撒谎为 true（见 logic.js foregroundReconnectAction）：connected →
      // probe（带 timeout 的 sync:since 探活+补发，超时即强制干净重连），未连 → connect（connect handler 会 sync）。
      if (foregroundReconnectAction(socket.connected) === 'connect') socket.connect();
      else {
        requestSync({ probe: true });
        measureRtt(); // 前台唤醒立即刷新延迟（不依赖 5s 周期）
      }
    }, 200);
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') reconnectIfNeeded();
  });
  window.addEventListener('online', reconnectIfNeeded);
  window.addEventListener('pageshow', reconnectIfNeeded); // 从 bfcache 恢复

  // iOS Safari 键盘弹起时 visualViewport 变化、layout viewport 不动，需补 footer padding 让输入区避开键盘。
  // 决策（含负/错配/Android 不补 + 失焦回落）抽到 logic.js keyboardInsetPadding，此处只取值/接线。
  // 失焦必复位是关键：点附件按钮唤起系统选择器会让输入框失焦、viewport 瞬时错配，旧实现会把一个大 inset
  // 写死进 padding 留出半屏空白且无人复位（E17 附件回流 bug）；改为按焦点门控 + focusout 后重算自愈。
  let scheduleInsetResettle = () => {}; // 附件选择器返回后主动重算键盘 inset（无 visualViewport 时为 no-op）
  if (window.visualViewport) {
    const footer = document.querySelector('footer');
    const vv = window.visualViewport;
    const baseBottom = footer ? (parseFloat(getComputedStyle(footer).paddingBottom) || 0) : 0;
    const applyInset = () => {
      if (!footer) return;
      const ae = document.activeElement;
      const inputFocused = !!ae && (ae.tagName === 'TEXTAREA' || ae.tagName === 'INPUT');
      const pad = keyboardInsetPadding({
        innerHeight: window.innerHeight,
        viewportHeight: vv.height,
        viewportOffsetTop: vv.offsetTop,
        inputFocused,
        baseBottom,
      });
      // 诊断 tap（localStorage.ccm_debug_inset='1' 开启）：排查「附件回来后下半屏白屏」——
      // 读 innerHeight/vv.height/offsetTop/scrollY/focused/pad 定位是 viewport 未恢复(H1) 还是 scroll 卡滞(H2)。
      if (localStorage.getItem('ccm_debug_inset') === '1') {
        const line = `[inset] innerH=${window.innerHeight} vvH=${Math.round(vv.height)} offTop=${Math.round(vv.offsetTop)} scrollY=${window.scrollY} focused=${inputFocused} pad=${Math.round(pad)} base=${baseBottom}`;
        console.log(line);
        logClientEvent('conn', line); // client_conn 恒显，手机端可在日志抽屉直接看数值
      }
      footer.style.paddingBottom = pad + 'px';
      if (pad - baseBottom > 60) scrollBottom(); // 键盘明显占位才滚动到底，保证输入区可见
    };
    scheduleInsetResettle = () => {
      // 附件选择器返回后 iOS 常不再补发 viewport resize，残留的键盘 inset 无人复位 → 半屏白屏（E17 回归）。
      // 主动在 viewport 恢复窗口内多次重算：此时键盘已被 picker 取代而消失，applyInset 读到真实 viewport → 回落 baseBottom。
      setTimeout(applyInset, 300);
      setTimeout(applyInset, 700);
    };
    vv.addEventListener('resize', applyInset);
    vv.addEventListener('scroll', applyInset);
    // 焦点变化（尤其附件选择器抢/还焦点）后重算：键盘收起即回落 baseBottom，消除残留空白。
    // focusout 延后一帧再算——等 activeElement / viewport 落定，避免读到过渡态。
    window.addEventListener('focusout', () => setTimeout(applyInset, 50));
    window.addEventListener('focusin', applyInset);
  }

  // 当前是否走公网（非 localhost/局域网）——公网由 Cloudflare Access 把守、无 token 可输。
  function isLanOrLocal() {
    const h = location.hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.endsWith('.local')
      || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/.test(h);
  }
  // 探测 /health 是否被 Access 302 到登录页（redirect:manual → opaqueredirect）；是则弹手动重登（不 auto-reload，防死循环）。
  async function maybeAccessRelogin() {
    try {
      const r = await fetch('/health', { redirect: 'manual', cache: 'no-store' });
      if (r.type === 'opaqueredirect' || r.status === 0) showAccessReloginGate();
    } catch { /* 网络错误：不误报 */ }
  }
  function showAccessReloginGate() { accessRelogin?.classList.remove('hidden'); }
  if (accessReloginBtn) accessReloginBtn.onclick = () => location.reload(); // 整页跳转重过 Access

  // ---- 访问令牌输入页（鉴权失败时引导；不改握手契约，替代手动改 #token= URL）----
  function showAuthGate(msg) {
    if (!authGate) return;
    if (authError) {
      if (msg) { authError.textContent = msg; authError.classList.remove('hidden'); }
      else authError.classList.add('hidden');
    }
    authGate.classList.remove('hidden');
    if (authSubmit) { authSubmit.disabled = false; authSubmit.textContent = '进入'; }
    setTimeout(() => authToken?.focus(), 50);
  }
  function submitAuth() {
    const val = authToken?.value.trim();
    if (!val) { showAuthGate('请输入访问令牌'); return; }
    localStorage.setItem('auth_token', val);
    token = val;
    socket.auth = { token: val, deviceToken };
    if (authError) authError.classList.add('hidden');
    if (authSubmit) { authSubmit.disabled = true; authSubmit.textContent = '连接中…'; }
    socket.connect(); // 用新 auth 重连；成功→connect 收起，失败→connect_error 再次提示
  }
  if (authSubmit) authSubmit.onclick = submitAuth;
  if (authToken) authToken.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); submitAuth(); }
  });

  // ---- 访问帮助 + 被拒说明 + 已信任设备远程审批（替代必须上电脑终端）----
  function showAccessHelp() { accessHelp?.classList.remove('hidden'); }
  function hideAccessHelp() { accessHelp?.classList.add('hidden'); }
  if (accessHelpClose) accessHelpClose.onclick = hideAccessHelp;
  if (accessHelpOpen) accessHelpOpen.onclick = showAccessHelp;

  // ④ UI 安全体检：点击 → doctor:run（鉴权 socket）→ 渲染逐项 pass/warn/fail + 危险白名单 + 就绪度横幅。
  function renderDoctor(rep, box) {
    box.replaceChildren();
    if (!rep || !Array.isArray(rep.checks)) {
      const e = el(`<div class="text-danger"></div>`); e.textContent = '体检失败或无响应'; box.appendChild(e); return;
    }
    const R = { ready: ['✅', 'text-success'], caution: ['⚠️', 'text-warning'], blocked: ['🚫', 'text-danger'] };
    const [ricon, rcls] = R[rep.readiness?.level] || ['', 'text-ink'];
    const banner = el(`<div class="font-semibold mb-1.5"></div>`);
    banner.className = `font-semibold mb-1.5 ${rcls}`;
    banner.textContent = `${ricon} ${rep.readiness?.summary || ''}`;
    box.appendChild(banner);
    const SI = { ok: '✓', warn: '⚠', fail: '✗' }, SC = { ok: 'text-success', warn: 'text-warning', fail: 'text-danger' };
    for (const c of rep.checks) {
      const row = el(`<div class="flex items-start gap-2 py-1 border-b border-line-soft"><span></span><div class="flex-1 min-w-0"><div class="font-mono text-ink"></div><div class="text-ink-faint break-words"></div></div></div>`);
      const sp = row.querySelector('span');
      const [idDiv, detDiv] = row.querySelectorAll('.flex-1 > div');
      sp.textContent = SI[c.status] || '·'; sp.className = SC[c.status] || 'text-ink-faint';
      idDiv.textContent = c.id; detDiv.textContent = c.detail || '';
      box.appendChild(row);
      if (c.id === 'WHITELIST' && c.safe?.dangerous?.length) {  // 危险规则明细：显规则串 + scope（让用户知道改哪个文件）
        for (const d of c.safe.dangerous) {
          const dr = el(`<div class="text-danger pl-6 break-words"></div>`);
          dr.textContent = `⚠ ${d.rule} —— ${d.reason}（${d.scope || '?'}）`;
          box.appendChild(dr);
        }
      }
    }
  }
  if ($('btnSecurityCheck')) $('btnSecurityCheck').onclick = () => {
    const box = $('doctorReport');
    box.classList.remove('hidden');
    box.replaceChildren();
    const loading = el(`<div class="text-ink-faint"></div>`); loading.textContent = '🔍 体检中…'; box.appendChild(loading);
    socket.emit('doctor:run', {}, rep => renderDoctor(rep, box));
  };
  if (authHelpLink) authHelpLink.onclick = showAccessHelp;

  // 短 session_id 胶囊点按 → 复制完整 id（便于粘到终端 claude --resume <id> 或跨设备定位）
  const pillSession = $('pillSession');
  if (pillSession) pillSession.onclick = async () => {
    if (!currentSessionIdForCopy) return;
    haptic('tap');
    try {
      await navigator.clipboard.writeText(currentSessionIdForCopy);
      addBar(`已复制 session id：${currentSessionIdForCopy}`, 'text-ink-faint');
    } catch {
      addBar(`session id：${currentSessionIdForCopy}`, 'text-ink-faint'); // 剪贴板不可用（非 HTTPS 等）时至少显示全 id
    }
  };

  // 开发者模式：一键重启常驻 server（按钮仅 DEV_MODE=1 时由 setInstances 显示）。
  const btnRestartServer = $('btnRestartServer');
  if (btnRestartServer) btnRestartServer.onclick = () => {
    const busyN = instancesList.filter(i => i.state === 'busy' || i.state === 'permission').length;
    const warnLine = busyN ? `\n\n⚠️ 当前有 ${busyN} 个会话在运行/待审批，重启会中断它们（含后台任务）。` : '';
    if (!confirm(`⟳ 重启常驻 server？${warnLine}\n\n服务将优雅退出并由 KeepAlive 自动拉起，页面会自动重连。`)) return;
    haptic('warning');
    addBar('⟳ 正在重启服务…页面将自动重连', 'text-warning');
    socket.emit('dev:restart', {}, res => {
      if (res && res.ok === false) addBar(`重启被拒：${res.error || '未知'}`, 'text-danger');
    });
  };

  function showDeniedOverlay() { deviceDenied?.classList.remove('hidden'); }
  if (deviceDeniedHelp) deviceDeniedHelp.onclick = showAccessHelp;
  if (deviceDeniedRetry) deviceDeniedRetry.onclick = () => {
    deviceDenied?.classList.add('hidden');
    if (socket.connected) socket.disconnect();
    socket.connect(); // 重新发起 → 重新进入 pending，可信端/终端可再批
  };

  // 已信任设备渲染待审批设备请求（pending_devices 事件）。点准入/拒绝即发 user:approveDevice/denyDevice。
  // ID/IP/UA 一律用 textContent（UA 攻击者可控），不拼 innerHTML，防 XSS。
  function renderDeviceRequests(devices) {
    if (!deviceRequests) return;
    deviceRequests.textContent = '';
    if (!devices.length) { deviceRequests.classList.add('hidden'); return; }
    deviceRequests.classList.remove('hidden');
    for (const d of devices) {
      const card = document.createElement('div');
      card.className = 'pointer-events-auto mx-auto w-full max-w-sm bg-surface border border-line rounded-xl p-3';
      card.setAttribute('data-testid', 'device-card');
      card.setAttribute('data-device-id', d.deviceId);
      card.style.boxShadow = 'var(--shadow-pop)';
      const title = document.createElement('div');
      title.className = 'text-sm font-semibold text-ink mb-1.5';
      title.textContent = '🔔 新设备请求接入';
      const meta = document.createElement('div');
      meta.className = 'text-[11px] text-ink-soft leading-snug mb-2.5 break-all';
      const idLine = document.createElement('div'); idLine.textContent = 'ID：' + (d.deviceId || '—');
      const ipLine = document.createElement('div'); ipLine.textContent = 'IP：' + (d.ip || '—');
      const uaLine = document.createElement('div'); uaLine.className = 'text-ink-faint'; uaLine.textContent = d.userAgent || '';
      meta.append(idLine, ipLine, uaLine);
      const btns = document.createElement('div');
      btns.className = 'flex gap-2';
      const approve = document.createElement('button');
      approve.type = 'button';
      approve.className = 'flex-1 py-2 rounded-lg bg-accent text-white active:bg-accent-deep text-xs font-medium';
      approve.textContent = '✓ 准入';
      approve.addEventListener('click', () => { socket.emit('user:approveDevice', { deviceId: d.deviceId }); });
      const deny = document.createElement('button');
      deny.type = 'button';
      deny.className = 'flex-1 py-2 rounded-lg bg-sunk text-ink-soft active:bg-line-soft text-xs font-medium';
      deny.textContent = '✕ 拒绝';
      deny.addEventListener('click', () => { socket.emit('user:denyDevice', { deviceId: d.deviceId }); });
      btns.append(approve, deny);
      card.append(title, meta, btns);
      deviceRequests.appendChild(card);
    }
  }

  // ---- agent:event：带外事件、实例分流、epoch/seq 去重与日志由独立 dispatcher 管理 ----
  const dispatchAgentEvent = createAgentEventDispatcher(appContext, {
    handlers: () => handle,
    logger: clientLogger,
    outOfBand: {
      task_notification: onTaskNotification,
      task_progress: onTaskProgress,
      api_retry: onApiRetry,
      history_append: onHistoryAppend,
      mirror_state: onMirrorState,
      usage(ev) {
        if (!pendingUsageRender) return;
        const renderUsage = pendingUsageRender;
        pendingUsageRender = null;
        renderUsage(ev.payload);
      },
    },
    onEpochReset() {
      permQueue.length = 0;
      if (activePerm) {
        activePerm = null;
        closeSheet(permModal);
        permExpandBtn?.remove();
        permExpandBtn = null;
      }
      questionQueue.length = 0;
      if (activeQuestion) {
        activeQuestion = null;
        closeSheet(questionModal);
      }
    },
    onSessionId(sessionId) {
      localStorage.setItem('current_session', sessionId);
    },
  });
  socket.on('agent:event', dispatchAgentEvent);
  function failPendingToolCards(message) {
    if (!toolCards.size) return;
    const summary = message || '工具执行已因本轮错误停止';
    for (const card of toolCards.values()) {
      const status = card.querySelector('.t-status');
      if (status) status.textContent = '❌';
      const out = card.querySelector('.t-out');
      if (out) {
        // t-out 内是 <code>；写 textContent 到 pre 会清掉子节点，统一落到 code 上
        const code = out.querySelector('code') || out;
        code.textContent = summary;
        out.classList.remove('hidden');
      }
    }
    toolCards.clear();
    agentToolIds.clear();
    hideActivityBanner();
  }

  const handle = {
    device_status(p) {
      const modal = $('deviceModal');
      const modalId = $('deviceModalId');
      const modalCmdId = $('deviceModalCmdId');
      if (p.status === 'pending') {
        if (modal) {
          if (modalId) modalId.textContent = p.deviceId || '';
          if (modalCmdId) modalCmdId.textContent = p.deviceId || '';
          modal.classList.remove('hidden');
        }
        if (inputEl) inputEl.disabled = true;
        updateSendButtonState();
      } else if (p.status === 'approved') {
        if (modal) {
          modal.style.transition = 'opacity 0.15s ease-out';
          modal.style.opacity = '0';
          setTimeout(() => {
            modal.classList.add('hidden');
            modal.style.opacity = '';
          }, 150);
        }
        if (inputEl) inputEl.disabled = false;
        updateSendButtonState();
      } else if (p.status === 'denied') {
        if (modal) modal.classList.add('hidden');
        if (inputEl) inputEl.disabled = true;
        updateSendButtonState();
        showDeniedOverlay();
      }
    },
    // 已信任设备收到的待审批设备列表（全量幂等）；渲染成可一键准入/拒绝的卡片。
    pending_devices(p) {
      renderDeviceRequests(Array.isArray(p?.devices) ? p.devices : []);
    },
    init(p) {
      const rawM = p.model || '';
      const m = rawM.replace(/\[[^\]]+\]$/, '');
      // 模型切换成功无独立回执事件（随 user:message 捎带、send 内差分 setModel），每轮 init.model 是
      // 实际生效模型的权威值：跨轮 diff 上屏（首轮只定基线；切换失败时 agent 已发显式 error 且
      // 本轮 model 不变，自然不上屏）
      if (mirrorReadonlySid) {
        // SDK 回执只更新接管后的 Web 偏好快照；CLI 驾驶中的展示仍保持 observedCli，禁止被晚到 init 覆盖。
        if (mirrorWebPanelSnapshot) {
          mirrorWebPanelSnapshot.model = rawM || null;
          if (p.permissionMode) mirrorWebPanelSnapshot.permissionMode = p.permissionMode;
        }
        renderCliPanelState();
      } else {
        if (currentModel && m && m !== currentModel) addBar(`模型 → ${m}`, 'text-info');
        updateModelAndSuffix(rawM);
        rebuildEffortOptions(currentModel); // 模型变 → effort 档位跟随；空列表也刷（显示默认磁贴，好过整个隐藏）
        rebuildCustomModelGrid(modelsList); // 模型网格用已有缓存重建（models 事件没到也不空白）
        setPermMode(p.permissionMode); // 每轮 init 回显当前权限档（幂等，与 permission_mode 事件一致）
      }
      // 顶部状态行回归「纯连接状态」职责：model/目录/ctx/cost 已由 E16 web 状态栏投送（更全更权威），
      // 此处不再合成覆盖连接状态
      if (Array.isArray(p.slashCommands)) {
        window.availableSkills = p.slashCommands;
        localStorage.setItem('slash_commands', JSON.stringify(p.slashCommands));
      }
    },
    // 权限档切换后即时同步（多设备一致）；server 合成事件，与 init.permissionMode 一致
    permission_mode(p) {
      if (mirrorReadonlySid) {
        if (mirrorWebPanelSnapshot && p.mode) mirrorWebPanelSnapshot.permissionMode = p.mode;
        renderCliPanelState();
      } else setPermMode(p.mode);
    },
    // 思考强度档回执/重放（含拒切拨回的单发）；server 合成事件
    effort_mode(p) {
      if (mirrorReadonlySid) {
        if (mirrorWebPanelSnapshot) mirrorWebPanelSnapshot.effort = p.level ?? null;
        renderCliPanelState();
      } else setEffortMode(p.level);
    },
    // 台阶3：tab 栏快照回执/重放（合成事件，同 permission_mode/effort_mode 惯例）——
    // 驱动 viewingInstanceId 分流锚点 + 目录切换器角标 + 切视图（viewingInstanceId 变了才重载）
    instances(p) {
      setInstances(p);
    },
    session_log(p) {
      if (consoleModal && consoleModal.classList.contains('sheet-open')) {
        appendLogEntry(p);
      }
    },
    // 可用模型列表由 init 后 fire-and-forget supportedModels() 推送（含重连/重启后的服务端重放）。
    // 原样透传（2026-06-15 / 2026-07-14）：只渲染 CLI/SDK 列表（含 value=default 的 Default recommended），
    // 不再自造「不指定/默认模型」空选项。预选 currentModel；空则选 CLI default。
    models(p) {
      modelsList = Array.isArray(p.models) ? p.models : []; // 存原始候选供 effort 动态渲染
      rebuildEffortOptions(currentModel || cwdDefaultModel); // 列表到达 → 按当前/默认模型刷新 effort
      rebuildCustomModelGrid(modelsList);                    // 刷新自定义设置面板中的模型选择
      if (!modelInput) return;
      modelInput.innerHTML = '';
      (p.models || []).forEach(m => {
        const opt = document.createElement('option');
        if (typeof m === 'string') { opt.value = m; opt.textContent = m; }
        else { opt.value = m.value; opt.textContent = m.displayName || m.value; }
        modelInput.appendChild(opt);
      });
      // 预选：有 currentModel 用它；否则 CLI default；再不济留空
      if (currentModel) {
        ensureModelOption(currentModel);
        modelInput.value = currentModel;
        syncModelUI(currentModel);
      } else if ([...modelInput.options].some(o => o.value === 'default')) {
        modelInput.value = 'default';
        syncModelUI('');
      } else {
        syncModelUI('');
      }
      if (mirrorReadonlySid) renderCliPanelState(); // 晚到 models 只能更新候选，不能覆盖 CLI 未知/观察态
    },
    text_delta(p) {
      clearApiRetryBanner(); // 重试已过，流恢复——撤掉「重试中 n/m」横幅
      // 子 agent 正文：嵌进可折叠卡（不污染主流气泡）；parentToolUseId = 主 Agent/Task 的 toolUseId
      if (isSubagentPayload(p)) {
        const sa = ensureSubagentCard(p.parentToolUseId, p.subagentType);
        const s = getSubagentStream(sa, p.messageId);
        s.raw += p.text;
        s.textNode.appendData(p.text);
        scrollBottom();
        setBusy(true);
        return;
      }
      const s = getStream(p.messageId);
      s.raw += p.text;
      // 流式轻量 markdown：首 400ms 内 TextNode 即时跟手；此后节流用 marked 预览（result 时 finalize 权威全文）
      if (s.textNode && !s._mdLive) s.textNode.appendData(p.text);
      if (!s._mdTimer) {
        s._mdTimer = setTimeout(() => {
          s._mdTimer = null;
          s._mdLive = true;
          s.textNode = null;
          try { s.el.innerHTML = render(s.raw); } catch { /* 失败保持现状 */ }
          scrollBottom();
        }, 400);
      }
      scrollBottom();
      setBusy(true);
    },
    thinking_delta(p) {
      clearApiRetryBanner();
      if (isSubagentPayload(p)) {
        const sa = ensureSubagentCard(p.parentToolUseId, p.subagentType);
        getSubagentThinking(sa, p.messageId).body.appendData(p.text);
        scrollBottom();
        setBusy(true);
        if (activeStatusText) activeStatusText.textContent = 'Claude 正在思考中...';
        return;
      }
      getThinking(p.messageId).body.appendData(p.text);
      scrollBottom();
      setBusy(true);
      if (activeStatusText) {
        activeStatusText.textContent = 'Claude 正在思考中...';
      }
    },
    tool_use(p) {
      clearApiRetryBanner();
      // 工具卡片摘要：formatToolSummary 把紧凑 JSON pretty 成缩进文本，再套 hljs（与预览变更/聊天代码块同源）。
      // pre 用 whitespace-pre-wrap break-words：手机窄屏允许换行，不再强制横向滚一整行。
      const card = el(`
        <details class="msg-frame toolcard rounded-lg bg-surface border border-line text-xs">
          <summary class="px-3 py-2 flex items-center gap-2">
            <span class="t-status">⏳</span><span class="font-mono font-semibold text-ink">${esc(p.name)}</span>
          </summary>
          <div class="px-3 pb-2 space-y-1">
            <pre class="t-in overflow-x-auto whitespace-pre-wrap break-words text-ink-soft"><code></code></pre>
            <pre class="t-out overflow-x-auto whitespace-pre-wrap break-words text-ink-faint hidden"><code></code></pre>
          </div>
        </details>`);
      const inCode = card.querySelector('.t-in code');
      if (inCode) {
        inCode.textContent = formatToolSummary(p.inputSummary || '');
        try { hljs.highlightElement(inCode); } catch { /* 高亮失败不影响显示 */ }
      }
      toolCards.set(p.toolUseId, card);
      if (p.file?.path) {  // ③：文件类工具入口——Read=预览文件，Edit/Write/…=预览变更（见 toolPreviewLabel）
        const label = toolPreviewLabel({ name: p.name, changeKind: p.file?.changeKind });
        const wrap = el(`<div class="mt-1"><button type="button" class="tp-btn text-info underline"></button><div class="tp-body hidden mt-1 space-y-1"></div></div>`);
        const btn = wrap.querySelector('.tp-btn'), tbody = wrap.querySelector('.tp-body');
        btn.textContent = label;
        const inst = viewingInstanceId;  // 快照：点击时用卡片创建时所属实例，切换后不错乱
        let loaded = false;
        btn.onclick = () => {
          tbody.classList.toggle('hidden');
          if (loaded) return;
          loaded = true;
          socket.emit('tool:preview', { instanceId: inst, toolUseId: p.toolUseId }, res => {
            tbody.replaceChildren();
            if (!res?.ok) {  // inWhitelist=false → 红字（安全拒绝），其余灰字（过期/读失败）
              const m = el(`<div class="${res?.inWhitelist === false ? 'text-danger' : 'text-ink-faint'}"></div>`);
              m.textContent = res?.error || '预览不可用';
              tbody.appendChild(m);
              return;
            }
            const lab = el(`<div class="text-ink-faint"></div>`);
            lab.textContent = `📁 ${res.attribution.workdirLabel} / ${res.attribution.relPath}`;  // 路径归属
            tbody.appendChild(lab);
            const addPre = (txt, bg) => { const pre = el(`<pre class="overflow-x-auto"></pre>`); if (bg) pre.style.background = bg; pre.textContent = txt; tbody.appendChild(pre); };
            if (res.diff) {  // 变更 diff：old 红底 / new 绿底（textContent 防 XSS）
              for (const h of (res.diff.hunks || [])) {
                if (h.old) addPre('- ' + h.old, 'rgba(188,67,52,.12)');
                if (h.new) addPre('+ ' + h.new, 'rgba(61,138,80,.12)');
              }
              if (res.diff.added !== undefined) addPre(res.diff.added, 'rgba(61,138,80,.12)');
            } else if (res.snippet) {  // Read 文件片段：图片 → 缩略图；文本 → 代码高亮
              if (res.snippet.image?.base64 && res.snippet.image?.mimeType) {
                // 与用户附件气泡同源：data URI + CSP img-src data: 已许
                const img = el(`<img class="max-w-full max-h-48 rounded border border-line object-contain bg-sunk" alt="预览">`);
                img.src = `data:${res.snippet.image.mimeType};base64,${res.snippet.image.base64}`;
                tbody.appendChild(img);
                if (res.snippet.snippet) {
                  const cap = el(`<div class="text-ink-faint text-[11px]"></div>`);
                  cap.textContent = res.snippet.snippet + (res.snippet.truncated ? ' …（已截断）' : '');
                  tbody.appendChild(cap);
                }
              } else {
                const pre = el(`<pre class="overflow-x-auto whitespace-pre-wrap break-words"><code></code></pre>`);
                pre.querySelector('code').textContent = res.snippet.snippet + (res.snippet.truncated ? '\n…（已截断）' : '');
                tbody.appendChild(pre);
                try { hljs.highlightElement(pre.querySelector('code')); } catch { /* 高亮失败不影响显示 */ }
              }
            }
          });
        };
        card.querySelector('.space-y-1')?.appendChild(wrap);
      }
      // 子 agent 内部工具 → 嵌进对应可折叠卡 body；主会话工具仍走主流 appendMessage
      if (isSubagentPayload(p)) {
        const sa = ensureSubagentCard(p.parentToolUseId, p.subagentType);
        sa.body.appendChild(card);
      } else {
        appendMessage(card);
      }
      scrollBottom();
      setBusy(true);
      // 子代理/Workflow 活动横幅（仅主会话 Agent/Task；嵌套内部 Agent 不再叠横幅）
      if (!isSubagentPayload(p) && (p.name === 'Agent' || p.name === 'Task')) {
        agentToolIds.add(p.toolUseId);
        // 预建空卡：主 Agent 工具一启动就有「🤖 … 运行中」占位，后续 parentToolUseId 事件填内容
        const subType = extractInput(p.inputSummary, ['subagent_type', 'subagentType'], '');
        ensureSubagentCard(p.toolUseId, subType || null);
        const desc = extractInput(p.inputSummary, ['description'], '');
        if (desc) showActivityBanner(desc);
      }
      if (activeStatusText) {
        // 工具状态细化：Bash 显示具体命令，Agent 显示任务描述，其他显示工具名
        if (p.name === 'Bash') {
          const cmd = extractInput(p.inputSummary, ['command', 'cmd'], p.inputSummary);
          activeStatusText.textContent = `🖥 ${cmd.length > 60 ? cmd.slice(0, 57) + '...' : cmd}`;
        } else if (p.name === 'Agent' || p.name === 'Task') {
          const desc = extractInput(p.inputSummary, ['description'], p.inputSummary);
          activeStatusText.textContent = `🤖 ${desc.length > 50 ? desc.slice(0, 47) + '...' : desc}`;
        } else {
          activeStatusText.textContent = `Claude 正在运行工具 ${p.name}...`;
        }
      }
    },
    tool_result(p) {
      // 主会话 Agent/Task 完成 → 对应子 agent 卡标题改「已完成」（键 = toolUseId = 子事件的 parentToolUseId）
      if (!isSubagentPayload(p) && subagentCards.has(p.toolUseId)) {
        markSubagentCardDone(p.toolUseId);
      }
      const card = toolCards.get(p.toolUseId);
      if (!card) {
        // 无工具卡时仍处理 Agent 横幅（预建了子 agent 卡但 tool 卡可能被清过）
        if (agentToolIds.has(p.toolUseId)) {
          agentToolIds.delete(p.toolUseId);
          if (agentToolIds.size === 0) hideActivityBanner();
        }
        return;
      }
      // deny+message 通道结果被 SDK 标 is_error（ok:false），但真实语义由 denyKind 决定（agent.js）：
      // answered=已回答 ☑️ / denied=已拒绝 🚫 / cancelled=已取消 🚫——均非工具报错；无 denyKind 才按 ok 显 ✅/❌。
      const DENY_ICON = { answered: '☑️', denied: '🚫', cancelled: '🚫' };
      card.querySelector('.t-status').textContent = DENY_ICON[p.denyKind] || (p.ok ? '✅' : '❌');
      if (p.outputSummary) {
        const out = card.querySelector('.t-out');
        // deny 通道正文带 SDK 加的 "Error:" 前缀（非真错误），剥掉只留语义文本
        const raw = p.denyKind ? p.outputSummary.replace(/^Error:\s*/i, '') : p.outputSummary;
        const code = out.querySelector('code') || out;
        code.textContent = formatToolSummary(raw);
        try { if (code !== out) hljs.highlightElement(code); } catch { /* 高亮失败不影响显示 */ }
        out.classList.remove('hidden');
        // 截断时挂「展开全文」——点后走 tool:full 取 agent 缓存的完整输出
        if (isToolSummaryTruncated(raw, { truncated: p.truncated }) && p.toolUseId) {
          attachToolFullExpand(card, p.toolUseId);
        }
      }
      toolCards.delete(p.toolUseId);
      // 子代理/Workflow 完成时隐藏活动横幅（仅当所有并行 Agent 都完成才隐藏）
      if (agentToolIds.has(p.toolUseId)) {
        agentToolIds.delete(p.toolUseId);
        if (agentToolIds.size === 0) hideActivityBanner();
      }
    },
    // F3：user_message 事件渲染右侧气泡（已入缓冲，多设备/重载均可回放）
    // E17：p.attachments=[{name,mimeType,size,thumb?}]——图片显 thumb（data URI，CSP img-src data: 已许），其他显 📎 chip
    user_message(p) {
      // 弱网韧性：检查是否存在具有相同文本的未连接/离线发送中的乐观占位符。
      // 如果存在，不创建新气泡，而是将占位符气泡无缝转换为已确认的消息状态。
      const pendingBubbles = [...messagesEl.querySelectorAll('.opacity-70')];
      let matchedBubble = null;
      for (const b of pendingBubbles) {
        const tDiv = b.querySelector('.whitespace-pre-wrap');
        if (tDiv && tDiv.textContent === p.text) {
          matchedBubble = b;
          break;
        }
      }

      if (matchedBubble) {
        matchedBubble.classList.remove('opacity-70');
        matchedBubble.querySelector('.pending-indicator')?.remove();
        
        // 追加任何可能附带的附件
        if (Array.isArray(p.attachments) && p.attachments.length) {
          let wrap = null;
          for (const a of p.attachments) {
            const alreadyRendered = a.name && (
              matchedBubble.textContent.includes(a.name)
              || [...matchedBubble.querySelectorAll('img')].some(img => img.title === a.name)
            );
            if (alreadyRendered) continue;
            if (!wrap) wrap = el(`<div class="flex flex-wrap gap-2 mt-2"></div>`);
            if (a.thumb) {
              const img = el(`<img class="max-w-[8rem] max-h-32 rounded-lg">`);
              img.src = a.thumb; img.title = a.name || '';
              wrap.appendChild(img);
            } else {
              const chip = el(`<div class="flex items-center gap-1 bg-sunk rounded-lg px-2 py-1 text-xs max-w-[12rem]"><span class="shrink-0">📎</span></div>`);
              const nm = el(`<span class="truncate"></span>`); nm.textContent = a.name || '附件';
              chip.appendChild(nm);
              wrap.appendChild(chip);
            }
          }
          if (wrap) matchedBubble.appendChild(wrap);
        }
        if (p.text) appendCopyAction(matchedBubble, () => p.text, 'right');
        scrollBottom(true);
        return; // 匹配成功，直接返回，避免生成重复聊天气泡
      }

      const bubble = el(`<div class="msg-frame rounded-xl bg-user text-ink px-3 py-2 text-sm" data-testid="user-message"></div>`);
      if (p.text) {
        const t = el(`<div class="whitespace-pre-wrap"></div>`);
        t.textContent = p.text;
        // 长指令默认折叠（移动端痛点：上滑看前文被长指令顶住）。纯函数判超 10 行才折，
        // 折叠态限高可见一截 + 底部「展开」按钮；点开保持展开、再点收起。
        foldLongUserText(t, p.text);
        bubble.appendChild(t);
      }
      if (Array.isArray(p.attachments) && p.attachments.length) {
        const wrap = el(`<div class="flex flex-wrap gap-2${p.text ? ' mt-2' : ''}"></div>`);
        for (const a of p.attachments) {
          if (a.thumb) {
            const img = el(`<img class="max-w-[8rem] max-h-32 rounded-lg">`);
            img.src = a.thumb; img.title = a.name || '';
            wrap.appendChild(img);
          } else {
            const chip = el(`<div class="flex items-center gap-1 bg-sunk rounded-lg px-2 py-1 text-xs max-w-[12rem]"><span class="shrink-0">📎</span></div>`);
            const nm = el(`<span class="truncate"></span>`); nm.textContent = a.name || '附件';
            chip.appendChild(nm);
            wrap.appendChild(chip);
          }
        }
        bubble.appendChild(wrap);
      }
      if (p.text) appendCopyAction(bubble, () => p.text, 'right');
      appendMessage(bubble);
      scrollBottom(true);
    },
    permission_request(p) {
      // 幂等：sync:since 切入补发的 pending 快照可能与 buffer 回放的原始事件同 requestId → 只保留一份
      if (activePerm?.requestId === p.requestId || permQueue.some(r => r.requestId === p.requestId)) return;
      alertCue('need');
      permQueue.push(p);
      showNextPerm();
      notify('⚠️ 等待审批', `${p.name}：${JSON.stringify(p.input).slice(0, 80)}`);
      verifyPermIntegrity(p); // 异步、不阻塞渲染——NFR-17 协议步骤4，核验结果稍后到达时若仍是当前卡片才提示
    },
    question(p) {
      // 幂等：同上（快照补发 vs buffer 回放去重），按 requestId
      if (activeQuestion?.requestId === p.requestId || questionQueue.some(q => q.requestId === p.requestId)) return;
      // 已本地作答/已收 request_resolved：忽略重放（切会话、probe、整页刷新后的 sync）
      if (interactionState.isQuestionAnswered(p.requestId)) return;
      alertCue('need');
      questionQueue.push(p);
      showNextQuestion();
      notify('❓ 需要选择', p.text.slice(0, 80));
    },
    // M4：审批/选题完成后广播，多设备或重放缓冲时关闭陈旧弹窗
    request_resolved(p) {
      const { requestId, kind } = p;
      if (kind === 'permission') {
        // NFR-17：完整性校验失败是服务端 fail-closed 介入，不是用户的选择——若用户刚点了"允许"，
        // answerPerm() 已乐观显示过"✅ 已允许"（activePerm 早已本地清空，下面的分支找不到它，无从
        // 事后订正）。这里补一条独立提示，避免用户以为操作已生效、实际却被悄悄拦下。
        if (p.outcome === 'integrity_mismatch') {
          addBar('⚠️ 完整性校验未通过，该操作已被服务端拒绝执行（并非您的选择生效）', 'text-danger');
        }
        if (activePerm?.requestId === requestId) {
          activePerm = null;
          closeSheet(permModal);
          permExpandBtn?.remove(); permExpandBtn = null;
        } else {
          const idx = permQueue.findIndex(r => r.requestId === requestId);
          if (idx !== -1) permQueue.splice(idx, 1);
        }
        if (!activePerm) showNextPerm();
        updateSendButtonState();
      } else if (kind === 'question') {
        // question requestId 格式 '${toolUseID}#i'；单题 resolved 用 '#i'，整组终态用 toolUseID
        const matchQ = qId => qId === requestId || qId.startsWith(requestId + '#');
        markQuestionAnswered(requestId); // 整组 toolUseID 也入库 → isAnsweredQuestionId 覆盖所有 #i
        if (activeQuestion && matchQ(activeQuestion.requestId)) {
          markQuestionAnswered(activeQuestion.requestId);
          activeQuestion = null;
          closeSheet(questionModal);
        } else {
          // 可能一次终态清掉队列里同 tool 的多题
          for (let i = questionQueue.length - 1; i >= 0; i--) {
            if (matchQ(questionQueue[i].requestId)) {
              markQuestionAnswered(questionQueue[i].requestId);
              questionQueue.splice(i, 1);
            }
          }
        }
        if (!activeQuestion) showNextQuestion();
        updateSendButtonState();
      }
    },
    result(p) {
      // 服务端随 result 下发完整回复文本——断网恢复后 s.raw 可能因遗漏 deltas 而截断，
      // 此处用权威全文覆盖确保 Markdown 渲染完整（E18）
      if (p.text && p.messageId) {
        const s = streams.get(p.messageId);
        if (s) s.raw = p.text;
      }
      finalizeStreams();
      markAllSubagentCardsDone(); // 主轮结束：仍 running 的子 agent 卡标「已完成」（防 tool_result 漏标）
      setBusy(false);
      hideActivityBanner(); // 会话结束隐藏活动横幅
      // 不在此隐藏后台任务进度横幅：后台任务（Workflow/后台 Agent/Bash）跨轮次存活，轮次 result ≠ 后台完成。
      // 横幅生命周期交给 task_progress（下拍心跳 showTaskProgress 重现）与 task_notification（完成时 hideTaskProgress）自洽驱动。
      // 对齐 CLI：用户主动中止时 SDK 常带 is_error + ede_diagnostic；interrupted 优先，不当红色错误展示。
      const ui = presentTurnResult(p);
      if (ui.failToolsMessage) failPendingToolCards(ui.failToolsMessage);
      agentToolIds.clear(); // 清理 Agent 工具 ID 跟踪
      alertCue(ui.haptic); // success / warning / error：音+震（各自开关门控）
      addBar(ui.statusBar.text, ui.statusBar.cls);
      if (ui.errorBar) addBar(ui.errorBar.text, ui.errorBar.cls);
      notify(ui.notify.title, ui.notify.body, { force: alerts.preferences().foregroundComplete });

      // 防御性清理当前 tab 的挂起提问和审批
      permQueue.length = 0;
      if (activePerm) {
        activePerm = null;
        closeSheet(permModal);
        permExpandBtn?.remove(); permExpandBtn = null;
      }
      questionQueue.length = 0;
      if (activeQuestion) {
        activeQuestion = null;
        closeSheet(questionModal);
      }
      updateSendButtonState();
    },
    error(p) {
      finalizeStreams();
      failPendingToolCards(p.message);
      alertCue('error');
      addBar(`⚠️ ${p.message}`, 'text-danger');
      setBusy(false);
      hideActivityBanner(); // 含 api_retry 横幅

      // 防御性清理当前 tab 的挂起提问和审批
      permQueue.length = 0;
      if (activePerm) {
        activePerm = null;
        closeSheet(permModal);
        permExpandBtn?.remove(); permExpandBtn = null;
      }
      questionQueue.length = 0;
      if (activeQuestion) {
        activeQuestion = null;
        closeSheet(questionModal);
      }
      updateSendButtonState();
    },
    // M7：改用 kind 字段判断中断，不靠字符串匹配（字符串会随 i18n 变化）
    system(p) {
      addBar(p.message, 'text-ink-faint');
      if (p.kind === 'interrupted') { finalizeStreams(); setBusy(false); hideActivityBanner(); }
    },
    // E16：web 自有结构化状态（非 ANSI）。摘要去 emoji，展开分段构建 DOM（createElement+textContent，
    // 不经 innerHTML/DOMPurify，天然 XSS 安全）；服务端未启用则此事件不来，容器恒 hidden
    status_line(p) {
      if (!cliStatusEl || !p || typeof p !== 'object') return;
      // 守护：如果 payload 里的 instanceId 与前端当前的 viewingInstanceId 不一致，则丢弃渲染（防止旧 tab 覆盖）
      if (p.instanceId && viewingInstanceId && p.instanceId !== viewingInstanceId) return;
      // 兼容陈旧重放：老 payload 可能没有 instanceId，但仍带 cwd；用 cwd 兜底防止别的工作区状态线覆盖当前视图。
      if (!p.instanceId && p.cwd && currentCwd && p.cwd !== currentCwd) return;
      // 空启动页采用极简底部：模型/权限/思考 chips 即可，statusLine 进入消息流后再显示。
      if (messagesEl.classList.contains('empty-start')) return;
      const fmtTok = n => n >= 1e6 ? (n / 1e6).toFixed(1) + 'm' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n);
      const fmtMs = ms => { const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60; return h ? `${h}h${String(m).padStart(2, '0')}m` : m ? `${m}m${String(x).padStart(2, '0')}s` : `${x}s`; };
      const fmtTokF = n => n >= 1e6 ? (n / 1e6).toFixed(1) + 'm' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n); // 带 1 位小数（token 明细，匹配 cli 的 2.1k/199.6k）
      // 额度重置倒计时：ISO resets_at → 相对时长（对齐 CLI statusline `reset 2h05m`）
      const fmtReset = iso => {
        if (!iso) return '';
        const t = Date.parse(iso);
        if (!Number.isFinite(t)) return '';
        const rem = Math.max(0, t - Date.now());
        if (rem <= 0) return 'now';
        const totalMins = Math.ceil(rem / 60_000);
        const days = Math.floor(totalMins / 1440), hours = Math.floor((totalMins % 1440) / 60), mins = totalMins % 60;
        if (days > 0) return `${days}d${hours}h${String(mins).padStart(2, '0')}m`;
        if (hours > 0) return `${hours}h${String(mins).padStart(2, '0')}m`;
        return `${mins}m`;
      };
      // 折叠条只显 'statusline' 一词；全部数据在展开态（CLI 密集风、│ 分隔、分段着色）
      if (cliSummaryEl) cliSummaryEl.textContent = 'statusline';
      // 展开详情：CLI 密集风、分段着色、纯 DOM 构建。seg = {text,cls} 或 {node}。配色用项目语义色 token
      // （随明/暗主题），不硬塞 CLI 的 Catppuccin。每个非首段把分隔符 │ 与内容打包成一个不可拆的 cell，
      // 这样窄屏 flex-wrap 折行时 │ 永远跟着它后面的值走、不会被孤零零甩到行尾。
      const span = (text, cls) => { const s = document.createElement('span'); if (cls) s.className = cls; s.textContent = text; return s; };
      const row = segs => {
        const segsF = segs.filter(Boolean);
        if (!segsF.length) return null;
        const line = document.createElement('div');
        line.className = 'flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5';
        segsF.forEach((seg, i) => {
          const content = seg.node || span(seg.text, seg.cls);
          if (!i) { line.appendChild(content); return; }
          const cell = document.createElement('span');
          cell.className = 'inline-flex items-baseline gap-x-1.5'; // │ + 内容打包，防分隔符落行尾
          cell.appendChild(span('│', 'text-ink-faint opacity-40'));
          cell.appendChild(content);
          line.appendChild(cell);
        });
        return line;
      };
      const linesArr = [];

      if (p.source?.kind === 'cli-unavailable') {
        cliStatusEl.textContent = '';
        const unavailable = document.createElement('div');
        unavailable.className = 'flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5';
        unavailable.appendChild(span('CLI 状态暂不可用', 'text-warning font-medium'));
        if (p.source.reason) unavailable.appendChild(span(`(${p.source.reason})`, 'text-ink-faint'));
        cliStatusEl.appendChild(unavailable);
        if (cliSummaryEl) cliSummaryEl.textContent = 'statusline · CLI 暂不可用';
        cliStatusWrapEl?.classList.remove('hidden');
        return; // CLI owner 缺/陈旧时明确空缺，绝不把上一份 SDK/CLI 字段混进来
      }

      // git 段（分支 +暂存 !改动 ?未跟踪 ↑ahead ↓behind）。三分对齐 CLI；陈旧 payload 无三分时回退 ✱changed。
      // 不含 git 工作区 +ins/−del（web 独有口径已删；会话工具改行走 lines +/−）。
      let gitNode = null;
      if (p.git?.branch) {
        let b = p.git.branch;
        if (p.git.staged || p.git.modified || p.git.untracked) {
          if (p.git.staged) b += ` +${p.git.staged}`;
          if (p.git.modified) b += ` !${p.git.modified}`;
          if (p.git.untracked) b += ` ?${p.git.untracked}`;
        } else if (p.git.changed) {
          b += ` ✱${p.git.changed}`;
        }
        if (p.git.ahead) b += ` ↑${p.git.ahead}`;
        if (p.git.behind) b += ` ↓${p.git.behind}`;
        gitNode = span(b, 'text-accent font-medium');
      }
      // ctx 段：有 usedPercent → 'ctx X% · left Y'（≥90% 转红警示）；否则退回绝对 token 数（认不出 model 的窗口）
      let ctxSeg = null;
      if (p.ctx && Number.isFinite(p.ctx.usedPercent)) {
        let txt = `ctx ${p.ctx.usedPercent}%`;
        if (Number.isFinite(p.ctx.windowSize)) txt += ` · left ${fmtTok(Math.max(0, p.ctx.windowSize - p.ctx.tokens))}`;
        const pc = p.ctx.usedPercent; // 蓝(健康)→橙(≥70)→红(≥90) 三段警示
        ctxSeg = { text: txt, cls: pc >= 90 ? 'text-danger' : pc >= 70 ? 'text-warning' : 'text-info' };
      } else if (p.ctx && Number.isFinite(p.ctx.tokens)) {
        ctxSeg = { text: `ctx ${fmtTok(p.ctx.tokens)}`, cls: 'text-ink-soft' };
      }
      // 行A（headline，对齐 CLI 首行）：model │ effort │ location │ git │ ctx │ 版本
      // location = project（cwd 末段）或 git.repo 短名；model 作标题、与 CLI 首段一致；底部 pill 仍是选择器。
      const modelText = p.model ? (p.model.length > 26 ? p.model.slice(0, 25) + '…' : p.model) : '';
      const location = p.project || (p.git?.repo ? p.git.repo.split('/').pop() : '');
      linesArr.push(row([
        modelText && { text: modelText, cls: 'text-ink font-medium' },
        p.effort && { text: `effort ${p.effort}`, cls: 'text-warning' },
        typeof p.thinking?.enabled === 'boolean' && { text: `think ${p.thinking.enabled ? 'on' : 'off'}`, cls: 'text-ink-soft' },
        location && { text: location, cls: 'text-info' },
        gitNode && { node: gitNode },
        ctxSeg,
        p.version && { text: `v${p.version}`, cls: 'text-ink-faint' }
      ]));

      // token 明细段（对齐 CLI）：uncached <未缓存输入> response <输出>
      let tokenNode = null;
      if (p.ctx && Number.isFinite(p.ctx.in)) {
        tokenNode = span(`uncached ${fmtTokF(p.ctx.in)} response ${fmtTokF(p.ctx.out || 0)}`, 'text-info');
      }
      // cache 明细段（对齐 CLI）：cache <命中率>.XX% write <cache写> read <cache读>；命中率按 r/tokens 重算 2 位小数
      let cacheNode = null;
      if (p.ctx && Number.isFinite(p.ctx.w) && Number.isFinite(p.ctx.r)) {
        const rate = p.ctx.tokens > 0 ? (p.ctx.r / p.ctx.tokens * 100).toFixed(2) : '0.00';
        cacheNode = document.createElement('span');
        cacheNode.appendChild(span(`cache ${rate}%`, 'text-success'));
        cacheNode.appendChild(document.createTextNode(' '));
        cacheNode.appendChild(span(`write ${fmtTokF(p.ctx.w)} read ${fmtTokF(p.ctx.r)}`, 'text-ink-faint'));
      }
      // 额度段（对齐 CLI）：5h X% [reset …] │ 7d Y% [reset …]
      const rateSegs = [];
      if (p.rate?.fiveHour && Number.isFinite(p.rate.fiveHour.usedPercent)) {
        const pc = p.rate.fiveHour.usedPercent;
        let t = `5h ${Math.round(pc)}%`;
        const r = fmtReset(p.rate.fiveHour.resetsAt);
        if (r) t += ` reset ${r}`;
        rateSegs.push({ text: t, cls: pc >= 90 ? 'text-danger' : pc >= 70 ? 'text-warning' : 'text-info' });
      }
      if (p.rate?.sevenDay && Number.isFinite(p.rate.sevenDay.usedPercent)) {
        const pc = p.rate.sevenDay.usedPercent;
        let t = `7d ${Math.round(pc)}%`;
        const r = fmtReset(p.rate.sevenDay.resetsAt);
        if (r) t += ` reset ${r}`;
        rateSegs.push({ text: t, cls: pc >= 90 ? 'text-danger' : pc >= 70 ? 'text-warning' : 'text-info' });
      }
      // 行B（遥测，对齐 CLI 次行）：5h/7d │ uncached/response │ cache%+write/read
      linesArr.push(row([
        ...rateSegs,
        tokenNode && { node: tokenNode },
        cacheNode && { node: cacheNode }
      ]));

      // 行C（成本/耗时/改行，对齐 CLI）：est $成本 │ total 墙钟 │ api 耗时 │ lines +A/-R
      linesArr.push(row([
        Number.isFinite(p.cost) && { text: `est $${p.cost.toFixed(2)}`, cls: 'text-success' },
        p.duration && p.duration.wallMs && { text: `total ${fmtMs(p.duration.wallMs)}`, cls: 'text-ink-faint' },
        p.duration && p.duration.apiMs && { text: `api ${fmtMs(p.duration.apiMs)}`, cls: 'text-ink-faint' },
        p.lines && (p.lines.added || p.lines.removed) && { text: `lines +${p.lines.added || 0}/-${p.lines.removed || 0}`, cls: 'text-success' }
      ]));
      // 行D（会话身份/元数据，弱化为 faint）：repo │ sid
      // 不含时钟（web 独有已删）；不含 pid/transcript/PR/wt（CLI 独有、SDK 路径不产出或不接）。
      linesArr.push(row([
        p.git?.repo && { text: p.git.repo, cls: 'text-ink-faint' },
        p.session?.id && { text: `sid ${p.session.id.slice(0, 8)}`, cls: 'text-ink-faint' },
        p.source?.kind === 'cli' && { text: 'source CLI', cls: 'text-info' },
        p.source?.kind === 'sdk' && { text: 'source Web SDK', cls: 'text-ink-faint' }
      ]));

      // 一次性替换：清空旧节点 + append 非空行（row 对空行返回 null）
      cliStatusEl.textContent = '';
      linesArr.filter(Boolean).forEach(l => cliStatusEl.appendChild(l));
      cliStatusWrapEl?.classList.remove('hidden'); // 揭示折叠包裹（默认折叠为 summary 摘要）
    }
  };

  // 工具卡「展开全文」：live 路径 agent 缓存截断前全文；成功后替换 .t-out 并去掉按钮。
  function attachToolFullExpand(card, toolUseId) {
    if (!card || !toolUseId || card.querySelector('[data-testid="tool-expand-full"]')) return;
    const host = card.querySelector('.space-y-1') || card;
    const btn = el(`<button type="button" class="text-info underline text-[11px]" data-testid="tool-expand-full">展开全文</button>`);
    const inst = viewingInstanceId;
    btn.onclick = () => {
      btn.disabled = true;
      btn.textContent = '加载中…';
      socket.emit('tool:full', { instanceId: inst, toolUseId }, res => {
        if (!res?.ok) {
          btn.textContent = res?.error || '全文不可用';
          btn.disabled = false;
          return;
        }
        const out = card.querySelector('.t-out');
        const code = out?.querySelector('code') || out;
        if (code) {
          code.textContent = formatToolSummary(res.text || '');
          try { if (code !== out) hljs.highlightElement(code); } catch { /* noop */ }
          out?.classList.remove('hidden');
        }
        btn.remove();
      });
    };
    host.appendChild(btn);
  }

  // ---- 流式气泡 ----
  function getStream(id) {
    const key = id || '_';
    let s = streams.get(key);
    if (!s) {
      const wrap = el(`<div class="msg-frame msg-body px-0.5" data-testid="assistant-message"></div>`);
      const textNode = document.createTextNode('');
      const span = document.createElement('span');
      span.className = 'whitespace-pre-wrap';
      span.appendChild(textNode);
      wrap.appendChild(span);
      appendMessage(wrap);
      s = { el: wrap, raw: '', textNode, done: false };
      streams.set(key, s);
      scrollBottom();
    }
    return s;
  }
  function finalizeStreams() {
    for (const s of streams.values()) {
      if (s.done) continue;
      if (s._mdTimer) { clearTimeout(s._mdTimer); s._mdTimer = null; }
      s.done = true;
      s.el.style.transition = 'opacity .1s';
      s.el.style.opacity = '0.4';
      requestAnimationFrame(() => {
        s.el.innerHTML = render(s.raw);
        s.el.querySelectorAll('pre code').forEach(b => hljs.highlightElement(b));
        injectCodeCopyButtons(s.el);
        appendCopyAction(s.el, () => s.raw, 'left');
        s.el.style.opacity = '1';
        setTimeout(() => s.el.style.transition = '', 120);
      });
    }
    streams.clear();
    thinkings.clear();
    scrollBottom();
  }
  function getThinking(id) {
    const key = id || '_';
    let t = thinkings.get(key);
    if (!t) {
      const wrap = el(`
        <details class="msg-frame thinking rounded-lg bg-surface border border-line-soft text-xs text-ink-faint">
          <summary class="px-3 py-1.5">💭 思考过程</summary>
          <pre class="t-body px-3 pb-2 whitespace-pre-wrap"></pre>
        </details>`);
      const body = document.createTextNode('');
      wrap.querySelector('.t-body').appendChild(body);
      appendMessage(wrap);
      t = { body };
      thinkings.set(key, t);
      scrollBottom();
    }
    return t;
  }

  // ---- 子 agent 可折叠卡（切片 C：默认收起，点头展开看 text/thinking/tool）----
  // parentId = 主会话 Agent/Task 的 toolUseId（= 后端 parent_tool_use_id / parentToolUseId）
  function ensureSubagentCard(parentId, subagentType) {
    let c = subagentCards.get(parentId);
    if (!c) {
      // 默认不设 open —— 收起态；data-testid 供 visual E2E 断言
      const wrap = el(`
        <details class="msg-frame subagent-card rounded-lg bg-surface border border-line text-xs" data-testid="subagent-card">
          <summary class="px-3 py-2 flex items-center gap-2 cursor-pointer select-none">
            <span class="sa-title text-ink font-medium"></span>
          </summary>
          <div class="sa-body px-3 pb-2 pl-4 border-l-2 border-accent/40 ml-3 space-y-1"></div>
        </details>`);
      wrap.dataset.parentId = parentId;
      const titleEl = wrap.querySelector('.sa-title');
      const type = subagentType != null && String(subagentType).trim() ? String(subagentType).trim() : null;
      titleEl.textContent = formatSubagentCardTitle({ subagentType: type, running: true });
      c = {
        el: wrap,
        body: wrap.querySelector('.sa-body'),
        titleEl,
        type,
        running: true,
        streams: new Map(),
        thinkings: new Map(),
      };
      subagentCards.set(parentId, c);
      appendMessage(wrap);
      scrollBottom();
    } else if (subagentType != null && String(subagentType).trim() && !c.type) {
      // 首批 delta 可能早于带 subagentType 的 assistant：后来补类型标签
      c.type = String(subagentType).trim();
      c.titleEl.textContent = formatSubagentCardTitle({ subagentType: c.type, running: c.running });
    }
    return c;
  }

  function markSubagentCardDone(parentId) {
    const c = subagentCards.get(parentId);
    if (!c || !c.running) return;
    c.running = false;
    c.titleEl.textContent = formatSubagentCardTitle({ subagentType: c.type, running: false });
  }

  function markAllSubagentCardsDone() {
    for (const id of subagentCards.keys()) markSubagentCardDone(id);
  }

  // 子 agent 卡内流式正文（与 getStream 同构，但挂到 sa.body，不进主流 streams Map）
  function getSubagentStream(sa, messageId) {
    const key = messageId || '_';
    let s = sa.streams.get(key);
    if (!s) {
      const wrap = el(`<div class="msg-body px-0.5 text-ink-soft whitespace-pre-wrap" data-testid="subagent-text"></div>`);
      const textNode = document.createTextNode('');
      wrap.appendChild(textNode);
      sa.body.appendChild(wrap);
      s = { el: wrap, raw: '', textNode };
      sa.streams.set(key, s);
    }
    return s;
  }

  function getSubagentThinking(sa, messageId) {
    const key = messageId || '_';
    let t = sa.thinkings.get(key);
    if (!t) {
      const wrap = el(`
        <details class="thinking rounded-lg bg-sunk/40 border border-line-soft text-xs text-ink-faint">
          <summary class="px-2 py-1">💭 思考过程</summary>
          <pre class="t-body px-2 pb-1 whitespace-pre-wrap"></pre>
        </details>`);
      const body = document.createTextNode('');
      wrap.querySelector('.t-body').appendChild(body);
      sa.body.appendChild(wrap);
      t = { body };
      sa.thinkings.set(key, t);
    }
    return t;
  }

  // ---- 审批完整性预检（NFR-17，承接 docs/design.md 协议步骤4）----
  // 渲染前（严格说：渲染后异步补验，见下）重算指纹比对服务端锚定的 fp，防传输层篡改（op 被改而 fp
  // 未同步改）。不阻塞卡片显示——真正的执行门槛在后端 resolvePermission（agent.js），这里只是"谨慎
  // 确认"提示，即使因浏览器兼容性等原因未能核验也不影响审批本身仍受后端 fail-closed 保护。
  async function verifyPermIntegrity(p) {
    if (!p.fp) return; // 服务端理论上总带 fp；防御性跳过，不误判
    if (typeof crypto === 'undefined' || !crypto.subtle) {
      // 非安全上下文（纯局域网 http:// 访问）：Web Crypto 不可用，前端预检优雅降级——
      // 后端完整性校验不受影响，仍是真正生效的门槛。
      console.warn('[integrity] crypto.subtle 不可用（非安全上下文），跳过前端预检');
      return;
    }
    let ok;
    try {
      ok = await verifyIntegrity(p.fp, { tool: p.name, args: p.input, cwd: p.cwd });
    } catch (e) {
      console.error('[integrity] 前端预检计算异常，不误判为篡改：', e.message);
      return;
    }
    if (!ok && activePerm?.requestId === p.requestId) showPermIntegrityWarning();
  }
  function showPermIntegrityWarning() {
    if (permIntegrityWarn) permIntegrityWarn.classList.remove('hidden');
  }

  // ---- 审批弹窗（4a：完整命令 + cwd）----
  function showNextPerm() {
    if (activePerm || permQueue.length === 0) return;
    activePerm = permQueue.shift();
    permTool.textContent = activePerm.name;
    permCwd.textContent = `工作目录：${activePerm.cwd}`;
    // 每张新卡片先重置警示条（上一张若显示过不应带到这张）；verifyPermIntegrity 若判定不符会异步重新显示。
    if (permIntegrityWarn) permIntegrityWarn.classList.add('hidden');
    // M1：超 4000 字显示展开按钮，而非截断（防恶意内容藏尾部）
    permExpandBtn?.remove(); permExpandBtn = null;
    const full = JSON.stringify(activePerm.input, null, 2);
    if (full.length > 4000) {
      permInput.textContent = full.slice(0, 4000);
      permExpandBtn = el(`<button class="text-xs text-accent mt-1 block">…显示全部（${full.length} 字符）</button>`);
      permExpandBtn.onclick = () => { permInput.textContent = full; permExpandBtn.remove(); permExpandBtn = null; };
      permInput.after(permExpandBtn);
    } else {
      permInput.textContent = full;
    }
    permAlways.checked = false;
    // ExitPlanMode：展示退出后权限档选择（对齐 CLI plan-exit）；其它工具隐藏
    selectedExitMode = 'default';
    if (permExitModeWrap) {
      const isExit = activePerm.name === 'ExitPlanMode';
      permExitModeWrap.classList.toggle('hidden', !isExit);
      if (isExit) {
        permExitModeWrap.querySelectorAll('.perm-exit-mode').forEach(btn => {
          const on = btn.getAttribute('data-exit-mode') === selectedExitMode;
          btn.classList.toggle('border-accent', on);
          btn.classList.toggle('bg-accent-wash', on);
          btn.classList.toggle('text-ink', on);
          btn.classList.toggle('border-line', !on);
          btn.classList.toggle('text-ink-soft', !on);
        });
      }
    }
    openSheet(permModal);
    updateSendButtonState();
  }
  function answerPerm(decision) {
    if (!activePerm) return;
    const wasExitPlanMode = activePerm.name === 'ExitPlanMode'; // 下方 activePerm 即置 null，提前捕获
    const payload = {
      requestId: activePerm.requestId,
      decision,
      alwaysThisSession: permAlways.checked,
      instanceId: viewingInstanceId, // 台阶3：路由到当前查看 tab 实例（切过去后审批的本就是该实例）
      // op：回传本卡片渲染时所见的确切操作（承接 docs/design.md NFR-17 审批完整性绑定协议步骤5）——
      // 服务端用它重算指纹比对 canUseTool 时锚定的 fp，不一致 fail-closed 拒绝（agent.js#resolvePermission）。
      op: { tool: activePerm.name, args: activePerm.input, cwd: activePerm.cwd }
    };
    // 仅 ExitPlanMode 批准时带 exitMode；拒绝/其它工具不传
    if (wasExitPlanMode && decision === 'allow') payload.exitMode = selectedExitMode || 'default';
    socket.emit('user:approve', payload);
    const exitNote = (wasExitPlanMode && decision === 'allow') ? ` → ${payload.exitMode}` : '';
    addBar(`${decision === 'allow' ? '✅ 已允许' : '🚫 已拒绝'}：${activePerm.name}${exitNote}`, 'text-ink-faint');
    activePerm = null;
    permExpandBtn?.remove(); permExpandBtn = null;
    closeSheet(permModal);
    showNextPerm();
    // ExitPlanMode 与 AskUserQuestion 同属「瞬间完成型」工具：无论批准/拒绝，该工具调用即结束、
    // 模型转入重新规划的长推理，而文案仍卡在已结束的「运行工具 ExitPlanMode」。仅此一类回落「思考中」
    // 填补空窗；普通工具批准后真要执行，「运行工具 X」是正确文案、不动。无下一待审才落。见 answerQuestion。
    if (wasExitPlanMode && !activePerm && activeStatusText) {
      activeStatusText.textContent = 'Claude 正在思考中...';
    }
    updateSendButtonState();
  }
  $('permAllow').onclick = () => answerPerm('allow');
  $('permDeny').onclick = () => answerPerm('deny');
  // ExitPlanMode 档位 chip 点选
  if (permExitModeWrap) {
    permExitModeWrap.querySelectorAll('.perm-exit-mode').forEach(btn => {
      btn.onclick = () => {
        selectedExitMode = btn.getAttribute('data-exit-mode') || 'default';
        permExitModeWrap.querySelectorAll('.perm-exit-mode').forEach(b => {
          const on = b.getAttribute('data-exit-mode') === selectedExitMode;
          b.classList.toggle('border-accent', on);
          b.classList.toggle('bg-accent-wash', on);
          b.classList.toggle('text-ink', on);
          b.classList.toggle('border-line', !on);
          b.classList.toggle('text-ink-soft', !on);
        });
      };
    });
  }

  // ---- 选择题弹窗（E7：AskUserQuestion）----
  function resetQuestionOtherUI() {
    if (questionOtherPanel) questionOtherPanel.classList.add('hidden');
    if (questionOtherInput) questionOtherInput.value = '';
  }
  function optionLabel(opt) {
    if (opt == null) return '';
    if (typeof opt === 'string') return opt;
    return opt.label || '';
  }
  function paintMultiOption(btn, selected) {
    btn.classList.toggle('border-accent', selected);
    btn.classList.toggle('bg-accent-wash', selected);
    btn.classList.toggle('border-line', !selected);
    btn.classList.toggle('bg-sunk', !selected);
  }
  function showNextQuestion() {
    if (activeQuestion || questionQueue.length === 0) return;
    activeQuestion = questionQueue.shift();
    multiSelectedIndexes = new Set();
    const multi = Boolean(activeQuestion.multiSelect);
    if (questionHeader) {
      const h = activeQuestion.header ? String(activeQuestion.header) : '';
      questionHeader.textContent = h;
      questionHeader.classList.toggle('hidden', !h);
    }
    questionText.textContent = activeQuestion.text;
    if (questionMultiHint) questionMultiHint.classList.toggle('hidden', !multi);
    if (questionMultiSubmit) {
      questionMultiSubmit.classList.toggle('hidden', !multi);
      questionMultiSubmit.disabled = true;
      questionMultiSubmit.textContent = '确认选择';
    }
    questionOptions.innerHTML = '';
    resetQuestionOtherUI();
    (activeQuestion.options || []).forEach((opt, i) => {
      const wrap = el(`<div class="rounded-lg border border-line bg-sunk overflow-hidden"></div>`);
      const btn = el(`<button type="button" class="w-full py-2.5 px-3 text-ink text-sm text-left"></button>`);
      const label = optionLabel(opt);
      btn.textContent = multi ? `☐ ${label}` : label;
      if (opt && typeof opt === 'object' && opt.description) {
        const desc = el(`<div class="px-3 pb-2 text-[11px] text-ink-faint leading-snug"></div>`);
        desc.textContent = opt.description;
        wrap.appendChild(btn);
        wrap.appendChild(desc);
      } else {
        wrap.appendChild(btn);
      }
      if (opt && typeof opt === 'object' && opt.preview) {
        const prevBtn = el(`<button type="button" class="w-full text-left px-3 pb-2 text-[11px] text-info underline">查看预览</button>`);
        const prevBox = el(`<pre class="hidden mx-3 mb-2 p-2 rounded bg-canvas border border-line-soft text-[11px] whitespace-pre-wrap break-words text-ink-soft max-h-40 overflow-y-auto"></pre>`);
        prevBox.textContent = String(opt.preview);
        prevBtn.onclick = (e) => {
          e.stopPropagation();
          prevBox.classList.toggle('hidden');
          prevBtn.textContent = prevBox.classList.contains('hidden') ? '查看预览' : '收起预览';
        };
        wrap.appendChild(prevBtn);
        wrap.appendChild(prevBox);
      }
      if (multi) {
        btn.onclick = () => {
          if (multiSelectedIndexes.has(i)) multiSelectedIndexes.delete(i);
          else multiSelectedIndexes.add(i);
          const on = multiSelectedIndexes.has(i);
          btn.textContent = `${on ? '☑' : '☐'} ${label}`;
          paintMultiOption(wrap, on);
          if (questionMultiSubmit) {
            questionMultiSubmit.disabled = multiSelectedIndexes.size === 0;
            questionMultiSubmit.textContent = multiSelectedIndexes.size
              ? `确认选择（${multiSelectedIndexes.size}）`
              : '确认选择';
          }
        };
      } else {
        btn.onclick = () => answerQuestion(i);
      }
      questionOptions.appendChild(wrap);
    });
    openSheet(questionModal);
    updateSendButtonState();
  }
  function finishQuestionUI(barText) {
    activeQuestion = null;
    multiSelectedIndexes = new Set();
    closeSheet(questionModal);
    resetQuestionOtherUI();
    showNextQuestion();
    // 答完最后一题（队列已空、无下一题）：立即把状态栏从过时的「正在运行工具 AskUserQuestion」
    // 切到「思考中」，填补「答完→模型首个流式事件到达」的空窗（实测中位 ~64s 模型推理）。
    if (!activeQuestion && activeStatusText) {
      activeStatusText.textContent = 'Claude 正在思考中...';
    }
    if (barText) addBar(barText, 'text-ink-faint');
    updateSendButtonState();
  }
  function answerQuestion(index) {
    if (!activeQuestion) return;
    // 先标记已答再 emit/关窗：紧接的切会话/sync 即使抢在 server resolve 前到达，也不会重弹
    markQuestionAnswered(activeQuestion.requestId);
    socket.emit('user:answer', { requestId: activeQuestion.requestId, optionIndex: index, instanceId: viewingInstanceId }); // 台阶3 路由
    const label = optionLabel(activeQuestion.options[index]);
    finishQuestionUI(`已选择：${label}`);
  }
  function answerQuestionMulti() {
    if (!activeQuestion || !multiSelectedIndexes.size) {
      addBar('请至少选择一项', 'text-info');
      return;
    }
    const indexes = [...multiSelectedIndexes].sort((a, b) => a - b);
    markQuestionAnswered(activeQuestion.requestId);
    socket.emit('user:answer', { requestId: activeQuestion.requestId, optionIndexes: indexes, instanceId: viewingInstanceId });
    const labels = indexes.map(i => optionLabel(activeQuestion.options[i])).filter(Boolean);
    finishQuestionUI(`已选择：${labels.join('、')}`);
  }
  function answerQuestionOther() {
    if (!activeQuestion) return;
    const freeText = (questionOtherInput?.value || '').trim();
    if (!freeText) {
      addBar('请先输入其他答案', 'text-info');
      questionOtherInput?.focus();
      return;
    }
    markQuestionAnswered(activeQuestion.requestId);
    socket.emit('user:answer', { requestId: activeQuestion.requestId, freeText, instanceId: viewingInstanceId });
    finishQuestionUI(`已回答（其他）：${freeText}`);
  }
  if (questionMultiSubmit) questionMultiSubmit.onclick = () => answerQuestionMulti();
  if (questionOtherToggle) {
    questionOtherToggle.onclick = () => {
      if (!questionOtherPanel) return;
      questionOtherPanel.classList.toggle('hidden');
      if (!questionOtherPanel.classList.contains('hidden')) questionOtherInput?.focus();
    };
  }
  if (questionOtherSubmit) questionOtherSubmit.onclick = () => answerQuestionOther();
  if (questionOtherInput) {
    questionOtherInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); answerQuestionOther(); }
    });
  }
  // 跳过/中止：复用 user:interrupt。后端 handleQuestion 已监听 abort → deny「问题已取消」；
  // 弹窗内必须自带此入口——遮罩盖住输入区「停止」时否则无路可走。
  // 不在本地乐观关窗：等 request_resolved(aborted) / result 走既有清理，避免多设备/重放分叉。
  if (questionSkip) {
    questionSkip.onclick = () => {
      if (!activeQuestion) return;
      haptic('tap');
      addBar('已跳过提问（中止本轮）', 'text-ink-faint');
      requestInterrupt();
    };
  }
  // 权限弹窗内「中止本轮」：对齐 CLI Esc，遮罩盖住输入区停止键时仍可中止
  if (permInterrupt) {
    permInterrupt.onclick = () => {
      if (!activePerm) return;
      haptic('tap');
      addBar('已请求中止本轮', 'text-ink-faint');
      requestInterrupt();
    };
  }

  // ---- 发送 / 停止 ----
  function send() {
    ensureAlertAudio(); // 发送=用户手势：解锁 WebAudio，本轮完成后提示音才能响
    if (mirrorReadonlySid) { // 只读追平中：硬拦截，防与终端并发写盘分叉（点「接管 CLI 会话」可接管）
      addBar('此会话正在终端运行，只读中——点「接管 CLI 会话」可在手机继续', 'text-danger');
      return;
    }
    if (inputEl.disabled) {
      addBar('请先完成设备授权或解除只读状态，再发送新消息', 'text-info');
      return;
    }
    if (activePerm || activeQuestion) {
      addBar('请先处理当前审批或选择，再发送新消息', 'text-info');
      return;
    }
    const rawText = inputEl.value.trim();
    if (ultracodeArmed && !rawText && attachments.items().length === 0) {
      addBar('ultracode 档需要先输入任务再发送', 'text-info');
      inputEl.focus();
      return;
    }
    const text = ultracodeArmed ? withUltracodeKeyword(rawText) : rawText; // ultracode 档：每轮注入关键词触发 Workflow
    if (!text && attachments.items().length === 0) return; // E17：纯附件（空文本）也可发
    // /model 前端拦截——TUI 命令不可透传，映射到 F1 模型切换通道（下一条消息经 setModel 生效）。
    // 纯本地操作，置于断线检查之前；若未来 CLI 把 model 纳入 slash_commands 则让位透传
    if (/^\/model(\s|$)/.test(text) && !(window.availableSkills || []).includes('model')) {
      const arg = text.slice(6).trim();
      if (arg) {
        let nakedArg = arg;
        const match = arg.match(/\[[^\]]+\]$/);
        if (match) {
          currentGatewaySuffix = match[0];
          nakedArg = arg.replace(/\[[^\]]+\]$/, '');
          modelInput.dataset.fullModel = arg;
        } else {
          currentGatewaySuffix = '';
          delete modelInput.dataset.fullModel;
        }
        ensureModelOption(nakedArg, '手动设置'); // select 候选外的任意名（如网关别名）动态插入
        modelInput.value = nakedArg;
        syncModelUI(nakedArg);
        addBar(`模型已设为 ${nakedArg}${currentGatewaySuffix}（下一条消息生效）`, 'text-info');
      } else {
        const pending = modelInput.value.trim();
        const opts = [...modelInput.options].map(o => o.value).filter(Boolean);
        addBar(`当前模型：${currentModel || '默认'}${currentGatewaySuffix}${pending && pending !== currentModel ? `；下一条消息起：${pending}${currentGatewaySuffix}` : ''}${opts.length ? `；可选：${opts.join('、')}` : ''}`, 'text-info');
      }
      inputEl.value = '';
      hints.classList.add('hidden');
      autosize();
      return;
    }
    let model = modelInput.dataset.fullModel || modelInput.value.trim() || undefined;
    // S5：仅对「不在 supportedModels 候选里的自设名」(如 /model 手设并剥离了后缀的) 回贴网关后缀。
    // 候选内的值本就是网关合法完整名(裸别名 opus/sonnet 或显式 deepseek-v4-pro[1m])，原样发送——
    // 否则会把上个模型的后缀错贴到用户新选的别的候选(opus→opus[1m]，网关不认)。
    if (model && currentGatewaySuffix && !modelsList.some(m => (typeof m === 'string' ? m : m?.value) === model)) {
      model = model + currentGatewaySuffix;
    }
    // E17：剥掉本地 _id（非契约字段），data=完整 base64、thumb=小缩略图随消息上传
    const outgoingAttachments = attachments.items().length
      ? attachments.payload()
      : undefined;
    // REL-01：客户端消息 ID——离线重发/网络抖动可能致同一条消息被处理两次，服务端据此去重（message-dedup.js）。
    // 在线/离线两条路径共享同一个 ID（在离线分支判断前生成）。
    const clientMessageId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

    // BE-002：长度预检必须在离线入队【之前】——否则离线时超长消息也会进 offlineQueue，重连重发被服务端拒，
    // 反复无法送达。提前拦下，超长消息根本不入队（在线分支原来的重复校验已随之移到这里）。
    if (typeof text === 'string' && text.length > 50000) {
      addBar(`消息过长（${text.length}/50000），未发送`, 'text-danger');
      return;
    }

    // M2 / Weak Network Optimistic Sending Queue:
    if (!socket.connected) {
      // 离线状态：生成乐观消息气泡占位符，保存到离线重发队列，待重连后自动重发
      haptic('tap');
      const bubble = el(`<div class="msg-frame rounded-xl bg-user text-ink px-3 py-2 text-sm opacity-70 transition-opacity"></div>`);
      if (text) {
        const t = el(`<div class="whitespace-pre-wrap"></div>`);
        t.textContent = text;
        // 离线乐观占位符气泡也折叠（与已确认气泡一致，长指令发出去那刻就折）
        foldLongUserText(t, text);
        bubble.appendChild(t);
      }
      
      // 添加离线待发送的附件缩略 chip/图片预览，让离线体验达到原生级
      if (outgoingAttachments && outgoingAttachments.length) {
        const wrap = el(`<div class="flex flex-wrap gap-2${text ? ' mt-2' : ''}"></div>`);
        for (const a of attachments.items()) { // controller 中保留 thumb 供气泡预览
          if (a.thumb) {
            const img = el(`<img class="max-w-[8rem] max-h-32 rounded-lg">`);
            img.src = a.thumb; img.title = a.name || '';
            wrap.appendChild(img);
          } else {
            const chip = el(`<div class="flex items-center gap-1 bg-sunk rounded-lg px-2 py-1 text-xs max-w-[12rem]"><span class="shrink-0">📎</span></div>`);
            const nm = el(`<span class="truncate"></span>`); nm.textContent = a.name || '附件';
            chip.appendChild(nm);
            wrap.appendChild(chip);
          }
        }
        bubble.appendChild(wrap);
      }
      
      const indicator = el(`<div class="pending-indicator text-[11px] text-ink-faint mt-1 animate-pulse">🕐 正在等待连接...</div>`);
      bubble.appendChild(indicator);
      appendMessage(bubble);
      
      offlineQueue.push({
        text,
        model,
        attachments: outgoingAttachments,
        bubbleEl: bubble,
        clientMessageId,
        // REL-01：保存入队时刻的目标，重发时须用这个而非"当下"的 viewingInstanceId/currentCwd——
        // 否则用户离线期间切换了查看的会话，消息会被错发到现在正看着的会话，而非当初想发的那个。
        instanceId: viewingInstanceId,
        cwd: currentCwd
      });
      
      inputEl.value = '';
      // 已发出：清掉该会话缓存草稿，避免切走切回把已发送内容当草稿恢复
      if (currentSessionId) sessionDraftCache.delete(currentSessionId);
      attachments.clear();
      hints.classList.add('hidden');
      autosize();
      scrollBottom(true);
      return;
    }

    if (text.startsWith('/')) addBar(`⚡ 命令：${text}`, 'text-info');
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {});
    }

    // 台阶3：instanceId 路由到当前查看 tab；cwd 供无 tab（首发/session:new 后）时服务端懒开实例
    const attCount = Array.isArray(outgoingAttachments) ? outgoingAttachments.length : 0;
    logClientEvent('send', `[WEB_SEND] 发送消息: "${text.slice(0, 100)}${text.length > 100 ? '...' : ''}" (${text.length} 字符), model=${model || '未指定(沿用)'}, 附件数=${attCount}, instanceId=${viewingInstanceId || 'new'}`);
    socket.emit('user:message', { text, model, attachments: outgoingAttachments, instanceId: viewingInstanceId, cwd: currentCwd, clientMessageId });
    // F3：不再本地 append 气泡，由 user_message 事件渲染（同时入缓冲，重载可回放）
    inputEl.value = '';
    // 已发出：清掉该会话缓存草稿，避免切走切回把已发送内容当草稿恢复
    if (currentSessionId) sessionDraftCache.delete(currentSessionId);
    attachments.clear();
    hints.classList.add('hidden');
    autosize();
    setBusy(true);
    // 新会话首发（viewingInstanceId 为空）：服务端将懒开实例并广播 instances，触发 setInstances→bindView→
    // clearView 的 setBusy(false) 冲掉这次乐观 busy；置一次性标志，待 setInstances 绑定到新实例后同步补回。
    if (!viewingInstanceId) _pendingFirstSend = true;
    scrollBottom(true);
  }
  btnSend.onclick = send;
  // 移动端回车发送截断修复（2026-07-13 排查报告 §4/§8.1）：触屏软键盘没有 Shift+Enter 这个换行
  // 逃生舱，回车恒当发送键会把长消息在换行处截断。触摸设备下回车走 textarea 默认换行，发送收窄为
  // 仅走发送按钮；enterkeyhint 同步改 'enter'，避免部分输入法把回车当 action 直接派发而非插入换行符。
  const isTouchDevice = matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;
  inputEl.enterKeyHint = isTouchDevice ? 'enter' : 'send';
  // 中文输入法：e.isComposing + keyCode 229 双检已覆盖绝大多数现代浏览器，
  // composition 状态追踪作为旧浏览器（Safari <14、部分 Android WebView）的后备兜底
  let composing = false;
  inputEl.addEventListener('compositionstart', () => { composing = true; });
  inputEl.addEventListener('compositionend', () => { composing = false; });
  inputEl.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229 && !composing && shouldSendOnEnter({ shiftKey: e.shiftKey, isTouchDevice })) {
      e.preventDefault();
      send();
    }
  });

  // ---- 输入与附件：状态、读取、预览和 DOM 绑定由独立 controller 管理 ----
  const attachments = createAttachmentController(appContext, {
    addBar,
    createElement: el,
    haptic,
    onChange: updateSendButtonState,
    scheduleInsetResettle: () => scheduleInsetResettle(),
  });
  // ---- 斜杠命令提示 ----
  const hints = el(`<div id="cmdHints" class="hidden absolute bottom-full left-0 mb-1 bg-surface border border-line rounded-lg max-h-60 overflow-y-auto w-full z-50" style="box-shadow:var(--shadow-pop)"></div>`);
  inputEl.parentElement.style.position = 'relative';
  inputEl.parentElement.appendChild(hints);
  // 前端本地拦截命令（不透传后端），并入提示列表
  const LOCAL_COMMANDS = ['model'];

  inputEl.addEventListener('input', () => {
    const val = inputEl.value;
    if (val.startsWith('/')) {
      const base = (window.availableSkills || []).map(slashCommandName).filter(Boolean);
      const cands = base.concat(LOCAL_COMMANDS.filter(c => !base.includes(c)));
      const prefix = val.slice(1).toLowerCase();
      const matches = prefix ?
        cands.filter(cmd => cmd.toLowerCase().startsWith(prefix)) :
        cands;
      if (matches.length > 0) {
        hints.innerHTML = matches.map(cmd => {
          const safe = esc(cmd);
          return `<div class="px-3 py-2 hover:bg-sunk cursor-pointer text-sm font-mono" data-cmd="/${safe}">/${safe}</div>`;
        }).join('');
        hints.classList.remove('hidden');
      } else {
        hints.classList.add('hidden');
      }
    } else {
      hints.classList.add('hidden');
    }
    autosize();
  });

  hints.addEventListener('click', e => {
    const cmd = e.target.dataset.cmd;
    if (cmd) { inputEl.value = cmd + ' '; inputEl.focus(); hints.classList.add('hidden'); autosize(); }
  });
  document.addEventListener('click', e => {
    if (!hints.contains(e.target) && e.target !== inputEl) hints.classList.add('hidden');
    if (!leftSidebar.classList.contains('-translate-x-full') && !leftSidebar.contains(e.target) && !btnSessions.contains(e.target) && !(topContextPill && topContextPill.contains(e.target)) && e.target.isConnected)
      closeLeftSidebar();
  });

  function updateSendButtonState() {
    const hasText = inputEl.value.trim().length > 0 || attachments.items().length > 0;
    const blockedByUserRequest = !!activePerm || !!activeQuestion;
    const blockedByDisabledInput = inputEl.disabled;
    if (hasText && !_queueFull && !blockedByUserRequest && !blockedByDisabledInput) {
      btnSend.className = "flex items-center justify-center w-9 h-9 rounded-full bg-ink text-surface hover:bg-ink-soft active:scale-95 shadow-sm transition-all duration-200 shrink-0";
      btnSend.disabled = false;
      btnSend.title = '';
    } else {
      btnSend.className = "flex items-center justify-center w-9 h-9 rounded-full bg-transparent text-ink-faint opacity-40 cursor-not-allowed transition-all duration-200 shrink-0";
      btnSend.disabled = true;
      btnSend.title = blockedByUserRequest
        ? '请先处理当前审批或选择'
        : (blockedByDisabledInput ? '请先完成设备授权或解除只读状态' : (_queueFull ? '前面已有消息在排队，请等当前任务结束' : ''));
    }
  }

  function autosize() {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 144) + 'px';
    updateSendButtonState();
  }
  updateSendButtonState();

  function requestInterrupt() {
    if (interruptPending) return;
    interruptPending = true;
    if (btnStop) btnStop.disabled = true;
    if (btnStopNew) btnStopNew.disabled = true;
    socket.emit('user:interrupt', { instanceId: viewingInstanceId }); // 台阶3：中断当前查看 tab 的在途任务
  }

  btnStop.onclick = requestInterrupt;
  if (btnStopNew) {
    btnStopNew.onclick = () => {
      haptic('tap');
      requestInterrupt();
    };
  }

  // ---- 权限档切换（6 档；dontAsk/auto 非交互档，终端只切得到 default/plan/acceptEdits/bypass）----
  // setPermMode 仅由 init/permission_mode 服务端事件驱动（权威回执，函数声明有提升），onchange 不再
  // 乐观调用——故上屏的系统条 = 服务端已确认切换。程序设 select.value 不触发 onchange，无回声循环。
  const PERM_LABEL = {
    default: '默认（白名单外弹窗审批）',
    plan: '计划模式',
    acceptEdits: '自动接受编辑',
    dontAsk: '免打扰（白名单外直接拒）',
    auto: 'Auto（LLM 自动判批/拒权限）',
    bypassPermissions: '⚠️ bypass（跳过所有审批）'
  };
  function clearCliUnknownPermissionOption() {
    permModeSelect?.querySelector('option[data-cli-observed-unknown]')?.remove();
  }
  function setPermMode(mode, silent = false) {
    if (!permModeSelect || !mode) return;
    clearCliUnknownPermissionOption();
    if (!silent && permModeSeen && mode !== currentPermMode) {
      addBar(`权限档 → ${PERM_LABEL[mode] || mode}`,
        mode === 'bypassPermissions' ? 'text-danger' : 'text-ink-faint');
    }
    permModeSeen = true;
    currentPermMode = mode;
    permModeSelect.value = mode;
    const danger = mode === 'bypassPermissions';
    permModeSelect.classList.toggle('ring-1', danger);
    permModeSelect.classList.toggle('ring-danger', danger);
    permModeSelect.classList.toggle('text-danger', danger);

    // Sync Pill Display Text
    if (pillPermText) {
      const labels = {
        default: '默认审批',
        plan: '计划模式',
        acceptEdits: '自动接受编辑',
        dontAsk: '免打扰',
        auto: 'Auto',
        bypassPermissions: 'Bypass'
      };
      pillPermText.textContent = labels[mode] || mode;
    }

    // Sync Custom Perm Tiles Selection Styling
    if (customPermGrid) {
      customPermGrid.querySelectorAll('.perm-tile').forEach(tile => {
        const isCurrent = tile.dataset.mode === mode;
        if (isCurrent) {
          tile.classList.add('ring-1', 'ring-accent', 'border-accent', 'bg-accent-wash/30');
          const title = tile.querySelector('.text-xs');
          if (title) title.classList.add('text-accent');
        } else {
          tile.classList.remove('ring-1', 'ring-accent', 'border-accent', 'bg-accent-wash/30');
          const title = tile.querySelector('.text-xs');
          if (title) title.classList.remove('text-accent');
        }
      });
    }
  }
  permModeSelect.onchange = () => {
    // 单驾驶员：终端驾驶中（只读锁）设置一并冻结——权限档实际只作用于 web 自己的实例、碰不到终端进程，
    // 此刻切档只会造成「我切了怎么终端没变」的误解；接管后再调。拨回 select 防 UI 与实际档漂移。
    if (mirrorReadonlySid) { permModeSelect.value = currentPermMode; addBar('终端驾驶中，设置已冻结——接管后可调', 'text-info'); return; }
    const mode = permModeSelect.value;
    if (mode === currentPermMode) return;
    // bypass 二次危险确认（终端等价：终端首次 bypass 亦需确认）；取消则回退 select
    if (mode === 'bypassPermissions' &&
        !confirm('⚠️ 切到 bypass（跳过所有审批）\n\nclaude 将无需确认即可改文件、跑命令；一次提示注入即可波及整台机器。\n确定开启？')) {
      permModeSelect.value = currentPermMode;
      return;
    }
    socket.emit('user:setPermissionMode', { mode });
    // 不乐观更新：等 server 广播 permission_mode（成功回执，毫秒级）驱动 setPermMode 拨档 + 上屏；
    // 失败则 agent 发 error 红条且不广播，下轮 init 拨回 select
  };

  // ---- 思考强度切换（5 档对应终端 /effort；切档=实例置换、下条消息生效）----
  // setEffortMode 仅由 effort_mode 服务端事件驱动（成功回执广播 / 拒切拨回单发），onchange 不乐观更新。
  function setEffortMode(level, silent = false) {
    if (!effortSelect) return;
    const val = level || null; // 空串/undefined 归一为 null（模型默认）
    // ultracode 档借道 xhigh：后端只回 xhigh，用本地 ultracodeArmed 决定呈现名
    if (!silent && effortSeen && val !== currentEffort) {
      addBar(`思考强度 → ${ultracodeArmed ? 'ultracode' : (val || '模型默认')}（下一条消息生效）`, 'text-ink-faint');
    }
    effortSeen = true;
    currentEffort = val;
    effortSelect.value = val || '';

    // Sync Pill Display Text（武装 ultracode 时显 ultracode，而非后端真值 xhigh）
    if (pillEffortText) {
      pillEffortText.textContent = ultracodeArmed ? 'ultracode' : (val || '默认思考');
    }

    // Sync Custom Effort Tiles Selection Styling（武装 ultracode 时高亮最高档，而非后端真值 xhigh）
    if (customEffortGrid) {
      const activeLevel = ultracodeArmed ? 'ultracode' : (val || '');
      customEffortGrid.querySelectorAll('.effort-tile').forEach(tile => {
        const tileVal = tile.dataset.level || '';
        const isCurrent = activeLevel === tileVal;
        if (isCurrent) {
          tile.classList.add('ring-1', 'ring-accent', 'border-accent', 'text-accent', 'bg-accent-wash/30');
          const title = tile.querySelector('.text-xs') || tile;
          title.classList.add('text-accent');
        } else {
          tile.classList.remove('ring-1', 'ring-accent', 'border-accent', 'text-accent', 'bg-accent-wash/30');
          const title = tile.querySelector('.text-xs') || tile;
          title.classList.remove('text-accent');
        }
      });
    }
  }
  // 把当前模型（init.model 规范名）桥接到 models 候选项（取其 supportedEffortLevels）。
  // 先精确 value 命中；否则 alias↔规范名桥接：剥 [Nm] 上下文后缀，候选别名作为 family 子串落在规范名里、
  // 且后缀一致（如 claude-opus-4-8[1m] ↔ opus[1m]）。纯从 SDK 列表派生，不硬编码任何模型名。
  // effort 档位按当前模型动态渲染（CLI/SDK 透传，不硬编码）：决策在 logic.js 的 effortLevelsFor，此处只渲染。
  function rebuildEffortOptions(modelValue) {
    if (!effortSelect) return;
    const { hidden, levels: baseLevels } = effortLevelsFor(modelValue, modelsList);
    const show = withUltracodeTier(baseLevels); // xhigh-capable 模型上追加 ultracode 最高档，镜像 CLI /effort
    if (hidden) {
      // 候选明确声明该模型不支持 effort（区别于“当前 CLI 档未知”）：Web 驾驶时把实例档清回
      // model-default，等服务端 effort_mode 回执再更新 currentEffort；CLI 镜像只读态绝不写回。
      if (!mirrorReadonlySid && currentEffort !== null) socket.emit('user:setEffort', { level: null });
      effortSelect.value = '';
      if (customEffortGrid) customEffortGrid.innerHTML = '';
      effortRow?.classList.add('hidden');
      pillEffort?.classList.add('hidden');
      customEffortGroup?.classList.add('hidden');
      return;
    }
    effortRow?.classList.remove('hidden');
    pillEffort?.classList.remove('hidden');
    customEffortGroup?.classList.remove('hidden');

    // 候选列表只决定「能选什么」，不得改写当前档事实。CLI 镜像拿不到档位时保留 null/未知，
    // 不能因为候选第一项是 low 就谎报 low；FRESH settings=low 会由服务端明确下发，仍正常选中。
    const ui = effortUiState(currentEffort, show, { mirrorReadonly: Boolean(mirrorReadonlySid) });
    effortSelect.innerHTML = '';
    if (!ui.selected && !ultracodeArmed) {
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = ui.placeholder;
      placeholder.disabled = true;
      effortSelect.appendChild(placeholder);
    }
    for (const lv of show) {
      const o = document.createElement('option');
      o.value = lv;
      o.textContent = lv;
      effortSelect.appendChild(o);
    }
    effortSelect.value = ultracodeArmed ? 'ultracode' : ui.selected;

    if (customEffortGrid) {
      customEffortGrid.innerHTML = '';
      const currentVal = ultracodeArmed ? 'ultracode' : (effortSelect.value || '');
      for (const lv of show) {
        const active = currentVal === lv;
        const isUltra = lv === 'ultracode';
        const sub = isUltra ? 'xhigh + 多 agent workflow · 最彻底，更慢更费额度' : `思考等级: ${lv}`;
        const lvTile = el(`
          <div data-level="${lv}" class="effort-tile p-2.5 rounded-xl border border-line bg-surface active:bg-sunk cursor-pointer transition-all ${active ? 'ring-1 ring-accent border-accent text-accent bg-accent-wash/30' : ''}">
            <div class="text-xs font-semibold ${active ? 'text-accent' : 'text-ink'}">${lv}</div>
            <div class="text-[9.5px] text-ink-soft mt-0.5">${sub}</div>
          </div>
        `);
        lvTile.onclick = () => {
          haptic('tap');
          effortSelect.value = lv;
          effortSelect.onchange();
        };
        customEffortGrid.appendChild(lvTile);
      }
    }
    // 同步 pill 文案（无「模型默认」伪档后 pill 应显真实档名）
    if (pillEffortText) {
      pillEffortText.textContent = ultracodeArmed ? 'ultracode' : ui.label;
    }
  }
  effortSelect.onchange = () => {
    // 单驾驶员：终端驾驶中设置冻结（同 permModeSelect.onchange）——effort 切档还会 dispose+重开实例、
    // 往终端正在写的 transcript 里插 mode 记录行，驾驶期间尤其不该发生。拨回防漂移。
    if (mirrorReadonlySid) { effortSelect.value = currentEffort || ''; addBar('终端驾驶中，设置已冻结——接管后可调', 'text-info'); return; }
    // ultracode 档在 SDK 层不存在：解析成「借道 xhigh + 武装关键词」。effort 始终是后端认得的合法值。
    const { effort, ultracode } = resolveEffortSelection(effortSelect.value || null);
    const armedChanged = ultracode !== ultracodeArmed;
    ultracodeArmed = ultracode;
    if (effort !== currentEffort) {
      socket.emit('user:setEffort', { level: effort });
      // 体感：置换实例有冷启动延迟；server 也会 emit kind:resuming system，这里立刻本地提示一次
      addBar('正在切换思考强度并续接会话…', 'text-ink-faint');
      // 不乐观更新：成功则 effort_mode 广播拨档 + 上屏（setEffortMode 读 ultracodeArmed 决定显名）；
      // busy/非法档则 server 发 system 提示并单发当前档拨回本设备 select
    } else if (armedChanged) {
      // effort 未变、仅 ultracode 武装态翻转（xhigh ↔ ultracode）：无后端往返、免会话重建，本地即时刷新
      setEffortMode(currentEffort, true);
      addBar(ultracode ? 'ultracode：xhigh + 多 agent workflow（更彻底，更慢更费额度）' : `思考强度 → ${currentEffort || '模型默认'}`, 'text-ink-faint');
    }
  };

  // ---- 工作目录切换（台阶1：多目录单并发）----
  // basename：路径太长，目录切换器/顶部胶囊只显末段，title 挂全路径兜底重名
  const baseName = projectDisplayName;

  // 切 tab：静默把顶部面板（权限档/思考强度/模型 select）同步到目标实例的档。上下文恢复显示、
  // 非用户主动切档 → silent=true 不上屏系统条。model 先于 effort（effort 档位按当前模型 rebuildEffortOptions
  // 渲染）；空 model 跳过、不清空 select。先于 bindView 的 sync:since 回放执行——回放若含
  // init/permission_mode/effort_mode，因值已一致不会重复上屏。
  function adoptPanelState(inst) {
    if (!inst) return; // 新会话尚无实例（viewingInstanceId=null）：保持现状不乱跳
    // 始终更新模型显示——即使 inst.model 为 null/空也清掉旧值，防切换工作区时上个区的模型名泄漏
    const rawModel = inst.model || '';
    updateModelAndSuffix(rawModel);
    const effortModelValue = rawModel || currentModel;
    if (modelInput) {
      if (inst.model) {
        ensureModelOption(currentModel);
        modelInput.value = currentModel;
        rebuildEffortOptions(effortModelValue);
      } else {
        modelInput.value = '';
      }
      syncModelUI(currentModel);
    }
    setPermMode(inst.permissionMode || 'default', true);
    setEffortMode(inst.effort ?? null, true);
    rebuildEffortOptions(effortModelValue);
  }

  function captureWebPanelState() {
    return {
      model: currentModel ? `${currentModel}${currentGatewaySuffix}` : null,
      selectedModel: modelInput?.value || '',
      selectedFullModel: modelInput?.dataset.fullModel || '',
      gatewaySuffix: currentGatewaySuffix,
      permissionMode: currentPermMode || 'default',
      effort: currentEffort,
      ultracodeArmed,
    };
  }

  function renderCliPermissionMode(mode) {
    if (mode) {
      setPermMode(mode, true);
      return;
    }
    clearCliUnknownPermissionOption();
    const unknown = document.createElement('option');
    unknown.value = '';
    unknown.textContent = 'CLI 当前模式未知';
    unknown.disabled = true;
    unknown.dataset.cliObservedUnknown = '1';
    permModeSelect?.prepend(unknown);
    currentPermMode = '';
    if (permModeSelect) permModeSelect.value = '';
    if (pillPermText) pillPermText.textContent = 'CLI 模式未知';
    permModeSelect?.classList.remove('ring-1', 'ring-danger', 'text-danger');
    customPermGrid?.querySelectorAll('.perm-tile').forEach(tile => {
      tile.classList.remove('ring-1', 'ring-accent', 'border-accent', 'bg-accent-wash/30');
      tile.querySelector('.text-xs')?.classList.remove('text-accent');
    });
  }

  function renderCliPanelState() {
    const panel = resolvePanelState({
      mirrorReadonly: true,
      observedCli: mirrorObservedCli,
      web: mirrorWebPanelSnapshot,
    });
    const rawModel = panel.model || '';
    updateModelAndSuffix(rawModel);
    if (modelInput) {
      delete modelInput.dataset.fullModel;
      if (rawModel) {
        ensureModelOption(currentModel, 'CLI 当前模型');
        modelInput.value = currentModel;
      } else {
        modelInput.value = '';
        if (pillModelText) pillModelText.textContent = 'CLI 模型未知';
        if (pillModel) pillModel.title = 'CLI 当前模型未知';
        customModelGrid?.querySelectorAll('.model-tile').forEach(tile => {
          tile.classList.remove('ring-1', 'ring-accent', 'border-accent', 'text-accent', 'bg-accent-wash/30');
          const title = tile.querySelector('.text-xs');
          title?.classList.remove('text-accent');
          title?.classList.add('text-ink');
        });
      }
    }
    renderCliPermissionMode(panel.permissionMode);
    setEffortMode(panel.effort, true);
    rebuildEffortOptions(rawModel || cwdDefaultModel);
  }

  function restoreWebPanelState() {
    const saved = mirrorWebPanelSnapshot;
    if (!saved) return;
    const panel = resolvePanelState({ mirrorReadonly: false, observedCli: mirrorObservedCli, web: saved });
    ultracodeArmed = saved.ultracodeArmed === true;
    updateModelAndSuffix(panel.model || '');
    currentGatewaySuffix = saved.gatewaySuffix || currentGatewaySuffix;
    if (modelInput) {
      if (saved.selectedModel) {
        ensureModelOption(saved.selectedModel);
        modelInput.value = saved.selectedModel;
      } else {
        modelInput.value = '';
      }
      if (saved.selectedFullModel) modelInput.dataset.fullModel = saved.selectedFullModel;
      else delete modelInput.dataset.fullModel;
      syncModelUI(saved.selectedModel || currentModel);
    }
    setPermMode(panel.permissionMode || 'default', true);
    setEffortMode(panel.effort, true);
    rebuildEffortOptions(saved.selectedModel || currentModel || cwdDefaultModel);
  }

  // tab 栏快照回执/重放（台阶3，Step A+B 均已落地）。首次只定基线不动视图（刷新/重连不清空）；
  // viewingInstanceId 变了才切视图（bindView：sync 活缓冲/回退 history）；cwd 变了全量刷新面板。
  // dirs + per-cwd 聚合 states 供目录切换器角标（steps 回归补回入口，见 openSessionPanel）。
  // ②2c：通知深链落地——把 {instanceId, sessionId, cwd} 切到对应会话。来源两条：ntfy click / SW openWindow
  // 的 URL hash（启动时解析）、SW postMessage（运行时）。instances 未就绪（冷启动竞态）时暂存，首个
  // setInstances 消费一次；实例已失效走 session:switch 懒 resume（服务端校验归属），定位不到则打开会话列表。
  let pendingDeepLink = null;
  function applyDeepLink(target) {
    if (!target || !target.instanceId) return;
    if (!instancesReady) { pendingDeepLink = target; return; }
    const r = resolveDeepLinkTarget(target, instancesList);
    if (r.action === 'setViewing') {
      if (r.instanceId !== viewingInstanceId) socket.emit('user:setViewing', { instanceId: r.instanceId });
      closeLeftSidebar();
    } else if (r.action === 'switch') {
      closeLeftSidebar();
      socket.emit('session:switch', { sessionId: r.sessionId, cwd: r.cwd }, res => {
        if (!res?.ok) addBar(res?.error || '深链目标会话已不可用', 'text-warning');
      });
    } else {
      openLeftSidebar(); // 定位不到（缺 sessionId / 无 instanceId）→ 打开会话列表让用户手选
    }
  }

  // ②2c：深链入口初始化（首次 connect 调一次，幂等防重连重复注册）。hash 来自 ntfy click / SW openWindow；
  // message 来自 SW postMessage（已开窗口场景）。两条最终都汇入 applyDeepLink。
  let deepLinkInited = false;
  function initDeepLinkOnce() {
    if (deepLinkInited) return;
    deepLinkInited = true;
    const p = new URLSearchParams(location.hash.slice(1));
    if (p.get('instance')) {
      applyDeepLink({ instanceId: p.get('instance'), sessionId: p.get('session') || undefined, cwd: p.get('cwd') || undefined });
      history.replaceState(null, '', location.pathname + location.search); // 清 hash，防刷新重复触发
    }
    navigator.serviceWorker?.addEventListener('message', ev => {
      if (ev.data?.type === 'ccm:deeplink') {
        applyDeepLink({ instanceId: ev.data.instanceId, sessionId: ev.data.sessionId, cwd: ev.data.cwd });
      }
    });
  }

  function setInstances(p) {
    availableDirs = Array.isArray(p?.dirs) ? p.dirs : [];
    const prevInstances = instancesList;
    instancesList = Array.isArray(p?.instances) ? p.instances : [];
    needsYouList = Array.isArray(p?.needsYou) ? p.needsYou : [];
    // cwd 默认模型：捕获旧值 + currentModel（下方 adoptPanelState 会改 currentModel），末尾据此决定是否重建默认磁贴标签。
    // 非 string（含 null=未探到）归一空 → 切到无默认的 cwd 自动清、不残留上区默认。
    const prevDefaultModel = cwdDefaultModel, prevCurrentModel = currentModel;
    cwdDefaultModel = (typeof p?.defaultModel === 'string') ? p.defaultModel : '';
    // 实例集变化时清除会话缓存，防止关闭的会话以幽灵数据残留
    const prevIds = new Set(prevInstances.map(x => x.instanceId));
    const currIds = new Set(instancesList.map(x => x.instanceId));
    if (prevIds.size !== currIds.size || ![...currIds].every(id => prevIds.has(id))) {
      sessionsCache.clear();
    }
    const newStates = aggregateStates(instancesList, availableDirs); // per-cwd 聚合（permission>busy>done>idle）
    const newViewing = p?.viewingInstanceId ?? null;
    const newCwd = p?.viewingCwd ?? null;
    const cwdChanged = cwdSeen && newCwd && newCwd !== currentCwd;
    if (cwdSeen) notifyStateChanges(newStates, newCwd); // 首次只定基线不通知（刷新/重连不冒假通知）
    workdirStates = newStates;
    currentCwd = newCwd;
    // 切换查看实例（切 tab / 切工作区 / 新会话）→ 先把只读态复位为可编辑，等 server 按新会话重判并推权威 mirror_state。
    // 消除切换瞬间旧会话只读横幅残留（server 判活现仅靠观察外部写入、切入不预锁，故复位是安全默认）。override 随会话切换失效；
    // 排队中的接管同理随会话切换作废（armedTakeoverStep 的 switch→disarm 契约，此处 armed 必真故直接置空，无需查返回值）。
    if (newViewing !== viewingInstanceId) { mirrorOverriddenSid = null; armedTakeoverSid = null; applyMirror(false, null); }
    viewingInstanceId = newViewing;
    cwdSeen = true;
    instancesReady = true; // 视图状态已知：此后 shouldDropAgentEvent 按 viewingInstanceId 精确分流（含 null 空窗口）
    if (pendingDeepLink) { const t = pendingDeepLink; pendingDeepLink = null; applyDeepLink(t); } // ②2c：instances 到齐后消费暂存深链

    // 进度横幅可见性收敛（权威状态驱动，替代零散事件隐藏）：当前查看实例无活的后台任务（bgActive=false）即隐藏横幅——
    // 统一覆盖「切会话到别的会话 / 后台任务 TTL 清 / 完成 / 前台轮残留」所有隐藏场景。显示仍由 onTaskProgress
    // 逐心跳 showTaskProgress 驱动（仅当前查看实例）。修复：删 result 的 hideTaskProgress 后横幅只靠 task_notification 隐藏的缺口。
    const viewedInst = instancesList.find(x => x.instanceId === newViewing);
    // 严格 === false（非 falsy）：仅服务端明确「无活后台任务」或当前无查看实例（切到空会话）才隐藏；
    // bgActive 缺失（旧服务端 / 视觉 mock 不带该字段）时保守不隐藏，保留 showTaskProgress 逐心跳驱动的原行为。
    if (!viewedInst || viewedInst.bgActive === false) hideTaskProgress();
    // 发送按钮禁用态：随 instances 广播的权威 queueFull 字段驱动（undefined/旧服务端=保守 false 不误禁）。
    _queueFull = viewedInst?.queueFull === true;

    // REDESIGN: Update active workspace text pill
    if (topProjectText) {
      topProjectText.textContent = baseName(currentCwd);
      topContextPill.title = currentCwd ? `浏览项目文件（只读）：${currentCwd}` : '浏览项目文件（只读）';
    }
    // pillWorkspace（📁 状态 pill）显当前工作区名——该 pill 是工作区入口，显 model 名是名实错配（2026-06-21）
    if ($('pillWorkspaceText')) $('pillWorkspaceText').textContent = baseName(currentCwd);
    // 开发者模式：DEV_MODE=1 时显示齿轮面板「重启服务」组（生产默认隐藏，防误触重启对外服务）
    const devGroup = $('devModeGroup');
    if (devGroup) devGroup.classList.toggle('hidden', !p?.devMode);
    // 短 session_id 状态胶囊：显示当前查看会话的前 8 位；无会话（空首页/未获 id）隐藏
    updatePillSession(instancesList.find(x => x.instanceId === newViewing)?.sessionId || null);
    if (topTitleText) {
      topTitleText.textContent = shouldShowStartScreen({ viewingInstanceId: newViewing, sessionId: instancesList.find(x => x.instanceId === newViewing)?.sessionId }) ? '新聊天' : '聊天';
    }
    // 保持纯手动展开折叠，不自动展开任何工作区目录

    // 切视图：viewingInstanceId 变了重载；空首页内换工作区（newViewing 恒 null、cwd 变了）也重渲——
    // 否则 dashboard 工作区名 + 模型 chip 残留上个工作区（本次修复的 bug 正出于此：两个 null 空首页被判为「视图没变」）
    const startScreenCwdChanged = !newViewing && cwdChanged;
    if (newViewing !== displayedInstanceId || startScreenCwdChanged) {
      const target = instancesList.find(x => x.instanceId === newViewing);
      ultracodeArmed = false;           // ultracode 档不跨实例（CLI: never persist）；切会话/工作区一律回落（含切到空首页 target=null）
      adoptPanelState(target);          // 先静默同步顶部面板到新实例档（先于 bindView 的 sync 回放）
      // 空首页（无实例）：① 模型不显具体名（新会话模型=env 默认、服务端不可知）→「不指定」，modelInput 归零；
      // ② 权限/思考强度显"下条新会话将用的真实档"
      // （server defaultPermissionMode/defaultEffort = L0 pending > L3 CLI settings > L4 硬默认），
      // silent 同步不上屏——修空首页残留上个会话档（A1，2026-06-22；L3 2026-07-14）。
      if (!target) {
        updateModelAndSuffix(''); if (modelInput) modelInput.value = '';
        setPermMode(p.defaultPermissionMode || 'default', true);
        setEffortMode(p.defaultEffort ?? null, true);
      }
      bindView(target, newViewing); // 空首页→showDashboard 重渲（工作区名 + greeting + 模型一致刷新）
      // 新会话首发懒开：bindView→clearView 刚把 send() 的乐观 busy 关掉；若这正是首发绑定到新建实例
      // （sessionId 未由 SDK init 返回），同步补回 busy，让"正在执行任务"从发送起连续显示到首个 delta 接管
      // （与上面 clearView 在同一同步块，无视觉闪烁）；session:switch 打开的已有会话（有 sessionId）不补。
      if (shouldRestoreOptimisticBusy({ pendingFirstSend: _pendingFirstSend, viewingInstanceId: newViewing, sessionId: target?.sessionId })) {
        setBusy(true);
      }
      _pendingFirstSend = false; // 一次性：进入视图切换即消费，防标志悬留误触发后续绑定
      if (consoleModal && consoleModal.classList.contains('sheet-open')) {
        loadConsoleLogs(newViewing);
      }
    } else if (!newViewing) {
      // 空首页视图未变（displayed 已是 null、cwd 也没变），但仍可能收到二次 instances：
      // session:new / 启动后 ensureCliDefaults 异步到齐会再广播一次，defaults 从 L4→L3。
      // 若不在此静默刷新，顶部 mode/effort 会卡在首帧硬默认，直到用户切走再回来。
      // 用户在空窗手改档（L0）时 server 会把 pending 编进 default*，这里幂等对齐权威源即可。
      setPermMode(p.defaultPermissionMode || 'default', true);
      setEffortMode(p.defaultEffort ?? null, true);
    }
    updateSessionsDot();
    updateServiceNotice(p?.service ?? null); // 服务健康与实例结构无关，无条件每次广播都刷新（不进 _structChanged 分支）
    // P3 性能优化：仅结构变化时全量重建面板（+ N×session:list 往返）；纯状态变化（busy/done/error）走
    // 轻量路径 refreshDirBadges()，避免并发流式时反复 innerHTML teardown + socket 往返 + 滚动跳位。
    // 结构键 = dirs 集合 + 实例集（id/sessionId/title 前20字）+ viewingInstanceId + viewingCwd。
    // 状态（busy/idle/permission/error）不进键——由更新后的 workdirStates 驱动 refreshDirBadges 实时刷新角标。
    // expandedDirs 变化由 toggleBtn.onclick 直接调 openSessionPanel()，不经此路径，无需纳入键。
    const _structKey = (() => {
      const ids = instancesList.map(x => `${x.instanceId}:${x.sessionId || ''}:${(x.title || '').slice(0, 20)}`).join(',');
      return `${currentCwd || ''}|${availableDirs.join('|')}|${viewingInstanceId || ''}|${ids}`;
    })();
    const _structChanged = _structKey !== _lastPanelStructKey;
    if (_structChanged) _lastPanelStructKey = _structKey;
    const isDesktop = window.innerWidth >= 1024;
    const isPanelOpen = leftSidebar && !leftSidebar.classList.contains('-translate-x-full');
    if (isDesktop || isPanelOpen) {
      if (_structChanged) {
        openSessionPanel(); // 内含 needsYou/status/service 区全量重建，此路径不必再单独 refresh*
      } else {
        refreshDirBadges();
        refreshInstanceBadges(); // 实例角标实时刷新（busy 时工具图标细化）
        refreshNeedsYou(); // "等我"聚合独立于 structKey（新增/清除审批不改变实例集结构），须单独刷新
        refreshStatusSection(); // live 实例状态汇总（busy 计数等随 state 变，不进 structKey）
      }
    } else {
      refreshDirBadges();
      refreshInstanceBadges();
      refreshNeedsYou();
      refreshStatusSection();
    }
    updateAttentionSignal(); // 顶栏 connDotWrap 边框：alert/attention/ok（与连通性内圈绿/红分轴）
    // 默认磁贴标签依赖 currentModel(空/非空) + cwdDefaultModel，二者本次都可能变（adoptPanelState 改 currentModel、
    // scout 完成的同视图广播改 cwdDefaultModel）。用纯函数比对前后标签，仅真变时重建网格刷新——adoptPanelState 只
    // 切高亮不重建，故此处兜底；无变化不重建（省性能）。
    const prevLbl = defaultModelTileLabel({ currentModel: prevCurrentModel, cwdDefaultModel: prevDefaultModel });
    const curLbl = defaultModelTileLabel({ currentModel, cwdDefaultModel });
    if (prevLbl.title !== curLbl.title || prevLbl.subtitle !== curLbl.subtitle) {
      rebuildCustomModelGrid(modelsList); // 磁贴标签
      syncModelUI(currentModel);          // 底栏 chip「默认 · <真名>」（rebuild 不碰 chip）
    }
    updateSendButtonState(); // _queueFull 可能随 instances 广播变化，须即时刷新发送按钮禁用态
  }

  // aggregateStates 已抽到 logic.js（顶部 import）。
  // 切视图到指定实例（台阶3）：清视图 → sync 活缓冲（重建在途流 + 挂起审批弹窗）→ 无缓冲回退 history。
  // entry 缺失/无 sessionId（新会话尚未 init）= 空白，事件流入自然渲染。
  function bindView(entry, id) {
    const prevInstanceId = displayedInstanceId; // S1：缓存归属的(外出)实例，供切回时检测实例是否被替换
    const prevSessionId = displayedSessionId;   // 切实例前的会话 id——供 planSessionDraftSwap 判 keep/swap
    displayedInstanceId = id;
    const sid = entry?.sessionId || null;
    displayedSessionId = sid;

    // Phase 2: Save DOM nodes of current session to cache before clearing.
    // S1：连同去重基线(lastSeq/epoch)一并缓存——切回时据此「只增量续传缓存之后的新事件」，而非
    // sync:since(0) 全量回放（会与缓存重复，且旧逻辑用 innerHTML='' 清重复时把回放也一起清掉 → 空屏）。
    if (currentSessionId && !messagesEl.classList.contains('empty-start') && messagesEl.childNodes.length > 0) {
      const nodes = Array.from(messagesEl.childNodes);
      sessionDomCache.set(currentSessionId, { nodes, lastSeq, epoch: curEpoch, instanceId: prevInstanceId });
      if (sessionDomCache.size > 40) {
        const oldestKey = sessionDomCache.keys().next().value;
        sessionDomCache.delete(oldestKey);
      }
    }

    // 草稿快照须在 clearView 之前取（clearView 清消息 DOM；附件托盘改由下方 swap 路径统一接管，
    // 不再在 clearView 里无脑清空——否则同会话 keep 会误清托盘）。
    const draftSnapshot = {
      text: inputEl ? inputEl.value : '',
      attachments: attachments.items(),
    };
    clearView(sid, null);
    // 未发送草稿（文字+附件）按 sessionId 存/取：同会话静默换实例(keep)不动；真实切会话(swap)存旧恢复新。
    // 旧逻辑只 clear 不存 → 切走再切回输入/附件被清空（用户报告）。
    const draftPlan = planSessionDraftSwap({
      prevSessionId,
      newSessionId: sid,
      currentDraft: draftSnapshot.text,
      currentAttachments: draftSnapshot.attachments,
      drafts: sessionDraftCache,
    });
    if (draftPlan.action === 'swap') {
      if (draftPlan.save) {
        sessionDraftCache.set(draftPlan.save.sessionId, {
          text: draftPlan.save.text,
          attachments: draftPlan.save.attachments,
        });
        if (sessionDraftCache.size > 40) {
          const oldestKey = sessionDraftCache.keys().next().value;
          sessionDraftCache.delete(oldestKey);
        }
      }
      if (inputEl) {
        inputEl.value = draftPlan.restoreText;
        inputEl.dispatchEvent(new Event('input'));
      }
      attachments.setItems(draftPlan.restoreAttachments);
    }

    // 新会话首发懒开：实例已建、sessionId 未由 SDK init 返回。此刻回落 dashboard 会「闪首页」——
    // 到首个 user_message 经 leaveStartScreen 切回聊天前的几百 ms 用户看见首页再弹回。
    // 首发进行中（判定同 setInstances 的补 busy 守卫：_pendingFirstSend 且绑定到无 sessionId 的新建实例）
    // → 保持空聊天区 + 乐观 busy（setInstances 随后 shouldRestoreOptimisticBusy 补回 setBusy），
    // 不 showDashboard；等首个事件经 appendMessage 接管渲染。
    if (shouldRestoreOptimisticBusy({ pendingFirstSend: _pendingFirstSend, viewingInstanceId: id, sessionId: sid })) {
      return;
    }

    if (shouldShowStartScreen({ viewingInstanceId: id, sessionId: sid })) {
      showDashboard();
      return;
    }

    // Phase 2: Check memory cache for instant restoration.
    // 已完成的对话/工具卡片按 session 不可变：同 sessionId 即恢复 DOM，不要求 instanceId 相同
    // （effort/model 切档会换 instance，旧逻辑要求 instance 一致 → 整段重走 history 丢掉工具卡片）。
    // seq/epoch 仅在「缓存归属实例 === 当前实例」时复用；跨 instance 从 0 跟新缓冲（见 sessionDomCachePlan）。
    let hasCache = false;
    let resumeFromSeq = 0;
    const cached = sid ? sessionDomCache.get(sid) : null;
    const cachePlan = sessionDomCachePlan({ cached, currentInstanceId: id });
    if (cachePlan.restore) {
      for (const node of cached.nodes) messagesEl.appendChild(node);
      if (cachePlan.reuseSeqBaseline) {
        curEpoch = cachePlan.epoch;
        lastSeq = cachePlan.lastSeq;
      } else {
        curEpoch = null;
        lastSeq = 0;
      }
      resumeFromSeq = cachePlan.resumeFromSeq;
      scrollBottom(true);
      hasCache = true;
    } else {
      showLoadingCard();
    }

    socket.emit('sync:since', { instanceId: id, sessionId: sid, lastSeq: resumeFromSeq }, res => {
      if (displayedInstanceId !== id) return;        // 已切走：丢弃过期回调
      // S1：hasCache 时已增量续传（resumeFromSeq=缓存位置，回放只含新事件、append 不重复）。
      // 切入决策交纯函数 shouldReloadOnEnter（logic.js，单测覆盖）——活缓冲/DOM 缓存 vs 磁盘全量重载：
      //   'load'   无缓存、聊天区空 → 拉磁盘首次填充（不必清屏）；
      //   'reload' gap（缓冲超窗残缺）或磁盘被外部写长（web 离开期间终端 CLI 写盘的盲区）→ 清屏全量重载磁盘；
      //   'keep'   缓存/活缓冲即最新真相 → 直接收尾，保留 DOM 秒恢复。
      const action = shouldReloadOnEnter({
        replayed: res?.replayed, gap: res?.gap, hasCache,
        diskLen: res?.diskLen ?? 0, seenDiskLen: seenDiskLenBySession.get(sid) ?? 0
      });
      if (action === 'load') {
        loadHistory(sid, entry.cwd);
      } else if (action === 'reload') {
        // 清屏全量重载历史（同重连路径 syncAckAction 的 gap→reload，不把残缺/过期缓存当完整）。
        // sync:since 已把活缓冲事件推进 lastSeq/curEpoch 并渲染进 DOM；clearView 会归零基线——
        // 若不恢复，后续 reconnect 以 lastSeq=0 再回放缓冲会与磁盘历史叠成重复气泡。history 不占 seq，
        // 恢复本轮已推进的基线即可让后续增量从缓冲尾部续。
        const keepSeq = lastSeq;
        const keepEpoch = curEpoch;
        clearView(sid, null);
        lastSeq = keepSeq;
        curEpoch = keepEpoch;
        showLoadingCard();
        loadHistory(sid, entry.cwd);
      } else {
        hideLoadingCard();
      }
      // 状态对账：视图已稳定（上面所有 clearView 已执行完）→ 用 ack 带回的快照重建未决审批/提问卡片。
      // 放最后而非提前 socket.emit，正为不被 reload 分支的 clearView 清掉（workflow 高频事件常触发 gap）。
      applyPendingSnapshot(res?.pending);
    });
  }

  // 跨 tab 通知：非查看 cwd 的聚合状态迁移到 done/permission → notify（notify 内部仅 document.hidden 生效）。
  // 单一来源 = states 差分（后台 agent:event 已在分发入口按 instanceId 丢弃，不在那边重复 notify）。
  function notifyStateChanges(newStates, viewCwd) {
    for (const d of Object.keys(newStates)) {
      if (d === viewCwd) continue;                   // 查看中的 cwd 走内联渲染，不通知
      const prev = workdirStates[d], cur = newStates[d];
      if (cur === prev) continue;
      if (cur === 'permission') notify('⚠️ 后台需要审批', baseName(d));
      else if (cur === 'error') notify('⚠️ 后台任务出错', baseName(d));
      else if (cur === 'done') notify('✅ 后台任务完成', baseName(d));
    }
  }

  // 角标视觉：busy ⏳ / permission ⚠️ / error ❗ / done ✅；idle 隐藏。挂在目录行内、ml-auto 右对齐。
  // [emoji, 颜色类, 语义 title]——title 消除「不知道图标/颜色对应什么状态」
  const DIR_BADGE = { busy: ['⏳', 'text-warning', '运行中'], permission: ['⚠️', 'text-danger', '待审批'], error: ['❗', 'text-danger', '出错'], done: ['✅', 'text-success', '已完成'], aborted: ['⏹', 'text-warning', '已中止'] };
  // 工具角标细化：busy 时根据 activeTool 显示具体工具图标
  const TOOL_BADGE = { Agent: '🤖', Task: '🤖', Bash: '🖥', Write: '📝', Edit: '✏️', Read: '👁' };
  function applyBadge(badge, state) {
    const m = DIR_BADGE[state];
    if (m) { badge.textContent = m[0]; badge.className = `dir-badge ml-auto shrink-0 ${m[1]}`; badge.title = m[2]; }
    else { badge.textContent = ''; badge.className = 'dir-badge hidden'; badge.title = ''; }
  }
  // "已等待"文案（FR-22，与 needsYouList 共享 waitingSince 数据源）：按分钟粒度，不做秒级实时动画——
  // 该区块只在 instances 广播到达时重渲（同 refreshNeedsYou 触发时机），文案本就是"上次广播时刻"的快照。
  function formatWaitingDuration(waitingSince) {
    if (typeof waitingSince !== 'number') return '';
    const mins = Math.max(0, Math.floor((Date.now() - waitingSince) / 60000));
    if (mins < 1) return '已等待 <1 分钟';
    if (mins < 60) return `已等待 ${mins} 分钟`;
    const h = Math.floor(mins / 60), m = mins % 60;
    return `已等待 ${h} 小时${m ? m + ' 分钟' : ''}`;
  }
  // 单条"需要你"行：点击深链跳转（复用 FR-14 applyDeepLink，同通知点击的落地逻辑）。
  // 全程 textContent 插值动态数据（title/cwd/toolName 均可能含用户数据）→ CSP 安全，同现有行渲染惯例。
  function needsYouRow(item) {
    const isApproval = item.reason === 'awaiting_approval';
    const row = el(`<button class="w-full flex items-center gap-2 pl-3 pr-3 py-2 border-b border-line-soft border-l-2 border-warning text-left hover:bg-sunk/30 active:opacity-70 bg-surface" data-testid="needs-you-row"></button>`);
    const icon = el(`<span class="shrink-0"></span>`);
    icon.textContent = isApproval ? '⚠️' : '❓';
    row.appendChild(icon);
    const body = el(`<div class="flex-1 min-w-0"></div>`);
    const head = el(`<div class="truncate text-xs font-medium text-ink"></div>`);
    head.textContent = item.title || '新会话';
    const sub = el(`<div class="truncate text-[10px] text-ink-faint"></div>`);
    const reasonLabel = isApproval ? '等待审批' : '等待输入';
    const toolSuffix = isApproval && item.toolName ? `（${item.toolName}）` : '';
    sub.textContent = `${baseName(item.cwd)} · ${reasonLabel}${toolSuffix} · ${formatWaitingDuration(item.waitingSince)}`;
    body.appendChild(head);
    body.appendChild(sub);
    row.appendChild(body);
    row.onclick = () => {
      haptic('tap');
      applyDeepLink({ instanceId: item.instanceId, sessionId: item.sessionId, cwd: item.cwd });
    };
    return row;
  }
  // 顶部"需要你(N)"聚合区（AD-11/§3.2.5，承接 FR-21）：needsYouList 已由 setInstances 按 waitingSince
  // 升序排好（等得越久排越前，OQ-01 已决），此处只负责渲染，不重排序。空列表渲染空壳（hidden），
  // 保持 #needsYouSection 锚点常在，refreshNeedsYou 的 querySelector 才总能找到替换目标。
  function buildNeedsYouSection() {
    const section = el(`<div id="needsYouSection"></div>`);
    if (!needsYouList.length) { section.classList.add('hidden'); return section; }
    const header = el(`<div class="px-3 py-1.5 text-[10px] font-semibold text-warning border-b border-line"></div>`);
    header.textContent = `需要你 (${needsYouList.length})`;
    section.appendChild(header);
    for (const item of needsYouList) section.appendChild(needsYouRow(item));
    return section;
  }
  // 面板开着时刷新"需要你"区（不重建整个面板）：needsYou 变化（新增/清除审批或提问）不改变 dirs/实例集，
  // 不会触发 _structKey 变化 → openSessionPanel 不会被调用，须独立刷新（同 refreshDirBadges/refreshInstanceBadges 的定位）。
  // 面板尚未渲染过（#needsYouSection 不存在）时跳过——首次 openSessionPanel 会用当下 needsYouList 建好。
  function refreshNeedsYou() {
    const old = sessionPanel.querySelector('#needsYouSection');
    if (!old) return;
    old.replaceWith(buildNeedsYouSection());
  }
  // "服务"小节（第一性原理重新设计）：与上面"需要你"聚合故意保持视觉分隔——放在状态角标图例之后、
  // 目录列表之前，避免看起来像"更多同类待办"（两条轴论证依据不同，见 updateServiceNotice 注释）。
  // 仅异常时渲染（空数组=一切正常，section 直接 hidden），锚点 #serviceSection 常在同 needsYouSection 惯例。
  function buildServiceSection() {
    const section = el(`<div id="serviceSection"></div>`);
    const notices = formatServiceNotices({ service: latestServiceHealth, restartChanged: _serviceRestartNoticeActive, now: Date.now() });
    if (!notices.length) { section.classList.add('hidden'); return section; }
    const wrap = el(`<div class="px-3 py-1.5 text-[10px] font-semibold text-warning border-b border-line flex flex-col gap-0.5"></div>`);
    for (const line of notices) {
      const row = el(`<div></div>`);
      row.textContent = line; // 动态文案，textContent 插值同现有行渲染惯例（CSP 安全）
      wrap.appendChild(row);
    }
    section.appendChild(wrap);
    return section;
  }
  function refreshServiceSection() {
    const old = sessionPanel.querySelector('#serviceSection');
    if (!old) return;
    old.replaceWith(buildServiceSection());
  }
  // 状态一瞥区（live 会话实例汇总，非 OS 进程表）：摘要 + 实例表 + 说明。
  // 数据全来自 instances 广播；attention 优先排序；点行深链。锚点 #statusSection 常在，refresh 可独立替换。
  function buildStatusSection() {
    const section = el(`<div id="statusSection" class="border-b border-line"></div>`);
    const sum = summarizeInstanceStates(instancesList);
    const attention = whatNeedsAttention({
      instances: instancesList,
      needsYou: needsYouList,
      service: latestServiceHealth,
    });
    const header = el(`<div class="px-3 py-1.5 text-[10px] font-semibold border-b border-line-soft flex items-center justify-between gap-2"></div>`);
    const title = el(`<span></span>`);
    title.textContent = '状态 · live 会话实例';
    header.appendChild(title);
    const levelEl = el(`<span class="font-normal"></span>`);
    if (attention.level === 'alert') {
      levelEl.textContent = '告警';
      levelEl.className = 'font-normal text-danger';
      header.classList.add('text-danger');
    } else if (attention.level === 'attention') {
      levelEl.textContent = '待处理';
      levelEl.className = 'font-normal text-warning';
      header.classList.add('text-warning');
    } else {
      levelEl.textContent = '正常';
      levelEl.className = 'font-normal text-ink-faint';
      header.classList.add('text-ink-soft');
    }
    header.appendChild(levelEl);
    section.appendChild(header);

    const summary = el(`<div class="px-3 py-1 text-[10px] text-ink-soft"></div>`);
    const b = sum.byState;
    summary.textContent = `live ${sum.total} · 运行 ${sum.running} · 待批 ${b.permission} · 出错 ${b.error} · 完成 ${b.done} · 中止 ${b.aborted} · 空闲 ${b.idle}`;
    section.appendChild(summary);

    // 实例表：attention 优先（permission > error > busy > aborted > done > idle），同档按 title
    const rank = { permission: 0, error: 1, busy: 2, aborted: 3, done: 4, idle: 5 };
    const rows = [...instancesList]
      .filter(i => i && i.instanceId)
      .sort((a, b2) => (rank[a.state] ?? 9) - (rank[b2.state] ?? 9) || String(a.title || '').localeCompare(String(b2.title || '')));
    if (rows.length) {
      const list = el(`<div class="pb-1"></div>`);
      for (const inst of rows) {
        const row = el(`<button type="button" class="w-full flex items-center gap-2 pl-3 pr-3 py-1.5 text-left hover:bg-sunk/30 active:opacity-70" data-testid="status-instance-row"></button>`);
        const badge = el(`<span class="shrink-0 text-xs"></span>`);
        const m = DIR_BADGE[inst.state];
        if (m) { badge.textContent = m[0]; badge.className = `shrink-0 text-xs ${m[1]}`; badge.title = m[2]; }
        else if (inst.state === 'busy' && inst.activeTool && TOOL_BADGE[inst.activeTool]) {
          badge.textContent = TOOL_BADGE[inst.activeTool];
          badge.className = 'shrink-0 text-xs text-warning';
          badge.title = `运行中：${inst.activeTool}`;
        } else { badge.textContent = '·'; badge.className = 'shrink-0 text-xs text-ink-faint'; }
        row.appendChild(badge);
        const body = el(`<div class="flex-1 min-w-0"></div>`);
        const head = el(`<div class="truncate text-xs font-medium text-ink"></div>`);
        head.textContent = inst.title || '新会话';
        const sub = el(`<div class="truncate text-[10px] text-ink-faint"></div>`);
        const stateLabel = (m && m[2]) || inst.state || '空闲';
        const toolBit = inst.activeTool ? ` · ${inst.activeTool}` : '';
        const bgBit = inst.bgActive ? ' · 后台' : '';
        sub.textContent = `${baseName(inst.cwd)} · ${stateLabel}${toolBit}${bgBit}`;
        body.appendChild(head);
        body.appendChild(sub);
        row.appendChild(body);
        row.onclick = () => {
          haptic('tap');
          applyDeepLink({ instanceId: inst.instanceId, sessionId: inst.sessionId, cwd: inst.cwd });
        };
        list.appendChild(row);
      }
      section.appendChild(list);
    } else {
      const empty = el(`<div class="px-3 py-1 text-[10px] text-ink-faint"></div>`);
      empty.textContent = '当前无 live 实例（空首页或尚未发消息）';
      section.appendChild(empty);
    }

    const note = el(`<div class="px-3 py-1.5 text-[9.5px] text-ink-faint/80 leading-snug"></div>`);
    note.textContent = '此处为 web 驱动的会话实例，不含本机其它 claude 终端进程；无法检测 OS 僵尸。';
    section.appendChild(note);

    // 额度窗入口：按需 usage:get → 弹简易层（第三方 available:false 时显示不可用说明）
    const usageRow = el(`<div class="px-3 py-2 border-t border-line-soft"></div>`);
    const usageBtn = el(`<button type="button" class="w-full text-left text-[11px] text-info underline" data-testid="usage-open-btn">查看套餐额度</button>`);
    usageBtn.onclick = () => {
      haptic('tap');
      openUsageWindow();
    };
    usageRow.appendChild(usageBtn);
    const usageBody = el(`<div id="usageWindowBody" class="hidden mt-1 text-[10px] text-ink-soft space-y-0.5" data-testid="usage-window"></div>`);
    usageRow.appendChild(usageBody);
    section.appendChild(usageRow);
    return section;
  }

  let _usageReqGen = 0;
  function openUsageWindow() {
    const body = sessionPanel.querySelector('#usageWindowBody');
    if (!body) return;
    body.classList.remove('hidden');
    body.replaceChildren();
    const loading = el(`<div class="text-ink-faint"></div>`);
    loading.textContent = '加载中…';
    body.appendChild(loading);
    const gen = ++_usageReqGen;
    socket.emit('usage:get', { instanceId: viewingInstanceId }, () => { /* ack 可选，真值走 agent:event usage */ });
    // 兼容：server 以 agent:event type=usage 推送；也接受 ack 形态（若未来改）
    const onUsage = (payload) => {
      if (gen !== _usageReqGen) return;
      renderUsageWindow(body, payload);
    };
    // 一次性监听：通过 pending flag 在 agent:event 分发处消费
    pendingUsageRender = onUsage;
  }
  function renderUsageWindow(body, payload) {
    const view = formatUsageWindowLines(payload || { available: false });
    body.replaceChildren();
    if (!view.available) {
      const empty = el(`<div class="text-ink-faint"></div>`);
      empty.textContent = '当前认证无套餐额度（API key / 第三方 provider 不提供）';
      body.appendChild(empty);
      return;
    }
    for (const line of view.lines) {
      const row = el(`<div class="flex justify-between gap-2"></div>`);
      const lab = el(`<span class="text-ink-faint"></span>`);
      lab.textContent = line.label;
      const val = el(`<span class="text-ink font-medium"></span>`);
      val.textContent = line.text;
      row.appendChild(lab);
      row.appendChild(val);
      body.appendChild(row);
    }
  }
  function refreshStatusSection() {
    const old = sessionPanel.querySelector('#statusSection');
    if (!old) return;
    old.replaceWith(buildStatusSection());
  }
  // 顶栏 connDotWrap 边框：服务异常(alert) 优先于 会话待处理(attention)；内圈绿/红仍只管连通性。
  // 与 updateServiceNotice 共用边框，避免两轴打架——本函数在 setInstances 末尾统一重算。
  function updateAttentionSignal() {
    if (!connDotWrap) return;
    const { level } = whatNeedsAttention({
      instances: instancesList,
      needsYou: needsYouList,
      service: latestServiceHealth,
    });
    // 清旧态
    connDotWrap.classList.remove('border-warning', 'border-danger', 'border-line-soft');
    if (level === 'alert') {
      connDotWrap.classList.add('border-danger');
      // 保留 RTT/连接 title 前缀语义：追加注意力说明
      const base = connDotWrap.title || '';
      if (!base.includes('服务告警')) connDotWrap.title = (base ? base + ' · ' : '') + '服务告警（推送失败等）';
    } else if (level === 'attention') {
      connDotWrap.classList.add('border-warning');
      const base = connDotWrap.title || '';
      if (!base.includes('需要你')) connDotWrap.title = (base ? base + ' · ' : '') + `需要你 (${needsYouList.length || '…'})`;
    } else {
      connDotWrap.classList.add('border-line-soft');
    }
  }
  // 面板开着时仅更新已渲染目录行的角标（不重发 session:list）
  function refreshDirBadges() {
    sessionPanel.querySelectorAll('[data-dir]').forEach(row => {
      const badge = row.querySelector('.dir-badge');
      if (badge) applyBadge(badge, workdirStates[row.dataset.dir]);
    });
  }
  // 面板开着时仅更新已渲染实例行的角标（busy 时细化工具图标）
  function refreshInstanceBadges() {
    const instMap = new Map(instancesList.map(x => [x.instanceId, x]));
    sessionPanel.querySelectorAll('[data-instance-id]').forEach(row => {
      const instId = row.dataset.instanceId;
      if (!instId) return;
      const inst = instMap.get(instId);
      if (!inst) return;
      const head = row.querySelector('.truncate');
      if (!head) return;
      const oldBadge = head.querySelector('[data-instance-badge]');
      if (oldBadge) oldBadge.remove();
      if (inst.state === 'busy') {
        const badgeIcon = (inst.activeTool && TOOL_BADGE[inst.activeTool]) || '⏳';
        const badgeCls = 'text-warning';
        const b = document.createElement('span');
        b.className = `shrink-0 ${badgeCls}`;
        b.setAttribute('data-instance-badge', '');
        b.textContent = badgeIcon;
        head.appendChild(b);
      } else {
        const m = DIR_BADGE[inst.state];
        if (m) {
          const b = document.createElement('span');
          b.className = `shrink-0 ${m[1]}`;
          b.setAttribute('data-instance-badge', '');
          b.textContent = m[0];
          head.appendChild(b);
        }
      }
    });
  }
  // 会话按钮汇总角标：非查看目录有动静即亮，用与面板同款 emoji（⏳/⚠️/❗/✅）而非裸色——消除「不知道颜色对应什么状态」。
  // 定位/底色样式常驻在 index.html 的 #sessionsDot base 类里，这里只切 hidden + 换 emoji/title。
  // 优先级 permission>error>done>busy 由 summarizeOtherWorkspaces 决定（纯逻辑、可单测；已排除 currentCwd）。
  function updateSessionsDot() {
    if (!sessionsDot) return;
    const top = summarizeOtherWorkspaces(workdirStates, availableDirs, currentCwd);
    const m = top && DIR_BADGE[top]; // [emoji, 颜色类, 中文名]
    if (m) {
      sessionsDot.textContent = m[0];
      sessionsDot.title = `其他工作区${m[2]}`; // 如「其他工作区待审批」
      sessionsDot.classList.remove('hidden');
    } else {
      sessionsDot.textContent = '';
      sessionsDot.title = '';
      sessionsDot.classList.add('hidden');
    }
  }
  // 服务状态可见性（第一性原理重新设计）：与上面 updateSessionsDot（会话待处理，FR-21/注意力不对称）
  // 是不同的轴——这里只答"ccm 这个服务本身有没有出过岔子"（NFR-15/可维护性），复用 connDotWrap（已有的
  // 服务级 UI 落点，纯连通性的 connDot 内圈继续只管绿/红，环形边框承载这条独立语义）。
  // 本地基线存 localStorage（跨刷新持久，命名对齐既有 auth_token/device_token 风格）；每设备独立判定。
  function updateServiceNotice(service) {
    latestServiceHealth = service;
    if (service && typeof service.startedAt === 'number') {
      const lastSeenRaw = localStorage.getItem('service_started_at');
      const lastSeen = lastSeenRaw != null ? Number(lastSeenRaw) : null;
      const { changed, nextStartedAt } = detectServiceRestart({ startedAt: service.startedAt, lastSeenStartedAt: lastSeen });
      if (nextStartedAt != null) localStorage.setItem('service_started_at', String(nextStartedAt));
      // 一旦命中过就锁定为 true（不因下一次广播里 changed 判回 false 而让提示瞬间消失，见变量声明处注释）。
      if (changed) _serviceRestartNoticeActive = true;
    }
    // 边框由 updateAttentionSignal 统一重算（alert > attention > ok），此处只刷服务文案区。
    refreshServiceSection();
  }

  function setBusy(b) {
    if (!activeStatusPill || b === _busyState) return;
    _busyState = b;
    if (b) {
      if (!interruptPending) {
        if (btnStop) btnStop.disabled = false;
        if (btnStopNew) btnStopNew.disabled = false;
      }
      activeStatusPill.classList.remove('hidden');
      activeStatusPill.offsetHeight; // 触发 CSS 过渡所需的单次强制 layout（仅在 false→true 时执行一次）
      activeStatusPill.classList.add('pill-active');
      if (activeStatusText) {
        activeStatusText.textContent = 'Claude 正在执行任务...';
      }
    } else {
      interruptPending = false;
      if (btnStop) btnStop.disabled = false;
      if (btnStopNew) btnStopNew.disabled = false;
      activeStatusPill.classList.remove('pill-active');
      setTimeout(() => {
        if (!activeStatusPill.classList.contains('pill-active')) {
          activeStatusPill.classList.add('hidden');
        }
      }, 250);
    }
  }

  // ---- 抽屉式侧边栏控制器 (Left Drawer Sidebar Controllers) ----
  function openLeftSidebar() {
    if (window.innerWidth >= 1024) return; // No-op on desktop
    haptic('tap');
    leftSidebar.classList.remove('-translate-x-full');
    sidebarScrim.classList.remove('hidden');
    openSessionPanel();
  }
  function closeLeftSidebar() {
    if (window.innerWidth >= 1024) return; // No-op on desktop
    leftSidebar.classList.add('-translate-x-full');
    sidebarScrim.classList.add('hidden');
  }

  if (sidebarClose) sidebarClose.onclick = closeLeftSidebar;
  if (sidebarScrim) sidebarScrim.onclick = closeLeftSidebar;

  // 移动端：边缘滑动呼出侧边栏，向左滑动收起侧边栏
  let dragStartX = 0, dragStartY = 0;
  document.addEventListener('touchstart', e => {
    dragStartX = e.touches[0].clientX;
    dragStartY = e.touches[0].clientY;
  }, { passive: true });

  document.addEventListener('touchmove', e => {
    if (!dragStartX) return;
    const currentX = e.touches[0].clientX;
    const currentY = e.touches[0].clientY;
    const diffX = currentX - dragStartX;
    const diffY = currentY - dragStartY;

    if (Math.abs(diffX) > Math.abs(diffY) * 1.5) {
      // 从左边缘起（clientX < 45px）向右滑动呼出
      if (leftSidebar.classList.contains('-translate-x-full') && dragStartX < 45 && diffX > 65) {
        openLeftSidebar();
        dragStartX = 0; // 防止重复触发
      }
      // 向左滑动收起
      else if (!leftSidebar.classList.contains('-translate-x-full') && diffX < -65) {
        closeLeftSidebar();
        dragStartX = 0; // 防止重复触发
      }
    }
  }, { passive: true });

  function openSheet(el) {
    haptic('tap');
    el.classList.remove('hidden');
    // Force reflow
    el.offsetHeight;
    el.classList.add('sheet-open');
  }
  function closeSheet(el) {
    haptic('tap');
    el.classList.remove('sheet-open');
    // Delay adding hidden class to let slide-down animation finish,
    // which takes around 300ms. E2E wait tasks wait up to 15s so 300ms is perfect.
    setTimeout(() => {
      if (!el.classList.contains('sheet-open')) {
        el.classList.add('hidden');
      }
    }, 300);
  }

  // ---- 两级删除会话（FR-20，docs/design.md）----
  // L1=从产品移除（session:delete，transcript 保留）；L2=彻底删底层文件（session:deletePermanent，二次确认）。
  // 只对「未打开的历史会话」提供入口（见 sessionRow）——已打开的会话先关闭 tab 再删，避免删一个正被本产品
  // 驱动的会话（后端 L2 保护①也会拒，但前端不给入口更清晰）。此块只执行一次（IIFE 顶层），非每次渲染。
  let deleteTarget = null; // { sessionId, cwd, title }
  function openDeleteSession(sessionId, cwd, title) {
    deleteTarget = { sessionId, cwd, title };
    deleteSessionTitle.textContent = title || sessionId;
    openSheet(deleteSessionModal);
  }
  if (deleteSessionCancel) deleteSessionCancel.onclick = () => { deleteTarget = null; closeSheet(deleteSessionModal); };
  if (deleteL1Btn) deleteL1Btn.onclick = () => {
    if (!deleteTarget) return;
    const t = deleteTarget; deleteTarget = null;
    closeSheet(deleteSessionModal);
    socket.emit('session:delete', { sessionId: t.sessionId, cwd: t.cwd }, res => {
      if (res?.ok) { addBar(`已从列表移除：${t.title || t.sessionId}`, 'text-ink-faint'); openSessionPanel(); }
      else addBar(res?.error || '移除失败', 'text-danger');
    });
  };
  if (deleteL2Btn) deleteL2Btn.onclick = () => {
    if (!deleteTarget) return;
    const t = deleteTarget;
    // L2 显式二次确认（docs/design.md"显式二次确认删底层 transcript 文件"）——不可恢复，故在 L1 一级弹窗之上再加一道。
    if (!confirm(`彻底删除会话「${t.title || t.sessionId}」的底层文件？\n\n此操作不可恢复：主机上的会话记录将被真正抹除。`)) return;
    deleteTarget = null;
    closeSheet(deleteSessionModal);
    socket.emit('session:deletePermanent', { sessionId: t.sessionId, cwd: t.cwd }, res => {
      if (res?.ok) { addBar(`已彻底删除：${t.title || t.sessionId}`, 'text-ink-faint'); openSessionPanel(); }
      else addBar(res?.error || '彻底删除失败', 'text-danger');
    });
  };

  // ---- 项目文件只读浏览：传输回调、分页状态和 DOM 渲染由独立 controller 管理 ----
  const fileBrowser = createFileBrowser(appContext, {
    baseName,
    closeSheet,
    createElement: el,
    haptic,
    openSheet,
  });
  const openFileBrowser = fileBrowser.open;
  // ---- 设置：抽屉、完成提示偏好和预览由独立 controller 管理 ----
  const settings = createSettingsController(appContext, { alerts, haptic });
  const openSettingsSheet = settings.open;
  if (pillModel) pillModel.onclick = openSettingsSheet; // 点底栏模型 chip → 开「选择模型」格
  // 顶部 pill 原先只是 btnSessions 的重复代理（两者都调 toggleSessions，纯冗余入口）。
  // 现改为直接打开当前工作区的只读文件浏览——抽屉只负责会话切换/新建，文件浏览入口唯一在此。
  if (topContextPill) {
    topContextPill.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      haptic('tap');
      openFileBrowser(currentCwd);
    };
  }
  
  if (pillPerm) {
    pillPerm.onclick = () => {
      openSettingsSheet();
      if (customPermGrid) {
        customPermGrid.classList.add('ring-2', 'ring-accent');
        setTimeout(() => customPermGrid.classList.remove('ring-2', 'ring-accent'), 1500);
      }
    };
  }
  
  if (pillEffort) {
    pillEffort.onclick = () => {
      openSettingsSheet();
      if (customEffortGrid) {
        customEffortGrid.classList.add('ring-2', 'ring-accent');
        setTimeout(() => customEffortGrid.classList.remove('ring-2', 'ring-accent'), 1500);
      }
    };
  }

  const pillWorkspace = $('pillWorkspace');
  if (pillWorkspace) {
    pillWorkspace.onclick = () => {
      haptic('tap');
      openSettingsSheet();
    };
  }

  if (customPermGrid) {
    customPermGrid.querySelectorAll('.perm-tile').forEach(tile => {
      tile.onclick = () => {
        haptic('tap');
        const mode = tile.dataset.mode;
        if (mode === currentPermMode) return;
        permModeSelect.value = mode;
        permModeSelect.onchange();
      };
    });
  }

  // ---- 会话 ----
  // 模型清单不再由前端主动拉。旧 refreshAvailableModels 在后端返空时「保留陈旧」——切到无缓存的别区点
  // 新会话时，就把上个工作区的候选（如 deepseek）继续显出来，正是跨工作区泄漏。改由后端在切 cwd
  // （session:new/switch、setWorkdir/setViewing）时按本区主动推 models 事件（无缓存→空），统一走下方
  // models(p) 处理器「空则清、非空则填」，单一权威路径不再分叉。

  // 回空首页枢纽（最近工作区/会话）。已在空首页则只重渲列表；否则 session:home。
  // 与 ＋ 分工：二者都到空首页且 compose=FRESH；＋ 额外重置 pending 权限/思考档并 scout 模型，🏠 保留面板档、专为「去选最近」。
  if (btnHome) btnHome.onclick = () => {
    haptic('tap');
    closeLeftSidebar();
    const sid = instancesList.find(x => x.instanceId === viewingInstanceId)?.sessionId || null;
    if (shouldShowStartScreen({ viewingInstanceId, sessionId: sid })) {
      showDashboard();
      return;
    }
    let acked = false;
    socket.emit('session:home', {}, res => {
      acked = true;
      if (res && res.ok === false) addBar(res.error || '回首页失败', 'text-danger');
    });
    setTimeout(() => { if (!acked) addBar('回首页无响应，请刷新后重试', 'text-danger'); }, 4000);
  };

  // 台阶3：新建会话 = 在当前 cwd 开新 tab（旧 tab 后台继续、**不中断**），清视图等首条消息懒开。
  // 不再 confirm「将被中断」——台阶3 新建不中断任何在途任务（视图由 instances 广播驱动清空）。
  btnNew.onclick = () => {
    haptic('tap');
    socket.emit('session:new', { cwd: currentCwd }); // 模型清单由后端 pushModelsForCwd 主动推、不再前端拉
  };
  function toggleSessions() {
    haptic('tap');
    if (window.innerWidth >= 1024) {
      document.body.classList.toggle('sidebar-collapsed');
      return;
    }
    if (leftSidebar.classList.contains('-translate-x-full')) {
      openLeftSidebar();
    } else {
      closeLeftSidebar();
    }
  }
  btnSessions.onclick = toggleSessions;

  // 台阶3 Step B：工作区面板 = 目录树（当前 cwd 展开，其他折叠）——类似 IDE 项目浏览器。
  function openSessionPanel() {
    sessionPanel.innerHTML = '';

    // "需要你"聚合置顶（AD-11/§3.2.5 AttentionDeriver，承接 FR-21）：跨全部工作区/会话，
    // 不限于当前展开的目录——正是它相对下方逐目录列表的增量价值（注意力不对称）。
    sessionPanel.appendChild(buildNeedsYouSection());

    // 状态角标图例：消除「不知道 ⏳/⚠️/❗/✅ 各代表什么」——两行，紧跟标题。
    // 第二行点明左上角按钮角标只汇总「其他工作区」状态，并解释按钮上的连接点绿/红——消除「绿点=什么」的误解。
    sessionPanel.appendChild(el(`<div class="px-3 py-1.5 text-[10px] text-ink-faint border-b border-line flex flex-col gap-1"><div class="flex flex-wrap gap-x-3 gap-y-1"><span>⏳ 运行中</span><span>⚠️ 待审批</span><span>❗ 出错</span><span>✅ 已完成</span></div><div class="flex flex-wrap gap-x-3 gap-y-1 text-ink-faint/80"><span>目录角标 = 该工作区最需关注的状态</span><span>左上角角标 = 其他工作区状态汇总</span><span>连接点：绿=已连接 · 红=断开</span></div></div>`));

    // "服务"小节（第一性原理重新设计，NFR-15/可维护性）：与上方"需要你"聚合故意分隔——图例之后、
    // 目录列表之前，仅异常时渲染，见 buildServiceSection 注释。
    sessionPanel.appendChild(buildServiceSection());

    // "状态一瞥"小节（台阶6 状态中心 MVP，承接 NFR-15/会话状态可见性）：live 会话实例汇总表，
    // 不含 OS 进程/僵尸（后端无 PID、设计禁 OS 探针）。置服务小节之后、目录列表之前——
    // 与"需要你"不同轴：这里数量化（在跑几个/出错几个），那里注意力化（哪个等你）。
    sessionPanel.appendChild(buildStatusSection());

    // 按 availableDirs 顺序（=WORK_DIR 首位 + WORK_DIRS），每目录一行：
    //   展开：📂 ▼ basename + 角标 → 下方缩进显示该目录会话列表（纯 /resume 时间序，已打开者就地标 ✕/角标）
    //   折叠：📁 ▶ basename + 角标 → 点击展开（若非当前 cwd 则同时切换）
    const liveByCwd = {};
    for (const inst of instancesList) {
      if (!inst.instanceId) continue;
      if (!liveByCwd[inst.cwd]) liveByCwd[inst.cwd] = [];
      liveByCwd[inst.cwd].push(inst);
    }

    for (const d of availableDirs) {
      const isCurrent = d === currentCwd;
      const isExpanded = expandedDirs.has(d);

      // ---- 目录头行（所有目录均可点击展开/折叠）----
      const dirRow = el(`<div class="w-full px-3 py-1.5 border-b border-line flex items-center justify-between hover:bg-sunk/30${isCurrent ? ' text-accent' : ' text-ink'}"></div>`);
      dirRow.dataset.dir = d;
      dirRow.title = d;

      const toggleBtn = el(`<button class="flex-1 min-w-0 text-left flex items-center gap-2 py-1.5 active:opacity-70"></button>`);
      const icon = el(`<span class="shrink-0"></span>`); icon.textContent = isExpanded ? '📂' : '📁';
      // 统一用 "▶" 字符，旋转实现向下效果，平滑过渡
      const arrow = el(`<span class="shrink-0 text-[9px] w-3 dir-arrow">▶</span>`);
      if (isExpanded) arrow.classList.add('rotated');
      const name = el(`<span class="truncate"></span>`); name.textContent = baseName(d);
      const badge = el(`<span class="dir-badge hidden"></span>`);
      applyBadge(badge, workdirStates[d]);

      toggleBtn.appendChild(icon);
      toggleBtn.appendChild(arrow);
      toggleBtn.appendChild(name);
      toggleBtn.appendChild(badge);
      dirRow.appendChild(toggleBtn);

      // 物理热区扩大版 "＋" 新建按钮
      const newSessionBtn = el(`<button class="shrink-0 w-8 h-8 rounded-lg flex items-center justify-center border border-line text-ink-soft hover:text-accent hover:border-accent hover:bg-accent-wash active:scale-90 text-sm font-bold shadow-sm transition-all" title="在此工作区新建会话">＋</button>`);
      newSessionBtn.onclick = (e) => {
        e.stopPropagation();
        closeLeftSidebar();
        haptic('tap');
        socket.emit('session:new', { cwd: d }); // 模型清单由后端 pushModelsForCwd 主动推、不再前端拉
      };
      dirRow.appendChild(newSessionBtn);

      // 文件浏览入口已收归顶部 pill（当前工作区）；抽屉只负责会话切换/新建，不再挂逐行「浏览」按钮。

      sessionPanel.appendChild(dirRow);

      // ---- 展开区容器（所有目录均常驻 DOM 以支持 CSS max-height 过渡，仅通过类来控制动画） ----
      const subtree = el(`<div class="subtree-container"></div>`);
      if (isExpanded) {
        subtree.classList.add('expanded');
      }
      sessionPanel.appendChild(subtree);

      const tabs = liveByCwd[d] || [];
      const liveBySession = new Map();        // sessionId → 已打开实例（有 id 的 live tab，用于在 /resume 列表中就地标记）
      const freshTabs = [];                   // 无 sessionId 的新会话实例（尚未保存，/resume 列表看不到、无时间）
      for (const inst of tabs) { if (inst.sessionId) liveBySession.set(inst.sessionId, inst); else freshTabs.push(inst); }

      // 统一行：一条会话（session:list 的 s，或无 id 的新会话）→ DOM 行。liveInst 非空 = 已打开为 tab。
      // 全程 textContent（无 innerHTML 插值用户数据）→ CSP 安全。
      const sessionRow = (s, liveInst, rowCwd) => {
        const active = liveInst && liveInst.instanceId === viewingInstanceId;
        
        // 使用相对定位的包装容器来实现侧滑关闭
        const container = el(`<div class="relative overflow-hidden w-full select-none swipe-row-container"></div>`);
        
        // 背景红底“关闭”按钮
        let deleteBtn;
        if (liveInst) {
          deleteBtn = el(`<div class="absolute inset-y-0 right-0 w-[70px] bg-danger text-white flex items-center justify-center font-sans font-semibold text-xs active:opacity-90 cursor-pointer select-none" style="z-index: 10;">关闭</div>`);
          deleteBtn.onclick = (e) => {
            e.stopPropagation();
            haptic('warning');
            if (confirm(`关闭会话「${s.title || '新会话'}」？\n\n会话将从 tab 列表移除，但历史保留可重新打开。`)) {
              socket.emit('session:close', { instanceId: liveInst.instanceId });
              closeLeftSidebar();
            } else {
              rowContent.style.transform = 'translateX(0px)';
              rowSwiped = false;
            }
          };
          container.appendChild(deleteBtn);
        }

        // 行内容 (可滑动的前景卡片)
        const rowContent = el(`<div class="row-content relative flex items-center gap-2 pl-6 pr-3 py-2.5 border-b border-line-soft transition-transform duration-200 cursor-pointer${active ? ' bg-accent-wash' : ' bg-surface'}" style="z-index: 20;" data-testid="session-row" data-session-id="${s.id || ''}" data-instance-id="${liveInst?.instanceId || ''}"></div>`);
        const btn = el(`<button class="flex-1 min-w-0 text-left text-xs active:opacity-70"></button>`);
        btn.title = s.title || '新会话';
        const head = el(`<div class="truncate flex items-center gap-1.5"></div>`);
        const titleSpan = el(`<span class="truncate font-medium${active ? ' text-accent' : ' text-ink-soft'}"></span>`);
        titleSpan.textContent = s.title || '新会话';
        head.appendChild(titleSpan);
        if (liveInst) {                        // 已打开标记：状态角标（busy ⏳ / permission ⚠️ / error ❗ / done ✅）
          // busy 时优先使用工具细化图标（🤖 Agent / 🖥 Bash），其他状态用通用角标
          const badgeState = liveInst.state;
          let badgeIcon, badgeCls, badgeTitle;
          if (badgeState === 'busy' && liveInst.activeTool && TOOL_BADGE[liveInst.activeTool]) {
            badgeIcon = TOOL_BADGE[liveInst.activeTool];
            badgeCls = 'text-warning';
            badgeTitle = `运行中：${liveInst.activeTool}`;
          } else {
            const m = DIR_BADGE[badgeState];
            if (m) { badgeIcon = m[0]; badgeCls = m[1]; badgeTitle = m[2]; }
          }
          if (badgeIcon) { const b = el(`<span data-instance-badge></span>`); b.textContent = badgeIcon; b.className = `shrink-0 ${badgeCls}`; if (badgeTitle) b.title = badgeTitle; head.appendChild(b); }
        }
        btn.appendChild(head);
        const sub = el(`<div class="text-ink-faint text-[10px]"></div>`);
        const when = s.lastUsedAt ? new Date(s.lastUsedAt).toLocaleString() : '新会话（未保存）';
        // 短 session_id（前 8 位）：便于对照 CLI /resume、日志、多设备定位同一会话；无 id 的新会话不显示。
        const shortId = s.id ? ` · ${s.id.slice(0, 8)}` : '';
        sub.textContent = when + (liveInst ? ' · 已打开' : '') + shortId;
        btn.appendChild(sub);
        
        let rowSwiped = false;
        btn.onclick = (e) => {
          // 拦截滑动/滚动导致的误触
          if (rowContent.getAttribute('data-preventClick') === 'true') {
            e.preventDefault();
            e.stopPropagation();
            return;
          }
          if (rowSwiped) {
            rowContent.style.transform = 'translateX(0px)';
            rowSwiped = false;
            return;
          }
          haptic('tap');
          if (liveInst) {                      // 已打开：切视图，不重新 resume
            if (liveInst.instanceId !== viewingInstanceId) socket.emit('user:setViewing', { instanceId: liveInst.instanceId });
            closeLeftSidebar();
          } else {                             // 未打开：resume 打开（同步关面板 + 4s 兜底，不把反馈压在 ack 上）
            closeLeftSidebar();
            let acked = false;
            socket.emit('session:switch', { sessionId: s.id, cwd: rowCwd }, res => { acked = true; if (!res?.ok) addBar(res?.error || '切换失败', 'text-danger'); });
            setTimeout(() => { if (!acked) addBar('切换无响应，请刷新页面后重试', 'text-danger'); }, 4000);
          }
        };
        rowContent.appendChild(btn);

        // 原生 x 按钮：桌面/移动端均常显（此前 md:block hidden 只在桌面显示，手机端只能靠不可发现的侧滑
        // 手势——已打开会话本行没有其它可见按钮，用户体感是"点开会话后这行的图标凭空消失了"）。
        // 侧滑仍保留作快捷方式，二者并存、互不冲突，都是触发同一个 session:close。
        if (liveInst) {
          const closeBtn = el(`<button class="shrink-0 w-6 h-6 rounded text-ink-faint hover:text-danger hover:bg-sunk active:bg-line text-sm">✕</button>`);
          closeBtn.onclick = e => {
            e.stopPropagation();
            haptic('warning');
            if (confirm(`关闭会话「${s.title || '新会话'}」？\n\n会话将从 tab 列表移除，但历史保留可重新打开。`)) {
              socket.emit('session:close', { instanceId: liveInst.instanceId });
              closeLeftSidebar();
            }
          };
          rowContent.appendChild(closeBtn);
        }

        // 未打开的历史会话：两级删除入口（FR-20）。已打开的会话走上面的关闭 tab，不在此重复给删除入口
        // （删一个正被本产品驱动的会话语义混乱，后端 L2 保护①也会拒）。无 id 的新会话（未落盘）无从删。
        if (s.id && !liveInst) {
          const delBtn = el(`<button class="shrink-0 w-6 h-6 rounded text-ink-faint hover:text-danger hover:bg-sunk active:bg-line text-sm" title="删除会话">🗑</button>`);
          delBtn.onclick = e => {
            e.stopPropagation();
            haptic('warning');
            openDeleteSession(s.id, rowCwd, s.title);
          };
          rowContent.appendChild(delBtn);
        }

        container.appendChild(rowContent);

        // 手机端：侧滑触控手势监听 (Swipe left gestures) - 贴合指尖且防点击误触
        if (liveInst) {
          let rowStartX = 0, rowStartY = 0;
          let isDragging = false;

          rowContent.addEventListener('touchstart', ev => {
            rowStartX = ev.touches[0].clientX;
            rowStartY = ev.touches[0].clientY;
            isDragging = true;
            rowContent.classList.add('swiping'); // 禁用过渡
          }, { passive: true });

          rowContent.addEventListener('touchmove', ev => {
            if (!rowStartX || !isDragging) return;
            const currentX = ev.touches[0].clientX;
            const currentY = ev.touches[0].clientY;
            const diffX = currentX - rowStartX;
            const diffY = currentY - rowStartY;

            // 只要手指发生了明显移动（超过 8px），就标记为拖拽，防止触发点击事件
            if (Math.abs(diffX) > 8 || Math.abs(diffY) > 8) {
              rowContent.setAttribute('data-preventClick', 'true');
            }

            // 横向滑动优势判定
            if (Math.abs(diffX) > Math.abs(diffY) * 1.2) {
              let targetX = rowSwiped ? -70 + diffX : diffX;
              // 边缘阻尼
              if (targetX > 15) {
                targetX = 15 * 0.3;
              } else if (targetX < -100) {
                targetX = -100 + (targetX + 100) * 0.3;
              }
              rowContent.style.transform = `translateX(${targetX}px)`;
            }
          }, { passive: true });

          rowContent.addEventListener('touchend', ev => {
            if (!isDragging) return;
            isDragging = false;
            rowContent.classList.remove('swiping'); // 启用过渡

            const currentX = ev.changedTouches[0].clientX;
            const diffX = currentX - rowStartX;

            let finalSwiped = rowSwiped;
            if (rowSwiped) {
              if (diffX > 30) finalSwiped = false;
            } else {
              if (diffX < -35) finalSwiped = true;
            }

            rowSwiped = finalSwiped;
            if (rowSwiped) {
              rowContent.style.transform = 'translateX(-70px)';
              haptic('tap');
            } else {
              rowContent.style.transform = 'translateX(0px)';
            }

            // 延迟清除防误触标志，确保拦截 touchend 后产生的 click 事件
            setTimeout(() => {
              rowContent.removeAttribute('data-preventClick');
            }, 100);

            rowStartX = 0;
            rowStartY = 0;
          }, { passive: true });
        }

        return container;
      };

      // 组装并渲染子树函数
      const populateSubtree = (cwd, container, liveMap, fTabs) => {
        // 渲染：无 id 新会话实例 + 会话行 +（若被截断）「显示全部」行
        const renderRows = (sessions, hasMore) => {
          container.innerHTML = '';
          for (const inst of fTabs) {
            container.appendChild(sessionRow({ id: null, title: inst.title, lastUsedAt: null, entrypoint: null }, inst, cwd));
          }
          for (const s of sessions) {
            container.appendChild(sessionRow(s, liveMap.get(s.id), cwd));
          }
          if (hasMore) {
            const more = el(`<button class="w-full text-left pl-6 pr-3 py-2 text-xs text-accent hover:bg-sunk/50 border-b border-line-soft/40">显示全部会话…</button>`);
            more.onclick = () => {
              haptic('tap');
              more.textContent = '加载中…';
              socket.emit('session:list', { cwd, all: true }, state => {
                if (!expandedDirs.has(cwd)) return;
                const all = state?.sessions || [];
                sessionsCache.set(cwd, { sessions: all, hasMore: false });
                renderRows(all, false);
              });
            };
            container.appendChild(more);
          }
        };

        // 1) SWR 缓存极速呈现（缓存值形状：{sessions, hasMore}）
        if (sessionsCache.has(cwd)) {
          const cached = sessionsCache.get(cwd);
          renderRows(cached.sessions || [], cached.hasMore);
        } else {
          container.innerHTML = '';
          for (const inst of fTabs) {
            container.appendChild(sessionRow({ id: null, title: inst.title, lastUsedAt: null, entrypoint: null }, inst, cwd));
          }
          // 显示高级骨架屏
          const skeleton = el(`
            <div class="skeleton-loader py-1">
              <div class="flex flex-col gap-2 px-6 py-3 border-b border-line-soft/40">
                <div class="h-3.5 bg-sunk/60 skeleton-shimmer rounded w-2/3"></div>
                <div class="h-2 bg-sunk/40 skeleton-shimmer rounded w-1/3"></div>
              </div>
              <div class="flex flex-col gap-2 px-6 py-3 border-b border-line-soft/40">
                <div class="h-3.5 bg-sunk/60 skeleton-shimmer rounded w-1/2"></div>
                <div class="h-2 bg-sunk/40 skeleton-shimmer rounded w-1/4"></div>
              </div>
            </div>
          `);
          container.appendChild(skeleton);
        }

        // 2) 后端异步刷新（默认按每工作区 sessionLimit 截断；hasMore 决定是否显示「显示全部」）
        socket.emit('session:list', { cwd }, state => {
          if (!expandedDirs.has(cwd)) return; // 过期守卫
          const sessions = state?.sessions || [];
          sessionsCache.set(cwd, { sessions, hasMore: !!state?.hasMore });
          renderRows(sessions, !!state?.hasMore);
        });
      };

      // 如果当前展开，则渲染列表
      if (isExpanded) {
        populateSubtree(d, subtree, liveBySession, freshTabs);
      }

      // 折叠/展开切换：纯 CSS 驱动，不触发重绘全量 DOM
      toggleBtn.onclick = () => {
        haptic('tap');
        if (expandedDirs.has(d)) {
          expandedDirs.delete(d);
          subtree.classList.remove('expanded');
          arrow.classList.remove('rotated');
          icon.textContent = '📁';
        } else {
          expandedDirs.add(d);
          subtree.classList.add('expanded');
          arrow.classList.add('rotated');
          icon.textContent = '📂';
          populateSubtree(d, subtree, liveBySession, freshTabs);
        }
      };
    }
  }

  // 清视图层（DOM + 去重基线 + 弹窗队列），不加载历史——加载由调用方决定（台阶3：bindView 切 tab 时
  // 先 sync 活缓冲、无缓冲再 history）。
  function clearView(sessionId, tip) {
    currentSessionId = sessionId;
    lastSeq = 0;
    curEpoch = null;
    localStorage.setItem('current_session', sessionId || '');
    messagesEl.innerHTML = '';
    messagesEl.classList.remove('empty-start');
    streams.clear(); thinkings.clear(); toolCards.clear();
    subagentCards.clear(); // 切会话/清屏：丢弃子 agent 卡状态（DOM 已随 messagesEl 清空）
    permQueue.length = 0; activePerm = null;
    permExpandBtn?.remove(); permExpandBtn = null;
    closeSheet(permModal);
    questionQueue.length = 0; activeQuestion = null;
    closeSheet(questionModal);
    // 附件托盘不再这里无脑清空：bindView 经 planSessionDraftSwap 按会话存/取；
    // 发送成功路径各自清空。否则同会话静默换实例 / 重载历史会误清未发送附件。
    setBusy(false);
    hideActivityBanner(); // WS-005：清 activity 横幅（含 api_retry——二者共用 activityBanner + apiRetryBannerActive），否则 A 的活动/重试态残留到空闲的 B（task-progress 已由 setInstances 按实例处理）

    // Clear stale status line and hide details row to prevent latency layout flashes
    if (cliStatusEl) cliStatusEl.innerHTML = '';
    if (cliSummaryEl) cliSummaryEl.textContent = 'statusline';
    if (cliStatusWrapEl) {
      cliStatusWrapEl.removeAttribute('open'); // Fold <details> element
      cliStatusWrapEl.classList.add('hidden'); // Hide the wrapper
    }
    pillModel?.classList.remove('hidden'); // 恢复底栏模型 chip（statusLine 隐藏时）
    if (tip) addBar(tip, 'text-ink-faint');
  }

  // 空首页最近列表代次：连续 showDashboard（切 cwd / 重连）时丢弃过期 ack，防旧列表盖新。
  // 产品决策：重启/空闲回收后永远停在空首页，只展示最近列表，不自动 session:switch。
  let _dashRecentsGen = 0;

  function showDashboard() {
    messagesEl.innerHTML = '';
    messagesEl.classList.add('empty-start');
    if (topTitleText) topTitleText.textContent = '新聊天';
    if (topProjectText) topProjectText.textContent = baseName(currentCwd);

    const hour = new Date().getHours();
    let greeting;
    if (hour < 5) greeting = '夜深了，有什么需要我帮忙的吗？';
    else if (hour < 11) greeting = '上午好，今天我能帮您做什么？';
    else if (hour < 13) greeting = '中午好，今天我能帮您做什么？';
    else if (hour < 18) greeting = '下午好，今天我能帮您做什么？';
    else greeting = '晚上好，今天我能帮您做什么？';

    const container = el(`
      <div class="dashboard-container flex flex-col items-center w-full max-w-xl mx-auto py-6 px-3 select-none">
        <!-- 问候语区域 -->
        <div class="text-center mb-6 w-full">
          <h1 class="text-2xl md:text-3xl font-bold tracking-tight text-ink mb-3 leading-tight" id="dashGreeting">${esc(greeting)}</h1>
          <div class="text-[10px] text-ink-faint uppercase tracking-wider mb-1">当前工作区 / Active Workspace</div>
          <button type="button" class="empty-project-pill inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full border border-line-soft bg-surface text-ink hover:bg-sunk active:scale-[0.98] transition-all text-xs font-semibold shadow-sm" title="点击打开会话列表（按工作区浏览）">
            <svg class="w-4 h-4 shrink-0 text-accent opacity-90" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M3 7.5A2.5 2.5 0 015.5 5h4.25l2 2H18.5A2.5 2.5 0 0121 9.5v7A2.5 2.5 0 0118.5 19h-13A2.5 2.5 0 013 16.5v-9z" />
            </svg>
            <span class="max-w-[12rem] truncate">${esc(baseName(currentCwd))}</span>
            <span class="text-xs text-ink-faint">⌄</span>
          </button>
        </div>

        <div id="dashWorkspacesSection" class="w-full hidden mb-5">
          <div class="text-[10.5px] font-bold text-ink-faint uppercase tracking-wider mb-2 px-1 flex items-center gap-1">
            <span>📁</span>
            <span>最近活跃工作区</span>
          </div>
          <div id="dashWorkspacesList" class="flex flex-wrap gap-2 w-full px-0.5"></div>
        </div>

        <div id="dashRecentsSection" class="w-full hidden">
          <div class="text-[10.5px] font-bold text-ink-faint uppercase tracking-wider mb-3 px-1 flex items-center gap-1">
            <span>⏱️</span>
            <span>最近活跃会话</span>
          </div>
          <div id="dashRecentsList" class="flex flex-col gap-2 w-full"></div>
        </div>

        <!-- 使用引导入口（落地页常驻）：复用设置面板同款帮助页 -->
        <button id="dashHelpLink" class="mt-6 text-xs text-ink-faint hover:text-accent underline underline-offset-2 transition-colors" type="button">❓ 如何连接与使用</button>
      </div>`);

    // 绑定使用引导入口 → 访问帮助页（showAccessHelp）
    const dashHelp = container.querySelector('#dashHelpLink');
    if (dashHelp) dashHelp.onclick = (e) => { e.stopPropagation(); haptic('tap'); showAccessHelp(); };

    // 绑定工作区按钮 → 打开侧栏完整会话树（按工作区浏览 / 新建）
    container.querySelector('.empty-project-pill').onclick = (e) => {
      e.stopPropagation();
      haptic('tap');
      if (btnSessions) btnSessions.onclick();
    };

    // 跨全部白名单工作区拉最近会话（并行 session:list），合并后展示，便于冷启动/空首页一键切回。
    const recentsSection = container.querySelector('#dashRecentsSection');
    const recentsList = container.querySelector('#dashRecentsList');
    const workspacesSection = container.querySelector('#dashWorkspacesSection');
    const workspacesList = container.querySelector('#dashWorkspacesList');
    const dirs = (availableDirs && availableDirs.length) ? availableDirs.slice() : (currentCwd ? [currentCwd] : []);
    const gen = ++_dashRecentsGen;

    const switchToSession = (s) => {
      let acked = false;
      socket.emit('session:switch', { sessionId: s.id, cwd: s.cwd }, res => {
        acked = true;
        if (!res?.ok) addBar(res?.error || '切换失败', 'text-danger');
      });
      setTimeout(() => { if (!acked) addBar('切换无响应，请刷新页面后重试', 'text-danger'); }, 4000);
    };

    const renderDashRecents = (recent) => {
      // 工作区 chips：按最近会话时间去重排序，点 chip → 进入该区最近一条
      if (workspacesSection && workspacesList) {
        const seen = new Set();
        const wsOrder = [];
        for (const s of recent) {
          if (seen.has(s.cwd)) continue;
          seen.add(s.cwd);
          wsOrder.push(s);
        }
        workspacesList.innerHTML = '';
        for (const s of wsOrder) {
          const chip = el(`
            <button type="button" class="inline-flex items-center gap-1.5 max-w-full px-3 py-1.5 rounded-full border border-line-soft bg-surface hover:bg-accent-wash/40 hover:border-accent-bright/50 active:scale-[0.98] transition-all text-xs font-semibold text-ink shadow-sm">
              <span class="shrink-0 opacity-80">📁</span>
              <span class="truncate max-w-[10rem]"></span>
            </button>`);
          chip.querySelector('span.truncate').textContent = s.workspaceName;
          chip.title = s.cwd;
          chip.onclick = (e) => {
            e.stopPropagation();
            haptic('tap');
            switchToSession(s);
          };
          workspacesList.appendChild(chip);
        }
        workspacesSection.classList.remove('hidden');
      }

      recentsSection.classList.remove('hidden');
      recentsList.innerHTML = '';
      for (const s of recent) {
        const when = s.lastUsedAt ? new Date(s.lastUsedAt).toLocaleString() : '时间未知';
        const item = el(`
          <div class="dash-recent-item flex items-center justify-between p-3 bg-surface hover:bg-accent-wash/30 border border-line-soft hover:border-accent-bright/50 rounded-xl cursor-pointer transition-all active:scale-[0.99]">
            <div class="flex-1 min-w-0 pr-3">
              <div class="font-bold text-xs text-ink truncate"></div>
              <div class="text-[10px] text-ink-faint mt-1 flex items-center gap-1.5 min-w-0">
                <span class="shrink-0">📁</span>
                <span class="truncate dash-ws"></span>
                <span class="shrink-0 opacity-50">·</span>
                <span class="shrink-0 dash-when"></span>
              </div>
            </div>
            <div class="text-xs text-accent font-bold shrink-0">进入 ➔</div>
          </div>
        `);
        item.querySelector('.font-bold').textContent = s.title || '无标题会话';
        item.querySelector('.dash-ws').textContent = s.workspaceName;
        item.querySelector('.dash-when').textContent = when;
        item.title = `${s.workspaceName} · ${s.title || '无标题会话'}`;
        item.onclick = (e) => {
          e.stopPropagation();
          haptic('tap');
          switchToSession(s);
        };
        recentsList.appendChild(item);
      }
    };

    if (recentsSection && recentsList && dirs.length) {
      Promise.all(dirs.map(cwd => new Promise(resolve => {
        let settled = false;
        const done = (sessions) => { if (!settled) { settled = true; resolve({ cwd, sessions }); } };
        socket.emit('session:list', { cwd }, state => done(state?.sessions || []));
        setTimeout(() => done([]), 4000); // 单目录超时不挡整表
      }))).then(dirLists => {
        if (gen !== _dashRecentsGen) return; // 已换页/重渲
        const recent = mergeRecentSessionsAcrossWorkspaces(dirLists, { limit: 8 });
        if (!recent.length) return;
        renderDashRecents(recent);
      });
    }

    messagesEl.appendChild(container);
  }

  function loadHistory(sessionId, cwd = currentCwd) {
    if (!sessionId) return;
    const reqInstanceId = displayedInstanceId; // WS-001：捕获发起时的视图目标（代次）
    socket.emit('session:history', { sessionId, cwd }, res => {
      // WS-001：迟到 ACK 守卫——发起后若已切走（会话或实例变），丢弃本回调。否则 A 的历史会被 renderHistoryBubbles
      // 追加进当前 B 的 DOM，且 hideLoadingCard 抹掉 B 的 loading 卡。对齐 onHistoryAppend 的 viewingInstanceId 守卫。
      if (displayedSessionId !== sessionId || displayedInstanceId !== reqInstanceId) return;
      hideLoadingCard();
      const msgs = res?.messages || [];
      if (!msgs.length) {
        if (res?.error) addBar('历史消息加载失败', 'text-ink-faint');
        return;
      }
      addBar(`加载了 ${msgs.length} 条历史消息`, 'text-ink-faint');
      renderHistoryBubbles(msgs);
      // 记下该会话已渲染到的磁盘 history 条数——切入时与 server 报的 diskLen 比对，判「离开期间被外部写过」
      // 而需清屏重载（见 shouldReloadOnEnter）。全量重载=全长。
      seenDiskLenBySession.set(sessionId, msgs.length);
    });
  }

  // 渲染一批历史/追平消息为气泡并追加（loadHistory 与 onHistoryAppend 复用；一次性 fragment 插入 + 空闲高亮）。
  // 支持文本 / thinking / tool_use / tool_result；sidechain（parentToolUseId）收进可折叠子 agent 卡。
  function renderHistoryBubbles(msgs) {
    if (!msgs?.length) return;
    const frag = document.createDocumentFragment();
    const codeBlocks = [];
    const histToolCards = new Map(); // toolUseId → card（本批内配对 tool_result）
    const histSubCards = new Map(); // parentToolUseId → { el, body, titleEl }
    const ensureHistSub = (parentId) => {
      let c = histSubCards.get(parentId);
      if (c) return c;
      const wrap = el(`
        <details class="msg-frame subagent-card rounded-lg bg-surface border border-line text-xs" data-testid="subagent-card" data-history="1">
          <summary class="px-3 py-2 flex items-center gap-2 cursor-pointer select-none">
            <span class="sa-title text-ink font-medium"></span>
          </summary>
          <div class="sa-body px-3 pb-2 pl-4 border-l-2 border-accent/40 ml-3 space-y-1"></div>
        </details>`);
      wrap.dataset.parentId = parentId;
      const titleEl = wrap.querySelector('.sa-title');
      titleEl.textContent = formatSubagentCardTitle({ subagentType: null, running: false });
      c = { el: wrap, body: wrap.querySelector('.sa-body'), titleEl };
      histSubCards.set(parentId, c);
      frag.appendChild(wrap);
      return c;
    };
    const appendNode = (node, msg) => {
      if (msg?.parentToolUseId || msg?.isSidechain) {
        const pid = msg.parentToolUseId || 'sidechain';
        ensureHistSub(pid).body.appendChild(node);
      } else {
        frag.appendChild(node);
      }
    };
    for (const msg of msgs) {
      if (msg?.kind === 'thinking') {
        const wrap = el(`
          <details class="msg-frame thinking rounded-lg bg-surface border border-line-soft text-xs text-ink-faint">
            <summary class="px-3 py-1.5">💭 思考过程</summary>
            <pre class="t-body px-3 pb-2 whitespace-pre-wrap"></pre>
          </details>`);
        wrap.querySelector('.t-body').textContent = msg.content || '';
        appendNode(wrap, msg);
        continue;
      }
      if (msg?.kind === 'tool_use') {
        const card = el(`
          <details class="msg-frame toolcard rounded-lg bg-surface border border-line text-xs">
            <summary class="px-3 py-2 flex items-center gap-2">
              <span class="t-status">⏳</span><span class="font-mono font-semibold text-ink">${esc(msg.name || 'tool')}</span>
            </summary>
            <div class="px-3 pb-2 space-y-1">
              <pre class="t-in overflow-x-auto whitespace-pre-wrap break-words text-ink-soft"><code></code></pre>
              <pre class="t-out overflow-x-auto whitespace-pre-wrap break-words text-ink-faint hidden"><code></code></pre>
            </div>
          </details>`);
        const inCode = card.querySelector('.t-in code');
        if (inCode) {
          inCode.textContent = formatToolSummary(msg.inputSummary || '');
          codeBlocks.push(inCode);
        }
        if (msg.toolUseId) histToolCards.set(msg.toolUseId, card);
        // 主链 Agent/Task：预建折叠卡（与 live 一致）
        if (!msg.parentToolUseId && !msg.isSidechain && (msg.name === 'Agent' || msg.name === 'Task') && msg.toolUseId) {
          ensureHistSub(msg.toolUseId);
        }
        appendNode(card, msg);
        continue;
      }
      if (msg?.kind === 'tool_result') {
        const card = msg.toolUseId ? histToolCards.get(msg.toolUseId) : null;
        if (!card) {
          const orphan = el(`
            <details class="msg-frame toolcard rounded-lg bg-surface border border-line text-xs">
              <summary class="px-3 py-2 flex items-center gap-2">
                <span class="t-status">${msg.ok === false ? '❌' : '✅'}</span>
                <span class="font-mono font-semibold text-ink">tool</span>
              </summary>
              <div class="px-3 pb-2 space-y-1">
                <pre class="t-out overflow-x-auto whitespace-pre-wrap break-words text-ink-faint"><code></code></pre>
              </div>
            </details>`);
          const code = orphan.querySelector('.t-out code');
          if (code) {
            code.textContent = formatToolSummary(msg.outputSummary || '');
            codeBlocks.push(code);
          }
          appendNode(orphan, msg);
          continue;
        }
        card.querySelector('.t-status').textContent = msg.ok === false ? '❌' : '✅';
        if (msg.outputSummary) {
          const out = card.querySelector('.t-out');
          const code = out.querySelector('code') || out;
          code.textContent = formatToolSummary(msg.outputSummary);
          if (code !== out) codeBlocks.push(code);
          out.classList.remove('hidden');
        }
        histToolCards.delete(msg.toolUseId);
        // 主链 Agent 完成 → 子卡标题「已完成」
        if (!msg.parentToolUseId && histSubCards.has(msg.toolUseId)) {
          const sa = histSubCards.get(msg.toolUseId);
          sa.titleEl.textContent = formatSubagentCardTitle({ running: false });
        }
        continue;
      }
      // 文本气泡（默认路径）
      const isUser = msg.role === 'user';
      const bubble = isUser
        ? el(`<div class="msg-frame bg-user text-ink um rounded-xl px-3 py-2 text-sm msg-body" data-testid="user-message"></div>`)
        : el(`<div class="msg-frame px-0.5 msg-body" data-testid="assistant-message"></div>`);
      if (msg.parentToolUseId || msg.isSidechain) {
        // 子 agent 正文：纯文本进卡，避免历史 markdown 二次污染嵌套
        bubble.textContent = msg.content || '';
        bubble.className = 'msg-body px-0.5 text-ink-soft whitespace-pre-wrap text-xs';
        appendNode(bubble, msg);
        continue;
      }
      bubble.innerHTML = render(msg.content || '');
      bubble.querySelectorAll('pre code').forEach(b => codeBlocks.push(b));
      injectCodeCopyButtons(bubble);
      if (isUser) foldLongUserBubble(bubble, msg.content || '');
      appendCopyAction(bubble, () => msg.content || '', isUser ? 'right' : 'left');
      frag.appendChild(bubble);
    }
    leaveStartScreen();
    messagesEl.appendChild(frag); // 一次性插入，避免 N 次 live-DOM reflow
    scrollBottom(true);
    if (codeBlocks.length) {
      const doHighlight = () => codeBlocks.forEach(b => { try { hljs.highlightElement(b); } catch { /* 高亮失败不影响显示 */ } });
      if (typeof requestIdleCallback !== 'undefined') {
        requestIdleCallback(doHighlight, { timeout: 2000 });
      } else {
        setTimeout(doHighlight, 0);
      }
    }
  }

  // 只读「追平」：server 轮询「正在终端 CLI 里跑」的会话 transcript，检测到【外部新落定】消息 → history_append。
  // 仅渲染当前查看会话。局限：看不到实时 thinking / 在跑子 agent——它们不落盘，终端把消息落定后才追加得到。
  function onHistoryAppend(ev) {
    if (ev.instanceId !== viewingInstanceId) return; // 只进当前查看会话（server 已按 viewing 发，这里再兜一层）
    const msgs = ev.payload?.messages || [];
    if (msgs.length) {
      renderHistoryBubbles(msgs);
      // 追平也是磁盘 history 增量——累加到已见条数，保持切入对账基准准确（见 shouldReloadOnEnter）。
      const sid = ev.sessionId;
      if (sid) seenDiskLenBySession.set(sid, (seenDiskLenBySession.get(sid) || 0) + msgs.length);
      // 外部写入重置自动解锁倒计时（quietTicks 清零 → 重新满量约 12.5s）
      if (ev.payload?.external && mirrorReadonlySid) startMirrorCountdown();
    }
  }

  // 只读锁：会话被判「正在终端运行」时常驻横幅 + 禁用输入，硬防两进程并发写盘分叉。
  // 四态文案（2026-07-13 排队接管）：stale=false 未 armed=「⏱ 终端驾驶中」（尾部形态判轮次未完结，长工具调用
  // 零写盘期间也维持——修「过一会儿感觉没在跑」误判）；armed=「⏳ 已排队接管」（点了「接管 CLI 会话」但终端本轮
  // 未完结，纯等待、零并发写盘风险，见下方 armedTakeoverStep 接线）；stale=true=「⚠️ 疑似中断」（pending 但
  // 超 5 分钟零写入，终端可能被强杀/断电，维持即时确认接管——等待对已疑似死亡的终端无意义）。
  // 驾驶中倒计时：优先 mirror_state.remainingMs（服务端 quietTicks×间隔）；缺省回落 12.5s 估计。
  // 每次 history_append 外部消息 / 重新上锁会 reset。
  const MIRROR_UNLOCK_EST_SEC = 12.5;
  let mirrorCountdownTimer = null;
  let mirrorCountdownEndsAt = 0;
  function stopMirrorCountdown() {
    if (mirrorCountdownTimer) { clearInterval(mirrorCountdownTimer); mirrorCountdownTimer = null; }
    mirrorCountdownEndsAt = 0;
  }
  function refreshMirrorBannerCopy() {
    if (!mirrorReadonlySid || !mirrorBannerText || !mirrorBannerIcon) return;
    const armed = armedTakeoverSid === mirrorReadonlySid;
    const remainingSec = (!armed && !mirrorStaleFlag && mirrorCountdownEndsAt)
      ? Math.max(0, (mirrorCountdownEndsAt - Date.now()) / 1000)
      : undefined;
    mirrorBannerIcon.textContent = armed ? '⏳' : (mirrorStaleFlag ? '⚠️' : '⏱');
    mirrorBannerText.textContent = formatMirrorBannerText({
      armed, stale: mirrorStaleFlag, remainingSec: armed || mirrorStaleFlag ? undefined : remainingSec,
    });
  }
  function startMirrorCountdown(remainingMs) {
    stopMirrorCountdown();
    const ms = Number.isFinite(remainingMs) ? remainingMs : MIRROR_UNLOCK_EST_SEC * 1000;
    mirrorCountdownEndsAt = Date.now() + Math.max(0, ms);
    refreshMirrorBannerCopy();
    mirrorCountdownTimer = setInterval(() => {
      if (!mirrorReadonlySid || armedTakeoverSid || mirrorStaleFlag) { stopMirrorCountdown(); return; }
      if (Date.now() >= mirrorCountdownEndsAt) {
        // 到点不自动解锁（权威在 server mirror_state）；文案回落默认句，等 server 解锁事件
        stopMirrorCountdown();
        refreshMirrorBannerCopy();
        return;
      }
      refreshMirrorBannerCopy();
    }, 1000);
  }
  function applyMirror(readonly, sessionId, stale = false, observedCli, remainingMs) {
    const wasEffective = Boolean(mirrorReadonlySid);
    const effective = readonly && mirrorOverriddenSid !== sessionId; // 已接管则忽略只读
    if (effective && !wasEffective) {
      mirrorWebPanelSnapshot = captureWebPanelState();
      ultracodeArmed = false; // CLI 观察态从不继承 Web-only workflow 武装；退出镜像时由快照恢复
    }
    if (observedCli !== undefined) {
      mirrorObservedCli = {
        model: observedCli?.model ?? null,
        permissionMode: observedCli?.permissionMode ?? null,
        effort: observedCli?.effort ?? null,
      };
    }
    mirrorReadonlySid = effective ? sessionId : null;
    mirrorStaleFlag = effective && stale;
    if (effective) {
      // observed CLI state 只是镜像展示层，不能写回 Web 实例偏好；未知字段也必须保持未知。
      renderCliPanelState();
    } else if (wasEffective) {
      restoreWebPanelState();
      mirrorWebPanelSnapshot = null;
      mirrorObservedCli = { model: null, permissionMode: null, effort: null };
    } else {
      rebuildEffortOptions(currentModel || cwdDefaultModel);
    }
    mirrorBanner?.classList.toggle('hidden', !effective);
    const armed = effective && armedTakeoverSid === sessionId;
    if (effective) {
      if (!armed && !stale) startMirrorCountdown(remainingMs);
      else { stopMirrorCountdown(); refreshMirrorBannerCopy(); }
    } else {
      stopMirrorCountdown();
    }
    if (btnMirrorOverride) btnMirrorOverride.textContent = armed ? '取消接管' : '接管 CLI 会话';
    if (inputEl) inputEl.disabled = effective;
    if (effective) { if (btnSend) btnSend.disabled = true; } // 锁定：禁发送
    else updateSendButtonState();                            // 解锁：按有无文本恢复发送按钮态
  }
  function onMirrorState(ev) {
    // readonly=true 只对当前查看会话生效；readonly=false（sessionId 可能为 null）一律解锁。
    // ⚠️ 已知边界（code-review 发现3，有意不修）：mirror_state 是 io.emit 广播 + 服务端 viewingInstanceId
    //   是单例全局（一次只跟踪一个会话的锁）。readonly=false 这里【无条件解锁】——两台设备同时看不同会话时，
    //   给会话 B 的解锁会误解锁正看着会话 A 的另一端。属"单活跃查看者"架构限制，仅多设备-不同会话场景触发；
    //   彻底修需把 viewing/catchup/mirror 全改 per-socket + 定向 emit（大改），单用户工具不值，故保留。
    //   （承接 docs/design.md；2026-07-12 机主确认 Phase 8 不做此 per-socket 大改、保留现状，见 server.js setMirror 登记。）
    const readonly = !!ev.payload?.readonly;
    const stale = !!ev.payload?.stale;
    if (readonly && ev.instanceId !== viewingInstanceId) return;
    if (armedTakeoverSid) { // 排队接管中：交给 armedTakeoverStep 判是否该自动放行（本轮完结/转疑似中断）
      const step = armedTakeoverStep({ armed: true, armedSid: armedTakeoverSid }, { kind: 'mirror', readonly, stale, sessionId: ev.sessionId });
      if (step.action !== 'none') {
        armedTakeoverSid = null;
        mirrorOverriddenSid = ev.sessionId;
        applyMirror(false, ev.sessionId);
        addBar(step.action === 'unlock-focus'
          ? '已接管 CLI 会话：终端本轮已完结，安全切换'
          : '已接管 CLI 会话：终端疑似中断，自动完成接管——若终端仍在跑同一会话，并发发送有分叉风险',
          step.action === 'unlock-focus' ? 'text-ink-faint' : 'text-warning');
        inputEl?.focus();
        return;
      }
    }
    applyMirror(readonly, ev.sessionId, stale, ev.payload?.observedCli, ev.payload?.remainingMs);
  }
  // 「接管 CLI 会话」：驾驶中(⏱)点击=排队接管——不立即解锁（零并发写盘风险，静候终端本轮完结/转疑似中断自动放行，
  // 见 onMirrorState），无需确认弹窗；再次点击（此时按钮已变「取消接管」）可撤销排队、回退驾驶中态。
  // 疑似中断(⚠️)点击=维持原地即时确认（弹窗说清「不停终端进程 + 分叉后果 + 建议先 Ctrl+C」）后立即解锁——
  // 终端大概率已死，等待无意义。接管后（任一路径）首次发送经 server 陈旧上下文守卫置换实例，吸收终端轮次。
  btnMirrorOverride?.addEventListener('click', () => {
    if (!mirrorReadonlySid) return;
    if (armedTakeoverSid === mirrorReadonlySid) { // 取消排队中的接管，回退驾驶中态
      armedTakeoverSid = null;
      applyMirror(true, mirrorReadonlySid, false); // 仍处于 armed 时必未 stale（stale 经 unlock-stale 已自动放行）
      return;
    }
    if (!mirrorStaleFlag) { // 驾驶中：排队等待，零风险故无需确认弹窗
      armedTakeoverSid = mirrorReadonlySid;
      applyMirror(true, mirrorReadonlySid, false);
      addBar('已请求接管 CLI 会话：终端当前操作完成后自动切换，可点「取消接管」撤销', 'text-ink-faint');
      return;
    }
    if (!confirm('接管 CLI 会话？\n\n这是电脑终端正在跑的同一条对话。接管不会停止终端进程——两边同时发消息会造成会话分叉（对方的消息在后续会话中可能不可见）。\n\n建议先到终端 Ctrl+C 或等它跑完再接管。')) return;
    mirrorOverriddenSid = mirrorReadonlySid;
    applyMirror(false, mirrorReadonlySid);
    addBar('已接管 CLI 会话：若终端仍在跑同一会话，并发发送有分叉风险', 'text-warning');
    inputEl?.focus();
  });
  // 「刷新消息」：强制触发一次 server 追平 tick（正常 2.5s 自动跑，这里给"我要确定是最新的"一个确定性入口）
  btnMirrorSync?.addEventListener('click', () => {
    haptic('tap');
    socket.emit('mirror:syncNow');
    addBar('已请求刷新：拉取终端最新消息', 'text-ink-faint');
  });

  // E18: 为代码块注入复制按钮（per-block，hover 时浮现）
  function injectCodeCopyButtons(container) {
    container.querySelectorAll('pre').forEach(pre => {
      if (pre.closest('.code-block-wrap')) return; // 已注入跳过
      const wrap = document.createElement('div');
      wrap.className = 'code-block-wrap';
      pre.parentNode.insertBefore(wrap, pre);
      wrap.appendChild(pre);
      const btn = el(`
        <button class="code-copy-btn" title="复制代码">
          <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" />
          </svg>
          <span>复制</span>
        </button>
      `);
      btn.onclick = async (e) => {
        e.stopPropagation();
        haptic('tap');
        const code = pre.querySelector('code');
        const text = code ? code.textContent : pre.textContent;
        const ok = await copyText(text);
        const span = btn.querySelector('span');
        if (span) span.textContent = ok ? '已复制' : '失败';
        setTimeout(() => { if (span) span.textContent = '复制'; }, 1500);
      };
      wrap.appendChild(btn);
    });
  }

  // ---- 工具函数 ----

  // E18：带降级的剪贴板写入（HTTPS/安全上下文用 navigator.clipboard；局域网 HTTP 降级 execCommand）
  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {}
    try {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch { return false; }
  }



  // E18: Redesigned premium utility row under each message block with copy, speak (TTS), and edit capabilities
  function appendCopyAction(container, getText, align) {
    if (!getText()) return;   // Empty messages have no action bar
    
    // For User messages (aligned to the right), render a single clean copy icon button aligned to the right
    if (align === 'right') {
      const row = el(`<div class="mt-1 text-right msg-action-bar justify-end"></div>`);
      const btn = el(`
        <button class="msg-action-btn" title="复制消息">
          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" />
          </svg>
          <span>复制</span>
        </button>
      `);
      btn.onclick = async () => {
        haptic('tap');
        const ok = await copyText(getText());
        const span = btn.querySelector('span');
        if (span) span.textContent = ok ? '已复制' : '失败';
        setTimeout(() => { if (span) span.textContent = '复制'; }, 1500);
      };
      row.appendChild(btn);
      container.appendChild(row);
      return;
    }

    // For Assistant messages (aligned to the left), render a beautiful multi-action bar
    const bar = el(`<div class="msg-action-bar justify-start"></div>`);
    
    // 1. Copy Button
    const copyBtn = el(`
      <button class="msg-action-btn" title="复制消息">
        <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" />
        </svg>
        <span>复制</span>
      </button>
    `);
    copyBtn.onclick = async () => {
      haptic('tap');
      const ok = await copyText(getText());
      const span = copyBtn.querySelector('span');
      if (span) span.textContent = ok ? '已复制' : '失败';
      setTimeout(() => { if (span) span.textContent = '复制'; }, 1500);
    };
    bar.appendChild(copyBtn);

    // 2. Speak (TTS) Button using browser-native Web Speech API
    const speakBtn = el(`
      <button class="msg-action-btn" title="语音朗读">
        <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
        </svg>
        <span>朗读</span>
      </button>
    `);
    speakBtn.onclick = () => {
      if (window.speechSynthesis.speaking && activeSpeechBtn === speakBtn) {
        window.speechSynthesis.cancel();
        speakBtn.innerHTML = `
          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
          </svg>
          <span>朗读</span>
        `;
        activeSpeechBtn = null;
        return;
      }
      
      if (window.speechSynthesis.speaking) {
        window.speechSynthesis.cancel();
        if (activeSpeechBtn) {
          activeSpeechBtn.innerHTML = `
            <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
            </svg>
            <span>朗读</span>
          `;
        }
      }

      haptic('tap');
      const text = getText();
      // Remove basic markdown formatting for cleaner speech synthesis output
      const cleanText = text.replace(/[*_`#]/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').trim();
      if (!cleanText) return;
      
      const utterance = new SpeechSynthesisUtterance(cleanText);
      utterance.onend = () => {
        speakBtn.innerHTML = `
          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
          </svg>
          <span>朗读</span>
        `;
        if (activeSpeechBtn === speakBtn) activeSpeechBtn = null;
      };
      
      speakBtn.innerHTML = `
        <svg class="w-3.5 h-3.5 text-danger animate-pulse" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
        </svg>
        <span class="text-danger font-semibold">停止</span>
      `;
      activeSpeechBtn = speakBtn;
      window.speechSynthesis.speak(utterance);
    };
    bar.appendChild(speakBtn);

    // 3. Edit / Reuse Button to put the message text back into input
    const editBtn = el(`
      <button class="msg-action-btn" title="编辑消息/重新放入输入框">
        <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
        </svg>
        <span>编辑</span>
      </button>
    `);
    editBtn.onclick = () => {
      haptic('tap');
      // Find the previous user bubble to get the prompt
      let prevUserText = '';
      let sibling = container.previousElementSibling;
      while (sibling) {
        if (sibling.classList.contains('bg-user')) {
          const textEl = sibling.querySelector(':scope > .whitespace-pre-wrap') || sibling.querySelector('.whitespace-pre-wrap');
          if (textEl) {
            prevUserText = textEl.textContent || '';
          } else {
            const clone = sibling.cloneNode(true);
            clone.querySelectorAll?.('.msg-action-bar').forEach(node => node.remove());
            prevUserText = clone.textContent || '';
          }
          prevUserText = prevUserText.trim();
          break;
        }
        sibling = sibling.previousElementSibling;
      }
      
      const valToSet = prevUserText || getText();
      if (inputEl) {
        inputEl.value = valToSet;
        inputEl.focus();
        inputEl.dispatchEvent(new Event('input'));
        scrollBottom(true);
      }
    };
    bar.appendChild(editBtn);

    container.appendChild(bar);
  }

  // 长用户文本折叠（live user_message、离线乐观占位符、历史回显共用）。
  // 纯函数 userBubbleFold 判超 10 行才折；折叠态限高 8rem（≈6 行可见一截）+ 内联「展开」按钮，
  // 点开保持展开、再点收起（用户选的策略：点开就保持展开）。
  function foldLongUserText(textEl, rawText) {
    if (!textEl) return;
    const { fold } = userBubbleFold(rawText);
    if (!fold) return;
    textEl.classList.add('overflow-hidden');
    textEl.style.maxHeight = '8rem';
    const btn = el(`<button class="text-xs text-accent mt-1 block">展开</button>`);
    let expanded = false;
    btn.onclick = () => {
      expanded = !expanded;
      if (expanded) { textEl.style.maxHeight = 'none'; btn.textContent = '收起'; textEl.classList.remove('overflow-hidden'); }
      else { textEl.style.maxHeight = '8rem'; btn.textContent = '展开'; textEl.classList.add('overflow-hidden'); }
    };
    textEl.after(btn);
  }

  // 历史回显气泡（innerHTML 渲染过 markdown）：把渲染产物包进一层限高容器 + 「展开」按钮，
  // 与 foldLongUserText 视觉一致。不重写已渲染的 innerHTML（避免二次 markdown 解释风险）。
  function foldLongUserBubble(bubble, rawText) {
    if (!bubble) return;
    const { fold } = userBubbleFold(rawText);
    if (!fold) return;
    // 把气泡里已渲染的 DOM 节点平移进一个限高包装层
    const wrap = el(`<div class="overflow-hidden" style="max-height:8rem"></div>`);
    while (bubble.firstChild) wrap.appendChild(bubble.firstChild);
    bubble.appendChild(wrap);
    const btn = el(`<button class="text-xs text-accent mt-1 block">展开</button>`);
    let expanded = false;
    btn.onclick = () => {
      expanded = !expanded;
      if (expanded) { wrap.style.maxHeight = 'none'; wrap.classList.remove('overflow-hidden'); btn.textContent = '收起'; }
      else { wrap.style.maxHeight = '8rem'; wrap.classList.add('overflow-hidden'); btn.textContent = '展开'; }
    };
    wrap.after(btn);
  }

  function showLoadingCard() {
    if ($('historyLoadingCard')) return;
    const card = el(`
      <div id="historyLoadingCard" class="flex flex-col items-center justify-center p-5 my-10 mx-auto max-w-[200px] rounded-xl border border-line-soft bg-surface/80 backdrop-blur-md select-none animate-pulse" style="box-shadow:var(--shadow-pop)">
        <svg class="animate-spin h-6 w-6 text-accent mb-2.5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
        </svg>
        <div class="text-xs font-semibold text-ink-soft tracking-wide">正在加载会话...</div>
      </div>
    `);
    appendMessage(card);
    scrollBottom(true);
  }

  function hideLoadingCard() {
    $('historyLoadingCard')?.remove();
  }
  // esc / ansiToHtml 已抽到 logic.js（顶部 import）。

  if (btnConsole) {
    btnConsole.onclick = () => {
      if (consoleModal) {
        if (!consoleModal.classList.contains('sheet-open')) {
          openSheet(consoleModal);
          loadConsoleLogs();
        } else {
          closeSheet(consoleModal);
        }
      }
    };
  }

  if (consoleClose) {
    consoleClose.onclick = () => {
      if (consoleModal) closeSheet(consoleModal);
    };
  }

  if (consoleModal) {
    consoleModal.onclick = (e) => {
      if (e.target === consoleModal) {
        closeSheet(consoleModal);
      }
    };
  }

  if (consoleClear) {
    consoleClear.onclick = () => {
      if (consoleLogArea) consoleLogArea.innerHTML = '';
    };
  }

  function loadConsoleLogs(id) {
    const instId = id || viewingInstanceId;
    if (!instId) {
      // 首页无选中实例：服务端日志按实例隔离故无从拉，但连接级(client_conn)日志无工作区归属、恒显——
      // 仍渲染它们，否则首页打开日志抽屉一片空白、断连/重连痕迹全丢（logEntryVisibleForInstance 对 client_conn 恒 true）。
      if (consoleLogArea) {
        consoleLogArea.innerHTML = '';
        clientLogger.entries().filter(e => logEntryVisibleForInstance(e, null)).forEach(log => appendLogEntry(log));
      }
      return;
    }
    socket.emit('logs:get', { instanceId: instId }, (res) => {
      if (!consoleLogArea) return;
      // WS-019：迟到 ACK 守卫——发起后若已切到别的实例，丢弃本回调。否则 A 的日志回包会清空并覆盖共享的
      // consoleLogArea（当前显示 B 的日志）。仅调试抽屉、只读、下次打开自愈，但迟到覆盖仍是可见错乱。
      if (viewingInstanceId !== instId) return;
      consoleLogArea.innerHTML = '';
      let mergedLogs = [];
      if (res && Array.isArray(res.logs)) {
        mergedLogs = [...res.logs];
      }
      // 只合并属于本实例(或连接级恒显)的 client 日志——修切工作区残留上个区日志（clientLogBuffer 全局无隔离）。
      // 服务端日志(res.logs)已按 sessionId 隔离、无 instanceId 字段，不经此过滤。
      mergedLogs = mergedLogs.concat(clientLogger.entries().filter(e => logEntryVisibleForInstance(e, instId)));
      mergedLogs.sort((a, b) => a.ts - b.ts);
      if (mergedLogs.length > 200) {
        mergedLogs = mergedLogs.slice(mergedLogs.length - 200);
      }
      mergedLogs.forEach(log => appendLogEntry(log));
    });
  }

  function appendLogEntry(p) {
    if (!p || !consoleLogArea) return;
    // 布局契约：纵向 row + 可换行 meta + 满宽 body（见 logic.js consoleLogEntryLayout）。
    // 旧横向 flex 会在窄屏被 chip 挤成一字宽竖排。
    const layout = consoleLogEntryLayout();
    const row = document.createElement('div');
    row.className = layout.row;

    const meta = document.createElement('div');
    meta.className = layout.meta;

    const tsStr = p.ts ? new Date(p.ts).toLocaleTimeString() : new Date().toLocaleTimeString();
    const tsSpan = document.createElement('span');
    tsSpan.className = 'text-gray-500 select-none shrink-0 font-semibold';
    tsSpan.textContent = `[${tsStr}]`;
    meta.appendChild(tsSpan);

    const badgeSpan = document.createElement('span');
    badgeSpan.className = 'px-1 py-0.5 rounded text-[9px] uppercase font-bold tracking-wider shrink-0';
    let badgeText;
    let textClass;

    switch (p.type) {
      case 'user_in':
        badgeSpan.className += ' bg-blue-950/60 text-blue-400 border border-blue-800/40';
        badgeText = 'user→srv';
        textClass = 'text-blue-100/90';
        break;
      case 'user_out':
        badgeSpan.className += ' bg-cyan-950/60 text-cyan-400 border border-cyan-800/40';
        badgeText = 'srv→cli';
        textClass = 'text-cyan-100/90';
        break;
      case 'agent_send':
        badgeSpan.className += ' bg-purple-950/60 text-purple-400 border border-purple-800/40';
        badgeText = 'agt→sdk';
        textClass = 'text-purple-100/90';
        break;
      case 'agent_result':
        badgeSpan.className += ' bg-emerald-950/60 text-emerald-400 border border-emerald-800/40';
        badgeText = 'sdk→agt';
        textClass = 'text-emerald-100/90';
        break;
      case 'sys_info':
        badgeSpan.className += ' bg-rose-950/60 text-rose-400 border border-rose-800/40';
        badgeText = 'sys-info';
        textClass = 'text-rose-100/90';
        break;
      case 'client_conn':
        badgeSpan.className += ' bg-amber-950/60 text-amber-400 border border-amber-800/40';
        badgeText = 'cli-conn';
        textClass = 'text-amber-100/90';
        break;
      case 'client_send':
        badgeSpan.className += ' bg-blue-950/60 text-blue-400 border border-blue-800/40';
        badgeText = 'web-send';
        textClass = 'text-blue-100/90';
        break;
      case 'client_recv':
        badgeSpan.className += ' bg-indigo-950/60 text-indigo-400 border border-indigo-800/40';
        badgeText = 'web-recv';
        textClass = 'text-indigo-100/90';
        break;
      case 'client_stream':
        badgeSpan.className += ' bg-teal-950/60 text-teal-400 border border-teal-800/40';
        badgeText = 'stream';
        textClass = 'text-teal-100/90';
        break;
      default:
        badgeSpan.className += ' bg-gray-800 text-gray-400 border border-gray-700';
        badgeText = p.type || 'log';
        textClass = 'text-gray-300';
    }
    badgeSpan.textContent = badgeText;
    meta.appendChild(badgeSpan);

    // 模型 ID 独立 chip（紧邻 type 角标）：仅当 entry 带 model 时渲染；中性配色区别于 type 语义色
    if (p.model) {
      const modelSpan = document.createElement('span');
      modelSpan.className = 'px-1 py-0.5 rounded text-[9px] font-bold shrink-0 bg-slate-800 text-slate-300 border border-slate-600/50 max-w-[120px] truncate';
      modelSpan.textContent = p.model;
      modelSpan.title = p.model; // 超长截断时悬停看全名
      meta.appendChild(modelSpan);
    }
    // 思考强度 / 权限档 chip（那一刻的档位）：只要 entry 带该字段就渲染，默认值（model-default/default）
    // 也照显——每条数据流记录都完整列出模型 + 强度 + 权限档。字段缺失（如 sys_info 不带这俩）仍跳过、不画空 chip。
    const metaChip = (val, cls, prefix) => {
      if (!val) return;
      const c = document.createElement('span');
      c.className = `px-1 py-0.5 rounded text-[9px] font-bold shrink-0 ${cls}`;
      c.textContent = prefix + val;
      meta.appendChild(c);
    };
    metaChip(p.effort, 'bg-indigo-950/60 text-indigo-300 border border-indigo-700/40', '🧠');
    metaChip(p.permissionMode, 'bg-amber-950/60 text-amber-300 border border-amber-700/40', '🔑');

    row.appendChild(meta);

    const textSpan = document.createElement('span');
    textSpan.className = `${layout.body} ${textClass}`;
    textSpan.textContent = (p.text || '').replace(/\\n/g, '\n');
    row.appendChild(textSpan);

    consoleLogArea.appendChild(row);
    consoleLogArea.scrollTop = consoleLogArea.scrollHeight;
  }

  let scrollPending = false;
  function scrollBottom(force) {
    if (scrollPending) return; // 已有 rAF 待执行，跳过布局读（一定会滚到底，无需再判断）
    const near = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 120;
    if (!(near || force)) return;
    scrollPending = true;
    requestAnimationFrame(() => { scrollPending = false; messagesEl.scrollTop = messagesEl.scrollHeight; });
  }

})();
