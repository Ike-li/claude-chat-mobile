// 寄居在 #messages 里的几张「空状态表面」与它们牵动的外围显隐：首页枢纽（showDashboard）、新会话配置页
// （showComposeSurface + worktree 选择 chips）、会话打不开的落地页（showSessionBlockedSurface）、会话中断页
// （showInstanceDestroyedSurface）；以及 empty-start 切换时底栏 composer、顶栏 pill 的显隐与文案、新会话默认档摘要。
// #359 Step 3 从 app.js 原样迁出；app.js 里跨模块的可变态经 getter / setter 注入。

import { dashboardDirs, displaySessionTitle, esc, folderReasonText, formatComposeDefaultsSummary, formatSessionRowTime, formatTopContextPillAriaLabel, isBlockedSurfaceTarget, mergeRecentSessionsAcrossWorkspaces, recentWorkspaceChips, resolveEmptySurface, resolveModelPillText, shouldShowComposer, shouldShowTopContextPill, summarizeRecentsLoad } from '../logic.js';
import { t } from '../i18n.js';

export function createEmptySurfaces(context, {
  $, approvals, baseName, btnHome, btnNew, btnSessions, dashUnreadMark, el, elicitationSheet, folderPicker, haptic,
  hideStatuslineWrap, inputEl, messagesEl, modelInput, newSessionWorktree, openLeftSidebar, panelCwd,
  pillEffortText, pillPermText, projectsState, scrollToBottom, showAccessHelp, socket, topContextChanges,
  topContextPill, topProjectText, topTitleText, unread, updateWorkspaceChangeBadge, wireConfigRefreshButton,
  getAvailableDirs, getComposeReady, getCurrentCwd, getCurrentGatewaySuffix, getCurrentModel,
  getCurrentSessionId, getCwdDefaultModel, getDisplayedSessionId, getFreshInterruptedInstanceId,
  getInstancesList, getLatestServiceHealth, getModelsList, getPendingFirstSend, getViewingInstanceId,
  setComposeReady,
} = {}) {
  // 空首页最近列表代次：连续 showDashboard（切 cwd / 重连）时丢弃过期 ack，防旧列表盖新。
  // 产品决策：重启/空闲回收后永远停在空首页，只展示最近列表，不自动 session:switch。
  let _dashRecentsGen = 0;

  // 底部输入区显隐：空首页枢纽隐藏；composeReady（点 ＋）/ 有 session / 首发在途显示。
  const composerFooterEl = document.getElementById('composerFooter') || document.querySelector('footer');
  function syncComposerVisibility() {
    const sid = getInstancesList().find(x => x.instanceId === getViewingInstanceId())?.sessionId
      || getCurrentSessionId()
      || getDisplayedSessionId()
      || null;
    const show = shouldShowComposer({
      viewingInstanceId: getViewingInstanceId(),
      sessionId: sid,
      composeReady: getComposeReady(),
      pendingFirstSend: getPendingFirstSend(),
      freshInterrupted: getViewingInstanceId() === getFreshInterruptedInstanceId(),
    });
    if (!composerFooterEl) return;
    composerFooterEl.classList.toggle('hidden', !show);
    // composer 显隐会改「回到最新」的 isEnabled 与定位；无滚动事件时也要立刻同步。
    scrollToBottom.sync();
  }
  // 顶部文件夹 pill：真实会话 + compose 页（工作区已定，文件/改动与 session 无关）显示；空首页隐藏。
  // composeReady 显式传参而不是直接读 _composeReady：三个空表面里 destroyed 那张调用时 _composeReady
  // 可能仍是 true（resolveEmptySurface 的 instanceDestroyed 分支排在 composeReady 之前），读全局会让
  // 「会话已中断」表面凭空多出一个入口。cwd 取 panelCwd()——与 pill 的 onclick 同源，判据和落点不许分叉。
  function syncTopContextPillVisibility(viewingId = getViewingInstanceId(), sessionId = null, { composeReady = getComposeReady() } = {}) {
    if (!topContextPill) return;
    const sid = sessionId
      ?? getInstancesList().find(x => x.instanceId === viewingId)?.sessionId
      ?? getCurrentSessionId()
      ?? getDisplayedSessionId()
      ?? null;
    const show = shouldShowTopContextPill({
      viewingInstanceId: viewingId, sessionId: sid, composeReady, cwd: panelCwd(), scratchRoot: projectsState.scratchRoot(),
    });
    topContextPill.classList.toggle('hidden', !show);
    // 隐藏时不可聚焦，避免读屏仍读到工作区入口
    topContextPill.tabIndex = show ? 0 : -1;
    topContextPill.setAttribute('aria-hidden', show ? 'false' : 'true');
  }

  // 顶栏主 pill 文案：固定工作区 basename（维护者拍板不要会话标题——同仓多会话靠侧栏区分）。
  // #topTitleText 仍 hidden；title 挂点开会浏览的那个完整目录供长按辨认——取 panelCwd()，与 onclick 同源。
  // 取工作区 cwd 会和落点分叉：「无文件夹」会话写成 scratch 根（点开看的是它自己的 scratch 目录），
  // worktree 会话写成父仓（点开看的是 worktree）。
  function syncTopContextLabel() {
    const project = baseName(getCurrentCwd());
    if (topProjectText) topProjectText.textContent = project || '…';
    // 换工作区即清角标：别让上个工作区的数字挂在新工作区名旁边（下一条 status_line 会填新值）。
    // 判据用 cwd 归属而非「每次调用都清」——本函数随 instances 广播高频触发，无条件清会让角标反复闪。
    if (topContextChanges && topContextChanges.dataset.cwd !== (getCurrentCwd() || '')) {
      updateWorkspaceChangeBadge(null);
    }
    if (topContextPill) {
      const target = panelCwd();
      topContextPill.title = target
        ? `${t('工作区：浏览或查看改动')} · ${target}`
        : t('工作区：浏览或查看改动');
    }
    syncTopContextPillAriaLabel();
  }
  /** pill 无障碍名：工作区名 + 可选改动数（角标单独可读，但 pill 名也要带数，避免只摸到文件夹图标）（#366） */
  function syncTopContextPillAriaLabel() {
    if (!topContextPill) return;
    const project = (topProjectText?.textContent || '').trim() || baseName(getCurrentCwd()) || '';
    const changesText = (topContextChanges && !topContextChanges.classList.contains('hidden'))
      ? (topContextChanges.textContent || '').trim()
      : '';
    topContextPill.setAttribute('aria-label', formatTopContextPillAriaLabel({ project, changesText }));
  }
  function enterComposeReady() {
    setComposeReady(true);
    syncComposerVisibility();
  }
  function leaveComposeReady() {
    if (!getComposeReady()) {
      syncComposerVisibility();
      return;
    }
    setComposeReady(false);
    syncComposerVisibility();
  }

  // 读底栏 pill 已同步的文案（instances defaults / models scout）→ 写进 compose 页摘要。
  // 与 setPermMode / setEffortMode / syncModelUI 同源，避免页内与底栏各猜一套。
  function currentComposeDefaultsLabels() {
    const cliDefault = (getModelsList() || []).find(m => (typeof m === 'string' ? m : m?.value) === 'default');
    const cliDefaultLabel = cliDefault && typeof cliDefault === 'object'
      ? (cliDefault.displayName || 'Default (recommended)')
      : null;
    // 与底栏 pill 同源（resolveModelPillText）：新会话空 model 时同样把 cwd 默认别名解析成真实模型名，
    // 不再各猜一套 / 靠读 pill DOM 文案兜底。
    // H3：compose 摘要与底栏 pill 同源——优先待发 modelInput（下一条才生效），否则 currentModel
    const pendingModel = (modelInput?.dataset?.fullModel || modelInput?.value || '').trim();
    const modelForSummary = (pendingModel && pendingModel !== 'default') ? pendingModel : getCurrentModel();
    const modelLabel = resolveModelPillText({
      model: modelForSummary,
      gatewaySuffix: getCurrentGatewaySuffix(),
      modelsList: getModelsList(),
      cwdDefaultModel: getCwdDefaultModel(),
      cliDefaultLabel,
    });
    return {
      modelLabel,
      modeLabel: (pillPermText?.textContent || '').trim(),
      effortLabel: (pillEffortText?.dataset.full || pillEffortText?.textContent || '').trim(),
    };
  }
  function refreshComposeDefaultsSummary() {
    const elSum = messagesEl?.querySelector?.('[data-compose-defaults]');
    if (!elSum) return;
    elSum.textContent = formatComposeDefaultsSummary(currentComposeDefaultsLabels());
  }

  // 空表面本地分流：viewing 已 null 时 instances 广播不进 bindView，＋/侧栏 ＋ 须直接重渲。
  function ensureEmptySurface() {
    const sid = getInstancesList().find(x => x.instanceId === getViewingInstanceId())?.sessionId
      || getCurrentSessionId()
      || getDisplayedSessionId()
      || null;
    const surface = resolveEmptySurface({
      viewingInstanceId: getViewingInstanceId(),
      sessionId: sid,
      composeReady: getComposeReady(),
      freshInterrupted: Boolean(getViewingInstanceId()) && getViewingInstanceId() === getFreshInterruptedInstanceId(),
    });
    if (surface === 'compose') showComposeSurface();
    else if (surface === 'home') showDashboard();
  }


  // 新会话页的 worktree 两件套：源分支 chip（可点换分支）+「在新 worktree 里开」勾选。
  //
  // 【懒创建】勾选只改本地状态，**一个请求都不发**：意图跟着第一条消息传给服务端，那时才
  // `git worktree add`。勾了又取消、改分支重勾，磁盘上都不会留下任何东西。
  // 与 Claude Code Desktop 同构——它的 lazyWorktrees.prepare 同样挂在 start_session 上，不挂在勾选上。
  // 【非 git 工作区整块不显示】那里没有 worktree 这个概念，摆一个恒灰的勾选框只会让人去点。
  let branchListOpen = false;
  function renderWorktreeChips() {
    const host = messagesEl?.querySelector('[data-worktree-chips]');
    if (!host) return;
    const st = newSessionWorktree.snapshot();
    const sub = messagesEl.querySelector('[data-compose-sub]');
    host.innerHTML = '';

    if (!newSessionWorktree.isAvailable()) {
      if (sub) sub.textContent = t('将在此工作区开新 CLI 会话');
      return;
    }

    if (sub) {
      sub.textContent = st.enabled
        ? t('将在 %s 的新 worktree 里开，不动当前工作树').replace('%s', st.sourceBranch || '')
        : t('将在此工作区开新 CLI 会话');
    }

    const row = el('<div class="flex items-center justify-center gap-1.5 flex-wrap"></div>');

    // 没勾时胶囊锁定、显示仓库当前分支：源分支只对新 worktree 有意义，没勾时会话就开在主工作树上。
    // 此前没勾也能选，胶囊写着 feat、会话却开在 main，没有任何提示（2026-10-10 真机）。
    const locked = !st.enabled;
    // 锁定用 aria-disabled 而不是 disabled：原生 disabled 的按钮连点击都不派发，手机上没有悬停，原因只放在 title 里
    // 就永远看不到，点了没反应像是坏了（验收 O54）。点一下把原因写在胶囊下面。
    const lockedReason = t('勾选「在新 worktree 里开」后可换源分支');
    const branchBtn = el(`<button type="button" class="inline-flex items-center gap-1 px-2.5 py-1 rounded-full border border-line-soft bg-surface text-ink-soft text-[11px] font-semibold active:scale-[0.98] transition-all${locked ? ' opacity-50' : ''}" data-testid="compose-source-branch"${locked ? ` aria-disabled="true" title="${esc(lockedReason)}"` : ''}>
      <span class="text-ink-faint">⑂</span><span class="max-w-[9rem] truncate">${esc(st.sourceBranch || '')}</span>${locked ? '' : '<span class="text-ink-faint">⌄</span>'}
    </button>`);
    branchBtn.onclick = (e) => {
      e.stopPropagation();
      haptic('tap');
      if (locked) {
        const hint = host.querySelector('[data-testid="compose-branch-locked-hint"]');
        if (hint) hint.classList.remove('hidden');
        return;
      }
      branchListOpen = !branchListOpen;
      renderWorktreeChips();
    };
    row.appendChild(branchBtn);

    const on = st.enabled;
    const wtBtn = el(`<button type="button" class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[11px] font-semibold active:scale-[0.98] transition-all ${on ? 'border-accent-bright bg-accent-wash text-accent-deep' : 'border-line-soft bg-surface text-ink-soft'}" data-testid="compose-worktree-toggle" aria-pressed="${on}">
      <span class="inline-block w-3.5 h-3.5 rounded-[4px] border ${on ? 'bg-cta border-cta text-white' : 'border-line'} leading-[13px] text-[9px] text-center">${on ? '✓' : ''}</span>
      <span>${t('在新 worktree 里开')}</span>
    </button>`);
    wtBtn.onclick = (e) => {
      e.stopPropagation();
      haptic('tap');
      branchListOpen = false;
      newSessionWorktree.setEnabled(!on);
    };
    row.appendChild(wtBtn);
    host.appendChild(row);
    if (locked) {
      const hint = el('<div class="hidden text-[10px] text-ink-soft" data-testid="compose-branch-locked-hint" role="status"></div>');
      hint.textContent = lockedReason;
      host.appendChild(hint);
    }

    if (st.loadError) {
      const errEl = el(`<div class="text-[10px] text-danger"></div>`);
      errEl.textContent = st.loadError;
      host.appendChild(errEl);
    }

    // 锁定时列表也不画：branchListOpen 不随 reset() 清零，勾上→点开列表→回新会话会留一个开着的
    // 列表挂在锁定的胶囊下面，照样能选。
    if (!locked && branchListOpen && st.branches.length) {
      // 自绘按钮组，不用原生 select：移动端上原生下拉会把弹层渲染到页面另一头（2026-09-11 实测）
      const list = el('<div class="flex flex-wrap items-center justify-center gap-1 max-h-32 overflow-y-auto px-1" data-testid="compose-branch-list"></div>');
      for (const b of st.branches) {
        const active = b === st.sourceBranch;
        const item = el(`<button type="button" class="px-2 py-0.5 rounded-full border text-[11px] ${active ? 'border-accent-bright bg-accent-wash text-accent-deep font-semibold' : 'border-line-soft bg-surface text-ink-soft'}"></button>`);
        item.textContent = b;
        item.onclick = (e) => {
          e.stopPropagation();
          haptic('tap');
          branchListOpen = false;
          newSessionWorktree.setSourceBranch(b);
          // 已勾选时换分支 = 换了源，必须重建：旧那棵是从别的分支切的，继续用就是在错的基线上干活
          // 换分支不需要做任何事：意图跟着第一条消息传给服务端，此刻磁盘上还什么都没建
        };
        list.appendChild(item);
      }
      host.appendChild(list);
    }
  }

  // 干净新会话页（＋ / session:new）：当前工作区 + 将开 CLI 的默认档 + 示例 prompt；无最近列表。
  function showComposeSurface({ relocatedFrom = null } = {}) {
    messagesEl.innerHTML = '';
    messagesEl.classList.add('empty-start');
    if (topTitleText) topTitleText.textContent = t('新聊天');
    // 走 syncTopContextLabel 而不是只手写 topProjectText：pill 现在在这张页面上是【可见】的，
    // 光换名字不够——改动角标与 title 还归属上一个工作区，得靠它那道 dataset.cwd 判据清掉。
    // 抽屉里按目录行点 ＋ 时这条路是同步的（currentCwd 当场改、compose 表面当场渲染），不清就会
    // 出现「新工作区名 + 旧工作区改动数」，一直挂到服务端 instances 广播回来才自愈。
    syncTopContextLabel();
    syncComposerVisibility();
    // compose 页：显示顶栏文件夹（工作区已定；页内那个 pill 通向会话列表，不通向文件）
    syncTopContextPillVisibility(null, null, { composeReady: true });
    // 状态栏先清空再等新数据：btnNew 这条路**不经过 clearView**（见 btnNew.onclick → ensureEmptySurface），
    // 上一个会话的 model/ctx 会原样挂在新会话页上。
    //
    // 【E2E 验不到，别照着"没测试所以是冗余"删】：compose 页随后必定收到自己那条 status_line
    // （真 server session:new 末尾 scheduleStatusRefresh；mock 已对齐），而 status_line 渲染是整体替换
    // （cliStatusEl.textContent='' 后重 append），于是残留窗口只有那 300ms，断言必然扑空。这行保的是
    // statusOff / WEB_STATUSLINE=off 的场景——那条事件永不到达，不清就是永久显示别的会话的用量。
    hideStatuslineWrap();

    const defaultsText = formatComposeDefaultsSummary(currentComposeDefaultsLabels());
    const container = el(`
      <div class="compose-surface flex flex-col items-center w-full max-w-xl mx-auto py-8 px-3 select-none" data-testid="compose-surface">
        <div class="text-center mb-5 w-full">
          <h1 class="text-xl md:text-2xl font-bold tracking-tight text-ink mb-2 leading-tight">${t('新会话已就绪')}</h1>
          <div class="text-[10px] text-ink-faint uppercase tracking-wider mb-1" data-compose-sub>${t('将在此工作区开新 CLI 会话')}</div>
          <button type="button" class="compose-project-pill inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full border border-line-soft bg-surface text-ink hover:bg-sunk active:scale-[0.98] transition-all text-xs font-semibold shadow-sm" data-testid="compose-project-pill" title="${t('换一个文件夹')}">
            <svg class="w-4 h-4 shrink-0 text-accent opacity-90" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M3 7.5A2.5 2.5 0 015.5 5h4.25l2 2H18.5A2.5 2.5 0 0121 9.5v7A2.5 2.5 0 0118.5 19h-13A2.5 2.5 0 013 16.5v-9z" />
            </svg>
            <span class="max-w-[12rem] truncate">${esc(baseName(getCurrentCwd()))}</span>
            <span class="text-xs text-ink-faint">⌄</span>
          </button>
          ${relocatedFrom ? `<div class="mt-2 text-xs text-warning" data-testid="compose-relocated">${t('文件夹「')}${esc(baseName(relocatedFrom))}${t('」已断开，新会话改在这里开')}</div>` : ''}
          <div class="mt-2 flex flex-col items-center gap-1.5" data-worktree-chips></div>
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

    // 照官方新会话页：胶囊就是「在哪开」的选择器（已连接的文件夹 / 子文件夹 / 无文件夹 / 添加文件夹）
    container.querySelector('.compose-project-pill').onclick = (e) => {
      e.stopPropagation();
      haptic('tap');
      folderPicker.open();
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
    // 分支列表按 cwd 缓存，拉到后 onChange 会回来重画这一块；拉之前先画一次（此时 isAvailable
    // 为假、整块不显示），避免非 git 工作区闪一下空 chip 行。
    renderWorktreeChips();
    void newSessionWorktree.ensureBranches(getCurrentCwd());
    // defaults 可能仍在 L4→L3 途中；微任务再刷一次，兜住刚 setPerm/setEffort 的 pill 文案
    queueMicrotask(() => refreshComposeDefaultsSummary());
  }

  // 会话打不开时的落地页（2026-09-07）。**四个 session:switch 入口共用的失败路径**：侧栏会话行 /
  // 首页最近列表 / 通知深链落地 / 重启后「继续此会话」。此前它们各自 addBar，而 addBar 落在
  // #messages —— 也就是【当时正看着的那个会话】的消息流里。视图从头到尾没动过，于是「blog_static 的
  // 会话被后台任务占用」这句话出现在 third-party 会话的工具卡中间，读起来像是当前会话出了事；点击时
  // 又已经先 closeLeftSidebar()，连"我刚点了别的会话"这个上下文都没了（2026-09-06 用户实撞）。
  //
  // 与 showInstanceDestroyedSurface 的关键区别：那张空表面直接 messagesEl.innerHTML = ''，因为那时
  // 实例真的没了；这里当前会话很可能【正在跑】，清空会让后续流式事件追加到一片废墟上。所以这里是
  // 覆盖层，不碰 #messages，关掉即回到原会话。
  let blockedSurfaceTarget = null;
  let blockedSurfaceWired = false;
  function setBlockedReason(text) {
    const reasonEl = $('sessionBlockedReason');
    if (reasonEl) reasonEl.textContent = text;
  }
  function hideSessionBlockedSurface() {
    blockedSurfaceTarget = null;
    $('sessionBlockedSurface')?.classList.add('hidden');
    approvals.resume();
    elicitationSheet.resume();
  }
  // 迟到的成功 ack：4s 兜底已经把落地页弹出来了，而这次切换其实成功了——服务端可能先广播导航、
  // 后回 ack。不撤掉的话用户人已经在目标会话里，屏幕上却盖着一张「切换无响应」。
  // 只撤属于本次请求的那一张：这 4 秒里用户完全可能已经点开别的会话并撞上真实失败，
  // 无条件 hide 会把那条真实的错误提示一起抹掉。
  function dismissBlockedSurfaceIfTarget(sessionId, cwd) {
    if (isBlockedSurfaceTarget(blockedSurfaceTarget, { sessionId, cwd })) hideSessionBlockedSurface();
  }
  function retryBlockedSession() {
    const target = blockedSurfaceTarget;
    if (!target?.sessionId) return;
    const btn = $('sessionBlockedRetry');
    // 乐观禁用 + 4s 兜底恢复：与四个入口原本各自的 ack/超时约定同形，不新造一套。
    if (btn) btn.disabled = true;
    let acked = false;
    socket.emit('session:switch', { sessionId: target.sessionId, cwd: target.cwd }, res => {
      acked = true;
      if (btn) btn.disabled = false;
      // 成功后不必自己导航：服务端广播新 viewingInstanceId，setInstances→bindView 自然接管。
      // 按目标撤而不是无条件 hide：这次重试的 ack 可能迟到，期间用户已经点开别的会话并撞上
      // 真实失败，此刻挂着的是那一张——无条件 hide 会把那条真实错误一起抹掉。
      if (res?.ok) dismissBlockedSurfaceIfTarget(target.sessionId, target.cwd);
      else setBlockedReason(res?.error || t('切换失败'));
    });
    setTimeout(() => {
      if (acked) return;
      if (btn) btn.disabled = false;
      setBlockedReason(t('切换无响应，请刷新页面后重试'));
    }, 4000);
  }
  function showSessionBlockedSurface({ sessionId = null, cwd = null, title = '', message = '' } = {}) {
    const surface = $('sessionBlockedSurface');
    if (!surface) return;
    blockedSurfaceTarget = { sessionId, cwd };
    const titleEl = $('sessionBlockedTitle'), projectEl = $('sessionBlockedProject');
    // 标题回落短 id：深链与「继续此会话」两条路只有 {sessionId, cwd}，拿不到标题。宁可显示
    // 8 位 id 也不写"会话"——用户要靠这行确认自己点的是不是那一个。
    if (titleEl) titleEl.textContent = displaySessionTitle(title, sessionId ? sessionId.slice(0, 8) : t('会话'));
    if (projectEl) projectEl.textContent = cwd ? baseName(cwd) : '';
    setBlockedReason(message || t('切换失败'));
    if (!blockedSurfaceWired) {
      blockedSurfaceWired = true;
      $('sessionBlockedBack').onclick = () => { haptic('tap'); hideSessionBlockedSurface(); };
      $('sessionBlockedRetry').onclick = () => { haptic('tap'); retryBlockedSession(); };
      $('sessionBlockedSessions').onclick = () => { haptic('tap'); hideSessionBlockedSurface(); openLeftSidebar(); };
    }
    surface.classList.remove('hidden');
    // 底下那个会话（视图没动）的审批 / 提问卡是 z-40 的 sheet，会浮在这张落地页上，读起来像是这个打不开的会话的
    // （验收 O38）。收起而不是清掉：卡还是原会话的，返回时原样恢复。
    approvals.suspend();
    elicitationSheet.suspend();
  }

  // 点停止顿一下跳主页的回归修复：正在查看的实例被摧毁（中断失败→settleForce 强杀子进程→onExit→
  // 无同 cwd 存活实例可回退，见 wasViewingInstanceDestroyed）时的专属提示态——不静默 showDashboard()，
  // 让用户先看到"发生了什么"，自己决定下一步（回首页 / 新建会话）。不做自动导航（维护者已否决"自动
  // 静默 resume 接管"方案，这里同理：不能因为实现方便就悄悄跳转）。
  // 视觉语言复用两处既有约定：标题行走 addBar 同款 msg-frame 系统提示条样式（对齐 interrupted/
  // queue_dropped 的系统提示行）；外层卡片 + 操作按钮走 showDashboard/showComposeSurface 同款
  // 空表面卡片布局——不引入新的弹窗/模态体系。两个按钮直接复用 btnHome/btnNew 的既有点击处理，
  // 不重复其内部逻辑（保持行为完全一致，包括 haptic、freshInterruptedInstanceId 清理等副作用）。
  // byRestart：server 整机重启细分（见 setInstances 的 detectServerRestart）——不是这个实例被单独
  // 摧毁，文案换成准确的「服务已重启」，并加「继续此会话」一键重开（resume={sessionId,cwd} 走既有
  // session:switch 打开路径懒 resume，与侧栏/最近列表点击同源）。不自动切换：尊重「重启后不自动
  // session:switch」的既有产品决策（见 _dashRecentsGen 注释），按钮是用户主动点的。
  function showInstanceDestroyedSurface({ byRestart = false, resume = null, reason = null } = {}) {
    messagesEl.innerHTML = '';
    messagesEl.classList.add('empty-start');
    if (topTitleText) topTitleText.textContent = t('新聊天');
    if (topProjectText) topProjectText.textContent = baseName(getCurrentCwd());
    syncComposerVisibility();
    // 「会话已中断」：顶栏文件夹入口隐藏（同 home）。显式 composeReady:false——见函数注释，此处全局值不可信
    syncTopContextPillVisibility(null, null, { composeReady: false });
    // 状态栏也要收：实例已经没了，里面那份 ctx / 模型 / 额度全归属于它，留在屏上就是在报废数字。
    // 这张表面不像 home 那样能靠 #composerFooter 整体隐藏顺带藏掉它——composer 在这里仍可能是显示的
    // （从 compose 首发跳过来时 _composeReady 停在陈旧的 true，shouldShowComposer 据此判显示）。
    // 上面那道判据改读 DOM 只防住「后续事件把它重新渲染出来」，防不住已经渲染好的那份残留。
    hideStatuslineWrap();

    const title = byRestart ? t('🔄 服务已重启') : t('⏹ 会话已中断');
    // reason：进程异常退出的原因（O121）。有它时说明换掉「停止操作未能正常结束」——那是停止路径的说法，
    // 进程被 kill 时用户根本没点过停止。
    const body = byRestart
      ? t('服务已重启，之前的会话进程随之退出。会话记录仍保存在磁盘上，可以继续此会话，也可以回首页或新建一个会话。')
      : reason
        ? t('后台会话进程已意外退出，无法直接继续。可以回首页，或在此工作区新建一个会话。')
        : t('停止操作未能正常结束，后台会话进程已意外退出，无法直接继续。可以回首页，或在此工作区新建一个会话。');
    const canResume = byRestart && resume?.sessionId && resume?.cwd;
    const container = el(`
      <div class="instance-destroyed-surface flex flex-col items-center w-full max-w-xl mx-auto py-8 px-3 select-none" data-testid="instance-destroyed-surface">
        <div class="msg-frame text-center text-xs text-warning font-semibold mb-2">${title}</div>
        ${!byRestart && reason ? `<p class="text-xs text-danger text-center mb-2 max-w-sm leading-relaxed px-2 break-words" data-testid="instance-destroyed-reason">${esc(reason)}</p>` : ''}
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
        const blocked = message => {
          resumeBtn.disabled = false;
          showSessionBlockedSurface({ sessionId: resume.sessionId, cwd: resume.cwd, message });
        };
        socket.emit('session:switch', { sessionId: resume.sessionId, cwd: resume.cwd }, res => {
          acked = true;
          if (!res?.ok) blocked(res?.error || t('切换失败'));
          else dismissBlockedSurfaceIfTarget(resume.sessionId, resume.cwd); // 同上：迟到的成功 ack 要撤页
        });
        setTimeout(() => { if (!acked) blocked(t('切换无响应，请刷新页面后重试')); }, 4000);
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
    if (topProjectText) topProjectText.textContent = baseName(getCurrentCwd());
    syncComposerVisibility();
    syncTopContextPillVisibility(null, null, { composeReady: false }); // 首页：工作区未选定，顶栏文件夹隐藏

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

        <div class="w-full hidden mb-5 p-4 rounded-xl border border-line-soft bg-surface text-center" data-testid="dash-no-folders">
          <p class="text-sm font-semibold text-ink mb-1" data-dash-no-folders-title>${t('还没有连接文件夹')}</p>
          <p class="text-xs text-ink-faint mb-3">${t('选一个项目文件夹，claude 就在里面读写代码。只是聊聊的话，点 ＋ 直接在「无文件夹」里开。')}</p>
          <button type="button" class="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full bg-cta text-white text-xs font-semibold shadow-sm active:scale-[0.98] transition-all" data-testid="dash-pick-folder">${t('选择文件夹')}</button>
          <p class="hidden text-xs text-ink-soft" data-testid="dash-folders-readonly"></p>
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
          <!-- 部分工作区 session:list 超时（4s）时的缺角提示：拿不到 ≠ 没有。常驻此处，JS 只切 hidden + 换文案。 -->
          <p id="dashRecentsIncomplete" class="hidden text-[10.5px] text-ink-faint mt-2 px-1" data-testid="recents-incomplete"></p>
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
    // 零文件夹引导：直接进家目录浏览（加上一个就在那里开新会话，见 folder-picker.js 的 add）
    container.querySelector('[data-testid="dash-pick-folder"]').onclick = (e) => {
      e.stopPropagation();
      haptic('tap');
      folderPicker.open({ mode: 'add' });
    };

    // 跨全部项目拉最近会话（并行 session:list），合并后展示，便于冷启动/空首页一键切回。
    // worktree 的会话随所属仓库的列表一起回来。
    const recentsSection = container.querySelector('#dashRecentsSection');
    const recentsList = container.querySelector('#dashRecentsList');
    const workspacesSection = container.querySelector('#dashWorkspacesSection');
    const workspacesList = container.querySelector('#dashWorkspacesList');
    const emptyHint = container.querySelector('#dashEmptyHint');
    const dirs = dashboardDirs({ keys: getAvailableDirs(), connectedCount: projectsState.connectedCount(), currentCwd: getCurrentCwd() });
    const gen = ++_dashRecentsGen;

    const switchToSession = (s) => {
      let acked = false;
      const blocked = message => showSessionBlockedSurface({ sessionId: s.id, cwd: s.cwd, title: s.title, message });
      socket.emit('session:switch', { sessionId: s.id, cwd: s.cwd }, res => {
        acked = true;
        if (!res?.ok) blocked(res?.error || t('切换失败'));
        else dismissBlockedSurfaceIfTarget(s.id, s.cwd); // 同上：迟到的成功 ack 要撤页
      });
      setTimeout(() => { if (!acked) blocked(t('切换无响应，请刷新页面后重试')); }, 4000);
    };

    const renderDashRecents = (recent) => {
      // 工作区 chips：一个项目一个、按最近会话时间排，点 chip → 进入该区最近一条
      if (workspacesSection && workspacesList) {
        const wsOrder = recentWorkspaceChips(recent);
        workspacesList.innerHTML = '';
        for (const s of wsOrder) {
          const chip = el(`
            <button type="button" class="inline-flex items-center gap-1.5 max-w-full px-3 py-1.5 rounded-full border border-line-soft bg-surface hover:bg-accent-wash/40 hover:border-accent-bright/50 active:scale-[0.98] transition-all text-xs font-semibold text-ink shadow-sm">
              <span class="shrink-0 opacity-80 dash-ws-icon"></span>
              <span class="truncate max-w-[10rem]"></span>
            </button>`);
          chip.querySelector('.dash-ws-icon').textContent = '📁';
          chip.querySelector('span.truncate').textContent = s.workspaceName;
          chip.title = s.workspaceCwd;
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
        const when = s.lastUsedAt ? formatSessionRowTime(s.lastUsedAt) : t('时间未知');
        // 原生 button 而不是带 onclick 的 div（验收 O11）：同权限六档那次的理由——键盘走得到、Enter/空格能点、
        // 读屏认得是控件，都由浏览器给。
        const item = el(`
          <button type="button" class="dash-recent-item w-full text-left flex items-center justify-between p-3 bg-surface hover:bg-accent-wash/30 border border-line-soft hover:border-accent-bright/50 rounded-xl cursor-pointer transition-all active:scale-[0.99]">
            <div class="flex-1 min-w-0 pr-3">
              <div class="dash-recent-title font-bold text-xs text-ink truncate"></div>
              <div class="text-[10px] text-ink-faint mt-1 flex items-center gap-1.5 min-w-0">
                <span class="shrink-0 dash-ws-icon"></span>
                <span class="truncate dash-ws"></span>
                <span class="shrink-0 opacity-50">·</span>
                <span class="shrink-0 dash-when"></span>
              </div>
            </div>
            <div class="text-xs text-accent font-bold shrink-0">${t('进入 ➔')}</div>
          </button>
        `);
        item.querySelector('.dash-recent-title').textContent = s.title || t('无标题会话');
        // 判定所需的两个字段留在行上：位点晚到时（read:sync 归并）要能就地重算，而 renderDashRecents
        // 是 showDashboard 的闭包、外部够不着。存 DOM 不存快照——省掉一份会和界面漂移的状态。
        if (s.id) item.dataset.sessionId = s.id;
        if (Number.isFinite(s.lastUsedAt)) item.dataset.lastUsedAt = String(s.lastUsedAt);
        // R65 未读（首页最近行）：与抽屉同款「未读」chip，inline-flex 前置进 truncate 容器，不改其块级截断语义。
        if (s.id && unread.isUnread(s, { isViewing: s.id === getDisplayedSessionId() })) {
          item.querySelector('.dash-recent-title').prepend(dashUnreadMark());
        }
        item.querySelector('.dash-ws-icon').textContent = '📁';
        // 托管 worktree 的会话挂在父仓工作区名下，但要标出工作树——否则首页两行看起来是同一个
        // 地方的会话，而它们改的是不同的树。cwd 已由 mergeRecentSessionsAcrossWorkspaces 带回真实值。
        const wsLabel = s.worktree ? `${s.workspaceName} / ${s.worktree}` : s.workspaceName;
        item.querySelector('.dash-ws').textContent = wsLabel;
        item.querySelector('.dash-when').textContent = when;
        item.title = `${wsLabel} · ${s.title || t('无标题会话')}`;
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

    // 缺角提示。两件事：① 说出「有 N 个工作区没能加载」；② 把 dashEmptyHint 压掉——「还没有最近
    // 会话」在缺角时是错的（全部超时 → recent 为空 → 那句话会以确定语气宣布一件没被证实的事，
    // 正是本次要修的病本身）。无缺角时本函数不碰 section/emptyHint，那是 renderDashRecents 的职责。
    const incompleteEl = container.querySelector('#dashRecentsIncomplete');
    const renderRecentsIncompleteNotice = ({ complete, failedCount, failedDirs } = {}) => {
      if (!incompleteEl) return;
      if (complete !== false) { incompleteEl.classList.add('hidden'); incompleteEl.textContent = ''; return; }
      const names = failedDirs.map(baseName).join('、');
      incompleteEl.textContent = `${t('{n} 个工作区未能加载').replace('{n}', String(failedCount))}：${names}`;
      incompleteEl.classList.remove('hidden');
      recentsSection?.classList.remove('hidden');
      emptyHint?.classList.add('hidden');
    };

    if (recentsSection && recentsList && dirs.length) {
      // timedOut 必须随行上报：拿不到 ≠ 该目录没有会话。此前超时一律 done([])，那个工作区连同
      // 它的未读会话从首页静默消失、界面零痕迹（与目录头角标 null/0 同形是同一个病）。合并结果
      // 不变（拿到多少展示多少），只是让下面能挂一行「部分工作区未能加载」。
      const listMain = (cwd) => new Promise(resolve => {
        let settled = false;
        const done = (sessions, timedOut = false) => {
          if (!settled) { settled = true; resolve({ cwd, sessions, timedOut, workspaceName: baseName(cwd) }); }
        };
        socket.emit('session:list', { cwd }, state => {
          unread.hydrate(state?.readState); // 首页最近行也画未读 chip；Promise.all 之后才渲染，天然同帧
          // 刻意不合并 ack 的 pinned（手动标「稍后再看」但排在分页窗外的那些）：这个列表叫「最近」，
          // 语义是时间序的前 8 条，塞进上周的会话既名不副实，又会挤掉真正最近的。待办入口在抽屉。
          done(state?.sessions || []);
        });
        setTimeout(() => done([], true), 4000); // 单目录超时不挡整表，但要说出来
      });
      Promise.all(dirs.map(listMain)).then((mainLists) => {
        if (gen !== _dashRecentsGen) return; // 已换页/重渲
        const recent = mergeRecentSessionsAcrossWorkspaces(mainLists, { limit: 8 });
        renderDashRecents(recent); // 空列表也渲 → dashEmptyHint
        renderRecentsIncompleteNotice(summarizeRecentsLoad(mainLists));
      });
    } else if (emptyHint) {
      emptyHint.classList.remove('hidden');
    }

    messagesEl.appendChild(container);
    syncDashNoFolders();
  }

  // 首页的零文件夹引导（2026-10-15）。一个文件夹都没连时 server 照常起、只剩「无文件夹」（SCOPE-03），
  // 首页得说清下一步。判据是广播里的 dirs（服务端的已连接清单）：第一条广播到之前不知道，不显示——
  // 有文件夹的人在那一瞬间看到「还没有连接文件夹」比晚一拍出现更糟。配置了却全都找不到时 dirs 同样是空的，
  // 标题改说「找不到」（服务快照里的 missingFolders），原因与恢复办法在抽屉的「服务」小节。
  function syncDashNoFolders() {
    const box = messagesEl.querySelector('[data-testid="dash-no-folders"]');
    if (!box) return;
    box.classList.toggle('hidden', projectsState.connectedCount() !== 0);
    box.querySelector('[data-dash-no-folders-title]').textContent = getLatestServiceHealth()?.missingFolders > 0
      ? t('已连接的文件夹都找不到了') : t('还没有连接文件夹');
    // 手机上改不了清单（来源是环境变量 / 外置文件、或没有配置文件）：不给一个走完选择面板才报错的按钮，直接说为什么
    const readonly = projectsState.foldersReadonly();
    box.querySelector('[data-testid="dash-pick-folder"]').classList.toggle('hidden', Boolean(readonly));
    const why = box.querySelector('[data-testid="dash-folders-readonly"]');
    why.textContent = readonly ? folderReasonText(readonly) : '';
    why.classList.toggle('hidden', !readonly);
  }

  return { dismissBlockedSurfaceIfTarget, ensureEmptySurface, enterComposeReady, leaveComposeReady, refreshComposeDefaultsSummary, renderWorktreeChips, showComposeSurface, showDashboard, showInstanceDestroyedSurface, showSessionBlockedSurface, syncComposerVisibility, syncDashNoFolders, syncTopContextLabel, syncTopContextPillAriaLabel, syncTopContextPillVisibility };
}
