import { bgTaskListCollapsed, formatApiRetryBanner, formatBgTaskRowLabel, taskStopUiState } from '../logic.js';
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
    const list = taskList();
    if (list) {
      list.replaceChildren();
      list.classList.add('hidden');
    }
    dom.btnTaskToggle?.classList.add('hidden');
    syncStopButton();
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
      const row = createElement('<div class="rounded-lg border border-warning/25 bg-warning/5 px-2 py-1.5" data-testid="bg-task-row"></div>');
      const top = createElement('<div class="flex items-center gap-2 text-[11px]"></div>');
      const label = createElement('<span class="truncate flex-1 min-w-0 text-ink font-medium"></span>');
      const title = formatBgTaskRowLabel({
        taskType: task.taskType,
        message: task.message,
        taskId,
      });
      label.textContent = title.slice(0, 72);
      label.title = task.message || taskId;
      const stop = createElement('<button type="button" class="shrink-0 px-1.5 py-0.5 rounded border border-warning text-warning" data-testid="bg-task-stop">停</button>');
      stop.onclick = () => stopTask(taskId, `${t('已请求停止后台任务')} ${String(taskId).slice(0, 8)}…`);
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
      list.appendChild(row);
    }
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
    applyTasksFromPayload(payload);
    if (tasks.size === 0) {
      hideProgress();
      return true;
    }
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
    } else {
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
