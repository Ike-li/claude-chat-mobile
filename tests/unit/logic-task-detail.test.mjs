// tests/unit/logic-task-detail.test.mjs —— 后台任务详情面板 + 横幅构成文案/分组纯逻辑单测。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyBgTaskKind,
  formatBgTaskBannerCopy,
  formatProgressHistoryEntry,
  formatProgressTimestamp,
  groupBgTasksForList,
  taskDetailState,
} from '../../app/public/js/logic.js';

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

test.describe('classifyBgTaskKind（横幅构成分类）', () => {
  test('local_agent / agent → agent', () => {
    assert.equal(classifyBgTaskKind('local_agent'), 'agent');
    assert.equal(classifyBgTaskKind('agent'), 'agent');
  });
  test('local_bash / bash → bash', () => {
    assert.equal(classifyBgTaskKind('local_bash'), 'bash');
    assert.equal(classifyBgTaskKind('bash'), 'bash');
  });
  test('local_workflow / workflow → workflow', () => {
    assert.equal(classifyBgTaskKind('local_workflow'), 'workflow');
    assert.equal(classifyBgTaskKind('workflow'), 'workflow');
  });
  test('空 / 未知 / 非字符串 → other（不猜）', () => {
    assert.equal(classifyBgTaskKind(null), 'other');
    assert.equal(classifyBgTaskKind(''), 'other');
    assert.equal(classifyBgTaskKind('subagent'), 'other');
    assert.equal(classifyBgTaskKind(undefined), 'other');
  });
});

test.describe('formatBgTaskBannerCopy（横幅标题+状态按构成）', () => {
  test('空列表 → 空文案', () => {
    assert.deepEqual(formatBgTaskBannerCopy([]), { title: '', status: '' });
    assert.deepEqual(formatBgTaskBannerCopy(), { title: '', status: '' });
  });
  test('单一种类：标题是种类名，状态沿用「运行中 / N 个运行中」', () => {
    assert.deepEqual(
      formatBgTaskBannerCopy([{ taskType: 'local_agent' }]),
      { title: '子代理', status: '运行中' },
    );
    assert.deepEqual(
      formatBgTaskBannerCopy([{ taskType: 'local_agent' }, { taskType: 'agent' }]),
      { title: '子代理', status: '2 个运行中' },
    );
    assert.deepEqual(
      formatBgTaskBannerCopy([{ taskType: 'local_bash' }]),
      { title: '后台命令', status: '运行中' },
    );
    assert.deepEqual(
      formatBgTaskBannerCopy([{ taskType: 'workflow' }, { taskType: 'local_workflow' }]),
      { title: '工作流', status: '2 个运行中' },
    );
  });
  test('未知类型保持「后台任务」+ 原数量文案（无 taskType 的旧快照不破）', () => {
    assert.deepEqual(
      formatBgTaskBannerCopy([{ taskId: 't1', message: 'one' }]),
      { title: '后台任务', status: '运行中' },
    );
    assert.deepEqual(
      formatBgTaskBannerCopy([{ taskId: 't1' }, { taskId: 't2' }]),
      { title: '后台任务', status: '2 个运行中' },
    );
  });
  test('混合：标题「运行中」，状态报构成', () => {
    assert.deepEqual(
      formatBgTaskBannerCopy([
        { taskType: 'local_agent' },
        { taskType: 'local_bash' },
        { taskType: 'local_agent' },
      ]),
      { title: '运行中', status: '2 个子代理 · 1 条命令' },
    );
  });
  test('具名种类 + 未知 → 也算混合，未知进「N 个其它」', () => {
    assert.deepEqual(
      formatBgTaskBannerCopy([
        { taskType: 'local_agent' },
        { taskType: 'local_agent' },
        { message: 'mystery' },
      ]),
      { title: '运行中', status: '2 个子代理 · 1 个其它' },
    );
  });
});

test.describe('groupBgTasksForList（混合才分组，组内保序）', () => {
  test('单一种类：一组、无组头', () => {
    const r = groupBgTasksForList([
      { taskId: 'a', taskType: 'local_agent' },
      { taskId: 'b', taskType: 'agent' },
    ]);
    assert.equal(r.mixed, false);
    assert.equal(r.groups.length, 1);
    assert.equal(r.groups[0].kind, 'agent');
    assert.equal(r.groups[0].label, null);
    assert.deepEqual(r.groups[0].items.map(i => i.taskId), ['a', 'b']);
  });
  test('混合：子代理 → 后台命令 → 工作流 → 其它；组内保留输入相对序', () => {
    const r = groupBgTasksForList([
      { taskId: 'bash-new', taskType: 'local_bash' },
      { taskId: 'agent-new', taskType: 'local_agent' },
      { taskId: 'wf', taskType: 'workflow' },
      { taskId: 'agent-old', taskType: 'local_agent' },
      { taskId: 'mystery' },
    ]);
    assert.equal(r.mixed, true);
    assert.deepEqual(r.groups.map(g => g.kind), ['agent', 'bash', 'workflow', 'other']);
    assert.deepEqual(r.groups.map(g => g.label), ['子代理', '后台命令', '工作流', '其它']);
    assert.deepEqual(r.groups[0].items.map(i => i.taskId), ['agent-new', 'agent-old']);
    assert.deepEqual(r.groups[1].items.map(i => i.taskId), ['bash-new']);
  });
  test('空输入：不混合、无组', () => {
    assert.deepEqual(groupBgTasksForList([]), { mixed: false, groups: [] });
    assert.deepEqual(groupBgTasksForList(), { mixed: false, groups: [] });
  });
});
