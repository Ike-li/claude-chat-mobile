import { findOutboxTargetInstance, pickAfterTurnResend, sameOutboxTarget } from '../logic/outbox-send.js';

// 离线重放撞上在途轮的条目：排队，本轮结束按序自动续发，一轮一条（O66）。终端里忙时打的话也是排队、
// 回合结束再发；此前这里落「⏸ 未发送」终态，得逐条点「重发」。
// 只管「离线时已经按过发送」的条目，不是在线排队——在线发送仍是一轮一条、运行中禁发（6f544058）。
// 续发走的就是那颗气泡上的「重发」（resend），手动点与自动续发是同一条路径；本模块只决定什么时候替用户点。
// 判据在 logic/outbox-send.js 的 pickAfterTurnResend。
export function createOutboxAfterTurn({ getInstances = () => [] } = {}) {
  // { target, resend, cancel, sawRunning, inFlight }
  let entries = [];

  const runningNow = target => findOutboxTargetInstance(target, getInstances())?.turnRunning === true;

  // 登记时目标正被一轮占着（正是被它拒收的），所以 sawRunning 起始为真：这一轮结束就轮到它。
  function wait(target, { resend, cancel = () => {} }) {
    entries.push({ target, resend, cancel, sawRunning: true, inFlight: false });
  }

  async function tick() {
    for (const e of entries) if (runningNow(e.target)) e.sawRunning = true;
    const next = pickAfterTurnResend(entries, getInstances());
    if (!next) return;
    next.inFlight = true;
    let outcome;
    try {
      outcome = await next.resend();
    } finally {
      next.inFlight = false;
    }
    if (outcome === 'blocked') return; // 又撞上一轮（别处抢先开了）：留在队首，等这一轮结束
    // 发出去了（或已被手动点掉、或落了别的终态，手动「重发」仍在）：出队。同一会话后面的那条得先看到新一轮开跑。
    entries = entries.filter(e => e !== next);
    if (outcome === 'ok' || outcome == null) {
      for (const e of entries) if (sameOutboxTarget(e.target, next.target)) e.sawRunning = runningNow(e.target);
    }
    tick();
  }

  // 用户按了停止：这一会话排着的不再自动发（终端里中断后，排着的话也不会自己发出去），退回手动「重发」。
  function cancelTarget(target) {
    const dropped = entries.filter(e => sameOutboxTarget(e.target, target));
    entries = entries.filter(e => !dropped.includes(e));
    for (const e of dropped) e.cancel();
  }

  return { wait, tick, cancelTarget, size: () => entries.length };
}
