// 打开配置面板时锁住背后主页面滚动（#messages / body），避免上滑把聊天内容顶穿面板。
// 关闭时还原；body 上挂 class 便于 CSS 兜底 + 测试探测。
// 关法：点遮罩 / Escape / 把手区下拉（位移或快甩）。
//
// 本控制器驱动两个同构的底部 sheet（配置按作用域拆开后）：
//   会话设置 #settingsSheet（入口=底栏模型/权限/思考强度三个 chip，随 composer 显隐）
//   通用设置 #generalSheet（侧栏底部入口，本机偏好 + 主机与服务，全局可达）
// 二者的开合/手势/滚动锁完全一样，故只参数化 DOM key，不复制第二份实现。
import { resolveSheetDragEnd } from '../logic/panel-state.js';

const SHEET_OPEN_CLASS = 'ccm-sheet-open';

// 默认指向会话设置那套 id——现有调用点与单测因此零改动。
const DEFAULT_KEYS = {
  sheet: 'settingsSheet',
  body: 'settingsSheetBody',
  scrim: 'settingsScrim',
  dragZone: 'settingsDragZone',
  close: 'settingsClose',
  trigger: 'btnSettings',
};

export function createSettingsController(context, {
  // 本控制器操作哪一组 DOM（见 DEFAULT_KEYS）。
  keys: keyOverrides = null,
  // 本 sheet 是否承载「提示音/震动/前台通知/推送预览/语言」这套本机偏好。拆分后它们全在通用设置里，
  // 会话设置传 false 跳过回填与开关绑定（那些 DOM 根本不在它的子树内）。
  syncPrefs = true,
  // 打开前的钩子：通用设置用它收掉可能还开着的会话设置，避免两层 sheet 叠着。
  // **必须走这个参数而不是在 app.js 侧包装 open()**，理由同下方 onOpen 的头注。
  beforeOpen = () => {},
  alerts,
  // ⑧ 推送内容预览：get/set 由 app.js 注入（读写 localStorage + set 时触发重新订阅，把新偏好带给服务端）。
  // 独立于 alerts（那是本地提示音/震动，不涉网络）；duck-typed 最小接口，settings.js 不需要认识整个
  // notifications 控制器。
  pushPreview = { get: () => false, set: () => {} },
  // ⑨ 语言偏好：get/set 由 app.js 注入；set 里写 storage + 提示刷新（不做响应式重渲，见 index.html 头注）。
  langPref = { get: () => 'zh', set: () => {} },
  autoBind = true,
  // 面板打开时的回调：给需要"每次打开重算"的动态段用（如推送订阅状态——权限可能在系统设置里被
  // 改过，渲染一次会过期）。**必须挂在这里而不是包装 open()**：trigger 按钮由下方 autoBind 直接绑到
  // 本控制器的 open，任何在 app.js 侧包装 open 的做法都不会被 trigger 触发（真机上整行空白的成因）。
  onOpen = () => {},
  haptic = () => {},
  // 可注入 document 方便单测；浏览器默认用全局 document
  doc = typeof document !== 'undefined' ? document : null,
  // 可注入 now() 方便速度测算单测
  now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
} = {}) {
  const dom = context.dom;
  const keys = { ...DEFAULT_KEYS, ...(keyOverrides || {}) };
  const sheetEl = () => dom[keys.sheet];
  const scrimEl = () => dom[keys.scrim];

  /** @type {null | {
   *   pointerId: number,
   *   startY: number,
   *   lastY: number,
   *   lastT: number,
   *   dy: number,
   *   velocityY: number,
   * }} */
  let drag = null;

  function lockBackgroundScroll() {
    doc?.documentElement?.classList?.add(SHEET_OPEN_CLASS);
    doc?.body?.classList?.add(SHEET_OPEN_CLASS);
  }

  function unlockBackgroundScroll() {
    doc?.documentElement?.classList?.remove(SHEET_OPEN_CLASS);
    doc?.body?.classList?.remove(SHEET_OPEN_CLASS);
  }

  function resetSheetMotion() {
    const sheet = sheetEl();
    if (!sheet) return;
    sheet.classList?.remove?.('is-dragging');
    // 单测 mock 可能无 style 对象
    if (sheet.style) {
      sheet.style.transform = '';
      sheet.style.transition = '';
    }
    if (scrimEl()?.style) scrimEl().style.opacity = '';
  }

  function syncPreferences() {
    if (!syncPrefs) return;
    const preferences = alerts.preferences();
    if (dom.prefAlertSound) dom.prefAlertSound.checked = !!preferences.sound;
    if (dom.prefAlertVibrate) dom.prefAlertVibrate.checked = !!preferences.vibrate;
    if (dom.prefAlertForeground) dom.prefAlertForeground.checked = !!preferences.foregroundComplete;
    if (dom.prefPushPreview) dom.prefPushPreview.checked = !!pushPreview.get();
    if (dom.prefLang) dom.prefLang.value = langPref.get();
  }

  function open() {
    try { beforeOpen(); } catch { /* 收另一个 sheet 失败不能让本面板打不开 */ }
    haptic('tap');
    alerts.ensureAudio?.();
    syncPreferences();
    // 内容区每次打开滚回顶部，避免上次停在底部再打开时「像丢了半截」
    if (dom[keys.body]) dom[keys.body].scrollTop = 0;
    else if (sheetEl()) sheetEl().scrollTop = 0;
    resetSheetMotion();
    sheetEl()?.classList.remove('translate-y-full');
    scrimEl()?.classList.remove('hidden');
    lockBackgroundScroll();
    try { onOpen(); } catch { /* 动态段渲染失败不能让面板打不开 */ }
  }

  function close() {
    haptic('tap');
    drag = null;
    resetSheetMotion();
    sheetEl()?.classList.add('translate-y-full');
    scrimEl()?.classList.add('hidden');
    unlockBackgroundScroll();
  }

  function bindToggle(element, key) {
    if (!element) return;
    element.onchange = () => {
      alerts.setPreference(key, element.checked);
      if (key === 'sound' && element.checked) {
        alerts.ensureAudio?.();
        alerts.playTone?.('success');
      }
      if (key === 'vibrate' && element.checked) haptic('success');
    };
  }

  function isOpen() {
    const sheet = sheetEl();
    return Boolean(sheet && !sheet.classList.contains('translate-y-full'));
  }

  function onKeydown(ev) {
    if (ev.key !== 'Escape') return;
    if (!isOpen()) return;
    ev.preventDefault();
    close();
  }

  // ── 把手区下拉关闭 ──────────────────────────────────────────
  // 只在 handle + 标题头（#settingsDragZone）启动；内容区滚动不受影响。
  function applyDragVisual(dy) {
    const sheet = sheetEl();
    if (!sheet) return;
    sheet.style.transform = `translateY(${dy}px)`;
    // 下拉时遮罩渐隐（底 0.4 ≈ Tailwind black/40）
    if (scrimEl()) {
      const opacity = Math.max(0, 1 - dy / 280);
      scrimEl().style.opacity = String(opacity);
    }
  }

  function onDragPointerDown(ev) {
    if (!isOpen()) return;
    if (ev.pointerType === 'mouse' && ev.button !== 0) return;
    // 标题行旁按钮（如 CLI 重读）不启动拖关，避免吞掉 click
    if (ev.target?.closest?.('button, a, input, select, textarea, [role="button"]')) return;
    const sheet = sheetEl();
    const zone = dom[keys.dragZone];
    if (!sheet || !zone) return;
    // 只认主触点
    if (drag) return;
    drag = {
      pointerId: ev.pointerId,
      startY: ev.clientY,
      lastY: ev.clientY,
      lastT: now(),
      dy: 0,
      velocityY: 0,
    };
    try { zone.setPointerCapture?.(ev.pointerId); } catch { /* ignore */ }
    sheet.classList.add('is-dragging');
    sheet.style.transition = 'none';
    // 不 preventDefault 在 down——留给 move 时再禁选中
  }

  function onDragPointerMove(ev) {
    if (!drag || ev.pointerId !== drag.pointerId) return;
    const nowTs = now();
    const y = ev.clientY;
    const dt = Math.max(1, nowTs - drag.lastT);
    // 瞬时速度（px/ms），EMA 平滑
    const instV = (y - drag.lastY) / dt;
    drag.velocityY = drag.velocityY * 0.6 + instV * 0.4;
    drag.lastY = y;
    drag.lastT = nowTs;
    // 只允许下拉（正方向）
    const dy = Math.max(0, y - drag.startY);
    drag.dy = dy;
    applyDragVisual(dy);
    if (dy > 0) ev.preventDefault?.();
  }

  function endDrag(ev) {
    if (!drag) return;
    if (ev && ev.pointerId !== drag.pointerId) return;
    const sheet = sheetEl();
    const zone = dom[keys.dragZone];
    const { dy, velocityY, pointerId } = drag;
    drag = null;
    try { zone?.releasePointerCapture?.(pointerId); } catch { /* ignore */ }
    if (!sheet) return;

    const decision = resolveSheetDragEnd({ dy, velocityY });
    if (decision === 'close') {
      // 从当前下拉位移继续滑出屏幕，避免「先弹回再关」的跳动
      sheet.classList.remove('is-dragging');
      sheet.style.transition = 'transform 0.22s ease-out';
      sheet.style.transform = 'translateY(100%)';
      if (scrimEl()) {
        scrimEl().style.transition = 'opacity 0.22s ease-out';
        scrimEl().style.opacity = '0';
      }
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        sheet.removeEventListener('transitionend', finish);
        close();
      };
      sheet.addEventListener('transitionend', finish);
      setTimeout(finish, 280);
      return;
    }
    // snap 回顶部（开启 transition 做回弹）
    sheet.classList.remove('is-dragging');
    sheet.style.transition = 'transform 0.2s ease-out';
    sheet.style.transform = 'translateY(0)';
    if (scrimEl()) {
      scrimEl().style.transition = 'opacity 0.2s ease-out';
      scrimEl().style.opacity = '1';
    }
    const clear = () => {
      sheet.removeEventListener('transitionend', clear);
      // 回弹结束后清 inline，交还给 Tailwind class 管
      if (!drag) {
        sheet.style.transform = '';
        sheet.style.transition = '';
        if (scrimEl()) {
          scrimEl().style.opacity = '';
          scrimEl().style.transition = '';
        }
      }
    };
    sheet.addEventListener('transitionend', clear);
    setTimeout(clear, 260);
  }

  function bindDragZone() {
    const zone = dom[keys.dragZone]
      || sheetEl()?.querySelector?.(`#${keys.dragZone}, .settings-drag-zone, .sheet-handle`)
      || null;
    if (!zone) return;
    // 缓存到 dom 以便 close/end 复用
    if (!dom[keys.dragZone]) dom[keys.dragZone] = zone;
    zone.addEventListener('pointerdown', onDragPointerDown);
    zone.addEventListener('pointermove', onDragPointerMove);
    zone.addEventListener('pointerup', endDrag);
    zone.addEventListener('pointercancel', endDrag);
    // 触摸滚动竞争：标记 touch-action:none 在 CSS
  }

  function bind() {
    // 包一层箭头函数而非直接 `= open`：onclick 会把 PointerEvent 当首参塞进来，未来给 open 加选项
    // 参数时会被事件对象污染。
    if (dom[keys.trigger]) dom[keys.trigger].onclick = () => open();
    // 关法：点遮罩 / Escape / 把手下拉；「完成」已去掉（改档即时生效，无需确认）
    if (scrimEl()) scrimEl().onclick = close;
    if (dom[keys.close]) dom[keys.close].onclick = close;
    doc?.addEventListener?.('keydown', onKeydown);
    bindDragZone();
    // 本机偏好这套开关只存在于通用设置里；会话设置的控制器 syncPrefs=false，不去抢绑同一批 DOM
    // （两个控制器都绑会互相覆盖 onchange，后建的赢——静默且难查）。
    if (!syncPrefs) return;
    bindToggle(dom.prefAlertSound, 'sound');
    bindToggle(dom.prefAlertVibrate, 'vibrate');
    bindToggle(dom.prefAlertForeground, 'foregroundComplete');
    if (dom.prefPushPreview) {
      dom.prefPushPreview.onchange = () => pushPreview.set(dom.prefPushPreview.checked);
    }
    if (dom.prefLang) {
      dom.prefLang.onchange = () => langPref.set(dom.prefLang.value);
    }
    if (dom.btnAlertPreview) {
      dom.btnAlertPreview.onclick = () => {
        alerts.ensureAudio?.();
        alerts.preview?.();
      };
    }
  }

  if (autoBind) bind();
  return {
    close,
    open,
    syncPreferences,
    isOpen,
    lockBackgroundScroll,
    unlockBackgroundScroll,
    // 供单测直接驱动手势
    _test: { onDragPointerDown, onDragPointerMove, endDrag, getDrag: () => drag },
  };
}
