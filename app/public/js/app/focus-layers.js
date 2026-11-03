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

// 全屏门：令牌门、Access 重登、等待授权、被拒、访问帮助。它们盖住整屏，背后的东西点不到，却仍能被
// Tab 到。最上面那层开着时，body 下其余子节点一律 inert。几层同为 z-50，谁在上面看 DOM 顺序——
// gates 按 DOM 顺序传，取最后一个开着的。
//
// 中层 aria-modal（overlays，如会话打不开落地页 z-20）不能塞进 gates：它比侧栏/审批 sheet 矮，
// 按「列表末开着的当顶」会把更高的 z-50 门盖错，也会把 leftSidebar（z-40）一起 inert 掉——
// 而落地页的设计就是「仍在侧栏之下，从这里要能直接翻会话列表」。overlays 单独一层，而且只 inert
// overlayCovers() 点名的那几块（它【实际盖住】的东西），不按「除了谁之外全部」：比它高的层——
// 设备授权卡（z-30）、抽屉、抽屉里弹的菜单与设置、各类 sheet——都是 body 子节点，排除法会把它们
// 一起变成「看得见、点不动」。overlayCovers 在每次打开时求值：桌面常驻侧栏（z-10）在落地页下面、
// 手机抽屉（z-40）在上面，同一个元素该不该 inert 取决于此刻的布局。真全屏门开着时仍走 gate。
//
// 显隐由各处直接切 hidden class，散在十几个调用点；用 MutationObserver 盯 class，不要求每个调用点
// 都记得通知一声。不盯 body 的子节点增删：剪贴板兜底会临时往 body 挂一个 textarea 再 focus 它，
// 访问帮助里的「复制命令」走的就是这条路，把它也 inert 掉会让复制静默失败。
export function createGateFocusController({
  gates,
  overlays = [],
  overlayCovers = () => [],
  doc = document,
  Observer = globalThis.MutationObserver,
} = {}) {
  const layers = gates.filter(Boolean);
  const midLayers = overlays.filter(Boolean);
  let top = null;
  let focusBefore = null;
  let covered = new Set();

  function sync() {
    const openGates = layers.filter(el => !el.classList.contains('hidden'));
    const topGate = openGates[openGates.length - 1] || null;
    const openOverlays = midLayers.filter(el => !el.classList.contains('hidden'));
    const topOverlay = openOverlays[openOverlays.length - 1] || null;
    // 全屏门压过中层落地页：两者同时开着时焦点与 inert 以门为准。
    const next = topGate || topOverlay || null;
    if (next === top) return;
    if (!top) focusBefore = doc.activeElement;
    const prevTop = top;
    top = next;
    for (const child of doc.body.children) setInertReason(child, 'gate', !!topGate && child !== topGate);
    // 仅无全屏门时才挂 overlay 原因；门一开就清掉（门盖住一切，由 gate 原因负责）。
    const nextCovered = new Set(!topGate && topOverlay ? overlayCovers().filter(el => el && el !== topOverlay) : []);
    for (const el of covered) if (!nextCovered.has(el)) setInertReason(el, 'overlay', false);
    for (const el of nextCovered) setInertReason(el, 'overlay', true);
    covered = nextCovered;
    if (top) {
      if (!top.contains(doc.activeElement)) focusInto(top);
    } else {
      // 关层的那段代码可能已经把焦点交给了别处（落地页「选择其他会话」：收起自己、再打开抽屉移焦）。
      // 焦点还在这一层里或已掉到 body，才轮到这里还焦——否则会把人从刚打开的抽屉里拽回顶栏。
      const active = doc.activeElement;
      if (!active || active === doc.body || prevTop?.contains(active)) restoreFocus(focusBefore, doc);
      focusBefore = null;
    }
  }

  if (Observer) {
    const observer = new Observer(sync);
    for (const el of [...layers, ...midLayers]) observer.observe(el, { attributes: true, attributeFilter: ['class'] });
  }
  sync();
  return { sync };
}
