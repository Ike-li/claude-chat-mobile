// 前端性能上报的汇总（app/src/ops/client-perf-report.js，scripts/perf-report.js 的计算部分）：
// 读 ccm-server.log 的 [client-perf] 行，按维度出 n / p50 / p90 / max。行的形状由 client-perf-log.js 写出。
// 不测什么：前端怎么采、怎么攒批在 frontend-perf-report.test.mjs；服务端清洗在 client-perf-log.test.mjs。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { format } from 'node:util';
import { formatClientPerfLine } from '../../app/src/ops/client-perf-log.js';
import { wrapConsole } from '../../app/src/shared/log-time.js';
import { formatClientPerfReport, parseSince, summarizeClientPerf } from '../../app/src/ops/client-perf-report.js';

const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

const ctx = (over = {}) => ({ standalone: true, vw: 412, vh: 915, dpr: 2.6, cores: 8, mem: 8, net: { type: '4g', rtt: 100, down: 10, save: false }, build: 'abc', ...over });
const line = (at, batch, { ua = ANDROID, sid = 's1' } = {}) => `${at} [client-perf] ${JSON.stringify({ sid, ua, v: 1, ctx: ctx(), self: { ms: 1, n: 3 }, ...batch })}`;
const startup = (total, over = {}) => ({ k: 'startup', total, label: '首页', nav: 'navigate', discarded: false, transport: 'polling', marks: { dcl: 300, connect: 600 }, res: { count: 90, cached: 90, revalidated: 0, fetched: 0, bytes: 0, lastEndMs: 200 }, lt: null, view: 'home', busy: false, ...over });
const section = (report, title) => report.sections.find(s => s.title === title);
const row = (report, title, label) => section(report, title)?.rows.find(r => r.label === label);

test('启动总耗时：全部与按设备分开出分位值（最近秩）；只有一个取值的维度不单列', () => {
  const totals = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
  const lines = totals.map((total, i) => line(`2026-10-30T10:00:0${i}.000-05:00`, { events: [startup(total)] }));
  lines.push(line('2026-10-30T11:00:00.000-05:00', { ctx: ctx({ standalone: false }), events: [startup(5000)] }, { ua: MAC }));
  const report = summarizeClientPerf(lines);
  assert.equal(report.batches, 11);
  assert.deepEqual(row(report, '启动总耗时', '全部'), { label: '全部', n: 11, p50: 600, p90: 1000, max: 5000 });
  assert.deepEqual(row(report, '启动总耗时', '设备 Android·PWA'), { label: '设备 Android·PWA', n: 10, p50: 500, p90: 900, max: 1000 });
  assert.deepEqual(row(report, '启动总耗时', '设备 Mac·浏览器'), { label: '设备 Mac·浏览器', n: 1, p50: 5000, p90: 5000, max: 5000 });
  assert.equal(section(report, '启动总耗时').rows.some(r => r.label.startsWith('网络 ')), false, '网络全是 4g，不该单列');
});

test('启动：按缓存状态与导航方式分开；被系统回收后重开单独算一类', () => {
  const lines = [
    line('2026-10-30T10:00:00.000-05:00', { events: [startup(400)] }),
    line('2026-10-30T10:00:01.000-05:00', { events: [startup(2000, { res: { count: 90, cached: 10, revalidated: 0, fetched: 80, bytes: 900000, lastEndMs: 1500 } })] }),
    line('2026-10-30T10:00:02.000-05:00', { events: [startup(900, { res: { count: 90, cached: 0, revalidated: 90, fetched: 0, bytes: 30000, lastEndMs: 800 } })] }),
    line('2026-10-30T10:00:03.000-05:00', { events: [startup(3000, { discarded: true, nav: 'reload' })] }),
  ];
  const report = summarizeClientPerf(lines);
  assert.equal(row(report, '启动总耗时', '缓存 全缓存')?.n, 2);
  assert.equal(row(report, '启动总耗时', '缓存 有下载')?.max, 2000);
  assert.equal(row(report, '启动总耗时', '缓存 有重验')?.max, 900);
  assert.equal(row(report, '启动总耗时', '导航 被回收后重开')?.max, 3000);
  assert.equal(row(report, '启动总耗时', '导航 navigate')?.n, 3);
});

test('启动各点按发生先后列出；启动后才到的点（late）并进同一行', () => {
  const lines = [
    line('2026-10-30T10:00:00.000-05:00', { events: [startup(700, { marks: { dcl: 300, connect: 600 } }), { k: 'late', name: 'upgrade', t: 1500, transport: 'websocket' }] }),
    line('2026-10-30T10:00:01.000-05:00', { events: [startup(900, { marks: { dcl: 500, connect: 800, upgrade: 850 } })] }),
  ];
  const report = summarizeClientPerf(lines);
  assert.deepEqual(section(report, '启动各点（距导航开始）').rows.map(r => r.label), ['点 dcl DCL', '点 connect 连上', '点 upgrade 升级']);
  assert.deepEqual(row(report, '启动各点（距导航开始）', '点 upgrade 升级'), { label: '点 upgrade 升级', n: 2, p50: 850, p90: 1500, max: 1500 });
});

test('服务端真实写出的那一行（console 时间戳前缀 + 清洗后的 JSON）汇总读得回来', () => {
  const written = [];
  const sink = { log: (...args) => written.push(format(...args)), info() {}, warn() {}, error() {} };
  wrapConsole(sink, () => new Date('2026-10-30T15:00:00.000Z'));
  sink.log('[client-perf]', formatClientPerfLine({ v: 1, ctx: ctx(), events: [startup(700)], self: { ms: 1, n: 2 } }, { socketId: 'abc', ua: ANDROID }));
  const report = summarizeClientPerf(written);
  assert.equal(report.batches, 1);
  assert.equal(report.from, Date.parse('2026-10-30T15:00:00.000Z'));
  assert.deepEqual(row(report, '启动总耗时', '全部'), { label: '全部', n: 1, p50: 700, p90: 700, max: 700 });
});

test('只认 [client-perf] 行；坏行计数跳过；since 之前的不算；from / to 是实际纳入的时间范围', () => {
  const lines = [
    '2026-10-30T09:00:00.000-05:00 [interact] something else',
    line('2026-10-20T10:00:00.000-05:00', { events: [startup(9999)] }),
    '2026-10-30T10:00:00.000-05:00 [client-perf] {not json',
    line('2026-10-30T10:00:00.000-05:00', { events: [startup(100)] }),
    line('2026-10-31T10:00:00.000-05:00', { events: [startup(200)] }),
  ];
  const report = summarizeClientPerf(lines, { since: Date.parse('2026-10-25T00:00:00.000-05:00') });
  assert.equal(report.batches, 2);
  assert.equal(report.skipped, 1);
  assert.equal(row(report, '启动总耗时', '全部')?.max, 200);
  assert.equal(report.from, Date.parse('2026-10-30T10:00:00.000-05:00'));
  assert.equal(report.to, Date.parse('2026-10-31T10:00:00.000-05:00'));
});

test('打开会话：按来源、结果、拉了多少条拆开；各段取相对上一段的增量，服务端耗时单列；中途被切走的不计入', () => {
  const full = { k: 'open', source: 'tap', outcome: 'done', total: 1200, lt: null, view: 'session', busy: false, steps: [
    { n: 'switch', t: 200 }, { n: 'sync', t: 300, note: 'load' }, { n: 'history', t: 900, note: 'tail', count: 300, server: { ms: 400, chainMs: 250 } },
    { n: 'older', t: 1000, count: 1700, server: { ms: 90 } }, { n: 'insert', t: 1100, count: 300 }, { n: 'highlight', t: 1200, blocks: 10, ms: 50 },
  ] };
  const keep = { k: 'open', source: 'bind', outcome: 'keep', total: 80, lt: null, view: 'session', busy: true, steps: [{ n: 'bind', t: 0 }, { n: 'sync', t: 80, note: 'keep' }] };
  const away = { k: 'open', source: 'tap', outcome: 'superseded', total: 500, lt: null, view: 'session', busy: false, steps: [{ n: 'switch', t: 500 }] };
  const report = summarizeClientPerf([line('2026-10-30T10:00:00.000-05:00', { events: [full, keep, away] })]);
  const title = '打开会话总耗时';
  assert.deepEqual(row(report, title, '全部'), { label: '全部', n: 2, p50: 80, p90: 1200, max: 1200 });
  assert.equal(row(report, title, '条数 ≥1000')?.max, 1200, '最近一段 300 + 更早 1700');
  assert.equal(row(report, title, '条数 未拉历史')?.max, 80);
  assert.ok(row(report, title, '来源 bind 视图切入'));
  assert.ok(row(report, title, '结果 keep 不拉历史'));
  assert.equal(row(report, title, '结果 superseded 被切走'), undefined);
  const steps = '打开会话各段（相对上一段）';
  assert.deepEqual(section(report, steps).rows.map(r => r.label), [
    '段 bind 绑定视图', '段 switch 切换回执', '段 sync 同步回执', '段 history 历史回执', '段 history.server 历史回执·服务端',
    '段 older 更早回执', '段 older.server 更早回执·服务端', '段 insert 插入', '段 highlight 高亮',
  ]);
  assert.equal(row(report, steps, '段 history 历史回执')?.p50, 600);
  assert.equal(row(report, steps, '段 history.server 历史回执·服务端')?.p50, 400);
  assert.deepEqual(row(report, steps, '段 sync 同步回执'), { label: '段 sync 同步回执', n: 2, p50: 80, p90: 100, max: 100 });
  assert.equal(report.notes.excluded.open, 1);
});

test('切回前台：按离开多久分档（按时长先后排）、连接还在与否拆开；又切走 / 被打断的不计入', () => {
  const resume = (hiddenMs, connected, outcome, total, steps) => ({ k: 'resume', hiddenMs, connected, outcome, total, lt: null, steps, view: 'session', busy: false });
  const events = [
    resume(2 * 3600_000, false, 'timeout', 30000, [{ n: 'connect', t: 2000 }]),
    resume(30_000, true, 'keep', 120, [{ n: 'sync', t: 120, note: 'keep' }]),
    resume(20 * 60_000, false, 'reload', 3000, [{ n: 'connect', t: 1500 }, { n: 'sync', t: 1800, note: 'reload' }, { n: 'history', t: 3000 }]),
    resume(5_000, true, 'hidden', 400, []),
  ];
  const report = summarizeClientPerf([line('2026-10-30T10:00:00.000-05:00', { events })]);
  const title = '切回前台总耗时';
  assert.equal(row(report, title, '全部')?.n, 3);
  assert.deepEqual(section(report, title).rows.filter(r => r.label.startsWith('离开 ')).map(r => r.label), ['离开 <1min', '离开 10–60min', '离开 ≥1h']);
  assert.equal(row(report, title, '连接 断线重连')?.n, 2);
  assert.equal(row(report, title, '连接 还在')?.max, 120);
  assert.equal(row(report, title, '结果 timeout 30s 未追平')?.max, 30000);
  assert.deepEqual(row(report, '切回前台各段（相对上一段）', '段 connect 连上'), { label: '段 connect 连上', n: 2, p50: 1500, p90: 2000, max: 2000 });
  assert.equal(row(report, '切回前台各段（相对上一段）', '段 history 历史重画')?.max, 1200);
  assert.equal(report.notes.excluded.resume, 1);
});

test('长帧：时长按视图、运行中、有没有输入在等拆开；卡在哪段脚本按函数跨批合计、按总时长排', () => {
  const onScroll = dur => ({ type: 'event-listener', inv: 'DIV#messages.onscroll', src: '/js/app.js', fn: 'onScroll', pos: 1234, dur, forced: 10 });
  const frame = (dur, block, input, scripts, view, busy) => ({ k: 'frame', t: 100, dur, block, render: 10, layout: 5, input, scriptsN: scripts.length, scripts, view, busy });
  const lines = [
    line('2026-10-30T10:00:00.000-05:00', { events: [frame(120, 70, false, [onScroll(90), { type: 'user-callback', inv: 'Window.requestIdleCallback', src: '/js/app/history-render.js', fn: 'renderChunk', pos: 50, dur: 20, forced: 0 }], 'session', true)] }),
    line('2026-10-30T10:00:30.000-05:00', { events: [frame(300, 250, true, [onScroll(200)], 'home', false)] }),
  ];
  const report = summarizeClientPerf(lines);
  const title = '长帧时长（≥50ms 的帧）';
  assert.deepEqual(row(report, title, '全部'), { label: '全部', n: 2, p50: 120, p90: 300, max: 300 });
  assert.equal(row(report, title, '视图 session')?.max, 120);
  assert.equal(row(report, title, '等输入 是')?.max, 300);
  assert.equal(row(report, '长帧阻塞时长', '全部')?.max, 250);
  assert.deepEqual(report.topScripts.map(({ key, n, totalMs, maxMs }) => ({ key, n, totalMs, maxMs })), [
    { key: '/js/app.js onScroll@1234', n: 2, totalMs: 290, maxMs: 200 },
    { key: '/js/app/history-render.js renderChunk@50', n: 1, totalMs: 20, maxMs: 20 },
  ]);
  assert.equal(report.topScripts[0].inv, 'DIV#messages.onscroll');
});

test('点击响应：各批的交互时长合在一起出分位值；最慢的几次带目标和三段拆分，跨批按时长排', () => {
  const lines = [
    line('2026-10-30T10:00:00.000-05:00', { events: [{ k: 'inputs', n: 3, durs: [40, 250, 24], slow: [{ t: 1000, dur: 250, type: 'click', target: 'button#sendBtn', delay: 180, proc: 40, present: 30 }], view: 'session', busy: true }] }),
    line('2026-10-30T10:00:30.000-05:00', { events: [{ k: 'inputs', n: 1, durs: [600], slow: [{ t: 5, dur: 600, type: 'pointerup', target: 'div.msg-row in #messages', delay: 500, proc: 60, present: 40 }], view: 'home', busy: false }] }),
  ];
  const report = summarizeClientPerf(lines);
  assert.deepEqual(row(report, '点击响应（≥16ms 的交互）', '全部'), { label: '全部', n: 4, p50: 40, p90: 600, max: 600 });
  assert.deepEqual(report.slowInputs.map(({ dur, type, target, delay, proc, present, device }) => ({ dur, type, target, delay, proc, present, device })), [
    { dur: 600, type: 'pointerup', target: 'div.msg-row in #messages', delay: 500, proc: 60, present: 40, device: 'Android·PWA' },
    { dur: 250, type: 'click', target: 'button#sendBtn', delay: 180, proc: 40, present: 30, device: 'Android·PWA' },
  ]);
  assert.equal(report.slowInputs[0].at, Date.parse('2026-10-30T10:00:30.000-05:00'));
});

test('埋点自身：每批主线程耗时出分位值（保留一位小数）、超预算停掉的批数；日志落盘最长一次与最大字节数；丢弃按类合计', () => {
  const lines = [
    line('2026-10-30T10:00:00.000-05:00', { events: [], self: { ms: 0.4, n: 10 }, dropped: { frame: 5 }, logPersist: { n: 4, totalMs: 20, maxMs: 9.5, bytes: 120000 } }),
    line('2026-10-30T10:00:30.000-05:00', { events: [], self: { ms: 60, n: 400, stopped: 'budget' }, dropped: { frame: 2, event: 10 }, logPersist: { n: 1, totalMs: 3, maxMs: 3, bytes: 90000 } }),
  ];
  const report = summarizeClientPerf(lines);
  assert.deepEqual(row(report, '埋点自身（每批主线程 ms）', '全部'), { label: '全部', n: 2, p50: 0.4, p90: 60, max: 60 });
  assert.equal(report.notes.stopped, 1);
  assert.deepEqual(row(report, '日志落盘（每批最长一次 ms）', '全部'), { label: '全部', n: 2, p50: 3, p90: 9.5, max: 9.5 });
  assert.equal(report.notes.logBytesMax, 120000);
  assert.deepEqual(report.notes.dropped, { frame: 7, event: 10 });
});

test('--since：7d / 24h 相对现在，YYYY-MM-DD 取本地零点；认不出的返回 null', () => {
  const now = Date.parse('2026-11-01T12:00:00.000-05:00');
  assert.equal(parseSince('7d', now), now - 7 * 86_400_000);
  assert.equal(parseSince('24h', now), now - 24 * 3_600_000);
  assert.equal(parseSince('2026-10-25', now), new Date(2026, 9, 25).getTime());
  assert.equal(parseSince('soon', now), null);
  assert.equal(parseSince('2026-13-40', now), null);
});

test('输出：每张表一列 n / p50 / p90 / max、标签放最后；没数据的表写「无数据」；脚本、最慢点击、未计入与丢弃各有一段', () => {
  const lines = [
    line('2026-10-30T10:00:00.000-05:00', { events: [startup(600), { k: 'open', source: 'tap', outcome: 'superseded', total: 1, steps: [] },
      { k: 'frame', t: 1, dur: 120, block: 70, render: 0, layout: 0, input: false, scriptsN: 1, scripts: [{ type: 'event-listener', inv: 'DIV#messages.onscroll', src: '/js/app.js', fn: 'onScroll', pos: 1234, dur: 90, forced: 0 }], view: 'session', busy: false },
      { k: 'inputs', n: 1, durs: [250], slow: [{ t: 1, dur: 250, type: 'click', target: 'button#sendBtn', delay: 180, proc: 40, present: 30 }] }], dropped: { frame: 3 } }),
  ];
  const text = formatClientPerfReport(summarizeClientPerf(lines));
  assert.match(text, /^启动总耗时\n\s+n\s+p50\s+p90\s+max\n\s+1\s+600\s+600\s+600\s+全部$/m);
  assert.match(text, /^切回前台总耗时\n\s+（无数据）$/m);
  assert.match(text, /^\s+90\s+1\s+90\s+\/js\/app\.js onScroll@1234 · event-listener DIV#messages\.onscroll$/m);
  assert.match(text, /250ms click button#sendBtn（等 180 · 处理 40 · 呈现 30）Android·PWA/);
  assert.match(text, /打开会话中途被切走 1 次/);
  assert.match(text, /因上限丢弃：frame 3/);
});

test('输出：一行都没有时说清楚为什么可能没有，而不是给一堆空表', () => {
  const text = formatClientPerfReport(summarizeClientPerf(['2026-10-30T10:00:00.000-05:00 [interact] x']));
  assert.match(text, /没有 \[client-perf\] 记录/);
  assert.doesNotMatch(text, /无数据/);
});
