// 页面顶部连接状态横幅：把「正在连接 / 断开重连中 / 已重新连接」从一个 3.5px 小圆点
// （#connDot）提升为一条可读的横幅。此前唯一的人话文案写给了恒 hidden 的 #statusLine，
// 用户看不到任何反馈——本模块只做接线，判定全在 logic.js resolveConnectionBanner。
//
// 相位由调用方用三个 mark* 显式推进（socket 的 connect/disconnect handler 各一行），
// 本模块不认识 socket，也不认识鉴权门——「是否该抑制」由 isSuppressed 注入。
//
// 定时器契约：只在「有东西要显示或即将要显示」时才跑 tick，稳定连接后 clearInterval 彻底停表。
// 移动端这个页面常驻，留一个 500ms interval 空转是白耗电。
import { resolveConnectionBanner } from '../logic/connection.js';
import { t } from '../i18n.js';

const BANNER_BASE = 'conn-banner shrink-0 flex items-center gap-2 px-3 py-1.5 text-xs';
const TONE_CLASSES = {
  info: 'conn-banner--info',
  warn: 'conn-banner--warn',
  success: 'conn-banner--success',
};

export function createConnectionBannerController(context, {
  onRetry = () => {},
  onToggle = () => {},
  isSuppressed = () => false,
  tickMs = 500,
} = {}) {
  const deps = context.dependencies || {};
  const setIntervalFn = deps.setInterval || globalThis.setInterval;
  const clearIntervalFn = deps.clearInterval || globalThis.clearInterval;
  const documentRef = deps.document || globalThis.document;
  const clock = deps.performance?.now
    ? () => deps.performance.now()
    : () => Date.now();

  let phase = 'connecting';   // 'connecting' | 'offline' | 'online'
  let phaseSince = clock();
  let visible = false;
  // 进入 online 那一刻横幅是否可见——决定要不要给「已重新连接」绿条。秒连不该闪一下。
  // 在 markConnected() 里快照，不在 tick 里反推 DOM。
  let wasVisibleOnConnect = false;
  let timer = null;

  function startTimer() {
    if (timer) return;
    timer = setIntervalFn(() => {
      // 切后台不做无谓 DOM 更新——但 online 相位必须放行：停表判定住在 render() 里，若在这里一并
      // 早退，恰好在绿条停留期锁屏就会把定时器落在后台无限长跑（正是本模块要避免的场景）。
      if (documentRef?.visibilityState === 'hidden' && phase !== 'online') return;
      render();
    }, tickMs);
  }

  function stopTimer() {
    if (timer) clearIntervalFn(timer);
    timer = null;
  }

  // 只在值真的变了才写 DOM。#connBanner 是 role="status"，而 role="status" 隐含 aria-live=polite
  // **且 aria-atomic=true**——区域内任何一次 childList 变动都会重播报整条。textContent 赋值即便字符串
  // 没变也会换掉 Text 节点，所以裸写会让读屏在一分钟断网里重播报上百次。顺带也省掉每 500ms 一次的
  // className 重写（每次都触发样式重算），抑制态下定时器空转的代价被压到接近零。
  function setText(el, value) {
    if (el && el.textContent !== value) el.textContent = value;
  }
  function setClass(el, value) {
    if (el && el.className !== value) el.className = value;
  }

  function apply(next) {
    const banner = context.dom.connBanner;
    if (!banner) return;
    const nowVisible = !!next;
    if (!nowVisible) {
      setClass(banner, `hidden ${BANNER_BASE}`);
    } else {
      setClass(banner, `${BANNER_BASE} ${TONE_CLASSES[next.tone] || TONE_CLASSES.info}`);
      setText(context.dom.connBannerText, t(next.label));
      const detail = context.dom.connBannerDetail;
      setText(detail, next.detail);
      setClass(detail, next.detail ? 'conn-banner__detail tabular-nums' : 'hidden conn-banner__detail tabular-nums');
      setClass(context.dom.connBannerSpinner, next.spinner ? 'animate-spin' : 'hidden animate-spin');
      const retry = context.dom.connBannerRetry;
      setText(retry, t('立即重试'));
      setClass(retry, next.retry ? 'conn-banner__retry' : 'hidden conn-banner__retry');
    }
    if (nowVisible !== visible) {
      visible = nowVisible;
      onToggle(nowVisible);  // app.js 据此补一次非 force 的 scrollBottom（不贴底会自动 no-op）
    }
  }

  function render() {
    const next = resolveConnectionBanner({
      phase,
      elapsedMs: clock() - phaseSince,
      suppressed: isSuppressed(),
      wasVisible: wasVisibleOnConnect,
    });
    apply(next);
    // online 相位下判定只会「从有到无」：wasVisible 已快照固定、elapsed 只增。一旦算出 null
    // 就再不会变回来 → 停表。秒连（从未显示过横幅）在第一次 render 就命中这里，不留空转定时器。
    if (phase === 'online' && !next) stopTimer();
  }

  function enter(nextPhase) {
    phase = nextPhase;
    phaseSince = clock();
    startTimer();
    render();
  }

  function markConnecting() { wasVisibleOnConnect = false; enter('connecting'); }
  function markDisconnected() { wasVisibleOnConnect = false; enter('offline'); }
  function markConnected() {
    // ★ 两个条件缺一不可，且快照必须在 enter() 之前——enter 会 render 并改写 visible/phase：
    //   visible：秒连从没显示过横幅，就别闪一下绿条；
    //   phase === 'offline'：绿条说的是「已重新连接」，只属于「断了又回来」。弱网/隧道下首次握手
    //     超过 800ms 是常见情形，那时横幅确实显示过「连接中…」，但从没连上过，不能说"重新"。
    wasVisibleOnConnect = visible && phase === 'offline';
    enter('online');
  }

  function stop() { stopTimer(); }

  const retryBtn = context.dom.connBannerRetry;
  if (retryBtn) retryBtn.onclick = () => onRetry();

  const controller = { markConnecting, markDisconnected, markConnected, stop, isVisible: () => visible };
  context.state.connBanner = controller;
  return controller;
}
