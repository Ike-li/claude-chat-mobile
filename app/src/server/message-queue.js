// message-queue.js —— 手机端消息排队：回合运行中收下一条，回合正常结束后替用户发出（工厂 + 全注入，同 auto-continue）。
//
// 【消息留在 server，不进 CLI 队列】2026-07-30 移除过 CLI 侧的排队：交给 CLI 之后 result 数量不定，停止也停不住它
// （interrupt 回 still_queued，紧接着开跑）。这里等到真的能发时才交出去，所以停止、额度墙、出错都拦得住。
//
// 【按 sessionId 挂，重启作废，不落盘】等待期间实例可能换号（规则 5 置换、切 effort）。不落盘的理由同
// auto-continue：hard-rules §1「不新增持久化层」。用户的话由发送方的本地副本兜底。
//
// 【什么时候放行】回合正常结束后（classifyTurnEnd）进 settling，等 CLI 说它真的闲了（session_state_changed:idle）：
//   · 收到 idle（普通情况在 result 后约 2ms）→ 释放。
//   · 收到 init → CLI 自己又起了一轮（后台任务汇报、Monitor），回 waiting，这一轮结束再判。这段时间消息还在 server，
//     这一轮出错或被停时不发。
//   · QUEUE_SETTLE_MS 内两者都没有 → 兜底释放：后台子 agent 占着 CLI 时 idle 要等它们跑完（这时发消息会立刻开跑，
//     不能干等），没有这个帧的旧 CLI 同样走这里。
// 不用 pendingAutoTurn：通知并进当前回合时它滞留到 120 秒 TTL，Monitor 事件起的轮又根本不武装它。
// 也不能用 command_lifecycle 的 queued：那是交给 CLI 之后才有的信号，那时消息已经不在 server 了。
//
// 【释放走发送闸的无人值守模式】判定和投递都在 send-gate.js。任何一道闸不过都转 held，held 永不自动释放，
// 只有用户取回。条目只有三个出口：发出、用户取回、删除会话。
//
// 【立即发送是唯一不等回合结束的出口】用户点了，人就在跟前：过交互闸，只跳过在途轮那一道，带 priority:'now' 交出去，
// CLI 让当前这一轮让路（转后台或停下）。能不能这样发看实例的 canSendNow()（CLI 能力位），快照里的 sendNow 给前端决定显不显示按钮。
import { classifyTurnEnd, MAX_QUEUED_TOTAL, QUEUE_PREVIEW_CHARS, QUEUE_SETTLE_MS } from '../agent/queued-message-policy.js';

const NOT_READY_ERROR = '会话还在启动，暂时不能排队';
const QUEUE_FULL_ERROR = '已有一条排队消息，先处理它';
const TOTAL_FULL_ERROR = '排队的消息太多了，先处理已有的';

// 对外只暴露三态：等 idle 和过闸都还算「排队中」。sending 是正在投递，消息进实例之前用户仍能撤回或停止。
const EXPOSED_STATE = { waiting: 'waiting', settling: 'waiting', releasing: 'waiting', sending: 'sending', held: 'held' };

export function createMessageQueue({
  now = () => Date.now(),
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  settleMs = QUEUE_SETTLE_MS,
  maxTotal = MAX_QUEUED_TOTAL,
  sendGate,
  getLiveInstance,
  onChange = () => {},
  onHeld = () => {}, // 转未发送：推送由接线方按 heldNeedsAttention 决定
  log = () => {},
} = {}) {
  const entries = new Map(); // sessionId → 条目

  const isCurrent = entry => entries.get(entry.sessionId) === entry;

  function clearTimer(entry) {
    if (entry.timer == null) return;
    clearTimeoutFn(entry.timer);
    entry.timer = null;
  }

  function setPhase(entry, phase) {
    clearTimer(entry);
    const changed = EXPOSED_STATE[entry.phase] !== EXPOSED_STATE[phase];
    entry.phase = phase;
    if (changed) onChange();
  }

  function remove(entry, why) {
    clearTimer(entry);
    if (!isCurrent(entry)) return;
    entries.delete(entry.sessionId);
    log(entry.sessionId, `[SYS] 排队消息：移除（${why}）`);
    onChange();
  }

  function toHeld(entry, reason) {
    clearTimer(entry);
    entry.phase = 'held';
    entry.reason = reason;
    entry.heldAt = now();
    const live = getLiveInstance(entry.sessionId);
    if (live) entry.cwd = live.cwd;
    log(entry.sessionId, `[SYS] 排队消息：未发送（${reason}）`);
    onChange();
    onHeld({ sessionId: entry.sessionId, instanceId: live?.instanceId ?? entry.instanceId, cwd: entry.cwd, reason });
  }

  function accept({ instance, clientMessageId, text, model, attachments }) {
    const { sessionId } = instance;
    const reject = (error, extra = {}) => ({ ok: false, ack: { ok: false, error, busy: true, retryable: false, ...extra } });
    if (!sessionId) return reject(NOT_READY_ERROR);
    if (entries.has(sessionId)) return reject(QUEUE_FULL_ERROR, { queueFull: true });
    if (entries.size >= maxTotal) return reject(TOTAL_FULL_ERROR);
    entries.set(sessionId, {
      sessionId, instanceId: instance.instanceId, cwd: instance.cwd,
      clientMessageId, text, model, attachments,
      phase: 'waiting', reason: null, acceptedAt: now(), heldAt: null, timer: null,
    });
    log(sessionId, '[SYS] 排队消息：收下，本轮结束后发送');
    onChange();
    return { ok: true };
  }

  async function release(entry) {
    const a = getLiveInstance(entry.sessionId);
    if (!a) return toHeld(entry, 'instance_exit'); // 不替用户把会话拉起来，同 MSG-02
    setPhase(entry, 'releasing');
    const gate = await sendGate.prepare(a, { unattended: true });
    if (!isCurrent(entry) || entry.phase !== 'releasing') return undefined; // 过闸期间被取回或停止
    if (!gate.ok) {
      if (gate.code === 'turn_running') return setPhase(entry, 'waiting');
      return toHeld(entry, gate.code);
    }
    setPhase(entry, 'sending');
    // 附件落盘和切模型都要等，消息还没进实例，这期间 interrupt 没东西可取消，只有这里拦得住。shouldSend 在 send 入队
    // 那一刻判断，入队之后到这里只有同步代码和微任务，socket 回调插不进来：看得到 sending 就说明它还没发出去。
    const out = await sendGate.deliver(gate.instance, {
      text: entry.text, model: entry.model, attachments: entry.attachments, clientMessageId: entry.clientMessageId,
      shouldSend: () => isCurrent(entry) && entry.phase === 'sending',
    });
    if (out.ok) return remove(entry, 'sent');
    if (!isCurrent(entry) || entry.phase !== 'sending') return undefined; // 入队之前被取回或停止
    if (gate.instance.pendingTurns > 0) return setPhase(entry, 'waiting'); // 手动发送抢先了：等那一轮结束
    return toHeld(entry, out.reason);
  }

  function startRelease(entry) {
    if (!isCurrent(entry) || (entry.phase !== 'settling' && entry.phase !== 'waiting')) return;
    release(entry).catch((err) => {
      log(entry.sessionId, `[SYS] 排队消息：释放异常（${err?.message || err}）`);
      if (!isCurrent(entry)) return;
      // deliver 只在 send 成功之后才可能抛（之前的失败都走返回值）：话已经发出去了，留着条目下一轮会重发。
      if (entry.phase === 'sending') remove(entry, 'sent');
      else toHeld(entry, 'send_failed');
    });
  }

  /** 回合结束（账面已归零）。返回 'release' 时 result 带 queuedNext：下一轮马上开始。 */
  function onTurnEnded(instance, facts) {
    const entry = entries.get(instance.sessionId);
    if (!entry || (entry.phase !== 'waiting' && entry.phase !== 'settling')) return undefined;
    const verdict = classifyTurnEnd(facts);
    if (verdict.kind === 'hold') {
      toHeld(entry, verdict.reason);
      return 'hold';
    }
    setPhase(entry, 'settling');
    entry.timer = setTimeoutFn(() => { entry.timer = null; startRelease(entry); }, settleMs);
    entry.timer?.unref?.();
    return 'release';
  }

  /** CLI 起了一轮（system/init）：result 之后才到说明是它自己起的，等这一轮结束再判。 */
  function onTurnStarted(instance) {
    const entry = entries.get(instance.sessionId);
    if (entry?.phase === 'settling') setPhase(entry, 'waiting');
  }

  /** CLI 报 idle。waiting 也试一次：上一个 init 不是回合时（闲时控制请求）不能卡死，账面还有在途轮时闸门会挡回来。 */
  function onCliIdle(instance) {
    const entry = entries.get(instance.sessionId);
    if (!entry) return;
    clearTimer(entry);
    startRelease(entry);
  }

  /** 停止、额度墙、实例退出、关标签：转未发送。第一次的原因才是用户要看的。 */
  function hold(sessionId, reason) {
    const entry = entries.get(sessionId);
    if (!entry || entry.phase === 'held') return;
    toHeld(entry, reason);
  }

  /**
   * 用户点「立即发送」。和 release 的差别：交互闸（人在跟前）、不等回合结束、带 priority:'now'。
   * 过闸不过回到 waiting 报原因，话不丢，回合结束时照旧走释放；期间被撤回或停止则不发。
   */
  async function sendNow(sessionId, clientMessageId) {
    const entry = entries.get(sessionId);
    if (!entry || entry.clientMessageId !== clientMessageId) return { ok: false, error: 'not_found' };
    if (entry.phase !== 'waiting' && entry.phase !== 'settling') return { ok: false, error: 'not_waiting' };
    const a = getLiveInstance(sessionId);
    if (!a) return { ok: false, error: 'instance_exit' };
    if (!a.canSendNow?.()) return { ok: false, error: 'send_now_unsupported' };
    setPhase(entry, 'sending');
    const stillMine = () => isCurrent(entry) && entry.phase === 'sending';
    const gate = await sendGate.prepare(a, { sendNow: true });
    if (!stillMine()) return { ok: false, error: 'cancelled' }; // 过闸期间被撤回或停止
    if (!gate.ok) {
      setPhase(entry, 'waiting');
      return { ok: false, error: gate.code };
    }
    log(sessionId, '[SYS] 排队消息：立即发送');
    const out = await sendGate.deliver(gate.instance, {
      text: entry.text, model: entry.model, attachments: entry.attachments, clientMessageId: entry.clientMessageId,
      priority: 'now', shouldSend: stillMine,
    });
    if (out.ok) {
      remove(entry, 'sent_now');
      return { ok: true };
    }
    if (!stillMine()) return { ok: false, error: 'cancelled' };
    setPhase(entry, 'waiting');
    return { ok: false, error: out.reason };
  }

  /** 用户取回。后到的设备拿到 not_found，Map 删除是同步的。 */
  function take(sessionId, clientMessageId) {
    const entry = entries.get(sessionId);
    if (!entry || entry.clientMessageId !== clientMessageId) return { ok: false, error: 'not_found' };
    remove(entry, 'taken');
    return { ok: true, text: entry.text, model: entry.model, attachments: entry.attachments };
  }

  /** 实例换了会话（/clear）：这句话是对旧上下文说的，不能静默接到新会话上。每轮 init 都会调，同一个 id 是空操作。 */
  function onSessionChanged(instance, sessionId) {
    for (const entry of entries.values()) {
      if (entry.instanceId !== instance.instanceId || entry.sessionId === sessionId) continue;
      entries.delete(entry.sessionId);
      entry.sessionId = sessionId;
      entries.set(sessionId, entry);
      toHeld(entry, 'session_changed');
      return;
    }
  }

  /** 删除会话：用户删的是整个会话，条目一起丢。 */
  function discard(sessionId) {
    const entry = entries.get(sessionId);
    if (entry) remove(entry, 'session_deleted');
  }

  function hasMessage(clientMessageId) {
    for (const entry of entries.values()) if (entry.clientMessageId === clientMessageId) return true;
    return false;
  }

  function snapshot() {
    return [...entries.values()].map(e => ({
      sessionId: e.sessionId, instanceId: e.instanceId, cwd: e.cwd,
      clientMessageId: e.clientMessageId,
      state: EXPOSED_STATE[e.phase],
      reason: e.reason,
      preview: e.text.slice(0, QUEUE_PREVIEW_CHARS),
      textLength: e.text.length,
      attachments: (e.attachments ?? []).map(({ name, mimeType }) => ({ name, mimeType })),
      acceptedAt: e.acceptedAt, heldAt: e.heldAt,
      sendNow: Boolean(getLiveInstance(e.sessionId)?.canSendNow?.()),
    }));
  }

  return { accept, onTurnEnded, onTurnStarted, onCliIdle, hold, sendNow, take, onSessionChanged, discard, hasMessage, snapshot };
}
