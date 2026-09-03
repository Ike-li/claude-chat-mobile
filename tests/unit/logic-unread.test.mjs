// tests/unit/logic-unread.test.mjs —— R65 未读点判定（纯函数，浏览器与 node 共用）
// 语义红线（见 draft/plan-unread-dot-fable-5.md）：点=看过即清（lastUsedAt > seenAt），
// 与「需要你」chip/聚合（答过才清）分层不合并；首装基线不追溯；正在看的不亮。
import test from 'node:test';
import assert from 'node:assert/strict';
import { isSessionUnread, markSeenEntry, setManualUnreadEntry, parseUnreadState, serializeUnreadState, resolveDirUnreadBadge } from '../../app/public/js/logic/unread.js';

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

// 手动未读（长按「标为未读」）：用户显式要求「稍后再看」，压过时间判据——哪怕活动在基线前、
// 哪怕早就看过；只有「正在看」仍然不亮（自己正看着的内容不算未读，和自动未读同一条红线）。
test.describe('isSessionUnread：手动未读压过时间判据', () => {
  test('手动标记 + 活动在基线前（本来永不亮的历史会话）→ 亮', () => {
    assert.equal(isSessionUnread({ lastUsedAt: T0 - MIN, baselineTs: T0, manual: true }), true);
  });

  test('手动标记 + 看过之后无新活动 → 仍亮（标记不因「看过」失效，只因再次打开失效）', () => {
    assert.equal(isSessionUnread({ lastUsedAt: T0 + MIN, seenAt: T0 + 2 * MIN, baselineTs: T0, manual: true }), true);
  });

  test('手动标记 + 无 lastUsedAt → 亮（标记不依赖时间字段）', () => {
    assert.equal(isSessionUnread({ lastUsedAt: null, baselineTs: T0, manual: true }), true);
  });

  test('★ 手动标记 + 正在看 → 不亮', () => {
    assert.equal(isSessionUnread({ lastUsedAt: T0 - MIN, baselineTs: T0, manual: true, isViewing: true }), false);
  });

  test('manual 缺省/false → 行为与改动前完全一致', () => {
    assert.equal(isSessionUnread({ lastUsedAt: T0 - MIN, baselineTs: T0, manual: false }), false);
    assert.equal(isSessionUnread({ lastUsedAt: T0 + MIN, baselineTs: T0 }), true);
  });
});

test.describe('setManualUnreadEntry：手动未读表的不可变增删', () => {
  test('on=true 记入标记时刻且不改原对象', () => {
    const before = {};
    const after = setManualUnreadEntry(before, 'a', true, T0);
    assert.equal(after.a, T0);
    assert.equal(before.a, undefined, '必须返回新对象');
  });

  test('on=false 移除该会话；不存在时原样返回同一对象（调用方可据此免写盘）', () => {
    const before = { a: T0, b: T0 + 1 };
    const after = setManualUnreadEntry(before, 'a', false);
    assert.deepEqual(after, { b: T0 + 1 });
    assert.equal(before.a, T0, '不原地改');
    assert.equal(setManualUnreadEntry(before, 'zzz', false), before);
  });

  test('超过上限淘汰最旧的（与 seen 表同一套 LRU by ts），新记录必留', () => {
    let manual = {};
    for (let i = 0; i < 3; i++) manual = setManualUnreadEntry(manual, `s${i}`, true, T0 + i, 3);
    manual = setManualUnreadEntry(manual, 'newest', true, T0 + 100, 3);
    assert.equal(Object.keys(manual).length, 3);
    assert.equal(manual.s0, undefined);
    assert.equal(manual.newest, T0 + 100);
  });

  test('sessionId 缺失时原样返回', () => {
    const manual = { a: T0 };
    assert.equal(setManualUnreadEntry(manual, '', true, T0), manual);
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

  test('往返保真：serialize → parse 保留基线、seen 表与 manual 表', () => {
    const state = { baselineTs: T0, seen: { a: T0 + 1, b: T0 + 2 }, manual: { c: T0 + 3 } };
    const back = parseUnreadState(serializeUnreadState(state), T0 + 999);
    assert.deepEqual(back, state, '已有基线不得被 now 覆盖——覆盖=每次启动都重置基线，点永远不亮');
  });

  test('旧版本落盘（无 manual 字段）→ manual 回空表，其余原样（升级不丢已读表）', () => {
    const back = parseUnreadState(JSON.stringify({ baselineTs: T0, seen: { a: T0 } }), T0 + 999);
    assert.deepEqual(back, { baselineTs: T0, seen: { a: T0 }, manual: {} });
  });

  test('seen / manual 里的非数字值被丢弃（防手改/旧版本残留）', () => {
    const back = parseUnreadState(JSON.stringify({ baselineTs: T0, seen: { a: 'x', b: T0 }, manual: { c: true, d: T0 } }), T0);
    assert.deepEqual(back.seen, { b: T0 });
    assert.deepEqual(back.manual, { d: T0 });
  });

  test('全新状态也带空 manual 表', () => {
    assert.deepEqual(parseUnreadState(null, T0), { baselineTs: T0, seen: {}, manual: {} });
  });
});

// ---- resolveDirUnreadBadge：目录头角标的三态 ----
// 2026-09-02 实测缺陷：刷新后 sessionsCache（纯内存）必空，折叠目录不 populate，unreadCountForDir
// 返回 null；旧渲染把 null 与 0 一并隐藏，于是「我还不知道」被画成了「这个目录没有未读」——用户看到
// 的不是加载中，是一个错误的事实（12 秒后 background revalidate 填上缓存，角标才凭空冒出来）。
// 三态分开：unknown 要有占位，0 才是真的什么都不画。
test.describe('resolveDirUnreadBadge：未知 ≠ 确定没有', () => {
  test('count=null（缓存未到位）→ pending 占位，不声称 0', () => {
    const r = resolveDirUnreadBadge(null);
    assert.equal(r.state, 'pending');
    assert.equal(r.visible, true, '必须占位——什么都不画就等于在说「没有未读」');
    assert.equal(r.text, '', '占位不写数字（还不知道）');
  });

  test('count=0（确定没有未读）→ 隐藏，不占视觉噪音', () => {
    assert.deepEqual(resolveDirUnreadBadge(0), { state: 'none', visible: false, text: '' });
  });

  test('count>0 → 显示「N 未读」', () => {
    const r = resolveDirUnreadBadge(3);
    assert.equal(r.state, 'unread');
    assert.equal(r.visible, true);
    assert.equal(r.text, '3 未读');
  });

  test('脏输入（undefined / NaN / 负数 / 字符串）一律按未知处理，不按 0', () => {
    for (const bad of [undefined, NaN, -1, '2', {}]) {
      assert.equal(resolveDirUnreadBadge(bad).state, 'pending', String(bad));
    }
  });
});
