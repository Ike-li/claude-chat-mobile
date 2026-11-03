// client-perf-report.js —— 汇总 ccm-server.log 里的 [client-perf] 行（scripts/perf-report.js 的计算部分）。
// 行由 client-perf-log.js 写出：`<本地 ISO 时间> [client-perf] {"sid","ua","v":1,"ctx","events","self",...}`。
// 每张表先给「全部」，再按维度逐个拆开（一次只拆一个维度，不做交叉；只有一种取值的维度不拆，免得和「全部」重复）。
// 分位值取最近秩：样本少时 p90 就是最慢的那几次之一，n 一并列出，别拿 n=3 的 p90 下结论。
import { formatTimestamp } from '../shared/log-time.js';

const LINE = /^(\S+) \[client-perf\] (.*)$/;

const MARK_LABELS = { html: 'HTML 到齐', parsed: '解析完', appjs: 'app.js 开跑', dcl: 'DCL', connect: '连上', upgrade: '升级', instances: '首个 instances' };
const MARK_ORDER = Object.keys(MARK_LABELS);
const CACHE_ORDER = ['全缓存', '有重验', '有下载', '不可测'];
const OPEN_SOURCE_LABELS = { tap: '点击', bind: '视图切入' };
const OPEN_OUTCOME_LABELS = { done: '画完', keep: '不拉历史', empty: '空会话', error: '失败' };
const OPEN_STEP_LABELS = { bind: '绑定视图', switch: '切换回执', sync: '同步回执', history: '历史回执', older: '更早回执', insert: '插入', backfill: '补齐更早', highlight: '高亮' };
const RESUME_OUTCOME_LABELS = { keep: '不拉历史', reload: '重拉历史', home: '停在首页', timeout: '30s 未追平' };
const RESUME_STEP_LABELS = { connect: '连上', sync: '同步回执', history: '历史重画' };
// 没等到头用户就走开了：耗时不代表等了多久，不进表、只计数
const OPEN_EXCLUDED = new Set(['superseded']);
const RESUME_EXCLUDED = new Set(['hidden', 'superseded']);
const COUNT_ORDER = ['<100', '100–999', '≥1000', '未拉历史'];
const HIDDEN_ORDER = ['<1min', '1–10min', '10–60min', '≥1h'];
const TOP_SCRIPTS = 10;
const SLOW_INPUTS = 10;

// 「keep 不拉历史」：原名留着，日志里搜得到
const named = labels => value => `${value} ${labels[value] ?? ''}`.trim();
// 段名后缀 .server = 那个回执里服务端自己报的耗时，紧跟在该段后面列
const stepOrder = labels => Object.keys(labels).flatMap(name => [name, `${name}.server`]);
const stepLabel = labels => key => (key.endsWith('.server') ? `${key} ${labels[key.slice(0, -7)] ?? key.slice(0, -7)}·服务端` : named(labels)(key));

function stats(values, digits) {
  const sorted = [...values].sort((a, b) => a - b);
  const round = v => Math.round(v * 10 ** digits) / 10 ** digits;
  const at = p => sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
  return { n: sorted.length, p50: round(at(50)), p90: round(at(90)), max: round(sorted.at(-1)) };
}

// samples: [{ v: 数值, d: { 维度名: 取值 } }]；dims 按列出的顺序拆。取值排序：order 里有的按 order，其余按样本数多到少
// digits：埋点自身这类常在 1ms 以下的，取整就全成 0 了
function table(title, samples, dims, { overall = true, digits = 0 } = {}) {
  const rows = overall && samples.length ? [{ label: '全部', ...stats(samples.map(s => s.v), digits) }] : [];
  for (const { name, order = [], label = value => value } of dims) {
    const groups = new Map();
    for (const { v, d } of samples) {
      const value = d[name];
      if (value == null) continue;
      if (!groups.has(value)) groups.set(value, []);
      groups.get(value).push(v);
    }
    if (overall && groups.size < 2) continue;
    const rank = value => { const i = order.indexOf(value); return i < 0 ? order.length : i; };
    const sorted = [...groups].sort(([a, av], [b, bv]) => rank(a) - rank(b) || bv.length - av.length || String(a).localeCompare(String(b)));
    for (const [value, values] of sorted) rows.push({ label: `${name} ${label(value)}`, ...stats(values, digits) });
  }
  return { title, rows };
}

// iPhone 的 UA 里也有「like Mac OS X」、Android 的也有 Linux，所以按这个顺序认
function deviceClass(ua, standalone) {
  const s = typeof ua === 'string' ? ua : '';
  const os = /Android/.test(s) ? 'Android' : /iPhone/.test(s) ? 'iPhone' : /iPad/.test(s) ? 'iPad'
    : /Macintosh|Mac OS X/.test(s) ? 'Mac' : /Windows/.test(s) ? 'Windows' : /Linux/.test(s) ? 'Linux' : '其他';
  return `${os}·${standalone ? 'PWA' : '浏览器'}`;
}

function cacheState(res) {
  if (!res) return '不可测';
  if (res.fetched > 0) return '有下载';
  if (res.revalidated > 0) return '有重验';
  return '全缓存';
}

const isNum = v => Number.isFinite(v);
const yesNo = v => (v === true ? '是' : v === false ? '否' : null);

// 各段写相对上一段的增量（同前端 [PERF] 行），看时间花在等哪个回执、还是花在建 DOM 上
function pushSteps(steps, out) {
  let prevT = 0;
  for (const step of steps) {
    if (!isNum(step?.t) || typeof step.n !== 'string') continue;
    out.push({ v: step.t - prevT, d: { 段: step.n } });
    prevT = step.t;
    if (isNum(step.server?.ms)) out.push({ v: step.server.ms, d: { 段: `${step.n}.server` } });
  }
}

// 最近一段（history）加更早那段（older）一共拉了多少条
function countBucket(steps) {
  const fetched = steps.filter(step => (step?.n === 'history' || step?.n === 'older') && isNum(step.count));
  if (!fetched.length) return '未拉历史';
  const n = fetched.reduce((sum, step) => sum + step.count, 0);
  return n < 100 ? '<100' : n < 1000 ? '100–999' : '≥1000';
}

// 同一个函数（地址 + 函数名 + 字符位置）跨批合计；invoker 取最长那次的
function addScript(byKey, script) {
  if (!isNum(script?.dur)) return;
  const key = `${script.src ?? script.inv ?? '?'}${script.fn ? ` ${script.fn}` : ''}${isNum(script.pos) ? `@${script.pos}` : ''}`;
  const entry = byKey.get(key) ?? { key, type: null, inv: null, n: 0, totalMs: 0, maxMs: -Infinity };
  entry.n++;
  entry.totalMs += script.dur;
  if (script.dur > entry.maxMs) Object.assign(entry, { maxMs: script.dur, type: script.type ?? null, inv: script.inv ?? null });
  byKey.set(key, entry);
}

const hiddenBucket = ms => (ms < 60_000 ? '<1min' : ms < 600_000 ? '1–10min' : ms < 3_600_000 ? '10–60min' : '≥1h');

// lines：日志行（字符串）；since：毫秒时间戳，早于它的批不算
export function summarizeClientPerf(lines, { since = null } = {}) {
  let batches = 0, skipped = 0, from = null, to = null;
  const startupTotals = [], startupMarks = [], openTotals = [], openSteps = [], resumeTotals = [], resumeSteps = [];
  const frameDurs = [], frameBlocks = [], inputDurs = [], selfMs = [], persistMax = [];
  const excluded = { open: 0, resume: 0 };
  const scripts = new Map(), dropped = {}, slowInputs = [];
  let stopped = 0, logBytesMax = null;

  for (const text of lines) {
    const m = LINE.exec(text);
    if (!m) continue;
    const at = Date.parse(m[1]);
    let batch;
    try { batch = JSON.parse(m[2]); } catch { skipped++; continue; }
    if (!Number.isFinite(at) || !Array.isArray(batch?.events)) { skipped++; continue; }
    if (since != null && at < since) continue;
    batches++;
    from = from == null ? at : Math.min(from, at);
    to = to == null ? at : Math.max(to, at);

    const ctx = batch.ctx ?? {};
    const base = { 设备: deviceClass(batch.ua, ctx.standalone === true), 网络: ctx.net?.type ?? '未知' };
    if (isNum(batch.self?.ms)) selfMs.push({ v: batch.self.ms, d: base });
    if (batch.self?.stopped) stopped++;
    if (isNum(batch.logPersist?.maxMs)) persistMax.push({ v: batch.logPersist.maxMs, d: base });
    if (isNum(batch.logPersist?.bytes)) logBytesMax = Math.max(logBytesMax ?? 0, batch.logPersist.bytes);
    for (const [kind, n] of Object.entries(batch.dropped ?? {})) if (isNum(n)) dropped[kind] = (dropped[kind] ?? 0) + n;
    for (const event of batch.events) {
      if (event?.k === 'startup' && isNum(event.total)) {
        startupTotals.push({ v: event.total, d: { ...base, 缓存: cacheState(event.res), 导航: event.discarded ? '被回收后重开' : (event.nav ?? '未知'), 视图: event.view } });
        for (const [name, t] of Object.entries(event.marks ?? {})) if (isNum(t)) startupMarks.push({ v: t, d: { 点: name } });
      } else if (event?.k === 'late' && isNum(event.t) && typeof event.name === 'string') {
        startupMarks.push({ v: event.t, d: { 点: event.name } });
      } else if (event?.k === 'open' && isNum(event.total)) {
        if (OPEN_EXCLUDED.has(event.outcome)) { excluded.open++; continue; }
        const steps = Array.isArray(event.steps) ? event.steps : [];
        openTotals.push({ v: event.total, d: { ...base, 来源: event.source, 结果: event.outcome, 条数: countBucket(steps), 运行中: yesNo(event.busy) } });
        pushSteps(steps, openSteps);
      } else if (event?.k === 'resume' && isNum(event.total)) {
        if (RESUME_EXCLUDED.has(event.outcome)) { excluded.resume++; continue; }
        resumeTotals.push({ v: event.total, d: { ...base, 离开: hiddenBucket(event.hiddenMs ?? 0), 连接: event.connected ? '还在' : '断线重连', 结果: event.outcome, 视图: event.view, 运行中: yesNo(event.busy) } });
        pushSteps(Array.isArray(event.steps) ? event.steps : [], resumeSteps);
      } else if (event?.k === 'frame' && isNum(event.dur)) {
        const d = { ...base, 视图: event.view, 运行中: yesNo(event.busy), 等输入: yesNo(event.input) };
        frameDurs.push({ v: event.dur, d });
        if (isNum(event.block)) frameBlocks.push({ v: event.block, d });
        for (const script of Array.isArray(event.scripts) ? event.scripts : []) addScript(scripts, script);
      } else if (event?.k === 'inputs') {
        // 不按视图拆：inputs 的视图是发送那一刻的，不是点下去那一刻的
        for (const dur of Array.isArray(event.durs) ? event.durs : []) if (isNum(dur)) inputDurs.push({ v: dur, d: base });
        for (const slow of Array.isArray(event.slow) ? event.slow : []) if (isNum(slow?.dur)) slowInputs.push({ ...slow, device: base.设备, at });
      }
    }
  }

  const sections = [
    table('启动总耗时', startupTotals, [{ name: '设备' }, { name: '网络' }, { name: '缓存', order: CACHE_ORDER }, { name: '导航' }, { name: '视图' }]),
    table('启动各点（距导航开始）', startupMarks, [{ name: '点', order: MARK_ORDER, label: named(MARK_LABELS) }], { overall: false }),
    table('打开会话总耗时', openTotals, [{ name: '设备' }, { name: '网络' }, { name: '来源', label: named(OPEN_SOURCE_LABELS) }, { name: '结果', label: named(OPEN_OUTCOME_LABELS) }, { name: '条数', order: COUNT_ORDER }, { name: '运行中' }]),
    table('打开会话各段（相对上一段）', openSteps, [{ name: '段', order: stepOrder(OPEN_STEP_LABELS), label: stepLabel(OPEN_STEP_LABELS) }], { overall: false }),
    table('切回前台总耗时', resumeTotals, [{ name: '设备' }, { name: '网络' }, { name: '离开', order: HIDDEN_ORDER }, { name: '连接' }, { name: '结果', label: named(RESUME_OUTCOME_LABELS) }, { name: '视图' }, { name: '运行中' }]),
    table('切回前台各段（相对上一段）', resumeSteps, [{ name: '段', order: stepOrder(RESUME_STEP_LABELS), label: stepLabel(RESUME_STEP_LABELS) }], { overall: false }),
    table('长帧时长（≥50ms 的帧）', frameDurs, [{ name: '设备' }, { name: '视图' }, { name: '运行中' }, { name: '等输入' }]),
    table('长帧阻塞时长', frameBlocks, [{ name: '设备' }, { name: '视图' }, { name: '运行中' }, { name: '等输入' }]),
    table('点击响应（≥16ms 的交互）', inputDurs, [{ name: '设备' }, { name: '网络' }]),
    table('埋点自身（每批主线程 ms）', selfMs, [{ name: '设备' }], { digits: 1 }),
    table('日志落盘（每批最长一次 ms）', persistMax, [{ name: '设备' }], { digits: 1 }),
  ];
  return {
    batches, skipped, from, to, sections,
    topScripts: [...scripts.values()].sort((a, b) => b.totalMs - a.totalMs).slice(0, TOP_SCRIPTS).map(entry => ({ ...entry, totalMs: Math.round(entry.totalMs) })),
    slowInputs: slowInputs.sort((a, b) => b.dur - a.dur).slice(0, SLOW_INPUTS),
    notes: { excluded, stopped, logBytesMax, dropped },
  };
}

// 7d / 24h：从现在往前推；YYYY-MM-DD：那天的本地零点（日志时间戳也是本地时间）。认不出返回 null
export function parseSince(arg, now = Date.now()) {
  const relative = /^(\d+)([dh])$/.exec(arg ?? '');
  if (relative) return now - Number(relative[1]) * (relative[2] === 'd' ? 86_400_000 : 3_600_000);
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(arg ?? '');
  if (!day) return null;
  const [y, m, d] = day.slice(1).map(Number);
  const date = new Date(y, m - 1, d);
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d ? date.getTime() : null;
}

const when = ms => formatTimestamp(new Date(ms)).slice(0, 19).replace('T', ' ');
// 数字列在前、标签放最后：中文标签按字符数补空格对不齐
const col = (value, width = 7) => String(value).padStart(width);

export function formatClientPerfReport(report) {
  if (!report.batches) {
    return '日志里没有 [client-perf] 记录（或都早于 --since）。前端切到后台时、以及有新记录时每 30 秒发一批；'
      + '后端要重启到带 logs:clientPerf 的版本才会写进日志。';
  }
  const out = [
    `前端性能上报 ${report.batches} 批：${when(report.from)} → ${when(report.to)}${report.skipped ? `（另有 ${report.skipped} 行读不懂，已跳过）` : ''}`,
    '单位 ms。各表先「全部」，再一次按一个维度拆开；分位值取最近秩，n 小的 p90 只是最慢那几次。',
  ];
  for (const { title, rows } of report.sections) {
    out.push('', title);
    if (!rows.length) { out.push('  （无数据）'); continue; }
    out.push(`${col('n')}${col('p50')}${col('p90')}${col('max')}`);
    for (const r of rows) out.push(`${col(r.n)}${col(r.p50)}${col(r.p90)}${col(r.max)}  ${r.label}`);
  }

  out.push('', `卡在哪段脚本（长帧里按函数合计，前 ${TOP_SCRIPTS}）`);
  if (!report.topScripts.length) out.push('  （无数据）');
  else {
    out.push(`${col('合计', 5)}${col('次数', 5)}${col('最长', 5)}  函数 · 触发方式`);  // 中文一字占两列
    for (const s of report.topScripts) {
      const how = [s.type, s.inv].filter(Boolean).join(' ');
      out.push(`${col(s.totalMs)}${col(s.n)}${col(Math.round(s.maxMs))}  ${s.key}${how ? ` · ${how}` : ''}`);
    }
  }

  out.push('', `最慢的点击（前 ${SLOW_INPUTS}）`);
  if (!report.slowInputs.length) out.push('  （无数据）');
  for (const i of report.slowInputs) {
    out.push(`  ${i.dur}ms ${i.type ?? '?'} ${i.target ?? '?'}（等 ${i.delay} · 处理 ${i.proc} · 呈现 ${i.present}）${i.device} ${when(i.at)}`);
  }

  const { excluded, stopped, logBytesMax, dropped } = report.notes;
  const notes = [];
  if (excluded.open || excluded.resume) notes.push(`打开会话中途被切走 ${excluded.open} 次、切回前台没等追平就又切走或被打断 ${excluded.resume} 次，未计入上表`);
  if (stopped) notes.push(`埋点超出自身预算、关掉长帧与点击观测的批：${stopped}`);
  if (logBytesMax != null) notes.push(`前端日志单次落盘最大 ${Math.round(logBytesMax / 1024)}KB`);
  const drops = Object.entries(dropped);
  if (drops.length) notes.push(`因上限丢弃：${drops.map(([kind, n]) => `${kind} ${n}`).join(' · ')}`);
  if (notes.length) out.push('', '其他', ...notes.map(note => `  ${note}`));
  return out.join('\n');
}
