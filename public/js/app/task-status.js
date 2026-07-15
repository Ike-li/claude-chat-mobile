import { formatApiRetryBanner, taskStopUiState } from '../logic.js';

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
  const tasks = new Map();
  let activeTaskId = null;
  let apiRetryActive = false;

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
    dom.taskProgressList = createElement('<div id="taskProgressList" class="mt-1 space-y-0.5 hidden" data-testid="bg-task-list"></div>');
    dom.taskProgressBanner.appendChild(dom.taskProgressList);
    return dom.taskProgressList;
  }

  function syncStopButton() {
    if (!dom.btnTaskStop) return;
    const ui = taskStopUiState({
      taskId: activeTaskId,
      bannerVisible: dom.taskProgressBanner && !dom.taskProgressBanner.classList.contains('hidden'),
    });
    dom.btnTaskStop.classList.toggle('hidden', !ui.canStop);
    dom.btnTaskStop.disabled = !ui.canStop;
  }

  function showProgress(text) {
    if (!dom.taskProgressBanner || !dom.taskProgressText) return;
    const prefix = tasks.size > 1 ? `(${tasks.size}) ` : '';
    dom.taskProgressText.textContent = prefix + (text.length > 72 ? `${text.slice(0, 69)}...` : text);
    dom.taskProgressBanner.classList.remove('hidden');
    syncStopButton();
  }

  function hideProgress() {
    dom.taskProgressBanner?.classList.add('hidden');
    activeTaskId = null;
    tasks.clear();
    const list = taskList();
    if (list) {
      list.replaceChildren();
      list.classList.add('hidden');
    }
    syncStopButton();
  }

  function stopTask(taskId, message) {
    haptic('tap');
    context.socket?.emit('task:stop', { instanceId: context.state.viewingInstanceId, taskId });
    addBar(message, 'text-ink-faint');
  }

  function renderTaskList() {
    const list = taskList();
    if (!list) return;
    list.replaceChildren();
    if (tasks.size <= 1) {
      list.classList.add('hidden');
      return;
    }
    list.classList.remove('hidden');
    for (const [taskId, task] of tasks) {
      const row = createElement('<div class="flex items-center gap-2 text-[11px]"></div>');
      const label = createElement('<span class="truncate flex-1 min-w-0 text-ink-soft"></span>');
      label.textContent = (task.message || taskId).slice(0, 60);
      const stop = createElement('<button type="button" class="shrink-0 px-1.5 py-0.5 rounded border border-warning text-warning" data-testid="bg-task-stop">停</button>');
      stop.onclick = () => stopTask(taskId, `已请求停止后台任务 ${taskId.slice(0, 8)}…`);
      row.append(label, stop);
      list.appendChild(row);
    }
  }

  function onProgress(event) {
    if (event.instanceId && event.instanceId !== context.state.viewingInstanceId) return false;
    const message = event.payload?.message || '';
    const taskId = event.payload?.taskId;
    if (typeof taskId === 'string' && taskId) {
      activeTaskId = taskId;
      tasks.set(taskId, { message, taskType: event.payload?.taskType || null });
    }
    if (message) showProgress(message);
    renderTaskList();
    return true;
  }

  function onComplete(event) {
    const payload = event.payload || {};
    const failed = payload.status === 'failed' || payload.status === 'error';
    notify(
      failed ? '🔔 后台任务失败' : '🔔 后台任务完成',
      (payload.summary || 'Claude 即将汇报结果').slice(0, 80),
      { force: alerts?.preferences?.().foregroundComplete },
    );
    if (event.instanceId !== context.state.viewingInstanceId) return false;

    const taskId = payload.taskId;
    if (typeof taskId === 'string' && taskId && tasks.has(taskId)) {
      tasks.delete(taskId);
      if (activeTaskId === taskId) activeTaskId = tasks.size ? [...tasks.keys()].pop() : null;
      if (tasks.size === 0) hideProgress();
      else {
        const latest = tasks.get(activeTaskId);
        if (latest?.message) showProgress(latest.message);
        renderTaskList();
      }
    } else {
      hideProgress();
    }
    alertCue(failed ? 'warning' : 'success');
    if (payload.source === 'user_injection') {
      addBar('🔔 后台任务完成，Claude 正在汇报结果…', 'text-info');
    } else {
      const tail = payload.summary ? `：${payload.summary}` : '';
      addBar(`🔔 后台任务${failed ? '失败' : '完成'}${tail}`, failed ? 'text-danger' : 'text-info');
    }
    return true;
  }

  function bind() {
    dom.btnTaskStop?.addEventListener('click', () => {
      const ui = taskStopUiState({
        taskId: activeTaskId,
        bannerVisible: dom.taskProgressBanner && !dom.taskProgressBanner.classList.contains('hidden'),
      });
      if (ui.canStop) stopTask(ui.taskId, '已请求停止后台任务…');
    });
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
