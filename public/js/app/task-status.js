import { bgTaskListCollapsed, formatProgressHistoryEntry, isSyntheticTaskId, taskDetailState, taskStopUiState } from '../logic/bg-tasks.js';
import { formatBgTaskRowLabel } from '../logic/tool-cards.js';
import { t } from '../i18n.js';

export function createTaskStatusController(context, {
  addBar = () => {},
  alertCue = () => {},
  alerts = null,
  autoBind = true,
  createElement = null,
  haptic = () => {},
  notify = () => {},
} = {}) {
  const dom = context.dom;
  /** @type {Map<string, { message: string, taskType: string|null, lastToolName?: string|null, description?: string|null, subagentType?: string|null }>} */
  const tasks = new Map();
  let activeTaskId = null;
  // 多任务列表折叠时的用户表态：null=未表态（按阈值走默认折叠）；瞬态，横幅撤下（hideProgress）即重置。
  let userExpanded = null;
  // 详情面板：累积 task_progress 历史 + 当前展开的任务
  /** @type {Map<string, Array<{ts: number, description: string, lastToolName: string|null, summary: string|null}>>} */
  const progressHistory = new Map();
  const HISTORY_CAP = 20; // 每任务最多保留 20 条历史
  let activeDetailId = null;

  // 活动横幅只服务子 agent/Workflow 启动。API 重试**不**走这里——它已迁到流内状态行
  // （app.js liveLine.retry，对齐 CLI 的整行顶替）；旧实现与这里共用 DOM，既会互相摧毁文案，
  // 又被 reconcileBanners 的 task 优先级必现压掉。
  function showActivity(description) {
    if (!dom.activityBanner || !dom.activityBannerText) return;
    const text = String(description || '');
    dom.activityBannerText.textContent = text.length > 80 ? `${text.slice(0, 77)}...` : text;
    dom.activityBanner.classList.remove('hidden');
  }

  function hideActivity() {
    dom.activityBanner?.classList.add('hidden');
  }

  // 唯一的滚动容器：详情已内联进任务卡片，若列表不封顶，6 个任务 × 20 条历史会把 composer footer
  // 撑到吃满整屏（#messages 是 flex-1 overflow-y-auto，最小尺寸算 0，挡不住）。上限放这一层、
  // 卡片内不再套第二层滚动，避免移动端嵌套滚动抢手势。
  function taskList() {
    if (dom.taskProgressList) return dom.taskProgressList;
    if (!createElement || !dom.taskProgressBanner) return null;
    dom.taskProgressList = createElement('<div id="taskProgressList" class="mt-1.5 space-y-1 max-h-[45vh] overflow-y-auto overscroll-contain hidden" data-testid="bg-task-list"></div>');
    dom.taskProgressBanner.appendChild(dom.taskProgressList);
    return dom.taskProgressList;
  }

  function syncStopButton() {
    if (!dom.btnTaskStop) return;
    // 多任务时每行自带「停」；主按钮只在单任务时显示（停当前 active）
    const multi = tasks.size > 1;
    const ui = taskStopUiState({
      taskId: activeTaskId,
      bannerVisible: dom.taskProgressBanner && !dom.taskProgressBanner.classList.contains('hidden'),
    });
    const show = ui.canStop && !multi;
    dom.btnTaskStop.classList.toggle('hidden', !show);
    dom.btnTaskStop.disabled = !ui.canStop;
  }

  function showBanner() {
    if (!dom.taskProgressBanner || !dom.taskProgressText) return;
    const n = tasks.size;
    // 固定标签「后台任务」在 HTML；这里只写数量/状态，明细全在列表行
    if (n <= 0) {
      dom.taskProgressText.textContent = '';
      return;
    }
    dom.taskProgressText.textContent = n > 1 ? `${n} ${t('个运行中')}` : t('运行中');
    dom.taskProgressBanner.classList.remove('hidden');
    syncStopButton();
  }

  function hideProgress() {
    dom.taskProgressBanner?.classList.add('hidden');
    activeTaskId = null;
    userExpanded = null;
    tasks.clear();
    progressHistory.clear();
    activeDetailId = null;
    const list = taskList();
    if (list) {
      list.replaceChildren();
      list.classList.add('hidden');
    }
    syncBannerToggle(true);
    syncStopButton();
  }

  // tasks 收缩后（单个任务完成删除，或全量快照重建）同步清理 progressHistory：否则已消失任务的历史
  // 会一直留到「全部任务清零」才被 hideProgress 整体清空，长会话里持续有任务在跑会无界累积。
  // 详情正显示的任务若恰好消失，一并撤掉 activeDetailId——DOM 由随后的 renderTaskList 跟随。
  function pruneStaleProgressHistory() {
    for (const id of progressHistory.keys()) {
      if (!tasks.has(id)) progressHistory.delete(id);
    }
    if (activeDetailId && !tasks.has(activeDetailId)) activeDetailId = null;
  }

  // 折叠热区是整条横幅头行（#taskBannerToggle），恒可见、恒可点——不再有单独的 ▸/▾ 三角按钮，
  // 也不再按任务数隐藏它（单任务同样可折叠）。这里只同步无障碍状态。
  function syncBannerToggle(collapsed) {
    dom.taskBannerToggle?.setAttribute('aria-expanded', String(!collapsed));
  }

  function toggleTaskList() {
    const collapsed = bgTaskListCollapsed({ count: tasks.size, userExpanded });
    userExpanded = collapsed; // 翻转：当前收起 → 用户表态为「要展开」；当前展开 → 用户表态为「要收起」
    renderTaskList();
  }

  function stopTask(taskId, message) {
    haptic('tap');
    // instanceId 在【渲染时】就该定住而不是点击时才读：切视图后 A 的任务行仍留在 DOM（clearView 有意
    // 不清任务横幅），此时点「停」会把 A 的 taskId 发到 B 上。这里保持读当前值，但至少让失败可见 ——
    // 服务端 stopTask 返回 false（任务已结束 / control_request 超时）时不再谎报成功。
    let settled = false;
    const done = ok => {
      if (settled) return;
      settled = true;
      if (ok) addBar(message, 'text-ink-faint');
      // tw-config.js 定义的是 warning，没有 warn —— text-warn 是个不存在的类，渲染成默认字色。
      else addBar(t('停止请求未生效：任务可能已结束'), 'text-warning');
    };
    context.socket?.emit('task:stop', { instanceId: context.state.viewingInstanceId, taskId }, res => done(res?.ok === true));
    // 兜底：不回 ack 的旧服务端/mock 下保持原有「已请求停止」文案，不因缺 ack 变成误报失败
    setTimeout(() => done(true), 1500);
  }

  function renderTaskList() {
    const list = taskList();
    if (!list) return;
    // list 是滚动容器：replaceChildren 会把 scrollTop 归零，心跳重绘时先存后还，否则每拍跳回顶部。
    const prevScroll = list.scrollTop;
    list.replaceChildren();
    if (tasks.size === 0) {
      list.classList.add('hidden');
      syncBannerToggle(true);
      return;
    }
    // 单任务默认展开（给一行详情，标题只写「运行中」避免复读）；多任务默认折叠。两种情况下行都照常
    // 渲染供折叠态下的测试断言与即时展开使用，仅用 hidden 类控制可见性。
    const collapsed = bgTaskListCollapsed({ count: tasks.size, userExpanded });
    list.classList.toggle('hidden', collapsed);
    syncBannerToggle(collapsed);
    for (const [taskId, task] of tasks) {
      const histLen = (progressHistory.get(taskId) || []).length;
      const isActive = taskDetailState({ taskId, activeDetailId }).visible;
      // 卡片承载边框，data-testid="bg-task-row" 留在**高度恒定**的头行上：详情展开后卡片变高，
      // 若把 testid 挂到卡片上，点击（打元素中心点）会落进详情区，"再点一次收起"永远不触发。
      // 详情作为头行的兄弟而非后代，点它也不会冒泡回头行——不需要 stopPropagation。
      // 配色只用无 alpha 的语义 token：tw-config 把颜色映射为裸 var(--x)，`/NN` 修饰符生成不出 utility。
      const card = createElement(`<div class="rounded-lg border ${isActive ? 'border-warning' : 'border-line-soft'} bg-sunk overflow-hidden"></div>`);
      const row = createElement('<div class="px-2 py-1.5 cursor-pointer select-none" data-testid="bg-task-row"></div>');
      const top = createElement('<div class="flex items-center gap-2 text-[11px]"></div>');
      const label = createElement('<span class="truncate flex-1 min-w-0 text-ink font-medium"></span>');
      const title = formatBgTaskRowLabel({
        taskType: task.taskType,
        message: task.message,
        taskId,
      });
      const histTag = histLen > 0 ? ` · ${histLen}条` : '';
      label.textContent = `${title.slice(0, 72 - histTag.length)}${histTag}`;
      label.title = task.message || taskId;
      // 行「停」与横幅主钮共用同一策略：此前这里【无条件】挂按钮并 stopTask(taskId)，绕开了
      // taskStopUiState——多子代理时每行都可点，而 localcmd:* 在 SDK 侧根本没有这个 id，点了必然
      // 静默失败，前端还会乐观地打一条「已请求停止」（2026-08-05 review #2）。
      const rowStop = taskStopUiState({ taskId, bannerVisible: true });
      if (rowStop.canStop) {
        const stop = createElement('<button type="button" class="shrink-0 px-1.5 py-0.5 rounded border border-warning text-warning" data-testid="bg-task-stop">停</button>');
        stop.onclick = (e) => { e.stopPropagation(); stopTask(taskId, `${t('已请求停止后台任务')} ${String(taskId).slice(0, 8)}…`); };
        top.append(label, stop);
      } else {
        top.append(label);
      }

      const metaParts = [];
      if (task.lastToolName) metaParts.push(`${t('工具')} ${task.lastToolName}`);
      if (task.subagentType && !(task.message || '').includes(String(task.subagentType))) {
        metaParts.push(String(task.subagentType));
      }
      // 合成命名空间不进 meta：同 formatBgTaskRowLabel 的回落，用统一判据（review #7）
      const shortId = typeof taskId === 'string' && !isSyntheticTaskId(taskId)
        ? taskId.slice(0, 10)
        : '';
      if (shortId) metaParts.push(`#${shortId}`);
      if (metaParts.length) {
        const meta = createElement('<div class="text-[10px] text-ink-faint mt-0.5 truncate"></div>');
        meta.textContent = metaParts.join(' · ');
        meta.title = metaParts.join(' · ');
        row.append(top, meta);
      } else {
        row.append(top);
      }
      // 点击行文本区域 → 展开/收起该任务自己的详情
      row.addEventListener('click', () => toggleDetail(taskId));
      card.appendChild(row);
      if (isActive) {
        const panel = buildDetailPanel(taskId);
        if (panel) card.appendChild(panel);
      }
      list.appendChild(card);
    }
    list.scrollTop = prevScroll;
  }

  // ---- 详情面板：累积 task_progress 历史，点击任务行展开 ----

  function recordProgress(taskId, payload) {
    if (!taskId) return;
    const desc = payload?.description || payload?.message || '';
    const summary = payload?.summary || null;
    const tool = payload?.lastToolName || payload?.last_tool_name || null;
    // 无实质内容不记录（防空白行）
    if (!desc && !summary) return;
    // 去重：连续相同 description+summary 不重复记录
    const hist = progressHistory.get(taskId) || [];
    const last = hist[hist.length - 1];
    if (last && last.description === desc && last.summary === summary) return;
    hist.push({ ts: Date.now(), description: desc, lastToolName: tool, summary });
    if (hist.length > HISTORY_CAP) hist.splice(0, hist.length - HISTORY_CAP);
    progressHistory.set(taskId, hist);
  }

  function toggleDetail(taskId) {
    const expanding = activeDetailId !== taskId; // 再次点击同任务 → 收起
    activeDetailId = expanding ? taskId : null;
    renderTaskList();
    // 长列表里新展开的详情可能落在滚动视口外，带它进视野（真实 DOM 才有这两个 API）
    if (expanding) taskList()?.querySelector?.('[data-testid="task-detail-panel"]')?.scrollIntoView?.({ block: 'nearest' });
  }

  // 详情块：该任务的进度历史，作为头行的兄弟渲染在同一张卡片内（共用卡片边框，border-t 作分隔线）。
  // 历史为空返回 null（不渲染空框），activeDetailId 保留——下一拍心跳有内容了自然显示出来。
  function buildDetailPanel(taskId) {
    const hist = progressHistory.get(taskId) || [];
    if (hist.length === 0) return null;
    const panel = createElement('<div class="border-t border-line-soft px-2 py-1.5 space-y-1.5 text-[11px] cursor-default" data-testid="task-detail-panel"></div>');
    for (const entry of hist) {
      const { time, text, hasSummary } = formatProgressHistoryEntry(entry);
      const row = createElement('<div class="flex items-start gap-2" data-testid="task-detail-entry"></div>');
      const ts = createElement('<span class="text-[10px] text-ink-faint shrink-0 tabular-nums w-12 text-right"></span>');
      ts.textContent = time;
      const icon = createElement(`<span class="shrink-0">${hasSummary ? '✦' : '▸'}</span>`);
      const body = createElement('<span class="flex-1 min-w-0 text-ink-soft break-words"></span>');
      body.textContent = text;
      row.append(ts, icon, body);
      panel.appendChild(row);
    }
    return panel;
  }

  function applyTasksFromPayload(payload) {
    const list = Array.isArray(payload?.tasks) ? payload.tasks : null;
    if (list) {
      // 权威全量快照（task_progress / background_tasks_changed 经后端 emitBgTasksSnapshot）
      tasks.clear();
      for (const item of list) {
        const id = item?.taskId ?? item?.task_id;
        if (typeof id !== 'string' || !id) continue;
        tasks.set(id, {
          message: item.message || item.description || '',
          taskType: item.taskType ?? item.task_type ?? null,
          lastToolName: item.lastToolName ?? item.last_tool_name ?? null,
          description: item.description ?? null,
          subagentType: item.subagentType ?? item.subagent_type ?? null,
          truncated: item.truncated || false,
        });
      }
      if (typeof payload.taskId === 'string' && payload.taskId && tasks.has(payload.taskId)) {
        activeTaskId = payload.taskId;
      } else {
        activeTaskId = tasks.size ? [...tasks.keys()][0] : null;
      }
      return true;
    }
    // 兼容旧单条 upsert（无 tasks 数组）
    const taskId = payload?.taskId;
    const message = payload?.message || '';
    if (typeof taskId === 'string' && taskId) {
      activeTaskId = taskId;
      const prev = tasks.get(taskId) || {};
      tasks.set(taskId, {
        message: message || prev.message || '',
        taskType: payload?.taskType ?? prev.taskType ?? null,
        lastToolName: payload?.lastToolName ?? prev.lastToolName ?? null,
        description: payload?.description ?? prev.description ?? null,
        subagentType: payload?.subagentType ?? prev.subagentType ?? null,
        truncated: payload?.truncated || prev.truncated || false,
      });
      return true;
    }
    return false;
  }

  function onProgress(event) {
    if (event.instanceId && event.instanceId !== context.state.viewingInstanceId) return false;
    const payload = event.payload || {};
    // 累积进度历史（全量快照中的主任务 + 单条 payload）
    if (Array.isArray(payload.tasks)) {
      for (const item of payload.tasks) recordProgress(item?.taskId ?? item?.task_id, item);
    }
    recordProgress(payload.taskId, payload);
    applyTasksFromPayload(payload);
    pruneStaleProgressHistory();
    if (tasks.size === 0) {
      hideProgress();
      return true;
    }
    // 详情已内联进卡片，renderTaskList 一并重绘正在查看的那份历史，无需第二条刷新路径
    showBanner();
    renderTaskList();
    return true;
  }

  function onComplete(event) {
    const payload = event.payload || {};
    const failed = payload.status === 'failed' || payload.status === 'error';
    notify(
      failed ? t('🔔 后台任务失败') : t('🔔 后台任务完成'),
      (payload.summary || t('Claude 即将汇报结果')).slice(0, 80),
      { force: alerts?.preferences?.().foregroundComplete },
    );
    if (event.instanceId !== context.state.viewingInstanceId) return false;

    const taskId = payload.taskId;
    if (typeof taskId === 'string' && taskId && tasks.has(taskId)) {
      tasks.delete(taskId);
      pruneStaleProgressHistory();
      if (activeTaskId === taskId) activeTaskId = tasks.size ? [...tasks.keys()][0] : null;
      if (tasks.size === 0) hideProgress();
      else {
        showBanner();
        renderTaskList();
      }
    } else if (Array.isArray(payload.tasks)) {
      applyTasksFromPayload(payload);
      pruneStaleProgressHistory();
      if (tasks.size === 0) hideProgress();
      else {
        showBanner();
        renderTaskList();
      }
    } else if (typeof taskId === 'string' && taskId) {
      // 有明确 id 但不在前端表：对齐服务端 bgTaskDone「id 不在表 → no-op」。
      // 旧逻辑走 else hideProgress 会把仍在跑的横幅整清（快任务未心跳、id 不一致、TTL 后迟到通知）。
      // 完成条/通知仍照常写，只不动进度横幅。
    } else {
      // 无 taskId（null/undefined）或畸形：与服务端「真无 id 才整清兜底」对称，撤横幅。
      hideProgress();
    }
    alertCue(failed ? 'warning' : 'success');
    if (payload.source === 'user_injection') {
      addBar(t('🔔 后台任务完成，Claude 正在汇报结果…'), 'text-info');
    } else {
      const tail = payload.summary ? `：${payload.summary}` : '';
      addBar(`${failed ? t('🔔 后台任务失败') : t('🔔 后台任务完成')}${tail}`, failed ? 'text-danger' : 'text-info');
    }
    return true;
  }

  function bind() {
    dom.btnTaskStop?.addEventListener('click', () => {
      const ui = taskStopUiState({
        taskId: activeTaskId,
        bannerVisible: dom.taskProgressBanner && !dom.taskProgressBanner.classList.contains('hidden'),
      });
      if (ui.canStop) stopTask(ui.taskId, t('已请求停止后台任务…'));
    });
    // 折叠热区 = 横幅头行（不含右侧「停止」按钮，两者是兄弟元素）。用结构而非 stopPropagation 隔离：
    // stopPropagation 挡不住 keydown（焦点在「停止」上按 Enter 会同时停任务 + 折叠），且 role="button"
    // 是 Children Presentational，套住 <button> 会让辅助技术读不到「停止」。
    dom.taskBannerToggle?.addEventListener('click', () => toggleTaskList());
    dom.taskBannerToggle?.addEventListener('keydown', (ev) => {
      if (ev?.key !== 'Enter' && ev?.key !== ' ') return;
      ev.preventDefault?.();
      toggleTaskList();
    });
  }

  if (autoBind) bind();
  return {
    hideActivity,
    hideProgress,
    onComplete,
    onProgress,
    showActivity,
  };
}
