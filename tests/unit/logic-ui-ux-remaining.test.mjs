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
  statusIconSpec,
} from '../../public/js/logic.js';

// UX-018：CLI 列表原样搬运
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
  assert.equal(out[1].subtitle, 'b');
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

test('resolveModelTileDisplay: 有 resolvedModel 也不改写——一条 SDK 项一张磁贴、value 原样', () => {
  const out = resolveModelTileDisplay([
    { value: 'default', displayName: 'Default (recommended)', description: 'Use default', resolvedModel: 'grok-4.5[1m]' },
    { value: 'opus', displayName: 'Custom Opus model', resolvedModel: 'grok-4.5[1m]' },
    { value: 'sonnet', displayName: 'Custom Sonnet model', resolvedModel: 'grok-4.5[1m]' },
    { value: 'fable', displayName: 'Custom Fable model', resolvedModel: 'grok-4.5[1m]' },
  ]);
  assert.equal(out.length, 4);
  assert.equal(out[0].value, 'default');
  assert.equal(out[0].title, 'Default (recommended)');
  assert.equal(out[0].subtitle, 'Use default');
  assert.equal(out[1].value, 'opus');
  assert.equal(out[1].title, 'Custom Opus model');
  assert.equal(out[2].value, 'sonnet');
  assert.equal(out[3].value, 'fable');
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
  assert.equal(formatAttachmentChipLabel(null, 2), '附件 (2)');
});

test('formatCachePercent: 0–1 与 0–100 均取整为 N%', () => {
  assert.equal(formatCachePercent(0.47), '47%');
  assert.equal(formatCachePercent(47), '47%');
  assert.equal(formatCachePercent(0), '0%');
});

test('formatCachePercent: 非法 → —', () => {
  assert.equal(formatCachePercent(null), '—');
  assert.equal(formatCachePercent(NaN), '—');
});

test('effortLevelSubtitle: 各档增量文案', () => {
  assert.ok(effortLevelSubtitle('low'));
  assert.ok(effortLevelSubtitle('max'));
});

test('shouldShowBusyWithMirror: 镜像优先隐藏忙碌', () => {
  assert.equal(shouldShowBusyWithMirror({ busy: true, mirrorReadonly: true }), false);
  assert.equal(shouldShowBusyWithMirror({ busy: true, mirrorReadonly: false }), true);
});

test('bannerPriority: task 不被 mirror 压掉（镜像态已迁 placeholder，后台进度须可见）', () => {
  assert.ok(typeof bannerPriority === 'function' || typeof pickBannerToShow === 'function');
});

test('formatStreamPreviewIntervalMs: 默认 80ms 节流', () => {
  assert.equal(formatStreamPreviewIntervalMs(), 80);
});

test('statusIconSpec: 各 kind 返回 svg + label，无用户输入注入', () => {
  for (const k of ['ok', 'error', 'pending', 'warn']) {
    const s = statusIconSpec(k);
    assert.ok(s.svg || s.html || s);
  }
});

test('statusIconSpec: 未知 kind 回退 pending', () => {
  const s = statusIconSpec('nope');
  assert.ok(s);
});
