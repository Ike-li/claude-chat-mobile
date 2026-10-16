// tests/invariants/instance-identity.test.mjs —— 实例句柄跨重启不复用、离线重放核对会话（纯函数那一半）
// 守护：MSG-02（客户端手里的 instanceId 不得指到另一个会话：发号跨重启不复用；带着入队时 sessionId 的重放，句柄失效或指着别的会话时改投该会话此刻的活实例，没有才按 stale 拒收）
// 测什么：① createInstanceManager 每建一次（= 一次启动）发出的号，与别的那次不相交
//         ② resolveInstanceTarget 带上 expectedSessionId 时，命中活实例还要核对它此刻跑的会话
//         ③ 句柄失效（规则 5 置换、切 effort 换了号）或指着别的会话时，改投入队时那个会话此刻的活实例；没有活实例照旧 stale
//         ④ 离线队列条目的 sessionId 活过 localStorage 往返（序列化是白名单，不登记就被静默丢掉）
// 不测什么 + 为什么：① 真重启后的重放与续传接线、规则 5 置换后同一批第 2 条的真实接线 —— 要真组装根，
//                      归 S2（tests/invariants/server/instance-identity.test.mjs）
//                   ② 前端入队时记下哪个 sessionId、重放时有没有带上 —— 在 app.js 里，归 S3（tests/e2e/specs/input-send-empty.spec.ts）
// 槽位：S1（纯函数，数据进数据出）
import test from 'node:test';
import assert from 'node:assert/strict';
import { createInstanceManager } from '../../app/src/server/instance-manager.js';
import { resolveInstanceTarget } from '../../app/src/server/instance-routing.js';
import {
  planOutboxEnqueue,
  dumpDurableOutbox,
  parseDurableOutbox,
} from '../../app/public/js/logic/outbox-send.js';

test.describe('发号跨重启不复用', () => {
  test('两次启动各自从头发号，号码也不得撞上', () => {
    // 2026-10-16 云端 review P0-2 的根因：计数器在进程内、重启归零，新进程又从 inst_1 发起。
    // 手机上排着的消息带着旧进程发的 inst_1 重放，命中的是新进程里另一个项目的会话。
    const before = createInstanceManager();
    const after = createInstanceManager();
    const old = [before.nextId(), before.nextId(), before.nextId()];
    const fresh = [after.nextId(), after.nextId(), after.nextId()];
    for (const id of fresh) {
      assert.ok(!old.includes(id),
        `重启后发出的 ${id} 与上一进程发过的号相同：客户端拿着旧号重放，会投进这个新开的、不相干的会话`);
    }
  });

  test('同一次启动内照旧不重复', () => {
    const manager = createInstanceManager();
    const ids = Array.from({ length: 50 }, () => manager.nextId());
    assert.equal(new Set(ids).size, ids.length, '同一进程里发出了重复的实例号');
  });
});

test.describe('resolveInstanceTarget：带着入队时的会话，命中活实例也要对上', () => {
  const sessions = new Map([['inst_a', 'sess-a'], ['inst_fresh', null]]);
  const isLive = id => sessions.has(id);
  const sessionOf = id => sessions.get(id) ?? null;
  const viewing = 'inst_a';

  test('会话对得上 → 照常命中（正对照：这道核对不能把正常重放也拦掉）', () => {
    assert.deepEqual(
      resolveInstanceTarget('inst_a', viewing, isLive, { expectedSessionId: 'sess-a', sessionOf }),
      { id: 'inst_a', stale: false },
    );
  });

  test('实例还活着，但跑的已经是另一个会话 → stale，不投递', () => {
    assert.deepEqual(
      resolveInstanceTarget('inst_a', viewing, isLive, { expectedSessionId: 'sess-other', sessionOf }),
      { id: null, stale: true },
      '入队时这条消息属于 sess-other，投进 sess-a 就是把它交给另一段对话去执行',
    );
  });

  test('命中的实例还没有会话（新开、init 未到）而条目带着会话 → stale', () => {
    // 客户端知道的 sessionId 只可能来自服务端，而实例的 sessionId 一旦有了就不会变回空。
    // 条目带着会话、实例却没有，说明这根本不是入队时那个实例。
    assert.deepEqual(
      resolveInstanceTarget('inst_fresh', viewing, isLive, { expectedSessionId: 'sess-a', sessionOf }),
      { id: null, stale: true },
    );
  });

  test('条目没带会话（升级前入队的、入队时会话还没开出来的）→ 维持原行为，只看活不活', () => {
    for (const expectedSessionId of [undefined, null, '']) {
      assert.deepEqual(
        resolveInstanceTarget('inst_a', viewing, isLive, { expectedSessionId, sessionOf }),
        { id: 'inst_a', stale: false },
        `expectedSessionId=${JSON.stringify(expectedSessionId)} 时不该多拦`,
      );
    }
  });

  test('没指定实例时 expectedSessionId 不改变缺省语义（那条路走懒开，不在这里判）', () => {
    assert.deepEqual(
      resolveInstanceTarget(null, viewing, isLive, { allowViewingFallback: false, expectedSessionId: 'sess-x', sessionOf }),
      { id: null, stale: false },
    );
  });
});

// 2026-10-16 review P2「离线同一批第 2 条起被判 stale」：第 1 条触发规则 5 置换（dispose + resume 换了实例号），
// 后面的条目还拿着置换前的句柄。会话没关，只是换了进程——身份是会话，句柄只是入队那一刻的进程号。
test.describe('resolveInstanceTarget：离线重放的句柄失效了，会话还开着 → 改投这个会话此刻的实例', () => {
  // inst_new 是 sess-a 置换后的新实例（规则 5 / 切 effort / 另一台设备重开过），inst_gone 是置换前的旧号
  const sessions = new Map([['inst_new', 'sess-a'], ['inst_b', 'sess-b']]);
  const isLive = id => sessions.has(id);
  const sessionOf = id => sessions.get(id) ?? null;
  const liveInstanceOfSession = sid => [...sessions].find(([, s]) => s === sid)?.[0] ?? null;
  const replay = extra => ({ allowViewingFallback: false, sessionOf, liveInstanceOfSession, ...extra });

  test('旧句柄已不在、入队时那个会话有活实例 → 改投它', () => {
    assert.deepEqual(
      resolveInstanceTarget('inst_gone', 'inst_new', isLive, replay({ expectedSessionId: 'sess-a' })),
      { id: 'inst_new', stale: false, followed: true },
      '判成 stale 的话，前端落「目标会话已关闭」永久失败、不给重发，而会话明明还开着',
    );
  });

  test('句柄还活着但跑的是别的会话，入队时那个会话在另一个实例上 → 改投那个实例，不投句柄', () => {
    assert.deepEqual(
      resolveInstanceTarget('inst_b', null, isLive, replay({ expectedSessionId: 'sess-a' })),
      { id: 'inst_new', stale: false, followed: true },
      '句柄指着 sess-b，这条却是给 sess-a 的：投句柄就是把它交给另一段对话执行（MSG-02）',
    );
  });

  test('句柄对得上 → 用句柄本身，不改投（正对照：改投只在句柄失效时发生）', () => {
    assert.deepEqual(
      resolveInstanceTarget('inst_b', null, isLive, replay({ expectedSessionId: 'sess-b', liveInstanceOfSession: () => 'inst_new' })),
      { id: 'inst_b', stale: false },
    );
  });

  test('会话此刻没有活实例（空闲回收了、用户关掉了）→ 照旧 stale，不替用户把会话重新拉起来', () => {
    assert.deepEqual(
      resolveInstanceTarget('inst_gone', null, isLive, replay({ expectedSessionId: 'sess-closed' })),
      { id: null, stale: true },
    );
  });

  test('条目没带会话（升级前入队的、入队时会话还没开出来的）→ 无从知道它属于哪段对话，照旧 stale', () => {
    for (const expectedSessionId of [undefined, null, '']) {
      assert.deepEqual(
        resolveInstanceTarget('inst_gone', null, isLive, replay({ expectedSessionId })),
        { id: null, stale: true },
        `expectedSessionId=${JSON.stringify(expectedSessionId)} 时不该改投`,
      );
    }
  });

  test('调用方不给查找函数（在线发送）→ 与改投前一致，只核对不改投', () => {
    assert.deepEqual(
      resolveInstanceTarget('inst_gone', null, isLive, { expectedSessionId: 'sess-a', sessionOf }),
      { id: null, stale: true },
    );
  });
});

test.describe('离线队列条目带着会话过 localStorage 往返', () => {
  const item = {
    text: '离线时打的字', clientMessageId: 'c-1', instanceId: 'inst_a', cwd: '/proj-a', sessionId: 'sess-a',
  };

  test('入队 → 落盘 → 读回，sessionId 还在', () => {
    const { queue } = planOutboxEnqueue([], item);
    const [row] = parseDurableOutbox(dumpDurableOutbox(queue));
    assert.equal(row.sessionId, 'sess-a',
      '序列化是白名单：sessionId 没登记就会在入队或刷新页面时被丢掉，服务端就无从核对重放的目标');
  });

  test('没有或不是字符串的 sessionId 不落键（服务端判的是非空字符串）', () => {
    for (const sessionId of [undefined, null, '', 42, { id: 'x' }]) {
      const { queue } = planOutboxEnqueue([], { ...item, sessionId });
      const [row] = parseDurableOutbox(dumpDurableOutbox(queue));
      assert.equal('sessionId' in row, false, `sessionId=${JSON.stringify(sessionId)} 不该留下来`);
    }
  });
});
