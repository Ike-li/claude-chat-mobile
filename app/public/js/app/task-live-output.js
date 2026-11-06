// app/task-live-output.js —— 运行中后台命令的输出，对齐终端 /tasks 详情页。
//
// 只在有人看的时候拉：任务行展开才开始，收起、任务结束、页面不可见都停，回到前台立刻补一次。
// 上一次没回来不发下一次，服务端卡住时不会叠请求。
// 看得好好的时候一次失败不清屏：限流重试期间控制请求会超时，这时把输出换成报错没有意义，下一拍通常就好了。

import { formatTaskOutput } from '../logic.js';

const POLL_MS = 3000;
// 服务端套的是控制请求超时（10s）；这里多留一截，免得服务端还在等、前端先报了失败
const ACK_TIMEOUT_MS = 15_000;

export function createTaskLiveOutput(context, { documentRef = globalThis.document, onChange = () => {} } = {}) {
  /** @type {{ taskId: string, instanceId: string, display: string|null, inFlight: boolean, timer: any }|null} */
  let watched = null;

  const visible = () => documentRef?.visibilityState !== 'hidden';

  function poll(w) {
    if (w !== watched || w.inFlight || !visible() || !context.socket) return;
    w.inFlight = true;
    context.socket.timeout(ACK_TIMEOUT_MS).emit('task:output', { instanceId: w.instanceId, taskId: w.taskId }, (err, res) => {
      w.inFlight = false;
      if (w !== watched) return;
      const good = !err && res?.ok;
      if (good || w.display === null) {
        const next = formatTaskOutput(err ? null : res);
        if (next !== w.display) {
          w.display = next;
          onChange();
        }
      }
      w.timer = setTimeout(() => poll(w), POLL_MS);
    });
  }

  // 传 null 停。同一个任务重复调用无副作用：renderTaskList 每拍都会调。
  // instanceId 在这一刻定住：切视图后这张卡片仍留在 DOM，轮询时才读会把 A 的 taskId 发到 B。
  function watch(taskId) {
    if ((watched?.taskId ?? null) === (taskId ?? null)) return;
    watched = taskId ? { taskId, instanceId: context.state.viewingInstanceId, display: null, inFlight: false, timer: null } : null;
    if (watched) poll(watched);
  }

  documentRef?.addEventListener?.('visibilitychange', () => {
    if (!watched) return;
    clearTimeout(watched.timer);
    poll(watched);
  });

  return {
    watch,
    isWatching: taskId => watched?.taskId === taskId,
    display: () => watched?.display ?? null,
  };
}
