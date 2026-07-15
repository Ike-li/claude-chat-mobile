// tests/unit/attention.test.mjs —— "等我"聚合纯函数单测（需求与状态语义见 docs/design.md §3）
// deriveAttention(sessions, pendingApprovals) → { needsYou, others }：
// - needsYou 按 waitingSince 升序（等得越久排越前，OQ-01 已决）
// - 数据源两条互不重叠：审批维度直接来自 pendingApprovals（每项即一条 needsYou）、
//   输入维度来自 sessions 里 status==='awaiting_input' 的项（取其 awaitingSince）
// - others = sessions 中未出现在 needsYou 的部分，按 cwd 分组、lastActiveAt 降序
import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveAttention } from '../../src/sessions/attention.js';

test.describe('deriveAttention', () => {
  test('空输入：needsYou 与 others 均为空数组', () => {
    assert.deepEqual(deriveAttention([], []), { needsYou: [], others: [] });
  });

  test('审批维度：每条 pendingApproval 映射为一个 needsYou 项，reason=awaiting_approval，waitingSince=createdAt', () => {
    const approvals = [{ sessionId: 's1', cwd: '/a', title: '会话A', requestId: 'r1', createdAt: 1000, toolName: 'Bash' }];
    const { needsYou } = deriveAttention([], approvals);
    assert.deepEqual(needsYou, [
      { sessionId: 's1', cwd: '/a', title: '会话A', reason: 'awaiting_approval', waitingSince: 1000, risk: undefined, toolName: 'Bash' }
    ]);
  });

  test('输入维度：sessions 中 status=awaiting_input 的项映射为 needsYou，reason=awaiting_input，waitingSince=awaitingSince', () => {
    const sessions = [{ sessionId: 's2', cwd: '/b', title: '会话B', lastActiveAt: 500, status: 'awaiting_input', awaitingSince: 2000 }];
    const { needsYou } = deriveAttention(sessions, []);
    assert.deepEqual(needsYou, [
      { sessionId: 's2', cwd: '/b', title: '会话B', reason: 'awaiting_input', waitingSince: 2000 }
    ]);
  });

  test('sessions 中非 awaiting_input 状态（running/completed/idle 等）不进入 needsYou', () => {
    const sessions = [
      { sessionId: 's3', cwd: '/c', title: 'C', lastActiveAt: 1, status: 'running' },
      { sessionId: 's4', cwd: '/c', title: 'D', lastActiveAt: 2, status: 'completed' },
      { sessionId: 's5', cwd: '/c', title: 'E', lastActiveAt: 3, status: 'idle' },
      { sessionId: 's6', cwd: '/c', title: 'F', lastActiveAt: 4 }, // 无 status（非实时驱动会话）
    ];
    const { needsYou } = deriveAttention(sessions, []);
    assert.deepEqual(needsYou, []);
  });

  test('sessions 中 status=awaiting_input 但缺失 awaitingSince：防御性跳过（数据不完整不参与排序），但仍归入 others', () => {
    const sessions = [{ sessionId: 's7', cwd: '/d', title: 'G', lastActiveAt: 10, status: 'awaiting_input' }];
    const result = deriveAttention(sessions, []);
    assert.deepEqual(result.needsYou, []);
    assert.deepEqual(result.others, [{ sessionId: 's7', cwd: '/d', title: 'G', lastActiveAt: 10, status: 'awaiting_input' }]);
  });

  test('混合排序：审批项与输入项按 waitingSince 升序合并（等得最久的排最前，OQ-01 已决——不是降序）', () => {
    const sessions = [{ sessionId: 's-input', cwd: '/x', title: 'Input', lastActiveAt: 1, status: 'awaiting_input', awaitingSince: 3000 }];
    const approvals = [
      { sessionId: 's-appr-old', cwd: '/y', title: 'Old', requestId: 'r1', createdAt: 1000 },
      { sessionId: 's-appr-new', cwd: '/z', title: 'New', requestId: 'r2', createdAt: 5000 },
    ];
    const { needsYou } = deriveAttention(sessions, approvals);
    assert.deepEqual(needsYou.map(x => x.sessionId), ['s-appr-old', 's-input', 's-appr-new']);
  });

  test('risk 字段仅展示标签透传，不参与排序（OQ-01 已决：risk 不进排序公式）', () => {
    const approvals = [
      { sessionId: 'low', cwd: '/a', title: 'Low', requestId: 'r1', createdAt: 2000, risk: 'high' },
      { sessionId: 'high', cwd: '/a', title: 'High', requestId: 'r2', createdAt: 1000, risk: 'low' },
    ];
    const { needsYou } = deriveAttention([], approvals);
    // createdAt 更早（1000）的 'high' sessionId 排前，即便其 risk 标签是 'low'——risk 不影响顺序
    assert.deepEqual(needsYou.map(x => x.sessionId), ['high', 'low']);
    assert.equal(needsYou[0].risk, 'low');
    assert.equal(needsYou[1].risk, 'high');
  });

  test('others：排除已在 needsYou 中的 sessionId（同一会话不重复出现在两个区）', () => {
    const sessions = [
      { sessionId: 's-busy', cwd: '/a', title: 'Busy', lastActiveAt: 100, status: 'running' },
      { sessionId: 's-appr', cwd: '/a', title: 'Appr', lastActiveAt: 200, status: 'awaiting_approval' }, // 该会话自身状态是 awaiting_approval
    ];
    const approvals = [{ sessionId: 's-appr', cwd: '/a', title: 'Appr', requestId: 'r1', createdAt: 999 }];
    const { needsYou, others } = deriveAttention(sessions, approvals);
    assert.equal(needsYou.length, 1);
    assert.equal(needsYou[0].sessionId, 's-appr');
    assert.deepEqual(others.map(x => x.sessionId), ['s-busy']); // s-appr 不再出现在 others
  });

  test('others：按 cwd 分组、lastActiveAt 降序', () => {
    const sessions = [
      { sessionId: 's1', cwd: '/b', title: 'B1', lastActiveAt: 100, status: 'idle' },
      { sessionId: 's2', cwd: '/a', title: 'A1', lastActiveAt: 300, status: 'idle' },
      { sessionId: 's3', cwd: '/a', title: 'A2', lastActiveAt: 500, status: 'idle' },
    ];
    const { others } = deriveAttention(sessions, []);
    assert.deepEqual(others.map(x => x.sessionId), ['s3', 's2', 's1']); // /a 组内 500>300 在前，/a 排在 /b 之前（字典序）
  });

  test('同一会话两条独立 pendingApprovals（罕见但合法）：各自成一条 needsYou，不去重折叠', () => {
    const approvals = [
      { sessionId: 's1', cwd: '/a', title: 'A', requestId: 'r1', createdAt: 1000 },
      { sessionId: 's1', cwd: '/a', title: 'A', requestId: 'r2', createdAt: 2000 },
    ];
    const { needsYou } = deriveAttention([], approvals);
    assert.equal(needsYou.length, 2);
  });
});
