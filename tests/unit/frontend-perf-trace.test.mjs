// tests/unit/frontend-perf-trace.test.mjs —— createPerfTrace（app/perf-trace.js）采集接线单测。
// 时钟、Performance API、定时器是外部边界，注入 fake；断言只看写进日志的那几行——机主导出的就是它们。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPerfTrace } from '../../app/public/js/app/perf-trace.js';

function setup({ win = {} } = {}) {
  const lines = [];
  const clock = { t: 0 };
  const trace = createPerfTrace({ log: text => lines.push(text), now: () => clock.t, win });
  const at = (t, fn) => { clock.t = t; fn(); };
  return { lines, trace, at, openLines: () => lines.filter(l => l.startsWith('[PERF] 打开会话')) };
}

test.describe('createPerfTrace：打开会话', () => {
  test('点击到高亮完一行写清；别的会话迟到的步骤不算进来，结束后的步骤也不再记', () => {
    const { trace, at, openLines } = setup();
    at(1000, () => trace.openBegin('A', 'tap'));
    at(1420, () => trace.openBind('A'));
    at(1430, () => trace.openStep('B', 'insert', { count: 5 }));   // 上一个会话还在画的那批
    at(1435, () => trace.openStep('A', 'switch', { server: { ms: 380 } }));
    at(1645, () => trace.openStep('A', 'sync', { note: 'load' }));
    at(2545, () => trace.openStep('A', 'history', { count: 2000 }));
    at(3745, () => trace.openStep('A', 'insert', { count: 2000 }));
    at(4120, () => trace.openStep('A', 'highlight', { blocks: 678, ms: 356 }));
    at(4120, () => trace.openEnd('A', 'done'));
    at(5000, () => { trace.openStep('A', 'highlight', { blocks: 1, ms: 1 }); trace.openEnd('A', 'done'); });
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
    at(5400, () => trace.openBind('B'));
    at(5600, () => trace.openEnd('B', 'keep'));
    assert.deepEqual(openLines(), [
      '[PERF] 打开会话 5000ms（点击 · 被切走）：绑定视图 +300；长任务 不可测',
      '[PERF] 打开会话 600ms（点击 · 不拉历史）：绑定视图 +400；长任务 不可测',
    ]);
  });
});

test.describe('createPerfTrace：从绑定视图起算', () => {
  test('没有点击起点（启动恢复上次会话、从别处切进来）：从绑定视图起算，来源记「视图切入」', () => {
    const { trace, at, openLines } = setup();
    at(2000, () => trace.openBind('A', { note: '有缓存' }));
    at(2180, () => trace.openStep('A', 'sync', { note: 'keep' }));
    at(2180, () => trace.openEnd('A', 'keep'));
    assert.deepEqual(openLines(), ['[PERF] 打开会话 180ms（视图切入 · 不拉历史）：绑定视图 +0（有缓存） → 同步回执 +180（keep）；长任务 不可测']);
  });

  test('切换回执先到、绑定视图后到：仍算同一次点击，不另起一次', () => {
    const { trace, at, openLines } = setup();
    at(0, () => trace.openBegin('A', 'tap'));
    at(200, () => trace.openStep('A', 'switch', { server: { ms: 150 } }));
    at(260, () => trace.openBind('A'));
    at(400, () => trace.openEnd('A', 'keep'));
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
    at(1800, () => trace.openBind('A'));               // Z 被切走：不算就绪
    at(2100, () => trace.openEnd('A', 'keep'));
    at(2600, () => { trace.openBind('B'); trace.openEnd('B', 'keep'); });
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
    at(1000, () => trace.openBind('A'));
    at(2000, () => trace.openEnd('A', 'keep'));
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
    at(1000, () => trace.openBind('A'));
    at(4290, () => trace.openEnd('A', 'done'));          // 高亮那个空闲任务的末尾
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
