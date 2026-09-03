// logic/outbox-send.js —— 在线/离线发送 ack · 耐久 outbox · busy 态种子与广播绑定
//
// 红线（拆分后由每个子模块各自承担，原文与 logic.js barrel 同源）：
// 只做数据→数据，不得触碰 DOM / window / socket / 应用可变状态（会话、实例、连接态等）。
// 目的：让浏览器 import 与 tests/unit/logic-*.test.mjs（node:test）共用同一份逻辑，零构建。
// 唯一允许的宿主外 import 是 ../i18n.js（纯查表 + 一个语言开关，node 与浏览器行为一致）；
// 同层 logic/ 子模块之间可以互相 import，但不得成环（npm run check 的 import 边界守卫会拒）。
// 想再加 import 前先自问：新依赖能在裸 node 里被 import 且不碰宿主 API 吗？不能就别加。

import { t } from '../i18n.js';
import { formatCliDuration, pickTurnDoneVerb } from './bg-tasks.js';

// 在线 user:message 的 socket ack 决策（纯函数）。成功只清 in-flight；失败须清乐观 busy +
// 可见文案，并可恢复草稿（输入已被 send() 清空）。旧实现把 ack 当 clearSendInFlight 忽略 payload。
//
// dropBubble = 在线乐观气泡的去留。send() 那一刻气泡就上屏了，负 ack 必须决定命运：
// 留 ⟺ ok || requeue；撤 ⟺ 确定没发出去（文字已回填输入框），否则会留一颗永远转圈的气泡。
// 与 restoreDraft 分开：一个管消息流、一个管输入框，当前同值只是巧合。
export function presentOnlineSendAck(ack) {
  if (ack && ack.ok === true) {
    return {
      ok: true,
      clearBusy: false,
      restoreDraft: false,
      retryable: false,
      permanent: false,
      stale: false,
      requeue: false,
      dropBubble: false, // 留：等 user_message 按 clientMessageId 认领转正
      message: '',
    };
  }
  const error = (ack && typeof ack.error === 'string' && ack.error.trim())
    ? ack.error.trim()
    : t('发送失败');
  // 在途轮拒收（排队已移除）：被拒的是【这条新消息】，不是正在跑的那轮——
  // clearBusy 必须 false，否则会把在跑那轮的状态行/停止钮一起清掉；也不 requeue，
  // 自动重发等于把排队搬到客户端。文字回填输入框（send 已清空它）。
  if (ack?.busy === true) {
    return {
      ok: false,
      busy: true,
      clearBusy: false,
      restoreDraft: true,
      retryable: false,
      permanent: false,
      stale: false,
      requeue: false,
      dropBubble: true, // 撤：服务端没收下这条，文字已回填输入框
      message: error,
    };
  }
  const permanent = Boolean(ack?.permanent);
  const retryable = Boolean(ack?.retryable) || (!permanent && !ack?.stale);
  const stale = Boolean(ack?.stale);
  let message = error;
  if (error === 'stale_instance' || stale) {
    message = t('目标会话已关闭，请刷新后重发');
  } else if (!message.startsWith(t('发送')) && !message.includes(t('失败'))) {
    message = `${t('发送失败：')}${message}`;
  }
  // retryable 且非 permanent/stale → 入 outbox 自动重试（与离线路径对齐）；此时不回填草稿，避免与队列双份
  const requeue = retryable && !permanent && !stale;
  return {
    ok: false,
    clearBusy: true,
    restoreDraft: !requeue,
    retryable,
    permanent,
    stale,
    requeue,
    dropBubble: !requeue, // 进 outbox 的留给重发认领；permanent/stale 确定没发出去 → 撤
    message,
  };
}

// 在线发送 transport 层（socket.timeout err 或 ack）决策——与 presentOfflineResendAck 对齐。
// err 非空 = 超时/断连；无 err 时委托 presentOnlineSendAck。
export function presentOnlineSendTransport(err, ack) {
  if (err) {
    return {
      ok: false,
      clearBusy: true,
      restoreDraft: false,
      retryable: true,
      permanent: false,
      stale: false,
      requeue: true,
      dropBubble: false, // 留：进 outbox 自动重发，气泡上继续显示进度
      message: t('未确认送达，已排队重试'),
    };
  }
  return presentOnlineSendAck(ack);
}

// ---- 发送时序常量 ----
// 服务端从收到 user:message 到 pendingTurns++ 的耗时上界。主导项是 agent.js#send 里那次 setModel
// control_request：它打给一个刚 spawn、还没起来的 CLI，上限 interruptTimeoutMs=10s。这段窗口里
// instance-manager 的 stateOf() 恒返回 'idle'（判据就是 pendingTurns > 0），轮次「还没开始」。
//
// 这个数字是【多个】客户端判据的共同约束源——凡是要区分「轮次还没开跑」与「轮次已结束/没送达」
// 的地方，窗口都必须比它长。2026-08-26 之前传输超时与 busy 看门狗各写各的 5000，双双踩中：
// 前者把没送达判错（白刷「正在重发」横幅），后者把没结束判错（运行条中途消失）。
// 同一个根因被发现了两次，第二次靠独立审查才挖出来——所以现在它们同住一个模块并有序关系断言
// 钉住（tests/unit/logic-composer-primary.test.mjs 的「发送时序常量」describe）。
export const SERVER_PRE_TURN_UPPER_BOUND_MS = 10000;

// UI 兜底：到点解锁发送按钮，防 ack 真丢时按钮永久卡死。只管本端交互手感，不参与「是否送达」
// 的判定，所以可以（也应该）远短于下面那个——按钮早点能按，比让用户干等安全。
export const SEND_ACK_FALLBACK_MS = 5000;

// 传输判据：超时即认定「这条没送达」→ 进 outbox 自动重发。必须覆盖 SERVER_PRE_TURN_UPPER_BOUND_MS
// 之外，还要留出 resume 的时间——注意 RESUME 路径并非有界：openResumeInstance 是
// Promise.all([两次无超时的 transcript 尾读, Promise.race([ensureCliDefaults, 1200ms])])，
// 即 max(尾读IO, ≤1200ms)，只有 FRESH 分支才真的 ≤1200ms。
// 上界一侧受 engine.io 被动判死窗约束（默认 pingInterval 25s + pingTimeout 20s = 45s，本仓未覆盖
// 该默认）。真断线不必等满：socket.io 的 onclose→_clearAcks 会立刻用 Error 回调非 buffered 的 ack，
// 30s 只在 half-open 才真的付出。
// 已知不足：附件上传的传输时间也算在这个窗口里（计时从 emit 起算，早于连接检查），20MB 附件在
// 移动上行下可能超 30s → 仍会误判重发。要根治得把附件走 HTTP 分离出去，不在本轮范围。
export const SEND_ACK_TRANSPORT_MS = 30000;

// 离线重发窗：重发打的是同一个 user:message handler，同一段慢路径要再走一遍，故与上面同值
// （不变量断言钉住相等）。
export const OFFLINE_RESEND_ACK_MS = SEND_ACK_TRANSPORT_MS;

// ---- 发送 outbox（在线/离线统一耐久队列的纯决策）----
// 条目可序列化字段不含 bubbleEl；app.js 用 clientMessageId 回挂 DOM。
export const OUTBOX_MAX_ITEMS = 20;
export const OUTBOX_STORAGE_KEY = 'ccm-outbox-v1';

function serializeOutboxItem(item) {
  if (!item || typeof item !== 'object') return null;
  const clientMessageId = typeof item.clientMessageId === 'string' ? item.clientMessageId : '';
  if (!clientMessageId) return null;
  return {
    text: item.text == null ? '' : String(item.text),
    model: item.model == null ? null : item.model,
    attachments: Array.isArray(item.attachments) ? item.attachments : undefined,
    clientMessageId,
    instanceId: item.instanceId == null ? null : item.instanceId,
    cwd: item.cwd == null ? null : item.cwd,
  };
}

// 有界入队：超 maxItems 丢最旧。返回 { queue, dropped }。
export function planOutboxEnqueue(queue, item, { maxItems = OUTBOX_MAX_ITEMS } = {}) {
  const base = Array.isArray(queue) ? queue.slice() : [];
  const row = serializeOutboxItem(item);
  if (!row) return { queue: base, dropped: [] };
  // 同 clientMessageId 去重：后写覆盖前（重试路径可能重复 push）
  const without = base.filter(x => x?.clientMessageId !== row.clientMessageId);
  without.push({ ...row, ...(item.bubbleEl ? { bubbleEl: item.bubbleEl } : {}) });
  if (without.length <= maxItems) return { queue: without, dropped: [] };
  const overflow = without.length - maxItems;
  return { queue: without.slice(overflow), dropped: without.slice(0, overflow) };
}

export function parseDurableOutbox(raw) {
  if (raw == null || raw === '') return [];
  let data;
  try { data = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return []; }
  if (!Array.isArray(data)) return [];
  const out = [];
  for (const row of data) {
    const s = serializeOutboxItem(row);
    if (s) out.push(s);
  }
  return out;
}

export function dumpDurableOutbox(queue) {
  const items = (Array.isArray(queue) ? queue : [])
    .map(serializeOutboxItem)
    .filter(Boolean);
  return JSON.stringify(items);
}

// 离线队列单条重发 ack 决策（FE-NEW-001）。与在线不同：不恢复草稿（气泡已在消息流）、
// permanent 必停重试；timeout/err 与非 permanent 负 ack 一律 requeue。
// outcome: 'ok' | 'permanent' | 'requeue' | 'blocked'
// blocked = 撞上在途轮（排队已移除）：队列首条发出去就开跑，其后各条必被拒。继续 requeue 会空转成
// 客户端排队，故落终态由用户手动重发。与 permanent 的区别：blocked 稍后重发能成功，不是死信。
export function presentOfflineResendAck(err, ack) {
  if (!err && ack && ack.ok === true) {
    return { outcome: 'ok', permanent: false, requeue: false, clearBusyIfViewing: false, message: '' };
  }
  if (!err && ack && ack.ok === false && ack.busy === true) {
    const error = (typeof ack.error === 'string' && ack.error.trim()) ? ack.error.trim() : t('当前任务运行中，完成后可发送');
    return { outcome: 'blocked', permanent: false, requeue: false, clearBusyIfViewing: false, message: error };
  }
  // stale（目标实例已关闭）也是死信：服务端 fail-closed 的负 ack 只带 {stale:true}、【不带】permanent，
  // 落到下面的兜底 requeue 就成了「每次重连重发一遍、永不退场」。判据与在线路径 presentOnlineSendAck
  // 逐字对齐（error==='stale_instance' || ack.stale），并把裸协议串换成人话——用户看到的是提示不是错误码。
  if (!err && ack && ack.ok === false && (ack.stale === true || ack.error === 'stale_instance')) {
    return {
      outcome: 'permanent', permanent: true, requeue: false, clearBusyIfViewing: true,
      message: t('目标会话已关闭，请刷新后重发'),
    };
  }
  if (!err && ack && ack.ok === false && ack.permanent) {
    const error = (typeof ack.error === 'string' && ack.error.trim()) ? ack.error.trim() : t('发送失败');
    return { outcome: 'permanent', permanent: true, requeue: false, clearBusyIfViewing: true, message: error };
  }
  // 超时 / 可重试失败 / 畸形 ack
  return {
    outcome: 'requeue',
    permanent: false,
    requeue: true,
    clearBusyIfViewing: false,
    message: err ? t('未确认送达') : ((ack && typeof ack.error === 'string' && ack.error.trim()) || t('发送失败')),
  };
}

// 队列项是否发往当前视图——outbox 的唯一归属判据。此前 planOutboxDrainNotice /
// shouldBusyAfterOfflineBatch / app.js 的 targetsViewing 各写一份「逐字一致」的表达式，
// 任一处改动都会静默分叉（2026-08-05 outbox 三修的教训：两个函数注释都写「与对方对齐」，
// 而那一维从没对齐过）。合成一个函数后，"一致" 由语言保证，不再靠注释纪律。
//
// 两条判据分工：
// ① instanceId 非空 → 严格相等。同一工作区可并存多个会话，cwd 相同也不得改判。
// ② instanceId 为空（入队时实例还没开：新会话首发、或在线 ack 超时把首发消息推进 outbox）→
//    按 cwd 判。cwd 任一侧缺失/空串就判不属于，与服务端 shouldRejectOutboxLazyOpen 的 fail-closed
//    对齐（它同样拒 cwd.trim() === ''），不在 UI 上谎称它属于眼下这个会话。
//
//    ⚠️ 这是启发式，不是与服务端逐字等价的判据。服务端 fromOutbox 无 instanceId 时路由到
//    currentSessionForCwd(cwd)——那是该目录的【当前会话指针】，而不是「客户端正在看的实例」。
//    该指针会被 session:new / 空首页 compose 清掉，同一工作区也可能同时有多个会话。所以在
//    「一个工作区开了两个会话」或「离线期间 session:new 清过指针」时，这里判 true 而服务端可能
//    投给另一个会话。可达性窄（要 ≥2 个同目录会话，或离线 session:new），代价仅是文案归属标错，
//    故接受启发式而不引入 instances 列表依赖把纯函数复杂化。
export function outboxItemTargetsViewing(item, { viewingInstanceId = null, viewingCwd = null } = {}) {
  if (!item || typeof item !== 'object') return false;
  if (item.instanceId != null) return item.instanceId === viewingInstanceId;
  const itemCwd = typeof item.cwd === 'string' ? item.cwd.trim() : '';
  const viewCwd = typeof viewingCwd === 'string' ? viewingCwd.trim() : '';
  return itemCwd !== '' && viewCwd !== '' && itemCwd === viewCwd;
}

// 离线批处理后是否应 busy：仅当「仍有目标为当前 viewing 的重入队项」或「本批有 viewing 相关 ok 且
// 指望 result 清 busy」时保持 busy。FE-NEW-001：永久失败且无剩余 viewing 队列 → 必须 clear。
// remainingItems = 本批结束后仍在 offlineQueue 的项；viewingInstanceId 可为 null。
export function shouldBusyAfterOfflineBatch({ viewingInstanceId, viewingCwd = null, remainingItems = [], hadViewingOk = false } = {}) {
  // 首页（无 viewing 实例）恒不 busy：那里没有会话承载运行条，且 instances 广播里的 busy 看门狗
  // 被 `newViewing && newViewing === displayedInstanceId` 包着（app.js），newViewing 为 null 时整段
  // 跳过 ⇒ 此处一旦置上就没人清得掉，主按钮卡成「停止」直到下次 clearView。下面 hadViewingOk 那条
  // 早有同款 `viewingInstanceId != null` 前提，这里补齐 viewingPending 那一半（按 cwd 归属后才够得着）。
  if (viewingInstanceId == null) return false;
  const viewingPending = remainingItems.some(it => outboxItemTargetsViewing(it, { viewingInstanceId, viewingCwd }));
  if (viewingPending) return true;
  // 本批对当前 viewing 成功发出 → 短暂 busy 等 result（与在线一致）；非 viewing 成功不抬 busy
  if (hadViewingOk && viewingInstanceId != null) return true;
  return false;
}

// 重发横幅文案：addBar 无条件贴当前会话消息流（app.js 的 addBar 不带归属过滤），而队列项的目标
// 是【入队时刻】那个实例——两者不是一回事。不标注就会读成「这条排队消息在本会话发了」，
// 叠上服务端 sysTo 的「目标会话已关闭」（同样贴当前视图）尤其像串会话。
// 归属判据走 outboxItemTargetsViewing（与 shouldBusyAfterOfflineBatch / app.js 的 targetsViewing 同一份）。
export function planOutboxDrainNotice({ items = [], viewingInstanceId = null, viewingCwd = null } = {}) {
  const list = Array.isArray(items) ? items : [];
  const total = list.length;
  // 冷启动/刷新后 connect 即 drain（app.js 的 socket.on('connect')），而横幅在第一个 await 之前同步
  // 贴出 ⇒ 必早于本次连接的首帧 instances 广播，此刻两个视图变量都还是初值 null。归属判不出来时
  // 不标注：说「发往其它会话」和说「本会话」一样是编的。foreign 归 0 自然走下面不带标注的中性文案。
  const hasViewContext = viewingInstanceId != null || viewingCwd != null;
  const foreign = hasViewContext
    ? list.filter(it => !outboxItemTargetsViewing(it, { viewingInstanceId, viewingCwd })).length
    : 0;
  let text;
  if (foreign === 0) {
    text = `${t('正在重发离线发送队列中的')} ${total} ${t('条消息...')}`;
  } else if (foreign === total) {
    text = `${t('正在重发')} ${total} ${t('条离线消息（发往其它会话）...')}`;
  } else {
    text = `${t('正在重发离线发送队列中的')} ${total} ${t('条消息...')}${t('（其中 ')}${foreign}${t(' 条发往其它会话）')}`;
  }
  return { total, foreign, text };
}

// 通知预览安全截断（FE-NEW-002）：JSON.stringify(undefined) 是 undefined，.slice 会抛。
export function safeJsonPreview(value, maxLen = 80) {
  let s;
  try {
    if (value === undefined) s = 'null';
    else s = JSON.stringify(value);
    if (s === undefined) s = 'null'; // stringify 对 undefined 顶层返回 undefined
  } catch {
    s = '[unserializable]';
  }
  s = String(s);
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

// 切入已在跑的 live 实例时是否 seed busy（FE-NEW-004）。state 来自 instances[].state。
export function shouldSeedBusyFromInstanceState(state) {
  return state === 'busy' || state === 'permission';
}

// reload 清屏后运行态重种：state 优先取 ack 时刻 instances 广播的最新值（切回瞬间 turn
// 恰结束时入场 entry.state 是过期快照，直接用会 stale-busy）；广播查不到才回退入场快照。
export function shouldReseedBusyAfterReload({ instances = [], instanceId, entryState } = {}) {
  const live = instances.find(x => x?.instanceId === instanceId);
  return shouldSeedBusyFromInstanceState(live ? live.state : entryState);
}

// instances 广播（视图未变）→ 运行条单向对齐：只置 true、绝不置 false。
// bgActive===true 排除：纯后台任务期无 result 事件可释放，单向置 true 会卡死运行条
//（该期 UI 归 task_progress 横幅）；undefined（旧服务端/视觉 mock）视为无后台任务。
export function shouldBindBusyFromBroadcast({ state, bgActive } = {}) {
  if (bgActive === true) return false;
  return shouldSeedBusyFromInstanceState(state);
}

// 看门狗：上面单向对齐的代价——终止事件（result/error/interrupted）若被实例路由过滤丢弃或丢包，
// 本地 liveLine 会永久卡在 busy=true 空转（见 ccm 现场：会话已结束、spinner 仍在跑）。这里补另一半：
// 服务端 stateOf() 已把后台任务折进 'busy'（instance-manager.js），故此处只看 state 而非 bgActive——
// 真后台任务期 state 仍是 'busy'，不会被误清。
//
// 宽限期必须覆盖 SERVER_PRE_TURN_UPPER_BOUND_MS（见其声明处）：那段窗口里服务端 stateOf() 恒为
// 'idle'（pendingTurns 还是 0），而 broadcastInstances 在 server 有近三十个调用点——任何一个实例的
// 状态变动都会广播，撞进这段窗口就把本端正在跑的乐观 busy 判成「轮次已结束」，运行条和停止按钮
// 中途消失（2026-08-26 二轮审查发现；此前取 5000，短于 setModel 的 10s 上限）。
// 取值与传输窗同源：两者守的是同一段窗口。代价是终止事件真丢包时 spinner 多转到这个时长才被清掉
// ——但那只是多转几秒，而误清的后果是用户看不到停止按钮、中止不了正在跑的轮次，后者更糟。
export const BUSY_BROADCAST_CLEAR_GRACE_MS = SEND_ACK_TRANSPORT_MS;
export function shouldForceClearBusyFromBroadcast({ state, localBusy = false, turnStartTs = null, now = 0, graceMs = BUSY_BROADCAST_CLEAR_GRACE_MS } = {}) {
  if (!localBusy || shouldSeedBusyFromInstanceState(state)) return false;
  if (!turnStartTs) return true;
  return (now - turnStartTs) >= graceMs;
}

// 轮次 result → 聊天流条/通知/触感/挂起工具收尾。
// CLI 对用户主动中止只呈现 interrupt，不把 SDK 伴随的 is_error + ede_diagnostic 当红色错误。
// 后端 agent.js 在 interrupt() 成功后给紧随的 result 打 interrupted=true；此处优先于 isError。
// opts.rand 注入过去式动词随机源（默认 Math.random），仅供测试确定化；成功轮收尾行用它。
export function presentTurnResult(payload = {}, opts = {}) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const durationMs = typeof p.durationMs === 'number' ? p.durationMs : 0;
  const cost = typeof p.costUsd === 'number' ? ` · $${p.costUsd.toFixed(4)}` : '';
  const secs = (durationMs / 1000).toFixed(1);
  const errorText = Array.isArray(p.errors) ? p.errors.filter(Boolean).join('; ') : '';

  if (p.interrupted) {
    return {
      kind: 'aborted',
      statusBar: { text: `${t('已中止')} · ${secs}s${cost}`, cls: 'text-ink-faint' },
      errorBar: null,
      notify: { title: t('⏹ 任务已中止'), body: `${t('用时')} ${secs}s` },
      failToolsMessage: t('已中止'),
      haptic: 'warning',
    };
  }
  if (p.isError) {
    return {
      kind: 'error',
      statusBar: { text: `${t('完成')} · ${secs}s${cost}`, cls: 'text-ink-faint' },
      errorBar: errorText ? { text: `${t('出错：')}${errorText}`, cls: 'text-danger' } : null,
      notify: { title: t('⚠️ 任务出错'), body: errorText.slice(0, 80) || `${t('用时')} ${secs}s` },
      failToolsMessage: errorText || t('工具执行已因本轮错误停止'),
      haptic: 'error',
    };
  }
  // 成功轮收尾对齐 CLI turn_duration 行：✻ <过去式动词> for <时长>。
  // 累计 cost 不再挂后缀（状态栏 #cliStatus 随时可看），保终端等价的收敛观感。
  return {
    kind: 'success',
    statusBar: { text: `✻ ${pickTurnDoneVerb(opts.rand)} for ${formatCliDuration(durationMs)}`, cls: 'text-ink-faint' },
    errorBar: null,
    notify: { title: t('✅ 任务完成'), body: `${t('用时')} ${secs}s` },
    failToolsMessage: null,
    haptic: 'success',
  };
}
