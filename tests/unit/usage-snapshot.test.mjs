// tests/unit/usage-snapshot.test.mjs —— usage-snapshot.js 纯函数单测（零 token）
// 覆盖：写入后 TTL 窗口内能回落取到 / 超过 TTL 返回 null / 未写入过（空 store）返回 null /
// rate 为空时不写入（不污染 store，也不清空已有快照）。全部用注入的 now，不依赖真实时钟。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createUsageSnapshotStore,
  rememberUsage,
  fallbackUsage,
  USAGE_SNAPSHOT_TTL_MS,
} from '../../src/ops/usage-snapshot.js';

test.describe('USAGE_SNAPSHOT_TTL_MS：默认 TTL', () => {
  test('默认 15 分钟', () => {
    assert.equal(USAGE_SNAPSHOT_TTL_MS, 15 * 60 * 1000);
  });
});

test.describe('createUsageSnapshotStore：空 store 初始形态', () => {
  test('新建 store → rate 为 null（尚未写入过）', () => {
    const store = createUsageSnapshotStore();
    assert.equal(store.rate, null);
  });

  test('每次调用返回独立实例（不共享引用）', () => {
    const a = createUsageSnapshotStore();
    const b = createUsageSnapshotStore();
    rememberUsage(a, { fiveHour: { usedPercent: 1 } }, 100);
    assert.equal(b.rate, null); // a 的写入不应影响 b
  });
});

test.describe('rememberUsage：写入 + 空值防污染', () => {
  test('写入非空 rate → store 记住 rate 与 now', () => {
    const store = createUsageSnapshotStore();
    rememberUsage(store, { fiveHour: { usedPercent: 42 } }, 1_000);
    assert.deepEqual(store.rate, { fiveHour: { usedPercent: 42 } });
    assert.equal(store.at, 1_000);
  });

  test('rateBits=undefined → 不写入（store 仍是初始空态）', () => {
    const store = createUsageSnapshotStore();
    rememberUsage(store, undefined, 1_000);
    assert.equal(store.rate, null);
  });

  test('rateBits=null → 不写入', () => {
    const store = createUsageSnapshotStore();
    rememberUsage(store, null, 1_000);
    assert.equal(store.rate, null);
  });

  test('rateBits={}（空对象、无 key）→ 不写入', () => {
    const store = createUsageSnapshotStore();
    rememberUsage(store, {}, 1_000);
    assert.equal(store.rate, null);
  });

  // 核心防污染场景：第三方鉴权账号 / 越界 utilization 等"本就不该有额度"的场景，usageBitsForStatusLine
  // 会产出空 rate；这类空写不该抹掉此前记住的真实温热快照，否则回落会在"本该无额度"和"曾经有额度"
  // 之间被空写打断，出现假性断档。
  test('已写入过热数据后，再传空值 → 不覆盖/不清空既有快照', () => {
    const store = createUsageSnapshotStore();
    rememberUsage(store, { fiveHour: { usedPercent: 42 } }, 1_000);
    rememberUsage(store, undefined, 2_000);
    assert.deepEqual(store.rate, { fiveHour: { usedPercent: 42 } });
    assert.equal(store.at, 1_000); // at 也不该被空写入推进
  });

  test('二次写入非空 rate → 覆盖为最新值与最新 now', () => {
    const store = createUsageSnapshotStore();
    rememberUsage(store, { fiveHour: { usedPercent: 42 } }, 1_000);
    rememberUsage(store, { fiveHour: { usedPercent: 55 } }, 2_000);
    assert.deepEqual(store.rate, { fiveHour: { usedPercent: 55 } });
    assert.equal(store.at, 2_000);
  });
});

test.describe('fallbackUsage：TTL 窗口内回落 / 超窗 null / 未写入 null', () => {
  test('未写入过（空 store）→ null', () => {
    const store = createUsageSnapshotStore();
    assert.equal(fallbackUsage(store, 1_000), null);
  });

  test('写入后窗口内 → 原样返回 rate 数据', () => {
    const store = createUsageSnapshotStore();
    rememberUsage(store, { fiveHour: { usedPercent: 42 } }, 1_000);
    assert.deepEqual(fallbackUsage(store, 1_000 + USAGE_SNAPSHOT_TTL_MS - 1), { fiveHour: { usedPercent: 42 } });
  });

  test('恰好等于 TTL（未越过）→ 仍返回（边界含在窗口内）', () => {
    const store = createUsageSnapshotStore();
    rememberUsage(store, { fiveHour: { usedPercent: 42 } }, 1_000);
    assert.deepEqual(fallbackUsage(store, 1_000 + USAGE_SNAPSHOT_TTL_MS), { fiveHour: { usedPercent: 42 } });
  });

  test('超过 TTL 一毫秒 → null', () => {
    const store = createUsageSnapshotStore();
    rememberUsage(store, { fiveHour: { usedPercent: 42 } }, 1_000);
    assert.equal(fallbackUsage(store, 1_000 + USAGE_SNAPSHOT_TTL_MS + 1), null);
  });

  test('自定义 ttl 覆盖默认值', () => {
    const store = createUsageSnapshotStore();
    rememberUsage(store, { fiveHour: { usedPercent: 42 } }, 1_000);
    assert.deepEqual(fallbackUsage(store, 1_100, 200), { fiveHour: { usedPercent: 42 } });
    assert.equal(fallbackUsage(store, 1_201, 200), null);
  });

  test('store=null/undefined → null（防御性，不抛）', () => {
    assert.equal(fallbackUsage(null, 1_000), null);
    assert.equal(fallbackUsage(undefined, 1_000), null);
  });
});
