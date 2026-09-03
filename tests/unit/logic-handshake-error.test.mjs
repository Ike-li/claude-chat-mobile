// tests/unit/logic-handshake-error.test.mjs —— 握手被拒时给人看的话（纯判定层）。
// 跑法：npm run test:unit。零 DOM / 零 socket，只吃 socket.io connect_error 的 {message, data}。
//
// 背景：socket 侧此前拒绝时一个数字都不给，前端只能把原始标识符抛给用户——屏幕上是
// 「连接失败：rate_limited」，既看不懂也不知道要等多久，于是反复重试，而每次重试都只是撞在锁上。
// 服务端补上 retryAfter 之后，这一层负责把它翻成人话。
import test from 'node:test';
import assert from 'node:assert/strict';
import { describeHandshakeError, shouldAttemptReconnect } from '../../app/public/js/logic/connection.js';

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

// ── 该不该【发起】握手（上游那一半）──────────────────────────────────────────
// 2026-09-02 生产复现：打开 http://127.0.0.1:3000 而 localStorage 无令牌时，屏幕上必现
// 「登录尝试过多，请 1 秒后再试」——而用户只失败了一次。服务端语义已单独修（gateCheck），
// 这里修触发源：
//   · 四个重连入口（visibilitychange / online / pageshow / 连接横幅「立即重试」）没有一个
//     检查凭据门是否开着。用户还没输令牌，页面就替他发了一次注定失败的握手，唯一效果是
//     把退避锁越推越长（500ms→1s→2s→…→30s），切够 8 次标签页即 15 分钟长锁。
//   · pageshow 在【普通页面加载】时同样触发（persisted=false，Playwright 实测 t=+0ms 即 fire），
//     而监听器的注释写的是「从 bfcache 恢复」——注释描述的契约与代码执行的契约分叉了。
//     后果：io() 首次握手失败后 200ms 再补一枪，稳稳落在那把 500ms 退避锁内。
test.describe('shouldAttemptReconnect：凭据门开着时不许自动重连', () => {
  test('令牌门开着 → 不重连（必然失败，只会把退避越推越长）', () => {
    assert.equal(shouldAttemptReconnect({ authGateOpen: true }), false);
  });

  test('Access 重登门开着 → 同样不重连（公网侧压根没有令牌可试）', () => {
    assert.equal(shouldAttemptReconnect({ accessReloginOpen: true }), false);
  });

  test('pageshow 普通加载（persisted=false）→ 不重连：io() 刚刚才连过', () => {
    assert.equal(shouldAttemptReconnect({ persisted: false }), false);
  });

  test('pageshow 从 bfcache 恢复（persisted=true）→ 重连，这才是那个监听器的本意', () => {
    assert.equal(shouldAttemptReconnect({ persisted: true }), true);
  });

  test('非 pageshow 入口（visibilitychange / online / 手动重试）不带 persisted → 正常重连', () => {
    assert.equal(shouldAttemptReconnect({}), true);
    assert.equal(shouldAttemptReconnect(), true, '无参调用不得崩');
  });

  test('凭据门优先于 bfcache：门开着时从 bfcache 回来也不许自动重连', () => {
    assert.equal(shouldAttemptReconnect({ authGateOpen: true, persisted: true }), false);
  });
});
