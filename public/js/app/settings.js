// 打开配置面板时锁住背后主页面滚动（#messages / body），避免上滑把聊天内容顶穿面板。
// 关闭时还原；body 上挂 class 便于 CSS 兜底 + 测试探测。
// 关法：点遮罩 / Escape / 把手区下拉（位移或快甩）。
import { resolveSheetDragEnd } from '../logic.js';

const SHEET_OPEN_CLASS = 'ccm-sheet-open';

export function createSettingsController(context, {
  alerts,
  autoBind = true,
  haptic = () => {},
  // 可注入 document 方便单测；浏览器默认用全局 document
  doc = typeof document !== 'undefined' ? document : null,
  // 可注入 now() 方便速度测算单测
  now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
} = {}) {
  const dom = context.dom;

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
    const sheet = dom.settingsSheet;
    if (!sheet) return;
    sheet.classList?.remove?.('is-dragging');
    // 单测 mock 可能无 style 对象
    if (sheet.style) {
      sheet.style.transform = '';
      sheet.style.transition = '';
    }
    if (dom.settingsScrim?.style) dom.settingsScrim.style.opacity = '';
  }

  function syncPreferences() {
    const preferences = alerts.preferences();
    if (dom.prefAlertSound) dom.prefAlertSound.checked = !!preferences.sound;
    if (dom.prefAlertVibrate) dom.prefAlertVibrate.checked = !!preferences.vibrate;
    if (dom.prefAlertForeground) dom.prefAlertForeground.checked = !!preferences.foregroundComplete;
  }

  function open() {
    haptic('tap');
    alerts.ensureAudio?.();
    syncPreferences();
    // 内容区每次打开滚回顶部，避免上次停在底部再打开时「像丢了半截」
    if (dom.settingsSheetBody) dom.settingsSheetBody.scrollTop = 0;
    else if (dom.settingsSheet) dom.settingsSheet.scrollTop = 0;
    resetSheetMotion();
    dom.settingsSheet?.classList.remove('translate-y-full');
    dom.settingsScrim?.classList.remove('hidden');
    lockBackgroundScroll();
  }

  function close() {
    haptic('tap');
    drag = null;
    resetSheetMotion();
    dom.settingsSheet?.classList.add('translate-y-full');
    dom.settingsScrim?.classList.add('hidden');
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
    return Boolean(dom.settingsSheet && !dom.settingsSheet.classList.contains('translate-y-full'));
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
    const sheet = dom.settingsSheet;
    if (!sheet) return;
    sheet.style.transform = `translateY(${dy}px)`;
    // 下拉时遮罩渐隐（底 0.4 ≈ Tailwind black/40）
    if (dom.settingsScrim) {
      const t = Math.max(0, 1 - dy / 280);
      dom.settingsScrim.style.opacity = String(t);
    }
  }

  function onDragPointerDown(ev) {
    if (!isOpen()) return;
    if (ev.pointerType === 'mouse' && ev.button !== 0) return;
    const sheet = dom.settingsSheet;
    const zone = dom.settingsDragZone;
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
    const t = now();
    const y = ev.clientY;
    const dt = Math.max(1, t - drag.lastT);
    // 瞬时速度（px/ms），EMA 平滑
    const instV = (y - drag.lastY) / dt;
    drag.velocityY = drag.velocityY * 0.6 + instV * 0.4;
    drag.lastY = y;
    drag.lastT = t;
    // 只允许下拉（正方向）
    const dy = Math.max(0, y - drag.startY);
    drag.dy = dy;
    applyDragVisual(dy);
    if (dy > 0) ev.preventDefault?.();
  }

  function endDrag(ev) {
    if (!drag) return;
    if (ev && ev.pointerId !== drag.pointerId) return;
    const sheet = dom.settingsSheet;
    const zone = dom.settingsDragZone;
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
      if (dom.settingsScrim) {
        dom.settingsScrim.style.transition = 'opacity 0.22s ease-out';
        dom.settingsScrim.style.opacity = '0';
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
    if (dom.settingsScrim) {
      dom.settingsScrim.style.transition = 'opacity 0.2s ease-out';
      dom.settingsScrim.style.opacity = '1';
    }
    const clear = () => {
      sheet.removeEventListener('transitionend', clear);
      // 回弹结束后清 inline，交还给 Tailwind class 管
      if (!drag) {
        sheet.style.transform = '';
        sheet.style.transition = '';
        if (dom.settingsScrim) {
          dom.settingsScrim.style.opacity = '';
          dom.settingsScrim.style.transition = '';
        }
      }
    };
    sheet.addEventListener('transitionend', clear);
    setTimeout(clear, 260);
  }

  function bindDragZone() {
    const zone = dom.settingsDragZone
      || dom.settingsSheet?.querySelector?.('#settingsDragZone, .settings-drag-zone, .sheet-handle')
      || null;
    if (!zone) return;
    // 缓存到 dom 以便 close/end 复用
    if (!dom.settingsDragZone) dom.settingsDragZone = zone;
    zone.addEventListener('pointerdown', onDragPointerDown);
    zone.addEventListener('pointermove', onDragPointerMove);
    zone.addEventListener('pointerup', endDrag);
    zone.addEventListener('pointercancel', endDrag);
    // 触摸滚动竞争：标记 touch-action:none 在 CSS
  }

  function bind() {
    if (dom.btnSettings) dom.btnSettings.onclick = open;
    // 关法：点遮罩 / Escape / 把手下拉；「完成」已去掉（改档即时生效，无需确认）
    if (dom.settingsScrim) dom.settingsScrim.onclick = close;
    if (dom.settingsClose) dom.settingsClose.onclick = close;
    doc?.addEventListener?.('keydown', onKeydown);
    bindDragZone();
    bindToggle(dom.prefAlertSound, 'sound');
    bindToggle(dom.prefAlertVibrate, 'vibrate');
    bindToggle(dom.prefAlertForeground, 'foregroundComplete');
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
