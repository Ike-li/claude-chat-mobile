// 剩余 UI/UX 批：纯逻辑单测（零 DOM/零 token）
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveModelTileDisplay,
  formatAttachmentChipLabel,
  formatCachePercent,
  effortLevelSubtitle,
  shouldShowBusyWithMirror,
  bannerPriority,
  pickBannerToShow,
  formatStreamPreviewIntervalMs,
} from '../../public/js/logic.js';

// UX-018
test('resolveModelTileDisplay: 无撞车用 displayName', () => {
  const out = resolveModelTileDisplay([
    { value: 'a', displayName: 'Alpha', description: 'A' },
    { value: 'b', displayName: 'Beta' },
  ]);
  assert.equal(out[0].value, 'a');
  assert.equal(out[0].title, 'Alpha');
  assert.equal(out[0].subtitle, 'A');
  assert.equal(out[0].duplicate, false);
  assert.equal(out[1].title, 'Beta');
  assert.equal(out[1].subtitle, 'b'); // description 缺省 → value
  assert.equal(out[1].duplicate, false);
});

test('resolveModelTileDisplay: displayName 撞车回退 value', () => {
  const out = resolveModelTileDisplay([
    { value: 'grok-4.5-fast', displayName: 'grok-4.5', description: 'fast' },
    { value: 'grok-4.5', displayName: 'grok-4.5', description: 'base' },
    { value: 'other', displayName: 'Other' },
  ]);
  assert.equal(out[0].title, 'grok-4.5-fast');
  assert.equal(out[0].subtitle, 'fast');
  assert.equal(out[0].duplicate, true);
  assert.equal(out[1].title, 'grok-4.5');
  assert.equal(out[1].subtitle, 'base');
  assert.equal(out[1].duplicate, true);
  assert.equal(out[2].title, 'Other');
  assert.equal(out[2].duplicate, false);
});

test('resolveModelTileDisplay: 无 displayName 时 title=value；缺省安全', () => {
  const out = resolveModelTileDisplay([{ value: 'sonnet' }]);
  assert.equal(out[0].title, 'sonnet');
  assert.equal(out[0].subtitle, 'sonnet');
  assert.equal(out[0].duplicate, false);
  assert.deepEqual(resolveModelTileDisplay(null), []);
  assert.deepEqual(resolveModelTileDisplay(undefined), []);
  assert.equal(resolveModelTileDisplay(['raw']).length, 1);
  assert.equal(resolveModelTileDisplay(['raw'])[0].title, 'raw');
});

// UX-020
test('formatAttachmentChipLabel: 同名 1-based 序号', () => {
  assert.equal(formatAttachmentChipLabel('image.png', 1), 'image.png');
  assert.equal(formatAttachmentChipLabel('image.png', 2), 'image.png (2)');
  assert.equal(formatAttachmentChipLabel('image.png', 3), 'image.png (3)');
});

test('formatAttachmentChipLabel: 可选 sizeBytes 追加', () => {
  assert.equal(formatAttachmentChipLabel('image.png', 3, 1200), 'image.png (3) · 1KB');
  assert.equal(formatAttachmentChipLabel('photo.jpg', 1, 120 * 1024), 'photo.jpg · 120KB');
  assert.equal(formatAttachmentChipLabel('big.bin', 1, 2.5 * 1024 * 1024), 'big.bin · 2.5MB');
  assert.equal(formatAttachmentChipLabel('tiny.txt', 1, 42), 'tiny.txt · 42B');
});

test('formatAttachmentChipLabel: 缺省名', () => {
  assert.equal(formatAttachmentChipLabel('', 1), '附件');
  assert.equal(formatAttachmentChipLabel(null, 1, 500), '附件 · 500B');
  assert.equal(formatAttachmentChipLabel('x', 0), 'x'); // 非正 → 当 1
});

// UX-015
test('formatCachePercent: 0–1 与 0–100 均取整为 N%', () => {
  assert.equal(formatCachePercent(0.4667), '47%');
  assert.equal(formatCachePercent(46.67), '47%');
  assert.equal(formatCachePercent(0), '0%');
  assert.equal(formatCachePercent(1), '100%');
  assert.equal(formatCachePercent(100), '100%');
});

test('formatCachePercent: 非法 → —', () => {
  assert.equal(formatCachePercent(null), '—');
  assert.equal(formatCachePercent(undefined), '—');
  assert.equal(formatCachePercent(NaN), '—');
  assert.equal(formatCachePercent('x'), '—');
});

// UX-014
test('effortLevelSubtitle: 各档增量文案', () => {
  assert.equal(effortLevelSubtitle('low'), '更快更省');
  assert.equal(effortLevelSubtitle('medium'), '均衡');
  assert.equal(effortLevelSubtitle('med'), '均衡');
  assert.equal(effortLevelSubtitle('high'), '更深入');
  assert.equal(effortLevelSubtitle('xhigh'), '很深入更慢');
  assert.equal(effortLevelSubtitle('max'), '最深入更慢更贵');
  assert.equal(effortLevelSubtitle('ultracode'), 'xhigh + 多 agent workflow · 最彻底');
  assert.equal(effortLevelSubtitle('HIGH'), '更深入'); // 大小写不敏感
  assert.equal(effortLevelSubtitle('unknown'), '');
  assert.equal(effortLevelSubtitle(null), '');
});

// UX-010
test('shouldShowBusyWithMirror: 镜像优先隐藏忙碌', () => {
  assert.equal(shouldShowBusyWithMirror({ mirrorReadonly: true, busy: true }), false);
  assert.equal(shouldShowBusyWithMirror({ mirrorReadonly: true, busy: false }), false);
  assert.equal(shouldShowBusyWithMirror({ mirrorReadonly: false, busy: true }), true);
  assert.equal(shouldShowBusyWithMirror({ mirrorReadonly: false, busy: false }), false);
  assert.equal(shouldShowBusyWithMirror({}), false);
});

test('bannerPriority: mirror > task > subagent > activity > null', () => {
  assert.equal(bannerPriority({ mirror: true, task: true, subagent: true, activity: true }), 'mirror');
  assert.equal(bannerPriority({ mirror: false, task: true, subagent: true, activity: true }), 'task');
  assert.equal(bannerPriority({ mirror: false, task: false, subagent: true, activity: true }), 'subagent');
  assert.equal(bannerPriority({ mirror: false, task: false, subagent: false, activity: true }), 'activity');
  assert.equal(bannerPriority({}), null);
  // 兼容旧名
  assert.equal(pickBannerToShow({ task: true, activity: true }), 'task');
  assert.equal(pickBannerToShow, bannerPriority);
});

// UX-004 helper: stream re-render interval
test('formatStreamPreviewIntervalMs: 默认 80ms 节流', () => {
  assert.equal(formatStreamPreviewIntervalMs(), 80);
  assert.equal(formatStreamPreviewIntervalMs(50), 50);
});
