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
  deserializeSnapshot,
  diffRunningState,
  serializeSnapshot,
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

  // ★ 用户主动点「立即重启」也会换 pid，采样器照样产出一条 restarted。而配置面板在**每次保存
  // 成功后**都给一个「立即重启」按钮 —— 手机上改三次配置就凑够「1 小时 3 次」，doctor 报
  // 「疑似崩溃重启循环」、面板行变红、菜单栏图标变 ◐，而根本没有任何东西崩过。
  // 这正是本模块头注写着要消灭的那类恒亮误报，从另一扇门回来了。
  test.describe('主动重启不算崩溃', () => {
    const intent = (ts, label = 'com.ccm.server') => ({ ts, label, kind: 'restart-requested' });

    test('★ 三次「点按钮重启」→ 不是 flapping', () => {
      const events = [
        intent(T - 50 * 60_000), ev(T - 50 * 60_000 + 3000, 'com.ccm.server'),
        intent(T - 30 * 60_000), ev(T - 30 * 60_000 + 4000, 'com.ccm.server'),
        intent(T - 10 * 60_000), ev(T - 10 * 60_000 + 2500, 'com.ccm.server'),
      ];
      const r = classifyRestartPattern(events, { label: 'com.ccm.server', now: T });
      assert.equal(r.flapping, false, '用户自己按的三次重启不是崩溃循环');
      assert.equal(r.lastHour, 0, '有意的重启不进频率计数');
    });

    test('★ 但重启之后真的崩起来了，照样要报', () => {
      const events = [
        intent(T - 40 * 60_000), ev(T - 40 * 60_000 + 3000, 'com.ccm.server'),
        ev(T - 20 * 60_000, 'com.ccm.server'),   // 这三条没有对应的 intent
        ev(T - 12 * 60_000, 'com.ccm.server'),
        ev(T - 4 * 60_000, 'com.ccm.server'),
      ];
      const r = classifyRestartPattern(events, { label: 'com.ccm.server', now: T });
      assert.equal(r.lastHour, 3, '一条 intent 只抵消紧随其后的一条，不抵消整个窗口');
      assert.equal(r.flapping, true, '一次主动重启不该给后续的崩溃循环打掩护');
    });

    test('intent 之后隔了很久才重启 → 那是另一回事，照算', () => {
      const events = [
        intent(T - 50 * 60_000),
        ev(T - 20 * 60_000, 'com.ccm.server'),   // 距 intent 半小时，不是它引起的
        ev(T - 12 * 60_000, 'com.ccm.server'),
        ev(T - 4 * 60_000, 'com.ccm.server'),
      ];
      assert.equal(classifyRestartPattern(events, { label: 'com.ccm.server', now: T }).flapping, true);
    });

    test('lastRestartAt 仍取全部重启的最后一条 —— 那是事实，不是判据', () => {
      const events = [intent(T - 10 * 60_000), ev(T - 10 * 60_000 + 2000, 'com.ccm.server')];
      const r = classifyRestartPattern(events, { label: 'com.ccm.server', now: T });
      assert.equal(r.lastRestartAt, T - 10 * 60_000 + 2000, '历史面板要如实显示「上次重启在几分钟前」');
    });

    test('别的 label 的 intent 不能抵消本 label 的重启', () => {
      const events = [
        intent(T - 30 * 60_000, 'com.ccm.tunnel'),
        ev(T - 30 * 60_000 + 2000, 'com.ccm.server'),
        ev(T - 20 * 60_000, 'com.ccm.server'),
        ev(T - 10 * 60_000, 'com.ccm.server'),
      ];
      assert.equal(classifyRestartPattern(events, { label: 'com.ccm.server', now: T }).flapping, true);
    });
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

  // ★ 这条用例原本断言的是 `started 计入 → flapping=true`，2026-08-14 第三轮审查推翻了那个设计：
  // 那正是让短命周期 job（tunnel-watch / logrotate）恒亮告警的原因。判据收窄成只认 restarted。
  test('started 不计入（那是「从无到有」，周期 job 每轮都这样）', () => {
    const events = [
      ev(T - 10 * 60_000, 'com.ccm.tunnel', 'started'),
      ev(T - 20 * 60_000, 'com.ccm.tunnel', 'started'),
      ev(T - 30 * 60_000, 'com.ccm.tunnel', 'restarted'),
    ];
    const r = classifyRestartPattern(events, { label: 'com.ccm.tunnel', now: T });
    assert.equal(r.lastHour, 1, '三条里只有一条是 restarted');
    assert.equal(r.flapping, false);
  });

  test('没有事件 → 一切为零，不 flapping', () => {
    const r = classifyRestartPattern([], { label: 'x', now: T });
    assert.deepEqual({ ...r }, { lastHour: 0, last24h: 0, manual24h: 0, flapping: false, lastRestartAt: null });
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

// ── 第三轮审查修复：短命周期 job 不再被算成重启 ──────────────────────────
//
// 机主机器上的实证：`com.ccm.tunnel-watch`（每 30s 检测 en0 的 DHCP 漂移）与 `com.ccm.logrotate`
// 在 `launchctl list` 里 pid 恒为 `-` —— 它们是**短命周期 job**，不是常驻进程。采样器每 60s 抓
// 一次，抓到在跑就产 started、下次抓到已退出就产 stopped。把 started 计入频率的后果是：
// 一小时抓到三次就报 flapping ——**这正是本功能立意要消灭的「恒亮告警」，只是换了个 label**。
//
// 判据改成只认 restarted（pid→pid，进程被就地换掉）。取舍写明：
//   · 常驻服务的崩溃循环在 60s 粒度下几乎必然表现为 pid→pid（KeepAlive 会立刻拉起），命中
//   · 周期 job 的形态是 null↔pid 交替，天然不命中
//   · 代价：真「停了很久再手动起来」的循环不计入频率 —— 但那是用户操作，本来就不是 flapping
test.describe('classifyRestartPattern —— 短命周期 job 不算 flapping', () => {
  const at = (ts, kind) => ({ ts, label: 'com.ccm.tunnel-watch', kind });

  test('started/stopped 交替 8 次 → 不算 flapping（周期 job 的形态）', () => {
    const events = [];
    for (let i = 0; i < 4; i += 1) {
      events.push(at(T - (8 - i * 2) * 60_000, 'started'));
      events.push(at(T - (7 - i * 2) * 60_000, 'stopped'));
    }
    const r = classifyRestartPattern(events, { label: 'com.ccm.tunnel-watch', now: T });
    assert.equal(r.flapping, false, '周期 job 来了又走不是崩溃循环');
    assert.equal(r.lastHour, 0, 'started/stopped 都不计入频率');
  });

  test('pid→pid 的 restarted 仍然计入（真崩溃循环的形态）', () => {
    const events = [at(T - 30 * 60_000, 'restarted'), at(T - 20 * 60_000, 'restarted'), at(T - 10 * 60_000, 'restarted')];
    assert.equal(classifyRestartPattern(events, { label: 'com.ccm.tunnel-watch', now: T }).flapping, true);
  });

  test('started 混进来也不会把 restarted 的计数推过阈值', () => {
    const events = [
      at(T - 50 * 60_000, 'restarted'), at(T - 40 * 60_000, 'started'),
      at(T - 30 * 60_000, 'started'), at(T - 20 * 60_000, 'restarted'),
    ];
    const r = classifyRestartPattern(events, { label: 'com.ccm.tunnel-watch', now: T });
    assert.equal(r.lastHour, 2, '只有两条 restarted');
    assert.equal(r.flapping, false);
  });
});

// ── 第三轮审查修复：时钟回拨不再制造假 flapping ─────────────────────────
//
// `now - e.ts < WINDOW` 对**未来**时间戳的差值是负数，而负数恒 < 窗口 ⇒ 全部历史事件
// 一起落进「1 小时内」。触发路径：NTP 大幅回拨 / VM 快照回滚 / 手改过 service-events.json。
test.describe('classifyRestartPattern —— 未来时间戳不计入窗口', () => {
  const HOUR = 3600_000;
  const ev = (ts) => ({ ts, label: 'com.ccm.tunnel', kind: 'restarted' });

  test('时钟回拨（事件 ts 在未来）→ 不算 flapping', () => {
    const events = Array.from({ length: 10 }, (_, i) => ev(T + (i + 1) * 24 * HOUR));
    const r = classifyRestartPattern(events, { label: 'com.ccm.tunnel', now: T });
    assert.equal(r.flapping, false, '未来时间戳不该被当成「刚刚发生」');
    assert.equal(r.lastHour, 0);
    assert.equal(r.last24h, 0);
  });

  test('未来事件不污染 lastRestartAt（否则 UI 显示负的「多久以前」）', () => {
    const events = [ev(T - 2 * HOUR), ev(T + 30 * 24 * HOUR)];
    const r = classifyRestartPattern(events, { label: 'com.ccm.tunnel', now: T });
    assert.equal(r.lastRestartAt, T - 2 * HOUR, '取最近的**过去**事件');
  });
});

// ── 第三轮审查修复：快照可持久化，跨 server 生命周期比对 ──────────────────
//
// 修的是本功能最大的盲区：`com.ccm.server` 自身的重启**结构性永远记不到**。
//   ① 命内：launchctl 里 com.ccm.server 的 pid 就是采样进程自己（ps 实证），恒定 ⇒ before===after
//   ② 跨命：快照只在内存，server 重启即归零 ⇒ 新命首次采样走「prev 为空」静默分支
// 于是最该被抓到的场景（server 自己在崩溃循环）恰恰是唯一抓不到的。把快照落盘后，
// 新命的首次采样拿得到上一命的 pid，server 换命就产出一条 restarted。
test.describe('快照序列化 —— 跨 server 生命周期比对', () => {
  test('序列化 → 反序列化 后可直接喂给 diffRunningState', () => {
    const before = snap({ 'com.ccm.server': { pid: 100, lastExit: 0 }, 'com.ccm.tunnel': { pid: 7, lastExit: -9 } });
    const restored = deserializeSnapshot(serializeSnapshot(before));
    assert.deepEqual([...restored.entries()], [...before.entries()]);
  });

  test('★ server 换命 → 认出 restarted（这条是整个修复的意义所在）', () => {
    const lastLife = deserializeSnapshot(serializeSnapshot(snap({ 'com.ccm.server': { pid: 51531, lastExit: 0 } })));
    const thisLife = snap({ 'com.ccm.server': { pid: 60001, lastExit: 0 } });
    const evs = diffRunningState(lastLife, thisLife, T);
    assert.equal(evs.length, 1);
    assert.equal(evs[0].kind, 'restarted');
    assert.equal(evs[0].from, 51531);
    assert.equal(evs[0].to, 60001);
  });

  test('读不懂的快照一律当作「没有基线」→ 首次采样仍静默，不伪造事件', () => {
    for (const bad of [null, undefined, 'x', 42, [], { 'com.ccm.server': 'nope' }, { 'com.ccm.server': { pid: 'x' } }]) {
      const m = deserializeSnapshot(bad);
      assert.ok(m instanceof Map, `应返回 Map：${JSON.stringify(bad)}`);
      assert.deepEqual(diffRunningState(m, snap({ 'com.ccm.server': { pid: 1 } }), T), [],
        `坏快照不该产出事件：${JSON.stringify(bad)}`);
    }
  });

  test('pid 为 null 的条目原样保留（周期 job 的常态，丢了会误判成 started）', () => {
    const m = deserializeSnapshot(serializeSnapshot(snap({ 'com.ccm.logrotate': { pid: null, lastExit: 0 } })));
    assert.equal(m.has('com.ccm.logrotate'), true);
    assert.equal(m.get('com.ccm.logrotate').pid, null);
  });
});
