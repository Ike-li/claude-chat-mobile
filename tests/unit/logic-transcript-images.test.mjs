// tests/unit/logic-transcript-images.test.mjs —— logic/transcript-images.js：会话图片引用 → 缩略图格子的纯决策
// 覆盖：哪些引用画成格子（白名单外 / 畸形的不画）· 超上限直接占位、不去取 · 取回的载荷怎么变成 data URL
//       （白名单外与非 base64 不拼）· 失败文案
// 不测：取图队列与 DOM（E2E transcript-images.spec）
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TRANSCRIPT_IMAGE_TYPES, planTranscriptImages, transcriptImageDataUrl, transcriptImageFailureText,
} from '../../app/public/js/logic/transcript-images.js';
import { setLang } from '../../app/public/js/i18n.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/6X2Xb0AAAAASUVORK5CYII=';

test('白名单与后端一致的四种', () => {
  assert.deepEqual([...TRANSCRIPT_IMAGE_TYPES].sort(), ['image/gif', 'image/jpeg', 'image/png', 'image/webp']);
});

test('planTranscriptImages：可显示的出格子，超上限的直接占位不去取', () => {
  const plan = planTranscriptImages([
    { ref: 't:a:0', mediaType: 'image/png', bytes: 100 },
    { ref: 't:a:1', mediaType: 'image/jpeg', bytes: 5e6, tooLarge: true },
  ]);
  assert.deepEqual(plan, [
    { ref: 't:a:0', mediaType: 'image/png', bytes: 100, state: 'pending' },
    { ref: 't:a:1', mediaType: 'image/jpeg', bytes: 5e6, state: 'too_large' },
  ]);
});

test('planTranscriptImages：白名单外 / 畸形条目不画（后端漏网也不在前端变成格子）', () => {
  assert.deepEqual(planTranscriptImages([
    { ref: 't:a:0', mediaType: 'image/svg+xml', bytes: 1 },
    { ref: 42, mediaType: 'image/png', bytes: 1 },
    { mediaType: 'image/png' },
    null,
  ]), []);
  assert.deepEqual(planTranscriptImages(undefined), []);
  assert.deepEqual(planTranscriptImages('t:a:0'), []);
});

test('transcriptImageDataUrl：只拼白名单内、纯 base64 的载荷', () => {
  assert.equal(transcriptImageDataUrl({ ok: true, mediaType: 'image/png', data: PNG }), `data:image/png;base64,${PNG}`);
  assert.equal(transcriptImageDataUrl({ ok: false, code: 'not_found' }), null);
  assert.equal(transcriptImageDataUrl({ ok: true, mediaType: 'image/svg+xml', data: PNG }), null, 'svg 进 data: URL 可带脚本');
  assert.equal(transcriptImageDataUrl({ ok: true, mediaType: 'image/png', data: 'x" onerror="alert(1)' }), null);
  assert.equal(transcriptImageDataUrl({ ok: true, mediaType: 'image/png', data: '' }), null);
  assert.equal(transcriptImageDataUrl(null), null);
});

test('transcriptImageFailureText：超上限写出大小，其余一律「图片无法加载」', () => {
  setLang('zh');
  assert.equal(transcriptImageFailureText('too_large', 3.2 * 1024 * 1024), '图片过大（3.2MB），未加载');
  assert.equal(transcriptImageFailureText('not_found'), '图片无法加载');
  assert.equal(transcriptImageFailureText(undefined), '图片无法加载');
});
