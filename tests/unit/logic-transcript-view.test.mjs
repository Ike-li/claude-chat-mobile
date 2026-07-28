// 回合末滚动 + composer placeholder（纯逻辑，零 DOM）
// 原 Transcript 三档密度 / 底栏 ctx 常显 pill 已移除（与 statusline 折叠摘要重复）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveTurnEndScroll,
  resolveComposerPlaceholder,
  resolveComposerPrimaryMode,
  queuedBubbleState,
} from '../../public/js/logic.js';

test('resolveTurnEndScroll：有文件汇总卡 → 锚定卡；否则落底', () => {
  assert.equal(resolveTurnEndScroll({ hasFileChangesCard: true }), 'file-changes');
  assert.equal(resolveTurnEndScroll({ hasFileChangesCard: false }), 'bottom');
  assert.equal(resolveTurnEndScroll({}), 'bottom');
});

test('resolveComposerPlaceholder：busy 仍用 idle 文案；queueFull / mirror 优先', () => {
  assert.equal(resolveComposerPlaceholder({ busy: true }), '给 Claude 发消息...');
  assert.match(resolveComposerPlaceholder({ busy: true, queueFull: true }), /排队/);
  assert.equal(
    resolveComposerPlaceholder({ busy: true, mirrorReadonly: true, mirrorText: '终端运行中' }),
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

test('resolveComposerPrimaryMode: 忙碌有内容 → 发送启用 + 纠偏 title', () => {
  const out = resolveComposerPrimaryMode({ busy: true, hasContent: true });
  assert.equal(out.mode, 'send');
  assert.equal(out.enabled, true);
  assert.match(out.title, /步骤|纠偏|排队/);
  assert.match(out.ariaLabel, /发送|排队/);
});

test('queuedBubbleState: 文案保留排队语义并暗示步骤后生效', () => {
  const st = queuedBubbleState({ queued: true });
  assert.equal(st.show, true);
  assert.match(st.label, /排队/);
  assert.match(st.label, /步骤|结束|发送/);
});
