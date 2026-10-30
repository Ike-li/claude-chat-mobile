// app.js —— 契约客户端：agent:event 渲染 + 审批弹窗 + epoch 感知续传。
// 纯决策逻辑（effort 档位 / 状态聚合 / ANSI / esc）抽到 logic.js，浏览器 import + node:test 共用。
/* global io, marked, DOMPurify, hljs */
import {
  esc,
  formatToolSummary,
  toolOutputHighlightClass,
  formatToolCardTitle,
  formatTaskToolTitle,
  renderTaskToolResultText,
  shouldEmitModeChangeBar,
  resolveModelDisplayName,
  modelTileValueFor,
  resolveOutgoingModel,
  shouldShowBusyWithMirror,
  formatStreamPreviewIntervalMs,
  statusIconSpec,
  STATUS_ICON_TONES,
  toolPreviewLabel,
  resolvePanelState,
  resolvePanelCwd,
  resolveSessionCwd,
  resolveWorktreeGoneNotice,
  aggregateStates,
  mirrorRowLockChanged,
  resolveEmptySurface,
  wasViewingInstanceDestroyed,
  detectServerRestart,
  shouldRestoreOptimisticBusy,
  planSessionDraftSwap,
  draftKeyFor,
  foregroundReconnectAction,
  shouldAttemptReconnect,
  describeHandshakeError,
  syncAckAction,
  shouldReloadOnEnter,
  shouldForceScrollAfterReplay,
  shouldStickScrollToBottom,
  resolveReplayBufferAction,
  sessionDomCachePlan,
  defaultModelTileLabel,
  resolveDeepLinkTarget,
  armedTakeoverStep,
  presentTurnResult,
  isSoftKeyboardPrimaryDevice,
  userBubbleFold,
  historyLoadedNotice,
  formatNotifyIdentity,
  notifySessionTag,
  lookupNotifySessionTitle,
  otherWorkspaceNotifyOpts,
  isSubagentPayload,
  isSpawnToolName,
  formatSubagentLastToolLine,
  formatSpawnDescription,
  isFileMutationTool,
  accumulateTurnFileChange,
  summarizeTurnFileChanges,
  formatSubagentCardTitle,
  isToolSummaryTruncated,
  localizeServerThinkingText,
  formatMirrorBannerText,
  formatMirrorComposerHint,
  shouldEmitThrottledHint,
  acceptMirrorState,
  shouldResetMirrorOnViewChange,
  resolveComposerPrimaryMode,
  shouldHideComposerSendButton,
  shouldShowComposerDiscoverHint,
  resolveComposerDiscoverAriaDescription,
  formatLiveActivityText,
  INTERRUPT_PENDING_TIMEOUT_MS,
  shouldClearInterruptPendingOnSystem,
  systemBarClass,
  pickSpinnerVerb,
  formatCliSpinnerLine,
  formatCliRetryLine,
  advanceThinkingClock,
  resolveLiveWaitPhase,
  presentOnlineSendTransport,
  presentOfflineResendAck,
  shouldBusyAfterOfflineBatch,
  outboxItemTargetsViewing,
  outboxNoticePlacement,
  outboxParkedNotice,
  outboxDeadLetterHead,
  isUnreturnableDeadLetter,
  shouldCarryOutboxBubbleOnClear,
  canTextClaimPendingBubble,
  SEND_ACK_FALLBACK_MS,
  SEND_ACK_TRANSPORT_MS,
  OFFLINE_RESEND_ACK_MS,
  planOutboxDrainNotice,
  planOutboxWorktreeReuse,
  planOutboxScratchReuse,
  nextOutboxScratchAnchor,
  nextOutboxLazyOpenAnchor,
  planOutboxBlockedTarget,
  nextOutboxWorktreeAnchor,
  outboxComposeKey,
  planOutboxEnqueue,
  parseDurableOutbox,
  dumpDurableOutbox,
  OUTBOX_STORAGE_KEY,
  OUTBOX_MAX_ITEMS,
  safeJsonPreview,
  shouldSeedBusyFromInstanceState,
  shouldReseedBusyAfterReload,
  resolveRunStateFromSnapshot,
  shouldClearBusyBySnapshot,
  buildClientErrorReport,
  clientErrorGateStep,
  guessImageMime,
  nextHistoryRenderChunk,
  findHistoryClaimForPending,
  resolveUnreadAnchorIndex,
  shouldAckUnreadOnScroll,
  hasSlashCommand,
  unifiedDiffLines,
  MAX_DIFF_LINES_FOR_LCS,
  formatWorkspaceChangeBadge,
  readPushPreviewPref,
  writePushPreviewPref,
  buildDirInstanceSignatures,
  diffDirSignatures,
  dirPanelStructuralKey,
  resolveComposerPlaceholder,
  resolveTurnEndScroll,
  isLanOrLocalHostname,
  authFailurePath,
  shouldHandshakeOnBoot,
  shortDeviceId,
  formatRelativeApprovedAt,
  rewindOutcomeNotes,
  isPathWithin,
} from './logic.js';
import { t, setLang, getLang, resolveInitialLang, readLangPref, writeLangPref, confirmAndWriteLangPref, applyI18nToDocument } from './i18n.js';
import { readThemePref, writeThemePref, applyThemeToDocument } from './theme.js';
// 未读域的展示决策直接取子模块：logic/unread.js 不在 logic.js barrel 里（app/unread-tracker.js 同样
// 直接 import），barrel 是给这份巨石的历史兼容层，不为新符号扩张它。
import { askQuestionResultView } from './logic/questions.js';
import { createAppContext } from './app/context.js';
import { createClientLogger } from './app/client-log.js';
import { createAlertController } from './app/alerts.js';
import { createAttachmentController, createStoredPreviewLoader } from './app/attachments.js';
import { createTranscriptImages } from './app/transcript-images.js';
import { createRttMonitor } from './app/connection-sync.js';
import { createConnectionBannerController } from './app/connection-banner.js';
import { createAutoContinueBannerController, tagAutoContinueBubble } from './app/auto-continue-banner.js';
import { createMessageRenderer } from './app/message-renderer.js';
import { createMessageTimeline } from './app/message-timeline.js';
import { createHistoryLoadGate } from './app/history-load-gate.js';
import { createAgentEventDispatcher, createReplayBuffer } from './app/event-dispatch.js';
import { createFileBrowser } from './app/file-browser.js';
import { createUnreadTracker } from './app/unread-tracker.js';
import { createScrollToBottomController } from './app/scroll-to-bottom.js';
import { createGitChangesPanel, createWorkspacePanel, renderPatchLines } from './app/git-changes.js';
import { createNewSessionWorktree } from './app/new-session-worktree.js';
import { createComposePage } from './app/compose-page.js';
import { createSettingsController } from './app/settings.js';
import { createGeneralNav } from './app/general-nav.js';
import { createAboutPage } from './app/about-page.js';
import { createHostMcp } from './app/host-mcp.js';
import { createEnvConfigPanel } from './app/env-config.js';
import { createNoticeDismissals } from './app/notice-dismissals.js';
import { createNotificationController } from './app/notifications.js';
import { createTaskStatusController } from './app/task-status.js';
import { createOutboxDeadLetters } from './app/outbox-dead-letters.js';
import { createSessionWorkspaceState } from './app/session-workspaces.js';
import { createProjectsState } from './app/projects-state.js';
import { createFolderPicker } from './app/folder-picker.js';
import { createInteractionQueueState, createApprovalController } from './app/approval-questions.js';
import { createSheetController } from './app/sheets.js';
import { createDrawerController } from './app/drawer.js';
import { createSessionDeleteController } from './app/session-delete.js';
import { createSessionRowMenu } from './app/session-row-menu.js';
import { createElicitationSheet } from './app/elicitation-sheet.js';
import { createForegroundTasks } from './app/foreground-tasks.js';
import { createSessionRenameController } from './app/session-rename.js';
import { createCrashNotices } from './app/crash-notices.js';
import { createRewindCommandController } from './app/rewind-command.js';
import { createResumeDivergencePrompt } from './app/resume-divergence.js';
import { createOutboxAfterTurn } from './app/outbox-after-turn.js';
import { createOutboxInFlight } from './app/outbox-in-flight.js';
import { createLocalReset } from './app/local-reset.js';
import { createWidgetRenderer } from './app/widget-render.js';
import { createModelIntent } from './app/model-intent.js';
import { createGateFocusController } from './app/focus-layers.js';
import { createConsoleModal } from './app/console-modal.js';
import { createServiceStatus } from './app/service-status.js';
import { createStatuslineView } from './app/statusline-view.js';
import { createEmptySurfaces } from './app/empty-surfaces.js';
import { createSessionSidebar } from './app/session-sidebar.js';
import { createComposerControls } from './app/composer-controls.js';
import { createKeyboardInset } from './app/keyboard-inset.js';
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

  // 指纹上屏（设置 › 📱 这台手机）。写一次就够：deviceToken 在整个页面生命周期内不变，
  // 不跟任何状态同步。module script 已 defer 到 DOM 解析完成，这两个节点此刻必然在。
  {
    const fpShort = document.getElementById('deviceFingerprintShort');
    if (fpShort) fpShort.textContent = shortDeviceId(deviceToken);
    const fpFull = document.getElementById('deviceFingerprintFull');
    if (fpFull) fpFull.textContent = deviceToken;
  }

  // ⑨ i18n：module script 已 defer 到 DOM 解析完成后执行，整棵静态外壳此刻已就位，且尚未渲染任何
  // 会话内容——applyI18nToDocument 整树扫文本节点+属性只会碰 index.html 自带的界面文案，不会误伤用户消息。
  // 静态壳靠整树扫描（免逐句标注、进词典即生效），app.js 运行时生成的模板则各自包 t()。
  setLang(resolveInitialLang(k => localStorage.getItem(k), navigator.language));
  applyI18nToDocument(document);

  // ⑩ 主题：theme-boot.js 已在首屏写过 data-theme / manifest；这里再跑一遍以同步 theme-color / hljs media / manifest，
  // 并在「跟随系统」时监听系统切换（强制档不听——用户显式钉死了）。
  const systemDarkMq = window.matchMedia?.('(prefers-color-scheme: dark)') || null;
  const systemDarkNow = () => !!(systemDarkMq && systemDarkMq.matches);
  const applyStoredTheme = () => applyThemeToDocument(
    document,
    readThemePref(k => localStorage.getItem(k)),
    { systemDark: systemDarkNow() },
  );
  applyStoredTheme();
  if (systemDarkMq) {
    const onScheme = () => {
      if (readThemePref(k => localStorage.getItem(k)) === 'system') applyStoredTheme();
    };
    // 新旧 Safari：addEventListener 与 addListener 都要兜
    if (typeof systemDarkMq.addEventListener === 'function') systemDarkMq.addEventListener('change', onScheme);
    else if (typeof systemDarkMq.addListener === 'function') systemDarkMq.addListener(onScheme);
  }

  // ---- DOM ----
  const $ = id => document.getElementById(id);
  const messagesEl = $('messages'), inputEl = $('input'), statusEl = $('statusLine'), connDot = $('connDot'), connRttEl = $('connRtt'), connDotWrap = $('connDotWrap');
  const connBannerEl = $('connBanner'), connBannerTextEl = $('connBannerText'), connBannerDetailEl = $('connBannerDetail');
  const connBannerSpinnerEl = $('connBannerSpinner'), connBannerRetryEl = $('connBannerRetry');
  const btnSend = $('btnSend'), btnStop = $('btnStop'), btnNew = $('btnNew'), btnHome = $('btnHome'), btnSessions = $('btnSessions');
  // 流内 live 活动行（懒创建 #streamLiveStatus）；composer 顶条 #activeStatusPill 已移除
  const mirrorBanner = $('mirrorBanner'), btnMirrorOverride = $('btnMirrorOverride');
  const mirrorBannerText = $('mirrorBannerText'), mirrorBannerIcon = $('mirrorBannerIcon'), btnMirrorSync = $('btnMirrorSync');
  const taskProgressBanner = $('taskProgressBanner'), taskProgressText = $('taskProgressText'), taskBannerLabel = $('taskBannerLabel'), btnTaskStop = $('btnTaskStop'), taskBannerToggle = $('taskBannerToggle'), taskBannerChevron = $('taskBannerChevron');
  const unreadPillEl = $('unreadPill'), unreadPillCountEl = $('unreadPillCount'); // 未读角标悬浮胶囊
  const sessionPanel = $('sessionPanel');
  const sessionsDot = $('sessionsDot');  // 台阶2 Step B：后台目录动静汇总角标
  const attentionChipEl = $('attentionChip'); // 顶栏文字 chip：把 connDot / sessionsDot 两颗角标的含义写成人话（updateHeaderAttentionChip）

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
  const modelIntent = createModelIntent(); // 当前会话里亲手选过模型没有（发送意图，见 app/model-intent.js）
  const statuslineView = createStatuslineView({
    $, addBar: (...args) => addBar(...args), messagesEl, renderLiveLine, updateWorkspaceChangeBadge,
    getCurrentCwd: () => currentCwd, getLiveLine: () => liveLine,
    getViewingInstanceId: () => viewingInstanceId,
  });
  const { cliStatusBarEl, hideStatuslineWrap, renderStatusLine } = statuslineView;
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
        <button type="button" aria-pressed="false" class="model-tile w-full text-left p-2 rounded-xl border border-line bg-surface active:bg-sunk cursor-pointer transition-all">
          <div class="text-xs font-semibold truncate text-ink"></div>
          <div class="text-[9.5px] text-ink-soft truncate mt-0.5"></div>
        </button>
      `);
      card.dataset.model = value;                 // 属性走 dataset，不进 HTML 串
      const [nameDiv, noteDiv] = card.children;   // 两个内层 div，textContent 赋值（自动转义）
      nameDiv.textContent = value;
      noteDiv.textContent = note || t('当前加载模型');
      card.onclick = () => {
        if (mirrorReadonlySid) { addBar(t('终端驾驶中，设置已冻结——接管后可调'), 'text-info'); return; } // 单驾驶员：驾驶期设置冻结
        haptic('tap');
        modelInput.value = value;
        modelIntent.markPicked(); // 用户点的才算发送意图（见 resolveOutgoingModel）
        delete modelInput.dataset.fullModel; // 发送时 dataset.fullModel 优先级高于 value，选中此卡须清掉旧的（同 rebuildCustomModelGrid）
        syncModelUI(value);
      };
      customModelGrid.appendChild(card);
      syncModelGridEmptyHint(); // 这张兜底卡也算磁贴：加上它之后就不能再说「一张都没有」
    }
  }
  // 两个弹窗容器留在 app.js：通用 sheet 开关与视图切换仍要用；其余 perm*/question* DOM 引用
  // 连同 selectedExitMode / multiSelectedIndexes 等状态已归 app/approval-questions.js 所有。
  const permModal = $('permModal'), questionModal = $('questionModal');
  // 会话彻底删除与通用确认弹窗的 DOM 引用已随各自模块迁出（app/session-delete.js、app/sheets.js）。
  const authGate = $('authGate'), authToken = $('authToken'), authSubmit = $('authSubmit'), authError = $('authError'); // 访问令牌输入页
  const accessRelogin = $('accessRelogin'), accessReloginBtn = $('accessReloginBtn'); // Access 会话过期重登浮层
  // 远程设备审批 + 访问帮助 UI
  const deviceRequests = $('deviceRequests'); // 已信任设备上的待审批请求卡片栈
  const deviceDenied = $('deviceDenied'), deviceDeniedRetry = $('deviceDeniedRetry'), deviceDeniedHelp = $('deviceDeniedHelp');
  const deviceModalEl = $('deviceModal'); // TOFU 待授权全屏遮罩（连接横幅的抑制判据之一）
  const accessHelp = $('accessHelp'), accessHelpClose = $('accessHelpClose'), accessHelpOpen = $('accessHelpOpen'), authHelpLink = $('authHelpLink');
  // 全屏门开着时背后的页面不可 Tab（验收 O74）。按 DOM 顺序传：同为 z-50，靠后的在上面。
  // sessionBlockedSurface（z-20）是中层 aria-modal（#393）：走 overlays，不要塞进 gates——
  // 否则会 inert 掉更高的 leftSidebar（层序注释：落地页在侧栏之下，要能直接翻会话列表）。
  // overlayCovers 点名它（fixed inset-0 z-20）实际盖住的东西：顶栏、连接横幅、消息区、未读胶囊、输入区；
  // 桌面（≥1024）常驻侧栏是 relative z-10，也在它下面。设备授权卡（z-30）、手机抽屉（z-40）与各类 sheet
  // 在它上面，不点名、照常可用。
  const sessionBlockedSurface = $('sessionBlockedSurface');
  createGateFocusController({
    gates: [authGate, accessRelogin, deviceModalEl, deviceDenied, accessHelp],
    overlays: [sessionBlockedSurface],
    overlayCovers: () => [
      document.querySelector('header'), $('connBanner'), $('messages'), $('unreadPill'), $('composerFooter'),
      window.innerWidth >= 1024 ? leftSidebar : null,
    ],
  });
  const btnConsole = $('btnConsole'), consoleModal = $('consoleModal'),
        consoleClose = $('consoleClose'), consoleClear = $('consoleClear'),
        consoleLogArea = $('consoleLogArea');
  const consoleFilterButtons = [$('consoleFilterAll'), $('consoleFilterInteraction'), $('consoleFilterDiag')].filter(Boolean);
  // 工作区面板外壳（文件 / 改动两 tab 同壳）
  const workspaceModal = $('workspaceModal'), workspaceClose = $('workspaceClose'),
        workspaceTabFiles = $('workspaceTabFiles'), workspaceTabChanges = $('workspaceTabChanges'),
        workspaceWorktreeGone = $('workspaceWorktreeGone');
  // 项目文件只读浏览——文件 tab
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
  // 按表面分槽的未发送草稿 {text, attachments}（切走存/切回恢复；同一表面静默换实例不读写，见 planSessionDraftSwap）。
  // 槽的 key 见 draftKeyFor：有 sessionId 用它，新会话页（首发前无 id）用 `new:<cwd>`。
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
  // 发送时序常量（SEND_ACK_FALLBACK_MS / SEND_ACK_TRANSPORT_MS / OFFLINE_RESEND_ACK_MS）已收进
  // logic/outbox-send.js，与 BUSY_BROADCAST_CLEAR_GRACE_MS 同住一个模块并由序关系断言钉住——
  // 它们守的是同一段「服务端 pendingTurns 尚未计入广播」的窗口，分居两处各写各的值正是
  // 2026-08-26 那个 bug 被发现两次的原因。取值理由见那边的注释。
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
  // n1: N1-MIRROR-VIEW-FE 这一族按「当前 viewing」单值渲染，与服务端 N1-MIRROR-LOCK 的全局广播配对：
  //     本端收到的 mirror_state 可能是为另一台设备正看的会话算出来的（见 onMirrorState 的归属判定）。
  let mirrorReadonlySid = null, mirrorOverriddenSid = null, armedTakeoverSid = null, mirrorStaleFlag = false;
  // server 侧 cliPresenceStep 的 seen 槽：本次观察期是否见过 entrypoint=cli 的活注册表条目。
  // 决定 stale 该说「终端疑似中断」还是只说只读——没见过终端就别把推断说成事实（原先两个调用点
  // 硬编码 isWebInitiated:true，等于恒不说，「疑似中断」文案在 composer 上完全不可达）。
  let mirrorCliSeenFlag = false;
  // mirrorAutonomousFlag=当前只读锁能否确定是本会话自己被 ScheduleWakeup/CronCreate 定时唤起（server
  // 端 classifyTranscriptTail 查到 harness marker），而非真不知道来源的「大概率终端」——只影响横幅措辞，
  // 不影响是否只读（见 logic.js formatMirrorBannerText/formatMirrorComposerHint 的 autonomous 参数）。
  let mirrorAutonomousFlag = false;
  // mirrorWaitingFlag=终端此刻卡在一个对话框上等人按键（含权限审批框；server 端 registry status:"waiting"）。
  // 同 autonomous：只影响措辞不影响是否只读。此前这个状态走 driving 默认句「终端会话运行中」——终端
  // 并没有在运行，而且提示承诺的「等终端静默后自动可写」在等审批时永远兑现不了（等审批本身就是静默）。
  let mirrorWaitingFlag = false;
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
  // terminal 绑定命令名单（init.terminal_slash_commands）：与上面那份同批缓存，否则刷新后到下一轮
  // init 之间会拿空名单过滤，/color /statusline 这类会短暂冒回补全菜单。
  try {
    const cachedTerm = JSON.parse(localStorage.getItem('slash_commands_terminal'));
    if (Array.isArray(cachedTerm)) window.terminalSlashCommands = cachedTerm;
  } catch { /* 缓存损坏等价于无缓存 */ }
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
  let currentEffort = null;             // 当前思考强度档（null=模型默认）；onchange 同值不重发
  let ultracodeArmed = false;           // ultracode 档（=xhigh+workflow）本地武装态：借道 xhigh 发 effort，
                                        // 由本标志驱动「发送时注入关键词」+ pill/磁贴显示 ultracode。不跨实例（CLI: never persist）
  let currentCwd = null;                // 当前查看 cwd 上下文（instances.viewingCwd），目录切换器高亮 + 新建会话选目录
  // 新会话页上选中的驾驶轴目录（instances.composeCwd）：选择器里挑中一个 worktree 时 currentCwd 是它所属的仓库，
  // 首条消息却要开在 worktree 里。只在新会话页上、且和 currentCwd 不同时才有。
  let composeCwd = null;
  // 【驾驶轴 cwd】某个实例的 claude 实际在哪棵树里跑。托管 worktree 的会话工作区轴归父仓
  // （server 的 workspaceCwdOf），但文件改在、transcript 也落在 .claude/worktrees/<name> 下。
  // 凡是「按 cwd 去磁盘找这个会话的东西」都必须走这条，拿 currentCwd 去查必然扑空。
  // ⚠️ 与下面的 panelCwd() 在「worktree 目录已被删掉」那一档会分叉，**不能合用一个**：
  // 这条喂 loadHistory（算 project 目录，必须是驾驶轴），那条喂文件/改动面板（必须是能 realpath
  // 的真实目录）。判据与两种错法见 logic/panel-state.js 的 resolveSessionCwd。
  const drivingCwdOf = (instanceId) => resolveSessionCwd({ instances: instancesList, viewingInstanceId: instanceId, workspaceCwd: currentCwd });
  // 文件/改动面板跟的是「当前会话在哪个工作树」，不是 currentCwd（判据见 logic/panel-state.js）。
  const panelCwd = () => resolvePanelCwd({ instances: instancesList, viewingInstanceId, workspaceCwd: currentCwd });
  // 按 cwd 找文件、读规则时用哪个目录。「无文件夹」那一节的键是 scratch 根——它只是新会话页的启动键，
  // 服务端不让拿它找文件；看着一个会话时改用它自己的 scratch 目录。新会话页上仍是 scratch 根（还没有目录）。
  const requestCwd = () => (projectsState.isNoFolder(currentCwd) && viewingInstanceId ? panelCwd() : currentCwd);
  // 首条消息（含离线入队）投到哪个目录：新会话页上选中了 worktree 就是它，其余一律 currentCwd
  const sendCwd = () => (!viewingInstanceId && composeCwd) || currentCwd;
  // 进离线队列的消息记下目标实例此刻跑的会话（MSG-02），与 instanceId 同取自 instances 快照——不用 displayedSessionId，
  // 切视图的窗口里两者可能分属两个实例。新会话页、会话还没开出来时为 null（服务端照旧只核对实例在不在）。
  const sendSessionId = () => (viewingInstanceId && instancesList.find(x => x?.instanceId === viewingInstanceId)?.sessionId) || null;
  // panelCwd() 悄悄换成父仓时要说一句——两个 openWorkspacePanel 调用点共用这一条，判据在纯函数里。
  const worktreeGoneNotice = () => resolveWorktreeGoneNotice({ instances: instancesList, viewingInstanceId });
  // 抽屉小节的键 = 项目键（已连接的文件夹、其下有会话的子文件夹、「无文件夹」；旧载荷回落 dirs）
  let availableDirs = [];
  const projectsState = createProjectsState(); // 项目清单与展示名（见 app/projects-state.js）
  let cwdSeen = false;                  // 首次服务端同步只定基线不切视图（刷新/重连不清空）
  let workdirStates = {};               // {[cwd]:'idle'|'busy'|'permission'|'done'} 目录切换器角标（台阶3 由 instances 按 cwd 聚合）
  // 台阶3：viewingInstanceId = 当前查看 tab 实例（前端分流锚点）；displayedInstanceId/Session =
  // 已绑定渲染的实例/会话（viewingInstanceId 变了才切视图，避免每个 instances 边界广播都重载）。
  let viewingInstanceId = null;
  // 是否已收到过首个 instances 广播（视图状态已知）。区分「视图未知（连接初期，应放行重放）」与
  // 「viewingInstanceId 确为 null（新会话懒开空窗口，须丢弃后台实例事件防污染）」——见 logic.js shouldDropAgentEvent。
  let instancesReady = false;
  let displayedInstanceId = undefined;  // undefined 确保首次 viewingInstanceId=null 也会 bind 空启动页
  // 用户刚显式新建（btnNew / 目录行＋）而权威广播还没落地的那段窗口。
  // 【为什么需要】那两处只重置得了 displayedSessionId，displayedInstanceId 仍指着旧实例；
  // 一条在 session:new 之前就在途、之后才到的 instances 包会命中下面 FE-001 那个分支
  // （同实例 + 无 sessionId → 从条目重填 displayedSessionId），把用户刚放弃的会话 id 填回来。
  // 于是下一条权威包让 bindView 读到 prev=旧会话 / new=null，又走回 swap，把正在打的字清掉。
  // 【为什么不改成把 displayedInstanceId 也置 null】那会让 newViewing !== displayedInstanceId 成立，
  // 在途旧包转而走进 bindView、把视图绑【回】旧会话——比重填更糟。
  let sessionIdClearedByNav = false;
  let displayedSessionId = null;
  // 与 displayedSessionId 配套的「当前表面 cwd」住在 sessionWorkspaceState.displayedCwd
  // （新前端状态不再落 app.js 顶层作用域）。它只服务草稿槽的 key，见 draftKeyFor。
  // R65（2026-08-30 需求合稿）未读点：已读表状态在模块内，此处只持句柄。onChange 把每次「看过/标记」上报服务端共享
  // （2026-09-03）——不上报就退回每设备一份，换设备时在另一台读过的会话会整屏复亮。
  // 刻意不带 ack：丢一条不致命，下次 connect 的 read:sync 全量归并会补回来。
  const unread = createUnreadTracker({
    onChange: mark => { if (socket?.connected) socket.emit('read:mark', mark); },
  });
  let instancesList = [];               // 最近 instances 事件的实例列表（含 per-instance state）
  let needsYouList = [];                // "等我"聚合（AttentionDeriver），按 waitingSince 升序（等得越久排越前）
  // 服务状态可见性（第一性原理重新设计，与上面 needsYouList 是不同轴——这条答"服务本身有没有出过岔子"）：
  // latestServiceHealth = 最近一次 instances 广播里的 service 字段。
  let latestServiceHealth = null;
  // 服务告警的「忽略」（#301）：本机记住忽略到哪个指纹，状态在模块内，此处只持句柄。
  const noticeDismissals = createNoticeDismissals();
  let expandedDirs = new Set();         // 工作区面板中展开的目录（初始空，首 instances 事件填充；切 cwd 重置）
  const SESSION_PANEL_REVALIDATE_MS = 12_000;
  // P3：面板"结构性"指纹（dirs 集合 + viewingInstanceId）；只有这两者变化才全量重建整个面板
  // （低频、全量更简单可靠）。纯状态变化、或只是某个目录下实例变化，都不再经它判定——见下方按目录分键。
  let _lastPanelStructKey = null;
  // 纯换序（拖动排序广播回来的新顺序，集合不变）单独判——不算结构性变化，只挪 DOM 位置，不触发
  // openSessionPanel 的 UX-007 强制展开（2026-10-26 回归：挪别的文件夹顺序，当前工作区被连带强制展开）。
  let _lastDirOrderKey = null;
  // P3：按目录分键的实例签名（cwd → 签名片段，见 logic.js buildDirInstanceSignatures）+ diff 出的
  // "签名变了的目录"只重建那几个目录的 DOM 子树，其余目录保持原样（不撤离滚动位置/侧滑态等本地态）。
  let _lastDirSignatures = {};
  // dirRow/subtree 节点引用表（cwd → {dirRow, subtree}），供 rebuildDirSections 定位要替换的旧节点；
  // 每次 openSessionPanel() 全量重建时重新填充。
  let dirSectionNodes = new Map();
  // 设置页底部两档（#302）。建在 outbox 之前：persistOutbox 与 pagehide 回写都要先问 isResetting()。
  // 依赖全是调用时才取（点按钮之前 socket、notifications、续发队列都已建好）。
  const localReset = createLocalReset({
    isSending: () => _offlineDrainInFlight || outboxAfterTurn.size() > 0,
    beforeReset: () => { socket.io.reconnection(false); socket.disconnect(); },
    unsubscribePush: () => notifications.unsubscribe(),
  });
  // 发送 outbox（在线 timeout/retryable + 离线共用）：内存队列 + localStorage 耐久。
  // bubbleEl 仅内存；落盘只写可序列化字段（见 dumpDurableOutbox）。PWA 杀进程后靠 clientMessageId 恢复重试。
  let offlineQueue = [];
  try {
    offlineQueue = parseDurableOutbox(localStorage.getItem(OUTBOX_STORAGE_KEY));
  } catch { offlineQueue = []; }
  // 取出队列、还没有结论的条目，与 offlineQueue 一起落盘（见 app/outbox-in-flight.js）
  const outboxInFlight = createOutboxInFlight();
  function persistOutbox() {
    if (localReset.isResetting()) return; // 重置中：内存里的旧队列不许写回刚清空的存储
    try { localStorage.setItem(OUTBOX_STORAGE_KEY, dumpDurableOutbox(offlineQueue, outboxInFlight.items())); } catch { /* quota */ }
  }
  // 登记即落盘：改投后的那份要在投递（await ack）之前写下去，等 ack 时被刷新，恢复的才是改投后的路由
  function holdOutbox(item) {
    outboxInFlight.hold(item);
    persistOutbox();
  }
  function settleOutbox(item) {
    outboxInFlight.settle(item);
    persistOutbox();
  }
  // 永久拒收、此刻又没地方交还原文的条目：暂存（落盘），回到它的会话时交还（见模块头注、deliverOutboxDeadLetters）
  const outboxDeadLetters = createOutboxDeadLetters({
    storage: (() => { try { return localStorage; } catch { return null; } })(),
    targetsViewing: outboxItemTargetsViewing,
  });
  // 离线重放撞上在途轮的条目：排队、本轮结束按序自动续发（O66，见 app/outbox-after-turn.js）
  const outboxAfterTurn = createOutboxAfterTurn({ getInstances: () => instancesList });
  function enqueueOutbox(item) {
    // 交给 outbox 的气泡记下它发往哪个会话：同一会话清屏重载时 clearView 据此保住它（shouldCarryOutboxBubbleOnClear）。
    // 投递结论从 'queued' 起记（deliverOutboxItem 改写），历史重载时据此判能不能按文字认领（canTextClaimPendingBubble）。
    if (item?.bubbleEl) {
      if (item.sessionId) item.bubbleEl.dataset.outboxSessionId = item.sessionId;
      item.bubbleEl.dataset.outboxOutcome = 'queued';
    }
    const { queue, dropped } = planOutboxEnqueue(offlineQueue, item, { maxItems: OUTBOX_MAX_ITEMS });
    offlineQueue = queue;
    persistOutbox();
    if (dropped.length) {
      logClientEvent('send', `[WEB_SEND] outbox 超上限丢弃 ${dropped.length} 条最旧消息`);
    }
    return offlineQueue;
  }
  // 「读完直接锁屏」的已读落地（2026-09-07 真机报告）。此前记 seen 的两个入口都在 bindView 里，
  // 两个都要求用户【主动切走】：入场记的是「进入那一刻」，离场要真的切到别的会话或首页才触发。
  // 而移动端最常见的退出方式是不切任何东西——读完就锁屏。于是「进入之后才到达的那条回复」永远
  // 晚于位点，seen 停在进入时刻；本机因为 isViewing 让当前会话恒不亮，这笔陈旧位点在原设备上
  // 完全不显形，换一台设备打开才是那屏假未读。
  //
  // 复用 markSeen 而不是 markEntered：前者带「当前是手动未读态就跳过」的守卫——用户刚长按标了
  // 「稍后再看」就切后台，不能被这一笔当场清掉（markEntered 会连手动标记一起作废）。
  function markActiveSessionSeen() {
    if (localReset.isResetting()) return;
    if (displayedSessionId) unread.markSeen(displayedSessionId);
  }
  window.addEventListener('pagehide', () => {
    try { persistOutbox(); } catch { /* noop */ }
    // pagehide 时 socket 多半已来不及把 read:mark 发出去，但 markSeen 的 localStorage 落盘是同步的：
    // 下次连上时 read:sync 会把整表推给服务端归并。两条监听合起来才覆盖到「直接杀进程」。
    try { markActiveSessionSeen(); } catch { /* noop */ }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      try { persistOutbox(); } catch { /* noop */ }
      try { markActiveSessionSeen(); } catch { /* noop */ }
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
      connBanner: connBannerEl,
      connBannerText: connBannerTextEl,
      connBannerDetail: connBannerDetailEl,
      connBannerSpinner: connBannerSpinnerEl,
      connBannerRetry: connBannerRetryEl,
      autoContinueBanner: $('autoContinueBanner'),
      autoContinueText: $('autoContinueText'),
      autoContinueAction: $('autoContinueAction'),
      consoleModal,
      consoleLogArea,
      btnAttach,
      fileInput,
      attachTray,
      attachNotice: $('attachNotice'),
      attachPreviewModal,
      attachPreviewImg,
      attachPreviewName,
      attachPreviewClose,
      workspaceModal,
      workspaceClose,
      workspaceTabFiles,
      workspaceTabChanges,
      workspaceWorktreeGone,
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
      prefLangGroup: $('prefLangGroup'),
      prefThemeGroup: $('prefThemeGroup'),
      btnPush,
      pushSubscribeResult: $('pushSubscribeResult'),
      taskProgressBanner,
      taskProgressText,
      taskBannerLabel,
      btnTaskStop,
      taskBannerToggle,
      taskBannerChevron,
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
    sessionSearchQueryByDir,
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
    if (!localReset.isResetting()) clientLogger.flush();
    socket.emit('client:presence', { hidden: true }); // 页面即将冻结前兜底再同步一次，双保险
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && !localReset.isResetting()) clientLogger.flush();
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
    blockingSheets: () => [permModal, questionModal, $('elicitationModal')],
    onClosed: (elm) => {
      // UX-003 / #372：关闭审批 / 提问弹窗时清防误触 arming（计时器归审批模块所有）。
      if (elm === permModal) {
        elm.classList.remove('sheet-arming');
        appContext.state.approvals?.cancelPermArming();
      }
      if (elm === questionModal) {
        elm.classList.remove('sheet-arming');
        appContext.state.approvals?.cancelQuestionArming();
      }
    },
  });
  const { openSheet, closeSheet, appConfirm, setGestureDismiss } = sheets;
  const setStatus = messageRenderer.setStatus;
  const leaveStartScreen = () => {
    messageRenderer.leaveStartScreen();
    messagesEl?.querySelectorAll('.empty-session-guide').forEach(n => n.remove());
  };
  // 流内 live 活动行：ephemeral，busy 时挂在 #messages 末尾；不进 disk/history；sessionDomCache 前 strip。
  // #379：不挂 aria-live / aria-busy——秒表每 1s 变；旧 polite+恒 busy 既刷屏又（按 WAI-ARIA）全程静默。
  // 文案不 aria-hidden：它还承载「正在停止…」与 API 重试状态，读屏用户浏览到这一行时要读得到。
  // 回合开始 / 结束的播报改由 #turnAnnouncer 各写一次（announceTurn）。
  let streamLiveStatusEl = null;
  function ensureStreamLiveStatus() {
    if (streamLiveStatusEl && streamLiveStatusEl.isConnected) return streamLiveStatusEl;
    streamLiveStatusEl = el(`
      <div id="streamLiveStatus" class="stream-live-status msg-frame flex items-center justify-center px-3 py-1.5 text-xs" data-ephemeral="1">
        <span id="streamLiveStatusText" class="font-medium truncate max-w-full"></span>
      </div>`);
    return streamLiveStatusEl;
  }
  const turnAnnouncer = $('turnAnnouncer');
  function announceTurn(text) {
    if (turnAnnouncer) turnAnnouncer.textContent = text || '';
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
  // 【为什么还要这个 observer，而不是在漏掉的插入点各补一次 pin】
  // pinStreamLiveStatus 要求「每个往 #messages 塞节点的地方都记得调它」。appendMessage / addBar
  // 之外还有 8 个直接 messagesEl.appendChild 的点，2026-09-11 实测其中 4 个漏了：clearView 懒开后
  // 放回未确认气泡、renderHistoryBubbles 的 fragment 一次性落地、reconcile 里把乐观气泡移到末尾的两处。
  // 症状是 live 行停在消息流【顶部】，且只有下一条 assistant 内容到达时才被 appendMessage 顺手拉回——
  // 也就是说它精确地只在「消息发出去、回复还没来」那段时间坏着，而那正是用户盯着这一屏的时候。
  // 「每个调用点都要记得」正是会失败的那一步，所以反转成缺省：容器子节点一变动就把 live 行顶回末尾，
  // 新增插入点不必知道它的存在。不会自激——pin 在已是末尾时什么都不做，第二轮回调即收敛。
  // 上面那些同步 pin 调用保留不删：observer 回调是微任务，同步路径原样立刻正确，代价为零。
  // 守护：tests/e2e/specs/live-status-tail.spec.ts（P0-33 / P0-33b）
  if (messagesEl) new MutationObserver(pinStreamLiveStatus).observe(messagesEl, { childList: true });
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
  //
  // ★ retry 这一维【不跟】thinking/sawContentDelta/lastEventAt 走「回放一律中性」那条规矩，
  // 回放事件照样清它。因为 api_retry 是 emitTransient（不进环形缓冲），`liveLine.retry` 只可能是
  // **本次连接**期间收到的；而典型时序恰恰是「收到 api_retry → 断线 → 重连 → 回放那条成功的
  // text_delta」——回放的输出本身就是重试已经通了的证据。若在此早退，renderLiveLineText 又优先
  // 渲染 retry，spinner 会一直显示旧的 API 错误、倒计时卡在 0，直到下一条非回放流事件或轮次结束
  // （PR #38 review 第五轮 P2）。
  // 代价是 mixed 批次里旧轮的 delta 可能提前撤掉当前轮的重试行——但 api_retry 是逐次重试都发的，
  // 真还在重试下一拍就会重新点亮；反过来「永久显示一个不存在的错误」没有自愈路径。取轻。
  function clearLiveRetry() {
    if (!liveLine?.retry) return;
    liveLine.retry = null;
    renderLiveLine();
  }
  // 运行态只由【实时】事件表达。sync:since 回放的是环形缓冲里的旧信封，它的职责是把离开期间的内容
  // 补渲染出来；「此刻在不在跑」是另一件事，真相源是 instances 广播（运行条看 state，发送闸与停止钮
  // 看 turnRunning，两者故意不同——见 logic/composer.js resolveComposerPrimaryMode 的红线注释）。
  //
  // 【这两个函数必须成对存在】只让 delta 不点亮、却让 result 照常清，会在「回放批次里既有已结束的
  // 旧轮、又有当前正在跑的新轮」时翻车：bindView 刚按权威 state 播下的 busy 被旧轮 result 清掉，
  // 而属于新轮的那些 delta 已经不会再点亮它 —— 运行条与停止钮双双消失，用户看到的是「空闲」，
  // 发出去的消息却被服务端以在途轮为由拒掉。2026-09-12 PR #38 review 抓出（P1）。
  //
  // 于是整批回放对运行态【完全中性】：既不点亮也不清除，运行态一律由 instances 决定
  // （bindView 入场播种 + 广播单向对齐 + 下方 ticker 的每秒自检）。
  // 守护：tests/e2e/specs/busy-orphan-replay.spec.ts
  function setBusyFromStreamEvent(ev) {
    if (ev?.replay) return;
    setBusy(true);
  }
  // 与上面对称：回放的轮次终止事件同样不写运行态。三处调用（result / error / system:interrupted）
  // 覆盖全部轮次终点；其余收尾动作（收口气泡与工具卡、状态条、滚动）照常执行——那是「补渲染内容」。
  //
  // unlockSendGate=false 专供 error 路径：**不是所有 error 都是轮次终点**。AgentSession.map() 对
  // assistant API 错误发 recoverable:true 并【故意保持 pendingTurns 非零】直到随后的 result，
  // 模型/权限切档失败同样如此（agent.js 的 recoverable:true 几处）。跟着解锁发送闸的话，若后续
  // instances 校正延迟或丢失，用户一打字就看到「发送」，发出去的消息会被仍在跑的服务端轮次拒掉。
  // dev 上 error handler 本就只清 busy、从不动 _turnRunning——本 PR 把三处收敛到这个函数时
  // 顺手给它加上了，属于我引入的行为变更，这里改回去（PR #38 review 第六轮 P2）。
  // 终止性 error（recoverable:false）之后 _turnRunning 交由 instances 广播的权威字段收，与 dev 同。
  function clearBusyFromTurnEndEvent(ev, { unlockSendGate = true } = {}) {
    // ★ 乐观 marker 与运行态分开处置，回放时【只清 marker、不写运行态】。
    // marker 记的是「我从这个客户端发出的那条消息还没等到它的终止事件」，而回放里这条终止事件
    // 【就是】那条消息的终止事件——必须照清。不清就会悬留：它只在终止事件与负 ack 两处清除，
    // 而用户发完就切走时那条实时终止事件会被 shouldDropAgentEvent 按视图丢弃，于是 marker 永久
    // 留着，此后每次切回该会话，bindView 的 shouldRestoreOptimisticBusy 都拿它点亮一次假运行条
    // ——权威实例明明是 idle（2026-09-12 PR #38 review P2 指出；这也是真机那次现场最可能的成因：
    // 22:54:44 发消息、5 秒后切走、22:56:16 的 result 被丢弃，23:01:58 切回即假亮，秒表从切回起算）。
    _pendingSendBusySessionId = null;
    if (ev?.replay) {
      // 回放本身不表达运行态，但到这里正好可以对一次账：bindView 是【先】按乐观 marker 点亮 busy、
      // 【后】才发 sync:since 的，所以上面那次清 marker 赶不及阻止这一次假亮。拿权威快照就地判一次
      // ——权威说已空闲就立刻收掉，不必干等 ticker 的 30 秒宽限；权威说还在跑（mixed：新轮真的活着）
      // 则一动不动。两个字段各判各的：state 管运行条，turnRunning 管发送闸（纯后台任务期 state 是
      // busy 而 turnRunning 为 false，运行条该留、发送闸不该锁）。
      const live = instancesList.find(x => x?.instanceId === displayedInstanceId);
      if (live) {
        // 判据分两段，缺一段都会错（两段各自被一轮 review 抓出来过）：
        //   · turnRunning===true → 一定保住。前台轮真的在跑，运行条就该在，哪怕同时挂着后台任务
        //     （bgActive 与 turnRunning 可以同时为真）。少了这段，「后台任务 + 前台轮并存」时会
        //     被下一段误判成没有前台活动，运行条被清掉，而回放的 delta 又被刻意挡住恢复不回来
        //     ——安静的前台命令看起来没有任何运行指示，停止闸却还锁着（第四轮 P2）。
        //   · 否则退回广播那条判据。它排除 bgActive===true（纯后台任务期没有 result 可释放，
        //     运行条归 task_progress 横幅管）。少了这段，后台任务活着的整段时间里运行条和红色
        //     停止钮都撤不掉，resolveComposerPrimaryMode 的 busy && !hasContent 兜底支会把主按钮
        //     锁成停止钮（第三轮 P2）。
        const authoritative = resolveRunStateFromSnapshot(live);
        if (!authoritative.busy) setBusy(false);
        if (!authoritative.turnRunning) _turnRunning = false;
      }
      return;
    }
    setBusy(false);
    // 发送闸解锁：事件流是权威且必达的那条通道，instances 广播只作校正。
    // 只靠广播清会留死锁——广播丢一次/某条路径压根不广播，用户就永远发不出下一条了。
    if (unlockSendGate) _turnRunning = false;
  }
  // ★ 兜底清除的【后果】只写一处，两条兜底通道（instances 广播看门狗、startLiveTicker 每秒自检）共用。
  // 这是把判据收敛到 shouldClearBusyBySnapshot 的另一半：判据共用而后果各写各的，等于把「改一处
  // 漏另一处」换个地方重开——事实上就重开过一次，ticker 清了乐观 marker、广播看门狗没清，于是权威
  // 说空闲、运行条也收掉了，marker 却还留着，下一次切回该会话 bindView 的 shouldRestoreOptimisticBusy
  // 又拿它把假运行条连同停止钮点亮一整个宽限窗，每切回一次重演一次（PR #38 review 第八轮 P2）。
  // 触发它不需要丢包：移动端页面转后台时 setInterval 被节流甚至冻结，而 socket 消息醒来后照常派发，
  // 于是「广播先于被节流的 ticker 到达」是常态而非边角。
  // 注意 setBusy(false) 会 stopLiveTicker()，所以广播看门狗清完之后 ticker 不会再跑来补这一刀。
  function forceClearBusyByAuthority(live) {
    // 乐观 marker 记的是「我从这个客户端发出的那条消息还没等到它的终止事件」。权威此刻说这个实例
    // 空闲且已过宽限，那条登记就是过期的——留着只会在下次 bindView 把假运行态复活。
    _pendingSendBusySessionId = null;
    // 发送闸按权威快照收。【为什么必须一起清】gap / 大缓冲 reload 那条路径上回放会被整批丢弃，
    // clearView 之后 busy 与 _turnRunning 都是从这个悬留的乐观 marker 恢复的；只清 busy 不清闸，
    // resolveComposerPrimaryMode 优先看 _turnRunning，主按钮会永久停在停止钮、一条也发不出去，
    // 直到下一次 instances 广播——而「系统安静时广播根本不来」正是自检存在的理由（第四轮 P1）。
    // 广播路径上 _turnRunning 在本函数之前已按 viewedInst.turnRunning 对齐过一次，这里是幂等的；
    // ticker 路径则只有这一次机会。setBusy(false) 内含 updateSendButtonState()，故赋值必须排在它之前。
    if (!resolveRunStateFromSnapshot(live)?.turnRunning) _turnRunning = false;
    setBusy(false);
  }
  function startLiveTicker() {
    if (liveTicker) return;
    liveTicker = setInterval(() => {
      if (!liveLine) return;
      // 兜底自检：清 busy 的两条既有通道都是被动的——轮次终止事件可能被视图路由丢弃（见上），
      // 而 instances 广播上的看门狗只在【收到广播】时才跑，系统一安静就永远不来（真机现场那 100 秒
      // 里一次广播都没有）。这里每秒主动看一眼权威快照，把「等广播」换成「自己查」。
      // 判据与广播看门狗共用 shouldClearBusyBySnapshot（含「查不到实例就不清」与宽限窗）：
      // 两处问的是同一个问题，此前各写一份，ticker 那份漏了 bgActive 折算（review 第六轮 P2）。
      const live = instancesList.find(x => x?.instanceId === displayedInstanceId);
      if (shouldClearBusyBySnapshot({
        live,
        localBusy: _busyState,
        turnStartTs: liveLine.turnStartTs,
        now: Date.now(),
      })) {
        forceClearBusyByAuthority(live);
        return;
      }
      renderLiveLine();
    }, 1000);
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
  // 进程异常退出的提示按会话记住，清屏重载历史后补回（验收 O60，见 crash-notices.js）
  const crashNotices = createCrashNotices({ addBar, hasNotice: () => Boolean(messagesEl.querySelector('[data-crash-notice]')) });
  // 消息流时间戳：跨天插日期分隔行、用户发言间隔超阈值插一次 HH:mm。只作用于主链 user/assistant
  // 气泡，工具卡/thinking/系统条一律不夹（那些在一个回合里密集刷屏，加时间戳是纯噪音）。
  const messageTimeline = createMessageTimeline({ createElement: el, appendMessage, messagesEl });
  // 拉历史在途时把镜像追平的 history_append 扣住，历史落地后再放行——顺序与打戳同时正确。
  const historyLoadGate = createHistoryLoadGate();
  // UI-007：工具卡/角标状态标 — 可信 SVG + aria-label（currentColor 吃语义色）
  // 图标与语义色一起换，两者同源于 statusIconSpec 的一次查表——染色曾由各调用点自己 add，
  // 历史回放与本轮报错收尾两处漏了，成功的 ✓ 顶着残留的 text-warning 画成棕色（2026-09-09）。
  // 缺省染色、例外显式：tone:false 只给自带色调的调用方（#sessionsDot 的 bg_locked 刻意用
  // warn 图标配 ink-faint 色，理由见 DRAWER_STATUS_META 那条注释）。
  function setStatusIcon(el, kind, { tone = true } = {}) {
    if (!el) return;
    const spec = statusIconSpec(kind);
    el.classList.add('status-icon', 't-status');
    if (tone) {
      el.classList.remove(...STATUS_ICON_TONES); // 先清：只 add 会让两个色类叠着靠 CSS 顺序决胜负
      el.classList.add(spec.tone);
    }
    el.setAttribute('aria-label', spec.label);
    el.innerHTML = spec.html;
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
  // 通用设置打开后的深链目标（推送铃铛 / 侧栏推送条）；须在 notifications 之前声明，bellAction 闭包写入。
  // 两级导航后它不再只是一个锚点 id：得先切到目标 L2 页，再滚到页内锚点——只滚不切页的话，
  // 目标元素还在 hidden 的子页里，scrollIntoView 静默无效（表现为「点了没反应」）。
  let generalDeepLink = null; // { page: string, anchor?: string }
  let general = null; // 后段 createSettingsController 赋值；bellAction 点击时再 open
  // 同上：后段赋值。renderDeviceRequests / renderPushStatusRow 在文件前段就要通知它重画目录，
  // 而那两个函数的**调用**都发生在异步事件里（socket 回调），届时早已赋值。
  // 用 let + null 而不是 const：const 在 TDZ 里被访问会抛 ReferenceError，`?.` 救不了。
  let generalNav = null;
  // 从通用设置切出去的第二层面板（服务状态 / 服务与配置）退回上一级用。
  // 那两张面板与 generalSheet 同为 z-40，叠着会互相拦点击，所以它们打开时先把设置 sheet 收了——
  // 代价是「关掉面板」在用户眼里等于「一路退到首页」，来时那一页得重新找。这里按来源页把设置
  // 面板重新开回来，退出语义就和面板内部 L1↔L2 的返回一致了。
  function reopenGeneralAt(page) {
    generalDeepLink = { page };
    general?.open();
  }
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
      // open() 会把 body scrollTop 置 0；用 pending 标记在 onOpen 后切页 + rAF 再滚到推送段
      generalDeepLink = { page: 'notify', anchor: 'pushStatusRow' };
      general?.open();
    },
  });
  // 与 alertCue 对称：sync:since 补发期间静音 OS 通知，避免前台完成通知连弹（result / task_notification）
  // 身份：默认当前查看会话；跨工作区/后台任务必须显式传 cwd/sessionId，否则会把别人的完成标到正在看的那条上。
  const notify = (title, body, opts = {}) => {
    if (appContext.state.isReplayBatch) return false;
    const sessionId = opts.sessionId !== undefined ? opts.sessionId : currentSessionId;
    const cwd = opts.cwd !== undefined ? opts.cwd : currentCwd;
    const sessionTitle = lookupNotifySessionTitle({
      sessionId, cwd, sessionsCache, instances: instancesList,
    });
    return notifications.notify(
      formatNotifyIdentity(title, { cwd, sessionTitle }),
      body,
      {
        ...opts,
        tag: opts.tag || notifySessionTag(sessionId),
        identity: formatNotifyIdentity('', { cwd, sessionTitle }),
      },
    );
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
  let onTaskProgress = taskStatus.onProgress;
  let hideTaskProgress = taskStatus.hideProgress;
  const onTaskNotification = taskStatus.onComplete;

  // ---- socket ----
  // 没令牌、又会走令牌门时不在开页时握手（必然被拒且被记成一次鉴权失败，验收 O20），下面直接出令牌门；
  // submitAuth 写入令牌后自己 socket.connect()。
  const handshakeOnBoot = shouldHandshakeOnBoot({ token, lanOrLocal: isLanOrLocal(), cfAccessFlag: document.body.dataset.cfAccess });
  const socket = appContext.setSocket(io({
    auth: { token, deviceToken },
    autoConnect: handshakeOnBoot,
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
        ...(item.sessionId ? { sessionId: item.sessionId } : {}), // 服务端据它核对命中的实例还是不是那个会话（MSG-02）
        ...(item.useWorktree === true ? { useWorktree: true } : {}),
        ...(item.sourceBranch ? { sourceBranch: item.sourceBranch } : {}),
        ...(item.composeId ? { composeId: item.composeId } : {}), // 新会话页入队的：开它自己的新会话（O107）
        // 告诉服务端「这是入队时刻的快照，不是眼下的意图」：缺 instanceId 时不得回退到服务端
        // 当前 viewing（断线期间可能已换工作区），见 instance-routing.js 的 allowViewingFallback。
        fromOutbox: true,
      }, (err, ack) => {
        const decision = presentOfflineResendAck(err, ack);
        // 气泡记下这次投递的结论；结局不明（超时、服务端让重试）的记一笔、粘住不撤——它可能已写进 transcript，
        // 只是回执没到。历史重载时据这两样判能不能按文字认领（canTextClaimPendingBubble）。
        if (item.bubbleEl) {
          item.bubbleEl.dataset.outboxOutcome = decision.outcome;
          if (decision.outcome === 'requeue') item.bubbleEl.dataset.outboxMaybeSent = '1';
        }
        resolve(decision);
      });
    });
  }

  // 撞上在途轮（排队已移除）：不再 requeue 空转，落「未发送」终态 + 一个手动「重发」按钮。
  // 同一 clientMessageId 可直接复用——服务端在 busy 拒绝路径上没有 commit 去重 ID。
  // 挑落点：判据与理由全在 logic/outbox-send.js 的 outboxNoticePlacement 注释里。
  // 关键一条——querySelector 能从【已脱离 DOM】的缓存子树里找到 indicator，所以「找得到」
  // 不等于「看得见」；而 addBar 写的是当前消息面，归属对不上就是把 A 会话的失败打到 B 会话上。
  function outboxNoticeHost(item, targetsViewing, barClass) {
    const indicator = item.bubbleEl?.querySelector('.pending-indicator') || null;
    const where = outboxNoticePlacement({
      indicatorExists: Boolean(indicator),
      indicatorConnected: Boolean(indicator?.isConnected),
      targetsViewing,
    });
    if (where === 'indicator' || where === 'stale') return indicator;
    if (where === 'bar') return addBar('', barClass);
    return null;
  }

  // 离线重放撞上续接分叉闸的那一条，挪回输入框交给面板。只挪投给眼前这个会话、且输入框空着的——
  // 否则不是覆盖了用户新打的字，就是把别的会话的话塞到这里。条目带着会话时按会话认：规则 5 置换、切 effort
  // 之后同一会话换了实例号，服务端按会话改投（MSG-02），按实例号比就认不出它，「重发」会原地打转。
  function moveOutboxItemToComposer(item) {
    if (!item) return false;
    const sameSession = typeof item.sessionId === 'string' && item.sessionId !== '' && item.sessionId === displayedSessionId;
    if (item.instanceId !== displayedInstanceId && !sameSession) return false;
    if (inputEl.value.trim() || attachments.items().length) return false;
    dropPendingUserBubble(item.bubbleEl);
    inputEl.value = item.text || '';
    inputEl.dispatchEvent(new Event('input'));
    if (Array.isArray(item.attachments) && item.attachments.length) attachments.setItems(item.attachments);
    autosize();
    updateSendButtonState();
    return true;
  }

  // afterTurn（O66）：被在途轮挡下的离线条目——排队，本轮结束由 outboxAfterTurn 替用户点这里的「重发」；
  // 手动点照样可以。续接分叉闸挡下的（divergence）不排队：那边没有在途轮，等多久都是同一道闸。
  function markOutboxBlocked(item, message, targetsViewing = false, { afterTurn = false } = {}) {
    // 有结论之前一直落盘：刷新之后下一次批处理还能重新投递它（见 app/outbox-in-flight.js）。
    // 这里的 item 可能刚按懒开锚改投过（planOutboxBlockedTarget），立即落盘，不等整批结束。
    holdOutbox(item);
    const host = outboxNoticeHost(item, targetsViewing, 'text-warning');
    // 无正确落点（气泡没了且不属于当前会话）——不在别的会话里凭空多一条提示。但排队照样登记：它已经不在
    // offlineQueue 里，不登记就既不续发、也没有手动「重发」，这条话就丢了（重载后恢复、发往后台会话的条目）。
    if (!host) {
      if (afterTurn) {
        outboxAfterTurn.wait({ instanceId: item.instanceId ?? null, sessionId: item.sessionId ?? null }, {
          resend: () => resendOutboxHeadless(item),
          cancel: () => settleOutbox(item),
        });
      }
      return;
    }
    host.classList.remove('animate-pulse');
    host.textContent = '';
    const label = el(`<span></span>`);
    let queued = afterTurn;
    const blockedText = msg => (queued ? `⏳ ${t('排队中 · 本轮结束后自动发送')}` : `⏸ ${msg || t('未发送 · 任务运行中')}`);
    label.textContent = blockedText(message);
    host.appendChild(label);
    const btn = el(`<button type="button" class="ml-2 underline decoration-dotted" data-testid="outbox-resend">${t('重发')}</button>`);
    let settled = false;
    // 返回这次投递的结论（已送达或正在发时返回 null），outboxAfterTurn 据此决定出队还是接着等
    const resend = async () => {
      if (settled || btn.disabled) return null;
      btn.disabled = true;
      label.textContent = `🕐 ${t('正在发送...')}`;
      // 真正发出时挪到消息流最后：它排在这一轮的回答之后，问答顺序才与发送顺序一致（O66）
      if (item.bubbleEl?.parentElement === messagesEl) appendMessage(item.bubbleEl);
      const d = await deliverOutboxItem(item);
      if (d.outcome === 'ok') { settled = true; host.remove(); settleOutbox(item); return d.outcome; }
      // 续接会丢掉一段对话（SESSION-04）：再发一遍还是同一道闸。把这条挪回输入框，出在线路径同一块面板——
      // 两个选项都作用于输入框里的话。挪不了（不是眼前这个会话的、输入框里已有新打的字）就留在这里。
      if (d.divergence && moveOutboxItemToComposer(item)) {
        settled = true;
        host.remove();
        settleOutbox(item);
        resumeDivergencePrompt.prompt({ divergence: d.divergence, sessionId: displayedSessionId, cwd: drivingCwdOf(displayedInstanceId) });
        return d.outcome;
      }
      btn.disabled = false;
      label.textContent = d.outcome === 'blocked' ? blockedText(d.message) : `⚠️ ${d.message || t('发送失败')}`;
      return d.outcome;
    };
    btn.onclick = () => { resend(); };
    host.appendChild(btn);
    if (afterTurn) {
      outboxAfterTurn.wait({ instanceId: item.instanceId ?? null, sessionId: item.sessionId ?? null }, {
        resend,
        // 按了停止就不再自动发，也不再落盘：留着的话，刷新后下一次批处理会替用户把它发出去（与停止的意思相反）
        cancel: () => {
          queued = false;
          settleOutbox(item);
          if (!settled && !btn.disabled) label.textContent = `⏸ ${t('未发送 · 本轮已停止，需要时点重发')}`;
        },
      });
    }
  }

  // 没有提示落点的排队条目由 outboxAfterTurn 续发：送达或又撞上一轮（留在队首）照常返回；别的结局放回持久化队列，
  // 交给下一次批处理按常规处置——不在这里替它决定是死信还是重试，也不能让它在内存里悄悄消失。
  async function resendOutboxHeadless(item) {
    const d = await deliverOutboxItem(item);
    if (d.outcome === 'ok') { settleOutbox(item); return d.outcome; }
    if (d.outcome === 'blocked' && !d.divergence) return d.outcome;
    enqueueOutbox(item);
    settleOutbox(item);
    return 'requeue';
  }

  // 离线批处理眼里的「当前视图」：横幅、逐条 targetsViewing、批后 busy 三处归属判据共用这一份，少传一维就和另外两处分叉。
  // 每次现取——drain 期间到达的 instances 广播（规则 5 置换、切 effort）会换掉视图的实例号。会话取 sendSessionId()：
  // 当前查看实例此刻跑的会话，与 viewingInstanceId 同一份 instances 快照。
  const outboxViewing = () => ({ viewingInstanceId, viewingCwd: currentCwd, viewingSessionId: sendSessionId() });

  // 离线条目的拒收提示：眼前多半是起始类表面（「服务已重启」面板、首页、新会话页）。addBar 会先 leaveStartScreen
  // 把整张表面清空——R7 截图里那片空白，就是服务端那行提示条冲掉了带「继续此会话」的重启面板（O126）；新会话页被冲掉时
  // 「文件夹已断开、改在这里开」那句跟着没了，输入框里的原文再发就悄悄换了文件夹（O128）。挂在表面顶上，不清它。
  function addOutboxRejectBar(text) {
    if (!messagesEl.classList.contains('empty-start')) return addBar(text, 'text-danger');
    const bar = el(`<div class="msg-frame text-center text-xs text-danger"></div>`);
    bar.textContent = text;
    messagesEl.insertBefore(bar, messagesEl.firstChild);
    return bar;
  }

  // 进了死信暂存、眼前又没有会话（outboxParkedNotice 判过）：说一句，并给一个回到那个会话的入口——回去之后
  // deliverOutboxDeadLetters 照常把原文放回输入框。切换的 ack / 4s 兜底同 dashboard 最近列表的 switchToSession。
  function addOutboxParkedBar(text, item) {
    const bar = addOutboxRejectBar(text);
    if (!bar || !item.sessionId) return;
    const btn = el(`<button type="button" class="ml-2 underline decoration-dotted" data-testid="outbox-parked-goto">${t('回到该会话')}</button>`);
    btn.onclick = () => {
      haptic('tap');
      let acked = false;
      const blocked = message => showSessionBlockedSurface({ sessionId: item.sessionId, cwd: item.cwd, message });
      socket.emit('session:switch', { sessionId: item.sessionId, cwd: item.cwd }, res => {
        acked = true;
        if (!res?.ok) blocked(res?.error || t('切换失败'));
        else dismissBlockedSurfaceIfTarget(item.sessionId, item.cwd);
      });
      setTimeout(() => { if (!acked) blocked(t('切换无响应，请刷新页面后重试')); }, 4000);
    };
    bar.appendChild(btn);
  }

  // 交还暂存的永久拒收条目：只交给它自己的会话；输入框空着就放回输入框，否则原文写进提示条（看得见、复制得到）。
  function deliverOutboxDeadLetters() {
    for (const d of outboxDeadLetters.takeFor(outboxViewing())) {
      if (moveOutboxItemToComposer(d)) addBar(`${d.message}${t('，原文已放回输入框')}`, 'text-danger');
      else addBar(`${d.message}${t('。原文：')}${d.text}`, 'text-danger');
    }
  }

  async function processOfflineQueue() {
    if (_offlineDrainInFlight || offlineQueue.length === 0) return;
    // 断线时根本不开工：下面的横幅是无条件同步贴的，若此时离线，用户会看到「正在重发 N 条…」
    // 然后一条也发不出去（循环里的 socket.connected 检查会把每条都跳过）。重连时 connect 回调
    // 会再调一次本函数，那才是该贴横幅的时刻。
    if (!socket.connected) return;
    _offlineDrainInFlight = true;
    const items = offlineQueue;
    // 本批取出；requeue 的再 enqueue。取出的条目有结论之前照样落盘（outboxInFlight）：投递中途、排队等本轮结束时
    // 被刷新或被系统回收标签页，下一次批处理还能把它们找回来。
    for (const item of items) outboxInFlight.hold(item);
    offlineQueue = [];
    persistOutbox();
    // 横幅贴的是当前会话消息流，但队列项的目标是入队时刻那个实例——不标注归属会读成
    // 「这条排队消息在本会话发了」（现场：在 Official 实例 看到 third-party 的重发提示）。
    const notice = planOutboxDrainNotice({ items, ...outboxViewing() });
    // 进行中的横幅，批处理结束就撤（验收 O65：此前不留引用，「正在重发 1 条…」重发完了还一直挂着）。
    // 各条的结局（送达 / 未发送 + 重发 / 永久拒绝）都落在各自的气泡或提示条上，不靠这一条。
    const drainBar = addBar(notice.text, 'text-info');
    logClientEvent('send', `[WEB_SEND] 正在重发离线发送队列中的 ${items.length} 条消息（其中 ${notice.foreign} 条发往其它会话）`);
    let hadViewingOk = false;
    // 本批里第一条「在新 worktree 里开」真正开出来的实例。后续同意图的条目改投它，不再各建一棵树。
    // 同理，本批第一条「无文件夹」消息开出来的实例（否则一条建一个 scratch 目录、开一个会话）。
    // 两种锚都按新会话页分（outboxComposeKey）：用户有意新开的另一页要各开各的。
    const worktreeAnchors = new Map();
    const scratchAnchors = new Map();
    // 普通工作区新会话页上第一条懒开的实例（按页 + 目录分）：后面各条被它那一轮拒收时按它登记，本轮结束才认得出目标。
    const lazyOpenAnchors = new Map();
    const scratchRoot = projectsState.scratchRoot();
    try {
      for (const item of items) {
        const indicator = item.bubbleEl?.querySelector('.pending-indicator');
        // REL-01：用入队时刻的 instanceId/cwd，不取当下 viewing。
        // 例外是「在新 worktree 里开」「无文件夹」：同一个新会话页里各只该兑现一次（判据见 planOutboxWorktreeReuse），
        // 否则每条各建一棵树 / 一个 scratch 目录、各开一个会话，同一个任务被拆进互不相干的上下文。
        // 改投过的条目此后一律按改投后的走（重新入队、「重发」按钮都是）：拿原始条目再发，锚点已不在，又会另开一个。
        const page = outboxComposeKey(item);
        const planned = planOutboxScratchReuse(planOutboxWorktreeReuse(item, worktreeAnchors.get(page) ?? null), scratchAnchors.get(page) ?? null, scratchRoot);
        holdOutbox(planned); // 落盘的是改投后的那份：刷新后再投不能又另建一棵树 / 一个 scratch 目录
        // 中途断线必须停手：socket.io 在未连接时把 emit 压进 sendBuffer，而断线回调 _clearAcks
        // 【显式跳过 buffered 包】（socket.io-client/build/cjs/socket.js 的 isBuffered 判断）⇒ 带
        // timeout 的 ack 不会被断线立刻拒掉，每条都要烧满 OFFLINE_RESEND_ACK_MS 才 settle。串行 drain
        // 下就是 N × 30s 的停摆，且这期间 _offlineDrainInFlight 一直占位，重连时 connect 里的
        // processOfflineQueue() 直接早退空转，条目要拖到【再下一次】connect 才动。断了就整批留在队列里
        // 等 reconnect——那本来就是 outbox 的语义，不必替它在离线时空转。
        if (!socket.connected) {
          enqueueOutbox(planned);
          settleOutbox(planned);
          if (indicator) indicator.textContent = t('🕐 正在等待连接...');
          continue;
        }
        if (indicator) indicator.textContent = t('🕐 正在发送...');
        logClientEvent('send', `[WEB_SEND] 重发离线消息: "${String(item.text || '').slice(0, 100)}" (${String(item.text || '').length} 字符)`);
        const decision = await deliverOutboxItem(planned);
        const worktreeAnchor = nextOutboxWorktreeAnchor(item, decision, worktreeAnchors.get(page) ?? null);
        if (worktreeAnchor) worktreeAnchors.set(page, worktreeAnchor);
        const scratchAnchor = nextOutboxScratchAnchor(item, decision, scratchAnchors.get(page) ?? null, scratchRoot);
        if (scratchAnchor) scratchAnchors.set(page, scratchAnchor);
        const lazyKey = `${page}\n${item.cwd ?? ''}`;
        const lazyAnchor = nextOutboxLazyOpenAnchor(item, decision, lazyOpenAnchors.get(lazyKey) ?? null, scratchRoot);
        if (lazyAnchor) lazyOpenAnchors.set(lazyKey, lazyAnchor);
        const targetsViewing = outboxItemTargetsViewing(item, outboxViewing());
        if (decision.outcome === 'ok') {
          settleOutbox(planned);
          if (indicator) indicator.remove();
          if (targetsViewing) hadViewingOk = true;
        } else if (decision.outcome === 'permanent') {
          settleOutbox(planned); // 原文交还输入框或进死信暂存（它自己落盘），不再重投
          const permanentMsg = `⚠️ ${decision.message || t('发送失败')}${t('，已停止重试')}`;
          // 服务端永久拒收、outbox 已清，这条不会再发——原文得交还给用户（验收 O31：此前只剩一行提示，输入框是空的）。
          // 投给眼前这个会话且输入框空着：放回输入框，气泡随之撤掉。否则提示落在气泡上（气泡里就是原文）；
          // 连气泡都不在时把原文写进提示条，至少还看得见、复制得到。
          if (moveOutboxItemToComposer(planned)) {
            addOutboxRejectBar(`${permanentMsg}${t('，原文已放回输入框')}`);
          } else {
            // 同 markOutboxBlocked：走同一套落点判据，不能只看 indicator 取不取得到。
            const permanentHost = outboxNoticeHost(item, targetsViewing, 'text-danger');
            const inBubble = Boolean(permanentHost?.closest?.('[data-testid="user-message"]'));
            if (permanentHost?.isConnected) permanentHost.textContent = inBubble ? permanentMsg : `${permanentMsg}${t('。原文：')}${item.text || ''}`;
            // 眼前看不到的都暂存，回到它的会话时交还（PR #232 review）：重载后恢复的条目没有气泡（落点 'none'）；
            // 气泡只在 DOM 缓存里（'stale'）也不能指望——断线期间 server 重启时那个实例已经没了，重开会话不再用那份缓存，
            // 写在缓存气泡上的提示和原文一起丢（验收 O31 / AC-13-07）。气泡一并摘掉，交还时只剩输入框里那一份。
            else {
              dropPendingUserBubble(item.bubbleEl);
              const parkedText = outboxParkedNotice({ viewingInstanceId, stale: decision.stale, message: decision.message, sessionId: planned.sessionId, text: planned.text });
              // 交还不了的（升级前入队）：眼前没有会话时上面已把原文写出来，不再暂存；正在看某个会话时暂存，由这个视图落定时的
              // deliverOutboxDeadLetters 交出来——不当场写，是因为首次 bindView 还没走完，写进去的会被它清掉（验收 O135）
              const unreturnable = isUnreturnableDeadLetter({ stale: decision.stale, sessionId: planned.sessionId, instanceId: planned.instanceId });
              if (!(unreturnable && parkedText)) {
                outboxDeadLetters.park(planned, unreturnable ? outboxDeadLetterHead({ stale: decision.stale, message: decision.message }) : permanentMsg, { unreturnable });
              }
              if (parkedText) addOutboxParkedBar(parkedText, planned);
            }
          }
          logClientEvent('send', `[WEB_SEND] 离线消息被服务端永久拒绝（${decision.message || ''}），停止重试`);
        } else if (decision.outcome === 'blocked') {
          // 队列首条发出去就开跑，其后各条必被拒。不 requeue 空转：交给 outboxAfterTurn 排队，本轮结束按序续发（O66）。
          markOutboxBlocked(planOutboxBlockedTarget(planned, lazyOpenAnchors.get(lazyKey) ?? null), decision.message, targetsViewing, { afterTurn: !decision.divergence });
          // viewingInstanceId 非空才锁发送闸：首页没有「当前会话」可被别的轮次挡住，而按 cwd 归属
          // 的判据在首页会对 {instanceId:null, cwd:同目录} 返回 true（那对横幅文案是对的，对这里不是）。
          // 漏这个前提会在空首页把 compose 的发送钮禁掉，直到下一次 instances 广播才自愈。
          // 续接分叉闸（divergence）也落 blocked，但那边没有在途轮：锁了发送闸，面板上的「仍然发送」就发不出去。
          if (viewingInstanceId != null && targetsViewing && !decision.divergence) _turnRunning = true;
          logClientEvent('send', decision.divergence
            ? '[WEB_SEND] 离线消息撞上续接分叉闸，落未发送终态待手动重发'
            : '[WEB_SEND] 离线消息撞上在途轮，落未发送终态待手动重发');
        } else {
          if (indicator) indicator.textContent = t('🕐 未确认送达，等待重连重试...');
          enqueueOutbox(planned);
          settleOutbox(planned);
          logClientEvent('send', `[WEB_SEND] 离线消息重发未确认，已重新排队`);
        }
      }
    } finally {
      _offlineDrainInFlight = false;
      drainBar?.remove();
      persistOutbox();
      outboxAfterTurn.tick(); // 批处理期间那一轮可能已经跑完（广播先到）：不等下一条广播
      // 批后 busy：仅 viewing 相关 in-flight/成功才抬；永久失败且无剩余 viewing 队列 → clear
      setBusy(shouldBusyAfterOfflineBatch({
        ...outboxViewing(),
        remainingItems: offlineQueue,
        hadViewingOk,
      }));
    }
  }

  // 移动端切前台/重连后的统一 sync 入口（命中根因 A/B）。复用 clearView（清 DOM + 重置 lastSeq/curEpoch
  // 去重基线）→ loadHistory（默认 cwd=currentCwd、ack 内 hideLoadingCard）。connect 路径不像 bindView 那样
  // 先 clearView，loadHistory 是 appendChild 不清空，故重载前必须先 clearView 防重复整段对话。
  const PROBE_MS = 5000; // 探测 ack 超时：远低于 socket.io 被动心跳超时窗口(~45s)，又容忍移动端慢 RTT
  // session:history 的 ack 超时。给得宽松（server 要读整份 transcript，长会话可能上千条），
  // 它的职责不是"快速失败"而是"保证回调一定会被调用一次"——裸 ack 在断线时会被静默丢弃，
  // 那正是 historyLoadGate 永久卡死的两个成因之一（见 history-load-gate.js 的看门狗注释）。
  const HISTORY_ACK_TIMEOUT_MS = 15000;
  // sync:since 的 ack 超时（bindView 入场 + connect 重连补传两处共用，F3/2026-08-06）。职责同上：
  // 不是快速失败，是保证回调必被调用一次——裸 ack 断线时被 _clearAcks() 静默丢弃，而加载卡收场、
  // 历史加载、pending 快照对账全挂在回调里。server ack 前要先逐条重放环形缓冲，给同样宽松的窗。
  const SYNC_ACK_TIMEOUT_MS = 15000;
  let _probeInFlight = false;
  function reloadCurrentFromHistory(onDone) {
    if (!displayedSessionId) return;
    hideUnreadPill(); // 即将清屏重载：旧胶囊指向的 DOM 节点马上失效，先清，onDone 到达后再按新数字重建
    scrollToBottom.reset(); // 同上：回到最新钮的基线/可见态跟着旧 DOM 一起作废
    // 与 bindView reload 同理：clearView 前的 lastSeq/curEpoch 可能刚被 sync 回放推进；
    // 归零后若再 sync 会把环形缓冲整段再叠到磁盘历史上。恢复基线，仅丢未落盘的实时中间态。
    const keepSeq = lastSeq;
    const keepEpoch = curEpoch;
    clearView(displayedSessionId, null, { prevSessionId: displayedSessionId });
    lastSeq = keepSeq;
    curEpoch = keepEpoch;
    // clearView 内部只补乐观 busy（shouldRestoreOptimisticBusy），不含 state seed——
    // 前台回切/重连 gap→reload 静默窗口无 delta 自愈，运行条被本次清屏永久抹掉 → 按 server 权威 state 重种。
    if (shouldReseedBusyAfterReload({ instances: instancesList, instanceId: displayedInstanceId })) setBusy(true);
    // 发送闸同理：clearView 把 _turnRunning 清了，按广播的权威字段重种，否则 reload 后停止钮消失
    if (instancesList.find(x => x?.instanceId === displayedInstanceId)?.turnRunning === true) _turnRunning = true;
    showLoadingCard();
    loadHistory(displayedSessionId, undefined, onDone); // cwd 默认驾驶轴（见 loadHistory 头注）
  }
  // 状态对账：用 sync:since ack 带回的 pending 快照重建未决审批/提问卡片。走既有 handler（自带 requestId
  // 去重 + 弹窗/通知）。修「角标 ⚠️ 待审批但会话内无卡片」——原始事件可能被环形缓冲 trim 或切视图分流丢弃，
  // pendingPermissions/pendingQuestions 才是权威真相。视图稳定后调用（bindView / connect 两路径）。
  function applyPendingSnapshot(pending, instanceId) {
    if (!pending) return;
    // 走 sync:since ack 的 pending 字段重建卡片，不经过 dispatchAgentEvent，故不带 event.replay 标记；
    // 这里单独置位 isReplayBatch 防止环形缓冲被冲出窗口（gap）时，这条旁路漏静音重新弹响。
    // try/finally：handle.* 会动 DOM，若中途抛错也必须复位，否则 isReplayBatch 卡在 true 会静默吞掉后续所有实时提示音。
    // instanceId：快照属于这次 sync 的实例；合成信封第二参，让 enqueue 存下所属实例（#388）。
    const env = instanceId ? { instanceId } : undefined;
    appContext.state.isReplayBatch = true;
    try {
      for (const p of pending.permissions || []) handle.permission_request(p, env);
      for (const q of pending.questions || []) handle.question(q, env);
      for (const e of pending.elicitations || []) handle.elicitation(e, env);
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
        // 只有还连着（ack 超时、连接可疑）才自己重连。没连着时这个回调多半是 socket.io-client 在 Manager.onclose 里
        // 同步回调在途 ack 触发的——Manager 紧接着就会排自己的重连；此刻再 socket.connect() 会抢先发起一次不带回调
        // 的 open，Manager 定时器那次 open(fn) 随后被吞，_reconnecting 永久停在 true：这次碰巧连上看不出毛病，之后
        // 每次断线 reconnect() 第一行就返回，页面停在「自动重连中…」（验收 O49，对照 socket.io-client 4.8.4 源码）。
        if (socket.connected && reconnectAllowed()) forceReconnect();
        return;
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
      applyPendingSnapshot(res?.pending, reqInstanceId);
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
      // F3：裸 ack 断线时被 _clearAcks() 静默丢弃（同 loadHistory 的教训）→ pending 快照对账永久缺失。
      // 带 timeout 后 err 走 act 的既有 'reconnect' 分支：ack 超时 = 连接可疑，干净重连一次。
      socket.timeout(SYNC_ACK_TIMEOUT_MS).emit('sync:since', payload, (err, res) => act(err, res));
    }
  }


  // ---- 连接同步：RTT 旁路监测由独立 controller 管理 ----
  const rttMonitor = createRttMonitor(appContext, { setStatus });
  const clearRttDisplay = rttMonitor.clear;
  const measureRtt = rttMonitor.measure;
  const startRttLoop = rttMonitor.start;
  const stopRttLoop = rttMonitor.stop;

  // ---- 连接状态横幅：连通性的人话通道 ----
  // 抑制条件读的是两个全屏门的 hidden class：鉴权失败时 socket 永远连不上，此时挂一条
  // 「自动重连中…」既误导又与全屏令牌输入页视觉打架。因此 connect_error 不必额外接线。
  // 写成 !!el && !hidden 而不是 !el?.classList.contains('hidden')：后者在元素缺失时得到 !undefined
  // === true，也就是「恒抑制」——一次 id 改名就会静默关掉整个横幅，无报错、无红测试。
  const gateIsOpen = el => !!el && !el.classList.contains('hidden');
  const connBanner = createConnectionBannerController(appContext, {
    onRetry: () => reconnectIfNeeded(),
    onToggle: () => scrollBottom(), // 横幅占一行会改 #messages 高度；非 force 调用不贴底会自动 no-op
    // 四个 z-50 全屏门都要算：它们盖住整屏时，底下再挂一条「自动重连中…」既看不见又会被读屏念出来，
    // 而且 deviceDenied/deviceModal 下重连是徒劳的（设备没获批，连上也会被再次拒绝）。
    isSuppressed: () => gateIsOpen(authGate) || gateIsOpen(accessRelogin)
      || gateIsOpen(deviceDenied) || gateIsOpen(deviceModalEl),
  });
  // io() 在本脚本同步执行流里已发起连接、中间无 await，故此处即「首连开始」的准确起点。
  connBanner.markConnecting();
  if (!handshakeOnBoot) {
    setStatus(t('需要访问令牌'));
    showAuthGate(''); // 首访不是「令牌无效」，不带错误文案
  }

  // ---- 额度墙「到点自动继续」横幅：数据 = instances 广播的 autoContinue，按钮 → user:autoContinue ----
  // 结果以服务端下一次广播为准；只有请求失败（超时 / 相位已变 / 设备未批准）才就地重画、解锁按钮。
  const autoContinueBanner = createAutoContinueBannerController(appContext, {
    onAction: ({ sessionId, action }) => {
      socket.timeout(10_000).emit('user:autoContinue', { sessionId, action }, (err, ack) => {
        if (err || !ack?.ok) autoContinueBanner.refresh();
      });
    },
    onToggle: () => scrollBottom(), // 同连接横幅：占一行会改 #messages 高度，非 force 调用不贴底会自动 no-op
  });

  socket.on('connect', () => {
    authGate?.classList.add('hidden');           // 鉴权通过：收起令牌输入页
    if (authToken) authToken.value = '';         // 成功后不把令牌留在本地表单状态里
    accessRelogin?.classList.add('hidden');      // 连上即收起重登浮层
    connectErrorCount = 0;
    if (authSubmit) { authSubmit.disabled = false; authSubmit.textContent = t('进入'); }
    connBanner.markConnected(); // 必须排在上面两个门收起之后：isSuppressed 此刻才为 false
    updateAttentionSignal();
    setStatus(t('已连接'));
    startRttLoop(); // 连上即开始测 RTT（立即一次 + 周期）
    cliStatusBarEl?.classList.remove('opacity-40'); // E16：重连恢复（折叠条整体：summary + ANSI 行，重放/刷新马上跟上）
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

    // 已读位点归并（2026-09-03）：把本地表推上去、取回全局权威态。这一趟同时干三件事——
    // 迁移升级前只存在于 localStorage 的记录、补上离线期间攒的位点、把本设备的基线换成全局基线。
    // 最后一件才是「换设备整屏复亮」的根因修复：本地基线是「本设备首次打开时刻」，在另一台设备上
    // 读过的会话对它来说全是「基线之后有活动、又没有 seen 记录」。
    socket.emit('read:sync', unread.snapshot(), res => {
      if (unread.hydrate(res?.state)) refreshUnreadMarks();
    });

    // 触发离线发送队列重发
    processOfflineQueue();
  });
  socket.on('disconnect', (reason) => {
    connBanner.markDisconnected();
    updateAttentionSignal();
    setStatus(t('连接断开，自动重连中…'));
    stopRttLoop();
    clearRttDisplay();
    cliStatusBarEl?.classList.add('opacity-40'); // E16：置灰示陈旧（折叠条整体：summary + ANSI 行；内容含 🕐，不另发明离线文案）
    logClientEvent('conn', `网络连接断开，原因: ${reason || '未知'}`);
  });
  socket.on('connect_error', async err => {
    logClientEvent('conn', `连接尝试失败: ${err.message || err}`);
    const handshake = describeHandshakeError(err);
    if (handshake.kind === 'cooldown') {
      // 验收 O83：同一来源刚有一次登录失败，服务端在退避短锁里，这次的令牌根本没校验——既不是令牌错，
      // 也不是尝试过多。说清在等，到点用同一份凭据再握一次手。冷却期内服务端不计数，这次重试不会加锁。
      // 不另存计时器：到点时 socket 已在握手（active）就跳过，连撞几次锁也只会有一次握手在途。
      setStatus(handshake.text);
      if (authGate && !authGate.classList.contains('hidden') && authError) {
        authError.textContent = handshake.text;
        authError.classList.remove('hidden');
      }
      setTimeout(() => { if (!socket.active && !localReset.isResetting()) socket.connect(); }, handshake.retryAfterMs + 50);
      return;
    }
    if (handshake.kind === 'rate_limited') {
      // 被防暴破限速挡下：说清还要等多久。此前这里落到下面的 else，屏幕上是
      // 「连接失败：rate_limited」——用户看不懂，也不知道要等，于是反复重连撞在刚上的那把锁上。
      setStatus(handshake.text);
      // 【不】主动弹登录页：限速不等于「令牌错」，用户不需要重新输入什么。而且限速按来源分桶、
      // IPv6 按 /64 归桶，同网段另一台设备连错到阈值会连累这台——把一个令牌完全正确的已登录用户
      // 踢回登录门，既答非所问又会诱导他去改本来没问题的令牌。只在登录门本来就开着时把话放进去。
      if (authGate && !authGate.classList.contains('hidden')) showAuthGate(handshake.text);
      else {
        if (authSubmit?.disabled) { authSubmit.disabled = false; authSubmit.textContent = t('进入'); }
        // 令牌门没开：话说在连接横幅上（setStatus 写的 #statusLine 恒隐藏，此前用户只看得到「连接中…」，验收 O22）
        connBanner.markRateLimited(handshake.text);
      }
      return;
    }
    connBanner.clearRateLimited(); // 这一轮不是被锁挡下的，别再挂着上一轮的「等 N 分钟」
    if (err.message === 'unauthorized') {
      if (authFailurePath({ lanOrLocal: isLanOrLocal(), cfAccessFlag: document.body.dataset.cfAccess }) === 'token-gate') {
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
      if (!isLanOrLocal() && document.body.dataset.cfAccess === '1' && ++connectErrorCount >= 3) {
        connectErrorCount = 0;
        maybeAccessRelogin();
      }
    }
  });

  // 移动端：切后台/息屏会冻结页面并断开 socket。回前台 / 网络恢复 / bfcache 恢复时主动尽快重连，
  // 不傻等 socket.io 被动超时退避；已连接则 connect() 为 no-op。重连后 connect handler 走 sync:since 补传断线期间事件。
  let _reconnectTimer;
  // opts.persisted 只有 pageshow 传（true=真·bfcache 恢复）。门控判定见 logic 的 shouldAttemptReconnect：
  // 凭据门开着、或 pageshow 的普通加载分支，一律不发起——那种重连必然失败，唯一效果是把服务端的
  // 退避锁越推越长，正是「只错一次却被告知登录尝试过多」的触发源（2026-09-02）。
  // 强制干净重连：disconnect() 经 Manager._destroy → _close 清掉 _reconnecting 与残留的重连定时器、关掉挂住的 engine，
  // 再 connect() 重新握手。只调 socket.connect() 不够——Manager 正在（或卡在）重连中时它什么都不做，而服务暂停又恢复时
  // 那次握手可能挂着要等满 20s 连接超时，「立即重试」点了没反应（验收 O49）。
  function forceReconnect() {
    socket.disconnect();
    socket.connect();
  }
  const reconnectAllowed = (opts = {}) => shouldAttemptReconnect({
    authGateOpen: !!authGate && !authGate.classList.contains('hidden'),
    accessReloginOpen: !!accessRelogin && !accessRelogin.classList.contains('hidden'),
    deviceDeniedOpen: gateIsOpen(deviceDenied),
    persisted: opts?.persisted ?? null,
  });
  function reconnectIfNeeded(opts = {}) {
    if (localReset.isResetting() || !reconnectAllowed(opts)) return;
    clearTimeout(_reconnectTimer);
    _reconnectTimer = setTimeout(() => {
      // 排上之后门可能才关上：拒绝（device_status: denied）赶在这 200ms 之内到达，连接随即被服务端断开——
      // 走到这里照样握手，设备就重新进了待审（#226 review）。执行前再问一次。
      // 重置也一样：确认前排上的这一次活过了 beforeReset，等退订期间握上手就会把要丢弃的 outbox 发出去（#352 review）
      if (localReset.isResetting() || !reconnectAllowed()) return;
      // 半开连接下 socket.connected 会撒谎为 true（见 logic.js foregroundReconnectAction）：connected →
      // probe（带 timeout 的 sync:since 探活+补发，超时即强制干净重连），未连 → connect（connect handler 会 sync）。
      if (foregroundReconnectAction(socket.connected) === 'connect') forceReconnect();
      else {
        requestSync({ probe: true });
        measureRtt(); // 前台唤醒立即刷新延迟（不依赖 5s 周期）
      }
    }, 200);
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') reconnectIfNeeded();
  });
  window.addEventListener('online', () => reconnectIfNeeded());
  // pageshow 在【普通页面加载】时同样触发（persisted=false），不是 bfcache 专属事件——必须把
  // persisted 透出去让门控分辨，否则每次打开页面都会紧贴着 io() 的首次握手再补一枪。
  window.addEventListener('pageshow', e => reconnectIfNeeded({ persisted: !!e?.persisted }));

  // iOS Safari 键盘弹起时给 footer 补 padding 避开键盘（app/keyboard-inset.js）
  const keyboardInset = createKeyboardInset({ logClientEvent, scrollBottom });

  // 当前是否走公网（非 localhost/局域网/隧道内）——公网由 Cloudflare Access 把守、无 token 可输。
  function isLanOrLocal() {
    return isLanOrLocalHostname(location.hostname);
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

  const serviceStatus = createServiceStatus(appContext, {
    $, addBar, appConfirm, closeSheet, el, isLanOrLocal, localReset, notifications, openSheet,
    outboxDeadLetters, outboxInFlight, reopenGeneralAt, requestCwd, rttMonitor, setGestureDismiss, socket,
    wireConfigRefreshButton, getGeneral: () => general, getGeneralNav: () => generalNav,
    getLatestServiceHealth: () => latestServiceHealth, getOfflineQueue: () => offlineQueue,
    setGeneralPushSubscribed: v => { generalPushSubscribed = v; },
  });
  const { emitServiceAck, hideQr, loadPermissionRules, renderHooksBridgeSection, renderPushStatusRow, renderStatuslineBridgeSection } = serviceStatus;

  // 服务与配置面板。表单结构全部由服务端 env:get 下发（src/ops/env-schema.js 是单一事实源）——
  // 前端一个配置项名都不硬编码，加一项只改那一个文件。pickText 按当前语言从 {zh,en} 里挑：
  // 这些文案不进 EN_DICT，否则 i18n-check 会当成孤儿 key 报红（见 env-schema.js 头注）。
  const envConfigPanel = createEnvConfigPanel({
    $, socket, openSheet, closeSheet, appConfirm,
    pickText: (pair) => (getLang() === 'en' ? (pair.en || pair.zh) : pair.zh),
    beforeOpen: () => general.close(), // 先收通用设置，否则它会拦掉本面板上的点击
    // 退出＝退回来源页，不是关到首页（同服务状态面板）。从抽屉告警的「管理工作区」进来的（#301）就直接关掉
    afterClose: from => { if (from !== 'drawer') reopenGeneralAt('behavior'); },
    canRestart: () => _canRestart,
    onSaved: () => {},
  });
  envConfigPanel.bind();
  // #399：把手下拉走 envConfigPanel.close（afterClose 退回设置）
  setGestureDismiss($('envConfigModal'), () => envConfigPanel.close());

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

  // 开发者模式：一键重启 server（按钮仅 DEV_MODE=1 时由 setInstances 显示）。
  const btnRestartServer = $('btnRestartServer');
  if (btnRestartServer) btnRestartServer.onclick = async () => {
    const busyN = instancesList.filter(i => i.state === 'busy' || i.state === 'permission').length;
    const warnLine = busyN ? `⚠️ ${busyN} ${t('个会话在运行/待审批，重启会中断它们（含后台任务）。')}\n\n` : '';
    if (!(await appConfirm({
      title: t('⟳ 重启服务？'),
      body: `${warnLine}${t('服务将优雅退出并由 KeepAlive 自动拉起，页面会自动重连。')}`,
      okText: t('重启'),
      tone: 'danger',
    }))) return;
    haptic('warning');
    // 服务端答应了才说「正在重启」——被拒时先写的那行会和「重启被拒」一起留在消息流里，前后矛盾（O87）。
    // 新进程连上来（startedAt 变了）时由 setInstances 撤掉这一行。
    socket.emit('dev:restart', {}, res => {
      if (res && res.ok === false) {
        addBar(`${t('重启被拒：')}${res.error || t('未知')}`, 'text-danger');
        return;
      }
      const bar = addBar(t('⟳ 正在重启服务…页面将自动重连'), 'text-warning');
      if (bar) bar.dataset.restartPending = '1';
    });
  };

  function showDeniedOverlay() {
    deviceDenied?.classList.remove('hidden');
    clearTimeout(_reconnectTimer); // 已经排上的前台重连作废：只有「重新请求接入」该发起握手
  }
  if (deviceDeniedHelp) deviceDeniedHelp.onclick = showAccessHelp;
  if (deviceDeniedRetry) deviceDeniedRetry.onclick = () => {
    deviceDenied?.classList.add('hidden');
    if (socket.connected) socket.disconnect();
    socket.connect(); // 重新发起 → 重新进入 pending，可信端/终端可再批
    // 相位起点必须跟着重置：被拒期间横幅一直被 deviceDenied 抑制着不显示，但 phaseSince 停在最初
    // 断开那一刻。遮罩一收、抑制解除，横幅会立刻端出「已断开 12 分钟」——而重连其实一秒前才发起。
    connBanner.markDisconnected();
  };

  // 已信任设备渲染待审批设备请求（pending_devices 事件）。点准入/拒绝即发 user:approveDevice/denyDevice。
  // ID/IP/UA 一律用 textContent（UA 攻击者可控），不拼 innerHTML，防 XSS。
  // 待审设备条数：L1 目录「接入与设备」那行的红点判据（唯一会亮红点的一行）。
  let lastPendingDevices = [];
  // init 带来的 MCP 服务器与 skills 数（「宿主机」页渲染用），**按 cwd 归键**。
  //
  // 与 modelsCache / slashCommandsCache 同一条理由：二者都随工作区的 settings/skills 而变，不是
  // 账号级全局量。这里此前是一份全局「最后一次 init」快照，而切到一个**已经 live** 的会话不会
  // 重放 init——于是换工作区之后这一页继续显示上一处的 MCP 服务器与 skills 数。那恰恰是排查
  // 「某个 MCP 没起来」时最要紧的一屏，显示成别处的只会把人带偏。
  // 没有本 cwd 的快照时要渲染成「没有」，而不是留着上一处的——所以读取一律按当前 cwd 现取。
  const mcpServersByCwd = new Map();
  const skillsCountByCwd = new Map();
  function renderDeviceRequests(devices) {
    lastPendingDevices = Array.isArray(devices) ? devices : [];
    generalNav?.render();
    // 「接入与设备」页那条入口与卡片栈同源显隐：判据只有一个（有没有待批），不另存一份。
    // 入口本身不复制审批按钮——它只负责把盖在卡片上的设置面板收走，见 index.html 那段注释。
    renderPendingDevicesEntry();
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
      card.setAttribute('data-short-id', d.shortId || '');
      card.style.boxShadow = 'var(--shadow-pop)';
      const title = document.createElement('div');
      title.className = 'text-sm font-semibold text-ink mb-1.5';
      title.textContent = t('🔔 新设备请求接入');
      const meta = document.createElement('div');
      meta.className = 'text-[11px] text-ink-soft leading-snug mb-2.5 break-all';
      const idLine = document.createElement('div'); idLine.textContent = 'ID：' + (d.shortId || '—');
      const ipLine = document.createElement('div'); ipLine.textContent = 'IP：' + (d.ip || '—');
      const uaLine = document.createElement('div'); uaLine.className = 'text-ink-faint'; uaLine.textContent = d.userAgent || '';
      meta.append(idLine, ipLine, uaLine);
      const btns = document.createElement('div');
      btns.className = 'flex gap-2';
      const approve = document.createElement('button');
      approve.type = 'button';
      approve.className = 'flex-1 py-2 rounded-lg bg-cta text-white active:brightness-95 text-xs font-medium';
      approve.textContent = t('✓ 准入');
      approve.addEventListener('click', () => { socket.emit('user:approveDevice', { shortId: d.shortId }); });
      const deny = document.createElement('button');
      deny.type = 'button';
      deny.className = 'flex-1 py-2 rounded-lg bg-sunk text-ink-soft active:bg-line-soft text-xs font-medium';
      deny.textContent = t('✕ 拒绝');
      deny.addEventListener('click', () => { socket.emit('user:denyDevice', { shortId: d.shortId }); });
      btns.append(approve, deny);
      card.append(title, meta, btns);
      deviceRequests.appendChild(card);
    }
  }

  // 「接入与设备」页的待批入口。**不渲染审批按钮**：点它只做一件事——把设置面板收走，
  // 让 #deviceRequests 那个 z-30 卡片栈重新可见可点。z-30 与 #generalScrim 同层而 DOM 在前，
  // 所以设置开着时它必被盖住，L1 那个红点（全站唯一「点一下就能处理」的记号）就成了空头承诺。
  function renderPendingDevicesEntry() {
    const wrap = $('pendingDevicesEntry');
    if (!wrap) return;
    const n = lastPendingDevices.length;
    if (!n) { wrap.classList.add('hidden'); return; }
    const label = $('pendingDevicesCount');
    // 条数进文案：一台和三台在「要不要现在处理」上是两回事。textContent，不拼 innerHTML。
    if (label) label.textContent = n > 1 ? `${n} ${t('台设备在等你批')}` : t('有设备在等你批');
    wrap.classList.remove('hidden');
  }
  if ($('btnPendingDevices')) {
    // 只收面板、不导航：卡片栈是页面级覆盖层，没有「返回来源页」这回事——批完人就走了。
    // 这也是它与「排查」页那两条日志入口的区别：那两条切去另一张面板，这条是让开一张。
    $('btnPendingDevices').onclick = () => general.close();
  }

  // 已受信任设备列表（设置 › 🖥 宿主机）。载荷里**没有全量 token**，只有 shortId——
  // DEVICE-03：把信任表下发到网络上，等于一台被吊销的设备手里还攥着其余设备的凭据。
  // ua/ip 一律 textContent（UA 攻击者可控），不拼 innerHTML。
  // kind 由服务端算好下发（与 desktop/CCMCore.swift 的 deviceKindLabel 互为镜像）。
  // 这两个是**唯一需要翻译**的取值——iPhone/iPad/Android/Mac/Windows 是专名，各语言相同。
  // 写成显式表而不是 t(d.kind)：后者静态看不见，i18n 的孤儿 key 检查扫不到它们，
  // 于是那两条词典条目会在没人察觉的情况下烂掉（门禁当场就抓到了这一点）。
  const translateDeviceKind = (kind) => (
    kind === '未知设备' ? t('未知设备')
      : kind === '其他设备' ? t('其他设备')
        : (kind || t('未知设备'))
  );

  // 最后一次 trusted_devices 载荷。改名的输入框提交/取消后要重渲染整段，
  // 而那时手里只有闭包里的单条 d——存一份整表比给每个输入框各留一条回滚路径简单。
  let lastTrustedDevices = [];
  let lastTrustedBypass = false;

  function renderTrustedDevices(devices, accessBypassActive = false) {
    lastTrustedDevices = devices;
    lastTrustedBypass = accessBypassActive;
    generalNav?.render(); // L1「接入与设备」那行报的是这张表的条数
    const section = $('trustedDevicesSection');
    const list = $('trustedDevicesList');
    const note = $('trustedDevicesNote');
    if (!section || !list) return;
    list.textContent = '';
    // 脚注按管辖面分档。默认档（CF Access 开着、DEVICE_APPROVAL_SCOPE 未设 all）下这张表
    // 【管不到】经隧道进来的连接，此时还写「吊销后立刻失去访问权」就是在说假话——
    // 用户会照着操作，然后发现设备照常能用（2026-09-10 实录）。
    if (note) {
      note.textContent = accessBypassActive
        ? t('⚠️ 经 Cloudflare Access 进来的连接不查这张表，吊销对它们无效——本表目前只管局域网 / 本机直连。要让它对所有路径生效，把 DEVICE_APPROVAL_SCOPE 设为 all 后重启。')
        : t('吊销后该设备立刻失去访问权，正用设备令牌连着的那条连接会被断开。这不是拉黑，之后仍可重新申请。');
      note.classList.toggle('text-warning', accessBypassActive);
      note.classList.toggle('text-ink-faint', !accessBypassActive);
    }
    // 空列表：没开 CF Access 旁路时不显示整段——一台都没有意味着这台 server 只被本机访问过，摆一个空框只会让人
    // 以为坏了。旁路开着时照样显示（验收 O89）：新部署的 Access 实例正好一台都没有，这时更要看到「这张表管不到
    // 隧道进来的连接」，给一句空态代替空框。
    if (!devices.length) {
      section.classList.toggle('hidden', !accessBypassActive);
      if (accessBypassActive) {
        const empty = document.createElement('div');
        empty.className = 'text-[11px] text-ink-faint px-1';
        empty.setAttribute('data-testid', 'trusted-devices-empty');
        empty.textContent = t('还没有已信任的设备：局域网 / 本机直连批准过的设备会列在这里。');
        list.appendChild(empty);
      }
      return;
    }
    section.classList.remove('hidden');
    for (const d of devices) {
      const row = document.createElement('div');
      row.className = 'p-2.5 rounded-xl border border-line bg-surface text-xs';
      row.setAttribute('data-testid', 'trusted-device-row');
      row.setAttribute('data-short-id', d.shortId || '');

      const head = document.createElement('div');
      head.className = 'flex items-center justify-between gap-2';
      // 名字这一段：别名优先——用户自己下的判断永远比我们从 UA 猜的准。
      // 没别名就拼能拿到的：类型 · 机型 · 浏览器。机型多半拿不到（Chrome 冻结了 UA 的机型位，
      // iOS 从来不给），缺哪段跳哪段，不留悬空分隔符。
      const autoName = [translateDeviceKind(d.kind), d.model, d.browser].filter(Boolean).join(' · ');
      // 名字与短 ID 拆成两段，**不拼成一个字符串**：改名时只换掉名字那一段，短 ID 全程留在行里。
      // 拼成一段的话，一进编辑态整行就不含短 ID 了——而用户正是要靠它认出这是哪台设备。
      const name = document.createElement('div');
      name.className = 'min-w-0 font-semibold text-ink truncate';
      name.setAttribute('data-testid', 'trusted-device-name');
      const nameText = document.createElement('span');
      nameText.textContent = d.alias || autoName;
      const idText = document.createElement('span');
      idText.className = 'text-ink-faint font-normal';
      idText.textContent = ' · ' + (d.shortId || '—');
      name.append(nameText, idText);
      head.appendChild(name);

      // 改名：点 ✎ 就地换成输入框。不弹 sheet——移动端多一层模态只是多一次点击，
      // 而这个操作的全部内容就是敲几个字。Enter / 失焦提交，Esc 放弃。
      const rename = document.createElement('button');
      rename.type = 'button';
      rename.className = 'shrink-0 px-2 py-1 rounded-lg border border-line text-ink-soft active:bg-sunk text-[11px]';
      rename.textContent = '✎';
      rename.title = t('起个名字');
      rename.setAttribute('aria-label', t('起个名字'));
      rename.setAttribute('data-testid', 'trusted-device-rename');
      rename.addEventListener('click', () => {
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'min-w-0 w-32 px-2 py-1 rounded-lg border border-accent bg-surface text-ink text-xs font-normal';
        input.value = d.alias || '';
        input.placeholder = autoName;
        // 限长与后端 MAX_DEVICE_ALIAS 同一口径：按【码点】24 个（后端仍会再归一一次，这里只是省一次往返）。
        // 不用 maxLength：它按 UTF-16 单元计，emoji 占两个，纯 emoji 别名只写得下 12 个（验收 O106）。
        // 输入法组字途中不截——截了会把正在拼的那个字打断，等 compositionend 再截。
        const clampAlias = () => {
          const points = [...input.value];
          if (points.length > 24) input.value = points.slice(0, 24).join('');
        };
        input.addEventListener('input', (e) => { if (!e.isComposing) clampAlias(); });
        input.addEventListener('compositionend', clampAlias);
        input.setAttribute('data-testid', 'trusted-device-alias-input');
        let done = false;
        const commit = (save) => {
          if (done) return;
          done = true;
          if (save) { clampAlias(); socket.emit('user:renameTrustedDevice', { shortId: d.shortId, alias: input.value }); }
          // 不手动还原 DOM：提交后服务端会重播 trusted_devices，整段重渲染；
          // 取消时也重渲染一次，省掉一条只在这里用的回滚路径。
          renderTrustedDevices(lastTrustedDevices, lastTrustedBypass);
        };
        input.addEventListener('keydown', (e) => {
          // 输入法组字中的 Enter 是「确认候选词」，不是提交（#320 review）：同 2036 行令牌门的双检
          if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); commit(true); }
          else if (e.key === 'Escape') { e.preventDefault(); commit(false); }
        });
        input.addEventListener('blur', () => commit(true));
        name.replaceChild(input, nameText); // 只换名字那一段；短 ID 留在原处
        rename.disabled = true;
        input.focus();
        input.select();
      });
      head.appendChild(rename);

      if (d.isCurrent) {
        // 当前这台不给吊销按钮：服务端也会拦（decideRevokeByShortId 的 self 分支），
        // 但让一个点了必然失败的按钮摆在那里本身就是缺陷。
        const badge = document.createElement('span');
        badge.className = 'shrink-0 text-[10px] px-1.5 py-0.5 rounded-full bg-sunk text-ink-soft';
        badge.textContent = t('这台（当前）');
        head.appendChild(badge);
      } else {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'shrink-0 px-2.5 py-1 rounded-lg border border-danger text-danger active:bg-danger/10 text-[11px] font-medium';
        btn.textContent = t('吊销');
        btn.setAttribute('data-testid', 'trusted-device-revoke');
        btn.addEventListener('click', async () => {
          const ok = await appConfirm({
            title: t('吊销这台设备的信任？'),
            body: `${translateDeviceKind(d.kind)} · ${d.shortId}\n${d.ua || ''}`.trim(),
            okText: t('吊销'),
            tone: 'danger',
          });
          if (ok) socket.emit('user:revokeTrustedDevice', { shortId: d.shortId });
        });
        head.appendChild(btn);
      }

      const meta = document.createElement('div');
      meta.className = 'text-[10px] text-ink-faint leading-snug mt-1 break-all';
      // 「多久以前批的」比绝对时间戳更能回答「这台我还在用吗」；没有元数据就如实说没有
      // （本功能上线前批准的条目，UA/IP/时间事后无从补——吊销后重批一次即可补上）。
      const when = d.approvedAt ? formatRelativeApprovedAt(d.approvedAt) : t('无批准记录');
      meta.textContent = [when, d.ip, d.ua].filter(Boolean).join(' · ');
      row.append(head, meta);
      list.appendChild(row);
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
      // 前台任务集合（#459）：按实例存、只画当前查看的那个，所以不经视图过滤
      foreground_tasks: (ev) => foregroundTasks.onEvent(ev),
      // 回退已生效（可能来自本机，也可能来自另一台设备）。走 outOfBand 而非普通 handler：
      // 它是【跨会话】通知，普通分支会因 event.sessionId ≠ currentSessionId 触发 onSessionId
      // 把当前会话身份改掉——用户正看着 A 会话，B 会话的回退不该改写 A 的状态。
      rewind_applied: (ev) => {
        const p = ev?.payload || {};
        // 只有正看着这个会话时才需要说一声。
        if (!ev?.sessionId || ev.sessionId !== displayedSessionId) return;
        const n = Array.isArray(p.filesChanged) ? p.filesChanged.length : 0;
        // 三个模式的成功形态不同，不能只看 forkedSessionId 在不在：
        // 「只恢复代码」本来就不产生新会话，照 forkedSessionId 判会把它误报成创建失败。
        if (p.mode === 'code') {
          addBar(t('已回退 {n} 个文件（对话未改动）').replace('{n}', n), 'text-ink-faint');
        } else if (!p.forkedSessionId) {
          addBar(t('已回退 {n} 个文件，但新会话创建失败').replace('{n}', n), 'text-danger');
        } else if (p.mode === 'conversation') {
          addBar(t('已分叉出回到那一刻的新会话（原会话保留，文件未改动）'), 'text-ink-faint');
        } else {
          addBar(t('已回退 {n} 个文件，并分叉出回到那一刻的新会话（原会话保留）').replace('{n}', n), 'text-ink-faint');
        }
        // 【不重拉这个会话的历史】三个模式都不改它的对话：分叉是复制到新会话（原会话一个字节不动，
        // 见 sessions/rewind-plan.js 头注），只恢复代码根本不碰 transcript。这里原先调 loadHistory 是
        // 原地截断时代留下的，而 loadHistory 只追加不清屏，整段对话会在下面再出现一遍（P0-REWINDo）。
        // 新会话由 instances 广播切过去时照常加载。
        // 不必失效文件预览：附件/文件预览走 browse:read 按需拉取，前端不留缓存（已核实）。
      },
      // outOfBand 不经 handled 分支，相关进度/重试仍刷新 lastEventAt（说明 turn 还活着）
      task_progress: (ev) => {
        // 【底栏权责归位】已经有流内聚合卡的任务，从底栏载荷里摘掉——它的状态、用量、最近工具
        // 全都在卡上，底栏再显示一遍就是同屏复读（2026-09-10 真机实证：卡头写着
        // 「general-purpose 运行中 · 4 tools · 52s · 51.8k tok」，底栏面板同时写着同一份）。
        //
        // 【判据是「有没有流内卡」，不是「是不是后台」】这两个判据看着近似，差别是致命的：
        // 本地 slash 命令（/code-review 等）的子代理整轮零 SDK 流——连 tool_use 都没有，
        // 建不出卡，只能靠底栏被看见。按「非后台就摘」会让它们既不在流里也不在底栏，
        // 复现 2026-08-05 真机那次「只有计时器在转、别的什么都没有」（用户等了 13 分钟按停止）。
        // 那批任务的 taskId 带 localcmd: 前缀、没有 toolUseId，天然不会命中下面这个集合。
        const p = ev.payload || {};
        const anchored = new Set();
        for (const row of Array.isArray(p.tasks) ? p.tasks : []) {
          if (typeof row?.toolUseId === 'string' && subagentCards.has(row.toolUseId)) anchored.add(row.taskId);
        }
        const forBanner = anchored.size
          ? { ...ev, payload: { ...p, tasks: p.tasks.filter(row => !anchored.has(row.taskId)) } }
          : ev;
        const relevant = onTaskProgress(forBanner); // let 可后绑 reconcile 包装
        if (relevant && liveLine) liveLine.lastEventAt = Date.now();
        if (relevant) applySubagentUsage(p); // 用量仍按【全量】挂：被摘的那些正是要挂到卡上的
        return relevant;
      },
      // API 重试：CLI 把整条 spinner 行顶替成 "✻ API error · Retrying in 4s · attempt 2/10"，
      // web 对齐同一语义——写进 liveLine.retry 由 renderLiveLineText 整行顶替。不再走底部横幅：
      // 旧横幅与后台任务/子 agent 争抢同一 DOM（那条横幅已于 2026-09-10 整体退役）。
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
      // 回放事件不得改写 live 行的任何字段：mixed 批次里旧轮的 delta 会把 lastEventAt 推到「刚刚」、
      // 把 sawContentDelta 置真，于是当前这一轮明明已经安静很久，spinner 却不显示等待提示
      // （PR #38 review 第三轮 P2）。
      if (ev?.replay) return;
      liveLine.lastEventAt = Date.now();
      if (ev.type === 'text_delta' || ev.type === 'thinking_delta') liveLine.sawContentDelta = true;
    },
    onEpochReset() {
      approvals.clearAll();
      elicitationSheet.clearAll();
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
    // 超时兜底与 ack 路径同口径：未超阈值 flush；超阈值不在超时点收尾，留给 ack 回调（见 createReplayBuffer
    // 的 armTimeout）。busy 在超时点无法可靠取（可能正是半开连接），按非 busy 处理——ack 回调那时会按
    // 最新的 instances 广播重判。
    // deferMs：ack 自己带 SYNC_ACK_TIMEOUT_MS 的超时、必定回调，这一道只兜回调在 resolve 之前抛了的坏情况。
    deferMs: SYNC_ACK_TIMEOUT_MS + 5_000,
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

  // slash 命令列表的落地点。两条来源共用：init（真 init / 服务端按 cwd 重放的合成 init）与
  // slash_commands（CLI 中途发现新 skill 的全量推送）。两处各写一遍迟早漂，故收在这里。
  // 空数组是有效值——REPLACE 语义下「命令被删光」也要让补全列表跟着空掉。
  // terminalList 缺省时【保留】现有名单而不是清空：commands_changed 那条路带不到它
  // （SDK 的 SlashCommand[] 不含 terminalOriented 标记），清空会让隐藏在每次 skill 变动后失效。
  // 这与 server 侧 slash_commands 分支「沿用上一条 init 的名单」是同一条判据的两端，改一端必须改另一端。
  function applySlashCommands(list, terminalList) {
    if (!Array.isArray(list)) return;
    window.availableSkills = list;
    try { localStorage.setItem('slash_commands', JSON.stringify(list)); } catch { /* quota / 隐私模式 */ }
    if (!Array.isArray(terminalList)) return;
    window.terminalSlashCommands = terminalList;
    try { localStorage.setItem('slash_commands_terminal', JSON.stringify(terminalList)); } catch { /* quota / 隐私模式 */ }
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
    trusted_devices(p) {
      renderTrustedDevices(Array.isArray(p?.devices) ? p.devices : [], p?.accessBypassActive === true);
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
      applySlashCommands(p.slashCommands, p.terminalSlashCommands);
      // MCP 服务器与 skills 数：同 slashCommands 的「缺字段不覆盖」惯例——合成 init（切区重放、
      // 仅校正 model/cwd）不带这两个字段，硬覆盖会把「宿主机」页刷成空。
      // 归键用事件自带的 cwd：切工作区时 init 与 currentCwd 的更新顺序不保证，拿 currentCwd 当键
      // 会把 A 的快照记到 B 名下。缺 cwd（老式合成 init）才回落当前值。
      const initCwd = p?.cwd || currentCwd;
      if (p && Object.prototype.hasOwnProperty.call(p, 'mcpServers')) mcpServersByCwd.set(initCwd, p.mcpServers);
      if (typeof p?.skillsCount === 'number') skillsCountByCwd.set(initCwd, p.skillsCount);
      renderHostEnvSection();
    },
    // CLI 中途发现新命令/skill 的全量推送（SDK 0.3.229 的 commands_changed）。
    // 与 init 分开是因为 server 对 init 有副作用（覆盖 lastInit、算 new_activity），
    // 而这条既不是新会话也不是用户活动——判据见 app/src/agent/agent.js 的同名分支。
    slash_commands(p) {
      applySlashCommands(p?.slashCommands);
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
      // 没指定时 CLI 实际生效的档（只进文案）；缺字段的旧回执一律当未知
      appContext.state.effortEffective = p.effective ?? null;
      // 档位来源：'cli-settings' 按「没指定」显示（O15）；缺字段的旧回执按用户自选显示，与改动前一致
      appContext.state.effortSource = p.source ?? null;
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
      appendSessionLog(p);
    },
    // 诊断时间线（镜像/排队/停止）实时推送：与 session_log 同款 seq:0/epoch:'server' 旁路广播
    diag_log(p) {
      appendDiagLog(p);
    },
    // 可用模型列表由 init 后 fire-and-forget supportedModels() 推送（含重连/重启后的服务端重放）。
    // 原样透传（2026-06-15 / 2026-07-14）：只渲染 CLI/SDK 列表（含 value=default 的 Default recommended），
    // 不再自造「不指定/默认模型」空选项。预选 currentModel；空则选 CLI default。
    models(p) {
      modelsList = Array.isArray(p.models) ? p.models : []; // 存原始候选供 effort 动态渲染
      rebuildEffortOptions(currentModel || cwdDefaultModel); // 列表到达 → 按当前/默认模型刷新 effort
      rebuildCustomModelGrid(modelsList);                    // 刷新自定义设置面板中的模型选择
      if (!modelInput) return;
      // 待发模型必须在清空 options 之前读：清空重建后 select.value 已是新列表首项，
      // 用户点了磁贴、还没发出去的选择会被静默换掉（磁贴只写 value，不写 dataset.fullModel）。
      const pendingSend = (modelInput.dataset.fullModel || modelInput.value || '').trim();
      modelInput.innerHTML = '';
      (p.models || []).forEach(m => {
        const opt = document.createElement('option');
        // 网关映射场景（resolvedModel）优先显真实模型名，而非档位别名 displayName/value（同 syncModelUI）
        if (typeof m === 'string') { opt.value = m; opt.textContent = m; }
        else { opt.value = m.value; opt.textContent = resolveModelDisplayName(m.value, modelsList); }
        modelInput.appendChild(opt);
      });
      // 预选：若用户已选「下一条才生效」的待发模型，保留 modelInput（H2）；
      // 否则 currentModel → CLI default → 空。「是不是用户选的」以 modelIntent 为准（与 resolveOutgoingModel 同一判据）：
      // 没点过时 select 里可能只是落后于 init 的旧在跑模型（网关场景 init 先把 currentModel 换成 opus），不是待发选择。
      const pendingIsIntentional = modelIntent.isPicked() && !!(pendingSend && pendingSend !== 'default' && pendingSend !== (currentModel || ''));
      if (pendingIsIntentional) {
        ensureModelOption(pendingSend);
        modelInput.value = pendingSend;
        rebuildCustomModelGrid(modelsList);
      } else if (currentModel) {
        // 在跑的 wire 已落在某张磁贴上就不再补一张「当前加载模型」（验收 O53）
        if (!modelTileValueFor(currentModel, modelsList, currentGatewaySuffix)) ensureModelOption(currentModel);
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
    text_delta(p, ev) {
      clearLiveRetry(); // 重试已过，流恢复——状态行从重试态回落普通 spinner
      // 子 agent 正文：嵌进可折叠卡（不污染主流气泡）；parentToolUseId = 主 Agent/Task 的 toolUseId
      if (isSubagentPayload(p)) {
        const sa = ensureSubagentCard(p.parentToolUseId, p.subagentType);
        const s = getSubagentStream(sa, p.messageId);
        s.raw += p.text;
        s.textNode.appendData(p.text);
        scrollBottom();
        setBusyFromStreamEvent(ev);
        return;
      }
      const s = getStream(p.messageId, ev?.ts);
      s.raw += p.text;
      // UX-004：流式期间节流全量 renderMarkdown（默认 80ms），避免裸星号/列表源码；result 时 finalize 权威全文
      if (!s._mdTimer) {
        s._mdTimer = setTimeout(() => {
          s._mdTimer = null;
          try { s.el.innerHTML = render(s.raw); } catch { /* 失败保持现状 */ }
          scrollBottom();
        }, formatStreamPreviewIntervalMs());
      }
      setBusyFromStreamEvent(ev);
      // 正文开流 = 本轮 thinking 阶段结束（事件驱动切换，比 idle 超时判定准）
      // !ev?.replay：回放里旧轮的 delta 不得去动当前这一轮的 thinking 态（见 onHandledEvent 的注释）
      if (!ev?.replay && liveLine?.thinking?.state === 'active') {
        liveLine.thinking.state = 'done';
        renderLiveLine();
      }
    },
    thinking_delta(p, ev) {
      clearLiveRetry();
      if (isSubagentPayload(p)) {
        const sa = ensureSubagentCard(p.parentToolUseId, p.subagentType);
        getSubagentThinking(sa, p.messageId).body.appendData(p.text);
        scrollBottom();
        setBusyFromStreamEvent(ev);
        // 子 agent thinking 不计主线 thinking 时长（内容已折叠进子卡，live 行保留主线状态）
        return;
      }
      getThinking(p.messageId).body.appendData(p.text);
      scrollBottom();
      setBusyFromStreamEvent(ev);
      if (!ev?.replay && liveLine) {
        liveLine.thinking = { state: 'active', ...advanceThinkingClock(liveLine.thinking || undefined, Date.now()) };
        renderLiveLine();
      }
    },
    tool_use(p, ev) {
      clearLiveRetry();
      // 工具卡片摘要：formatToolSummary 把紧凑 JSON pretty 成缩进文本，再套 hljs（与预览变更/聊天代码块同源）。
      // pre 用 whitespace-pre-wrap break-words：手机窄屏允许换行，不再强制横向滚一整行。
      // UX-002：收起态标题「工具名 · inputSummary 截断」，扫读不必逐张展开；Task 清单工具特化
      const cardTitle = formatTaskToolTitle(p.name, p.inputSummary) ?? formatToolCardTitle(p.name, p.inputSummary);
      const card = el(`
        <details class="msg-frame toolcard text-xs">
          <summary class="pl-2 pr-1 py-1 flex items-center gap-2 min-w-0">
            <span class="t-status status-icon shrink-0"></span><span class="t-name text-ink-soft truncate">${esc(cardTitle)}</span>
          </summary>
          <div class="pl-2 pr-1 pb-2 space-y-1">
            <pre class="t-in overflow-x-auto whitespace-pre-wrap break-words text-ink-soft"><code></code></pre>
            <pre class="t-out overflow-x-auto whitespace-pre-wrap break-words text-ink-faint hidden"><code></code></pre>
          </div>
        </details>`);
      setStatusIcon(card.querySelector('.t-status'), 'pending');
      card.dataset.toolName = p.name || ''; // tool_result 无 name，结果特化渲染从卡上取
      // 会话 DOM 缓存放回的卡不进 toolCards，要按 id 找卡的（「后台运行」按钮）靠这个属性，见 getToolCard
      if (p.toolUseId) card.dataset.toolUseId = p.toolUseId;
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
          socket.timeout(8000).emit('tool:preview', { instanceId: inst, toolUseId: p.toolUseId }, (err, res) => {
            tbody.replaceChildren();
            if (err || !res?.ok) {  // inWhitelist=false → 红字（安全拒绝），其余灰字（过期/读失败/超时）
              if (err) loaded = false; // 超时不是终态：ack 没回来不代表以后也回不来，得能再点一次重试
              const m = el(`<div class="${res?.inWhitelist === false ? 'text-danger' : 'text-ink-faint'}"></div>`);
              m.textContent = err ? t('请求超时，请重试') : (res?.error || t('预览不可用'));
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
      // 子 agent 内部工具 → 嵌进对应可折叠卡 body；主会话工具仍走主流 appendMessage。
      // 合卡：Agent/Task 的通用工具卡【不入流】——一次 spawn 曾经在屏幕上留两张兄弟卡
      // （「Agent · 描述」+「🤖 类型 运行中」），现在只留聚合卡那一张，槽位见 adoptSpawnCard。
      // Workflow 是有意的例外：它不预建聚合卡（预建会留「🤖 workflow 已完成」空壳），
      // 等首条子流事件才懒建，此刻通用卡已 append 进流、再摘要动已插入的时间分隔行，故不合。
      const isMergedSpawn = !isSubagentPayload(p) && isSpawnToolName(p.name) && p.name !== 'Workflow';
      // show_widget 的图紧跟在工具卡后面；render 返回 null = 退回只有一行工具调用
      const widgetNode = p.widget ? widgets.render(p.widget) : null;
      if (isSubagentPayload(p)) {
        const sa = ensureSubagentCard(p.parentToolUseId, p.subagentType);
        sa.body.appendChild(card);
        if (widgetNode) sa.body.appendChild(widgetNode);
      } else if (!isMergedSpawn) {
        appendMessage(card);
        if (widgetNode) appendMessage(widgetNode);
      }
      scrollBottom();
      setBusyFromStreamEvent(ev);
      // 子代理/Workflow 活动横幅（主会话 spawn 工具；嵌套内部 Agent 不再叠横幅）
      // Agent/Task：预建空卡占位。Workflow 多数阶段只走 task_progress、常无 parent 子流——
      // 预建会留下「🤖 workflow 已完成」空壳（实测观感怪），故等首条 parentToolUseId 事件再建卡。
      if (!isSubagentPayload(p) && isSpawnToolName(p.name)) {
        agentToolIds.add(p.toolUseId);
        if (isMergedSpawn) {
          const subType = extractInput(p.inputSummary, ['subagent_type', 'subagentType'], '');
          adoptSpawnCard(ensureSubagentCard(p.toolUseId, subType || null), p);
        }
      }
      // 对齐 CLI：spinner 行不挂工具后缀（命令由上方工具卡显示）；工具启动只终结 thinking burst
      // !ev?.replay：同 text_delta，回放里旧轮的工具不得终结当前这一轮的 thinking burst
      if (!ev?.replay && liveLine?.thinking?.state === 'active') {
        liveLine.thinking.state = 'done';
        renderLiveLine();
      }
    },
    tool_result(p, ev) {
      // 主会话 Agent/Task 完成 → 对应子 agent 卡标题改「已完成」（键 = toolUseId = 子事件的 parentToolUseId）
      if (!isSubagentPayload(p) && subagentCards.has(p.toolUseId)) {
        markSubagentCardDone(p.toolUseId);
      }
      // 机制 4 错误显性化：子工具真错误累进聚合卡标题的 ❌ 计数。折叠态下嵌套卡的红图标看不见，
      // 而移动端多数时候就是折叠着的——不往上报一层，子代理内部报错在手机上等于隐瞒。
      // 【只数真错误】denyKind 的两档（已拒绝/已取消）是用户自己的动作，他知道，不是异常。
      // 【不染聚合卡的状态图标】那个图标表达的是 Agent 工具【自身】的结果（下方 tool_result 在管）：
      // 一次失败的 Read 不该让整张卡看起来失败了——子代理完全可能照常得出结论。
      if (isSubagentPayload(p) && p.ok === false && !p.denyKind) {
        const sa = subagentCards.get(p.parentToolUseId);
        if (sa) { sa.failures = (sa.failures || 0) + 1; renderSubagentTitle(sa); }
      }
      // 历史里配不上结果的卡，结果可能随后才实时到达（重载期间那一轮跑完了）：live 表里没有就到历史表里找，
      // 否则它会一直停在「进行中」或被收尾判成「已中止」（PR #233 review）。历史卡与 live 卡同构（.t-status / .t-out）。
      const card = toolCards.get(p.toolUseId) || histToolCards.get(p.toolUseId);
      histToolCards.delete(p.toolUseId);
      if (!card) {
        // 无工具卡时仍处理 Agent 横幅（预建了子 agent 卡但 tool 卡可能被清过）
        if (agentToolIds.has(p.toolUseId)) {
          agentToolIds.delete(p.toolUseId);
        }
        return;
      }
      // 审批的 deny+message 通道结果被 SDK 标 is_error（ok:false），真实语义由 denyKind 决定（agent.js）：
      // denied=已拒绝 🚫 / cancelled=已取消 🚫——均非工具报错。AskUserQuestion 的作答 #455 起走 allow，结果本身就是
      // 成功的，按 CLI 文案分已回答 / 没回答（askQuestionResultView，与历史回放同一个判法）；其余按 ok 显 ✅/❌。
      // UI-007：结果态 SVG
      const askView = !p.denyKind && card.dataset.toolName === 'AskUserQuestion'
        ? askQuestionResultView({ ok: p.ok, text: p.outputSummary }) : null;
      const statusKind = askView ? askView.kind
        : (p.denyKind === 'denied' || p.denyKind === 'cancelled') ? 'denied'
        : (p.ok ? 'ok' : 'error');
      setStatusIcon(card.querySelector('.t-status'), statusKind); // 语义色随 kind 一起落，见 setStatusIcon
      if (p.outputSummary) {
        const out = card.querySelector('.t-out');
        // deny 通道正文带 SDK 加的 "Error:" 前缀（非真错误），剥掉只留语义文本
        const raw = askView ? askView.text : p.denyKind ? p.outputSummary.replace(/^Error:\s*/i, '') : p.outputSummary;
        const code = out.querySelector('code') || out;
        // Task 清单工具结果 → ☐/◐/☒ 清单文本（deny/报错走通用路径保留原文）
        const taskText = (!p.denyKind && p.ok) ? renderTaskToolResultText(card.dataset.toolName, raw) : null;
        code.textContent = taskText ?? formatToolSummary(raw, { truncated: p.truncated });
        if (!taskText && code !== out) highlightToolOutput(code);
        if (taskText) card.open = true; // 清单即结果本体，收起就白渲染了（对齐 CLI 面板可见性）
        out.classList.remove('hidden');
        // 截断时挂「展开全文」——点后走 tool:full 取 agent 缓存的完整输出
        // 会话坐标有就带：实例内存里的全文 10 分钟过期，之后服务端回落去 transcript 取（同历史卡片）
        if (isToolSummaryTruncated(raw, { truncated: p.truncated }) && p.toolUseId) {
          attachToolFullExpand(card, p.toolUseId, ev?.sessionId && ev?.cwd ? { sessionId: ev.sessionId, cwd: ev.cwd } : null);
        }
      }
      // 截图：只带引用，卡片展开、格子进入可视区才取图。坐标取信封（发出它的那个实例与会话）
      const shots = transcriptImages.render(p.images, { sessionId: ev?.sessionId, cwd: ev?.cwd, instanceId: ev?.instanceId });
      if (shots) (card.querySelector('.t-out')?.parentElement || card).appendChild(shots);
      toolCards.delete(p.toolUseId);
      // 子代理/Workflow 完成时隐藏活动横幅（仅当所有并行 Agent 都完成才隐藏）
      if (agentToolIds.has(p.toolUseId)) {
        agentToolIds.delete(p.toolUseId);
      }
    },
    // F3：user_message 事件渲染右侧气泡（已入缓冲，多设备/重载均可回放）
    // E17：p.attachments=[{name,mimeType,size,thumb?}]——图片显 thumb（data URI，CSP img-src data: 已许），其他显 📎 chip
    user_message(p, ev) {
      crashNotices.clear(ev?.sessionId); // 崩溃后在这个会话里接着聊了：那条提示翻篇，重载历史不再补
      // 这条消息可能已经由历史全量重载渲染成【正式气泡】了：settleCarriedPendingBubbles 认领时
      // 把 clientMessageId 从乐观气泡移交了过去（见那里的 ★ 注释）。此时屏幕上已经有它，直接收工——
      // 既不能再建一颗（那是第三颗），也不该走下面的转正流程：它早已是确认态，settleAt 会重复打戳。
      // 判据只认 clientMessageId 精确匹配，不做文本兜底：已确认气泡是 markdown 结构、没有
      // .whitespace-pre-wrap，靠文本认反而容易误伤别的消息。
      if (p.clientMessageId && findUserBubbleByClientMessageId(p.clientMessageId, { settledOnly: true })) {
        scrollBottom(true);
        return;
      }
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
        // 离线占位转正：补服务端权威 ts + 补该插的时间行。占位创建时刻意不打客户端 Date.now()
        //（手机时钟若快几小时，那条 data-ts 落在未来，而「ts < prevTs 不插行」的规则排在跨天之前
        // → 之后每条都被判成时间倒流，连日期行都永久消失）。这个分支直接 return、不走 append，
        // 故须在此单独收口；settleAt 会把 marker 插在这条气泡【前面】而不是容器尾部。
        messageTimeline.settleAt(matchedBubble, ev?.ts, 'user');
        // 占位本来就是纯文本（appendUserText），确认时只换成已确认气泡的字体，不再重渲染（验收 O25）
        if (p.text) matchedBubble.classList.add('msg-body', 'um');

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
        // 占位转正时补上服务端权威 uuid（占位创建时还没有 uuid）。
        if (p.uuid && !matchedBubble.dataset.uuid) {
          matchedBubble.dataset.uuid = p.uuid;
        }
        scrollBottom(true);
        return; // 匹配成功，直接返回，避免生成重复聊天气泡
      }

      const bubble = el(`<div class="msg-frame rounded-xl bg-user text-ink px-3 py-2 text-sm" data-testid="user-message"></div>`);
      bubble.dataset.topLevel = '1'; // 未读角标锚点定位用：user_message 在线新建分支（离线占位分支在 send() 创建时已挂，这里走 matchedBubble 复用不重复创建）
      // 排队撤回/标记转正都按 clientMessageId 定位气泡（离线占位分支已挂，此处补齐在线新建分支）
      if (p.clientMessageId) bubble.dataset.clientMessageId = p.clientMessageId;
      // live 气泡从这一刻起就带 uuid。这个 uuid 与 transcript 落盘值逐字相同（2026-09-10 实测），所以刷新前后行为一致。
      if (p.uuid) bubble.dataset.uuid = p.uuid;
      if (p.text) {
        // 与乐观占位、历史路径同一个构建器：纯文本（验收 O25）
        bubble.classList.add('msg-body', 'um');
        appendUserText(bubble, p.text);
      }
      if (Array.isArray(p.attachments) && p.attachments.length) {
        bubble.appendChild(buildAttachmentWrap(p.attachments, Boolean(p.text)));
      }
      if (p.text) appendCopyAction(bubble, () => p.text, 'right');
      if (p.origin === 'auto-continuation') tagAutoContinueBubble(bubble); // 额度墙到点续跑发的，不是用户打的
      messageTimeline.appendWithTime(bubble, ev?.ts, 'user');
      scrollBottom(true);
    },
    permission_request(p, ev) {
      // 幂等：sync:since 切入补发的 pending 快照可能与 buffer 回放的原始事件同 requestId → 只保留一份
      if (approvals.isDuplicatePermission(p.requestId)) return;
      alertCue('need');
      // 信封 instanceId 随队列条目存下，作答路由到所属实例（#388；dispatch 契约第二参）
      approvals.enqueuePermission(p, ev?.instanceId);
      // FE-NEW-002：JSON.stringify(undefined) 为 undefined，.slice 抛错会中断 handler（verify 也不跑）
      // sensitive：正文是工具入参原文（Bash 的 command、Write 的 file_path/content 头部）。
      // 预览开关关闭时 notify 只保留标题，与 Web Push / ntfy 两条通道的隐私口径对齐。
      notify(t('⚠️ 等待审批'), `${p.name}：${safeJsonPreview(p.input, 80)}`, { sensitive: true });
      approvals.verifyPermIntegrity(p); // 异步、不阻塞渲染——完整性协议步骤4，核验结果稍后到达时若仍是当前卡片才提示
    },
    question(p, ev) {
      // 幂等：同上（快照补发 vs buffer 回放去重），按 requestId
      // 含「已本地作答/已收 request_resolved」判定：忽略重放（切会话、probe、整页刷新后的 sync）
      if (approvals.isDuplicateQuestion(p.requestId)) return;
      alertCue('need');
      approvals.enqueueQuestion(p, ev?.instanceId);
      // FE-003：text 可能缺失/非字符串（畸形 AskUserQuestion / SDK 漂移），slice 会抛并中断 handler。
      const qPreview = typeof p.text === 'string' ? p.text : (p.text == null ? '' : String(p.text));
      notify(t('❓ 需要选择'), qPreview.slice(0, 80), { sensitive: true }); // 问题正文同属预览开关管辖
    },
    // MCP 服务器要表单输入或 URL 授权（#460）。去重同提问：快照补发与 buffer 回放可能同 requestId，已结算的不再弹
    elicitation(p, ev) {
      if (elicitationSheet.isDuplicate(p.requestId)) return;
      alertCue('need');
      elicitationSheet.enqueue(p, ev?.instanceId);
      notify(t('🔐 MCP 需要你'), String(p.message ?? '').slice(0, 80), { sensitive: true }); // message 是第三方正文，同属预览开关管辖
    },
    // M4：审批/选题完成后广播，多设备或重放缓冲时关闭陈旧弹窗
    request_resolved(p) {
      const { requestId, kind } = p;
      if (kind === 'permission') {
        // 完整性校验失败是服务端 fail-closed 介入，不是用户的选择——若用户刚点了"允许"，
        // answerPerm() 已乐观显示过"✅ 已允许"（activePerm 早已本地清空，下面的分支找不到它，无从
        // 事后订正）。这里补一条独立提示，避免用户以为操作已生效、实际却被悄悄拦下。
        if (p.outcome === 'integrity_mismatch') {
          addBar(t('⚠️ 完整性校验未通过，该操作已被服务端拒绝执行（并非您的选择生效）'), 'text-danger');
        }
        // 等到 TTL 到期：服务端已按拒绝回给 CLI。此前只是悄悄关卡，用户回来只看到卡片没了，不知道那个操作其实
        // 没执行（验收 O30）。
        if (p.outcome === 'expired') addBar(t('⏱ 这条审批等太久已过期，操作没有执行'), 'text-warning');
        approvals.resolvePermission(requestId);
        updateSendButtonState();
      } else if (kind === 'question') {
        // 同上。多题提问会逐题各发一条（requestId 带 #序号）再发整体那条，只在整体那条上说一次
        if (p.outcome === 'expired' && !String(requestId).includes('#')) addBar(t('⏱ 这个提问等太久已过期，没有作答'), 'text-warning');
        approvals.resolveQuestion(requestId);
        updateSendButtonState();
      } else if (kind === 'elicitation') {
        if (p.outcome === 'expired') addBar(t('⏱ 这个 MCP 请求等太久已过期，已按取消处理'), 'text-warning');
        elicitationSheet.resolve(requestId, p.outcome);
        updateSendButtonState();
      }
    },
    result(p, ev) {
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
      clearBusyFromTurnEndEvent(ev);
      updateSendButtonState();
      // 不在此隐藏后台任务进度横幅：后台任务（Workflow/后台 Agent/Bash）跨轮次存活，轮次 result ≠ 后台完成。
      // 横幅生命周期交给 task_progress（下拍心跳 showTaskProgress 重现）与 task_notification（完成时 hideTaskProgress）自洽驱动。
      // 对齐 CLI：用户主动中止时 SDK 常带 is_error + ede_diagnostic；interrupted 优先，不当红色错误展示。
      const ui = presentTurnResult(p);
      logClientEvent('recv', `[WEB_RECV] ${ui.statusBar.text}`); // send↔recv 对账：turn 结果在客户端到达
      if (ui.failToolsMessage) failPendingToolCards(ui.failToolsMessage);
      agentToolIds.clear(); // 清理 Agent 工具 ID 跟踪
      alertCue(ui.haptic); // success / warning / error：音+震（各自开关门控）
      addBar(ui.statusBar.text, ui.statusBar.cls);
      announceTurn(ui.statusBar.text); // 读屏的回合结束端点（#379）：与状态条同一句
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
      elicitationSheet.clearAll();
      updateSendButtonState();
    },
    error(p, ev) {
      // endsTurn:false = 报个错、轮次照常（socket handler 抛错、轮中切权限档/模型失败）。只打提示，
      // 不走下面那套轮次收尾：清审批、工具卡标失败、熄 busy——服务端那一轮还在等审批（30 分钟 TTL），
      // 清掉了用户就没地方点「允许」了（2026-09-22 review P1）。
      if (p?.endsTurn === false) {
        alertCue('error');
        hideLoadingCard();
        addBar(`⚠️ ${p.message}`, 'text-danger');
        return;
      }
      finalizeStreams();
      const errFileCard = flushTurnFileChangesCard(); // 出错前若已改盘，仍给汇总
      failPendingToolCards(p.message);
      alertCue('error');
      hideLoadingCard(); // resume 失败等路径：避免「正在加载会话…」与红条叠屏
      const errBar = addBar(`⚠️ ${p.message}`, 'text-danger');
      announceTurn(`${t('出错：')}${p.message}`); // 读屏的回合结束端点（#379）
      if (p.processExited) {
        crashNotices.record(ev?.sessionId, p.message, errBar);
        crashNotices.noteInstance(ev?.instanceId, p.message);
      }
      clearBusyFromTurnEndEvent(ev, { unlockSendGate: false });
      if (resolveTurnEndScroll({ hasFileChangesCard: Boolean(errFileCard) }) === 'file-changes' && errFileCard?.isConnected) {
        try { errFileCard.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch { scrollBottom(true); }
      }

      // 防御性清理当前 tab 的挂起提问和审批
      approvals.clearAll();
      elicitationSheet.clearAll();
      updateSendButtonState();
    },
    // M7：改用 kind 字段判断中断，不靠字符串匹配（字符串会随 i18n 变化）
    // 每轮收尾后模型预测的下一句。空文本不显示——模型判断"猜不准"时按提示词要求返回空。
    prompt_suggestion(p) {
      const text = typeof p?.text === 'string' ? p.text.trim() : '';
      if (!text) return;
      showPromptSuggestion(text);
    },
    // 「离开又回来」时模型写的一句摘要（server 侧 presence 触发，见 app.js maybeRecapOnReturn）。
    // 走 addBar 而非新造气泡：它不是对话的一部分，是给屏幕前这个人的提示条，与 interrupted/
    // queue_dropped 那些系统行同一视觉层级。空文本不渲染——模型判断"没什么可摘要的"时会返回空。
    session_recap(p) {
      const text = typeof p?.text === 'string' ? p.text.trim() : '';
      if (!text) return;
      addBar(`${t('回顾')} · ${text}`, 'text-ink-faint');
    },
    system(p, ev) {
      addBar(p.message, systemBarClass(p));
      if (p.kind === 'elicitation_complete') elicitationSheet.complete(p.elicitationId);
      // 中止成功 / 「无可中断任务」失败回执：都必须清 interruptPending（限流重试中点停止的卡死修复）
      if (shouldClearInterruptPendingOnSystem(p)) {
        clearInterruptPending(viewingInstanceId, { keepLiveOverride: p.kind === 'interrupted' });
      }
      if (p.kind === 'interrupted') {
        announceTurn(t('已中止')); // 读屏的回合结束端点（#379）：interrupted 走这里，不发 result
        finalizeStreams();
        // E3：interrupt 成功/settleForce 走 system interrupted 时没有 result，须收口工具卡与子 agent 卡
        failPendingToolCards(t('已中止'));
        markAllSubagentCardsDone();
        clearBusyFromTurnEndEvent(ev); // 中止也是轮次终点：与 result 同样解锁发送闸，不等 instances 广播
        updateSendButtonState();
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
      renderStatusLine(p);
    }
  };

  // 工具输出代码块：先按内容定高亮 class（JSON 才高亮，见 toolOutputHighlightClass），再交给 hljs
  function highlightToolOutput(code) {
    code.className = toolOutputHighlightClass(code.textContent);
    delete code.dataset.highlighted; // 「展开全文」换了内容要重新判，hljs 对已高亮过的元素会跳过
    try { hljs.highlightElement(code); } catch { /* 高亮失败不影响显示 */ }
  }

  // 工具卡「展开全文」：成功后替换 .t-out 并去掉按钮。全文来源由服务端定：live 卡片先查实例内存；带上会话坐标
  // （history = { sessionId, cwd, agentToolUseId? }）时内存没有就回落去 transcript 取——历史卡片只能走这条（验收 O55）。
  function attachToolFullExpand(card, toolUseId, history = null) {
    if (!card || !toolUseId || card.querySelector('[data-testid="tool-expand-full"]')) return;
    // 聚合卡里 .sa-body 也带 space-y-1 且排在结果槽之前，裸 querySelector 会把「展开全文」
    // 塞进子代理流水中间。给结果槽标了 .t-full-host 的卡优先用它；通用工具卡没有这个 class，
    // 回落到原来的 .space-y-1，行为一个字节不变。
    const host = card.querySelector('.t-full-host') || card.querySelector('.space-y-1') || card;
    const btn = el(`<button type="button" class="text-info underline text-[11px]" data-testid="tool-expand-full">${t('展开全文')}</button>`);
    const inst = viewingInstanceId;
    btn.onclick = () => {
      btn.disabled = true;
      btn.textContent = t('加载中…');
      socket.timeout(8000).emit('tool:full', { instanceId: inst, toolUseId, ...(history || {}) }, (err, res) => {
        if (err || !res?.ok) {
          btn.textContent = err ? t('请求超时，请重试') : (res?.error || t('全文不可用'));
          btn.disabled = false;
          return;
        }
        const out = card.querySelector('.t-out');
        const code = out?.querySelector('code') || out;
        if (code) {
          code.textContent = formatToolSummary(res.text || '', { truncated: false }); // 全文不带服务端尾巴：超长另有提示条
          if (code !== out) highlightToolOutput(code);
          out?.classList.remove('hidden');
        }
        if (res.truncated) {
          // 全文超过服务端上限时只回了开头：不说清楚就像已经完整了（PR #250 review）
          const note = el(`<div class="text-ink-faint text-[11px]" data-testid="tool-full-truncated"></div>`);
          note.textContent = `${t('全文过长，只显示了开头')}（${res.totalLength ?? '?'} ${t('字符')}）`;
          btn.replaceWith(note);
        } else {
          btn.remove();
        }
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
  // ts：本轮首个 text_delta 的信封时刻。注意气泡只在这里建一次，所以它的 data-ts 是回合【开头】
  // 而非结束——长回合下用户紧接着跟进时 gap 会算大、比预期更常插行，是已知偏差（见 logic.js 注释）。
  function getStream(id, ts) {
    const key = id || '_';
    let s = streams.get(key);
    if (!s) {
      // UX-004：直接 msg-body 容器，流式走 innerHTML=render，不再用纯文本 textNode 裸显 markdown
      // #379：流式气泡不挂 aria-live——每 ~80ms 全量 innerHTML 重写会让读屏反复重读生长中的消息；定稿后用户可自行浏览。
      const wrap = el(`<div class="msg-frame msg-body px-0.5" data-testid="assistant-message"></div>`);
      wrap.dataset.topLevel = '1'; // 未读角标锚点定位用：仅主链 assistant 流式气泡（子agent走 getSubagentStream，不经过这里）
      messageTimeline.appendWithTime(wrap, ts, 'assistant');
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
      // 正文同步写进气泡，rAF 只管那一下淡入（验收 O59）。上面刚清掉的预览定时器可能一次都没触发过——本地
      // slash 命令（/context、/cost）的输出就是一条增量紧跟着 result——而浏览器对后台标签页暂停 rAF：
      // 正文若也放进 rAF，同一会话开在另一个标签页里的那一端气泡一直是空的，刷新才从磁盘补上。
      s.el.innerHTML = render(s.raw);
      // try 与全文件其余 hljs 调用点一致（2026-08-03 F5）：高亮抛错不该打断复制按钮注入——高亮失败只该丢高亮。
      s.el.querySelectorAll('pre code').forEach(b => { try { hljs.highlightElement(b); } catch { /* 高亮失败不影响显示 */ } });
      injectCodeCopyButtons(s.el);
      appendCopyAction(s.el, () => s.raw, 'left');
      s.el.style.transition = 'opacity .1s';
      s.el.style.opacity = '0.4';
      requestAnimationFrame(() => {
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
        <details class="msg-frame thinking text-xs text-ink-faint">
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
      // 【槽位必须排在 sa-body 之前，别按"先过程后结论"调回去】tool_result 是
      // card.querySelector('.t-out') 取槽的，而 querySelector 是文档序深度优先——
      // 槽位排在 sa-body 之后时，它会先命中【嵌套子工具卡】的同名 .t-out，
      // 于是子代理的最终报告被写进内层某张工具卡里，聚合卡自己的结果槽永远是空的。
      // 顺序也确实更好读：问了什么（t-in）→ 结论（t-out）→ 想深究再展开过程（sa-body）。
      // t-status / t-in / t-out 三个 class 与通用工具卡同名【是有意的】——合卡后 tool_result 靠
      // toolCards.get(toolUseId) 找卡再 querySelector 这三个，同名即可零改动复用那条路径。
      const wrap = el(`
        <details class="msg-frame subagent-card rounded-lg bg-surface border border-line text-xs" data-testid="subagent-card">
          <summary class="px-3 py-2 cursor-pointer select-none">
            <div class="flex items-center gap-2 min-w-0">
              <span class="t-status status-icon shrink-0"></span><span class="sa-title text-ink font-medium truncate"></span>
            </div>
            <div class="sa-lasttool mt-0.5 pl-5 text-ink-faint truncate hidden" data-testid="subagent-last-tool"></div>
          </summary>
          <div class="t-in mx-3 mb-1 text-ink-soft break-words hidden"></div>
          <div class="t-full-host px-3 pb-1 space-y-1">
            <pre class="t-out overflow-x-auto whitespace-pre-wrap break-words text-ink-faint hidden"><code></code></pre>
          </div>
          <div class="sa-body px-3 pb-2 pl-4 border-l-2 border-accent/40 ml-3 space-y-1"></div>
        </details>`);
      wrap.dataset.parentId = parentId;
      const titleEl = wrap.querySelector('.sa-title');
      const type = subagentType != null && String(subagentType).trim() ? String(subagentType).trim() : null;
      c = {
        el: wrap,
        body: wrap.querySelector('.sa-body'),
        titleEl,
        lastToolEl: wrap.querySelector('.sa-lasttool'),
        type,
        running: true,
        failures: 0, // 子工具真错误的累计数（只增不减，见 formatSubagentCardTitle 的判据）
        usage: null, // 由 applySubagentUsage 按 toolUseId 挂上；历史回放取不到（bgTasks 是 live 内存态）
        streams: new Map(),
        thinkings: new Map(),
      };
      renderSubagentTitle(c);
      subagentCards.set(parentId, c);
      appendMessage(wrap);
      scrollBottom();
    } else if (subagentType != null && String(subagentType).trim() && !c.type) {
      // 首批 delta 可能早于带 subagentType 的 assistant：后来补类型标签
      c.type = String(subagentType).trim();
      renderSubagentTitle(c);
    }
    return c;
  }

  // 合卡：把 spawn 工具（Agent/Task）那张通用工具卡的职责接进聚合卡。
  // 【关键是最后一行】把聚合卡注册进 toolCards —— tool_result 的状态图标、结果正文、
  // 截断「展开全文」三条路径全靠 toolCards.get(toolUseId) 取卡，接过来之后那三条一个字节都不用改。
  // 不接的话，合卡就是拿「丢掉子代理最终报告」换「少一张卡」。
  // 标题的三条改写路径（建卡 / 类型晚到补标签 / 标完成）必须共用同一个渲染口——
  // 少带 usage 的那条会把已显示的「· 15 tools · 65.4k tok」在下一次改标题时抹掉。
  function renderSubagentTitle(c) {
    c.titleEl.textContent = formatSubagentCardTitle({
      subagentType: c.type,
      running: c.running,
      failures: c.failures || 0,
      ...(c.usage || {}),
    });
  }

  // 后台任务快照 → 按 toolUseId 把用量与最近工具挂到对应的子代理卡上。
  // 【为什么 join 写在这里而不是 task-status.js】那边管底栏横幅、按 task_id 组织；
  // 卡按 parentToolUseId 组织。两张表唯一的交集就是 payload 里新加的 toolUseId
  // （SDK task_progress.tool_use_id，2026-09-10 接通）。没有它就只能在横幅显示用量。
  function applySubagentUsage(payload) {
    const list = Array.isArray(payload?.tasks) ? payload.tasks : null;
    if (!list) return;
    for (const row of list) {
      const id = typeof row?.toolUseId === 'string' ? row.toolUseId : '';
      if (!id) continue;
      const c = subagentCards.get(id);
      if (!c) continue; // 有用量但没有卡：本地 slash 命令那批（整轮零 SDK 流），它们只活在横幅里
      c.usage = { toolUses: row.toolUses ?? null, totalTokens: row.totalTokens ?? null, durationMs: row.durationMs ?? null };
      renderSubagentTitle(c);
      setSubagentLastTool(c, c.running ? formatSubagentLastToolLine(row) : null);
    }
  }

  // 单行动作槽：折叠态也可见，对齐 CLI 的 lastToolInfo。跑完就撤——留着最后一条工具名
  // 会让已完成的卡看起来还在动。
  function setSubagentLastTool(c, line) {
    if (!c?.lastToolEl) return;
    c.lastToolEl.textContent = line || '';
    c.lastToolEl.classList.toggle('hidden', !line);
  }

  function adoptSpawnCard(sa, p) {
    const wrap = sa.el;
    wrap.dataset.toolName = p.name || ''; // tool_result 无 name，清单工具特化渲染从卡上取（同通用卡）
    if (p.toolUseId) wrap.dataset.toolUseId = p.toolUseId; // 同通用卡
    setStatusIcon(wrap.querySelector('.t-status'), 'pending');
    // 【只显 description，不铺原始输入】通用工具卡在这个槽里放的是整个 input 的 pretty JSON，
    // 合卡后它就挡在展开区门口——含用户刚打的整段 prompt（2026-09-10 真机撞到）。CLI 在同一
    // 位置也只显 description。原文没丢：transcript 里一直都在，需要时从那边看。
    const inEl = wrap.querySelector('.t-in');
    const desc = formatSpawnDescription(p.inputSummary);
    if (inEl && desc) {
      inEl.textContent = desc;
      inEl.classList.remove('hidden');
    }
    toolCards.set(p.toolUseId, wrap);
    return sa;
  }

  function markSubagentCardDone(parentId) {
    const c = subagentCards.get(parentId);
    if (!c || !c.running) return;
    c.running = false;
    renderSubagentTitle(c);
    setSubagentLastTool(c, null); // 终态定格：单行动作槽隐去（同 CLI，跑完不再显示最近工具）
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
        <details class="thinking text-xs text-ink-faint">
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
        if (typeof openWorkspacePanel === 'function' && currentCwd) openWorkspacePanel(panelCwd(), 'changes', worktreeGoneNotice());
      };
    }
    const statsEl = card.querySelector('.tfc-stats');
    statsEl.children[0].textContent = `+${summary.added}`;
    statsEl.children[1].textContent = `-${summary.removed}`;
    const list = card.querySelector('.tfc-list');
    for (const f of summary.files) {
      const row = el(`
        <div class="tfc-row" data-testid="turn-file-row">
          <button type="button" class="tfc-row-btn w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-sunk/60 active:bg-sunk transition-colors" aria-expanded="false">
            <span class="tfc-chevron text-[10px] text-ink-faint shrink-0" aria-hidden="true">▸</span>
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
      const chevron = row.querySelector('.tfc-chevron');
      let loaded = false;
      btn.onclick = () => {
        preview.classList.toggle('hidden');
        const open = !preview.classList.contains('hidden');
        btn.setAttribute('aria-expanded', String(open));
        if (chevron) chevron.textContent = open ? '▾' : '▸';
        if (loaded || !f.toolUseId) return;
        loaded = true;
        socket.timeout(8000).emit('tool:preview', { instanceId: inst, toolUseId: f.toolUseId }, (err, res) => {
          preview.replaceChildren();
          if (err || !res?.ok) {
            if (err) loaded = false; // 超时不是终态，允许再点一次重试
            const m = el(`<div class="${res?.inWhitelist === false ? 'text-danger' : 'text-ink-faint'}"></div>`);
            m.textContent = err ? t('请求超时，请重试') : (res?.error || t('预览不可用'));
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
  // MCP 表单 / URL 授权（#460），见 app/elicitation-sheet.js
  const elicitationSheet = createElicitationSheet(appContext, { $, socket, openSheet, closeSheet });

  // ---- 发送 / 停止 ----

  // 未确认用户气泡（在线乐观 + 离线占位【共用】）。
  // 在线也必须立刻建：user_message 被压在服务端 await 之后，输入框已空、流还空，观感就是没发出去。
  // 靠 clientMessageId 精确认领转正，不会和回推撞成两条。两条路径共用构建器，字段漂开会认领失败。
  // ts 传 null：客户端时钟不可信。转正时由 settleAt 补服务端权威 ts。
  function buildPendingUserBubble({ text, outgoingAttachments, clientMessageId, pendingLabel }) {
    const bubble = el(`<div class="msg-frame rounded-xl bg-user text-ink px-3 py-2 text-sm opacity-70 transition-opacity" data-testid="user-message"></div>`);
    // 未读角标锚点定位用：未确认气泡是「user_message 到达前就存在」的顶层气泡创建点——
    // matchedBubble 命中时原地复用本节点（见 handle.user_message），不会重新创建，故必须在这里打标记。
    bubble.dataset.topLevel = '1';
    // FE-002：clientMessageId + 附件名指纹，供 user_message 回放精确认领（含纯附件无文本）
    bubble.dataset.clientMessageId = clientMessageId;
    if (outgoingAttachments?.length) {
      bubble.dataset.attNames = outgoingAttachments.map(a => a?.name).filter(Boolean).sort().join('\0');
    }
    if (text) appendUserText(bubble, text); // 长指令发出去那刻就折，与已确认气泡一致
    // 待发附件缩略 chip/图片预览：controller items 含完整 data → 点击直开本地预览（无需服务端）
    if (outgoingAttachments?.length) {
      bubble.appendChild(buildAttachmentWrap(attachments.items(), Boolean(text)));
    }
    const indicator = el(`<div class="pending-indicator text-[11px] text-ink-faint mt-1 animate-pulse"></div>`);
    indicator.textContent = pendingLabel;
    bubble.appendChild(indicator);
    messageTimeline.appendWithTime(bubble, null, 'user');
    return bubble;
  }

  // 撤掉一颗未确认气泡：负 ack 判定这条消息【确定没发出去】时调用（decision.dropBubble）。
  // 不撤的话屏幕上会留一颗永远转圈的气泡，用户以为发出去了——比原本「气泡迟迟不出现」更糟。
  //
  // ★ 光 remove() 不够：气泡可能已随 bindView 进了某个会话的 sessionDomCache（切走时把整棵
  // #messages 子树的节点数组存下来，切回时原序 appendChild 复原）。remove() 只摘得掉当前文档里的
  // 那份，缓存数组仍持有引用 —— 切回该会话时它会被原样加回来，表现为「发送失败的消息过一会儿自己
  // 复活，并且永远转圈」。ack 窗口最长 SEND_ACK_TRANSPORT_MS(30s)，这期间切走再切回完全够触发。
  function dropPendingUserBubble(bubble) {
    if (!bubble) return;
    bubble.remove();
    for (const entry of sessionDomCache.values()) {
      const nodes = entry?.nodes;
      if (!Array.isArray(nodes)) continue;
      const i = nodes.indexOf(bubble);
      if (i >= 0) nodes.splice(i, 1);
    }
  }

  // ackDivergence：续接分叉面板上选了「仍然发送」时带上（确认的是哪一段，见 app/resume-divergence.js）
  function send({ ackDivergence } = {}) {
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
    if (approvals.hasPending() || elicitationSheet.hasPending()) {
      addBar(t('请先处理当前审批或选择，再发送新消息'), 'text-info');
      return;
    }
    const rawText = inputEl.value.trim();
    // ultracode 走 SDK Settings.ultracode + xhigh，不再往用户正文塞关键词（透传）
    const text = rawText;
    if (!text && attachments.items().length === 0) return; // E17：纯附件（空文本）也可发
    // /model 前端拦截——TUI 命令不可透传，映射到 F1 模型切换通道（下一条消息经 setModel 生效）。
    // 纯本地操作，置于断线检查之前；若未来 CLI 把 model 纳入 slash_commands 则让位透传。
    // /rewind 前端拦截——同 /model：TUI 命令不可透传（SDK 非交互，出不来那两步选择界面）。
    // 映射到本地的两步面板，最终仍落在 session:rewind:preview / confirm 上。
    if (/^\/rewind(\s|$)/.test(rawText) && !hasSlashCommand(window.availableSkills, 'rewind')) {
      if (!displayedSessionId) { addBar(t('还没有会话可回退'), 'text-info'); return; }
      inputEl.value = '';
      inputEl.dispatchEvent(new Event('input'));
      autosize();
      updateSendButtonState();
      rewindCommand.openPanel(displayedSessionId, drivingCwdOf(displayedInstanceId)); // 驾驶轴，同 requestSessionFork
      return;
    }
    if (/^\/model(\s|$)/.test(rawText) && !hasSlashCommand(window.availableSkills, 'model')) {
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
        modelIntent.markPicked(); // /model 是显式选择，与点磁贴同属发送意图
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
    // 运行中的会话用户没点过模型：原样带回在跑模型，不从磁贴重建（会丢网关后缀，验收 O53 / O26）。
    // 点过或新会话：resolveSendModel pin wire，再按 S5 回贴网关后缀——仅对「不在 supportedModels 候选里的
    // 自设名」(如 /model 手设并剥离了后缀的)；判据同时认 value 与 resolvedModel，只比 value 会让守卫恒失效、
    // 每次选模型都送出 grok-4.5[1m][1m]。
    const model = resolveOutgoingModel({
      running: Boolean(viewingInstanceId),
      picked: modelIntent.isPicked(),
      loadedModel: currentModel ? currentModel + currentGatewaySuffix : '',
      selectValue: modelInput.value,
      fullModel: modelInput.dataset.fullModel || '',
      gatewaySuffix: currentGatewaySuffix,
      modelsList,
    });
    // E17：剥掉本地 _id（非契约字段），data=完整 base64、thumb=小缩略图随消息上传
    const outgoingAttachments = attachments.items().length
      ? attachments.payload()
      : undefined;
    // REL-01：客户端消息 ID——离线重发/网络抖动可能致同一条消息被处理两次，服务端据此去重（message-dedup.js）。
    // 在线/离线两条路径共享同一个 ID（在离线分支判断前生成）。
    const clientMessageId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

    // 「在新 worktree 里开」的意图随第一条消息一起发出（服务端据此懒建）。有实例时不带——
    // 那时按 instanceId 路由，带上去只会让服务端对一个已经在跑的会话重复判断。
    // 【必须在离线分支之前定义】与 clientMessageId 同一个理由：在线与离线两条路径共用同一份意图。
    // 放到在线分支里会让离线入队撞 TDZ——而 ESLint 的 no-undef 查不出这个，症状是离线路径整条炸掉
    // （2026-09-11 实测：三条离线队列 E2E 一起红，而 lint 全绿）。
    const worktreeArgs = viewingInstanceId ? {} : newSessionWorktree.newSessionArgs();
    // 新会话页的标记，在线与离线重放都带：服务端据它开新会话、不回退全局 viewing（验收 O107），
    // 同一页的后续消息按它落回这一页开出的实例；离线队列也靠它分开两个新会话页（见 outboxComposeKey）
    const composeArgs = viewingInstanceId ? {} : { composeId: composePage.id() };

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
      const bubble = buildPendingUserBubble({
        text, outgoingAttachments, clientMessageId,
        pendingLabel: t('🕐 正在等待连接...'),
      });

      enqueueOutbox({
        text,
        model,
        attachments: outgoingAttachments,
        bubbleEl: bubble,
        clientMessageId,
        // REL-01：保存入队时刻的目标，重发时须用这个而非"当下"的 viewingInstanceId/currentCwd——
        // 否则用户离线期间切换了查看的会话，消息会被错发到现在正看着的会话，而非当初想发的那个。
        instanceId: viewingInstanceId,
        cwd: sendCwd(),
        sessionId: sendSessionId(),
        // worktree 意图与 text 同属"入队时刻的快照"：离线期间用户可能取消勾选，
        // 但这条消息当初就是要发往新 worktree 的。序列化白名单见 logic/outbox-send.js。
        ...worktreeArgs,
        ...composeArgs,
      });

      inputEl.value = '';
      // 已发出：清掉该表面缓存的草稿，避免切走切回把已发送内容当草稿恢复。
      // 新会话首发时还没有 sessionId，槽是 `new:<cwd>`——不按同一份判据删就会残留一条
      // 「已经发出去的话」，下次从别处回到这个工作区的新会话页时被当草稿恢复。
      dropDraftForCurrentSurface();
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
    const reqCwd = sendCwd();
    const reqViewingInstanceId = viewingInstanceId;
    // 驾驶轴 cwd 要在发出这一刻取：拒收若在规则 5 置换之后到达，旧实例已不在 instancesList 里，那时现算会回落到
    // 工作区轴（父仓），worktree 会话的分叉就找不到 transcript（reqCwd 是 sendCwd()，看着实例时同样是工作区轴，不能用它）。
    const reqDrivingCwd = drivingCwdOf(reqViewingInstanceId);
    _sendInFlightSessionIds.add(reqSessionId);
    const clearSendInFlight = () => {
      if (!_sendInFlightSessionIds.has(reqSessionId)) return;
      _sendInFlightSessionIds.delete(reqSessionId);
      clearTimeout(sendInFlightTimer);
      updateSendButtonState();
      // 让「正在发送…」立刻切回 spinner，不必等下一次 1s ticker
      if (liveLine) renderLiveLine();
    };
    // 在线乐观气泡：先上屏，不等服务端那串 await（见 buildPendingUserBubble 的注释）。
    // user_message 回推时由 matchedBubble 按 clientMessageId 认领并原地转正，不会变成两个气泡。
    const pendingBubble = buildPendingUserBubble({
      text, outgoingAttachments, clientMessageId,
      pendingLabel: `🕐 ${t('正在发送...')}`,
    });
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
      sessionId: sendSessionId(), // 与 reqViewingInstanceId 同一刻取：本对象在 emit 之前同步建好
      // 交给 outbox 接管这颗气泡：重发期间 processOfflineQueue 会改它的待发文案、撞上在途轮时
      // markOutboxBlocked 会在它上面挂「未发送 + 重发」按钮。不传的话在线 requeue 的消息在屏幕上
      // 就是一颗永远转圈的气泡，用户既看不出它在排队、也没有手动重发的入口。
      bubbleEl: pendingBubble,
      // worktree 意图与 text 同属「发出那一刻的快照」（离线入队那条同理）。漏了它，在线没被确认、
      // 转进 outbox 重发的第一条消息会开在父仓里——勾的「新 worktree」静默失效。
      ...worktreeArgs,
      ...composeArgs,
    };
    const sendInFlightTimer = setTimeout(clearSendInFlight, SEND_ACK_FALLBACK_MS); // 兜底：ack 真丢了也不永久卡死
    // 在线也走 timeout：half-open / 中途断连时 err 回调 → 入 outbox，不再静默丢字。
    // 窗口用 SEND_ACK_TRANSPORT_MS 而非上面那个 UI 兜底：见其声明处的注释（服务端慢路径 ≫ 5s）。
    socket.timeout(SEND_ACK_TRANSPORT_MS).emit(
      'user:message',
      { text, model, attachments: outgoingAttachments, instanceId: reqViewingInstanceId, cwd: reqCwd, clientMessageId, ...worktreeArgs, ...composeArgs, ...(ackDivergence ? { ackDivergence } : {}) },
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
      // 乐观气泡的去留（判据见 presentOnlineSendAck 的 dropBubble 注释）。刻意排在下方 WS-003 迟到
      // 负 ack 守卫【之前】：那道守卫挡的是「作用于当前视图」的副作用（贴错误条、清 busy、回填草稿），
      // 而这颗气泡属于发起时那个会话，与用户此刻在看哪个会话无关——切走了也照样得撤，否则切回时
      // 迎面一颗永远转圈的假消息。
      if (decision.dropBubble) dropPendingUserBubble(pendingBubble);
      if (decision.requeue) {
        // 这次在线投递结局不明（超时，或服务端让重试），同 deliverOutboxItem 的 requeue 记一笔
        pendingBubble.dataset.outboxMaybeSent = '1';
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
      // 续接分叉的拒收只比会话：它常在规则 5 置换之后到达（server 先 dispose 旧实例、resume 新实例并广播，再过闸），
      // 同一会话此时已换了新 instanceId。按实例比对会当成「已切走」——话被撤掉却不回填、面板不出、busy 也不清。
      const sameSurface = decision.divergence
        ? displayedSessionId === reqSessionId
        : displayedInstanceId === reqInstanceId && displayedSessionId === reqSessionId;
      if (!sameSurface) return;
      if (decision.clearBusy) setBusy(false);
      // busy 拒收：服务端说那边有轮在跑——同步锁上发送闸（本端 _turnRunning 可能因广播未到而滞后）
      if (decision.busy) {
        _turnRunning = true;
        updateSendButtonState();
      }
      if (decision.message) addBar(decision.message, decision.busy ? 'text-info' : 'text-danger');
      let restored = false;
      if (decision.restoreDraft && inputEl && !inputEl.value.trim() && attachments.items().length === 0) {
        restored = true;
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
      // 续接会丢掉一段对话（SESSION-04）：话已回到输入框，面板问怎么续。输入框里已有用户新打的字时不弹——
      // 两个选项作用的都是输入框里的话，那不是被拒的这一条。
      if (decision.divergence) {
        if (restored) {
          resumeDivergencePrompt.prompt({ divergence: decision.divergence, sessionId: reqSessionId, cwd: reqDrivingCwd });
        } else {
          addBar(t('续接会丢掉一段对话，这条没有发出去'), 'text-danger');
        }
      }
    });
    updateSendButtonState(); // 立即反映在途态，不等下一次外部驱动的刷新
    // 气泡已在上方本地 append（buildPendingUserBubble），服务端回推的 user_message 只负责认领转正。
    inputEl.value = '';
    // 已发出：清掉该表面缓存的草稿（口径同上面离线入队那处）
    dropDraftForCurrentSurface();
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
  // 移动端回车发送截断修复（2026-07-13 排查）：触屏软键盘没有 Shift+Enter 这个换行
  // 逃生舱，回车恒当发送键会把长消息在换行处截断。软键盘主设备下回车走 textarea 默认换行，发送收窄为
  // 仅走发送按钮；enterkeyhint 同步改 'enter'，避免部分输入法把回车当 action 直接派发而非插入换行符。
  // #386：勿 OR maxTouchPoints——触屏笔记本有触摸硬件但主指针是 fine，物理 Enter 应发送。
  const isTouchDevice = isSoftKeyboardPrimaryDevice({
    pointerCoarse: matchMedia('(pointer: coarse)').matches,
  });
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
  const composerControls = createComposerControls(appContext, {
    $, addBar, addModeBar, appConfirm, autosize, btnSessions,
    closeLeftSidebar: (...args) => closeLeftSidebar(...args), customEffortGrid, customEffortGroup,
    customModelGrid, customPermGrid, effortOwnerModel, effortOwnerWrap, effortRow, effortSelect,
    effortUnsupported, el, ensureModelOption, haptic, hidePromptSuggestion, inputEl, isTouchDevice,
    leftSidebar, modelInput, modelIntent, permModeSelect, pillDefaults, pillEffort, pillEffortText,
    pillModelText, pillPermText, projectsState,
    refreshComposeDefaultsSummary: (...args) => refreshComposeDefaultsSummary(...args), requestCwd, send,
    socket, topContextPill, updateSendButtonState, getComposeReady: () => _composeReady,
    getComposing: () => composing, getCurrentEffort: () => currentEffort,
    getCurrentGatewaySuffix: () => currentGatewaySuffix, getCurrentModel: () => currentModel,
    getCurrentPermMode: () => currentPermMode, getCwdDefaultModel: () => cwdDefaultModel,
    getPanelIsExternal: () => Boolean(instancesList.find(i => i.instanceId === viewingInstanceId)?.externalObserved),
    getMirrorReadonlySid: () => mirrorReadonlySid, getModelsList: () => modelsList,
    getUltracodeArmed: () => ultracodeArmed, getViewingInstanceId: () => viewingInstanceId,
    setCurrentEffort: v => { currentEffort = v; },
    setCurrentGatewaySuffix: v => { currentGatewaySuffix = v; }, setCurrentModel: v => { currentModel = v; },
    setCurrentPermMode: v => { currentPermMode = v; },
    setCurrentSessionIdForCopy: v => { currentSessionIdForCopy = v; },
    setUltracodeArmed: v => { ultracodeArmed = v; },
  });
  const {
    checkAtMention, clearCliUnknownPermissionOption, hints, rebuildCustomModelGrid, rebuildEffortOptions,
    rebuildPermissionModeUi, setEffortMode, setPermMode, syncDefaultsPillTitle, syncModelGridEmptyHint,
    syncModelUI, updateModelAndSuffix, updatePillSession,
  } = composerControls;

  // ---- 输入与附件：状态、读取、预览和 DOM 绑定由独立 controller 管理 ----
  const attachments = createAttachmentController(appContext, {
    addBar,
    createElement: el,
    haptic,
    onChange: updateSendButtonState,
    scheduleInsetResettle: () => keyboardInset.scheduleResettle(),
    // CLI 驾驶只读：拒加附件（否则进 tray 却发不出去）；说明走 showMirrorComposerHint。
    canAdd: () => {
      if (!mirrorReadonlySid) return true;
      showMirrorComposerHint();
      return false;
    },
    isStartScreen: () => messagesEl.classList.contains('empty-start'),
  });
  // E18：气泡附件按需预览——live/历史点击经 browse:read 拉原图，复用托盘灯箱
  const storedPreview = createStoredPreviewLoader(appContext, {
    addBar,
    openPreviewUrl: (name, url) => attachments.openPreviewUrl(name, url),
  });
  // 会话里的图片（工具截图、用户贴图）：引用 → 缩略图，经 image:get 按需取，点开复用同一个灯箱
  const transcriptImages = createTranscriptImages(appContext, {
    createElement: el,
    openPreviewUrl: (name, url) => attachments.openPreviewUrl(name, url),
  });
  // 桌面端 show_widget 图表：SVG 当图片插在工具卡后面，点开复用同一个灯箱（live / 历史两路共用）
  const widgets = createWidgetRenderer({
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
      blockedByUserRequest: approvals.hasPending() || elicitationSheet.hasPending(),
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
    // 视觉 "/ · @" 仍 aria-hidden（碎读无益）；空聚焦时把可发现性写进 textarea aria-description（#370）。
    // 不走 aria-live：聚焦/失焦各改一次即可，避免与 #379 的刷屏顾虑冲突。
    hint.setAttribute('aria-hidden', 'true');
    const desc = resolveComposerDiscoverAriaDescription({ show });
    if (desc) inputEl.setAttribute('aria-description', desc);
    else inputEl.removeAttribute('aria-description');
  }

  // 下一步建议条：每轮收尾后 server 推来一条（prompt_suggestion），点一下把整句填进输入框。
  // **只填不发**——建议是猜的，用户几乎总要改一两个词；自动发送会把"猜错"变成"替我做错事"。
  // 填完聚焦并派发 input 事件，让 autosize / 发送钮态 / slash 提示这些既有联动照常跑。
  function hidePromptSuggestion() {
    $('promptSuggestion')?.classList.add('hidden');
  }
  function showPromptSuggestion(text) {
    const box = $('promptSuggestion'), btn = $('promptSuggestionBtn'), body = $('promptSuggestionText');
    if (!box || !btn || !body) return;
    // 镜像只读态下输入框根本不能打字，给了也用不了；有草稿时也不打扰（用户已经在写自己的了）。
    // 屏幕正在滚时同样不给：这条是对【上一轮】说的。server 侧 maybeSuggest 有 pendingTurns 闸，但它
    // 挡不住「askSide 先返回、用户那条消息随后才到」的窗口——放行的建议会落到一块已经在跑的屏幕上，
    // 且此刻输入框恰好刚被 send() 清空，下面那道草稿闸也拦不住。判据与 setBusy 那处 hide 同源。
    if (mirrorReadonlySid || _busyState || inputEl?.value.trim()) return;
    // 只写正文那个 span：按钮里还有一行静态标签，写 btn.textContent 会把标签一起冲掉。
    body.textContent = text;
    btn.title = text; // 长句被 truncate 截掉时，长按/悬停仍能看全
    box.classList.remove('hidden');
  }
  $('promptSuggestionBtn')?.addEventListener('click', () => {
    // ★ 读正文 span，不是整个按钮：按钮里含一行静态标签（「猜你接下来想发 · 点一下填进输入框」），
    // 读 btn.textContent 会把那句提示一起塞进输入框。
    const text = $('promptSuggestionText')?.textContent || '';
    hidePromptSuggestion();
    if (!text || !inputEl) return;
    haptic('tap');
    inputEl.value = text;
    inputEl.focus();
    inputEl.dispatchEvent(new Event('input'));
  });
  // 关掉 ≠ 采纳：只收起，不碰输入框。没有这个出口时，用户想赶走一条不想要的建议只剩打字或切会话。
  $('promptSuggestionClose')?.addEventListener('click', () => {
    haptic('tap');
    hidePromptSuggestion();
  });

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
      if (instanceId === viewingInstanceId) {
        const msg = t('停止请求超时，可再试一次');
        addBar(msg, 'text-ink-faint');
        // #371：审批/提问浮层开着时，超时原因写进浮层（addBar 会被 z-40 挡住）
        approvals.surfaceError(msg);
      }
    }, INTERRUPT_PENDING_TIMEOUT_MS);
    socket.emit('user:interrupt', { instanceId }); // 台阶3：中断当前查看 tab 的在途任务
    // 停止 = 不想接着跑：这个会话排着的离线条目不再自动发，退回手动「重发」（O66）
    outboxAfterTurn.cancelTarget({ instanceId, sessionId: instancesList.find(x => x.instanceId === instanceId)?.sessionId ?? null });
  }

  if (btnStop) btnStop.onclick = requestInterrupt;

  // ---- 工作目录切换（台阶1：多目录单并发）----
  // basename：路径太长，目录切换器/顶部胶囊只显末段，title 挂全路径兜底重名
  // 工作区展示名：子文件夹是「根 › 相对路径」、scratch 目录是「无文件夹」，其余取末段（见 projects-state）
  const baseName = c => projectsState.labelFor(c);

  // 切 tab：静默把顶部面板（权限档/思考强度/模型 select）同步到目标实例的档。上下文恢复显示、
  // 非用户主动切档 → silent=true 不上屏系统条。model 先于 effort（effort 档位按当前模型 rebuildEffortOptions
  // 渲染）；空 model 跳过、不清空 select。先于 bindView 的 sync:since 回放执行——回放若含
  // init/permission_mode/effort_mode，因值已一致不会重复上屏。
  function adoptPanelState(inst) {
    if (!inst) return; // 新会话尚无实例（viewingInstanceId=null）：保持现状不乱跳
    // 始终更新模型显示——即使 inst.model 为 null/空也清掉旧值，防切换工作区时上个区的模型名泄漏
    if (inst.externalObserved) {
      modelIntent.reset();
      mirrorObservedCli = inst.externalObserved;
      renderCliPanelState();
      return;
    }
    const rawModel = inst.model || '';
    updateModelAndSuffix(rawModel);
    const effortModelValue = rawModel || currentModel;
    if (modelInput) {
      modelIntent.reset(); // 换了会话：上一个会话里点过的模型不是这一个的发送意图
      if (inst.model) {
        if (!modelTileValueFor(currentModel, modelsList, currentGatewaySuffix)) ensureModelOption(currentModel);
        modelInput.value = currentModel;
        rebuildEffortOptions(effortModelValue, { silentClear: true });
      } else {
        modelInput.value = '';
      }
      syncModelUI(currentModel);
    }
    setPermMode(inst.permissionMode || 'default', true);
    appContext.state.effortEffective = inst.effortEffective ?? null;
    appContext.state.effortSource = inst.effortSource ?? null;
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
      tile.setAttribute('aria-pressed', 'false'); // CLI 模式未知：读屏也不能说某一张选中（#403）
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
        if (!modelTileValueFor(currentModel, modelsList, currentGatewaySuffix)) ensureModelOption(currentModel, t('CLI 当前模型'));
        modelInput.value = currentModel;
        // 兜底卡是在上面 updateModelAndSuffix → syncModelUI 之后才插进来的：再同步一次，它的选中态（含 aria-pressed）才对（#246 review）
        syncModelUI(currentModel);
      } else {
        modelInput.value = '';
        if (pillModelText) pillModelText.textContent = t('CLI 模型未知');
        syncDefaultsPillTitle();
        customModelGrid?.querySelectorAll('.model-tile').forEach(tile => {
          tile.setAttribute('aria-pressed', 'false'); // 界面说不知道，读屏也不能说某一张选中（#246 review）
          tile.classList.remove('ring-1', 'ring-accent', 'border-accent', 'text-accent', 'bg-accent-wash/30');
          const title = tile.querySelector('.text-xs');
          title?.classList.remove('text-accent');
          title?.classList.add('text-ink');
        });
      }
    }
    renderCliPermissionMode(panel.permissionMode);
    if (pillDefaults) pillDefaults.title = t('外部会话的最近记录；续接后由实际进程确认设置');
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
    // silentClear：这里跑的时候 mirrorReadonlySid 已经在 applyMirror 里被置回 null（赋值发生在
    // 三个分支判断之前），若恢复出的模型恰好不支持 effort 又留着非空 currentEffort，不加这个参数
    // 会像 applyMirror 第三分支同款那样误发 user:setEffort({level:null})，把实例档位误清回 auto。
    rebuildEffortOptions(saved.selectedModel || currentModel || cwdDefaultModel, { silentClear: true });
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
      // 深链尤其需要落地页：从推送点进来时用户对"当前在哪个会话"毫无预期，一条落在别处的红字
      // 会被读成"我点开的这个会话出错了"；ack 迟迟不来同样不能让用户干等——同其它 4 处
      // session:switch 入口一样补 4s 兜底（不把反馈压在 ack 上）。
      let acked = false;
      const blocked = message => showSessionBlockedSurface({
        sessionId: r.sessionId, cwd: r.cwd,
        // 签名是具名参数（sessionsCache + instances 两条来源），位置参数会静默返回空标题
        title: lookupNotifySessionTitle({ sessionId: r.sessionId, cwd: r.cwd, sessionsCache, instances: instancesList }),
        message,
      });
      socket.emit('session:switch', { sessionId: r.sessionId, cwd: r.cwd }, res => {
        acked = true;
        if (!res?.ok) blocked(res?.error || t('深链目标会话已不可用'));
        // ack 迟于 4s 兜底时落地页已经弹出来了，但这次切换其实成功了——撤掉它，
        // 否则用户人在目标会话里、屏幕上却盖着一张「切换无响应」。
        else dismissBlockedSurfaceIfTarget(r.sessionId, r.cwd);
      });
      setTimeout(() => { if (!acked) blocked(t('切换无响应，请刷新页面后重试')); }, 4000);
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

  let _canRestart = false; // 由 instances 广播维护，供配置面板判断能否就地重启

  function setInstances(p) {
    projectsState.set(p);
    availableDirs = projectsState.keys();
    syncDashNoFolders(); // 首页开着时连上/断开了文件夹：引导跟着广播走，不等下次重画首页
    const prevInstances = instancesList;
    instancesList = Array.isArray(p?.instances) ? p.instances : [];
    outboxAfterTurn.tick(); // 排队的离线条目：目标会话这一轮结束了就续发下一条（O66）
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
    // 本区 settings 禁用了 auto（#461）：变了才重建权限档面板（Auto 置灰并换成原因），先于下面的 setPermMode。
    const autoModeDisabled = p?.autoModeDisabled === true;
    if (autoModeDisabled !== (appContext.state.autoModeDisabled === true)) {
      appContext.state.autoModeDisabled = autoModeDisabled;
      rebuildPermissionModeUi();
    }
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
    // 重启已兑现：撤掉「⟳ 正在重启服务…」那一行，否则它一直挂着、像还没重启完（O87）。
    const restartBars = serverRestarted ? [...messagesEl.querySelectorAll('[data-restart-pending]')] : [];
    restartBars.forEach(node => node.remove());
    // 清除④：freshInterrupted 标记的实例从 instances 列表消失（关闭/退出/别处清理），待续档态随之作废。
    if (freshInterruptedInstanceId && !currIds.has(freshInterruptedInstanceId)) {
      freshInterruptedInstanceId = null;
    }
    const newStates = aggregateStates(instancesList, availableDirs); // per-cwd 聚合（permission>busy>done>idle）
    const newViewing = p?.viewingInstanceId ?? null;
    const oldViewed = prevInstances.find(x => x.instanceId === newViewing);
    const nextViewed = instancesList.find(x => x.instanceId === newViewing);
    const recordLocationChanged = Boolean(oldViewed && nextViewed)
      && (oldViewed.transcriptCwd || oldViewed.cwd) !== (nextViewed.transcriptCwd || nextViewed.cwd);
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
    // 新会话页停在的文件夹被断开（本机或别的设备）→ 服务端把它归位到别处（O119）：记下从哪来，新会话页重画时说一句。
    // 只在原来就在新会话页上、旧目录确实已不在任何已连接的文件夹（p.dirs）之下时算——用户自己换文件夹不提示。
    // 不看展示用的项目清单：「无文件夹」只在用着时、子文件夹只在有会话时才占一节，换走就不在了，那不是被断开
    // （#330 review P2）。「无文件夹」本来就不是连接来的，单独排除。必须在 currentCwd 覆写之前取。
    // 「在新会话页上」认 _composeReady，不认 DOM 里有没有 compose-surface：在新会话页上断线发的首条会先挂一个
    // 等待气泡、把表面顶掉，可这一页仍是新会话页——重连时被归位，那句「已断开」正是这时最要紧（O128）。
    const connectedRoots = Array.isArray(p?.dirs) ? p.dirs : [];
    const composeRelocatedFrom = !viewingInstanceId && !newViewing && cwdChanged && currentCwd && _composeReady
      && !connectedRoots.some(root => isPathWithin(currentCwd, root)) && !projectsState.isNoFolder(currentCwd)
      ? currentCwd : null;
    currentCwd = newCwd;
    composeCwd = !newViewing && typeof p?.composeCwd === 'string' ? p.composeCwd : null;
    const viewingChanged = viewingInstanceId !== newViewing;
    viewingInstanceId = newViewing;
    foregroundTasks.render(); // 「转后台」只跟着当前查看的实例
    cwdSeen = true;
    // 「宿主机」页开着时查看的会话换了（含别的设备切走）：MCP 卡片立刻按新会话重画（先退回快照、不留旧按钮），再现查（#457 review）
    if (viewingChanged && generalNav?.currentPage() === 'host') { renderHostEnvSection(); hostMcp.refresh(); }
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
    // 额度墙自动继续横幅：按当前查看会话的 sessionId 取条目。字段缺失（mock 的旧式内联载荷）时模块内保留上一份。
    autoContinueBanner.update({ entries: p?.autoContinue, sessionId: viewedInst?.sessionId || null });

    // 顶栏主 pill：标题优先 / 无则工作区；title 挂 cwd 供长按辨认
    syncTopContextLabel();
    // pillWorkspace（📁 状态 pill）显当前工作区名——该 pill 是工作区入口，显 model 名是名实错配（2026-06-21）
    if ($('pillWorkspaceText')) $('pillWorkspaceText').textContent = baseName(currentCwd);
    // 开发者模式：DEV_MODE=1 时显示齿轮面板「重启服务」组（生产默认隐藏，防误触重启对外服务）
    const devGroup = $('devModeGroup');
    if (devGroup) devGroup.classList.toggle('hidden', !p?.devMode);
    // canRestart 与 devMode 是两维：devMode 管上面这个常驻按钮组，canRestart 管配置面板
    // 保存成功后要不要给「立即重启」入口（生产 DEV_MODE=0 但被 launchd 托管时应为 true）。
    _canRestart = p?.canRestart === true;
    // 开发者模式下拉不起来（前台 npm start、容器里没有托管）时按钮照样显示，但点了服务端只会拒绝——
    // 不给点，并当场说明原因（与配置面板不给「立即重启」同一判据）。
    if (btnRestartServer) {
      btnRestartServer.disabled = !_canRestart;
      btnRestartServer.textContent = _canRestart
        ? t('⟳ 重启服务（改代码/配置后生效）')
        : t('⟳ 重启服务：本进程不是常驻托管，停了不会自动拉起，请到电脑上重启');
    }
    // 短 session_id 状态胶囊：显示当前查看会话的前 8 位；无 id 时收起胶囊并就地说明缺席原因。
    // 两个空态参数在此处求值：实例懒开于首条消息，故「有 newViewing 却无 sid」＝id 分配在途；
    // _pendingFirstSend 覆盖空首页首发到懒开广播回来之间那一瞬（此时 newViewing 仍是 null）。
    // 必须读本行上方尚未被 4122 消费掉的 _pendingFirstSend，顺序不可与 bindView 分支对调。
    updatePillSession(instancesList.find(x => x.instanceId === newViewing)?.sessionId || null, {
      viewingInstanceId: newViewing,
      pendingFirstSend: _pendingFirstSend,
      // 首轮被中断的全新会话：实例还在但那轮作废了，没有 id 在路上（同 5886 处的算法）
      freshInterrupted: Boolean(newViewing) && newViewing === freshInterruptedInstanceId,
    });
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
    if (newViewing !== displayedInstanceId || startScreenCwdChanged || recordLocationChanged) {
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
      // 进程异常退出：带 processExited 的 error 先到、已按实例（与会话）记下原因（SIGKILL 等），中断面当场写出来（验收 O121）。
      // 按实例记：进程可能在 init 之前就退出，那时还没有会话 id（#329 review P2）。
      // 刚切过来 / 重连时那条 error 可能还排在回放缓冲里，接下来的 bindView 会把队列丢掉，先收下来（见 adoptQueued）。
      const destroyedInstanceId = instanceDestroyed && !destroyedByRestart ? displayedInstanceId : null;
      const destroyedSid = destroyedInstanceId
        ? prevInstances.find(x => x.instanceId === destroyedInstanceId)?.sessionId : null;
      if (destroyedInstanceId) {
        crashNotices.adoptQueued({ instanceId: destroyedInstanceId, sessionId: destroyedSid, queued: replayBuffer.queued(destroyedInstanceId) });
      }
      const destroyedReason = destroyedInstanceId ? crashNotices.reasonFor(destroyedInstanceId) : null;
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
        appContext.state.effortSource = p.defaultEffortSource ?? null;
        setEffortMode(p.defaultEffort ?? null, true);
      }
      bindView(target, newViewing, { instanceDestroyed, destroyedByRestart, destroyedResume, destroyedReason, composeRelocatedFrom, forceHistoryReload: recordLocationChanged }); // 空表面→home dashboard / compose 新会话页 / destroyed 中断提示
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
    } else if (newViewing && displayedInstanceId === newViewing && !displayedSessionId && !sessionIdClearedByNav) {
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
      appContext.state.effortSource = p.defaultEffortSource ?? null;
      setEffortMode(p.defaultEffort ?? null, true);
      // compose 页默认档摘要跟 pill 同源；L3 到齐后就地刷新，避免仍显 L4 硬默认。
      if (_composeReady) refreshComposeDefaultsSummary();
      // 在首页 / 新会话页点的重启：addBar 插那一行时清掉了空态表面，而这条路不进 bindView——
      // 撤掉那一行后主区若已空，把空态表面还回来，否则一片空白直到用户手动切走。
      if (restartBars.length && !messagesEl.children.length) ensureEmptySurface();
    }
    // 视图未变的广播：server 权威 busy 单向对齐（reload 误擦兜底 + 多设备同视图静默窗口）。
    // 只置 true；释放交给 live result（见 shouldBindBusyFromBroadcast 注释）。
    if (newViewing && newViewing === displayedInstanceId) {
      // 权威快照的解释统一走 resolveRunStateFromSnapshot（logic/outbox-send.js）——它同时是
      // bindView 播种、回放对账、ticker 自检用的那一份，四处不再各写一遍。
      if (resolveRunStateFromSnapshot(viewedInst)?.busy) {
        setBusy(true);
      } else if (shouldClearBusyBySnapshot({
        live: viewedInst,
        localBusy: _busyState,
        turnStartTs: liveLine?.turnStartTs ?? null,
        now: Date.now(),
      })) {
        // 看门狗：终止事件丢了才会走到这——正常轮次权威快照全程说「在跑」，这个分支不触发。
        // 善后与 ticker 自检共用 forceClearBusyByAuthority：此前这里只 setBusy(false)，把乐观
        // marker 留在了原地（见该函数注释，第八轮 P2）。
        forceClearBusyByAuthority(viewedInst);
      }
    }
    if (nextViewed?.externalObserved && newViewing === displayedInstanceId && !mirrorReadonlySid) {
      mirrorObservedCli = nextViewed.externalObserved;
      renderCliPanelState();
    }
    updateSessionsDot();
    updateServiceNotice(p?.service ?? null); // 服务健康与实例结构无关，无条件每次广播都刷新（不进下方判定分支）
    // P3 性能优化（两层判定，故意不合并——关注点不同）：
    // ① 结构性变化（目录集合本身变化 / viewingInstanceId 变化 / 当前查看 cwd 变化——三者共同决定
    //   dirRow 高亮与自动展开）仍走全量重建：低频、全量更简单可靠，不做精细化 diff。
    // ② 其余情况按目录分键 diff（见 logic.js buildDirInstanceSignatures/diffDirSignatures：id/sessionId/
    //   title 前20字），只重建签名真变化的目录子树，未涉及目录的 DOM 原样不动（不撤离滚动位置/侧滑态/
    //   "显示更多"展开态）——避免重连等场景下无关工作区被连坐重建（P3 抽屉局部重建）。
    // 状态（busy/idle/permission/error）不进任何一层——由更新后的 workdirStates 驱动 refreshDirBadges
    // 实时刷新角标。expandedDirs 变化由 toggleBtn.onclick 直接调 populateSubtree，不经此路径。
    const _structuralKey = dirPanelStructuralKey({ dirs: availableDirs, viewingInstanceId, currentCwd });
    const _structuralChanged = _structuralKey !== _lastPanelStructKey;
    _lastPanelStructKey = _structuralKey;
    const _dirOrderKey = availableDirs.join('|');
    const _orderChanged = !_structuralChanged && _dirOrderKey !== _lastDirOrderKey;
    _lastDirOrderKey = _dirOrderKey;
    const _nextDirSignatures = buildDirInstanceSignatures(instancesList, availableDirs);
    const _changedDirs = diffDirSignatures(_lastDirSignatures, _nextDirSignatures);
    _lastDirSignatures = _nextDirSignatures;
    const isDesktop = window.innerWidth >= 1024;
    const isPanelOpen = leftSidebar && !leftSidebar.classList.contains('-translate-x-full');
    if (isDesktop || isPanelOpen) {
      if (_structuralChanged) {
        openSessionPanel(); // 内含 needsYou/service 区 + 工作区树全量重建，此路径不必再单独 refresh*
      } else if (_orderChanged) {
        reorderDirSections(availableDirs); // 纯换序：只挪 DOM 位置，不碰 expandedDirs/不强制展开
        refreshDirBadges();
        refreshSessionStatusChips();
        refreshNeedsYou();
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
    updateAttentionSignal(); // 顶栏会话按钮角标：断开 / 需要你（服务健康留在抽屉，不混进这条）
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
  // 切入会话、渲染稳定后的汇合点（keep / load / reload / 超时 / 重连补同步各分支都在这时调用）：
  // 先放未读胶囊（锚点按此刻的气泡算），再交还暂存的永久拒收条目——它们写的提示条排在锚点之后。
  function showUnreadPillIfAny(count) {
    placeUnreadPill(count);
    deliverOutboxDeadLetters();
  }
  function placeUnreadPill(count) {
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

  // ---- 回到最新（#376）：上翻离开底部时出现；状态在 app/scroll-to-bottom.js，不散落顶层 let ----
  // 与未读胶囊分层：不 emit user:ackUnread、不改应用图标角标；定位相对 #composerFooter 顶边。
  const scrollToBottomBtn = $('scrollToBottomBtn');
  const scrollToBottomLabel = $('scrollToBottomLabel');
  const composerFooterForScrollBtn = $('composerFooter');
  const scrollToBottom = createScrollToBottomController({
    buttonEl: scrollToBottomBtn,
    labelEl: scrollToBottomLabel,
    messagesEl,
    composerFooterEl: composerFooterForScrollBtn,
    countTopLevel: () => topLevelBubbles().length,
    onJump: () => { haptic('tap'); scrollBottom(true); },
    isProgrammaticScroll: () => Date.now() < programmaticScrollUntil,
    // 空首页 / composer 隐藏时不露这颗钮（没有消息流可贴底）。
    isEnabled: () => Boolean(composerFooterForScrollBtn)
      && !composerFooterForScrollBtn.classList.contains('hidden')
      && !messagesEl.classList.contains('empty-start'),
  });

  // aggregateStates 已抽到 logic.js（顶部 import）。
  // 切视图到指定实例（台阶3）：清视图 → sync 活缓冲（重建在途流 + 挂起审批弹窗）→ 无缓冲回退 history。
  // entry 缺失/无 sessionId（新会话尚未 init）= 空白，事件流入自然渲染。
  // 未发送草稿（文字+附件）按 draftKeyFor 的槽存/取（有 sessionId 用它，新会话页用 `new:<cwd>`）。
  // bindView（收到广播后的真实切换）与 btnNew（同步本地重置）共用这一份：两处分头实现必然漂，
  // 而 btnNew 漏做这一步正是 2026-09-18「在新会话页打的字被清空、还被归档进旧会话草稿」的成因。
  // draft 由调用方传快照而不是这里现读 inputEl：bindView 是在 clearView 之前取的值。
  // forceSwap：用户显式发起的新建（btnNew / 目录行＋）。keep 判据挡的是 instances 广播，
  // 不该把用户自己点的导航也挡掉——否则「已经在新会话页时再按新建」会带着上一页的草稿。
  function applySessionDraftSwap(prevSessionId, newSessionId, draft, { forceSwap = false, prevCwd = null, newCwd = null } = {}) {
    const plan = planSessionDraftSwap({
      prevSessionId,
      newSessionId,
      prevCwd,
      newCwd,
      currentDraft: draft?.text ?? '',
      currentAttachments: draft?.attachments ?? [],
      drafts: sessionDraftCache,
      forceSwap,
    });
    if (plan.action !== 'swap') return;
    if (plan.discard) sessionDraftCache.delete(plan.discard);
    if (plan.save) {
      sessionDraftCache.set(plan.save.key, {
        text: plan.save.text,
        attachments: plan.save.attachments,
      });
      if (sessionDraftCache.size > 40) {
        const oldestKey = sessionDraftCache.keys().next().value;
        sessionDraftCache.delete(oldestKey);
      }
    }
    if (inputEl) {
      inputEl.value = plan.restoreText;
      inputEl.dispatchEvent(new Event('input'));
    }
    attachments.setItems(plan.restoreAttachments);
  }

  // 发出一条消息后丢弃当前表面的草稿槽。身份必须取 displayed*（与存草稿时逐字同源），
  // 【不能用 currentSessionId】：它有三个写入者、语义是「事件流里最近见过的 sessionId」，
  // 而且按 ＋ 之后它要等 instances 广播落地、bindView→clearView 才更新。那段窗口里（离线时
  // 无限长）拿它算 key，删掉的是【上一个会话刚存下的草稿】，而新会话页这条已发出去的话
  // 留在 `new:<cwd>` 槽里，下次回到这个工作区会被当草稿恢复出来。
  function dropDraftForCurrentSurface() {
    const key = draftKeyFor({
      sessionId: displayedSessionId,
      cwd: sessionWorkspaceState.displayedCwd || currentCwd,
    });
    if (key) sessionDraftCache.delete(key);
  }

  function bindView(entry, id, opts = {}) {
    hidePromptSuggestion(); // 建议属于【上一个会话的上一轮】，跟着视图一起走
    hideUnreadPill(); // 无条件先清上一个会话的残留胶囊——含本函数下方提前 return 的空首页/compose 分支，避免悬浮在无关界面上
    scrollToBottom.reset(); // 同上：回到最新钮不跨会话残留
    // 无条件先丢弃上一个实例的回放缓冲——同 hideUnreadPill：含下方提前 return 的空首页/compose/
    // pendingFirstSend 分支也要清，否则遗留缓冲会静默吞掉那个旧实例后续的实时事件（缓冲一直挂着、
    // 却再没人来 resolve() 它）。真正切入某个会话时 begin() 自身也会 discard，这里是兜底覆盖全分支。
    replayBuffer.discard();
    const prevInstanceId = displayedInstanceId; // S1：缓存归属的(外出)实例，供切回时检测实例是否被替换
    const prevSessionId = displayedSessionId;   // 切实例前的会话 id——供 planSessionDraftSwap 判 keep/swap
    const prevCwd = sessionWorkspaceState.displayedCwd; // 同上，新会话页没有 sessionId 时草稿按它分槽
    sessionIdClearedByNav = false;             // 权威广播已落到 bindView，那段「等广播」的窗口到此为止
    // R65：离开旧会话的瞬间把它记为「已看到此刻」——正在看时到达的消息不该在离开后亮点。
    // 入场侧（下方真实会话分支）另有一记，覆盖「看完直接关页面」的路径；重复标记无害。
    if (prevSessionId) unread.markSeen(prevSessionId);
    displayedInstanceId = id;
    const sid = entry?.sessionId || null;
    displayedSessionId = sid;
    const cwd = entry?.transcriptCwd || entry?.cwd || currentCwd || null;
    sessionWorkspaceState.displayedCwd = cwd;
    // 清除①②：切到别的实例/空表面（id 变了），或该实例这一刻已经拿到 sessionId（sid 非空）——
    // 两种情况都意味着"sessionId 未到即被中断"这个待续档态不再适用，须清掉，否则会悬留到下一个
    // 无关场景把它误判成该显示中断态。
    if (freshInterruptedInstanceId && (id !== freshInterruptedInstanceId || sid)) {
      freshInterruptedInstanceId = null;
    }

    // Phase 2: Save DOM nodes of current session to cache before clearing.
    // S1：连同去重基线(lastSeq/epoch)一并缓存——切回时据此「只增量续传缓存之后的新事件」，而非
    // sync:since(0) 全量回放（会与缓存重复，且旧逻辑用 innerHTML='' 清重复时把回放也一起清掉 → 空屏）。
    // 页面还没绑过任何视图（prevInstanceId 仍是初值 undefined）时，#messages 里的东西不属于任何会话：currentSessionId
    // 是 localStorage 里上次那个，离线重放的提示又可能先于首次 bindView 写进来——当成它的缓存贴回去，sync:since 就走
    // 'keep' 不拉历史，整屏只剩那一行（R10 修 O135 时发现，P0-02d11 守着）
    if (prevInstanceId !== undefined && currentSessionId && !messagesEl.classList.contains('empty-start') && messagesEl.childNodes.length > 0) {
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
    clearView(sid, null, { prevSessionId });
    // 未发送草稿（文字+附件）按 draftKeyFor 的槽存/取：同一表面静默换实例(keep)不动；真实切换(swap)存旧恢复新。
    // 旧逻辑只 clear 不存 → 切走再切回输入/附件被清空（用户报告）。
    applySessionDraftSwap(prevSessionId, sid, draftSnapshot, { prevCwd, newCwd: cwd });

    // clearView 刚 setBusy(false)：发送窗口内（首发懒开 / 同会话静默换实例）立即补回，避免 live 行闪没。
    // FE-NEW-004：切入已在跑的 live 实例时 seed busy（instances.state），否则发送钮停在 idle 直到下一条 delta。
    const restoreBusy = shouldRestoreOptimisticBusy({
      pendingFirstSend: _pendingFirstSend,
      pendingSendBusySessionId: _pendingSendBusySessionId,
      viewingInstanceId: id,
      sessionId: sid,
    }) || Boolean(resolveRunStateFromSnapshot(entry)?.busy);
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
      showInstanceDestroyedSurface({ byRestart: Boolean(opts.destroyedByRestart), resume: opts.destroyedResume || null, reason: opts.destroyedReason || null });
      return;
    }
    if (emptySurface === 'home') {
      showDashboard();
      return;
    }
    if (emptySurface === 'compose') {
      showComposeSurface({ relocatedFrom: opts.composeRelocatedFrom || null });
      return;
    }

    // 进入真实会话：输入条常显（shouldShowComposer 看 sessionId）；composeReady 可清掉。
    leaveComposeReady();
    syncComposerVisibility();
    syncTopContextPillVisibility(id, sid);
    if (sid) unread.markEntered(sid); // R65：入场即记已读 + 手动未读作废（离场侧 markSeen 另有一记，两侧合围）

    // Phase 2: Check memory cache for instant restoration.
    // 已完成的对话/工具卡片按 session 不可变：同 sessionId 即恢复 DOM，不要求 instanceId 相同
    // （effort/model 切档会换 instance，旧逻辑要求 instance 一致 → 整段重走 history 丢掉工具卡片）。
    // seq/epoch 仅在「缓存归属实例 === 当前实例」时复用；跨 instance 从 0 跟新缓冲（见 sessionDomCachePlan）。
    let hasCache = false;
    let resumeFromSeq = 0;
    const cached = sid ? sessionDomCache.get(sid) : null;
    const cachePlan = sessionDomCachePlan({ cached, currentInstanceId: id });
    if (cachePlan.restore && !opts.forceHistoryReload) {
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
    // F3（2026-08-06）：必须 socket.timeout——裸 ack 断线时被 _clearAcks() 静默删除且【不调用】
    // （同 loadHistory 那条禁令），整个回调（含 hideLoadingCard/loadHistory/applyPendingSnapshot）
    // 都不会执行：加载卡永转、历史永不加载；且首次进入页面期间断线连 connect 补传都没有
    // （initialLoad 尚未翻转）。err 分支在下方迟到守卫之后收尾。
    socket.timeout(SYNC_ACK_TIMEOUT_MS).emit('sync:since', { instanceId: id, sessionId: sid, lastSeq: resumeFromSeq }, (err, res) => {
      // 已切走：丢弃过期回调。显式 discard 本轮 handle——后续 bindView 的 begin/discard 通常已顶替，
      // 但若同一实例被快速 A→B→A 重入，仅靠 displayed 守卫早退而不 resolve，会让中间那批已入队事件
      // 既不 flush 也不推进基线，最终被第三次 begin 无声丢掉。
      if (displayedInstanceId !== id || drivingCwdOf(id) !== cwd) {
        replayBuffer.resolve(replayHandle, 'discard');
        return;
      }
      if (err) {
        // 超时/断线：这个 ack 不会来了。有 sid → 与下面 'load' 分支同款转拉磁盘历史（loadHistory
        // 自带 15s 超时与 err 清理，连接还活着即自愈；resolve('reload') 把续传基线推进到缓冲尾，
        // 历史不占 seq、不会重复）。无 sid → 磁盘上无从补拉，缓冲就是唯一内容：flush 渲染 + 收
        // 加载卡，宁可残缺不可白等（同 decideTimeoutAction 的取舍）。unreadOnEntry 随 ack 丢失，按 0。
        if (sid) {
          replayBuffer.resolve(replayHandle, 'reload');
          loadHistory(sid, entry.transcriptCwd || entry.cwd, () => showUnreadPillIfAny(0));
        } else {
          replayBuffer.resolve(replayHandle, 'flush');
          hideLoadingCard();
        }
        return;
      }
      // S1：hasCache 时已增量续传（resumeFromSeq=缓存位置，回放只含新事件、append 不重复）。
      // 切入决策交纯函数 shouldReloadOnEnter（logic.js，单测覆盖）——活缓冲/DOM 缓存 vs 磁盘全量重载：
      //   'load'   无缓存、聊天区空 → 拉磁盘首次填充（不必清屏）；
      //   'reload' gap（缓冲超窗残缺）或磁盘被外部写长（web 离开期间终端 CLI 写盘的盲区）→ 清屏全量重载磁盘；
      //   'keep'   缓存/活缓冲即最新真相 → 直接收尾，保留 DOM 秒恢复。
      const action = opts.forceHistoryReload ? 'load' : shouldReloadOnEnter({
        replayed: res?.replayed, gap: res?.gap, hasCache,
        diskLen: res?.diskLen ?? 0, diskExternalLen: res?.diskExternalLen ?? 0,
        seenDiskLen: seenDiskLenBySession.get(sid) ?? 0,
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
        loadHistory(sid, entry.transcriptCwd || entry.cwd, () => showUnreadPillIfAny(unreadOnEntry));
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
        clearView(sid, null, { prevSessionId: displayedSessionId });
        lastSeq = keepSeq;
        curEpoch = keepEpoch;
        // clearView 内部只补乐观 busy（shouldRestoreOptimisticBusy），不含 state seed——
        // 静默窗口（长 Bash 执行中）无 delta 自愈，运行条被本次清屏永久抹掉 → 按 server 权威 state 重种。
        if (shouldReseedBusyAfterReload({ instances: instancesList, instanceId: id, entryState: entry?.state })) setBusy(true);
        // 发送闸同理：clearView 把 _turnRunning 清了，按广播的权威字段重种，否则 reload 后停止钮消失
        if (instancesList.find(x => x?.instanceId === id)?.turnRunning === true) _turnRunning = true;
        showLoadingCard();
        loadHistory(sid, entry.transcriptCwd || entry.cwd, () => showUnreadPillIfAny(unreadOnEntry));
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
      applyPendingSnapshot(res?.pending, id);
      // 'keep' 分支的卡是从 sessionDomCache 放回的，这里视图已稳定，按手里的前台任务快照把「后台运行」挂回去
      foregroundTasks.render();
    });
  }

  // 跨 tab 通知：非查看 cwd 的聚合状态迁移到 done/permission → notify（notify 内部仅 document.hidden 生效）。
  // 单一来源 = states 差分（后台 agent:event 已在分发入口按 instanceId 丢弃，不在那边重复 notify）。
  function notifyStateChanges(newStates, viewCwd) {
    for (const d of Object.keys(newStates)) {
      if (d === viewCwd) continue;                   // 查看中的 cwd 走内联渲染，不通知
      const prev = workdirStates[d], cur = newStates[d];
      if (cur === prev) continue;
      const identityOpts = otherWorkspaceNotifyOpts(d);
      if (cur === 'permission') notify(t('⚠️ 后台需要审批'), '', identityOpts);
      else if (cur === 'error') notify(t('⚠️ 后台任务出错'), '', identityOpts);
      else if (cur === 'done') notify(t('✅ 后台任务完成'), '', identityOpts);
    }
  }



  function setBusy(b) {
    // UX-010：镜像只读时不与本地忙碌条同现；live 状态迁到消息流 #streamLiveStatus，发送钮双态由 updateSendButtonState 驱动
    const show = shouldShowBusyWithMirror({ mirrorReadonly: Boolean(mirrorReadonlySid), busy: b });
    if (show === _busyState) return;
    _busyState = show;
    if (show) {
      // 新一轮开跑 ⇒ 上一轮那条建议已经过时。挂在这里而不是发送路径上：发起新一轮的入口不止输入框
      // （审批/选项回答、另一台设备、CLI 侧驾驶都不经过它），而"轮次开始"是这些路径唯一的公共出口。
      hidePromptSuggestion();
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
      announceTurn(t('Claude 正在回复'));
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
    // immediate 与桌面端 toggleSessions（≥1024 分支）、visibilitychange 回前台三处对齐。此前移动端
    // 是三条打开路径里唯一裸调的，于是要等满一个 SESSION_PANEL_REVALIDATE_MS(12s) 周期才有数据：
    // 刷新后 sessionsCache（纯内存）必空，折叠目录不 populate，目录头未读角标整整 12 秒是空的——
    // 而空角标与「确定没有未读」同形（见 resolveDirUnreadBadge），用户读到的是错误事实不是加载中。
    // 移动端恰恰是本产品主场景。openSessionPanel() 末尾那次裸调装的 12s 定时器仍在，
    // scheduleSessionPanelRevalidate 的 timer 守卫保证这里不会重复装，不是双倍请求。
    onOpened: () => { openSessionPanel(); startSessionPanelRevalidator({ immediate: true, skipExpanded: true }); },
    onClosed: () => stopSessionPanelRevalidator(),
    // 抽屉不可见时失败回执的去处：此刻用户看的是聊天区，消息流才是"看得见的那一层"。
    fallbackNotice: (text) => addBar(text, 'text-danger'),
  });
  const { openLeftSidebar, closeLeftSidebar } = drawer;
  // 顶栏文字 chip 与会话按钮同一去处：点它打开抽屉（需要你区 / 服务异常区 / 工作区树就在里面）。
  attentionChipEl?.addEventListener('click', () => openLeftSidebar());

  const { openDeleteSession } = createSessionDeleteController(appContext, {
    socket, addBar, appConfirm, showDrawerNotice: drawer.showNotice,
    isNoFolderCwd: cwd => projectsState.isNoFolder(cwd),
    onDeleted: ({ cwd, sectionKey } = {}) => {
      // 立刻丢掉这一行所在小节的 SWR 缓存，避免重建时先画「含已删行」的旧快照再等 revalidate。
      // 缓存按小节归键：worktree / scratch 会话的 cwd 是成员目录，只按 cwd 删等于没删。
      if (sectionKey) sessionsCache.delete(sectionKey);
      if (cwd) sessionsCache.delete(cwd);
      openSessionPanel();
    },
  });
  const sessionRowMenu = createSessionRowMenu(appContext, { $, el, openSheet, closeSheet });
  // 转后台（#459，终端 Ctrl+B）：输入条「转后台」与工具卡「后台运行」，见 app/foreground-tasks.js
  const foregroundTasks = createForegroundTasks(appContext, {
    $, socket, addBar,
    getViewingInstanceId: () => viewingInstanceId,
    // 切回会话时卡是从 sessionDomCache 原样放回的，toolCards 已随 clearView 清空；刷新后从历史渲染的卡只在
    // histToolCards 里。两种都按 DOM 上的 data-tool-use-id 找回（#469 review）
    getToolCard: toolUseId => toolCards.get(toolUseId)
      || messagesEl.querySelector(`[data-tool-use-id="${CSS.escape(toolUseId)}"]`),
  });
  const sessionRename = createSessionRenameController(appContext, {
    $, socket, openSheet, closeSheet,
    onRenamed: ({ cwd, sectionKey, terminalMayOverwrite } = {}) => {
      // 同删除：丢掉这一行所在小节的 SWR 缓存再重建，免得先画一帧旧名字
      if (sectionKey) sessionsCache.delete(sectionKey);
      if (cwd) sessionsCache.delete(cwd);
      openSessionPanel();
      drawer.showNotice(terminalMayOverwrite ? t('终端正在使用这个会话，改名可能被覆盖') : '');
    },
  });

  // ---- /rewind 面板（对齐终端的两步交互）----
  // 成功路径的 UI 更新由 rewind_applied 广播统一驱动（本机与其他设备同一条路径），
  // 这里只做两件【只对发起方有意义】的事：说清处置建议、把那一轮的原话回填输入框。
  const rewindCommand = createRewindCommandController({
    $, socket, openSheet, closeSheet,
    getCurrentSession: () => ({ sessionId: displayedSessionId, cwd: drivingCwdOf(displayedInstanceId) }),
    onRewound: (res) => {
      // 整体性失败（warning）、哪些文件没恢复（unrestored）、几个链接被跳过（skippedLinks）——
      // 三者可叠加、有轻重，组装在 logic/rewind.js（可单测）。
      for (const note of rewindOutcomeNotes(res)) {
        addBar(note.text, note.tone === 'danger' ? 'text-danger' : note.tone);
      }
      // 回退的下一步多半是把这句话改一改重说。守卫同发送失败时的草稿恢复：**只在输入框空且
      // 无附件时**回填，绝不覆盖用户已经打的字。
      if (res.prefill && inputEl && !inputEl.value.trim() && attachments.items().length === 0) {
        inputEl.value = res.prefill;
        inputEl.dispatchEvent(new Event('input'));
        autosize();
        updateSendButtonState();
      }
    },
  });
  // #399 / #425：把手下拉走 rewind close（清 picked/session），不要裸 closeSheet 留下脏态
  setGestureDismiss($('rewindModal'), () => rewindCommand.close());

  // ---- 续接会丢掉一段对话（SESSION-04）：发送被拒后问「分叉到新会话 / 仍然发送」----
  // 话的去留在这里：分叉要把它从这个会话的输入框挪进新会话（正看着就直接放，否则放进草稿槽，
  // 切过去时 bindView 的草稿交换会恢复它——fork 的 ack 与 instances 广播谁先到都对）。
  const resumeDivergencePrompt = createResumeDivergencePrompt({
    socket, appConfirm, addBar,
    getCurrentSession: () => ({ sessionId: displayedSessionId }),
    resend: (opts) => send(opts),
    takeDraft: () => {
      const draft = { text: inputEl.value, attachments: attachments.items() };
      if (!draft.text.trim() && draft.attachments.length === 0) return null;
      inputEl.value = '';
      inputEl.dispatchEvent(new Event('input'));
      dropDraftForCurrentSurface();
      attachments.clear();
      autosize();
      updateSendButtonState();
      return draft;
    },
    putDraft: (sessionId, draft) => {
      if (displayedSessionId === sessionId && !inputEl.value.trim() && attachments.items().length === 0) {
        inputEl.value = draft.text;
        inputEl.dispatchEvent(new Event('input'));
        attachments.setItems(draft.attachments);
        autosize();
        updateSendButtonState();
        return;
      }
      sessionDraftCache.set(draftKeyFor({ sessionId }), { text: draft.text, attachments: draft.attachments });
    },
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
  // 新会话的 worktree 意图（勾选态 / 源分支 / 建好的路径）。onChange 只重绘空首页那一块——
  // 整页重绘会把用户已经敲进输入框的字冲掉。
  const newSessionWorktree = createNewSessionWorktree(appContext, {
    onChange: () => { try { renderWorktreeChips(); } catch { /* 空首页未渲染时无事可做 */ } },
  });
  // 「这一个新会话页」的标识：离线重放时同一页的几条并成一个会话、另开的一页各开各的（见 compose-page.js）
  const composePage = createComposePage();
  // 两个子控制器只管各自半边的数据；sheet 开合与 tab 切换归 workspacePanel 统一持有
  const workspacePanel = createWorkspacePanel(appContext, {
    closeSheet,
    openSheet,
    haptic,
    fileBrowser,
    gitChanges,
  });
  // #399：把手下拉走面板自己的 close（含未保存编辑丢弃确认），不要直接 closeSheet
  setGestureDismiss(workspaceModal, () => { void workspacePanel.close(); });
  const openWorkspacePanel = workspacePanel.open;
  // 「选文件夹」面板：新会话在哪开（已连接的文件夹 / 子文件夹 / 无文件夹 / 添加文件夹）
  const folderPicker = createFolderPicker({
    $, el, socket, openSheet, closeSheet, haptic,
    getProjects: () => projectsState.entries(),
    getScratchRoot: () => projectsState.scratchRoot(),
    getFoldersReadonly: () => projectsState.foldersReadonly(),
    onPick: cwd => startNewSessionIn(cwd),
  });
  // ⑧ 推送内容预览：本地偏好读写 + 改动时（若已授权通知权限）立即重新订阅，把新 prefs.preview 带给服务端
  // ——不重新订阅的话，服务端那份旧订阅记录的 prefs 就跟本地开关脱节，下次推送还是按旧偏好选 body。
  const pushPreview = {
    get: () => readPushPreviewPref(k => localStorage.getItem(k)),
    set: (enabled) => {
      writePushPreviewPref((k, v) => localStorage.setItem(k, v), enabled);
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') void notifications.subscribe();
    },
  };
  // ⑨ 语言偏好：先确认刷新，同意后再写 storage + reload（不做响应式重渲——已翻译的静态串只在启动时应用一次，
  // 运行中改语言若不刷新，会停留在混杂态；appConfirm 走已有的确认 sheet，不新开一套 UI）。
  const langPref = {
    // 回显设置面板下拉框用原始存储值（含 auto）；语言渲染/t() 走 getLang() 的运行时折叠值，两者用途不同。
    // 切换：先确认刷新，同意后再 writeLangPref + reload（取消不落盘，避免磁贴/文案半切换）。
    get: () => readLangPref(k => localStorage.getItem(k)),
    set: async (lang) => confirmAndWriteLangPref({
      lang,
      confirm: () => appConfirm({ title: t('需要刷新页面才能生效'), body: t('现在刷新吗？'), okText: t('刷新') }),
      write: (next) => writeLangPref((k, v) => localStorage.setItem(k, v), next),
      reload: () => location.reload(),
    }),
  };
  // ⑩ 主题偏好：即时落盘 + apply（色板是 CSS 变量，无需刷新）；回显用原始 'light'|'dark'|'system'。
  const themePref = {
    get: () => readThemePref(k => localStorage.getItem(k)),
    set: (theme) => {
      writeThemePref((k, v) => localStorage.setItem(k, v), theme);
      applyThemeToDocument(document, theme, { systemDark: systemDarkNow() });
    },
  };
  // ---- 设置：两个同构 sheet，由同一个 controller 按作用域分工 ----
  // 会话设置（入口=底栏 #pillDefaults 摘要 chip，随 composer 显隐）：模型 / 权限 / 思考 / 会话 ID。
  // 原独立齿轮与三 chip 打开同一个 sheet、纯重复，已收敛为一条摘要。DEFAULT_KEYS.trigger 的
  // btnSettings 不再注入 dom，controller bind 对缺失 trigger 安全跳过。syncPrefs=false——
  // 本机偏好那批 DOM 已迁到通用设置，两个控制器都去绑会互相覆盖 onchange（后建的赢，静默难查）。
  // 自动调用计数：两个旁路提问（下一步建议 / 回来时的摘要）在本会话触发了几次。
  // 数据搭 instances 广播的便车（见 server instancesPayload 的说明）。一次都没有就整段隐藏——
  // 空计数占位既没信息量，又让人以为功能坏了。
  // 占位符用 {n} 而非单个字母：英文译文里 'Next-step suggestions ×N' 的首字母 N 会被
  // replace('N', …) 抢先命中，这类误伤在中文界面下完全看不出来。
  function renderSideQuestionStats() {
    const block = $('sideQuestionBlock'), line = $('sideQuestionCounts');
    if (!block || !line) return;
    const calls = instancesList.find(x => x.instanceId === viewingInstanceId)?.sideQuestionCalls;
    const suggestion = Number(calls?.suggestion) || 0, recap = Number(calls?.recap) || 0;
    if (!suggestion && !recap) { block.classList.add('hidden'); return; }
    const parts = [];
    if (suggestion) parts.push(t('下一步建议 {n} 次').replace('{n}', String(suggestion)));
    if (recap) parts.push(t('会话摘要 {n} 次').replace('{n}', String(recap)));
    line.textContent = parts.join(' · ');
    block.classList.remove('hidden');
  }

  // 面板内三块始终展开磁贴（方案 A），onOpen 只需回填摘要 title。
  const settings = createSettingsController(appContext, {
    alerts, haptic, syncPrefs: false,
    onOpen: () => { syncDefaultsPillTitle(); renderSideQuestionStats(); },
  });
  // 侧栏与 sheet 同为 z-40：不先收侧栏，弹出的面板会和左侧抽屉叠在一起。
  // 必须抢在下面 createSettingsController 的 bind() 之前注册——listener 按注册顺序触发，
  // 这样是「先收侧栏、再弹面板」而不是反过来闪一帧。也**不能**改写 btnGeneralSettings.onclick
  // （那是控制器 bind 的落点，覆盖掉 open 就没了）。
  if (btnGeneralSettings) btnGeneralSettings.addEventListener('click', closeLeftSidebar);
  // 「宿主机上的 claude」段：MCP 服务器与 skills 数。skills 数来自 init 事件（缺字段不覆盖，见 init handler）；
  // MCP 进页时现查（#457，见 app/host-mcp.js），拿不到再用 init 那份快照。
  const hostMcp = createHostMcp({
    emit: (event, payload, ms = 3000) => new Promise(resolve => {
      socket.timeout(ms).emit(event, payload, (err, res) => resolve(err ? null : res));
    }),
    appConfirm,
    getInstanceId: () => viewingInstanceId,
    // 现取当前 cwd 的那份：没有就是没有，绝不回落到上一个工作区的快照
    getSnapshot: () => mcpServersByCwd.get(currentCwd) ?? null,
    onChange: () => renderHostEnvSection(),
  });
  function renderHostEnvSection() {
    const section = $('hostEnvSection'), body = $('hostEnvBody');
    if (!section || !body) return;
    const lastSkillsCount = skillsCountByCwd.get(currentCwd) ?? 0;
    const mcpCard = hostMcp.renderCard();
    // 两样都没有 = 这个 cwd 确实既没配 MCP 也没有 skill，整段隐藏，不给空计数占位
    if (!mcpCard && !lastSkillsCount) { section.classList.add('hidden'); return; }
    section.classList.remove('hidden');
    body.replaceChildren();
    if (mcpCard) body.appendChild(mcpCard);

    if (lastSkillsCount) {
      const skills = el('<div class="p-2.5 rounded-xl border border-line bg-surface text-xs"></div>');
      const t1 = el('<div class="font-semibold text-ink"></div>');
      t1.textContent = `Skills · ${lastSkillsCount} ${t('个可用')}`;
      const t2 = el('<div class="text-ink-soft mt-0.5"></div>');
      t2.textContent = t('当前工作区加载的技能');
      skills.append(t1, t2);
      body.appendChild(skills);
    }
  }

  // L1 目录要用的两份快照。推送订阅态由 renderPushStatusRow 写入（同一份判据，免得目录与
  // 面板里的话自相矛盾）；服务快照来自 service:status ——那条 ack 不随 instances 广播常驻，
  // 不主动拉就永远显示「状态读取中」。
  let generalPushSubscribed = false;
  // 版本号只拉一次：它在 server 进程的生命周期内不变，而运行时长走 instances 广播里的 startedAt
  // （computeServiceHealth 恒带该字段）。此前这里每次打开面板都发一条 service:status——那条请求
  // 在四分片并行的 E2E 下把一条依赖广播时序的既有用例挤成了 8s 超时，而它拿到的东西广播里本就有。
  let generalVersions = null;
  let generalVersionsInflight = false;
  // 「关于」页（#303）。版本号用上面这份 generalVersions，不另发请求；检查更新要等服务端打 GitHub，超时由它自己传。
  const aboutPage = createAboutPage({
    $,
    emit: (event, payload, ms = 3000) => new Promise(resolve => {
      socket.timeout(ms).emit(event, payload, (err, res) => resolve(err ? null : res));
    }),
    getVersion: () => generalVersions?.server,
  });
  aboutPage.bind();
  async function ensureGeneralVersions() {
    if (generalVersions || generalVersionsInflight) return;
    generalVersionsInflight = true;
    try {
      const status = await emitServiceAck('service:status', {});
      if (status?.ok === true && status.versions) {
        generalVersions = status.versions;
        generalNav?.render();
        aboutPage.renderVersion();
      }
    } finally {
      generalVersionsInflight = false;
    }
  }

  // 两级导航：L1 目录 ↔ 7 个 L2 页。摘要是活数据，故 state() 每次现取，不缓存。
  generalNav = createGeneralNav({
    haptic,
    state: () => ({
      push: { subscribed: generalPushSubscribed, preview: pushPreview.get() },
      alerts: alerts.preferences(),
      devices: { trusted: lastTrustedDevices.length, pending: lastPendingDevices.length },
      // 两个桥的安装态原样透传：摘要里那两档与页面里 formatHooksBridgeRow / formatStatuslineBridgeRow
      // 读的是同一个对象，不可能一处说开一处说关。旧 server 没有这两个字段 → 两处一起缺席。
      service: {
        startedAt: latestServiceHealth?.startedAt,
        versions: generalVersions,
        hooksBridge: latestServiceHealth?.hooksBridge,
        statuslineBridge: latestServiceHealth?.statuslineBridge,
      },
      lang: langPref.get(),
      theme: themePref.get(),
    }),
    // 「宿主机」页进来时补一次版本号（只拉一次，之后复用）。运行时长不用管——
    // 它跟着 instances 广播实时更新。
    onEnterPage: page => {
      // 离开「接入与设备」页就收码：钥匙不该挂在一个用户以为已经翻过去的界面上
      if (page !== 'devices') hideQr();
      // #381：推送订阅回执只在通知页有上下文；离开（含回 L1 的 page=null）就清掉
      if (page !== 'notify') notifications.clearSubscribeResult();
      // MCP / skills 那一段按 cwd 归键，而切到一个**已经 live** 的会话不会重放 init——
      // 只靠 init 回调重画的话，换过工作区之后这一页还挂着上一处的数据。每次进页现取一次。
      if (page === 'host') { ensureGeneralVersions(); renderHostEnvSection(); hostMcp.refresh(); }
      // 审批规则每次进页重拉：用户可能刚在电脑上改过 settings.json，缓存一次会显示过期名单
      if (page === 'behavior') loadPermissionRules();
      if (page === 'about') { ensureGeneralVersions(); aboutPage.load(); }
    },
  });
  generalNav.bind();

  // 通用设置（侧栏底部入口，全局可达）：L1 目录 + 通知/设备/主机/行为/排查/帮助/关于 七页。
  // beforeOpen 收掉可能还开着的会话设置——两个 sheet 同为 z-40，叠着会露出下面那层的边。
  general = createSettingsController(appContext, {
    keys: {
      sheet: 'generalSheet', body: 'generalSheetBody', scrim: 'generalScrim',
      dragZone: 'generalDragZone', close: 'generalClose', trigger: 'btnGeneralSettings',
    },
    alerts, haptic, pushPreview, langPref, themePref,
    beforeOpen: () => { if (settings.isOpen()) settings.close(); },
    // 推送订阅状态每次打开重算：权限可能在系统设置里被改过，渲染一次会过期。
    onOpen: () => {
      renderPushStatusRow();
      // 每次打开都从 L1 起步（目录心智）；带深链时再切到目标页。
      const link = generalDeepLink;
      generalDeepLink = null;
      hideQr(); // 每次打开面板都从「未展开」起步，不继承上一次的展开态
      generalNav.showHome();
      if (link?.page) generalNav.showPage(link.page, { anchor: link.anchor || null });
      // 版本号首次打开时补一次；运行时长已由 instances 广播喂给 latestServiceHealth，无需请求。
      ensureGeneralVersions();
    },
  });
  const openSettingsSheet = settings.open; // 刷新动态段走控制器的 onOpen
  if (pillDefaults) pillDefaults.onclick = () => openSettingsSheet(); // 点摘要 chip → 会话设置（三块磁贴已展开）
  // 顶部 pill：工作区入口，直接落到「文件」tab（「改动」tab 就在同一行，无需先选一次）。侧栏不再挂浏览入口。
  if (topContextPill) {
    topContextPill.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      haptic('tap');
      openWorkspacePanel(panelCwd(), 'files', worktreeGoneNotice());
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
      if (!tile || !customPermGrid.contains(tile) || tile.disabled) return;
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
    // 清除③：用户显式回主页——放弃"sessionId 未到即中断"的待续档态（用户就是要去主页）。
    freshInterruptedInstanceId = null;
    // 「已在空表面」只认没有正在看的实例，不看 sessionId 有没有到。sessionId 未到的实例可能正在跑
    // （首轮头几秒、网关卡住）：本地画了首页，服务端却仍当它是正在看的，busy 也还归它，动态状态行的
    // 下一次刷新（每秒一拍的 ticker、status_line、流式 delta）就经 leaveStartScreen 清掉首页、挂回那一行
    // （2026-10-15 复现，首页撑不过 1 秒）。也不能改成看它在不在跑：懒开的那条广播发在 send 之前，
    // send 还要先等 setModel / effort 的控制请求才计入在途轮（CLI 没起来时可达数秒），这段时间广播里
    // 实例还不是 busy，本地却已乐观 busy。所以有实例就走 session:home，广播回来经 bindView 落首页，
    // 实例在后台照跑。
    if (!viewingInstanceId) {
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
    // 新的一页属于项目本身：上一页在选择器里挑的 worktree 要当场作废（同 startNewSessionIn）。
    // 等广播来清就晚了——广播落地前发出的首条消息会被 sendCwd() 投进那个 worktree。
    composeCwd = null;
    // 【displayedSessionId 也要同步置空】上面那条 Bug A 的保证只做了一半：漏了这个变量，
    // 一次迟到的 instances 广播会拿「prev=旧会话 / new=null」进 bindView 判成 swap，
    // 把用户【刚在新会话页打的字】存进旧会话的草稿缓存，再用空串覆盖输入框
    // （E2E 的 P0-33 / P0-12 稳定红就是撞这个：fill 之后几十毫秒被清空，发送键随之隐藏）。
    // 草稿交换在这里同步做完——语义与 bindView 那次一致（存旧、清空、进空白的新会话页），
    // 做完之后两侧都是 null，后续广播一律 keep，不再碰输入框。
    applySessionDraftSwap(displayedSessionId, null, {
      text: inputEl ? inputEl.value : '',
      attachments: attachments.items(),
    }, { forceSwap: true, prevCwd: sessionWorkspaceState.displayedCwd, newCwd: currentCwd });
    displayedSessionId = null;
    sessionWorkspaceState.displayedCwd = currentCwd;
    sessionIdClearedByNav = true;
    // 清除③：新建会话——放弃上一个实例"sessionId 未到即中断"的待续档态。
    freshInterruptedInstanceId = null;
    enterComposeReady();
    ensureEmptySurface();
    newSessionWorktree.reset(); // 新一轮新会话：勾选/源分支/已建路径全部作废
    composePage.renew();
    socket.emit('session:new', { cwd: currentCwd }); // 模型清单由后端 pushModelsForCwd 主动推、不再前端拉
  };
  function toggleSessions() {
    haptic('tap');
    if (window.innerWidth >= 1024) {
      const collapsed = document.body.classList.toggle('sidebar-collapsed');
      if (collapsed) stopSessionPanelRevalidator();
      else {
        openSessionPanel(); // 用已剥离 terminal 的 SWR 缓存重画，避免展开时闪旧 CLI 状态
        startSessionPanelRevalidator({ immediate: true, skipExpanded: true });
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

  const sessionSidebar = createSessionSidebar(appContext, {
    appConfirm, applyDeepLink, applySessionDraftSwap, attachments, attentionChipEl, baseName,
    closeLeftSidebar, composePage, connBanner, connDot, connDotWrap,
    dismissBlockedSurfaceIfTarget: (...args) => dismissBlockedSurfaceIfTarget(...args), drawer, el,
    ensureEmptySurface: (...args) => ensureEmptySurface(...args),
    enterComposeReady: (...args) => enterComposeReady(...args), envConfigPanel, folderPicker, haptic,
    inputEl, leftSidebar, newSessionWorktree, noticeDismissals, openDeleteSession, projectsState,
    renderHooksBridgeSection, renderStatuslineBridgeSection, SESSION_PANEL_REVALIDATE_MS, sessionPanel,
    sessionRename, sessionRowMenu, sessionsCache, sessionsDot, sessionSearchQueryByDir, sessionWorkspaceState,
    setStatusIcon, showSessionBlockedSurface: (...args) => showSessionBlockedSurface(...args), socket,
    syncDashNoFolders: (...args) => syncDashNoFolders(...args), unread,
    getAvailableDirs: () => availableDirs, getCurrentCwd: () => currentCwd,
    getDirSectionNodes: () => dirSectionNodes, getDisplayedSessionId: () => displayedSessionId,
    getExpandedDirs: () => expandedDirs, getGeneralNav: () => generalNav,
    getInstancesList: () => instancesList, getLatestServiceHealth: () => latestServiceHealth,
    getMirrorAutonomousFlag: () => mirrorAutonomousFlag, getMirrorReadonlySid: () => mirrorReadonlySid,
    getMirrorStaleFlag: () => mirrorStaleFlag, getMirrorWaitingFlag: () => mirrorWaitingFlag,
    getNeedsYouList: () => needsYouList, getViewingInstanceId: () => viewingInstanceId,
    getWorkdirStates: () => workdirStates, setComposeCwd: v => { composeCwd = v; },
    setCurrentCwd: v => { currentCwd = v; }, setDirSectionNodes: v => { dirSectionNodes = v; },
    setDisplayedSessionId: v => { displayedSessionId = v; },
    setExplicitCloseInstanceId: v => { explicitCloseInstanceId = v; },
    setFreshInterruptedInstanceId: v => { freshInterruptedInstanceId = v; },
    setLatestServiceHealth: v => { latestServiceHealth = v; },
    setSessionIdClearedByNav: v => { sessionIdClearedByNav = v; },
    setViewingInstanceId: v => { viewingInstanceId = v; },
  });
  const {
    dashUnreadMark, isSessionPanelRevalidateActive, mirrorRowLock, openSessionPanel, rebuildDirSections,
    refreshDirBadges, refreshNeedsYou, refreshSessionStatusChips, refreshUnreadMarks, reorderDirSections,
    startNewSessionIn, startSessionPanelRevalidator, stopSessionPanelRevalidator, updateAttentionSignal,
    updateServiceNotice, updateSessionsDot,
  } = sessionSidebar;

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

  // prevSessionId：清屏前屏幕上是哪个会话。调用方说清是同一会话的重载，离线条目的气泡才保得住（缺省不保）。
  // 不能在这里读 displayedSessionId 代替：bindView 先改写它再调本函数。
  function clearView(sessionId, tip, { prevSessionId = null } = {}) {
    currentSessionId = sessionId;
    lastSeq = 0;
    curEpoch = null;
    localStorage.setItem('current_session', sessionId || '');
    // 发送窗口内的清屏要保住未确认气泡。
    //
    // 新会话首发【必中】这条路：服务端懒开实例后一定会 broadcastInstances，viewingInstanceId 由 null
    // 变成新实例 → setInstances 判定视图变了 → bindView → 走到这里 innerHTML=''。用户刚点发送的那颗
    // 乐观气泡若挺不过这次清屏，就是「消息出现一下又消失、等服务端回显才回来」——真机反馈里的
    // "闪烁一下才出现"正是它（另一半"消失几秒"是回显本身被服务端慢路径压着，见 buildPendingUserBubble）。
    //
    // 判据与下方补 busy 同源（shouldRestoreOptimisticBusy）不是巧合：两者问的是同一件事——这次清屏
    // 是不是发生在一次尚未落定的发送窗口内。同一次发送里不可能"busy 该留而气泡该丢"，所以共用一个
    // 判定结果、绝不各判各的（各判各的正是本仓多次踩过的分叉坑）。
    const inSendWindow = shouldRestoreOptimisticBusy({
      pendingFirstSend: _pendingFirstSend,
      pendingSendBusySessionId: _pendingSendBusySessionId,
      viewingInstanceId: displayedInstanceId,
      sessionId,
    });
    // 离线条目（交给 outbox 的）气泡另判一次，只保气泡、不补 busy。这是有意拆开，不是漏扩：发送窗口那条问的是
    // 「有没有一次乐观 busy 会被这次清屏冲掉」，离线条目没有这样一个 busy——断线时入队不点亮运行条，重放那一批的
    // busy 在批后按结果结算（shouldBusyAfterOfflineBatch），两条重载路径清屏之后又按 instances 权威态重种。
    // 照着发送窗口补 busy，还在等连接的那几条会凭空点亮一条运行条，没有 result 来收。
    // 保它们是为了让同一会话的清屏重载不把气泡摘掉：负 ack 常常先于重载的历史到达，气泡不在，「未发送 + 重发」
    // 就只能另起一条提示条，被随后的历史压到顶上（判据见 shouldCarryOutboxBubbleOnClear）。
    // 只捞未确认的（.opacity-70）——已被 user_message 认领转正的那些属于历史，照常随清屏走、
    // 由 sessionDomCache 或 loadHistory 负责复原，重复留下会和历史回放撞成两条。
    const keptPending = [...messagesEl.querySelectorAll('[data-testid="user-message"].opacity-70')]
      .filter(b => inSendWindow || shouldCarryOutboxBubbleOnClear({
        outboxSessionId: b.dataset.outboxSessionId || null, prevSessionId, sessionId,
      }));
    messagesEl.innerHTML = '';
    messagesEl.classList.remove('empty-start');
    clearStreams(); thinkings.clear(); toolCards.clear();
    histToolCards.clear(); histSubCards.clear(); // 切会话/清屏：历史配对表也要随 DOM 一起归零，防跨会话误配对
    turnFileChanges = new Map(); // 切会话：丢弃未 flush 的本轮账本
    // UX-008：清视图后若仍无内容（新会话），给极简引导
    queueMicrotask(() => maybeShowEmptySessionGuide());
    subagentCards.clear(); // 切会话/清屏：丢弃子 agent 卡状态（DOM 已随 messagesEl 清空）
    approvals.clearAll();
    elicitationSheet.clearAll();
    // 附件托盘不再这里无脑清空：bindView 经 planSessionDraftSwap 按会话存/取；
    // 发送成功路径各自清空。否则同会话静默换实例 / 重载历史会误清未发送附件。
    setBusy(false);
    // 发送闸同理乐观清零：切到别的会话时不该把上一个会话的「运行中」提示带过去。
    // 随后的 setInstances 会按新实例的 turnRunning 校正（与 setBusy 同一套「先清、广播再定」哲学）。
    _turnRunning = false;
    // 发送窗口内同会话静默换实例 / history reload 二次 clearView 须补回 busy
    // （innerHTML='' 会拆掉 #streamLiveStatus；setBusy(false) 也会 hide）。真切会话则不补。
    if (inSendWindow) {
      setBusy(true);
      _turnRunning = true; // 同会话静默换实例：那条刚发出的消息仍在跑，闸不能松
    }
    // 未确认气泡放回（innerHTML='' 只是把节点摘出 DOM 树，节点本身连同已绑的监听器都还完好）。
    // 追加到末尾即可：这批本就是清屏前最靠后的消息，且此刻容器是空的，相对顺序原样保留。
    // 必须排在 maybeShowEmptySessionGuide 的 queueMicrotask 之前落地——它以 childNodes.length 为
    // 判据，气泡先回来才不会在"其实有消息"的会话上多贴一张空态引导卡。同步代码天然先于微任务。
    // 打上 data-carried：在历史回包之前，回显（user_message）可能先把它认领转正、摘掉 .opacity-70。落定逻辑
    // 只认 .opacity-70 的话会跳过它，它就留在随后落地的历史上方、历史里又画出同一条（验收 O29）。
    // 原文一并记下：回显转正时会把气泡内容换成 markdown 渲染，.whitespace-pre-wrap 就没了，历史认领按文本找不到它。
    for (const node of keptPending) {
      node.dataset.carried = '1';
      node.dataset.carriedText = node.querySelector('.whitespace-pre-wrap')?.textContent ?? '';
      messagesEl.appendChild(node);
    }

    // Clear stale status line and hide details row to prevent latency layout flashes
    hideStatuslineWrap();
    pillDefaults?.classList.remove('hidden'); // 恢复底栏会话档摘要 chip（statusLine 隐藏时）
    if (tip) addBar(tip, 'text-ink-faint');
  }

  const emptySurfaces = createEmptySurfaces(appContext, {
    $, approvals, baseName, btnHome, btnNew, btnSessions, dashUnreadMark, el, elicitationSheet, folderPicker, haptic,
    hideStatuslineWrap, inputEl, messagesEl, modelInput, newSessionWorktree, openLeftSidebar, panelCwd,
    pillEffortText, pillPermText, projectsState, scrollToBottom, showAccessHelp, socket, topContextChanges,
    topContextPill, topProjectText, topTitleText, unread, updateWorkspaceChangeBadge,
    wireConfigRefreshButton, getAvailableDirs: () => availableDirs, getComposeReady: () => _composeReady,
    getCurrentCwd: () => currentCwd, getCurrentGatewaySuffix: () => currentGatewaySuffix,
    getCurrentModel: () => currentModel, getCurrentSessionId: () => currentSessionId,
    getCwdDefaultModel: () => cwdDefaultModel, getDisplayedSessionId: () => displayedSessionId,
    getFreshInterruptedInstanceId: () => freshInterruptedInstanceId, getInstancesList: () => instancesList,
    getLatestServiceHealth: () => latestServiceHealth, getModelsList: () => modelsList,
    getPendingFirstSend: () => _pendingFirstSend, getViewingInstanceId: () => viewingInstanceId,
    setComposeReady: v => { _composeReady = v; },
  });
  const {
    dismissBlockedSurfaceIfTarget, ensureEmptySurface, enterComposeReady, leaveComposeReady,
    refreshComposeDefaultsSummary, renderWorktreeChips, showComposeSurface, showDashboard,
    showInstanceDestroyedSurface, showSessionBlockedSurface, syncComposerVisibility, syncDashNoFolders,
    syncTopContextLabel, syncTopContextPillAriaLabel, syncTopContextPillVisibility,
  } = emptySurfaces;
  /**
   * 顶栏 pill 的未提交改动角标。数据源是 status_line 事件里现成的 git 段——不发 git:status、不加轮询。
   * 角标记住自己属于哪个 cwd（dataset.cwd），供 syncTopContextLabel 判断换区后是否该清零。
   */
  function updateWorkspaceChangeBadge(git) {
    if (!topContextChanges) return;
    const text = formatWorkspaceChangeBadge(git);
    topContextChanges.textContent = text;
    topContextChanges.classList.toggle('hidden', !text);
    // 有文案时对 AT 可见；空/隐藏时继续藏（#366）
    topContextChanges.setAttribute('aria-hidden', text ? 'false' : 'true');
    topContextChanges.dataset.cwd = currentCwd || '';
    syncTopContextPillAriaLabel();
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
    // 图标字形节点：settings 用 [data-spin]；compose ↻ 无 data-spin，落在内层 span（spinEl 是整颗按钮）。
    const iconGlyphEl = () => btn.querySelector('[data-spin]')
      || (spinEl !== btn ? spinEl : null)
      || btn.querySelector('span')
      || btn;
    // 有 [data-label] 改文案；纯图标钮改字形+色（手机无 hover，只改 title 等于没反馈）。
    // 超时 / ack ok:false 必须同样可见，不能只 restore（面板盖住消息流时 addBar 也看不见）。
    const showFeedback = (ok) => {
      const labelEl = btn.querySelector('[data-label]');
      if (labelEl) {
        if (labelEl.dataset.reverting === '1') return;
        const original = labelEl.textContent;
        labelEl.dataset.reverting = '1';
        labelEl.textContent = ok ? t('✓ 已刷新') : t('刷新失败');
        setTimeout(() => {
          labelEl.textContent = original;
          delete labelEl.dataset.reverting;
        }, 2000);
        return;
      }
      if (btn.dataset.iconReverting === '1') return;
      const glyph = iconGlyphEl();
      const originalText = glyph.textContent;
      const originalTitle = btn.getAttribute('title') || '';
      const hadAria = btn.hasAttribute('aria-label');
      const originalAria = btn.getAttribute('aria-label') || '';
      btn.dataset.iconReverting = '1';
      glyph.classList.remove('text-success', 'text-danger');
      glyph.classList.add(ok ? 'text-success' : 'text-danger');
      glyph.textContent = ok ? '✓' : '✗';
      const feedbackTitle = ok ? t('✓ 已刷新') : t('刷新失败');
      btn.setAttribute('title', feedbackTitle);
      if (hadAria) btn.setAttribute('aria-label', feedbackTitle);
      setTimeout(() => {
        glyph.textContent = originalText;
        glyph.classList.remove('text-success', 'text-danger');
        btn.setAttribute('title', originalTitle);
        if (hadAria) btn.setAttribute('aria-label', originalAria);
        delete btn.dataset.iconReverting;
      }, 2000);
    };
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
      socket.emit('config:refresh', { cwd: currentCwd }, (res) => {
        acked = true;
        restore();
        showFeedback(res?.ok !== false);
      });
      // 兜底：与文件里其它「乐观禁用+超时兜底恢复」操作（session:home/session:switch 等）对齐——
      // ack 丢了也不能让按钮永久卡在禁用+转圈态；超时须在图标上显失败，不只靠 addBar。
      setTimeout(() => {
        if (acked) return;
        restore();
        showFeedback(false);
        addBar(t('刷新无响应，请检查网络后重试'), 'text-danger');
      }, 4000);
    };
  }


  // onDone：历史渲染真正落地（含 renderHistoryBubbles 内部分块 requestIdleCallback）后触发，供未读胶囊
  // 判断"此刻 DOM 已稳定、可以查 topLevelBubbles() 定位锚点"——只有 bindView 的 sync:since 回调会传，
  // onHistoryAppend（只读镜像追平）不传，维持原样不受影响。
  // cwd 缺省取【驾驶轴】而不是 currentCwd：transcript 落在会话实际所在的那棵树里，而 currentCwd 是
  // 工作区轴，托管 worktree 的会话恒为父仓。拿父仓去查，server 的 sessionFileExists 必然 false →
  // ack 回 { messages: [], error: '会话不存在' } → 灰行「历史消息加载失败」。
  // 2026-09-13 真机：首次点开（bindView 传 entry.cwd，驾驶轴）好好的，锁屏回来走
  // reloadCurrentFromHistory（用缺省值）就必failed——所以症状是「会出现，但不是百分百」。
  function loadHistory(sessionId, cwd = drivingCwdOf(displayedInstanceId), onDone) {
    if (!sessionId) return;
    const reqInstanceId = displayedInstanceId; // WS-001：捕获发起时的视图目标（代次）
    // 发起时那一轮在不在跑：在跑的话，读盘那一刻没配上结果的工具可能随后跑完，渲染收尾时不能判它中止（PR #233 review）
    const turnRunningAtRequest = _turnRunning;
    // SS-ORDER：从这里到历史真正落地是一段可观的窗口（socket 往返 + renderHistoryBubbles 的分块
    // 渲染，2000 条约 50 块）。期间镜像追平的 history_append 完全可能插进来——它是 out-of-band，
    // 不进 replay buffer，挡不住。扣住它们，等历史落地后按原顺序放行（见 history-load-gate.js）。
    const gateHandle = historyLoadGate.begin(reqInstanceId);
    // 必须用 socket.timeout()：裸 ack 在断线时会被 socket.io-client 的 _clearAcks() 直接 delete 掉
    // 且【不调用】（只有 withError 的才回调），于是这个回调永不执行——闸门不 abort 也不 release，
    // 手机锁屏/切后台就能触发。带 timeout 后断线会以 err 形式回调，下面 err 分支负责收尾。
    socket.timeout(HISTORY_ACK_TIMEOUT_MS).emit('session:history', { sessionId, cwd }, (err, res) => {
      // 之后同一实例又发起了一次加载（手动「重新加载」、gap 重载）：这一轮整段作废，收尾归新一轮。
      // 排在 err 分支之前——超时的旧 ACK 不能 hideLoadingCard 把新一轮的加载卡收掉（#354 review）
      if (historyLoadGate.superseded(gateHandle)) {
        logClientEvent('recv', `[HISTORY_RENDER] 上一轮历史回执迟到，已作废（之后又发起了新一轮加载） session=${sessionId} instance=${reqInstanceId}`);
        return;
      }
      // ★ 这里必须 release+drain 而【不是】abort：ACK 失败 ≠ 视图已切走。超时（15s）时连接常常还活着，
      // 断线时也可能不触发全量重载，而扣住的那些 history_append 是 out-of-band 的单程票——不进 replay
      // buffer，server 的 catch-up 基线又已前移，abort 掉就是永久丢失（终端在跑、手机上少几条，直到
      // 用户重进或刷新才补上）。无条件 flush 是安全的，有两层现成守卫兜着：① release() 对 stale handle
      // 返回 []，上一轮的迟到 err 动不了当前轮的队列；② onHistoryAppend 的 viewingInstanceId 守卫会丢弃
      // 不属于当前视图的事件。于是「视图已切走」时它与 abort 完全等价，只在「视图还在」时多放行——正是
      // 要修的那一格。同款取舍见 processChunk 的中断路径与闸门看门狗：宁可顺序稍差，绝不静默吞消息。
      if (err) { hideLoadingCard(); flushHeldHistoryAppends(gateHandle); onDone?.(); return; }
      // WS-001：迟到 ACK 守卫——发起后若已切走（会话或实例变），丢弃本回调。否则 A 的历史会被 renderHistoryBubbles
      // 追加进当前 B 的 DOM，且 hideLoadingCard 抹掉 B 的 loading 卡。对齐 onHistoryAppend 的 viewingInstanceId 守卫。
      if (displayedSessionId !== sessionId || displayedInstanceId !== reqInstanceId) { historyLoadGate.abort(gateHandle); return; }
      if (drivingCwdOf(reqInstanceId) !== cwd) { historyLoadGate.abort(gateHandle); return; }
      hideLoadingCard();
      const msgs = res?.messages || [];
      if (!msgs.length) {
        if (res?.error) addBar(t('历史消息加载失败'), 'text-ink-faint');
        crashNotices.restore(sessionId);
        flushHeldHistoryAppends(gateHandle);
        onDone?.();
        return;
      }
      const noticeBar = addBar(historyLoadedNotice(msgs.length, res?.total), 'text-ink-faint');
      renderHistoryBubbles(msgs, () => {
        // 渲染途中切走时 renderHistoryBubbles 也会调这里（为了放行历史闸），那时补提示就补进了别的会话（PR #245 review）
        if (displayedSessionId === sessionId && displayedInstanceId === reqInstanceId) crashNotices.restore(sessionId);
        // 前台任务快照随 sync:since 先到、那时卡还没从历史渲染出来——卡落地后再挂一次「后台运行」
        foregroundTasks.render();
        flushHeldHistoryAppends(gateHandle);
        onDone?.();
      }, { fullReload: true, turnRunningAtRequest, noticeBar, superseded: () => historyLoadGate.superseded(gateHandle) });
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

  // 【气泡上不挂长按】（2026-10-26）长按曾是分叉的入口（O136 起还认 Android 的 contextmenu 并拦下），
  // 真机上系统选字照样出来、分叉确认又盖在上面，想复制一段文字复制不了。浏览器没有「保留系统选字、
  // 同时把长按另作他用」的可靠做法，于是长按整个还给系统：入口只剩 assistant 操作栏的「分叉」按钮；
  // user 气泡原来那个「丢弃这条及之后」就是 /rewind 的「只恢复对话」，服务端同一个 planRewind。
  async function requestSessionFork(bubble) {
    // 【锚点不再由前端算】只送这条气泡自己的 uuid，真正的 upToMessageId 由服务端对着
    // transcript 算（见 sessions/rewind-plan.js 的 planFork）。前端 DOM 里工具卡没有 uuid，
    // 「保留轮尾部是 tool_result」这种形态在这一侧结构上就看不见，算不对。
    const ownUuid = bubble.dataset.uuid || null;
    if (!ownUuid || !displayedSessionId) return;
    // 快照：确认框等待用户点击期间，任何与本地操作无关的 instances 广播都可能改写 cwd/
    // displayedSessionId（同 loadHistory 的 await 前快照+await 后重新校验模式）——不快照会把 A 会话
    // 消息的 anchor 和 await 后已变成 B 的 cwd/sessionId 拼到一起发出去。
    // cwd 取驾驶轴：服务端按它找 transcript、也在那里开分叉出来的会话。worktree 会话的 currentCwd 是父仓，
    // 拿它分叉就是「会话不存在」。
    const cwdAtRequest = drivingCwdOf(displayedInstanceId), sessionIdAtRequest = displayedSessionId;
    const ok = await appConfirm({
      title: t('从这里分叉新会话？'),
      body: t('会复制到这条消息为止的对话，创建一个独立的新会话；原会话不受影响。'),
      okText: t('分叉'),
    });
    if (!ok) return;
    if (drivingCwdOf(displayedInstanceId) !== cwdAtRequest || displayedSessionId !== sessionIdAtRequest) {
      addBar(t('会话已切换，分叉已取消，请重新发起'), 'text-info');
      return;
    }
    haptic('tap');
    // keepAnchorTurn 表达语义而非位置：assistant 气泡＝「保留到这一轮」，交给服务端按 transcript 解析。
    socket.emit('session:fork', {
      cwd: cwdAtRequest, sessionId: sessionIdAtRequest, uuid: ownUuid, keepAnchorTurn: true,
    }, res => {
      if (!res?.ok) addBar(res?.error || t('分叉失败'), 'text-danger');
    });
  }

  // 渲染一批历史/追平消息为气泡并追加（loadHistory 与 onHistoryAppend 复用；分块让出主线程 + 一次性 fragment 插入 + 空闲高亮）。
  // 支持文本 / thinking / tool_use / tool_result；sidechain（parentToolUseId）收进可折叠子 agent 卡。
  // fullReload：来自 loadHistory 的全量加载（这批就是会话开头，时间戳基准不看 #messages 里已有内容）
  // 还是来自 onHistoryAppend 的增量追平（要回落读 #messages 尾巴接上前批）。详见 message-timeline.js
  // 的 appendWithTimeToFragment 注释——两者对基准的要求正好相反。
  // 按 clientMessageId 找用户气泡（settledOnly=只要已确认那颗）。用遍历比对 dataset 而不是拼
  // 属性选择器：id 形如 `${Date.now()}-${base36}`，拼进选择器要考虑转义，遍历没有这个坑。
  function findUserBubbleByClientMessageId(id, { settledOnly = false } = {}) {
    if (!id) return null;
    for (const b of messagesEl.querySelectorAll('[data-testid="user-message"]')) {
      if (b.dataset.clientMessageId !== id) continue;
      if (settledOnly && b.classList.contains('opacity-70')) continue;
      return b;
    }
    return null;
  }

  // 全量重载后处置被 clearView 保住的未确认气泡。
  // 历史已带回这条 → 丢乐观气泡并移交 clientMessageId（否则随后 user_message 会再新建一颗）。
  // 历史还没有 → 移到末尾。必须在 append 之后做：渲染前先摘会闪一下。
  // 交给 outbox 的气泡多一道闸（canTextClaimPendingBubble）：没有证据说它进了 transcript 就不认领，直接移到末尾。
  // 走 dropPendingUserBubble，避免 sessionDomCache 把已删节点复活。
  function settleCarriedPendingBubbles(msgs) {
    // 认 data-carried 而不只是 .opacity-70：被保住的气泡可能已在历史回包之前被回显认领转正（见 clearView）。
    // 转正过的就是服务端收下了的证据，可以让历史认领，不必再过 canTextClaimPendingBubble 那道闸。
    for (const bubble of [...messagesEl.querySelectorAll('[data-testid="user-message"][data-carried]')]) {
      const carriedText = bubble.dataset.carriedText ?? '';
      delete bubble.dataset.carried;
      delete bubble.dataset.carriedText;
      const settled = !bubble.classList.contains('opacity-70');
      const tDiv = bubble.querySelector('.whitespace-pre-wrap');
      const claim = (settled || canTextClaimPendingBubble({
        outboxOutcome: bubble.dataset.outboxOutcome ?? null,
        maybeSent: Boolean(bubble.dataset.outboxMaybeSent),
      }))
        ? findHistoryClaimForPending({
          text: tDiv ? tDiv.textContent : carriedText,
          attNames: bubble.dataset.attNames || '',
          messages: msgs,
        })
        : null;
      if (!claim) {
        messagesEl.appendChild(bubble); // 同一节点 appendChild = 移动；已绑的监听器与 dataset 都还在
        continue;
      }
      const heir = claim.uuid
        ? [...messagesEl.querySelectorAll('[data-testid="user-message"]')].find(b => b !== bubble && b.dataset.uuid === claim.uuid)
        : null;
      if (!heir) {
        // 认领到了历史里的那条，却定位不到它渲染出的气泡（msg.uuid 缺失——真实 transcript 每行都有，
        // 但不做这个假设）。此刻丢弃乐观气泡会让 clientMessageId 无处安放，随后的 user_message 认领
        // 不到就再建一颗，那是第三颗，比重复更糟。降级成「历史还没有这条」的处理：移到末尾留着。
        // 最坏结果是两颗（等同未修前），但绝不会丢消息、也不会多出第三颗。
        messagesEl.appendChild(bubble);
        continue;
      }
      if (bubble.dataset.clientMessageId) heir.dataset.clientMessageId = bubble.dataset.clientMessageId;
      // 借 dropPendingUserBubble 撤气泡：它的原设计语义是「确定没发出去」，这里是反过来的
      // 「确定已经发出去了（历史都带回来了）」——但要做的事完全相同：摘出 DOM ＋ 清掉
      // sessionDomCache 里持有的那份引用（否则切走再切回它会原样复活，见该函数注释）。
      dropPendingUserBubble(bubble);
    }
  }

  // cardsOnly：这批条目【全部】属于某张子代理卡（懒加载 subagent:flow 的回包），不进主流。
  // 用它抑制三个页面级副作用——尤其 scrollBottom：展开一张历史卡片时把页面滚到底是灾难性的。
  // 之所以仍走本函数而不另写一个渲染器：renderOne 是 live/history 共用的那一份，
  // 另写一个就等于再造一套平行实现，而"刷新前后同构"正是这条链要保证的东西。
  // 历史没画完、屏幕上只剩「加载了 N 条历史消息」提示条时（#307，根因未明），在那条提示条上原地给「重新加载」：
  // 走 reloadCurrentFromHistory（先清屏再拉），不刷新整页，也不会和残留的内容叠成两份。
  function offerHistoryReload(bar) {
    if (!bar?.isConnected || bar.querySelector('[data-testid="history-reload"]')) return;
    const btn = el('<button type="button" class="ml-2 underline text-accent" data-testid="history-reload"></button>');
    btn.textContent = t('重新加载');
    btn.addEventListener('click', reloadSessionByHand);
    bar.appendChild(btn);
  }
  // 手动重载（提示条上的「重新加载」与顶栏「⋯」）：clearView 连审批 / 提问卡一起清，session:history 又不带待办——
  // 画完后照重连那条路补一次 sync:since，用回执里的 pending 快照重建，否则服务端还在等批、手机上却没了卡（#354 review）
  function reloadSessionByHand() { reloadCurrentFromHistory(() => requestSync({ probe: false })); }

  // 顶栏「⋯」→「重新加载本会话」（#307）：原地按钮只挂在已知的两处停下的地方上，别的路径停住时靠这一项。
  // 没在看会话时（首页等）不可点，判据同 reloadCurrentFromHistory 自己的守卫。
  const moreModal = $('moreModal');
  const closeMoreMenu = () => { if (moreModal?.classList.contains('sheet-open')) closeSheet(moreModal); };
  $('btnMore')?.addEventListener('click', () => {
    if (!moreModal) return;
    const item = $('moreReloadSession');
    if (item) item.disabled = !displayedSessionId;
    openSheet(moreModal);
  });
  $('moreReloadSession')?.addEventListener('click', () => { closeMoreMenu(); reloadSessionByHand(); });
  $('moreCancel')?.addEventListener('click', closeMoreMenu);
  moreModal?.addEventListener('click', e => { if (e.target === moreModal) closeMoreMenu(); });
  moreModal?.addEventListener('keydown', e => { if (e.key === 'Escape') closeMoreMenu(); });

  // noticeBar：loadHistory 刚插的那条「加载了 N 条」提示条。渲染半路停下时，在它上面给「重新加载」（offerHistoryReload）。
  // superseded：loadHistory 传入，这一轮之后同实例又发起了加载时为真（见 processChunk 开头）。
  function renderHistoryBubbles(msgs, onDone, { fullReload = false, cardsOnly = false, turnRunningAtRequest = false, noticeBar = null, superseded = null } = {}) {
    if (!msgs?.length) { onDone?.(); return; }
    const frag = document.createDocumentFragment();
    // 历史里的图片按需取，坐标在【渲染时】快照（同子代理卡的 flowSid）：格子会留在 DOM 里跨越会话切换，
    // 进入可视区时再读会按别的会话去取。cwd 走驾驶轴，与 loadHistory 的 session:history 同一个值。
    const imageScope = { sessionId: displayedSessionId, cwd: drivingCwdOf(displayedInstanceId), instanceId: displayedInstanceId };
    // 历史卡片「展开全文」的会话坐标：同图片；子代理里的卡带上那次 Agent 调用的 id，服务端到子代理文件里找
    const histFullScope = msg => ({ sessionId: imageScope.sessionId, cwd: imageScope.cwd, agentToolUseId: msg.parentToolUseId || null });
    // fragment 是线性构建的：基准 seed 一次之后顺着往下带，不必每条反向扫。
    //  · 全量加载：null —— 这批就是整个会话的开头。
    //  · 增量追平：#messages 尾巴的戳 —— 接上前一批。
    const stampIntoFrag = messageTimeline.beginFragment(frag, {
      seedPrevTs: fullReload ? null : messageTimeline.lastTimestampIn(messagesEl),
    });
    const codeBlocks = [];
    // histToolCards/histSubCards 是模块级持久 Map（跨 tick 配对，见其声明处注释），本函数只读写不新建。
    const ensureHistSub = (parentId, subagentType) => {
      let c = histSubCards.get(parentId);
      if (c) return c;
      // 槽位与 live 的 ensureSubagentCard 逐项同构（合卡后 history 的 tool_result 分支同样靠
      // .t-status / .t-out / dataset.toolName 落结果）——两边模板漂了就会出现「刷新后结论不见」。
      const wrap = el(`
        <details class="msg-frame subagent-card rounded-lg bg-surface border border-line text-xs" data-testid="subagent-card" data-history="1">
          <summary class="px-3 py-2 cursor-pointer select-none">
            <div class="flex items-center gap-2 min-w-0">
              <span class="t-status status-icon shrink-0"></span><span class="sa-title text-ink font-medium truncate"></span>
            </div>
            <div class="sa-lasttool mt-0.5 pl-5 text-ink-faint truncate hidden" data-testid="subagent-last-tool"></div>
          </summary>
          <div class="t-in mx-3 mb-1 text-ink-soft break-words hidden"></div>
          <div class="t-full-host px-3 pb-1 space-y-1">
            <pre class="t-out overflow-x-auto whitespace-pre-wrap break-words text-ink-faint hidden"><code></code></pre>
          </div>
          <div class="sa-body px-3 pb-2 pl-4 border-l-2 border-accent/40 ml-3 space-y-1"></div>
        </details>`);
      wrap.dataset.parentId = parentId;
      const titleEl = wrap.querySelector('.sa-title');
      // 与 live 路径 ensureSubagentCard 对齐：type 来自 inputSummary 的 subagent_type，不硬编码 null——
      // 否则历史回放/刷新页面后卡片标题从「🤖 Explore」这类具体类型退化成泛泛的「🤖 子 agent」。
      const type = subagentType != null && String(subagentType).trim() ? String(subagentType).trim() : null;
      titleEl.textContent = formatSubagentCardTitle({ subagentType: type, running: false });
      c = { el: wrap, body: wrap.querySelector('.sa-body'), titleEl, type, loaded: false };
      histSubCards.set(parentId, c);
      // 展开时才拉这一个 agent 的流水。主 transcript 里没有子代理的执行内容（全在
      // <sessionId>/subagents/agent-*.jsonl），不拉的话这张卡刷新后就是个空壳。
      // 【为什么不在渲染历史时一起拉】那批文件实测中位 360KB、最大 1.2MB，且绝大多数卡不会被展开。
      // cwd/sessionId 在【建卡时】快照，不在点击时读：卡会留在 DOM 里跨越会话切换（同 tool:preview
      // 快照 viewingInstanceId 的理由），点击时读会把 A 会话的卡按 B 的坐标去拉。
      const flowCwd = currentCwd, flowSid = displayedSessionId;
      wrap.addEventListener('toggle', () => {
        if (!wrap.open || c.loaded) return;
        c.loaded = true;
        // 上一次请求超时留下的占位行不算「已有内容」——它写的正是「请重试」，留着会被下面那道
        // childElementCount 守卫挡住，于是 c.loaded=false 放开的重试永远发不出去，提示自相矛盾。
        for (const n of [...c.body.children]) if (n.dataset?.outboxRetryable === '1') n.remove();
        if (c.body.childElementCount > 0) return; // 已有内容（老会话 sidechain 落在主 transcript 里）
        if (!flowSid) return;
        const hint = el('<div class="text-ink-faint text-xs" data-testid="subagent-flow-hint"></div>');
        hint.textContent = t('正在读取子代理执行记录…');
        c.body.appendChild(hint);
        socket.timeout(8000).emit('subagent:flow', { cwd: flowCwd, sessionId: flowSid, toolUseId: parentId }, (err, res) => {
          hint.remove();
          // 【渲染前再核一次「还在同一个会话吗」】上面那对快照保证的是**拉对了数据**，不保证
          // 响应回来时用户还没切走。切会话会清掉 histSubCards，于是下面的 renderHistoryBubbles
          // (..., {cardsOnly:true}) 会把这张旧卡在**新会话的消息流里**重建一遍——上一个会话的
          // 执行记录凭空出现在另一个对话里，且刷新后又消失，正是「凭空多出来的气泡」那类症状，
          // 只不过来源是会话切换而不是 toolUseId 归属。两道闸各挡一个方向，缺一不可。
          if (displayedSessionId !== flowSid || currentCwd !== flowCwd) return;
          // 只收属于这张卡的条目：服务端已按 toolUseId 归属，这里再挡一道——漏进主流的条目
          // 会变成凭空多出来的气泡，而那是刷新后才出现、极难归因的一类症状。
          const items = Array.isArray(res?.items) ? res.items.filter(m => m?.parentToolUseId === parentId) : [];
          if (err || !res?.ok || !items.length) {
            if (err) c.loaded = false; // 超时不是终态：折叠再展开时允许重新拉取
            const empty = el('<div class="text-ink-faint text-xs" data-testid="subagent-flow-empty"></div>');
            empty.textContent = err ? t('请求超时，请重试') : t('没有可显示的子代理执行记录');
            // 标记可重试：下次展开时先摘掉它，否则 childElementCount 守卫会把重试挡回去。
            if (err) empty.dataset.outboxRetryable = '1';
            c.body.appendChild(empty);
            return;
          }
          renderHistoryBubbles(items, null, { cardsOnly: true });
          if (res.truncated) {
            const more = el('<div class="text-ink-faint text-xs" data-testid="subagent-flow-truncated"></div>');
            more.textContent = t('（只显示最近的部分记录）');
            c.body.appendChild(more);
          }
        });
      });
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
      // /compact 的压缩摘要（O115）：history.js 换成了这个标记——与 live 侧 system「上下文已压缩」同一观感，
      // 不是用户气泡（摘要是给模型的上下文，终端主视图也不显示它）
      if (msg?.kind === 'compact_summary') {
        const bar = el('<div class="msg-frame text-center text-xs text-ink-faint" data-testid="compact-marker"></div>');
        bar.textContent = t('上下文已压缩');
        appendNode(bar, msg);
        return;
      }
      if (msg?.kind === 'thinking') {
        const wrap = el(`
          <details class="msg-frame thinking text-xs text-ink-faint">
            <summary class="px-3 py-1.5">${t('💭 思考过程')}</summary>
            <pre class="t-body px-3 pb-2 whitespace-pre-wrap"></pre>
          </details>`);
        wrap.querySelector('.t-body').textContent = localizeServerThinkingText(msg.content);
        appendNode(wrap, msg);
        return;
      }
      if (msg?.kind === 'tool_use') {
        // UX-002：历史回显与 live 一致——收起态带 inputSummary 截断；Task 清单工具特化
        const histTitle = formatTaskToolTitle(msg.name, msg.inputSummary) ?? formatToolCardTitle(msg.name || 'tool', msg.inputSummary);
        const card = el(`
          <details class="msg-frame toolcard text-xs">
            <summary class="pl-2 pr-1 py-1 flex items-center gap-2 min-w-0">
              <span class="t-status status-icon shrink-0"></span><span class="t-name text-ink-soft truncate">${esc(histTitle)}</span>
            </summary>
            <div class="pl-2 pr-1 pb-2 space-y-1">
              <pre class="t-in overflow-x-auto whitespace-pre-wrap break-words text-ink-soft"><code></code></pre>
              <pre class="t-out overflow-x-auto whitespace-pre-wrap break-words text-ink-faint hidden"><code></code></pre>
            </div>
          </details>`);
        setStatusIcon(card.querySelector('.t-status'), 'pending');
        card.dataset.toolName = msg.name || ''; // tool_result 无 name，结果特化渲染从卡上取
        if (msg.toolUseId) card.dataset.toolUseId = msg.toolUseId; // 同 live
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
        // 主链 Agent/Task：预建折叠卡 + 合卡（口径与 live 的 isMergedSpawn 逐项相同，
        // 含 Workflow 那条例外）。两边不同口径的话，刷新前后卡的张数会对不上。
        const histSpawn = !msg.parentToolUseId && !msg.isSidechain && isSpawnToolName(msg.name) && msg.toolUseId;
        const histMergedSpawn = histSpawn && msg.name !== 'Workflow';
        if (histSpawn) {
          const subType = extractInput(msg.inputSummary, ['subagent_type', 'subagentType'], '');
          const sa = ensureHistSub(msg.toolUseId, subType || null);
          if (histMergedSpawn) {
            // 同 live 的 adoptSpawnCard：接管状态/输入/结果三槽 + 改写 histToolCards 指向，
            // 让本文件下方 tool_result 分支（setStatusIcon / .t-out / dataset.toolName）零改动生效。
            sa.el.dataset.toolName = msg.name || '';
            sa.el.dataset.toolUseId = msg.toolUseId;
            setStatusIcon(sa.el.querySelector('.t-status'), 'pending');
            // 同 live 的 adoptSpawnCard：只显 description，不铺原始输入 JSON
            const histInEl = sa.el.querySelector('.t-in');
            const histDesc = formatSpawnDescription(msg.inputSummary);
            if (histInEl && histDesc) {
              histInEl.textContent = histDesc;
              histInEl.classList.remove('hidden');
            }
            histToolCards.set(msg.toolUseId, sa.el);
          }
        }
        if (!histMergedSpawn) {
          appendNode(card, msg);
          const widgetNode = msg.widget ? widgets.render(msg.widget) : null; // 同 live：图紧跟工具卡
          if (widgetNode) appendNode(widgetNode, msg);
        }
        return;
      }
      if (msg?.kind === 'tool_result') {
        const card = msg.toolUseId ? histToolCards.get(msg.toolUseId) : null;
        if (!card) {
          const orphan = el(`
            <details class="msg-frame toolcard text-xs">
              <summary class="pl-2 pr-1 py-1 flex items-center gap-2">
                <span class="t-status status-icon shrink-0"></span>
                <span class="text-ink-soft">tool</span>
              </summary>
              <div class="pl-2 pr-1 pb-2 space-y-1">
                <pre class="t-out overflow-x-auto whitespace-pre-wrap break-words text-ink-faint"><code></code></pre>
              </div>
            </details>`);
          setStatusIcon(orphan.querySelector('.t-status'), msg.ok === false ? 'error' : 'ok');
          const code = orphan.querySelector('.t-out code');
          if (code) {
            code.textContent = formatToolSummary(msg.outputSummary || '');
            code.className = toolOutputHighlightClass(code.textContent);
            codeBlocks.push(code);
          }
          if (msg.toolUseId && isToolSummaryTruncated(msg.outputSummary)) attachToolFullExpand(orphan, msg.toolUseId, histFullScope(msg));
          const orphanShots = transcriptImages.render(msg.images, imageScope);
          if (orphanShots) orphan.querySelector('.t-out')?.parentElement.appendChild(orphanShots);
          appendNode(orphan, msg);
          return;
        }
        // AskUserQuestion 同 live：按 CLI 文案分已回答 / 没回答；旧 transcript 的 deny 格式答案不再显成 ❌（#455）
        const askView = card.dataset.toolName === 'AskUserQuestion' ? askQuestionResultView({ ok: msg.ok, text: msg.outputSummary }) : null;
        setStatusIcon(card.querySelector('.t-status'), askView ? askView.kind : msg.ok === false ? 'error' : 'ok');
        if (msg.outputSummary) {
          const out = card.querySelector('.t-out');
          const code = out.querySelector('code') || out;
          // Task 清单工具结果 → ☐/◐/☒ 清单文本（同 live；历史是 block.content 文本形态）
          const taskText = msg.ok !== false ? renderTaskToolResultText(card.dataset.toolName, msg.outputSummary) : null;
          code.textContent = taskText ?? formatToolSummary(askView ? askView.text : msg.outputSummary);
          if (!taskText && code !== out) {
            code.className = toolOutputHighlightClass(code.textContent);
            codeBlocks.push(code);
          }
          if (taskText) card.open = true; // 清单即结果本体（同 live）
          out.classList.remove('hidden');
          // 历史卡片的「展开全文」：全文只能从 transcript 取，请求带上这个会话的坐标（验收 O55）
          if (!taskText && msg.toolUseId && isToolSummaryTruncated(msg.outputSummary)) attachToolFullExpand(card, msg.toolUseId, histFullScope(msg));
        }
        const shots = transcriptImages.render(msg.images, imageScope);
        if (shots) (card.querySelector('.t-out')?.parentElement || card).appendChild(shots);
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
      if (isUser) {
        if (msg.content) appendUserText(bubble, msg.content);
      } else {
        bubble.innerHTML = render(msg.content || '');
        bubble.querySelectorAll('pre code').forEach(b => codeBlocks.push(b));
        injectCodeCopyButtons(bubble);
      }
      // E18：历史附件（history.js 解析 [附件] 块所得）→ 可点击 chip，按需拉原图；纯附件消息（content 空）
      // 渲染 chip-only 气泡、跳过复制按钮（复制空文本无意义）
      if (isUser && Array.isArray(msg.attachments) && msg.attachments.length) {
        bubble.appendChild(buildAttachmentWrap(msg.attachments, Boolean(msg.content)));
      }
      // 终端 / 桌面端里贴进对话的图（transcript 里的图片块，不是 CCM 上传的附件）
      const pasted = isUser ? transcriptImages.render(msg.images, imageScope) : null;
      if (pasted) bubble.appendChild(pasted);
      if (msg.content) appendCopyAction(bubble, () => msg.content || '', isUser ? 'right' : 'left', msg.uuid);
      if (isUser && msg.origin === 'auto-continuation') tagAutoContinueBubble(bubble); // 与 live 的 user_message 同一判据
      bubble.dataset.topLevel = '1'; // 未读角标锚点定位用（jumpToUnreadAnchor）：仅主链用户消息/assistant文字回复计入，子agent/侧链在上面已提前 return
      if (msg.uuid) bubble.dataset.uuid = msg.uuid;
      // 历史条目的 timestamp 是 transcript 原样透传的 ISO 串（src/sessions/history.js）。
      // 节点先进游离的 frag，故 prevTs 优先读 frag、空了再回落 #messages（增量追加场景）。
      stampIntoFrag(bubble, msg.timestamp, msg.role);
    }

    // 中断检查用「渲染发起时 #messages 归属哪个实例」的快照；bindView 是唯一整体改写 #messages 的地方，
    // displayedInstanceId 代表此刻 DOM 安全可写给谁。分块跨越一次切视图时直接丢弃 frag，不再调度、不
    // appendChild——frag/codeBlocks/histSubCards/histToolCards 全是本次调用的局部变量，中止后自然被 GC，
    // 不需要额外清理；用户若切回同一会话，因没有 sessionDomCache 缓存会自然触发一次完整重渲染。
    //
    // 注意：不得放宽为「同 sessionId 即可续渲」——同会话 instance 置换时 bindView 会 clearView + 重新
    // loadHistory，旧 frag 若仍落地会与新一轮历史叠加成重复气泡。跨 instance 一律中断，由新 bindView 负责。
    const targetInstanceId = displayedInstanceId;
    const targetSessionId = displayedSessionId;
    let i = 0;
    function processChunk() {
      // ★ 中断也必须通知收尾。onDone 是 flushHeldHistoryAppends 的唯一调用点，早年这里直接 return
      // 把它一并跳过了：闸门既不 release 也不 abort，永久开着，此后该实例每条 history_append 都被
      // 静默吞掉——终端在跑、手机再也不刷新、无任何报错。此刻视图已切走，flush 出来的事件会被
      // onHistoryAppend 的 viewingInstanceId 守卫正常丢弃，所以只关闸、不会污染新视图。
      if (displayedInstanceId !== targetInstanceId) {
        // #307 观测：这一趟画的东西整段作废。同一会话换了实例却没有再全量重载的话，屏幕就停在只有提示条
        logClientEvent('recv', `[HISTORY_RENDER] 渲染途中实例变了，放弃本次历史渲染 session=${targetSessionId} instance=${targetInstanceId}→${displayedInstanceId} 已渲染 ${i}/${msgs.length}`);
        if (displayedSessionId === targetSessionId) offerHistoryReload(noticeBar);
        onDone?.();
        return;
      }
      // 实例没变、但同一实例上又发起了一次全量加载（手动「重新加载」）：上面的守卫拦不住，这一轮整段作废——
      // 不再 renderOne（它会写进新一轮刚清空的配对表）、不插 frag。也不调 onDone：闸门已归新一轮，
      // 旧 handle 的 release 本来就拿不到东西，crashNotices.restore 反而会在新一轮半路多补一份（#354 review）
      if (superseded?.()) return;
      const { end, done } = nextHistoryRenderChunk({ processed: i, total: msgs.length, chunkSize: HISTORY_RENDER_CHUNK_SIZE });
      for (; i < end; i++) {
        try {
          renderOne(msgs[i]);
        } catch (error) {
          // #307 观测：分块链在这里断了，后面的块不再调度、frag 不插入、onDone 不调（历史闸要等看门狗）。
          // 根因未修：照旧抛出去（全局错误上报照常记「前端错误」），只多记一条带坐标的日志、给原地重新加载。
          logClientEvent('error', `[HISTORY_RENDER] 渲染第 ${i + 1}/${msgs.length} 条历史时抛错，后面的都没画出来 session=${targetSessionId} instance=${targetInstanceId} 当前=${displayedInstanceId} 已渲染 ${i}/${msgs.length}：${error?.message || error}`);
          if (displayedSessionId === targetSessionId) offerHistoryReload(noticeBar);
          throw error;
        }
      }
      if (!done) {
        scheduleIdle(processChunk, { timeout: HISTORY_RENDER_CHUNK_IDLE_TIMEOUT_MS });
        return;
      }
      if (!cardsOnly) leaveStartScreen();
      messagesEl.appendChild(frag); // 一次性插入，避免 N 次 live-DOM reflow（分块只让解析让出主线程，插入仍是一次性）
      // cardsOnly 下 frag 恒空：调用方已过滤成「只有 parentToolUseId 的条目」，appendNode 全部路由进卡
      // 历史已落地：把 clearView 保住的未确认气泡与刚回来的历史收敛成一条（见函数注释）。
      // 必须排在 scrollBottom 之前——它可能移动/删除气泡，位置定下来再落底才不会滚错。
      if (fullReload) settleCarriedPendingBubbles(msgs);
      // 全量重载完还没配上 tool_result 的工具卡：会话此刻没在跑（没有在途轮、也不是终端在驾驶），结果就不会再来了。
      // 重启后过期的审批留下的正是这种 tool_use——画成「进行中」会让那一行永远转着（验收 O30）。标中性终态「已中止」。
      if (fullReload && !cardsOnly && !_turnRunning && !turnRunningAtRequest && !mirrorReadonlySid) {
        for (const card of histToolCards.values()) setStatusIcon(card.querySelector('.t-status'), 'aborted');
      }
      if (!cardsOnly) scrollBottom(true);
      if (codeBlocks.length) {
        const doHighlight = () => codeBlocks.forEach(b => { try { hljs.highlightElement(b); } catch { /* 高亮失败不影响显示 */ } });
        scheduleIdle(doHighlight, { timeout: 2000 });
      }
      onDone?.(); // DOM 真正稳定（frag 已插入）之后才通知——未读胶囊的 topLevelBubbles() 查询依赖这个时机
    }
    processChunk();
  }

  // 历史落地后放行被扣住的追平事件。此刻 DOM 已是最终态，走正常 onHistoryAppend 即可——
  // 顺序天然接在历史之后，时间戳也以真正的前一条为基准（不会再误判成会话首条）。
  // ★ 必须串行：renderHistoryBubbles 对 >HISTORY_RENDER_CHUNK_SIZE 条是【异步】的（分块让出主线程，
  // frag 最后才一次性 appendChild）。若在这里同步 for 循环挨个调 onHistoryAppend，一个 60 条的批次
  // 会先挂起、紧随其后的 3 条批次却同步落地——后到的排到先到的前面，而且它 seed 基准读的是尚未
  // 收到前一批的 #messages，又会凭空多一条日期分隔行。那正是本闸门要消灭的两个症状，等于在闸门
  // 内部原样复现一遍。所以等前一批真正落地（onDone）再放下一批。
  function drainHeldHistoryAppends(events) {
    let i = 0;
    const next = () => { if (i < events.length) onHistoryAppend(events[i++], next); };
    next();
  }
  function flushHeldHistoryAppends(handle) {
    drainHeldHistoryAppends(historyLoadGate.release(handle));
  }
  // 看门狗兜底放行：走与正常放行完全相同的路径。到这里说明某条早退路径没能收尾（见 history-load-gate.js），
  // 此刻 DOM 未必是最终态、顺序可能不完美——但比静默吞掉消息好得多。
  historyLoadGate.onTimeout(drainHeldHistoryAppends);

  // 只读「追平」：server 轮询「正在终端 CLI 里跑」的会话 transcript，检测到【外部新落定】消息 → history_append。
  // 仅渲染当前查看会话。局限：看不到实时 thinking / 在跑子 agent——它们不落盘，终端把消息落定后才追加得到。
  // onDone：本批真正落地（frag 已插入 #messages）后回调。仅串行放行队列时需要——见 flushHeldHistoryAppends。
  function onHistoryAppend(ev, onDone) {
    const done = () => onDone?.();
    if (ev.instanceId !== viewingInstanceId) { done(); return; } // 只进当前查看会话（server 已按 viewing 发，这里再兜一层）
    // 拉历史在途：扣住，等历史落地后由 flushHeldHistoryAppends 按原顺序放行。此刻渲染的话，
    // 顺序会排到历史前面，而且是对着尚被清空的 #messages 判定时间戳（会误判成会话首条而多出
    // 一条日期分隔行）——顺序和打戳都得等最终 DOM 就位才算得准。
    if (historyLoadGate.hold(ev)) { done(); return; }
    const msgs = ev.payload?.messages || [];
    if (!msgs.length && !ev.payload?.replace) { done(); return; }
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
      // 满窗滑动全量替换：上面刚 innerHTML='' 清过屏，语义同 loadHistory 的全量加载——
      // 这批就是当前窗口的开头，基准不该回落（此刻回落也读不到东西，显式标注防将来清屏逻辑变动）
      const sid = ev.sessionId;
      if (sid) seenDiskLenBySession.set(sid, msgs.length);
      if (msgs.length) renderHistoryBubbles(msgs, done, { fullReload: true });
      else done();
    } else if (msgs.length) {
      // 追平也是磁盘 history 增量——累加到已见条数，保持切入对账基准准确（见 shouldReloadOnEnter）。
      const sid = ev.sessionId;
      if (sid) seenDiskLenBySession.set(sid, (seenDiskLenBySession.get(sid) || 0) + msgs.length);
      renderHistoryBubbles(msgs, done);
    } else {
      done();
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
    inputEl.placeholder = formatMirrorBannerText({ armed, stale: mirrorStaleFlag, autonomous: mirrorAutonomousFlag, waiting: mirrorWaitingFlag, isWebInitiated: !mirrorCliSeenFlag });
    maybeHintHooksBridge();
    // 兼容：隐藏节点若仍在 DOM，同步文案（不展示）
    if (mirrorBannerText) mirrorBannerText.textContent = inputEl.placeholder;
    if (mirrorBannerIcon) mirrorBannerIcon.textContent = armed ? '⏳' : (mirrorStaleFlag ? '⚠️' : '⏱');
  }

  // 【曾经这里有 reconcileBanners 与 #activityBanner】那条横幅在 spawn 时点亮、显示子代理的
  // description，唯一的生产者是主链 spawn 工具。合卡之后聚合卡在同一时刻就建好了，且带着类型、
  // 用量与最近工具——横幅成了纯复读，2026-09-10 真机同屏看见两处说同一件事。
  // 横幅一撤，仲裁函数的剩余职责只有「隐藏 #mirrorBanner」，而那个节点本就 class="hidden"
  // 且另有一处显式隐它，于是整个仲裁退化成空操作，一并删掉。优先级表（bannerPriority）
  // 随之失去唯一消费者，也从 logic 里退役。
  // 驾驶中点输入区：解释能/不能/硬要怎么做（disabled 吞原生 focus，需主动反馈）。
  function showMirrorComposerHint() {
    if (!mirrorReadonlySid) return;
    const armed = armedTakeoverSid === mirrorReadonlySid;
    const text = formatMirrorComposerHint({ armed, stale: mirrorStaleFlag, autonomous: mirrorAutonomousFlag, waiting: mirrorWaitingFlag, isWebInitiated: !mirrorCliSeenFlag });
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

  function applyMirror(readonly, sessionId, stale = false, observedCli, autonomous = false, waiting = false) {
    const prevRowLock = mirrorRowLock();
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
    mirrorWaitingFlag = effective && waiting;
    if (effective) {
      // observed CLI state 只是镜像展示层，不能写回 Web 实例偏好；未知字段也必须保持未知。
      renderCliPanelState();
    } else if (wasEffective) {
      const external = instancesList.find(i => i.instanceId === displayedInstanceId)?.externalObserved;
      if (external) {
        mirrorObservedCli = external;
        renderCliPanelState();
      } else {
        restoreWebPanelState();
        mirrorObservedCli = { model: null, permissionMode: null, effort: null };
      }
      mirrorWebPanelSnapshot = null;
      _mirrorComposerHintLast = { text: '', at: 0 }; // 解锁后清节流，下次再锁可立刻提示
    } else {
      // 第三分支：本来就不在镜像态、现在也不在——最常见路径，每次 readonly:false 广播都会走这里。
      // silentClear：mirrorReadonlySid 在函数顶部已被置 null（早于这里的分支判断），不加这个参数，
      // 当前模型恰好不支持 effort 又留着非空 currentEffort 时会误发 user:setEffort({level:null})，
      // 把实例档位误清回 auto——对齐 adoptPanelState（同文件 4728/4736 附近）已有写法。
      rebuildEffortOptions(currentModel || cwdDefaultModel, { silentClear: true });
    }
    if (mirrorBanner) mirrorBanner.classList.add('hidden'); // 状态改走 placeholder，横幅恒隐
    document.body.classList.toggle('mirror-readonly', effective); // UX-009
    // UX-010：镜像时强制隐藏忙碌条
    if (effective) setBusy(false);
    if (inputEl) inputEl.disabled = effective;
    refreshMirrorComposerCopy();
    // 附件入口随只读锁：禁点 + 防「选了图却发不出」
    if (btnAttach) {
      btnAttach.disabled = effective;
      btnAttach.classList.toggle('opacity-50', effective);
      btnAttach.classList.toggle('cursor-not-allowed', effective);
      // 与横幅/composer 提示同源的三档措辞（第三处文案面，改一处必须扫这三处）
      btnAttach.title = effective
        ? (mirrorWaitingFlag ? t('只读镜像：终端正在等你操作——点右侧续接可在手机继续')
          : mirrorAutonomousFlag ? t('只读镜像：本会话自主循环执行中——点右侧续接可在手机继续')
            : t('只读镜像：终端会话运行中——点右侧续接可在手机继续'))
        : t('添加附件');
    }
    // 镜像/解锁都走主按钮状态机：镜像时 mode=resume，解锁恢复 send/stop
    updateSendButtonState();
    refreshSessionStatusChips(); // 抽屉里被锁住的那一行跟着标/撤终端态（O86）
    // #289 方案 F：行上终端态以注册表快照为准，快照最多晚 12 秒。锁真正转变时立刻 revalidate 那一行所在目录，
    // 一个往返内换成服务端给的权威态与来源。锁消失时按变化前那把锁找行；行不在已渲染的目录里就不管，
    // 下一轮周期刷新或重开抽屉兜住。
    const rowLock = mirrorRowLock();
    if (mirrorRowLockChanged(prevRowLock, rowLock) && isSessionPanelRevalidateActive() && socket.connected) {
      const sids = [...new Set([prevRowLock?.sessionId, rowLock?.sessionId].filter(Boolean))];
      for (const section of dirSectionNodes.values()) {
        if (sids.some(sid => section.subtree.querySelector(`[data-testid="session-row"][data-session-id="${CSS.escape(sid)}"]`))) {
          section.revalidate?.();
        }
      }
    }
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
    //   （2026-07-12 维护者确认 Phase 8 不做 per-socket 大改、保留现状；见 docs/hard-rules.md §5 AD-5 / mirror-engine 登记。）
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
    applyMirror(readonly, ev.sessionId, stale, ev.payload?.observedCli, !!ev.payload?.autonomous, !!ev.payload?.waiting);
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
      // 保留 autonomous / waiting 标志，避免本地 apply 把「自主循环」「终端在等你」文案抹成「终端会话」（C1）
      applyMirror(true, mirrorReadonlySid, false, undefined, mirrorAutonomousFlag, mirrorWaitingFlag);
      return;
    }
    if (!mirrorStaleFlag) { // 运行中：排队等待，零风险故无需确认弹窗
      armedTakeoverSid = mirrorReadonlySid;
      applyMirror(true, mirrorReadonlySid, false, undefined, mirrorAutonomousFlag, mirrorWaitingFlag);
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
  // anchorUuid：这条气泡自己的权威 uuid。缺了就不挂需要锚点的入口（见下方 align==='left' 分支）。
  function appendCopyAction(container, getText, align, anchorUuid) {
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
      // UX-012 / #362：填入输入框放在用户气泡；只回填原文，不 rewind / 不改历史
      const rewrite = el(`
        <button class="msg-action-btn hit-44" title="${t('将原文填入输入框（不回退历史）')}">
          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
          </svg>
          <span>${t('填入输入框')}</span>
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

    // 对话轴分叉的可见入口。对齐 Claude Desktop 1.52386.6——它把「Fork from here」放在
    // assistant 消息的操作栏里，与复制/朗读同排。2026-10-26 起它是唯一入口（气泡长按还给了系统选字，
    // 见 requestSessionFork 头注）。
    //
    // 【为什么判 anchorUuid】没有锚点就分叉不了（requestSessionFork 开头直接 return）。
    // 流式气泡由 getStream 建、不带 dataset.uuid，旧 transcript 里也有缺 uuid 的条目——
    // 那两档摆出按钮就是摆一个点了必然失败的东西。「复制」不需要锚点，所以它照常在。
    if (anchorUuid) {
      const forkBtn = el(`
        <button class="msg-action-btn" data-testid="fork-action" title="${t('从这里分叉')}">
          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M6 3v12m0 0a3 3 0 103 3 3 3 0 00-3-3zm0-12a3 3 0 110 6 3 3 0 010-6zm12 0a3 3 0 100 6 3 3 0 000-6zm0 6c0 6-6 3-6 9" />
          </svg>
          <span>${t('分叉')}</span>
        </button>
      `);
      // 确认框在 requestSessionFork 里，haptic 同理——按钮可见不等于一键执行。
      // uuid 在点击时由该函数从 container.dataset 读，不用这里的 anchorUuid：
      // 气泡的 dataset 才是权威值，且历史回显路径是先挂操作栏、后补 uuid。
      forkBtn.onclick = () => requestSessionFork(container);
      bar.appendChild(forkBtn);
    }

    // UX-012 / #362：编辑已迁到用户气泡「填入输入框」

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
    // #395：长用户消息「展开」挂 hit-44，补足 44px 触控热区（同屏工具卡「展开全文」另案）
    const btn = el(`<button type="button" class="hit-44 text-xs text-accent mt-1 block">${t('展开')}</button>`);
    let expanded = false;
    btn.onclick = () => {
      expanded = !expanded;
      if (expanded) { textEl.style.maxHeight = 'none'; btn.textContent = t('收起'); textEl.classList.remove('overflow-hidden'); }
      else { textEl.style.maxHeight = '8rem'; btn.textContent = t('展开'); textEl.classList.add('overflow-hidden'); }
    };
    textEl.after(btn);
  }

  // 用户气泡的文字：一律纯文本，保留换行与连续空白（验收 O25 / O90）。终端里看到的就是用户原样打的字；
  // 原来和助手回复共用 markdown + sanitize，<Header> 被吞、<b> 变粗体、**…** 变加粗、连续空格被压成一个，
  // 用户会以为自己的话被截断了。乐观占位、在线新建、历史渲染三个建出点共用这一个构建器，字段漂开会认领失败。
  function appendUserText(bubble, text) {
    const textNode = el(`<div class="whitespace-pre-wrap break-words" data-testid="user-text"></div>`);
    textNode.textContent = text;
    bubble.appendChild(textNode);
    foldLongUserText(textNode, text);
    return textNode;
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

  const consolePanel = createConsoleModal(appContext, {
    $, btnConsole, clientLogger, closeSheet, consoleClear, consoleClose, consoleFilterButtons,
    consoleLogArea, consoleModal, copyText, openSheet, reopenGeneralAt, setGestureDismiss, socket,
    getGeneral: () => general, getModelsList: () => modelsList,
    getViewingInstanceId: () => viewingInstanceId,
  });
  const { appendDiagLog, appendLogEntry, appendSessionLog, loadConsoleLogs } = consolePanel;

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
