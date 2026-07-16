// 发送钮双态 + 流内 live 状态文案：纯逻辑单测（零 DOM/零 token）
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveComposerPrimaryMode,
  formatLiveActivityText,
} from '../../public/js/logic.js';

test('resolveComposerPrimaryMode: 空闲空输入 → 禁用发送', () => {
  const out = resolveComposerPrimaryMode({});
  assert.equal(out.mode, 'send');
  assert.equal(out.enabled, false);
  assert.equal(out.ariaLabel, '发送');
});

test('resolveComposerPrimaryMode: 空闲有内容 → 启用发送', () => {
  const out = resolveComposerPrimaryMode({ hasContent: true });
  assert.equal(out.mode, 'send');
  assert.equal(out.enabled, true);
  assert.equal(out.title, '');
  assert.equal(out.ariaLabel, '发送');
});

test('resolveComposerPrimaryMode: 忙碌空输入 → 停止启用', () => {
  const out = resolveComposerPrimaryMode({ busy: true, hasContent: false });
  assert.equal(out.mode, 'stop');
  assert.equal(out.enabled, true);
  assert.equal(out.title, '停止');
  assert.equal(out.ariaLabel, '停止');
});

test('resolveComposerPrimaryMode: 忙碌有内容 → 仍发送（FE-004 排队）', () => {
  const out = resolveComposerPrimaryMode({ busy: true, hasContent: true });
  assert.equal(out.mode, 'send');
  assert.equal(out.enabled, true);
});

test('resolveComposerPrimaryMode: 忙碌空 + interruptPending → 停止禁用', () => {
  const out = resolveComposerPrimaryMode({
    busy: true,
    hasContent: false,
    interruptPending: true,
  });
  assert.equal(out.mode, 'stop');
  assert.equal(out.enabled, false);
  assert.match(out.title, /停止/);
  assert.equal(out.ariaLabel, '正在停止');
});

test('resolveComposerPrimaryMode: 忙碌有内容 + queueFull → 禁用发送 + 排队 title', () => {
  const out = resolveComposerPrimaryMode({
    busy: true,
    hasContent: true,
    queueFull: true,
  });
  assert.equal(out.mode, 'send');
  assert.equal(out.enabled, false);
  assert.match(out.title, /排队/);
});

test('resolveComposerPrimaryMode: 忙碌空 + queueFull → 仍可停止', () => {
  const out = resolveComposerPrimaryMode({
    busy: true,
    hasContent: false,
    queueFull: true,
  });
  assert.equal(out.mode, 'stop');
  assert.equal(out.enabled, true);
});

test('resolveComposerPrimaryMode: 审批/提问打开 → 禁用发送（不走 morph 停止）', () => {
  const out = resolveComposerPrimaryMode({
    busy: true,
    hasContent: false,
    blockedByUserRequest: true,
  });
  assert.equal(out.mode, 'send');
  assert.equal(out.enabled, false);
  assert.match(out.title, /审批|选择/);
});

test('resolveComposerPrimaryMode: 输入禁用 → 禁用', () => {
  const out = resolveComposerPrimaryMode({
    busy: true,
    hasContent: false,
    blockedByDisabledInput: true,
  });
  assert.equal(out.mode, 'send');
  assert.equal(out.enabled, false);
  assert.match(out.title, /授权|只读/);
});

test('resolveComposerPrimaryMode: sendInFlight 挡双击发送', () => {
  const out = resolveComposerPrimaryMode({
    hasContent: true,
    blockedBySendInFlight: true,
  });
  assert.equal(out.mode, 'send');
  assert.equal(out.enabled, false);
  assert.match(out.title, /稍候/);
});

test('formatLiveActivityText: default / thinking / stopping', () => {
  assert.equal(formatLiveActivityText('default'), 'Claude 正在执行任务...');
  assert.equal(formatLiveActivityText(), 'Claude 正在执行任务...');
  assert.equal(formatLiveActivityText('thinking'), 'Claude 正在思考中...');
  assert.equal(formatLiveActivityText('stopping'), '正在停止…');
});

test('formatLiveActivityText: Bash 截断 60', () => {
  const short = formatLiveActivityText('tool', { name: 'Bash', command: 'ls -la' });
  assert.equal(short, '🖥 ls -la');
  const longCmd = 'x'.repeat(70);
  const long = formatLiveActivityText('tool', { name: 'Bash', command: longCmd });
  assert.equal(long, `🖥 ${'x'.repeat(57)}...`);
  assert.ok(long.length <= 4 + 60); // emoji + truncated
});

test('formatLiveActivityText: Agent/Task 截断 50', () => {
  const short = formatLiveActivityText('tool', { name: 'Agent', description: 'explore UI' });
  assert.equal(short, '🤖 explore UI');
  const longDesc = 'y'.repeat(60);
  const long = formatLiveActivityText('tool', { name: 'Task', description: longDesc });
  assert.equal(long, `🤖 ${'y'.repeat(47)}...`);
});

test('formatLiveActivityText: 其他工具名', () => {
  assert.equal(
    formatLiveActivityText('tool', { name: 'Read' }),
    'Claude 正在运行工具 Read...',
  );
  assert.equal(
    formatLiveActivityText('tool', { name: 'ExitPlanMode' }),
    'Claude 正在运行工具 ExitPlanMode...',
  );
});
