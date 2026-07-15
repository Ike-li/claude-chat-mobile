// notifications.js —— 事件 → 通知的纯逻辑层（渠道无关文案 + 渠道元数据），从 server.js 抽出便于单测。
// 传输层仍在 server.js：pushNotify（Web Push）与 ntfyNotify（ntfy）。
import { basename } from 'node:path';

// notificationForEvent 返回 { title, body, data? }：
//   · body 最小化（SEC-04 / docs/design.md）：不含命令/参数/问题正文/summary——尤其 ntfy 明文经第三方；正文回 app 内经鉴权取。
//   · title 追加 cwdBase（docs/design.md NotifPayload/OQ-08 已决：默认显示，不设隐藏配置项）——仅目录尾段（basename），
//     非完整路径，帮多工作区场景分辨通知来自哪个项目；无 cwd（如未绑定实例）时不追加，向后兼容不带 cwd 的旧调用。
//   · data 仅在传入 instanceId 时附带（{instanceId, sessionId, cwd}）——供深链回该会话。Web Push 的 data 走 RFC 8291
//     端到端加密（push service 不见明文、不上锁屏），故保留完整 cwd 供深链；ntfy click 深链则不含完整 cwd（见 ntfyMetaFor）。
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
  const titleWithCwd = (title) => (cwd ? `${title} · ${basename(cwd)}` : title);
  switch (type) {
    case 'result':
      if (hasClients) return null;
      // 对齐 CLI：interrupt 终态 result 即使 is_error/ede_diagnostic，也是「已中止」不是「出错」
      {
        const secs = ((p.durationMs ?? 0) / 1000).toFixed(1);
        const title = p.interrupted ? '⏹ 任务已中止' : (p.isError ? '⚠️ 任务出错' : '✅ 任务完成');
        return withData({ title: titleWithCwd(title), body: `用时 ${secs}s` });
      }
    case 'permission_request':
      // 最小化（SEC-04）：body 只保留工具名，【不含 input 命令/参数正文】；待批操作回 app 内经鉴权查看。
      return withData({
        title: titleWithCwd('⚠️ Claude 请求许可'),
        body: `需要你授权：${p.name ?? '工具'}`
      });
    case 'question':
      // 最小化：不含问题正文（消息正文），固定引导文案；正文回 app 内取。
      return withData({
        title: titleWithCwd('❓ Claude 有问题'),
        body: 'Claude 需要你的回答'
      });
    case 'task_notification': {
      // 最小化：不含 summary 正文（可能含代码/结果），固定引导文案；成功/失败见 title。
      const failed = p.status === 'failed' || p.status === 'error';
      return withData({
        title: titleWithCwd(failed ? '⚠️ 后台任务失败' : '✅ 后台任务完成'),
        body: failed ? '后台任务未成功，点开查看' : '后台任务已完成，点开查看'
      });
    }
    default:
      return null;
  }
}

// ── per-会话推送节流（docs/design.md TriggerPolicy，承接 FR-14"不重复轰炸同一会话"的另一半）──
// 两层规则：①同一会话同一类别已有未决通知（未被 clearNotifyPending 清除）不重复推——
// approval/input 需要"被处理"（request_resolved）才算未决解除；finished（result/task_notification）
// 是一次性终态通知，没有"被处理"这个动作，只受②约束。②同类事件最小间隔（默认 60s）内抑制，
// 防止连续多次触发瞬间炸出好几条。纯函数、状态外置（EP-2）：调用方持有 Map<sessionId, {[category]:{notifiedAt,pending}}>。
export const NOTIFY_CATEGORY = Object.freeze({
  permission_request: 'approval',
  question: 'input',
  result: 'finished',
  task_notification: 'finished',
});

export function throttleNotify(sessionId, category, now, state = new Map(), minIntervalMs = 60000) {
  if (!sessionId || !category) return { throttled: false, next: state }; // 保守：缺 key 时不误伤，不节流
  const sessionState = state.get(sessionId) || {};
  const entry = sessionState[category];
  if (entry) {
    if (entry.pending) return { throttled: true, next: state }; // 未决（approval/input 尚未被处理）→ 抑制
    if (now - entry.notifiedAt < minIntervalMs) return { throttled: true, next: state }; // 未到最小间隔 → 抑制
  }
  const next = new Map(state);
  // approval/input 有"被处理"动作、需要追踪未决；finished 是一次性通知，直接 pending:false（只受最小间隔约束）
  next.set(sessionId, { ...sessionState, [category]: { notifiedAt: now, pending: category === 'approval' || category === 'input' } });
  return { throttled: false, next };
}

// 审批/提问被处理（request_resolved）后调用，清除该会话对应类别的"未决"标记；不动 notifiedAt——
// 最小间隔计时不因"已处理"而重置，防止"批准后立刻又来一个新审批"瞬间绕开间隔节流。
export function clearNotifyPending(sessionId, category, state = new Map()) {
  const sessionState = state.get(sessionId);
  if (!sessionState || !sessionState[category]) return state;
  const next = new Map(state);
  next.set(sessionId, { ...sessionState, [category]: { ...sessionState[category], pending: false } });
  return next;
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
    // 【不把完整 cwd 放进 ntfy click 深链】——ntfy 明文经第三方（SEC-04）。深链靠 instance+session 定位；
    // 实例已失效时缺 cwd 降级为手选会话（session:switch 以 sessionId 为主键校验、cwd 仅路由辅助）。
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

// BE-014：Web Push 订阅结构校验（纯函数）。旧 HTTP handler `if (!req.body?.endpoint)` 只挡 falsy——
// truthy 非字符串 endpoint（数字/对象/数组）会先 savePushSubscription 落盘、再 `req.body.endpoint.slice()`
// 抛异常返回 500，畸形订阅从此常驻，后续 webpush.sendNotification 对它持续失败污染推送。调用方必须在
// 变更任何状态【之前】用本函数校验，非法即 400。
// 标准 PushSubscription.toJSON()：{ endpoint:<http(s) URL 字符串>, keys:{ p256dh, auth }, expirationTime? }；
// keys 为 web-push RFC 8291 加密所必需，缺失会让 sendNotification 抛错，故一并强制。
export function isValidPushSubscription(sub) {
  if (!sub || typeof sub !== 'object' || Array.isArray(sub)) return false;
  if (typeof sub.endpoint !== 'string' || sub.endpoint.length === 0) return false;
  if (!/^https?:\/\//.test(sub.endpoint)) return false; // 必须是 http(s) URL 端点（拦 javascript:/ftp: 等）
  const k = sub.keys;
  if (!k || typeof k !== 'object' || Array.isArray(k)) return false;
  if (typeof k.p256dh !== 'string' || k.p256dh.length === 0) return false;
  if (typeof k.auth !== 'string' || k.auth.length === 0) return false;
  return true;
}
