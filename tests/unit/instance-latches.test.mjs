// tests/unit/instance-latches.test.mjs —— 实例状态 latch（done/error/aborted）派生纯函数单测
// 承接 P1-4「已中止独立状态」：done/error 已有的成对处理容易在补 aborted 时留下不对称疏漏
// （只在非 viewing 时才 add done/error，但 aborted 若也照搬这个规则，会在"前台中止"这个最常见场景下
// 从不触发；而 result 事件的清除若只对 viewing 或非 viewing 单独处理，会漏清另一侧的 aborted）。
// 抽成纯函数集中处理，避免这类疏漏散落在 server.js 的大回调里。
import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveLatches } from '../../src/server/instance-latches.js';

const base = { inDone: false, inError: false, inAborted: false, isViewing: false };

test.describe('deriveLatches', () => {
  test('system_interrupted：无条件置位 aborted，清 done/error（不论是否 viewing）', () => {
    assert.deepEqual(
      deriveLatches({ ...base, eventType: 'system_interrupted', inDone: true, isViewing: false }),
      { done: false, error: false, aborted: true },
    );
    assert.deepEqual(
      deriveLatches({ ...base, eventType: 'system_interrupted', inError: true, isViewing: true }), // viewing 中的前台会话也要 latch
      { done: false, error: false, aborted: true },
    );
  });

  test('result（非 viewing）：按 isError 二选一 latch done/error，且清 aborted', () => {
    assert.deepEqual(
      deriveLatches({ ...base, eventType: 'result', isError: false, isViewing: false, inAborted: true }),
      { done: true, error: false, aborted: false },
    );
    assert.deepEqual(
      deriveLatches({ ...base, eventType: 'result', isError: true, isViewing: false, inAborted: true }),
      { done: false, error: true, aborted: false },
    );
  });

  test('result（viewing）：done/error 保持既有行为不变（前台不 latch），但 aborted 必须被清（回归：中止后前台又正常完成一轮）', () => {
    assert.deepEqual(
      deriveLatches({ ...base, eventType: 'result', isError: false, isViewing: true, inDone: false, inError: false, inAborted: true }),
      { done: false, error: false, aborted: false }, // done/error 不变（仍 false，既有前台不 latch 行为），aborted 清掉
    );
  });

  // 实证发现（真实 SDK 行为）：interrupt() 成功后，SDK 消息流会紧接着自己吐出一条 result（is_error:true）
  // 终结这一轮——这条 result 不是独立的新错误，是这次中断的终态确认，必须保持/重新确认 aborted，
  // 不能被当成新的 error 覆盖掉（那样"已中止"这个状态刚置位就被自己触发的伴随事件立即抹掉）。
  test('result 且 wasInterrupted=true：不论 isError/isViewing，一律保持 aborted，不落 done/error', () => {
    assert.deepEqual(
      deriveLatches({ ...base, eventType: 'result', isError: true, isViewing: true, wasInterrupted: true }),
      { done: false, error: false, aborted: true },
    );
    assert.deepEqual(
      deriveLatches({ ...base, eventType: 'result', isError: true, isViewing: false, wasInterrupted: true }),
      { done: false, error: false, aborted: true },
    );
    assert.deepEqual(
      deriveLatches({ ...base, eventType: 'result', isError: false, isViewing: false, wasInterrupted: true }),
      { done: false, error: false, aborted: true },
    );
  });

  test('new_activity（init/permission_request/question）：无条件清空三者', () => {
    assert.deepEqual(
      deriveLatches({ ...base, eventType: 'new_activity', inDone: true, inError: false, inAborted: false }),
      { done: false, error: false, aborted: false },
    );
    assert.deepEqual(
      deriveLatches({ ...base, eventType: 'new_activity', inDone: false, inError: false, inAborted: true }),
      { done: false, error: false, aborted: false },
    );
  });

  test('其它事件类型：三者维持原状不变', () => {
    assert.deepEqual(
      deriveLatches({ ...base, eventType: 'tool_use', inDone: true, inError: false, inAborted: false }),
      { done: true, error: false, aborted: false },
    );
    assert.deepEqual(
      deriveLatches({ ...base, eventType: 'text_delta', inDone: false, inError: true, inAborted: false }),
      { done: false, error: true, aborted: false },
    );
  });
});
