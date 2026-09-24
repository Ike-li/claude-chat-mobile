// auto-continue.js —— 额度墙「到点自动继续」的调度（状态与编排的唯一所有者，工厂 + 全注入，同 mirror-engine）。
//
// 判定全在 agent/quota-auto-continue.js（纯函数），本模块只管：谁布防了、什么时候到点、到点时再核一遍
// 能不能发、发给哪个实例。所有 IO（读 transcript 尾窗、读 CLI 会话注册表、开实例）与时钟、随机源、
// 定时器都由 app.js 注入，生产代码里不直接碰 fs。
//
// 【状态按 sessionId 挂，不挂在实例上】等待常达 5 小时，而空闲 30 分钟的实例就会被回收
// （agent.js checkIdle 的 instanceIdleReclaimMs）。到点时实例多半已经不在了，要 resume 一个出来再发。
//
// 【重启即作废，不落盘】与 CLI 同口径（它的原文："Claude Code exited during the wait, so the task will
// not resume on its own"），也是 APPROVAL-02 的同一个立场：重启时残留的「待执行动作」不再执行。
// 另一个理由是 hard-rules §1「不新增持久化层」——布防事实能从 transcript 重建（墙条目自带 quotaLimits），
// 不能重建的只有用户的「取消」，而为它新开一个落盘文件换来的是「重启后自动替你开跑」这种更难预期的行为。
//
// 【到点时的四道复核】（任一不过都不发——代发是替用户做决定，没有证据就不做）
//   1. 自动布防的条目：开关此刻仍开着（手动布防的不看开关：开关管的是「自动」）
//   2. transcript 尾窗里墙仍是主链最后一条对话（没人在终端 / 别的设备上接着干过），读不到就不发
//   3. 注册表里没有终端或桌面端开着这个会话（单驾驶员，SESSION-01）；注册表读不全也不发
//   4. 实例没有在跑一轮、内存上下文没有陈旧（externalDirty）
// 2、3 不过且原因是「有别人可能在驾驶」时转 stale：横幅留一个「继续」按钮，由用户拍板。
import {
  AUTO_CONTINUE_PROMPT,
  computeFireAt,
  decideDue,
  planQuotaWall,
  wallStillTail,
} from '../agent/quota-auto-continue.js';
import { terminalStateKey } from '../sessions/session-registry.js';

export const AUTO_CONTINUE_TICK_MS = 30_000;

// 撞墙当下就不布防时，给会话时间线的一句说明。只在开关开着时说——用户没指望自动继续时这是噪音。
const INELIGIBLE_NOTICE = {
  no_reset: '上游没有给出额度重置时间，无法到点自动继续',
  overage: '当前在用超额用量，这次撞墙后不会自动继续',
};
const STOP_NOTICE = '续跑后连续撞墙，已停止自动继续；额度真正恢复后请手动发送';
const FIRED_NOTICE = '额度已重置，自动继续';

export function createAutoContinue({
  now = () => Date.now(),
  random = Math.random,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  tickMs = AUTO_CONTINUE_TICK_MS,
  isAutoEnabled = () => true,
  readTailEntries,
  listTerminalStates,
  getLiveInstance,
  resumeInstance,
  onChange = () => {},
  log = () => {},
} = {}) {
  const entries = new Map();   // sessionId → { sessionId, cwd, phase, reason, resetsAtMs, fireAt, rateLimitType, origin, wallUuid }
  const futile = new Map();    // sessionId → 连续空转次数（planQuotaWall 的 prevFutile）
  const firing = new Map();    // sessionId → 在途的 fire Promise（同一次布防至多发一次）
  let timer = null;
  let lastTickAt = null;

  function ensureTimer() {
    if (timer || entries.size === 0) return;
    lastTickAt = now();
    timer = setIntervalFn(() => { tick().catch(err => log(null, `[auto-continue] tick 异常: ${err?.message || err}`)); }, tickMs);
    timer?.unref?.(); // 不拖住进程退出：等待期再长，也不该让 server 关不掉
  }

  function stopTimerIfIdle() {
    if (!timer || entries.size > 0) return;
    clearIntervalFn(timer);
    timer = null;
    lastTickAt = null;
  }

  function remove(sessionId, why) {
    if (!entries.delete(sessionId)) return false;
    log(sessionId, `[SYS] 自动继续：撤销（${why}）`);
    stopTimerIfIdle();
    return true;
  }

  function toStale(entry, reason) {
    entries.set(entry.sessionId, { ...entry, phase: 'stale', reason, fireAt: null });
    log(entry.sessionId, `[SYS] 自动继续：未代发，等用户确认（${reason}）`);
  }

  function onWall({ sessionId, cwd, instance, wall }) {
    if (!sessionId || !wall) return;
    const autoEnabled = isAutoEnabled(cwd);
    const plan = planQuotaWall({
      quota: wall.quota, fallback: wall.fallback, now: now(), autoEnabled,
      turnOrigin: wall.turnOrigin, turnHadOutput: wall.turnHadOutput,
      prevFutile: futile.get(sessionId) ?? 0, random,
    });
    futile.set(sessionId, plan.futile);
    const hadEntry = entries.has(sessionId);
    if (plan.kind === 'ineligible' || plan.kind === 'stop') {
      entries.delete(sessionId);
      const notice = plan.kind === 'stop' ? STOP_NOTICE : (autoEnabled ? INELIGIBLE_NOTICE[plan.reason] : null);
      if (notice) instance?.emitNotice?.(notice, plan.kind === 'stop' ? 'warning' : 'info');
      log(sessionId, `[SYS] 自动继续：不布防（${plan.reason}）`);
      stopTimerIfIdle();
      if (hadEntry) onChange();
      return;
    }
    entries.set(sessionId, {
      sessionId, cwd,
      phase: plan.kind === 'arm' ? 'armed' : 'offered',
      reason: plan.reason,
      resetsAtMs: plan.resetsAtMs,
      fireAt: plan.fireAt,
      rateLimitType: plan.rateLimitType,
      origin: 'auto',
      wallUuid: wall.uuid ?? null,
    });
    log(sessionId, `[SYS] 自动继续：${plan.kind === 'arm' ? `布防，${new Date(plan.fireAt).toISOString()} 到点` : `仅提供选项（${plan.reason}）`}`);
    ensureTimer();
    onChange();
  }

  async function fire(entry) {
    const { sessionId, cwd } = entry;
    if (entry.origin === 'auto' && !isAutoEnabled(cwd)) {
      if (remove(sessionId, 'setting_off')) onChange();
      return;
    }
    const tail = await readTailEntries(sessionId, cwd);
    if (tail === null) { toStale(entry, 'unverified'); onChange(); return; }
    if (!wallStillTail(tail, { wallUuid: entry.wallUuid, resetsAtMs: entry.resetsAtMs })) {
      if (remove(sessionId, 'superseded')) onChange();
      return;
    }
    // null = 注册表读不全。这里拿它当否定证据（没有别的驾驶员 ⇒ 可以代发），读不全时结论不成立。
    const states = await listTerminalStates();
    if (!states) { toStale(entry, 'unverified'); onChange(); return; }
    const st = states.get(terminalStateKey(cwd, sessionId));
    if (st && (st.state || st.blocked)) { toStale(entry, 'other_driver'); onChange(); return; }
    let inst = getLiveInstance(sessionId);
    if (inst?.pendingTurns > 0) {
      if (remove(sessionId, 'busy')) onChange();
      return;
    }
    if (inst?.externalDirty) { toStale(entry, 'other_driver'); onChange(); return; }
    if (!inst) {
      try {
        inst = await resumeInstance(cwd, sessionId);
      } catch (err) {
        log(sessionId, `[SYS] 自动继续：resume 失败（${err?.message || err}）`);
        toStale(entry, 'resume_failed');
        onChange();
        return;
      }
    }
    // resume 的 await 间隙里用户可能已经取消、手动发送或删了会话：条目不在了就不发。
    if (entries.get(sessionId) !== entry) return;
    inst.emitNotice?.(FIRED_NOTICE, 'info');
    const sent = await inst.send(AUTO_CONTINUE_PROMPT, undefined, { origin: 'auto-continuation' });
    remove(sessionId, sent ? 'fired' : 'busy');
    onChange();
  }

  function startFire(entry) {
    if (firing.has(entry.sessionId)) return firing.get(entry.sessionId);
    const p = fire(entry)
      .catch(err => {
        log(entry.sessionId, `[SYS] 自动继续：发送异常（${err?.message || err}）`);
        if (entries.get(entry.sessionId) === entry) { toStale(entry, 'resume_failed'); onChange(); }
      })
      .finally(() => firing.delete(entry.sessionId));
    firing.set(entry.sessionId, p);
    return p;
  }

  // 复核要读盘，一拍可能跨过下一拍。重叠的两拍不另加互斥：到点条目在发出之前一直留在表里，
  // 第二拍会再次选中它，但 startFire 按 sessionId 复用在途的那一次——「至多发一次」只由 firing 表负责。
  async function tick() {
    const t = now();
    const prev = lastTickAt;
    lastTickAt = t;
    let changed = false;
    const due = [];
    for (const entry of [...entries.values()]) {
      if (entry.phase === 'offered' && t >= entry.resetsAtMs) {
        changed = remove(entry.sessionId, 'offer_expired') || changed;
      } else if (entry.phase === 'armed') {
        const verdict = decideDue({ fireAt: entry.fireAt, now: t, lastTickAt: prev });
        if (verdict === 'stale') { toStale(entry, 'slept'); changed = true; }
        else if (verdict === 'fire') due.push(entry);
      }
    }
    if (changed) onChange();
    for (const entry of due) await startFire(entry);
  }

  // 用户的三个动作（横幅按钮）。只认当前相位下有意义的动作，其余 ok:false、不改状态。
  function act(sessionId, action) {
    const entry = entries.get(sessionId);
    if (!entry) return { ok: false, error: 'not_found' };
    if (action === 'cancel') {
      remove(sessionId, 'cancelled');
      onChange();
      return { ok: true };
    }
    if (action === 'arm' && entry.phase === 'offered') {
      entries.set(sessionId, {
        ...entry, phase: 'armed', reason: null, origin: 'manual',
        fireAt: computeFireAt({ resetsAtMs: entry.resetsAtMs, now: now(), random }),
      });
      log(sessionId, '[SYS] 自动继续：用户手动布防');
      ensureTimer();
      onChange();
      return { ok: true };
    }
    if (action === 'continueNow' && entry.phase === 'stale') {
      // 点「继续」就是人拍板：按手动处理（同 arm 那一支），不再受「自动」开关约束——否则开关关着时
      // 复核会删掉条目却不发，ack 还回 ok，用户这一下就丢了。
      // 已有在途的那一次就什么都不动：换掉表里的条目对象会让在途那次醒来认不出自己（fire 末尾按
      // 对象身份复核），而 startFire 又按 sessionId 复用它——两边一错开，连点两下就一条都不发。
      if (!firing.has(sessionId)) {
        const manual = { ...entry, origin: 'manual' };
        entries.set(sessionId, manual);
        void startFire(manual);
      }
      return { ok: true };
    }
    return { ok: false, error: 'invalid_action' };
  }

  function onManualSend(sessionId) {
    if (remove(sessionId, 'manual_submit')) onChange();
  }

  // 会话被删、或用户显式关掉了它的标签（CLI 的对应物是退出进程，同样即作废）。
  // 空闲回收不走这里：那是资源回收，不是用户意图，到点照常 resume。
  function onSessionGone(sessionId, why = 'session_gone') {
    futile.delete(sessionId);
    if (remove(sessionId, why)) onChange();
  }

  // instances 广播的 autoContinue 字段。只放前端渲染横幅要的事实，wallUuid 这类内部锚点不外发。
  function snapshot() {
    return [...entries.values()].map(e => ({
      sessionId: e.sessionId, cwd: e.cwd, phase: e.phase, reason: e.reason,
      resetsAt: e.resetsAtMs, fireAt: e.fireAt, rateLimitType: e.rateLimitType, origin: e.origin,
    }));
  }

  async function idle() {
    await Promise.all([...firing.values()]);
  }

  function stop() {
    entries.clear();
    futile.clear();
    if (timer) clearIntervalFn(timer);
    timer = null;
    lastTickAt = null;
  }

  return { onWall, onManualSend, onSessionGone, act, snapshot, tick, idle, stop };
}
