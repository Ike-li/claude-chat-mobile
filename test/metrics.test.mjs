// test/metrics.test.mjs —— metrics.js 单测（LLD §3.7 MetricsCollector + StateProbe，承接 NFR-15）
import test from 'node:test';
import assert from 'node:assert/strict';
import { inc, gauge, snapshot, reset, classifyState } from '../metrics.js';

test.describe('MetricsCollector（LLD §3.7 指标最小集）', () => {
  test.beforeEach(() => reset());

  test('inc: 累计递增，默认 +1', () => {
    inc('events'); inc('events'); inc('events', 5);
    assert.equal(snapshot().counters.events, 7);
  });

  test('inc: 未出现过的计数器从 0 起算', () => {
    inc('rate_limit_lockouts');
    assert.equal(snapshot().counters.rate_limit_lockouts, 1);
  });

  test('gauge: 瞬时值覆盖式（非累计）', () => {
    gauge('active_sessions', 3);
    gauge('active_sessions', 5);
    assert.equal(snapshot().gauges.active_sessions, 5);
  });

  test('snapshot: 空时返回空 counters/gauges', () => {
    assert.deepEqual(snapshot(), { counters: {}, gauges: {} });
  });

  test('counter 与 gauge 命名空间独立（同名不互相覆盖）', () => {
    inc('x', 2); gauge('x', 9);
    const s = snapshot();
    assert.equal(s.counters.x, 2);
    assert.equal(s.gauges.x, 9);
  });

  test('reset: 清空所有计数器与瞬时值（仅测试用）', () => {
    inc('a'); gauge('b', 1);
    reset();
    assert.deepEqual(snapshot(), { counters: {}, gauges: {} });
  });
});

test.describe('classifyState（LLD §3.7 StateProbe.classify——后端可产出的四类）', () => {
  // 语义：failed/awaiting 是当前实时观测；notifyFailed 是进程生命周期内累计（重启清零）——一旦发生过
  // 推送失败即持续提示运维去查审计（诚实的诊断信号，非"必然还在失败中"）；mobileClients 为当前连接数。
  // host_offline 不在此列（LLD 明说不由后端产生，由客户端心跳缺席判定）。
  test('全正常且有移动端连接 → null（无需关注的状态）', () => {
    assert.equal(classifyState({ failed: 0, awaiting: 0, notifyFailed: 0, mobileClients: 1 }), null);
  });

  test('failed 优先级最高（盖过其余）', () => {
    assert.equal(classifyState({ failed: 1, awaiting: 2, notifyFailed: 3, mobileClients: 0 }), 'failed');
  });

  test('awaiting 次于 failed', () => {
    assert.equal(classifyState({ failed: 0, awaiting: 1, notifyFailed: 1, mobileClients: 1 }), 'awaiting');
  });

  test('notify_failed 次于 awaiting', () => {
    assert.equal(classifyState({ failed: 0, awaiting: 0, notifyFailed: 1, mobileClients: 1 }), 'notify_failed');
  });

  test('mobile_offline：当前无移动端连接（最低优先级、中性状态）', () => {
    assert.equal(classifyState({ failed: 0, awaiting: 0, notifyFailed: 0, mobileClients: 0 }), 'mobile_offline');
  });

  test('缺省字段按 0/正常处理（防御性）', () => {
    assert.equal(classifyState({}), 'mobile_offline'); // 无字段 → mobileClients 视为 0
    assert.equal(classifyState({ mobileClients: 2 }), null);
  });
});
