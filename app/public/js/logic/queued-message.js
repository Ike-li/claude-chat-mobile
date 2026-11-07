// logic/queued-message.js —— 排队消息的前端判定（接线在 app/queued-message.js，状态机在 server 的 message-queue.js）
//
// 红线同 logic/ 其它模块：只做数据→数据，不碰 DOM / window / socket / 应用可变状态。
import { t, tk } from '../i18n.js';
import { presentOnlineSendAck } from './outbox-send.js';

export const QUEUED_COPIES_STORAGE_KEY = 'ccm-queued-v1';

const HELD_REASON_TEXT = {
  stopped: tk('本轮已停止，这条没有发出'),
  interrupted: tk('本轮被中断，这条没有发出'),
  turn_error: tk('本轮出错，这条没有发出'),
  quota_wall: tk('撞上额度墙，这条没有发出'),
  approval_expired: tk('审批过期，本轮没做完，这条没有发出'),
  incomplete: tk('本轮没有正常结束，这条没有发出'),
  instance_exit: tk('会话进程退出了，这条没有发出'),
  closed: tk('会话关闭了，这条没有发出'),
  session_changed: tk('会话已经换了，这条没有发出'),
  other_driver: tk('终端或桌面端正在用这个会话，这条没有发出'),
  unverified: tk('无法确认这个会话的状态，这条没有发出'),
  diverged: tk('续接会丢掉一段对话：取回后发送时选怎么续'),
  location: tk('找不到这个会话的记录了，这条没有发出'),
  attachment_failed: tk('附件保存失败，这条没有发出'),
  send_failed: tk('发送失败，这条没有发出'),
};

export const queuedEntryFor = (entries, sessionId) => (sessionId ? entries.find(e => e?.sessionId === sessionId) ?? null : null);

/**
 * 排队入口给不给。supported = 收到过带 queuedMessages 数组的 instances：真 server 恒带，所以「从没收到过」就是
 * 后端不支持。前端热更新先于后端重启时走这一支，入口不出现，行为与没有这个功能完全相同。
 */
export function isQueueAvailable({ connected, supported, sessionId, entries, submitting }) {
  return Boolean(connected && supported && sessionId && !submitting && !queuedEntryFor(entries, sessionId));
}

const previewOf = (entry) => {
  if (entry.preview) return entry.preview;
  return (entry.attachments ?? []).map(a => a?.name).filter(Boolean).join(t('、'));
};

/** 卡片要显示什么。这个会话没有条目时返回 null。 */
export function resolveQueuedCard(entries, sessionId) {
  const entry = queuedEntryFor(entries, sessionId);
  if (!entry) return null;
  const base = { state: entry.state, clientMessageId: entry.clientMessageId, sessionId: entry.sessionId, preview: previewOf(entry) };
  if (entry.state === 'held') {
    const reason = HELD_REASON_TEXT[entry.reason];
    return { ...base, icon: '⏸', status: `${t('未发送')} · ${reason ? t(reason) : t('这条没有发出')}`, actionLabel: t('取回') };
  }
  if (entry.state === 'sending') return { ...base, icon: '🕐', status: t('正在发送...'), actionLabel: null };
  return { ...base, icon: '⏳', status: t('排队中 · 本轮结束后自动发送'), actionLabel: t('撤回') };
}

/**
 * 排队请求的 ack。不复用 presentOnlineSendTransport：超时在普通发送里进 outbox 重试，而排队只在在线时发，
 * 进 outbox 的话一条消息可能同时活在两边。这里一律把话放回输入框。
 * @returns {{outcome:'queued'|'sent'|'unknown'|'rejected', restore?:boolean, message?:string, divergence?:object}}
 */
export function presentQueueSubmitAck(err, ack) {
  if (err) return { outcome: 'unknown', restore: true, message: t('没有确认排上，话已放回输入框') };
  if (ack?.ok === true) return { outcome: ack.queued === true ? 'queued' : 'sent' };
  const decision = presentOnlineSendAck(ack);
  return {
    outcome: 'rejected',
    restore: true,
    message: ack?.queueFull ? t('已有一条排队消息，先处理它') : decision.message,
    ...(decision.divergence ? { divergence: decision.divergence } : {}),
  };
}

/** 取回的话放进输入框：空着就放入，有字用空行拼在后面，不覆盖用户新打的。 */
export function mergeTakenIntoComposer({ current, taken }) {
  const head = (current ?? '').trim();
  if (!head) return taken ?? '';
  return taken ? `${head}\n\n${taken}` : head;
}

/**
 * 本地副本对账。server 重启作废排队消息，副本是用户那句话的最后一份。
 * 快照里消失、server 没重启：已发出或被别的设备取走，删掉。server 重启了、或者请求一直没有 ack（页面重载）：
 * 话没有别的去处，交还。请求还在途时快照里当然没有，不判。广播没带 startedAt 判不了有没有重启，全留着。
 * 方向是多一份草稿，不会重发：交还的话回到输入框，由用户决定。
 * @returns {{keep:Array, lost:Array}}
 */
export function reconcileQueuedCopies({ copies, entries, startedAt, submitting }) {
  if (startedAt == null) return { keep: copies, lost: [] };
  const present = new Set(entries.map(e => e?.clientMessageId));
  const keep = [];
  const lost = [];
  for (const copy of copies) {
    if (present.has(copy.clientMessageId)) keep.push({ ...copy, acked: true }); // 页面重载丢了 ack 也算收下了
    else if (submitting.includes(copy.clientMessageId)) keep.push(copy);
    else if (copy.startedAt !== startedAt || !copy.acked) lost.push(copy);
  }
  return { keep, lost };
}
