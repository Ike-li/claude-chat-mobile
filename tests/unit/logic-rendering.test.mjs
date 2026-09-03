// tests/unit/logic.test.mjs —— app/public/js/logic.js 纯逻辑单测（node 内置 test runner，零依赖）。
// 跑法：npm test （= node --test）。覆盖 model 桥接 / effort 档位 / 状态优先级 / ANSI 配平 / esc。
// 不覆盖 DOM 接线与 iOS/Safari 平台行为（归 npm run check + 真机）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { ansiToHtml, urlBase64ToUint8Array, nextHistoryRenderChunk, resolveUnreadAnchorIndex, formatPushStatusRow } from '../../app/public/js/logic.js';
import { createRingBuffer } from '../../app/public/js/ring-buffer.js';

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

// ---- resolveUnreadAnchorIndex：未读胶囊"跳到第一条未读"的定位数学（不碰 DOM，纯计算） ----
// 未读消息永远是当前已渲染顶层气泡列表的尾部 N 条（N=服务端 unreadOnEntry），不需要跨路径消息 ID，
// 渲染完成后对列表做一次位置计算即可，越界（未读数超过实际渲染条数）优雅降级为"滚到最顶部"而非报错。
test.describe('resolveUnreadAnchorIndex', () => {
  test('正常情况：定位到"倒数第 unreadCount 条"对应的下标', () => {
    assert.equal(resolveUnreadAnchorIndex(10, 3), 7);
    assert.equal(resolveUnreadAnchorIndex(5, 1), 4);
  });

  test('unreadCount 覆盖全部列表：定位到第 0 条（列表顶部）', () => {
    assert.equal(resolveUnreadAnchorIndex(5, 5), 0);
  });

  test('unreadCount 超过实际渲染条数（滑窗截断等极端场景）：clamp 到 0，不越界', () => {
    assert.equal(resolveUnreadAnchorIndex(5, 8), 0);
  });

  test('unreadCount<=0 或列表为空：返回 -1（无需定位）', () => {
    assert.equal(resolveUnreadAnchorIndex(10, 0), -1);
    assert.equal(resolveUnreadAnchorIndex(10, -1), -1);
    assert.equal(resolveUnreadAnchorIndex(0, 3), -1);
  });

  test('unreadCount 非有限数（NaN/undefined）：返回 -1，不产生 NaN 下标', () => {
    assert.equal(resolveUnreadAnchorIndex(10, Number.NaN), -1);
    assert.equal(resolveUnreadAnchorIndex(10, undefined), -1);
  });
});

// ---- pushEnvHint：Web Push 环境判定（E15 / ②2a）——手机「没触发过」多半卡在这几道门 ----


// 推送订阅状态行：这一整段是"我从来没收到过推送、界面上却看不出任何异常"逼出来的——
// 真机实测中 push-subscription.json 压根不存在（从未订阅），而 UI 里没有任何地方显示这件事，
// 铃铛按钮在"权限被拒"时还会永久隐藏。状态必须能被看见，且看得出下一步该做什么。
test.describe('formatPushStatusRow：推送订阅状态可见化', () => {
  test('已订阅 → ok 态、无动作按钮', () => {
    const r = formatPushStatusRow({ hint: 'ready', permission: 'granted', subscribed: true });
    assert.equal(r.tone, 'ok');
    assert.match(r.value, /已开启/);
    assert.equal(r.action, null);
  });

  test('未授权（default）→ 给「开启」按钮', () => {
    const r = formatPushStatusRow({ hint: 'ready', permission: 'default', subscribed: false });
    assert.equal(r.action, 'subscribe');
    assert.match(r.value, /未开启/);
  });

  test('权限被拒 → 必须仍然可见并说清怎么恢复（此前按钮直接隐藏、成死路）', () => {
    const r = formatPushStatusRow({ hint: 'ready', permission: 'denied', subscribed: false });
    assert.equal(r.tone, 'warn');
    assert.match(r.value, /已被拒绝|被拒/);
    assert.match(r.hint, /浏览器|设置/);
  });

  test('已授权却没订阅上 → 报出来并给重试（此前是彻底静默）', () => {
    const r = formatPushStatusRow({ hint: 'ready', permission: 'granted', subscribed: false });
    assert.equal(r.tone, 'warn');
    assert.equal(r.action, 'subscribe');
    assert.match(r.value, /未完成|未订阅/);
  });

  test('环境不满足：iOS 未加主屏 / 非 HTTPS / 不支持 → 说明具体门槛，不给无效按钮', () => {
    const ios = formatPushStatusRow({ hint: 'ios-add-home', permission: 'default', subscribed: false });
    assert.match(ios.hint, /主屏/);
    assert.equal(ios.action, null);
    const http = formatPushStatusRow({ hint: 'need-https', permission: 'default', subscribed: false });
    assert.match(http.hint, /HTTPS/i);
    assert.equal(http.action, null);
    assert.equal(formatPushStatusRow({ hint: 'unsupported', permission: 'default', subscribed: false }).action, null);
  });
});
