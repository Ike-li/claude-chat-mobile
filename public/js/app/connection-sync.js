import { formatRttMs, rttToneClass } from '../logic.js';

const TONE_CLASSES = {
  good: 'text-success',
  ok: 'text-ink-soft',
  warn: 'text-warning',
  bad: 'text-danger',
};

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

  function clear() {
    const rtt = context.dom.connRtt;
    if (!rtt) return;
    rtt.textContent = '';
    rtt.className = 'hidden text-[10px] font-mono tabular-nums leading-none select-none';
    if (context.dom.connDotWrap) context.dom.connDotWrap.title = '连接状态：绿=已连接 红=断开';
  }

  function render(milliseconds) {
    const rtt = context.dom.connRtt;
    if (!rtt) return '';
    const label = formatRttMs(milliseconds);
    if (!label) {
      clear();
      return '';
    }
    const toneClass = TONE_CLASSES[rttToneClass(milliseconds)] || 'text-ink-soft';
    rtt.textContent = label;
    rtt.className = `${toneClass} text-[10px] font-mono tabular-nums leading-none select-none`;
    rtt.title = `手机到主机往返延迟 ${label}`;
    if (context.dom.connDotWrap) context.dom.connDotWrap.title = `已连接 · 延迟 ${label}`;
    setStatus(`已连接 · ${label}`);
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

  return { clear, measure, render, start, stop };
}
