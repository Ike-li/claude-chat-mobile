// 键盘焦点分层：此刻哪些区域不该被 Tab 到（inert），以及层开合时把焦点移进去、交还回去。
//
// 【为什么需要】全屏门、设置面板、移动端抽屉收起时只是 hidden 了别人、或者把自己移出屏幕，
// 背后和屏幕外的控件照样能被 Tab 到、回车触发（验收 O74 / O77）。
//
// 【inert 按原因叠加】同一个元素可能同时因为两件事不可达：会话设置收起着（'closed'），又赶上令牌门
// 开着（'gate'）。只用一个布尔的话，令牌门一关就会把「收起」那份也摘掉，收起的面板重新能被 Tab 到。
// 原因集合记在元素自己的 data-inert-by 上，状态跟着 DOM 走，不另存一份会和 DOM 对不上的表。

// 与 sheets.js 判可聚焦的口径相同。
const FOCUSABLE_SELECTOR = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export function setInertReason(el, reason, on) {
  if (!el) return;
  const reasons = new Set((el.dataset.inertBy || '').split(' ').filter(Boolean));
  if (on) reasons.add(reason);
  else reasons.delete(reason);
  if (reasons.size) el.dataset.inertBy = [...reasons].join(' ');
  else delete el.dataset.inertBy;
  el.inert = reasons.size > 0;
}

function focusablesIn(root) {
  return [...root.querySelectorAll(FOCUSABLE_SELECTOR)].filter(n => !n.disabled && n.offsetParent !== null);
}

// 焦点放到容器本身（tabindex=-1），不放第一个控件：第一个控件若是输入框，手机上会直接弹出键盘。
// 容器带 aria-labelledby 时读屏照样念出标题，再按一次 Tab 就进第一个控件。
export function focusInto(root) {
  if (!root.hasAttribute('tabindex')) root.setAttribute('tabindex', '-1');
  root.focus({ preventScroll: true });
}

// 还焦点之前确认它还能接：仍在文档里、不在 inert 子树里、不是 body。
export function restoreFocus(el, doc) {
  if (!el || el === doc.body || !el.isConnected || el.closest('[inert]')) return;
  el.focus({ preventScroll: true });
}

// Tab 陷阱：焦点在 root 首尾时循环。焦点落在别的层（比如叠在上面的确认框）时不归这里管——
// 那一层有它自己的陷阱，这里抢回来就把人从确认框里拽走了。
export function trapTabIn(root, ev, doc) {
  const active = doc.activeElement;
  if (active !== root && active !== doc.body && !root.contains(active)) return;
  const list = focusablesIn(root);
  if (!list.length) { ev.preventDefault(); return; }
  const first = list[0], last = list[list.length - 1];
  if (ev.shiftKey && (active === first || active === root || active === doc.body)) {
    ev.preventDefault(); last.focus();
  } else if (!ev.shiftKey && (active === last || active === doc.body)) {
    ev.preventDefault(); first.focus();
  }
}

// 全屏门：令牌门、Access 重登、会话打不开落地页、等待授权、被拒、访问帮助。它们盖住整屏，背后的东西点不到，却仍能被
// Tab 到。最上面那层开着时，body 下其余子节点一律 inert。几层同为 z-50，谁在上面看 DOM 顺序——
// gates 按 DOM 顺序传，取最后一个开着的（会话打不开页是 z-20，仍按 DOM 序挂进同一列表）。
//
// 显隐由各处直接切 hidden class，散在十几个调用点；用 MutationObserver 盯 class，不要求每个调用点
// 都记得通知一声。不盯 body 的子节点增删：剪贴板兜底会临时往 body 挂一个 textarea 再 focus 它，
// 访问帮助里的「复制命令」走的就是这条路，把它也 inert 掉会让复制静默失败。
export function createGateFocusController({ gates, doc = document, Observer = globalThis.MutationObserver } = {}) {
  const layers = gates.filter(Boolean);
  let top = null;
  let focusBefore = null;

  function sync() {
    const open = layers.filter(el => !el.classList.contains('hidden'));
    const next = open[open.length - 1] || null;
    if (next === top) return;
    if (!top) focusBefore = doc.activeElement;
    top = next;
    for (const child of doc.body.children) setInertReason(child, 'gate', !!top && child !== top);
    if (top) {
      if (!top.contains(doc.activeElement)) focusInto(top);
    } else {
      restoreFocus(focusBefore, doc);
      focusBefore = null;
    }
  }

  if (Observer) {
    const observer = new Observer(sync);
    for (const el of layers) observer.observe(el, { attributes: true, attributeFilter: ['class'] });
  }
  sync();
  return { sync };
}
