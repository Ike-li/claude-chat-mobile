// tests/unit/logic-session-panel.test.mjs —— 工作区抽屉 SWR 保鲜 + 按目录局部重建的纯逻辑单测。
// 覆盖 shouldRerenderSessionList / buildDirInstanceSignatures / diffDirSignatures（见 public/js/logic.js
// 对应函数注释）。同域拆分惯例：logic-session.test.mjs 已 800 行硬顶，新行为域另起文件。
import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldRerenderSessionList, buildDirInstanceSignatures, diffDirSignatures } from '../../public/js/logic.js';

test('shouldRerenderSessionList: 首次拿到数据（此前无缓存/正显示骨架屏）恒需要渲染', () => {
  assert.equal(shouldRerenderSessionList({ hasPrevEntry: false, nextSessions: [] }), true);
  assert.equal(shouldRerenderSessionList({ hasPrevEntry: false, nextSessions: [{ id: 'a', title: 'A' }] }), true);
});

test('shouldRerenderSessionList: 内容完全一致（id/title/lastUsedAt 相同）不需要重渲染', () => {
  const prev = [{ id: 's1', title: 'Foo', lastUsedAt: 100 }, { id: 's2', title: 'Bar', lastUsedAt: 50 }];
  const next = [{ id: 's1', title: 'Foo', lastUsedAt: 100 }, { id: 's2', title: 'Bar', lastUsedAt: 50 }];
  assert.equal(shouldRerenderSessionList({ hasPrevEntry: true, prevSessions: prev, prevHasMore: false, nextSessions: next, nextHasMore: false }), false);
});

test('shouldRerenderSessionList: 标题真变了必须检测到（防回归：不能为了少重渲而漏真变化）', () => {
  const prev = [{ id: 's1', title: 'Old Title', lastUsedAt: 100 }];
  const next = [{ id: 's1', title: 'New Title', lastUsedAt: 100 }];
  assert.equal(shouldRerenderSessionList({ hasPrevEntry: true, prevSessions: prev, nextSessions: next }), true);
});

test('shouldRerenderSessionList: 新增/删除会话需要重渲染', () => {
  const prev = [{ id: 's1', title: 'Foo', lastUsedAt: 100 }];
  const next = [{ id: 's1', title: 'Foo', lastUsedAt: 100 }, { id: 's2', title: 'New', lastUsedAt: 200 }];
  assert.equal(shouldRerenderSessionList({ hasPrevEntry: true, prevSessions: prev, nextSessions: next }), true);
  assert.equal(shouldRerenderSessionList({ hasPrevEntry: true, prevSessions: next, nextSessions: prev }), true);
});

test('shouldRerenderSessionList: hasMore 翻转（"显示全部"按钮出现/消失）需要重渲染', () => {
  const sessions = [{ id: 's1', title: 'Foo', lastUsedAt: 100 }];
  assert.equal(shouldRerenderSessionList({ hasPrevEntry: true, prevSessions: sessions, prevHasMore: true, nextSessions: sessions, nextHasMore: false }), true);
});

test('shouldRerenderSessionList: 空/未定义入参安全，不抛异常', () => {
  assert.equal(shouldRerenderSessionList(), true); // hasPrevEntry 缺省 false → 必须渲染
  assert.equal(shouldRerenderSessionList({ hasPrevEntry: true }), false); // 两边都是"无数据"视为无变化
});

test('buildDirInstanceSignatures: 按 cwd 分组，同目录多实例按入参顺序拼接', () => {
  const instances = [
    { instanceId: 'i1', cwd: '/a', sessionId: 's1', title: 'Foo' },
    { instanceId: 'i2', cwd: '/b', sessionId: 's2', title: 'Bar' },
    { instanceId: 'i3', cwd: '/a', sessionId: null, title: 'Fresh' },
  ];
  const sig = buildDirInstanceSignatures(instances, ['/a', '/b']);
  assert.equal(sig['/a'], 'i1:s1:Foo,i3::Fresh');
  assert.equal(sig['/b'], 'i2:s2:Bar');
});

test('buildDirInstanceSignatures: 空目录（无实例）签名为空字符串', () => {
  const sig = buildDirInstanceSignatures([], ['/a', '/b']);
  assert.deepEqual(sig, { '/a': '', '/b': '' });
});

test('buildDirInstanceSignatures: 无 instanceId 的实例被跳过；实例 cwd 不在 dirs 里也按自身 cwd 计入', () => {
  const instances = [
    { instanceId: null, cwd: '/a', title: 'Ghost' },
    { instanceId: 'i1', cwd: '/orphan', sessionId: 's1', title: 'Orphan' },
  ];
  const sig = buildDirInstanceSignatures(instances, ['/a']);
  assert.equal(sig['/a'], '');
  assert.equal(sig['/orphan'], 'i1:s1:Orphan');
});

test('buildDirInstanceSignatures: title 只取前 20 字符', () => {
  const longTitle = 'x'.repeat(50);
  const instances = [{ instanceId: 'i1', cwd: '/a', sessionId: 's1', title: longTitle }];
  const sig = buildDirInstanceSignatures(instances, ['/a']);
  assert.equal(sig['/a'], `i1:s1:${'x'.repeat(20)}`);
});

test('buildDirInstanceSignatures: 实例 title/sessionId 变化会反映在签名里（供 diffDirSignatures 检出）', () => {
  const before = buildDirInstanceSignatures([{ instanceId: 'i1', cwd: '/a', sessionId: 's1', title: 'Old' }], ['/a']);
  const after = buildDirInstanceSignatures([{ instanceId: 'i1', cwd: '/a', sessionId: 's1', title: 'New' }], ['/a']);
  assert.notEqual(before['/a'], after['/a']);
});

test('buildDirInstanceSignatures: 空/未定义入参安全', () => {
  assert.deepEqual(buildDirInstanceSignatures(), {});
  assert.deepEqual(buildDirInstanceSignatures(undefined, ['/a']), { '/a': '' });
});

test('diffDirSignatures: 无变化返回空数组', () => {
  const prev = { '/a': 'x', '/b': 'y' };
  const next = { '/a': 'x', '/b': 'y' };
  assert.deepEqual(diffDirSignatures(prev, next), []);
});

test('diffDirSignatures: 只有一个目录变化时只报告该目录（防回归：真实变化必须被检测到）', () => {
  const prev = { '/a': 'x', '/b': 'y' };
  const next = { '/a': 'x-changed', '/b': 'y' };
  assert.deepEqual(diffDirSignatures(prev, next), ['/a']);
});

test('diffDirSignatures: 多个目录同时变化都要报告，按字母序排序', () => {
  const prev = { '/a': 'x', '/b': 'y', '/c': 'z' };
  const next = { '/a': 'x2', '/b': 'y', '/c': 'z2' };
  assert.deepEqual(diffDirSignatures(prev, next), ['/a', '/c']);
});

test('diffDirSignatures: 空/未定义入参安全', () => {
  assert.deepEqual(diffDirSignatures(), []);
  assert.deepEqual(diffDirSignatures({ '/a': 'x' }, undefined), ['/a']);
});


test('shouldRerenderSessionList: terminal 徽标变化需要重渲染（K3）', () => {
  const prev = [{ id: 'a', title: 'A', lastUsedAt: 1, terminal: null }];
  const next = [{ id: 'a', title: 'A', lastUsedAt: 1, terminal: 'busy' }];
  assert.equal(shouldRerenderSessionList({ hasPrevEntry: true, prevSessions: prev, nextSessions: next }), true);
  assert.equal(shouldRerenderSessionList({ hasPrevEntry: true, prevSessions: next, nextSessions: next }), false);
});
