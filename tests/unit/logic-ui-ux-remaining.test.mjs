// 剩余 UI/UX 批：纯逻辑单测（零 DOM/零 token）
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveModelTileDisplay,
  formatAttachmentChipLabel,
  formatCachePercent,
  effortLevelSubtitle,
  shouldShowBusyWithMirror,
  pickBannerToShow,
  formatStreamPreviewIntervalMs,
} from '../../public/js/logic.js';

// UX-018
test('resolveModelTileDisplay: 无撞车用 displayName', () => {
  const out = resolveModelTileDisplay([
    { value: 'a', displayName: 'Alpha', description: 'A' },
    { value: 'b', displayName: 'Beta' },
  ]);
  assert.equal(out[0].title, 'Alpha');
  assert.equal(out[0].subtitle, 'A');
  assert.equal(out[0].duplicate, false);
  assert.equal(out[1].title, 'Beta');
});

test('resolveModelTileDisplay: displayName 撞车回退 value', () => {
  const out = resolveModelTileDisplay([
    { value: 'grok-4.5-fast', displayName: 'grok-4.5', description: 'fast' },
    { value: 'grok-4.5', displayName: 'grok-4.5', description: 'base' },
    { value: 'other', displayName: 'Other' },
  ]);
  assert.equal(out[0].title, 'grok-4.5-fast');
  assert.equal(out[0].duplicate, true);
  assert.equal(out[1].title, 'grok-4.5');
  assert.equal(out[1].duplicate, true);
  assert.equal(out[2].title, 'Other');
  assert.equal(out[2].duplicate, false);
});

test('resolveModelTileDisplay: 缺省安全', () => {
  assert.deepEqual(resolveModelTileDisplay(null), []);
  assert.equal(resolveModelTileDisplay(['raw']).length, 1);
  assert.equal(resolveModelTileDisplay(['raw'])[0].title, 'raw');
});

// UX-020
test('formatAttachmentChipLabel: 同名加序号', () => {
  assert.equal(formatAttachmentChipLabel('image.png', 1), 'image.png');
  assert.equal(formatAttachmentChipLabel('image.png', 2), 'image.png (2)');
  assert.equal(formatAttachmentChipLabel('image.png', 3, 1200), 'image.png (3) · 1KB');
});

test('formatAttachmentChipLabel: 缺省', () => {
  assert.equal(formatAttachmentChipLabel('', 1), '附件');
  assert.equal(formatAttachmentChipLabel(null, 1, 500), '附件 · 500B');
});

// UX-015
test('formatCachePercent: 取整', () => {
  assert.equal(formatCachePercent(0.4667), '47%');
  assert.equal(formatCachePercent(46.67), '47%');
  assert.equal(formatCachePercent(0), '0%');
  assert.equal(formatCachePercent(null), '—');
  assert.equal(formatCachePercent(NaN), '—');
});

// UX-014
test('effortLevelSubtitle: 增量文案', () => {
  assert.equal(effortLevelSubtitle('low'), '更快更省');
  assert.equal(effortLevelSubtitle('high'), '更深入');
  assert.equal(effortLevelSubtitle('ultracode'), 'xhigh + 多 agent · 最彻底');
  assert.equal(effortLevelSubtitle('unknown'), '');
});

// UX-010
test('shouldShowBusyWithMirror: 镜像优先隐藏忙碌', () => {
  assert.equal(shouldShowBusyWithMirror({ mirrorReadonly: true, busy: true }), false);
  assert.equal(shouldShowBusyWithMirror({ mirrorReadonly: false, busy: true }), true);
  assert.equal(shouldShowBusyWithMirror({ mirrorReadonly: false, busy: false }), false);
});

test('pickBannerToShow: mirror > task > subagent > activity', () => {
  assert.equal(pickBannerToShow({ mirror: true, task: true, subagent: true, activity: true }), 'mirror');
  assert.equal(pickBannerToShow({ mirror: false, task: true, subagent: true, activity: true }), 'task');
  assert.equal(pickBannerToShow({ mirror: false, task: false, subagent: true, activity: true }), 'subagent');
  assert.equal(pickBannerToShow({ mirror: false, task: false, subagent: false, activity: true }), 'activity');
  assert.equal(pickBannerToShow({}), null);
});

// UX-004 helper: stream re-render interval
test('formatStreamPreviewIntervalMs: 默认 80ms 节流', () => {
  assert.equal(formatStreamPreviewIntervalMs(), 80);
  assert.equal(formatStreamPreviewIntervalMs(50), 50);
});
