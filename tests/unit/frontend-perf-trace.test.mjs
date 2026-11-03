// tests/unit/frontend-perf-trace.test.mjs —— createPerfTrace（app/perf-trace.js）采集接线单测。
// 时钟、Performance API、定时器是外部边界，注入 fake；断言只看写进日志的那几行——机主导出的就是它们。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPerfTrace } from '../../app/public/js/app/perf-trace.js';

function setup({ win = {} } = {}) {
  const lines = [];
  const records = [];
  const clock = { t: 0 };
  const trace = createPerfTrace({ log: text => lines.push(text), report: record => records.push(record), now: () => clock.t, win });
  const at = (t, fn) => { clock.t = t; return fn(); };
  return { lines, records, trace, at, openLines: () => lines.filter(l => l.startsWith('[PERF] 打开会话')) };
}

test.describe('createPerfTrace：打开会话', () => {
  test('点击到高亮完一行写清；别的会话迟到的步骤不算进来，结束后的步骤也不再记', () => {
    const { trace, at, openLines } = setup();
    const a = at(1000, () => trace.openBegin('A', 'tap'));
    at(1420, () => trace.openBind('A'));
    at(1430, () => trace.openStep(trace.openFor('B'), 'insert', { count: 5 }));   // 上一个会话还在画的那批
    at(1435, () => trace.openStep(a, 'switch', { server: { ms: 380 } }));
    at(1645, () => trace.openStep(a, 'sync', { note: 'load' }));
    at(2545, () => trace.openStep(a, 'history', { count: 2000 }));
    at(3745, () => trace.openStep(a, 'insert', { count: 2000 }));
    at(4120, () => trace.openStep(a, 'highlight', { blocks: 678, ms: 356 }));
    at(4120, () => trace.openEnd(a, 'done'));
    at(5000, () => { trace.openStep(a, 'highlight', { blocks: 1, ms: 1 }); trace.openEnd(a, 'done'); });
    assert.deepEqual(openLines(), [
      '[PERF] 打开会话 3120ms（点击）：绑定视图 +420 → 切换回执 +15（服务端 380ms） → 同步回执 +210（load） → 历史回执 +900（2000 条） → 插入 +1200（2000 条） → 高亮 +375（678 块，356ms）；长任务 不可测',
    ]);
  });
});

test.describe('createPerfTrace：打开会话被打断', () => {
  test('没走完就换了会话：上一次记成「被切走」写出来——慢到用户放弃的那次正是要看的', () => {
    const { trace, at, openLines } = setup();
    at(0, () => trace.openBegin('A', 'tap'));
    at(300, () => trace.openBind('A'));
    at(5000, () => trace.openBegin('B', 'tap'));
    const b = at(5400, () => trace.openBind('B'));
    at(5600, () => trace.openEnd(b, 'keep'));
    assert.deepEqual(openLines(), [
      '[PERF] 打开会话 5000ms（点击 · 被切走）：绑定视图 +300；长任务 不可测',
      '[PERF] 打开会话 600ms（点击 · 不拉历史）：绑定视图 +400；长任务 不可测',
    ]);
  });

  // 同一个会话又绑了一次（effort / 模型切档换了实例、A→B→A 快速切回）：上一次的回调手里也是这个 sid，
  // 只比 sid 分不出两次打开——排在空闲里的旧高亮会记进新这一次，还把它提前结束（PR #481 review）
  test('同一个会话重新打开：上一次迟到的步骤不记进这一次，也结束不了它', () => {
    const { trace, at, openLines } = setup();
    const first = at(0, () => trace.openBind('A'));
    at(900, () => trace.openStep(first, 'insert', { count: 2000 }));
    const second = at(1000, () => trace.openBind('A', { note: '有缓存' }));
    at(1300, () => { trace.openStep(first, 'highlight', { blocks: 678, ms: 300 }); trace.openEnd(first, 'done'); });
    at(1400, () => trace.openStep(second, 'sync', { note: 'keep' }));
    at(1400, () => trace.openEnd(second, 'keep'));
    assert.deepEqual(openLines(), [
      '[PERF] 打开会话 1000ms（视图切入 · 被切走）：绑定视图 +0 → 插入 +900（2000 条）；长任务 不可测',
      '[PERF] 打开会话 400ms（视图切入 · 不拉历史）：绑定视图 +0（有缓存） → 同步回执 +400（keep）；长任务 不可测',
    ]);
  });
});

test.describe('createPerfTrace：从绑定视图起算', () => {
  test('没有点击起点（启动恢复上次会话、从别处切进来）：从绑定视图起算，来源记「视图切入」', () => {
    const { trace, at, openLines } = setup();
    const a = at(2000, () => trace.openBind('A', { note: '有缓存' }));
    at(2180, () => trace.openStep(a, 'sync', { note: 'keep' }));
    at(2180, () => trace.openEnd(a, 'keep'));
    assert.deepEqual(openLines(), ['[PERF] 打开会话 180ms（视图切入 · 不拉历史）：绑定视图 +0（有缓存） → 同步回执 +180（keep）；长任务 不可测']);
  });

  test('切换回执先到、绑定视图后到：仍算同一次点击，不另起一次', () => {
    const { trace, at, openLines } = setup();
    const tap = at(0, () => trace.openBegin('A', 'tap'));
    at(200, () => trace.openStep(tap, 'switch', { server: { ms: 150 } }));
    const bind = at(260, () => trace.openBind('A'));
    at(400, () => trace.openEnd(bind, 'keep'));
    assert.deepEqual(openLines(), ['[PERF] 打开会话 400ms（点击 · 不拉历史）：切换回执 +200（服务端 150ms） → 绑定视图 +60；长任务 不可测']);
  });
});

test.describe('createPerfTrace：启动', () => {
  test('启动行只出一次：带导航时间点、一方静态资源（不含 XHR 与跨域）和各 mark；就绪之后到的 mark 单独成行', () => {
    const entries = {
      navigation: [{ responseEnd: 180, domInteractive: 700, domContentLoadedEventStart: 1150 }],
      resource: [
        { name: 'https://ccm.test/js/app.js?v=1', initiatorType: 'script', transferSize: 0, encodedBodySize: 9000, responseEnd: 900 },
        { name: 'https://ccm.test/vendor/tailwind.js', initiatorType: 'script', transferSize: 300, encodedBodySize: 400_000, responseEnd: 600 },
        { name: 'https://ccm.test/socket.io/?EIO=4&transport=polling', initiatorType: 'xmlhttprequest', transferSize: 500, encodedBodySize: 100, responseEnd: 1400 },
        { name: 'https://fonts.example/x.woff2', initiatorType: 'css', transferSize: 20_000, encodedBodySize: 20_000, responseEnd: 1000 },
      ],
    };
    const win = { location: { origin: 'https://ccm.test' }, performance: { getEntriesByType: type => entries[type] ?? [] } };
    const { lines, trace, at } = setup({ win });
    at(1100, () => trace.mark('appjs'));
    at(1500, () => trace.mark('connect', { transport: 'polling' }));
    at(1650, () => trace.mark('instances'));
    at(1700, () => trace.mark('instances'));          // 同名只认第一次
    at(2350, () => trace.startupReady('首页列表'));
    at(2400, () => trace.startupReady('会话就绪'));   // 只出一次
    at(2900, () => trace.mark('upgrade', { transport: 'websocket' }));
    assert.deepEqual(lines, [
      '[PERF] 启动 2350ms（首页列表）：HTML 到齐 180 → 解析完 700 → app.js 开跑 1100 → DCL 1150 → 连上 1500（polling） → 首个 instances 1650 → 首页列表 2350；一方资源 2 个：缓存 1 · 重验 1 · 下载 0 · 0KB · 最后到齐 900；长任务 不可测',
      '[PERF] 启动后 升级 2900（websocket）',
    ]);
  });
});

test.describe('createPerfTrace：启动就绪的来源', () => {
  test('首次打开会话走完即算启动就绪（启动时停在会话里，没有首页列表可等）；被切走的那次不算', () => {
    const { lines, trace, at } = setup();
    at(900, () => trace.openBind('Z'));
    const a = at(1800, () => trace.openBind('A'));     // Z 被切走：不算就绪
    at(2100, () => trace.openEnd(a, 'keep'));
    at(2600, () => trace.openEnd(trace.openBind('B'), 'keep'));
    assert.deepEqual(lines.filter(l => l.startsWith('[PERF] 启动 ')), ['[PERF] 启动 2100ms（会话就绪）：会话就绪 2100；一方资源 不可测；长任务 不可测']);
  });
});

test.describe('createPerfTrace：启动兜底', () => {
  test('30s 内谁都没报就绪（停在新会话页、首页列表卡住）：兜底照样出启动行，之后的就绪不再重复', () => {
    const timers = [];
    const { lines, trace, at } = setup({ win: { setTimeout: fn => timers.push(fn) } });
    at(30_000, () => { while (timers.length) timers.shift()(); });   // 定时器里新排的（下一个任务写行）也照跑
    at(31_000, () => trace.startupReady('首页列表'));
    assert.deepEqual(lines, ['[PERF] 启动 30000ms（30s 未就绪）：30s 未就绪 30000；一方资源 不可测；长任务 不可测']);
  });
});

test.describe('createPerfTrace：长任务', () => {
  test('浏览器支持 longtask 时按各自的窗口汇总：启动算导航开始到就绪，打开算这一次的起止', () => {
    let deliver = null;
    class FakeObserver {
      static supportedEntryTypes = ['longtask', 'resource'];
      constructor(callback) { deliver = callback; }
      observe() {}
      takeRecords() { return []; }
    }
    const { lines, trace, at } = setup({ win: { PerformanceObserver: FakeObserver } });
    deliver?.({ getEntries: () => [{ startTime: 400, duration: 120 }, { startTime: 1300, duration: 300 }] });
    const a = at(1000, () => trace.openBind('A'));
    at(2000, () => trace.openEnd(a, 'keep'));
    assert.match(lines[0], /^\[PERF\] 打开会话 1000ms.*；长任务 1 次 共 300ms 最长 300ms$/);
    assert.match(lines[1], /^\[PERF\] 启动 2000ms（会话就绪）.*；长任务 2 次 共 420ms 最长 300ms$/);
  });

  // 浏览器等一个任务跑完才生成它的长任务条目，先进观察器缓冲，回调更晚。高亮完就在高亮那个任务里收尾：
  // 当场汇总会漏掉最该记的这段（10-31 桌面复现：高亮本身 2732ms，那一行的长任务最长只记到 765ms）
  test('在长任务里收尾：这个任务本身也算进打开行和启动行', () => {
    const timers = [];
    const buffered = [];
    class FakeObserver {
      static supportedEntryTypes = ['longtask'];
      observe() {}
      takeRecords() { return buffered.splice(0); }
    }
    const { lines, trace, at } = setup({ win: { PerformanceObserver: FakeObserver, setTimeout: (fn, ms) => timers.push({ fn, ms }) } });
    const a = at(1000, () => trace.openBind('A'));
    at(4290, () => trace.openEnd(a, 'done'));            // 高亮那个空闲任务的末尾
    buffered.push({ startTime: 1500, duration: 2800 });  // 任务跑完：条目进缓冲，回调还没跑
    at(4300, () => timers.filter(timer => !timer.ms).forEach(timer => timer.fn()));   // 下一个任务；30s 兜底没到点
    assert.match(lines[0], /^\[PERF\] 打开会话 3290ms.*；长任务 1 次 共 2800ms 最长 2800ms$/);
    assert.match(lines[1], /^\[PERF\] 启动 4290ms（会话就绪）.*；长任务 1 次 共 2800ms 最长 2800ms$/);
  });
});

test.describe('createPerfTrace：浏览器 API 是外部边界', () => {
  test('Performance API 自己抛错时不把调用方带崩（它在 app.js 顶层构造），照样出行、拿不到的写「不可测」', () => {
    const win = {
      PerformanceObserver: class { static supportedEntryTypes = ['longtask']; observe() { throw new TypeError('unsupported'); } },
      performance: { getEntriesByType() { throw new Error('blocked'); } },
    };
    let ctx = null;
    assert.doesNotThrow(() => { ctx = setup({ win }); });
    assert.doesNotThrow(() => ctx?.at(500, () => ctx.trace.startupReady('首页列表')));
    assert.deepEqual(ctx?.lines, ['[PERF] 启动 500ms（首页列表）：首页列表 500；一方资源 不可测；长任务 不可测']);
  });
});

// 同一份数据另出一条结构化记录，上报服务端后按维度出分位值（scripts/perf-report.js）。中文行给人看，这条给统计
test.describe('createPerfTrace：结构化记录', () => {
  test('启动：各时间点、导航类型、是否被系统回收过、资源与长任务汇总；就绪之后到的 mark 另成一条', () => {
    const entries = {
      navigation: [{ type: 'reload', responseEnd: 180, domInteractive: 700, domContentLoadedEventStart: 1150 }],
      resource: [{ name: 'https://ccm.test/js/app.js?v=1', initiatorType: 'script', transferSize: 0, encodedBodySize: 9000, responseEnd: 900.4 }],
    };
    const win = { location: { origin: 'https://ccm.test' }, document: { wasDiscarded: true }, performance: { getEntriesByType: type => entries[type] ?? [] } };
    const { records, trace, at } = setup({ win });
    at(1100.6, () => trace.mark('appjs'));
    at(1500, () => trace.mark('connect', { transport: 'polling' }));
    at(2350, () => trace.startupReady('首页列表'));
    at(2900, () => trace.mark('upgrade', { transport: 'websocket' }));
    assert.deepEqual(records, [
      {
        k: 'startup', total: 2350, label: '首页列表', nav: 'reload', discarded: true, transport: 'polling',
        marks: { html: 180, parsed: 700, dcl: 1150, appjs: 1101, connect: 1500 },
        res: { count: 1, cached: 1, revalidated: 0, fetched: 0, bytes: 0, lastEndMs: 900 },
        lt: null,
      },
      { k: 'late', name: 'upgrade', t: 2900, transport: 'websocket' },
    ]);
  });

  test('打开会话：来源、结局、总耗时，每一步距起点的时刻和原样的细节（条数、服务端耗时）', () => {
    const { records, trace, at } = setup();
    const a = at(1000, () => trace.openBegin('A', 'tap'));
    at(1420, () => trace.openBind('A', { note: '无缓存' }));
    at(1645.4, () => trace.openStep(a, 'sync', { note: 'load' }));
    at(2545, () => trace.openStep(a, 'history', { count: 300, server: { ms: 42, readMs: 30 } }));
    at(4120, () => trace.openStep(a, 'highlight', { blocks: 12, ms: 8.6 }));
    at(4120, () => trace.openEnd(a, 'done'));
    assert.deepEqual(records.filter(r => r.k === 'open'), [{
      k: 'open', source: 'tap', outcome: 'done', total: 3120, lt: null,
      steps: [
        { n: 'bind', t: 420, note: '无缓存' },
        { n: 'sync', t: 645, note: 'load' },
        { n: 'history', t: 1545, count: 300, server: { ms: 42, readMs: 30 } },
        { n: 'highlight', t: 3120, blocks: 12, ms: 9 },
      ],
    }]);
  });
});

// PWA 切回前台：页面没重新加载，启动行不会再出。这一段（重连、追平、必要时重拉历史）单独记
test.describe('createPerfTrace：切回前台', () => {
  test('回来到追平一行写清：离开多久（从切走算）、回来时连接还在不在、各步增量；启动就绪之前的不算', () => {
    const { lines, records, trace, at } = setup();
    at(100, () => trace.hide());
    at(500, () => trace.resumeBegin({ connected: true }));                   // 启动还没就绪：这是启动的一部分
    at(1000, () => trace.startupReady('首页列表'));
    at(2000, () => trace.hide());
    at(302_400, () => trace.resumeBegin({ connected: false }));
    at(303_200, () => trace.resumeStep('connect'));
    at(303_634, () => trace.resumeStep('sync', { note: 'keep' }));
    at(303_634, () => trace.resumeEnd('keep'));
    at(304_000, () => trace.resumeEnd('keep'));                              // 已经结束：不再出行
    assert.deepEqual(lines.filter(l => l.startsWith('[PERF] 切回前台')), [
      '[PERF] 切回前台 1234ms（离开 300s · 断线重连 · 不拉历史）：连上 +800 → 同步回执 +434（keep）；长任务 不可测',
    ]);
    assert.deepEqual(records.filter(r => r.k === 'resume'), [{
      k: 'resume', hiddenMs: 300_400, connected: false, outcome: 'keep', total: 1234, lt: null,
      steps: [{ n: 'connect', t: 800 }, { n: 'sync', t: 1234, note: 'keep' }],
    }]);
  });

  test('没走完又切走、或 30s 还没追平：照样写出来，记成各自的结局；上一次的兜底计时器结束不了这一次', () => {
    const fallbacks = [];   // 0ms 的（下一个任务写行）当场跑，30s 兜底攒着按点触发
    const { lines, trace, at } = setup({ win: { setTimeout: (fn, ms) => (ms ? fallbacks.push(fn) : fn()) } });
    at(1000, () => trace.startupReady('首页列表'));
    at(1500, () => trace.hide());
    at(6500, () => trace.resumeBegin({ connected: true }));
    at(6800, () => trace.hide());
    at(15_800, () => trace.resumeBegin({ connected: true }));
    at(15_900, () => trace.resumeStep('connect'));
    at(36_800, () => fallbacks[1]());   // 第一次切回的兜底
    at(45_800, () => fallbacks[2]());   // 这一次的兜底
    at(46_000, () => trace.resumeStep('sync', { note: 'keep' }));
    assert.deepEqual(lines.filter(l => l.startsWith('[PERF] 切回前台')), [
      '[PERF] 切回前台 300ms（离开 5s · 连接还在 · 又切走了）；长任务 不可测',
      '[PERF] 切回前台 30000ms（离开 9s · 连接还在 · 30s 未追平）：连上 +100；长任务 不可测',
    ]);
  });
});
