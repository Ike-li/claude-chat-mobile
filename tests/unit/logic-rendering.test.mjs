// tests/unit/logic.test.mjs —— public/js/logic.js 纯逻辑单测（node 内置 test runner，零依赖）。
// 跑法：npm test （= node --test）。覆盖 model 桥接 / effort 档位 / 状态优先级 / ANSI 配平 / esc。
// 不覆盖 DOM 接线与 iOS/Safari 平台行为（归 npm run check + 真机），见 docs/design.md 验收纪律。
import test from 'node:test';
import assert from 'node:assert/strict';
import { ansiToHtml, urlBase64ToUint8Array, nextHistoryRenderChunk } from '../../public/js/logic.js';
import { createRingBuffer } from '../../public/js/ring-buffer.js';

test('ansiToHtml: 纯文本被 esc', () => {
  assert.equal(ansiToHtml('a<b>'), 'a&lt;b&gt;');
});

test('ansiToHtml: 24-bit 前景色 → span', () => {
  assert.equal(ansiToHtml('\x1b[38;2;255;0;0mhi\x1b[0m'), '<span style="color:rgb(255,0,0)">hi</span>');
});

test('ansiToHtml: 未闭合 span 结尾配平', () => {
  assert.equal(ansiToHtml('\x1b[38;2;1;2;3mhi'), '<span style="color:rgb(1,2,3)">hi</span>');
});

test('ansiToHtml: \\x1b[m 空 reset 也闭合', () => {
  assert.equal(ansiToHtml('\x1b[38;2;0;0;0mx\x1b[m'), '<span style="color:rgb(0,0,0)">x</span>');
});

test('ansiToHtml: 非颜色 SGR 吞序列、保留文本、不留游离 span', () => {
  assert.equal(ansiToHtml('\x1b[1mbold\x1b[0m'), 'bold');
});

// ---- ring-buffer 环形缓冲 ----
test('createRingBuffer: push + toArray + 基本读写', () => {
  const b = createRingBuffer(3);
  assert.equal(b.size(), 0);
  b.push('a');
  assert.equal(b.size(), 1);
  assert.deepEqual(b.toArray(), ['a']);
  b.push('b'); b.push('c');
  assert.deepEqual(b.toArray(), ['a', 'b', 'c']);
});

test('createRingBuffer: 溢出：保留最新 N 条', () => {
  const b = createRingBuffer(3);
  b.push('a'); b.push('b'); b.push('c'); b.push('d');
  assert.equal(b.size(), 3);
  assert.deepEqual(b.toArray(), ['b', 'c', 'd']);
});

test('createRingBuffer: clear + isEmpty', () => {
  const b = createRingBuffer(3);
  b.push('x'); b.push('y');
  assert.equal(b.isEmpty(), false);
  b.clear();
  assert.equal(b.isEmpty(), true);
  assert.equal(b.size(), 0);
  assert.deepEqual(b.toArray(), []);
});

test('createRingBuffer: head/tail（首尾查看不取出）', () => {
  const b = createRingBuffer(3);
  b.push('first'); b.push('second');
  assert.equal(b.head(), 'first');
  assert.equal(b.tail(), 'second');
  b.push('third'); b.push('fourth'); // 'first' 溢出
  assert.equal(b.head(), 'second');
  assert.equal(b.tail(), 'fourth');
});

test('createRingBuffer: cap=0 永不存储', () => {
  const b = createRingBuffer(0);
  b.push('x');
  assert.equal(b.isEmpty(), true);
  assert.equal(b.size(), 0);
});

test('createRingBuffer: cap=1 边界', () => {
  const b = createRingBuffer(1);
  b.push('a'); b.push('b');
  assert.equal(b.size(), 1);
  assert.equal(b.head(), 'b');
  assert.equal(b.tail(), 'b');
});

// ---- urlBase64ToUint8Array：VAPID 公钥解码（E15） ----
test('urlBase64ToUint8Array: 标准 URL-safe base64 解码', () => {
  // "AQAB" in URL-safe base64 without padding → Uint8Array [1, 0, 1]
  const result = urlBase64ToUint8Array('AQAB');
  assert.ok(result instanceof Uint8Array);
  assert.equal(result.length, 3);
  assert.equal(result[0], 1);
  assert.equal(result[1], 0);
  assert.equal(result[2], 1);
});

test('urlBase64ToUint8Array: 含 - 和 _ 的 URL-safe 字符', () => {
  // "-_" in URL-safe base64 = "+/" in standard base64 → "/w" which decodes to 0xff
  const result = urlBase64ToUint8Array('-_w');
  assert.ok(result instanceof Uint8Array);
  assert.equal(result.length, 2);
  // - → +, _ → /: "+/w" in base64 → 0xfb, 0xfc
  assert.equal(result[0], 0xfb);
});

test('urlBase64ToUint8Array: 空串 → 空数组', () => {
  const result = urlBase64ToUint8Array('');
  assert.ok(result instanceof Uint8Array);
  assert.equal(result.length, 0);
});

test('urlBase64ToUint8Array: 自动补填充', () => {
  // "AA" is 2 chars → needs 2 padding chars ("AA==")
  // "AA==" in base64 = single byte 0x00
  const result = urlBase64ToUint8Array('AA');
  assert.equal(result.length, 1);
  assert.equal(result[0], 0);
});

// ---- nextHistoryRenderChunk：长会话切入分块渲染的推进数学（不碰 DOM，纯计算） ----
test.describe('nextHistoryRenderChunk', () => {
  test('整除边界：total 恰好是 chunkSize 的倍数，分两步推进', () => {
    const step1 = nextHistoryRenderChunk({ processed: 0, total: 80, chunkSize: 40 });
    assert.deepEqual(step1, { end: 40, done: false });
    const step2 = nextHistoryRenderChunk({ processed: 40, total: 80, chunkSize: 40 });
    assert.deepEqual(step2, { end: 80, done: true });
  });

  test('余数块：95 条、每块 40，推进 40/40/15，最后一步 done', () => {
    const step1 = nextHistoryRenderChunk({ processed: 0, total: 95, chunkSize: 40 });
    assert.deepEqual(step1, { end: 40, done: false });
    const step2 = nextHistoryRenderChunk({ processed: 40, total: 95, chunkSize: 40 });
    assert.deepEqual(step2, { end: 80, done: false });
    const step3 = nextHistoryRenderChunk({ processed: 80, total: 95, chunkSize: 40 });
    assert.deepEqual(step3, { end: 95, done: true });
  });

  test('total < chunkSize：一步处理完，done=true', () => {
    const step = nextHistoryRenderChunk({ processed: 0, total: 15, chunkSize: 40 });
    assert.deepEqual(step, { end: 15, done: true });
  });

  test('chunkSize<=0 防呆：至少推进 1 条，不死循环', () => {
    const step = nextHistoryRenderChunk({ processed: 0, total: 3, chunkSize: 0 });
    assert.equal(step.end, 1);
    assert.equal(step.done, false);
    const stepNeg = nextHistoryRenderChunk({ processed: 0, total: 3, chunkSize: -5 });
    assert.equal(stepNeg.end, 1);
  });

  test('total=0：一步 done=true，end=0', () => {
    assert.deepEqual(nextHistoryRenderChunk({ processed: 0, total: 0, chunkSize: 40 }), { end: 0, done: true });
  });
});

// ---- pushEnvHint：Web Push 环境判定（E15 / ②2a）——手机「没触发过」多半卡在这几道门 ----
