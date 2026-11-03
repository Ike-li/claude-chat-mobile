// tests/unit/history-page.test.mjs —— session:history 分两次传：先最近一段，再补窗口里更早的那段
// 手机经隧道下行实测 130–200KB/s，2000 条的窗口压缩后仍有 316–481KB，一次传完首屏要等 2–3s。
// historyPage 只切已经读好的窗口，不碰磁盘；两次请求之间终端可能又写了，第二次要么接得上第一次的头，
// 要么明说 stale，绝不能交出一段和已画的尾巴拼不起来的消息。
import test from 'node:test';
import assert from 'node:assert/strict';
import { historyPage } from '../../app/src/sessions/history.js';

const msg = i => ({
  role: i % 2 === 0 ? 'user' : 'assistant',
  content: `message #${i}`,
  timestamp: new Date(Date.UTC(2026, 9, 1, 10, 0, 0) + i * 1000).toISOString(),
});
// 磁盘上一共 total 条，窗口是最近的 windowLen 条（截顶时 windowLen < total）
const history = (total, windowLen = total) => ({
  messages: Array.from({ length: windowLen }, (_, k) => msg(total - windowLen + k)),
  total,
});

test('historyPage：带 tail 只回最近 tail 条，另报窗口条数与这段的起点', () => {
  const r = historyPage(history(1000), { tail: 300 });
  assert.deepEqual(r.messages, history(1000).messages.slice(-300));
  assert.equal(r.total, 1000);
  assert.equal(r.diskLen, 1000);
  assert.equal(r.from, 700);
  assert.equal(typeof r.anchor, 'string');
});

test('historyPage：窗口不比 tail 长就整窗交出，diskLen 等于条数（前端据此不发第二次）', () => {
  const r = historyPage(history(120), { tail: 300 });
  assert.deepEqual(r.messages, history(120).messages);
  assert.equal(r.diskLen, 120);
});

test('historyPage：第二次带回第一次的起点和锚点，交出的那段接上已有的尾巴就是整个窗口', () => {
  for (const [total, windowLen] of [[1000, 1000], [2100, 2000]]) {
    const h = history(total, windowLen);
    const first = historyPage(h, { tail: 300 });
    const older = historyPage(h, { before: first.from, anchor: first.anchor });
    assert.equal(older.stale, undefined);
    assert.deepEqual([...older.messages, ...first.messages], h.messages, `total=${total}`);
    assert.equal(older.diskLen, windowLen);
  }
});

test('historyPage：两次之间终端又写了几条（未截顶），更早那段不变，照样接得上', () => {
  const first = historyPage(history(1000), { tail: 300 });
  const older = historyPage(history(1005), { before: first.from, anchor: first.anchor });
  assert.equal(older.stale, undefined);
  assert.deepEqual(older.messages, history(1000).messages.slice(0, 700));
  assert.equal(older.total, 1005);
  assert.equal(older.diskLen, 1005);
});

test('historyPage：截顶的窗口往后滑了几条，更早那段从新窗口的头开始、仍紧挨着已有的尾巴', () => {
  const first = historyPage(history(2100, 2000), { tail: 300 });
  const slid = history(2105, 2000);
  const older = historyPage(slid, { before: first.from, anchor: first.anchor });
  assert.equal(older.stale, undefined);
  assert.deepEqual(older.messages, slid.messages.slice(0, 1695));
  assert.deepEqual(older.messages.at(-1), msg(first.from - 1));
});

test('historyPage：锚点那一格换了内容（历史被改写）→ stale，不交消息', () => {
  const first = historyPage(history(1000), { tail: 300 });
  const rewritten = history(1000);
  rewritten.messages[700] = { ...rewritten.messages[700], content: 'rewritten' };
  assert.deepEqual(historyPage(rewritten, { before: first.from, anchor: first.anchor }).messages, []);
  assert.equal(historyPage(rewritten, { before: first.from, anchor: first.anchor }).stale, true);
});

test('historyPage：变短到锚点之前、或窗口滑过了锚点 → stale', () => {
  const first = historyPage(history(2100, 2000), { tail: 300 });
  for (const later of [history(1500), history(4200, 2000)]) {
    const r = historyPage(later, { before: first.from, anchor: first.anchor });
    assert.equal(r.stale, true, `total=${later.total}`);
    assert.deepEqual(r.messages, []);
  }
});

test('historyPage：不带 tail 也不带 before（旧前端）→ 原样整窗', () => {
  const h = history(2100, 2000);
  assert.deepEqual(historyPage(h, {}), h);
});
