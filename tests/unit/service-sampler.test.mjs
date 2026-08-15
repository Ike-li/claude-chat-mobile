// tests/unit/service-sampler.test.mjs —— 重启历史采样器的 glue 层
//
// 这一层此前整个住在 src/server/app.js 里，**零测试**：`rg 'sampleServiceEvents' tests/` 无命中。
// 而它恰恰是 2026-08-14 第三轮审查里出问题最多的地方——快照只在内存（server 自身重启记不到）、
// 缺 mkdirSync（全新安装静默丢事件）、写失败时快照已推进（事件永久丢失）、搭了别人的开关。
// 判定逻辑在 service-events.js 且测得不错，**出事的全是 glue**。所以按 createServiceManager
// 的范式把 IO 全部注入，让 glue 本身可测。
import test from 'node:test';
import assert from 'node:assert/strict';

import { createServiceSampler } from '../../src/ops/service-sampler.js';

const T0 = 1786600000000;

/** 可控的假世界：launchctl 输出、两个文件、时钟，全部由用例摆布。 */
function world({ platform = 'darwin', units = {}, events = null, snapshot = null, failWriteEvents = false, failWriteSnapshot = false, listFails = false } = {}) {
  const state = {
    events, snapshot,
    live: new Map(Object.entries(units)),
    logs: [], warns: [],
    writes: { events: 0, snapshot: 0 },
    t: T0,
  };
  const sampler = createServiceSampler({
    platform,
    now: () => state.t,
    listUnits: () => (listFails ? null : state.live),
    readEventsRaw: () => state.events,
    writeEvents: (arr) => {
      if (failWriteEvents) throw new Error('EACCES');
      state.writes.events += 1; state.events = arr;
    },
    readSnapshotRaw: () => state.snapshot,
    writeSnapshot: (obj) => {
      if (failWriteSnapshot) throw new Error('ENOSPC');
      state.writes.snapshot += 1; state.snapshot = obj;
    },
    log: (m) => state.logs.push(m),
    warn: (m) => state.warns.push(m),
  });
  return { sampler, state };
}

const setLive = (state, units) => { state.live = new Map(Object.entries(units)); };

test.describe('createServiceSampler.sample —— 采样与落盘', () => {
  test('非 darwin 一律不采样（Linux 用 systemd，见 docs/deployment.md）', () => {
    const { sampler, state } = world({ platform: 'linux', units: { 'com.ccm.server': { pid: 1 } } });
    sampler.sample();
    assert.equal(state.writes.events, 0);
    assert.equal(state.writes.snapshot, 0);
  });

  test('launchctl 挂了 → 什么都不做，下一轮再试（不清空、不报错）', () => {
    const { sampler, state } = world({ listFails: true, snapshot: { 'com.ccm.server': { pid: 1 } } });
    sampler.sample();
    assert.equal(state.writes.events, 0);
    assert.deepEqual(state.snapshot, { 'com.ccm.server': { pid: 1 } }, '旧快照原样保留');
  });

  test('只记 com.ccm. 前缀的 unit（机器上还有十几个第三方 agent）', () => {
    const { sampler, state } = world({
      snapshot: { 'com.ccm.server': { pid: 1 }, 'com.apple.foo': { pid: 2 } },
      units: { 'com.ccm.server': { pid: 9 }, 'com.apple.foo': { pid: 99 } },
    });
    sampler.sample();
    assert.equal(state.events.length, 1);
    assert.equal(state.events[0].label, 'com.ccm.server');
    assert.deepEqual(Object.keys(state.snapshot), ['com.ccm.server'], '第三方 agent 也不进快照');
  });

  test('首次运行（盘上没有快照）→ 不产事件，但要把快照写下来当基线', () => {
    const { sampler, state } = world({ units: { 'com.ccm.server': { pid: 100 } } });
    sampler.sample();
    assert.equal(state.events, null, '没有可比的前值，不该伪造事件');
    assert.equal(state.writes.snapshot, 1, '基线必须落盘，否则下一条命还是没有可比的前值');
    assert.deepEqual(state.snapshot, { 'com.ccm.server': { pid: 100, lastExit: null } });
  });

  test('★ 盘上有上一条命的快照 → 认出 server 自己的重启', () => {
    const { sampler, state } = world({
      snapshot: { 'com.ccm.server': { pid: 51531, lastExit: 0 } },
      units: { 'com.ccm.server': { pid: 60001, lastExit: 0 } },
    });
    sampler.sample();
    assert.equal(state.events.length, 1);
    assert.equal(state.events[0].kind, 'restarted');
    assert.equal(state.events[0].from, 51531);
    assert.equal(state.events[0].to, 60001);
  });

  test('pid 没变 → 不写事件也不重复写快照（绝大多数采样都是这条）', () => {
    const { sampler, state } = world({
      snapshot: { 'com.ccm.server': { pid: 100, lastExit: null } },
      units: { 'com.ccm.server': { pid: 100 } },
    });
    sampler.sample();
    sampler.sample();
    assert.equal(state.writes.events, 0);
    assert.equal(state.writes.snapshot, 0, '内容没变就别每分钟碰一次盘');
  });

  // 断言「重试真的发生」而不是查内存变量：内部状态怎么存是实现细节，
  // 用户能观察到的契约是「这批事件没丢，下一轮还会被写出来」。
  test('★ 写事件失败 → 不推进快照，下一轮把同一批事件重新算出来', () => {
    let fail = true;
    const state = { events: null, snapshot: { 'com.ccm.server': { pid: 1, lastExit: null } }, warns: [] };
    const sampler = createServiceSampler({
      platform: 'darwin',
      now: () => T0,
      listUnits: () => new Map([['com.ccm.server', { pid: 2 }]]),
      readEventsRaw: () => state.events,
      writeEvents: (arr) => { if (fail) throw new Error('EACCES'); state.events = arr; },
      readSnapshotRaw: () => state.snapshot,
      writeSnapshot: (obj) => { state.snapshot = obj; },
      warn: (m) => state.warns.push(m),
    });

    sampler.sample();
    assert.equal(state.warns.length, 1, '要有一条 warn，不能静默');
    assert.equal(state.events, null, '没写成');
    assert.deepEqual(state.snapshot, { 'com.ccm.server': { pid: 1, lastExit: null } }, '快照不许推进');

    fail = false;
    sampler.sample(); // 下一轮：同样的 launchctl 输出
    assert.equal(state.events.length, 1, '同一批事件被重新算出来并写进去了');
    assert.equal(state.events[0].to, 2);
  });

  test('写快照失败不回滚已经落盘的事件（那是两件独立的事）', () => {
    const { sampler, state } = world({
      snapshot: { 'com.ccm.server': { pid: 1, lastExit: null } },
      units: { 'com.ccm.server': { pid: 2 } },
      failWriteSnapshot: true,
    });
    sampler.sample();
    assert.equal(state.writes.events, 1, '事件该落的还是落了');
    assert.equal(state.warns.length, 1);
  });

  test('事件文件坏了 → 当作没有历史，新事件照常追加（不抛错阻断）', () => {
    const { sampler, state } = world({
      events: 'not-an-array',
      snapshot: { 'com.ccm.server': { pid: 1, lastExit: null } },
      units: { 'com.ccm.server': { pid: 2 } },
    });
    sampler.sample();
    assert.equal(Array.isArray(state.events), true);
    assert.equal(state.events.length, 1);
  });

  test('快照文件坏了 → 退化成「没有基线」，静默一轮而不是伪造一堆 started', () => {
    const { sampler, state } = world({
      snapshot: { 'com.ccm.server': 'garbage' },
      units: { 'com.ccm.server': { pid: 2 } },
    });
    sampler.sample();
    assert.equal(state.events, null, '坏快照制造出来的假重启比没有历史更糟');
  });

  test('连续多轮：每次 pid 变化各记一条，快照跟着走', () => {
    const { sampler, state } = world({
      snapshot: { 'com.ccm.server': { pid: 1, lastExit: null } },
      units: { 'com.ccm.server': { pid: 2 } },
    });
    sampler.sample();
    state.t += 60_000; setLive(state, { 'com.ccm.server': { pid: 3 } });
    sampler.sample();
    state.t += 60_000; setLive(state, { 'com.ccm.server': { pid: 4 } });
    sampler.sample();
    assert.equal(state.events.length, 3);
    assert.deepEqual(state.events.map((e) => e.to), [2, 3, 4]);
  });

  test('每条事件都写一行日志（排障时要能在日志里看到）', () => {
    const { sampler, state } = world({
      snapshot: { 'com.ccm.server': { pid: 1, lastExit: null } },
      units: { 'com.ccm.server': { pid: 2 } },
    });
    sampler.sample();
    assert.equal(state.logs.length, 1);
    assert.match(state.logs[0], /com\.ccm\.server.*restarted/);
  });
});

test.describe('createServiceSampler.summarize —— 面板要的摘要', () => {
  const ev = (ts, label, kind = 'restarted') => ({ ts, label, kind });

  test('没有历史 → 空的两段（前端据此显示「暂无记录」）', () => {
    const { sampler } = world({});
    assert.deepEqual(sampler.summarize(), { units: [], recent: [] });
  });

  test('按 label 汇总，顺序稳定', () => {
    const { sampler } = world({ events: [ev(T0 - 1000, 'com.ccm.tunnel'), ev(T0 - 2000, 'com.ccm.server')] });
    assert.deepEqual(sampler.summarize().units.map((u) => u.label), ['com.ccm.server', 'com.ccm.tunnel']);
  });

  test('★ 时间线只留摘要里有话说的 unit —— 否则同一屏里两段互相打脸', () => {
    // 高频 label 有 12 条、tunnel 只有 1 条且更早：不过滤的话最近 10 条全是 noisy，
    // 而摘要那行却说「com.ccm.tunnel 24 小时内 1 次」
    const events = [ev(T0 - 90_000_000, 'com.ccm.tunnel')]; // 25 小时前 → 不进 24h 窗口
    for (let i = 12; i >= 1; i -= 1) events.push(ev(T0 - i * 60_000, 'com.ccm.noisy'));
    const { sampler } = world({ events });
    const s = sampler.summarize();
    const shown = new Set(s.units.filter((u) => u.last24h > 0 || u.flapping).map((u) => u.label));
    assert.equal(shown.has('com.ccm.noisy'), true);
    assert.equal(shown.has('com.ccm.tunnel'), false, '25 小时前那条不该进摘要');
    assert.equal(s.recent.every((e) => e.label === 'com.ccm.noisy'), true, '时间线只剩摘要里的 unit');
  });

  test('摘要为空时不过滤（那时时间线是唯一的信息）', () => {
    const { sampler } = world({ events: [ev(T0 - 90_000_000, 'com.ccm.tunnel')] });
    const s = sampler.summarize();
    assert.equal(s.units.filter((u) => u.last24h > 0 || u.flapping).length, 0);
    assert.equal(s.recent.length, 1, '仍然给出全局最近的几条');
  });

  test('时间线最新在前，且有上限', () => {
    const events = Array.from({ length: 30 }, (_, i) => ev(T0 - (30 - i) * 60_000, 'com.ccm.server'));
    const { sampler } = world({ events });
    const s = sampler.summarize();
    assert.equal(s.recent.length, 10);
    assert.equal(s.recent[0].ts > s.recent[1].ts, true, '倒序：最新的在前');
  });

  test('坏文件 → 空两段，不抛错（面板不该因为一个附属文件炸掉）', () => {
    const { sampler } = world({ events: { nope: 1 } });
    assert.deepEqual(sampler.summarize(), { units: [], recent: [] });
  });
});
