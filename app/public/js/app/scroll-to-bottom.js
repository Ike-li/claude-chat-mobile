// 「回到最新」悬浮钮（#376）：上翻离开底部时出现，点一下 force 落底。
// 与未读胶囊分层——清除条件不同，文案与定位也不复用它的 bottom:84px。
// 状态放本模块，不在 app.js 顶层再散一组 let。逻辑文案见 logic/connection.js。

import {
  shouldShowScrollToBottom,
  resolveScrollToBottomNewCount,
  formatScrollToBottomLabel,
} from '../logic/connection.js';

const GAP_ABOVE_COMPOSER_PX = 12;

export function createScrollToBottomController({
  buttonEl,
  labelEl,
  messagesEl,
  composerFooterEl,
  countTopLevel = () => 0,
  onJump = () => {},
  isProgrammaticScroll = () => false,
  isEnabled = () => true,
} = {}) {
  let baselineCount = null; // null = 当前贴底（或尚未离开）
  let visible = false;
  let scrollCheckPending = false;
  let positionRaf = 0;

  function applyLabel(newCount) {
    if (!buttonEl) return;
    const { text, ariaLabel } = formatScrollToBottomLabel(newCount);
    if (labelEl) labelEl.textContent = text;
    else buttonEl.textContent = text;
    buttonEl.setAttribute('aria-label', ariaLabel);
  }

  function setVisible(next) {
    if (!buttonEl) return;
    if (next === visible) return;
    visible = next;
    buttonEl.classList.toggle('hidden', !visible);
  }

  function hideAndReset() {
    baselineCount = null;
    applyLabel(0);
    setVisible(false);
  }

  function positionAboveComposer() {
    if (!buttonEl) return;
    // composer 隐藏（空首页）时按钮也不该露；bottom 仍写一个合理回落以免闪一下错位。
    if (!composerFooterEl || composerFooterEl.classList.contains('hidden')) {
      buttonEl.style.bottom = `calc(84px + env(safe-area-inset-bottom))`;
      return;
    }
    const rect = composerFooterEl.getBoundingClientRect();
    const fromBottom = Math.max(0, window.innerHeight - rect.top) + GAP_ABOVE_COMPOSER_PX;
    buttonEl.style.bottom = `${fromBottom}px`;
  }

  function sync() {
    if (!buttonEl || !messagesEl) return;
    positionAboveComposer();
    if (!isEnabled()) {
      hideAndReset();
      return;
    }
    // 程序性落底（含本钮自己点下去的 force）期间不闪显、不钉新基线。
    if (isProgrammaticScroll()) {
      if (shouldShowScrollToBottom({
        scrollHeight: messagesEl.scrollHeight,
        scrollTop: messagesEl.scrollTop,
        clientHeight: messagesEl.clientHeight,
      })) {
        // 还在半空中的程序性滚动：保持现状，等真正停稳再判
        return;
      }
      hideAndReset();
      return;
    }

    const away = shouldShowScrollToBottom({
      scrollHeight: messagesEl.scrollHeight,
      scrollTop: messagesEl.scrollTop,
      clientHeight: messagesEl.clientHeight,
    });
    if (!away) {
      hideAndReset();
      return;
    }
    const current = countTopLevel();
    if (baselineCount == null) baselineCount = current;
    const newCount = resolveScrollToBottomNewCount(baselineCount, current);
    applyLabel(newCount);
    setVisible(true);
  }

  function scheduleSync() {
    if (scrollCheckPending) return;
    scrollCheckPending = true;
    requestAnimationFrame(() => {
      scrollCheckPending = false;
      sync();
    });
  }

  function schedulePosition() {
    if (positionRaf) return;
    positionRaf = requestAnimationFrame(() => {
      positionRaf = 0;
      positionAboveComposer();
    });
  }

  // 内容增高时 scroll 事件未必触发（scrollTop 不变），用 childList 观察补一次。
  let mo = null;
  if (messagesEl && typeof MutationObserver === 'function') {
    mo = new MutationObserver(() => {
      if (!visible && baselineCount == null) return; // 贴底时新增会走 stick 滚底，不必唤醒
      scheduleSync();
    });
    mo.observe(messagesEl, { childList: true });
  }

  if (messagesEl) {
    messagesEl.addEventListener('scroll', scheduleSync, { passive: true });
  }

  let ro = null;
  if (composerFooterEl && typeof ResizeObserver === 'function') {
    ro = new ResizeObserver(() => schedulePosition());
    ro.observe(composerFooterEl);
  }
  window.addEventListener('resize', schedulePosition, { passive: true });

  if (buttonEl) {
    buttonEl.addEventListener('click', () => {
      onJump();
      // force 落底后几何会贴底；立刻藏，避免等下一帧 scroll 事件才消失。
      hideAndReset();
    });
  }

  // 初始定位一次（按钮仍 hidden）
  positionAboveComposer();
  applyLabel(0);

  return {
    sync: scheduleSync,
    reset: hideAndReset,
    isVisible: () => visible,
    dispose() {
      mo?.disconnect();
      ro?.disconnect();
      window.removeEventListener('resize', schedulePosition);
    },
  };
}
