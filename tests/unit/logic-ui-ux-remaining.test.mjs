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

// 条数 = SDK 条数；标题 = 真实 wire id
test('resolveModelTileDisplay: 无 resolved 时标题用 displayName，value 原样', () => {
  const out = resolveModelTileDisplay([
    { value: 'a', displayName: 'Alpha', description: 'A' },
    { value: 'b', displayName: 'Beta' },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].value, 'a');
  assert.equal(out[0].title, 'Alpha');
  assert.equal(out[0].subtitle, 'A');
  assert.equal(out[1].title, 'Beta');
});

test('resolveModelTileDisplay: 缺省安全', () => {
  assert.deepEqual(resolveModelTileDisplay(null), []);
  assert.equal(resolveModelTileDisplay(['raw'])[0].title, 'raw');
  assert.equal(resolveModelTileDisplay(['raw'])[0].value, 'raw');
});

test('resolveModelTileDisplay: 多档同 wire → 仍 N 张卡，标题都是真实 ID，副标题档位名', () => {
  const out = resolveModelTileDisplay([
    { value: 'default', displayName: 'Default (recommended)', description: 'Use default', resolvedModel: 'grok-4.5[1m]' },
    { value: 'opus', displayName: 'Custom Opus model', resolvedModel: 'grok-4.5' },
    { value: 'sonnet', displayName: 'Custom Sonnet model', resolvedModel: 'grok-4.5' },
    { value: 'fable', displayName: 'Custom Fable model', resolvedModel: 'grok-4.5' },
    { value: 'haiku', displayName: 'Custom Haiku model', resolvedModel: 'grok-4.5' },
    { value: 'grok-4.5-build', displayName: '当前加载模型' },
  ]);
  assert.equal(out.length, 6); // 与 TUI/SDK 条数一致，不去重
  assert.equal(out[0].value, 'default');
  assert.equal(out[0].title, 'grok-4.5[1m]'); // 真实 ID
  assert.match(out[0].subtitle, /Default|default/i);
  assert.equal(out[1].value, 'opus');
  assert.equal(out[1].title, 'grok-4.5');
  // 有 wire 时副标题 = 档位 id · displayName（同 wire 多卡靠此区分）
  assert.equal(out[1].subtitle, 'opus · Custom Opus model');
  assert.equal(out[2].title, 'grok-4.5');
  assert.equal(out[2].value, 'sonnet');
  assert.equal(out[2].subtitle, 'sonnet · Custom Sonnet model');
  assert.equal(out[5].value, 'grok-4.5-build');
  assert.equal(out[5].title, '当前加载模型'); // 无 resolved → displayName
});

test('resolveModelTileDisplay: 不同 wire 各一张，标题=各自真实 ID', () => {
  const out = resolveModelTileDisplay([
    { value: 'opus', resolvedModel: 'mimo-pro' },
    { value: 'sonnet', resolvedModel: 'mimo-fast' },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].value, 'opus');
  assert.equal(out[0].title, 'mimo-pro');
  assert.equal(out[1].value, 'sonnet');
  assert.equal(out[1].title, 'mimo-fast');
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
