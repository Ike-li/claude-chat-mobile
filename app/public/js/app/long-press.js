// public/js/app/long-press.js —— 长按手势（抽屉会话行「标为未读/已读」的入口）。
//
// 触屏与鼠标统一走 Pointer Events：主键按下 → 计时 holdMs → 期间指尖位移不超过 moveTolerance、
// 未抬手、未被系统接管（pointercancel = 浏览器判定为滚动）才算长按。桌面右键（contextmenu）同效，
// 并阻止原生菜单；Android 触屏长按会先后发「计时到点」与 contextmenu 两个信号，只认第一个。
//
// 长按触发后吞掉紧随其后的那一次 click：长按松手时浏览器仍会派发 click，不拦就会在弹出确认 sheet
// 的同时把会话也切走。拦截挂在【文档】的 capture 阶段、不限落点（O101）：触屏抬手补发的 click 按
// 抬手位置命中，此时确认框已盖在行上，click 落在遮罩上会把它当场关掉——挂在行上拦不到。
// 这道拦截一次性，下一次 pointerdown / keydown（新的操作）就撤掉，所以吞不到属于别的操作的 click。
// 侧滑手势（app.js 会话行 touchmove）与本手势天然互斥——横向位移一超过容差本计时就撤销。
//
// 「去重 Android 补发的 contextmenu」是另一件事，生命周期是本次指针手势：firedByTimer 在下一次
// 任意键 pointerdown 或行上的 keydown 时复位——不在 pointerup 复位，Pointer Events 规范允许 contextmenu
// 晚于 pointerup 到达；键盘呼出的菜单（Shift+F10 / Menu 键）前面没有 pointerdown，靠 keydown 开新一轮。它曾与吞 click 共用一个闩（swallowNextClick），
// 而那个闩只被落在本行的 click 清除——click 落在别处、或右键（不走主键 pointerdown、也不派发 click）
// 时都清不掉，同一行接下来的右键就被静默吞掉（2026-09-07 与 O101 两次）。
//
// touchOnly（消息气泡用，O136）：只认触屏。鼠标按压不计时（那是在拖选文字），本手势里没有触屏
// pointerdown 的 contextmenu（桌面右键、键盘菜单键）原样交还浏览器，右键「复制」照常可用。触屏标记
// 跟 firedByTimer 同一生命周期、不在 pointercancel 复位：Android 长按文字时系统先接管选字发
// pointercancel，之后才发 contextmenu，那一下就是这次长按唯一还收得到的信号。
//
// 不做长按中的视觉反馈：确认 sheet 本身就是反馈。计时器可注入，供单测零 DOM 钉手势契约。
export function attachLongPress(el, onLongPress, {
  holdMs = 500,
  moveTolerance = 10,
  touchOnly = false,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
} = {}) {
  let timer = null;
  let startX = 0, startY = 0;
  let firedByTimer = false;
  let touchGesture = false;
  let disarmClickGuard = null;

  function cancel() {
    if (timer === null) return;
    clearTimer(timer);
    timer = null;
  }

  function armClickGuard() {
    const doc = el.ownerDocument;
    disarmClickGuard?.();
    const swallow = ev => {
      disarm();
      ev.preventDefault();
      ev.stopPropagation();
    };
    const disarm = () => {
      doc.removeEventListener('click', swallow, true);
      doc.removeEventListener('pointerdown', disarm, true);
      doc.removeEventListener('keydown', disarm, true);
      disarmClickGuard = null;
    };
    doc.addEventListener('click', swallow, true);
    doc.addEventListener('pointerdown', disarm, true);
    doc.addEventListener('keydown', disarm, true);
    disarmClickGuard = disarm;
  }


  el.addEventListener('pointerdown', ev => {
    firedByTimer = false;
    touchGesture = ev.pointerType === 'touch';
    if (touchOnly && !touchGesture) return;
    // button：0 主键 / 2 右键（右键走 contextmenu，不计时）；isPrimary=false 是第二根手指。
    if (ev.button !== undefined && ev.button !== 0) return;
    if (ev.isPrimary === false) return;
    cancel();
    startX = ev.clientX;
    startY = ev.clientY;
    timer = setTimer(() => { timer = null; firedByTimer = true; armClickGuard(); onLongPress(ev); }, holdMs);
  });
  el.addEventListener('pointermove', ev => {
    if (timer === null) return;
    if (Math.abs(ev.clientX - startX) > moveTolerance || Math.abs(ev.clientY - startY) > moveTolerance) cancel();
  });
  for (const type of ['pointerup', 'pointercancel', 'pointerleave']) el.addEventListener(type, cancel);
  el.addEventListener('keydown', () => { firedByTimer = false; touchGesture = false; });

  el.addEventListener('contextmenu', ev => {
    if (touchOnly && !touchGesture) return;
    ev.preventDefault();
    if (firedByTimer) return; // 本次手势的计时器刚触发过（Android 长按双信号），不重复弹
    // 主键还按着（计时未到时 Android 先发了 contextmenu）同样会有抬手 click，一并拦；桌面右键不派发 click
    if (timer !== null) armClickGuard();
    cancel();
    onLongPress(ev);
  });
}
