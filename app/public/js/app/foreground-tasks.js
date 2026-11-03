// app/foreground-tasks.js —— 把在跑的前台命令 / 子代理转到后台（#459），对应终端 Ctrl+B。
//
// 服务端每当实例的前台任务集合变化就发一份全量 foreground_tasks（瞬时，切回 / 重连由 sync:since 补推）。
// 集合非空时：
//   · 输入条停止键旁出「转后台」—— task:background 不带 toolUseId，等于 Ctrl+B，全部转后台；
//   · 对得上 toolUseId、还在跑的工具卡上出「后台运行」—— 只转这一条。
// 成功不做乐观更新：CLI 随后发 task_updated / background_tasks_changed，前台集合清掉、后台任务横幅接住，
// 工具卡也会收到「running in the background」的结果。失败把原因写进消息流（logic 的 backgroundTasksErrorText）。
// 快照按实例存：foreground_tasks 走 outOfBand，不经视图过滤，后台实例的也会到。

import { t } from '../i18n.js';
import { normalizeForegroundTasks, backgroundTasksErrorText } from '../logic.js';

// 服务端套的是控制请求超时（10s）；这里多留一截，免得服务端还在等、前端先报了失败
const ACK_TIMEOUT_MS = 15_000;

export function createForegroundTasks(context, {
  $: byId,
  socket,
  getViewingInstanceId,
  getToolCard,
  addBar = () => {},
} = {}) {
  const byInstance = new Map(); // instanceId → [{ taskId, toolUseId }]
  const cardButtons = new Map(); // toolUseId → 卡上的「后台运行」按钮
  const composerBtn = byId('btnBackgroundTasks');

  function send(toolUseId, btn) {
    const instanceId = getViewingInstanceId();
    if (!instanceId) return;
    btn.disabled = true;
    socket.timeout(ACK_TIMEOUT_MS).emit('task:background', { instanceId, ...(toolUseId ? { toolUseId } : {}) }, (err, res) => {
      btn.disabled = false;
      const text = err ? t('转后台无响应，请稍后再试') : backgroundTasksErrorText(res);
      if (text) addBar(text, 'text-danger');
    });
  }

  function cardButton(toolUseId) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'shrink-0 ml-auto px-2 py-0.5 rounded-lg border border-line text-ink-soft bg-surface active:bg-sunk disabled:opacity-50';
    btn.textContent = t('后台运行');
    btn.title = t('只把这一条转到后台，本轮继续');
    btn.dataset.testid = 'tool-background';
    // 按钮挂在 <summary> 里。Chromium 下激活目标是按钮本身，卡片不会跟着展开（P0-17r 去掉这行也绿）；
    // WebKit 没实测，preventDefault 留作保险
    btn.addEventListener('click', e => { e.preventDefault(); send(toolUseId, btn); });
    return btn;
  }

  function render() {
    const tasks = byInstance.get(getViewingInstanceId()) || [];
    composerBtn?.classList.toggle('hidden', tasks.length === 0);
    const want = new Set(tasks.map(task => task.toolUseId).filter(Boolean));
    for (const [id, btn] of cardButtons) {
      if (want.has(id) && btn.isConnected) continue;
      btn.remove();
      cardButtons.delete(id);
    }
    for (const id of want) {
      if (cardButtons.has(id)) continue;
      // 通用工具卡的 summary 与子代理合卡的标题行都以 .t-status 打头，挂在它所在的那一行末尾
      const row = getToolCard(id)?.querySelector('.t-status')?.parentElement;
      if (!row) continue;
      const btn = cardButton(id);
      row.appendChild(btn);
      cardButtons.set(id, btn);
    }
  }

  function onEvent(ev) {
    const instanceId = ev?.instanceId;
    if (!instanceId) return;
    const tasks = normalizeForegroundTasks(ev.payload?.tasks);
    if (tasks.length) byInstance.set(instanceId, tasks);
    else byInstance.delete(instanceId);
    render();
  }

  if (composerBtn) composerBtn.addEventListener('click', () => send(null, composerBtn));

  const controller = { onEvent, render };
  context.state.foregroundTasks = controller;
  return controller;
}
