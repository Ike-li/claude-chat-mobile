// tests/unit/usage-snapshot.test.mjs —— usage-snapshot.js 纯函数单测（零 token）
// 覆盖：写入后 TTL 窗口内能回落取到 / 超过 TTL 返回 null / 未写入过（空 store）返回 null /
// rate 为空时不写入（不污染 store，也不清空已有快照）。全部用注入的 now，不依赖真实时钟。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createUsageSnapshotStore,
  rememberUsage,
  fallbackUsage,
  snapshotAgeMs,
  clampRateMonotonic,
  USAGE_SNAPSHOT_TTL_MS,
} from '../../app/src/ops/usage-snapshot.js';

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

test.describe('snapshotAgeMs：回落值的年龄（与 fallbackUsage 的边界严格同步）', () => {
  const rate = { fiveHour: { usedPercent: 40 } };

  test('未写入过 → null', () => {
    assert.equal(snapshotAgeMs(createUsageSnapshotStore(), 1_000), null);
  });

  test('TTL 内 → 返回年龄毫秒数', () => {
    const store = createUsageSnapshotStore();
    rememberUsage(store, rate, 1_000);
    assert.equal(snapshotAgeMs(store, 61_000), 60_000);
  });

  test('超 TTL → null，且与 fallbackUsage 同时失效（两者不得给出矛盾判断）', () => {
    const store = createUsageSnapshotStore();
    rememberUsage(store, rate, 1_000);
    const past = 1_000 + USAGE_SNAPSHOT_TTL_MS + 1;
    assert.equal(snapshotAgeMs(store, past), null);
    assert.equal(fallbackUsage(store, past), null);
  });

  test('恰好等于 TTL → 仍温热（复用 `>` 而非 `>=` 语义）', () => {
    const store = createUsageSnapshotStore();
    rememberUsage(store, rate, 1_000);
    const edge = 1_000 + USAGE_SNAPSHOT_TTL_MS;
    assert.equal(snapshotAgeMs(store, edge), USAGE_SNAPSHOT_TTL_MS);
    assert.ok(fallbackUsage(store, edge));
  });
});

// 不变量：固定窗口内 utilization 只增不减。见 clampRateMonotonic 的注释。
test.describe('clampRateMonotonic：同一 reset 窗口内额度百分比不许回退', () => {
  const R = '2026-09-03T20:00:00Z';

  test('同窗口内 next 更低 → 钳回 prev 的高位，并返回新对象（调用方可用 !== 检出）', () => {
    const prev = { fiveHour: { usedPercent: 82, resetsAt: R } };
    const next = { fiveHour: { usedPercent: 68, resetsAt: R } };
    const out = clampRateMonotonic(prev, next);
    assert.notEqual(out, next);
    assert.equal(out.fiveHour.usedPercent, 82);
    assert.equal(out.fiveHour.resetsAt, R);
    assert.equal(next.fiveHour.usedPercent, 68, '纯函数：不得改入参');
    assert.equal(prev.fiveHour.usedPercent, 82);
  });

  test('同窗口内 next 更高（正常增长）→ 原样返回 next 引用', () => {
    const next = { fiveHour: { usedPercent: 90, resetsAt: R } };
    assert.equal(clampRateMonotonic({ fiveHour: { usedPercent: 82, resetsAt: R } }, next), next);
  });

  test('resetsAt 变了 = 窗口已重置 → 放行下降（否则额度栏再也归不了零）', () => {
    const next = { fiveHour: { usedPercent: 3, resetsAt: '2026-09-04T01:00:00Z' } };
    assert.equal(clampRateMonotonic({ fiveHour: { usedPercent: 82, resetsAt: R } }, next), next);
    assert.equal(next.fiveHour.usedPercent, 3);
  });

  test('任一侧 resetsAt 缺失 → 无法证明同窗口，放行（宁可漏挡，不可钉死）', () => {
    const a = { fiveHour: { usedPercent: 20 } };
    assert.equal(clampRateMonotonic({ fiveHour: { usedPercent: 82, resetsAt: R } }, a), a);
    const b = { fiveHour: { usedPercent: 20, resetsAt: R } };
    assert.equal(clampRateMonotonic({ fiveHour: { usedPercent: 82 } }, b), b);
  });

  test('两个窗口各自独立判断：5h 钳、7d 放行', () => {
    const R7 = '2026-09-10T20:00:00Z';
    const out = clampRateMonotonic(
      { fiveHour: { usedPercent: 82, resetsAt: R }, sevenDay: { usedPercent: 20, resetsAt: R7 } },
      { fiveHour: { usedPercent: 68, resetsAt: R }, sevenDay: { usedPercent: 21, resetsAt: R7 } },
    );
    assert.equal(out.fiveHour.usedPercent, 82);
    assert.equal(out.sevenDay.usedPercent, 21);
  });

  test('prev 缺失 / next 缺失 / 非对象 → 原样返回 next（防御性，不抛）', () => {
    const next = { fiveHour: { usedPercent: 5, resetsAt: R } };
    assert.equal(clampRateMonotonic(null, next), next);
    assert.equal(clampRateMonotonic(undefined, next), next);
    assert.equal(clampRateMonotonic({ fiveHour: { usedPercent: 9, resetsAt: R } }, null), null);
    assert.equal(clampRateMonotonic({}, next), next);
  });

  test('usedPercent 非数字 → 不参与钳位（越界值早在 usageBitsForStatusLine 就被丢弃）', () => {
    const next = { fiveHour: { usedPercent: 10, resetsAt: R } };
    assert.equal(clampRateMonotonic({ fiveHour: { usedPercent: null, resetsAt: R } }, next), next);
  });
});
