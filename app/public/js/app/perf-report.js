// app/perf-report.js —— 性能记录攒批上报服务端（logs:clientPerf，落成 ccm-server.log 的 [client-perf] 行）
//
// 手机上的耗时此前只能靠机主导出日志。这里把三路数据攒成一批，连上时发给服务端，scripts/perf-report.js
// 再按维度出分位值：perf-trace 的启动 / 打开会话 / 切回前台记录（record）；长帧（Long Animation Frames：
// 哪一帧卡了、卡在哪段脚本）；点击响应（Event Timing）。后两路 Chrome 才有，别的浏览器就没有这两项。
// 埋点做粗了自己就是卡顿源：只用浏览器自己产出条目的观察器，不轮询 rAF、不跑 JS 采样；只收小对象，
// 每批条数有上限，自己花的主线程时间记账并随批报上去。
import { summarizeInteractions, summarizeLongFrame } from '../logic/perf.js';

const SCHEMA = 1;
// 一批最多这么多条；断线时也只攒这么多，多的只计数（服务端单行有 32KB 上限）
const MAX_EVENTS = 50;
const MAX_FRAMES = 30;
// 一次点击会有 pointerdown / pointerup / click 好几条，汇总前的原始条目上限
const MAX_INTERACTION_ENTRIES = 300;
// 点击响应只记 ≥16ms 的（一帧），浏览器默认 104ms 会漏掉「有点钝」的那一档
const EVENT_DURATION_THRESHOLD = 16;
// 两次发送之间自己花的主线程时间超过这么多，就把观察器关掉（批里报 stopped），只留 perf-trace 的记录
const SELF_BUDGET_MS = 50;
// 定时发：等主线程空闲，最多等这么久。切后台 / pagehide 时 app.js 另外直接调 flush
const FLUSH_INTERVAL_MS = 30_000;
const IDLE_TIMEOUT_MS = 2_000;

// 「button#sendBtn」「div.msg-row in #messages」：认得出是哪一块就够了，不带文字内容
function targetLabel(el) {
  if (!el?.tagName) return null;
  const tag = el.tagName.toLowerCase();
  if (el.id) return `${tag}#${el.id}`.slice(0, 60);
  const firstClass = typeof el.className === 'string' ? el.className.trim().split(/\s+/)[0] : '';
  const ancestor = el.closest?.('[id]');
  return `${tag}${firstClass ? `.${firstClass}` : ''}${ancestor?.id ? ` in #${ancestor.id}` : ''}`.slice(0, 60);
}

// 设备和网络状况，每批现取（网络会变）。拿不到的字段为 null
function deviceContext(win) {
  const nav = win.navigator ?? {};
  const conn = nav.connection;
  return {
    standalone: win.matchMedia?.('(display-mode: standalone)').matches === true || nav.standalone === true,
    vw: win.innerWidth ?? null,
    vh: win.innerHeight ?? null,
    dpr: win.devicePixelRatio ?? null,
    cores: nav.hardwareConcurrency ?? null,
    mem: nav.deviceMemory ?? null,
    net: conn ? { type: conn.effectiveType ?? null, rtt: conn.rtt ?? null, down: conn.downlink ?? null, save: conn.saveData === true } : null,
  };
}

// build：资源版本戳（index.html 给每个模块打的 ?v=），对得上是哪一版前端
const ownBuild = () => { try { return new URL(import.meta.url).searchParams.get('v'); } catch { return null; } };

// dims：记录产生那一刻的维度（在首页还是会话里、会话是否正在跑），由 app.js 提供。
// persistStats：clientLogger 上次取以来的落盘代价（取完清零），所以只在真发出去时取
export function createPerfReporter({ emit, isConnected, dims = () => ({}), persistStats = () => null, clock = () => performance.now(), build = ownBuild(), win = globalThis }) {
  let events = [];
  let interactions = [];
  let dropped = {};
  let self = { ms: 0, n: 0 };
  let windowMs = 0;
  let stopped = null;
  const observers = [];

  function stop(reason) {
    stopped = reason;
    for (const observer of observers) { try { observer.disconnect(); } catch { /* 外部边界 */ } }
  }

  // 自己花的时间：每个入口量一次，记进本批的 self 和预算窗口
  const measured = fn => (...args) => {
    const startedAt = clock();
    try {
      return fn(...args);
    } finally {
      const ms = clock() - startedAt;
      self.ms += ms;
      self.n++;
      windowMs += ms;
      if (!stopped && windowMs > SELF_BUDGET_MS) stop('budget');
    }
  };

  function push(event) {
    if (events.length < MAX_EVENTS) events.push(event);
    else dropped[event.k] = (dropped[event.k] ?? 0) + 1;
  }

  const record = measured(rec => push({ ...rec, ...dims() }));

  // Performance API 是外部边界：不支持、observe 抛错都当没有这一路，不能让 app.js 顶层起不来。
  // buffered：观察器建起来之前的也补上，启动时那几帧正是要看的
  function observe(type, options, onEntries) {
    if (!win.PerformanceObserver?.supportedEntryTypes?.includes(type)) return;
    try {
      const observer = new win.PerformanceObserver(measured(list => { if (!stopped) onEntries(list.getEntries()); }));
      observer.observe({ type, buffered: true, ...options });
      observers.push(observer);
    } catch { /* 拿不到就没有这一路 */ }
  }

  const origin = win.location?.origin;
  let frames = 0;
  observe('long-animation-frame', {}, entries => {
    for (const entry of entries) {
      if (frames >= MAX_FRAMES) { dropped.frame = (dropped.frame ?? 0) + 1; continue; }
      frames++;
      push({ ...summarizeLongFrame(entry, { origin }), ...dims() });
    }
  });
  // 只留交互（interactionId > 0）；元素引用当场换成标签，不攒 DOM 节点
  observe('event', { durationThreshold: EVENT_DURATION_THRESHOLD }, entries => {
    for (const entry of entries) {
      if (!(entry.interactionId > 0)) continue;
      if (interactions.length >= MAX_INTERACTION_ENTRIES) { dropped.event = (dropped.event ?? 0) + 1; continue; }
      const { name, interactionId, startTime, duration, processingStart, processingEnd } = entry;
      interactions.push({ name, interactionId, startTime, duration, processingStart, processingEnd, target: targetLabel(entry.target) });
    }
  });

  const flush = measured(() => {
    windowMs = 0;
    if ((!events.length && !interactions.length) || !isConnected()) return;
    const inputs = summarizeInteractions(interactions);
    if (inputs) events.push({ ...inputs, ...dims() });
    const payload = { v: SCHEMA, ctx: { ...deviceContext(win), build }, events, self: stopped ? { ...self, stopped } : self };
    if (Object.keys(dropped).length) payload.dropped = dropped;
    const logPersist = persistStats();
    if (logPersist) payload.logPersist = logPersist;
    events = [];
    interactions = [];
    dropped = {};
    frames = 0;
    self = { ms: 0, n: 0 };
    emit(payload);
  });

  const whenIdle = fn => (win.requestIdleCallback ? win.requestIdleCallback(fn, { timeout: IDLE_TIMEOUT_MS }) : win.setTimeout?.(fn, 0));
  win.setInterval?.(() => whenIdle(() => flush()), FLUSH_INTERVAL_MS);

  return { record, flush };
}
