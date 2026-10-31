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
const OPEN_STEP_LABELS = { bind: '绑定视图', switch: '切换回执', sync: '同步回执', history: '历史回执', insert: '插入', backfill: '补齐更早', highlight: '高亮' };

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
