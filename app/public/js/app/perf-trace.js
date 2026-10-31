// app/perf-trace.js —— 启动 / 打开会话耗时埋点（2026-10-31 性能改造 Stage 0）
//
// 这里只管采集，归类和拼行在 logic/perf.js。结果经 clientLogger 写成 client_perf 行，机主在手机上
// 「复制全部」导出——性能改造每一步都拿它做改前改后的对照。
import { formatLateStartupMark, formatOpenPerfLine, formatStartupPerfLine, summarizeLongTasks, summarizeResources } from '../logic/perf.js';

// socket.io 轮询、接口请求不是静态资源，不算进「一方资源」
const NON_STATIC_INITIATORS = new Set(['xmlhttprequest', 'fetch', 'beacon']);
const STARTUP_FALLBACK_MS = 30_000;
// 只留最近这么多条：PWA 一开几天，不能无限涨；要汇总的窗口（启动、刚才那次打开）都在最近
const LONG_TASK_CAP = 200;

// Performance API 各浏览器实现参差，是外部边界：这里抛错会让 app.js 顶层起不来，拿不到就当不可测。
// 长任务（主线程被一段脚本占住 ≥50ms）。浏览器不支持时返回 null，日志写「不可测」。
// buffered：观察器建起来之前的也补上——app.js 是 module，跑到这里时 head 里的同步脚本早执行完了。
// 返回取数函数：已生成、还没回调到的条目（takeRecords）也一并取回。
function observeLongTasks(win) {
  if (!win.PerformanceObserver?.supportedEntryTypes?.includes('longtask')) return null;
  const tasks = [];
  const add = entries => {
    for (const entry of entries) tasks.push({ start: entry.startTime, duration: entry.duration });
    if (tasks.length > LONG_TASK_CAP) tasks.splice(0, tasks.length - LONG_TASK_CAP);
  };
  let observer;
  try {
    observer = new win.PerformanceObserver(list => add(list.getEntries()));
    observer.observe({ type: 'longtask', buffered: true });
  } catch { return null; }
  return () => { add(observer.takeRecords()); return tasks; };
}

function entriesByType(win, type) {
  try { return win.performance?.getEntriesByType?.(type) ?? null; } catch { return null; }
}

export function createPerfTrace({ log, now = () => performance.now(), win = globalThis } = {}) {
  const takeLongTasks = observeLongTasks(win);
  const longTasksIn = (from, to) => takeLongTasks && summarizeLongTasks(takeLongTasks(), from, to);
  // 收尾常落在长任务里（高亮完、首页列表画完），浏览器却要等这个任务跑完才生成它的条目：
  // 时刻当场记，汇总长任务和写行挪到下一个任务。每一行都走这里，先后顺序不乱
  const afterThisTask = fn => (win.setTimeout ? win.setTimeout(fn, 0) : fn());

  // ---- 启动 ----
  const marks = {};
  let startupLogged = false;

  // 同名只认第一次（重连还会再 connect）；启动行出过之后才到的（websocket 升级常晚于首页）单独成行
  function mark(name, detail) {
    if (marks[name]) return;
    marks[name] = { t: now(), ...detail };
    if (startupLogged) afterThisTask(() => log(formatLateStartupMark(name, marks[name])));
  }

  // 导航时间点，距导航开始的 ms；0 = 还没发生，不写
  function navigationMarks() {
    const nav = entriesByType(win, 'navigation')?.[0];
    const out = {};
    if (!nav) return out;
    for (const [name, at] of [['html', nav.responseEnd], ['parsed', nav.domInteractive], ['dcl', nav.domContentLoadedEventStart]]) {
      if (at > 0) out[name] = { t: at };
    }
    return out;
  }

  function firstPartyResources() {
    const entries = entriesByType(win, 'resource');
    if (!Array.isArray(entries)) return null;
    const prefix = `${win.location?.origin}/`;
    return summarizeResources(entries.filter(entry => entry.name?.startsWith(prefix) && !NON_STATIC_INITIATORS.has(entry.initiatorType)));
  }

  function startupReady(label) {
    if (startupLogged) return;
    startupLogged = true;
    const line = { marks: { ...navigationMarks(), ...marks }, ready: { t: now(), label }, resources: firstPartyResources() };
    afterThisTask(() => log(formatStartupPerfLine({ ...line, longTasks: longTasksIn(0, line.ready.t) })));
  }
  // 停在新会话页、首页列表卡住时没人报就绪：到点照样出一行，时间点照样有用
  win.setTimeout?.(() => startupReady('30s 未就绪'), STARTUP_FALLBACK_MS);

  // ---- 打开会话 ----
  // 当前这一次打开。步骤带 sid，对不上的（上一个会话还在画的那批、迟到的回执）一律不记。
  let open = null;

  function finishOpen(outcome) {
    const trace = open;
    open = null;
    const endT = now();
    afterThisTask(() => log(formatOpenPerfLine({ source: trace.source, steps: trace.steps, end: { t: endT - trace.begin, outcome }, longTasks: longTasksIn(trace.begin, endT) })));
  }

  // 上一次还没走完就开了新的：照样写出来、记成被切走——慢到用户放弃的那次正是要看的
  function openBegin(sid, source) {
    if (!sid) return;
    if (open) finishOpen('superseded');
    open = { sid, source, begin: now(), steps: [] };
  }

  // 点了这个会话、视图还没绑过来：并进这次点击（切换回执可能先于 instances 广播到）。
  // 否则就是没有点击起点的一次打开（启动恢复上次会话、从别处切进来、同会话换了实例），从这里起算。
  function openBind(sid, detail) {
    if (!sid) return;
    if (open?.sid === sid && !open.steps.some(step => step.name === 'bind')) {
      open.steps.push({ name: 'bind', t: now() - open.begin, ...detail });
      return;
    }
    if (open) finishOpen('superseded');
    open = { sid, source: 'bind', begin: now(), steps: [{ name: 'bind', t: 0, ...detail }] };
  }

  function openStep(sid, name, detail) {
    if (!sid || open?.sid !== sid) return;
    open.steps.push({ name, t: now() - open.begin, ...detail });
  }

  // 首次走完的打开也算启动就绪：启动时停在会话里就没有首页列表可等（被切走的不算，用户没等到）
  function openEnd(sid, outcome) {
    if (!sid || open?.sid !== sid) return;
    finishOpen(outcome);
    startupReady('会话就绪');
  }

  return {
    mark,
    startupReady,
    openBegin,
    openBind,
    openStep,
    openEnd,
  };
}
