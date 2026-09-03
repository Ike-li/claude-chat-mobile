// public/js/app/long-press.js —— 长按手势（抽屉会话行「标为未读/已读」的入口）。
//
// 触屏与鼠标统一走 Pointer Events：主键按下 → 计时 holdMs → 期间指尖位移不超过 moveTolerance、
// 未抬手、未被系统接管（pointercancel = 浏览器判定为滚动）才算长按。桌面右键（contextmenu）同效，
// 并阻止原生菜单；Android 触屏长按会先后发「计时到点」与 contextmenu 两个信号，只认第一个。
//
// 触发后吞掉紧随其后的那一次 click（capture 阶段拦截）：长按松手时浏览器仍会派发 click，
// 不拦就会在弹出确认 sheet 的同时把会话也切走。侧滑手势（app.js 会话行 touchmove）与本手势
// 天然互斥——横向位移一超过容差本计时就撤销。
//
// 不做长按中的视觉反馈：确认 sheet 本身就是反馈。计时器可注入，供单测零 DOM 钉手势契约。
export function attachLongPress(el, onLongPress, {
  holdMs = 500,
  moveTolerance = 10,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
} = {}) {
  let timer = null;
  let startX = 0, startY = 0;
  let swallowNextClick = false;

  function cancel() {
    if (timer === null) return;
    clearTimer(timer);
    timer = null;
  }

  function fire(ev) {
    cancel();
    swallowNextClick = true;
    onLongPress(ev);
  }

  el.addEventListener('pointerdown', ev => {
    // button：0 主键 / 2 右键（右键走 contextmenu，不计时）；isPrimary=false 是第二根手指。
    if (ev.button !== undefined && ev.button !== 0) return;
    if (ev.isPrimary === false) return;
    cancel();
    startX = ev.clientX;
    startY = ev.clientY;
    swallowNextClick = false;
    timer = setTimer(() => { timer = null; fire(ev); }, holdMs);
  });
  el.addEventListener('pointermove', ev => {
    if (timer === null) return;
    if (Math.abs(ev.clientX - startX) > moveTolerance || Math.abs(ev.clientY - startY) > moveTolerance) cancel();
  });
  for (const type of ['pointerup', 'pointercancel', 'pointerleave']) el.addEventListener(type, cancel);

  el.addEventListener('contextmenu', ev => {
    ev.preventDefault();
    if (swallowNextClick) return; // 计时器刚触发过（Android 长按双信号）
    fire(ev);
  });

  el.addEventListener('click', ev => {
    if (!swallowNextClick) return;
    swallowNextClick = false;
    ev.preventDefault();
    ev.stopPropagation();
  }, true);
}
