// tests/unit/instance-routing.test.mjs —— 实例路由目标解析纯函数单测
// BE-001：显式但已关闭的 instanceId 必须 fail-closed，不静默回退到当前查看实例（否则消息/中断误投别的会话）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveInstanceTarget, reselectViewingTarget } from '../../src/server/instance-routing.js';

test.describe('resolveInstanceTarget（BE-001：区分缺省回退 / 命中 / 显式 stale）', () => {
  const live = new Set(['inst_a', 'inst_b']);
  const isLive = id => live.has(id);
  const viewing = 'inst_b';

  test('缺省 undefined → 回退 viewingInstanceId，非 stale（向后兼容缺参旧调用）', () => {
    assert.deepEqual(resolveInstanceTarget(undefined, viewing, isLive), { id: 'inst_b', stale: false });
  });

  test('缺省 null → 同样回退 viewingInstanceId', () => {
    assert.deepEqual(resolveInstanceTarget(null, viewing, isLive), { id: 'inst_b', stale: false });
  });

  test('显式命中 live → 该实例本身', () => {
    assert.deepEqual(resolveInstanceTarget('inst_a', viewing, isLive), { id: 'inst_a', stale: false });
  });

  test('显式但已不在 live（已关闭）→ stale=true、id=null（fail-closed，绝不回退 viewing）', () => {
    assert.deepEqual(resolveInstanceTarget('inst_gone', viewing, isLive), { id: null, stale: true });
  });

  test('缺省且无 viewing（首发/无 open tab）→ id=null 但非 stale（调用方应懒开而非拒绝）', () => {
    assert.deepEqual(resolveInstanceTarget(undefined, null, isLive), { id: null, stale: false });
  });

  test('显式 stale 即便 viewing 为 null 仍判 stale（不因无 viewing 就退化成懒开）', () => {
    assert.deepEqual(resolveInstanceTarget('inst_gone', null, isLive), { id: null, stale: true });
  });

  test('空字符串 instanceId 视为「显式但未知」→ stale（客户端不应发空 id；真缺省用 null/undefined）', () => {
    assert.deepEqual(resolveInstanceTarget('', viewing, isLive), { id: null, stale: true });
  });
});

// BE-016：当前查看实例被移除后，重选查看目标并【原子同步】viewingCwd——落到剩余实例取其 cwd，
// 落到空视图(null)保留刚移除实例的 cwd（否则裸 viewingCwd 停在更早旧值，新会话选目录/statusline 跳回旧工作区）。
test.describe('reselectViewingTarget（BE-016：移除当前查看实例后原子重选 ID+cwd）', () => {
  const cwdOf = id => ({ a: '/repo/a', b: '/repo/b' }[id]);

  test('有剩余实例 → 选插入序第一个剩余，cwd 同步为该实例', () => {
    assert.deepEqual(
      reselectViewingTarget(['b'], '/repo/a', cwdOf, '/fallback'),
      { viewingInstanceId: 'b', viewingCwd: '/repo/b' }
    );
  });

  test('无剩余实例 → viewingInstanceId=null，viewingCwd 保留刚移除实例的 cwd（不回退旧值）', () => {
    assert.deepEqual(
      reselectViewingTarget([], '/repo/a', cwdOf, '/fallback'),
      { viewingInstanceId: null, viewingCwd: '/repo/a' }
    );
  });

  test('无剩余且 removedCwd 为空 → 回退 fallbackCwd', () => {
    assert.deepEqual(
      reselectViewingTarget([], null, cwdOf, '/fallback'),
      { viewingInstanceId: null, viewingCwd: '/fallback' }
    );
  });

  test('多个剩余 → 取插入序第一个（对齐 agents.keys().next().value）', () => {
    assert.deepEqual(
      reselectViewingTarget(['b', 'a'], '/repo/x', cwdOf, '/fallback'),
      { viewingInstanceId: 'b', viewingCwd: '/repo/b' }
    );
  });
});
