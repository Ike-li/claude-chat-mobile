// tests/unit/agent-event-type-guard.test.mjs —— AgentSession 出向 type 的运行时自检。
// 契约清单（app/src/shared/protocol.js）此前只被门禁脚本消费，运行时看不见它：漏登记的 type 一路发到前端，
// 前端 handle 表没有对应项就静默丢弃，除非提交时跑了 npm run check 否则无人察觉。
// 这里锚定「记录但不拦截」的语义——n=1 生产稳定优先，门禁负责挡提交，运行时只负责让问题可见。
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSession } from '../helpers/agent-unit.mjs';
import { AGENT_EVENT_TYPES } from '../../app/src/shared/protocol.js';

function captureConsoleError(fn) {
  const original = console.error;
  const calls = [];
  console.error = (...args) => { calls.push(args.join(' ')); };
  try { fn(); } finally { console.error = original; }
  return calls;
}

test.describe('AgentSession 出向事件 type 自检', () => {
  test('已登记 type：不告警，事件照常入缓冲并递增 seq', () => {
    const { s, events, dispose } = makeSession();
    const calls = captureConsoleError(() => s.emit('system', { text: 'hi' }));
    assert.deepEqual(calls, []);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'system');
    assert.equal(events[0].seq, 1);
    dispose();
  });

  test('未登记 type：告警一次，但事件仍照常发出（不拦截）', () => {
    const { s, events, dispose } = makeSession();
    const calls = captureConsoleError(() => s.emit('not_a_real_type', { a: 1 }));
    assert.equal(calls.length, 1);
    assert.match(calls[0], /\[event-contract\]/);
    assert.match(calls[0], /not_a_real_type/);
    assert.equal(events.length, 1, '事件必须照常发出');
    assert.equal(events[0].type, 'not_a_real_type');
    assert.equal(events[0].seq, 1, 'seq 照常递增，不制造空洞');
    assert.deepEqual(events[0].payload, { a: 1 });
    dispose();
  });

  test('emitTransient 未登记 type 同样告警且照常发出，seq 不递增', () => {
    const { s, events, dispose } = makeSession();
    const calls = captureConsoleError(() => s.emitTransient('bogus_transient', { p: 1 }));
    assert.equal(calls.length, 1);
    assert.match(calls[0], /\[event-contract\]/);
    assert.equal(events.length, 1);
    assert.equal(events[0].transient, true);
    assert.equal(events[0].seq, 0, 'transient 复用当前 seq，不占序列');
    dispose();
  });

  test('契约内的每个 type 都不触发告警（全量扫一遍，防清单与校验分叉）', () => {
    const { s, dispose } = makeSession();
    const calls = captureConsoleError(() => {
      for (const type of AGENT_EVENT_TYPES) s.emit(type, {});
    });
    assert.deepEqual(calls, []);
    dispose();
  });
});
