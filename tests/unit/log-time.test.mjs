// tests/unit/log-time.test.mjs —— log-time.js 单测（服务端日志行时间戳前缀）
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatTimestamp, wrapConsole } from '../../src/shared/log-time.js';

const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/;

test.describe('log-time.js 单元测试', () => {
  test('formatTimestamp：本地 ISO 带偏移，且可无损回解析（时区无关）', () => {
    const d = new Date(1784000000123);
    const s = formatTimestamp(d);
    assert.match(s, TS_RE);
    assert.equal(new Date(s).getTime(), d.getTime());
  });

  test('wrapConsole：log/info/warn/error 首参前缀时间戳，其余参数原样透传', () => {
    const calls = [];
    const fake = {};
    for (const m of ['log', 'info', 'warn', 'error']) {
      fake[m] = (...args) => calls.push([m, args]);
    }
    const fixed = new Date(1784000000123);
    wrapConsole(fake, () => fixed);

    const payload = { a: 1 };
    fake.log('hello', payload);
    fake.error('boom');

    assert.equal(calls.length, 2);
    const [m1, args1] = calls[0];
    assert.equal(m1, 'log');
    assert.equal(args1[0], formatTimestamp(fixed));
    assert.equal(args1[1], 'hello');
    assert.equal(args1[2], payload); // 引用透传，不序列化
    const [m2, args2] = calls[1];
    assert.equal(m2, 'error');
    assert.equal(args2[0], formatTimestamp(fixed));
    assert.equal(args2[1], 'boom');
  });

  test('wrapConsole：幂等——二次包装不双前缀', () => {
    const calls = [];
    const fake = { log: (...args) => calls.push(args), info: () => {}, warn: () => {}, error: () => {} };
    const fixed = new Date(1784000000123);
    wrapConsole(fake, () => fixed);
    wrapConsole(fake, () => fixed);
    fake.log('once');
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], [formatTimestamp(fixed), 'once']);
  });
});
