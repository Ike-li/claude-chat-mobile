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
      message: t('未确认送达，已排队重试'),
    };
  }
  return presentOnlineSendAck(ack);
}

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

// 离线批处理后是否应 busy：仅当「仍有目标为当前 viewing 的重入队项」或「本批有 viewing 相关 ok 且
// 指望 result 清 busy」时保持 busy。FE-NEW-001：永久失败且无剩余 viewing 队列 → 必须 clear。
// remainingItems = 本批结束后仍在 offlineQueue 的项；viewingInstanceId 可为 null。
export function shouldBusyAfterOfflineBatch({ viewingInstanceId, remainingItems = [], hadViewingOk = false } = {}) {
  const viewingPending = remainingItems.some(it => it && it.instanceId != null && it.instanceId === viewingInstanceId);
  if (viewingPending) return true;
  // 本批对当前 viewing 成功发出 → 短暂 busy 等 result（与在线一致）；非 viewing 成功不抬 busy
  if (hadViewingOk && viewingInstanceId != null) return true;
  return false;
}

// 重发横幅文案：addBar 无条件贴当前会话消息流（app.js 的 addBar 不带归属过滤），而队列项的目标
// 是【入队时刻】那个实例——两者不是一回事。不标注就会读成「这条排队消息在本会话发了」，
// 叠上服务端 sysTo 的「目标会话已关闭」（同样贴当前视图）尤其像串会话。
// 归属判据与 shouldBusyAfterOfflineBatch / app.js 的 targetsViewing 逐字一致：
// instanceId != null 且相等才算本视图——两边同为 null（首页 + 首发未开实例）不得配成一对。
export function planOutboxDrainNotice({ items = [], viewingInstanceId = null } = {}) {
  const list = Array.isArray(items) ? items : [];
  const total = list.length;
  const foreign = list.filter(
    it => !(it && it.instanceId != null && it.instanceId === viewingInstanceId)
  ).length;
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
// 真后台任务期 state 仍是 'busy'，不会被误清。宽限期防止刚发送、服务端 pendingTurns 尚未计入广播的
// 乐观 busy 窗口被误清（同量级于 app.js 的 SEND_ACK_FALLBACK_MS）。
export const BUSY_BROADCAST_CLEAR_GRACE_MS = 5000;
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
