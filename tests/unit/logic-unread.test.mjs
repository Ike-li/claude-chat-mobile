// tests/unit/logic-unread.test.mjs —— R65 未读点判定（纯函数，浏览器与 node 共用）
// 语义红线（见 draft/plan-unread-dot-fable-5.md）：点=看过即清（lastUsedAt > seenAt），
// 与「需要你」chip/聚合（答过才清）分层不合并；首装基线不追溯；正在看的不亮。
import test from 'node:test';
import assert from 'node:assert/strict';
import { isSessionUnread, markSeenEntry, parseUnreadState, serializeUnreadState } from '../../public/js/logic/unread.js';

const T0 = 1_700_000_000_000; // 基线
const MIN = 60_000;

test.describe('isSessionUnread：四态判定', () => {
  test('从未打开过 + 活动在基线之后 → 亮（这是点存在的理由）', () => {
    assert.equal(isSessionUnread({ lastUsedAt: T0 + MIN, baselineTs: T0 }), true);
  });

  test('★ 基线不追溯：从未打开过 + 活动在基线之前 → 不亮（首装历史会话零点）', () => {
    assert.equal(isSessionUnread({ lastUsedAt: T0 - MIN, baselineTs: T0 }), false);
    assert.equal(isSessionUnread({ lastUsedAt: T0, baselineTs: T0 }), false, '恰好等于基线也不亮');
  });

  test('看过即清：seenAt 之后无新活动 → 不亮；有新活动 → 复亮', () => {
    assert.equal(isSessionUnread({ lastUsedAt: T0 + MIN, seenAt: T0 + 2 * MIN, baselineTs: T0 }), false);
    assert.equal(isSessionUnread({ lastUsedAt: T0 + 3 * MIN, seenAt: T0 + 2 * MIN, baselineTs: T0 }), true);
  });

  test('★ 正在看的不亮——即便活动比 seenAt 新（自己正看着的内容不算未读）', () => {
    assert.equal(isSessionUnread({ lastUsedAt: T0 + 3 * MIN, seenAt: T0 + MIN, baselineTs: T0, isViewing: true }), false);
  });

  test('无 lastUsedAt（未落盘新会话行 / live-only 行）→ 不亮', () => {
    assert.equal(isSessionUnread({ lastUsedAt: null, baselineTs: T0 }), false);
    assert.equal(isSessionUnread({ lastUsedAt: undefined, baselineTs: T0 }), false);
  });
});

test.describe('markSeenEntry：不可变更新 + 容量上限', () => {
  test('记录时间戳且不改原对象', () => {
    const before = { a: T0 };
    const after = markSeenEntry(before, 'b', T0 + MIN);
    assert.equal(after.b, T0 + MIN);
    assert.equal(before.b, undefined, '必须返回新对象，不原地改');
  });

  test('超过上限淘汰最旧的（LRU by ts），新记录必留', () => {
    let seen = {};
    for (let i = 0; i < 5; i++) seen = markSeenEntry(seen, `s${i}`, T0 + i, 5);
    seen = markSeenEntry(seen, 'newest', T0 + 100, 5);
    assert.equal(Object.keys(seen).length, 5);
    assert.equal(seen.s0, undefined, '最旧的 s0 被淘汰');
    assert.equal(seen.newest, T0 + 100);
  });

  test('sessionId 缺失时原样返回', () => {
    const seen = { a: T0 };
    assert.equal(markSeenEntry(seen, '', T0), seen);
  });
});

test.describe('parseUnreadState / serializeUnreadState：localStorage 序列化守卫', () => {
  test('坏 JSON / 空值 → 全新状态，基线=now（隐私模式/首装都走这条）', () => {
    for (const raw of [null, undefined, '', '{bad json', '[]', '42']) {
      const s = parseUnreadState(raw, T0);
      assert.equal(s.baselineTs, T0, `raw=${String(raw).slice(0, 10)}`);
      assert.deepEqual(s.seen, {});
    }
  });

  test('往返保真：serialize → parse 保留基线与 seen 表', () => {
    const state = { baselineTs: T0, seen: { a: T0 + 1, b: T0 + 2 } };
    const back = parseUnreadState(serializeUnreadState(state), T0 + 999);
    assert.deepEqual(back, state, '已有基线不得被 now 覆盖——覆盖=每次启动都重置基线，点永远不亮');
  });

  test('seen 里的非数字值被丢弃（防手改/旧版本残留）', () => {
    const back = parseUnreadState(JSON.stringify({ baselineTs: T0, seen: { a: 'x', b: T0 } }), T0);
    assert.deepEqual(back.seen, { b: T0 });
  });
});
