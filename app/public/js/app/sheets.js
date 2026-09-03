import { t } from '../i18n.js';

// 底部 sheet 的开合原语（焦点管理 + Tab 陷阱 + 导航层抬升）与建立其上的通用确认弹窗。
//
// 【为什么合成一个模块】appConfirm 只是 openSheet 的一个应用：它的 confirmResolve 与 sheet 的
// sheetFocusPrev/sheetKeyHandler 生命周期完全绑定（开=存焦点+挂键盘钩子，关=还焦点+摘钩子+兑现
// Promise），拆成两个模块只会让这三个状态跨文件互相 poke。
//
// 【去掉的一处认知泄漏】原实现里 openSheet/closeSheet 直接读 permModal/questionModal 判"是否
// 阻断态"、并在关闭 permModal 时伸手清审批模块的 arming 计时器——通用原语知道了两个具体业务弹窗。
// 现改为注入 blockingSheets()（哪些 sheet 算"等你答复"）与 onClosed(el)（关闭后的业务钩子），
// 本模块不再认识任何具体弹窗。
export function createSheetController(context, {
  $: byId,
  haptic = () => {},
  blockingSheets = () => [],
  onClosed = () => {},
  doc = document,
} = {}) {
  const confirmModal = byId('confirmModal'), confirmSheet = byId('confirmSheet');
  const confirmTitle = byId('confirmTitle'), confirmBody = byId('confirmBody');
  const confirmOk = byId('confirmOk'), confirmCancel = byId('confirmCancel');

  // UI-012：sheet 焦点管理（打开移焦、关闭还焦、Tab 陷阱）
  let sheetFocusPrev = null;
  let sheetKeyHandler = null;
  let confirmResolve = null;

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
    sheetFocusPrev = doc.activeElement;
    el.classList.remove('hidden');
    // Force reflow
    el.offsetHeight;
    el.classList.add('sheet-open');
    if (!el.getAttribute('role')) el.setAttribute('role', 'dialog');
    if (!el.getAttribute('aria-modal')) el.setAttribute('aria-modal', 'true');
    // 移焦到首个可聚焦控件（arming 结束后用户仍可 Tab）
    requestAnimationFrame(() => {
      const list = sheetFocusables(el);
      (list[0] || el).focus?.();
    });
    if (sheetKeyHandler) doc.removeEventListener('keydown', sheetKeyHandler, true);
    sheetKeyHandler = (e) => {
      if (e.key !== 'Tab' || !el.classList.contains('sheet-open')) return;
      const list = sheetFocusables(el);
      if (!list.length) return;
      const first = list[0], last = list[list.length - 1];
      if (e.shiftKey && doc.activeElement === first) {
        e.preventDefault(); last.focus();
      } else if (!e.shiftKey && doc.activeElement === last) {
        e.preventDefault(); first.focus();
      }
    };
    doc.addEventListener('keydown', sheetKeyHandler, true);
    syncNavEscapeLayer();
  }

  function closeSheet(el) {
    haptic('tap');
    el.classList.remove('sheet-open');
    onClosed(el); // 业务钩子：如审批弹窗需要清防误触 arming
    if (sheetKeyHandler) {
      doc.removeEventListener('keydown', sheetKeyHandler, true);
      sheetKeyHandler = null;
    }
    const prev = sheetFocusPrev;
    sheetFocusPrev = null;
    syncNavEscapeLayer(); // sheet-open 刚摘掉：若已无审批/提问挂起，导航层落回既有层级
    // Delay adding hidden class to let slide-down animation finish,
    // which takes around 300ms. E2E wait tasks wait up to 15s so 300ms is perfect.
    setTimeout(() => {
      if (!el.classList.contains('sheet-open')) {
        el.classList.add('hidden');
        try { prev?.focus?.({ preventScroll: true }); } catch { /* ignore */ }
      }
    }, 300);
  }

  // ---- 通用确认弹窗（替代原生 confirm，样式/开合对齐项目底部 sheet）----
  // Promise<boolean>：确定=true，取消按钮/点遮罩=false。已开着时再次调用直接 resolve(false)
  // （async handler await 期间连点的重入兜底），不排队不叠加。tone 只切三处配色，结构复用同一 DOM。
  const CONFIRM_TONES = {
    default: { border: 'var(--accent)', title: 'text-accent-deep', ok: 'bg-cta' },
    warning: { border: 'var(--warning)', title: 'text-warning', ok: 'bg-cta' },
    danger:  { border: 'var(--danger)',  title: 'text-danger',  ok: 'bg-danger' },
  };
  function appConfirm({ title, body, okText = t('确定'), tone = 'default' }) {
    if (!confirmModal || confirmResolve) return Promise.resolve(false);
    const toneStyle = CONFIRM_TONES[tone] || CONFIRM_TONES.default;
    confirmSheet.style.borderTopColor = toneStyle.border;
    confirmTitle.className = `${toneStyle.title} font-semibold mb-2`;
    confirmTitle.textContent = title;
    confirmBody.textContent = body || '';
    confirmBody.classList.toggle('hidden', !body);
    confirmOk.className = `flex-1 py-2.5 rounded-lg ${toneStyle.ok} text-white active:brightness-95 font-medium`;
    confirmOk.textContent = okText;
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
  if (confirmOk) confirmOk.onclick = () => settleConfirm(true);
  if (confirmCancel) confirmCancel.onclick = () => settleConfirm(false);
  // 点遮罩空白处 = 取消（对齐移动端 sheet 习惯；permModal 因审批语义不做，这里是普通确认、可以做）
  if (confirmModal) confirmModal.addEventListener('click', e => { if (e.target === confirmModal) settleConfirm(false); });

  const controller = { openSheet, closeSheet, appConfirm };
  context.state.sheets = controller;
  return controller;
}
