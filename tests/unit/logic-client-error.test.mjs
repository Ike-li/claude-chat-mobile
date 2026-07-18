// logic.js 前端全局错误上报域纯函数单测：错误事件→上报载荷/签名、去重+限流门步进。
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildClientErrorReport, clientErrorGateStep } from '../../public/js/logic.js';

test.describe('buildClientErrorReport', () => {
  test('error 事件：message/source/line/col/stack 进载荷，签名含定位', () => {
    const { payload, signature } = buildClientErrorReport('error', {
      message: 'x is not a function', source: 'https://h/app.js', line: 42, col: 7, stack: 'TypeError: x...\n  at foo',
    });
    assert.equal(payload.kind, 'error');
    assert.equal(payload.message, 'x is not a function');
    assert.equal(payload.source, 'https://h/app.js');
    assert.equal(payload.line, 42);
    assert.equal(payload.col, 7);
    assert.match(payload.stack, /at foo/);
    assert.match(signature, /error\|x is not a function/);
    assert.match(signature, /app\.js:42/);
  });

  test('unhandledrejection：Error reason 取 message/stack，字符串 reason 直接 String 化', () => {
    const err = new Error('boom');
    const a = buildClientErrorReport('unhandledrejection', { reason: err });
    assert.equal(a.payload.kind, 'unhandledrejection');
    assert.equal(a.payload.message, 'boom');
    assert.match(a.payload.stack, /boom/);
    const b = buildClientErrorReport('unhandledrejection', { reason: 'plain refusal' });
    assert.equal(b.payload.message, 'plain refusal');
  });

  test('钳制：超长 message/stack 截断，空 message 回落占位符', () => {
    const { payload } = buildClientErrorReport('error', { message: 'A'.repeat(2000), stack: 'B'.repeat(9000) });
    assert.ok(payload.message.length <= 500);
    assert.ok(payload.stack.length <= 1500);
    const empty = buildClientErrorReport('error', {});
    assert.ok(empty.payload.message.length > 0);
  });
});

test.describe('clientErrorGateStep', () => {
  test('同签名窗口内只放一次，不同签名各放行', () => {
    let s = null;
    const r1 = clientErrorGateStep(s, 'sig-a', 1000);
    assert.equal(r1.send, true);
    const r2 = clientErrorGateStep(r1.state, 'sig-a', 2000);
    assert.equal(r2.send, false);
    const r3 = clientErrorGateStep(r2.state, 'sig-b', 3000);
    assert.equal(r3.send, true);
  });

  test('窗口内最多 max 条，窗口滚动后同签名可再报', () => {
    let s = null;
    for (let i = 0; i < 5; i++) {
      const r = clientErrorGateStep(s, `sig-${i}`, 1000 + i);
      assert.equal(r.send, true, `第 ${i} 条应放行`);
      s = r.state;
    }
    const overflow = clientErrorGateStep(s, 'sig-over', 5000);
    assert.equal(overflow.send, false);
    const nextWindow = clientErrorGateStep(overflow.state, 'sig-0', 1000 + 60000);
    assert.equal(nextWindow.send, true);
  });
});
