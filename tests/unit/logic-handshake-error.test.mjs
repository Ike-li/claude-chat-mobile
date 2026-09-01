// tests/unit/logic-handshake-error.test.mjs —— 握手被拒时给人看的话（纯判定层）。
// 跑法：npm run test:unit。零 DOM / 零 socket，只吃 socket.io connect_error 的 {message, data}。
//
// 背景：socket 侧此前拒绝时一个数字都不给，前端只能把原始标识符抛给用户——屏幕上是
// 「连接失败：rate_limited」，既看不懂也不知道要等多久，于是反复重试，而每次重试都只是撞在锁上。
// 服务端补上 retryAfter 之后，这一层负责把它翻成人话。
import test from 'node:test';
import assert from 'node:assert/strict';
import { describeHandshakeError } from '../../public/js/logic/connection.js';

test.describe('describeHandshakeError：把握手拒绝翻成人话', () => {
  test('rate_limited + 秒级等待 → 说清还要等多久', () => {
    const r = describeHandshakeError({ message: 'rate_limited', data: { reason: 'rate_limited', retryAfterMs: 8000, retryAfterSeconds: 8 } });
    assert.equal(r.kind, 'rate_limited');
    assert.match(r.text, /8/, '必须把秒数说出来');
    assert.doesNotMatch(r.text, /rate_limited/, '不能把原始标识符抛给用户');
  });

  test('分钟级等待换算成分钟（15 分钟长锁说「900 秒」没人读得懂）', () => {
    const r = describeHandshakeError({ message: 'rate_limited', data: { retryAfterSeconds: 900 } });
    assert.match(r.text, /15/);
    assert.doesNotMatch(r.text, /900/);
  });

  test('不足 1 分钟不进位到分钟（59 秒仍按秒说）', () => {
    assert.match(describeHandshakeError({ message: 'rate_limited', data: { retryAfterSeconds: 59 } }).text, /59/);
  });

  test('分钟数向上取整：61 秒要说 2 分钟，说 1 分钟会让人早退回来又撞锁', () => {
    assert.match(describeHandshakeError({ message: 'rate_limited', data: { retryAfterSeconds: 61 } }).text, /2/);
  });

  test('rate_limited 但缺 data（旧服务端）→ 仍给人话，只是不带具体时长', () => {
    const r = describeHandshakeError({ message: 'rate_limited' });
    assert.equal(r.kind, 'rate_limited');
    assert.doesNotMatch(r.text, /rate_limited/);
    assert.doesNotMatch(r.text, /NaN|undefined|null/, '缺数据时不得把 NaN 漏到界面上');
  });

  test('unauthorized 单独归类：交给令牌门处理，不当成普通连接失败', () => {
    assert.equal(describeHandshakeError({ message: 'unauthorized' }).kind, 'unauthorized');
  });

  test('其它错误（网络抖动等）归 other，文案保留原始信息供排查', () => {
    const r = describeHandshakeError({ message: 'xhr poll error' });
    assert.equal(r.kind, 'other');
    assert.match(r.text, /xhr poll error/);
  });

  test('空/畸形入参不崩', () => {
    for (const bad of [undefined, null, {}, { message: '' }, { message: 'rate_limited', data: { retryAfterSeconds: 'abc' } }]) {
      const r = describeHandshakeError(bad);
      assert.ok(typeof r.text === 'string' && r.text.length > 0, `应给出非空文案，输入 ${JSON.stringify(bad)}`);
      assert.doesNotMatch(r.text, /NaN|undefined/, `不得漏出 NaN/undefined，输入 ${JSON.stringify(bad)}`);
    }
  });
});
