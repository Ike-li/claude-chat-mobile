// 排队消息：卡片、提交、取回、本地副本。判定全在 logic/queued-message.js，状态机在 server 的 message-queue.js。
//
// 【卡片不进消息流】排队中的话不做气泡：气泡要应付清屏、DOM 缓存、历史重载和跨设备，而另一台设备根本没有这颗气泡。
// 卡片由 instances 广播的 queuedMessages 驱动，是按 sessionId 归键的全量快照：断线重连、切会话、换设备都从同一份
// 权威快照重画。发出那一刻由普通 user_message 上屏。理由同额度墙横幅（app/auto-continue-banner.js）。
//
// 【缺字段 = 后端不支持】真 server 恒带数组。从没收到过数组就不给排队入口，见 isQueueAvailable。收到过之后缺字段的
// 广播保留上一份，同 autoContinue 的约定。
//
// 【本地副本】server 重启作废排队消息（hard-rules §1 不新增持久化层），副本是用户那句话的最后一份，判据见
// reconcileQueuedCopies。副本带着提交那一刻的 service.startedAt：比较用记下来的值，页面重载后也成立。
import { t } from '../i18n.js';
import {
  QUEUED_COPIES_STORAGE_KEY, isQueueAvailable, presentQueueSubmitAck, queuedEntryFor, reconcileQueuedCopies, resolveQueuedCard,
} from '../logic/queued-message.js';

// 只用无透明度的 token，理由同 auto-continue-banner.js
const CARD_BASE = 'px-3 py-2 bg-surface border rounded-xl text-xs mb-1 shrink-0 flex items-center gap-2';
const TONE_CLASSES = { waiting: 'border-accent', sending: 'border-line', held: 'border-warning' };

export function createQueuedMessageController(context, {
  socket,
  storage,
  ackTimeoutMs,
  isResetting = () => false,
  isSameSurface,
  restoreToComposer,
  clearComposerIfEquals,
  notify,
  onLost,
  onSentDirectly,
  onDivergence,
  onChange = () => {},
  onToggle = () => {},
}) {
  let entries = [];
  let supported = false;
  let sessionId = null;
  let startedAt = null;
  let copies = readCopies();
  let unconfirmed = null; // 超时、结果不明的那一条：话已回输入框，万一服务端其实收下了要把输入框里的撤掉
  let visible = false;
  const submitting = new Set();

  function readCopies() {
    try {
      const data = JSON.parse(storage?.getItem(QUEUED_COPIES_STORAGE_KEY) || '[]');
      return Array.isArray(data) ? data.filter(c => typeof c?.clientMessageId === 'string' && typeof c.text === 'string') : [];
    } catch { return []; }
  }
  function writeCopies() {
    if (isResetting()) return; // 重置中：内存里的旧副本不许写回刚清空的存储
    try {
      storage?.setItem(QUEUED_COPIES_STORAGE_KEY, JSON.stringify(copies));
    } catch {
      // 配额不够放附件的 base64：至少留住文字
      try { storage?.setItem(QUEUED_COPIES_STORAGE_KEY, JSON.stringify(copies.map(({ attachments: _attachments, ...rest }) => rest))); } catch { /* 隐私模式 */ }
    }
  }
  function dropCopy(clientMessageId) {
    copies = copies.filter(c => c.clientMessageId !== clientMessageId);
    writeCopies();
  }

  function reconcile() {
    const { keep, lost } = reconcileQueuedCopies({ copies, entries, startedAt, submitting: [...submitting] });
    copies = keep;
    writeCopies();
    for (const copy of lost) onLost(copy, t('这条排队消息没有发出'));
  }

  function render() {
    const { queuedCard: card, queuedCardIcon: icon, queuedCardStatus: status, queuedCardPreview: preview, queuedCardAction: action } = context.dom;
    if (!card) return;
    const view = resolveQueuedCard(entries, sessionId);
    if (!view) {
      card.className = `hidden ${CARD_BASE}`;
    } else {
      card.className = `${CARD_BASE} ${TONE_CLASSES[view.state] || TONE_CLASSES.waiting}`;
      card.dataset.state = view.state;
      icon.textContent = view.icon;
      status.textContent = view.status;
      preview.textContent = view.preview;
      preview.classList.toggle('hidden', !view.preview);
      action.classList.toggle('hidden', !view.actionLabel);
      action.textContent = view.actionLabel ?? '';
      action.disabled = false;
    }
    if (Boolean(view) !== visible) {
      visible = Boolean(view);
      onToggle(visible); // 卡片占一行会改 #messages 高度
    }
  }

  function update({ entries: next, sessionId: sid, startedAt: started }) {
    sessionId = sid || null;
    if (started != null) startedAt = started;
    if (Array.isArray(next)) {
      entries = next;
      supported = true;
      reconcile();
      if (unconfirmed && next.some(e => e?.clientMessageId === unconfirmed.clientMessageId)) {
        clearComposerIfEquals(unconfirmed.text);
        unconfirmed = null;
      }
    }
    render();
    onChange();
  }

  const available = () => isQueueAvailable({ connected: socket.connected, supported, sessionId, entries, submitting: submitting.size > 0 });

  /** 发不出去时给用户的那句话：已占位时说清楚，其余用调用方自己的文案。 */
  const blockedHint = () => (queuedEntryFor(entries, sessionId) ? t('已有一条排队消息，先处理它') : null);

  function settleSubmit(message, decision) {
    const { clientMessageId, text, attachments } = message;
    submitting.delete(clientMessageId);
    if (decision.outcome === 'queued') {
      copies = copies.map(c => (c.clientMessageId === clientMessageId ? { ...c, acked: true } : c));
      writeCopies();
    } else {
      dropCopy(clientMessageId);
    }
    if (decision.outcome === 'sent') onSentDirectly(message);
    if (decision.outcome === 'unknown') unconfirmed = { clientMessageId, text };
    if (decision.restore) {
      if (isSameSurface(message)) {
        restoreToComposer({ text, attachments });
        if (decision.message) notify(decision.message, 'text-danger');
        if (decision.divergence) onDivergence(decision.divergence, message);
      } else {
        // 切走了：话不能放进别的会话的输入框，等用户回到它自己的会话时交还
        onLost(message, decision.message || t('这条排队消息没有发出'));
      }
    }
    onChange();
  }

  function submit(message) {
    const { clientMessageId, text, model, attachments, instanceId, sessionId: sid, cwd } = message;
    copies = [...copies, { clientMessageId, sessionId: sid, instanceId, cwd, text, model, attachments, startedAt, acked: false }];
    writeCopies();
    submitting.add(clientMessageId);
    onChange();
    socket.timeout(ackTimeoutMs).emit(
      'user:message',
      { text, model, attachments, instanceId, cwd, sessionId: sid, clientMessageId, queue: true },
      (err, ack) => settleSubmit(message, presentQueueSubmitAck(err, ack)),
    );
  }

  function take() {
    const view = resolveQueuedCard(entries, sessionId);
    const action = context.dom.queuedCardAction;
    if (!view?.actionLabel || !action) return;
    action.disabled = true; // 连点两下不该发两次；等回执或下一次广播重画时解锁
    socket.timeout(ackTimeoutMs).emit('user:takeQueued', { sessionId: view.sessionId, clientMessageId: view.clientMessageId }, (err, ack) => {
      if (ack?.ok) {
        dropCopy(view.clientMessageId);
        restoreToComposer({ text: ack.text, attachments: ack.attachments });
      } else {
        notify(err ? t('取回失败，可再试一次') : t('已被取走或已发出'), err ? 'text-danger' : 'text-info');
      }
      render();
    });
  }

  if (context.dom.queuedCardAction) context.dom.queuedCardAction.onclick = take;

  return { update, available, blockedHint, submit, take };
}
