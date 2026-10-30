// 左侧栏（会话抽屉）：目录树与会话行的构建 / 按目录增量重建 / 换序、「需要你」与服务通知小节、目录未读角标与跳转、
// 顶栏注意力 chip 与 #sessionsDot、抽屉开着时的 SWR 保鲜轮询、在某目录开新会话。
// #359 Step 4 从 app.js 原样迁出；只有本模块用的几份状态（显示更多档位、终端聚合态、保鲜计时器、未读跳转）随代码搬入，
// 与 app.js 共用的可变态经 getter / setter 注入，声明在实例化点之后的依赖经惰性包装注入。

import { MISSING_FOLDERS_NOTICE_ID, disconnectFolderConfirm, displaySessionTitle, esc, folderReasonText, folderRowMenuItems, formatServiceNoticeRows, formatSessionRowSubtitle, formatSessionRowTime, liveRowsForSection, openSessionsUnderRoot, orphanLiveRows, remainingOlderSessionCount, resolveDrawerStatus, resolveDrawerStatusChip, resolveHeaderAttentionChip, resolveHeaderConnBadge, resolveRowTerminalState, sessionRowMenuItems, shouldRerenderSessionList, summarizeOtherWorkspaces, undismissedServiceNotices, unownedLiveInstances, whatNeedsAttention } from '../logic.js';
import { attachFolderDrag } from './folder-drag.js';
import { bindSessionRowsHost, bindSessionSearchInput } from './session-search.js';
import { createDrawerUnreadJump } from './drawer-unread-jump.js';
import { createLastKnownExpiry } from './terminal-state-expiry.js';
import { resolveDirUnreadBadge, unreadSessionsInGroup } from '../logic/unread.js';
import { t, tk } from '../i18n.js';

export function createSessionSidebar(context, {
  appConfirm, applyDeepLink, applySessionDraftSwap, attachments, attentionChipEl, baseName, closeLeftSidebar,
  composePage, connBanner, connDot, connDotWrap, dismissBlockedSurfaceIfTarget, drawer, el,
  ensureEmptySurface, enterComposeReady, envConfigPanel, folderPicker, haptic, inputEl, leftSidebar,
  newSessionWorktree, noticeDismissals, openDeleteSession, projectsState, renderHooksBridgeSection,
  renderStatuslineBridgeSection, SESSION_PANEL_REVALIDATE_MS, sessionPanel, sessionRename, sessionRowMenu, sessionsCache,
  sessionsDot, sessionSearchQueryByDir, sessionWorkspaceState, setStatusIcon, showSessionBlockedSurface,
  socket, syncDashNoFolders, unread, getAvailableDirs, getCurrentCwd, getDirSectionNodes,
  getDisplayedSessionId, getExpandedDirs, getGeneralNav, getInstancesList, getLatestServiceHealth,
  getMirrorAutonomousFlag, getMirrorReadonlySid, getMirrorStaleFlag, getMirrorWaitingFlag, getNeedsYouList,
  getViewingInstanceId, getWorkdirStates, setComposeCwd, setCurrentCwd, setDirSectionNodes,
  setDisplayedSessionId, setExplicitCloseInstanceId, setFreshInterruptedInstanceId, setLatestServiceHealth,
  setSessionIdClearedByNav, setViewingInstanceId,
} = {}) {
  // 目录 → 「显示更多」点了几次（照抄桌面端 Show more，每次多显示一档；「收起」回到 0 即删键）。缓存里的 sessions
  // 是"当下拿到的那一份"，记不住用户要看更多这个意图——而 populateSubtree 每次都会无条件 revalidate，
  // 不带上 more 就会把展开态悄悄打回第一档（P0-11x）。
  const moreStepsByDir = new Map();
  // session:list 附带的 CLI registry 快照：每个 cwd 的终端聚合态（'waiting' | 'busy'，无则不存键）。
  // 与 Web workdirStates 独立保存并在抽屉显示层合并，避免 live idle/done 遮住终端运行态。
  // 存单值而后端给两个布尔：目录行只有一个角标位，同 cwd 两态并存时取更要紧的那个（等人 > 在跑）。
  const terminalStateByDir = new Map();
  // #398：抽屉关上后这份 last-known 继续喂 #sessionsDot，但只信 60s（从最后一次观测起算），见 terminal-state-expiry.js
  const terminalStateExpiry = createLastKnownExpiry({ ttlMs: 60_000 });

  let sessionPanelRevalidateTimer = null;

  // 目录头「N 未读」角标 → 依次跳到下一条未读行。角标此前是纯展示：它准确报出「有 N 条未读」，
  // 却答不了「在哪」——列表按时间排、未读判据逐条独立，一条未读完全可能在第 30 行（见模块头注）。
  const drawerUnreadJump = createDrawerUnreadJump({
    getSection: cwd => getDirSectionNodes().get(cwd),
    isExpanded: cwd => getExpandedDirs().has(cwd),
    expandDir: cwd => getDirSectionNodes().get(cwd)?.expand?.(),
  });

  // 抽屉主状态只保留三种 kind：需要你 / 出错 / 运行中。目录角标和顶部点用三态原文；
  // 会话行 busy 在 CLI 干活时写成「终端运行中」，来源不再塞进副行。
  // 注意：这张表是 resolveDrawerStatus 的**渲染侧白名单**——appendSessionStatusChip 拿不到 meta
  // 就直接 return。给纯函数加了新状态却漏了这里，chip 会静默不显示（判据全绿、界面照旧）。
  const DRAWER_STATUS_META = {
    busy: { icon: 'busy', tone: 'text-accent', label: tk('运行中') },
    permission: { icon: 'warn', tone: 'text-warning', label: tk('需要你') },
    // 与 Web 侧 permission 同色（都是"要人动手"），文案区分谁能处理它
    terminal_waiting: { icon: 'warn', tone: 'text-warning', label: tk('终端需要你') },
    error: { icon: 'error', tone: 'text-danger', label: tk('出错') },
    // 中性色不是随手选的：warning 这一档在本产品里专指「点一下就能处理」的待办（宪法里
    // 「需要你(N)」那条轴），而被后台 agent 占用恰恰是【处理不了】——手机上点它只会被拒。
    // 用 warning 会让它去抢待办的注意力预算，最后是真正要人批的审批被淹掉。
    bg_locked: { icon: 'warn', tone: 'text-ink-faint', label: tk('后台占用') },
  };
  function drawerStatusMeta(state) {
    const meta = DRAWER_STATUS_META[state];
    return meta ? { ...meta, label: t(meta.label) } : null;
  }
  function drawerStateForDir(cwd) {
    return resolveDrawerStatus({
      liveState: getWorkdirStates()[cwd],
      terminalState: terminalStateByDir.get(cwd) ?? null,
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
  function appendSessionStatusChip(head, liveState, terminalState, terminalSource = null, bgLocked = false) {
    head.querySelector('[data-session-status]')?.remove();
    const spec = resolveDrawerStatusChip({ liveState, terminalState, terminalSource, bgLocked });
    const meta = spec ? DRAWER_STATUS_META[spec.status] : null;
    if (!spec || !meta) return;
    const label = t(spec.label);
    const chip = el(`<span data-session-status class="drawer-status-chip shrink-0 ${meta.tone}"></span>`);
    chip.textContent = label;
    chip.title = label;
    chip.setAttribute('aria-label', label);
    head.appendChild(chip);
  }
  // "已等待"文案（与 needsYouList 共享 waitingSince 数据源）：按分钟粒度，不做秒级实时动画——
  // 该区块只在 instances 广播到达时重渲（同 refreshNeedsYou 触发时机），文案本就是"上次广播时刻"的快照。
  function formatWaitingDuration(waitingSince) {
    if (typeof waitingSince !== 'number') return '';
    const mins = Math.max(0, Math.floor((Date.now() - waitingSince) / 60000));
    if (mins < 1) return t('已等待 <1 分钟');
    if (mins < 60) return `${t('已等待')} ${mins} ${t('分钟')}`;
    const h = Math.floor(mins / 60), m = mins % 60;
    return `${t('已等待')} ${h} ${t('小时')}${m ? ' ' + m + ' ' + t('分钟') : ''}`;
  }
  // 单条"需要你"行：点击深链跳转（复用 applyDeepLink，同通知点击的落地逻辑）。
  // 全程 textContent 插值动态数据（title/cwd/toolName 均可能含用户数据）→ CSP 安全，同现有行渲染惯例。
  function needsYouRow(item) {
    const isApproval = item.reason === 'awaiting_approval';
    const row = el(`<button class="w-full flex items-center gap-2 pl-3 pr-3 py-2 border-b border-line-soft border-l-2 border-warning text-left hover:bg-sunk/30 active:opacity-70 bg-surface" data-testid="needs-you-row"></button>`);
    const icon = el(`<span class="shrink-0"></span>`);
    icon.textContent = isApproval ? '⚠️' : '❓';
    row.appendChild(icon);
    const body = el(`<div class="flex-1 min-w-0"></div>`);
    const head = el(`<div class="truncate text-xs font-medium text-ink"></div>`);
    head.textContent = displaySessionTitle(item.title, t('新会话'));
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
  // 顶部"需要你(N)"聚合区（AttentionDeriver）：needsYouList 已由 setInstances 按 waitingSince
  // 升序排好（等得越久排越前，已决），此处只负责渲染，不重排序。空列表渲染空壳（hidden），
  // 保持 #needsYouSection 锚点常在，refreshNeedsYou 的 querySelector 才总能找到替换目标。
  function buildNeedsYouSection() {
    const section = el(`<div id="needsYouSection"></div>`);
    if (!getNeedsYouList().length) { section.classList.add('hidden'); return section; }
    const header = el(`<div class="px-3 py-1.5 text-[10px] font-semibold text-warning border-b border-line"></div>`);
    header.textContent = `${t('需要你')} (${getNeedsYouList().length})`;
    section.appendChild(header);
    for (const item of getNeedsYouList()) section.appendChild(needsYouRow(item));
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
  // 「N 个文件夹找不到了」那一行带动作（#301 / #355）：管理工作区、重新检查、从列表移除缺失项（可写来源才给）、忽略。
  // 限速锁定、推送失败、前端错误只有「忽略」。服务状态面板是只读的诊断清单，照常列出全部告警、不受「忽略」影响。
  function buildServiceSection() {
    const section = el(`<div id="serviceSection"></div>`);
    const notices = undismissedServiceNotices(
      formatServiceNoticeRows({ service: getLatestServiceHealth(), now: Date.now() }),
      noticeDismissals.dismissed(),
    );
    if (!notices.length) { section.classList.add('hidden'); return section; }
    const wrap = el(`<div class="px-3 py-1.5 text-[10px] font-semibold text-warning border-b border-line flex flex-col gap-0.5"></div>`);
    for (const notice of notices) {
      const row = el(`<div></div>`);
      const text = el(`<div></div>`);
      text.textContent = notice.text; // 动态文案，textContent 插值同现有行渲染惯例（CSP 安全）
      row.appendChild(text);
      if (notice.id) {
        row.dataset.noticeId = notice.id;
        row.appendChild(serviceNoticeActions(notice));
      }
      wrap.appendChild(row);
    }
    section.appendChild(wrap);
    return section;
  }
  function serviceNoticeActions(notice) {
    const bar = el(`<div class="flex flex-wrap gap-1.5 pt-1 pb-0.5 font-normal"></div>`);
    const action = label => {
      const btn = el(`<button type="button" class="px-2 py-1 rounded-md border border-line text-ink-soft hover:text-ink hover:bg-sunk active:scale-95"></button>`);
      btn.textContent = label;
      bar.appendChild(btn);
      return btn;
    };
    if (notice.id === MISSING_FOLDERS_NOTICE_ID) {
      action(t('管理工作区')).onclick = () => {
        haptic('tap');
        closeLeftSidebar();
        envConfigPanel.open({ from: 'drawer', focusKey: 'WORKDIRS' });
      };
      const recheck = action(t('重新检查'));
      recheck.onclick = () => {
        haptic('tap');
        recheck.disabled = true;
        recheck.textContent = t('检查中…');
        // 带 timeout：后端还没重启到带这个事件的版本时没有 ack，不能让按钮一直转着
        socket.timeout(10_000).emit('folders:recheck', {}, (err, res) => {
          recheck.disabled = false;
          recheck.textContent = t('重新检查');
          if (err || !res?.ok) { drawer.showNotice(t('检查失败')); return; }
          drawer.showNotice(res.missingFolders > 0 ? t('还有 {n} 个找不到').replace('{n}', String(res.missingFolders)) : t('都找到了'));
          // 广播会带着同一份结果到；先按回执把这一行改掉，不等它
          setLatestServiceHealth({ ...getLatestServiceHealth(), missingFolders: res.missingFolders, missingFolderPaths: res.missingFolderPaths });
          refreshServiceSection();
        });
      };
      // #355：一键按原始配置条目删掉仍找不到的。只读来源前端不给按钮，服务端仍会拒——不能只靠隐藏。
      if (!projectsState.foldersReadonly()) {
        const removeMissing = action(t('从列表移除缺失项'));
        removeMissing.onclick = async () => {
          haptic('tap');
          const paths = Array.isArray(notice.paths) ? notice.paths : [];
          // 一点就改写配置、连各自的 sessionLimit 一起删；告警自己就说了可能只是外置盘没挂上，而家目录外的路径
          // 从手机上加不回来（添加文件夹只浏览家目录）——先确认，并把要删的路径列出来（同「断开连接」）。
          if (!(await appConfirm({
            title: t('从工作区列表移除这些文件夹？'),
            body: `${t('会改写配置文件，连同各自的会话上限设置一起删掉。只是外置盘没挂上的话，挂回来点「重新检查」即可。')}\n${paths.join('\n')}`,
            okText: t('移除'),
            tone: 'danger',
          }))) return;
          removeMissing.disabled = true;
          removeMissing.textContent = t('移除中…');
          socket.timeout(10_000).emit('folders:removeMissing', { paths }, (err, res) => {
            removeMissing.disabled = false;
            removeMissing.textContent = t('从列表移除缺失项');
            if (err || !res?.ok) { drawer.showNotice(err ? t('移除失败') : folderReasonText(res?.error)); return; }
            const n = Array.isArray(res.removed) ? res.removed.length : 0;
            drawer.showNotice(t('已移除 {n} 项').replace('{n}', String(n)));
            setLatestServiceHealth({ ...getLatestServiceHealth(), missingFolders: res.missingFolders, missingFolderPaths: res.missingFolderPaths });
            refreshServiceSection();
          });
        };
      }
    }
    action(t('忽略')).onclick = () => {
      haptic('tap');
      noticeDismissals.dismiss(notice);
      refreshServiceSection();
    };
    return bar;
  }
  function refreshServiceSection() {
    const old = sessionPanel.querySelector('#serviceSection');
    if (!old) return;
    old.replaceWith(buildServiceSection());
  }
  // 顶栏会话按钮右下角标。判定在 resolveHeaderConnBadge（断开 > 需要你 > 隐藏）。
  // 首连中不点亮，避免开页闪红。服务健康（推送失败等）不进这条轴——它归抽屉「服务」小节
  // 与服务状态面板，不与「点一下就能推进」的待办抢顶栏那唯一的位子。
  function updateAttentionSignal() {
    if (!connDotWrap) return;
    const { level } = whatNeedsAttention({
      instances: getInstancesList(),
      needsYou: getNeedsYouList(),
    });
    const spec = resolveHeaderConnBadge({
      connected: connBanner.isConnected(),
      everConnected: connBanner.hasEverConnected(),
      attentionLevel: level,
      needsYouCount: getNeedsYouList().length,
    });
    connDotWrap.dataset.conn = spec.conn;
    connDotWrap.dataset.reason = spec.reason;
    connDotWrap.title = spec.title;
    if (connDot) {
      const fill = spec.tone === 'warning' ? 'bg-warning' : 'bg-danger';
      connDot.className = `w-2 h-2 rounded-full ${fill} shrink-0`;
    }
    connDotWrap.classList.toggle('hidden', !spec.visible);
    updateHeaderAttentionChip();
  }
  function updateTerminalStateForDir(cwd, sessions, terminalBusy, terminalWaiting) {
    // 新服务端给出完整 registry 的 cwd 汇总，避免默认分页漏掉页外的条目；旧服务端回落当前返回行。
    const rowHas = state => Array.isArray(sessions) && sessions.some(s => s?.terminal === state);
    const busy = typeof terminalBusy === 'boolean' ? terminalBusy : rowHas('busy');
    const waiting = typeof terminalWaiting === 'boolean' ? terminalWaiting : rowHas('waiting');
    // 等人 > 在跑：目录行只有一个角标位，卡在审批上的那个才是要用户动手的
    const next = waiting ? 'waiting' : busy ? 'busy' : null;
    terminalStateExpiry.observe(); // 状态没变也算一次新观测（有效期从这里起算）
    const prev = terminalStateByDir.get(cwd) ?? null;
    if (next === prev) return;
    if (next) terminalStateByDir.set(cwd, next);
    else terminalStateByDir.delete(cwd);
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
  // 当前生效的只读镜像锁（已接管的不算）——抽屉行据此给被终端占着的会话补终端态（O86）。
  function mirrorRowLock() {
    return getMirrorReadonlySid()
      ? { sessionId: getMirrorReadonlySid(), stale: getMirrorStaleFlag(), waiting: getMirrorWaitingFlag(), autonomous: getMirrorAutonomousFlag() }
      : null;
  }
  // 初次绘制和 instances 增量广播共用同一个状态 resolver/builder，避免两套角标语义分叉。
  // 镜像锁变化（applyMirror）也走这里重刷。
  function refreshSessionStatusChips() {
    const instMap = new Map(getInstancesList().map(x => [x.instanceId, x]));
    const mirror = mirrorRowLock();
    sessionPanel.querySelectorAll('[data-testid="session-row"]').forEach(row => {
      const inst = row.dataset.instanceId ? instMap.get(row.dataset.instanceId) : null;
      const head = row.querySelector('[data-session-head]');
      if (!head) return;
      const terminalState = resolveRowTerminalState({
        registryState: row.dataset.terminalState || null,
        sessionId: row.dataset.sessionId || null,
        mirror,
      });
      appendSessionStatusChip(head, inst?.state, terminalState, row.dataset.terminalSource || null,
        row.dataset.bgLocked === '1');
    });
  }
  // 顶部点位空间极小，继续用 SVG；但只汇总需要你/出错/运行中，正常完成和中止不再持续点亮。
  function updateSessionsDot() {
    if (!sessionsDot) return;
    const drawerStates = {};
    for (const cwd of getAvailableDirs()) drawerStates[cwd] = drawerStateForDir(cwd);
    const top = summarizeOtherWorkspaces(drawerStates, getAvailableDirs(), getCurrentCwd());
    const meta = drawerStatusMeta(top);
    sessionsDot.classList.remove('text-accent', 'text-warning', 'text-danger', 'text-success', 'text-ink-faint');
    if (meta) {
      sessionsDot.classList.remove('hidden');
      sessionsDot.classList.add('status-icon', meta.tone);
      // tone:false —— 这颗角标的色由 DRAWER_STATUS_META 单独决定，不跟随图标 kind
      // （bg_locked 刻意是 warn 图标 + ink-faint 色：它是「此路不通」的说明，不该去抢待办的注意力）
      setStatusIcon(sessionsDot, meta.icon, { tone: false });
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
    updateHeaderAttentionChip();
  }
  // 顶栏文字 chip（#attentionChip）：把 #connDot / #sessionsDot 两颗角标的含义写成人话——手机没有 hover，
  // 它们的 title 等于不存在，用户只看到「一颗不知道什么意思的小红点」。判定在 resolveHeaderAttentionChip；
  // 输入 1）#connDot 刚算出的 reason（读它的 dataset，DOM 即真相源，不另存一份）2）需要你计数
  // 3）其他工作区汇总（与 updateSessionsDot 同一份数据）。两个角标的更新函数末尾都会调到这里，谁先谁后都不漏。
  const ATTENTION_CHIP_TONE_CLASS = { danger: 'text-danger', warning: 'text-warning', accent: 'text-accent' };
  function updateHeaderAttentionChip() {
    if (!attentionChipEl) return;
    const drawerStates = {};
    for (const cwd of getAvailableDirs()) drawerStates[cwd] = drawerStateForDir(cwd);
    const spec = resolveHeaderAttentionChip({
      badgeReason: connDotWrap?.dataset.reason || 'ok',
      needsYouCount: getNeedsYouList().length,
      otherWorkspaceStatus: summarizeOtherWorkspaces(drawerStates, getAvailableDirs(), getCurrentCwd()),
    });
    attentionChipEl.textContent = spec.text;
    attentionChipEl.title = spec.text;
    attentionChipEl.dataset.reason = spec.reason;
    attentionChipEl.className = `${spec.visible ? '' : 'hidden '}conn-rtt-chip attention-chip select-none ${ATTENTION_CHIP_TONE_CLASS[spec.tone] || ''}`.trim();
  }
  // 目录头「N 未读」：按该目录已加载的会话页（SWR 缓存）计。搜索态缓存不是全量、不作数；没缓存
  // （从未展开、后台保鲜还没回来）就不显示——不显示 0，也不为了这个数字多发一次 session:list。
  //
  // pinned（手动标「稍后再看」、被 limit 挤出本页而由服务端单独补回的那组）与 open（页外开着的会话）
  // 必须一起数：它们在屏幕上有行、有「未读」chip，漏数就成了反方向的同一个毛病——行亮着而角标说 0。
  // 数字与 chip 必须同源；文件夹长按「全部标为已读」的目标也是这同一个集合（#300）。
  function unreadSessionsForDir(cwd) {
    const entry = sessionsCache.get(cwd);
    if (!entry || String(entry.query || '')) return null;
    return unreadSessionsInGroup(entry, s => unread.isUnread(s, { isViewing: s.id === getDisplayedSessionId() }));
  }
  function unreadCountForDir(cwd) {
    return unreadSessionsForDir(cwd)?.length ?? null;
  }
  // 三态渲染（判定在 logic resolveDirUnreadBadge）：pending=缓存还没到位，必须占位说「不知道」，
  // 不能什么都不画——不画就与「确定没有未读」同形，等于在空窗期报一个错误事实。
  function applyDirUnreadBadge(badge, cwd) {
    const spec = resolveDirUnreadBadge(unreadCountForDir(cwd));
    badge.textContent = spec.text;
    badge.dataset.state = spec.state;
    badge.classList.toggle('hidden', !spec.visible);
    badge.classList.toggle('dir-unread-pending', spec.state === 'pending');
    if (spec.state === 'pending') {
      badge.title = t('未读数加载中');
      badge.setAttribute('aria-label', t('未读数加载中'));
    } else if (spec.state === 'unread') {
      // 手机没有 hover，title 基本等于不存在——但 aria-label 是读屏用户唯一能听到的那句，
      // 「4 未读」和「4 未读，点按跳到下一条」的差别正是「知道有」与「知道怎么去」。
      const label = `${spec.text} · ${t('点按跳到下一条')}`;
      badge.title = label;
      badge.setAttribute('aria-label', label);
    } else {
      badge.title = spec.text;
      if (spec.text) badge.setAttribute('aria-label', spec.text);
      else badge.removeAttribute('aria-label');
    }
  }
  // 行数据变化（renderRows）与长按标记后都要刷：两条路径共用同一个 resolver，不各写一套。
  function refreshDirUnreadCounts() {
    sessionPanel.querySelectorAll('[data-dir]').forEach(row => {
      const badge = row.querySelector('.dir-unread');
      if (badge) applyDirUnreadBadge(badge, row.dataset.dir);
    });
  }
  // 服务状态可见性（第一性原理重新设计）：与上面 updateSessionsDot（会话待处理/注意力不对称）
  // 是不同的轴——这里只答"ccm 这个服务本身有没有出过岔子"（可维护性）。
  function updateServiceNotice(service) {
    setLatestServiceHealth(service);
    // 只存快照 + 刷抽屉文案。顶栏角标由 setInstances 末尾的 updateAttentionSignal 重算。
    refreshServiceSection();
    syncDashNoFolders(); // 首页引导的标题吃 missingFolders：这份快照比项目清单晚一步落地
    renderHooksBridgeSection(); // 安装态随广播刷新：面板开着时点完开关能立刻看到变化
    renderStatuslineBridgeSection(); // 同上：两个桥的安装态都随 instances 广播刷新
    getGeneralNav()?.render(); // L1「宿主机」那行的运行时长吃的就是这份广播
  }

  // 统一行：一条会话（session:list 的 s，或无 id 的新会话）→ DOM 行。liveInst 非空 = 已打开为 tab。
  // 全程 textContent（无 innerHTML 插值用户数据）→ CSP 安全。
  const sessionRow = (s, liveInst, workspaceCwd) => {
    // 托管 worktree 的会话行自带真实 cwd（`.claude/worktrees/<name>`，父仓只是展示归属）。
    // 打开/删除都要用它：拿工作区 cwd 去 resume，会落到一个根本没有这条 transcript 的
    // project 目录，ack 回「会话不存在」。父仓的行不带 cwd，照旧回落工作区 cwd。
    const rowCwd = s.cwd || workspaceCwd;
    const active = liveInst && liveInst.instanceId === getViewingInstanceId();

    const rowContent = el(`<div class="row-content relative flex items-center gap-2 pl-6 pr-3 py-2.5 border-b border-line-soft cursor-pointer select-none${active ? ' bg-accent-wash' : ' bg-surface'}" data-testid="session-row" data-session-id="${esc(s.id || '')}" data-instance-id="${esc(liveInst?.instanceId || '')}"></div>`);
    rowContent.dataset.terminalState = s.terminal || '';
    rowContent.dataset.terminalSource = s.terminalSource || '';
    rowContent.dataset.bgLocked = s.bgLocked ? '1' : '';
    const btn = el(`<button class="flex-1 min-w-0 text-left text-xs active:opacity-70"></button>`);
    btn.title = displaySessionTitle(s.title, t('新会话'));
    const head = el(`<div data-session-head class="flex items-center gap-1.5 min-w-0"></div>`);
    const titleSpan = el(`<span class="flex-1 min-w-0 truncate font-medium${active ? ' text-accent' : ' text-ink-soft'}"></span>`);
    titleSpan.textContent = displaySessionTitle(s.title, t('新会话'));
    head.appendChild(titleSpan);
    // R65 未读：标题加粗变深 + 文字 chip「未读」（原 8px 色点在手机上既不显眼也说不清自己是什么）。
    // 上次打开后有新活动或在「⋯」菜单里标过才亮；正在看的（本实例激活或就是当前显示会话）不算未读。
    // 抽成函数：菜单里标记后原地重刷这一行，不等整个列表重画。
    const isViewingRow = active || s.id === getDisplayedSessionId();
    const applyUnreadMark = () => {
      const on = Boolean(s.id) && unread.isUnread(s, { isViewing: isViewingRow });
      titleSpan.classList.toggle('font-semibold', on);
      titleSpan.classList.toggle('font-medium', !on);
      if (!active) {
        titleSpan.classList.toggle('text-ink', on);
        titleSpan.classList.toggle('text-ink-soft', !on);
      }
      head.querySelector('[data-testid="unread-mark"]')?.remove();
      if (!on) return;
      const mark = el(`<span data-testid="unread-mark" class="drawer-status-chip shrink-0 text-accent"></span>`);
      mark.textContent = t('未读');
      mark.title = t('未读');
      mark.setAttribute('aria-label', t('未读'));
      titleSpan.after(mark);
    };
    applyUnreadMark();
    appendSessionStatusChip(head, liveInst?.state,
      resolveRowTerminalState({ registryState: s.terminal || null, sessionId: s.id || null, mirror: mirrorRowLock() }),
      s.terminalSource, Boolean(s.bgLocked));
    btn.appendChild(head);
    const sub = el(`<div class="truncate text-ink-faint text-[10px]"></div>`);
    // 有 id 却没有时间戳的只有 SESSION-02 补画的活实例行——它是存过的会话，不能说「未保存」。
    const when = s.lastUsedAt ? formatSessionRowTime(s.lastUsedAt) : (s.id ? '' : t('新会话（未保存）'));
    // 短 session_id（前 8 位）：便于对照 CLI /resume、日志、多设备定位同一会话；无 id 的新会话不显示。
    sub.textContent = formatSessionRowSubtitle({
      whenText: when,
      liveOpen: Boolean(liveInst),
      terminalState: s.terminal || null,
      terminalSource: s.terminalSource || null,
      shortId: s.id ? s.id.slice(0, 8) : null,
      worktree: s.worktree || null, // 托管 worktree 的会话行：标出在哪个工作树干活
      worktreeGone: Boolean(s.worktreeGone), // 那棵树已被删：这一行点不开，得当场看得出来
    });
    btn.appendChild(sub);

    btn.onclick = () => {
      haptic('tap');
      if (liveInst && !s.id) {             // 未获 sessionId 的新会话只切视图
        if (liveInst.instanceId !== getViewingInstanceId()) socket.emit('user:setViewing', { instanceId: liveInst.instanceId });
        closeLeftSidebar();
      } else {                             // 有 ID：服务端统一核对位置并打开/聚焦
        closeLeftSidebar();
        let acked = false;
        const blocked = message => showSessionBlockedSurface({ sessionId: s.id, cwd: rowCwd, title: s.title, message });
        socket.emit('session:switch', { sessionId: s.id, cwd: rowCwd }, res => {
          acked = true;
          if (!res?.ok) blocked(res?.error || t('切换失败'));
          else dismissBlockedSurfaceIfTarget(s.id, rowCwd); // 迟到的成功 ack：撤掉 4s 兜底弹出的落地页
        });
        setTimeout(() => { if (!acked) blocked(t('切换无响应，请刷新页面后重试')); }, 4000);
      }
    };
    rowContent.appendChild(btn);

    // 行尾「⋯」是这一行唯一的入口（2026-10-25，对齐桌面端）：此前 ✕、🗑、红色侧滑「关闭」三处并存，侧滑还和
    // 抽屉的左滑收起抢同一次手势——露出按钮后多滑 30px 抽屉就被收走。长按不再有动作。
    // 哪些项、何时灰掉见 logic 的 sessionRowMenuItems。
    const menuItems = () => sessionRowMenuItems({
      hasId: Boolean(s.id),
      live: Boolean(liveInst),
      // 正看着的会话同样能标「稍后再看」并当场亮起：手动标记不受 isViewing 管辖（见 logic/unread.js
      // 里那两条短路的顺序注），所以这里问 isUnread 一个就够，不必再叠 isManualUnread。
      unread: Boolean(s.id) && unread.isUnread(s, { isViewing: isViewingRow }),
    });
    const runMenuAction = async action => {
      if (action === 'toggle-read') {
        haptic('tap');
        unread.setManualUnread(s.id, !unread.isUnread(s, { isViewing: isViewingRow }));
        applyUnreadMark();
        refreshDirUnreadCounts();
      } else if (action === 'close') {
        haptic('warning');
        if (await appConfirm({
          title: `${t('关闭会话「')}${displaySessionTitle(s.title, t('新会话'))}${t('」？')}`,
          body: t('会话将从 tab 列表移除，但历史保留可重新打开。'),
          okText: t('关闭会话'),
        })) {
          // 点停止顿一下跳主页的回归修复：若关的正是当前正在看的会话，记下 id 供
          // wasViewingInstanceDestroyed 排除——这是用户自己确认过的主动关闭，不是"被摧毁"。
          setExplicitCloseInstanceId(liveInst.instanceId);
          socket.emit('session:close', { instanceId: liveInst.instanceId });
          closeLeftSidebar();
        }
      } else if (action === 'rename') {
        haptic('tap');
        sessionRename.open({ sessionId: s.id, cwd: rowCwd, title: displaySessionTitle(s.title, ''), sectionKey: workspaceCwd });
      } else if (action === 'delete') {
        haptic('warning');
        openDeleteSession(s.id, rowCwd, displaySessionTitle(s.title, ''), workspaceCwd); // 空串 → 内部回落 sessionId
      }
    };
    // hit-44（#359）：视觉 32px，触控热区四周各扩 8px；向左正好补满与行本体之间的 gap-2，不吞行本体的点击。
    const menuBtn = el(`<button type="button" class="hit-44 shrink-0 w-8 h-8 rounded-lg flex items-center justify-center text-ink-faint hover:text-ink hover:bg-sunk active:scale-90 text-base" data-testid="session-menu" aria-haspopup="dialog" aria-controls="sessionMenuModal" title="${t('会话操作')}" aria-label="${t('会话操作')}">⋯</button>`);
    menuBtn.onclick = () => {
      haptic('tap');
      sessionRowMenu.open({ title: displaySessionTitle(s.title, t('新会话')), label: t('会话操作'), items: menuItems(), onSelect: runMenuAction });
    };
    rowContent.appendChild(menuBtn);

    return rowContent;
  };

  // 在指定目录开一个新会话（进空首页，首条消息时服务端懒开实例）。抽屉每节的 ＋ 与「选文件夹」面板共用。
  function startNewSessionIn(d) {
    // 同步本地重置（同 btnNew，Bug A）：viewingInstanceId 不等广播落地；currentCwd 同样要立刻
    // 切到 d——否则广播落地前发送会把消息投到当前正看的工作区，而不是刚选的这个 d。
    setViewingInstanceId(null);
    setCurrentCwd(d);
    setComposeCwd(null); // 广播落地前 currentCwd 就是 d；上一页选的 worktree 不能留到这一页
    // displayedSessionId 同样要立刻置空 + 同步做完草稿交换，理由与 btnNew 那处逐字相同：
    // 漏了它，一次迟到的 instances 广播会拿「prev=旧会话 / new=null」判 swap，把用户刚在
    // 新会话页打的字存进旧会话草稿、再用空串覆盖输入框（E2E P0-11h 撞的就是这条路径——
    // 它走的是目录行的 ＋，不经过 btnNew，所以只修 btnNew 那一处时它照旧红）。
    applySessionDraftSwap(getDisplayedSessionId(), null, {
      text: inputEl ? inputEl.value : '',
      attachments: attachments.items(),
    }, { forceSwap: true, prevCwd: sessionWorkspaceState.displayedCwd, newCwd: d });
    setDisplayedSessionId(null);
    sessionWorkspaceState.displayedCwd = d;
    setSessionIdClearedByNav(true);
    // 清除③：新建会话——放弃上一个实例"sessionId 未到即中断"的待续档态。
    setFreshInterruptedInstanceId(null);
    enterComposeReady();
    ensureEmptySurface(); // cwd 可能变了；空表面内 viewing 仍 null 须本地切到 compose
    newSessionWorktree.reset(); // 换工作区：分支列表与勾选都属于上一个工作区
    composePage.renew();
    socket.emit('session:new', { cwd: d }); // 模型清单由后端 pushModelsForCwd 主动推、不再前端拉
  }

  // 台阶3 Step B：工作区面板 = 目录树（当前 cwd 展开，其他折叠）——类似 IDE 项目浏览器。
  // 单个工作区目录的 DOM 子树构建（dirRow 头行 + subtree 展开区）——从 openSessionPanel 抽出以支持
  // 局部重建（见 rebuildDirSections）：只有这个函数知道"一个目录该怎么画"，openSessionPanel（全量）
  // 与 rebuildDirSections（局部，只重建按目录签名 diff 出的变化目录）都复用它，两条路径画出来的东西
  // 保证一致，不会走成两套逻辑。tabs 现读 instancesList（不依赖调用方快照）：局部重建时数据可能比
  // 上一次 openSessionPanel 更新，直接读最新更正确。
  function buildDirSection(d) {
    const isCurrent = d === getCurrentCwd();
    const isExpanded = getExpandedDirs().has(d);

    // ---- 目录头行（所有目录均可点击展开/折叠）----
    const dirRow = el(`<div class="w-full px-3 py-1.5 border-b border-line flex items-center justify-between hover:bg-sunk/30${isCurrent ? ' text-accent' : ' text-ink'}"></div>`);
    dirRow.dataset.dir = d;
    dirRow.title = d;
    const kind = projectsState.kindOf(d);
    if (kind) dirRow.dataset.dirKind = kind; // 拖动排序据此认块：连接根带着紧随其后的子文件夹小节一起走（folder-drag.js）

    const toggleBtn = el(`<button class="flex-1 min-w-0 text-left flex items-center gap-2 py-1.5 active:opacity-70"></button>`);
    const icon = el(`<span class="shrink-0"></span>`); icon.textContent = isExpanded ? '📂' : '📁';
    // 统一用 "▶" 字符，旋转实现向下效果，平滑过渡
    const arrow = el(`<span class="shrink-0 text-[9px] w-3 dir-arrow">▶</span>`);
    if (isExpanded) arrow.classList.add('rotated');
    const name = el(`<span class="truncate"></span>`); name.textContent = baseName(d);
    const badge = el(`<span class="dir-badge hidden"></span>`);
    applyBadge(badge, drawerStateForDir(d));
    // 右侧角标组 [N 未读][运行中/需要你/出错]：未读数让折叠着的目录也能看出里面有没看过的会话
    // （行内标记在折叠态下根本不可见）。计数按已加载的会话页算，见 applyDirUnreadBadge。
    // 角标是按钮不是标签：点它跳到下一条未读行（见 app/drawer-unread-jump.js 头注）。用 <span
    // role=button> 而非 <button>——它嵌在 toggleBtn（也是 <button>）里，按钮套按钮是非法 HTML，
    // 浏览器会把内层甩出去，整个角标组的位置就散了。
    const unreadBadge = el(`<span class="dir-unread drawer-status-chip shrink-0 text-accent hidden" data-testid="dir-unread" role="button" tabindex="0"></span>`);
    applyDirUnreadBadge(unreadBadge, d);
    // stopPropagation 是必须的：不拦就冒泡到 toggleBtn，点「跳到未读」的结果是把整个目录折叠起来。
    const onBadgeActivate = (e) => {
      e.stopPropagation();
      e.preventDefault();
      if (unreadBadge.dataset.state !== 'unread') return; // pending（数字还不知道）时点了不该有反应
      haptic('tap');
      drawerUnreadJump.request(d);
    };
    unreadBadge.onclick = onBadgeActivate;
    unreadBadge.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') onBadgeActivate(e); };
    const badgeGroup = el(`<span class="ml-auto shrink-0 flex items-center gap-1"></span>`);
    badgeGroup.appendChild(unreadBadge);
    badgeGroup.appendChild(badge);

    toggleBtn.appendChild(icon);
    toggleBtn.appendChild(arrow);
    toggleBtn.appendChild(name);
    toggleBtn.appendChild(badgeGroup);
    dirRow.appendChild(toggleBtn);

    // 长按连接根 = 拖动调整上下位置（2026-10-26，取代 #305 置顶），子文件夹小节跟着根走、「无文件夹」不动。
    // 顺序存数据目录、不写配置，所以也不看 foldersReadonly。松手时 DOM 已按拖出来的样子摆好，服务端广播新清单后
    // 整段重画；拒了就按手里那份服务端清单重画回去。「全部标为已读」原来挂在长按上，挪进了下面的「⋯」。
    if (kind === 'connected') {
      attachFolderDrag(toggleBtn, {
        row: dirRow,
        panel: sessionPanel,
        haptic,
        onCancel: openSessionPanel,
        onDrop: roots => {
          socket.timeout(10_000).emit('folders:reorder', { roots }, (err, res) => {
            if (err || !res?.ok) {
              openSessionPanel();
              drawer.showNotice(t('顺序没保存上，稍后再试'));
            }
          });
        },
      });
    }

    // 物理热区扩大版 "＋" 新建按钮
    const newSessionBtn = el(`<button class="shrink-0 w-8 h-8 rounded-lg flex items-center justify-center border border-line text-ink-soft hover:text-accent hover:border-accent hover:bg-accent-wash active:scale-90 text-sm font-bold shadow-sm transition-all" title="${t('在此工作区新建会话')}">＋</button>`);
    newSessionBtn.onclick = (e) => {
      e.stopPropagation();
      closeLeftSidebar();
      haptic('tap');
      startNewSessionIn(d);
    };
    dirRow.appendChild(newSessionBtn);

    // 「⋯」（2026-10-26，同会话行共用 #sessionMenuModal）：每一节都有。
    // 全部标为已读（#300）：不改配置，子文件夹小节、「无文件夹」、只读来源下都能用。目标就是目录角标数的那个集合，
    // 确认框里的 N 与角标一致；还没显示出来的更早会话由文件夹水位一并盖住（markAllRead 的 folder，READ-01），确认框里说出来。
    // 断开连接（2026-10-15）：只给连接根——子文件夹小节与「无文件夹」不是连接根，断开它们什么也断不掉（服务端也拒）；
    // 手机上改不了清单时（来源是环境变量 / 外置文件、或没有配置文件）也不给：点下去只会在确认之后报「改不了」。
    // 已开在里面的会话照常跑，只是不能再在这里新开；确认框里说出这里开着几个。
    const markAllReadHere = async () => {
      const targets = unreadSessionsForDir(d); // 按点下去这一刻算：菜单开着时可能又来了新的
      if (!targets?.length) { drawer.showNotice(targets === null ? t('未读数加载中，稍后再试') : t('这里没有未读会话')); return; }
      const body = sessionsCache.get(d)?.hasMore ? t('把这里的 {n} 个未读会话标为已读，还没显示的更早会话也一起。') : t('把这里的 {n} 个未读会话标为已读。');
      if (!(await appConfirm({ title: baseName(d), body: body.replace('{n}', String(targets.length)), okText: t('全部标为已读') }))) return;
      unread.markAllRead(targets.map(s => s.id), d);
      refreshUnreadMarks();
    };
    const disconnectHere = async () => {
      const openSessions = openSessionsUnderRoot({ projects: projectsState.entries(), instances: getInstancesList(), root: d, sectionKeys: getAvailableDirs() });
      if (!(await appConfirm(disconnectFolderConfirm({ name: baseName(d), openSessions })))) return;
      socket.emit('folders:remove', { path: d }, res => {
        if (!res?.ok) drawer.showNotice(folderReasonText(res?.error));
      });
    };
    const menuBtn = el(`<button type="button" class="shrink-0 w-8 h-8 ml-1 rounded-lg flex items-center justify-center text-ink-faint hover:text-ink hover:bg-sunk active:scale-90 text-base" data-testid="dir-menu" aria-haspopup="dialog" aria-controls="sessionMenuModal" title="${t('文件夹操作')}" aria-label="${t('文件夹操作')}">⋯</button>`);
    menuBtn.onclick = (e) => {
      e.stopPropagation();
      haptic('tap');
      const targets = unreadSessionsForDir(d);
      sessionRowMenu.open({
        title: baseName(d),
        label: t('文件夹操作'),
        items: folderRowMenuItems({ unreadCount: targets ? targets.length : null, canDisconnect: kind === 'connected' && !projectsState.foldersReadonly() }),
        onSelect: action => (action === 'disconnect' ? disconnectHere() : markAllReadHere()),
      });
    };
    dirRow.appendChild(menuBtn);

    // 文件浏览入口已收归顶部 pill（当前工作区）；抽屉只负责会话切换/新建，不再挂逐行「浏览」按钮。

    // ---- 展开区容器（所有目录均常驻 DOM 以支持 CSS max-height 过渡，仅通过类来控制动画） ----
    const subtree = el(`<div class="subtree-container"></div>`);
    if (isExpanded) {
      subtree.classList.add('expanded');
    }

    // 状态-only instances 广播不会重建目录子树；每次 renderRows 都必须现读 instancesList，不能捕获
    // buildDirSection 当时的旧 state，否则后续 terminal revalidate 重画 rows 会把最新 Web 状态倒退。
    // 托管 worktree 的会话行挂在父仓名下，归属判据与角标/sessionsDot 共用 owningWorkspace（SESSION-02，见 logic）。
    const currentLiveRows = () => liveRowsForSection(getInstancesList(), d, getAvailableDirs());

    // 组装并渲染子树函数
    // subtreeGen：populateSubtree 每次调用递增的代次，供内部各异步 ack 判断"自己是否已被更晚一次调用
    // 顶替"——expandedDirs.has(cwd) 只答"这个目录还展开着吗"，答不了"这次 ack 属于哪一次调用"。快速
    // 折叠再展开同一目录（复用同一个 container）时，旧调用的迟到 ack 若只查前者，可能用 renderRows
    // 整段清空刚渲染好的新内容。
    let subtreeGen = 0;
    let sessionListRequestGen = 0;
    const populateSubtree = (cwd, container, { background = false } = {}) => {
      // 后台保鲜不使现有 renderRows /「显示更多」闭包失效；首次（折叠目录尚未画过）仍建立代次。
      if (!background || subtreeGen === 0) subtreeGen += 1;
      const myGen = subtreeGen;
      const activeQuery = () => String(sessionSearchQueryByDir.get(cwd) || '').trim();

      const mountSearch = () => bindSessionSearchInput(container, {
        cwd,
        getQuery: (dir) => sessionSearchQueryByDir.get(dir) || '',
        setQuery: (dir, value) => sessionSearchQueryByDir.set(dir, value),
        onDebouncedQuery: (dir) => {
          if (!getExpandedDirs().has(dir)) return;
          populateSubtree(dir, container);
        },
        el,
      });

      // 渲染：搜索框（稳定节点）+ 行宿主（可重建）+ 无 id 新会话 + 会话行 +（浏览态）「显示更多 / 收起」/剩余提示
      // worktree 的会话由服务端并进所属仓库的列表（行带自己的 cwd），不自成一节。
      // 「显示更多」与「收起」共用：按点过的次数拉窗口（每档条数与上限在服务端 sessionListWindow），
      // 记住次数供后续 revalidate 沿用；收起 = 回到 0 次。
      const loadMoreSteps = (steps, button) => {
        haptic('tap');
        button.textContent = t('加载中…');
        button.disabled = true;
        // 记住意图：后续 revalidate 也得按这个窗口拉，否则重建一次就被打回去
        if (steps > 0) moreStepsByDir.set(cwd, steps);
        else moreStepsByDir.delete(cwd);
        const requestGen = ++sessionListRequestGen;
        socket.emit('session:list', { cwd, ...(steps > 0 ? { more: steps } : {}) }, state => {
          if (requestGen !== sessionListRequestGen) return;
          if (!isSessionPanelRevalidateActive() || !container.isConnected) return;
          if (!getExpandedDirs().has(cwd) || myGen !== subtreeGen) return;
          const rows = state?.sessions || [];
          const nextHasMore = !!state?.hasMore;
          const nextTotal = Number.isFinite(state?.total) ? state.total : null;
          const nextPinned = Array.isArray(state?.pinned) ? state.pinned : [];
          const nextOpen = Array.isArray(state?.open) ? state.open : [];
          const nextMoreCount = Number.isInteger(state?.moreCount) ? state.moreCount : 0;
          unread.hydrate(state?.readState); // 下面无条件 renderRows，只需保证灌在渲染之前
          updateTerminalStateForDir(cwd, rows, state?.terminalBusy, state?.terminalWaiting);
          sessionsCache.set(cwd, { sessions: rows, hasMore: nextHasMore, total: nextTotal, query: '', pinned: nextPinned, open: nextOpen, moreCount: nextMoreCount });
          renderRows(rows, nextHasMore, nextTotal, nextPinned, nextOpen, nextMoreCount);
          // 收起后列表一下子短了，人会落到下面别的文件夹里。同桌面端：把按钮那一行滚回视野。
          if (steps === 0) container.querySelector('[data-testid="session-show-more-bar"]')?.scrollIntoView({ block: 'nearest' });
        });
      };

      const renderRows = (sessions, hasMore, total = null, pinned = [], open = [], moreCount = 0) => {
        const { liveMap, freshTabs } = currentLiveRows();
        const query = activeQuery();
        mountSearch();
        const rowsHost = bindSessionRowsHost(container, el);
        rowsHost.innerHTML = '';

        if (!query) {
          for (const inst of freshTabs) {
            rowsHost.appendChild(sessionRow({ id: null, title: inst.title, lastUsedAt: null, entrypoint: null }, inst, cwd));
          }
          // SESSION-02：在跑、但列表没返回的会话（被分页挤出、transcript 被迁走）照样画一行，排在前面——
          // 否则它正在跑，抽屉里却既看不见也关不掉。
          // 标题与时间用 session:list 的 open（服务端按 transcript 补回的元数据，验收 O46）：实例广播里的 title
          // 只来自 sessions.json，终端来的会话那里是 null，画出来就是一行没有时间的「新会话」。
          // transcript 被搬走的找不到元数据，才回落实例自己的 title。
          const listedIds = new Set([...sessions, ...pinned].map(s => s.id));
          const openById = new Map(open.map(s => [s.id, s]));
          for (const inst of orphanLiveRows(liveMap, listedIds)) {
            const meta = openById.get(inst.sessionId) || { id: inst.sessionId, title: inst.title, lastUsedAt: null, entrypoint: null };
            rowsHost.appendChild(sessionRow(meta, inst, cwd));
          }
        }
        for (const s of sessions) {
          rowsHost.appendChild(sessionRow(s, liveMap.get(s.id), cwd));
        }
        if (query && sessions.length === 0) {
          const empty = el(`<div class="pl-6 pr-3 py-3 text-xs text-ink-faint border-b border-line-soft/40" data-testid="session-search-empty">${t('无匹配会话')}</div>`);
          rowsHost.appendChild(empty);
        }

        // 「显示更多 N 个」/「收起」，照抄桌面端 Show more / Show less：每点一次多显示一档（N 由服务端按窗口算）。
        // 偏离两处：桌面端只在全部显示完才给 Show less，几百个会话的文件夹点不到底，所以这里点过一次就给；
        // 桌面端不报还剩多少，这里在按钮上带上（验收 AC-04-13：有剩余数量提示、总数准确）。
        // 到服务端硬顶后「显示更多」回落成搜索提示；剩下的全是页尾「稍后再看」行时什么都不给（没有藏着的）。
        if (!query) {
          const steps = moreStepsByDir.get(cwd) || 0;
          const remaining = hasMore ? remainingOlderSessionCount(total, sessions.length, pinned.length) : null;
          let hintText = null;
          if (hasMore && moreCount <= 0) {
            if (remaining != null) hintText = t('还有 {n} 个更早的会话，可用搜索查找').replace('{n}', String(remaining));
            else if (total == null) hintText = t('还有更早的会话，可用搜索查找');
          }
          if (moreCount > 0 || hintText || steps > 0) {
            const bar = el(`<div class="flex items-center border-b border-line-soft/40" data-testid="session-show-more-bar"></div>`);
            if (moreCount > 0) {
              const more = el(`<button class="flex-1 text-left pl-6 pr-3 py-2 text-xs text-accent hover:bg-sunk/50" data-testid="session-show-more"></button>`);
              more.textContent = (remaining != null && remaining > moreCount
                ? t('显示更多 {n} 个（还有 {m} 个）').replace('{m}', String(remaining))
                : t('显示更多 {n} 个')).replace('{n}', String(moreCount));
              more.onclick = () => loadMoreSteps(steps + 1, more);
              bar.appendChild(more);
            } else if (hintText) {
              const hint = el(`<div class="flex-1 pl-6 pr-3 py-2 text-xs text-ink-faint" data-testid="session-remaining-hint"></div>`);
              hint.textContent = hintText;
              bar.appendChild(hint);
            }
            if (steps > 0) {
              const less = el(`<button class="ml-auto shrink-0 px-3 py-2 text-xs text-ink-soft hover:text-accent hover:bg-sunk/50" data-testid="session-show-less"></button>`);
              less.textContent = t('收起');
              less.onclick = () => loadMoreSteps(0, less);
              bar.appendChild(less);
            }
            rowsHost.appendChild(bar);
          }
        }
        // 手动标「稍后再看」、已被 limit 挤出时间序这一页的会话（服务端 session:list 的 pinned）。按时间它们
        // 都比本页更早，所以排在本页与「显示更多」之后（O81：此前置顶，读起来像排序坏了；显示到覆盖它的那一档时，
        // 服务端不再把它算进 pinned，它就落回时间序里）。带一行小标说明这一组为什么在这里。
        if (!query && pinned.length) {
          const pinnedHead = el(`<div class="pl-6 pr-3 pt-2 pb-1 text-[10px] uppercase tracking-wide text-ink-faint" data-testid="session-pinned-head"></div>`);
          pinnedHead.textContent = t('稍后再看');
          rowsHost.appendChild(pinnedHead);
          for (const s of pinned) {
            rowsHost.appendChild(sessionRow(s, liveMap.get(s.id), cwd));
          }
        }
        refreshDirUnreadCounts(); // 行数据（含 lastUsedAt）刚更新，目录头「N 未读」随之重算
        // 折叠态点角标 → 先展开、发 session:list、等 ack 回来渲染完行，跳转才有落点，就是这里。
        drawerUnreadJump.flushPendingJump(cwd);
      };

      if (!background) {
        // 1) SWR 缓存极速呈现（缓存值形状：{sessions, hasMore, total?, query?}）：有缓存就先拿旧数据把列表画出来，
        // 不等网络；新鲜度交给下面那次无条件 revalidate。搜索态与浏览态缓存键共享同一 Map，用 query 字段区分。
        mountSearch();
        const cachedEntry = sessionsCache.get(cwd);
        const cacheMatchesQuery = cachedEntry && String(cachedEntry.query || '') === activeQuery();
        if (cacheMatchesQuery) {
          renderRows(cachedEntry.sessions || [], cachedEntry.hasMore, cachedEntry.total ?? null, cachedEntry.pinned || [], cachedEntry.open || [], cachedEntry.moreCount || 0);
        } else {
          const rowsHost = bindSessionRowsHost(container, el);
          rowsHost.innerHTML = '';
          if (!activeQuery()) {
            for (const inst of currentLiveRows().freshTabs) {
              rowsHost.appendChild(sessionRow({ id: null, title: inst.title, lastUsedAt: null, entrypoint: null }, inst, cwd));
            }
          }
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
          rowsHost.appendChild(skeleton);
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
      // 搜索态 revalidate 必须带上 query，否则会把匹配结果打回默认 6 条。
      if (background && !socket.connected) return;
      const requestGen = ++sessionListRequestGen;
      const query = activeQuery();
      const steps = moreStepsByDir.get(cwd) || 0;
      const listPayload = query ? { cwd, query } : { cwd, ...(steps > 0 ? { more: steps } : {}) };
      socket.emit('session:list', listPayload, state => {
        if (requestGen !== sessionListRequestGen) return;
        if (!isSessionPanelRevalidateActive() || !container.isConnected) return;
        if (myGen !== subtreeGen) return;
        if (!background && !getExpandedDirs().has(cwd)) return;
        // 用户在请求飞行期间改了搜索词 → 丢弃过期 ack
        if (activeQuery() !== query) return;
        const sessions = state?.sessions || [];
        const hasMore = !!state?.hasMore;
        const total = Number.isFinite(state?.total) ? state.total : null;
        // pinned：手动标记但被 limit 挤出本页的会话，服务端单独补回（旧服务端不发这个字段 → 空数组，
        // 功能静默退回「标了就可能找不回来」，但不报错、不影响本页任何一行）。
        const pinned = Array.isArray(state?.pinned) ? state.pinned : [];
        // open：开着、被分页挤出本页的会话的元数据（验收 O46）；旧服务端不发 → 空数组，那几行回落实例自己的 title
        const open = Array.isArray(state?.open) ? state.open : [];
        const moreCount = Number.isInteger(state?.moreCount) ? state.moreCount : 0; // 旧服务端不发 → 回落成「可用搜索查找」提示
        // 已读位点搭 session:list 回来（服务端刻意不另开广播）：必须在渲染前灌进去，让「行数据」
        // 与「未读判定」同帧——否则会出现行已更新、未读标记还是旧的这种撕裂。返回值是「内容真变了吗」，
        // 拿它并进重渲染条件；恒真会打掉 shouldRerenderSessionList 的省渲优化。
        const readChanged = unread.hydrate(state?.readState);
        updateTerminalStateForDir(cwd, sessions, state?.terminalBusy, state?.terminalWaiting);
        const prevEntry = sessionsCache.get(cwd);
        const willRerender = shouldRerenderSessionList({
          hasPrevEntry: !!prevEntry && String(prevEntry.query || '') === query,
          prevSessions: prevEntry?.sessions,
          prevHasMore: prevEntry?.hasMore,
          prevTotal: prevEntry?.total ?? null,
          prevPinned: prevEntry?.pinned,
          prevOpen: prevEntry?.open,
          nextSessions: sessions,
          nextHasMore: hasMore,
          nextTotal: total,
          nextPinned: pinned,
          nextOpen: open,
        });
        const moreCountChanged = (prevEntry?.moreCount || 0) !== moreCount;
        sessionsCache.set(cwd, { sessions, hasMore, total, query, pinned, open, moreCount });
        if (willRerender || readChanged || moreCountChanged) renderRows(sessions, hasMore, total, pinned, open, moreCount);
      });
    };

    // 如果当前展开，则渲染列表
    if (isExpanded) {
      populateSubtree(d, subtree);
    }

    // 折叠/展开切换：纯 CSS 驱动，不触发重绘全量 DOM
    // 展开抽成具名函数：折叠态点未读角标时也要走这条路（先展开，行渲染完再由 flushPendingJump
    // 补上跳转），两个入口共用一份，不各写一遍展开动作。
    const expandDir = () => {
      getExpandedDirs().add(d);
      try { localStorage.setItem('ccm_expanded_dirs', JSON.stringify([...getExpandedDirs()])); } catch {}
      subtree.classList.add('expanded');
      arrow.classList.add('rotated');
      icon.textContent = '📂';
      populateSubtree(d, subtree);
    };
    toggleBtn.onclick = () => {
      haptic('tap');
      if (getExpandedDirs().has(d)) {
        getExpandedDirs().delete(d);
        try { localStorage.setItem('ccm_expanded_dirs', JSON.stringify([...getExpandedDirs()])); } catch {}
        subtree.classList.remove('expanded');
        arrow.classList.remove('rotated');
        icon.textContent = '📁';
        drawerUnreadJump.resetCursor(d); // 下次点开从第一条未读重新数起
      } else {
        expandDir();
      }
    };

    return {
      dirRow,
      subtree,
      expand: expandDir,
      revalidate: () => populateSubtree(d, subtree, { background: true }),
    };
  }

  function openSessionPanel() {
    sessionPanel.innerHTML = '';
    // ★ 这里【不】清抽屉的失败回执。列表重建与那条回执没有因果关系，而每次打开抽屉都会走到
    // 这里：慢 ACK 的回执写进刚关上的抽屉后，用户重新打开的第一件事就是把它清掉——正好复现
    // 原来那个"点了没反应"。清除归 drawer（关抽屉时）与删除成功时，两处都是真的翻篇了。
    drawerUnreadJump.resetCursor(); // 面板整段重建：旧游标指向的行已不存在，从头数起
    // UX-007：当前工作区默认展开 + 记忆用户展开态
    try {
      const saved = JSON.parse(localStorage.getItem('ccm_expanded_dirs') || '[]');
      if (Array.isArray(saved)) for (const d of saved) if (d) getExpandedDirs().add(d);
    } catch { /* ignore */ }
    if (getCurrentCwd()) getExpandedDirs().add(getCurrentCwd());

    // 抽屉 = 注意力入口 + 导航树（非状态仪表盘）：需要你 → 服务异常 → 工作区树。
    // "需要你"聚合置顶（AttentionDeriver）：跨全部工作区/会话，
    // 不限于当前展开的目录——正是它相对下方逐目录列表的增量价值（注意力不对称）。
    sessionPanel.appendChild(buildNeedsYouSection());
    sessionPanel.appendChild(buildServiceSection());

    // 「选择文件夹」放在文件夹清单之上：放末尾时文件夹一多（真机 11 个）就沉到折叠线以下，得先滚才看得到。
    // 点开是家目录浏览（只看得到目录名，能不能加由服务端判）。
    // 手机上改不了清单时（验收 O41）与首页引导同一取舍：不给一个走完选择面板才被拒的入口，置灰并就地说清为什么。
    const foldersReadonly = projectsState.foldersReadonly();
    const addFolder = el(`<button type="button" class="w-full text-left px-3 py-2.5 text-xs text-accent hover:bg-sunk/40 active:bg-sunk disabled:text-ink-faint disabled:hover:bg-transparent disabled:active:bg-transparent" data-testid="drawer-add-folder"></button>`);
    addFolder.textContent = `＋ ${t('选择文件夹')}`;
    if (foldersReadonly) addFolder.disabled = true;
    else addFolder.onclick = () => { haptic('tap'); closeLeftSidebar(); folderPicker.open({ mode: 'add' }); };
    sessionPanel.appendChild(addFolder);
    if (foldersReadonly) {
      const why = el('<div class="px-3 pb-2 -mt-1 text-[11px] text-ink-faint" data-testid="drawer-folders-readonly"></div>');
      why.textContent = folderReasonText(foldersReadonly);
      sessionPanel.appendChild(why);
    }

    // 按项目清单顺序（已连接的文件夹按配置顺序、各自的子文件夹紧随其后、「无文件夹」垫底），每节一行：
    //   展开：📂 ▼ basename + 角标 → 下方缩进显示该目录会话列表（纯 /resume 时间序，已打开者就地标 ✕/角标）
    //   折叠：📁 ▶ basename + 角标 → 点击展开（若非当前 cwd 则同时切换）
    setDirSectionNodes(new Map());
    for (const d of getAvailableDirs()) {
      const section = buildDirSection(d);
      sessionPanel.appendChild(section.dirRow);
      sessionPanel.appendChild(section.subtree);
      getDirSectionNodes().set(d, section);
    }
    const unowned = buildUnownedLiveSection();
    if (unowned) sessionPanel.appendChild(unowned);
    startSessionPanelRevalidator();
  }

  // SESSION-02：cwd 不在任何工作区之下的活实例（例如刚进了仓库外的平级 worktree）单独成一节。
  // 只画活实例行、不发 session:list——这一节没有「工作区」可列，列了反而会拿越界 cwd 去查别人的会话。
  // 它随 instances 广播变化：状态变化走 rebuildDirSections，那里查不到这个 cwd 的节点就整段重建。
  function buildUnownedLiveSection() {
    const unowned = unownedLiveInstances(getInstancesList(), getAvailableDirs());
    if (!unowned.length) return null;
    const section = el(`<div data-testid="unowned-live-section"></div>`);
    const head = el(`<div class="px-3 pt-3 pb-1 text-[10px] uppercase tracking-wide text-ink-faint"></div>`);
    head.textContent = t('运行中（不在已连接的文件夹里）');
    section.appendChild(head);
    for (const inst of unowned) {
      section.appendChild(sessionRow({ id: inst.sessionId || null, title: inst.title, lastUsedAt: null, entrypoint: null }, inst, inst.cwd));
    }
    return section;
  }

  // 纯换序（拖动排序广播回来的新顺序，目录集合不变）：按新顺序把已有的 dirRow/subtree 节点挪位置，
  // 不重建内容、不碰 expandedDirs——换序不该触发 openSessionPanel() 那条全量重建路径（它会顺带把
  // UX-007「当前工作区强制展开」套在跟这次换序无关的目录上，2026-10-26 回归）。「无文件夹」之外
  // 的「运行中（不在已连接的文件夹里）」那一节不在 dirSectionNodes 里，挪完后把它续回最后。
  function reorderDirSections(order) {
    for (const d of order) {
      const section = getDirSectionNodes().get(d);
      if (!section || !section.dirRow.isConnected) {
        // 防御：面板还没针对这个目录做过全量渲染（同 rebuildDirSections 的同名防御）。
        // 自愈：退化为全量重建，好过留下一段挪了一半的面板。
        openSessionPanel();
        return;
      }
      sessionPanel.appendChild(section.dirRow);
      sessionPanel.appendChild(section.subtree);
    }
    const unowned = sessionPanel.querySelector('[data-testid="unowned-live-section"]');
    if (unowned) sessionPanel.appendChild(unowned);
  }

  // P3 抽屉局部重建：只重建 changedDirs 列出的目录（调用方=setInstances，changedDirs 来自
  // diffDirSignatures），其余目录的 dirRow/subtree 保持原 DOM 节点不动——滚动位置、侧滑态、
  // "显示更多"展开态等本地态都不受影响，不会像全量重建那样连坐撤离。dirRow 与 subtree 必须保持
  // 相邻兄弟节点（expandWorkspace 等测试辅助函数按 nextElementSibling 定位 subtree），两次
  // replaceWith 各自原地替换，不改变整体顺序，故这个不变量始终成立。
  function rebuildDirSections(changedDirs) {
    for (const d of changedDirs) {
      const old = getDirSectionNodes().get(d);
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
      getDirSectionNodes().set(d, next);
    }
  }

  // 已读位点被服务端刷新后（read:sync 归并回来）重画未读标记。每个目录小节的渲染逻辑是 buildDirSection
  // 的闭包，外部够不着，只能整段重建；面板还没渲染过时 dirSectionNodes 为空，什么都不做——下次
  // openSessionPanel 自然用新位点。首页最近列表不走这里：它在自己的 session:list 回调里 hydrate，
  // 与列表数据同帧渲染。
  function refreshUnreadMarks() {
    if (getDirSectionNodes()?.size) rebuildDirSections([...getDirSectionNodes().keys()]);
    refreshDashRecentUnreadMarks();
  }

  // 首页最近行的未读 chip 就地重算。首页是「重连后停在原地」最常见的落点（锁屏再打开必然重连），
  // 而 read:sync 只在 connect 那一趟发；只重建抽屉的话，已经画在屏幕上的首页行会一直停在旧判定，
  // 直到用户自己离开首页再回来——在另一台设备上读过的会话，这里仍写着「未读」。
  // 判定所需字段取自行自己的 dataset（渲染时留下），不保存列表快照：多一份状态就多一处会和 DOM 漂移。
  function refreshDashRecentUnreadMarks() {
    for (const item of document.querySelectorAll('#dashRecentsList .dash-recent-item[data-session-id]')) {
      const title = item.querySelector('.dash-recent-title');
      if (!title) continue;
      const id = item.dataset.sessionId;
      const lastUsedAt = Number(item.dataset.lastUsedAt);
      const shouldMark = unread.isUnread(
        { id, lastUsedAt: Number.isFinite(lastUsedAt) ? lastUsedAt : undefined },
        { isViewing: id === getDisplayedSessionId() },
      );
      const existing = title.querySelector('[data-testid="unread-mark"]');
      if (shouldMark === Boolean(existing)) continue;
      if (existing) existing.remove();
      else title.prepend(dashUnreadMark());
    }
  }

  // 首页最近行与抽屉行共用的「未读」chip 构造：渲染侧与就地重算侧各写一份必然漂移。
  function dashUnreadMark() {
    const mark = el(`<span data-testid="unread-mark" class="drawer-status-chip text-accent mr-1.5 align-middle"></span>`);
    mark.textContent = t('未读');
    mark.setAttribute('aria-label', t('未读'));
    return mark;
  }

  function isSessionPanelRevalidateActive() {
    if (!leftSidebar || document.visibilityState !== 'visible') return false;
    if (window.innerWidth >= 1024) return !document.body.classList.contains('sidebar-collapsed');
    return !leftSidebar.classList.contains('-translate-x-full');
  }
  // 关着抽屉时 last-known 到期撤下（#398）。到点时抽屉若又开着，轮询在刷，交给它；下次关抽屉再排。
  function expireTerminalState() {
    if (isSessionPanelRevalidateActive() || !terminalStateByDir.size) return;
    terminalStateByDir.clear();
    refreshDirBadges();
    updateSessionsDot();
  }
  function stopSessionPanelRevalidator() {
    if (sessionPanelRevalidateTimer) clearTimeout(sessionPanelRevalidateTimer);
    sessionPanelRevalidateTimer = null;
    terminalStateExpiry.arm(expireTerminalState);
    // 抽屉不可见时停掉 session:list 轮询（省流量）。但【保留】terminalStateByDir：#sessionsDot 在主界面
    // 正是靠这份 last-known 做「其他工作区终端需要你 / 运行中」的被动感知（product #398，2026-10-27）。
    // 旧实现这里 clear() 再 updateSessionsDot()，等于用户一回到主 UI 就把角标信号擦掉——与 summarizeOtherWorkspaces
    // 把 terminal_waiting/busy 排进 #sessionsDot 的设计初衷互斥。
    // 取舍：保留值可能略旧（抽屉关掉后不再轮询），宁可角标短暂滞后，也不要主界面恒盲；
    // 「短暂」由 terminalStateExpiry 兑现——最后一次观测满 60s 就撤下（expireTerminalState）。
    // 抽屉行 chip 仍剥 sessionsCache.terminal（见下），那是重开时防一帧假「运行中」；与顶栏角标无关。
    //
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
  // skipExpanded：紧跟 openSessionPanel() 的那次立即刷新专用。openSessionPanel 已经同步给每个
  // 展开目录调过 populateSubtree（各自恒发一次 session:list），再对它们刷一遍是纯冗余往返；这次
  // 立即刷新真正要覆盖的是【折叠目录】——它们不 populate，缓存空着，目录头未读角标要靠这一轮才有数。
  // 周期刷新与回前台不传此项（抽屉可能已开着很久，展开目录的数据同样陈旧，必须全量刷）。
  function revalidateSessionPanelDirs({ skipExpanded = false } = {}) {
    if (!isSessionPanelRevalidateActive()) { stopSessionPanelRevalidator(); return; }
    if (socket.connected) {
      for (const cwd of getAvailableDirs()) {
        if (skipExpanded && getExpandedDirs().has(cwd)) continue;
        getDirSectionNodes().get(cwd)?.revalidate?.();
      }
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
  function startSessionPanelRevalidator({ immediate = false, skipExpanded = false } = {}) {
    if (!isSessionPanelRevalidateActive()) { stopSessionPanelRevalidator(); return; }
    if (immediate) revalidateSessionPanelDirs({ skipExpanded });
    else scheduleSessionPanelRevalidate();
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') startSessionPanelRevalidator({ immediate: true });
    else stopSessionPanelRevalidator();
  });
  window.addEventListener('pagehide', stopSessionPanelRevalidator);

  return { dashUnreadMark, isSessionPanelRevalidateActive, mirrorRowLock, openSessionPanel, rebuildDirSections, refreshDirBadges, refreshNeedsYou, refreshSessionStatusChips, refreshUnreadMarks, reorderDirSections, startNewSessionIn, startSessionPanelRevalidator, stopSessionPanelRevalidator, updateAttentionSignal, updateServiceNotice, updateSessionsDot };
}
