// tests/unit/client-error-log.test.mjs —— 服务端前端错误上报落日志模块单测
// （logs:clientError 载荷校验/钳制/单行化/脱敏 + per-socket 限流）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatClientErrorLine, createSocketErrorLimiter } from '../../src/ops/client-error-log.js';

test.describe('formatClientErrorLine', () => {
  test('正常载荷 → 单行含 kind/message/定位/stack（换行折叠）', () => {
    const line = formatClientErrorLine({
      kind: 'error', message: 'x is not a function', source: 'https://h/app.js', line: 42, col: 7,
      stack: 'TypeError: x\n  at foo\n  at bar',
    });
    assert.match(line, /error: x is not a function/);
    assert.match(line, /@https:\/\/h\/app\.js:42:7/);
    assert.ok(!line.includes('\n'), 'stack 换行应折叠为单行');
    assert.match(line, /at foo/);
  });

  test('无效载荷（非对象/缺 message/非字符串 message）→ null', () => {
    assert.equal(formatClientErrorLine(null), null);
    assert.equal(formatClientErrorLine('str'), null);
    assert.equal(formatClientErrorLine({}), null);
    assert.equal(formatClientErrorLine({ message: 12345 }), null);
  });

  test('敌意载荷：超长钳制 + 敏感信息脱敏', () => {
    const line = formatClientErrorLine({ message: `leak sk-ant_${'a'.repeat(30)} ` + 'A'.repeat(5000), stack: 'B'.repeat(99999) });
    assert.ok(line.length < 2600, `总长应被钳制，实际 ${line.length}`);
    assert.ok(!line.includes('sk-ant_'), 'API key 应被脱敏');
  });
});

test.describe('createSocketErrorLimiter', () => {
  test('窗口内放行 max 条，超出拒绝，窗口滚动后恢复', () => {
    let t = 0;
    const limiter = createSocketErrorLimiter({ max: 3, windowMs: 60000, now: () => t });
    assert.equal(limiter.allow(), true);
    assert.equal(limiter.allow(), true);
    assert.equal(limiter.allow(), true);
    assert.equal(limiter.allow(), false);
    t = 60001;
    assert.equal(limiter.allow(), true);
  });
});
