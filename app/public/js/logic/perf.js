// logic/perf.js —— 启动 / 打开会话耗时埋点的纯计算（2026-10-31 性能改造 Stage 0）
//
// 红线同 logic.js barrel：只做数据→数据，不碰 DOM / window / performance / socket。
// 采集在 app/perf-trace.js，这里只负责把采到的数字归类、拼成一行日志。

const round = v => Math.round(v);

// 窗口 [from, to] 内的长任务（PerformanceObserver 'longtask'，时间同 performance.now() 口径）。
// 与窗口有重叠就算、按整段时长计：跨在点击前后的那个长任务，正是用户感到「点了没反应」的那一段。
export function summarizeLongTasks(tasks, from, to) {
  let count = 0, totalMs = 0, maxMs = 0;
  for (const task of Array.isArray(tasks) ? tasks : []) {
    const start = task?.start, duration = task?.duration;
    if (!Number.isFinite(start) || !Number.isFinite(duration)) continue;
    if (start + duration < from || start > to) continue;
    count++;
    totalMs += duration;
    if (duration > maxMs) maxMs = duration;
  }
  return { count, totalMs: round(totalMs), maxMs: round(maxMs) };
}

// Resource Timing 条目 → 走了缓存 / 304 重验 / 整份下载各几个。判据：transferSize 0 = 没上网；
// 只回了头（transferSize 比 body 还小，或浏览器给了 responseStatus 304，或传了字节而 body 报 0）= 重验；其余 = 下载。
// body 报 0 那条是 Chrome 的实测形状：预加载扫描器取的 head 资源，304 照报 responseStatus 200、body 0。
// transferSize 不是数字（浏览器不给）的只计总数，不猜。lastEndMs = 最后一个资源到齐的时刻。
export function summarizeResources(entries) {
  const out = { count: 0, cached: 0, revalidated: 0, fetched: 0, bytes: 0, lastEndMs: 0 };
  for (const entry of Array.isArray(entries) ? entries : []) {
    out.count++;
    if (Number.isFinite(entry?.responseEnd) && entry.responseEnd > out.lastEndMs) out.lastEndMs = entry.responseEnd;
    const transferSize = entry?.transferSize;
    if (!Number.isFinite(transferSize)) continue;
    out.bytes += transferSize;
    if (transferSize === 0) out.cached++;
    else if (entry.responseStatus === 304 || transferSize < entry.encodedBodySize || entry.encodedBodySize === 0) out.revalidated++;
    else out.fetched++;
  }
  out.lastEndMs = round(out.lastEndMs);
  return out;
}

const OPEN_SOURCE_LABELS = { tap: '点击', bind: '视图切入' };
// keep = 视图里已有的就是最新（DOM 缓存或服务端回放缓冲），没去拉磁盘历史
const OPEN_OUTCOME_LABELS = { keep: '不拉历史', empty: '空会话', error: '失败', superseded: '被切走' };
const OPEN_STEP_LABELS = { bind: '绑定视图', switch: '切换回执', sync: '同步回执', history: '历史回执', insert: '插入', older: '更早回执', backfill: '补齐更早', highlight: '高亮' };

// 服务端回执里带的 timing（扁平对象）：ms 是总耗时，其余键去掉 Ms 后缀原样列出，顺序同服务端。
function formatServerTiming(server) {
  if (!server || !Number.isFinite(server.ms)) return '';
  const parts = Object.entries(server)
    .filter(([key, value]) => key !== 'ms' && (Number.isFinite(value) || typeof value === 'string'))
    .map(([key, value]) => `${key.replace(/Ms$/, '')} ${Number.isFinite(value) ? round(value) : value}`);
  return `服务端 ${round(server.ms)}ms${parts.length ? `：${parts.join(' · ')}` : ''}`;
}

function formatOpenStepDetail(step) {
  const parts = [];
  if (typeof step.note === 'string' && step.note) parts.push(step.note);
  if (Number.isFinite(step.count)) parts.push(`${step.count} 条`);
  if (Number.isFinite(step.blocks)) parts.push(Number.isFinite(step.ms) ? `${step.blocks} 块，${round(step.ms)}ms` : `${step.blocks} 块`);
  const server = formatServerTiming(step.server);
  if (server) parts.push(server);
  return parts.length ? `（${parts.join('；')}）` : '';
}

// null = 浏览器不支持 longtask 观测；要和「观测了、0 次」分开写，否则会把没测当成不卡。
function formatLongTaskSummary(longTasks) {
  if (!longTasks) return '长任务 不可测';
  return `长任务 ${longTasks.count} 次 共 ${longTasks.totalMs}ms 最长 ${longTasks.maxMs}ms`;
}

// 打开会话一行：steps 的 t 都相对本次打开的起点，按到达顺序排；每段写相对上一段的增量，
// 这样一眼看出时间花在等哪个回执、还是花在前端建 DOM / 高亮上。
export function formatOpenPerfLine({ source, steps, end, longTasks } = {}) {
  const tags = [OPEN_SOURCE_LABELS[source] ?? source, OPEN_OUTCOME_LABELS[end?.outcome]].filter(Boolean);
  let prevT = 0;
  const segments = (Array.isArray(steps) ? steps : []).map(step => {
    const delta = round(step.t - prevT);
    prevT = step.t;
    return `${OPEN_STEP_LABELS[step.name] ?? step.name} +${delta}${formatOpenStepDetail(step)}`;
  });
  return `[PERF] 打开会话 ${round(end?.t ?? prevT)}ms（${tags.join(' · ')}）：${segments.join(' → ')}；${formatLongTaskSummary(longTasks)}`;
}

// 切回前台：页面没重新加载，从 visibilitychange→visible 起算到追平
const RESUME_OUTCOME_LABELS = { keep: '不拉历史', reload: '重拉历史', home: '停在首页', hidden: '又切走了', timeout: '30s 未追平', superseded: '被打断' };
const RESUME_STEP_LABELS = { connect: '连上', sync: '同步回执', history: '历史重画' };

export function formatResumePerfLine({ hiddenMs, connected, steps, end, longTasks } = {}) {
  const tags = [`离开 ${round((hiddenMs ?? 0) / 1000)}s`, connected ? '连接还在' : '断线重连', RESUME_OUTCOME_LABELS[end?.outcome] ?? end?.outcome];
  let prevT = 0;
  const segments = (Array.isArray(steps) ? steps : []).map(step => {
    const delta = round(step.t - prevT);
    prevT = step.t;
    return `${RESUME_STEP_LABELS[step.name] ?? step.name} +${delta}${formatOpenStepDetail(step)}`;
  });
  return `[PERF] 切回前台 ${round(end?.t ?? prevT)}ms（${tags.join(' · ')}）${segments.length ? `：${segments.join(' → ')}` : ''}；${formatLongTaskSummary(longTasks)}`;
}

const STARTUP_MARK_LABELS = {
  html: 'HTML 到齐', parsed: '解析完', appjs: 'app.js 开跑', dcl: 'DCL',
  connect: '连上', upgrade: '升级', instances: '首个 instances',
};

function formatStartupPoint(name, mark) {
  return `${STARTUP_MARK_LABELS[name] ?? name} ${round(mark.t)}${mark.transport ? `（${mark.transport}）` : ''}`;
}

function formatResourceSummary(resources) {
  if (!resources) return '一方资源 不可测';
  const { count, cached, revalidated, fetched, bytes, lastEndMs } = resources;
  return `一方资源 ${count} 个：缓存 ${cached} · 重验 ${revalidated} · 下载 ${fetched} · ${round(bytes / 1024)}KB · 最后到齐 ${lastEndMs}`;
}

// 启动一行：时间都是距导航开始的绝对 ms（performance.now() 口径），按发生先后排到就绪点为止。
// 资源只数一方的（同源脚本 / 样式），看的是二次启动有多少还在重验——那是往返次数的来源。
export function formatStartupPerfLine({ marks, ready, resources, longTasks } = {}) {
  const points = Object.entries(marks ?? {})
    .filter(([, mark]) => Number.isFinite(mark?.t))
    .sort(([, a], [, b]) => a.t - b.t)
    .map(([name, mark]) => formatStartupPoint(name, mark));
  points.push(`${ready.label} ${round(ready.t)}`);
  return `[PERF] 启动 ${round(ready.t)}ms（${ready.label}）：${points.join(' → ')}；${formatResourceSummary(resources)}；${formatLongTaskSummary(longTasks)}`;
}

export function formatLateStartupMark(name, mark) {
  return `[PERF] 启动后 ${formatStartupPoint(name, mark)}`;
}

// ---- 结构化记录：同一份数据给统计用（上报服务端，scripts/perf-report.js 按维度出分位值）----
// 中文行给人读，这里只留数字和枚举，时刻一律取整 ms。

const roundNumbers = detail => Object.fromEntries(Object.entries(detail ?? {}).map(([key, value]) => [key, Number.isFinite(value) ? round(value) : value]));

export function startupPerfRecord({ marks, ready, resources, longTasks, nav = null, discarded = false } = {}) {
  const times = {};
  for (const [name, mark] of Object.entries(marks ?? {})) if (Number.isFinite(mark?.t)) times[name] = round(mark.t);
  return {
    k: 'startup', total: round(ready.t), label: ready.label, nav, discarded, transport: marks?.connect?.transport ?? null,
    marks: times, res: resources ?? null, lt: longTasks ?? null,
  };
}

export function lateStartupPerfRecord(name, { t: at, ...detail }) {
  return { k: 'late', name, t: round(at), ...detail };
}

export function openPerfRecord({ source, steps, end, longTasks } = {}) {
  return {
    k: 'open', source, outcome: end?.outcome ?? null, total: round(end?.t ?? 0), lt: longTasks ?? null,
    steps: (Array.isArray(steps) ? steps : []).map(({ name, t: at, ...detail }) => ({ n: name, t: round(at), ...roundNumbers(detail) })),
  };
}

export function resumePerfRecord({ hiddenMs, connected, steps, end, longTasks } = {}) {
  const { k: _k, source: _source, ...open } = openPerfRecord({ steps, end, longTasks });
  return { k: 'resume', hiddenMs: round(hiddenMs ?? 0), connected: Boolean(connected), ...open };
}

// ---- 掉帧与点击响应（Long Animation Frames / Event Timing，Chrome 才有；采集在 app/perf-report.js）----

const LONG_FRAME_TOP_SCRIPTS = 3;
const SLOW_INTERACTION_MS = 200;
const SLOW_INTERACTION_TOP = 5;

// 同源只留路径（查询串是版本戳，没用）；扩展注入的脚本留协议和主机，一眼认出不是自己的代码
function shortenUrl(url, origin) {
  if (typeof url !== 'string' || !url) return null;
  try {
    const parsed = new URL(url);
    return parsed.origin === origin ? parsed.pathname : `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch { return url.split('?')[0]; }
}

// invoker 多是「DIV#messages.onscroll」「Window.requestIdleCallback」，整段脚本求值时是脚本地址
const shortenInvoker = (invoker, origin) => (typeof invoker !== 'string' || !invoker ? null
  : /^[a-z-]+:\/\//.test(invoker) ? shortenUrl(invoker, origin) : invoker.slice(0, 80));

// render / layout：这一帧花在渲染阶段（rAF + 样式排版绘制）、样式排版上的 ms；input：有用户输入在等这一帧
export function summarizeLongFrame(entry, { origin } = {}) {
  const end = entry.startTime + entry.duration;
  const untilEnd = at => (at > 0 ? round(end - at) : 0);
  const scripts = Array.isArray(entry.scripts) ? entry.scripts : [];
  return {
    k: 'frame', t: round(entry.startTime), dur: round(entry.duration), block: round(entry.blockingDuration ?? 0),
    render: untilEnd(entry.renderStart), layout: untilEnd(entry.styleAndLayoutStart), input: entry.firstUIEventTimestamp > 0,
    scriptsN: scripts.length,
    scripts: [...scripts].sort((a, b) => (b.duration ?? 0) - (a.duration ?? 0)).slice(0, LONG_FRAME_TOP_SCRIPTS).map(script => ({
      type: script.invokerType ?? null,
      inv: shortenInvoker(script.invoker, origin),
      src: shortenUrl(script.sourceURL, origin),
      fn: script.sourceFunctionName || null,
      pos: script.sourceCharPosition >= 0 ? script.sourceCharPosition : null,
      dur: round(script.duration ?? 0),
      forced: round(script.forcedStyleAndLayoutDuration ?? 0),
    })),
  };
}

// entries 是采集层摘出的普通对象（target 已换成「button#send」这样的标签，不带元素引用）。
// delay：等主线程空出来；proc：事件回调本身；present：回调完到画出来
export function summarizeInteractions(entries) {
  const byId = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!(entry?.interactionId > 0) || !Number.isFinite(entry.duration)) continue;
    const prev = byId.get(entry.interactionId);
    if (!prev || entry.duration > prev.duration) byId.set(entry.interactionId, entry);
  }
  if (!byId.size) return null;
  const list = [...byId.values()];
  const slow = list.filter(entry => entry.duration >= SLOW_INTERACTION_MS)
    .sort((a, b) => b.duration - a.duration)
    .slice(0, SLOW_INTERACTION_TOP)
    .map(entry => ({
      t: round(entry.startTime), dur: round(entry.duration), type: entry.name, target: entry.target ?? null,
      delay: round(entry.processingStart - entry.startTime),
      proc: round(entry.processingEnd - entry.processingStart),
      present: round(entry.startTime + entry.duration - entry.processingEnd),
    }));
  return { k: 'inputs', n: list.length, durs: list.map(entry => round(entry.duration)), slow };
}
