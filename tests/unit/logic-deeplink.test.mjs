// tests/unit/logic-deeplink.test.mjs —— 通知深链落地策略（②2c）的行为域单测。
// 从 logic-ui-state.test.mjs 分出：按行为域拆分是硬门禁（见 source-layout.test.mjs），
// 深链这一域已自成一块——instanceId 命中 / 失效回退 / sessionId 兜底。

import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveDeepLinkTarget } from '../../app/public/js/logic.js';

// ---- resolveDeepLinkTarget：通知深链落地 + instanceId 失效回退（②2c）----
test.describe('resolveDeepLinkTarget：通知深链落地策略', () => {
  const instances = [{ instanceId: 'inst_1' }, { instanceId: 'inst_2' }];
  test('instanceId 命中 live → setViewing', () => {
    assert.deepEqual(resolveDeepLinkTarget({ instanceId: 'inst_2', sessionId: 's2', cwd: '/r' }, instances),
      { action: 'setViewing', instanceId: 'inst_2' });
  });
  test('instanceId 失效但有 sessionId → switch（带 cwd，懒 resume 接住实例重生/关闭）', () => {
    assert.deepEqual(resolveDeepLinkTarget({ instanceId: 'gone', sessionId: 's9', cwd: '/r' }, instances),
      { action: 'switch', sessionId: 's9', cwd: '/r' });
  });
  test('instanceId 失效且无 sessionId → list', () => {
    assert.deepEqual(resolveDeepLinkTarget({ instanceId: 'gone' }, instances), { action: 'list' });
  });
  test('无 target / 无 instanceId → list', () => {
    assert.deepEqual(resolveDeepLinkTarget(null, instances), { action: 'list' });
    assert.deepEqual(resolveDeepLinkTarget({}, instances), { action: 'list' });
  });
  test('instances 缺省不抛（冷启动 instances 未到）', () => {
    assert.deepEqual(resolveDeepLinkTarget({ instanceId: 'x', sessionId: 's', cwd: '/r' }),
      { action: 'switch', sessionId: 's', cwd: '/r' });
  });
});

// instanceId 是进程内计数器（inst_${++counter}），server 重启即从 inst_1 重新发号 —— 「同号」≠「同会话」。
// 重启后点一条留在通知栏的旧通知会落进另一个项目的会话，用户以为在 A 实际在 B，后续发消息/授权全是错投。
test.describe('resolveDeepLinkTarget：instanceId 复用后必须靠 sessionId 兜底', () => {
  test('同 instanceId 但 sessionId 不符 → 不当 live，走 session:switch 精确定位', () => {
    const r = resolveDeepLinkTarget(
      { instanceId: 'inst_3', sessionId: 'sess-a', cwd: '/proj-a' },
      [{ instanceId: 'inst_3', sessionId: 'sess-b' }], // 重启后 inst_3 被另一个会话复用
    );
    assert.deepEqual(r, { action: 'switch', sessionId: 'sess-a', cwd: '/proj-a' });
  });
  test('instanceId 与 sessionId 都对得上 → 仍走最快的 setViewing', () => {
    const r = resolveDeepLinkTarget(
      { instanceId: 'inst_3', sessionId: 'sess-a', cwd: '/proj-a' },
      [{ instanceId: 'inst_3', sessionId: 'sess-a' }],
    );
    assert.deepEqual(r, { action: 'setViewing', instanceId: 'inst_3' });
  });
  test('旧通知无 sessionId / 快照无 sessionId → 保持旧行为（不因缺字段退化成 list）', () => {
    assert.deepEqual(
      resolveDeepLinkTarget({ instanceId: 'inst_3' }, [{ instanceId: 'inst_3', sessionId: 'sess-b' }]),
      { action: 'setViewing', instanceId: 'inst_3' },
    );
    assert.deepEqual(
      resolveDeepLinkTarget({ instanceId: 'inst_3', sessionId: 'sess-a' }, [{ instanceId: 'inst_3' }]),
      { action: 'setViewing', instanceId: 'inst_3' },
    );
  });
});
