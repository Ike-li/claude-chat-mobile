// notifications.js —— 事件 → 离线 web-push 文案的纯映射（从 server.js onEvent 抽出，便于单测；
// 传输层仍是 server.js 的 pushNotify）。返回 { title, body } 表示应推送、null 表示该事件不推。
//
// hasClients = 当前是否有客户端 socket 连着：
//   · result 仅在【无人连】（用户离线）时推——连着的客户端自己看得到，避免重复；
//   · permission_request / question / task_notification 无条件推——用户可能锁屏或切到别的 app。
//
// task_notification = 后台任务（Workflow / 后台 Agent / 后台 Bash）完成信号。此前 server.js 漏推，
// 导致「web 端发起后台任务、锁屏后完成收不到通知」；本映射补齐（对齐 permission/question 的无条件推）。
export function notificationForEvent(type, payload = {}, { hasClients = false } = {}) {
  const p = payload || {};
  switch (type) {
    case 'result':
      if (hasClients) return null;
      return {
        title: p.isError ? '⚠️ 任务出错' : '✅ 任务完成',
        body: `用时 ${((p.durationMs ?? 0) / 1000).toFixed(1)}s`
      };
    case 'permission_request':
      return {
        title: '⚠️ Claude 请求许可',
        body: `${p.name ?? '工具'}：${JSON.stringify(p.input ?? {}).slice(0, 80)}`
      };
    case 'question':
      return {
        title: '❓ Claude 有问题',
        body: (p.text ?? '').slice(0, 100) || 'Claude 需要你的回答'
      };
    case 'task_notification': {
      const failed = p.status === 'failed' || p.status === 'error';
      return {
        title: failed ? '⚠️ 后台任务失败' : '✅ 后台任务完成',
        body: p.summary || 'Claude 即将汇报结果'
      };
    }
    default:
      return null;
  }
}
