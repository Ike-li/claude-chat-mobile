import { formatRttMs, rttToneClass } from '../logic/format.js';
import { shouldShowRttChip } from '../logic/panel-state.js';
import { t } from '../i18n.js';

// good/ok 都用中性 ink-soft：健康延迟不与绿点抢 success 色；仅 warn/bad 上色告警。
// 芯片本身仅 warn/bad 显示（shouldShowRttChip）；好网数字仍写进连接点 title / 状态行。
const TONE_CLASSES = {
  good: 'text-ink-soft',
  ok: 'text-ink-soft',
  warn: 'text-warning',
  bad: 'text-danger',
};

// 顶栏胶囊基类：与 top-context-pill 同语汇（sunk 底 + 软边 + 圆角），尺寸更小；色阶由 tone class 叠上。
const RTT_CHIP_BASE = 'conn-rtt-chip tabular-nums leading-none select-none';

export function createRttMonitor(context, {
  pingTimeoutMs = 3000,
  intervalMs = 5000,
  setStatus = () => {},
} = {}) {
  const deps = context.dependencies;
  const setIntervalFn = deps.setInterval || globalThis.setInterval;
  const clearIntervalFn = deps.clearInterval || globalThis.clearInterval;
  const documentRef = deps.document || globalThis.document;
  const clock = deps.performance?.now
    ? () => deps.performance.now()
    : () => Date.now();
  let timer = null;
  let inFlight = false;
  let lastMs = null; // 最近一次成功测得的 RTT 数值；断线/清空归 null（服务状态面板经 last() 复用，不另发 ping）

  function clear() {
    lastMs = null;
    const rtt = context.dom.connRtt;
    if (!rtt) return;
    rtt.textContent = '';
    rtt.className = `hidden ${RTT_CHIP_BASE}`;
    if (context.dom.connDotWrap) context.dom.connDotWrap.title = t('连接状态：绿=已连接 红=断开');
  }

  function render(milliseconds) {
    const rtt = context.dom.connRtt;
    if (!rtt) return '';
    const label = formatRttMs(milliseconds);
    if (!label) {
      clear();
      return '';
    }
    lastMs = milliseconds;
    // 连接点 title + 状态行始终带延迟（排障用）；芯片只在差网出现，好网顶栏保持安静。
    if (context.dom.connDotWrap) context.dom.connDotWrap.title = `${t('已连接')} · ${t('延迟')} ${label}`;
    setStatus(`${t('已连接')} · ${t('延迟')} ${label}`);
    if (!shouldShowRttChip(milliseconds)) {
      rtt.textContent = '';
      rtt.title = `${t('手机到主机往返延迟')} ${label}`;
      rtt.className = `hidden ${RTT_CHIP_BASE}`;
      return label;
    }
    const toneClass = TONE_CLASSES[rttToneClass(milliseconds)] || 'text-ink-soft';
    // 人话前缀「延迟」：主界面可读；formatRttMs 仍只产出数值（42ms / 1.2s），便于单测与复用。
    rtt.textContent = `${t('延迟')} ${label}`;
    rtt.className = `${toneClass} ${RTT_CHIP_BASE}`;
    rtt.title = `${t('手机到主机往返延迟')} ${label}`;
    return label;
  }

  function measure() {
    const socket = context.socket;
    if (!socket?.connected || inFlight) return;
    inFlight = true;
    const startedAt = clock();
    socket.timeout(pingTimeoutMs).emit('conn:ping', {}, error => {
      inFlight = false;
      if (error || !socket.connected) return;
      render(clock() - startedAt);
    });
  }

  function stop() {
    if (timer) clearIntervalFn(timer);
    timer = null;
    inFlight = false;
  }

  function start() {
    stop();
    measure();
    timer = setIntervalFn(() => {
      if (documentRef?.visibilityState === 'hidden') return;
      measure();
    }, intervalMs);
  }

  return { clear, measure, render, start, stop, last: () => lastMs };
}
