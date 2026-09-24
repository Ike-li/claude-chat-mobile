// tests/unit/auto-continue.test.mjs —— 额度墙自动继续的调度层（app/src/server/auto-continue.js）
//
// 判定规则（能不能布防、抖动、24h 视界、空转熔断、睡过头、墙是否仍是尾部）在
// quota-auto-continue.test.mjs 里单测，本文件【不重复测】。这里只测编排层自己的行为：
//   · 布防后到点才发、发的是什么、发给谁（活实例 / 被空闲回收后 resume 出来的新实例）
//   · 不发的几种理由各自落成什么（移除 / stale 等用户点「继续」）
//   · 用户自己发了消息、会话被删、三个按钮动作
//   · 同一次布防至多发一次（重叠的 tick 不得双发）
//   · 定时器只在有条目时跑
// 「终端 / 桌面端还开着这个会话时不得代发」是 SESSION-01，用真注册表与真 transcript 守在
// tests/invariants/auto-continue-single-driver.test.mjs，这里只用假的注册表喂分支。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAutoContinue } from '../../app/src/server/auto-continue.js';
import {
  AUTO_CONTINUE_JITTER_MIN_MS,
  AUTO_CONTINUE_PROMPT,
  AUTO_CONTINUE_REARM_CAP,
  AUTO_CONTINUE_SLEEP_GRACE_MS,
} from '../../app/src/agent/quota-auto-continue.js';
import { terminalStateKey } from '../../app/src/sessions/session-registry.js';

const SID = 'sess-1';
const CWD = '/Users/you/code/app';
const T0 = Date.UTC(2026, 8, 22, 17, 48, 20);
const RESET_S = Math.floor(T0 / 1000) + 3 * 3600;
const RESET_MS = RESET_S * 1000;
const FIRE_AT = RESET_MS + AUTO_CONTINUE_JITTER_MIN_MS; // random()=0

const QUOTA = Object.freeze({
  status: 'rejected', resetsAt: RESET_S, rateLimitType: 'five_hour',
  overageStatus: 'rejected', isUsingOverage: false,
});
const WALL_ENTRY = {
  type: 'assistant', uuid: 'wall-1', isApiErrorMessage: true, error: 'rate_limit', quotaLimits: QUOTA,
  message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: "You've hit your session limit" }] },
};
const humanEntry = text => ({ type: 'user', uuid: `u-${text}`, message: { role: 'user', content: text } });

function fakeInstance({ pendingTurns = 0, externalDirty = false, sendResult = true } = {}) {
  const inst = {
    sent: [], notices: [], pendingTurns, externalDirty,
    async send(text, model, opts) { inst.sent.push({ text, model, opts }); return sendResult; },
    emitNotice(message, level) { inst.notices.push({ message, level }); },
  };
  return inst;
}

function harness(over = {}) {
  let now = T0;
  let intervalFn = null;
  const cleared = [];
  const changes = { n: 0 };
  const live = new Map();
  const resumed = [];
  const h = {
    get now() { return now; },
    set now(v) { now = v; },
    live, resumed, changes, cleared,
    tail: [humanEntry('跑个长任务'), WALL_ENTRY],
    terminal: new Map(),
    autoEnabled: true,
    resumeError: null,
    get timerArmed() { return intervalFn !== null; },
  };
  h.ac = createAutoContinue({
    now: () => now,
    random: () => 0,
    setIntervalFn: (fn) => { intervalFn = fn; return { unref() {} }; },
    clearIntervalFn: (t) => { cleared.push(t); intervalFn = null; },
    isAutoEnabled: () => h.autoEnabled,
    readTailEntries: async () => (typeof h.tail === 'function' ? h.tail() : h.tail),
    listTerminalStates: async () => h.terminal,
    getLiveInstance: sid => live.get(sid) ?? null,
    resumeInstance: async (cwd, sid) => {
      if (h.resumeError) throw h.resumeError;
      const inst = fakeInstance();
      resumed.push({ cwd, sid, inst });
      live.set(sid, inst);
      return inst;
    },
    onChange: () => { changes.n++; },
    log: () => {},
    ...over,
  });
  h.wall = (extra = {}) => h.ac.onWall({
    sessionId: SID, cwd: CWD, instance: live.get(SID) ?? null,
    wall: { uuid: 'wall-1', quota: QUOTA, fallback: null, turnOrigin: 'human', turnHadOutput: true, ...extra },
  });
  h.tickAt = async (t) => { now = t; await h.ac.tick(); };
  return h;
}

const entryOf = h => h.ac.snapshot().find(e => e.sessionId === SID) ?? null;

test.describe('布防与到点', () => {
  test('撞墙 → 快照里出现 armed 条目（带重置时刻与到点时刻），并通知广播', () => {
    const h = harness();
    h.live.set(SID, fakeInstance());
    h.wall();
    const e = entryOf(h);
    assert.equal(e.phase, 'armed');
    assert.equal(e.resetsAt, RESET_MS);
    assert.equal(e.fireAt, FIRE_AT);
    assert.equal(e.cwd, CWD);
    assert.ok(h.changes.n >= 1, '前端靠 instances 广播拿到横幅数据');
    assert.ok(h.timerArmed, '有条目就要有 tick');
  });

  test('未到点的 tick 什么都不发', async () => {
    const h = harness();
    const inst = fakeInstance();
    h.live.set(SID, inst);
    h.wall();
    await h.tickAt(FIRE_AT - 1);
    assert.equal(inst.sent.length, 0);
    assert.equal(entryOf(h).phase, 'armed');
  });

  test('到点 → 给活实例发 CLI 同款续跑提示词（auto-continuation 归属），条目清掉', async () => {
    const h = harness();
    const inst = fakeInstance();
    h.live.set(SID, inst);
    h.wall();
    await h.tickAt(FIRE_AT - 10_000); // 正常节拍
    await h.tickAt(FIRE_AT + 1);
    assert.equal(inst.sent.length, 1);
    assert.equal(inst.sent[0].text, AUTO_CONTINUE_PROMPT);
    assert.equal(inst.sent[0].opts.origin, 'auto-continuation', '标成 human 就是伪造来源');
    assert.equal(entryOf(h), null);
    assert.ok(inst.notices.some(n => /自动继续/.test(n.message)), '时间线上要看得出这一轮不是用户自己发的');
    assert.equal(h.timerArmed, false, '没有条目了就停表');
  });

  test('实例已被空闲回收 → 到点 resume 出新实例再发（等待常达 5 小时，回收是常态）', async () => {
    const h = harness();
    h.wall();
    await h.tickAt(FIRE_AT - 10_000);
    await h.tickAt(FIRE_AT + 1);
    assert.equal(h.resumed.length, 1);
    assert.deepEqual([h.resumed[0].cwd, h.resumed[0].sid], [CWD, SID]);
    assert.equal(h.resumed[0].inst.sent.length, 1);
  });
});

test.describe('到点但不发', () => {
  test('墙之后已有人发过消息（transcript 尾部不再是墙）→ 移除，不发', async () => {
    const h = harness();
    const inst = fakeInstance();
    h.live.set(SID, inst);
    h.wall();
    h.tail = [humanEntry('x'), WALL_ENTRY, humanEntry('我在终端接着干了')];
    await h.tickAt(FIRE_AT - 10_000);
    await h.tickAt(FIRE_AT + 1);
    assert.equal(inst.sent.length, 0);
    assert.equal(entryOf(h), null);
  });

  test('transcript 读不到（无法核实）→ 转 stale 等用户点「继续」，不代发', async () => {
    const h = harness();
    const inst = fakeInstance();
    h.live.set(SID, inst);
    h.wall();
    h.tail = null;
    await h.tickAt(FIRE_AT - 10_000);
    await h.tickAt(FIRE_AT + 1);
    assert.equal(inst.sent.length, 0);
    assert.deepEqual([entryOf(h).phase, entryOf(h).reason], ['stale', 'unverified']);
  });

  test('注册表显示终端/桌面端开着这个会话 → stale（other_driver），不代发', async () => {
    const h = harness();
    const inst = fakeInstance();
    h.live.set(SID, inst);
    h.wall();
    h.terminal = new Map([[terminalStateKey(CWD, SID), { state: 'alive', source: 'cli' }]]);
    await h.tickAt(FIRE_AT - 10_000);
    await h.tickAt(FIRE_AT + 1);
    assert.equal(inst.sent.length, 0);
    assert.deepEqual([entryOf(h).phase, entryOf(h).reason], ['stale', 'other_driver']);
  });

  test('等待期间机器睡过了重置点 → stale（slept），醒来不自动发', async () => {
    const h = harness();
    const inst = fakeInstance();
    h.live.set(SID, inst);
    h.wall();
    await h.tickAt(T0 + 30_000);
    await h.tickAt(FIRE_AT + 2 * 3600_000); // 与上一拍相隔远超宽限
    assert.ok(FIRE_AT + 2 * 3600_000 - (T0 + 30_000) > AUTO_CONTINUE_SLEEP_GRACE_MS);
    assert.equal(inst.sent.length, 0);
    assert.deepEqual([entryOf(h).phase, entryOf(h).reason], ['stale', 'slept']);
  });

  test('到点时会话已在跑一轮（别处先发了）→ 移除，不发', async () => {
    const h = harness();
    const inst = fakeInstance({ pendingTurns: 1 });
    h.live.set(SID, inst);
    h.wall();
    await h.tickAt(FIRE_AT - 10_000);
    await h.tickAt(FIRE_AT + 1);
    assert.equal(inst.sent.length, 0);
    assert.equal(entryOf(h), null);
  });

  test('实例被标了 externalDirty（终端写过、内存上下文已陈旧）→ stale，不从旧叶子代发', async () => {
    const h = harness();
    const inst = fakeInstance({ externalDirty: true });
    h.live.set(SID, inst);
    h.wall();
    await h.tickAt(FIRE_AT - 10_000);
    await h.tickAt(FIRE_AT + 1);
    assert.equal(inst.sent.length, 0);
    assert.deepEqual([entryOf(h).phase, entryOf(h).reason], ['stale', 'other_driver']);
  });

  test('resume 还在进行时用户点了取消 → 醒来不发（resume 冷启动可达数秒）', async () => {
    let release;
    const gate = new Promise(r => { release = r; });
    const inst = fakeInstance();
    const h = harness({ resumeInstance: async () => { await gate; return inst; } });
    h.wall();
    await h.tickAt(FIRE_AT - 10_000);
    h.now = FIRE_AT + 1;
    const ticking = h.ac.tick();
    await new Promise(r => setImmediate(r)); // 让 fire 走到 resume 的 await 上
    h.ac.act(SID, 'cancel');
    release();
    await ticking;
    await h.ac.idle();
    assert.equal(inst.sent.length, 0);
  });

  test('resume 失败（如活跃会话数已满）→ stale（resume_failed），让用户看得见', async () => {
    const h = harness();
    h.resumeError = new Error('超过最大活跃会话数量');
    h.wall();
    await h.tickAt(FIRE_AT - 10_000);
    await h.tickAt(FIRE_AT + 1);
    assert.deepEqual([entryOf(h).phase, entryOf(h).reason], ['stale', 'resume_failed']);
  });

  test('布防后开关被关掉 → 自动布防的条目到点不发', async () => {
    const h = harness();
    const inst = fakeInstance();
    h.live.set(SID, inst);
    h.wall();
    h.autoEnabled = false;
    await h.tickAt(FIRE_AT - 10_000);
    await h.tickAt(FIRE_AT + 1);
    assert.equal(inst.sent.length, 0);
    assert.equal(entryOf(h), null);
  });
});

test.describe('用户的动作', () => {
  test('用户自己往这个会话发了消息 → 布防作废', async () => {
    const h = harness();
    const inst = fakeInstance();
    h.live.set(SID, inst);
    h.wall();
    h.ac.onManualSend(SID);
    assert.equal(entryOf(h), null);
    await h.tickAt(FIRE_AT + 1);
    assert.equal(inst.sent.length, 0);
  });

  test('会话被删 / 用户显式关掉标签 → 条目清掉', () => {
    for (const why of [undefined, 'closed']) {
      const h = harness();
      h.wall();
      h.ac.onSessionGone(SID, why);
      assert.equal(entryOf(h), null, `why=${why}`);
    }
  });

  test('「取消」→ 条目清掉，到点不发', async () => {
    const h = harness();
    const inst = fakeInstance();
    h.live.set(SID, inst);
    h.wall();
    assert.deepEqual(h.ac.act(SID, 'cancel'), { ok: true });
    await h.tickAt(FIRE_AT + 1);
    assert.equal(inst.sent.length, 0);
  });

  test('开关关着 → 只 offer；点「到点自动继续」→ 手动布防，到点照发', async () => {
    const h = harness();
    const inst = fakeInstance();
    h.live.set(SID, inst);
    h.autoEnabled = false;
    h.wall();
    assert.deepEqual([entryOf(h).phase, entryOf(h).reason], ['offered', 'disabled']);
    assert.deepEqual(h.ac.act(SID, 'arm'), { ok: true });
    assert.deepEqual([entryOf(h).phase, entryOf(h).origin], ['armed', 'manual']);
    await h.tickAt(FIRE_AT - 10_000);
    await h.tickAt(FIRE_AT + 1);
    assert.equal(inst.sent.length, 1, '用户亲手点的布防不受总开关约束——开关管的是「自动」');
  });

  test('stale 条目点「继续」→ 立即走同一套复核后发出', async () => {
    const h = harness();
    const inst = fakeInstance();
    h.live.set(SID, inst);
    h.wall();
    await h.tickAt(T0 + 30_000);
    await h.tickAt(FIRE_AT + 2 * 3600_000);
    assert.equal(entryOf(h).phase, 'stale');
    assert.deepEqual(h.ac.act(SID, 'continueNow'), { ok: true });
    await h.ac.idle();
    assert.equal(inst.sent.length, 1);
    assert.equal(entryOf(h), null);
  });

  test('不认识的会话 / 动作 → ok:false，不改任何状态', () => {
    const h = harness();
    h.wall();
    assert.equal(h.ac.act('nope', 'cancel').ok, false);
    assert.equal(h.ac.act(SID, 'explode').ok, false);
    assert.equal(h.ac.act(SID, 'continueNow').ok, false, 'armed 条目不接受「立即继续」：还没到重置点');
    assert.equal(entryOf(h).phase, 'armed');
  });

  test('offer 过了重置点就撤掉（那之后用户直接发消息即可）', async () => {
    const h = harness();
    h.autoEnabled = false;
    h.wall();
    await h.tickAt(RESET_MS + 1);
    assert.equal(entryOf(h), null);
  });
});

test.describe('至多发一次', () => {
  test('复核还没回来时又到一拍 → 不得双发', async () => {
    const h = harness();
    const inst = fakeInstance();
    h.live.set(SID, inst);
    h.wall();
    let release;
    const gate = new Promise(r => { release = r; });
    h.tail = () => gate.then(() => [humanEntry('x'), WALL_ENTRY]);
    await h.tickAt(FIRE_AT - 10_000);
    h.now = FIRE_AT + 1;
    const first = h.ac.tick();
    h.now = FIRE_AT + 30_001;
    const second = h.ac.tick();
    release();
    await Promise.all([first, second]);
    await h.ac.idle();
    assert.equal(inst.sent.length, 1);
  });

  test('stale 条目上连点两次「继续」→ 只发一次', async () => {
    const h = harness();
    const inst = fakeInstance();
    h.live.set(SID, inst);
    h.wall();
    await h.tickAt(T0 + 30_000);
    await h.tickAt(FIRE_AT + 2 * 3600_000);
    assert.equal(entryOf(h).phase, 'stale');
    h.ac.act(SID, 'continueNow');
    h.ac.act(SID, 'continueNow');
    await h.ac.idle();
    assert.equal(inst.sent.length, 1, '第二次若也发出去，真实例会回一条「当前任务运行中」的噪音，或更糟地排进下一轮');
  });
});

test.describe('撞墙时就不布防的情形', () => {
  test('网关裸 429（没有重置时刻）且开关开着 → 在会话里说明无法自动继续', () => {
    const h = harness();
    const inst = fakeInstance();
    h.live.set(SID, inst);
    h.ac.onWall({ sessionId: SID, cwd: CWD, instance: inst, wall: { uuid: 'w', quota: null, fallback: null, turnOrigin: 'human', turnHadOutput: false } });
    assert.equal(entryOf(h), null);
    assert.ok(inst.notices.some(n => /重置时间/.test(n.message)), '不说的话用户会以为功能坏了、一直等');
  });

  test('开关关着时撞裸 429 不多说一句（用户本就没指望自动继续）', () => {
    const h = harness();
    const inst = fakeInstance();
    h.live.set(SID, inst);
    h.autoEnabled = false;
    h.ac.onWall({ sessionId: SID, cwd: CWD, instance: inst, wall: { uuid: 'w', quota: null, fallback: null, turnOrigin: 'human', turnHadOutput: false } });
    assert.equal(inst.notices.length, 0);
  });

  test(`续跑后连续空转超过 ${AUTO_CONTINUE_REARM_CAP} 次 → 熔断、说明原因、条目清掉`, () => {
    const h = harness();
    const inst = fakeInstance();
    h.live.set(SID, inst);
    for (let i = 0; i <= AUTO_CONTINUE_REARM_CAP; i++) {
      h.wall({ turnOrigin: 'auto-continuation', turnHadOutput: false });
    }
    assert.equal(entryOf(h), null);
    assert.ok(inst.notices.some(n => /停止自动继续/.test(n.message)));
  });

  test('没有 sessionId 的墙（会话 id 还没落定）→ 忽略', () => {
    const h = harness();
    h.ac.onWall({ sessionId: null, cwd: CWD, instance: null, wall: { uuid: 'w', quota: QUOTA, fallback: null, turnOrigin: 'human', turnHadOutput: false } });
    assert.equal(h.ac.snapshot().length, 0);
    assert.equal(h.timerArmed, false);
  });
});

test('stop() 清表、停表（服务关闭时调用）', () => {
  const h = harness();
  h.wall();
  h.ac.stop();
  assert.equal(h.ac.snapshot().length, 0);
  assert.equal(h.timerArmed, false);
});
