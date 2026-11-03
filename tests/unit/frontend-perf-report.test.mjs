// tests/unit/frontend-perf-report.test.mjs —— createPerfReporter（app/perf-report.js）攒批上报单测。
// socket、时钟、Performance API、定时器是外部边界，注入 fake；断言只看发出去的那一批——服务端落日志的就是它。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPerfReporter } from '../../app/public/js/app/perf-report.js';

function fakeWin(extra = {}) {
  return {
    location: { origin: 'https://ccm.test' },
    innerWidth: 412,
    innerHeight: 915,
    devicePixelRatio: 2.625,
    navigator: { hardwareConcurrency: 8, deviceMemory: 4, connection: { effectiveType: '4g', rtt: 150, downlink: 1.45, saveData: false } },
    matchMedia: query => ({ matches: query === '(display-mode: standalone)' }),
    ...extra,
  };
}

// 浏览器按类型回调观察器；fire 模拟浏览器交来一批条目，cost 是这批回调里时钟走了多少
function withObservers(types = ['long-animation-frame', 'event']) {
  const observers = {};
  // 断开后浏览器不再回调
  class FakeObserver {
    static supportedEntryTypes = types;
    constructor(callback) { this.callback = list => { if (!this.disconnected) callback(list); }; this.disconnected = false; }
    observe({ type, ...options }) { observers[type] = this; this.options = options; }
    disconnect() { this.disconnected = true; }
  }
  return { PerformanceObserver: FakeObserver, observers };
}

const frame = (startTime, duration = 80) => ({ startTime, duration, blockingDuration: 30, renderStart: 0, styleAndLayoutStart: 0, firstUIEventTimestamp: 0, scripts: [] });

// dims 每调一次让时钟走 dimsCost（默认 2ms）：自身耗时的记账要能看出来。一批几十条时设 0，免得撞上自身预算
function setup({ win = fakeWin(), persistStats, dimsCost = 2 } = {}) {
  const sent = [];
  const state = { connected: true, dims: { view: 'session', busy: true }, clock: 0 };
  const reporter = createPerfReporter({
    emit: payload => sent.push(JSON.parse(JSON.stringify(payload))),
    isConnected: () => state.connected,
    dims: () => { state.clock += dimsCost; return state.dims; },
    persistStats,
    clock: () => state.clock,
    build: 'abc',
    win,
  });
  const fire = (type, entries, cost = 0) => win.observers[type].callback({ getEntries: () => { state.clock += cost; return entries; } });
  return { reporter, sent, state, fire };
}

test.describe('createPerfReporter：攒批发送', () => {
  test('连上时 flush 发一批：版本号、设备上下文、带当时维度的记录、自身耗时；发完清空，没有新记录不再发', () => {
    const { reporter, sent, state } = setup();
    state.dims = { view: 'home', busy: false };
    reporter.record({ k: 'startup', total: 3620 });
    state.dims = { view: 'session', busy: true };
    reporter.record({ k: 'open', total: 900 });
    reporter.flush();
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0], {
      v: 1,
      ctx: { standalone: true, vw: 412, vh: 915, dpr: 2.625, cores: 8, mem: 4, net: { type: '4g', rtt: 150, down: 1.45, save: false }, build: 'abc' },
      events: [{ k: 'startup', total: 3620, view: 'home', busy: false }, { k: 'open', total: 900, view: 'session', busy: true }],
      self: { ms: 4, n: 2 },
    });
    reporter.flush();
    assert.equal(sent.length, 1, '没有新记录不发空批');
    reporter.record({ k: 'resume', total: 300 });
    reporter.flush();
    assert.deepEqual(sent[1].events, [{ k: 'resume', total: 300, view: 'session', busy: true }]);
  });

  test('没连上不发、攒着，连上后一并发出；攒满 50 条后丢掉的按类计数，计数随批清零', () => {
    const { reporter, sent, state } = setup();
    state.connected = false;
    for (let i = 0; i < 55; i++) reporter.record({ k: i < 52 ? 'open' : 'resume', total: i });
    reporter.flush();
    assert.equal(sent.length, 0);
    state.connected = true;
    reporter.flush();
    assert.equal(sent[0].events.length, 50);
    assert.deepEqual(sent[0].events.at(-1), { k: 'open', total: 49, view: 'session', busy: true });
    assert.deepEqual(sent[0].dropped, { open: 2, resume: 3 });
    reporter.record({ k: 'open', total: 1 });
    reporter.flush();
    assert.equal(sent[1].events.length, 1);
    assert.equal('dropped' in sent[1], false);
  });
});

test.describe('createPerfReporter：长帧', () => {
  test('浏览器交来的每个长帧摘要成一条（带当时的维度），连同观察器建起来之前的；每批最多 30 条，多的计数', () => {
    const observed = withObservers();
    const { sent, state, fire, reporter } = setup({ win: fakeWin(observed), dimsCost: 0 });
    assert.deepEqual(observed.observers['long-animation-frame'].options, { buffered: true });
    state.dims = { view: 'home', busy: false };
    fire('long-animation-frame', Array.from({ length: 32 }, (_, i) => frame(i * 100)));
    reporter.flush();
    assert.equal(sent[0].events.length, 30);
    assert.deepEqual(sent[0].events[0], { k: 'frame', t: 0, dur: 80, block: 30, render: 0, layout: 0, input: false, scriptsN: 0, scripts: [], view: 'home', busy: false });
    assert.deepEqual(sent[0].dropped, { frame: 2 });
    fire('long-animation-frame', [frame(9000, 120)]);
    reporter.flush();
    assert.deepEqual(sent[1].events.map(event => event.dur), [120], '每批重新计数');
  });
});

test.describe('createPerfReporter：点击响应', () => {
  // closest：DOM 的祖先查找，没有 id 的元素靠最近带 id 的祖先认出在哪一块
  const el = (tagName, { id = '', className = '', ancestorId = null } = {}) => ({ tagName, id, className, closest: sel => (sel === '[id]' && ancestorId ? { id: ancestorId } : null) });

  test('发送时把这一批的交互汇总成一条 inputs（带维度）；目标只留元素标签，不带文字', () => {
    const observed = withObservers();
    const { sent, fire, reporter } = setup({ win: fakeWin(observed) });
    assert.deepEqual(observed.observers.event.options, { buffered: true, durationThreshold: 16 });
    const send = el('BUTTON', { id: 'sendBtn' });
    fire('event', [
      { name: 'pointerdown', interactionId: 7, startTime: 100, duration: 250, processingStart: 230, processingEnd: 300, target: send },
      { name: 'click', interactionId: 7, startTime: 120, duration: 320, processingStart: 260, processingEnd: 400, target: send },
      { name: 'pointermove', interactionId: 0, startTime: 500, duration: 400, processingStart: 510, processingEnd: 880, target: send },
      { name: 'click', interactionId: 9, startTime: 900, duration: 210, processingStart: 905, processingEnd: 1100, target: el('DIV', { className: ' msg-row flex', ancestorId: 'messages' }) },
      { name: 'keydown', interactionId: 11, startTime: 2000, duration: 24, processingStart: 2001, processingEnd: 2010, target: null },
    ]);
    reporter.flush();
    assert.deepEqual(sent[0].events, [{
      k: 'inputs', n: 3, durs: [320, 210, 24],
      slow: [
        { t: 120, dur: 320, type: 'click', target: 'button#sendBtn', delay: 140, proc: 140, present: 40 },
        { t: 900, dur: 210, type: 'click', target: 'div.msg-row in #messages', delay: 5, proc: 195, present: 10 },
      ],
      view: 'session', busy: true,
    }]);
    reporter.flush();
    assert.equal(sent.length, 1, '汇总过的交互不再发');
  });

  test('浏览器没有这两路观察器（Safari / Firefox）：不崩，perf-trace 的记录照发', () => {
    for (const win of [fakeWin(), fakeWin(withObservers([]))]) {
      const { sent, reporter } = setup({ win });
      reporter.record({ k: 'startup', total: 1 });
      reporter.flush();
      assert.deepEqual(sent[0].events.map(event => event.k), ['startup']);
    }
  });
});

test.describe('createPerfReporter：自身耗时预算', () => {
  test('一个发送周期里自己花的主线程时间超过 50ms：关掉两路观察器，批里报 stopped；perf-trace 的记录照收', () => {
    const observed = withObservers();
    const { sent, fire, reporter } = setup({ win: fakeWin(observed) });
    fire('long-animation-frame', [frame(0)], 20);
    fire('long-animation-frame', [frame(100)], 20);
    reporter.flush();
    assert.equal(observed.observers['long-animation-frame'].disconnected, false, '没超预算不关');
    fire('long-animation-frame', [frame(200)], 30);                 // 发过一批，窗口重新算：30 + 两次 dims 4
    fire('long-animation-frame', [frame(300)], 30);                 // 累计 68，超了
    fire('long-animation-frame', [frame(400)], 0);
    reporter.record({ k: 'open', total: 1 });
    reporter.flush();
    assert.equal(observed.observers['long-animation-frame'].disconnected, true);
    assert.equal(observed.observers.event.disconnected, true);
    assert.deepEqual(sent[1].events.map(event => event.t ?? event.k), [200, 300, 'open']);
    assert.equal(sent[1].self.stopped, 'budget');
    assert.ok(sent[1].self.ms >= 64, `超预算那段要记进自身耗时，实际 ${sent[1].self.ms}`);
  });
});

test.describe('createPerfReporter：定时发送与日志落盘代价', () => {
  test('每 30s 等主线程空闲时发一批（最多等 2s）', () => {
    const intervals = [];
    const idles = [];
    const win = fakeWin({ setInterval: (fn, ms) => intervals.push({ fn, ms }), requestIdleCallback: (fn, options) => idles.push({ fn, options }) });
    const { sent, reporter } = setup({ win });
    reporter.record({ k: 'startup', total: 1 });
    assert.deepEqual(intervals.map(timer => timer.ms), [30_000]);
    intervals[0].fn();
    assert.equal(sent.length, 0, '到点先排进空闲，不当场发');
    assert.deepEqual(idles[0].options, { timeout: 2_000 });
    idles[0].fn({ didTimeout: false, timeRemaining: () => 10 });
    assert.deepEqual(sent[0].events.map(event => event.k), ['startup']);
  });

  test('clientLogger 的落盘代价随批带上；只在真发出去时取，断线期间攒的不丢；没落过盘不带', () => {
    let pending = { n: 3, totalMs: 12, maxMs: 6, bytes: 9000 };
    const persistStats = () => { const out = pending; pending = null; return out; };
    const { sent, state, reporter } = setup({ persistStats });
    state.connected = false;
    reporter.record({ k: 'open', total: 1 });
    reporter.flush();
    state.connected = true;
    reporter.flush();
    assert.deepEqual(sent[0].logPersist, { n: 3, totalMs: 12, maxMs: 6, bytes: 9000 });
    reporter.record({ k: 'open', total: 2 });
    reporter.flush();
    assert.equal('logPersist' in sent[1], false);
  });
});
