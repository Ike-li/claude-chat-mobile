// tests/unit/notifications.test.mjs —— 推送标题 / 标签 / 投递错误归因这类给人看的格式
// 抑制矩阵与正文最小化是 NOTIFY-01 / SEC-04，在 tests/invariants/notifications.test.mjs；这里放不碰红线的验收用例。
import test from 'node:test';
import assert from 'node:assert/strict';
import { notificationForEvent, ntfyMetaFor, describeDeliveryError } from '../../app/src/ops/notifications.js';

// 验收 O64：「⚠️ 任务出错」的 ntfy 推送 tags 仍是 white_check_mark，锁屏上显示成「✅ ⚠️ 任务出错」。
// 标签要跟标题同一个判断：完成 ✅、出错 ⚠️、已中止 ⏹。
test('result 的 ntfy 标签跟标题一致：出错不带 ✅，已中止也不带', () => {
  const tagsOf = (payload) => {
    const n = notificationForEvent('result', { durationMs: 1000, ...payload }, { hasClients: false });
    return ntfyMetaFor(n.ntfyType ?? 'result', {}, '').tags;
  };
  assert.deepEqual(tagsOf({}), ['white_check_mark']);
  assert.deepEqual(tagsOf({ isError: true }), ['warning']);
  assert.deepEqual(tagsOf({ interrupted: true, isError: true }), ['stop_button']);
  // 审批过期那一轮（O30）也是 is_error 收尾：标题是「⏰ 审批已过期」，标签同样不能是 ✅
  assert.deepEqual(tagsOf({ isError: true, approvalExpired: true }), ['warning']);
  // O120：过期了但那一轮模型正常收尾（没有 is_error）时，标签此前跟着回合走成 ✅，锁屏上是「✅ ⏰ 审批已过期」
  assert.deepEqual(tagsOf({ approvalExpired: true }), ['warning']);
});

// 验收 O51：ntfy 超时告警写「：23」（AbortSignal.timeout 抛的 DOMException，code 是数字 23）；断连、DNS 失败
// 只写「fetch failed」——真正的 ECONNRESET / ENOTFOUND 在 err.cause 里被丢了，前端「连不上 ntfy 服务（错误码）」
// 那句永远出不来。数字 code 不是错误码；超时归成 ETIMEDOUT；fetch 的底层原因从 cause 取。
test('ntfy（fetch）的失败：超时归 ETIMEDOUT，底层原因从 cause 取，数字 code 不当错误码', () => {
  assert.equal(describeDeliveryError({ name: 'TimeoutError', code: 23, message: 'The operation was aborted due to timeout' }), 'ETIMEDOUT');
  assert.equal(describeDeliveryError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } })), 'ECONNRESET');
  assert.equal(describeDeliveryError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } })), 'ENOTFOUND');
  assert.equal(describeDeliveryError({ code: 23, message: 'odd' }), 'odd');
});
