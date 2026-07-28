// Transcript 三档密度 + ctx 常显 + 回合末滚动 + composer 纠偏 placeholder（纯逻辑，零 DOM）
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TRANSCRIPT_VIEW_MODES,
  TRANSCRIPT_VIEW_STORAGE_KEY,
  normalizeTranscriptViewMode,
  cycleTranscriptViewMode,
  transcriptViewLabel,
  transcriptViewTitle,
  transcriptViewMessagesClass,
  transcriptDetailsOpenByDefault,
  readTranscriptViewPref,
  writeTranscriptViewPref,
  formatCtxPillText,
  ctxPillTone,
  resolveTurnEndScroll,
  resolveComposerPlaceholder,
  resolveComposerPrimaryMode,
  queuedBubbleState,
} from '../../public/js/logic.js';

test('TRANSCRIPT_VIEW_MODES 顺序对齐 Desktop：normal → verbose → summary', () => {
  assert.deepEqual(TRANSCRIPT_VIEW_MODES, ['normal', 'verbose', 'summary']);
});

test('normalizeTranscriptViewMode：合法保留，非法/空回落 normal', () => {
  assert.equal(normalizeTranscriptViewMode('verbose'), 'verbose');
  assert.equal(normalizeTranscriptViewMode('summary'), 'summary');
  assert.equal(normalizeTranscriptViewMode('normal'), 'normal');
  assert.equal(normalizeTranscriptViewMode(''), 'normal');
  assert.equal(normalizeTranscriptViewMode(null), 'normal');
  assert.equal(normalizeTranscriptViewMode('VERBOSE'), 'normal');
  assert.equal(normalizeTranscriptViewMode('debug'), 'normal');
});

test('cycleTranscriptViewMode：三档循环', () => {
  assert.equal(cycleTranscriptViewMode('normal'), 'verbose');
  assert.equal(cycleTranscriptViewMode('verbose'), 'summary');
  assert.equal(cycleTranscriptViewMode('summary'), 'normal');
  assert.equal(cycleTranscriptViewMode('garbage'), 'verbose'); // 非法先归一 normal 再步进
});

test('transcriptViewLabel / Title：三档有可区分文案', () => {
  for (const mode of TRANSCRIPT_VIEW_MODES) {
    assert.ok(transcriptViewLabel(mode).length > 0, mode);
    assert.ok(transcriptViewTitle(mode).length > 0, mode);
  }
  assert.notEqual(transcriptViewLabel('normal'), transcriptViewLabel('verbose'));
  assert.notEqual(transcriptViewLabel('verbose'), transcriptViewLabel('summary'));
});

test('transcriptViewMessagesClass：挂到 #messages 的 class', () => {
  assert.equal(transcriptViewMessagesClass('normal'), 'transcript-view-normal');
  assert.equal(transcriptViewMessagesClass('verbose'), 'transcript-view-verbose');
  assert.equal(transcriptViewMessagesClass('summary'), 'transcript-view-summary');
  assert.equal(transcriptViewMessagesClass('x'), 'transcript-view-normal');
});

test('transcriptDetailsOpenByDefault：仅 verbose 默认展开 tool/thinking', () => {
  assert.equal(transcriptDetailsOpenByDefault('verbose'), true);
  assert.equal(transcriptDetailsOpenByDefault('normal'), false);
  assert.equal(transcriptDetailsOpenByDefault('summary'), false);
});

test('read/writeTranscriptViewPref：localStorage 形注入', () => {
  const store = new Map();
  assert.equal(readTranscriptViewPref(k => store.get(k) ?? null), 'normal');
  writeTranscriptViewPref((k, v) => store.set(k, v), 'summary');
  assert.equal(store.get(TRANSCRIPT_VIEW_STORAGE_KEY), 'summary');
  assert.equal(readTranscriptViewPref(k => store.get(k) ?? null), 'summary');
  writeTranscriptViewPref((k, v) => store.set(k, v), 'nope');
  assert.equal(readTranscriptViewPref(k => store.get(k) ?? null), 'normal');
});

test('formatCtxPillText / ctxPillTone：优先百分比，着色阈值对齐 statusline', () => {
  assert.equal(formatCtxPillText({ usedPercent: 42.4 }), 'ctx 42%');
  assert.equal(formatCtxPillText({ tokens: 12500 }), 'ctx 13k');
  assert.equal(formatCtxPillText(null), '');
  assert.equal(formatCtxPillText({}), '');
  assert.equal(ctxPillTone(10), 'ok');
  assert.equal(ctxPillTone(70), 'warn');
  assert.equal(ctxPillTone(89.9), 'warn');
  assert.equal(ctxPillTone(90), 'danger');
  assert.equal(ctxPillTone(undefined), 'ok');
});

test('resolveTurnEndScroll：有文件汇总卡 → 锚定卡；否则落底', () => {
  assert.equal(resolveTurnEndScroll({ hasFileChangesCard: true }), 'file-changes');
  assert.equal(resolveTurnEndScroll({ hasFileChangesCard: false }), 'bottom');
  assert.equal(resolveTurnEndScroll({}), 'bottom');
});

test('resolveComposerPlaceholder：busy → 纠偏提示；queueFull / mirror 优先', () => {
  assert.match(resolveComposerPlaceholder({ busy: true }), /纠偏|步骤/);
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
