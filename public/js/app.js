// app.js —— 契约客户端：agent:event 渲染 + 审批弹窗 + epoch 感知续传。
// 纯决策逻辑（effort 档位 / 状态聚合 / ANSI / esc）抽到 logic.js，浏览器 import + node:test 共用。
/* global io, marked, DOMPurify, hljs */
import { esc, effortLevelsFor, aggregateStates, projectDisplayName, shouldShowStartScreen, shouldRestoreOptimisticBusy, shouldDropAgentEvent, foregroundReconnectAction, syncAckAction, keyboardInsetPadding, logEntryVisibleForInstance } from './logic.js';
(() => {
  // ---- token 注入（4a：#token= → localStorage → 立即清地址栏）----
  const hashMatch = location.hash.match(/#token=(.+)/);
  if (hashMatch) {
    localStorage.setItem('auth_token', decodeURIComponent(hashMatch[1]));
    history.replaceState(null, '', location.pathname);
  }
  const token = localStorage.getItem('auth_token') || '';

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
  const messagesEl = $('messages'), inputEl = $('input'), statusEl = $('statusLine'), connDot = $('connDot');
  const btnSend = $('btnSend'), btnStop = $('btnStop'), btnNew = $('btnNew'), btnSessions = $('btnSessions');
  const activeStatusPill = $('activeStatusPill'), activeStatusText = $('activeStatusText'), btnStopNew = $('btnStopNew');
  const sessionPanel = $('sessionPanel');
  const sessionsDot = $('sessionsDot');  // 台阶2 Step B：后台目录动静汇总小圆点

  // ---- 极简触觉交互及抽屉式元素 DOM 绑定 ----
  const sidebarScrim = $('sidebarScrim'), leftSidebar = $('leftSidebar'), sidebarClose = $('sidebarClose');
  const btnSettings = $('btnSettings'), settingsScrim = $('settingsScrim'), settingsSheet = $('settingsSheet'), settingsClose = $('settingsClose');
  const statusPillsRow = $('statusPillsRow'), pillModel = $('pillModel'), pillModelText = $('pillModelText');
  const pillPerm = $('pillPerm'), pillPermText = $('pillPermText'), pillEffort = $('pillEffort'), pillEffortText = $('pillEffortText');
  const topContextPill = $('topContextPill'), topTitleText = $('topTitleText'), topProjectText = $('topProjectText');
  const customModelGrid = $('customModelGrid'), customPermGrid = $('customPermGrid'), customEffortGrid = $('customEffortGrid'), customEffortGroup = $('customEffortGroup');

  // ---- Web Haptics (触觉振动反馈) ----
  function haptic(type) {
    if (!navigator.vibrate) return;
    try {
      if (type === 'tap') navigator.vibrate(12);
      else if (type === 'success') navigator.vibrate([15, 80, 15]);
      else if (type === 'error' || type === 'warning') navigator.vibrate([30, 80, 30, 80, 30]);
    } catch (e) { /* 忽略某些沙箱浏览器不支持 Vibrate 引起的错误 */ }
  }
  const modelInput = $('modelInput');   // 模型 select：候选由 models 事件填充；任意名走 /model 拦截动态插入
  const cliStatusEl = $('cliStatus');   // E16：终端 statusLine ANSI 行容器（status_line 事件填充）
  const cliStatusWrapEl = $('cliStatusWrap'); // E16：ANSI 行折叠包裹（<details>，揭示=去 hidden）
  const cliSummaryEl = $('cliSummary'); // E16：折叠条一行摘要（status_line 事件 summary 字段填充）
  const permModeSelect = $('permModeSelect');  // 权限档切换器（5 档；dontAsk 终端 Shift+Tab 切不到，属 setPermissionMode/agent 能力）
  const effortSelect = $('effortSelect');      // 思考强度档切换器（档位按当前模型 supportedEffortLevels 动态渲染）
  const effortRow = $('effortRow');            // effort 整行容器：当前模型不支持 effort（如 haiku）时隐藏
  const btnAttach = $('btnAttach'), fileInput = $('fileInput'), attachTray = $('attachTray'); // E17：附件
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
    if (customModelGrid && !customModelGrid.querySelector(`[data-model="${value}"]`)) {
      const card = el(`
        <div data-model="${value}" class="model-tile p-2.5 rounded-xl border border-line bg-surface active:bg-sunk cursor-pointer transition-all">
          <div class="text-xs font-semibold truncate text-ink">${value}</div>
          <div class="text-[9.5px] text-ink-soft truncate mt-0.5">${note || '当前加载模型'}</div>
        </div>
      `);
      card.onclick = () => {
        haptic('tap');
        modelInput.value = value;
        syncModelUI(value);
      };
      customModelGrid.appendChild(card);
    }
  }
  const permModal = $('permModal'), permTool = $('permTool'), permCwd = $('permCwd'),
        permInput = $('permInput'), permAlways = $('permAlways');
  const questionModal = $('questionModal'), questionText = $('questionText'), questionOptions = $('questionOptions');
  const authGate = $('authGate'), authToken = $('authToken'), authSubmit = $('authSubmit'), authError = $('authError'); // 访问令牌输入页
  const accessRelogin = $('accessRelogin'), accessReloginBtn = $('accessReloginBtn'); // Access 会话过期重登浮层
  // 远程设备审批 + 访问帮助 UI
  const deviceRequests = $('deviceRequests'); // 已信任设备上的待审批请求卡片栈
  const deviceDenied = $('deviceDenied'), deviceDeniedRetry = $('deviceDeniedRetry'), deviceDeniedHelp = $('deviceDeniedHelp');
  const accessHelp = $('accessHelp'), accessHelpClose = $('accessHelpClose'), accessHelpOpen = $('accessHelpOpen'), authHelpLink = $('authHelpLink');
  const btnConsole = $('btnConsole'), consoleModal = $('consoleModal'),
        consoleClose = $('consoleClose'), consoleClear = $('consoleClear'),
        consoleLogArea = $('consoleLogArea');

  // ---- 状态 ----
  let currentSessionId = localStorage.getItem('current_session') || null;
  const sessionDomCache = new Map();

  // ---- 客户端本地日志体系 (Console/Log modal) ----
  const clientLogBuffer = [];
  let streamCharCount = 0;
  let streamThinkingCharCount = 0;
  let currentStreamingMessageId = null;

  function logClientEvent(type, text) {
    const entry = {
      ts: Date.now(),
      type: 'client_' + type, // client_conn, client_send, client_recv, client_stream
      text: text,
      // 打当前查看实例标签，供切工作区时按实例过滤（client_conn 连接级恒显、其标签被忽略）。
      // recv/stream 仅当前视图实例会产生（后台事件已在 agent:event 分发处 shouldDropAgentEvent 拦掉）；
      // send 的目标即 viewingInstanceId → 标签准确。见 logic.js logEntryVisibleForInstance。
      instanceId: viewingInstanceId,
    };
    // 收发两类附当前模型 ID（与服务端四类一致带 chip）；连接/流式片段无单一模型语义、不带
    if ((type === 'send' || type === 'recv') && currentModel) entry.model = currentModel;
    clientLogBuffer.push(entry);
    if (clientLogBuffer.length > 200) {
      clientLogBuffer.shift();
    }
    if (consoleModal && consoleModal.classList.contains('sheet-open')) {
      appendLogEntry(entry);
    }
  }
  // 斜杠命令提示：init 事件推送 + localStorage 缓存（init 每轮到达并刷新缓存；页面刷新后、下一轮 init 前靠缓存提示）
  try {
    const cachedCmds = JSON.parse(localStorage.getItem('slash_commands'));
    if (Array.isArray(cachedCmds)) window.availableSkills = cachedCmds;
  } catch { /* 缓存损坏等价于无缓存 */ }
  let lastSeq = 0;
  let curEpoch = null;
  let currentModel = '';                // 当前生效模型（init 事件的 model 字段），/model 无参时展示
  let currentGatewaySuffix = '';        // 保存第三方网关的特殊后缀（如 [1m]）进行无感适配，保持 Web 选项名称干净
  let activeSpeechBtn = null;           // 语音朗读当前播放的按钮
  
  function syncModelUI(model) {
    // 底栏模型 chip：显完整真名（含网关后缀 [1m]，与 statusLine/实际发送名一致）；未选则显「默认」=
    // 发送时不带 model、用 CLI 启动默认（非猜——显的是你的显式选择或诚实的「默认」）。点击开「选择模型」格。
    if (pillModelText) pillModelText.textContent = model ? model + currentGatewaySuffix : '默认';
    if (customModelGrid) {
      customModelGrid.querySelectorAll('.model-tile').forEach(tile => {
        const tileVal = tile.dataset.model;
        const isCurrent = tileVal === model;
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
    
    // 默认首选项：不指定（沿用当前）
    const defActive = !currentModel;
    const defCard = el(`
      <div data-model="" class="model-tile p-2.5 rounded-xl border border-line bg-surface active:bg-sunk cursor-pointer transition-all ${defActive ? 'ring-1 ring-accent border-accent text-accent bg-accent-wash/30' : ''}">
        <div class="text-xs font-semibold truncate ${defActive ? 'text-accent' : 'text-ink'}">沿用当前模型</div>
        <div class="text-[9.5px] text-ink-soft truncate mt-0.5">不指定特定模型</div>
      </div>
    `);
    defCard.onclick = () => {
      haptic('tap');
      modelInput.value = '';
      syncModelUI('');
    };
    customModelGrid.appendChild(defCard);

    (models || []).forEach(m => {
      const val = typeof m === 'string' ? m : m.value;
      const display = typeof m === 'string' ? m : (m.displayName || m.value);
      const desc = typeof m === 'string' ? '' : (m.description || '');
      
      const active = val === currentModel;
      const card = el(`
        <div data-model="${val}" class="model-tile p-2.5 rounded-xl border border-line bg-surface active:bg-sunk cursor-pointer transition-all ${active ? 'ring-1 ring-accent border-accent text-accent bg-accent-wash/30' : ''}">
          <div class="text-xs font-semibold truncate ${active ? 'text-accent' : 'text-ink'}">${display}</div>
          <div class="text-[9.5px] text-ink-soft truncate mt-0.5">${desc || val}</div>
        </div>
      `);
      card.onclick = () => {
        haptic('tap');
        modelInput.value = val;
        syncModelUI(val);
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
  const permQueue = [];
  let activePerm = null;
  let permExpandBtn = null;             // M1：展开按钮引用，showNextPerm 前清除
  const questionQueue = [];
  let activeQuestion = null;
  let currentPermMode = 'default';      // 当前权限档；onchange 取消时回退、避免重复 emit
  let permModeSeen = false;             // 首次服务端同步只定基线不上屏（刷新/重连不冒「切换」假象）
  let currentEffort = null;             // 当前思考强度档（null=模型默认）；onchange 同值不重发
  let effortSeen = false;               // 首次服务端同步只定基线不上屏（同 permModeSeen）
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
  let expandedDirs = new Set();         // 工作区面板中展开的目录（初始空，首 instances 事件填充；切 cwd 重置）
  // P3：面板结构指纹（dirs + 实例集 + viewingInstanceId + viewingCwd）；纯状态变化时不重建面板。
  let _lastPanelStructKey = null;
  let pendingAttachments = [];          // E17：待发送附件 [{_id,name,mimeType,size,data,thumb?}]，发送后清空
  let offlineQueue = [];                // 弱网离线发送队列：重连后 processOfflineQueue 逐条补发

  marked.setOptions({ breaks: true, gfm: true });
  const render = raw => DOMPurify.sanitize(marked.parse(raw));

  // L5：输出中的链接加 target=_blank，防止跳出当前页（DOMPurify 已处理 XSS）
  DOMPurify.addHook('afterSanitizeAttributes', node => {
    if (node.tagName === 'A') {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
  });

  // ---- socket ----
  const socket = io({
    auth: { token, deviceToken },
    // 移动端常切后台/息屏，断开后想尽快回来：调小重连退避（默认 1000/5000ms 太久）
    reconnectionDelay: 500,
    reconnectionDelayMax: 2000,
  });

  let initialLoad = true;
  let connectErrorCount = 0;  // 公网 socket 连续失败计数，攒够再探测 Access 是否过期
  
  function processOfflineQueue() {
    if (offlineQueue.length === 0) return;
    addBar(`正在重发离线发送队列中的 ${offlineQueue.length} 条消息...`, 'text-info');
    logClientEvent('send', `[WEB_SEND] 正在重发离线发送队列中的 ${offlineQueue.length} 条消息`);
    while (offlineQueue.length > 0) {
      const item = offlineQueue.shift();
      const indicator = item.bubbleEl?.querySelector('.pending-indicator');
      if (indicator) {
        indicator.textContent = '🕐 正在发送...';
      }
      logClientEvent('send', `[WEB_SEND] 重发离线消息: "${item.text.slice(0, 100)}" (${item.text.length} 字符)`);
      socket.emit('user:message', {
        text: item.text,
        model: item.model,
        attachments: item.attachments,
        instanceId: viewingInstanceId,
        cwd: currentCwd
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
    clearView(displayedSessionId, null);
    showLoadingCard();
    loadHistory(displayedSessionId); // cwd 默认 currentCwd
  }
  function requestSync({ probe }) {
    if (!displayedInstanceId || !displayedSessionId) return;
    const payload = { instanceId: displayedInstanceId, sessionId: displayedSessionId, lastSeq };
    const act = (err, res) => {
      const a = syncAckAction(err, res);
      if (a === 'reconnect') { if (socket.connected) socket.disconnect(); socket.connect(); }
      else if (a === 'reload') reloadCurrentFromHistory();
      // 'none'：回放走正常 agent:event 经 epoch/seq 去重增量渲染
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

  socket.on('connect', () => {
    authGate?.classList.add('hidden');           // 鉴权通过：收起令牌输入页
    accessRelogin?.classList.add('hidden');      // 连上即收起重登浮层
    connectErrorCount = 0;
    if (authSubmit) { authSubmit.disabled = false; authSubmit.textContent = '进入'; }
    connDot.className = 'w-2 h-2 rounded-full bg-success shrink-0';
    setStatus('已连接');
    cliStatusWrapEl?.classList.remove('opacity-40'); // E16：重连恢复（折叠条整体：summary + ANSI 行，重放/刷新马上跟上）
    logClientEvent('conn', `连接成功！Socket ID = ${socket.id}。当前使用 token: ${token ? token.slice(0, 4) + '***' : '无（本机/公网）'}`);
    // 台阶3：首连由 instances 事件驱动加载当前查看实例（见 setInstances）；重连（非首连、已有绑定实例）
    // 续传该实例缓冲补齐断线期间漏掉的事件。
    if (!initialLoad && displayedInstanceId && displayedSessionId) requestSync({ probe: false });
    initialLoad = false;
    setupPush();
    
    // 触发离线发送队列重发
    processOfflineQueue();
  });
  socket.on('disconnect', (reason) => {
    connDot.className = 'w-2 h-2 rounded-full bg-danger shrink-0';
    setStatus('连接断开，自动重连中…');
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
      else requestSync({ probe: true });
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
      footer.style.paddingBottom = pad + 'px';
      if (pad - baseBottom > 60) scrollBottom(); // 键盘明显占位才滚动到底，保证输入区可见
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
  if (authHelpLink) authHelpLink.onclick = showAccessHelp;

  function showDeniedOverlay() { deviceDenied?.classList.remove('hidden'); }
  if (deviceDeniedHelp) deviceDeniedHelp.onclick = showAccessHelp;
  if (deviceDeniedRetry) deviceDeniedRetry.onclick = () => {
    deviceDenied?.classList.add('hidden');
    if (!socket.connected) socket.connect(); // 重新发起 → 重新进入 pending，可信端/终端可再批
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

  // ---- agent:event 分发（台阶3 instanceId 分流 + epoch 感知去重）----
  socket.on('agent:event', ev => {
    // 台阶3：事件按 instanceId 分流——非当前查看 tab（viewingInstanceId）的实例事件不渲染直接丢弃。
    // 角标/跨 tab 通知改由 instances 广播驱动（setInstances/notifyStateChanges），不在此重建。
    // 必须在 epoch 去重前过滤，否则后台实例事件会污染 curEpoch/lastSeq 基线。判定见 logic.js shouldDropAgentEvent：
    //   · instances / 无 instanceId 的合成事件永不丢；· instancesReady 前（视图未知）放行重放批次；
    //   · 视图已知后按 viewingInstanceId 精确分流——含 viewingInstanceId=null（新会话空窗口）时丢弃一切后台实例事件。
    if (shouldDropAgentEvent(ev, viewingInstanceId, instancesReady)) return;
    if (ev.epoch && ev.epoch !== 'server') {
      if (ev.epoch !== curEpoch) {
        curEpoch = ev.epoch;
        lastSeq = 0;
        // 清理旧 epoch 的挂起审批和提问，避免阻塞新 epoch 的弹窗流程
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
      }
      if (ev.seq <= lastSeq) return;
      lastSeq = ev.seq;
    }
    if (ev.sessionId && ev.sessionId !== currentSessionId) {
      currentSessionId = ev.sessionId;
      localStorage.setItem('current_session', currentSessionId);
    }

    // Log incoming event to our local clientLogBuffer
    if (ev.type === 'init') {
      logClientEvent('recv', `[WEB_RECV] 初始化 (init): model=${ev.payload?.model || ''}, cwd=${ev.payload?.cwd || ''}, commandsCount=${ev.payload?.slashCommands?.length || 0}`);
    } else if (ev.type === 'models') {
      const modelNames = (ev.payload?.models || []).map(m => typeof m === 'string' ? m : (m.displayName || m.value)).join(', ');
      logClientEvent('recv', `[WEB_RECV] 可用模型列表 (models): 共 ${ev.payload?.models?.length || 0} 个选项 [${modelNames}]`);
    } else if (ev.type === 'result') {
      logClientEvent('recv', `[WEB_RECV] 结果 (result): isError=${ev.payload?.isError || false}, duration=${ev.payload?.durationMs}ms, cost=$${ev.payload?.costUsd || 0}`);
      if (currentStreamingMessageId) {
        logClientEvent('stream', `[STREAM] 流式接收完成。共计: 文本 ${streamCharCount} 字符, 思考 ${streamThinkingCharCount} 字符`);
        streamCharCount = 0;
        streamThinkingCharCount = 0;
        currentStreamingMessageId = null;
      }
    } else if (ev.type === 'error') {
      logClientEvent('recv', `[WEB_RECV] 错误 (error): ${ev.payload?.message || ''}`);
    } else if (ev.type === 'system') {
      logClientEvent('recv', `[WEB_RECV] 系统通知 (system): ${ev.payload?.message || ''}`);
    } else if (ev.type === 'permission_request') {
      logClientEvent('recv', `[WEB_RECV] 权限审批请求: tool=${ev.payload?.name || ''}`);
    } else if (ev.type === 'question') {
      logClientEvent('recv', `[WEB_RECV] 提问: "${ev.payload?.text?.slice(0, 50)}..."`);
    } else if (ev.type === 'user_message') {
      logClientEvent('recv', `[WEB_RECV] 广播用户消息 (user_message): "${ev.payload?.text?.slice(0, 50)}${ev.payload?.text?.length > 50 ? '...' : ''}" (${ev.payload?.text?.length || 0} chars)`);
    } else if (ev.type === 'text_delta') {
      if (!currentStreamingMessageId) {
        currentStreamingMessageId = ev.payload?.messageId || 'default';
        logClientEvent('stream', `[STREAM] 启动流式文本段接收 (messageId=${currentStreamingMessageId})`);
      }
      streamCharCount += (ev.payload?.text?.length || 0);
    } else if (ev.type === 'thinking_delta') {
      if (!currentStreamingMessageId) {
        currentStreamingMessageId = ev.payload?.messageId || 'default';
        logClientEvent('stream', `[STREAM] 启动流式思考段接收 (messageId=${currentStreamingMessageId})`);
      }
      streamThinkingCharCount += (ev.payload?.text?.length || 0);
    } else if (ev.type === 'tool_use') {
      logClientEvent('recv', `[WEB_RECV] 工具启动: ${ev.payload?.name || ''}`);
    } else if (ev.type === 'tool_result') {
      logClientEvent('recv', `[WEB_RECV] 工具返回: toolUseId=${ev.payload?.toolUseId || ''}, ok=${ev.payload?.ok || false}`);
    }

    handle[ev.type]?.(ev.payload);
  });

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
      } else if (p.status === 'denied') {
        if (modal) modal.classList.add('hidden');
        if (inputEl) inputEl.disabled = false;
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
      if (currentModel && m && m !== currentModel) addBar(`模型 → ${m}`, 'text-info');
      updateModelAndSuffix(rawM);
      if (modelsList.length) rebuildEffortOptions(currentModel); // 模型变 → effort 档位跟随新模型（列表已在则即时刷）
      setPermMode(p.permissionMode); // 每轮 init 回显当前权限档（幂等，与 permission_mode 事件一致）
      // 顶部状态行回归「纯连接状态」职责：model/目录/ctx/cost 已由下方 E16 statusLine 投送（更全更权威），
      // MCP×N·skills×N 由 statusLine 脚本本身输出（终端 + 所有项目共享），此处不再合成覆盖连接状态
      if (Array.isArray(p.slashCommands)) {
        window.availableSkills = p.slashCommands;
        localStorage.setItem('slash_commands', JSON.stringify(p.slashCommands));
      }
    },
    // 权限档切换后即时同步（多设备一致）；server 合成事件，与 init.permissionMode 一致
    permission_mode(p) {
      setPermMode(p.mode);
    },
    // 思考强度档回执/重放（含拒切拨回的单发）；server 合成事件
    effort_mode(p) {
      setEffortMode(p.level);
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
    // 原样透传（2026-06-15）：SDK 返回 {value, displayName, description}（兼容纯字符串），option 文案直接用
    // displayName、发送值用 value，不叠加项目友好名映射。预选当前模型用 init.model 精确 value 匹配；
    // 不在列表（如网关后缀名 [1m]）则 ensureModelOption 插入裸名后选中——F1：匹配不到也绝不静默切走。
    // 空值选项「不指定」保留：用户可显式回退到不传 model，由会话沿用原有模型（F1 事故教训）。
    models(p) {
      modelsList = Array.isArray(p.models) ? p.models : []; // 存原始候选供 effort 动态渲染
      rebuildEffortOptions(currentModel);                    // 列表到达 → 按当前模型刷新 effort 档位
      rebuildCustomModelGrid(modelsList);                    // 刷新自定义设置面板中的模型选择
      if (!modelInput) return;
      modelInput.innerHTML = '';
      const def = document.createElement('option');
      def.value = '';
      def.textContent = '不指定（沿用当前）';
      modelInput.appendChild(def);
      (p.models || []).forEach(m => {
        const opt = document.createElement('option');
        if (typeof m === 'string') { opt.value = m; opt.textContent = m; }
        else { opt.value = m.value; opt.textContent = m.displayName || m.value; }
        modelInput.appendChild(opt);
      });
      // 预选当前模型（init.model）：已在列表则选中，否则插入裸名后选中（ensureModelOption 内部去重）
      if (currentModel) {
        ensureModelOption(currentModel);
        modelInput.value = currentModel;
        syncModelUI(currentModel);
      }
      // 若 /model 手设的 pending 值不同于当前模型，确保它在 option 里（切换前可见但不可选中的中间态）
      // keep 原逻辑已移除——init.model 是权威源，不再依赖 input.value 留存旧选择
    },
    text_delta(p) {
      const s = getStream(p.messageId);
      s.raw += p.text;
      s.textNode.appendData(p.text);
      scrollBottom();
      setBusy(true);
    },
    thinking_delta(p) {
      getThinking(p.messageId).body.appendData(p.text);
      scrollBottom();
      setBusy(true);
      if (activeStatusText) {
        activeStatusText.textContent = 'Claude 正在思考中...';
      }
    },
    tool_use(p) {
      const card = el(`
        <details class="msg-frame toolcard rounded-lg bg-surface border border-line text-xs">
          <summary class="px-3 py-2 flex items-center gap-2">
            <span class="t-status">⏳</span><span class="font-mono font-semibold text-ink">${esc(p.name)}</span>
          </summary>
          <div class="px-3 pb-2 space-y-1">
            <pre class="overflow-x-auto text-ink-soft">${esc(p.inputSummary)}</pre>
            <pre class="t-out overflow-x-auto text-ink-faint hidden"></pre>
          </div>
        </details>`);
      toolCards.set(p.toolUseId, card);
      appendMessage(card);
      scrollBottom();
      setBusy(true);
      if (activeStatusText) {
        // 直接用 SDK 给的真实工具名（Bash/Write/Edit/Read/…）——原 TOOL_MAPPING 的键是
        // execute_command 等非 claude 工具名、从不命中，是死表 + mis-label，已删（2026-06-21）
        activeStatusText.textContent = `Claude 正在运行工具 ${p.name}...`;
      }
    },
    tool_result(p) {
      const card = toolCards.get(p.toolUseId);
      if (!card) return;
      // deny+message 通道结果被 SDK 标 is_error（ok:false），但真实语义由 denyKind 决定（agent.js）：
      // answered=已回答 ☑️ / denied=已拒绝 🚫 / cancelled=已取消 🚫——均非工具报错；无 denyKind 才按 ok 显 ✅/❌。
      const DENY_ICON = { answered: '☑️', denied: '🚫', cancelled: '🚫' };
      card.querySelector('.t-status').textContent = DENY_ICON[p.denyKind] || (p.ok ? '✅' : '❌');
      if (p.outputSummary) {
        const out = card.querySelector('.t-out');
        // deny 通道正文带 SDK 加的 "Error:" 前缀（非真错误），剥掉只留语义文本
        out.textContent = p.denyKind ? p.outputSummary.replace(/^Error:\s*/i, '') : p.outputSummary;
        out.classList.remove('hidden');
      }
      toolCards.delete(p.toolUseId);
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
          const wrap = el(`<div class="flex flex-wrap gap-2 mt-2"></div>`);
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
          matchedBubble.appendChild(wrap);
        }
        if (p.text) appendCopyAction(matchedBubble, () => p.text, 'right');
        scrollBottom(true);
        return; // 匹配成功，直接返回，避免生成重复聊天气泡
      }

      const bubble = el(`<div class="msg-frame rounded-xl bg-user text-ink px-3 py-2 text-sm" data-testid="user-message"></div>`);
      if (p.text) {
        const t = el(`<div class="whitespace-pre-wrap"></div>`);
        t.textContent = p.text;
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
      haptic('warning');
      permQueue.push(p);
      showNextPerm();
      notify('⚠️ 等待审批', `${p.name}：${JSON.stringify(p.input).slice(0, 80)}`);
    },
    question(p) {
      haptic('warning');
      questionQueue.push(p);
      showNextQuestion();
      notify('❓ 需要选择', p.text.slice(0, 80));
    },
    // M4：审批/选题完成后广播，多设备或重放缓冲时关闭陈旧弹窗
    request_resolved(p) {
      const { requestId, kind } = p;
      if (kind === 'permission') {
        if (activePerm?.requestId === requestId) {
          activePerm = null;
          closeSheet(permModal);
          permExpandBtn?.remove(); permExpandBtn = null;
        } else {
          const idx = permQueue.findIndex(r => r.requestId === requestId);
          if (idx !== -1) permQueue.splice(idx, 1);
        }
        if (!activePerm) showNextPerm();
      } else if (kind === 'question') {
        // question requestId 格式 '${toolUseID}#i'；resolved requestId 是 toolUseID（或 '#i' 形式）
        const matchQ = qId => qId === requestId || qId.startsWith(requestId + '#');
        if (activeQuestion && matchQ(activeQuestion.requestId)) {
          activeQuestion = null;
          closeSheet(questionModal);
        } else {
          const idx = questionQueue.findIndex(q => matchQ(q.requestId));
          if (idx !== -1) questionQueue.splice(idx, 1);
        }
        if (!activeQuestion) showNextQuestion();
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
      setBusy(false);
      haptic(p.isError ? 'error' : 'success');
      const cost = p.costUsd != null ? ` · $${p.costUsd.toFixed(4)}` : '';
      addBar(`完成 · ${(p.durationMs / 1000).toFixed(1)}s${cost}`, 'text-ink-faint');
      if (p.isError && p.errors) addBar(`出错：${p.errors.join('; ')}`, 'text-danger');
      // 通知须区分成败：出错轮次不能误报「✅ 任务完成」
      if (p.isError) notify('⚠️ 任务出错', (p.errors?.join('; ') || '').slice(0, 80) || `用时 ${(p.durationMs / 1000).toFixed(1)}s`);
      else notify('✅ 任务完成', `用时 ${(p.durationMs / 1000).toFixed(1)}s`);

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
    },
    error(p) {
      finalizeStreams();
      haptic('error');
      addBar(`⚠️ ${p.message}`, 'text-danger');
      setBusy(false);

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
    },
    // M7：改用 kind 字段判断中断，不靠字符串匹配（字符串会随 i18n 变化）
    system(p) {
      addBar(p.message, 'text-ink-faint');
      if (p.kind === 'interrupted') { finalizeStreams(); setBusy(false); }
    },
    // E16：web 自有结构化状态（非 ANSI）。摘要去 emoji，展开分段构建 DOM（createElement+textContent，
    // 不经 innerHTML/DOMPurify，天然 XSS 安全）；服务端未启用则此事件不来，容器恒 hidden
    status_line(p) {
      if (!cliStatusEl || !p || typeof p !== 'object') return;
      // 守护：如果 payload 里的 instanceId 与前端当前的 viewingInstanceId 不一致，则丢弃渲染（防止旧 tab 覆盖）
      if (p.instanceId && viewingInstanceId && p.instanceId !== viewingInstanceId) return;
      // 空启动页采用极简底部：模型/权限/思考 chips 即可，statusLine 进入消息流后再显示。
      if (messagesEl.classList.contains('empty-start')) return;
      const fmtTok = n => n >= 1e6 ? (n / 1e6).toFixed(1) + 'm' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n);
      const fmtMs = ms => { const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60; return h ? `${h}h${String(m).padStart(2, '0')}m` : m ? `${m}m${String(x).padStart(2, '0')}s` : `${x}s`; };
      const fmtTokF = n => n >= 1e6 ? (n / 1e6).toFixed(1) + 'm' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n); // 带 1 位小数（token 明细，匹配 cli 的 2.1k/199.6k）
      // 折叠摘要（去 emoji）：<ctx> · $<cost> · <wall 耗时>——三个最常看的值
      const head = [];
      if (p.ctx && Number.isFinite(p.ctx.tokens)) head.push(fmtTok(p.ctx.tokens));
      if (Number.isFinite(p.cost)) head.push(`$${p.cost.toFixed(4)}`);
      if (p.duration && p.duration.wallMs) head.push(fmtMs(p.duration.wallMs));
      if (cliSummaryEl) cliSummaryEl.textContent = head.join(' · ') || '状态';
      // 展开详情：分段着色、纯 DOM 构建。seg = {text,cls} 或 {node}；段间插 faint 的 ' · ' 分隔
      const span = (text, cls) => { const s = document.createElement('span'); if (cls) s.className = cls; s.textContent = text; return s; };
      const buildLine = segs => {
        const segsF = segs.filter(Boolean);
        if (!segsF.length) return null;
        const line = document.createElement('div');
        segsF.forEach((seg, i) => {
          if (i) line.appendChild(span(' · ', 'text-ink-faint opacity-50'));
          line.appendChild(seg.node || span(seg.text, seg.cls));
        });
        return line;
      };
      const lines = [];
      // 行1：分支 ✱变更 ↑ahead ↓behind + 代码增删（+绿 −红双色复合段，跟随项目 emerald/rose 惯例）
      if (p.git?.branch) {
        let b = p.git.branch;
        if (p.git.changed) b += ` ✱${p.git.changed}`;
        if (p.git.ahead) b += ` ↑${p.git.ahead}`;
        if (p.git.behind) b += ` ↓${p.git.behind}`;
        let diff = null;
        if (p.git.insertions || p.git.deletions) {
          diff = document.createElement('span');
          if (p.git.insertions) diff.appendChild(span(`+${p.git.insertions}`, 'text-emerald-500'));
          if (p.git.insertions && p.git.deletions) diff.appendChild(document.createTextNode(' '));
          if (p.git.deletions) diff.appendChild(span(`−${p.git.deletions}`, 'text-rose-500'));
        }
        lines.push(buildLine([{ text: b, cls: 'text-accent font-medium' }, diff && { node: diff }]));
      }
      // 行2：精确 token + 缓存命中率 + API 耗时（wall 耗时已在摘要，这里只 API 避免重复）
      lines.push(buildLine([
        p.ctx && Number.isFinite(p.ctx.tokens) && { text: `${p.ctx.tokens.toLocaleString()} tokens`, cls: 'text-ink-soft' },
        p.ctx && Number.isFinite(p.ctx.cacheHitPct) && { text: `cache ${p.ctx.cacheHitPct}%`, cls: 'text-ink-faint' },
        p.duration && p.duration.apiMs && { text: `API ${fmtMs(p.duration.apiMs)}`, cls: 'text-ink-faint' }
      ]));
      // 行3：token 明细 in/w/r（input / cache 写 / cache 读——cli 口径，看缓存效率；窗口百分比 SDK 拿不到故不算）
      if (p.ctx && Number.isFinite(p.ctx.in)) {
        lines.push(buildLine([
          { text: `in:${fmtTokF(p.ctx.in)}`, cls: 'text-ink-faint' },
          { text: `w:${fmtTokF(p.ctx.w)}`, cls: 'text-ink-faint' },
          { text: `r:${fmtTokF(p.ctx.r)}`, cls: 'text-ink-faint' }
        ]));
      }
      // 行4：repo · 版本 · 时间（时间用后端刷新时刻 p.ts 在前端渲染，不进 payload 以免破坏 server 端去重）
      const clock = p.ts ? new Date(p.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }) : '';
      lines.push(buildLine([
        p.git?.repo && { text: p.git.repo, cls: 'text-ink-faint' },
        p.version && { text: `v${p.version}`, cls: 'text-ink-faint' },
        clock && { text: clock, cls: 'text-ink-faint' }
      ]));
      // 一次性替换：清空旧节点 + append 非空行（buildLine 对空行返回 null）
      cliStatusEl.textContent = '';
      lines.filter(Boolean).forEach(l => cliStatusEl.appendChild(l));
      cliStatusWrapEl?.classList.remove('hidden'); // 揭示折叠包裹（默认折叠为 summary 摘要）
    }
  };

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
      s.done = true;
      s.el.style.transition = 'opacity .1s';
      s.el.style.opacity = '0.4';
      requestAnimationFrame(() => {
        s.el.innerHTML = render(s.raw);
        s.el.querySelectorAll('pre code').forEach(b => hljs.highlightElement(b));
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

  // ---- 审批弹窗（4a：完整命令 + cwd）----
  function showNextPerm() {
    if (activePerm || permQueue.length === 0) return;
    activePerm = permQueue.shift();
    permTool.textContent = activePerm.name;
    permCwd.textContent = `工作目录：${activePerm.cwd}`;
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
    openSheet(permModal);
  }
  function answerPerm(decision) {
    if (!activePerm) return;
    const wasExitPlanMode = activePerm.name === 'ExitPlanMode'; // 下方 activePerm 即置 null，提前捕获
    socket.emit('user:approve', {
      requestId: activePerm.requestId,
      decision,
      alwaysThisSession: permAlways.checked,
      instanceId: viewingInstanceId // 台阶3：路由到当前查看 tab 实例（切过去后审批的本就是该实例）
    });
    addBar(`${decision === 'allow' ? '✅ 已允许' : '🚫 已拒绝'}：${activePerm.name}`, 'text-ink-faint');
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
  }
  $('permAllow').onclick = () => answerPerm('allow');
  $('permDeny').onclick = () => answerPerm('deny');

  // ---- 选择题弹窗（E7：AskUserQuestion）----
  function showNextQuestion() {
    if (activeQuestion || questionQueue.length === 0) return;
    activeQuestion = questionQueue.shift();
    questionText.textContent = activeQuestion.text;
    questionOptions.innerHTML = '';
    activeQuestion.options.forEach((opt, i) => {
      const btn = el(`<button class="w-full py-2.5 rounded-lg bg-sunk active:bg-line text-ink text-sm text-left px-3"></button>`);
      btn.textContent = opt.label || opt;
      btn.onclick = () => answerQuestion(i);
      questionOptions.appendChild(btn);
    });
    openSheet(questionModal);
  }
  function answerQuestion(index) {
    if (!activeQuestion) return;
    socket.emit('user:answer', { requestId: activeQuestion.requestId, optionIndex: index, instanceId: viewingInstanceId }); // 台阶3 路由
    const label = activeQuestion.options[index]?.label || activeQuestion.options[index];
    addBar(`已选择：${label}`, 'text-ink-faint');
    activeQuestion = null;
    closeSheet(questionModal);
    showNextQuestion();
    // 答完最后一题（队列已空、无下一题）：立即把状态栏从过时的「正在运行工具 AskUserQuestion」
    // 切到「思考中」，填补「答完→模型首个流式事件到达」的空窗（实测中位 ~64s 模型推理）。
    // 仅状态文案，不碰任何请求/ACK 通道。若还有下一题，activeQuestion 已被 showNextQuestion 重新赋值 → 跳过。
    if (!activeQuestion && activeStatusText) {
      activeStatusText.textContent = 'Claude 正在思考中...';
    }
  }

  // ---- 发送 / 停止 ----
  function send() {
    const text = inputEl.value.trim();
    if (!text && pendingAttachments.length === 0) return; // E17：纯附件（空文本）也可发
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
    let model = modelInput.value.trim() || undefined;
    // S5：仅对「不在 supportedModels 候选里的自设名」(如 /model 手设并剥离了后缀的) 回贴网关后缀。
    // 候选内的值本就是网关合法完整名(裸别名 opus/sonnet 或显式 deepseek-v4-pro[1m])，原样发送——
    // 否则会把上个模型的后缀错贴到用户新选的别的候选(opus→opus[1m]，网关不认)。
    if (model && currentGatewaySuffix && !modelsList.some(m => (typeof m === 'string' ? m : m?.value) === model)) {
      model = model + currentGatewaySuffix;
    }
    // E17：剥掉本地 _id（非契约字段），data=完整 base64、thumb=小缩略图随消息上传
    const attachments = pendingAttachments.length
      ? pendingAttachments.map(({ _id, ...rest }) => rest)
      : undefined;

    // M2 / Weak Network Optimistic Sending Queue:
    if (!socket.connected) {
      // 离线状态：生成乐观消息气泡占位符，保存到离线重发队列，待重连后自动重发
      haptic('tap');
      const bubble = el(`<div class="msg-frame rounded-xl bg-user text-ink px-3 py-2 text-sm opacity-70 transition-opacity"></div>`);
      if (text) {
        const t = el(`<div class="whitespace-pre-wrap"></div>`);
        t.textContent = text;
        bubble.appendChild(t);
      }
      
      // 添加离线待发送的附件缩略 chip/图片预览，让离线体验达到原生级
      if (attachments && attachments.length) {
        const wrap = el(`<div class="flex flex-wrap gap-2${text ? ' mt-2' : ''}"></div>`);
        for (const a of pendingAttachments) { // pendingAttachments 含有 thumb
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
        attachments,
        bubbleEl: bubble
      });
      
      inputEl.value = '';
      pendingAttachments = [];
      renderTray();
      hints.classList.add('hidden');
      autosize();
      scrollBottom(true);
      return;
    }

    if (text.length > 50000) { addBar(`消息过长（${text.length}/50000），未发送`, 'text-danger'); return; }
    if (text.startsWith('/')) addBar(`⚡ 命令：${text}`, 'text-info');
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {});
    }

    // 台阶3：instanceId 路由到当前查看 tab；cwd 供无 tab（首发/session:new 后）时服务端懒开实例
    const attCount = Array.isArray(attachments) ? attachments.length : 0;
    logClientEvent('send', `[WEB_SEND] 发送消息: "${text.slice(0, 100)}${text.length > 100 ? '...' : ''}" (${text.length} 字符), model=${model || '未指定(沿用)'}, 附件数=${attCount}, instanceId=${viewingInstanceId || 'new'}`);
    socket.emit('user:message', { text, model, attachments, instanceId: viewingInstanceId, cwd: currentCwd });
    // F3：不再本地 append 气泡，由 user_message 事件渲染（同时入缓冲，重载可回放）
    inputEl.value = '';
    pendingAttachments = [];
    renderTray();
    hints.classList.add('hidden');
    autosize();
    setBusy(true);
    // 新会话首发（viewingInstanceId 为空）：服务端将懒开实例并广播 instances，触发 setInstances→bindView→
    // clearView 的 setBusy(false) 冲掉这次乐观 busy；置一次性标志，待 setInstances 绑定到新实例后同步补回。
    if (!viewingInstanceId) _pendingFirstSend = true;
    scrollBottom(true);
  }
  btnSend.onclick = send;
  // 中文输入法：e.isComposing + keyCode 229 双检已覆盖绝大多数现代浏览器，
  // composition 状态追踪作为旧浏览器（Safari <14、部分 Android WebView）的后备兜底
  let composing = false;
  inputEl.addEventListener('compositionstart', () => { composing = true; });
  inputEl.addEventListener('compositionend', () => { composing = false; });
  inputEl.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229 && !composing) {
      e.preventDefault();
      send();
    }
  });

  // ---- 附件（E17）：选文件 → base64 + 图片 canvas 缩略图 → 待发送托盘 ----
  const MAX_FILE = 10 * 1024 * 1024, MAX_TOTAL = 20 * 1024 * 1024, MAX_COUNT = 10; // 与服务端 uploads.js 同
  btnAttach.onclick = () => fileInput.click();
  fileInput.onchange = async () => {
    const files = [...fileInput.files];
    fileInput.value = '';                 // 清空，便于重复选同一文件
    for (const file of files) {
      if (pendingAttachments.length >= MAX_COUNT) { addBar(`附件数量已达上限（${MAX_COUNT}）`, 'text-danger'); break; }
      if (file.size > MAX_FILE) { addBar(`「${file.name}」超过 10MB，未添加`, 'text-danger'); continue; }
      const total = pendingAttachments.reduce((s, a) => s + a.size, 0);
      if (total + file.size > MAX_TOTAL) { addBar('附件总量将超过 20MB，未添加', 'text-danger'); break; }
      try {
        const [data, thumb] = await Promise.all([readBase64(file), makeThumb(file)]);
        pendingAttachments.push({
          _id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          name: file.name, mimeType: file.type || 'application/octet-stream',
          size: file.size, data, thumb: (thumb && thumb.length < 100000) ? thumb : undefined // 超 ~100KB 退化为 chip
        });
        renderTray();
      } catch { addBar(`「${file.name}」读取失败`, 'text-danger'); }
    }
  };
  // FileReader → 纯 base64（剥掉 data:<mime>;base64, 前缀；服务端 Buffer.from(data,'base64') 解码）
  function readBase64(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => { const s = String(r.result); const i = s.indexOf(','); resolve(i >= 0 ? s.slice(i + 1) : s); };
      r.onerror = () => reject(r.error);
      r.readAsDataURL(file);
    });
  }
  // 图片 canvas 降采样为小 JPEG data URI（长边≤320）供气泡预览；非图片或失败返回 null
  function makeThumb(file) {
    return new Promise(resolve => {
      if (!file.type.startsWith('image/')) return resolve(null);
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        let w = img.width, h = img.height; const max = 320;
        if (w > h && w > max) { h = Math.round(h * max / w); w = max; }
        else if (h >= w && h > max) { w = Math.round(w * max / h); h = max; }
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        let out = null; try { out = c.toDataURL('image/jpeg', 0.6); } catch { /* 跨域/超限 */ }
        resolve(out);
      };
      img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
      img.src = url;
    });
  }
  function renderTray() {
    attachTray.innerHTML = '';
    if (!pendingAttachments.length) { 
      attachTray.classList.add('hidden'); 
      updateSendButtonState();
      return; 
    }
    for (const a of pendingAttachments) {
      const chip = el(`<div class="relative flex items-center gap-1.5 bg-sunk rounded-lg pl-1.5 pr-6 py-1 text-xs max-w-[10rem]"></div>`);
      if (a.thumb) { const img = el(`<img class="w-8 h-8 rounded object-cover shrink-0">`); img.src = a.thumb; chip.appendChild(img); }
      else chip.appendChild(el(`<span class="shrink-0">📎</span>`));
      const nm = el(`<span class="truncate"></span>`); nm.textContent = a.name; chip.appendChild(nm);
      const rm = el(`<button class="absolute right-1 top-1/2 -translate-y-1/2 text-ink-faint active:text-danger">✕</button>`);
      rm.onclick = () => { pendingAttachments = pendingAttachments.filter(x => x._id !== a._id); renderTray(); };
      chip.appendChild(rm);
      attachTray.appendChild(chip);
    }
    attachTray.classList.remove('hidden');
    updateSendButtonState();
  }

  // ---- 斜杠命令提示 ----
  const hints = el(`<div id="cmdHints" class="hidden absolute bottom-full left-0 mb-1 bg-surface border border-line rounded-lg max-h-60 overflow-y-auto w-full z-50" style="box-shadow:var(--shadow-pop)"></div>`);
  inputEl.parentElement.style.position = 'relative';
  inputEl.parentElement.appendChild(hints);
  // 前端本地拦截命令（不透传后端），并入提示列表
  const LOCAL_COMMANDS = ['model'];

  inputEl.addEventListener('input', () => {
    const val = inputEl.value;
    if (val.startsWith('/')) {
      const base = window.availableSkills || [];
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
    const hasText = inputEl.value.trim().length > 0 || pendingAttachments.length > 0;
    if (hasText) {
      btnSend.className = "flex items-center justify-center w-9 h-9 rounded-full bg-ink text-surface hover:bg-ink-soft active:scale-95 shadow-sm transition-all duration-200 shrink-0";
      btnSend.disabled = false;
    } else {
      btnSend.className = "flex items-center justify-center w-9 h-9 rounded-full bg-transparent text-ink-faint opacity-40 cursor-not-allowed transition-all duration-200 shrink-0";
      btnSend.disabled = true;
    }
  }

  function autosize() {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 144) + 'px';
    updateSendButtonState();
  }
  updateSendButtonState();

  btnStop.onclick = () => socket.emit('user:interrupt', { instanceId: viewingInstanceId }); // 台阶3：中断当前查看 tab 的在途任务
  if (btnStopNew) {
    btnStopNew.onclick = () => {
      haptic('tap');
      socket.emit('user:interrupt', { instanceId: viewingInstanceId });
    };
  }

  // ---- 权限档切换（5 档；dontAsk 非交互档，终端 Shift+Tab 切不到）----
  // setPermMode 仅由 init/permission_mode 服务端事件驱动（权威回执，函数声明有提升），onchange 不再
  // 乐观调用——故上屏的系统条 = 服务端已确认切换。程序设 select.value 不触发 onchange，无回声循环。
  const PERM_LABEL = {
    default: '默认（白名单外弹窗审批）',
    plan: '计划模式',
    acceptEdits: '自动接受编辑',
    dontAsk: '免打扰（白名单外直接拒）',
    bypassPermissions: '⚠️ bypass（跳过所有审批）'
  };
  function setPermMode(mode, silent = false) {
    if (!permModeSelect || !mode) return;
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
    if (!silent && effortSeen && val !== currentEffort) {
      addBar(`思考强度 → ${val || '模型默认'}（下一条消息生效）`, 'text-ink-faint');
    }
    effortSeen = true;
    currentEffort = val;
    effortSelect.value = val || '';

    // Sync Pill Display Text
    if (pillEffortText) {
      pillEffortText.textContent = val || '默认思考';
    }

    // Sync Custom Effort Tiles Selection Styling
    if (customEffortGrid) {
      customEffortGrid.querySelectorAll('.effort-tile').forEach(tile => {
        const tileVal = tile.dataset.level || '';
        const isCurrent = (val || '') === tileVal;
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
    const { hidden, levels: show } = effortLevelsFor(modelValue, modelsList);
    if (hidden) {
      effortRow?.classList.add('hidden');
      pillEffort?.classList.add('hidden');
      customEffortGroup?.classList.add('hidden');
      return;
    }
    effortRow?.classList.remove('hidden');
    pillEffort?.classList.remove('hidden');
    customEffortGroup?.classList.remove('hidden');

    effortSelect.innerHTML = '';
    const def = document.createElement('option'); def.value = ''; def.textContent = '（模型默认）';
    effortSelect.appendChild(def);
    for (const lv of show) { const o = document.createElement('option'); o.value = lv; o.textContent = lv; effortSelect.appendChild(o); }
    // 保留当前档（仍在新列表里则保持，否则回落「模型默认」）
    effortSelect.value = (currentEffort && show.includes(currentEffort)) ? currentEffort : '';

    // Dynamic tactile grid population inside #customEffortGrid
    if (customEffortGrid) {
      customEffortGrid.innerHTML = '';
      
      const currentVal = effortSelect.value || '';
      const defActive = !currentVal;
      const defTile = el(`
        <div data-level="" class="effort-tile p-2.5 rounded-xl border border-line bg-surface active:bg-sunk cursor-pointer transition-all ${defActive ? 'ring-1 ring-accent border-accent text-accent bg-accent-wash/30' : ''}">
          <div class="text-xs font-semibold ${defActive ? 'text-accent' : 'text-ink'}">模型默认</div>
          <div class="text-[9.5px] text-ink-soft mt-0.5">默认思考时长</div>
        </div>
      `);
      defTile.onclick = () => {
        haptic('tap');
        effortSelect.value = '';
        effortSelect.onchange();
      };
      customEffortGrid.appendChild(defTile);

      for (const lv of show) {
        const active = currentVal === lv;
        const lvTile = el(`
          <div data-level="${lv}" class="effort-tile p-2.5 rounded-xl border border-line bg-surface active:bg-sunk cursor-pointer transition-all ${active ? 'ring-1 ring-accent border-accent text-accent bg-accent-wash/30' : ''}">
            <div class="text-xs font-semibold ${active ? 'text-accent' : 'text-ink'}">${lv}</div>
            <div class="text-[9.5px] text-ink-soft mt-0.5">思考等级: ${lv}</div>
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
  }
  effortSelect.onchange = () => {
    const level = effortSelect.value || null;
    if (level === currentEffort) return;
    socket.emit('user:setEffort', { level });
    // 不乐观更新：成功则 effort_mode 广播拨档 + 上屏；busy/非法档则 server 发 system 提示
    // 并单发当前档拨回本设备 select
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
    updateModelAndSuffix(inst.model || '');
    if (modelInput) {
      if (inst.model) {
        ensureModelOption(currentModel);
        modelInput.value = currentModel;
        rebuildEffortOptions(currentModel);
      } else {
        modelInput.value = '';
      }
      syncModelUI(currentModel);
    }
    setPermMode(inst.permissionMode || 'default', true);
    setEffortMode(inst.effort ?? null, true);
  }

  // tab 栏快照回执/重放（台阶3，Step A+B 均已落地）。首次只定基线不动视图（刷新/重连不清空）；
  // viewingInstanceId 变了才切视图（bindView：sync 活缓冲/回退 history）；cwd 变了全量刷新面板。
  // dirs + per-cwd 聚合 states 供目录切换器角标（steps 回归补回入口，见 openSessionPanel）。
  function setInstances(p) {
    availableDirs = Array.isArray(p?.dirs) ? p.dirs : [];
    instancesList = Array.isArray(p?.instances) ? p.instances : [];
    const newStates = aggregateStates(instancesList, availableDirs); // per-cwd 聚合（permission>busy>done>idle）
    const newViewing = p?.viewingInstanceId ?? null;
    const newCwd = p?.viewingCwd ?? null;
    const cwdChanged = cwdSeen && newCwd && newCwd !== currentCwd;
    if (cwdSeen) notifyStateChanges(newStates, newCwd); // 首次只定基线不通知（刷新/重连不冒假通知）
    workdirStates = newStates;
    currentCwd = newCwd;
    viewingInstanceId = newViewing;
    cwdSeen = true;
    instancesReady = true; // 视图状态已知：此后 shouldDropAgentEvent 按 viewingInstanceId 精确分流（含 null 空窗口）

    // REDESIGN: Update active workspace text pill
    if (topProjectText) {
      topProjectText.textContent = baseName(currentCwd);
      topContextPill.title = currentCwd ? `查看工作区、会话列表和后台状态：${currentCwd}` : '查看工作区、会话列表和后台状态';
    }
    // pillWorkspace（📁 状态 pill）显当前工作区名——该 pill 是工作区入口，显 model 名是名实错配（2026-06-21）
    if ($('pillWorkspaceText')) $('pillWorkspaceText').textContent = baseName(currentCwd);
    if (topTitleText) {
      topTitleText.textContent = shouldShowStartScreen({ viewingInstanceId: newViewing, sessionId: instancesList.find(x => x.instanceId === newViewing)?.sessionId }) ? '新聊天' : '聊天';
    }
    // 保持纯手动展开折叠，不自动展开任何工作区目录

    // 切视图：viewingInstanceId 变了重载；空首页内换工作区（newViewing 恒 null、cwd 变了）也重渲——
    // 否则 dashboard 工作区名 + 模型 chip 残留上个工作区（本次修复的 bug 正出于此：两个 null 空首页被判为「视图没变」）
    const startScreenCwdChanged = !newViewing && cwdChanged;
    if (newViewing !== displayedInstanceId || startScreenCwdChanged) {
      const target = instancesList.find(x => x.instanceId === newViewing);
      adoptPanelState(target);          // 先静默同步顶部面板到新实例档（先于 bindView 的 sync 回放）
      // 空首页（无实例）：① 模型不显具体名（新会话模型=env 默认、服务端不可知）→「不指定」，modelInput 归零；
      // ② 权限/思考强度显"下条新会话将用的真实档"（server defaultPermissionMode/defaultEffort = pending ?? CLI 启动默认），
      // silent 同步不上屏——修空首页残留上个会话档（A1，2026-06-22）。
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
    }
    updateSessionsDot();
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
        openSessionPanel();
      } else {
        refreshDirBadges();
      }
    } else {
      refreshDirBadges();
    }
  }

  // aggregateStates 已抽到 logic.js（顶部 import）。
  // 切视图到指定实例（台阶3）：清视图 → sync 活缓冲（重建在途流 + 挂起审批弹窗）→ 无缓冲回退 history。
  // entry 缺失/无 sessionId（新会话尚未 init）= 空白，事件流入自然渲染。
  function bindView(entry, id) {
    const prevInstanceId = displayedInstanceId; // S1：缓存归属的(外出)实例，供切回时检测实例是否被替换
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

    clearView(sid, null);

    if (shouldShowStartScreen({ viewingInstanceId: id, sessionId: sid })) {
      showDashboard();
      return;
    }

    // Phase 2: Check memory cache for instant restoration
    let hasCache = false;
    let resumeFromSeq = 0;
    const cached = sid ? sessionDomCache.get(sid) : null;
    // S1 epoch 边角：仅当「缓存归属的实例 === 当前实例」才复用增量。该会话的实例若被替换（effort 切档=
    // dispose+open 出新 instanceId+新 epoch），旧缓存的 lastSeq/epoch 对不上新实例的 seq 空间，复用会显示
    // 陈旧内容、漏掉新实例的事件 → 改判无缓存，走整重载（showLoadingCard→sync:since(0)→回放新实例缓冲/history）。
    if (cached && cached.instanceId === id) {
      for (const node of cached.nodes) messagesEl.appendChild(node);
      // S1：恢复去重基线到缓存反映的位置，sync:since 只增量续传缓存之后的新事件（同 epoch、seq>缓存位置）。
      // 既不与缓存重复，也不丢失（缓存=上次完整渲染含历史；回放只补离开期间漏掉的几条）。
      curEpoch = cached.epoch;
      lastSeq = cached.lastSeq;
      resumeFromSeq = cached.lastSeq;
      scrollBottom(true);
      hasCache = true;
    } else {
      showLoadingCard();
    }

    socket.emit('sync:since', { instanceId: id, sessionId: sid, lastSeq: resumeFromSeq }, res => {
      if (displayedInstanceId !== id) return;        // 已切走：丢弃过期回调
      // S1：不再 innerHTML=''。hasCache 时已增量续传（resumeFromSeq=缓存位置，回放只含新事件、append 不重复）；
      // 无缓存且 replayed===0 → 回退 history；其余（无缓存有回放 / 有缓存）直接收尾。
      if (res && res.replayed === 0 && !hasCache) {
        loadHistory(sid, entry.cwd);
      } else if (res && res.gap) {
        // 缓冲超窗、回放残缺 → 清屏全量重载历史（同重连路径 syncAckAction 的 gap→reload，不把残缺当完整）
        clearView(sid, null); showLoadingCard(); loadHistory(sid, entry.cwd);
      } else {
        hideLoadingCard();
      }
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
  const DIR_BADGE = { busy: ['⏳', 'text-warning'], permission: ['⚠️', 'text-danger'], error: ['❗', 'text-danger'], done: ['✅', 'text-success'] };
  function applyBadge(badge, state) {
    const m = DIR_BADGE[state];
    if (m) { badge.textContent = m[0]; badge.className = `dir-badge ml-auto shrink-0 ${m[1]}`; }
    else { badge.textContent = ''; badge.className = 'dir-badge hidden'; }
  }
  // 面板开着时仅更新已渲染目录行的角标（不重发 session:list）
  function refreshDirBadges() {
    sessionPanel.querySelectorAll('[data-dir]').forEach(row => {
      const badge = row.querySelector('.dir-badge');
      if (badge) applyBadge(badge, workdirStates[row.dataset.dir]);
    });
  }
  // 会话按钮汇总圆点：非查看目录有动静即亮，优先级 permission/error(红) > done(绿) > busy(琥珀)
  function updateSessionsDot() {
    if (!sessionsDot) return;
    let level = 0; // 0 无 / 1 busy / 2 done / 3 error / 4 permission
    for (const d of availableDirs) {
      if (d === currentCwd) continue;
      const st = workdirStates[d];
      if (st === 'permission') level = 4;
      else if (st === 'error') level = Math.max(level, 3);
      else if (st === 'done') level = Math.max(level, 2);
      else if (st === 'busy') level = Math.max(level, 1);
    }
    const color = { 4: 'bg-danger', 3: 'bg-danger', 2: 'bg-success', 1: 'bg-warning' }[level];
    const base = 'absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full border border-surface';
    sessionsDot.className = color ? `${base} ${color}` : `hidden ${base}`;
  }


  let _busyState = false;
  let _pendingFirstSend = false; // 新会话首发乐观 busy 需跨越懒开后的 bindView→clearView(setBusy(false))；见 send()/setInstances
  function setBusy(b) {
    if (!activeStatusPill || b === _busyState) return;
    _busyState = b;
    if (b) {
      activeStatusPill.classList.remove('hidden');
      activeStatusPill.offsetHeight; // 触发 CSS 过渡所需的单次强制 layout（仅在 false→true 时执行一次）
      activeStatusPill.classList.add('pill-active');
      if (activeStatusText) {
        activeStatusText.textContent = 'Claude 正在执行任务...';
      }
    } else {
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

  // ---- 触觉配置面板抽屉控制器 (Settings Sheet Controllers) ----
  function openSettingsSheet() {
    haptic('tap');
    if (settingsSheet) settingsSheet.classList.remove('translate-y-full');
    if (settingsScrim) settingsScrim.classList.remove('hidden');
  }
  function closeSettingsSheet() {
    haptic('tap');
    if (settingsSheet) settingsSheet.classList.add('translate-y-full');
    if (settingsScrim) settingsScrim.classList.add('hidden');
  }

  if (btnSettings) btnSettings.onclick = openSettingsSheet;
  if (settingsClose) settingsClose.onclick = closeSettingsSheet;
  if (settingsScrim) settingsScrim.onclick = closeSettingsSheet;

  if (pillModel) pillModel.onclick = openSettingsSheet; // 点底栏模型 chip → 开「选择模型」格
  if (topContextPill) {
    topContextPill.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleSessions();
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

    // 面板标题
    sessionPanel.appendChild(el(`<div class="px-3 py-1.5 text-[10px] uppercase tracking-wide text-ink-faint border-b border-line">工作区</div>`));

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

      const toggleBtn = el(`<button class="flex-1 min-w-0 text-left flex items-center gap-2 py-0.5 active:opacity-70"></button>`);
      const icon = el(`<span class="shrink-0"></span>`); icon.textContent = isExpanded ? '📂' : '📁';
      const arrow = el(`<span class="shrink-0 text-[10px] w-3"></span>`); arrow.textContent = isExpanded ? '▼' : '▶';
      const name = el(`<span class="truncate"></span>`); name.textContent = baseName(d);
      const badge = el(`<span class="dir-badge hidden"></span>`);
      applyBadge(badge, workdirStates[d]);

      toggleBtn.appendChild(icon);
      toggleBtn.appendChild(arrow);
      toggleBtn.appendChild(name);
      toggleBtn.appendChild(badge);
      dirRow.appendChild(toggleBtn);

      const newSessionBtn = el(`<button class="shrink-0 w-5 h-5 rounded flex items-center justify-center border border-line-soft text-ink-faint hover:text-accent hover:border-accent hover:bg-accent-wash active:scale-95 text-xs font-bold" title="在此工作区新建会话">＋</button>`);
      newSessionBtn.onclick = (e) => {
        e.stopPropagation();
        closeLeftSidebar();
        haptic('tap');
        socket.emit('session:new', { cwd: d }); // 模型清单由后端 pushModelsForCwd 主动推、不再前端拉
      };
      dirRow.appendChild(newSessionBtn);

      toggleBtn.onclick = () => {
        haptic('tap');
        if (expandedDirs.has(d)) {
          // 折叠
          expandedDirs.delete(d);
        } else {
          // 展开
          expandedDirs.add(d);
        }
        openSessionPanel();
      };
      sessionPanel.appendChild(dirRow);

      // ---- 展开区（仅展开的目录显示子节点） ----
      if (!isExpanded) continue;

      // ---- 纯 /resume 单一列表：所有会话按 lastUsedAt 倒序混排成一条列表（与 CLI /resume 同源同序）；
      //      已打开（live）的就地标记（active 高亮 + 状态角标 + ✕ 关闭，点击切 tab 不重新 resume），
      //      未打开的点击 resume；不再把打开的会话单列到顶部（机主 2026-06-15：要纯 /resume 形态）。----
      const tabs = liveByCwd[d] || [];
      const liveBySession = new Map();        // sessionId → 已打开实例（有 id 的 live tab，用于在 /resume 列表中就地标记）
      const freshTabs = [];                   // 无 sessionId 的新会话实例（尚未保存，/resume 列表看不到、无时间）
      for (const inst of tabs) { if (inst.sessionId) liveBySession.set(inst.sessionId, inst); else freshTabs.push(inst); }
      const subtree = el(`<div></div>`);
      const listCwd = d;

      // 统一行：一条会话（session:list 的 s，或无 id 的新会话）→ DOM 行。liveInst 非空 = 已打开为 tab。
      // 全程 textContent（无 innerHTML 插值用户数据）→ CSP 安全。
      const sessionRow = (s, liveInst) => {
        const active = liveInst && liveInst.instanceId === viewingInstanceId;
        
        // 使用相对定位的包装容器来实现侧滑关闭
        const container = el(`<div class="relative overflow-hidden w-full select-none swipe-row-container"></div>`);
        
        // 背景红底“关闭”按钮
        let deleteBtn = null;
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
        const rowContent = el(`<div class="row-content relative flex items-center gap-2 pl-6 pr-3 py-2 border-b border-line-soft transition-transform duration-200 cursor-pointer${active ? ' bg-accent-wash' : ' bg-surface'}" style="z-index: 20;" data-testid="session-row" data-session-id="${s.id || ''}" data-instance-id="${liveInst?.instanceId || ''}"></div>`);
        const btn = el(`<button class="flex-1 min-w-0 text-left text-xs active:opacity-70"></button>`);
        btn.title = s.title || '新会话';
        const head = el(`<div class="truncate flex items-center gap-1.5"></div>`);
        const titleSpan = el(`<span class="truncate font-medium${active ? ' text-accent' : ' text-ink-soft'}"></span>`);
        titleSpan.textContent = s.title || '新会话';
        head.appendChild(titleSpan);
        if (liveInst) {                        // 已打开标记：状态角标（busy ⏳ / permission ⚠️ / error ❗ / done ✅）
          const m = DIR_BADGE[liveInst.state];
          if (m) { const b = el(`<span class="shrink-0"></span>`); b.textContent = m[0]; b.className = `shrink-0 ${m[1]}`; head.appendChild(b); }
        }
        btn.appendChild(head);
        const sub = el(`<div class="text-ink-faint text-[10px]"></div>`);
        const when = s.lastUsedAt ? new Date(s.lastUsedAt).toLocaleString() : '新会话（未保存）';
        sub.textContent = when + (liveInst ? ' · 已打开' : '');
        btn.appendChild(sub);
        
        let rowSwiped = false;
        btn.onclick = () => {
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
            socket.emit('session:switch', { sessionId: s.id, cwd: listCwd }, res => { acked = true; if (!res?.ok) addBar(res?.error || '切换失败', 'text-danger'); });
            setTimeout(() => { if (!acked) addBar('切换无响应，请刷新页面后重试', 'text-danger'); }, 4000);
          }
        };
        rowContent.appendChild(btn);

        // 原生 x 按钮（在 PC 端作为辅助，手机端优先侧滑）
        if (liveInst) {
          const closeBtn = el(`<button class="shrink-0 w-6 h-6 rounded text-ink-faint hover:text-danger hover:bg-sunk active:bg-line text-sm md:block hidden">✕</button>`);
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

        container.appendChild(rowContent);

        // 手机端：侧滑触控手势监听 (Swipe left gestures)
        if (liveInst) {
          let rowStartX = 0, rowStartY = 0;
          rowContent.addEventListener('touchstart', ev => {
            rowStartX = ev.touches[0].clientX;
            rowStartY = ev.touches[0].clientY;
          }, { passive: true });

          rowContent.addEventListener('touchmove', ev => {
            if (!rowStartX) return;
            const currentX = ev.touches[0].clientX;
            const currentY = ev.touches[0].clientY;
            const diffX = currentX - rowStartX;
            const diffY = currentY - rowStartY;

            if (Math.abs(diffX) > Math.abs(diffY) * 1.5) {
              if (diffX < -35 && !rowSwiped) { // 向左滑动：露出“关闭”
                rowContent.style.transform = 'translateX(-70px)';
                rowSwiped = true;
                haptic('tap');
              } else if (diffX > 35 && rowSwiped) { // 向右滑动：收回
                rowContent.style.transform = 'translateX(0px)';
                rowSwiped = false;
                haptic('tap');
              }
            }
          }, { passive: true });

          rowContent.addEventListener('touchend', () => {
            rowStartX = 0;
            rowStartY = 0;
          }, { passive: true });
        }

        return container;
      };

      // 1) 无 id 的新会话实例（/resume 列表里没有、无时间戳）——置顶（视为"最新、未保存"）
      for (const inst of freshTabs) subtree.appendChild(sessionRow({ id: null, title: inst.title, lastUsedAt: null, entrypoint: null }, inst));
      // 2) session:list（与 CLI /resume 同源，按 lastUsedAt 倒序）——统一列表，已打开者就地标记。
      //    过期守卫：仅当目录依然处于展开状态时渲染，防止误渲染旧回调。
      socket.emit('session:list', { cwd: listCwd }, state => {
        if (!expandedDirs.has(listCwd)) return;
        for (const s of (state?.sessions || [])) subtree.appendChild(sessionRow(s, liveBySession.get(s.id)));
      });

      sessionPanel.appendChild(subtree); // 子容器紧接在目录头行之后
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
    permQueue.length = 0; activePerm = null;
    permExpandBtn?.remove(); permExpandBtn = null;
    closeSheet(permModal);
    questionQueue.length = 0; activeQuestion = null;
    closeSheet(questionModal);
    pendingAttachments = []; renderTray();   // E17：切换/新建清空待发送附件托盘
    setBusy(false);

    // Clear stale status line and hide details row to prevent latency layout flashes
    if (cliStatusEl) cliStatusEl.innerHTML = '';
    if (cliSummaryEl) cliSummaryEl.textContent = '终端状态行';
    if (cliStatusWrapEl) {
      cliStatusWrapEl.removeAttribute('open'); // Fold <details> element
      cliStatusWrapEl.classList.add('hidden'); // Hide the wrapper
    }
    pillModel?.classList.remove('hidden'); // 恢复底栏模型 chip（statusLine 隐藏时）
    if (tip) addBar(tip, 'text-ink-faint');
  }

  function showDashboard() {
    messagesEl.innerHTML = '';
    messagesEl.classList.add('empty-start');
    if (topTitleText) topTitleText.textContent = '新聊天';
    if (topProjectText) topProjectText.textContent = baseName(currentCwd);

    const hour = new Date().getHours();
    let greeting = '今天我能帮您做什么？';
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
          <button class="empty-project-pill inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full border border-line-soft bg-surface text-ink hover:bg-sunk active:scale-[0.98] transition-all text-xs font-semibold shadow-sm" title="点击选择工作区">
            <svg class="w-4 h-4 shrink-0 text-accent opacity-90" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M3 7.5A2.5 2.5 0 015.5 5h4.25l2 2H18.5A2.5 2.5 0 0121 9.5v7A2.5 2.5 0 0118.5 19h-13A2.5 2.5 0 013 16.5v-9z" />
            </svg>
            <span class="max-w-[12rem] truncate">${esc(baseName(currentCwd))}</span>
            <span class="text-xs text-ink-faint">⌄</span>
          </button>
        </div>

        <div id="dashRecentsSection" class="w-full hidden">
          <div class="text-[10.5px] font-bold text-ink-faint uppercase tracking-wider mb-3 px-1 flex items-center gap-1">
            <span>⏱️</span>
            <span>最近活跃会话 (Resume)</span>
          </div>
          <div id="dashRecentsList" class="flex flex-col gap-2 w-full"></div>
        </div>
      </div>`);

    // 绑定工作区按钮
    container.querySelector('button').onclick = (e) => {
      e.stopPropagation();
      haptic('tap');
      if (btnSessions) btnSessions.onclick();
    };

    // 异步加载最近 3 个会话
    const recentsSection = container.querySelector('#dashRecentsSection');
    const recentsList = container.querySelector('#dashRecentsList');
    if (recentsSection && recentsList) {
      socket.emit('session:list', { cwd: currentCwd }, state => {
        const list = state?.sessions || [];
        if (list.length > 0) {
          recentsSection.classList.remove('hidden');
          recentsList.innerHTML = '';
          list.slice(0, 3).forEach(s => {
            const when = s.lastUsedAt ? new Date(s.lastUsedAt).toLocaleString() : '新会话';
            const item = el(`
              <div class="dash-recent-item flex items-center justify-between p-3 bg-surface hover:bg-accent-wash/30 border border-line-soft hover:border-accent-bright/50 rounded-xl cursor-pointer transition-all active:scale-[0.99]">
                <div class="flex-1 min-w-0 pr-3">
                  <div class="font-bold text-xs text-ink truncate">${esc(s.title || '无标题会话')}</div>
                  <div class="text-[10px] text-ink-faint mt-1 flex items-center gap-1.5">
                    <span>⏱️ ${esc(when)}</span>
                  </div>
                </div>
                <div class="text-xs text-accent font-bold shrink-0">进入 ➔</div>
              </div>
            `);
            item.onclick = (e) => {
              e.stopPropagation();
              haptic('tap');
              let acked = false;
              socket.emit('session:switch', { sessionId: s.id, cwd: currentCwd }, res => {
                acked = true;
                if (!res?.ok) addBar(res?.error || '切换失败', 'text-danger');
              });
              setTimeout(() => { if (!acked) addBar('切换无响应，请刷新页面后重试', 'text-danger'); }, 4000);
            };
            recentsList.appendChild(item);
          });
        }
      });
    }

    messagesEl.appendChild(container);
  }

  function loadHistory(sessionId, cwd = currentCwd) {
    if (!sessionId) return;
    socket.emit('session:history', { sessionId, cwd }, res => {
      hideLoadingCard();
      const msgs = res?.messages || [];
      if (!msgs.length) {
        if (res?.error) addBar('历史消息加载失败', 'text-ink-faint');
        return;
      }
      addBar(`加载了 ${msgs.length} 条历史消息`, 'text-ink-faint');
      const frag = document.createDocumentFragment();
      const codeBlocks = [];
      for (const msg of msgs) {
        const isUser = msg.role === 'user';
        const bubble = isUser
          ? el(`<div class="msg-frame bg-user text-ink um rounded-xl px-3 py-2 text-sm msg-body"></div>`)
          : el(`<div class="msg-frame px-0.5 msg-body"></div>`);
        bubble.innerHTML = render(msg.content);
        bubble.querySelectorAll('pre code').forEach(b => codeBlocks.push(b));
        appendCopyAction(bubble, () => msg.content, isUser ? 'right' : 'left');
        frag.appendChild(bubble);
      }
      leaveStartScreen();
      messagesEl.appendChild(frag); // 一次性插入，避免 N 次 live-DOM reflow
      scrollBottom(true);
      if (codeBlocks.length) {
        const doHighlight = () => codeBlocks.forEach(b => hljs.highlightElement(b));
        if (typeof requestIdleCallback !== 'undefined') {
          requestIdleCallback(doHighlight, { timeout: 2000 });
        } else {
          setTimeout(doHighlight, 0);
        }
      }
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
        if (sibling.classList.contains('bg-user') || (sibling.classList.contains('msg-body') && sibling.querySelector('.whitespace-pre-wrap'))) {
          // If the element is user message
          const textEl = sibling.querySelector('.whitespace-pre-wrap') || sibling;
          prevUserText = textEl.textContent || '';
          prevUserText = prevUserText.replace(/✓ 已复制|⧉ 复制|复制|已复制|编辑|朗读|停止/g, '').trim();
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

  function setStatus(text) { statusEl.textContent = text; }
  function leaveStartScreen() {
    if (!messagesEl.classList.contains('empty-start')) return;
    messagesEl.classList.remove('empty-start');
    messagesEl.innerHTML = '';
  }
  function appendMessage(node) {
    leaveStartScreen();
    return messagesEl.appendChild(node);
  }
  function addBar(text, cls) {
    appendMessage(el(`<div class="msg-frame text-center text-xs ${cls}"></div>`)).textContent = text;
    scrollBottom();
  }
  function el(html) {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstChild;
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

  function notify(title, body) {
    if (!document.hidden || !('Notification' in window) || Notification.permission !== 'granted') return;
    try { new Notification(title, { body, icon: '/icons/icon-192.png', tag: 'ccm' }); } catch { /* iOS 非 PWA 等场景静默 */ }
  }

  // E15：Web Push 订阅
  function urlBase64ToUint8Array(b64) {
    const pad = '='.repeat((4 - b64.length % 4) % 4);
    const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
  }
  let pushVapidKey = null; // 缓存公钥，避免每次重连重复 fetch

  async function doSubscribe() {
    // 实际执行订阅（需在有权限后调用）
    try {
      const reg = await navigator.serviceWorker.register('/js/sw.js');
      await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(pushVapidKey),
        });
      }
      const authQ = token ? `?token=${encodeURIComponent(token)}` : '';
      const r = await fetch(`/push/subscribe${authQ}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sub),
      });
      if (!r.ok) { console.warn('[push] 订阅未保存(HTTP', r.status + ')'); return; } // Access 过期/未配置不静默成功
      btnPush?.classList.add('hidden'); // 订阅成功，隐藏入口
    } catch (e) {
      console.warn('[push] 订阅失败:', e.message);
    }
  }

  async function setupPush() {
    // connect 时调用：push 未配置则静默退出；已授权则静默续订；未授权则亮出 🔔 按钮等用户手势
    if (!window.isSecureContext || !('serviceWorker' in navigator) || !('PushManager' in window)) return;
    if (!pushVapidKey) {
      try {
        const authQ = token ? `?token=${encodeURIComponent(token)}` : '';
        const r = await fetch(`/push/vapid-public-key${authQ}`);
        if (!r.ok) return; // push 未配置，优雅缺席
        pushVapidKey = (await r.json()).key;
      } catch { return; }
    }
    if (Notification.permission === 'granted') {
      doSubscribe(); // 已授权：静默续订（重连幂等）
    } else if (Notification.permission !== 'denied') {
      btnPush?.classList.remove('hidden'); // 未决：亮出按钮，等用户手势
    }
  }

  if (btnPush) {
    btnPush.onclick = async () => {
      if (!window.isSecureContext) {
        alert('⚠️ 订阅失败：推送通知仅支持在安全上下文（HTTPS 或 localhost）中启用，当前 HTTP 协议已被浏览器拦截。');
        addBar('⚠️ 订阅失败：推送通知仅支持在安全上下文（HTTPS 或 localhost）中启用，当前 HTTP 协议已被浏览器拦截', 'text-danger');
        return;
      }
      if (!pushVapidKey) {
        alert('⚠️ 订阅失败：服务端未启用或配置 Web Push 密钥，或当前未加载成功密钥。请检查 VAPID 环境变量并重启服务。');
        addBar('⚠️ 订阅失败：服务端未启用/配置 Web Push 密钥，或当前未加载成功密钥。请检查 VAPID 环境变量并重启服务。', 'text-danger');
        return;
      }
      try {
        if (typeof Notification === 'undefined') {
          throw new Error('当前浏览器/环境不支持 Notification API');
        }
        const perm = await Notification.requestPermission(); // 用户手势触发，Chrome 可弹权限框
        if (perm === 'granted') {
          await doSubscribe();
          alert('🔔 成功订阅推送通知！当 Claude 完成后台任务或需要审批权限时，您将在手机或桌面端收到系统推送消息。');
          addBar('🔔 成功订阅推送通知！', 'text-success');
        } else {
          alert('🚫 接收推送通知权限已被拒绝，可在浏览器地址栏左侧设置中重新允许。');
          addBar('🚫 接收推送通知权限已被拒绝，可在浏览器地址栏左侧设置中重新允许', 'text-warning');
          btnPush.classList.add('hidden'); // 已拒绝，不再显示
        }
      } catch (err) {
        alert(`❌ 订阅出错: ${err.message}`);
        addBar(`❌ 订阅出错: ${err.message}`, 'text-danger');
      }
    };
  }

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
      if (consoleLogArea) consoleLogArea.innerHTML = '';
      return;
    }
    socket.emit('logs:get', { instanceId: instId }, (res) => {
      if (!consoleLogArea) return;
      consoleLogArea.innerHTML = '';
      let mergedLogs = [];
      if (res && Array.isArray(res.logs)) {
        mergedLogs = [...res.logs];
      }
      // 只合并属于本实例(或连接级恒显)的 client 日志——修切工作区残留上个区日志（clientLogBuffer 全局无隔离）。
      // 服务端日志(res.logs)已按 sessionId 隔离、无 instanceId 字段，不经此过滤。
      mergedLogs = mergedLogs.concat(clientLogBuffer.filter(e => logEntryVisibleForInstance(e, instId)));
      mergedLogs.sort((a, b) => a.ts - b.ts);
      if (mergedLogs.length > 200) {
        mergedLogs = mergedLogs.slice(mergedLogs.length - 200);
      }
      mergedLogs.forEach(log => appendLogEntry(log));
    });
  }

  function appendLogEntry(p) {
    if (!p || !consoleLogArea) return;
    const row = document.createElement('div');
    row.className = 'flex items-start gap-1.5 leading-5 font-mono text-[11px]';
    
    const tsStr = p.ts ? new Date(p.ts).toLocaleTimeString() : new Date().toLocaleTimeString();
    const tsSpan = document.createElement('span');
    tsSpan.className = 'text-gray-500 select-none shrink-0 font-semibold';
    tsSpan.textContent = `[${tsStr}]`;
    row.appendChild(tsSpan);

    const badgeSpan = document.createElement('span');
    badgeSpan.className = 'px-1 py-0.5 rounded text-[9px] uppercase font-bold tracking-wider shrink-0';
    let badgeText = '';
    let textClass = 'text-gray-300';
    
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
    row.appendChild(badgeSpan);

    // 模型 ID 独立 chip（紧邻 type 角标）：仅当 entry 带 model 时渲染；中性配色区别于 type 语义色
    if (p.model) {
      const modelSpan = document.createElement('span');
      modelSpan.className = 'px-1 py-0.5 rounded text-[9px] font-bold shrink-0 bg-slate-800 text-slate-300 border border-slate-600/50 max-w-[120px] truncate';
      modelSpan.textContent = p.model;
      modelSpan.title = p.model; // 超长截断时悬停看全名
      row.appendChild(modelSpan);
    }

    const textSpan = document.createElement('span');
    textSpan.className = `break-all whitespace-pre-wrap ${textClass}`;
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
