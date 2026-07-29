// tests/unit/logic-task-detail.test.mjs —— 后台任务详情面板纯逻辑单测。
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatProgressHistoryEntry, formatProgressTimestamp, taskDetailState } from '../../public/js/logic.js';

test.describe('formatProgressHistoryEntry（后台任务进度历史条目）', () => {
  test('summary 优先于 description', () => {
    const r = formatProgressHistoryEntry({ ts: Date.now(), description: 'Running...', lastToolName: 'Bash', summary: '45/120 tests passed' });
    assert.equal(r.text, 'Bash · 45/120 tests passed');
    assert.equal(r.hasSummary, true);
  });
  test('无 summary 时回退到 description', () => {
    const r = formatProgressHistoryEntry({ ts: Date.now(), description: 'npm test --force', lastToolName: 'Bash' });
    assert.equal(r.text, 'Bash · npm test --force');
    assert.equal(r.hasSummary, false);
  });
  test('无 lastToolName 时不加前缀', () => {
    const r = formatProgressHistoryEntry({ ts: Date.now(), summary: 'Analyzing codebase' });
    assert.equal(r.text, 'Analyzing codebase');
  });
  test('空输入返回空文本', () => {
    const r = formatProgressHistoryEntry({});
    assert.equal(r.text, '');
    assert.equal(r.time, '');
  });
});

test.describe('formatProgressTimestamp（进度时间戳格式化）', () => {
  test('30 秒内显示相对时间', () => {
    const ts = Date.now() - 30000;
    assert.match(formatProgressTimestamp(ts), /^\d+s$/);
  });
  test('2 分钟显示相对时间', () => {
    const ts = Date.now() - 120000;
    assert.match(formatProgressTimestamp(ts), /^\d+m$/);
  });
  test('超过 5 分钟显示绝对时间 HH:MM:SS', () => {
    const ts = Date.now() - 600000;
    assert.match(formatProgressTimestamp(ts), /^\d{2}:\d{2}:\d{2}$/);
  });
});

test.describe('taskDetailState（详情面板可见性）', () => {
  test('taskId 匹配 activeDetailId → visible', () => {
    assert.deepEqual(taskDetailState({ taskId: 't1', activeDetailId: 't1' }), { visible: true });
  });
  test('taskId 不匹配 → hidden', () => {
    assert.deepEqual(taskDetailState({ taskId: 't1', activeDetailId: 't2' }), { visible: false });
  });
  test('无 activeDetailId → hidden', () => {
    assert.deepEqual(taskDetailState({ taskId: 't1' }), { visible: false });
  });
  test('无 taskId → hidden', () => {
    assert.deepEqual(taskDetailState({ activeDetailId: 't1' }), { visible: false });
  });
});
