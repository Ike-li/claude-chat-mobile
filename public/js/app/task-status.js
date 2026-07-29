import { bgTaskListCollapsed, formatApiRetryBanner, formatBgTaskRowLabel, formatProgressHistoryEntry, taskStopUiState } from '../logic.js';
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
  let apiRetryActive = false;
  // 多任务列表折叠时的用户表态：null=未表态（按阈值走默认折叠）；瞬态，横幅撤下（hideProgress）即重置。
  let userExpanded = null;
  // 详情面板：累积 task_progress 历史 + 当前展开的任务
  /** @type {Map<string, Array<{ts: number, description: string, lastToolName: string|null, summary: string|null}>>} */
  const progressHistory = new Map();
  const HISTORY_CAP = 20; // 每任务最多保留 20 条历史
  let activeDetailId = null;

  function showActivity(description) {
    if (!dom.activityBanner || !dom.activityBannerText) return;
    apiRetryActive = false;
    const text = String(description || '');
    dom.activityBannerText.textContent = text.length > 80 ? `${text.slice(0, 77)}...` : text;
    dom.activityBanner.classList.remove('hidden');
  }

  function hideActivity() {
    apiRetryActive = false;
    dom.activityBanner?.classList.add('hidden');
  }

  function showApiRetry(text) {
    if (!dom.activityBanner || !dom.activityBannerText) return;
    apiRetryActive = true;
    dom.activityBannerText.textContent = text.length > 80 ? `${text.slice(0, 77)}...` : text;
    dom.activityBanner.classList.remove('hidden');
  }

  function clearApiRetry() {
    if (apiRetryActive) hideActivity();
  }

  function onApiRetry(event) {
    if (event.instanceId && event.instanceId !== context.state.viewingInstanceId) return false;
    showApiRetry(formatApiRetryBanner(event.payload || {}));
    return true;
  }

  function taskList() {
    if (dom.taskProgressList) return dom.taskProgressList;
    if (!createElement || !dom.taskProgressBanner) return null;
    dom.taskProgressList = createElement('<div id="taskProgressList" class="mt-1.5 space-y-1 hidden" data-testid="bg-task-list"></div>');
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
    dom.btnTaskToggle?.classList.add('hidden');
    hideDetail();
    syncStopButton();
  }

  function hideDetail() {
    if (dom.taskDetailPanel) dom.taskDetailPanel.classList.add('hidden');
    if (dom.taskDetailContent) dom.taskDetailContent.replaceChildren();
  }

  function syncToggleButton(collapsed) {
    if (!dom.btnTaskToggle) return;
    dom.btnTaskToggle.classList.toggle('hidden', tasks.size <= 1);
    dom.btnTaskToggle.setAttribute('aria-expanded', String(!collapsed));
    dom.btnTaskToggle.textContent = collapsed ? '▸' : '▾';
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
      else addBar(t('停止请求未生效：任务可能已结束'), 'text-warn');
    };
    context.socket?.emit('task:stop', { instanceId: context.state.viewingInstanceId, taskId }, res => done(res?.ok === true));
    // 兜底：不回 ack 的旧服务端/mock 下保持原有「已请求停止」文案，不因缺 ack 变成误报失败
    setTimeout(() => done(true), 1500);
  }

  function renderTaskList() {
    const list = taskList();
    if (!list) return;
    list.replaceChildren();
    if (tasks.size === 0) {
      list.classList.add('hidden');
      syncToggleButton(true);
      return;
    }
    // 单任务恒展开（给一行详情，标题只写「运行中」避免复读）；多任务默认折叠，行照常渲染供折叠态下的
    // 测试断言与即时展开使用，仅用 hidden 类控制可见性。
    const collapsed = bgTaskListCollapsed({ count: tasks.size, userExpanded });
    list.classList.toggle('hidden', collapsed);
    syncToggleButton(collapsed);
    for (const [taskId, task] of tasks) {
      const histLen = (progressHistory.get(taskId) || []).length;
      const isActive = taskId === activeDetailId;
      const row = createElement(`<div class="rounded-lg border border-warning/25 bg-warning/5 px-2 py-1.5 cursor-pointer${isActive ? ' ring-1 ring-warning/50' : ''}" data-testid="bg-task-row"></div>`);
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
      const stop = createElement('<button type="button" class="shrink-0 px-1.5 py-0.5 rounded border border-warning text-warning" data-testid="bg-task-stop">停</button>');
      stop.onclick = (e) => { e.stopPropagation(); stopTask(taskId, `${t('已请求停止后台任务')} ${String(taskId).slice(0, 8)}…`); };
      top.append(label, stop);

      const metaParts = [];
      if (task.lastToolName) metaParts.push(`${t('工具')} ${task.lastToolName}`);
      if (task.subagentType && !(task.message || '').includes(String(task.subagentType))) {
        metaParts.push(String(task.subagentType));
      }
      const shortId = typeof taskId === 'string' && !taskId.startsWith('__notask_')
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
      // 点击行文本区域 → 展开/收起详情面板
      row.addEventListener('click', () => toggleDetail(taskId));
      list.appendChild(row);
    }
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
    if (activeDetailId === taskId) {
      // 再次点击同任务 → 收起
      activeDetailId = null;
      hideDetail();
    } else {
      activeDetailId = taskId;
      renderDetail(taskId);
    }
    // 刷新行高亮态
    renderTaskList();
  }

  function renderDetail(taskId) {
    if (!dom.taskDetailPanel || !dom.taskDetailContent) return;
    const hist = progressHistory.get(taskId) || [];
    if (hist.length === 0) {
      hideDetail();
      return;
    }
    dom.taskDetailContent.replaceChildren();
    for (const entry of hist) {
      const { time, text, hasSummary } = formatProgressHistoryEntry(entry);
      const row = createElement('<div class="flex items-start gap-2"></div>');
      const ts = createElement('<span class="text-[10px] text-ink-faint shrink-0 tabular-nums w-12 text-right"></span>');
      ts.textContent = time;
      const icon = createElement(`<span class="shrink-0">${hasSummary ? '✦' : '▸'}</span>`);
      const body = createElement('<span class="flex-1 min-w-0 text-ink-soft break-words"></span>');
      body.textContent = text;
      row.append(ts, icon, body);
      dom.taskDetailContent.appendChild(row);
    }
    dom.taskDetailPanel.classList.remove('hidden');
    // 新条目到达时自动滚动到底部
    dom.taskDetailContent.scrollTop = dom.taskDetailContent.scrollHeight;
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
    if (tasks.size === 0) {
      hideProgress();
      return true;
    }
    showBanner();
    renderTaskList();
    // 详情面板正在查看的任务有新进度时自动刷新
    if (activeDetailId && progressHistory.has(activeDetailId)) {
      renderDetail(activeDetailId);
    }
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
      if (activeTaskId === taskId) activeTaskId = tasks.size ? [...tasks.keys()][0] : null;
      if (tasks.size === 0) hideProgress();
      else {
        showBanner();
        renderTaskList();
      }
    } else if (Array.isArray(payload.tasks)) {
      applyTasksFromPayload(payload);
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
    dom.btnTaskToggle?.addEventListener('click', () => toggleTaskList());
  }

  if (autoBind) bind();
  return {
    clearApiRetry,
    hideActivity,
    hideProgress,
    onApiRetry,
    onComplete,
    onProgress,
    showActivity,
  };
}
