import { t } from '../i18n.js';
import { resolveSheetDragEnd } from '../logic/panel-state.js';
import { focusInto } from './focus-layers.js';
import { acquireSheetScrollLock, releaseSheetScrollLock } from './sheet-scroll-lock.js';

// 底部 sheet 的开合原语（焦点管理 + Tab 陷阱 + Esc 关闭 + 导航层抬升 + 背景滚动锁 + 把手下拉）与建立其上的通用确认弹窗。
//
// 【为什么合成一个模块】appConfirm 只是 openSheet 的一个应用：它的 confirmResolve 与 sheet 的
// sheetFocusPrev/sheetKeyHandler 生命周期完全绑定（开=存焦点+挂键盘钩子，关=还焦点+摘钩子+兑现
// Promise），拆成两个模块只会让这三个状态跨文件互相 poke。
//
// 【去掉的一处认知泄漏】原实现里 openSheet/closeSheet 直接读 permModal/questionModal 判"是否
// 阻断态"、并在关闭 permModal 时伸手清审批模块的 arming 计时器——通用原语知道了两个具体业务弹窗。
// 现改为注入 blockingSheets()（哪些 sheet 算"等你答复"）与 onClosed(el)（关闭后的业务钩子），
// 本模块不再认识任何具体弹窗。
//
// 【#399】与 settings.js 仍是两套控制器（完整合并另开 PR）。本模块补齐三处分裂：
//   1) 有 .sheet-handle 的面板绑定下拉关闭；强拦截弹窗在 HTML 里去掉假把手。
//   2) 打开时 acquireSheetScrollLock，栈空时 release（与设置面板共用引用计数）。
//   3) 初始焦点走 focusInto(容器)，不再强行打到第一个子控件。
export function createSheetController(context, {
  $: byId,
  haptic = () => {},
  blockingSheets = () => [],
  onClosed = () => {},
  doc = document,
  now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
} = {}) {
  const confirmModal = byId('confirmModal'), confirmSheet = byId('confirmSheet');
  const confirmTitle = byId('confirmTitle'), confirmBody = byId('confirmBody');
  const confirmOk = byId('confirmOk'), confirmCancel = byId('confirmCancel'), confirmAlt = byId('confirmAlt');

  // UI-012：sheet 焦点管理（打开移焦、关闭还焦、Tab 陷阱）。
  // 栈式而非单槽位——appConfirm 会在已开着的业务 sheet（如 #workspaceModal）之上再开一层
  // （如「放弃未保存的修改？」）。单槽位下内层关闭会把外层的 keydown 监听器一并摘掉
  // （变量被内层开启时覆盖，内层 close 时置 null），外层就此永久失去 Tab 陷阱，直到重新打开。
  let sheetStack = []; // { el, focusPrev, keyHandler }
  // 已关、收起动画（300ms）还没走完、还没还焦的层：{ el, focusPrev }。见 openSheet 的接力。
  let closingSheets = [];
  let confirmResolve = null;
  // 手势关闭钩子：默认 closeSheet(el)；工作区 / 服务状态等需要走自己的 close（丢弃确认、退回设置）。
  const gestureDismiss = new WeakMap(); // el -> () => void
  const gestureBound = new WeakSet();
  /** @type {null | {
   *   el: Element,
   *   card: Element,
   *   handle: Element,
   *   pointerId: number,
   *   startY: number,
   *   lastY: number,
   *   lastT: number,
   *   dy: number,
   *   velocityY: number,
   * }} */
  let drag = null;

  function sheetFocusables(root) {
    return [...root.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
      .filter(n => !n.disabled && n.offsetParent !== null);
  }

  // 审批/提问挂起时把导航层（顶栏 + 侧栏）抬到 sheet 之上——这两类 sheet 是「等你答复」而不是
  // 「阻断一切」：A 会话弹审批就切不到 B 会话，等于把多会话并发这个核心场景锁死。
  // 只在挂起期间临时抬升，不动静态层级——deviceRequests 等页面级提示的既有层级契约
  // （header < cards < modal，P0-15g）因此不受影响。
  function syncNavEscapeLayer() {
    const blocking = blockingSheets().some(el => el?.classList.contains('sheet-open'));
    doc.body.classList.toggle('nav-escape', blocking);
  }

  function openSheet(el) {
    haptic('tap');
    let focusPrev = doc.activeElement;
    // 接力：焦点还停在一层正在收起的 sheet 里（抽屉会话行「⋯」菜单点「删除」：先收菜单、再开确认）。
    // 本层关闭时该还的是那层当初的触发按钮，不是那层里的项——那层到时已 display:none，接不住焦点，会丢到 body。
    // 那层到点还焦时不抢本层的焦点，见 closeSheet。
    const relay = closingSheets.find(c => c.el.contains?.(focusPrev));
    if (relay) focusPrev = relay.focusPrev;
    const wasEmpty = sheetStack.length === 0;
    // 已在栈里（开着时又被 open 一次）只重做视觉：再压一条会让栈永远清不空，滚动锁随之永不释放
    const alreadyOpen = sheetStack.some(s => s.el === el);
    el.classList.remove('hidden');
    // #369：CSS 过渡认 .ccm-sheet，不认 ID 白名单；HTML 已标类，这里再补一次防漏标新面板。
    el.classList.add('ccm-sheet');
    // Force reflow
    el.offsetHeight;
    el.classList.add('sheet-open');
    if (!el.getAttribute('role')) el.setAttribute('role', 'dialog');
    if (!el.getAttribute('aria-modal')) el.setAttribute('aria-modal', 'true');
    // #399：焦点放到容器本身（tabindex=-1），不放第一个控件——与 focus-layers.js / settings.js 对齐；
    // 第一个若是输入框会在手机上直接弹键盘；容器带 aria-label 时读屏照样念标题。
    requestAnimationFrame(() => {
      try { focusInto(el); } catch { /* 单测桩可能无 focus */ }
    });
    // 每层自己的 handler，只在自己的 sheet-open 期间生效——同时挂多个不冲突：非本层的 Tab
    // 事件命中不了本层的 first/last，直接 no-op（见上方模块注释）。
    // #380：同一套 keydown 顺带处理 Esc——只关栈顶、走 requestGestureDismiss（含业务自定义 close），
    // 审批/提问经 blockingSheets() 排除（不静默关、也不代点批准/拒绝）。
    const keyHandler = (e) => {
      if (!el.classList.contains('sheet-open')) return;
      if (e.key === 'Escape') {
        if (sheetStack[sheetStack.length - 1]?.el !== el) return; // 只关栈顶一层
        e.preventDefault();
        if (blockingSheets().some(b => b === el)) return; // 等你答复：Esc 不是取消
        requestGestureDismiss(el);
        return;
      }
      if (e.key !== 'Tab') return;
      const list = sheetFocusables(el);
      if (!list.length) return;
      const first = list[0], last = list[list.length - 1];
      // 焦点在容器本身（focusInto）时，Tab 应进入第一个控件；Shift+Tab 从首个回到容器则循环到末尾。
      if (e.shiftKey && (doc.activeElement === first || doc.activeElement === el)) {
        e.preventDefault(); last.focus();
      } else if (!e.shiftKey && doc.activeElement === last) {
        e.preventDefault(); first.focus();
      } else if (!e.shiftKey && doc.activeElement === el) {
        e.preventDefault(); first.focus();
      }
    };
    if (!alreadyOpen) {
      doc.addEventListener('keydown', keyHandler, true);
      sheetStack.push({ el, focusPrev, keyHandler });
      if (wasEmpty) acquireSheetScrollLock(doc);
    }
    syncNavEscapeLayer();
    ensureGestureDismiss(el);
  }

  function closeSheet(el) {
    haptic('tap');
    if (drag?.el === el) {
      resetDragVisual(drag);
      drag = null;
    }
    el.classList.remove('sheet-open');
    onClosed(el); // 业务钩子：如审批弹窗需要清防误触 arming
    const idx = sheetStack.findIndex(s => s.el === el);
    const entry = idx >= 0 ? sheetStack[idx] : null;
    if (idx >= 0) sheetStack.splice(idx, 1);
    if (entry) doc.removeEventListener('keydown', entry.keyHandler, true);
    // 只有真从栈里摘下一层、且摘空了才还锁：给一个本来就没开着的 sheet 再关一次（别处已答掉的审批、
    // 拖关动画期间又点了遮罩）不得把设置面板还持有的那份锁一并扣掉
    if (entry && sheetStack.length === 0) releaseSheetScrollLock(doc);
    syncNavEscapeLayer(); // sheet-open 刚摘掉：若已无审批/提问挂起，导航层落回既有层级
    // Delay adding hidden class to let slide-down animation finish,
    // which takes around 300ms. E2E wait tasks wait up to 15s so 300ms is perfect.
    const pending = { el, focusPrev: entry?.focusPrev };
    closingSheets.push(pending);
    setTimeout(() => {
      closingSheets = closingSheets.filter(c => c !== pending);
      if (!el.classList.contains('sheet-open')) {
        el.classList.add('hidden');
        // 这 300ms 里焦点已进了另一层开着的 sheet（接力开的确认框）：不抢——还回去的触发按钮压在它后面，
        // 之后 Tab / 回车都落在模态层背后（Codex review #407）
        const focusInOpenSheet = sheetStack.some(s => s.el !== el && s.el.classList.contains('sheet-open') && s.el.contains?.(doc.activeElement));
        if (!focusInOpenSheet) {
          try { pending.focusPrev?.focus?.({ preventScroll: true }); } catch { /* ignore */ }
        }
      }
    }, 300);
  }

  // ── 把手下拉关闭（#399）──────────────────────────────────────
  // 只绑还画着 .sheet-handle 的面板；强拦截审批/提问/确认在 HTML 里已去掉假把手。
  // 视觉跟手作用在卡片（el.firstElementChild），与 sheet-open > div 的 translateY 过渡同层。
  function cardOf(el) {
    return el?.firstElementChild || el;
  }

  function applyDragVisual(state, dy) {
    const card = state.card;
    if (!card?.style) return;
    card.style.transform = `translateY(${dy}px)`;
    // 遮罩渐隐：外层是 bg-black/40 的 backdrop
    if (state.el?.style) {
      const opacity = Math.max(0, 1 - dy / 280);
      state.el.style.opacity = String(opacity);
    }
  }

  function resetDragVisual(state) {
    if (!state) return;
    state.el?.classList?.remove?.('is-dragging');
    if (state.card?.style) {
      state.card.style.transform = '';
      state.card.style.transition = '';
    }
    if (state.el?.style) {
      state.el.style.opacity = '';
      state.el.style.transition = '';
    }
  }

  function requestGestureDismiss(el) {
    const custom = gestureDismiss.get(el);
    if (custom) {
      try { custom(); } catch { /* 业务 close 失败不能卡死把手 */ }
      return;
    }
    closeSheet(el);
  }

  function onDragPointerDown(ev, el, handle) {
    if (!el.classList.contains('sheet-open')) return;
    if (ev.pointerType === 'mouse' && ev.button !== 0) return;
    if (ev.target?.closest?.('button, a, input, select, textarea, [role="button"]')) return;
    if (drag) return;
    const card = cardOf(el);
    drag = {
      el,
      card,
      handle,
      pointerId: ev.pointerId,
      startY: ev.clientY,
      lastY: ev.clientY,
      lastT: now(),
      dy: 0,
      velocityY: 0,
    };
    try { handle.setPointerCapture?.(ev.pointerId); } catch { /* ignore */ }
    el.classList.add('is-dragging');
    if (card?.style) card.style.transition = 'none';
    if (el.style) el.style.transition = 'none';
  }

  function onDragPointerMove(ev) {
    if (!drag || ev.pointerId !== drag.pointerId) return;
    const nowTs = now();
    const y = ev.clientY;
    const dt = Math.max(1, nowTs - drag.lastT);
    const instV = (y - drag.lastY) / dt;
    drag.velocityY = drag.velocityY * 0.6 + instV * 0.4;
    drag.lastY = y;
    drag.lastT = nowTs;
    const dy = Math.max(0, y - drag.startY);
    drag.dy = dy;
    applyDragVisual(drag, dy);
    if (dy > 0) ev.preventDefault?.();
  }

  function endDrag(ev) {
    if (!drag) return;
    if (ev && ev.pointerId !== drag.pointerId) return;
    const state = drag;
    drag = null;
    try { state.handle?.releasePointerCapture?.(state.pointerId); } catch { /* ignore */ }
    const { el, card, dy, velocityY } = state;
    const decision = resolveSheetDragEnd({ dy, velocityY });
    if (decision === 'close') {
      el.classList.remove('is-dragging');
      if (card?.style) {
        card.style.transition = 'transform 0.22s ease-out';
        card.style.transform = 'translateY(100%)';
      }
      if (el.style) {
        el.style.transition = 'opacity 0.22s ease-out';
        el.style.opacity = '0';
      }
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        card?.removeEventListener?.('transitionend', finish);
        resetDragVisual(state);
        requestGestureDismiss(el);
      };
      card?.addEventListener?.('transitionend', finish);
      setTimeout(finish, 280);
      return;
    }
    // snap 回顶部
    el.classList.remove('is-dragging');
    if (card?.style) {
      card.style.transition = 'transform 0.2s ease-out';
      card.style.transform = 'translateY(0)';
    }
    if (el.style) {
      el.style.transition = 'opacity 0.2s ease-out';
      el.style.opacity = '1';
    }
    const clear = () => {
      card?.removeEventListener?.('transitionend', clear);
      if (!drag) resetDragVisual(state);
    };
    card?.addEventListener?.('transitionend', clear);
    setTimeout(clear, 260);
  }

  function ensureGestureDismiss(el) {
    if (!el || gestureBound.has(el)) return;
    const handle = el.querySelector?.('.sheet-handle');
    if (!handle) return; // 无把手 = 不可手势关闭（审批/提问/确认）
    gestureBound.add(el);
    handle.addEventListener('pointerdown', (ev) => onDragPointerDown(ev, el, handle));
    handle.addEventListener('pointermove', onDragPointerMove);
    handle.addEventListener('pointerup', endDrag);
    handle.addEventListener('pointercancel', endDrag);
  }

  // 业务侧覆盖手势关闭（工作区要走丢弃确认；服务状态/配置要退回设置页）。
  function setGestureDismiss(el, fn) {
    if (el && typeof fn === 'function') gestureDismiss.set(el, fn);
  }

  // ---- 通用确认弹窗（替代原生 confirm，样式/开合对齐项目底部 sheet）----
  // Promise<boolean>：确定=true，取消按钮/点遮罩=false。已开着时再次调用直接 resolve(false)
  // （async handler await 期间连点的重入兜底），不排队不叠加。tone 只切三处配色，结构复用同一 DOM。
  const CONFIRM_TONES = {
    default: { border: 'var(--accent)', title: 'text-accent-deep', ok: 'bg-cta' },
    warning: { border: 'var(--warning)', title: 'text-warning', ok: 'bg-cta' },
    danger:  { border: 'var(--danger)',  title: 'text-danger',  ok: 'bg-danger-solid' }, // 白字实底：深色 danger 为当文字而亮，压白字只剩 3.3（O102）
  };
  // altText 存在时多出一个次动作按钮，Promise 兑现成 'ok' | 'alt' | false（两个字符串都是 truthy，
  // 老调用点的 `if (!ok) return` 语义不变）；不传 altText 时行为与扩展前【逐字相同】——
  // 兑现 true/false，次按钮保持 hidden。这样两个动作能共用一次长按，不必为它新造一个 sheet。
  function appConfirm({ title, body, okText = t('确定'), altText = null, tone = 'default' }) {
    if (!confirmModal || confirmResolve) return Promise.resolve(false);
    const toneStyle = CONFIRM_TONES[tone] || CONFIRM_TONES.default;
    confirmSheet.style.borderTopColor = toneStyle.border;
    confirmTitle.className = `${toneStyle.title} font-semibold mb-2`;
    confirmTitle.textContent = title;
    confirmBody.textContent = body || '';
    confirmBody.classList.toggle('hidden', !body);
    confirmOk.className = `flex-1 py-2.5 rounded-lg ${toneStyle.ok} text-white active:brightness-95 font-medium`;
    confirmOk.textContent = okText;
    if (confirmAlt) {
      confirmAlt.classList.toggle('hidden', !altText);
      if (altText) confirmAlt.textContent = altText;
    }
    return new Promise(resolve => {
      confirmResolve = resolve;
      openSheet(confirmModal);
    });
  }
  function settleConfirm(ok) {
    if (!confirmResolve) return;
    const r = confirmResolve; confirmResolve = null;
    closeSheet(confirmModal);
    r(ok);
  }
  if (confirmOk) confirmOk.onclick = () => settleConfirm(confirmAlt && !confirmAlt.classList.contains('hidden') ? 'ok' : true);
  if (confirmAlt) confirmAlt.onclick = () => settleConfirm('alt');
  if (confirmCancel) confirmCancel.onclick = () => settleConfirm(false);
  // 点遮罩空白处 = 取消（对齐移动端 sheet 习惯；permModal 因审批语义不做，这里是普通确认、可以做）
  if (confirmModal) confirmModal.addEventListener('click', e => { if (e.target === confirmModal) settleConfirm(false); });
  // #380：Esc / 把手（若有）与点遮罩同义——兑现 false，避免裸 closeSheet 把 Promise 挂死
  if (confirmModal) setGestureDismiss(confirmModal, () => settleConfirm(false));

  const controller = {
    openSheet,
    closeSheet,
    appConfirm,
    setGestureDismiss,
    _test: { onDragPointerDown, onDragPointerMove, endDrag, getDrag: () => drag, ensureGestureDismiss },
  };
  context.state.sheets = controller;
  return controller;
}
