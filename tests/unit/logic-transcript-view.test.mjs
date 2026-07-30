// 回合末滚动 + composer placeholder（纯逻辑，零 DOM）
// 原 Transcript 三档密度 / 底栏 ctx 常显 pill 已移除（与 statusline 折叠摘要重复）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveTurnEndScroll,
  resolveComposerPlaceholder,
  resolveComposerPrimaryMode,
} from '../../public/js/logic.js';

test('resolveTurnEndScroll：有文件汇总卡 → 锚定卡；否则落底', () => {
  assert.equal(resolveTurnEndScroll({ hasFileChangesCard: true }), 'file-changes');
  assert.equal(resolveTurnEndScroll({ hasFileChangesCard: false }), 'bottom');
  assert.equal(resolveTurnEndScroll({}), 'bottom');
});

// busy 与 turnRunning 分开：busy 含后台任务/待审批，发送闸只认在途轮——
// 挂着后台任务时 placeholder 不该谎称「发不出去」。
test('resolveComposerPlaceholder：turnRunning 提示不可发送；busy 单独不改文案；mirror 优先', () => {
  assert.equal(resolveComposerPlaceholder({ busy: true }), '给 Claude 发消息...');
  assert.match(resolveComposerPlaceholder({ turnRunning: true }), /运行中/);
  assert.equal(
    resolveComposerPlaceholder({ turnRunning: true, mirrorReadonly: true, mirrorText: '终端运行中' }),
    '终端运行中',
  );
  assert.equal(resolveComposerPlaceholder({}), '给 Claude 发消息...');
  assert.equal(
    resolveComposerPlaceholder({ busy: false, idleText: 'custom' }),
    'custom',
  );
  assert.equal(
    resolveComposerPlaceholder({ busy: true, idleText: 'custom' }),
    'custom',
  );
});

test('resolveComposerPrimaryMode: 在途轮 + 有内容 → 停止钮（排队已移除）', () => {
  const out = resolveComposerPrimaryMode({ busy: true, turnRunning: true, hasContent: true });
  assert.equal(out.mode, 'stop');
  assert.equal(out.enabled, true);
  assert.equal(out.ariaLabel, '停止');
});
