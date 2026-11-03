// public/js/app/terminal-state-expiry.js —— 抽屉关着时终端 last-known 的有效期（#398）。
//
// 抽屉关上后 terminalStateByDir 不清空，继续给 #sessionsDot 做「其他工作区终端需要你 / 运行中」的被动感知；
// 但关着抽屉不再轮询 session:list，没有任何东西会刷新或撤下这份快照。不设上限，终端那边早答完了，
// 手机主界面仍亮着「需要你」直到下次开抽屉或刷新。
//
// 截止时刻 = 最后一次观测 + ttlMs，只由 observe() 推进：arm() 重复调用（回前台、反复开关抽屉都会走到）
// 只按同一个截止时刻重排，不能把一份旧快照续命。
export function createLastKnownExpiry({
  ttlMs,
  now = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = id => clearTimeout(id),
}) {
  let observedAt = now();
  let timer = null;
  function cancel() {
    if (timer !== null) clearTimer(timer);
    timer = null;
  }
  return {
    observe() { observedAt = now(); },
    arm(onExpire) {
      cancel();
      timer = setTimer(() => { timer = null; onExpire(); }, Math.max(0, observedAt + ttlMs - now()));
    },
    cancel,
  };
}
