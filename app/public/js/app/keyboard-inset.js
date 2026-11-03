// iOS Safari 键盘弹起时 visualViewport 变化、layout viewport 不动，需补 footer padding 让输入区避开键盘。
// 决策（含负/错配/Android 不补 + 失焦回落）抽到 logic.js keyboardInsetPadding，此处只取值/接线。
// 失焦必复位是关键：点附件按钮唤起系统选择器会让输入框失焦、viewport 瞬时错配，旧实现会把一个大 inset
// 写死进 padding 留出半屏空白且无人复位（E17 附件回流 bug）；改为按焦点门控 + focusout 后重算自愈。
// #359 Step 5 从 app.js 原样迁出。
import { keyboardInsetPadding } from '../logic.js';

export function createKeyboardInset({ logClientEvent, scrollBottom } = {}) {
  // 附件选择器返回后主动重算键盘 inset（无 visualViewport 时为 no-op）
  let scheduleResettle = () => {};
  if (window.visualViewport) {
    const footer = document.querySelector('footer');
    const vv = window.visualViewport;
    const baseBottom = footer ? (parseFloat(getComputedStyle(footer).paddingBottom) || 0) : 0;
    const applyInset = () => {
      if (!footer) return;
      const ae = document.activeElement;
      const inputFocused = !!ae && (ae.tagName === 'TEXTAREA' || ae.tagName === 'INPUT');
      const pad = keyboardInsetPadding({
        innerHeight: window.innerHeight,
        viewportHeight: vv.height,
        viewportOffsetTop: vv.offsetTop,
        inputFocused,
        baseBottom,
      });
      // 诊断 tap（localStorage.ccm_debug_inset='1' 开启）：排查「附件回来后下半屏白屏」——
      // 读 innerHeight/vv.height/offsetTop/scrollY/focused/pad 定位是 viewport 未恢复(H1) 还是 scroll 卡滞(H2)。
      if (localStorage.getItem('ccm_debug_inset') === '1') {
        const line = `[inset] innerH=${window.innerHeight} vvH=${Math.round(vv.height)} offTop=${Math.round(vv.offsetTop)} scrollY=${window.scrollY} focused=${inputFocused} pad=${Math.round(pad)} base=${baseBottom}`;
        console.log(line);
        logClientEvent('conn', line); // client_conn 恒显，手机端可在日志抽屉直接看数值
      }
      footer.style.paddingBottom = pad + 'px';
      if (pad - baseBottom > 60) scrollBottom(); // 键盘明显占位才滚动到底，保证输入区可见
    };
    scheduleResettle = () => {
      // 附件选择器返回后 iOS 常不再补发 viewport resize，残留的键盘 inset 无人复位 → 半屏白屏（E17 回归）。
      // 主动在 viewport 恢复窗口内多次重算：此时键盘已被 picker 取代而消失，applyInset 读到真实 viewport → 回落 baseBottom。
      setTimeout(applyInset, 300);
      setTimeout(applyInset, 700);
    };
    vv.addEventListener('resize', applyInset);
    vv.addEventListener('scroll', applyInset);
    // 焦点变化（尤其附件选择器抢/还焦点）后重算：键盘收起即回落 baseBottom，消除残留空白。
    // focusout 延后一帧再算——等 activeElement / viewport 落定，避免读到过渡态。
    window.addEventListener('focusout', () => setTimeout(applyInset, 50));
    window.addEventListener('focusin', applyInset);
  }
  return { scheduleResettle };
}
