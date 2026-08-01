// app.js —— 契约客户端：agent:event 渲染 + 审批弹窗 + epoch 感知续传。
// 纯决策逻辑（effort 档位 / 状态聚合 / ANSI / esc）抽到 logic.js，浏览器 import + node:test 共用。
/* global io, marked, DOMPurify, hljs */
import { esc, formatToolSummary, formatToolCardTitle, formatTaskToolTitle, renderTaskToolResultText, shouldEmitModeChangeBar, resolveModelTileDisplay, resolveModelDisplayName, resolveGatewayModelName, resolveModelPillText, formatCachePercent, effortLevelSubtitle, shouldShowBusyWithMirror, pickBannerToShow, formatStreamPreviewIntervalMs, statusIconSpec, toolPreviewLabel, effortLevelsFor, modelLabelFor, effortUiState, resolvePanelState, aggregateStates, resolveDrawerStatus, summarizeOtherWorkspaces, projectDisplayName, shouldShowStartScreen, shouldShowComposer, shouldShowTopContextPill, resolveEmptySurface, wasViewingInstanceDestroyed, detectServerRestart, formatComposeDefaultsSummary, shouldRestoreOptimisticBusy, planSessionDraftSwap, foregroundReconnectAction, syncAckAction, shouldReloadOnEnter, shouldForceScrollAfterReplay, shouldStickScrollToBottom, resolveReplayBufferAction, sessionDomCachePlan, keyboardInsetPadding, logEntryVisibleForInstance, consoleLogEntryLayout, defaultModelTileLabel, withUltracodeTier, resolveDeepLinkTarget, armedTakeoverStep, presentTurnResult, formatServiceNotices, formatHooksBridgeRow, formatPushStatusRow, pushEnvHint, serviceStatusBasicRows, shouldSendOnEnter, whatNeedsAttention, userBubbleFold, mergeRecentSessionsAcrossWorkspaces, isSubagentPayload, isSpawnToolName, isFileMutationTool, accumulateTurnFileChange, summarizeTurnFileChanges, formatSubagentCardTitle, isToolSummaryTruncated, formatMirrorBannerText, formatMirrorComposerHint, shouldEmitThrottledHint, acceptMirrorState, shouldResetMirrorOnViewChange, resolveComposerPrimaryMode, shouldHideComposerSendButton, pillPermTone, shouldShowComposerDiscoverHint, formatLiveActivityText, INTERRUPT_PENDING_TIMEOUT_MS, shouldClearInterruptPendingOnSystem, systemBarClass, pickSpinnerVerb, formatCliSpinnerLine, formatCliRetryLine, advanceThinkingClock, resolveLiveWaitPhase, presentOnlineSendTransport, presentOfflineResendAck, shouldBusyAfterOfflineBatch, planOutboxEnqueue, parseDurableOutbox, dumpDurableOutbox, OUTBOX_STORAGE_KEY, OUTBOX_MAX_ITEMS, safeJsonPreview, shouldSeedBusyFromInstanceState, shouldReseedBusyAfterReload, shouldBindBusyFromBroadcast, shouldForceClearBusyFromBroadcast, buildClientErrorReport, clientErrorGateStep, formatLogsForCopy, isRestoredBoundary, guessImageMime, formatDiagLogEntry, filterConsoleEntries, nextHistoryRenderChunk, resolveUnreadAnchorIndex, shouldAckUnreadOnScroll, resolveForkAnchorUuid, detectAtMentionQuery, applyAtMentionPick, unifiedDiffLines, MAX_DIFF_LINES_FOR_LCS, formatStatuslineCollapsedSummary, formatStatuslineCopyText, formatStatuslineCtxLeft, formatWorkspaceChangeBadge, readPushPreviewPref, writePushPreviewPref, shouldRerenderSessionList, buildDirInstanceSignatures, diffDirSignatures, permissionModeTileSpecs, resolveComposerPlaceholder, resolveTurnEndScroll, resolveSendModel, applyGatewaySuffix } from './logic.js';
import { t, setLang, resolveInitialLang, readLangPref, writeLangPref, applyI18nToDocument } from './i18n.js';
import { createAppContext } from './app/context.js';
import { createClientLogger } from './app/client-log.js';
import { createAlertController } from './app/alerts.js';
import { createAttachmentController, createStoredPreviewLoader } from './app/attachments.js';
import { createRttMonitor } from './app/connection-sync.js';
import { createMessageRenderer } from './app/message-renderer.js';
import { createAgentEventDispatcher, createReplayBuffer } from './app/event-dispatch.js';
import { createFileBrowser } from './app/file-browser.js';
import { createGitChangesPanel, createWorkspacePanel, renderPatchLines } from './app/git-changes.js';
import { createSettingsController } from './app/settings.js';
import { createNotificationController } from './app/notifications.js';
import { createTaskStatusController } from './app/task-status.js';
import { createSessionWorkspaceState } from './app/session-workspaces.js';
import { createInteractionQueueState, createApprovalController } from './app/approval-questions.js';
import { createSheetController } from './app/sheets.js';
import { createDrawerController } from './app/drawer.js';
import { createSessionDeleteController } from './app/session-delete.js';
(() => {
  // ---- token 注入（4a：#token= → localStorage → 立即清地址栏）----
  const hashMatch = location.hash.match(/#token=(.+)/);
  if (hashMatch) {
    // 畸形转义序列（截断的分享链接等）会让 decodeURIComponent 抛 URIError；此处在全局错误监听器
    // 注册之前执行，不兜底会直接中止整个 IIFE，后面近全部初始化代码都不会跑（白屏）。
    try {
      localStorage.setItem('auth_token', decodeURIComponent(hashMatch[1]));
    } catch { /* 忽略，回退到已存的 auth_token（若有） */ }
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

  // ⑨ i18n：module script 已 defer 到 DOM 解析完成后执行，整棵静态外壳此刻已就位，且尚未渲染任何
  // 会话内容——applyI18nToDocument 整树扫文本节点+属性只会碰 index.html 自带的界面文案，不会误伤用户消息。
  // 静态壳靠整树扫描（免逐句标注、进词典即生效），app.js 运行时生成的模板则各自包 t()。
  setLang(resolveInitialLang(k => localStorage.getItem(k), navigator.language));
  applyI18nToDocument(document);

  // ---- DOM ----
  const $ = id => document.getElementById(id);
  const messagesEl = $('messages'), inputEl = $('input'), statusEl = $('statusLine'), connDot = $('connDot'), connRttEl = $('connRtt'), connDotWrap = $('connDotWrap');
  const btnSend = $('btnSend'), btnStop = $('btnStop'), btnNew = $('btnNew'), btnHome = $('btnHome'), btnSessions = $('btnSessions');
  const activityBanner = $('activityBanner'), activityBannerText = $('activityBannerText');
  // 流内 live 活动行（懒创建 #streamLiveStatus）；composer 顶条 #activeStatusPill 已移除
  const mirrorBanner = $('mirrorBanner'), btnMirrorOverride = $('btnMirrorOverride');
  const mirrorBannerText = $('mirrorBannerText'), mirrorBannerIcon = $('mirrorBannerIcon'), btnMirrorSync = $('btnMirrorSync');
  const taskProgressBanner = $('taskProgressBanner'), taskProgressText = $('taskProgressText'), btnTaskStop = $('btnTaskStop'), taskBannerToggle = $('taskBannerToggle');
  const unreadPillEl = $('unreadPill'), unreadPillCountEl = $('unreadPillCount'); // 未读角标悬浮胶囊
  const sessionPanel = $('sessionPanel');
  const sessionsDot = $('sessionsDot');  // 台阶2 Step B：后台目录动静汇总角标

  // ---- 极简触觉交互及抽屉式元素 DOM 绑定 ----
  const leftSidebar = $('leftSidebar'); // scrim/close 按钮已随 app/drawer.js 迁出
  const settingsScrim = $('settingsScrim'), settingsSheet = $('settingsSheet'), settingsSheetBody = $('settingsSheetBody'), settingsDragZone = $('settingsDragZone'), settingsClose = $('settingsClose');
  // 通用设置 sheet（本机偏好 + 主机与服务）：与会话设置同构、同一个控制器驱动，入口在侧栏底部
  const btnGeneralSettings = $('btnGeneralSettings'), generalScrim = $('generalScrim'), generalSheet = $('generalSheet'), generalSheetBody = $('generalSheetBody'), generalDragZone = $('generalDragZone');
  // 底栏会话档摘要 chip：一条连写「模型 · 权限 · 思考」。#pillSession 是设置里复制 session id 的胶囊，别撞。
  const pillDefaults = $('pillDefaults');
  const pillModelText = $('pillModelText'), pillPermText = $('pillPermText');
  const pillEffort = $('pillEffort'), pillEffortText = $('pillEffortText');
  // UX-009 已废弃：不再注入「终端驾驶中」合并胶囊；驾驶态靠 input placeholder + 发送位「续接」
  // （pillMirrorMerged 已从 DOM/CSS 移除）

  const topContextPill = $('topContextPill'), topTitleText = $('topTitleText'), topProjectText = $('topProjectText');
  const topContextChanges = $('topContextChanges'); // 未提交改动数角标（status_line.git 驱动）
  const customModelGrid = $('customModelGrid'), customPermGrid = $('customPermGrid'), customEffortGrid = $('customEffortGrid'), customEffortGroup = $('customEffortGroup');
  // 强度区块挂在模型下：归属标签 + 不支持时的就地说明（替代原先整块消失）
  const effortOwnerModel = $('effortOwnerModel'), effortOwnerWrap = $('effortOwnerWrap'), effortUnsupported = $('effortUnsupported');
  // 三块始终展开的设置分区 id 留在 HTML（#modelSection / #effortSection / #permSection）供滚动与 E2E，JS 不握引用。

  const modelInput = $('modelInput');   // 模型 select：候选由 models 事件填充；任意名走 /model 拦截动态插入
  const cliStatusEl = $('cliStatus');   // E16：web 状态栏容器（status_line 事件填充，原生 DOM 结构化渲染非 ANSI）
  const cliStatusWrapEl = $('cliStatusWrap'); // E16：状态栏折叠包裹（<details>，揭示=去 hidden）
  const cliSummaryEl = $('cliSummary'); // E16：折叠条摘要 git · ctx（formatStatuslineCollapsedSummary）
  const cliStatusCopyBtn = $('cliStatusCopy'); // 点按复制（不触发展开）
  let lastStatusLinePayload = null; // 最近一次 status_line，供复制
  if (cliStatusCopyBtn) {
    // mousedown 也拦截：部分浏览器在 summary 内点按钮会先 toggle details
    cliStatusCopyBtn.addEventListener('click', async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const text = formatStatuslineCopyText(lastStatusLinePayload)
        || (cliSummaryEl?.textContent || '').trim();
      if (!text || text === 'statusline') {
        addBar(t('暂无状态可复制'), 'text-ink-faint');
        return;
      }
      try {
        if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
        else {
          const ta = document.createElement('textarea');
          ta.value = text;
          ta.style.position = 'fixed';
          ta.style.left = '-9999px';
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          ta.remove();
        }
        addBar(t('已复制状态摘要'), 'text-success');
      } catch {
        addBar(t('复制失败'), 'text-danger');
      }
    });
  }
  const permModeSelect = $('permModeSelect');  // 权限档切换器：选项/磁贴由 rebuildPermissionModeUi 按 SDK PermissionMode 填充
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
        <div class="model-tile p-2 rounded-xl border border-line bg-surface active:bg-sunk cursor-pointer transition-all">
          <div class="text-xs font-semibold truncate text-ink"></div>
          <div class="text-[9.5px] text-ink-soft truncate mt-0.5"></div>
        </div>
      `);
      card.dataset.model = value;                 // 属性走 dataset，不进 HTML 串
      const [nameDiv, noteDiv] = card.children;   // 两个内层 div，textContent 赋值（自动转义）
      nameDiv.textContent = value;
      noteDiv.textContent = note || t('当前加载模型');
      card.onclick = () => {
        if (mirrorReadonlySid) { addBar(t('终端驾驶中，设置已冻结——接管后可调'), 'text-info'); return; } // 单驾驶员：驾驶期设置冻结
        haptic('tap');
        modelInput.value = value;
        delete modelInput.dataset.fullModel; // 发送时 dataset.fullModel 优先级高于 value，选中此卡须清掉旧的（同 rebuildCustomModelGrid）
        syncModelUI(value);
      };
      customModelGrid.appendChild(card);
    }
  }
  // 两个弹窗容器留在 app.js：通用 sheet 开关与视图切换仍要用；其余 perm*/question* DOM 引用
  // 连同 selectedExitMode / multiSelectedIndexes 等状态已归 app/approval-questions.js 所有。
  const permModal = $('permModal'), questionModal = $('questionModal');
  // 两级删除会话与通用确认弹窗的 DOM 引用已随各自模块迁出（app/session-delete.js、app/sheets.js）。
  const authGate = $('authGate'), authToken = $('authToken'), authSubmit = $('authSubmit'), authError = $('authError'); // 访问令牌输入页
  const accessRelogin = $('accessRelogin'), accessReloginBtn = $('accessReloginBtn'); // Access 会话过期重登浮层
  // 远程设备审批 + 访问帮助 UI
  const deviceRequests = $('deviceRequests'); // 已信任设备上的待审批请求卡片栈
  const deviceDenied = $('deviceDenied'), deviceDeniedRetry = $('deviceDeniedRetry'), deviceDeniedHelp = $('deviceDeniedHelp');
  const accessHelp = $('accessHelp'), accessHelpClose = $('accessHelpClose'), accessHelpOpen = $('accessHelpOpen'), authHelpLink = $('authHelpLink');
  const btnConsole = $('btnConsole'), consoleModal = $('consoleModal'),
        consoleClose = $('consoleClose'), consoleClear = $('consoleClear'),
        consoleLogArea = $('consoleLogArea');
  const consoleFilterButtons = [$('consoleFilterAll'), $('consoleFilterInteraction'), $('consoleFilterDiag')].filter(Boolean);
  // 工作区面板外壳（文件 / 改动两 tab 同壳）
  const workspaceModal = $('workspaceModal'), workspaceClose = $('workspaceClose'),
        workspaceTabFiles = $('workspaceTabFiles'), workspaceTabChanges = $('workspaceTabChanges');
  // 项目文件只读浏览（FR-07）——文件 tab
  const fileBrowseTools = $('fileBrowseTools'), fileBrowseBack = $('fileBrowseBack'),
        fileBrowsePath = $('fileBrowsePath'),
        fileBrowseBody = $('fileBrowseBody'), fileBrowseEdit = $('fileBrowseEdit'),
        fileBrowseSave = $('fileBrowseSave'), fileBrowseCancelEdit = $('fileBrowseCancelEdit'),
        fileBrowseSaveError = $('fileBrowseSaveError');
  // git 变更（只读）——改动 tab
  const gitChangesTools = $('gitChangesTools'), gitChangesBranch = $('gitChangesBranch'),
        gitChangesRefresh = $('gitChangesRefresh'), gitChangesBody = $('gitChangesBody');

  // ---- 状态 ----
  let currentSessionId = localStorage.getItem('current_session') || null;
  // per-session 未发送草稿 {text, attachments}（切会话存/切回恢复；同会话静默换实例不读写，见 planSessionDraftSwap）。
  // 仅内存、不落盘——刷新页面后丢失可接受（与 sessionDomCache 同寿）。
  // per-session「上次为该会话渲染到的磁盘 history 条数」（history 口径，非活缓冲 seq）。切入时与 server 报的
  // diskLen 比对，判「离开期间被终端外部写过」→ 清屏重载（见 shouldReloadOnEnter）。独立于 sessionDomCache：
  // 后者只在切走时 set 一次（DOM 快照），这里要在每次 loadHistory/onHistoryAppend 渲染后累积。
  // 这些状态会被早期 socket/DOM 回调触达，必须先于回调注册声明，避免首连事件抢跑触发 TDZ。
  let _busyState = false;
  // instanceId → { timer }：按实例隔离挂起态（曾是裸全局布尔——跨实例的 shouldDropAgentEvent 视图过滤会把
  // A 会话「停止」的结算事件在切到 B 后丢弃，全局标志卡 true 会连带堵死 B 会话本该独立生效的停止按钮）。
  // 安全超时：限流重试中 interrupt 可能挂起，超时清位防「正在停止…」永挂。
  const interruptPendingByInstance = new Map();
  // 当前查看实例有在途轮（服务端 pendingTurns>0）→ 发不出新消息（排队已于 2026-07-30 移除）。
  // 由 setInstances 按广播的 turnRunning 字段驱动 + 发送 ack 成功后本地乐观置位（关掉广播未到的窄窗）。
  // 与 _busyState 分开：后者含后台任务/待审批，而发送闸只认在途轮——挂着后台任务时仍可发送。
  let _turnRunning = false;
  // 只挡"这条消息还没被服务端 ack"的窗口（挡瞬时双击/触屏合成双 click）。与 _turnRunning 分工：
  // 那道闸认服务端权威状态，这道闸认本端在途请求，覆盖 ack 尚未回来的那几十毫秒。
  // SEND_ACK_FALLBACK_MS 只是兜底：ack 真丢了也不永久卡死发送按钮。
  const SEND_ACK_FALLBACK_MS = 5000;
  // 按会话隔离在途态（曾是裸全局布尔——同 _pendingSendBusySessionId 修过的同类问题，这个姐妹变量当时漏改）：
  // A 会话 ack 等待窗口内不该阻塞切到 B 会话后的发送按钮。存的是"哪些会话当前有条消息在等 ack"。
  const _sendInFlightSessionIds = new Set();
  let _pendingFirstSend = false; // 新会话首发乐观 busy 需跨越懒开后的 bindView→clearView(setBusy(false))；见 send()/setInstances
  // 全新会话首轮点停止后不跳回主页：标记"当前这个 instanceId 是已发过消息、sessionId 仍未到、且刚被
  // 用户中断"的实例——置位见 system(p) 的 interrupted 分支；清除时机须覆盖全（否则悬留会把其它正常
  // 场景误判成该显示中断态）：① bindView 里视图切走或该实例已拿到 sessionId ② FE-001 同实例后续补上
  // sessionId ③ 回主页/新建会话（btnHome/btnNew/目录行 ＋） ④ 该实例从 instances 列表消失。
  // 只存一个 instanceId（非 Set/Map）：同一时刻只可能有"当前正在看的这一个"处于这个待续档态，
  // 与 _pendingFirstSend/_pendingSendBusySessionId 这类单值跟踪器同款风格。
  let freshInterruptedInstanceId = null;
  // 点停止顿一下跳主页（回归修复）：抽屉「关闭」/侧滑 ✕ 关闭的是当前正在查看的会话时记下其 instanceId，
  // 供下一次 setInstances 广播里 wasViewingInstanceDestroyed 排除——用户显式关闭自己正在看的唯一会话
  // 与"被摧毁"广播形态完全相同（服务端都是 viewingInstanceId 变 null + 该实例从列表消失），但这是用户
  // 自己确认过的操作，不该弹"会话已中断"。一次性：在 setInstances 里消费后立即清空。
  let explicitCloseInstanceId = null;
  // server 重启检测基线：上一条 instances 广播携带的 service.startedAt（进程级常量，重启必变）。
  // 整机重启后重连的首条广播形态（实例从列表消失 + viewing 变 null）与「实例被单独摧毁」完全同构，
  // wasViewingInstanceDestroyed 无法自辨——靠 startedAt 变化区分（见 setInstances 的 detectServerRestart），
  // 否则每次重启都误弹「停止操作未能正常结束」。广播缺 service 字段（旧服务端/mock 手工 payload）时
  // 保持旧基线不清空，缺字段不能当"变了"。
  let lastServiceStartedAt = null;
  // 空首页枢纽默认隐藏底部输入条；仅点 ＋ / session:new 进入 compose 就绪，或进入真实会话后显示。
  // 防「未选项目就直接发消息」歧义（懒开 FRESH 路径仍保留，但入口收窄为显式 ＋）。
  let _composeReady = false;
  // 在线发送后到 result/error/负 ack 前：同会话静默换实例（externalDirty/effort dispose+resume）也要补 busy。
  // 记的是"这条乐观 busy 属于哪个 session"（而非裸 boolean）：若发送方会话被用户甩开、从未等到
  // result/error 就切走，标志不能被之后完全无关的另一个会话自己的同会话换实例误捡（见 shouldRestoreOptimisticBusy）。
  let _pendingSendBusySessionId = null;
  // mirrorReadonlySid=当前只读会话（null=可编辑）；mirrorOverriddenSid=用户已显式接管、忽略其只读；
  // armedTakeoverSid=已排队接管、等终端本轮完结/疑似中断再自动放行（见 logic.js armedTakeoverStep）；
  // mirrorStaleFlag=当前只读会话是否处于疑似中断态（供点击「续接 CLI 会话」时判定走排队还是即时确认）。
  let mirrorReadonlySid = null, mirrorOverriddenSid = null, armedTakeoverSid = null, mirrorStaleFlag = false;
  // server 侧 cliPresenceStep 的 seen 槽：本次观察期是否见过 entrypoint=cli 的活注册表条目。
  // 决定 stale 该说「终端疑似中断」还是只说只读——没见过终端就别把推断说成事实（原先两个调用点
  // 硬编码 isWebInitiated:true，等于恒不说，「疑似中断」文案在 composer 上完全不可达）。
  let mirrorCliSeenFlag = false;
  // mirrorAutonomousFlag=当前只读锁能否确定是本会话自己被 ScheduleWakeup/CronCreate 定时唤起（server
  // 端 classifyTranscriptTail 查到 harness marker），而非真不知道来源的「大概率终端」——只影响横幅措辞，
  // 不影响是否只读（见 logic.js formatMirrorBannerText/formatMirrorComposerHint 的 autonomous 参数）。
  let mirrorAutonomousFlag = false;
  let mirrorObservedCli = { model: null, permissionMode: null, effort: null };
  let mirrorWebPanelSnapshot = null; // CLI 观察态只负责展示；接管时恢复进入镜像前的 Web 选择，绝不写回实例偏好
  // 点输入区/附件/禁发钮时的说明节流（同文案 2.5s 内不刷屏；换 armed/stale 文案立即放行）
  let _mirrorComposerHintLast = { text: '', at: 0 };
  const MIRROR_COMPOSER_HINT_THROTTLE_MS = 2500;

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
  // 回放缓冲（P0-REPLAY-BUFFER）flush 收尾时置位：期间 scrollBottom() 直接返回，抑制缓冲事件逐条
  // 派发时各自触发的滚动；flushQueue 派发完毕后复位并显式调一次 scrollBottom(true) 落底。
  // 见 createReplayBuffer（app/event-dispatch.js）withScrollSuppressed 依赖注入点。
  let _suppressScrollBottom = false;
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

  function syncModelUI(model, displayOverride) {
    // 底栏模型 chip：原样显示当前 model（+ 网关后缀）；未选时用 CLI default 的 displayName 或 cwd 默认裸名。
    const cliDefault = (modelsList || []).find(m => (typeof m === 'string' ? m : m?.value) === 'default');
    const cliDefaultLabel = cliDefault && typeof cliDefault === 'object'
      ? (cliDefault.displayName || 'Default (recommended)')
      : null;
    const modelPillText = displayOverride || resolveModelPillText({
      model,
      gatewaySuffix: currentGatewaySuffix,
      modelsList,
      cwdDefaultModel,
      cliDefaultLabel,
    });
    if (pillModelText) pillModelText.textContent = modelPillText;
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
    // compose 页默认档摘要与底栏同源；模型段变了就地刷 title
    syncDefaultsPillTitle();
    if (_composeReady) refreshComposeDefaultsSummary();
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

    // 条数 = SDK 列表；标题 = 真实 wire id（resolvedModel），value 仍用 SDK 档位 id
    const tiles = resolveModelTileDisplay(list);
    const wireOf = (v) => {
      if (!v || v === 'default') return v || '';
      return resolveGatewayModelName(v, list) || String(v);
    };
    tiles.forEach(({ value: val, title, subtitle }) => {
      const display = title;
      const active = val === selectedVal
        || (!!currentModel && val === currentModel)
        || (!!currentModel && wireOf(currentModel) && wireOf(currentModel) === wireOf(val))
        || (!!selectedVal && selectedVal !== 'default' && wireOf(selectedVal) === wireOf(val))
        || (!currentModel && val === 'default' && (selectedVal === 'default' || !selectedVal));
      const using = active ? t(' · 使用中') : '';
      const card = el(`
        <div data-model="${esc(val)}" class="model-tile p-2 rounded-xl border border-line bg-surface active:bg-sunk cursor-pointer transition-all ${active ? 'ring-1 ring-accent border-accent text-accent bg-accent-wash/30' : ''}">
          <div class="text-xs font-semibold truncate ${active ? 'text-accent' : 'text-ink'}">${esc(display)}${using ? `<span class="text-[11px] font-normal opacity-80">${esc(using)}</span>` : ''}</div>
          <div class="text-xs text-ink-soft truncate mt-0.5">${esc(subtitle || val)}</div>
        </div>
      `);
      card.onclick = () => {
        if (mirrorReadonlySid) { addBar(t('终端驾驶中，设置已冻结——接管后可调'), 'text-info'); return; }
        haptic('tap');
        // value 保持 SDK 条目 id；发送时 resolveSendModel 再 pin wire
        modelInput.value = val === 'default' ? '' : val;
        delete modelInput.dataset.fullModel;
        if (val !== 'default') ensureModelOption(val);
        syncModelUI(val === 'default' ? '' : val);
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
  // 本轮主会话文件变更账本（Edit/Write/…）；result 时汇总成卡后清空。子 agent 内改动不入（嵌在子卡里）。
  let turnFileChanges = new Map();
  const agentToolIds = new Set(); // 跟踪 Agent/Task 工具的 toolUseId，用于在 tool_result 时隐藏活动横幅
  // 子 agent 可折叠卡：parentToolUseId → { el, body, titleEl, type, running, streams, thinkings }
  // 键 = 主会话 Agent/Task 的 toolUseId（后端 parent_tool_use_id）。默认 <details> 收起。
  const subagentCards = new Map();
  // renderHistoryBubbles 的 tool_use↔tool_result 配对表：必须持久化跨调用（而非函数内局部变量），因为只读
  // 镜像追平场景下 catchUpTick 每次只带增量消息——耗时较长的工具 tool_use 落在第 N 个 tick、tool_result
  // 落在第 N+1 个 tick 才到，若每次调用都用全新空 Map，跨 tick 到达的 tool_result 永远配对失败（走孤儿分支，
  // 原卡片永久卡在"进行中"）。clearView / onHistoryAppend 的整窗替换分支会显式 clear，代表真正的"从头渲染"。
  const histToolCards = new Map(); // toolUseId → card
  const histSubCards = new Map(); // parentToolUseId → { el, body, titleEl }
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
  // latestServiceHealth = 最近一次 instances 广播里的 service 字段。
  let latestServiceHealth = null;
  let expandedDirs = new Set();         // 工作区面板中展开的目录（初始空，首 instances 事件填充；切 cwd 重置）
  // 用户点过「显示全部会话…」的目录。缓存里的 sessions 是"当下拿到的那一份"，记不住用户要看全量这个
  // 意图——而 populateSubtree 每次都会无条件 revalidate，不带上 all 就会把展开态悄悄打回截断（P0-11x）。
  const expandedAllDirs = new Set();
  // session:list 附带的 CLI registry 快照：每个 cwd 是否至少有一条 terminal=busy。与 Web workdirStates
  // 独立保存并在抽屉显示层合并，避免 live idle/done 遮住终端运行态。
  const terminalBusyByDir = new Map();
  const SESSION_PANEL_REVALIDATE_MS = 12_000;
  let sessionPanelRevalidateTimer = null;
  // P3：面板"结构性"指纹（dirs 集合 + viewingInstanceId）；只有这两者变化才全量重建整个面板
  // （低频、全量更简单可靠）。纯状态变化、或只是某个目录下实例变化，都不再经它判定——见下方按目录分键。
  let _lastPanelStructKey = null;
  // P3：按目录分键的实例签名（cwd → 签名片段，见 logic.js buildDirInstanceSignatures）+ diff 出的
  // "签名变了的目录"只重建那几个目录的 DOM 子树，其余目录保持原样（不撤离滚动位置/侧滑态等本地态）。
  let _lastDirSignatures = {};
  // dirRow/subtree 节点引用表（cwd → {dirRow, subtree}），供 rebuildDirSections 定位要替换的旧节点；
  // 每次 openSessionPanel() 全量重建时重新填充。
  let dirSectionNodes = new Map();
  // 发送 outbox（在线 timeout/retryable + 离线共用）：内存队列 + localStorage 耐久。
  // bubbleEl 仅内存；落盘只写可序列化字段（见 dumpDurableOutbox）。PWA 杀进程后靠 clientMessageId 恢复重试。
  let offlineQueue = [];
  try {
    offlineQueue = parseDurableOutbox(localStorage.getItem(OUTBOX_STORAGE_KEY));
  } catch { offlineQueue = []; }
  function persistOutbox() {
    try { localStorage.setItem(OUTBOX_STORAGE_KEY, dumpDurableOutbox(offlineQueue)); } catch { /* quota */ }
  }
  function enqueueOutbox(item) {
    const { queue, dropped } = planOutboxEnqueue(offlineQueue, item, { maxItems: OUTBOX_MAX_ITEMS });
    offlineQueue = queue;
    persistOutbox();
    if (dropped.length) {
      logClientEvent('send', `[WEB_SEND] outbox 超上限丢弃 ${dropped.length} 条最旧消息`);
    }
    return offlineQueue;
  }
  window.addEventListener('pagehide', () => { try { persistOutbox(); } catch { /* noop */ } });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      try { persistOutbox(); } catch { /* noop */ }
    }
  });

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
      workspaceModal,
      workspaceClose,
      workspaceTabFiles,
      workspaceTabChanges,
      fileBrowseTools,
      fileBrowseBack,
      fileBrowsePath,
      fileBrowseBody,
      fileBrowseEdit,
      fileBrowseSave,
      fileBrowseCancelEdit,
      fileBrowseSaveError,
      gitChangesTools,
      gitChangesBranch,
      gitChangesRefresh,
      gitChangesBody,
      settingsScrim,
      settingsSheet,
      settingsSheetBody,
      settingsDragZone,
      settingsClose,
      btnGeneralSettings,
      generalScrim,
      generalSheet,
      generalSheetBody,
      generalDragZone,
      prefAlertSound: $('prefAlertSound'),
      prefAlertVibrate: $('prefAlertVibrate'),
      prefAlertForeground: $('prefAlertFgComplete'),
      btnAlertPreview: $('btnAlertPreview'),
      prefPushPreview: $('prefPushPreview'),
      prefLang: $('prefLang'),
      btnPush,
      activityBanner,
      activityBannerText,
      taskProgressBanner,
      taskProgressText,
      btnTaskStop,
      taskBannerToggle,
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
  const clientLogger = createClientLogger(appContext, {
    storage: (typeof localStorage !== 'undefined' ? localStorage : null), // 抗 PWA 被杀：落盘+重开恢复
    onEntry(entry) {
      if (consoleModal?.classList.contains('sheet-open')) appendLogEntry(entry);
    },
  });
  const logClientEvent = clientLogger.log;
  // 切后台/被 iOS 杀前把节流窗口内未落盘的日志尾巴强制写入。pagehide 在移动端比 unload 可靠；
  // visibilitychange→hidden 覆盖「切走但未卸载」。flush 幂等（force write）、双挂无害。
  // 同时上报 presence（PWA 后台推送修复）：服务端据此判定 approved 房间里是否还有"前台"连接，解锁
  // result 完成通知——否则 PWA 切后台后 socket 常常还没断（要等 OS 冻结页面才真正断连），会被误判为
  // "有人在看"而永久吞掉完成通知。fire-and-forget，无需 ack。
  window.addEventListener('pagehide', () => {
    clientLogger.flush();
    socket.emit('client:presence', { hidden: true }); // 页面即将冻结前兜底再同步一次，双保险
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') clientLogger.flush();
    socket.emit('client:presence', { hidden: document.hidden });
  });
  const alerts = createAlertController(appContext);
  const haptic = alerts.haptic;
  // 补发批次（sync:since 一次性追平离开期间积压的多轮 result/error）静音：isReplayBatch 由
  // dispatchAgentEvent 在 handler 调用期间置位，未读角标本身就是提示，不需要连续响铃。
  const alertCue = (kind) => { if (!appContext.state.isReplayBatch) alerts.cue(kind); };
  const ensureAlertAudio = alerts.ensureAudio;
  const messageRenderer = createMessageRenderer(appContext, { scrollBottom: () => scrollBottom() });
  const render = messageRenderer.renderMarkdown;
  const el = messageRenderer.createElement;
  // sheet 开合原语 + 通用确认弹窗。接线必须早于审批模块（那边以值的形式接收 openSheet/closeSheet），
  // 故落在 haptic/el 就绪之后的最早位置。两个「等你答复」型弹窗以取值函数注入，模块本身不认识它们。
  const sheets = createSheetController(appContext, {
    $, haptic,
    blockingSheets: () => [permModal, questionModal],
    onClosed: (elm) => {
      // UX-003：关闭审批弹窗时清防误触 arming（计时器归审批模块所有）。
      if (elm === permModal) {
        elm.classList.remove('sheet-arming');
        appContext.state.approvals?.cancelPermArming();
      }
    },
  });
  const { openSheet, closeSheet, appConfirm } = sheets;
  const setStatus = messageRenderer.setStatus;
  const leaveStartScreen = () => {
    messageRenderer.leaveStartScreen();
    messagesEl?.querySelectorAll('.empty-session-guide').forEach(n => n.remove());
  };
  // 流内 live 活动行：ephemeral，busy 时挂在 #messages 末尾；不进 disk/history；sessionDomCache 前 strip。
  let streamLiveStatusEl = null;
  function ensureStreamLiveStatus() {
    if (streamLiveStatusEl && streamLiveStatusEl.isConnected) return streamLiveStatusEl;
    streamLiveStatusEl = el(`
      <div id="streamLiveStatus" class="stream-live-status msg-frame flex items-center justify-center px-3 py-1.5 text-xs" data-ephemeral="1" aria-live="polite" aria-busy="true">
        <span id="streamLiveStatusText" class="font-medium truncate max-w-full"></span>
      </div>`);
    return streamLiveStatusEl;
  }
  function setStreamLiveStatusText(text) {
    // busy 期间保证挂在 #messages 末尾（仅 ensure 不 append 会留下断链节点）
    if (_busyState) {
      showStreamLiveStatus(text);
      return;
    }
    if (!streamLiveStatusEl?.isConnected) return;
    const textEl = streamLiveStatusEl.querySelector('#streamLiveStatusText');
    if (textEl) textEl.textContent = text || formatLiveActivityText('default');
  }
  function showStreamLiveStatus(text) {
    if (!messagesEl) return;
    leaveStartScreen();
    const row = ensureStreamLiveStatus();
    const textEl = row.querySelector('#streamLiveStatusText');
    if (textEl) textEl.textContent = text || formatLiveActivityText('default');
    if (row.parentNode !== messagesEl) messagesEl.appendChild(row);
    else if (messagesEl.lastChild !== row) messagesEl.appendChild(row);
    scrollBottom();
  }
  function pinStreamLiveStatus() {
    if (!streamLiveStatusEl || !messagesEl || !streamLiveStatusEl.isConnected) return;
    if (messagesEl.lastChild !== streamLiveStatusEl) messagesEl.appendChild(streamLiveStatusEl);
  }
  function hideStreamLiveStatus() {
    if (streamLiveStatusEl?.parentNode) streamLiveStatusEl.parentNode.removeChild(streamLiveStatusEl);
    streamLiveStatusEl = null;
  }
  // CLI 式动态状态行（终端等价）：✻ Stewing… (55s · ↓ 3.3k tokens · thought for 1s)。
  // 每 turn setBusy(false→true) 时选一次动词并起 1s 秒表；token/秒表权威值来自 status_line.turn
  // （无该数据时退化为本地 Date.now() 从 0 计 + 省略 token 段）；文案组装在 logic.js 纯函数。
  // lastEventAt / sawContentDelta：等待可观测性——距上次事件多久、是否已见 content delta。
  let liveLine = null;   // { verb, turnStartTs, serverTurnStartedAt, outTokens, thinking, override, lastEventAt, sawContentDelta }
  let liveTicker = null;
  function renderLiveLineText() {
    if (!liveLine) return formatLiveActivityText('default');
    if (liveLine.override) return liveLine.override;
    // API 重试期间整行顶替 spinner（对齐 CLI 的 retryStatus ? 重试行 : spinner 行 二选一）。
    // 排在 override 之后：用户点了「停止」时「正在停止…」优先，重试信息已无意义。
    if (liveLine.retry) {
      const { deadline } = liveLine.retry;
      return formatCliRetryLine({
        ...liveLine.retry,
        remainingSec: deadline ? Math.max(0, Math.ceil((deadline - Date.now()) / 1000)) : null,
      });
    }
    // 发送 ack 前的短暂阶段：独立文案，不走 spinner
    const phase = resolveLiveWaitPhase({ sendInFlight: _sendInFlightSessionIds.has(displayedSessionId), sawContentDelta: liveLine.sawContentDelta });
    if (phase === 'sending') return formatLiveActivityText('sending');
    const base = liveLine.serverTurnStartedAt || liveLine.turnStartTs;
    const sinceLastEventSec = Math.max(0, Math.floor((Date.now() - (liveLine.lastEventAt || base)) / 1000));
    return formatCliSpinnerLine({
      verb: liveLine.verb,
      elapsedSec: Math.max(0, Math.floor((Date.now() - base) / 1000)),
      outTokens: liveLine.outTokens,
      thinking: liveLine.thinking,
      effort: currentEffort,
      // 断线时不追加「网络问题」提示——顶部已有「连接断开，自动重连中…」，避免重复冲突
      sinceLastEventSec: socket.connected ? sinceLastEventSec : null,
    });
  }
  // 已挂载时只直写文本节点（不 append/不 scrollBottom——status_line 300ms 一发，走 show 路径会把
  // 上翻阅读的用户反复拽底）；未挂载且忙碌才走 showStreamLiveStatus 完成挂载+置底。
  function renderLiveLine() {
    if (streamLiveStatusEl?.isConnected) {
      const textEl = streamLiveStatusEl.querySelector('#streamLiveStatusText');
      if (textEl) { textEl.textContent = renderLiveLineText(); return; }
    }
    if (_busyState) showStreamLiveStatus(renderLiveLineText());
  }
  // 重试已过、流恢复 → 撤掉重试行，回落普通 spinner。由 text_delta/thinking_delta/tool_use 三处驱动
  // （任一到达都说明这一轮的 API 请求真的通了）；setBusy(false) 会整清 liveLine，无需在此重复。
  function clearLiveRetry() {
    if (!liveLine?.retry) return;
    liveLine.retry = null;
    renderLiveLine();
  }
  function startLiveTicker() {
    if (liveTicker) return;
    liveTicker = setInterval(() => { if (liveLine) renderLiveLine(); }, 1000);
  }
  function stopLiveTicker() {
    if (liveTicker) { clearInterval(liveTicker); liveTicker = null; }
  }
  function stripEphemeralMessageNodes(nodes) {
    return nodes.filter(n => !(n?.nodeType === 1 && n.getAttribute?.('data-ephemeral') === '1'));
  }
  // 流内 live 行须始终在 #messages 末尾；append 后 pin，避免工具卡/思考卡插到它下面。
  const appendMessage = (node) => {
    const result = messageRenderer.appendMessage(node);
    pinStreamLiveStatus();
    return result;
  };
  // addBar 内部走 messageRenderer 自己的 append，须再 pin 一次
  const addBar = (text, className) => {
    const bar = messageRenderer.addBar(text, className);
    pinStreamLiveStatus();
    return bar;
  };
  // UI-007：工具卡/角标状态标 — 可信 SVG + aria-label（currentColor 吃语义色）
  function setStatusIcon(el, kind) {
    if (!el) return;
    const { html, label } = statusIconSpec(kind);
    el.classList.add('status-icon', 't-status');
    el.setAttribute('aria-label', label);
    el.innerHTML = html;
  }

  // UX-019：档位变更反馈——空态不打系统条，改胶囊短暂高亮；有消息后仍可留痕。
  // 审批留痕（已允许/已拒绝）必须直接走 addBar，不经此闸。
  let pillFlashTimer = null;
  function flashStatusPills() {
    // 底栏只剩一条摘要 chip；空态档位变更靠它闪一下反馈
    const pills = [pillDefaults].filter(p => p && !p.classList.contains('hidden'));
    for (const p of pills) {
      p.classList.remove('status-pill-flash');
      void p.offsetWidth;
      p.classList.add('status-pill-flash');
    }
    if (pillFlashTimer) clearTimeout(pillFlashTimer);
    pillFlashTimer = setTimeout(() => {
      for (const p of pills) p.classList.remove('status-pill-flash');
      pillFlashTimer = null;
    }, 800);
  }
  function addModeBar(text, className) {
    const emptyStart = Boolean(messagesEl?.classList.contains('empty-start'));
    if (!shouldEmitModeChangeBar({ emptyStart })) {
      flashStatusPills();
      return null;
    }
    return addBar(text, className);
  }
  // 通用设置打开后可选滚到指定 id（推送铃铛）；须在 notifications 之前声明，bellAction 闭包写入
  let generalScrollToId = null;
  let general = null; // 后段 createSettingsController 赋值；bellAction 点击时再 open
  const notifications = createNotificationController(appContext, {
    addBar,
    getToken: () => token,
    getDeviceToken: () => deviceToken,
    // 铃铛只当「未订阅」的可见信号，不自己解释——把人带到通用设置的推送段，
    // 那里的 #pushStatusRow 才说得全（当前状态 + 为什么 + 下一步点哪）。两套解释各说各话
    // 是这块历史上真出过问题的地方。general 在文件后段才定义，靠闭包延迟到点击时求值。
    // 铃铛住在侧栏底部固定条：先收侧栏再弹 sheet（两者同 z-40，同 btnGeneralSettings 的顺序约束）。
    bellAction: () => {
      closeLeftSidebar();
      // open() 会把 body scrollTop 置 0；用 pending 标记在 onOpen 后 rAF 再滚到推送段
      generalScrollToId = 'pushStatusRow';
      general?.open();
    },
  });
  // 与 alertCue 对称：sync:since 补发期间静音 OS 通知，避免前台完成通知连弹（result / task_notification）
  const notify = (title, body, opts) => {
    if (appContext.state.isReplayBatch) return false;
    return notifications.notify(title, body, opts);
  };
  const setupPush = notifications.setup;
  const taskStatus = createTaskStatusController(appContext, {
    addBar,
    alertCue,
    alerts,
    createElement: el,
    haptic,
    notify,
  });
  let showActivityBanner = taskStatus.showActivity;
  let hideActivityBanner = taskStatus.hideActivity;
  let onTaskProgress = taskStatus.onProgress;
  let hideTaskProgress = taskStatus.hideProgress;
  const onTaskNotification = taskStatus.onComplete;

  // ---- socket ----
  const socket = appContext.setSocket(io({
    auth: { token, deviceToken },
    // 移动端常切后台/息屏，断开后想尽快回来：调小重连退避（默认 1000/5000ms 太久）
    reconnectionDelay: 500,
    reconnectionDelayMax: 2000,
  }));

  // 全局 JS 错误上报：手机浏览器无 devtools，运行期错误进本地日志抽屉（client_error）
  // 并经 logs:clientError 落服务端日志。只覆盖启动成功之后的错误——更早的解析/启动
  // 失败连本上报器都不存在。去重+限流（clientErrorGateStep）防错误风暴；上报路径自身
  // 抛错会再触发 error 监听，除 try 兜底外同签名也会被门直接吸收，不会递归放大。
  let clientErrorGate = null;
  const reportClientError = (kind, info) => {
    try {
      const { payload, signature } = buildClientErrorReport(kind, info);
      const step = clientErrorGateStep(clientErrorGate, signature, Date.now());
      clientErrorGate = step.state;
      if (!step.send) return;
      // 本地抽屉条目附 stack 前 3 帧（此前 stack 只上服务端）——手机端无 devtools，本地就能看到出错位置。
      const stackTail = payload.stack ? ` | ${payload.stack.split('\n').slice(0, 3).map(s => s.trim()).join(' ⏎ ')}` : '';
      logClientEvent('error', `[JS_ERROR] ${payload.message}${payload.source ? ` @${payload.source}:${payload.line ?? '?'}` : ''}${stackTail}`);
      if (socket.connected) socket.emit('logs:clientError', payload);
    } catch { /* 上报器绝不能自己再抛 */ }
  };
  window.addEventListener('error', e => reportClientError('error', {
    message: e.message, source: e.filename, line: e.lineno, col: e.colno, stack: e.error?.stack,
  }));
  window.addEventListener('unhandledrejection', e => reportClientError('unhandledrejection', { reason: e.reason }));

  let initialLoad = true;
  let connectErrorCount = 0;  // 公网 socket 连续失败计数，攒够再探测 Access 是否过期
  
  const OFFLINE_RESEND_ACK_MS = 8000; // 慢移动网络 RTT 留余地（同 cf-access 2s→8s 超时教训，见项目 memory）
  // FE-NEW-001/006：串行重发 + 按 viewing 作用域决定 busy（永久失败/他会话成功不再 sticky busy）。
  // 在线路径有 _sendInFlightSessionIds；离线旧实现 for 循环并行 emit 易撞在途轮闸，且 setBusy(true) 无配对 clear。
  let _offlineDrainInFlight = false;
  // 单条投递：批量重发与「重发」按钮共用，避免两份 emit 参数各自漂移。
  function deliverOutboxItem(item) {
    return new Promise((resolve) => {
      socket.timeout(OFFLINE_RESEND_ACK_MS).emit('user:message', {
        text: item.text,
        model: item.model,
        attachments: item.attachments,
        instanceId: item.instanceId,
        cwd: item.cwd,
        clientMessageId: item.clientMessageId,
      }, (err, ack) => resolve(presentOfflineResendAck(err, ack)));
    });
  }

  // 撞上在途轮（排队已移除）：不再 requeue 空转，落「未发送」终态 + 一个手动「重发」按钮。
  // 同一 clientMessageId 可直接复用——服务端在 busy 拒绝路径上没有 commit 去重 ID。
  function markOutboxBlocked(item, message) {
    const indicator = item.bubbleEl?.querySelector('.pending-indicator');
    if (!indicator) return;
    indicator.classList.remove('animate-pulse');
    indicator.textContent = '';
    const label = el(`<span></span>`);
    label.textContent = `⏸ ${message || t('未发送 · 任务运行中')}`;
    indicator.appendChild(label);
    const btn = el(`<button type="button" class="ml-2 underline decoration-dotted" data-testid="outbox-resend">${t('重发')}</button>`);
    btn.onclick = async () => {
      btn.disabled = true;
      label.textContent = `🕐 ${t('正在发送...')}`;
      const d = await deliverOutboxItem(item);
      if (d.outcome === 'ok') { indicator.remove(); return; }
      btn.disabled = false;
      label.textContent = d.outcome === 'blocked'
        ? `⏸ ${d.message || t('未发送 · 任务运行中')}`
        : `⚠️ ${d.message || t('发送失败')}`;
    };
    indicator.appendChild(btn);
  }

  async function processOfflineQueue() {
    if (_offlineDrainInFlight || offlineQueue.length === 0) return;
    _offlineDrainInFlight = true;
    const items = offlineQueue;
    offlineQueue = []; // 本批取出；requeue 的再 enqueue
    persistOutbox();
    addBar(`${t('正在重发离线发送队列中的')} ${items.length} ${t('条消息...')}`, 'text-info');
    logClientEvent('send', `[WEB_SEND] 正在重发离线发送队列中的 ${items.length} 条消息`);
    let hadViewingOk = false;
    try {
      for (const item of items) {
        const indicator = item.bubbleEl?.querySelector('.pending-indicator');
        if (indicator) indicator.textContent = t('🕐 正在发送...');
        logClientEvent('send', `[WEB_SEND] 重发离线消息: "${String(item.text || '').slice(0, 100)}" (${String(item.text || '').length} 字符)`);
        // REL-01：用入队时刻的 instanceId/cwd，不取当下 viewing。
        const decision = await deliverOutboxItem(item);
        const targetsViewing = item.instanceId != null && item.instanceId === viewingInstanceId;
        if (decision.outcome === 'ok') {
          if (indicator) indicator.remove();
          if (targetsViewing) hadViewingOk = true;
        } else if (decision.outcome === 'permanent') {
          if (indicator) indicator.textContent = `⚠️ ${decision.message || t('发送失败')}${t('，已停止重试')}`;
          logClientEvent('send', `[WEB_SEND] 离线消息被服务端永久拒绝（${decision.message || ''}），停止重试`);
        } else if (decision.outcome === 'blocked') {
          // 队列首条发出去就开跑，其后各条必被拒——继续 requeue 会空转成客户端排队。
          markOutboxBlocked(item, decision.message);
          if (targetsViewing) _turnRunning = true;
          logClientEvent('send', `[WEB_SEND] 离线消息撞上在途轮，落未发送终态待手动重发`);
        } else {
          if (indicator) indicator.textContent = t('🕐 未确认送达，等待重连重试...');
          enqueueOutbox(item);
          logClientEvent('send', `[WEB_SEND] 离线消息重发未确认，已重新排队`);
        }
      }
    } finally {
      _offlineDrainInFlight = false;
      persistOutbox();
      // 批后 busy：仅 viewing 相关 in-flight/成功才抬；永久失败且无剩余 viewing 队列 → clear
      setBusy(shouldBusyAfterOfflineBatch({
        viewingInstanceId,
        remainingItems: offlineQueue,
        hadViewingOk,
      }));
    }
  }

  // 移动端切前台/重连后的统一 sync 入口（命中根因 A/B）。复用 clearView（清 DOM + 重置 lastSeq/curEpoch
  // 去重基线）→ loadHistory（默认 cwd=currentCwd、ack 内 hideLoadingCard）。connect 路径不像 bindView 那样
  // 先 clearView，loadHistory 是 appendChild 不清空，故重载前必须先 clearView 防重复整段对话。
  const PROBE_MS = 5000; // 探测 ack 超时：远低于 socket.io 被动心跳超时窗口(~45s)，又容忍移动端慢 RTT
  let _probeInFlight = false;
  function reloadCurrentFromHistory(onDone) {
    if (!displayedSessionId) return;
    hideUnreadPill(); // 即将清屏重载：旧胶囊指向的 DOM 节点马上失效，先清，onDone 到达后再按新数字重建
    // 与 bindView reload 同理：clearView 前的 lastSeq/curEpoch 可能刚被 sync 回放推进；
    // 归零后若再 sync 会把环形缓冲整段再叠到磁盘历史上。恢复基线，仅丢未落盘的实时中间态。
    const keepSeq = lastSeq;
    const keepEpoch = curEpoch;
    clearView(displayedSessionId, null);
    lastSeq = keepSeq;
    curEpoch = keepEpoch;
    // clearView 内部只补乐观 busy（shouldRestoreOptimisticBusy），不含 state seed——
    // 前台回切/重连 gap→reload 静默窗口无 delta 自愈，运行条被本次清屏永久抹掉 → 按 server 权威 state 重种。
    if (shouldReseedBusyAfterReload({ instances: instancesList, instanceId: displayedInstanceId })) setBusy(true);
    // 发送闸同理：clearView 把 _turnRunning 清了，按广播的权威字段重种，否则 reload 后停止钮消失
    if (instancesList.find(x => x?.instanceId === displayedInstanceId)?.turnRunning === true) _turnRunning = true;
    showLoadingCard();
    loadHistory(displayedSessionId, undefined, onDone); // cwd 默认 currentCwd
  }
  // 状态对账：用 sync:since ack 带回的 pending 快照重建未决审批/提问卡片。走既有 handler（自带 requestId
  // 去重 + 弹窗/通知）。修「角标 ⚠️ 待审批但会话内无卡片」——原始事件可能被环形缓冲 trim 或切视图分流丢弃，
  // pendingPermissions/pendingQuestions 才是权威真相。视图稳定后调用（bindView / connect 两路径）。
  function applyPendingSnapshot(pending) {
    if (!pending) return;
    // 走 sync:since ack 的 pending 字段重建卡片，不经过 dispatchAgentEvent，故不带 event.replay 标记；
    // 这里单独置位 isReplayBatch 防止环形缓冲被冲出窗口（gap）时，这条旁路漏静音重新弹响。
    // try/finally：handle.* 会动 DOM，若中途抛错也必须复位，否则 isReplayBatch 卡在 true 会静默吞掉后续所有实时提示音。
    appContext.state.isReplayBatch = true;
    try {
      for (const p of pending.permissions || []) handle.permission_request(p);
      for (const q of pending.questions || []) handle.question(q);
    } finally {
      appContext.state.isReplayBatch = false;
    }
  }
  function requestSync({ probe }) {
    if (!displayedInstanceId || !displayedSessionId) return;
    const reqInstanceId = displayedInstanceId, reqSessionId = displayedSessionId; // WS-002：捕获发起时的视图目标（代次）
    const payload = { instanceId: reqInstanceId, sessionId: reqSessionId, lastSeq };
    // 回放缓冲句柄：probe/非 probe 分支各自 begin()（见下方），ack 到达后 act() 据判定结果 resolve()。
    let replayHandle = null;
    const act = (err, res) => {
      // WS-002：迟到 ACK 守卫——发起后若已切到别的会话/实例，丢弃本回调。否则 A 的 sync ACK 会在当前 B 上
      // reload（清空 B）或 applyPendingSnapshot 弹出 A 的审批/问题卡。对齐 bindView 的 sync:since 守卫。
      // 必须先 resolve/discard 本轮缓冲：否则早退会把已入队的 live 事件挂到超时或被后续 begin 无声
      // discard——若服务端环窗已挤出这些 seq，它们永远不会再被回放（code review 确认的竞态丢事件）。
      if (displayedInstanceId !== reqInstanceId || displayedSessionId !== reqSessionId) {
        replayBuffer.resolve(replayHandle, 'discard');
        return;
      }
      const a = syncAckAction(err, res, {
        seenDiskLen: seenDiskLenBySession.get(reqSessionId) ?? 0,
        // 无 sessionId = session:history 无从查起，清屏必然换来白屏（见 logic.js 该闸注释）
        hasSessionId: Boolean(reqSessionId),
      });
      if (a === 'reconnect') {
        // 整条连接都要重来：缓冲内容从未渲染过，纯丢弃、不推进续传基线——重连后新一轮 sync:since
        // 会用旧基线重新取，否则这批事件会被当成"已处理过"永久丢失（见 createReplayBuffer resolve 注释）。
        replayBuffer.resolve(replayHandle, 'discard');
        if (socket.connected) socket.disconnect(); socket.connect(); return;
      }
      if (res?.replayed > 0) logClientEvent('recv', `[WEB_RECV] 断线追平补发 ${res.replayed} 条`); // 对账断线期漏收
      // 回放缓冲二层判定（同 bindView）：a 已是 'reload' 时直接沿用；'none' 时再看缓冲攒了多少条 +
      // 是否 busy。busy 取 ack 时刻 instances 广播的最新值（该实例此刻正有实时轮次在跑则恒不 reload）。
      const busy = shouldSeedBusyFromInstanceState(instancesList.find(x => x.instanceId === reqInstanceId)?.state);
      const bufferAction = resolveReplayBufferAction({ bufferedCount: replayBuffer.bufferedCount(reqInstanceId), priorAction: a, busy, hasSessionId: Boolean(reqSessionId) });
      // 未读胶囊：这是"同一会话内断线重连"路径（镜像视图架构下最常见的"切出去"形态——锁屏/切后台冻结页面
      // 断开 socket，viewingInstanceId 全程不变，故不会走 bindView，只会走到这里）。DOM 是否就绪同样分叉：
      // 'reload' 要等 reloadCurrentFromHistory 的 onDone；其余（回放走正常 agent:event 增量渲染）DOM 已稳定。
      const unreadOnEntry = res?.unreadOnEntry || 0;
      if (bufferAction === 'reload') {
        // 丢弃缓冲队列 + 续传基线前移到队列尾（reloadCurrentFromHistory 内部的 keepSeq/keepEpoch
        // 快照-恢复由此拿到正确值，理由同 bindView 的 reload 分支）。
        replayBuffer.resolve(replayHandle, 'reload');
        reloadCurrentFromHistory(() => showUnreadPillIfAny(unreadOnEntry));
      } else {
        // flush：缓冲队列（若有）按序正常派发，抑制中间滚动，派发完一次强制落底。
        replayBuffer.resolve(replayHandle, 'flush');
        showUnreadPillIfAny(unreadOnEntry);
        // 同 bindView 的 keep 分支：'none' 时 DOM 停在断连前的旧内容底部，断连期间产生的新内容随后
        // 才作为 replay 事件逐条补发，不强制补一次落底会停留在旧位置附近。flushQueue 已在缓冲非空时
        // 做过一次，这里是冗余但无害的兜底（replayed=0/缓冲为空时仍需要它独立生效）。
        if (shouldForceScrollAfterReplay({ action: a, replayed: res?.replayed })) scrollBottom(true);
      }
      // 状态对账：重连/probe 补传后用快照重建未决审批卡片（reload 的 clearView 已同步执行完、不被清）；
      // reconnect 已 return——它触发干净重连，届时新一轮 sync 会带新快照。
      applyPendingSnapshot(res?.pending);
    };
    if (probe) {
      if (_probeInFlight) return;       // ack 异步，防 200ms debounce 外的并发探测
      _probeInFlight = true;
      replayHandle = replayBuffer.begin(reqInstanceId);
      socket.timeout(PROBE_MS).emit('sync:since', payload, (err, res) => {
        _probeInFlight = false;
        act(err, res);
      });
    } else {
      replayHandle = replayBuffer.begin(reqInstanceId);
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
    if (authSubmit) { authSubmit.disabled = false; authSubmit.textContent = t('进入'); }
    connDot.className = 'w-2 h-2 rounded-full bg-success shrink-0';
    setStatus(t('已连接'));
    startRttLoop(); // 连上即开始测 RTT（立即一次 + 周期）
    cliStatusWrapEl?.classList.remove('opacity-40'); // E16：重连恢复（折叠条整体：summary + ANSI 行，重放/刷新马上跟上）
    logClientEvent('conn', `连接成功！Socket ID = ${socket.id}。当前使用 token: ${token ? token.slice(0, 4) + '***' : '无（本机/公网）'}`);
    // 台阶3：首连由 instances 事件驱动加载当前查看实例（见 setInstances）；重连（非首连、已有绑定实例）
    // 续传该实例缓冲补齐断线期间漏掉的事件。
    if (!initialLoad && displayedInstanceId && displayedSessionId) requestSync({ probe: false });
    initialLoad = false;
    setupPush();
    initDeepLinkOnce();  // ②2c：深链入口（幂等，仅首次 connect 生效）
    // PWA 后台推送修复：重连后服务端对这个新 socket 的 presence 是全新的（socket.data.hidden 从
    // undefined 起算），需要重新对齐当前 document.hidden，避免重连瞬间被误判为"前台"或"后台"。
    socket.emit('client:presence', { hidden: document.hidden });

    // 触发离线发送队列重发
    processOfflineQueue();
  });
  socket.on('disconnect', (reason) => {
    connDot.className = 'w-2 h-2 rounded-full bg-danger shrink-0';
    setStatus(t('连接断开，自动重连中…'));
    stopRttLoop();
    clearRttDisplay();
    cliStatusWrapEl?.classList.add('opacity-40'); // E16：置灰示陈旧（折叠条整体：summary + ANSI 行；内容含 🕐，不另发明离线文案）
    logClientEvent('conn', `网络连接断开，原因: ${reason || '未知'}`);
  });
  socket.on('connect_error', async err => {
    logClientEvent('conn', `连接尝试失败: ${err.message || err}`);
    if (err.message === 'unauthorized') {
      if (isLanOrLocal() || !document.body.dataset.cfAccess) {
        setStatus(t('需要访问令牌'));
        showAuthGate(socket.auth?.token ? t('令牌无效，请重新输入') : ''); // 有 token 仍失败 = 无效
      } else {
        setStatus(t('需要重新登录'));                 // 公网无 token 可输，走 Access 重登
        maybeAccessRelogin();
      }
    } else {
      setStatus(`${t('连接失败：')}${err.message}`);
      // 非 unauthorized 错误（如网络抖动）也要复位登录按钮——仅在它确实还卡在 submitAuth() 置的
      // 「连接中…」禁用态时才复位，不强制弹出整个 authGate（没打开过登录页时不该无端冒出来）。
      if (authSubmit && authSubmit.disabled) { authSubmit.disabled = false; authSubmit.textContent = t('进入'); }
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
    if (authSubmit) { authSubmit.disabled = false; authSubmit.textContent = t('进入'); }
    setTimeout(() => authToken?.focus(), 50);
  }
  function submitAuth() {
    const val = authToken?.value.trim();
    if (!val) { showAuthGate(t('请输入访问令牌')); return; }
    localStorage.setItem('auth_token', val);
    token = val;
    socket.auth = { token: val, deviceToken };
    if (authError) authError.classList.add('hidden');
    if (authSubmit) { authSubmit.disabled = true; authSubmit.textContent = t('连接中…'); }
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
      const e = el(`<div class="text-danger"></div>`); e.textContent = t('体检失败或无响应'); box.appendChild(e); return;
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
  // 会话设置标题行右侧 ↻（常驻）；新会话页摘要旁那个同源入口在 showComposeSurface 里接线。
  // spinEl 取不到时回落按钮本身——|| 而非默认参数：querySelector 返回 null 不会触发默认值。
  const cfgRefreshBtn = $('btnConfigRefresh');
  wireConfigRefreshButton(cfgRefreshBtn, cfgRefreshBtn?.querySelector('[data-spin]') || cfgRefreshBtn);

  if ($('btnSecurityCheck')) $('btnSecurityCheck').onclick = () => {
    const box = $('doctorReport');
    box.classList.remove('hidden');
    box.replaceChildren();
    const loading = el(`<div class="text-ink-faint"></div>`); loading.textContent = t('🔍 体检中…'); box.appendChild(loading);
    socket.emit('doctor:run', {}, rep => renderDoctor(rep, box));
  };

  // ---- 服务状态面板（NFR-15 可见性）----
  // 设置「访问与设备」组入口 → 底部 sheet 两段渲染：基础(时长/版本/连接/日志开关) + 异常告警（判定化：
  // 裸计数器段已撤——对人无参照系不可解读，原始计数留 /metrics 巡检端点；有信号项升格为带时效窗告警）。
  // 数据走鉴权 service:status ack（doctor:run 同构）；打开即拉、开着时 5s 重拉（后台 tab 跳过）、关闭即停。
  const serviceStatusModal = $('serviceStatusModal'), serviceStatusBody = $('serviceStatusBody');
  let serviceStatusTimer = null;
  function renderServiceStatus(res) {
    if (!serviceStatusBody) return;
    const now = Date.now();
    const section = (title, titleSuffix) => {
      const s = el(`<div><div class="text-xs font-semibold text-ink-soft mb-2"></div><div class="rounded-xl border border-line bg-surface"></div></div>`);
      s.firstChild.textContent = title;
      if (titleSuffix) {
        const soft = el(`<span class="font-normal text-ink-faint"></span>`);
        soft.textContent = ` ${titleSuffix}`;
        s.firstChild.appendChild(soft);
      }
      return s;
    };
    const addRow = (card, label, value, valueClass) => {
      const row = el(`<div class="flex items-center justify-between gap-3 px-3 py-2.5 text-xs border-t border-line-soft first:border-t-0"><span class="text-ink-soft font-medium shrink-0"></span><span class="text-ink text-right tabular-nums"></span></div>`);
      row.firstChild.textContent = label;
      row.lastChild.textContent = value;
      if (valueClass) row.lastChild.classList.add(valueClass);
      card.appendChild(row);
    };
    serviceStatusBody.replaceChildren();
    // 段1 基础：连接状态取自本 socket 与 RTT 监视器（不另发 ping）
    const basic = section(t('基础'));
    for (const r of serviceStatusBasicRows({ startedAt: res.startedAt, versions: res.versions, connected: socket.connected, rttMs: rttMonitor.last(), now, logging: res.logging })) {
      addRow(basic.lastChild, r.label, r.value, r.alert ? 'text-warning' : null); // 日志开关：SDK 调试开着标黄（忘关观测点）
    }
    serviceStatusBody.appendChild(basic);
    // 段2 异常告警：与抽屉「服务」小节同一纯函数（文案一致）。
    // 服务端已按时效窗判定（超窗自动退场），此处只渲染。
    const noticesSection = section(t('异常告警'));
    const notices = formatServiceNotices({
      service: { deliveryFailure: res.deliveryFailure, rateLimitLockout: res.rateLimitLockout, clientError: res.clientError },
      now,
    });
    if (!notices.length) {
      const okRow = el(`<div class="px-3 py-2.5 text-xs text-success"></div>`);
      okRow.textContent = t('✓ 无异常');
      noticesSection.lastChild.appendChild(okRow);
    } else {
      for (const line of notices) {
        const row = el(`<div class="px-3 py-2.5 text-xs border-t border-line-soft first:border-t-0"></div>`);
        // 判色按告警类别：投递失败(🔔)/限速锁定(⛔)红——错过审批与安全事件；重启(🔄)/前端错误(🐞)黄
        row.classList.add(line.startsWith('🔔') || line.startsWith('⛔') ? 'text-danger' : 'text-warning');
        row.textContent = line;
        noticesSection.lastChild.appendChild(row);
      }
    }
    serviceStatusBody.appendChild(noticesSection);
    const hint = el(`<div class="text-[10px] text-ink-faint"></div>`);
    hint.textContent = t('数据每 5 秒自动刷新 · 告警超 24 小时自动退场 · 原始计数见 /metrics');
    serviceStatusBody.appendChild(hint);
  }
  // 一键安装/卸载 hooks 桥。安装要写用户全局 ~/.claude/settings.json，所以先明确确认——
  // 这是 server 唯一会动那个文件的路径，必须让用户知道自己在批准什么。
  // 报告直接回显安装器输出（含四种结局文案），不在前端另写一套话术。
  async function runHooksSetup(action, btn) {
    const installing = action === 'install';
    const okConfirm = await appConfirm({
      title: installing ? t('开启终端会话推送？') : t('关闭终端会话推送？'),
      body: installing
        ? t('会往 ~/.claude/settings.json 追加两个 hook（你已有的配置原样保留）。已在跑的终端会话需重开才生效。')
        : t('会移除本项目添加的那两个 hook 条目，你已有的 hooks 不受影响。'),
      okText: installing ? t('开启') : t('关闭'),
      tone: installing ? 'default' : 'warn',
    });
    if (!okConfirm) return;
    btn.disabled = true;
    btn.textContent = t('处理中…');
    socket.timeout(25000).emit('hooks:setup', { action }, (err, res) => {
      btn.disabled = false;
      // 用 ack 自带的 state 立刻回填再重渲：只等 instances 广播的话，按钮会一直卡在「处理中…」
      // （广播若没来或迟到，这段就再也不会重画）。广播随后到达只是二次确认，不是唯一依赖。
      if (res?.state && latestServiceHealth?.hooksBridge) latestServiceHealth.hooksBridge.state = res.state;
      renderHooksBridgeSection();
      if (err || !res) { addBar(t('操作超时，请重试'), 'text-danger'); loadServiceStatus(); return; }
      addBar(res.report || (res.ok ? t('已完成') : t('操作失败')), res.ok ? 'text-ink-faint' : 'text-danger');
      loadServiceStatus(); // 服务状态页开着时顺带刷新
    });
  }

  function loadServiceStatus() {
    if (!serviceStatusModal || !serviceStatusModal.classList.contains('sheet-open')) return;
    socket.timeout(3000).emit('service:status', {}, (err, res) => {
      if (err || !res || res.ok !== true) return; // 断线/未审批设备无 ack：面板留旧值，不挂 spinner
      // WS-019 同款迟到 ack 守卫：回包时面板已关则丢弃，防对着 hidden DOM 白渲染
      if (!serviceStatusModal.classList.contains('sheet-open')) return;
      renderServiceStatus(res);
    });
  }
  function closeServiceStatus() {
    if (serviceStatusTimer) { clearInterval(serviceStatusTimer); serviceStatusTimer = null; }
    if (serviceStatusModal) closeSheet(serviceStatusModal);
  }
  if ($('btnServiceStatus')) $('btnServiceStatus').onclick = () => {
    if (!serviceStatusModal) return;
    general.close(); // 从通用设置切入：先收设置 sheet 再弹状态 sheet（服务状态属 🖥 主机那节）
    openSheet(serviceStatusModal);
    loadServiceStatus();
    if (serviceStatusTimer) clearInterval(serviceStatusTimer);
    serviceStatusTimer = setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      loadServiceStatus();
    }, 5000);
  };
  if ($('serviceStatusClose')) $('serviceStatusClose').onclick = closeServiceStatus;
  if (serviceStatusModal) serviceStatusModal.onclick = e => { if (e.target === serviceStatusModal) closeServiceStatus(); };

  if (authHelpLink) authHelpLink.onclick = showAccessHelp;

  // 短 session_id 胶囊点按 → 复制完整 id（便于粘到终端 claude --resume <id> 或跨设备定位）
  const pillSession = $('pillSession');
  if (pillSession) pillSession.onclick = async () => {
    if (!currentSessionIdForCopy) return;
    haptic('tap');
    try {
      await navigator.clipboard.writeText(currentSessionIdForCopy);
      addBar(`${t('已复制 session id：')}${currentSessionIdForCopy}`, 'text-ink-faint');
    } catch {
      addBar(`session id：${currentSessionIdForCopy}`, 'text-ink-faint'); // 剪贴板不可用（非 HTTPS 等）时至少显示全 id
    }
  };

  // 开发者模式：一键重启常驻 server（按钮仅 DEV_MODE=1 时由 setInstances 显示）。
  const btnRestartServer = $('btnRestartServer');
  if (btnRestartServer) btnRestartServer.onclick = async () => {
    const busyN = instancesList.filter(i => i.state === 'busy' || i.state === 'permission').length;
    const warnLine = busyN ? `⚠️ ${busyN} ${t('个会话在运行/待审批，重启会中断它们（含后台任务）。')}\n\n` : '';
    if (!(await appConfirm({
      title: t('⟳ 重启常驻 server？'),
      body: `${warnLine}${t('服务将优雅退出并由 KeepAlive 自动拉起，页面会自动重连。')}`,
      okText: t('重启'),
      tone: 'danger',
    }))) return;
    haptic('warning');
    addBar(t('⟳ 正在重启服务…页面将自动重连'), 'text-warning');
    socket.emit('dev:restart', {}, res => {
      if (res && res.ok === false) addBar(`${t('重启被拒：')}${res.error || t('未知')}`, 'text-danger');
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
    // 让开顶栏：卡片栈是 fixed 覆盖层，容器虽 pointer-events-none，卡片本身却是 auto，且窄屏下
    // max-w-sm 占满宽度、高约 130px——从 top:0 铺开会把整条 header 盖死，有待批设备时侧栏/首页/
    // 日志/＋ 一个都点不到，用户只能先处理掉卡片才能干别的。
    // 必须实测而不是写常量：header 的上 padding 是 max(1.25rem, env(safe-area-inset-top))
    // （app.css 移动端 header 规则），高度随刘海/横竖屏变，任何静态值都会在某类设备上错。
    const headerEl = document.querySelector('header');
    if (headerEl) deviceRequests.style.top = `${headerEl.offsetHeight}px`;
    deviceRequests.classList.remove('hidden');
    for (const d of devices) {
      const card = document.createElement('div');
      card.className = 'pointer-events-auto mx-auto w-full max-w-sm bg-surface border border-line rounded-xl p-3';
      card.setAttribute('data-testid', 'device-card');
      card.setAttribute('data-device-id', d.deviceId);
      card.style.boxShadow = 'var(--shadow-pop)';
      const title = document.createElement('div');
      title.className = 'text-sm font-semibold text-ink mb-1.5';
      title.textContent = t('🔔 新设备请求接入');
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
      approve.className = 'flex-1 py-2 rounded-lg bg-cta text-white active:brightness-95 text-xs font-medium';
      approve.textContent = t('✓ 准入');
      approve.addEventListener('click', () => { socket.emit('user:approveDevice', { deviceId: d.deviceId }); });
      const deny = document.createElement('button');
      deny.type = 'button';
      deny.className = 'flex-1 py-2 rounded-lg bg-sunk text-ink-soft active:bg-line-soft text-xs font-medium';
      deny.textContent = t('✕ 拒绝');
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
    // handler 抛异常时走既有的前端错误上报（服务状态面板的「🐞 前端错误」告警据此点亮）。
    // 关键在于异常不再冒出去中断整条派发链——那会让同批后续事件一起永久丢失且不可补。
    onHandlerError: (err, event) => reportClientError('error', {
      message: `agent:event handler [${event?.type}] threw: ${err?.message || err}`,
      stack: err?.stack,
    }),
    outOfBand: {
      task_notification: onTaskNotification,
      // outOfBand 不经 handled 分支，相关进度/重试仍刷新 lastEventAt（说明 turn 还活着）
      task_progress: (ev) => {
        const relevant = onTaskProgress(ev); // let 可后绑 reconcile 包装
        if (relevant && liveLine) liveLine.lastEventAt = Date.now();
        return relevant;
      },
      // API 重试：CLI 把整条 spinner 行顶替成 "✻ API error · Retrying in 4s · attempt 2/10"，
      // web 对齐同一语义——写进 liveLine.retry 由 renderLiveLineText 整行顶替。不再走底部横幅：
      // 旧横幅与后台任务/子 agent 争抢同一 DOM，且被 reconcileBanners 的 task 优先级必现压掉。
      // deadline 存绝对时刻而非 delayMs——已有的 1s ticker 据此重算，倒计时才走得动。
      api_retry: (ev) => {
        if (ev.instanceId && viewingInstanceId && ev.instanceId !== viewingInstanceId) return;
        if (!liveLine) return;
        liveLine.lastEventAt = Date.now();
        const p = ev.payload || {};
        const delayMs = Number(p.delayMs ?? p.retry_delay_ms);
        liveLine.retry = {
          attempt: Number(p.attempt) || null,
          maxRetries: Number(p.maxRetries ?? p.max_retries) || null,
          deadline: Number.isFinite(delayMs) && delayMs > 0 ? Date.now() + delayMs : null,
          errorStatus: p.errorStatus ?? p.error_status ?? null,
        };
        renderLiveLine();
      },
      history_append: onHistoryAppend,
      mirror_state: onMirrorState,
    },
    // handled 分支统一刷新：已过实例过滤 + epoch/seq 去重，任何本会话事件都说明「还活着」
    onHandledEvent(ev) {
      if (!liveLine) return;
      liveLine.lastEventAt = Date.now();
      if (ev.type === 'text_delta' || ev.type === 'thinking_delta') liveLine.sawContentDelta = true;
    },
    onEpochReset() {
      approvals.clearAll();
    },
    onSessionId(sessionId) {
      localStorage.setItem('current_session', sessionId);
      // FE-001：新会话懒开时 bindView 用 entry.sessionId=null 绑定，displayedSessionId 一直 null，
      // requestSync / reloadCurrentFromHistory 早退 → 重连追平死。SDK 首到 sessionId 时补丁同一实例。
      if (displayedInstanceId && !displayedSessionId && sessionId) {
        displayedSessionId = sessionId;
        updatePillSession(sessionId);
        syncTopContextLabel();
      }
    },
  });
  // 回放缓冲（P0-REPLAY-BUFFER，见 logic.js resolveReplayBufferAction 顶部注释）：bindView 切视图 /
  // requestSync 重连-探活两条入口共用，emit 'sync:since' 之前先 begin() 架起缓冲，命中该 instanceId
  // 的事件（含期间穿插的非 replay 实时事件）先入队不渲染；ack 到达后按判定结果 resolve('reload'|'flush')。
  // scrollBottom/dispatchAgentEvent 是本文件下方的函数声明/上方已构造的 const，此处引用均安全
  // （函数声明整体提升；dispatchAgentEvent 在本行之前已完成赋值）。
  const replayBuffer = createReplayBuffer({
    dispatch: dispatchAgentEvent,
    scrollBottom,
    withScrollSuppressed(fn) {
      _suppressScrollBottom = true;
      try { fn(); } finally { _suppressScrollBottom = false; }
    },
    setSeq: value => { lastSeq = value; },
    setEpoch: value => { curEpoch = value; },
    // 超时兜底与 ack 路径同口径：超阈值走 reload 语义（只推进基线，不逐条吐成打字机）；
    // 未超阈值 flush。busy 在超时点无法可靠取（可能正是半开连接），按非 busy 处理——宁可
    // 超阈值时丢缓冲改走下次 history/sync，也不要 100+ 条 DOM 抖动。
    decideTimeoutAction: ({ bufferedCount }) => resolveReplayBufferAction({
      bufferedCount,
      priorAction: 'keep',
      busy: false,
      // 无 sessionId 时这里的 'reload' 语义是「丢弃缓冲队列只推进基线」——但磁盘上没有任何东西能补回来，
      // 丢了就是永久丢失，只能 flush 把它们渲染出来（见 logic.js 该闸注释）。
      hasSessionId: Boolean(displayedSessionId),
    }),
  });
  socket.on('agent:event', event => {
    if (replayBuffer.offer(event)) return; // 命中当前缓冲实例的对话流：已入队，不在这里渲染（OOB 不入队）
    dispatchAgentEvent(event);
  });
  function failPendingToolCards(message) {
    if (!toolCards.size) return;
    const summary = message || t('工具执行已因本轮错误停止');
    for (const card of toolCards.values()) {
      const status = card.querySelector('.t-status');
      if (status) setStatusIcon(status, 'error');
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

  // 停止时丢弃「尚未送达 SDK」的消息（send 完成到输入泵取走之间的窄窗）：气泡落灰色终态而非删除，
  // 与 buffer 回放、多设备视图一致。排队已移除，故这里只剩 queue_dropped 一个来源。
  // 按 data-client-message-id 定位——顶层气泡创建时就带这个属性（离线占位与在线渲染都打）。
  function markMessageDropped(ids, label) {
    for (const id of ids) {
      const b = messagesEl.querySelector(`[data-client-message-id="${CSS.escape(id)}"]`);
      if (!b) continue;
      b.style.opacity = '0.55';
      if (b.querySelector('.dropped-indicator')) continue; // 幂等：sync 回放可能重复喂同一条
      const row = el(`<div class="dropped-indicator text-[11px] text-ink-faint mt-1"></div>`);
      row.textContent = label;
      b.appendChild(row);
    }
  }

  // 工具卡「预览变更」diff 渲染：Edit/MultiEdit 的 hunks 走行级 unified diff（复用 git-changes.js
  // renderPatchLines 着色）；超过 MAX_DIFF_LINES_FOR_LCS 行退回整块红/绿块（异常大输入的兜底，不算 LCS）；
  // Write/NotebookEdit 的 added（无 old）维持既有整块绿。tool_use 工具卡与 turn-end 汇总卡共用本函数。
  function renderToolDiff(container, diff) {
    for (const h of (diff?.hunks || [])) {
      if (h.old === undefined && h.new === undefined) continue;
      const oldStr = h.old || '', newStr = h.new || '';
      const tooBig = Math.max(oldStr.split('\n').length, newStr.split('\n').length) > MAX_DIFF_LINES_FOR_LCS;
      if (tooBig) {
        if (h.old) { const pre = el(`<pre class="overflow-x-auto whitespace-pre-wrap break-words rounded px-2 py-1"></pre>`); pre.style.background = 'rgba(188,67,52,.12)'; pre.textContent = '- ' + h.old; container.appendChild(pre); }
        if (h.new) { const pre = el(`<pre class="overflow-x-auto whitespace-pre-wrap break-words rounded px-2 py-1"></pre>`); pre.style.background = 'rgba(61,138,80,.12)'; pre.textContent = '+ ' + h.new; container.appendChild(pre); }
      } else {
        container.appendChild(renderPatchLines(unifiedDiffLines(oldStr, newStr).join('\n'), el));
      }
    }
    if (diff?.added !== undefined) {
      const pre = el(`<pre class="overflow-x-auto whitespace-pre-wrap break-words rounded px-2 py-1"></pre>`);
      pre.style.background = 'rgba(61,138,80,.12)';
      pre.textContent = String(diff.added);
      container.appendChild(pre);
    }
  }

  let deviceApprovedHideTimer = null; // approved 的淡出隐藏是延迟执行；若 150ms 内又来一个 pending 须作废，否则会把重新弹出的弹窗悄悄关掉
  const handle = {
    device_status(p) {
      const modal = $('deviceModal');
      const modalId = $('deviceModalId');
      const modalCmdId = $('deviceModalCmdId');
      if (deviceApprovedHideTimer) { clearTimeout(deviceApprovedHideTimer); deviceApprovedHideTimer = null; }
      if (p.status === 'pending') {
        if (modal) {
          if (modalId) modalId.textContent = p.deviceId || '';
          if (modalCmdId) modalCmdId.textContent = p.deviceId || '';
          modal.classList.remove('hidden');
          modal.style.opacity = ''; // 防陈旧 approved 淡出效果残留把新弹窗带成半透明
        }
        if (inputEl) inputEl.disabled = true;
        updateSendButtonState();
      } else if (p.status === 'approved') {
        if (modal) {
          modal.style.transition = 'opacity 0.15s ease-out';
          modal.style.opacity = '0';
          deviceApprovedHideTimer = setTimeout(() => {
            deviceApprovedHideTimer = null;
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
      // 合成 init 可能只带 slashCommands（切区重放）或只校正 model/cwd——按字段是否存在分别处理，
      // 缺字段不覆盖：否则 pushSlashCommandsForCwd 的精简 init 会把 currentModel 冲成空。
      const hasModel = p && Object.prototype.hasOwnProperty.call(p, 'model');
      if (hasModel) {
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
          if (currentModel && m && m !== currentModel) addModeBar(`${t('模型 →')} ${m}`, 'text-info');
          updateModelAndSuffix(rawM);
          rebuildEffortOptions(currentModel); // 模型变 → effort 档位跟随；空列表也刷（显示默认磁贴，好过整个隐藏）
          rebuildCustomModelGrid(modelsList); // 模型网格用已有缓存重建（models 事件没到也不空白）
          setPermMode(p.permissionMode); // 每轮 init 回显当前权限档（幂等，与 permission_mode 事件一致）
        }
      } else if (mirrorReadonlySid && p?.permissionMode && mirrorWebPanelSnapshot) {
        mirrorWebPanelSnapshot.permissionMode = p.permissionMode;
        renderCliPanelState();
      } else if (!mirrorReadonlySid && p?.permissionMode) {
        setPermMode(p.permissionMode);
      }
      // 顶部状态行回归「纯连接状态」职责：model/目录/ctx/cost 已由 E16 web 状态栏投送（更全更权威），
      // 此处不再合成覆盖连接状态
      // slashCommands：真 init / 服务端按 cwd 重放都会带；空数组也接受（表示该 cwd 确实无命令）。
      // 缺字段（合成 init 仅校正 model/cwd 时）不碰缓存，保留 localStorage / 上次列表。
      if (Array.isArray(p.slashCommands)) {
        window.availableSkills = p.slashCommands;
        try { localStorage.setItem('slash_commands', JSON.stringify(p.slashCommands)); } catch { /* quota / 隐私模式 */ }
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
      if (consoleModal && consoleModal.classList.contains('sheet-open') && consoleFilter !== 'diag') {
        appendLogEntry(p);
      }
    },
    // 诊断时间线（镜像/排队/停止）实时推送：与 session_log 同款 seq:0/epoch:'server' 旁路广播，
    // 抽屉开着且未把过滤切到"仅交互"时才追加——切到"诊断"/"全部"都应看见。
    diag_log(p) {
      if (consoleModal && consoleModal.classList.contains('sheet-open') && consoleFilter !== 'interaction') {
        appendLogEntry(formatDiagLogEntry(p));
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
        // 网关映射场景（resolvedModel）优先显真实模型名，而非档位别名 displayName/value（同 syncModelUI）
        if (typeof m === 'string') { opt.value = m; opt.textContent = m; }
        else { opt.value = m.value; opt.textContent = resolveModelDisplayName(m.value, modelsList); }
        modelInput.appendChild(opt);
      });
      // 预选：若用户已选「下一条才生效」的待发模型，保留 modelInput（H2）；
      // 否则 currentModel → CLI default → 空。
      const pendingSend = (modelInput.dataset.fullModel || modelInput.value || '').trim();
      const pendingIsIntentional = !!(pendingSend && pendingSend !== 'default' && pendingSend !== (currentModel || ''));
      if (pendingIsIntentional) {
        ensureModelOption(pendingSend);
        modelInput.value = pendingSend;
        rebuildCustomModelGrid(modelsList);
      } else if (currentModel) {
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
      // scout 模型到齐后，compose 页默认档摘要与底栏 pill 同步刷新
      if (_composeReady) refreshComposeDefaultsSummary();
    },
    text_delta(p) {
      clearLiveRetry(); // 重试已过，流恢复——状态行从重试态回落普通 spinner
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
      // UX-004：流式期间节流全量 renderMarkdown（默认 80ms），避免裸星号/列表源码；result 时 finalize 权威全文
      if (!s._mdTimer) {
        s._mdTimer = setTimeout(() => {
          s._mdTimer = null;
          try { s.el.innerHTML = render(s.raw); } catch { /* 失败保持现状 */ }
          scrollBottom();
        }, formatStreamPreviewIntervalMs());
      }
      setBusy(true);
      // 正文开流 = 本轮 thinking 阶段结束（事件驱动切换，比 idle 超时判定准）
      if (liveLine?.thinking?.state === 'active') {
        liveLine.thinking.state = 'done';
        renderLiveLine();
      }
    },
    thinking_delta(p) {
      clearLiveRetry();
      if (isSubagentPayload(p)) {
        const sa = ensureSubagentCard(p.parentToolUseId, p.subagentType);
        getSubagentThinking(sa, p.messageId).body.appendData(p.text);
        scrollBottom();
        setBusy(true);
        // 子 agent thinking 不计主线 thinking 时长（内容已折叠进子卡，live 行保留主线状态）
        return;
      }
      getThinking(p.messageId).body.appendData(p.text);
      scrollBottom();
      setBusy(true);
      if (liveLine) {
        liveLine.thinking = { state: 'active', ...advanceThinkingClock(liveLine.thinking || undefined, Date.now()) };
        renderLiveLine();
      }
    },
    tool_use(p) {
      clearLiveRetry();
      // 工具卡片摘要：formatToolSummary 把紧凑 JSON pretty 成缩进文本，再套 hljs（与预览变更/聊天代码块同源）。
      // pre 用 whitespace-pre-wrap break-words：手机窄屏允许换行，不再强制横向滚一整行。
      // UX-002：收起态标题「工具名 · inputSummary 截断」，扫读不必逐张展开；Task 清单工具特化
      const cardTitle = formatTaskToolTitle(p.name, p.inputSummary) ?? formatToolCardTitle(p.name, p.inputSummary);
      const card = el(`
        <details class="msg-frame toolcard rounded-lg bg-surface border border-line text-xs">
          <summary class="px-3 py-2 flex items-center gap-2 min-w-0">
            <span class="t-status status-icon shrink-0 text-warning" aria-label="${t('进行中')}"></span><span class="t-name font-mono font-semibold text-ink truncate">${esc(cardTitle)}</span>
          </summary>
          <div class="px-3 pb-2 space-y-1">
            <pre class="t-in overflow-x-auto whitespace-pre-wrap break-words text-ink-soft"><code></code></pre>
            <pre class="t-out overflow-x-auto whitespace-pre-wrap break-words text-ink-faint hidden"><code></code></pre>
          </div>
        </details>`);
      setStatusIcon(card.querySelector('.t-status'), 'pending');
      card.dataset.toolName = p.name || ''; // tool_result 无 name，结果特化渲染从卡上取
      const inCode = card.querySelector('.t-in code');
      if (inCode) {
        // 空对象输入展开也只有「{}」噪音 → 整块藏掉（CLI 对空输入零渲染）
        if (String(p.inputSummary || '').trim() === '{}') {
          card.querySelector('.t-in')?.classList.add('hidden');
        } else {
          inCode.textContent = formatToolSummary(p.inputSummary || '');
          try { hljs.highlightElement(inCode); } catch { /* 高亮失败不影响显示 */ }
        }
      }
      toolCards.set(p.toolUseId, card);
      // 主会话写盘工具 → 记入本轮变更账本（Read / 子 agent 工具不入）
      if (!isSubagentPayload(p) && p.file?.path && isFileMutationTool({ name: p.name, changeKind: p.file?.changeKind })) {
        accumulateTurnFileChange(turnFileChanges, {
          path: p.file.path,
          name: p.name,
          changeKind: p.file.changeKind,
          toolUseId: p.toolUseId,
          added: p.file.added,
          removed: p.file.removed,
        });
      }
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
              m.textContent = res?.error || t('预览不可用');
              tbody.appendChild(m);
              return;
            }
            const lab = el(`<div class="text-ink-faint"></div>`);
            lab.textContent = `📁 ${res.attribution.workdirLabel} / ${res.attribution.relPath}`;  // 路径归属
            tbody.appendChild(lab);
            if (res.diff) {  // 变更 diff：行级 unified（textContent 防 XSS，见 renderToolDiff）
              renderToolDiff(tbody, res.diff);
            } else if (res.snippet) {  // Read 文件片段：图片 → 缩略图；文本 → 代码高亮
              if (res.snippet.image?.base64 && res.snippet.image?.mimeType) {
                // 与用户附件气泡同源：data URI + CSP img-src data: 已许
                const img = el(`<img class="max-w-full max-h-48 rounded border border-line object-contain bg-sunk" alt="${t('预览')}">`);
                img.src = `data:${res.snippet.image.mimeType};base64,${res.snippet.image.base64}`;
                tbody.appendChild(img);
                if (res.snippet.snippet) {
                  const cap = el(`<div class="text-ink-faint text-[11px]"></div>`);
                  cap.textContent = res.snippet.snippet + (res.snippet.truncated ? t(' …（已截断）') : '');
                  tbody.appendChild(cap);
                }
              } else {
                const pre = el(`<pre class="overflow-x-auto whitespace-pre-wrap break-words"><code></code></pre>`);
                pre.querySelector('code').textContent = res.snippet.snippet + (res.snippet.truncated ? t('\n…（已截断）') : '');
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
      // 子代理/Workflow 活动横幅（主会话 spawn 工具；嵌套内部 Agent 不再叠横幅）
      // Agent/Task：预建空卡占位。Workflow 多数阶段只走 task_progress、常无 parent 子流——
      // 预建会留下「🤖 workflow 已完成」空壳（机主反馈怪），故等首条 parentToolUseId 事件再建卡。
      if (!isSubagentPayload(p) && isSpawnToolName(p.name)) {
        agentToolIds.add(p.toolUseId);
        if (p.name !== 'Workflow') {
          const subType = extractInput(p.inputSummary, ['subagent_type', 'subagentType'], '');
          ensureSubagentCard(p.toolUseId, subType || null);
        }
        const desc = extractInput(p.inputSummary, ['description', 'prompt', 'args'], '');
        if (desc) showActivityBanner(desc);
      }
      // 对齐 CLI：spinner 行不挂工具后缀（命令由上方工具卡显示）；工具启动只终结 thinking burst
      if (liveLine?.thinking?.state === 'active') {
        liveLine.thinking.state = 'done';
        renderLiveLine();
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
      // UI-007：结果态 SVG
      const statusKind = p.denyKind === 'answered' ? 'answered'
        : (p.denyKind === 'denied' || p.denyKind === 'cancelled') ? 'denied'
        : (p.ok ? 'ok' : 'error');
      const stEl = card.querySelector('.t-status');
      setStatusIcon(stEl, statusKind);
      if (statusKind === 'ok') stEl?.classList.add('text-success');
      else if (statusKind === 'error' || statusKind === 'denied') stEl?.classList.add('text-danger');
      else stEl?.classList.add('text-ink-soft');
      if (p.outputSummary) {
        const out = card.querySelector('.t-out');
        // deny 通道正文带 SDK 加的 "Error:" 前缀（非真错误），剥掉只留语义文本
        const raw = p.denyKind ? p.outputSummary.replace(/^Error:\s*/i, '') : p.outputSummary;
        const code = out.querySelector('code') || out;
        // Task 清单工具结果 → ☐/◐/☒ 清单文本（deny/报错走通用路径保留原文）
        const taskText = (!p.denyKind && p.ok) ? renderTaskToolResultText(card.dataset.toolName, raw) : null;
        code.textContent = taskText ?? formatToolSummary(raw);
        try { if (!taskText && code !== out) hljs.highlightElement(code); } catch { /* 高亮失败不影响显示 */ }
        if (taskText) card.open = true; // 清单即结果本体，收起就白渲染了（对齐 CLI 面板可见性）
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
      // FE-002：优先 clientMessageId；纯附件无 .whitespace-pre-wrap 时按附件名集合匹配。
      const pendingBubbles = [...messagesEl.querySelectorAll('.opacity-70')];
      let matchedBubble = null;
      const attNames = Array.isArray(p.attachments)
        ? p.attachments.map(a => a?.name).filter(Boolean).sort().join('\0')
        : '';
      for (const b of pendingBubbles) {
        if (p.clientMessageId && b.dataset.clientMessageId === p.clientMessageId) {
          matchedBubble = b;
          break;
        }
        const tDiv = b.querySelector('.whitespace-pre-wrap');
        if (tDiv && p.text && tDiv.textContent === p.text) {
          matchedBubble = b;
          break;
        }
        // 纯附件（无文本）占位：用 data-att-names 对齐
        if (!p.text && attNames && b.dataset.attNames === attNames) {
          matchedBubble = b;
          break;
        }
      }

      if (matchedBubble) {
        matchedBubble.classList.remove('opacity-70');
        matchedBubble.querySelector('.pending-indicator')?.remove();
        // FE-005：离线占位曾是纯 textContent——确认时升级为与历史一致的 markdown 渲染（保留附件区）
        if (p.text && !matchedBubble.classList.contains('um')) {
          const attWrap = matchedBubble.querySelector('.flex.flex-wrap');
          matchedBubble.innerHTML = render(p.text);
          matchedBubble.classList.add('msg-body', 'um');
          if (attWrap) matchedBubble.appendChild(attWrap);
          matchedBubble.querySelectorAll('pre code').forEach(b => {
            try { hljs.highlightElement(b); } catch { /* ignore */ }
          });
          injectCodeCopyButtons(matchedBubble);
          foldLongUserBubble(matchedBubble, p.text);
        }

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
            wrap.appendChild(buildAttachmentNode(a));
          }
          if (wrap) matchedBubble.appendChild(wrap);
        }
        if (p.text && !matchedBubble.querySelector('[data-copy-action]')) {
          appendCopyAction(matchedBubble, () => p.text, 'right');
        }
        scrollBottom(true);
        return; // 匹配成功，直接返回，避免生成重复聊天气泡
      }

      const bubble = el(`<div class="msg-frame rounded-xl bg-user text-ink px-3 py-2 text-sm" data-testid="user-message"></div>`);
      bubble.dataset.topLevel = '1'; // 未读角标锚点定位用：user_message 在线新建分支（离线占位分支在 send() 创建时已挂，这里走 matchedBubble 复用不重复创建）
      // 排队撤回/标记转正都按 clientMessageId 定位气泡（离线占位分支已挂，此处补齐在线新建分支）
      if (p.clientMessageId) bubble.dataset.clientMessageId = p.clientMessageId;
      if (p.text) {
        // FE-005：与历史路径一致——marked + DOMPurify，避免「发出去纯文本 / 回来看变 markdown」观感分裂。
        bubble.innerHTML = render(p.text);
        bubble.classList.add('msg-body', 'um');
        bubble.querySelectorAll('pre code').forEach(b => {
          try { hljs.highlightElement(b); } catch { /* 高亮失败不影响显示 */ }
        });
        injectCodeCopyButtons(bubble);
        foldLongUserBubble(bubble, p.text);
      }
      if (Array.isArray(p.attachments) && p.attachments.length) {
        bubble.appendChild(buildAttachmentWrap(p.attachments, Boolean(p.text)));
      }
      if (p.text) appendCopyAction(bubble, () => p.text, 'right');
      appendMessage(bubble);
      scrollBottom(true);
    },
    permission_request(p) {
      // 幂等：sync:since 切入补发的 pending 快照可能与 buffer 回放的原始事件同 requestId → 只保留一份
      if (approvals.isDuplicatePermission(p.requestId)) return;
      alertCue('need');
      approvals.enqueuePermission(p);
      // FE-NEW-002：JSON.stringify(undefined) 为 undefined，.slice 抛错会中断 handler（verify 也不跑）
      // sensitive：正文是工具入参原文（Bash 的 command、Write 的 file_path/content 头部）。
      // 预览开关关闭时 notify 只保留标题，与 Web Push / ntfy 两条通道的隐私口径对齐。
      notify(t('⚠️ 等待审批'), `${p.name}：${safeJsonPreview(p.input, 80)}`, { sensitive: true });
      approvals.verifyPermIntegrity(p); // 异步、不阻塞渲染——NFR-17 协议步骤4，核验结果稍后到达时若仍是当前卡片才提示
    },
    question(p) {
      // 幂等：同上（快照补发 vs buffer 回放去重），按 requestId
      // 含「已本地作答/已收 request_resolved」判定：忽略重放（切会话、probe、整页刷新后的 sync）
      if (approvals.isDuplicateQuestion(p.requestId)) return;
      alertCue('need');
      approvals.enqueueQuestion(p);
      // FE-003：text 可能缺失/非字符串（畸形 AskUserQuestion / SDK 漂移），slice 会抛并中断 handler。
      const qPreview = typeof p.text === 'string' ? p.text : (p.text == null ? '' : String(p.text));
      notify(t('❓ 需要选择'), qPreview.slice(0, 80), { sensitive: true }); // 问题正文同属预览开关管辖
    },
    // M4：审批/选题完成后广播，多设备或重放缓冲时关闭陈旧弹窗
    request_resolved(p) {
      const { requestId, kind } = p;
      if (kind === 'permission') {
        // NFR-17：完整性校验失败是服务端 fail-closed 介入，不是用户的选择——若用户刚点了"允许"，
        // answerPerm() 已乐观显示过"✅ 已允许"（activePerm 早已本地清空，下面的分支找不到它，无从
        // 事后订正）。这里补一条独立提示，避免用户以为操作已生效、实际却被悄悄拦下。
        if (p.outcome === 'integrity_mismatch') {
          addBar(t('⚠️ 完整性校验未通过，该操作已被服务端拒绝执行（并非您的选择生效）'), 'text-danger');
        }
        approvals.resolvePermission(requestId);
        updateSendButtonState();
      } else if (kind === 'question') {
        approvals.resolveQuestion(requestId);
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
      // turn-end 文件变更汇总卡（对齐官方「已编辑 N 个文件」；完整 diff 仍走单卡预览）
      const fileChangesCard = flushTurnFileChangesCard();
      _pendingSendBusySessionId = null;
      setBusy(false);
      // 发送闸解锁：事件流是权威且必达的那条通道，instances 广播只作校正。
      // 只靠广播清会留死锁——广播丢一次/某条路径压根不广播，用户就永远发不出下一条了。
      _turnRunning = false;
      updateSendButtonState();
      hideActivityBanner(); // 会话结束隐藏活动横幅
      // 不在此隐藏后台任务进度横幅：后台任务（Workflow/后台 Agent/Bash）跨轮次存活，轮次 result ≠ 后台完成。
      // 横幅生命周期交给 task_progress（下拍心跳 showTaskProgress 重现）与 task_notification（完成时 hideTaskProgress）自洽驱动。
      // 对齐 CLI：用户主动中止时 SDK 常带 is_error + ede_diagnostic；interrupted 优先，不当红色错误展示。
      const ui = presentTurnResult(p);
      logClientEvent('recv', `[WEB_RECV] ${ui.statusBar.text}`); // send↔recv 对账：turn 结果在客户端到达
      if (ui.failToolsMessage) failPendingToolCards(ui.failToolsMessage);
      agentToolIds.clear(); // 清理 Agent 工具 ID 跟踪
      alertCue(ui.haptic); // success / warning / error：音+震（各自开关门控）
      addBar(ui.statusBar.text, ui.statusBar.cls);
      if (ui.errorBar) addBar(ui.errorBar.text, ui.errorBar.cls);
      notify(ui.notify.title, ui.notify.body, { force: alerts.preferences().foregroundComplete });
      // P0：回合末锚定——有文件汇总卡则滚到卡（手机扫结果）；否则落底
      if (resolveTurnEndScroll({ hasFileChangesCard: Boolean(fileChangesCard) }) === 'file-changes' && fileChangesCard?.isConnected) {
        try { fileChangesCard.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch { scrollBottom(true); }
      } else {
        scrollBottom(true);
      }

      // 防御性清理当前 tab 的挂起提问和审批
      approvals.clearAll();
      updateSendButtonState();
    },
    error(p) {
      finalizeStreams();
      const errFileCard = flushTurnFileChangesCard(); // 出错前若已改盘，仍给汇总
      failPendingToolCards(p.message);
      alertCue('error');
      hideLoadingCard(); // resume 失败等路径：避免「正在加载会话…」与红条叠屏
      addBar(`⚠️ ${p.message}`, 'text-danger');
      _pendingSendBusySessionId = null;
      setBusy(false);
      hideActivityBanner();
      if (resolveTurnEndScroll({ hasFileChangesCard: Boolean(errFileCard) }) === 'file-changes' && errFileCard?.isConnected) {
        try { errFileCard.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch { scrollBottom(true); }
      }

      // 防御性清理当前 tab 的挂起提问和审批
      approvals.clearAll();
      updateSendButtonState();
    },
    // M7：改用 kind 字段判断中断，不靠字符串匹配（字符串会随 i18n 变化）
    system(p) {
      addBar(p.message, systemBarClass(p));
      // 中止成功 / 「无可中断任务」失败回执：都必须清 interruptPending（限流重试中点停止的卡死修复）
      if (shouldClearInterruptPendingOnSystem(p)) {
        clearInterruptPending(viewingInstanceId, { keepLiveOverride: p.kind === 'interrupted' });
      }
      if (p.kind === 'interrupted') {
        finalizeStreams();
        // E3：interrupt 成功/settleForce 走 system interrupted 时没有 result，须收口工具卡与子 agent 卡
        failPendingToolCards(t('已中止'));
        markAllSubagentCardsDone();
        _pendingSendBusySessionId = null;
        setBusy(false);
        _turnRunning = false; // 中止也是轮次终点：与 result 同样解锁发送闸，不等 instances 广播
        updateSendButtonState();
        hideActivityBanner();
        // 全新会话首轮点停止后不跳回主页：sessionId 仍未到（displayedSessionId 空）时被中断，标记当前
        // 实例——resolveEmptySurface/shouldShowComposer 据此不再把"sessionId 为空"误判成该显启动页。
        // 已有 sessionId 的正常中断（displayedSessionId 非空）不置位，且顺带清掉任何过期残留。
        freshInterruptedInstanceId = (displayedInstanceId && !displayedSessionId) ? displayedInstanceId : null;
      }
      // 停止时尚未送达 SDK 的消息落终态（live + buffer 回放共用同一路径，多设备视图一致）
      if (p.kind === 'queue_dropped' && Array.isArray(p.clientMessageIds)) {
        markMessageDropped(p.clientMessageIds, t('已随停止取消，未发送'));
      }
    },
    // E16：web 自有结构化状态（非 ANSI）。摘要去 emoji，展开分段构建 DOM（createElement+textContent，
    // 不经 innerHTML/DOMPurify，天然 XSS 安全）；服务端未启用则此事件不来，容器恒 hidden
    status_line(p) {
      if (!p || typeof p !== 'object') return;
      // 守护：如果 payload 里的 instanceId 与前端当前的 viewingInstanceId 不一致，则丢弃渲染（防止旧 tab 覆盖）
      if (p.instanceId && viewingInstanceId && p.instanceId !== viewingInstanceId) return;
      // 兼容陈旧重放：老 payload 可能没有 instanceId，但仍带 cwd；用 cwd 兜底防止别的工作区状态线覆盖当前视图。
      if (!p.instanceId && p.cwd && currentCwd && p.cwd !== currentCwd) return;
      // 顶栏 pill 改动角标：复用上面两道同源守护（防跨工作区串号），但**必须在下面两处早退之前**更新
      // ——`!cliStatusEl`（statusline 容器缺失）与 `empty-start`（空启动页）都与角标无关，角标挂在顶栏
      // 而非状态栏里，不该被状态栏的存在与否绑架。
      updateWorkspaceChangeBadge(p.git);
      if (!cliStatusEl) return;
      // per-turn 权威秒表/token（agent.turnStartedAt/turnOutputTokens）：刷新/切实例回来后 live 行恢复真值
      if (p.turn && liveLine) {
        liveLine.serverTurnStartedAt = Number(p.turn.startedAt) || null;
        liveLine.outTokens = Number(p.turn.outTokens) || null;
        renderLiveLine();
      }
      // 空启动页采用极简底部：模型/权限/思考 chips 即可，statusLine 进入消息流后再显示。
      if (messagesEl.classList.contains('empty-start')) return;
      // 与 statuslineFmtTok 同边界：round 到 k 后 ≥1000 抬 m，避免 1000k
      const fmtTok = n => {
        if (n >= 1e6) return (n / 1e6).toFixed(1) + 'm';
        if (n >= 1e3) { const k = Math.round(n / 1e3); return k >= 1000 ? (k / 1000).toFixed(1) + 'm' : k + 'k'; }
        return String(n);
      };
      const fmtMs = ms => { const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60; return h ? `${h}h${String(m).padStart(2, '0')}m` : m ? `${m}m${String(x).padStart(2, '0')}s` : `${x}s`; };
      // F2：带 1 位小数；≥1000.0k 抬 m，避免 1000.0k
      const fmtTokF = n => {
        if (n >= 1e6) return (n / 1e6).toFixed(1) + 'm';
        if (n >= 1e3) {
          const k = n / 1e3;
          if (k >= 1000) return (k / 1000).toFixed(1) + 'm';
          return k.toFixed(1) + 'k';
        }
        return String(n);
      };
      // 额度重置倒计时：ISO resets_at → 相对时长（对齐 CLI statusline `reset 2h05m`）
      const fmtReset = iso => {
        if (!iso) return '';
        const parsed = Date.parse(iso);
        if (!Number.isFinite(parsed)) return '';
        const rem = Math.max(0, parsed - Date.now());
        if (rem <= 0) return 'now';
        const totalMins = Math.ceil(rem / 60_000);
        const days = Math.floor(totalMins / 1440), hours = Math.floor((totalMins % 1440) / 60), mins = totalMins % 60;
        if (days > 0) return `${days}d${hours}h${String(mins).padStart(2, '0')}m`;
        if (hours > 0) return `${hours}h${String(mins).padStart(2, '0')}m`;
        return `${mins}m`;
      };
      // 折叠摘要：git · ctx（模型/effort 已在底栏 pill）；展开仍有 CLI 全量
      lastStatusLinePayload = p;
      if (cliSummaryEl) cliSummaryEl.textContent = formatStatuslineCollapsedSummary(p);
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
      // 额度段公共构建（对齐 CLI）：5h X% [reset …] │ 7d Y% [reset …]。抽成函数供两处复用——
      // 正常态尾段（行B，下方）与 cli-unavailable 分支（账号级回落值展示）共享同一份文案/配色
      // 规则，避免后续只改一处、漏改另一处。
      const buildRateSegs = rate => {
        const segs = [];
        if (rate?.fiveHour && Number.isFinite(rate.fiveHour.usedPercent)) {
          const pc = rate.fiveHour.usedPercent;
          let label = `5h ${Math.round(pc)}%`;
          const r = fmtReset(rate.fiveHour.resetsAt);
          if (r) label += ` reset ${r}`;
          segs.push({ text: label, cls: pc >= 90 ? 'text-danger' : pc >= 70 ? 'text-warning' : 'text-info' });
        }
        if (rate?.sevenDay && Number.isFinite(rate.sevenDay.usedPercent)) {
          const pc = rate.sevenDay.usedPercent;
          let label = `7d ${Math.round(pc)}%`;
          const r = fmtReset(rate.sevenDay.resetsAt);
          if (r) label += ` reset ${r}`;
          segs.push({ text: label, cls: pc >= 90 ? 'text-danger' : pc >= 70 ? 'text-warning' : 'text-info' });
        }
        return segs;
      };
      const linesArr = [];

      if (p.source?.kind === 'cli-unavailable') {
        cliStatusEl.textContent = '';
        const unavailable = document.createElement('div');
        unavailable.className = 'flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5';
        unavailable.appendChild(span(t('CLI 状态暂不可用'), 'text-warning font-medium'));
        if (p.source.reason) unavailable.appendChild(span(`(${p.source.reason})`, 'text-ink-faint'));
        cliStatusEl.appendChild(unavailable);
        // 额度是唯一例外：仅当 rateFromSnapshot 显式标记为账号级快照回落值时才展示，且必须清楚
        // 标注"非实时"——不能让用户误以为 CLI 状态本身是好的。其余字段（model/git/ctx/token/cache
        // 等）仍严格遵守下面 return 处的注释、绝不混入陈旧字段，此处不因为顺手展示额度而放宽。
        const staleRateSegs = (p.rate && p.rateFromSnapshot) ? buildRateSegs(p.rate) : [];
        if (staleRateSegs.length) {
          staleRateSegs.push({ text: t('(账号级旧值，非实时)'), cls: 'text-ink-faint' });
          const staleRateRow = row(staleRateSegs);
          if (staleRateRow) cliStatusEl.appendChild(staleRateRow);
        }
        lastStatusLinePayload = p;
        if (cliSummaryEl) cliSummaryEl.textContent = staleRateSegs.length ? t('statusline · CLI 暂不可用（额度沿用旧值）') : t('statusline · CLI 暂不可用');
        cliStatusWrapEl?.classList.remove('hidden');
        return; // CLI owner 缺/陈旧时明确空缺，绝不把上一份 SDK/CLI 字段混进来（额度回落值是唯一例外，见上）
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
      // ctx 段：有 usedPercent → 'ctx X% · left Y/Z'（Y=剩余 Z=窗口总量，对齐本机 CLI statusline.sh 里
      // elif 分支已用的 '/' 记法，这里扩展到有百分比的分支）；否则退回绝对 token 数（认不出 model 的窗口）。
      // left 走 formatStatuslineCtxLeft：优先 totalTokens（与 usedPercent 同源），避免 lastUsage=0 假 1.0m/1.0m。
      let ctxSeg = null;
      if (p.ctx && Number.isFinite(p.ctx.usedPercent)) {
        let txt = `ctx ${p.ctx.usedPercent}%`;
        const left = formatStatuslineCtxLeft(p.ctx);
        if (left) txt += ` · ${left}`;
        const pc = p.ctx.usedPercent; // 蓝(健康)→橙(≥70)→红(≥90) 三段警示
        ctxSeg = { text: txt, cls: pc >= 90 ? 'text-danger' : pc >= 70 ? 'text-warning' : 'text-ink-soft' }; // UI-011 数据色非链接蓝
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
        tokenNode = span(`uncached ${fmtTokF(p.ctx.in)} response ${fmtTokF(p.ctx.out || 0)}`, 'text-ink-soft');
      }
      // cache 明细段（对齐 CLI）：cache <命中率>.XX% write <cache写> read <cache读>；命中率按 r/tokens 重算 2 位小数
      let cacheNode = null;
      if (p.ctx && Number.isFinite(p.ctx.w) && Number.isFinite(p.ctx.r)) {
        const rate = formatCachePercent(p.ctx.tokens > 0 ? (p.ctx.r / p.ctx.tokens) : 0);
        cacheNode = document.createElement('span');
        cacheNode.appendChild(span(`cache ${rate}`, 'text-ink-soft'));
        cacheNode.appendChild(document.createTextNode(' '));
        cacheNode.appendChild(span(`write ${fmtTokF(p.ctx.w)} read ${fmtTokF(p.ctx.r)}`, 'text-ink-faint'));
      }
      // 额度段（对齐 CLI）：5h X% [reset …] │ 7d Y% [reset …]。构建逻辑见上方 buildRateSegs
      // （与 cli-unavailable 分支共用，避免重复实现两遍）。
      // rateFromSnapshot：正常路径也必须标注"非实时"——否则 SDK/CLI 回落值会看起来像活数据
      // （code review：此前只在 cli-unavailable 分支加了 disclaimer，正常行漏标）。
      const rateSegs = buildRateSegs(p.rate);
      if (rateSegs.length && p.rateFromSnapshot) {
        rateSegs.push({ text: t('(账号级旧值，非实时)'), cls: 'text-ink-faint' });
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
    const btn = el(`<button type="button" class="text-info underline text-[11px]" data-testid="tool-expand-full">${t('展开全文')}</button>`);
    const inst = viewingInstanceId;
    btn.onclick = () => {
      btn.disabled = true;
      btn.textContent = t('加载中…');
      socket.emit('tool:full', { instanceId: inst, toolUseId }, res => {
        if (!res?.ok) {
          btn.textContent = res?.error || t('全文不可用');
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
  // 丢弃 streams（切视图/整窗替换场景，不同于 finalizeStreams 的"收尾定稿"）：必须先清各条目挂着的
  // _mdTimer 节流定时器再清 Map——否则残留定时器稍后触发，往已不在 #messages 里的旧 DOM 节点写内容，
  // 还会调用 scrollBottom() 误滚动当前正显示的（无关）会话。
  function clearStreams() {
    for (const s of streams.values()) {
      if (s._mdTimer) { clearTimeout(s._mdTimer); s._mdTimer = null; }
    }
    streams.clear();
  }
  function getStream(id) {
    const key = id || '_';
    let s = streams.get(key);
    if (!s) {
      // UX-004：直接 msg-body 容器，流式走 innerHTML=render，不再用纯文本 textNode 裸显 markdown
      const wrap = el(`<div class="msg-frame msg-body px-0.5" data-testid="assistant-message" aria-live="polite"></div>`);
      wrap.dataset.topLevel = '1'; // 未读角标锚点定位用：仅主链 assistant 流式气泡（子agent走 getSubagentStream，不经过这里）
      appendMessage(wrap);
      s = { el: wrap, raw: '', done: false };
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
    for (const th of thinkings.values()) th.el?.classList.remove('thinking-live');
    thinkings.clear();
    scrollBottom();
  }
  function getThinking(id) {
    const key = id || '_';
    let entry = thinkings.get(key);
    if (!entry) {
      const wrap = el(`
        <details class="msg-frame thinking rounded-lg bg-surface border border-line-soft text-xs text-ink-faint">
          <summary class="px-3 py-1.5">${t('💭 思考过程')}</summary>
          <pre class="t-body px-3 pb-2 whitespace-pre-wrap"></pre>
        </details>`);
      const body = document.createTextNode('');
      wrap.querySelector('.t-body').appendChild(body);
      wrap.classList.add('thinking-live'); // UX-016
      appendMessage(wrap);
      entry = { body, el: wrap };
      thinkings.set(key, entry);
      scrollBottom();
    }
    return entry;
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
    let entry = sa.thinkings.get(key);
    if (!entry) {
      const wrap = el(`
        <details class="thinking rounded-lg bg-sunk/40 border border-line-soft text-xs text-ink-faint">
          <summary class="px-2 py-1">${t('💭 思考过程')}</summary>
          <pre class="t-body px-2 pb-1 whitespace-pre-wrap"></pre>
        </details>`);
      const body = document.createTextNode('');
      wrap.querySelector('.t-body').appendChild(body);
      sa.body.appendChild(wrap);
      entry = { body };
      sa.thinkings.set(key, entry);
    }
    return entry;
  }

  // turn-end：把本轮主会话写盘工具聚合成「已编辑 N 个文件」卡（对齐官方汇总；无撤销）。
  // 完整 diff 仍走 tool:preview；点文件行按需拉 hunk 内嵌展示。
  function flushTurnFileChangesCard() {
    const summary = summarizeTurnFileChanges(turnFileChanges);
    turnFileChanges = new Map();
    if (!summary) return null;
    const inst = viewingInstanceId;
    const card = el(`
      <div class="msg-frame turn-file-changes rounded-xl border border-line bg-surface overflow-hidden" data-testid="turn-file-changes">
        <div class="flex items-center gap-2 px-3 py-2.5 border-b border-line-soft">
          <div class="w-8 h-8 rounded-lg bg-sunk flex items-center justify-center text-ink-soft shrink-0" aria-hidden="true">
            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"/></svg>
          </div>
          <div class="min-w-0 flex-1">
            <div class="text-xs font-semibold text-ink tfc-title"></div>
            <div class="text-[11px] tabular-nums tfc-stats"><span class="text-success"></span> <span class="text-danger"></span></div>
          </div>
          <button type="button" class="tfc-git-btn shrink-0 px-2 py-1 rounded-lg border border-line text-[11px] text-ink-soft hover:bg-sunk active:scale-95" data-testid="turn-file-git">${t('工作区')}</button>
        </div>
        <div class="tfc-list divide-y divide-line-soft"></div>
      </div>`);
    card.querySelector('.tfc-title').textContent = summary.title;
    const gitBtn = card.querySelector('.tfc-git-btn');
    if (gitBtn) {
      gitBtn.onclick = () => {
        haptic('tap');
        // 上下文直达：本轮刚改完文件，直接落到「改动」tab（而非默认的「文件」tab）
        if (typeof openWorkspacePanel === 'function' && currentCwd) openWorkspacePanel(currentCwd, 'changes');
      };
    }
    const statsEl = card.querySelector('.tfc-stats');
    statsEl.children[0].textContent = `+${summary.added}`;
    statsEl.children[1].textContent = `-${summary.removed}`;
    const list = card.querySelector('.tfc-list');
    for (const f of summary.files) {
      const row = el(`
        <div class="tfc-row" data-testid="turn-file-row">
          <button type="button" class="tfc-row-btn w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-sunk/60 active:bg-sunk transition-colors">
            <span class="tfc-name flex-1 min-w-0 truncate text-xs text-ink font-medium"></span>
            <span class="tfc-file-stats shrink-0 text-[11px] tabular-nums"><span class="text-success"></span> <span class="text-danger"></span></span>
          </button>
          <div class="tfc-preview hidden px-3 pb-2 space-y-1 text-[11px]"></div>
        </div>`);
      row.querySelector('.tfc-name').textContent = f.baseName;
      row.querySelector('.tfc-name').title = f.path;
      const fs = row.querySelector('.tfc-file-stats');
      fs.children[0].textContent = `+${f.added}`;
      fs.children[1].textContent = `-${f.removed}`;
      const btn = row.querySelector('.tfc-row-btn');
      const preview = row.querySelector('.tfc-preview');
      let loaded = false;
      btn.onclick = () => {
        preview.classList.toggle('hidden');
        if (loaded || !f.toolUseId) return;
        loaded = true;
        socket.emit('tool:preview', { instanceId: inst, toolUseId: f.toolUseId }, res => {
          preview.replaceChildren();
          if (!res?.ok) {
            const m = el(`<div class="${res?.inWhitelist === false ? 'text-danger' : 'text-ink-faint'}"></div>`);
            m.textContent = res?.error || t('预览不可用');
            preview.appendChild(m);
            return;
          }
          if (res.attribution) {
            const lab = el(`<div class="text-ink-faint"></div>`);
            lab.textContent = `📁 ${res.attribution.workdirLabel} / ${res.attribution.relPath}`;
            preview.appendChild(lab);
          }
          if (res.diff) {
            renderToolDiff(preview, res.diff);
          } else {
            const m = el(`<div class="text-ink-faint"></div>`);
            m.textContent = t('无 diff 详情（可到对应工具卡查看）');
            preview.appendChild(m);
          }
        });
      };
      list.appendChild(row);
    }
    appendMessage(card);
    scrollBottom();
    return card;
  }

  // 审批 / 选择题两个弹窗的完整状态机（当前卡片、展开按钮、ExitPlanMode 档位、多选下标、指纹不符集合
  // 与两窗自己的 DOM 引用）已整体归 app/approval-questions.js 所有；此处只做接线。
  // 落位保持在原代码位置：addBar/render/el/haptic 都是 const，须在其声明之后接线。
  const approvals = createApprovalController(appContext, {
    queues: interactionState,
    $, el, render, addBar, haptic, socket,
    permModal, questionModal,
    openSheet, closeSheet, requestInterrupt, updateSendButtonState,
    getViewingInstanceId: () => viewingInstanceId,
  });

  // ---- 发送 / 停止 ----
  function send() {
    ensureAlertAudio(); // 发送=用户手势：解锁 WebAudio，本轮完成后提示音才能响
    if (mirrorReadonlySid) { // 只读追平中：硬拦截，防与终端并发写盘分叉（点发送位「续接 CLI 会话」）
      showMirrorComposerHint();
      return;
    }
    if (inputEl.disabled) {
      addBar(t('请先完成设备授权或解除只读状态，再发送新消息'), 'text-info');
      return;
    }
    // 上一条还没收到 ack 前挡新的一次触发：双击 Send 在首条 ack 前会发出两条不同 clientMessageId。
    // 离线入队不走此闸（无在途 SDK turn，本地乐观消息允许多条）。
    if (socket.connected && _sendInFlightSessionIds.has(displayedSessionId)) {
      return;
    }
    // 在途轮拒收（排队已移除）：正常路径下按钮已是停止钮点不到这里，这道闸兜住键盘回车/竞态。
    if (_turnRunning) {
      addBar(t('当前任务运行中，完成后可发送'), 'text-info');
      return;
    }
    if (approvals.hasPending()) {
      addBar(t('请先处理当前审批或选择，再发送新消息'), 'text-info');
      return;
    }
    const rawText = inputEl.value.trim();
    // ultracode 走 SDK Settings.ultracode + xhigh，不再往用户正文塞关键词（透传）
    const text = rawText;
    if (!text && attachments.items().length === 0) return; // E17：纯附件（空文本）也可发
    // /model 前端拦截——TUI 命令不可透传，映射到 F1 模型切换通道（下一条消息经 setModel 生效）。
    // 纯本地操作，置于断线检查之前；若未来 CLI 把 model 纳入 slash_commands 则让位透传。
    if (/^\/model(\s|$)/.test(rawText) && !(window.availableSkills || []).includes('model')) {
      const arg = rawText.slice(6).trim();
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
        // value=default 是 CLI /model 「不 pin」语义：对齐 tile 点击路径，select 置空，
        // 不把字面 'default' 写进 select（否则发消息会带 model:'default' 让后端误 setModel 字面值）。
        if (nakedArg === 'default') {
          currentGatewaySuffix = '';
          delete modelInput.dataset.fullModel;
          modelInput.value = '';
          syncModelUI('');
          addModeBar(t('模型已重置为默认（下一条消息生效）'), 'text-info');
        } else {
          ensureModelOption(nakedArg, t('手动设置')); // select 候选外的任意名（如网关别名）动态插入
          modelInput.value = nakedArg;
          syncModelUI(nakedArg);
          addModeBar(`${t('模型已设为')} ${nakedArg}${currentGatewaySuffix}${t('（下一条消息生效）')}`, 'text-info');
        }
      } else {
        const pending = modelInput.value.trim();
        const opts = [...modelInput.options].map(o => o.value).filter(Boolean);
        addBar(`${t('当前模型：')}${currentModel || t('默认')}${currentGatewaySuffix}${pending && pending !== currentModel ? `${t('；下一条消息起：')}${pending}${currentGatewaySuffix}` : ''}${opts.length ? `${t('；可选：')}${opts.join(t('、'))}` : ''}`, 'text-info');
      }
      inputEl.value = '';
      hints.classList.add('hidden');
      autosize();
      return;
    }
    // 原样转发 select；空/default → undefined（CLI 不 pin）
    let model = resolveSendModel({
      selectValue: modelInput.value,
      fullModel: modelInput.dataset.fullModel || '',
      modelsList,
    });
    // S5：仅对「不在 supportedModels 候选里的自设名」(如 /model 手设并剥离了后缀的) 回贴网关后缀。
    // 候选内的值本就是网关合法完整名(裸别名 opus/sonnet 或显式 deepseek-v4-pro[1m])，原样发送。
    // 判据必须同时认 value 与 resolvedModel：resolveSendModel 自 7febabc 起返回的是 **wire**
    // （entry.resolvedModel），只比 value 会让守卫恒失效、每次选模型都送出 grok-4.5[1m][1m]。
    model = applyGatewaySuffix(model, currentGatewaySuffix, modelsList);
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
      addBar(`${t('消息过长')} (${text.length}/50000)${t('，未发送')}`, 'text-danger');
      return;
    }

    // M2 / Weak Network Optimistic Sending Queue:
    if (!socket.connected) {
      // 离线状态：生成乐观消息气泡占位符，保存到离线重发队列，待重连后自动重发
      haptic('tap');
      const bubble = el(`<div class="msg-frame rounded-xl bg-user text-ink px-3 py-2 text-sm opacity-70 transition-opacity"></div>`);
      // 未读角标锚点定位用：离线占位气泡是唯一"在线 user_message 到达前就存在"的顶层气泡创建点——
      // matchedBubble 命中时是原地复用这个节点（见 handle.user_message），不会重新创建，故必须在这里打标记。
      bubble.dataset.topLevel = '1';
      // FE-002：挂 clientMessageId + 附件名指纹，供 user_message 回放精确匹配（含纯附件无文本）
      bubble.dataset.clientMessageId = clientMessageId;
      if (outgoingAttachments?.length) {
        bubble.dataset.attNames = outgoingAttachments.map(a => a?.name).filter(Boolean).sort().join('\0');
      }
      if (text) {
        const textNode = el(`<div class="whitespace-pre-wrap"></div>`);
        textNode.textContent = text;
        // 离线乐观占位符气泡也折叠（与已确认气泡一致，长指令发出去那刻就折）
        foldLongUserText(textNode, text);
        bubble.appendChild(textNode);
      }
      
      // 添加离线待发送的附件缩略 chip/图片预览，让离线体验达到原生级；
      // controller items 含完整 data → buildAttachmentNode 点击直开本地预览（无需服务端）
      if (outgoingAttachments && outgoingAttachments.length) {
        bubble.appendChild(buildAttachmentWrap(attachments.items(), Boolean(text)));
      }
      
      const indicator = el(`<div class="pending-indicator text-[11px] text-ink-faint mt-1 animate-pulse">${t('🕐 正在等待连接...')}</div>`);
      bubble.appendChild(indicator);
      appendMessage(bubble);
      
      enqueueOutbox({
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

    if (text.startsWith('/')) addBar(`${t('⚡ 命令：')}${text}`, 'text-info');
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {});
    }

    // 台阶3：instanceId 路由到当前查看 tab；cwd 供无 tab（首发/session:new 后）时服务端懒开实例
    const attCount = Array.isArray(outgoingAttachments) ? outgoingAttachments.length : 0;
    logClientEvent('send', `[WEB_SEND] 发送消息: "${text.slice(0, 100)}${text.length > 100 ? '...' : ''}" (${text.length} 字符), model=${model || '未指定(沿用)'}, 附件数=${attCount}, instanceId=${viewingInstanceId || 'new'}`);
    // FE-004：发出即置位，ack 一回来（或到点兜底）就解锁——用真实回执判定"这条是否已被服务端收到"，
    // 不猜时长；服务端/mock 的 ack 都是收到就回，不等整轮 turn 跑完，正常网络下几乎瞬时清零。
    // 负 ack 须可见：旧实现把回调当 clearSendInFlight 忽略 payload → 队列满/stale 像「发送失败无反馈」。
    // WS-003：捕获发起时的视图目标（代次），对齐 WS-001/WS-002——ack 延迟到达期间用户可能已切到别的
    // 会话/实例，届时 setBusy/addBar/草稿回填这些「作用于当前视图」的副作用不该套到无关会话上。
    // 按会话登记在途态（而非裸全局布尔）：切到另一会话发消息不该被这条送出的等待窗口阻塞。
    const reqInstanceId = displayedInstanceId, reqSessionId = displayedSessionId;
    const reqCwd = currentCwd;
    const reqViewingInstanceId = viewingInstanceId;
    _sendInFlightSessionIds.add(reqSessionId);
    const clearSendInFlight = () => {
      if (!_sendInFlightSessionIds.has(reqSessionId)) return;
      _sendInFlightSessionIds.delete(reqSessionId);
      clearTimeout(sendInFlightTimer);
      updateSendButtonState();
      // 让「正在发送…」立刻切回 spinner，不必等下一次 1s ticker
      if (liveLine) renderLiveLine();
    };
    // 失败时恢复草稿：send 会先清空输入；仅当输入仍空才回填，避免覆盖用户已键入的下一条。
    // requeue 路径不回填（消息进 outbox）。
    const restoreDraftOnFail = { text, attachments: outgoingAttachments };
    const outboxPayload = {
      text,
      model,
      attachments: outgoingAttachments,
      clientMessageId,
      instanceId: reqViewingInstanceId,
      cwd: reqCwd,
    };
    const sendInFlightTimer = setTimeout(clearSendInFlight, SEND_ACK_FALLBACK_MS); // 兜底：ack 真丢了也不永久卡死
    // 在线也走 timeout：half-open / 中途断连时 err 回调 → 入 outbox，不再静默丢字
    socket.timeout(SEND_ACK_FALLBACK_MS).emit(
      'user:message',
      { text, model, attachments: outgoingAttachments, instanceId: reqViewingInstanceId, cwd: reqCwd, clientMessageId },
      (err, ack) => {
      clearSendInFlight();
      const decision = presentOnlineSendTransport(err, ack);
      if (decision.ok) {
        // 乐观置位：服务端已收下这条、轮次即将开跑，但 instances 广播还在路上。
        // 不等广播就锁住发送闸，关掉「ack 已回、广播未到」这个还能再发一条的窄窗。
        if (displayedInstanceId === reqInstanceId && displayedSessionId === reqSessionId) {
          _turnRunning = true;
          updateSendButtonState();
        }
        return;
      }
      // 只清自己这条送出的登记：若这条负 ack 迟到，槽位可能已被之后另一条 send() 的登记顶替
      // （比如很快切到别的会话又发了一条），不能连带清掉那条仍然合法在途的登记。
      if (_pendingSendBusySessionId === reqSessionId) _pendingSendBusySessionId = null;
      _pendingFirstSend = false;
      logClientEvent('send', `[WEB_SEND] 在线发送未确认：${decision.message || ack?.error || err?.message || 'unknown'}`);
      if (decision.requeue) {
        enqueueOutbox(outboxPayload);
        // 视图仍在本会话时提示已排队；切走则静默入队
        if (displayedInstanceId === reqInstanceId && displayedSessionId === reqSessionId) {
          if (decision.clearBusy) setBusy(false);
          if (decision.message) addBar(decision.message, 'text-danger');
        }
        // 长连接 timeout 入队后若仍 connected，不能只等 reconnect（J1）
        if (socket.connected) setTimeout(() => { try { processOfflineQueue(); } catch { /* noop */ } }, 500);
        return;
      }
      // WS-003：迟到负 ack 守卫——发起后若已切到别的会话/实例，本次发送的失败反馈不该出现在当前视图上
      // （错误提示会贴到无关会话、setBusy(false) 会打断无关会话真实在跑的轮次、草稿会覆盖无关会话的输入）。
      if (displayedInstanceId !== reqInstanceId || displayedSessionId !== reqSessionId) return;
      if (decision.clearBusy) setBusy(false);
      // busy 拒收：服务端说那边有轮在跑——同步锁上发送闸（本端 _turnRunning 可能因广播未到而滞后）
      if (decision.busy) {
        _turnRunning = true;
        updateSendButtonState();
      }
      if (decision.message) addBar(decision.message, decision.busy ? 'text-info' : 'text-danger');
      if (decision.restoreDraft && inputEl && !inputEl.value.trim() && attachments.items().length === 0) {
        if (restoreDraftOnFail.text) {
          inputEl.value = restoreDraftOnFail.text;
          inputEl.dispatchEvent(new Event('input'));
        }
        if (Array.isArray(restoreDraftOnFail.attachments) && restoreDraftOnFail.attachments.length) {
          attachments.setItems(restoreDraftOnFail.attachments);
        }
        autosize();
        updateSendButtonState();
      }
    });
    updateSendButtonState(); // 立即反映在途态，不等下一次外部驱动的刷新
    // F3：不再本地 append 气泡，由 user_message 事件渲染（同时入缓冲，重载可回放）
    inputEl.value = '';
    // 已发出：清掉该会话缓存草稿，避免切走切回把已发送内容当草稿恢复
    if (currentSessionId) sessionDraftCache.delete(currentSessionId);
    attachments.clear();
    hints.classList.add('hidden');
    autosize();
    setBusy(true);
    // 发送窗口内 busy 须跨「换实例 bindView→clearView」存活：新会话首发 + 同会话 externalDirty/effort 置换。
    // 记的是 reqSessionId（这条发送发起时的会话），不是裸 true——供 shouldRestoreOptimisticBusy 认领比对。
    _pendingSendBusySessionId = reqSessionId;
    // 新会话首发（viewingInstanceId 为空）：服务端将懒开实例并广播 instances，触发 setInstances→bindView→
    // clearView 的 setBusy(false) 冲掉这次乐观 busy；置一次性标志，待 setInstances 绑定到新实例后同步补回。
    if (!viewingInstanceId) _pendingFirstSend = true;
    scrollBottom(true);
  }
  btnSend.onclick = () => {
    if (btnSend.dataset.mode === 'stop') {
      haptic('tap');
      requestInterrupt();
      return;
    }
    // CLI 镜像：发送位变成「续接 / 取消续接」，走与旧横幅按钮同一套 requestMirrorResume
    if (btnSend.dataset.mode === 'resume' || btnSend.dataset.mode === 'cancel-resume') {
      haptic('tap');
      requestMirrorResume();
      return;
    }
    send();
  };
  // 移动端回车发送截断修复（2026-07-13 排查报告 §4/§8.1）：触屏软键盘没有 Shift+Enter 这个换行
  // 逃生舱，回车恒当发送键会把长消息在换行处截断。触摸设备下回车走 textarea 默认换行，发送收窄为
  // 仅走发送按钮；enterkeyhint 同步改 'enter'，避免部分输入法把回车当 action 直接派发而非插入换行符。
  const isTouchDevice = matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;
  inputEl.enterKeyHint = isTouchDevice ? 'enter' : 'send';
  // 中文输入法：e.isComposing + keyCode 229 双检已覆盖绝大多数现代浏览器，
  // composition 状态追踪作为旧浏览器（Safari <14、部分 Android WebView）的后备兜底
  let composing = false;
  inputEl.addEventListener('compositionstart', () => { composing = true; });
  // compositionend：组字落定后立刻跑 @ 检测（中文输入法常见路径）
  inputEl.addEventListener('compositionend', () => {
    composing = false;
    checkAtMention();
  });
  inputEl.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229 && !composing && shouldSendOnEnter({ shiftKey: e.shiftKey, isTouchDevice })) {
      e.preventDefault();
      send();
    }
    // ESC 关候选浮层（排队撤回已随排队功能一并移除，ESC 不再有第三个语义）
    if (e.key === 'Escape') {
      if (atMentionList && !atMentionList.classList.contains('hidden')) { hideAtMentionList(); return; }
      const cmdHintsEl = document.getElementById('cmdHints');
      if (cmdHintsEl && !cmdHintsEl.classList.contains('hidden')) { cmdHintsEl.classList.add('hidden'); return; }
    }
  });

  // ---- @ 文件引用：与 / 斜杠同款纵向浮层（absolute bottom-full），不再横滑 chips ----
  // 语义只插相对路径文本，agent 自己 Read；移动端纯触摸点选。
  // 面板挂在 input 父级（与 #cmdHints 同层），见下方 slash 提示初始化。
  let atMentionList = null; // 延迟到 slash hints 同批创建
  let atMentionState = null; // { matchStart } —— 当前触发态；null=未触发
  let atMentionReqId = 0;    // 每次触发/取消自增；files:search ack 里比对，迟到结果直接丢弃
  let atMentionDebounceTimer = null;

  function hideAtMentionList() {
    atMentionState = null;
    atMentionReqId++;
    if (atMentionDebounceTimer) { clearTimeout(atMentionDebounceTimer); atMentionDebounceTimer = null; }
    if (atMentionList) { atMentionList.classList.add('hidden'); atMentionList.innerHTML = ''; }
  }
  // hideAtMentionList 即关闭 @ 候选（Escape / 选中后）；不再保留未使用的 hideAtMentionChips 别名

  function pickAtMention(path) {
    if (!atMentionState) return;
    const cursor = inputEl.selectionStart ?? inputEl.value.length;
    const { text, cursorPos } = applyAtMentionPick(inputEl.value, { matchStart: atMentionState.matchStart, cursorPos: cursor, path });
    inputEl.value = text;
    hideAtMentionList();
    inputEl.focus();
    inputEl.setSelectionRange(cursorPos, cursorPos);
    autosize();
    updateSendButtonState();
  }

  function renderAtMentionList(paths, { emptyHint = '' } = {}) {
    if (!atMentionList) return;
    // 与 / 互斥：出文件列表时收起斜杠提示（hints 在下方初始化，调用时已就绪）
    document.getElementById('cmdHints')?.classList.add('hidden');
    atMentionList.innerHTML = '';
    if (!paths?.length) {
      if (emptyHint) {
        atMentionList.innerHTML = `<div class="px-3 py-2 text-xs text-ink-faint" data-testid="at-mention-empty">${esc(emptyHint)}</div>`;
        atMentionList.classList.remove('hidden');
      } else {
        atMentionList.classList.add('hidden');
      }
      return;
    }
    atMentionList.innerHTML = paths.map(p => {
      const safe = esc(p);
      return `<div class="px-3 py-2.5 hover:bg-sunk active:bg-sunk cursor-pointer text-sm font-mono truncate" data-testid="at-mention-chip" data-path="${safe}" title="${safe}">${safe}</div>`;
    }).join('');
    atMentionList.classList.remove('hidden');
  }

  function renderAtMentionLoading() {
    if (!atMentionList) return;
    document.getElementById('cmdHints')?.classList.add('hidden');
    atMentionList.innerHTML = `<div class="px-3 py-2 text-xs text-ink-faint" data-testid="at-mention-loading">${esc(t('查找文件…'))}</div>`;
    atMentionList.classList.remove('hidden');
  }

  function checkAtMention() {
    // IME 组字中不触发（避免中文输入半成品误搜）；compositionend 再跑一次
    if (composing) return;
    const cursor = inputEl.selectionStart ?? inputEl.value.length;
    const hit = detectAtMentionQuery(inputEl.value.slice(0, cursor));
    if (!hit) { if (atMentionState) hideAtMentionList(); return; }
    atMentionState = { matchStart: hit.matchStart };
    if (atMentionDebounceTimer) clearTimeout(atMentionDebounceTimer);
    const reqId = ++atMentionReqId;
    // 立刻给反馈，避免「打 @ 像没反应」（空 query 也会出候选列表）
    renderAtMentionLoading();
    atMentionDebounceTimer = setTimeout(() => {
      if (!socket?.connected) {
        if (reqId === atMentionReqId) renderAtMentionList([], { emptyHint: t('未连接，无法搜索文件') });
        return;
      }
      socket.emit('files:search', { cwd: currentCwd, query: hit.query }, res => {
        if (reqId !== atMentionReqId) return; // 迟到 ack：期间已改 query / 取消触发，丢弃
        if (!res?.ok) {
          renderAtMentionList([], { emptyHint: res?.error || t('文件搜索失败') });
          return;
        }
        const paths = Array.isArray(res.paths) ? res.paths : [];
        renderAtMentionList(paths, {
          emptyHint: paths.length ? '' : t('无匹配文件'),
        });
      });
    }, 150);
  }
  inputEl.addEventListener('input', checkAtMention);
  inputEl.addEventListener('blur', hideAtMentionList);

  // ---- 输入与附件：状态、读取、预览和 DOM 绑定由独立 controller 管理 ----
  const attachments = createAttachmentController(appContext, {
    addBar,
    createElement: el,
    haptic,
    onChange: updateSendButtonState,
    scheduleInsetResettle: () => scheduleInsetResettle(),
    // CLI 驾驶只读：拒加附件（否则进 tray 却发不出去）；说明走 showMirrorComposerHint。
    canAdd: () => {
      if (!mirrorReadonlySid) return true;
      showMirrorComposerHint();
      return false;
    },
  });
  // E18：气泡附件按需预览——live/历史点击经 browse:read 拉原图，复用托盘灯箱
  const storedPreview = createStoredPreviewLoader(appContext, {
    addBar,
    openPreviewUrl: (name, url) => attachments.openPreviewUrl(name, url),
  });

  // E18：气泡附件节点（live user_message 两分支 + 离线乐观占位 + 历史回显共用）。点击预览级联：
  // 本地全量 data（离线占位/发送失败回灌）→ 托盘同款直开；storedName（live meta/历史解析）→ 按需拉原图；
  // 仅 thumb（滚动升级窗口内的旧 meta）→ 放大缩略图兜底；三者皆无 → 不可点。
  function buildAttachmentNode(a) {
    const clickable = Boolean(a.data || a.storedName || a.thumb);
    let node;
    if (a.thumb) {
      node = el(`<img class="max-w-[8rem] max-h-32 rounded-lg${clickable ? ' cursor-pointer active:opacity-80' : ''}">`);
      node.src = a.thumb;
      node.title = a.name || '';
    } else {
      const isImage = (typeof a.mimeType === 'string' && a.mimeType.startsWith('image/')) || guessImageMime(a.name || a.storedName);
      node = el(`<div class="flex items-center gap-1 bg-sunk rounded-lg px-2 py-1 text-xs max-w-[12rem]${clickable ? ' cursor-pointer active:scale-[0.98] transition-transform' : ''}"${clickable ? ` title="${t('点击预览')}"` : ''}><span class="shrink-0">${isImage ? '🖼' : '📎'}</span></div>`);
      const nm = el(`<span class="truncate"></span>`);
      nm.textContent = a.name || t('附件');
      node.appendChild(nm);
    }
    if (a.data) node.onclick = () => attachments.openPreview(a);
    else if (a.storedName) node.onclick = () => storedPreview.open({ cwd: currentCwd, storedName: a.storedName, name: a.name, mimeType: a.mimeType, thumb: a.thumb });
    else if (a.thumb) node.onclick = () => attachments.openPreviewUrl(a.name || t('附件'), a.thumb);
    return node;
  }

  function buildAttachmentWrap(atts, withMargin) {
    const wrap = el(`<div class="flex flex-wrap gap-2${withMargin ? ' mt-2' : ''}"></div>`);
    for (const a of atts) wrap.appendChild(buildAttachmentNode(a));
    return wrap;
  }
  // ---- 斜杠命令提示 + @ 文件引用列表（同款纵向浮层，互斥显示）----
  const hints = el(`<div id="cmdHints" class="hidden absolute bottom-full left-0 mb-1 bg-surface border border-line rounded-lg max-h-60 overflow-y-auto w-full z-50" style="box-shadow:var(--shadow-pop)" data-testid="cmd-hints"></div>`);
  atMentionList = el(`<div id="atMentionHints" class="hidden absolute bottom-full left-0 mb-1 bg-surface border border-line rounded-lg max-h-60 overflow-y-auto w-full z-50" style="box-shadow:var(--shadow-pop)" data-testid="at-mention-chips"></div>`);
  inputEl.parentElement.style.position = 'relative';
  inputEl.parentElement.appendChild(hints);
  inputEl.parentElement.appendChild(atMentionList);
  // mousedown 防 blur 清空列表（点选行时 input 不失焦）
  atMentionList.addEventListener('mousedown', e => e.preventDefault());
  atMentionList.addEventListener('click', e => {
    const row = e.target.closest?.('[data-path]');
    if (row?.dataset?.path) pickAtMention(row.dataset.path);
  });
  // 前端本地拦截命令（不透传后端），并入提示列表
  const LOCAL_COMMANDS = ['model'];

  inputEl.addEventListener('input', () => {
    const val = inputEl.value;
    if (val.startsWith('/')) {
      hideAtMentionList(); // 与 @ 互斥
      const base = (window.availableSkills || []).map(slashCommandName).filter(Boolean);
      const cands = base.concat(LOCAL_COMMANDS.filter(c => !base.includes(c)));
      const prefix = val.slice(1).toLowerCase();
      const matches = prefix ?
        cands.filter(cmd => cmd.toLowerCase().startsWith(prefix)) :
        cands;
      if (matches.length > 0) {
        hints.innerHTML = matches.map(cmd => {
          const safe = esc(cmd);
          return `<div class="px-3 py-2.5 hover:bg-sunk active:bg-sunk cursor-pointer text-sm font-mono" data-cmd="/${safe}">/${safe}</div>`;
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
    if (atMentionList && !atMentionList.contains(e.target) && e.target !== inputEl) hideAtMentionList();
    if (!leftSidebar.classList.contains('-translate-x-full') && !leftSidebar.contains(e.target) && !btnSessions.contains(e.target) && !(topContextPill && topContextPill.contains(e.target)) && e.target.isConnected)
      closeLeftSidebar();
  });
  const SEND_ICON_HTML = `<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.6" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M5 10l7-7m0 0l7 7m-7-7v18" /></svg>`;
  const STOP_ICON_HTML = `<span class="btn-send-stop-icon" aria-hidden="true"></span>`;
  let _btnSendMode = null; // 仅 mode 变化时换图标，避免按键 thrash

  function updateSendButtonState() {
    if (!btnSend) return;
    const hasContent = inputEl.value.trim().length > 0 || attachments.items().length > 0;
    const mirrorArmed = Boolean(mirrorReadonlySid && armedTakeoverSid === mirrorReadonlySid);
    // 排队已移除：在途轮期间主按钮恒为停止钮（有无草稿都一样），发送位不再承担「排队发送」。
    // turnRunning 与 busy 都要传：前者是发送闸的权威判据，后者只在空输入时兜底（见 resolveComposerPrimaryMode 注释）。
    // CLI 镜像：mirrorReadonly 优先 → mode resume/cancel-resume，发送位变成「续接 CLI 会话」。
    const state = resolveComposerPrimaryMode({
      busy: _busyState,
      turnRunning: _turnRunning,
      hasContent,
      interruptPending: interruptPendingByInstance.has(viewingInstanceId),
      blockedByUserRequest: approvals.hasPending(),
      blockedByDisabledInput: inputEl.disabled,
      blockedBySendInFlight: socket.connected && _sendInFlightSessionIds.has(displayedSessionId),
      mirrorReadonly: Boolean(mirrorReadonlySid),
      mirrorArmed,
    });
    const modeChanged = _btnSendMode !== state.mode;
    _btnSendMode = state.mode;
    btnSend.dataset.mode = state.mode;
    btnSend.disabled = !state.enabled;
    // title 用 resolve 结果（空串=无额外提示）；aria-label 才是可访问名
    btnSend.title = state.title;
    btnSend.setAttribute('aria-label', state.ariaLabel);
    // C：空闲无内容隐藏灰发送（无语音）；stop/resume/有内容仍显示
    const hideSend = shouldHideComposerSendButton({
      mode: state.mode,
      enabled: state.enabled,
      hasContent,
    });
    if (state.mode === 'resume' || state.mode === 'cancel-resume') {
      // 短文案 pill：宽度贴近「发送」圆钮，不挤左侧芯片/齿轮；完整名在 aria-label/title
      btnSend.className = 'flex items-center justify-center h-10 px-2.5 rounded-full shrink-0 transition-all duration-200 shadow-sm text-xs font-semibold whitespace-nowrap' +
        (state.mode === 'cancel-resume'
          ? ' border border-line text-ink-soft bg-surface hover:bg-sunk active:scale-95'
          : ' bg-cta text-white hover:brightness-95 active:scale-95');
      if (modeChanged) btnSend.textContent = state.label || (state.mode === 'cancel-resume' ? t('取消') : t('续接'));
      else if (btnSend.textContent !== state.label) btnSend.textContent = state.label;
    } else if (state.mode === 'stop') {
      btnSend.className = 'flex items-center justify-center w-10 h-10 rounded-full shrink-0 transition-all duration-200 shadow-sm' +
        (state.enabled
          ? ' hover:brightness-95 active:scale-95'
          : ' opacity-55 cursor-not-allowed');
      if (modeChanged) btnSend.innerHTML = STOP_ICON_HTML;
    } else if (state.enabled) {
      // UI-002：激活态品牌 cta 底白箭头（与回形针同级 40px）
      btnSend.className = 'flex items-center justify-center w-10 h-10 rounded-full bg-cta text-white hover:brightness-95 active:scale-95 shadow-sm transition-all duration-200 shrink-0';
      if (modeChanged) btnSend.innerHTML = SEND_ICON_HTML;
    } else {
      btnSend.className = 'flex items-center justify-center w-10 h-10 rounded-full bg-transparent text-ink-faint opacity-60 cursor-not-allowed transition-all duration-200 shrink-0';
      if (modeChanged) btnSend.innerHTML = SEND_ICON_HTML;
    }
    btnSend.classList.toggle('hidden', hideSend);
    syncComposerDiscoverHint();
    syncComposerPlaceholder(); // turnRunning / 镜像 共用 placeholder
  }

  // placeholder：镜像态走 mirror 文案；在途轮提示「运行中」；其余用「给 Claude 发消息...」。
  function syncComposerPlaceholder() {
    if (!inputEl) return;
    if (mirrorReadonlySid) {
      refreshMirrorComposerCopy();
      return;
    }
    inputEl.placeholder = resolveComposerPlaceholder({
      busy: _busyState,
      turnRunning: _turnRunning,
      mirrorReadonly: false,
      idleText: t('给 Claude 发消息...'),
    });
  }

  function syncComposerDiscoverHint() {
    const hint = $('composerDiscoverHint');
    if (!hint || !inputEl) return;
    const hasContent = inputEl.value.trim().length > 0 || attachments.items().length > 0;
    const show = shouldShowComposerDiscoverHint({
      focused: document.activeElement === inputEl,
      hasContent,
      mirrorReadonly: Boolean(mirrorReadonlySid),
    });
    hint.classList.toggle('hidden', !show);
  }

  function autosize() {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 144) + 'px';
    updateSendButtonState();
  }
  inputEl.addEventListener('focus', syncComposerDiscoverHint);
  inputEl.addEventListener('blur', () => {
    // 延后一帧：点 slash 提示等时 activeElement 可能已迁走，避免闪一下
    setTimeout(syncComposerDiscoverHint, 0);
  });
  updateSendButtonState();

  // instanceId 默认取当前查看实例——system(p) 结算 handler 本就只在事件属于当前查看实例时才会被派发到，
  // 故其调用不传 instanceId 天然正确；requestInterrupt 的超时回调则显式传入发起时的 instanceId（届时
  // 用户可能已切走）。非当前查看实例时只清挂起态本身，不动 btnStop/liveLine 这些视图态。
  function clearInterruptPending(instanceId = viewingInstanceId, { keepLiveOverride = false } = {}) {
    const entry = interruptPendingByInstance.get(instanceId);
    if (entry?.timer) clearTimeout(entry.timer);
    if (!entry) return;
    interruptPendingByInstance.delete(instanceId);
    if (instanceId !== viewingInstanceId) return;
    if (btnStop) btnStop.disabled = false;
    // 超时/失败清位：去掉「正在停止…」覆盖，恢复 spinner 或空态；result/interrupted 路径会 setBusy(false) 整清
    if (!keepLiveOverride && liveLine?.override) {
      liveLine.override = '';
      renderLiveLine();
    }
    updateSendButtonState();
  }

  function requestInterrupt() {
    const instanceId = viewingInstanceId;
    if (interruptPendingByInstance.has(instanceId)) return;
    const entry = {};
    interruptPendingByInstance.set(instanceId, entry);
    if (btnStop) btnStop.disabled = true;
    if (liveLine) { liveLine.override = formatLiveActivityText('stopping'); renderLiveLine(); }
    else setStreamLiveStatusText(formatLiveActivityText('stopping'));
    updateSendButtonState();
    // 安全超时：SDK 限流重试中 control_request 可能挂起/回「无可中断」且前端漏清 → 永久卡「正在停止…」
    entry.timer = setTimeout(() => {
      if (!interruptPendingByInstance.has(instanceId)) return;
      clearInterruptPending(instanceId);
      // 只在仍看着这个会话时提示——若已切走，超时是别的（此刻无关）会话的事，不该冒到当前视图上
      if (instanceId === viewingInstanceId) addBar(t('停止请求超时，可再试一次'), 'text-ink-faint');
    }, INTERRUPT_PENDING_TIMEOUT_MS);
    socket.emit('user:interrupt', { instanceId }); // 台阶3：中断当前查看 tab 的在途任务
  }

  if (btnStop) btnStop.onclick = requestInterrupt;

  // ---- 权限档切换：清单 = SDK PermissionMode（SDK_PERMISSION_MODES / 后端 CCM_PERMISSION_MODES）----
  // 磁贴与 hidden select 均由 rebuildPermissionModeUi 动态填充，禁止 HTML 写死档位。
  // 文案 = CLI/桌面英文原名（Manual / Accept edits / …），不走 t()/i18n——与终端等价。
  // setPermMode 仅由 init/permission_mode 服务端事件驱动（权威回执，函数声明有提升），onchange 不再
  // 乐观调用——故上屏的系统条 = 服务端已确认切换。程序设 select.value 不触发 onchange，无回声循环。
  const _permTileSpecs = permissionModeTileSpecs();
  const PERM_LABEL = Object.fromEntries(_permTileSpecs.map(s => [s.id, s.bar]));
  const PERM_PILL_LABEL = Object.fromEntries(_permTileSpecs.map(s => [s.id, s.pill]));

  function rebuildPermissionModeUi() {
    const specs = permissionModeTileSpecs();
    if (permModeSelect) {
      const prev = permModeSelect.value;
      permModeSelect.innerHTML = '';
      for (const s of specs) {
        const opt = document.createElement('option');
        opt.value = s.id;
        opt.textContent = s.selectLabel; // CLI 原名，不 t()
        permModeSelect.appendChild(opt);
      }
      if (prev && specs.some(s => s.id === prev)) permModeSelect.value = prev;
      else if (specs[0]) permModeSelect.value = specs[0].id;
    }
    if (customPermGrid) {
      customPermGrid.innerHTML = '';
      for (const s of specs) {
        const dangerCls = s.danger ? ' text-danger' : '';
        const titleCls = s.danger ? 'text-danger' : 'text-ink';
        const descCls = s.danger ? 'text-red-500/80' : 'text-ink-soft';
        const card = el(`
          <div data-mode="${esc(s.id)}" class="perm-tile p-2 rounded-xl border border-line bg-surface active:bg-sunk cursor-pointer transition-all${dangerCls}">
            <div class="text-xs font-semibold ${titleCls} leading-snug">${esc(s.title)}</div>
            <div class="text-[11px] ${descCls} mt-0.5 leading-snug line-clamp-2">${esc(s.desc)}</div>
          </div>
        `);
        customPermGrid.appendChild(card);
      }
      // 重建后按当前档重画选中框
      if (currentPermMode) setPermMode(currentPermMode, true);
    }
  }
  rebuildPermissionModeUi();

  function clearCliUnknownPermissionOption() {
    permModeSelect?.querySelector('option[data-cli-observed-unknown]')?.remove();
  }
  // ---- 底栏会话档摘要 chip title（与 compose 页 formatComposeDefaultsSummary 同源）----
  // 三段文案由 setPermMode / setEffortMode / syncModelUI 各自维护 pillXxxText；title 只拼不另算，
  // 避免 CLI 镜像 / 网关别名边上两套文案漂移。
  function syncDefaultsPillTitle() {
    if (!pillDefaults) return;
    const summary = formatComposeDefaultsSummary({
      modelLabel: (pillModelText?.textContent || '').trim(),
      modeLabel: (pillPermText?.textContent || '').trim(),
      effortLabel: pillEffort?.classList.contains('hidden')
        ? ''
        : (pillEffortText?.textContent || '').trim(),
    });
    pillDefaults.title = summary || t('会话设置');
  }

  function setPermMode(mode, silent = false) {
    if (!permModeSelect || !mode) return;
    clearCliUnknownPermissionOption();
    if (!silent && permModeSeen && mode !== currentPermMode) {
      // UX-019：空态不打条（胶囊高亮）；有消息后保留「权限档 → X」留痕
      addModeBar(`${t('权限档 →')} ${PERM_LABEL[mode] || mode}`,
        mode === 'bypassPermissions' ? 'text-danger' : 'text-ink-faint');
    }
    permModeSeen = true;
    currentPermMode = mode;
    permModeSelect.value = mode;
    const danger = mode === 'bypassPermissions';
    permModeSelect.classList.toggle('ring-1', danger);
    permModeSelect.classList.toggle('ring-danger', danger);
    permModeSelect.classList.toggle('text-danger', danger);

    // Sync Pill Display Text（CLI 英文档名；Bypass 仅权限段标红，非整颗 chip）
    if (pillPermText) {
      pillPermText.textContent = PERM_PILL_LABEL[mode] || mode;
      const tone = pillPermTone(mode);
      pillPermText.classList.toggle('text-danger', tone === 'danger');
      pillPermText.classList.toggle('pill-perm-plan', tone === 'plan');
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
    syncDefaultsPillTitle();
    if (_composeReady) refreshComposeDefaultsSummary();
  }
  permModeSelect.onchange = async () => {
    // 单驾驶员：终端驾驶中（只读锁）设置一并冻结——权限档实际只作用于 web 自己的实例、碰不到终端进程，
    // 此刻切档只会造成「我切了怎么终端没变」的误解；接管后再调。拨回 select 防 UI 与实际档漂移。
    if (mirrorReadonlySid) { permModeSelect.value = currentPermMode; addBar(t('终端驾驶中，设置已冻结——接管后可调'), 'text-info'); return; }
    const mode = permModeSelect.value;
    if (mode === currentPermMode) return;
    // bypass 二次危险确认（终端等价：终端首次 bypass 亦需确认）；取消则回退 select
    if (mode === 'bypassPermissions' &&
        !(await appConfirm({
          title: t('⚠️ 切到 bypass（跳过所有审批）'),
          body: t('claude 将无需确认即可改文件、跑命令；一次提示注入即可波及整台机器。'),
          okText: t('开启 bypass'),
          tone: 'danger',
        }))) {
      permModeSelect.value = currentPermMode;
      return;
    }
    socket.emit('user:setPermissionMode', { mode });
    // 不乐观更新：等 server 广播 permission_mode（成功回执，毫秒级）驱动 setPermMode 拨档 + 上屏；
    // 失败则 agent 发 error 红条且不广播，下轮 init 拨回 select
  };

  // ---- 思考强度切换（CLI /effort：五档 + ultracode；切档=实例置换、下条消息生效）----
  // setEffortMode 仅由 effort_mode 服务端事件驱动（成功回执广播 / 拒切拨回单发），onchange 不乐观更新。
  // 后端可直接回 level=ultracode（Settings.ultracode 会话 flag），不再靠本地「只武装不重建」偷换。
  function setEffortMode(level, silent = false) {
    if (!effortSelect) return;
    const val = level || null; // 空串/undefined 归一为 null（模型默认）
    ultracodeArmed = val === 'ultracode';
    if (!silent && effortSeen && val !== currentEffort) {
      addModeBar(`${t('思考强度 →')} ${val || t('模型默认')}${t('（下一条消息生效）')}`, 'text-ink-faint');
    }
    effortSeen = true;
    currentEffort = val;
    effortSelect.value = val || '';

    if (pillEffortText) {
      pillEffortText.textContent = val || t('默认思考');
    }

    if (customEffortGrid) {
      const activeLevel = val || '';
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
    syncDefaultsPillTitle();
    if (_composeReady) refreshComposeDefaultsSummary();
  }
  // 把当前模型（init.model 规范名）桥接到 models 候选项（取其 supportedEffortLevels）。
  // 先精确 value 命中；否则 alias↔规范名桥接：剥 [Nm] 上下文后缀，候选别名作为 family 子串落在规范名里、
  // 且后缀一致（如 claude-opus-4-8[1m] ↔ opus[1m]）。纯从 SDK 列表派生，不硬编码任何模型名。
  // effort 档位按当前模型动态渲染（CLI/SDK 透传，不硬编码）：决策在 logic.js 的 effortLevelsFor，此处只渲染。
  // opts.silentClear：仅刷新面板显示、不得触发网络副作用——adoptPanelState 切 tab 查看别的（空闲）实例时传
  // true。根因：effort 只能在开实例时设定，之后随消息切模型不会跟着清空，二者可脱节而持久化仍非空；
  // 若在这里无脑 emit user:setEffort(null)，仅仅切一下 tab 查看就会让 server 判定档位不匹配、
  // 对着一个空闲实例整个 dispose+resume 重开，只有真正的模型切换（onchange/tile 点击/`/model`）才该触发它。
  function rebuildEffortOptions(modelValue, opts) {
    if (!effortSelect) return;
    const silentClear = Boolean(opts?.silentClear);
    const { hidden, levels: baseLevels } = effortLevelsFor(modelValue, modelsList);
    const show = withUltracodeTier(baseLevels); // xhigh-capable 模型上追加 ultracode 最高档，镜像 CLI /effort
    // 强度是所选模型的下级：标题挂上模型名，档位才有归属。用 displayName 而非裸 value，
    // 与模型磁贴主标题同源。空 modelValue（CLI「不 pin」）回落到 cwd 默认/当前模型——部分调用点
    // 已自带这个回落，这里统一兜一次，免得某条路径漏了就显示成无主的档位。
    const ownerLabel = modelLabelFor(modelValue || cwdDefaultModel || currentModel, modelsList);
    if (effortOwnerModel) effortOwnerModel.textContent = ownerLabel;
    effortOwnerWrap?.classList.toggle('hidden', !ownerLabel);
    effortOwnerWrap?.classList.toggle('inline-flex', Boolean(ownerLabel));
    if (hidden) {
      // 候选明确声明该模型不支持 effort（区别于“当前 CLI 档未知”）：Web 驾驶时把实例档清回
      // model-default，等服务端 effort_mode 回执再更新 currentEffort；CLI 镜像只读态绝不写回。
      if (!silentClear && !mirrorReadonlySid && currentEffort !== null) socket.emit('user:setEffort', { level: null });
      effortSelect.value = '';
      if (customEffortGrid) customEffortGrid.innerHTML = '';
      effortRow?.classList.add('hidden');
      pillEffort?.classList.add('hidden');
      // 整段不再消失——凭空少一栏用户只会以为界面坏了。就地说明「这个模型没有这档可调」，
      // 底栏 pill 仍隐藏（确实没有档位可显示，留个空 chip 反而是噪音）。
      customEffortGroup?.classList.remove('hidden');
      if (effortUnsupported) {
        effortUnsupported.textContent = ownerLabel
          ? `${ownerLabel}${t(' 不支持调节思考强度，按模型默认执行。')}`
          : t('当前模型不支持调节思考强度，按模型默认执行。');
        effortUnsupported.classList.remove('hidden');
      }
      syncDefaultsPillTitle();
      return;
    }
    effortRow?.classList.remove('hidden');
    pillEffort?.classList.remove('hidden');
    customEffortGroup?.classList.remove('hidden');
    effortUnsupported?.classList.add('hidden');

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
        // UX-014：副文案增量信息，非「思考等级: low」同义反复
        const sub = effortLevelSubtitle(lv) || (isUltra ? t('xhigh + 多 agent · 最彻底') : '');
        const lvTile = el(`
          <div data-level="${esc(lv)}" class="effort-tile p-2 rounded-xl border border-line bg-surface active:bg-sunk cursor-pointer transition-all ${active ? 'ring-1 ring-accent border-accent text-accent bg-accent-wash/30' : ''}">
            <div class="text-xs font-semibold ${active ? 'text-accent' : 'text-ink'}">${esc(lv)}</div>
            ${sub ? `<div class="text-xs text-ink-soft mt-0.5">${esc(sub)}</div>` : ''}
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
    syncDefaultsPillTitle();
    if (_composeReady) refreshComposeDefaultsSummary();
  }
  effortSelect.onchange = () => {
    // 单驾驶员：终端驾驶中设置冻结（同 permModeSelect.onchange）——effort 切档还会 dispose+重开实例。
    if (mirrorReadonlySid) { effortSelect.value = currentEffort || ''; addBar(t('终端驾驶中，设置已冻结——接管后可调'), 'text-info'); return; }
    // 原样发 UI 档（含 ultracode）；server 映射 xhigh+Settings.ultracode 并置换实例。xhigh↔ultracode 也必须重建。
    const uiLevel = effortSelect.value || null;
    if (uiLevel === currentEffort) return;
    socket.emit('user:setEffort', { level: uiLevel });
    addModeBar(t('正在切换思考强度并续接会话…'), 'text-ink-faint');
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
        rebuildEffortOptions(effortModelValue, { silentClear: true });
      } else {
        modelInput.value = '';
      }
      syncModelUI(currentModel);
    }
    setPermMode(inst.permissionMode || 'default', true);
    setEffortMode(inst.effort ?? null, true);
    rebuildEffortOptions(effortModelValue, { silentClear: true });
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
    unknown.textContent = t('CLI 当前模式未知');
    unknown.disabled = true;
    unknown.dataset.cliObservedUnknown = '1';
    permModeSelect?.prepend(unknown);
    currentPermMode = '';
    if (permModeSelect) permModeSelect.value = '';
    if (pillPermText) pillPermText.textContent = t('CLI 模式未知');
    syncDefaultsPillTitle();
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
        ensureModelOption(currentModel, t('CLI 当前模型'));
        modelInput.value = currentModel;
      } else {
        modelInput.value = '';
        if (pillModelText) pillModelText.textContent = t('CLI 模型未知');
        syncDefaultsPillTitle();
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
        if (!res?.ok) addBar(res?.error || t('深链目标会话已不可用'), 'text-warning');
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
    // 结算兜底（跨实例）：agent:event 层的 shouldDropAgentEvent 只放行当前查看实例的事件，非当前查看
    // 实例的「停止」结算事件会被丢弃、其 interruptPendingByInstance 挂起态无法经 system(p) 清位。这条
    // instances 广播不受视图过滤，靠它独立探测每个挂起实例是否已不再 busy，及时补清——防止切视图后
    // 该实例的停止按钮一直卡死到自身 12s 超时才在无关视图上弹出提示。
    for (const pendingId of [...interruptPendingByInstance.keys()]) {
      const pendingInst = instancesList.find(x => x.instanceId === pendingId);
      if (!pendingInst || pendingInst.state !== 'busy') clearInterruptPending(pendingId);
    }
    needsYouList = Array.isArray(p?.needsYou) ? p.needsYou : [];
    // cwd 默认模型：捕获旧值 + currentModel（下方 adoptPanelState 会改 currentModel），末尾据此决定是否重建默认磁贴标签。
    // 非 string（含 null=未探到）归一空 → 切到无默认的 cwd 自动清、不残留上区默认。
    const prevDefaultModel = cwdDefaultModel, prevCurrentModel = currentModel;
    cwdDefaultModel = (typeof p?.defaultModel === 'string') ? p.defaultModel : '';
    // 会话缓存不在这里做失效标记（P3 SWR 保鲜）：populateSubtree 拿缓存秒开渲染的同时恒发一次
    // session:list 刷新，新鲜度由那条响应负责——不需要谁来"标脏"。既不整段清空（避免"清空→骨架屏
    // →等网络往返"连坐重建没变化的目录），也不会因为 id 集合没变就把改名/截断变化漏掉。
    const prevIds = new Set(prevInstances.map(x => x.instanceId));
    const currIds = new Set(instancesList.map(x => x.instanceId));
    // server 重启检测（每条广播都要过账，与下方视图切换分支无关——基线必须持续跟进，否则重启前
    // 最后一条广播的 startedAt 会因为中间隔了几条无关广播而失真）。
    const newServiceStartedAt = p?.service?.startedAt ?? null;
    const serverRestarted = detectServerRestart({ prevStartedAt: lastServiceStartedAt, newStartedAt: newServiceStartedAt });
    if (newServiceStartedAt != null) lastServiceStartedAt = newServiceStartedAt;
    // 清除④：freshInterrupted 标记的实例从 instances 列表消失（关闭/退出/别处清理），待续档态随之作废。
    if (freshInterruptedInstanceId && !currIds.has(freshInterruptedInstanceId)) {
      freshInterruptedInstanceId = null;
    }
    const newStates = aggregateStates(instancesList, availableDirs); // per-cwd 聚合（permission>busy>done>idle）
    const newViewing = p?.viewingInstanceId ?? null;
    const newCwd = p?.viewingCwd ?? null;
    const cwdChanged = cwdSeen && newCwd && newCwd !== currentCwd;
    if (cwdSeen) notifyStateChanges(newStates, newCwd); // 首次只定基线不通知（刷新/重连不冒假通知）
    workdirStates = newStates;
    // 切换查看实例 / 空首页内换工作区 → 先把只读态复位为可编辑，等 server 按新上下文重判并推权威 mirror_state。
    // 消除切换瞬间旧会话只读横幅残留（server 判活现仅靠观察外部写入、切入不预锁，故复位是安全默认）。
    // 空首页 viewing 恒 null 时仅靠 instanceId 差判会漏清 → shouldResetMirrorOnViewChange 补 cwd 轴。
    // ⚠️ 必须在 currentCwd/viewingInstanceId 覆写之前读 prev（否则 prevCwd 已是 newCwd）。
    // override / 排队接管随会话切换作废（armedTakeoverStep 的 switch→disarm 契约）。
    if (shouldResetMirrorOnViewChange({
      prevViewing: viewingInstanceId, nextViewing: newViewing,
      prevCwd: currentCwd, nextCwd: newCwd, cwdSeen,
      // 同会话静默换实例（externalDirty/effort 触发的 dispose+resume）不应清用户刚做的接管选择：
      // 从新旧 instances 快照按 instanceId 查 sessionId，不依赖可能尚未同步的 currentSessionId。
      prevSessionId: prevInstances.find(x => x.instanceId === viewingInstanceId)?.sessionId ?? null,
      nextSessionId: instancesList.find(x => x.instanceId === newViewing)?.sessionId ?? null,
    })) {
      mirrorOverriddenSid = null;
      armedTakeoverSid = null;
      applyMirror(false, null);
    }
    currentCwd = newCwd;
    viewingInstanceId = newViewing;
    cwdSeen = true;
    instancesReady = true; // 视图状态已知：此后 shouldDropAgentEvent 按 viewingInstanceId 精确分流（含 null 空窗口）
    if (pendingDeepLink) { const link = pendingDeepLink; pendingDeepLink = null; applyDeepLink(link); } // ②2c：instances 到齐后消费暂存深链

    // 进度横幅可见性收敛（权威状态驱动，替代零散事件隐藏）：当前查看实例无活的后台任务（bgActive=false）即隐藏横幅——
    // 统一覆盖「切会话到别的会话 / 后台任务 TTL 清 / 完成 / 前台轮残留」所有隐藏场景。
    // 显示：onTaskProgress 心跳 + scheduleBgBroadcast/sync:since 的 emitBgTasksSnapshot 复亮；
    // bgActive===true 时【不】在此主动 hide——避免「权威仍有任务但前端曾误清」被再次压暗且无数据可重建。
    const viewedInst = instancesList.find(x => x.instanceId === newViewing);
    // 严格 === false（非 falsy）：仅服务端明确「无活后台任务」或当前无查看实例（切到空会话）才隐藏；
    // bgActive 缺失（旧服务端 / 视觉 mock 不带该字段）时保守不隐藏，保留 showTaskProgress 逐心跳驱动的原行为。
    if (!viewedInst || viewedInst.bgActive === false) hideTaskProgress();
    // 发送闸：随 instances 广播的权威 turnRunning 字段驱动（undefined/旧服务端=保守 false 不误禁）。
    _turnRunning = viewedInst?.turnRunning === true;

    // 顶栏主 pill：标题优先 / 无则工作区；title 挂 cwd 供长按辨认
    syncTopContextLabel();
    // pillWorkspace（📁 状态 pill）显当前工作区名——该 pill 是工作区入口，显 model 名是名实错配（2026-06-21）
    if ($('pillWorkspaceText')) $('pillWorkspaceText').textContent = baseName(currentCwd);
    // 开发者模式：DEV_MODE=1 时显示齿轮面板「重启服务」组（生产默认隐藏，防误触重启对外服务）
    const devGroup = $('devModeGroup');
    if (devGroup) devGroup.classList.toggle('hidden', !p?.devMode);
    // 短 session_id 状态胶囊：显示当前查看会话的前 8 位；无会话（空首页/未获 id）隐藏
    updatePillSession(instancesList.find(x => x.instanceId === newViewing)?.sessionId || null);
    // 顶栏文件夹 pill：首页/compose 隐藏（页内已有工作区入口）；进入真实会话后显示
    syncTopContextPillVisibility(newViewing, instancesList.find(x => x.instanceId === newViewing)?.sessionId || null);
    // 输入条同上：必须无条件同步，不能只靠下面 bindView 那条路。CLI 迟到的 init 只会让广播多出一个
    // sessionId，viewingInstanceId 并没变 → 下面 `newViewing !== displayedInstanceId` 不成立 → 不
    // 重新 bindView → 输入条会永远停在隐藏（真机 c1ccd055：内容回来了但发不了消息，换个浏览器新开
    // 页面却正常，因为那是完整 bindView）。syncComposerVisibility 自身读 instancesList 取最新 sid，幂等。
    syncComposerVisibility();
    // 保持纯手动展开折叠，不自动展开任何工作区目录

    // 切视图：viewingInstanceId 变了重载；空首页内换工作区（newViewing 恒 null、cwd 变了）也重渲——
    // 否则 dashboard 工作区名 + 模型 chip 残留上个工作区（本次修复的 bug 正出于此：两个 null 空首页被判为「视图没变」）
    const startScreenCwdChanged = !newViewing && cwdChanged;
    if (newViewing !== displayedInstanceId || startScreenCwdChanged) {
      // 点停止顿一下跳主页（回归修复）：须在 displayedInstanceId 被 bindView 覆写之前判定——
      // prevIds/currIds 是本函数顶部按"这次广播前后的 instancesList"算出的旧/新快照，
      // displayedInstanceId 此刻仍是"切视图前实际绑定在屏幕上的那个实例"（bindView 内部才会覆写它）。
      const instanceDestroyed = wasViewingInstanceDestroyed({
        prevViewingInstanceId: displayedInstanceId,
        newViewingInstanceId: newViewing,
        prevIds, currIds,
        explicitCloseInstanceId,
      });
      explicitCloseInstanceId = null; // 一次性：只用于紧接着这一次判定，防止悬留误伤后续无关的摧毁事件
      // server 重启细分：同一条广播里 startedAt 变了 + 正在看的实例消失 = 整机重启把所有内存实例带走了，
      // 不是这个实例被单独摧毁——提示页换准确文案 +「继续此会话」一键重开（会话 transcript 在磁盘上，
      // 走既有 session:switch 打开路径懒 resume）。resume 目标从旧快照取：instanceDestroyed=true 的
      // 前提就是该实例在 prevInstances 里（见 wasViewingInstanceDestroyed 的 prevIds 防御分支）。
      const destroyedByRestart = instanceDestroyed && serverRestarted;
      const restartPrevEntry = destroyedByRestart ? prevInstances.find(x => x.instanceId === displayedInstanceId) : null;
      const destroyedResume = restartPrevEntry?.sessionId && restartPrevEntry?.cwd
        ? { sessionId: restartPrevEntry.sessionId, cwd: restartPrevEntry.cwd }
        : null;
      const target = instancesList.find(x => x.instanceId === newViewing);
      ultracodeArmed = false;           // ultracode 档不跨实例（CLI: never persist）；切会话/工作区一律回落（含切到空首页 target=null）
      adoptPanelState(target);          // 先静默同步顶部面板到新实例档（先于 bindView 的 sync 回放）
      // 空首页（无实例）：① 模型不显具体名（新会话模型=env 默认、服务端不可知）→「不指定」，modelInput 归零；
      // ② 权限/思考强度显"下条新会话将用的真实档"
      // （server defaultPermissionMode/defaultEffort = L0 pending > L3 CLI settings > L4 硬默认），
      // silent 同步不上屏——修空首页残留上个会话档（A1，2026-06-22；L3 2026-07-14）。
      // 注意：实例被摧毁时也不去动模型/权限/思考强度面板显示（用户下一步是先看到中断提示，不是新会话面板）。
      if (!target && !instanceDestroyed) {
        updateModelAndSuffix(''); if (modelInput) modelInput.value = '';
        setPermMode(p.defaultPermissionMode || 'default', true);
        setEffortMode(p.defaultEffort ?? null, true);
      }
      bindView(target, newViewing, { instanceDestroyed, destroyedByRestart, destroyedResume }); // 空表面→home dashboard / compose 新会话页 / destroyed 中断提示
      // bindView 内已按 shouldRestoreOptimisticBusy 补 busy；此处再补一次防 bindView early-return 路径漏补
      // （首发无 sessionId / 同会话 externalDirty·effort 置换）。session:switch 打开已有会话不补。
      if (shouldRestoreOptimisticBusy({
        pendingFirstSend: _pendingFirstSend,
        pendingSendBusySessionId: _pendingSendBusySessionId,
        viewingInstanceId: newViewing,
        sessionId: target?.sessionId,
      })) {
        setBusy(true);
      }
      _pendingFirstSend = false; // 一次性：进入视图切换即消费，防标志悬留误触发后续绑定
      // _pendingSendBusySessionId 保留到 result/error/负 ack，覆盖置换后可能的二次 rebind
      if (consoleModal && consoleModal.classList.contains('sheet-open')) {
        loadConsoleLogs(newViewing);
      }
    } else if (newViewing && displayedInstanceId === newViewing && !displayedSessionId) {
      // FE-001：同一实例后续 instances 广播补上了 sessionId（懒开后 init），须补丁 displayedSessionId，
      // 否则 newViewing === displayedInstanceId 永远不进 bindView，requestSync 持续早退。
      const target = instancesList.find(x => x.instanceId === newViewing);
      if (target?.sessionId) {
        displayedSessionId = target.sessionId;
        updatePillSession(target.sessionId);
        syncTopContextLabel();
        // 清除②：同一实例在这条广播里补上了 sessionId——待续档态不再适用（这条路径不经 bindView，
        // 上面 bindView 内的清除逻辑覆盖不到，须在此单独清）。
        if (freshInterruptedInstanceId === newViewing) freshInterruptedInstanceId = null;
      }
    } else if (!newViewing) {
      // 空首页视图未变（displayed 已是 null、cwd 也没变），但仍可能收到二次 instances：
      // session:new / 启动后 ensureCliDefaults 异步到齐会再广播一次，defaults 从 L4→L3。
      // 若不在此静默刷新，顶部 mode/effort 会卡在首帧硬默认，直到用户切走再回来。
      // 用户在空窗手改档（L0）时 server 会把 pending 编进 default*，这里幂等对齐权威源即可。
      setPermMode(p.defaultPermissionMode || 'default', true);
      setEffortMode(p.defaultEffort ?? null, true);
      // compose 页默认档摘要跟 pill 同源；L3 到齐后就地刷新，避免仍显 L4 硬默认。
      if (_composeReady) refreshComposeDefaultsSummary();
    }
    // 视图未变的广播：server 权威 busy 单向对齐（reload 误擦兜底 + 多设备同视图静默窗口）。
    // 只置 true；释放交给 live result（见 shouldBindBusyFromBroadcast 注释）。
    if (newViewing && newViewing === displayedInstanceId) {
      if (shouldBindBusyFromBroadcast({ state: viewedInst?.state, bgActive: viewedInst?.bgActive })) {
        setBusy(true);
      } else if (shouldForceClearBusyFromBroadcast({
        state: viewedInst?.state,
        localBusy: _busyState,
        turnStartTs: liveLine?.turnStartTs ?? null,
        now: Date.now(),
      })) {
        // 看门狗：终止事件丢了才会走到这（见 shouldForceClearBusyFromBroadcast 注释）——正常轮次
        // state 全程 'busy'，这个分支不会触发。
        setBusy(false);
      }
    }
    updateSessionsDot();
    updateServiceNotice(p?.service ?? null); // 服务健康与实例结构无关，无条件每次广播都刷新（不进下方判定分支）
    // P3 性能优化（两层判定，故意不合并——关注点不同）：
    // ① 结构性变化（目录集合本身变化 / viewingInstanceId 变化 / 当前查看 cwd 变化——三者共同决定
    //   dirRow 高亮与自动展开）仍走全量重建：低频、全量更简单可靠，不做精细化 diff。
    // ② 其余情况按目录分键 diff（见 logic.js buildDirInstanceSignatures/diffDirSignatures：id/sessionId/
    //   title 前20字），只重建签名真变化的目录子树，未涉及目录的 DOM 原样不动（不撤离滚动位置/侧滑态/
    //   "显示全部"展开态）——避免重连等场景下无关工作区被连坐重建（P3 抽屉局部重建）。
    // 状态（busy/idle/permission/error）不进任何一层——由更新后的 workdirStates 驱动 refreshDirBadges
    // 实时刷新角标。expandedDirs 变化由 toggleBtn.onclick 直接调 populateSubtree，不经此路径。
    const _structuralKey = `${availableDirs.join('|')}|${viewingInstanceId || ''}|${currentCwd || ''}`;
    const _structuralChanged = _structuralKey !== _lastPanelStructKey;
    _lastPanelStructKey = _structuralKey;
    const _nextDirSignatures = buildDirInstanceSignatures(instancesList, availableDirs);
    const _changedDirs = diffDirSignatures(_lastDirSignatures, _nextDirSignatures);
    _lastDirSignatures = _nextDirSignatures;
    const isDesktop = window.innerWidth >= 1024;
    const isPanelOpen = leftSidebar && !leftSidebar.classList.contains('-translate-x-full');
    if (isDesktop || isPanelOpen) {
      if (_structuralChanged) {
        openSessionPanel(); // 内含 needsYou/service 区 + 工作区树全量重建，此路径不必再单独 refresh*
      } else if (_changedDirs.length) {
        rebuildDirSections(_changedDirs); // 只重建真正变化的目录子树，其余目录 DOM 保持原样
        refreshDirBadges();
        refreshSessionStatusChips(); // 会话文字状态实时刷新
        refreshNeedsYou(); // "等我"聚合独立于签名（新增/清除审批不改变实例集结构），须单独刷新
      } else {
        refreshDirBadges();
        refreshSessionStatusChips();
        refreshNeedsYou();
      }
    } else {
      refreshDirBadges();
      refreshSessionStatusChips();
      refreshNeedsYou();
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
    updateSendButtonState(); // _turnRunning 可能随 instances 广播变化，须即时刷新发送闸与提示行
  }

  // ---- 未读角标：切回会话时若离开期间攒了未读顶层消息，悬浮胶囊显示数量，点击/翻到附近自动确认已读 ----
  // 只统计顶层气泡（renderOne/getStream/handle.user_message/离线占位气泡创建时打的 dataset.topLevel='1'），
  // 与服务端 unread-tracker.js#resolveUnreadDelta 的计数颗粒度一致。
  function topLevelBubbles() {
    return Array.from(messagesEl.querySelectorAll(':scope > [data-top-level="1"]'));
  }
  let unreadAnchorNode = null;
  let unreadAnchorObserver = null;
  function hideUnreadPill() {
    unreadPillEl?.classList.add('hidden');
    unreadAnchorObserver?.disconnect();
    unreadAnchorObserver = null;
    unreadAnchorNode = null;
  }
  // 用户点掉胶囊 / 手动翻到锚点附近（IntersectionObserver 命中）均走这里：本地先隐藏，再上报服务端清
  // 冻结快照（user:ackUnread）——镜像视图架构下多端应一致，其他设备的胶囊会随 broadcastInstances 同步消失。
  function ackUnread() {
    const id = viewingInstanceId;
    hideUnreadPill();
    clearAppBadgeSafe(); // 确认已读 → 清应用图标角标（不支持的平台静默跳过）
    if (id != null) socket.emit('user:ackUnread', { instanceId: id });
  }
  // count：sync:since ack 带回的 unreadOnEntry（第一次为这个会话结算的权威数字）。必须在渲染真正稳定后调用
  // （bindView 的 'keep' 分支直接调用；'load'/'reload' 分支要等 loadHistory 的 onDone 回调），否则
  // topLevelBubbles() 数不全，锚点会算错位置。
  function showUnreadPillIfAny(count) {
    hideUnreadPill(); // 先清上一个会话可能残留的胶囊态，防止跨会话串味
    if (!unreadPillEl || !(count > 0)) return;
    const list = topLevelBubbles();
    const idx = resolveUnreadAnchorIndex(list.length, count);
    if (idx < 0) return;
    unreadAnchorNode = list[idx];
    unreadPillCountEl.textContent = count > 99 ? '99+' : String(count);
    unreadPillEl.classList.remove('hidden');
    setAppBadgeSafe(count); // 未读胶囊显示 → 同步置应用图标角标（不支持的平台静默跳过）
    // observe() 触发的第一次回调只是汇报"此刻"的可见状态（短对话/未读消息本来就在一屏内时，锚点从一开始
    // 就是可见的）——不能当成"用户翻到了"，否则胶囊刚显示就被自己判定为已读并立刻消失。只认后续真正由
    // 滚动触发的状态变化。
    let firstReport = true;
    unreadAnchorObserver = new IntersectionObserver(entries => {
      if (firstReport) { firstReport = false; return; }
      if (entries.some(e => e.isIntersecting)) ackUnread();
    }, { root: messagesEl, threshold: 0.5 });
    unreadAnchorObserver.observe(unreadAnchorNode);
  }
  // 仿微信"以下为新消息"分割线：插在锚点前，随高亮同一 2s 生命周期出现/消失。data-ephemeral="1"
  // 复用 stripEphemeralMessageNodes 的既有排除机制（同 streamLiveStatus）——切走该会话时不进
  // sessionDomCache，故已读结算过的分割线不会在下次缓存恢复时复活。
  function jumpToUnreadAnchor() {
    haptic('tap');
    const anchor = unreadAnchorNode; // ackUnread() 会清空闭包状态，先取局部引用供滚动/高亮用
    ackUnread();
    if (!anchor?.isConnected) return;
    const divider = el(`<div id="unreadDivider" class="msg-frame unread-divider text-center text-xs text-ink-faint" data-ephemeral="1">${t('以下为新消息')}</div>`);
    anchor.parentNode.insertBefore(divider, anchor);
    anchor.scrollIntoView({ block: 'center', behavior: 'smooth' });
    anchor.classList.add('unread-anchor-flash');
    setTimeout(() => {
      anchor.classList.remove('unread-anchor-flash');
      divider.remove();
    }, 2000);
  }
  unreadPillEl?.addEventListener('click', jumpToUnreadAnchor);

  // 未读胶囊第三条自动确认已读路径：用户手动滚动贴近底部 → ackUnread()（与上面「点击」「Intersection
  // Observer 扫到锚点」并存，互不替代——未读很多时锚点在很上面，用户滚到底部锚点早就飘出视口了，
  // Observer 不会触发，这是本条专门补的场景）。判定交纯函数 shouldAckUnreadOnScroll（logic.js），这里
  // 只负责取值 + 节流。withinProgrammaticWindow 取自 scrollBottom() 维护的 programmaticScrollUntil
  // （见下方 scrollBottom 定义）——切入积压会话时回放缓冲的程序性落底不能被误判成"用户看到了"。
  // 节流：scroll 事件触发频率很高，用 rAF 把同一帧内的多次事件合并成一次检查——回调里读取的是触发时刻
  // 的最新滚动几何（而非事件里的值），故合并多次事件不会漏判"最终停在哪"，比固定时间间隔的节流更稳。
  let unreadScrollCheckPending = false;
  messagesEl.addEventListener('scroll', () => {
    if (unreadScrollCheckPending) return;
    unreadScrollCheckPending = true;
    requestAnimationFrame(() => {
      unreadScrollCheckPending = false;
      if (shouldAckUnreadOnScroll({
        pillVisible: Boolean(unreadPillEl) && !unreadPillEl.classList.contains('hidden'),
        withinProgrammaticWindow: Date.now() < programmaticScrollUntil,
        scrollHeight: messagesEl.scrollHeight,
        scrollTop: messagesEl.scrollTop,
        clientHeight: messagesEl.clientHeight,
      })) ackUnread();
    });
  }, { passive: true });

  // aggregateStates 已抽到 logic.js（顶部 import）。
  // 切视图到指定实例（台阶3）：清视图 → sync 活缓冲（重建在途流 + 挂起审批弹窗）→ 无缓冲回退 history。
  // entry 缺失/无 sessionId（新会话尚未 init）= 空白，事件流入自然渲染。
  function bindView(entry, id, opts = {}) {
    hideUnreadPill(); // 无条件先清上一个会话的残留胶囊——含本函数下方提前 return 的空首页/compose 分支，避免悬浮在无关界面上
    // 无条件先丢弃上一个实例的回放缓冲——同 hideUnreadPill：含下方提前 return 的空首页/compose/
    // pendingFirstSend 分支也要清，否则遗留缓冲会静默吞掉那个旧实例后续的实时事件（缓冲一直挂着、
    // 却再没人来 resolve() 它）。真正切入某个会话时 begin() 自身也会 discard，这里是兜底覆盖全分支。
    replayBuffer.discard();
    const prevInstanceId = displayedInstanceId; // S1：缓存归属的(外出)实例，供切回时检测实例是否被替换
    const prevSessionId = displayedSessionId;   // 切实例前的会话 id——供 planSessionDraftSwap 判 keep/swap
    displayedInstanceId = id;
    const sid = entry?.sessionId || null;
    displayedSessionId = sid;
    // 清除①②：切到别的实例/空表面（id 变了），或该实例这一刻已经拿到 sessionId（sid 非空）——
    // 两种情况都意味着"sessionId 未到即被中断"这个待续档态不再适用，须清掉，否则会悬留到下一个
    // 无关场景把它误判成该显示中断态。
    if (freshInterruptedInstanceId && (id !== freshInterruptedInstanceId || sid)) {
      freshInterruptedInstanceId = null;
    }

    // Phase 2: Save DOM nodes of current session to cache before clearing.
    // S1：连同去重基线(lastSeq/epoch)一并缓存——切回时据此「只增量续传缓存之后的新事件」，而非
    // sync:since(0) 全量回放（会与缓存重复，且旧逻辑用 innerHTML='' 清重复时把回放也一起清掉 → 空屏）。
    if (currentSessionId && !messagesEl.classList.contains('empty-start') && messagesEl.childNodes.length > 0) {
      // strip ephemeral live 行，避免切回会话时把 busy 状态行当历史气泡
      const nodes = stripEphemeralMessageNodes(Array.from(messagesEl.childNodes));
      if (nodes.length === 0) { /* 仅有 ephemeral 时不缓存空壳 */ }
      else sessionDomCache.set(currentSessionId, { nodes, lastSeq, epoch: curEpoch, instanceId: prevInstanceId });
      // 最多 8 棵完整 DOM 树：长会话 tool 卡很重，40 在中低端机易顶 RAM
      if (sessionDomCache.size > 8) {
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

    // clearView 刚 setBusy(false)：发送窗口内（首发懒开 / 同会话静默换实例）立即补回，避免 live 行闪没。
    // FE-NEW-004：切入已在跑的 live 实例时 seed busy（instances.state），否则发送钮停在 idle 直到下一条 delta。
    const restoreBusy = shouldRestoreOptimisticBusy({
      pendingFirstSend: _pendingFirstSend,
      pendingSendBusySessionId: _pendingSendBusySessionId,
      viewingInstanceId: id,
      sessionId: sid,
    }) || shouldSeedBusyFromInstanceState(entry?.state);
    if (restoreBusy) setBusy(true);
    // 发送闸同样要重种：clearView 刚把 _turnRunning 清零，而 setInstances 对它的赋值发生在 bindView 之前，
    // 会被那次清零冲掉——切回一个正在跑的会话时闸就失准了（停止钮不出现、发送反被服务端拒）。
    // 取 instances 广播的权威 turnRunning（查不到则保持 clearView 后的 false，不猜）。
    const liveEntry = instancesList.find(x => x?.instanceId === id);
    if (liveEntry?.turnRunning === true) _turnRunning = true;

    // 新会话首发懒开：实例已建、sessionId 未由 SDK init 返回。此刻回落 dashboard 会「闪首页」——
    // 到首个 user_message 经 leaveStartScreen 切回聊天前的几百 ms 用户看见首页再弹回。
    // 首发进行中 → 保持空聊天区 + 乐观 busy，不 showDashboard；等首个事件经 appendMessage 接管渲染。
    // 注意：同会话静默换实例也 restoreBusy，但有 sessionId，须继续走缓存/history，不能 early return。
    if (restoreBusy && _pendingFirstSend && !sid) {
      syncComposerVisibility();
      return;
    }

    // ＋ → compose 干净新会话页；🏠 / 冷启动 → home 最近枢纽；有 session → none
    // freshInterrupted：sessionId 未到但已中断——不落 home/compose，保留已渲染的聊天内容（见上方清除注释）。
    // instanceDestroyed：点停止顿一下跳主页的回归修复——正在看的实例被摧毁（非用户主动导航），
    // 不静默落 home，先给用户看"会话已中断"提示，交由其手动选下一步（见 setInstances 调用处）。
    const emptySurface = resolveEmptySurface({
      viewingInstanceId: id,
      sessionId: sid,
      composeReady: _composeReady,
      freshInterrupted: id === freshInterruptedInstanceId,
      instanceDestroyed: Boolean(opts.instanceDestroyed),
      // sessionId 未到但实例正在跑：不落空首页，继续往下走 sync:since——服务端环形缓冲里有 CLI 已经
      // 实时吐出来的内容，早退就等于把它们扔了（见 logic.js shouldShowStartScreen 的 live 注释）。
      live: shouldSeedBusyFromInstanceState(entry?.state) || entry?.turnRunning === true,
    });
    if (emptySurface === 'destroyed') {
      showInstanceDestroyedSurface({ byRestart: Boolean(opts.destroyedByRestart), resume: opts.destroyedResume || null });
      return;
    }
    if (emptySurface === 'home') {
      showDashboard();
      return;
    }
    if (emptySurface === 'compose') {
      showComposeSurface();
      return;
    }

    // 进入真实会话：输入条常显（shouldShowComposer 看 sessionId）；composeReady 可清掉。
    leaveComposeReady();
    syncComposerVisibility();
    syncTopContextPillVisibility(id, sid);

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

    // 回放缓冲（P0-REPLAY-BUFFER）：emit 之前先 begin()，期间命中该 instanceId 的 agent:event
    // 先入队不渲染（见上方 socket.on('agent:event', ...)），修「切会话逐条吐消息像打字机」。
    const replayHandle = replayBuffer.begin(id);
    socket.emit('sync:since', { instanceId: id, sessionId: sid, lastSeq: resumeFromSeq }, res => {
      // 已切走：丢弃过期回调。显式 discard 本轮 handle——后续 bindView 的 begin/discard 通常已顶替，
      // 但若同一实例被快速 A→B→A 重入，仅靠 displayed 守卫早退而不 resolve，会让中间那批已入队事件
      // 既不 flush 也不推进基线，最终被第三次 begin 无声丢掉。
      if (displayedInstanceId !== id) {
        replayBuffer.resolve(replayHandle, 'discard');
        return;
      }
      // S1：hasCache 时已增量续传（resumeFromSeq=缓存位置，回放只含新事件、append 不重复）。
      // 切入决策交纯函数 shouldReloadOnEnter（logic.js，单测覆盖）——活缓冲/DOM 缓存 vs 磁盘全量重载：
      //   'load'   无缓存、聊天区空 → 拉磁盘首次填充（不必清屏）；
      //   'reload' gap（缓冲超窗残缺）或磁盘被外部写长（web 离开期间终端 CLI 写盘的盲区）→ 清屏全量重载磁盘；
      //   'keep'   缓存/活缓冲即最新真相 → 直接收尾，保留 DOM 秒恢复。
      const action = shouldReloadOnEnter({
        replayed: res?.replayed, gap: res?.gap, hasCache,
        diskLen: res?.diskLen ?? 0, seenDiskLen: seenDiskLenBySession.get(sid) ?? 0,
        // 无 sessionId = session:history 无从查起，清屏必然换来白屏（见 logic.js 该闸注释）
        hasSessionId: Boolean(sid),
      });
      // 回放缓冲二层判定（resolveReplayBufferAction，logic.js）：action 已是 'reload'/'load' 时直接
      // 沿用（这层不重判）；'keep' 时再看缓冲攒了多少条 + 是否 busy，决定要不要"补"一次 reload。
      // busy 取 ack 时刻 instances 广播的最新值（同 shouldReseedBusyAfterReload 的口径，优先于入场快照
      // entry?.state——ack 到达前可能已有更新的 instances 广播）。
      const busy = shouldSeedBusyFromInstanceState(instancesList.find(x => x.instanceId === id)?.state ?? entry?.state);
      const bufferAction = resolveReplayBufferAction({ bufferedCount: replayBuffer.bufferedCount(id), priorAction: action, busy, hasSessionId: Boolean(sid) });
      // 未读胶囊：数字随 ack 一次性到达，但 DOM 是否已就绪要看走哪条分支——'load'/'reload' 要等
      // loadHistory 分块渲染真正落地（onDone）才能查 topLevelBubbles()，'keep' 分支 DOM 已稳定可以直接查。
      const unreadOnEntry = res?.unreadOnEntry || 0;
      if (action === 'load') {
        // 缓冲通常本就空（'load' 只在 server replayed===0 时出现）；仍统一走 resolve('reload') 收尾，
        // 防万一有穿插的实时事件——续传基线前移到缓冲尾，不遗漏、不重复。
        replayBuffer.resolve(replayHandle, 'reload');
        loadHistory(sid, entry.cwd, () => showUnreadPillIfAny(unreadOnEntry));
      } else if (bufferAction === 'reload') {
        // 覆盖两种来源：action 本就是 'reload'（gap/外部写入），或 'keep' 但缓冲攒太多被这层升级——
        // 统一走清屏 + session:history 批量重载（loadHistory/renderHistoryBubbles 本就是一次性 fragment
        // + 单次落底，见 logic.js resolveReplayBufferAction 顶部注释）。
        // 丢弃缓冲队列前先把续传基线（lastSeq/curEpoch）前移到队列尾——否则下面 keepSeq/keepEpoch
        // 会读到"缓冲前"的旧值，下次再进这个会话可能重复播放本次被丢弃的这批事件，或因 seq 跳跃误判 gap。
        replayBuffer.resolve(replayHandle, 'reload');
        // sync:since 已把（原本会经缓冲推进的）lastSeq/curEpoch 前移；clearView 会归零基线——
        // 若不恢复，后续 reconnect 以 lastSeq=0 再回放缓冲会与磁盘历史叠成重复气泡。history 不占 seq，
        // 恢复前移后的基线即可让后续增量从缓冲尾部续。
        const keepSeq = lastSeq;
        const keepEpoch = curEpoch;
        clearView(sid, null);
        lastSeq = keepSeq;
        curEpoch = keepEpoch;
        // clearView 内部只补乐观 busy（shouldRestoreOptimisticBusy），不含 state seed——
        // 静默窗口（长 Bash 执行中）无 delta 自愈，运行条被本次清屏永久抹掉 → 按 server 权威 state 重种。
        if (shouldReseedBusyAfterReload({ instances: instancesList, instanceId: id, entryState: entry?.state })) setBusy(true);
        // 发送闸同理：clearView 把 _turnRunning 清了，按广播的权威字段重种，否则 reload 后停止钮消失
        if (instancesList.find(x => x?.instanceId === id)?.turnRunning === true) _turnRunning = true;
        showLoadingCard();
        loadHistory(sid, entry.cwd, () => showUnreadPillIfAny(unreadOnEntry));
      } else {
        // flush：缓冲队列（若有）按到达顺序正常派发（走原 handler 增量渲染），抑制中间滚动，派发完
        // 只做一次强制落底（resolveReplayBufferAction 内部处理，见 createReplayBuffer flushQueue）。
        replayBuffer.resolve(replayHandle, 'flush');
        hideLoadingCard();
        showUnreadPillIfAny(unreadOnEntry);
        // 修「切回停在旧位置」：'keep' 分支恢复的是离开时缓存的旧内容底部，离开期间产生的新内容随后
        // 才作为 replay 事件逐条补发（各自走非强制 scrollBottom，未必够到阈值）——不强制补一次的话
        // 视图会停留在旧底部附近，直到某条补发事件恰好触发滚动。flushQueue 已在缓冲非空时做过一次
        // 强制落底，这里是冗余但无害的兜底（replayed=0/缓冲为空时仍需要它独立生效）。
        if (shouldForceScrollAfterReplay({ action, replayed: res?.replayed })) scrollBottom(true);
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
      if (cur === 'permission') notify(t('⚠️ 后台需要审批'), baseName(d));
      else if (cur === 'error') notify(t('⚠️ 后台任务出错'), baseName(d));
      else if (cur === 'done') notify(t('✅ 后台任务完成'), baseName(d));
    }
  }

  // 抽屉主状态只保留三种可见文字：需要你 / 出错 / 运行中。工具类型、终端来源、正常终态不再
  // 抢占状态位；文字是主要语义，颜色仅辅助。顶部极小点位仍复用 icon 字段。
  const DRAWER_STATUS_META = {
    busy: { icon: 'busy', tone: 'text-accent', label: '运行中' },
    permission: { icon: 'warn', tone: 'text-warning', label: '需要你' },
    error: { icon: 'error', tone: 'text-danger', label: '出错' },
  };
  function drawerStatusMeta(state) {
    const meta = DRAWER_STATUS_META[state];
    return meta ? { ...meta, label: t(meta.label) } : null;
  }
  function drawerStateForDir(cwd) {
    return resolveDrawerStatus({
      liveState: workdirStates[cwd],
      terminalState: terminalBusyByDir.get(cwd) ? 'busy' : null,
    });
  }
  function applyBadge(badge, state) {
    const meta = drawerStatusMeta(state);
    if (meta) {
      badge.className = `dir-badge drawer-status-chip ml-auto shrink-0 ${meta.tone}`;
      badge.textContent = meta.label;
      badge.title = meta.label;
      badge.setAttribute('aria-label', meta.label);
      badge.classList.remove('hidden');
    } else {
      badge.textContent = '';
      badge.className = 'dir-badge hidden';
      badge.title = '';
      badge.removeAttribute('aria-label');
    }
  }
  function appendSessionStatusChip(head, liveState, terminalState) {
    head.querySelector('[data-session-status]')?.remove();
    const state = resolveDrawerStatus({ liveState, terminalState });
    const meta = drawerStatusMeta(state);
    if (!meta) return;
    const chip = el(`<span data-session-status class="drawer-status-chip shrink-0 ${meta.tone}"></span>`);
    chip.textContent = meta.label;
    chip.title = meta.label;
    chip.setAttribute('aria-label', meta.label);
    head.appendChild(chip);
  }
  // "已等待"文案（FR-22，与 needsYouList 共享 waitingSince 数据源）：按分钟粒度，不做秒级实时动画——
  // 该区块只在 instances 广播到达时重渲（同 refreshNeedsYou 触发时机），文案本就是"上次广播时刻"的快照。
  function formatWaitingDuration(waitingSince) {
    if (typeof waitingSince !== 'number') return '';
    const mins = Math.max(0, Math.floor((Date.now() - waitingSince) / 60000));
    if (mins < 1) return t('已等待 <1 分钟');
    if (mins < 60) return `${t('已等待')} ${mins} ${t('分钟')}`;
    const h = Math.floor(mins / 60), m = mins % 60;
    return `${t('已等待')} ${h} ${t('小时')}${m ? ' ' + m + ' ' + t('分钟') : ''}`;
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
    head.textContent = item.title || t('新会话');
    const sub = el(`<div class="truncate text-[10px] text-ink-faint"></div>`);
    const reasonLabel = isApproval ? t('等待审批') : t('等待输入');
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
    header.textContent = `${t('需要你')} (${needsYouList.length})`;
    section.appendChild(header);
    for (const item of needsYouList) section.appendChild(needsYouRow(item));
    return section;
  }
  // 面板开着时刷新"需要你"区（不重建整个面板）：needsYou 变化（新增/清除审批或提问）不改变 dirs/实例集，
  // 不会触发结构性变化或目录签名变化 → openSessionPanel/rebuildDirSections 都不会被调用，须独立刷新
  // （同 refreshDirBadges/refreshSessionStatusChips 的定位）。
  // 面板尚未渲染过（#needsYouSection 不存在）时跳过——首次 openSessionPanel 会用当下 needsYouList 建好。
  function refreshNeedsYou() {
    const old = sessionPanel.querySelector('#needsYouSection');
    if (!old) return;
    old.replaceWith(buildNeedsYouSection());
  }
  // "服务"小节：与"需要你"聚合故意保持视觉分隔——放在需要你之后、目录列表之前，
  // 避免看起来像"更多同类待办"（两条轴论证依据不同，见 updateServiceNotice 注释）。
  // 仅异常时渲染（空数组=一切正常，section 直接 hidden），锚点 #serviceSection 常在同 needsYouSection 惯例。
  // 抽屉不再放 live 实例汇总/状态图例——状态只活在需要你、行角标、主聊天面、底栏。
  function buildServiceSection() {
    const section = el(`<div id="serviceSection"></div>`);
    const notices = formatServiceNotices({ service: latestServiceHealth, now: Date.now() });
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
      // 同下：去重 key 与追加文案必须同语言，且译文须保持「t('服务告警') 是长句译文的前缀」这层关系。
      if (!base.includes(t('服务告警'))) connDotWrap.title = (base ? base + ' · ' : '') + t('服务告警（推送失败等）');
    } else if (level === 'attention') {
      connDotWrap.classList.add('border-warning');
      const base = connDotWrap.title || '';
      // 幂等去重靠 includes 比对，故追加的文案必须与被比对的 key 同语言——这里拼 t('需要你') 而非
      // 写死中文，否则 en 下 includes 永不命中，每刷新一次就往 title 里再追加一段。
      if (!base.includes(t('需要你'))) connDotWrap.title = (base ? base + ' · ' : '') + `${t('需要你')} (${needsYouList.length || '…'})`;
    } else {
      connDotWrap.classList.add('border-line-soft');
    }
  }
  function updateTerminalBusyForDir(cwd, sessions, terminalBusy) {
    // 新服务端给出完整 registry 的 cwd 汇总，避免默认分页漏掉页外 busy；旧服务端回落当前返回行。
    const next = typeof terminalBusy === 'boolean'
      ? terminalBusy
      : Array.isArray(sessions) && sessions.some(s => s?.terminal === 'busy');
    const prev = terminalBusyByDir.get(cwd) === true;
    if (next === prev) return;
    if (next) terminalBusyByDir.set(cwd, true);
    else terminalBusyByDir.delete(cwd);
    refreshDirBadges();
    updateSessionsDot();
  }
  // 面板开着时仅更新已渲染目录行的文字状态（不重发 session:list）
  function refreshDirBadges() {
    sessionPanel.querySelectorAll('[data-dir]').forEach(row => {
      const badge = row.querySelector('.dir-badge');
      if (badge) applyBadge(badge, drawerStateForDir(row.dataset.dir));
    });
  }
  // 初次绘制和 instances 增量广播共用同一个状态 resolver/builder，避免两套角标语义分叉。
  function refreshSessionStatusChips() {
    const instMap = new Map(instancesList.map(x => [x.instanceId, x]));
    sessionPanel.querySelectorAll('[data-testid="session-row"]').forEach(row => {
      const inst = row.dataset.instanceId ? instMap.get(row.dataset.instanceId) : null;
      const head = row.querySelector('[data-session-head]');
      if (!head) return;
      appendSessionStatusChip(head, inst?.state, row.dataset.terminalState || null);
    });
  }
  // 顶部点位空间极小，继续用 SVG；但只汇总需要你/出错/运行中，正常完成和中止不再持续点亮。
  function updateSessionsDot() {
    if (!sessionsDot) return;
    const drawerStates = {};
    for (const cwd of availableDirs) drawerStates[cwd] = drawerStateForDir(cwd);
    const top = summarizeOtherWorkspaces(drawerStates, availableDirs, currentCwd);
    const meta = drawerStatusMeta(top);
    sessionsDot.classList.remove('text-accent', 'text-warning', 'text-danger', 'text-success', 'text-ink-faint');
    if (meta) {
      sessionsDot.classList.remove('hidden');
      sessionsDot.classList.add('status-icon', meta.tone);
      setStatusIcon(sessionsDot, meta.icon);
      sessionsDot.setAttribute('aria-label', meta.label);
      sessionsDot.title = `${t('其他工作区')} · ${meta.label}`;
    } else {
      sessionsDot.innerHTML = '';
      sessionsDot.textContent = '';
      sessionsDot.title = '';
      sessionsDot.removeAttribute('aria-label');
      sessionsDot.classList.remove('status-icon', 't-status');
      sessionsDot.classList.add('hidden');
    }
  }
  // 服务状态可见性（第一性原理重新设计）：与上面 updateSessionsDot（会话待处理，FR-21/注意力不对称）
  // 是不同的轴——这里只答"ccm 这个服务本身有没有出过岔子"（NFR-15/可维护性），复用 connDotWrap（已有的
  // 服务级 UI 落点，纯连通性的 connDot 内圈继续只管绿/红，环形边框承载这条独立语义）。
  function updateServiceNotice(service) {
    latestServiceHealth = service;
    // 边框由 updateAttentionSignal 统一重算（alert > attention > ok），此处只刷服务文案区。
    refreshServiceSection();
    renderHooksBridgeSection(); // 安装态随广播刷新：面板开着时点完开关能立刻看到变化
  }

  // 配置面板「推送内容」段顶部的订阅状态行。推送不通时此前 UI 上零痕迹——铃铛按钮在权限被拒或
  // 订阅失败时都不显示，用户查不出自己为什么收不到（实测：机主机器上从未订阅成功过而毫不知情）。
  const pushStatusRowEl = $('pushStatusRow'), pushPreviewInertNote = $('pushPreviewInertNote');
  async function renderPushStatusRow() {
    if (!pushStatusRowEl) return;
    let subscribed = false;
    try {
      // ⚠️ navigator.serviceWorker.ready 在「没有任何 SW 注册」时**永远不 resolve**（不是 reject）。
      // 直接 await 会让本函数挂住，整行永远不渲染——正是"界面上什么都没有"的那类静默失败。
      const reg = await Promise.race([
        navigator.serviceWorker?.ready,
        new Promise(r => setTimeout(() => r(null), 1500)),
      ]);
      subscribed = !!(await reg?.pushManager?.getSubscription());
    } catch { /* 不支持/未注册 SW：按未订阅渲染，由 hint 解释原因 */ }
    // 没订阅时「推送带内容预览」是空转的——把这件事说出来，别让人勾了以为生效
    pushPreviewInertNote?.classList.toggle('hidden', subscribed);
    const row = formatPushStatusRow({
      hint: pushEnvHint(notifications.environment()),
      permission: typeof Notification !== 'undefined' ? Notification.permission : 'default',
      subscribed,
    });
    pushStatusRowEl.replaceChildren();
    const card = el(`<div class="flex items-center justify-between gap-3 p-2.5 rounded-xl border border-line bg-surface text-xs text-ink"><span class="min-w-0"></span></div>`);
    const value = el(`<span class="font-semibold block"></span>`);
    value.textContent = row.value;
    const toneCls = { ok: 'text-success', warn: 'text-warning' }[row.tone];
    if (toneCls) value.classList.add(toneCls);
    card.firstChild.appendChild(value);
    if (row.hint) {
      const h = el(`<span class="text-xs text-ink-soft"></span>`);
      h.textContent = row.hint;
      card.firstChild.appendChild(h);
    }
    if (row.action === 'subscribe') {
      const btn = el(`<button class="shrink-0 px-3 py-1.5 rounded-lg border border-line text-xs active:opacity-70" data-testid="push-subscribe"></button>`);
      btn.textContent = row.actionText;
      btn.onclick = async () => {
        btn.disabled = true;
        await notifications.requestSubscription();
        btn.disabled = false;
        renderPushStatusRow();
      };
      card.appendChild(btn);
    }
    pushStatusRowEl.appendChild(card);
  }

  // 「发一条测试推送」：自证推送链路，不必等真事件。结果如实回报——发出去几条、失败几条、
  // 有没有收件人。"没有订阅"是最常见也最容易被误当成"功能坏了"的情况，要说清楚。
  if ($('btnPushTest')) $('btnPushTest').onclick = () => {
    const btn = $('btnPushTest');
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = t('发送中…');
    socket.timeout(8000).emit('push:test', {}, (err, res) => {
      btn.disabled = false;
      btn.textContent = original;
      if (err || !res?.ok) { addBar(t('测试推送失败，请检查网络'), 'text-danger'); return; }
      if (!res.subscribed) {
        addBar(t('这台设备还没订阅推送——先点上方的「开启」'), 'text-warning');
      } else if (res.failed > 0) {
        addBar(`${t('测试推送发送失败')} ${res.failed} ${t('条（订阅可能已过期，重新开启一次）')}`, 'text-danger');
      } else {
        addBar(`${t('已发出测试推送')} ${res.sent} ${t('条——若手机没响，检查系统通知权限')}`, 'text-success');
      }
    });
  };

  // 配置面板的「终端会话推送」段（CLI hooks 桥）。放在通知这一组、而不是服务状态诊断页：对用户
  // 而言这就是"电脑终端里跑的会话要不要通知我"，与提示音/震动同一心智——埋进诊断页没人找得到。
  const hooksBridgeSection = $('hooksBridgeSection'), hooksBridgeBody = $('hooksBridgeBody');
  function renderHooksBridgeSection() {
    if (!hooksBridgeSection || !hooksBridgeBody) return;
    const row = formatHooksBridgeRow(latestServiceHealth?.hooksBridge);
    if (!row) { hooksBridgeSection.classList.add('hidden'); return; } // 旧 server / 读不出状态 → 整段缺席
    hooksBridgeSection.classList.remove('hidden');
    hooksBridgeBody.replaceChildren();
    const card = el(`<div class="flex items-center justify-between gap-3 p-2.5 rounded-xl border border-line bg-surface text-xs text-ink"><span class="min-w-0"></span></div>`);
    const label = el(`<span class="font-semibold block"></span>`);
    label.textContent = row.value;
    const toneCls = { ok: 'text-success', warn: 'text-warning', muted: 'text-ink-soft' }[row.tone];
    if (toneCls) label.classList.add(toneCls);
    card.firstChild.appendChild(label);
    const desc = el(`<span class="text-xs text-ink-soft"></span>`);
    desc.textContent = row.hint || t('电脑终端里跑的会话，完成或需要你时通知手机');
    card.firstChild.appendChild(desc);
    if (row.action) {
      const btn = el(`<button class="shrink-0 px-3 py-1.5 rounded-lg border border-line text-xs active:opacity-70" data-testid="hooks-bridge-action"></button>`);
      btn.textContent = row.actionText;
      btn.onclick = () => runHooksSetup(row.action, btn);
      card.appendChild(btn);
    }
    hooksBridgeBody.appendChild(card);
  }

  function setBusy(b) {
    // UX-010：镜像只读时不与本地忙碌条同现；live 状态迁到消息流 #streamLiveStatus，发送钮双态由 updateSendButtonState 驱动
    const show = shouldShowBusyWithMirror({ mirrorReadonly: Boolean(mirrorReadonlySid), busy: b });
    if (show === _busyState) return;
    _busyState = show;
    if (show) {
      if (!interruptPendingByInstance.has(viewingInstanceId) && btnStop) btnStop.disabled = false;
      // show === _busyState 去重保证每 turn 恰好在此选一次动词、起一次秒表
      const now = Date.now();
      liveLine = {
        verb: pickSpinnerVerb(),
        turnStartTs: now,
        serverTurnStartedAt: null,
        outTokens: null,
        thinking: null,
        override: '',
        lastEventAt: now,       // 等待可观测性：初值=turn 起点，收到 agent:event 后刷新
        sawContentDelta: false, // 本轮是否已见 text_delta/thinking_delta
      };
      startLiveTicker();
      showStreamLiveStatus(renderLiveLineText());
    } else {
      clearInterruptPending(viewingInstanceId, { keepLiveOverride: true }); // setBusy(false) 终态：清 pending/timer；live 整清在下两行
      stopLiveTicker();
      liveLine = null;
      if (btnStop) btnStop.disabled = false;
      hideStreamLiveStatus();
    }
    updateSendButtonState(); // FE-004 / 停止 morph：busy 变化即时刷新主按钮；内含纠偏 placeholder
  }

  // 左抽屉的开合与边缘手势归 app/drawer.js；sheet 开合原语与通用确认弹窗归 app/sheets.js
  // （两者的接线分别在下方与文件上部，此处仅留位置说明）。
  const drawer = createDrawerController(appContext, {
    $, haptic,
    onOpened: () => openSessionPanel(),
    onClosed: () => stopSessionPanelRevalidator(),
  });
  const { openLeftSidebar, closeLeftSidebar } = drawer;

  const { openDeleteSession } = createSessionDeleteController(appContext, {
    $, socket, addBar, appConfirm, openSheet, closeSheet,
    onDeleted: () => openSessionPanel(),
  });

  // ---- 项目文件只读浏览：传输回调、分页状态和 DOM 渲染由独立 controller 管理 ----
  const fileBrowser = createFileBrowser(appContext, {
    baseName,
    confirmDiscardEdit: () => appConfirm({
      title: t('放弃未保存的修改？'),
      body: t('编辑内容尚未保存，离开后将丢失。'),
      okText: t('放弃修改'),
      tone: 'warning',
    }),
    createElement: el,
    haptic,
  });
  const gitChanges = createGitChangesPanel(appContext, {
    createElement: el,
    haptic,
  });
  // 两个子控制器只管各自半边的数据；sheet 开合与 tab 切换归 workspacePanel 统一持有
  const workspacePanel = createWorkspacePanel(appContext, {
    closeSheet,
    openSheet,
    haptic,
    fileBrowser,
    gitChanges,
  });
  const openWorkspacePanel = workspacePanel.open;
  // ⑧ 推送内容预览：本地偏好读写 + 改动时（若已授权通知权限）立即重新订阅，把新 prefs.preview 带给服务端
  // ——不重新订阅的话，服务端那份旧订阅记录的 prefs 就跟本地开关脱节，下次推送还是按旧偏好选 body。
  const pushPreview = {
    get: () => readPushPreviewPref(k => localStorage.getItem(k)),
    set: (enabled) => {
      writePushPreviewPref((k, v) => localStorage.setItem(k, v), enabled);
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') void notifications.subscribe();
    },
  };
  // ⑨ 语言偏好：切换后写 storage + 提示刷新（不做响应式重渲——已翻译的静态串只在启动时应用一次，
  // 运行中改语言若不刷新，会停留在混杂态；appConfirm 走已有的确认 sheet，不新开一套 UI）。
  const langPref = {
    // 回显设置面板下拉框用原始存储值（含 auto）；语言渲染/t() 走 getLang() 的运行时折叠值，两者用途不同。
    get: () => readLangPref(k => localStorage.getItem(k)),
    set: async (lang) => {
      writeLangPref((k, v) => localStorage.setItem(k, v), lang);
      if (await appConfirm({ title: t('需要刷新页面才能生效'), body: t('现在刷新吗？'), okText: t('刷新') })) {
        location.reload();
      }
    },
  };
  // ---- 设置：两个同构 sheet，由同一个 controller 按作用域分工 ----
  // 会话设置（入口=底栏 #pillDefaults 摘要 chip，随 composer 显隐）：模型 / 权限 / 思考 / 会话 ID。
  // 原独立齿轮与三 chip 打开同一个 sheet、纯重复，已收敛为一条摘要。DEFAULT_KEYS.trigger 的
  // btnSettings 不再注入 dom，controller bind 对缺失 trigger 安全跳过。syncPrefs=false——
  // 本机偏好那批 DOM 已迁到通用设置，两个控制器都去绑会互相覆盖 onchange（后建的赢，静默难查）。
  // 面板内三块始终展开磁贴（方案 A），onOpen 只需回填摘要 title。
  const settings = createSettingsController(appContext, {
    alerts, haptic, syncPrefs: false,
    onOpen: () => { syncDefaultsPillTitle(); },
  });
  // 侧栏与 sheet 同为 z-40：不先收侧栏，弹出的面板会和左侧抽屉叠在一起。
  // 必须抢在下面 createSettingsController 的 bind() 之前注册——listener 按注册顺序触发，
  // 这样是「先收侧栏、再弹面板」而不是反过来闪一帧。也**不能**改写 btnGeneralSettings.onclick
  // （那是控制器 bind 的落点，覆盖掉 open 就没了）。
  if (btnGeneralSettings) btnGeneralSettings.addEventListener('click', closeLeftSidebar);
  function applyGeneralScrollTarget() {
    const id = generalScrollToId;
    generalScrollToId = null;
    if (!id) return;
    // 等 sheet 动画与 push 状态行渲染完再滚，否则 bounding box 还是 0
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        document.getElementById(id)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      });
    });
  }
  // 通用设置（侧栏底部入口，全局可达）：📱 本机偏好 + 🖥 主机与服务 + 🔑 访问与帮助。
  // beforeOpen 收掉可能还开着的会话设置——两个 sheet 同为 z-40，叠着会露出下面那层的边。
  general = createSettingsController(appContext, {
    keys: {
      sheet: 'generalSheet', body: 'generalSheetBody', scrim: 'generalScrim',
      dragZone: 'generalDragZone', close: 'generalClose', trigger: 'btnGeneralSettings',
    },
    alerts, haptic, pushPreview, langPref,
    beforeOpen: () => { if (settings.isOpen()) settings.close(); },
    // 推送订阅状态每次打开重算：权限可能在系统设置里被改过，渲染一次会过期。
    onOpen: () => {
      renderPushStatusRow();
      applyGeneralScrollTarget();
    },
  });
  // 顶部分段锚点：本机 / 主机 / 帮助
  generalSheetBody?.querySelectorAll?.('[data-scroll-to]')?.forEach(btn => {
    btn.addEventListener('click', (ev) => {
      ev.preventDefault();
      const id = btn.getAttribute('data-scroll-to');
      if (!id) return;
      document.getElementById(id)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
  });
  const openSettingsSheet = settings.open; // 刷新动态段走控制器的 onOpen
  if (pillDefaults) pillDefaults.onclick = () => openSettingsSheet(); // 点摘要 chip → 会话设置（三块磁贴已展开）
  // 顶部 pill：工作区入口，直接落到「文件」tab（「改动」tab 就在同一行，无需先选一次）。侧栏不再挂浏览入口。
  if (topContextPill) {
    topContextPill.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      haptic('tap');
      openWorkspacePanel(currentCwd, 'files');
    };
  }

  const pillWorkspace = $('pillWorkspace');
  if (pillWorkspace) {
    pillWorkspace.onclick = () => {
      haptic('tap');
      openSettingsSheet();
    };
  }

  // 事件委托：磁贴由 rebuildPermissionModeUi 动态生成，不能一次性绑死
  if (customPermGrid) {
    customPermGrid.addEventListener('click', (ev) => {
      const tile = ev.target.closest?.('.perm-tile');
      if (!tile || !customPermGrid.contains(tile)) return;
      haptic('tap');
      const mode = tile.dataset.mode;
      if (!mode || mode === currentPermMode) return;
      if (permModeSelect) permModeSelect.value = mode;
      permModeSelect?.onchange?.();
    });
  }

  // ---- 会话 ----
  // 模型清单不再由前端主动拉。旧 refreshAvailableModels 在后端返空时「保留陈旧」——切到无缓存的别区点
  // 新会话时，就把上个工作区的候选（如 deepseek）继续显出来，正是跨工作区泄漏。改由后端在切 cwd
  // （session:new/switch、setWorkdir/setViewing）时按本区主动推 models 事件（无缓存→空），统一走下方
  // models(p) 处理器「空则清、非空则填」，单一权威路径不再分叉。

  // 回空首页枢纽（最近工作区/会话）。已在空表面则只重渲 home；否则 session:home。
  // 与 ＋ 分工：🏠 = home 枢纽（输入条隐藏、保留面板档）；＋ = compose 干净新会话页（输入条开、重置 pending + scout）。
  if (btnHome) btnHome.onclick = () => {
    haptic('tap');
    closeLeftSidebar();
    leaveComposeReady();
    // 清除③：用户显式回主页——放弃"sessionId 未到即中断"的待续档态，让 shouldShowStartScreen 按
    // 正常规则判定（不应被 freshInterrupted 拦住，用户就是要去主页）。
    freshInterruptedInstanceId = null;
    const sid = instancesList.find(x => x.instanceId === viewingInstanceId)?.sessionId || null;
    if (shouldShowStartScreen({ viewingInstanceId, sessionId: sid })) {
      showDashboard();
      return;
    }
    let acked = false;
    socket.emit('session:home', {}, res => {
      acked = true;
      if (res && res.ok === false) addBar(res.error || t('回首页失败'), 'text-danger');
    });
    setTimeout(() => { if (!acked) addBar(t('回首页无响应，请刷新后重试'), 'text-danger'); }, 4000);
  };

  // 台阶3：新建会话 = 在当前 cwd 开 compose 页（旧 tab 后台继续、**不中断**），等首条消息懒开。
  // 显式 ＋ = compose 就绪：干净新会话页 + 输入条，底栏/页内摘要显示本工作区默认模型·权限·思考。
  // 已在空表面时 viewing 仍 null，instances 广播不会进 bindView，须本地 ensure 切到 compose。
  btnNew.onclick = () => {
    haptic('tap');
    // 同步本地重置：不等服务端 instances 广播（那要一次网络往返）。JS 单线程保证这行执行完之后，
    // 无论用户手速多快，ensureEmptySurface()/send() 都只能读到 null，不会残留旧会话 id（Bug A）。
    viewingInstanceId = null;
    // 清除③：新建会话——放弃上一个实例"sessionId 未到即中断"的待续档态。
    freshInterruptedInstanceId = null;
    enterComposeReady();
    ensureEmptySurface();
    socket.emit('session:new', { cwd: currentCwd }); // 模型清单由后端 pushModelsForCwd 主动推、不再前端拉
  };
  function toggleSessions() {
    haptic('tap');
    if (window.innerWidth >= 1024) {
      const collapsed = document.body.classList.toggle('sidebar-collapsed');
      if (collapsed) stopSessionPanelRevalidator();
      else {
        openSessionPanel(); // 用已剥离 terminal 的 SWR 缓存重画，避免展开时闪旧 CLI 状态
        startSessionPanelRevalidator({ immediate: true });
      }
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
  // 单个工作区目录的 DOM 子树构建（dirRow 头行 + subtree 展开区）——从 openSessionPanel 抽出以支持
  // 局部重建（见 rebuildDirSections）：只有这个函数知道"一个目录该怎么画"，openSessionPanel（全量）
  // 与 rebuildDirSections（局部，只重建按目录签名 diff 出的变化目录）都复用它，两条路径画出来的东西
  // 保证一致，不会走成两套逻辑。tabs 现读 instancesList（不依赖调用方快照）：局部重建时数据可能比
  // 上一次 openSessionPanel 更新，直接读最新更正确。
  function buildDirSection(d) {
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
    applyBadge(badge, drawerStateForDir(d));

    toggleBtn.appendChild(icon);
    toggleBtn.appendChild(arrow);
    toggleBtn.appendChild(name);
    toggleBtn.appendChild(badge);
    dirRow.appendChild(toggleBtn);

    // 物理热区扩大版 "＋" 新建按钮
    const newSessionBtn = el(`<button class="shrink-0 w-8 h-8 rounded-lg flex items-center justify-center border border-line text-ink-soft hover:text-accent hover:border-accent hover:bg-accent-wash active:scale-90 text-sm font-bold shadow-sm transition-all" title="${t('在此工作区新建会话')}">＋</button>`);
    newSessionBtn.onclick = (e) => {
      e.stopPropagation();
      closeLeftSidebar();
      haptic('tap');
      // 同步本地重置（同 btnNew，Bug A）：viewingInstanceId 不等广播落地；currentCwd 同样要立刻
      // 切到 d——否则广播落地前发送会把消息投到当前正看的工作区，而不是刚点的这个 d。
      viewingInstanceId = null;
      currentCwd = d;
      // 清除③：新建会话（按目录行 ＋）——放弃上一个实例"sessionId 未到即中断"的待续档态。
      freshInterruptedInstanceId = null;
      enterComposeReady();
      ensureEmptySurface(); // cwd 可能变了；空表面内 viewing 仍 null 须本地切到 compose
      socket.emit('session:new', { cwd: d }); // 模型清单由后端 pushModelsForCwd 主动推、不再前端拉
    };
    dirRow.appendChild(newSessionBtn);

    // 文件浏览入口已收归顶部 pill（当前工作区）；抽屉只负责会话切换/新建，不再挂逐行「浏览」按钮。

    // ---- 展开区容器（所有目录均常驻 DOM 以支持 CSS max-height 过渡，仅通过类来控制动画） ----
    const subtree = el(`<div class="subtree-container"></div>`);
    if (isExpanded) {
      subtree.classList.add('expanded');
    }

    // 状态-only instances 广播不会重建目录子树；每次 renderRows 都必须现读 instancesList，不能捕获
    // buildDirSection 当时的旧 state，否则后续 terminal revalidate 重画 rows 会把最新 Web 状态倒退。
    const currentLiveRows = () => {
      const liveMap = new Map();
      const freshTabs = [];
      for (const inst of instancesList) {
        if (!inst.instanceId || inst.cwd !== d) continue;
        if (inst.sessionId) liveMap.set(inst.sessionId, inst);
        else freshTabs.push(inst);
      }
      return { liveMap, freshTabs };
    };

    // 统一行：一条会话（session:list 的 s，或无 id 的新会话）→ DOM 行。liveInst 非空 = 已打开为 tab。
    // 全程 textContent（无 innerHTML 插值用户数据）→ CSP 安全。
    const sessionRow = (s, liveInst, rowCwd) => {
      const active = liveInst && liveInst.instanceId === viewingInstanceId;

      // 使用相对定位的包装容器来实现侧滑关闭
      const container = el(`<div class="relative overflow-hidden w-full select-none swipe-row-container"></div>`);

      // 背景红底“关闭”按钮
      let deleteBtn;
      if (liveInst) {
        deleteBtn = el(`<div class="absolute inset-y-0 right-0 w-[70px] bg-danger text-white flex items-center justify-center font-sans font-semibold text-xs active:opacity-90 cursor-pointer select-none" style="z-index: 10;">${t('关闭')}</div>`);
        deleteBtn.onclick = async (e) => {
          e.stopPropagation();
          haptic('warning');
          if (await appConfirm({
            title: `${t('关闭会话「')}${s.title || t('新会话')}${t('」？')}`,
            body: t('会话将从 tab 列表移除，但历史保留可重新打开。'),
            okText: t('关闭会话'),
          })) {
            // 点停止顿一下跳主页的回归修复：若关的正是当前正在看的会话，记下 id 供
            // wasViewingInstanceDestroyed 排除——这是用户自己确认过的主动关闭，不是"被摧毁"。
            explicitCloseInstanceId = liveInst.instanceId;
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
      const rowContent = el(`<div class="row-content relative flex items-center gap-2 pl-6 pr-3 py-2.5 border-b border-line-soft transition-transform duration-200 cursor-pointer${active ? ' bg-accent-wash' : ' bg-surface'}" style="z-index: 20;" data-testid="session-row" data-session-id="${esc(s.id || '')}" data-instance-id="${esc(liveInst?.instanceId || '')}"></div>`);
      rowContent.dataset.terminalState = s.terminal || '';
      const btn = el(`<button class="flex-1 min-w-0 text-left text-xs active:opacity-70"></button>`);
      btn.title = s.title || t('新会话');
      const head = el(`<div data-session-head class="flex items-center gap-1.5 min-w-0"></div>`);
      const titleSpan = el(`<span class="flex-1 min-w-0 truncate font-medium${active ? ' text-accent' : ' text-ink-soft'}"></span>`);
      titleSpan.textContent = s.title || t('新会话');
      head.appendChild(titleSpan);
      appendSessionStatusChip(head, liveInst?.state, s.terminal);
      btn.appendChild(head);
      const sub = el(`<div class="truncate text-ink-faint text-[10px]"></div>`);
      const when = s.lastUsedAt ? new Date(s.lastUsedAt).toLocaleString() : t('新会话（未保存）');
      let subText = when + (liveInst ? t(' · 已打开') : '');
      if (s.terminal === 'busy') subText += ` · ${t('终端')}`;
      else if (s.terminal === 'alive') subText += ` · ${t('终端会话已打开')}`;
      // 短 session_id（前 8 位）：便于对照 CLI /resume、日志、多设备定位同一会话；无 id 的新会话不显示。
      if (s.id) subText += ` · ${s.id.slice(0, 8)}`;
      sub.textContent = subText;
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
          socket.emit('session:switch', { sessionId: s.id, cwd: rowCwd }, res => { acked = true; if (!res?.ok) addBar(res?.error || t('切换失败'), 'text-danger'); });
          setTimeout(() => { if (!acked) addBar(t('切换无响应，请刷新页面后重试'), 'text-danger'); }, 4000);
        }
      };
      rowContent.appendChild(btn);

      // 原生 x 按钮：桌面/移动端均常显（此前 md:block hidden 只在桌面显示，手机端只能靠不可发现的侧滑
      // 手势——已打开会话本行没有其它可见按钮，用户体感是"点开会话后这行的图标凭空消失了"）。
      // 侧滑仍保留作快捷方式，二者并存、互不冲突，都是触发同一个 session:close。
      if (liveInst) {
        const closeBtn = el(`<button class="shrink-0 w-6 h-6 rounded text-ink-faint hover:text-danger hover:bg-sunk active:bg-line text-sm">✕</button>`);
        closeBtn.onclick = async e => {
          e.stopPropagation();
          haptic('warning');
          if (await appConfirm({
            title: `${t('关闭会话「')}${s.title || t('新会话')}${t('」？')}`,
            body: t('会话将从 tab 列表移除，但历史保留可重新打开。'),
            okText: t('关闭会话'),
          })) {
            // 同上（侧滑关闭按钮走的是另一条 DOM 路径，但同一个 session:close 语义）。
            explicitCloseInstanceId = liveInst.instanceId;
            socket.emit('session:close', { instanceId: liveInst.instanceId });
            closeLeftSidebar();
          }
        };
        rowContent.appendChild(closeBtn);
      }

      // 未打开的历史会话：两级删除入口（FR-20）。已打开的会话走上面的关闭 tab，不在此重复给删除入口
      // （删一个正被本产品驱动的会话语义混乱，后端 L2 保护①也会拒）。无 id 的新会话（未落盘）无从删。
      if (s.id && !liveInst) {
        const delBtn = el(`<button class="shrink-0 w-6 h-6 rounded text-ink-faint hover:text-danger hover:bg-sunk active:bg-line text-sm" title="${t('删除会话')}">🗑</button>`);
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
    // subtreeGen：populateSubtree 每次调用递增的代次，供内部各异步 ack 判断"自己是否已被更晚一次调用
    // 顶替"——expandedDirs.has(cwd) 只答"这个目录还展开着吗"，答不了"这次 ack 属于哪一次调用"。快速
    // 折叠再展开同一目录（复用同一个 container）时，旧调用的迟到 ack 若只查前者，可能用 renderRows
    // 整段清空刚渲染好的新内容。
    let subtreeGen = 0;
    let sessionListRequestGen = 0;
    const populateSubtree = (cwd, container, { background = false } = {}) => {
      // 后台保鲜不使现有 renderRows /「显示全部」闭包失效；首次（折叠目录尚未画过）仍建立代次。
      if (!background || subtreeGen === 0) subtreeGen += 1;
      const myGen = subtreeGen;
      // 渲染：无 id 新会话实例 + 会话行 +（若被截断）「显示全部」行
      // git worktree 不再嵌套在本目录下自动分组——须作为独立 workdir 出现在 availableDirs。
      const renderRows = (sessions, hasMore) => {
        const { liveMap, freshTabs } = currentLiveRows();
        container.innerHTML = '';
        for (const inst of freshTabs) {
          container.appendChild(sessionRow({ id: null, title: inst.title, lastUsedAt: null, entrypoint: null }, inst, cwd));
        }
        for (const s of sessions) {
          container.appendChild(sessionRow(s, liveMap.get(s.id), cwd));
        }
        if (hasMore) {
          const more = el(`<button class="w-full text-left pl-6 pr-3 py-2 text-xs text-accent hover:bg-sunk/50 border-b border-line-soft/40">${t('显示全部会话…')}</button>`);
          more.onclick = () => {
            haptic('tap');
            more.textContent = t('加载中…');
            expandedAllDirs.add(cwd); // 记住意图：后续 revalidate 也得按全量拉，否则重建一次就被打回截断
            const requestGen = ++sessionListRequestGen;
            socket.emit('session:list', { cwd, all: true }, state => {
              if (requestGen !== sessionListRequestGen) return;
              if (!isSessionPanelRevalidateActive() || !container.isConnected) return;
              if (!expandedDirs.has(cwd) || myGen !== subtreeGen) return;
              const all = state?.sessions || [];
              updateTerminalBusyForDir(cwd, all, state?.terminalBusy);
              sessionsCache.set(cwd, { sessions: all, hasMore: false });
              renderRows(all, false);
            });
          };
          container.appendChild(more);
        }
      };

      if (!background) {
        // 1) SWR 缓存极速呈现（缓存值形状：{sessions, hasMore}）：有缓存就先拿旧数据把列表画出来，
        // 不等网络；新鲜度交给下面那次无条件 revalidate。
        const cachedEntry = sessionsCache.get(cwd);
        if (cachedEntry) {
          renderRows(cachedEntry.sessions || [], cachedEntry.hasMore);
        } else {
          container.innerHTML = '';
          for (const inst of currentLiveRows().freshTabs) {
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
      }

      // 2) 后端异步刷新：无条件发 session:list——这就是 SWR 里的 revalidate，缓存只负责"秒开"，
      // 不负责"够新"。曾经这里加过 `仅当无缓存或已标 stale 才发` 的省流条件，而 stale 只在
      // 实例集 id 增删时置位，于是「id 集合没变、内容变了」的场景全部刷不出来：会话被改名、
      // session:list 自身返回值变化（如溢出截断转为 hasMore）都停留在旧数据上（P0-11n/v/w 就是
      // 为此而写的回归测试）。省下的那次 socket 往返不值这个正确性。
      //
      // 常规调用仍由结构变化/展开动作收窄；另有仅在抽屉可见时每 12 秒一次的 background revalidate，
      // 用来跟进 CLI registry 的 busy/alive。响应回来后由 shouldRerenderSessionList 比对内容签名，
      // 没真变化只更新缓存、不动 DOM，因此不会重画列表或闪骨架屏（P0-11t/P0-11z）。
      if (background && !socket.connected) return;
      const requestGen = ++sessionListRequestGen;
      socket.emit('session:list', { cwd, all: expandedAllDirs.has(cwd) }, state => {
        if (requestGen !== sessionListRequestGen) return;
        if (!isSessionPanelRevalidateActive() || !container.isConnected) return;
        if (myGen !== subtreeGen) return;
        if (!background && !expandedDirs.has(cwd)) return;
        const sessions = state?.sessions || [];
        const hasMore = !!state?.hasMore;
        updateTerminalBusyForDir(cwd, sessions, state?.terminalBusy);
        const prevEntry = sessionsCache.get(cwd);
        const willRerender = shouldRerenderSessionList({
          hasPrevEntry: !!prevEntry,
          prevSessions: prevEntry?.sessions,
          prevHasMore: prevEntry?.hasMore,
          nextSessions: sessions,
          nextHasMore: hasMore,
        });
        sessionsCache.set(cwd, { sessions, hasMore });
        if (willRerender) renderRows(sessions, hasMore);
      });
    };

    // 如果当前展开，则渲染列表
    if (isExpanded) {
      populateSubtree(d, subtree);
    }

    // 折叠/展开切换：纯 CSS 驱动，不触发重绘全量 DOM
    toggleBtn.onclick = () => {
      haptic('tap');
      if (expandedDirs.has(d)) {
        expandedDirs.delete(d);
        try { localStorage.setItem('ccm_expanded_dirs', JSON.stringify([...expandedDirs])); } catch {}
        subtree.classList.remove('expanded');
        arrow.classList.remove('rotated');
        icon.textContent = '📁';
      } else {
        expandedDirs.add(d);
        try { localStorage.setItem('ccm_expanded_dirs', JSON.stringify([...expandedDirs])); } catch {}
        subtree.classList.add('expanded');
        arrow.classList.add('rotated');
        icon.textContent = '📂';
        populateSubtree(d, subtree);
      }
    };

    return {
      dirRow,
      subtree,
      revalidate: () => populateSubtree(d, subtree, { background: true }),
    };
  }

  function openSessionPanel() {
    sessionPanel.innerHTML = '';
    // UX-007：当前工作区默认展开 + 记忆用户展开态
    try {
      const saved = JSON.parse(localStorage.getItem('ccm_expanded_dirs') || '[]');
      if (Array.isArray(saved)) for (const d of saved) if (d) expandedDirs.add(d);
    } catch { /* ignore */ }
    if (currentCwd) expandedDirs.add(currentCwd);

    // 抽屉 = 注意力入口 + 导航树（非状态仪表盘）：需要你 → 服务异常 → 工作区树。
    // "需要你"聚合置顶（AD-11/§3.2.5 AttentionDeriver，承接 FR-21）：跨全部工作区/会话，
    // 不限于当前展开的目录——正是它相对下方逐目录列表的增量价值（注意力不对称）。
    sessionPanel.appendChild(buildNeedsYouSection());
    sessionPanel.appendChild(buildServiceSection());

    // 按 availableDirs 顺序（=WORK_DIR 首位 + WORK_DIRS），每目录一行：
    //   展开：📂 ▼ basename + 角标 → 下方缩进显示该目录会话列表（纯 /resume 时间序，已打开者就地标 ✕/角标）
    //   折叠：📁 ▶ basename + 角标 → 点击展开（若非当前 cwd 则同时切换）
    dirSectionNodes = new Map();
    for (const d of availableDirs) {
      const section = buildDirSection(d);
      sessionPanel.appendChild(section.dirRow);
      sessionPanel.appendChild(section.subtree);
      dirSectionNodes.set(d, section);
    }
    startSessionPanelRevalidator();
  }

  // P3 抽屉局部重建：只重建 changedDirs 列出的目录（调用方=setInstances，changedDirs 来自
  // diffDirSignatures），其余目录的 dirRow/subtree 保持原 DOM 节点不动——滚动位置、侧滑态、
  // "显示全部"展开态等本地态都不受影响，不会像全量重建那样连坐撤离。dirRow 与 subtree 必须保持
  // 相邻兄弟节点（expandWorkspace 等测试辅助函数按 nextElementSibling 定位 subtree），两次
  // replaceWith 各自原地替换，不改变整体顺序，故这个不变量始终成立。
  function rebuildDirSections(changedDirs) {
    for (const d of changedDirs) {
      const old = dirSectionNodes.get(d);
      if (!old || !old.dirRow.isConnected) {
        // 防御：面板还没针对这个目录做过全量渲染（理论上不应发生——setInstances 里
        // isDesktop||isPanelOpen 门控保证局部重建只在面板已可见时触发，可见就必然渲染过）。
        // 自愈：退化为全量重建，好过留下一段不完整的面板。
        openSessionPanel();
        return;
      }
      const next = buildDirSection(d);
      old.dirRow.replaceWith(next.dirRow);
      old.subtree.replaceWith(next.subtree);
      dirSectionNodes.set(d, next);
    }
  }

  function isSessionPanelRevalidateActive() {
    if (!leftSidebar || document.visibilityState !== 'visible') return false;
    if (window.innerWidth >= 1024) return !document.body.classList.contains('sidebar-collapsed');
    return !leftSidebar.classList.contains('-translate-x-full');
  }
  function stopSessionPanelRevalidator() {
    if (sessionPanelRevalidateTimer) clearTimeout(sessionPanelRevalidateTimer);
    sessionPanelRevalidateTimer = null;
    // 抽屉不可见时不再刷新 CLI registry；与其让顶部/目录无限保留旧 busy，不如撤下这条临时信号。
    if (terminalBusyByDir.size) {
      terminalBusyByDir.clear();
      refreshDirBadges();
      updateSessionsDot();
    }
    // SWR 缓存仍保留标题/时间以便下次秒开，但 terminal 是短时活体状态，关闭后必须剥掉，避免重开时
    // 先画一帧已经结束的“终端运行中”。
    for (const [cwd, entry] of sessionsCache) {
      let changed = false;
      const sessions = (entry?.sessions || []).map(session => {
        if (!session?.terminal) return session;
        changed = true;
        const copy = { ...session };
        delete copy.terminal;
        return copy;
      });
      if (changed) sessionsCache.set(cwd, { ...entry, sessions });
    }
  }
  function revalidateSessionPanelDirs() {
    if (!isSessionPanelRevalidateActive()) { stopSessionPanelRevalidator(); return; }
    if (socket.connected) {
      for (const cwd of availableDirs) dirSectionNodes.get(cwd)?.revalidate?.();
    }
    scheduleSessionPanelRevalidate();
  }
  function scheduleSessionPanelRevalidate(delay = SESSION_PANEL_REVALIDATE_MS) {
    if (sessionPanelRevalidateTimer || !isSessionPanelRevalidateActive()) return;
    sessionPanelRevalidateTimer = setTimeout(() => {
      sessionPanelRevalidateTimer = null;
      revalidateSessionPanelDirs();
    }, delay);
  }
  function startSessionPanelRevalidator({ immediate = false } = {}) {
    if (!isSessionPanelRevalidateActive()) { stopSessionPanelRevalidator(); return; }
    if (immediate) revalidateSessionPanelDirs();
    else scheduleSessionPanelRevalidate();
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') startSessionPanelRevalidator({ immediate: true });
    else stopSessionPanelRevalidator();
  });
  window.addEventListener('pagehide', stopSessionPanelRevalidator);

  // 清视图层（DOM + 去重基线 + 弹窗队列），不加载历史——加载由调用方决定（台阶3：bindView 切 tab 时
  // 先 sync 活缓冲、无缓冲再 history）。

  // UX-008 回落：非 empty-start 的空消息区（极少路径）。＋ 主路径走 showComposeSurface，不靠这里。
  function maybeShowEmptySessionGuide() {
    if (!messagesEl || messagesEl.childNodes.length) return;
    if (messagesEl.classList.contains('empty-start')) return;
    if (_composeReady) return; // compose 页由 showComposeSurface 渲染
    const guide = el(`
      <div class="empty-session-guide flex flex-col items-center justify-center py-10 px-4 text-center select-none" data-testid="empty-session-guide">
        <div class="text-base font-medium text-ink mb-1">${t('新会话已就绪')}</div>
        <div class="text-xs text-ink-soft mb-4">${t('工作区')} <span class="font-semibold text-ink">${esc(baseName(currentCwd) || '…')}</span>${currentModel ? ` · ${t('模型')} <span class="font-semibold">${esc(currentModel)}</span>` : ''}</div>
        <div class="flex flex-col gap-2 w-full max-w-sm">
          <button type="button" class="esg-prompt text-left text-xs px-3 py-2 rounded-xl border border-line bg-surface text-ink-soft active:bg-sunk" data-p="${t('总结当前仓库结构并指出入口文件')}">${t('💡 总结当前仓库结构')}</button>
          <button type="button" class="esg-prompt text-left text-xs px-3 py-2 rounded-xl border border-line bg-surface text-ink-soft active:bg-sunk" data-p="${t('帮我写一个最小改动的修复计划')}">${t('🛠 写一个最小修复计划')}</button>
          <button type="button" class="esg-prompt text-left text-xs px-3 py-2 rounded-xl border border-line bg-surface text-ink-soft active:bg-sunk" data-p="${t('运行相关测试并解读失败')}">${t('🧪 运行测试并解读')}</button>
        </div>
      </div>`);
    guide.querySelectorAll('.esg-prompt').forEach(btn => {
      btn.onclick = () => {
        haptic('tap');
        if (inputEl) {
          inputEl.value = btn.getAttribute('data-p') || '';
          inputEl.focus();
          inputEl.dispatchEvent(new Event('input'));
        }
      };
    });
    messagesEl.appendChild(guide);
  }

  function clearView(sessionId, tip) {
    currentSessionId = sessionId;
    lastSeq = 0;
    curEpoch = null;
    localStorage.setItem('current_session', sessionId || '');
    messagesEl.innerHTML = '';
    messagesEl.classList.remove('empty-start');
    clearStreams(); thinkings.clear(); toolCards.clear();
    histToolCards.clear(); histSubCards.clear(); // 切会话/清屏：历史配对表也要随 DOM 一起归零，防跨会话误配对
    turnFileChanges = new Map(); // 切会话：丢弃未 flush 的本轮账本
    // UX-008：清视图后若仍无内容（新会话），给极简引导
    queueMicrotask(() => maybeShowEmptySessionGuide());
    subagentCards.clear(); // 切会话/清屏：丢弃子 agent 卡状态（DOM 已随 messagesEl 清空）
    approvals.clearAll();
    // 附件托盘不再这里无脑清空：bindView 经 planSessionDraftSwap 按会话存/取；
    // 发送成功路径各自清空。否则同会话静默换实例 / 重载历史会误清未发送附件。
    setBusy(false);
    // 发送闸同理乐观清零：切到别的会话时不该把上一个会话的「运行中」提示带过去。
    // 随后的 setInstances 会按新实例的 turnRunning 校正（与 setBusy 同一套「先清、广播再定」哲学）。
    _turnRunning = false;
    // 发送窗口内同会话静默换实例 / history reload 二次 clearView 须补回 busy
    // （innerHTML='' 会拆掉 #streamLiveStatus；setBusy(false) 也会 hide）。真切会话则不补。
    if (shouldRestoreOptimisticBusy({
      pendingFirstSend: _pendingFirstSend,
      pendingSendBusySessionId: _pendingSendBusySessionId,
      viewingInstanceId: displayedInstanceId,
      sessionId,
    })) {
      setBusy(true);
      _turnRunning = true; // 同会话静默换实例：那条刚发出的消息仍在跑，闸不能松
    }
    hideActivityBanner(); // WS-005：清 activity 横幅，否则 A 的子 agent 活动态残留到空闲的 B（task-progress 已由 setInstances 按实例处理；API 重试态随 liveLine 一起销毁）

    // Clear stale status line and hide details row to prevent latency layout flashes
    if (cliStatusEl) cliStatusEl.innerHTML = '';
    if (cliSummaryEl) cliSummaryEl.textContent = 'statusline';
    if (cliStatusWrapEl) {
      cliStatusWrapEl.removeAttribute('open'); // Fold <details> element
      cliStatusWrapEl.classList.add('hidden'); // Hide the wrapper
    }
    pillDefaults?.classList.remove('hidden'); // 恢复底栏会话档摘要 chip（statusLine 隐藏时）
    if (tip) addBar(tip, 'text-ink-faint');
  }

  // 空首页最近列表代次：连续 showDashboard（切 cwd / 重连）时丢弃过期 ack，防旧列表盖新。
  // 产品决策：重启/空闲回收后永远停在空首页，只展示最近列表，不自动 session:switch。
  let _dashRecentsGen = 0;

  // 底部输入区显隐：空首页枢纽隐藏；composeReady（点 ＋）/ 有 session / 首发在途显示。
  const composerFooterEl = document.getElementById('composerFooter') || document.querySelector('footer');
  function syncComposerVisibility() {
    const sid = instancesList.find(x => x.instanceId === viewingInstanceId)?.sessionId
      || currentSessionId
      || displayedSessionId
      || null;
    const show = shouldShowComposer({
      viewingInstanceId,
      sessionId: sid,
      composeReady: _composeReady,
      pendingFirstSend: _pendingFirstSend,
      freshInterrupted: viewingInstanceId === freshInterruptedInstanceId,
    });
    if (!composerFooterEl) return;
    composerFooterEl.classList.toggle('hidden', !show);
  }
  // 顶部文件夹 pill：仅真实会话显示（首页/compose 页内已有工作区入口，再放会重复）。
  function syncTopContextPillVisibility(viewingId = viewingInstanceId, sessionId = null) {
    if (!topContextPill) return;
    const sid = sessionId
      ?? instancesList.find(x => x.instanceId === viewingId)?.sessionId
      ?? currentSessionId
      ?? displayedSessionId
      ?? null;
    const show = shouldShowTopContextPill({ viewingInstanceId: viewingId, sessionId: sid });
    topContextPill.classList.toggle('hidden', !show);
    // 隐藏时不可聚焦，避免读屏仍读到工作区入口
    topContextPill.tabIndex = show ? 0 : -1;
    topContextPill.setAttribute('aria-hidden', show ? 'false' : 'true');
  }
  /**
   * 顶栏 pill 的未提交改动角标。数据源是 status_line 事件里现成的 git 段——不发 git:status、不加轮询。
   * 角标记住自己属于哪个 cwd（dataset.cwd），供 syncTopContextLabel 判断换区后是否该清零。
   */
  function updateWorkspaceChangeBadge(git) {
    if (!topContextChanges) return;
    const text = formatWorkspaceChangeBadge(git);
    topContextChanges.textContent = text;
    topContextChanges.classList.toggle('hidden', !text);
    topContextChanges.dataset.cwd = currentCwd || '';
  }
  // 顶栏主 pill 文案：固定工作区 basename（机主拍板不要会话标题——同仓多会话靠侧栏区分）。
  // #topTitleText 仍 hidden；title 挂完整 cwd 供长按辨认。
  function syncTopContextLabel() {
    const project = baseName(currentCwd);
    if (topProjectText) topProjectText.textContent = project || '…';
    // 换工作区即清角标：别让上个工作区的数字挂在新工作区名旁边（下一条 status_line 会填新值）。
    // 判据用 cwd 归属而非「每次调用都清」——本函数随 instances 广播高频触发，无条件清会让角标反复闪。
    if (topContextChanges && topContextChanges.dataset.cwd !== (currentCwd || '')) {
      updateWorkspaceChangeBadge(null);
    }
    if (topContextPill) {
      topContextPill.title = currentCwd
        ? `${t('工作区：浏览或查看改动')} · ${currentCwd}`
        : t('工作区：浏览或查看改动');
    }
  }
  function enterComposeReady() {
    _composeReady = true;
    syncComposerVisibility();
  }
  function leaveComposeReady() {
    if (!_composeReady) {
      syncComposerVisibility();
      return;
    }
    _composeReady = false;
    syncComposerVisibility();
  }

  // 读底栏 pill 已同步的文案（instances defaults / models scout）→ 写进 compose 页摘要。
  // 与 setPermMode / setEffortMode / syncModelUI 同源，避免页内与底栏各猜一套。
  function currentComposeDefaultsLabels() {
    const cliDefault = (modelsList || []).find(m => (typeof m === 'string' ? m : m?.value) === 'default');
    const cliDefaultLabel = cliDefault && typeof cliDefault === 'object'
      ? (cliDefault.displayName || 'Default (recommended)')
      : null;
    // 与底栏 pill 同源（resolveModelPillText）：新会话空 model 时同样把 cwd 默认别名解析成真实模型名，
    // 不再各猜一套 / 靠读 pill DOM 文案兜底。
    // H3：compose 摘要与底栏 pill 同源——优先待发 modelInput（下一条才生效），否则 currentModel
    const pendingModel = (modelInput?.dataset?.fullModel || modelInput?.value || '').trim();
    const modelForSummary = (pendingModel && pendingModel !== 'default') ? pendingModel : currentModel;
    const modelLabel = resolveModelPillText({
      model: modelForSummary,
      gatewaySuffix: currentGatewaySuffix,
      modelsList,
      cwdDefaultModel,
      cliDefaultLabel,
    });
    return {
      modelLabel,
      modeLabel: (pillPermText?.textContent || '').trim(),
      effortLabel: (pillEffortText?.textContent || '').trim(),
    };
  }
  function refreshComposeDefaultsSummary() {
    const elSum = messagesEl?.querySelector?.('[data-compose-defaults]');
    if (!elSum) return;
    elSum.textContent = formatComposeDefaultsSummary(currentComposeDefaultsLabels());
  }

  // CLI 配置刷新：用户在终端侧改了 ~/.claude/settings.json 后，web 侧默认档不会自己感知
  // （ensureCliDefaults 按 cwd 缓存，只在启动/session:new/session:home 才 force 重读）——手动兜底一次
  // force 重读。ack 前禁用+转圈，ack 后恢复；面板与摘要的文案本身经 instances 广播回来的既有路径
  // （refreshComposeDefaultsSummary / rebuildCustomModelGrid 等）自动刷新，这里不重复写渲染逻辑。
  //
  // 两个入口共用：新会话页摘要行旁的 ↻（只在 compose 页存在）、会话设置标题行右侧 ↻
  // （常驻，已有会话里也能用）。spinEl 单独传：只转图标，避免整块按钮旋转。
  function wireConfigRefreshButton(btn, spinEl = btn) {
    if (!btn) return;
    btn.onclick = () => {
      if (btn.disabled) return;
      haptic('tap');
      btn.disabled = true;
      spinEl.classList.add('animate-spin');
      let acked = false;
      const restore = () => {
        btn.disabled = false;
        spinEl.classList.remove('animate-spin');
      };
      socket.emit('config:refresh', { cwd: currentCwd }, () => {
        acked = true;
        restore();
        // 成功反馈：有 [data-label] 就改文案；图标按钮则改 title 两秒（面板盖住消息流时 addBar 看不见）。
        const labelEl = btn.querySelector('[data-label]');
        if (labelEl) {
          if (labelEl.dataset.reverting === '1') return;
          const original = labelEl.textContent;
          labelEl.dataset.reverting = '1';
          labelEl.textContent = t('✓ 已刷新');
          setTimeout(() => {
            labelEl.textContent = original;
            delete labelEl.dataset.reverting;
          }, 2000);
          return;
        }
        if (btn.dataset.titleReverting === '1') return;
        const originalTitle = btn.getAttribute('title') || '';
        btn.dataset.titleReverting = '1';
        btn.setAttribute('title', t('✓ 已刷新'));
        setTimeout(() => {
          btn.setAttribute('title', originalTitle);
          delete btn.dataset.titleReverting;
        }, 2000);
      });
      // 兜底：与文件里其它「乐观禁用+超时兜底恢复」操作（session:home/session:switch 等）对齐——
      // ack 丢了也不能让按钮永久卡在禁用+转圈态。
      setTimeout(() => {
        if (acked) return;
        restore();
        addBar(t('刷新无响应，请检查网络后重试'), 'text-danger');
      }, 4000);
    };
  }

  // 空表面本地分流：viewing 已 null 时 instances 广播不进 bindView，＋/侧栏 ＋ 须直接重渲。
  function ensureEmptySurface() {
    const sid = instancesList.find(x => x.instanceId === viewingInstanceId)?.sessionId
      || currentSessionId
      || displayedSessionId
      || null;
    const surface = resolveEmptySurface({
      viewingInstanceId,
      sessionId: sid,
      composeReady: _composeReady,
      freshInterrupted: Boolean(viewingInstanceId) && viewingInstanceId === freshInterruptedInstanceId,
    });
    if (surface === 'compose') showComposeSurface();
    else if (surface === 'home') showDashboard();
  }

  // 干净新会话页（＋ / session:new）：当前工作区 + 将开 CLI 的默认档 + 示例 prompt；无最近列表。
  function showComposeSurface() {
    messagesEl.innerHTML = '';
    messagesEl.classList.add('empty-start');
    if (topTitleText) topTitleText.textContent = t('新聊天');
    if (topProjectText) topProjectText.textContent = baseName(currentCwd);
    syncComposerVisibility();
    syncTopContextPillVisibility(null, null); // compose 页：隐藏顶栏文件夹（页内已有工作区 pill）

    const defaultsText = formatComposeDefaultsSummary(currentComposeDefaultsLabels());
    const container = el(`
      <div class="compose-surface flex flex-col items-center w-full max-w-xl mx-auto py-8 px-3 select-none" data-testid="compose-surface">
        <div class="text-center mb-5 w-full">
          <h1 class="text-xl md:text-2xl font-bold tracking-tight text-ink mb-2 leading-tight">${t('新会话已就绪')}</h1>
          <div class="text-[10px] text-ink-faint uppercase tracking-wider mb-1">${t('将在此工作区开新 CLI 会话')}</div>
          <button type="button" class="compose-project-pill inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full border border-line-soft bg-surface text-ink hover:bg-sunk active:scale-[0.98] transition-all text-xs font-semibold shadow-sm" title="${t('点击打开会话列表（按工作区浏览）')}">
            <svg class="w-4 h-4 shrink-0 text-accent opacity-90" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M3 7.5A2.5 2.5 0 015.5 5h4.25l2 2H18.5A2.5 2.5 0 0121 9.5v7A2.5 2.5 0 0118.5 19h-13A2.5 2.5 0 013 16.5v-9z" />
            </svg>
            <span class="max-w-[12rem] truncate">${esc(baseName(currentCwd))}</span>
            <span class="text-xs text-ink-faint">⌄</span>
          </button>
          <div class="mt-2 flex items-center justify-center gap-1">
            <span class="text-xs text-ink-soft" data-compose-defaults>${esc(defaultsText)}</span>
            <button type="button" class="compose-defaults-refresh shrink-0 w-5 h-5 flex items-center justify-center rounded-full text-ink-faint hover:text-ink hover:bg-sunk active:scale-90 transition-all disabled:opacity-50" data-testid="compose-defaults-refresh" title="${t('重新读取 CLI 配置')}">
              <span class="text-sm leading-none">↻</span>
            </button>
          </div>
        </div>
        <div class="flex flex-col gap-2 w-full max-w-sm">
          <button type="button" class="esg-prompt text-left text-xs px-3 py-2 rounded-xl border border-line bg-surface text-ink-soft active:bg-sunk" data-p="${t('总结当前仓库结构并指出入口文件')}">${t('💡 总结当前仓库结构')}</button>
          <button type="button" class="esg-prompt text-left text-xs px-3 py-2 rounded-xl border border-line bg-surface text-ink-soft active:bg-sunk" data-p="${t('帮我写一个最小改动的修复计划')}">${t('🛠 写一个最小修复计划')}</button>
          <button type="button" class="esg-prompt text-left text-xs px-3 py-2 rounded-xl border border-line bg-surface text-ink-soft active:bg-sunk" data-p="${t('运行相关测试并解读失败')}">${t('🧪 运行测试并解读')}</button>
        </div>
      </div>`);

    container.querySelector('.compose-project-pill').onclick = (e) => {
      e.stopPropagation();
      haptic('tap');
      if (btnSessions) btnSessions.onclick();
    };
    container.querySelectorAll('.esg-prompt').forEach(btn => {
      btn.onclick = () => {
        haptic('tap');
        if (inputEl) {
          inputEl.value = btn.getAttribute('data-p') || '';
          inputEl.focus();
          inputEl.dispatchEvent(new Event('input'));
        }
      };
    });
    wireConfigRefreshButton(container.querySelector('.compose-defaults-refresh'));

    messagesEl.appendChild(container);
    // defaults 可能仍在 L4→L3 途中；微任务再刷一次，兜住刚 setPerm/setEffort 的 pill 文案
    queueMicrotask(() => refreshComposeDefaultsSummary());
  }

  // 点停止顿一下跳主页的回归修复：正在查看的实例被摧毁（中断失败→settleForce 强杀子进程→onExit→
  // 无同 cwd 存活实例可回退，见 wasViewingInstanceDestroyed）时的专属提示态——不静默 showDashboard()，
  // 让用户先看到"发生了什么"，自己决定下一步（回首页 / 新建会话）。不做自动导航（机主已否决"自动
  // 静默 resume 接管"方案，这里同理：不能因为实现方便就悄悄跳转）。
  // 视觉语言复用两处既有约定：标题行走 addBar 同款 msg-frame 系统提示条样式（对齐 interrupted/
  // queue_dropped 的系统提示行）；外层卡片 + 操作按钮走 showDashboard/showComposeSurface 同款
  // 空表面卡片布局——不引入新的弹窗/模态体系。两个按钮直接复用 btnHome/btnNew 的既有点击处理，
  // 不重复其内部逻辑（保持行为完全一致，包括 haptic、freshInterruptedInstanceId 清理等副作用）。
  // byRestart：server 整机重启细分（见 setInstances 的 detectServerRestart）——不是这个实例被单独
  // 摧毁，文案换成准确的「服务已重启」，并加「继续此会话」一键重开（resume={sessionId,cwd} 走既有
  // session:switch 打开路径懒 resume，与侧栏/最近列表点击同源）。不自动切换：尊重「重启后不自动
  // session:switch」的既有产品决策（见 _dashRecentsGen 注释），按钮是用户主动点的。
  function showInstanceDestroyedSurface({ byRestart = false, resume = null } = {}) {
    messagesEl.innerHTML = '';
    messagesEl.classList.add('empty-start');
    if (topTitleText) topTitleText.textContent = t('新聊天');
    if (topProjectText) topProjectText.textContent = baseName(currentCwd);
    syncComposerVisibility();
    syncTopContextPillVisibility(null, null); // 无实例可看：顶栏文件夹入口隐藏（同 home/compose）

    const title = byRestart ? t('🔄 服务已重启') : t('⏹ 会话已中断');
    const body = byRestart
      ? t('服务已重启，之前的会话进程随之退出。会话记录仍保存在磁盘上，可以继续此会话，也可以回首页或新建一个会话。')
      : t('停止操作未能正常结束，后台会话进程已意外退出，无法直接继续。可以回首页，或在此工作区新建一个会话。');
    const canResume = byRestart && resume?.sessionId && resume?.cwd;
    const container = el(`
      <div class="instance-destroyed-surface flex flex-col items-center w-full max-w-xl mx-auto py-8 px-3 select-none" data-testid="instance-destroyed-surface">
        <div class="msg-frame text-center text-xs text-warning font-semibold mb-2">${title}</div>
        <p class="text-xs text-ink-faint text-center mb-6 max-w-sm leading-relaxed px-2">${body}</p>
        <div class="flex flex-col gap-2 w-full max-w-xs">
          ${canResume ? `<button type="button" class="instance-destroyed-resume inline-flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-full border border-line-soft bg-surface text-ink hover:bg-sunk active:scale-[0.98] transition-all text-xs font-semibold shadow-sm" data-testid="instance-destroyed-resume">${t('继续此会话')}</button>` : ''}
          <button type="button" class="instance-destroyed-home inline-flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-full border border-line-soft bg-surface text-ink hover:bg-sunk active:scale-[0.98] transition-all text-xs font-semibold shadow-sm" data-testid="instance-destroyed-home">${t('回首页')}</button>
          <button type="button" class="instance-destroyed-new inline-flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-full border border-line-soft bg-surface text-ink hover:bg-sunk active:scale-[0.98] transition-all text-xs font-semibold shadow-sm" data-testid="instance-destroyed-new">${t('新建会话')}</button>
        </div>
      </div>`);

    if (canResume) {
      const resumeBtn = container.querySelector('.instance-destroyed-resume');
      resumeBtn.onclick = (e) => {
        e.stopPropagation();
        haptic('tap');
        // 乐观禁用 + ack/超时兜底恢复：对齐 dashboard 最近列表 switchToSession 的既有约定。
        // 成功路径不必手动导航——服务端广播新 viewingInstanceId，setInstances→bindView 自然接管。
        resumeBtn.disabled = true;
        let acked = false;
        socket.emit('session:switch', { sessionId: resume.sessionId, cwd: resume.cwd }, res => {
          acked = true;
          if (!res?.ok) { resumeBtn.disabled = false; addBar(res?.error || t('切换失败'), 'text-danger'); }
        });
        setTimeout(() => { if (!acked) { resumeBtn.disabled = false; addBar(t('切换无响应，请刷新页面后重试'), 'text-danger'); } }, 4000);
      };
    }
    container.querySelector('.instance-destroyed-home').onclick = (e) => {
      e.stopPropagation();
      btnHome?.onclick?.();
    };
    container.querySelector('.instance-destroyed-new').onclick = (e) => {
      e.stopPropagation();
      btnNew.onclick?.();
    };

    messagesEl.appendChild(container);
  }

  function showDashboard() {
    messagesEl.innerHTML = '';
    messagesEl.classList.add('empty-start');
    if (topTitleText) topTitleText.textContent = t('新聊天');
    if (topProjectText) topProjectText.textContent = baseName(currentCwd);
    syncComposerVisibility();
    syncTopContextPillVisibility(null, null); // 首页：顶栏文件夹隐藏

    const hour = new Date().getHours();
    let greeting;
    if (hour < 5) greeting = t('夜深了，有什么需要我帮忙的吗？');
    else if (hour < 11) greeting = t('上午好，今天我能帮您做什么？');
    else if (hour < 13) greeting = t('中午好，今天我能帮您做什么？');
    else if (hour < 18) greeting = t('下午好，今天我能帮您做什么？');
    else greeting = t('晚上好，今天我能帮您做什么？');

    // 首页 = 枢纽：问候 + 最近工作区/会话；不标「当前工作区」
    // （＋ 仍用 currentCwd 默认区；要先选区 → 侧栏或最近 chip）
    const container = el(`
      <div class="dashboard-container flex flex-col items-center w-full max-w-xl mx-auto py-6 px-3 select-none" data-testid="home-dashboard">
        <div class="text-center mb-6 w-full">
          <h1 class="text-2xl md:text-3xl font-bold tracking-tight text-ink mb-1 leading-tight" id="dashGreeting">${esc(greeting)}</h1>
          <p class="text-xs text-ink-faint">${t('从最近会话继续，或点 ＋ 新建')}</p>
        </div>

        <div id="dashWorkspacesSection" class="w-full hidden mb-5">
          <div class="text-[10.5px] font-bold text-ink-faint uppercase tracking-wider mb-2 px-1 flex items-center gap-1">
            <span>📁</span>
            <span>${t('最近活跃工作区')}</span>
          </div>
          <div id="dashWorkspacesList" class="flex flex-wrap gap-2 w-full px-0.5"></div>
        </div>

        <div id="dashRecentsSection" class="w-full hidden">
          <div class="text-[10.5px] font-bold text-ink-faint uppercase tracking-wider mb-3 px-1 flex items-center gap-1">
            <span>⏱️</span>
            <span>${t('最近活跃会话')}</span>
          </div>
          <div id="dashRecentsList" class="flex flex-col gap-2 w-full"></div>
        </div>

        <div id="dashEmptyHint" class="w-full hidden text-center mt-2">
          <p class="text-xs text-ink-faint mb-3">${t('还没有最近会话')}</p>
          <button type="button" class="dash-open-sessions inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full border border-line-soft bg-surface text-ink hover:bg-sunk active:scale-[0.98] transition-all text-xs font-semibold shadow-sm" title="${t('打开会话列表')}">
            ${t('打开工作区与会话列表')}
          </button>
        </div>

        <button id="dashHelpLink" class="mt-6 text-xs text-ink-faint hover:text-accent underline underline-offset-2 transition-colors" type="button">${t('❓ 如何连接与使用')}</button>
      </div>`);

    // 绑定使用引导入口 → 访问帮助页（showAccessHelp）
    const dashHelp = container.querySelector('#dashHelpLink');
    if (dashHelp) dashHelp.onclick = (e) => { e.stopPropagation(); haptic('tap'); showAccessHelp(); };

    const openSessions = (e) => {
      e?.stopPropagation?.();
      haptic('tap');
      if (btnSessions) btnSessions.onclick();
    };
    container.querySelector('.dash-open-sessions')?.addEventListener('click', openSessions);

    // 跨全部白名单工作区拉最近会话（并行 session:list），合并后展示，便于冷启动/空首页一键切回。
    // git worktree 须作为独立 workdir 写入 workdirs.json，才会出现在 availableDirs 里被扫到。
    const recentsSection = container.querySelector('#dashRecentsSection');
    const recentsList = container.querySelector('#dashRecentsList');
    const workspacesSection = container.querySelector('#dashWorkspacesSection');
    const workspacesList = container.querySelector('#dashWorkspacesList');
    const emptyHint = container.querySelector('#dashEmptyHint');
    const dirs = (availableDirs && availableDirs.length) ? availableDirs.slice() : (currentCwd ? [currentCwd] : []);
    const gen = ++_dashRecentsGen;

    const switchToSession = (s) => {
      let acked = false;
      socket.emit('session:switch', { sessionId: s.id, cwd: s.cwd }, res => {
        acked = true;
        if (!res?.ok) addBar(res?.error || t('切换失败'), 'text-danger');
      });
      setTimeout(() => { if (!acked) addBar(t('切换无响应，请刷新页面后重试'), 'text-danger'); }, 4000);
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
              <span class="shrink-0 opacity-80 dash-ws-icon"></span>
              <span class="truncate max-w-[10rem]"></span>
            </button>`);
          chip.querySelector('.dash-ws-icon').textContent = '📁';
          chip.querySelector('span.truncate').textContent = s.workspaceName;
          chip.title = s.cwd;
          chip.onclick = (e) => {
            e.stopPropagation();
            haptic('tap');
            switchToSession(s);
          };
          workspacesList.appendChild(chip);
        }
        if (wsOrder.length) workspacesSection.classList.remove('hidden');
        else workspacesSection.classList.add('hidden');
      }

      recentsList.innerHTML = '';
      for (const s of recent) {
        const when = s.lastUsedAt ? new Date(s.lastUsedAt).toLocaleString() : t('时间未知');
        const item = el(`
          <div class="dash-recent-item flex items-center justify-between p-3 bg-surface hover:bg-accent-wash/30 border border-line-soft hover:border-accent-bright/50 rounded-xl cursor-pointer transition-all active:scale-[0.99]">
            <div class="flex-1 min-w-0 pr-3">
              <div class="font-bold text-xs text-ink truncate"></div>
              <div class="text-[10px] text-ink-faint mt-1 flex items-center gap-1.5 min-w-0">
                <span class="shrink-0 dash-ws-icon"></span>
                <span class="truncate dash-ws"></span>
                <span class="shrink-0 opacity-50">·</span>
                <span class="shrink-0 dash-when"></span>
              </div>
            </div>
            <div class="text-xs text-accent font-bold shrink-0">${t('进入 ➔')}</div>
          </div>
        `);
        item.querySelector('.font-bold').textContent = s.title || t('无标题会话');
        item.querySelector('.dash-ws-icon').textContent = '📁';
        item.querySelector('.dash-ws').textContent = s.workspaceName;
        item.querySelector('.dash-when').textContent = when;
        item.title = `${s.workspaceName} · ${s.title || t('无标题会话')}`;
        item.onclick = (e) => {
          e.stopPropagation();
          haptic('tap');
          switchToSession(s);
        };
        recentsList.appendChild(item);
      }
      if (recent.length) {
        recentsSection.classList.remove('hidden');
        emptyHint?.classList.add('hidden');
      } else {
        recentsSection.classList.add('hidden');
        emptyHint?.classList.remove('hidden');
      }
    };

    if (recentsSection && recentsList && dirs.length) {
      const listMain = (cwd) => new Promise(resolve => {
        let settled = false;
        const done = (sessions) => { if (!settled) { settled = true; resolve({ cwd, sessions }); } };
        socket.emit('session:list', { cwd }, state => done(state?.sessions || []));
        setTimeout(() => done([]), 4000); // 单目录超时不挡整表
      });
      Promise.all(dirs.map(listMain)).then((mainLists) => {
        if (gen !== _dashRecentsGen) return; // 已换页/重渲
        const recent = mergeRecentSessionsAcrossWorkspaces(mainLists, { limit: 8 });
        renderDashRecents(recent); // 空列表也渲 → dashEmptyHint
      });
    } else if (emptyHint) {
      emptyHint.classList.remove('hidden');
    }

    messagesEl.appendChild(container);
  }

  // onDone：历史渲染真正落地（含 renderHistoryBubbles 内部分块 requestIdleCallback）后触发，供未读胶囊
  // 判断"此刻 DOM 已稳定、可以查 topLevelBubbles() 定位锚点"——只有 bindView 的 sync:since 回调会传，
  // onHistoryAppend（只读镜像追平）不传，维持原样不受影响。
  function loadHistory(sessionId, cwd = currentCwd, onDone) {
    if (!sessionId) return;
    const reqInstanceId = displayedInstanceId; // WS-001：捕获发起时的视图目标（代次）
    socket.emit('session:history', { sessionId, cwd }, res => {
      // WS-001：迟到 ACK 守卫——发起后若已切走（会话或实例变），丢弃本回调。否则 A 的历史会被 renderHistoryBubbles
      // 追加进当前 B 的 DOM，且 hideLoadingCard 抹掉 B 的 loading 卡。对齐 onHistoryAppend 的 viewingInstanceId 守卫。
      if (displayedSessionId !== sessionId || displayedInstanceId !== reqInstanceId) return;
      hideLoadingCard();
      const msgs = res?.messages || [];
      if (!msgs.length) {
        if (res?.error) addBar(t('历史消息加载失败'), 'text-ink-faint');
        onDone?.();
        return;
      }
      addBar(`${t('加载了')} ${msgs.length} ${t('条历史消息')}`, 'text-ink-faint');
      renderHistoryBubbles(msgs, onDone);
      // 记下该会话已渲染到的磁盘 history 条数——切入时与 server 报的 diskLen 比对，判「离开期间被外部写过」
      // 而需清屏重载（见 shouldReloadOnEnter）。全量重载=全长。
      seenDiskLenBySession.set(sessionId, msgs.length);
    });
  }

  // 长会话切入分块渲染：块大小/让出间隔是经验起点，真机 DevTools Performance 面板校准。
  const HISTORY_RENDER_CHUNK_SIZE = 40; // 真机 DevTools Performance 校准起点；2000 条 ≈ 50 块
  const HISTORY_RENDER_CHUNK_IDLE_TIMEOUT_MS = 200; // 明显短于下方高亮用的 2000ms——渲染气泡在关键路径上，高亮是锦上添花
  function scheduleIdle(fn, opts) {
    if (typeof requestIdleCallback !== 'undefined') requestIdleCallback(fn, opts);
    else setTimeout(fn, 0);
  }

  // 长按历史气泡「从这里分叉新会话」：550ms 触发，touchmove>8px 视为滚动/误触而取消（同侧滑手势阈值，见 sessionRow 侧滑）。
  // 只绑在带 dataset.uuid 的历史气泡上——live 流气泡不带 uuid，长按天然无效（V1 范围：只做历史气泡入口）。
  function bindForkLongPress(bubble, role) {
    let timer = null, sx = 0, sy = 0, moved = false;
    const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
    bubble.addEventListener('touchstart', ev => {
      const touch = ev.touches?.[0];
      if (!touch) return;
      sx = touch.clientX; sy = touch.clientY; moved = false;
      cancel();
      timer = setTimeout(() => { timer = null; if (!moved) requestSessionFork(bubble, role); }, 550);
    }, { passive: true });
    bubble.addEventListener('touchmove', ev => {
      if (!timer) return;
      const touch = ev.touches?.[0];
      if (!touch) return;
      if (Math.abs(touch.clientX - sx) > 8 || Math.abs(touch.clientY - sy) > 8) { moved = true; cancel(); }
    }, { passive: true });
    bubble.addEventListener('touchend', cancel, { passive: true });
    bubble.addEventListener('touchcancel', cancel, { passive: true });
  }

  // 沿 DOM 序回溯找最近一条主链 assistant 气泡的 uuid（工具卡/思考块/子agent卡都没有 dataset.uuid，天然跳过）。
  function findPrecedingAssistantUuid(bubble) {
    let node = bubble.previousElementSibling;
    while (node) {
      if (node.dataset?.uuid && node.getAttribute('data-testid') === 'assistant-message') return node.dataset.uuid;
      node = node.previousElementSibling;
    }
    return null;
  }

  async function requestSessionFork(bubble, role) {
    const anchor = resolveForkAnchorUuid({
      role,
      ownUuid: bubble.dataset.uuid || null,
      precedingAssistantUuid: findPrecedingAssistantUuid(bubble),
    });
    if (!anchor) { addBar(t('这是最早一条消息，前面没有可分叉的起点'), 'text-ink-faint'); return; }
    if (!displayedSessionId) return;
    // 快照：确认框等待用户点击期间，任何与本地操作无关的 instances 广播都可能改写 currentCwd/
    // displayedSessionId（同 loadHistory 的 await 前快照+await 后重新校验模式）——不快照会把 A 会话
    // 消息的 anchor 和 await 后已变成 B 的 cwd/sessionId 拼到一起发出去。
    const cwdAtRequest = currentCwd, sessionIdAtRequest = displayedSessionId;
    const ok = await appConfirm({
      title: t('从这里分叉新会话？'),
      body: t('会复制到这条消息为止的对话，创建一个独立的新会话；原会话不受影响。'),
      okText: t('分叉'),
    });
    if (!ok) return;
    if (currentCwd !== cwdAtRequest || displayedSessionId !== sessionIdAtRequest) {
      addBar(t('会话已切换，分叉已取消，请重新发起'), 'text-info');
      return;
    }
    haptic('tap');
    socket.emit('session:fork', { cwd: cwdAtRequest, sessionId: sessionIdAtRequest, uuid: anchor }, res => {
      if (!res?.ok) addBar(res?.error || t('分叉失败'), 'text-danger');
    });
  }

  // 渲染一批历史/追平消息为气泡并追加（loadHistory 与 onHistoryAppend 复用；分块让出主线程 + 一次性 fragment 插入 + 空闲高亮）。
  // 支持文本 / thinking / tool_use / tool_result；sidechain（parentToolUseId）收进可折叠子 agent 卡。
  function renderHistoryBubbles(msgs, onDone) {
    if (!msgs?.length) { onDone?.(); return; }
    const frag = document.createDocumentFragment();
    const codeBlocks = [];
    // histToolCards/histSubCards 是模块级持久 Map（跨 tick 配对，见其声明处注释），本函数只读写不新建。
    const ensureHistSub = (parentId, subagentType) => {
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
      // 与 live 路径 ensureSubagentCard 对齐：type 来自 inputSummary 的 subagent_type，不硬编码 null——
      // 否则历史回放/刷新页面后卡片标题从「🤖 Explore」这类具体类型退化成泛泛的「🤖 子 agent」。
      const type = subagentType != null && String(subagentType).trim() ? String(subagentType).trim() : null;
      titleEl.textContent = formatSubagentCardTitle({ subagentType: type, running: false });
      c = { el: wrap, body: wrap.querySelector('.sa-body'), titleEl, type };
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
    function renderOne(msg) {
      // API 报错条：live 侧走 error 事件渲染成红条，刷新后从磁盘读回来须保持同一视觉语义，
      // 否则退化成看不出异常的普通助手气泡（正文里那句 "API Error:" 是唯一线索）。
      // 标记只挂文本条（见 history.js apiErrorField），故不会与 thinking/工具卡分支相撞。
      if (msg?.isApiErrorMessage) {
        const bar = el('<div class="msg-frame text-center text-xs text-danger"></div>');
        bar.textContent = `⚠️ ${msg.content || ''}`;
        appendNode(bar, msg);
        return;
      }
      if (msg?.kind === 'thinking') {
        const wrap = el(`
          <details class="msg-frame thinking rounded-lg bg-surface border border-line-soft text-xs text-ink-faint">
            <summary class="px-3 py-1.5">${t('💭 思考过程')}</summary>
            <pre class="t-body px-3 pb-2 whitespace-pre-wrap"></pre>
          </details>`);
        wrap.querySelector('.t-body').textContent = msg.content || '';
        appendNode(wrap, msg);
        return;
      }
      if (msg?.kind === 'tool_use') {
        // UX-002：历史回显与 live 一致——收起态带 inputSummary 截断；Task 清单工具特化
        const histTitle = formatTaskToolTitle(msg.name, msg.inputSummary) ?? formatToolCardTitle(msg.name || 'tool', msg.inputSummary);
        const card = el(`
          <details class="msg-frame toolcard rounded-lg bg-surface border border-line text-xs">
            <summary class="px-3 py-2 flex items-center gap-2 min-w-0">
              <span class="t-status status-icon shrink-0 text-warning" aria-label="${t('进行中')}"></span><span class="t-name font-mono font-semibold text-ink truncate">${esc(histTitle)}</span>
            </summary>
            <div class="px-3 pb-2 space-y-1">
              <pre class="t-in overflow-x-auto whitespace-pre-wrap break-words text-ink-soft"><code></code></pre>
              <pre class="t-out overflow-x-auto whitespace-pre-wrap break-words text-ink-faint hidden"><code></code></pre>
            </div>
          </details>`);
        setStatusIcon(card.querySelector('.t-status'), 'pending');
        card.dataset.toolName = msg.name || ''; // tool_result 无 name，结果特化渲染从卡上取
        const inCode = card.querySelector('.t-in code');
        if (inCode) {
          if (String(msg.inputSummary || '').trim() === '{}') {
            card.querySelector('.t-in')?.classList.add('hidden'); // 空对象输入不显（同 live）
          } else {
            inCode.textContent = formatToolSummary(msg.inputSummary || '');
            codeBlocks.push(inCode);
          }
        }
        if (msg.toolUseId) histToolCards.set(msg.toolUseId, card);
        // 主链 Agent/Task：预建折叠卡（与 live 一致）；type 同 live 路径从 inputSummary 提取
        if (!msg.parentToolUseId && !msg.isSidechain && isSpawnToolName(msg.name) && msg.toolUseId) {
          const subType = extractInput(msg.inputSummary, ['subagent_type', 'subagentType'], '');
          ensureHistSub(msg.toolUseId, subType || null);
        }
        appendNode(card, msg);
        return;
      }
      if (msg?.kind === 'tool_result') {
        const card = msg.toolUseId ? histToolCards.get(msg.toolUseId) : null;
        if (!card) {
          const orphan = el(`
            <details class="msg-frame toolcard rounded-lg bg-surface border border-line text-xs">
              <summary class="px-3 py-2 flex items-center gap-2">
                <span class="t-status status-icon shrink-0"></span>
                <span class="font-mono font-semibold text-ink">tool</span>
              </summary>
              <div class="px-3 pb-2 space-y-1">
                <pre class="t-out overflow-x-auto whitespace-pre-wrap break-words text-ink-faint"><code></code></pre>
              </div>
            </details>`);
          setStatusIcon(orphan.querySelector('.t-status'), msg.ok === false ? 'error' : 'ok');
          const code = orphan.querySelector('.t-out code');
          if (code) {
            code.textContent = formatToolSummary(msg.outputSummary || '');
            codeBlocks.push(code);
          }
          appendNode(orphan, msg);
          return;
        }
        setStatusIcon(card.querySelector('.t-status'), msg.ok === false ? 'error' : 'ok');
        if (msg.outputSummary) {
          const out = card.querySelector('.t-out');
          const code = out.querySelector('code') || out;
          // Task 清单工具结果 → ☐/◐/☒ 清单文本（同 live；历史是 block.content 文本形态）
          const taskText = msg.ok !== false ? renderTaskToolResultText(card.dataset.toolName, msg.outputSummary) : null;
          code.textContent = taskText ?? formatToolSummary(msg.outputSummary);
          if (!taskText && code !== out) codeBlocks.push(code);
          if (taskText) card.open = true; // 清单即结果本体（同 live）
          out.classList.remove('hidden');
        }
        histToolCards.delete(msg.toolUseId);
        // 主链 Agent 完成 → 子卡标题「已完成」；带上 sa.type，不然会把已提取的具体类型冲成泛泛的「子 agent」
        if (!msg.parentToolUseId && histSubCards.has(msg.toolUseId)) {
          const sa = histSubCards.get(msg.toolUseId);
          sa.titleEl.textContent = formatSubagentCardTitle({ subagentType: sa.type, running: false });
        }
        return;
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
        return;
      }
      bubble.innerHTML = render(msg.content || '');
      bubble.querySelectorAll('pre code').forEach(b => codeBlocks.push(b));
      injectCodeCopyButtons(bubble);
      if (isUser) foldLongUserBubble(bubble, msg.content || '');
      // E18：历史附件（history.js 解析 [附件] 块所得）→ 可点击 chip，按需拉原图；纯附件消息（content 空）
      // 渲染 chip-only 气泡、跳过复制按钮（复制空文本无意义）
      if (isUser && Array.isArray(msg.attachments) && msg.attachments.length) {
        bubble.appendChild(buildAttachmentWrap(msg.attachments, Boolean(msg.content)));
      }
      if (msg.content) appendCopyAction(bubble, () => msg.content || '', isUser ? 'right' : 'left');
      bubble.dataset.topLevel = '1'; // 未读角标锚点定位用（jumpToUnreadAnchor）：仅主链用户消息/assistant文字回复计入，子agent/侧链在上面已提前 return
      if (msg.uuid) {
        bubble.dataset.uuid = msg.uuid;
        bindForkLongPress(bubble, isUser ? 'user' : 'assistant');
      }
      frag.appendChild(bubble);
    }

    // 中断检查用「渲染发起时 #messages 归属哪个实例」的快照；bindView 是唯一整体改写 #messages 的地方，
    // displayedInstanceId 代表此刻 DOM 安全可写给谁。分块跨越一次切视图时直接丢弃 frag，不再调度、不
    // appendChild——frag/codeBlocks/histSubCards/histToolCards 全是本次调用的局部变量，中止后自然被 GC，
    // 不需要额外清理；用户若切回同一会话，因没有 sessionDomCache 缓存会自然触发一次完整重渲染。
    //
    // 注意：不得放宽为「同 sessionId 即可续渲」——同会话 instance 置换时 bindView 会 clearView + 重新
    // loadHistory，旧 frag 若仍落地会与新一轮历史叠加成重复气泡。跨 instance 一律中断，由新 bindView 负责。
    const targetInstanceId = displayedInstanceId;
    let i = 0;
    function processChunk() {
      if (displayedInstanceId !== targetInstanceId) return;
      const { end, done } = nextHistoryRenderChunk({ processed: i, total: msgs.length, chunkSize: HISTORY_RENDER_CHUNK_SIZE });
      for (; i < end; i++) renderOne(msgs[i]);
      if (!done) {
        scheduleIdle(processChunk, { timeout: HISTORY_RENDER_CHUNK_IDLE_TIMEOUT_MS });
        return;
      }
      leaveStartScreen();
      messagesEl.appendChild(frag); // 一次性插入，避免 N 次 live-DOM reflow（分块只让解析让出主线程，插入仍是一次性）
      scrollBottom(true);
      if (codeBlocks.length) {
        const doHighlight = () => codeBlocks.forEach(b => { try { hljs.highlightElement(b); } catch { /* 高亮失败不影响显示 */ } });
        scheduleIdle(doHighlight, { timeout: 2000 });
      }
      onDone?.(); // DOM 真正稳定（frag 已插入）之后才通知——未读胶囊的 topLevelBubbles() 查询依赖这个时机
    }
    processChunk();
  }

  // 只读「追平」：server 轮询「正在终端 CLI 里跑」的会话 transcript，检测到【外部新落定】消息 → history_append。
  // 仅渲染当前查看会话。局限：看不到实时 thinking / 在跑子 agent——它们不落盘，终端把消息落定后才追加得到。
  function onHistoryAppend(ev) {
    if (ev.instanceId !== viewingInstanceId) return; // 只进当前查看会话（server 已按 viewing 发，这里再兜一层）
    const msgs = ev.payload?.messages || [];
    if (!msgs.length && !ev.payload?.replace) return;
    // SS-001：满窗滑动全量重发——先清屏再渲，避免把中间条当增量叠上去。
    if (ev.payload?.replace) {
      messagesEl.innerHTML = '';
      messagesEl.classList.remove('empty-start');
      // FE-NEW-005：与 clearView 对齐——replace 全量窗口时清 streams/thinkings，避免 live 节点挂到已拆 DOM
      clearStreams();
      thinkings.clear();
      toolCards.clear();
      subagentCards.clear();
      histToolCards.clear(); histSubCards.clear(); // 全量替换=真正的从头渲染，历史配对表也要归零（同 clearView）
      if (msgs.length) renderHistoryBubbles(msgs);
      const sid = ev.sessionId;
      if (sid) seenDiskLenBySession.set(sid, msgs.length);
    } else if (msgs.length) {
      renderHistoryBubbles(msgs);
      // 追平也是磁盘 history 增量——累加到已见条数，保持切入对账基准准确（见 shouldReloadOnEnter）。
      const sid = ev.sessionId;
      if (sid) seenDiskLenBySession.set(sid, (seenDiskLenBySession.get(sid) || 0) + msgs.length);
    }
  }

  // 只读锁：禁用输入 + 发送位「续接」；状态文案写进 input placeholder，不再占单独横幅行。
  // 三态：driving / armed / stale（formatMirrorBannerText）。自动解锁仍在服务端 ~12.5s 静默。
  // 只读镜像页（= 正在看一个终端驾驶的会话）是"终端会话推送"价值最直观的时刻：用户此刻正盯着
  // 别处在跑的东西。未装 hooks 时在这里提示一次——只提示一次并永久记住，不做成每次都弹的噪音。
  const HOOKS_HINT_KEY = 'ccm.hooksHintDismissed';
  function maybeHintHooksBridge() {
    if (!mirrorReadonlySid) return;
    const hb = latestServiceHealth?.hooksBridge;
    if (!hb || hb.off || hb.state !== 'not-installed') return;
    try {
      if (localStorage.getItem(HOOKS_HINT_KEY) === '1') return;
      localStorage.setItem(HOOKS_HINT_KEY, '1');
    } catch { return; } // 隐私模式下 localStorage 不可用 → 干脆不提示，也不每次都弹
    addBar(t('提示：开启「终端会话推送」后，电脑终端里的会话跑完会通知你手机（设置 → 服务状态）'), 'text-ink-faint');
  }

  function refreshMirrorComposerCopy() {
    if (!inputEl) return;
    if (!mirrorReadonlySid) {
      // 非镜像：走 turnRunning placeholder（勿在此写死 idle，否则 setBusy 后被镜像刷新冲掉）
      inputEl.placeholder = resolveComposerPlaceholder({
        busy: _busyState,
        turnRunning: _turnRunning,
        mirrorReadonly: false,
        idleText: t('给 Claude 发消息...'),
      });
      return;
    }
    const armed = armedTakeoverSid === mirrorReadonlySid;
    inputEl.placeholder = formatMirrorBannerText({ armed, stale: mirrorStaleFlag, autonomous: mirrorAutonomousFlag, isWebInitiated: !mirrorCliSeenFlag });
    maybeHintHooksBridge();
    // 兼容：隐藏节点若仍在 DOM，同步文案（不展示）
    if (mirrorBannerText) mirrorBannerText.textContent = inputEl.placeholder;
    if (mirrorBannerIcon) mirrorBannerIcon.textContent = armed ? '⏳' : (mirrorStaleFlag ? '⚠️' : '⏱');
  }

  // UX-010：横幅优先级 task > subagent > activity（mirror 已迁 placeholder，不压 task）。
  // #mirrorBanner 恒隐；只读时仍展示 task_progress，让用户看见后台子代理/Workflow 进度。
  function reconcileBanners() {
    const taskOn = Boolean(taskProgressBanner && !taskProgressBanner.classList.contains('hidden'));
    const activityOn = Boolean(activityBanner && !activityBanner.classList.contains('hidden'));
    const pick = pickBannerToShow({
      mirror: Boolean(mirrorReadonlySid),
      task: taskOn,
      subagent: false,
      activity: activityOn,
    });
    if (mirrorBanner) mirrorBanner.classList.add('hidden');
    // 不再因 mirror 强制 hide taskProgressBanner
    if (activityBanner) {
      if (pick !== 'activity') activityBanner.classList.add('hidden');
    }
  }

  // UX-010：活动/后台任务横幅显示后走仲裁
  {
    const _sa = showActivityBanner;
    const _ha = hideActivityBanner;
    const _op = onTaskProgress;
    const _hp = hideTaskProgress;
    showActivityBanner = (...a) => { _sa(...a); reconcileBanners(); };
    hideActivityBanner = (...a) => { _ha(...a); reconcileBanners(); };
    onTaskProgress = (ev) => { const r = _op(ev); reconcileBanners(); return r; };
    hideTaskProgress = (...a) => { _hp(...a); reconcileBanners(); };
  }

  // 驾驶中点输入区：解释能/不能/硬要怎么做（disabled 吞原生 focus，需主动反馈）。
  function showMirrorComposerHint() {
    if (!mirrorReadonlySid) return;
    const armed = armedTakeoverSid === mirrorReadonlySid;
    const text = formatMirrorComposerHint({ armed, stale: mirrorStaleFlag, autonomous: mirrorAutonomousFlag, isWebInitiated: !mirrorCliSeenFlag });
    const now = Date.now();
    if (!shouldEmitThrottledHint({
      lastText: _mirrorComposerHintLast.text,
      lastAt: _mirrorComposerHintLast.at,
      nextText: text,
      now,
      throttleMs: MIRROR_COMPOSER_HINT_THROTTLE_MS,
    })) return;
    _mirrorComposerHintLast = { text, at: now };
    addBar(text, 'text-info');
    // 把视线导到发送位「续接」按钮（不自动续接）
    try {
      btnSend?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
      btnSend?.classList.add('ring-2', 'ring-danger/40');
      setTimeout(() => btnSend?.classList.remove('ring-2', 'ring-danger/40'), 900);
    } catch { /* scroll/classList 在极端 DOM 下可忽略 */ }
  }

  function applyMirror(readonly, sessionId, stale = false, observedCli, autonomous = false) {
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
    mirrorAutonomousFlag = effective && autonomous;
    if (effective) {
      // observed CLI state 只是镜像展示层，不能写回 Web 实例偏好；未知字段也必须保持未知。
      renderCliPanelState();
    } else if (wasEffective) {
      restoreWebPanelState();
      mirrorWebPanelSnapshot = null;
      mirrorObservedCli = { model: null, permissionMode: null, effort: null };
      _mirrorComposerHintLast = { text: '', at: 0 }; // 解锁后清节流，下次再锁可立刻提示
    } else {
      rebuildEffortOptions(currentModel || cwdDefaultModel);
    }
    if (mirrorBanner) mirrorBanner.classList.add('hidden'); // 状态改走 placeholder，横幅恒隐
    document.body.classList.toggle('mirror-readonly', effective); // UX-009
    // UX-010：镜像时强制隐藏忙碌条
    if (effective) setBusy(false);
    reconcileBanners();
    if (inputEl) inputEl.disabled = effective;
    refreshMirrorComposerCopy();
    // 附件入口随只读锁：禁点 + 防「选了图却发不出」
    if (btnAttach) {
      btnAttach.disabled = effective;
      btnAttach.classList.toggle('opacity-50', effective);
      btnAttach.classList.toggle('cursor-not-allowed', effective);
      btnAttach.title = effective
        ? (mirrorAutonomousFlag ? t('只读镜像：本会话自主循环执行中——点右侧续接可在手机继续') : t('只读镜像：终端会话运行中——点右侧续接可在手机继续'))
        : t('添加附件');
    }
    // 镜像/解锁都走主按钮状态机：镜像时 mode=resume，解锁恢复 send/stop
    updateSendButtonState();
  }

  // 输入 pill 捕获点击：disabled 的 textarea/按钮自身常不派发 click，父级 pointerdown 仍能收到。
  // 仅 mirror 只读时解释状态；不挡发送位「续接」主按钮（由 btnSend.onclick → requestMirrorResume）。
  document.querySelector('.chat-input-pill')?.addEventListener('pointerdown', (ev) => {
    if (!mirrorReadonlySid) return;
    // 设置 chip 已有自己的「设置已冻结」提示；续接主按钮自行处理
    if (ev.target?.closest?.('#pillDefaults, #btnSend')) return;
    showMirrorComposerHint();
  }, { capture: true });
  function onMirrorState(ev) {
    // readonly=true 只对当前查看会话生效；readonly=false（sessionId 可能为 null）一律解锁。
    // 归属守卫在 logic.acceptMirrorState：CLI 在 A 驾驶时切到 B 新会话/空首页，不得接纳 A 的 readonly=true
    // （否则「终端驾驶中」胶囊会挂到无关工作区）。readonly=false 仍一律接受——权威空闲快照。
    // ⚠️ 已知边界（code-review 发现3，有意不修）：mirror_state 是 io.emit 广播 + 服务端 viewingInstanceId
    //   是单例全局（一次只跟踪一个会话的锁）。readonly=false 这里【无条件解锁】——两台设备同时看不同会话时，
    //   给会话 B 的解锁会误解锁正看着会话 A 的另一端。属"单活跃查看者"架构限制，仅多设备-不同会话场景触发；
    //   彻底修需把 viewing/catchup/mirror 全改 per-socket + 定向 emit（大改），单用户工具不值，故保留。
    //   （承接 docs/design.md；2026-07-12 机主确认 Phase 8 不做此 per-socket 大改、保留现状，见 server.js setMirror 登记。）
    const readonly = !!ev.payload?.readonly;
    const stale = !!ev.payload?.stale;
    // server 是否见过真实 CLI 注册表条目（entrypoint=cli）。缺省（旧服务端/视觉 mock 不带）保守当
    // 「没见过」→ 不断言「终端」，只说只读；见到了才允许 stale 说成「终端疑似中断」。
    mirrorCliSeenFlag = !!ev.payload?.cliSeen;
    if (!acceptMirrorState({
      readonly,
      eventInstanceId: ev.instanceId ?? null,
      viewingInstanceId,
    })) return;
    if (armedTakeoverSid) { // 排队续接中：交给 armedTakeoverStep 判是否该自动放行（本轮完结/转疑似中断）
      const step = armedTakeoverStep({ armed: true, armedSid: armedTakeoverSid }, { kind: 'mirror', readonly, stale, sessionId: ev.sessionId });
      if (step.action !== 'none') {
        armedTakeoverSid = null;
        mirrorOverriddenSid = ev.sessionId;
        applyMirror(false, ev.sessionId);
        addBar(step.action === 'unlock-focus'
          ? t('已续接 CLI 会话：终端本轮已完结，安全切换')
          : t('已续接 CLI 会话：终端疑似中断，自动完成续接——若终端仍在跑同一会话，并发发送有分叉风险'),
          step.action === 'unlock-focus' ? 'text-ink-faint' : 'text-warning');
        inputEl?.focus();
        return;
      }
    }
    applyMirror(readonly, ev.sessionId, stale, ev.payload?.observedCli, !!ev.payload?.autonomous);
  }
  // 排队续接的「强制立即续接」入口（2026-07-28 真机 b06fb05d）：用户刚亲手杀掉终端时，他比判定链
  // 更早知道终端已死——排队只承诺「最长约 5 分钟」自动判定，这里给一条不等判定的显式出口（须确认
  // 分叉风险）。挂在排队 bar 内而非改发送钮语义：发送钮位的「取消续接」既有行为不动。
  function appendForceResumeAction(bar, sid) {
    if (!bar) return;
    const btn = el(`<button type="button" class="flex mx-auto mt-1.5 items-center justify-center gap-1.5 px-3.5 py-1.5 rounded-full border border-line-soft bg-surface text-warning hover:bg-sunk active:scale-[0.98] transition-all text-xs font-semibold shadow-sm" data-testid="mirror-force-resume">${t('强制立即续接')}</button>`);
    btn.onclick = async () => {
      haptic('tap');
      if (armedTakeoverSid !== sid || mirrorReadonlySid !== sid) return; // 已放行/已取消/已换会话：入口作废
      if (!(await appConfirm({
        title: t('强制立即续接？'),
        body: t('尚未判定终端已停止。若终端其实还在跑同一会话，两边同时发消息会造成会话分叉（对方的消息在后续会话中可能不可见）。\n\n请确认终端确实已关闭再继续。'),
        okText: t('强制立即续接'),
        tone: 'warning',
      }))) return;
      if (armedTakeoverSid !== sid || mirrorReadonlySid !== sid) return; // 确认框等待期间态可能已变（同 requestMirrorResume 的快照+复验模式）
      armedTakeoverSid = null;
      mirrorOverriddenSid = sid;
      applyMirror(false, sid);
      addBar(t('已续接 CLI 会话：若终端仍在跑同一会话，并发发送有分叉风险'), 'text-warning');
      inputEl?.focus();
    };
    bar.appendChild(btn);
  }
  // 「续接 CLI 会话」（发送钮位 mode=resume / cancel-resume）：
  // 运行中点击=排队续接——不立即解锁（零并发写盘风险，静候终端本轮完结/转疑似中断自动放行）；
  // 再次点击（按钮已变「取消续接」）可撤销排队。疑似中断点击=确认后立即解锁。
  // 续接后首次发送经 server 陈旧上下文守卫置换实例，吸收终端轮次。
  async function requestMirrorResume() {
    if (!mirrorReadonlySid) return;
    if (armedTakeoverSid === mirrorReadonlySid) { // 取消排队中的续接，回退只读态
      armedTakeoverSid = null;
      // 保留 autonomous 标志，避免本地 apply 把「自主循环」文案抹成「终端会话」（C1）
      applyMirror(true, mirrorReadonlySid, false, undefined, mirrorAutonomousFlag);
      return;
    }
    if (!mirrorStaleFlag) { // 运行中：排队等待，零风险故无需确认弹窗
      armedTakeoverSid = mirrorReadonlySid;
      applyMirror(true, mirrorReadonlySid, false, undefined, mirrorAutonomousFlag);
      const bar = addBar(t('已请求续接 CLI 会话：终端当前操作完成后自动切换；若终端已被关闭，最长约 5 分钟自动判定中断并完成续接。可点「取消续接」撤销'), 'text-ink-faint');
      appendForceResumeAction(bar, mirrorReadonlySid);
      return;
    }
    // 快照：确认框等待用户点击期间，一条并发 mirror_state 广播可能把 mirrorReadonlySid 改写成另一
    // 个会话——await 后须核对未变，否则会解锁/续接一个和确认框文案描述对不上的会话（同 loadHistory
    // 的 await 前快照+await 后重新校验模式）。
    const sidAtRequest = mirrorReadonlySid;
    if (!(await appConfirm({
      title: t('续接 CLI 会话？'),
      body: t('这是电脑终端正在跑的同一条对话。续接不会停止终端进程——两边同时发消息会造成会话分叉（对方的消息在后续会话中可能不可见）。\n\n建议先到终端 Ctrl+C 或等它跑完再续接。'),
      okText: t('仍要续接'),
      tone: 'warning',
    }))) return;
    if (mirrorReadonlySid !== sidAtRequest) {
      addBar(t('会话已变化，续接已取消，请重新确认'), 'text-info');
      return;
    }
    mirrorOverriddenSid = mirrorReadonlySid;
    applyMirror(false, mirrorReadonlySid);
    addBar(t('已续接 CLI 会话：若终端仍在跑同一会话，并发发送有分叉风险'), 'text-warning');
    inputEl?.focus();
  }
  // 兼容：旧隐藏按钮若仍被外部点到，转发到同一路径
  btnMirrorOverride?.addEventListener('click', () => { requestMirrorResume(); });
  btnMirrorSync?.addEventListener('click', () => {
    haptic('tap');
    socket.emit('mirror:syncNow');
    addBar(t('已请求刷新：拉取终端最新消息'), 'text-ink-faint');
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
        <button class="code-copy-btn" title="${t('复制代码')}">
          <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" />
          </svg>
          <span>${t('复制')}</span>
        </button>
      `);
      btn.onclick = async (e) => {
        e.stopPropagation();
        haptic('tap');
        const code = pre.querySelector('code');
        const text = code ? code.textContent : pre.textContent;
        const ok = await copyText(text);
        const span = btn.querySelector('span');
        if (span) span.textContent = ok ? t('已复制') : t('失败');
        setTimeout(() => { if (span) span.textContent = t('复制'); }, 1500);
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

  // PWA 应用图标角标（Badging API）：optional chaining 包装，不支持的平台/浏览器（含非 PWA 场景/桌面
  // Safari 等）静默跳过，不抛错也不影响主流程。挂点见 showUnreadPillIfAny（显示胶囊时置角标）与
  // ackUnread（确认已读时清角标）。硬边界：这只是"应用图标上的小圆点/数字"，不是锁屏常驻实时指示
  // （PWA 平台限制，锁屏能否看到运行中→完成的通知接力靠 web-push + sw.js tag 复用，见 notifications.js）。
  function setAppBadgeSafe(n) { navigator.setAppBadge?.(n).catch(() => {}); }
  function clearAppBadgeSafe() { navigator.clearAppBadge?.().catch(() => {}); }



  // E18: Redesigned premium utility row under each message block with copy, speak (TTS), and edit capabilities
  function appendCopyAction(container, getText, align) {
    if (!getText()) return;   // Empty messages have no action bar
    
    // For User messages (aligned to the right), render a single clean copy icon button aligned to the right
    if (align === 'right') {
      const row = el(`<div class="mt-1 text-right msg-action-bar justify-end"></div>`);
      const btn = el(`
        <button class="msg-action-btn hit-44" title="${t('复制消息')}">
          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" />
          </svg>
          <span>${t('复制')}</span>
        </button>
      `);
      btn.onclick = async () => {
        haptic('tap');
        const ok = await copyText(getText());
        const span = btn.querySelector('span');
        if (span) span.textContent = ok ? t('已复制') : t('失败');
        setTimeout(() => { if (span) span.textContent = t('复制'); }, 1500);
      };
      row.appendChild(btn);
      // UX-012：改写重发放在用户气泡，操作对象与位置一致
      const rewrite = el(`
        <button class="msg-action-btn hit-44" title="${t('改写后重发')}">
          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
          </svg>
          <span>${t('改写重发')}</span>
        </button>
      `);
      rewrite.onclick = () => {
        haptic('tap');
        const val = getText();
        if (inputEl) {
          inputEl.value = val;
          inputEl.focus();
          inputEl.dispatchEvent(new Event('input'));
          scrollBottom(true);
        }
      };
      row.appendChild(rewrite);
      container.appendChild(row);
      return;
    }

    // For Assistant messages (aligned to the left), render a beautiful multi-action bar
    const bar = el(`<div class="msg-action-bar justify-start"></div>`);
    
    // 1. Copy Button
    const copyBtn = el(`
      <button class="msg-action-btn" title="${t('复制消息')}">
        <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" />
        </svg>
        <span>${t('复制')}</span>
      </button>
    `);
    copyBtn.onclick = async () => {
      haptic('tap');
      const ok = await copyText(getText());
      const span = copyBtn.querySelector('span');
      if (span) span.textContent = ok ? t('已复制') : t('失败');
      setTimeout(() => { if (span) span.textContent = t('复制'); }, 1500);
    };
    bar.appendChild(copyBtn);

    // 2. Speak (TTS) Button using browser-native Web Speech API
    const speakBtn = el(`
      <button class="msg-action-btn" title="${t('语音朗读')}">
        <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
        </svg>
        <span>${t('朗读')}</span>
      </button>
    `);
    speakBtn.onclick = () => {
      // 特性检测：部分移动端浏览器/内嵌 WebView 不支持 Web Speech API，speechSynthesis 为 undefined
      // 时直接访问 .speaking 会抛未捕获 TypeError（同 copyText 的 navigator.clipboard && 检测风格）。
      if (typeof window.speechSynthesis === 'undefined' || typeof SpeechSynthesisUtterance === 'undefined') {
        addBar(t('此设备不支持语音朗读'), 'text-info');
        return;
      }
      if (window.speechSynthesis.speaking && activeSpeechBtn === speakBtn) {
        window.speechSynthesis.cancel();
        speakBtn.innerHTML = `
          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
          </svg>
          <span>${t('朗读')}</span>
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
            <span>${t('朗读')}</span>
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
          <span>${t('朗读')}</span>
        `;
        if (activeSpeechBtn === speakBtn) activeSpeechBtn = null;
      };
      
      speakBtn.innerHTML = `
        <svg class="w-3.5 h-3.5 text-danger animate-pulse" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
        </svg>
        <span class="text-danger font-semibold">${t('停止')}</span>
      `;
      activeSpeechBtn = speakBtn;
      window.speechSynthesis.speak(utterance);
    };
    bar.appendChild(speakBtn);

    // UX-012：编辑已迁到用户气泡「改写重发」

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
    const btn = el(`<button class="text-xs text-accent mt-1 block">${t('展开')}</button>`);
    let expanded = false;
    btn.onclick = () => {
      expanded = !expanded;
      if (expanded) { textEl.style.maxHeight = 'none'; btn.textContent = t('收起'); textEl.classList.remove('overflow-hidden'); }
      else { textEl.style.maxHeight = '8rem'; btn.textContent = t('展开'); textEl.classList.add('overflow-hidden'); }
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
    const btn = el(`<button class="text-xs text-accent mt-1 block">${t('展开')}</button>`);
    let expanded = false;
    btn.onclick = () => {
      expanded = !expanded;
      if (expanded) { wrap.style.maxHeight = 'none'; wrap.classList.remove('overflow-hidden'); btn.textContent = t('收起'); }
      else { wrap.style.maxHeight = '8rem'; wrap.classList.add('overflow-hidden'); btn.textContent = t('展开'); }
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
        <div class="text-xs font-semibold text-ink-soft tracking-wide">${t('正在加载会话...')}</div>
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
      clientLogger.clear(); // 清内存缓冲 + 落盘空缓冲（否则重开又恢复已清的旧条目）
      lastRenderedLogs = [];
      if (consoleLogArea) consoleLogArea.innerHTML = '';
    };
  }

  // 全部/交互/诊断 过滤：切换态 + 高亮当前按钮 + 本地重渲（数据已在服务端拉取过，无需重新请求）。
  function updateConsoleFilterButtons() {
    for (const btn of consoleFilterButtons) {
      const active = btn.dataset.filter === consoleFilter;
      btn.classList.toggle('bg-gray-700', active);
      btn.classList.toggle('text-gray-200', active);
      btn.classList.toggle('text-gray-500', !active);
    }
  }
  for (const btn of consoleFilterButtons) {
    btn.onclick = () => {
      if (btn.dataset.filter === consoleFilter) return;
      consoleFilter = btn.dataset.filter;
      updateConsoleFilterButtons();
      loadConsoleLogs();
    };
  }

  // 「复制全部」：把当前抽屉可见日志拼成多行文本，发给电脑 / 贴给 Claude 排障——手机端唯一带走途径。
  const consoleCopy = $('consoleCopy');
  if (consoleCopy) {
    consoleCopy.onclick = async () => {
      const text = formatLogsForCopy(lastRenderedLogs);
      if (!text) return;
      const ok = await copyText(text);
      const orig = consoleCopy.textContent;
      consoleCopy.textContent = ok ? t('已复制') : t('复制失败');
      setTimeout(() => { consoleCopy.textContent = orig; }, 1500);
    };
  }

  function loadConsoleLogs(id) {
    const instId = id || viewingInstanceId;
    if (!instId) {
      // 首页无选中实例：服务端日志按实例隔离故无从拉，但连接级(client_conn)日志无工作区归属、恒显——
      // 仍渲染它们，否则首页打开日志抽屉一片空白、断连/重连痕迹全丢（logEntryVisibleForInstance 对 client_conn 恒 true）。
      if (consoleLogArea) {
        consoleLogArea.innerHTML = '';
        renderLogList(filterConsoleEntries(clientLogger.entries().filter(e => logEntryVisibleForInstance(e, null)), consoleFilter));
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
      // 诊断时间线（镜像/排队/停止）：原始 {ts,subsystem,event,detail} 经 formatDiagLogEntry 译成
      // 判定过的一句话，与交互日志同一时间线合并展示，靠 diag_ 前缀 type 供过滤/着色区分。
      if (res && Array.isArray(res.diagLogs)) {
        mergedLogs = mergedLogs.concat(res.diagLogs.map(formatDiagLogEntry));
      }
      // 只合并属于本实例(或连接级恒显)的 client 日志——修切工作区残留上个区日志（clientLogBuffer 全局无隔离）。
      // 服务端日志(res.logs)已按 sessionId 隔离、无 instanceId 字段，不经此过滤。
      mergedLogs = mergedLogs.concat(clientLogger.entries().filter(e => logEntryVisibleForInstance(e, instId)));
      mergedLogs.sort((a, b) => a.ts - b.ts);
      mergedLogs = filterConsoleEntries(mergedLogs, consoleFilter);
      if (mergedLogs.length > 200) {
        mergedLogs = mergedLogs.slice(mergedLogs.length - 200);
      }
      renderLogList(mergedLogs);
    });
  }

  let consoleFilter = 'all'; // 交互日志抽屉过滤态：all|interaction|diag（切换即本地重渲，不重新请求服务端）
  let lastRenderedLogs = []; // 抽屉当前渲染的条目快照——「复制全部」的所见即所得数据源
  // 批量渲染日志：在恢复段(上次会话)与本次会话交界插一条「—— 本次会话 ——」分隔（isRestoredBoundary）。
  // 实时 onEntry 追加的都是本次(非 restored)、永不触发分隔，故分隔只在此批量路径出现。
  function renderLogList(entries) {
    if (!consoleLogArea) return;
    lastRenderedLogs = entries;
    let prev = null;
    for (const entry of entries) {
      if (isRestoredBoundary(prev, entry)) {
        const sep = document.createElement('div');
        sep.className = 'text-center text-[10px] text-gray-600 select-none py-1';
        sep.textContent = t('—— 本次会话 ——');
        consoleLogArea.appendChild(sep);
      }
      appendLogEntry(entry); // 批量路径每条 soft；循环后一次 force 落底（打开抽屉/切换过滤）
      prev = entry;
    }
    // 打开即看最新：全量/过滤重渲结束后强制贴底（实时 onEntry 仍走 soft stick）
    consoleLogArea.scrollTop = consoleLogArea.scrollHeight;
  }

  function appendLogEntry(p, { force = false } = {}) {
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
      // 诊断时间线（镜像/排队/停止）：徽标按子系统身份着色，正文按 severity 着色（见下方覆盖），
      // 不是像上面几类那样身份色/正文色绑死——这样超时/失败这类事件能在一堆中性事件里视觉跳出来。
      case 'diag_mirror':
        badgeSpan.className += ' bg-indigo-950/60 text-indigo-400 border border-indigo-800/40';
        badgeText = 'mirror';
        textClass = 'text-gray-300';
        break;
      case 'diag_queue':
        badgeSpan.className += ' bg-orange-950/60 text-orange-400 border border-orange-800/40';
        badgeText = 'queue';
        textClass = 'text-gray-300';
        break;
      case 'diag_interrupt':
        badgeSpan.className += ' bg-red-950/60 text-red-400 border border-red-800/40';
        badgeText = 'interrupt';
        textClass = 'text-gray-300';
        break;
      case 'diag_control':
        badgeSpan.className += ' bg-slate-800 text-slate-400 border border-slate-600/40';
        badgeText = 'control';
        textClass = 'text-gray-300';
        break;
      case 'diag_statusline':
        badgeSpan.className += ' bg-cyan-950/60 text-cyan-400 border border-cyan-800/40';
        badgeText = 'usage';
        textClass = 'text-gray-300';
        break;
      default:
        badgeSpan.className += ' bg-gray-800 text-gray-400 border border-gray-700';
        badgeText = p.type || 'log';
        textClass = 'text-gray-300';
    }
    // 诊断事件正文按 severity 覆盖着色（身份色留在徽标上，见上面 diag_* 分支注释）
    if (p.severity === 'danger') textClass = 'text-red-300';
    else if (p.severity === 'warning') textClass = 'text-amber-300';
    badgeSpan.textContent = badgeText;
    meta.appendChild(badgeSpan);

    // 模型 ID 独立 chip（紧邻 type 角标）：仅当 entry 带 model 时渲染；中性配色区别于 type 语义色。
    // 网关映射场景（同 syncModelUI）：候选项确有 resolvedModel 才覆盖显示真实模型名，否则保留原始
    // p.model 原样显示，不回落 displayName——诊断日志的价值在于忠实记录"那一刻实际记的值"。
    // title 悬停在覆盖时补显原始档位名，便于对照 setModel 实际请求的是哪个别名。
    if (p.model) {
      const gatewayName = resolveGatewayModelName(p.model, modelsList);
      const displayText = gatewayName || p.model;
      const modelSpan = document.createElement('span');
      modelSpan.className = 'px-1 py-0.5 rounded text-[9px] font-bold shrink-0 bg-slate-800 text-slate-300 border border-slate-600/50 max-w-[120px] truncate';
      modelSpan.textContent = displayText;
      modelSpan.title = gatewayName ? `${p.model} → ${gatewayName}` : p.model;
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

    // 在 append 前判定 stick：append 后 scrollHeight 会涨，贴底用户的 dist 可能瞬时变大并误判为「不在底部」。
    const stick = shouldStickScrollToBottom({
      scrollHeight: consoleLogArea.scrollHeight,
      scrollTop: consoleLogArea.scrollTop,
      clientHeight: consoleLogArea.clientHeight,
      force,
    });
    consoleLogArea.appendChild(row);
    if (stick) consoleLogArea.scrollTop = consoleLogArea.scrollHeight;
  }

  let scrollPending = false;
  // 未读胶囊自动确认已读（见上方 messagesEl scroll 监听）要能分辨"这次滚动是不是我自己（scrollBottom）
  // 造成的"——切入积压未读的会话时，回放缓冲落底会调 scrollBottom(true) 程序性把视图推到最新消息处，
  // 这次滚动不代表用户已经看到胶囊。窗口时长需要盖住「这次调用 → rAF 真正写 scrollTop → 浏览器异步
  // 派发原生 scroll 事件」这段延迟（通常 1-2 帧，~16-33ms），留 400ms 是给慢设备/CI 环境的充足余量，
  // 同时仍远短于人类"程序性落底后又主动继续滚动"两个动作之间的间隔，不会把用户紧随其后的真实滚动
  // 误判成程序性的。只在真正会发生滚动（下面 shouldStickScrollToBottom 判定通过）时才刷新窗口——
  // 被早退挡下的调用（含 _suppressScrollBottom 抑制期间的逐条 flush 派发）不算数。
  const PROGRAMMATIC_SCROLL_WINDOW_MS = 400;
  let programmaticScrollUntil = 0;
  function scrollBottom(force) {
    // 回放缓冲 flush 收尾期间抑制：缓冲事件正在按序派发，各自 handler 触发的滚动全部拦下，只留
    // flushQueue 派发完毕后显式调用的那一次（见 createReplayBuffer withScrollSuppressed）。
    if (_suppressScrollBottom) return;
    // 已有非强制 rAF 待执行时跳过布局读——但仅限非 force 调用：force 调用方（如切回会话/断线重连
    // 补发后的强制落底）明确要求"这次必须真正滚到底"，若被这里早退吞掉就成了无效调用。让 force 调用
    // 总能排上一个新 rAF：按 rAF 规范，帧回调处理期间新排的 rAF 会推迟到下一帧，故它必然在同一批已
    // 排队的渲染 rAF（如 finalizeStreams 的最终内容渲染）执行完之后才触发，读到的是渲染完成后的真实
    // 高度（实测：负载低时两种写法都凑巧对，负载高（142 条全量套件后段）时旧写法会被早退吞掉，
    // 读到渲染完成前的过渡态高度，见 switch-back-scroll.spec.ts 间歇性失败复现）。
    if (scrollPending && !force) return;
    if (!shouldStickScrollToBottom({
      scrollHeight: messagesEl.scrollHeight,
      scrollTop: messagesEl.scrollTop,
      clientHeight: messagesEl.clientHeight,
      force: !!force,
    })) return;
    scrollPending = true;
    programmaticScrollUntil = Date.now() + PROGRAMMATIC_SCROLL_WINDOW_MS;
    requestAnimationFrame(() => { scrollPending = false; messagesEl.scrollTop = messagesEl.scrollHeight; });
  }

})();
