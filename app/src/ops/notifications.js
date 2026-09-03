// notifications.js —— 事件 → 通知的纯逻辑层（渠道无关文案 + 渠道元数据），从组装根 src/server/app.js 抽出便于单测。
// 传输层在 src/ops/notify-channels.js：createNotifyChannels 返回的 pushNotify（Web Push）与 ntfyNotify（ntfy）。
import { setCapped } from '../shared/bounded-map.js';

// notificationForEvent 返回 { title, body, data? }：
//   · body 最小化（SEC-04，见 docs/hard-rules.md）：不含命令/参数/问题正文/summary——尤其 ntfy 明文经第三方；正文回 app 内经鉴权取。
//   · title 追加 cwdBase（已决：默认显示，不设隐藏配置项）——仅目录尾段（basename），
//     非完整路径，帮多工作区场景分辨通知来自哪个项目；无 cwd（如未绑定实例）时不追加，向后兼容不带 cwd 的旧调用。
//   · title 再追加 sessionTitle（抽屉可见的短标题）——同一项目常有多条会话，光有目录名横幅仍分不清；
//     占位「新会话」/「(无标题)」不加。会话标题是身份不是正文，进 title 不进最小化 body。
//   · data 仅在传入 instanceId 时附带（{instanceId, sessionId, cwd}）——供深链回该会话。Web Push 的 data 走 RFC 8291
//     端到端加密（push service 不见明文、不上锁屏），故保留完整 cwd 供深链；ntfy click 深链则不含完整 cwd（见 ntfyMetaFor）。
//   · 不传 instanceId 时不含 data 键（向后兼容旧调用与单测的 deepEqual）。
// hasClients = 当前是否有客户端 socket 连着：
//   · result 仅在【无人连】（用户离线）时推——连着的客户端自己看得到，避免重复；
//   · permission_request / question / task_notification 无条件推——用户可能锁屏或切到别的 app。
//
// task_notification = 后台任务（Workflow / 后台 Agent / 后台 Bash）完成信号（对齐 permission/question 的无条件推）。
// ⑧ 推送内容预览：previewBody 前 120 字截断（OS 通知栏本就单行/两行显示，不需要更多），超出加 …。
const PREVIEW_BODY_CAP = 120;
function truncatePreview(text) {
  const s = String(text ?? '');
  return s.length > PREVIEW_BODY_CAP ? `${s.slice(0, PREVIEW_BODY_CAP)}…` : s;
}

// PWA 后台推送修复：approved 房间"连着"不等于"看得见"——PWA 切后台后 socket 常常还没断（要等 OS
// 冻结页面才真正断连），这段窗口期内若仍把 hasClients 判 true，会把 result 完成通知永久吞掉（用户反馈
// "切后台收不到完成通知，感觉应用像消失了"的根因）。客户端在 visibilitychange/pagehide/连接成功时上报
// client:presence，服务端记在 socket.data.hidden（见 app.js on(socket,'client:presence',…)）；本函数
// 据此判定 approved 房间里是否还有"前台"连接。保守默认：未上报过 presence（data.hidden===undefined，
// 如刚连接尚未来得及上报、或未来的旧版前端）一律视为前台——最坏情况只是退回现状（该连接不解锁推送），
// 不会因误判后台而重复轰炸用户。
// 锁屏/通知栏一行很窄：会话标题截到 40 字（与 sessions.upsertSession 的 title 上限同款），换行压成空格。
export const NOTIFY_SESSION_TITLE_CAP = 40;
// 'New session' 是 i18n.js:321 给「新会话」的英文译文 —— 前端把标题翻译过再传上来，
// 只认中文那份等于对英文界面的用户失效（推送里出现「✅ 完成 · proj · New session」这种假标题）。
// 这三个值必须与 public/js/logic/session-search.js 的同名集合逐字相等，由
// tests/unit/cross-side-parity.test.mjs 的对照闸守着。
const NOTIFY_TITLE_PLACEHOLDERS = new Set(['新会话', '(无标题)', 'New session']);

export function sanitizeNotifySessionTitle(raw) {
  if (typeof raw !== 'string') return '';
  const one = raw.replace(/\s+/g, ' ').trim();
  if (!one || NOTIFY_TITLE_PLACEHOLDERS.has(one)) return '';
  return one.length > NOTIFY_SESSION_TITLE_CAP ? `${one.slice(0, NOTIFY_SESSION_TITLE_CAP)}…` : one;
}

// 项目名 = 路径尾段。**不用 node:path 的 basename**，两个实测到的形态它都答错：
//   · basename('/') === ''（不是 '/'），而外层 `if (cwd)` 判 '/' 为 truthy 放行
//     → 推出「✅ 任务完成 ·  · 改个bug」的空段，正是下面那行注释声称要避免的东西；
//   · basename('C:\\code\\proj') 在 POSIX 上返回整串（不认反斜杠）→ 整条 Windows 路径进横幅。
// 与 public/js/logic/session-search.js 的 projectFromCwd 逐字同源。它本身不 export，
// 由 cross-side-parity 的 formatNotifyIdentity 用例间接盯着（'/' 与 'C:\\code\\proj' 两行）。
function projectFromCwd(cwd) {
  const s = String(cwd || '').replace(/[/\\]+$/, '');
  if (!s) return '';
  return s.split(/[/\\]/).pop() || '';
}

// 横幅身份：事件 · 项目 · 会话。缺哪段跳过哪段，避免「✅ 任务完成 · ·」这种空段。
export function formatNotifyIdentity(eventTitle, { cwd, sessionTitle } = {}) {
  const parts = [];
  if (eventTitle) parts.push(eventTitle);
  const proj = projectFromCwd(cwd);
  if (proj) parts.push(proj);
  const sess = sanitizeNotifySessionTitle(sessionTitle);
  if (sess) parts.push(sess);
  return parts.join(' · ');
}

// result / gateway_stall 在节流那一刻用 hasClients 决定「该不该推」；peek 标题可能耗掉几百 ms，
// 发出前必须用现场值——人已经回到前台就不再推。permission/question/task 无条件推，保持快照。
export function notifyHasClientsAtSend(type, snapshotHasClients, liveHasClients) {
  if (type === 'result' || type === 'system') return liveHasClients === true;
  return snapshotHasClients === true;
}

export function hasForegroundApprovedClient(sockets = []) {
  for (const s of sockets) {
    if (s?.data?.hidden !== true) return true;
  }
  return false;
}

export function notificationForEvent(type, payload = {}, opts = {}) {
  const { hasClients = false, instanceId, sessionId, cwd, sessionTitle } = opts;
  const p = payload || {};
  const withData = (base) => (instanceId ? { ...base, data: { instanceId, sessionId, cwd } } : base);
  const titleWithIdentity = (title) => formatNotifyIdentity(title, { cwd, sessionTitle });
  switch (type) {
    case 'result':
      if (hasClients) return null;
      // 对齐 CLI：interrupt 终态 result 即使 is_error/ede_diagnostic，也是「已中止」不是「出错」
      // 无 previewBody：result 本身只是轮次终态元数据（耗时/costUsd/isError），没有可预览的正文内容
      // ——真正的对话内容在 assistant 的 text_delta 流里，不在这个事件上。
      {
        const secs = ((p.durationMs ?? 0) / 1000).toFixed(1);
        const title = p.interrupted ? '⏹ 任务已中止' : (p.isError ? '⚠️ 任务出错' : '✅ 任务完成');
        return withData({ title: titleWithIdentity(title), body: `用时 ${secs}s` });
      }
    case 'permission_request': {
      // body 最小化（SEC-04）：只保留工具名，【不含 input 命令/参数正文】；待批操作回 app 内经鉴权查看。
      // previewBody：用户主动开启预览时才用（见 notify-channels.js pushNotify 按订阅 prefs 选择）。
      const inputStr = p.input && typeof p.input === 'object' ? JSON.stringify(p.input) : '';
      const previewBody = truncatePreview(inputStr ? `${p.name ?? '工具'} · ${inputStr}` : (p.name ?? '工具'));
      return withData({
        title: titleWithIdentity('⚠️ Claude 请求许可'),
        body: `需要你授权：${p.name ?? '工具'}`,
        previewBody
      });
    }
    case 'question':
      // 最小化：不含问题正文（消息正文），固定引导文案；正文回 app 内取。
      return withData({
        title: titleWithIdentity('❓ Claude 有问题'),
        body: 'Claude 需要你的回答',
        previewBody: truncatePreview(p.text)
      });
    case 'task_notification': {
      // 最小化：不含 summary 正文（可能含代码/结果），固定引导文案；成功/失败见 title。
      const failed = p.status === 'failed' || p.status === 'error';
      return withData({
        title: titleWithIdentity(failed ? '⚠️ 后台任务失败' : '✅ 后台任务完成'),
        body: failed ? '后台任务未成功，点开查看' : '后台任务已完成，点开查看',
        previewBody: truncatePreview(p.summary)
      });
    }
    case 'system': {
      // 仅网关静默告警推送（agent.js checkIdle 的 gateway_stall notice，结构化字段识别、不匹配文案）；
      // 其余 system（普通 notice / 已中断回执等）是纯流内提示，从不出推送。2026-08-18 排查背景：
      // 「模型已 N 秒无响应」此前只落消息流，锁屏/离开时全程不可见，用户只见 spinner 干转不知何故。
      // 抑制口径同 result：前台正看着本会话时流内告警条已可见，推送只服务锁屏/离开场景。
      if (p.kind !== 'notice' || p.notice !== 'gateway_stall') return null;
      if (hasClients) return null;
      // body 无会话正文（SEC-04 天然满足），也不给 previewBody——预览开关是为会话正文设的旁路，
      // 这里没有可预览物。秒数畸形/缺失时退化为通用文案，绝不渲染 NaN。
      const secs = Number(p.seconds);
      const head = Number.isFinite(secs) && secs > 0 ? `已 ${Math.round(secs)} 秒无响应，` : '';
      return withData({
        title: titleWithIdentity('⏳ 模型长时间无响应'),
        body: `${head}仍在等待；持续无消息将自动中断`,
      });
    }
    default:
      return null;
  }
}

// PWA「后台运行中」低优先级提示：presence 从"approved 房间还有前台连接"跳变为"再无前台连接"、且此刻
// 确有实例在跑（busy）时才该推——弥补"切后台锁屏看不到应用还活着"的部分反馈（硬边界见 app.js 调用点
// 注释：做不到锁屏常驻实时指示，只是任务仍在跑时补一条"别担心，跑完会通知你"）。纯函数、无副作用：
// 调用方（src/server/app.js on(socket,'client:presence',…)）在真正 mutate socket.data.hidden 前后
// 各调一次 hasForegroundApprovedClient 喂 hadForeground/hasForeground。天然节流：同一 socket 重复上报
// hidden:true，或其他事件重触发本判定但状态未变，hadForeground 在第二次判定前已经是 false（该 socket
// 上一次上报已被计入"非前台"），跳变条件不会再次成立——不需要额外的节流状态机/计时器。
export function shouldNotifyBackgroundRunning({ hadForeground, hasForeground, hasBusyInstance } = {}) {
  return hadForeground === true && hasForeground === false && hasBusyInstance === true;
}

// 「后台运行中」提示文案：与 notificationForEvent 分列为独立函数——触发源是 client:presence 状态跳变，
// 不是某个 agent:event，混进 notificationForEvent 的 switch 会让"type 对应真实 envelope 类型"这条隐含
// 契约变模糊（NOTIFY_CATEGORY 也是按 envelope type 键的，这条不属于任何 envelope type）。
// body 同样最小化（SEC-04）：不含会话内容/工具名，只提示"仍在运行、跑完会通知你"。
export function notificationForBackgroundRunning({ instanceId, sessionId, cwd, sessionTitle } = {}) {
  const title = formatNotifyIdentity('⏳ 任务仍在后台运行', { cwd, sessionTitle });
  const body = '运行结束后会通知你';
  return instanceId ? { title, body, data: { instanceId, sessionId, cwd } } : { title, body };
}

// 终端直跑会话（CLI hooks 桥）的通知：与 notificationForEvent 分开，因为它按 envelope type 键控，
// 而 hook 事件不是 agent:event。body 同样最小化（SEC-04）：不含正文，只说发生了什么。
// data（深链）仅在该会话恰好有 live 实例时带——纯外部终端会话没有 instanceId，如实降级为无深链
// （点开落首页），不编一个点不开的链接。
export function notificationForCliHook(hookEventName, { cwd, sessionId, instanceId, sessionTitle } = {}) {
  let eventTitle;
  if (hookEventName === 'Stop') eventTitle = '✅ 终端会话完成一轮';
  else if (hookEventName === 'Notification') eventTitle = '⚠️ 终端会话需要你';
  else return null;
  const title = formatNotifyIdentity(eventTitle, { cwd, sessionTitle });
  const body = hookEventName === 'Stop' ? '电脑上的 claude 跑完了这一轮' : '电脑上的 claude 在等你回应';
  const base = { title, body };
  return instanceId ? { ...base, data: { instanceId, sessionId, cwd } } : base;
}

// 新设备请求接入的推送文案：与 notificationForEvent 分列——触发源是 socket 握手那一刻
// （io.use 里 addPendingDevice），不是任何 agent:event envelope，混进按 type 键控的 switch
// 会让「type 对应真实 envelope 类型」这条隐含契约变模糊（同 notificationForCliHook）。
//
// SEC-04 在这里比别处更硬：deviceId / ip / userAgent 恰恰是审批时要核对的三项，而推送是明文
// 通道（ntfy 还经第三方）。所以本函数【只解构 count】——多余字段结构上就取不到，不是靠"记得别放"。
// 也不给 previewBody：「推送内容预览」开关是为会话正文设的，不该成为设备标识漏进明文的旁路。
//
// 不带 data：设备审批不属于任何会话，深链无处可去；点开落首页即可看到待审卡片。
export function notificationForDeviceRequest({ count = 1 } = {}) {
  const n = Number.isFinite(count) && count > 1 ? Math.floor(count) : 1;
  return {
    title: '🔐 新设备请求接入',
    body: n > 1 ? `${n} 台设备正在等待批准，回 app 内确认` : '有新设备想要接入，回 app 内确认',
  };
}

// ── per-会话推送节流（"不重复轰炸同一会话"的另一半）──
// 两层规则：①同一会话同一类别已有未决通知（未被 clearNotifyPending 清除）不重复推——
// approval/input 需要"被处理"（request_resolved）才算未决解除；finished（result/task_notification）
// 是一次性终态通知，没有"被处理"这个动作，只受②约束。②同类事件最小间隔（默认 60s）内抑制，
// 防止连续多次触发瞬间炸出好几条。纯函数、状态外置：调用方持有 Map<sessionId, {[category]:{notifiedAt,pending}}>。
export const NOTIFY_CATEGORY = Object.freeze({
  permission_request: 'approval',
  question: 'input',
  result: 'finished',
  task_notification: 'finished',
  // system 型信封只有 gateway_stall notice 会产出通知（见 notificationForEvent），故此映射只被静默
  // 告警消费。stall 无「被处理」动作 → throttleNotify 里归入 pending:false 一侧，只受最小间隔约束。
  system: 'stall',
});

// 设备审批推送的节流键与窗口。key 借用 throttleNotify 的 per-会话状态机，但它并不是会话——
// 用一个真实 sessionId（UUID）永不碰撞的哨兵串。category 刻意用 'device' 而非 'approval'：
// 后者会置 pending，而清 pending 的三条审批路径里有一条（CLI 改 trusted-devices.json，由
// device-gate.js 的文件监听器处理）根本够不到 app.js 持有的节流状态——用了未决语义，从 CLI
// 批准之后这条状态就永远解不开，之后真有新设备也不再推。
// 窗口比会话类通知长得多（5min vs 60s）：「有设备在等你批准」没有回合完成那样的时效性，
// 每分钟提醒一次纯属打扰；反过来跨窗口再提醒一次是好事，用户可能错过了第一条。
export const DEVICE_NOTIFY_KEY = '__devices__';
export const DEVICE_NOTIFY_INTERVAL_MS = 300000;

// 静默告警（stall 类别）的专用节流窗。告警源在坏天气下每 90–120s 一条（2026-08-17 真机 4d4443ce
// 一轮 24 连发），套 60s 通用窗≈每条都推；10min 窗把最坏情况压到每轮个位数，同时保留「还卡着」
// 这个事实的跨窗口再提醒（同 DEVICE 的取舍：跨窗口重提是好事，用户可能错过了第一条）。
export const STALL_NOTIFY_INTERVAL_MS = 600000;

// 有界窗口（同 message-dedup DEDUP_CAP / interaction-log MAX_SESSIONS 的 always-on 有界纪律）：
// per-会话节流态在常驻进程里长跑不应无限增长；超上限按插入序丢最旧会话（正常单用户远不及此，
// 真触发时被丢的必是早已 resolved 的老会话，最坏后果 = 那个老会话下次通知少一次节流抑制）。
export const NOTIFY_THROTTLE_CAP = 500;

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
  // 有界：新增会话推到尾部，超上限删头部最旧（Map 保插入序）；已存在会话 set 不改位置、size 不变、不触发。
  setCapped(next, sessionId, { ...sessionState, [category]: { notifiedAt: now, pending: category === 'approval' || category === 'input' } }, NOTIFY_THROTTLE_CAP);
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
  background_running: ['hourglass_flowing_sand'],
  // CLI hooks 桥：Stop=完成；Notification=需要你（不得误用 result 的 checkmark + priority 3，J3）
  cli_hook_stop: ['white_check_mark'],
  cli_hook_notification: ['warning', 'bell'],
  device_request: ['closed_lock_with_key'],
  // system 型只有 gateway_stall 告警会走到推送（见 notificationForEvent）：等待语义，非紧急
  // （10 分钟自动中断兜底在，无需用户即时响应，priority 保持默认 3）。
  system: ['hourglass_flowing_sand'],
};
export function ntfyMetaFor(type, data = {}, publicUrl = '') {
  const priority = (
    type === 'permission_request'
    || type === 'question'
    || type === 'cli_hook_notification'
    || type === 'device_request' // 用户不处理，那台新设备就一直用不了——同属"需即时响应"
  ) ? 5 : 3;
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
// 投递失败原因 → 一行短语，供服务状态面板/抽屉的「🔔 推送最近失败」行下钻。
//
// 【为什么要清洗，不能直接吐 message】web-push 的网络错误 message 里内嵌完整 endpoint
// （"request to https://fcm.googleapis.com/fcm/send/<token> failed, …"），而 endpoint 就是推送
// 凭证——拿到它的人能给这台设备发任意通知。它出现在 UI 上、日志里、截图里都算泄露。
// 含 URL 的 message 整条丢弃而不是正则剔 URL：剔完剩下的「failed, reason: connect ETIMEDOUT」
// 也没比 'network error' 多说什么，而正则漏一个变体就是凭证外泄，不对称。
// 优先级 statusCode > code > 纯文本 message：前两者短、稳定、无敏感信息，且正是定位问题要看的那一维
// （HTTP 401=VAPID 配错，HTTP 502/ETIMEDOUT=网络不通）。
export function describeDeliveryError(err) {
  if (!err || typeof err !== 'object') return 'unknown';
  if (typeof err.statusCode === 'number') return `HTTP ${err.statusCode}`;
  if (err.code) return String(err.code);
  const msg = String(err.message ?? '').trim();
  if (!msg) return 'unknown';
  if (/https?:\/\//.test(msg)) return 'network error';
  return msg.length > 60 ? `${msg.slice(0, 60)}…` : msg;
}

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
