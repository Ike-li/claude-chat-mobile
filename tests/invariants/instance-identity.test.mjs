// tests/invariants/instance-identity.test.mjs —— 实例句柄跨重启不复用、离线重放核对会话（纯函数那一半）
// 守护：MSG-02（客户端手里的 instanceId 不得指到另一个会话：发号跨重启不复用；带着入队时 sessionId 的重放，命中的实例换了会话按 stale 拒收）
// 测什么：① createInstanceManager 每建一次（= 一次启动）发出的号，与别的那次不相交
//         ② resolveInstanceTarget 带上 expectedSessionId 时，命中活实例还要核对它此刻跑的会话
//         ③ 离线队列条目的 sessionId 活过 localStorage 往返（序列化是白名单，不登记就被静默丢掉）
// 不测什么 + 为什么：① 真重启后的重放与续传接线 —— 要两次真启动，归 S2（tests/invariants/server/instance-identity.test.mjs）
//                   ② 前端入队时记下哪个 sessionId、重放时有没有带上 —— 在 app.js 里，归 S3（tests/e2e/specs/input-send-empty.spec.ts）
//                   ③ 规则 5 置换换了号之后，同一批离线消息第 2 条起被判 stale —— 另一个缺陷，本条不管
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
