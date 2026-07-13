// test/instance-routing.test.mjs —— 实例路由目标解析纯函数单测
// BE-001：显式但已关闭的 instanceId 必须 fail-closed，不静默回退到当前查看实例（否则消息/中断误投别的会话）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveInstanceTarget } from '../instance-routing.js';

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
