// tests/unit/service-events.test.mjs —— 重启事件的采集与频率判定
//
// 为什么需要这一层：`launchctl list` 只给 `LastExitStatus`，那是**瞬时值**，回答不了
// 「这正常吗」。机主机器上的实证——隧道的 -9 不是崩溃，是自建看门狗每天按 DHCP 漂移
// kickstart 一次留下的痕迹。用瞬时值判 flapping 等于每天误报一次，而恒亮的告警比没有告警更糟：
// 它会训练用户忽略这个图标，等真出事那天也不会多看一眼。
//
// 只有时间序列能区分：每天一次是路由器换 IP，五分钟内三次才是真出事了。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_SERVICE_EVENTS,
  appendEvents,
  classifyRestartPattern,
  diffRunningState,
  validateServiceEvents,
} from '../../src/ops/service-events.js';

const snap = (pairs) => new Map(Object.entries(pairs).map(([k, v]) => [k, v]));
const T = 1786600000000;

test.describe('diffRunningState —— 从两次采样里认出重启', () => {
  test('PID 变了 → restarted（kickstart -k 的形态：瞬间换进程）', () => {
    const evs = diffRunningState(
      snap({ 'com.ccm.tunnel': { pid: 7960, lastExit: 0 } }),
      snap({ 'com.ccm.tunnel': { pid: 9182, lastExit: -9 } }),
      T
    );
    assert.equal(evs.length, 1);
    assert.deepEqual(evs[0], { ts: T, label: 'com.ccm.tunnel', kind: 'restarted', from: 7960, to: 9182, lastExit: -9 });
  });

  test('PID 没变 → 无事件（绝大多数采样都该是这条）', () => {
    const same = snap({ 'com.ccm.server': { pid: 100, lastExit: 0 } });
    assert.deepEqual(diffRunningState(same, same, T), []);
  });

  test('从无到有 → started（stop 之后手动起来，或 plist 刚被 bootstrap）', () => {
    const evs = diffRunningState(
      snap({ 'com.ccm.server': { pid: null, lastExit: 0 } }),
      snap({ 'com.ccm.server': { pid: 500, lastExit: 0 } }),
      T
    );
    assert.equal(evs[0].kind, 'started');
    assert.equal(evs[0].from, null);
  });

  test('从有到无 → stopped', () => {
    const evs = diffRunningState(
      snap({ 'com.ccm.server': { pid: 500, lastExit: 0 } }),
      snap({ 'com.ccm.server': { pid: null, lastExit: 0 } }),
      T
    );
    assert.equal(evs[0].kind, 'stopped');
    assert.equal(evs[0].to, null);
  });

  // ★ 首次采样必须静默：server 每次启动都会拿到一份「全是新 PID」的快照，
  // 若据此产出一堆 started，重启历史会被 server 自己的重启刷屏，频率判定跟着失真。
  test('首次采样（无 prev）→ 一条都不产出', () => {
    assert.deepEqual(diffRunningState(null, snap({ 'com.ccm.server': { pid: 1 } }), T), []);
    assert.deepEqual(diffRunningState(new Map(), snap({ 'com.ccm.server': { pid: 1 } }), T), []);
  });

  test('新出现的 label（刚 install）不算 started —— 它上一轮根本不存在', () => {
    const evs = diffRunningState(
      snap({ 'com.ccm.server': { pid: 1 } }),
      snap({ 'com.ccm.server': { pid: 1 }, 'com.ccm.menubar': { pid: 9 } }),
      T
    );
    assert.deepEqual(evs, [], '第一次见到某个 label 时没有可比的前值');
  });

  test('label 消失（被 uninstall）不产出 stopped', () => {
    const evs = diffRunningState(
      snap({ 'com.ccm.server': { pid: 1 }, 'com.ccm.menubar': { pid: 9 } }),
      snap({ 'com.ccm.server': { pid: 1 } }),
      T
    );
    assert.deepEqual(evs, []);
  });

  test('多个 unit 同时变化 → 各出一条，顺序按 label 稳定', () => {
    const evs = diffRunningState(
      snap({ 'com.ccm.tunnel': { pid: 1 }, 'com.ccm.server': { pid: 2 } }),
      snap({ 'com.ccm.tunnel': { pid: 11 }, 'com.ccm.server': { pid: 22 } }),
      T
    );
    assert.deepEqual(evs.map((e) => e.label), ['com.ccm.server', 'com.ccm.tunnel']);
  });
});

test.describe('appendEvents —— 有界追加', () => {
  test('追加到末尾（新的在后）', () => {
    const out = appendEvents([{ ts: 1 }], [{ ts: 2 }, { ts: 3 }]);
    assert.deepEqual(out.map((e) => e.ts), [1, 2, 3]);
  });

  test('超出上限时丢最旧的（环形，防止文件无界增长）', () => {
    const old = Array.from({ length: MAX_SERVICE_EVENTS }, (_, i) => ({ ts: i }));
    const out = appendEvents(old, [{ ts: 9999 }]);
    assert.equal(out.length, MAX_SERVICE_EVENTS);
    assert.equal(out.at(-1).ts, 9999);
    assert.equal(out[0].ts, 1, '最旧的那条被挤掉');
  });

  test('空追加不改变原数组内容', () => {
    assert.deepEqual(appendEvents([{ ts: 1 }], []), [{ ts: 1 }]);
  });
});

test.describe('classifyRestartPattern —— 频率判据（取代「最后一次退出码」）', () => {
  const ev = (ts, label = 'com.ccm.tunnel', kind = 'restarted') => ({ ts, label, kind });
  const HOUR = 3600_000;

  test('一天一次的 DHCP 漂移重启 → 不算 flapping', () => {
    // 机主机器上的真实模式：路由器每天换一次 IP，看门狗 kickstart 一次
    // 用 23h/47h 而不是整 24h/48h：整数倍恰好压在窗口边界上，测的就成了 < 与 <= 的区别，
    // 而不是「一天一次算不算 flapping」这个真正的意图。
    const events = [ev(T - 71 * HOUR), ev(T - 47 * HOUR), ev(T - 23 * HOUR), ev(T - 2 * HOUR)];
    const r = classifyRestartPattern(events, { label: 'com.ccm.tunnel', now: T });
    assert.equal(r.flapping, false, '每天一次是正常运维，不该恒亮告警');
    assert.equal(r.lastHour, 0);
    assert.equal(r.last24h, 2);
  });

  test('1 小时内 3 次 → flapping（真的在崩溃重启循环里）', () => {
    const events = [ev(T - 30 * 60_000), ev(T - 20 * 60_000), ev(T - 10 * 60_000)];
    const r = classifyRestartPattern(events, { label: 'com.ccm.tunnel', now: T });
    assert.equal(r.flapping, true);
    assert.equal(r.lastHour, 3);
  });

  test('1 小时内 2 次 → 还不算（阈值是 3）', () => {
    const events = [ev(T - 30 * 60_000), ev(T - 10 * 60_000)];
    assert.equal(classifyRestartPattern(events, { label: 'com.ccm.tunnel', now: T }).flapping, false);
  });

  test('刚好落在窗口边界外的不计入', () => {
    const events = [ev(T - HOUR - 1000), ev(T - HOUR - 2000), ev(T - HOUR - 3000)];
    const r = classifyRestartPattern(events, { label: 'com.ccm.tunnel', now: T });
    assert.equal(r.lastHour, 0);
    assert.equal(r.flapping, false);
  });

  test('只算这个 label 自己的事件', () => {
    const events = [
      ev(T - 10 * 60_000, 'com.ccm.server'),
      ev(T - 20 * 60_000, 'com.ccm.server'),
      ev(T - 30 * 60_000, 'com.ccm.server'),
      ev(T - 5 * 60_000, 'com.ccm.tunnel'),
    ];
    assert.equal(classifyRestartPattern(events, { label: 'com.ccm.tunnel', now: T }).lastHour, 1);
    assert.equal(classifyRestartPattern(events, { label: 'com.ccm.server', now: T }).flapping, true);
  });

  test('stopped 不计入重启次数（那是用户主动停的）', () => {
    const events = [
      ev(T - 10 * 60_000, 'com.ccm.tunnel', 'stopped'),
      ev(T - 20 * 60_000, 'com.ccm.tunnel', 'stopped'),
      ev(T - 30 * 60_000, 'com.ccm.tunnel', 'stopped'),
    ];
    assert.equal(classifyRestartPattern(events, { label: 'com.ccm.tunnel', now: T }).flapping, false);
  });

  test('started 计入（stop 后又起来，从进程角度就是重新开始）', () => {
    const events = [
      ev(T - 10 * 60_000, 'com.ccm.tunnel', 'started'),
      ev(T - 20 * 60_000, 'com.ccm.tunnel', 'started'),
      ev(T - 30 * 60_000, 'com.ccm.tunnel', 'restarted'),
    ];
    assert.equal(classifyRestartPattern(events, { label: 'com.ccm.tunnel', now: T }).flapping, true);
  });

  test('没有事件 → 一切为零，不 flapping', () => {
    const r = classifyRestartPattern([], { label: 'x', now: T });
    assert.deepEqual({ ...r }, { lastHour: 0, last24h: 0, flapping: false, lastRestartAt: null });
  });

  test('给出最近一次重启时间（UI 要显示「上次重启：3 小时前」）', () => {
    const events = [ev(T - 5 * HOUR), ev(T - 3 * HOUR)];
    assert.equal(classifyRestartPattern(events, { label: 'com.ccm.tunnel', now: T }).lastRestartAt, T - 3 * HOUR);
  });
});

test.describe('validateServiceEvents —— 读盘校验', () => {
  test('合法数组原样通过', () => {
    const ok = [{ ts: 1, label: 'a', kind: 'restarted', from: 1, to: 2, lastExit: 0 }];
    assert.deepEqual(validateServiceEvents(ok), ok);
  });

  test('非数组 / 坏 JSON 结果 → 空数组，不抛错（读不懂就当没有历史）', () => {
    assert.deepEqual(validateServiceEvents(null), []);
    assert.deepEqual(validateServiceEvents('nope'), []);
    assert.deepEqual(validateServiceEvents({ events: [] }), []);
  });

  test('丢弃形状不合法的条目，保留合法的', () => {
    const out = validateServiceEvents([
      { ts: 1, label: 'a', kind: 'restarted' },
      { label: 'b' },              // 缺 ts
      { ts: 'x', label: 'c', kind: 'restarted' }, // ts 不是数字
      { ts: 2, label: 'd', kind: '乱写' },        // kind 不在枚举里
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].label, 'a');
  });

  test('超过上限时只保留最近的（防手工塞一个巨大文件进来）', () => {
    const many = Array.from({ length: MAX_SERVICE_EVENTS + 50 }, (_, i) => ({ ts: i, label: 'a', kind: 'restarted' }));
    const out = validateServiceEvents(many);
    assert.equal(out.length, MAX_SERVICE_EVENTS);
    assert.equal(out.at(-1).ts, MAX_SERVICE_EVENTS + 49);
  });
});
