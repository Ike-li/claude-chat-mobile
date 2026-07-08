// notifications.js —— 事件 → 通知的纯逻辑层（渠道无关文案 + 渠道元数据），从 server.js 抽出便于单测。
// 传输层仍在 server.js：pushNotify（Web Push）与 ntfyNotify（ntfy）。
//
// notificationForEvent 返回 { title, body, data? }：
//   · data 仅在传入 instanceId 时附带（{instanceId, sessionId, cwd}）——供 push/ntfy 点击深链回该会话（②）。
//   · 不传 instanceId 时不含 data 键（向后兼容旧调用与单测的 deepEqual）。
// hasClients = 当前是否有客户端 socket 连着：
//   · result 仅在【无人连】（用户离线）时推——连着的客户端自己看得到，避免重复；
//   · permission_request / question / task_notification 无条件推——用户可能锁屏或切到别的 app。
//
// task_notification = 后台任务（Workflow / 后台 Agent / 后台 Bash）完成信号（对齐 permission/question 的无条件推）。
export function notificationForEvent(type, payload = {}, opts = {}) {
  const { hasClients = false, instanceId, sessionId, cwd } = opts;
  const p = payload || {};
  const withData = (base) => (instanceId ? { ...base, data: { instanceId, sessionId, cwd } } : base);
  switch (type) {
    case 'result':
      if (hasClients) return null;
      return withData({
        title: p.isError ? '⚠️ 任务出错' : '✅ 任务完成',
        body: `用时 ${((p.durationMs ?? 0) / 1000).toFixed(1)}s`
      });
    case 'permission_request':
      return withData({
        title: '⚠️ Claude 请求许可',
        body: `${p.name ?? '工具'}：${JSON.stringify(p.input ?? {}).slice(0, 80)}`
      });
    case 'question':
      return withData({
        title: '❓ Claude 有问题',
        body: (p.text ?? '').slice(0, 100) || 'Claude 需要你的回答'
      });
    case 'task_notification': {
      const failed = p.status === 'failed' || p.status === 'error';
      return withData({
        title: failed ? '⚠️ 后台任务失败' : '✅ 后台任务完成',
        body: p.summary || 'Claude 即将汇报结果'
      });
    }
    default:
      return null;
  }
}

// ②2b：ntfy 渠道元数据（优先级 / 标签 / 深链 click）。与文案分离，保持 notificationForEvent 渠道无关。
//   priority：需用户即时响应的（许可 / 提问）→ 5（urgent），其余 → 3（default）。
//   click：仅在有 publicUrl 且有 instanceId 时给——点通知直接深链回该实例会话（#instance=…&session=…&cwd=…）。
const NTFY_TAGS = {
  permission_request: ['warning'],
  question: ['question'],
  result: ['white_check_mark'],
  task_notification: ['robot'],
};
export function ntfyMetaFor(type, data = {}, publicUrl = '') {
  const priority = (type === 'permission_request' || type === 'question') ? 5 : 3;
  const tags = NTFY_TAGS[type] || [];
  let click;
  if (publicUrl && data && data.instanceId) {
    const q = new URLSearchParams();
    q.set('instance', data.instanceId);
    if (data.sessionId) q.set('session', data.sessionId);
    if (data.cwd) q.set('cwd', data.cwd);
    click = `${publicUrl.replace(/\/+$/, '')}/#${q.toString()}`;
  }
  return { priority, tags, click };
}

// ②2b：构造 ntfy 发布请求（POST JSON 到 ntfy server 根 URL，topic 在 body 内）。
// 纯函数不发网络（便于单测）；用 JSON body 而非 HTTP header 传 title，避开中文标题的 header 编码问题。
export function ntfyRequestInit({ url, topic, token }, title, body, meta = {}) {
  const payload = { topic, title, message: body };
  if (meta.tags && meta.tags.length) payload.tags = meta.tags;
  if (meta.priority) payload.priority = meta.priority;
  if (meta.click) payload.click = meta.click;
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return { url, init: { method: 'POST', headers, body: JSON.stringify(payload) } };
}
