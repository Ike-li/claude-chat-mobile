// tests/unit/statusline.test.mjs —— statusline.js 纯函数单测（零 token）
// statusLine 为 web 自有状态栏：自包含组装、不调脚本/快照。显示面目标对齐 CLI statusline。
// ctx 绝对 token 与窗口大小一律来自运行时真值（getContextUsage / CLI 自报）+ 会话内缓存；
// 绝不按模型名猜窗口——猜错会把 532k/1M(53%) 显示成 532k/200k(封顶 100%)。
import test from 'node:test';
import assert from 'node:assert/strict';
import { webContextCost, buildWebStatusLine, buildCliStatusLine, gitStatus, parseRepo, parsePorcelain, getContextUsageSafe, usageBitsForStatusLine, projectNameFromCwd, getFallbackUsageRate, noteStatusRefreshBusy } from '../../src/ops/statusline.js';
import { getDiagLogs } from '../../src/agent/diag-log.js';
import { createUsageSnapshotStore, USAGE_SNAPSHOT_TTL_MS } from '../../src/ops/usage-snapshot.js';

const usage = t => ({ input_tokens: t, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });

test.describe('webContextCost：只回真实 token 绝对数，不算窗口/百分比', () => {
  test('totalInputTokens = input + cache_creation + cache_read（真实占用口径）', () => {
    const r = webContextCost({ agent: { lastUsage: { input_tokens: 100_000, cache_creation_input_tokens: 60_000, cache_read_input_tokens: 60_000 } } });
    assert.equal(r.context.totalInputTokens, 220_000);
  });

  test('不再返回 windowSize / usedPercent / exceeds200k（窗口靠猜，已废除）', () => {
    const r = webContextCost({ agent: { lastUsage: usage(300_000) } });
    assert.equal(r.context.totalInputTokens, 300_000); // 只剩真实 token
    assert.equal(r.context.windowSize, undefined);
    assert.equal(r.context.usedPercent, undefined);
    assert.equal(r.context.exceeds200k, undefined);
  });

  test('保留原始 usage 四件套（含 output_tokens，CLI response 段）', () => {
    const r = webContextCost({ agent: { lastUsage: { input_tokens: 10, output_tokens: 7, cache_creation_input_tokens: 20, cache_read_input_tokens: 30 } } });
    assert.deepEqual(r.context.usage, { input_tokens: 10, output_tokens: 7, cache_creation_input_tokens: 20, cache_read_input_tokens: 30 });
  });

  test('output_tokens 缺省 → 0（不漏 undefined）', () => {
    const r = webContextCost({ agent: { lastUsage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } });
    assert.equal(r.context.usage.output_tokens, 0);
  });

  test('agent=null / 无 lastUsage → 无 context（空对象）', () => {
    assert.deepEqual(webContextCost({ agent: null }), {});
    assert.deepEqual(webContextCost({ agent: {} }), {});
  });

  test('cost：totalCostUsd>0 → 返回 cost 段', () => {
    const r = webContextCost({ agent: { totalCostUsd: 1.5, totalDurationMs: 60_000, totalApiDurationMs: 30_000 } });
    assert.equal(r.cost.usedUsd, 1.5);
    assert.equal(r.cost.durationMs, 60_000);
    assert.equal(r.cost.apiDurationMs, 30_000);
  });
});

test.describe('buildWebStatusLine：web 自包含结构化状态（对齐 CLI statusline 文案）', () => {
  test('组装 model/ctx/cost/duration + cache 命中率 + out；无 cwd 时无 git 段', async () => {
    const p = await buildWebStatusLine({
      agent: {
        activeModel: 'claude-opus-4-8[1m]',
        lastUsage: { input_tokens: 200_000, output_tokens: 1_500, cache_creation_input_tokens: 0, cache_read_input_tokens: 200_000 },
        totalCostUsd: 1.23, totalDurationMs: 60_000, totalApiDurationMs: 30_000
      },
      cwd: undefined
    });
    assert.equal(p.model, 'claude-opus-4-8[1m]'); // 含网关后缀
    assert.equal(p.ctx.tokens, 400_000);
    assert.equal(p.ctx.cacheHitPct, 50);          // 200k read / 400k total
    assert.equal(p.ctx.in, 200_000);              // token 明细 in/out/w/r
    assert.equal(p.ctx.out, 1_500);               // response 真值（不再恒 0）
    assert.equal(p.ctx.w, 0);
    assert.equal(p.ctx.r, 200_000);
    assert.equal(p.ctx.reused, undefined);        // web 独有 reused 已删
    assert.equal(p.ctx.cacheExpiresAt, undefined);// web 独有 TTL 已删
    assert.equal(p.ctx.categories, undefined);    // categories 非 CLI statusline 字段
    assert.equal(p.task, undefined);              // web 独有 task 已删
    assert.equal(p.cost, 1.23);
    assert.deepEqual(p.duration, { wallMs: 60_000, apiMs: 30_000 });
    assert.equal(p.git, undefined);               // 无 cwd → 无 git 段
    assert.equal(p.project, undefined);
    assert.equal(typeof p.ts, 'number');
  });

  test('effort 有值 → p.effort；null/缺省 → 不放（对齐 CLI 空 effort 不打印）', async () => {
    const withE = await buildWebStatusLine({ agent: { activeModel: 'm', effort: 'high', lastUsage: usage(1) }, cwd: undefined });
    assert.equal(withE.effort, 'high');
    const none = await buildWebStatusLine({ agent: { activeModel: 'm', lastUsage: usage(1) }, cwd: undefined });
    assert.equal(none.effort, undefined);
  });

  test('project 从 cwd 末段取；非 git 目录 git 段缺席；agent=null 不漏 model/ctx', async () => {
    const p = await buildWebStatusLine({ agent: null, cwd: '/tmp/nonexistent-ccm-xyz-123' });
    assert.equal(p.project, 'nonexistent-ccm-xyz-123');
    assert.equal(p.cwd, '/tmp/nonexistent-ccm-xyz-123');
    assert.equal(p.git, undefined);   // 不存在/非 git → null
    assert.equal(p.model, undefined); // agent=null：不回退全局
    assert.equal(p.ctx, undefined);
    assert.equal(p.cost, undefined);
  });

  test('model 回退 reportedModel（FRESH 会话 activeModel 空时显示 init 真实模型）', async () => {
    const p = await buildWebStatusLine({ agent: { reportedModel: 'claude-opus-4-8', lastUsage: usage(1000) }, cwd: undefined });
    assert.equal(p.model, 'claude-opus-4-8');
  });

  test('gitStatus(undefined) → null（边界）', async () => {
    assert.equal(await gitStatus(undefined), null);
  });

  test('versions.cli 取首段裸版本号（去 "(Claude Code)" 后缀）；unknown/缺省 → 无 version', async () => {
    const withVer = await buildWebStatusLine({ agent: { reportedModel: 'm', lastUsage: usage(1) }, cwd: undefined, versions: { cli: '2.1.178 (Claude Code)' } });
    assert.equal(withVer.version, '2.1.178');
    const unknown = await buildWebStatusLine({ agent: null, cwd: undefined, versions: { cli: 'unknown' } });
    assert.equal(unknown.version, undefined);
    const none = await buildWebStatusLine({ agent: null, cwd: undefined });
    assert.equal(none.version, undefined);
  });
});

test('buildCliStatusLine：只把 CLI 快照投影成现有 Web statusline 契约，不借用 SDK 陈值', async () => {
  const snapshot = {
    source: 'claude-cli', capturedAt: 1_000, sessionId: 'cli-session', cwd: '/tmp/not-a-repo',
    model: { id: 'claude-opus-4-8', displayName: 'Opus 4.8' }, effort: 'max', thinking: { enabled: true },
    ctx: { tokens: 100, in: 5, out: 2, w: 10, r: 85, windowSize: 1_000, usedPercent: 10 },
    cost: 1.25, duration: { wallMs: 2_000, apiMs: 1_500 }, lines: { added: 3, removed: 1 },
    rate: { fiveHour: { usedPercent: 42, resetsAt: 1_784_106_000 } }, cliVersion: '2.1.210',
    secret: 'must-not-leak',
  };
  // 显式独立 store：避免写入模块默认单例污染后续 getFallbackUsageRate() 无参断言。
  const payload = await buildCliStatusLine({ snapshot, cwd: snapshot.cwd, usageStore: createUsageSnapshotStore() });

  assert.equal(payload.model, 'Opus 4.8');
  assert.equal(payload.effort, 'max');
  assert.deepEqual(payload.thinking, { enabled: true });
  assert.deepEqual(payload.ctx, snapshot.ctx);
  assert.equal(payload.cost, 1.25);
  assert.deepEqual(payload.duration, snapshot.duration);
  assert.deepEqual(payload.lines, snapshot.lines);
  assert.deepEqual(payload.rate.fiveHour, { usedPercent: 42, resetsAt: '2026-07-15T09:00:00.000Z' });
  assert.equal(payload.version, '2.1.210');
  assert.deepEqual(payload.session, { id: 'cli-session' });
  assert.equal(payload.project, 'not-a-repo');
  assert.equal(payload.secret, undefined);
});

// ---- 账号级额度快照回落：CLI 路径（owner=cli 时 bridge 快照恰好这一拍没带 rate 字段）----
test.describe('buildCliStatusLine：额度快照回落（usage-snapshot 接线，与 SDK 路径共享同一账号级快照）', () => {
  const baseSnapshot = { source: 'claude-cli', capturedAt: 1_000, sessionId: 'cli-session', cwd: '/tmp/not-a-repo' };

  test('本次快照带 rate → 写入快照；下一次快照没带 rate → 回落垫上 + rateFromSnapshot:true', async () => {
    const store = createUsageSnapshotStore();
    const withRate = { ...baseSnapshot, rate: { fiveHour: { usedPercent: 60 } } };
    const first = await buildCliStatusLine({ snapshot: withRate, cwd: withRate.cwd, usageStore: store });
    assert.equal(first.rate.fiveHour.usedPercent, 60);
    assert.equal(first.rateFromSnapshot, undefined);

    const withoutRate = { ...baseSnapshot }; // 同一 fresh 快照序列，这一拍恰好没有 rate 字段
    const second = await buildCliStatusLine({ snapshot: withoutRate, cwd: withoutRate.cwd, usageStore: store });
    assert.equal(second.rate.fiveHour.usedPercent, 60);
    assert.equal(second.rateFromSnapshot, true);
  });

  test('从未写入过（store 为空）+ 快照无 rate → payload 无 rate，无回落', async () => {
    const store = createUsageSnapshotStore();
    const p = await buildCliStatusLine({ snapshot: { ...baseSnapshot }, cwd: baseSnapshot.cwd, usageStore: store });
    assert.equal(p.rate, undefined);
    assert.equal(p.rateFromSnapshot, undefined);
  });

  test('越界 utilization（>100）→ 不写入 store，也不回落', async () => {
    const store = createUsageSnapshotStore();
    const bad = { ...baseSnapshot, rate: { fiveHour: { usedPercent: 150 } } };
    const p = await buildCliStatusLine({ snapshot: bad, cwd: bad.cwd, usageStore: store });
    assert.equal(p.rate, undefined);
    assert.equal(store.rate, null);
  });

  test('SDK 路径先写入的快照，CLI 路径这次没拿到 rate → 同样能回落（共享同一账号级 store）', async () => {
    const store = createUsageSnapshotStore();
    store.rate = { sevenDay: { usedPercent: 25 } };
    store.at = Date.now();
    const p = await buildCliStatusLine({ snapshot: { ...baseSnapshot }, cwd: baseSnapshot.cwd, usageStore: store });
    assert.equal(p.rate.sevenDay.usedPercent, 25);
    assert.equal(p.rateFromSnapshot, true);
  });

  test('快照已超过 TTL → 不回落', async () => {
    const store = createUsageSnapshotStore();
    store.rate = { fiveHour: { usedPercent: 77 } };
    store.at = Date.now() - USAGE_SNAPSHOT_TTL_MS - 1_000;
    const p = await buildCliStatusLine({ snapshot: { ...baseSnapshot }, cwd: baseSnapshot.cwd, usageStore: store });
    assert.equal(p.rate, undefined);
  });
});

// ---- getFallbackUsageRate：app.js refreshStatusLine() cli-unavailable 分支专用的窄读接口 ----
// （selectStatusSource 判定 kind!=='cli' 时，buildCliStatusLine 整个不会被调用，两个正常回落点都摸不到；
//  这个函数是唯一让该分支也能垫上账号级温热额度的入口，不直接导出 usageSnapshotStore 单例本身）。
test.describe('getFallbackUsageRate：cli-unavailable 分支专用回落读接口', () => {
  test('store 里有温热快照 → 原样返回 rate', () => {
    const store = createUsageSnapshotStore();
    store.rate = { fiveHour: { usedPercent: 55 } };
    store.at = Date.now();
    assert.deepEqual(getFallbackUsageRate(Date.now(), store), { fiveHour: { usedPercent: 55 } });
  });

  test('从未写入过（store.rate 为 null）→ null', () => {
    const store = createUsageSnapshotStore();
    assert.equal(getFallbackUsageRate(Date.now(), store), null);
  });

  test('已超过 TTL → null', () => {
    const store = createUsageSnapshotStore();
    store.rate = { fiveHour: { usedPercent: 55 } };
    store.at = Date.now() - USAGE_SNAPSHOT_TTL_MS - 1_000;
    assert.equal(getFallbackUsageRate(Date.now(), store), null);
  });

  test('恰好等于 TTL 边界 → 仍算温热（复用 fallbackUsage 的 `>` 而非 `>=` 语义）', () => {
    const store = createUsageSnapshotStore();
    store.rate = { sevenDay: { usedPercent: 10 } };
    const now = Date.now();
    store.at = now - USAGE_SNAPSHOT_TTL_MS;
    assert.deepEqual(getFallbackUsageRate(now, store), { sevenDay: { usedPercent: 10 } });
  });

  test('显式传入同一 store 时 buildCliStatusLine 与 getFallbackUsageRate 共享数据（不污染模块默认单例）', async () => {
    // 用独立 store 证明两条 API 能共享同一份数据——绝不往模块默认单例写，避免污染后续测试。
    const store = createUsageSnapshotStore();
    const snapshot = { source: 'claude-cli', capturedAt: Date.now(), sessionId: 'gfur-shared-isolated-store', cwd: '/tmp/gfur-shared',
      rate: { fiveHour: { usedPercent: 91 } } };
    await buildCliStatusLine({ snapshot, cwd: snapshot.cwd, usageStore: store });
    assert.equal(getFallbackUsageRate(Date.now(), store).fiveHour.usedPercent, 91);
    // 模块默认单例应仍为空（本测试未触碰它）
    assert.equal(getFallbackUsageRate(Date.now()), null);
  });
});

test.describe('buildWebStatusLine：ctx 窗口只认运行时真值 + 会话内缓存（绝不按模型名猜）', () => {
  const usageT = t => ({ input_tokens: t, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });
  const sdkQ = maxTokens => ({ getContextUsage: async () => ({ maxTokens, percentage: 7, totalTokens: 1, categories: [] }) });

  test('无 SDK 真值且无缓存 → 不出 windowSize/usedPercent，只保留绝对 token', async () => {
    // 治根前这里会按模型名猜 200k 并算出封顶 100%；现在宁可不显示 %，也不编造分母。
    const p = await buildWebStatusLine({ agent: { activeModel: 'claude-opus-5', lastUsage: usageT(532_000) }, cwd: undefined });
    assert.equal(p.ctx.windowSize, undefined);
    assert.equal(p.ctx.usedPercent, undefined);
    assert.equal(p.ctx.tokens, 532_000);
  });

  test('SDK 真值落库缓存：同模型下次 RPC 失败仍用真值窗口（治 ctx 100%↔53% 跳变）', async () => {
    const agent = { activeModel: 'claude-opus-5', lastUsage: usageT(532_000), q: sdkQ(1_000_000), disposed: false };
    const live = await buildWebStatusLine({ agent, cwd: undefined });
    assert.equal(live.ctx.windowSize, 1_000_000);
    // 下一次刷新撞上 busy 子进程 → RPC 抛错/超时；此时必须垫会话真值，不得回落成猜测
    agent.q = { getContextUsage: async () => { throw new Error('rpc fail'); } };
    const degraded = await buildWebStatusLine({ agent, cwd: undefined });
    assert.equal(degraded.ctx.windowSize, 1_000_000);
    assert.equal(degraded.ctx.usedPercent, 53); // 532k/1M，而非 532k/200k 封顶 100
  });

  test('模型切换 → 旧窗口缓存作废（opus-5 的 1M 不得算到 haiku 头上）', async () => {
    const agent = { activeModel: 'claude-opus-5', lastUsage: usageT(100_000), q: sdkQ(1_000_000), disposed: false };
    await buildWebStatusLine({ agent, cwd: undefined });
    agent.activeModel = 'claude-haiku-4-5';
    agent.q = null;
    const p = await buildWebStatusLine({ agent, cwd: undefined });
    assert.equal(p.ctx.windowSize, undefined);
    assert.equal(p.ctx.usedPercent, undefined);
    assert.equal(p.ctx.tokens, 100_000);
  });

  test('缓存路径 usedPercent 封顶 100（占用超窗口）', async () => {
    const agent = { activeModel: 'm', lastUsage: usageT(1_200_000), q: sdkQ(1_000_000), disposed: false };
    await buildWebStatusLine({ agent, cwd: undefined });
    agent.q = null;
    const p = await buildWebStatusLine({ agent, cwd: undefined });
    assert.equal(p.ctx.usedPercent, 100);
  });

  test('窗口真值随模型升级自动跟随（2M 模型无需改代码即可正确显示）', async () => {
    const agent = { activeModel: 'future-model-2m', lastUsage: usageT(500_000), q: sdkQ(2_000_000), disposed: false };
    const live = await buildWebStatusLine({ agent, cwd: undefined });
    assert.equal(live.ctx.windowSize, 2_000_000);
    agent.q = null;
    const degraded = await buildWebStatusLine({ agent, cwd: undefined });
    assert.equal(degraded.ctx.windowSize, 2_000_000);
    assert.equal(degraded.ctx.usedPercent, 25); // 500k/2M
  });
});

test.describe('getContextUsageSafe：安全取 Agent SDK 上下文用量（Part2 §6）', () => {
  test('有 getContextUsage → 返回其值', async () => {
    const q = { getContextUsage: async () => ({ maxTokens: 1_000_000, percentage: 23, categories: [] }) };
    assert.equal((await getContextUsageSafe(q, 500)).maxTokens, 1_000_000);
  });
  test('无 getContextUsage / q=null → null（降级信号）', async () => {
    assert.equal(await getContextUsageSafe({}, 500), null);
    assert.equal(await getContextUsageSafe(null, 500), null);
  });
  test('getContextUsage 抛错 → null（降级）', async () => {
    const q = { getContextUsage: async () => { throw new Error('rpc fail'); } };
    assert.equal(await getContextUsageSafe(q, 500), null);
  });
  test('getContextUsage 超时 → null（降级，小超时确定性）', async () => {
    const q = { getContextUsage: () => new Promise(() => {}) }; // 永不 resolve
    assert.equal(await getContextUsageSafe(q, 50), null);
  });
});

test.describe('buildWebStatusLine：ctx% 只认 SDK getContextUsage 真值（Part2 修 5x bug）', () => {
  const usageC = t => ({ input_tokens: t, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });
  test('活跃会话（q.getContextUsage 返回权威值）→ windowSize/usedPercent 来自 SDK；categories 不透传', async () => {
    // 真 bug 场景：model 名看着像 200k 的 haiku，但 SDK 实报 maxTokens=1M → ctx% 不再偏高 5x
    const cats = [{ name: 'Skills', tokens: 5000, color: '#abc' }, { name: 'Free space', tokens: 995000, color: '#def' }];
    const q = { getContextUsage: async () => ({ maxTokens: 1_000_000, percentage: 23, totalTokens: 230_000, categories: cats }) };
    const p = await buildWebStatusLine({ agent: { activeModel: 'claude-haiku-4-5', lastUsage: usageC(50_000), q, disposed: false }, cwd: undefined });
    assert.equal(p.ctx.windowSize, 1_000_000);   // SDK 权威，非静态 200k
    assert.equal(p.ctx.usedPercent, 23);         // 官方 percentage，非 tokens/win 自算
    assert.equal(p.ctx.totalTokens, 230_000);   // 与 percentage 同源；left 用它，别用 lastUsage
    assert.equal(p.ctx.tokens, 50_000);         // lastUsage 仍留给 uncached/cache 明细
    assert.equal(p.ctx.categories, undefined);   // 对齐 CLI statusline：categories 不进 statusline
  });
  test('SDK 权威路径：lastUsage 全 0 时仍透传 totalTokens（修 left 1.0m/1.0m 与 ctx 13% 分叉）', async () => {
    // 真机回归：中途刷新 lastUsage 可能是 0（第三方/网关中间消息无 usage），但 getContextUsage
    // 仍报 percentage=13 + totalTokens≈130k。若 left 用 windowSize-tokens → 假 1.0m/1.0m。
    const q = { getContextUsage: async () => ({ maxTokens: 1_000_000, percentage: 13, totalTokens: 130_000, categories: [] }) };
    const p = await buildWebStatusLine({
      agent: { activeModel: 'grok-4.5[1m]', lastUsage: usageC(0), q, disposed: false },
      cwd: undefined,
    });
    assert.equal(p.ctx.windowSize, 1_000_000);
    assert.equal(p.ctx.usedPercent, 13);
    assert.equal(p.ctx.tokens, 0);            // lastUsage 真值保留
    assert.equal(p.ctx.totalTokens, 130_000); // left 的权威占用
  });
  test('disposed 会话（q 存在但 disposed）→ 不调 SDK；无缓存则不出 %', async () => {
    let called = false;
    const q = { getContextUsage: async () => { called = true; return { maxTokens: 1e6, percentage: 5, categories: [] }; } };
    const p = await buildWebStatusLine({ agent: { activeModel: 'claude-haiku-4-5', lastUsage: usageC(50_000), q, disposed: true }, cwd: undefined });
    assert.equal(called, false);                 // disposed → 不调 SDK
    assert.equal(p.ctx.windowSize, undefined);   // 无会话真值可垫 → 不编造分母
    assert.equal(p.ctx.usedPercent, undefined);
    assert.equal(p.ctx.tokens, 50_000);          // 绝对 token 仍显示
  });
  test('无 q（idle/历史冷读）→ 无缓存则不出 %，只留绝对 token', async () => {
    const p = await buildWebStatusLine({ agent: { activeModel: 'claude-opus-4-8[1m]', lastUsage: usageC(400_000) }, cwd: undefined });
    assert.equal(p.ctx.windowSize, undefined);   // [1m] 后缀也不再当窗口依据（网关可能乱贴）
    assert.equal(p.ctx.usedPercent, undefined);
    assert.equal(p.ctx.tokens, 400_000);
  });
});

test.describe('usageBitsForStatusLine：5h/7d 额度 + lines +/−（对齐 CLI）', () => {
  test('完整 usage → rate.fiveHour/sevenDay + lines', () => {
    const bits = usageBitsForStatusLine({
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 42.5, resets_at: '2026-07-14T12:00:00Z' },
        seven_day: { utilization: 11, resets_at: '2026-07-20T00:00:00Z' }
      },
      session: { total_lines_added: 12, total_lines_removed: 3, total_cost_usd: 0.5 }
    });
    assert.deepEqual(bits.rate.fiveHour, { usedPercent: 42.5, resetsAt: '2026-07-14T12:00:00Z' });
    assert.deepEqual(bits.rate.sevenDay, { usedPercent: 11, resetsAt: '2026-07-20T00:00:00Z' });
    assert.deepEqual(bits.lines, { added: 12, removed: 3 });
  });
  test('rate_limits_available=false → 无 rate（第三方 provider）', () => {
    const bits = usageBitsForStatusLine({
      rate_limits_available: false,
      rate_limits: { five_hour: { utilization: 10 } },
      session: { total_lines_added: 5, total_lines_removed: 0 }
    });
    assert.equal(bits.rate, undefined);
    assert.deepEqual(bits.lines, { added: 5, removed: 0 });
  });
  test('lines 全 0 → 不放 lines；usage 空 → 空对象', () => {
    assert.equal(usageBitsForStatusLine({ session: { total_lines_added: 0, total_lines_removed: 0 } }).lines, undefined);
    assert.deepEqual(usageBitsForStatusLine(null), {});
  });
  // OPS-2：越界 utilization 与 CLI 路径一致——丢弃，不输出 usedPercent 150/-5。
  test('utilization 越出 [0,100] → 不放 rate 窗（OPS-2）', () => {
    const high = usageBitsForStatusLine({
      rate_limits: { five_hour: { utilization: 150 }, seven_day: { utilization: 11 } },
    });
    assert.equal(high.rate?.fiveHour, undefined);
    assert.deepEqual(high.rate?.sevenDay, { usedPercent: 11 });
    const low = usageBitsForStatusLine({
      rate_limits: { five_hour: { utilization: -5 } },
    });
    assert.equal(low.rate, undefined);
  });
});

test.describe('buildWebStatusLine：fetchUsage 接线（5h/7d + lines）', () => {
  // 显式传入独立 usageStore：不依赖模块级默认单例——既避免这几个用例互相污染，也避免被同文件
  // 其它 describe（如下方"额度快照回落"）的写入干扰，用例结果与执行顺序无关。
  test('agent.fetchUsage 返回有效 → p.rate / p.lines；非回落（rateFromSnapshot 不置位）', async () => {
    const agent = {
      activeModel: 'm', lastUsage: usage(1000), disposed: false,
      fetchUsage: async () => ({
        rate_limits_available: true,
        rate_limits: { five_hour: { utilization: 70, resets_at: '2026-07-14T18:00:00Z' } },
        session: { total_lines_added: 8, total_lines_removed: 2 }
      })
    };
    const p = await buildWebStatusLine({ agent, cwd: undefined, usageStore: createUsageSnapshotStore() });
    assert.equal(p.rate.fiveHour.usedPercent, 70);
    assert.equal(p.rate.fiveHour.resetsAt, '2026-07-14T18:00:00Z');
    assert.deepEqual(p.lines, { added: 8, removed: 2 });
    assert.equal(p.rateFromSnapshot, undefined); // 本轮是活数据，不是快照垫的
  });
  test('fetchUsage 抛错 / disposed → 字段省，不崩（空 store，无快照可回落）', async () => {
    const boom = await buildWebStatusLine({
      agent: { activeModel: 'm', lastUsage: usage(1), disposed: false, fetchUsage: async () => { throw new Error('rpc'); } },
      cwd: undefined, usageStore: createUsageSnapshotStore()
    });
    assert.equal(boom.rate, undefined);
    assert.equal(boom.lines, undefined);
    const disposed = await buildWebStatusLine({
      agent: { activeModel: 'm', lastUsage: usage(1), disposed: true, fetchUsage: async () => ({ rate_limits_available: true, rate_limits: { five_hour: { utilization: 1 } } }) },
      cwd: undefined, usageStore: createUsageSnapshotStore()
    });
    assert.equal(disposed.rate, undefined);
  });
});

// ---- 账号级额度快照回落（OPS：owner=sdk fetchUsage 超时/owner=cli bridge 快照过期时"时有时无"的根因修复）----
test.describe('buildWebStatusLine：额度快照回落（usage-snapshot 接线）', () => {
  test('先成功写入快照，下一轮 fetchUsage 抛错 → 用快照垫上 + rateFromSnapshot:true', async () => {
    const store = createUsageSnapshotStore();
    const okAgent = {
      activeModel: 'm', lastUsage: usage(1), disposed: false,
      fetchUsage: async () => ({ rate_limits_available: true, rate_limits: { five_hour: { utilization: 33 } } })
    };
    const first = await buildWebStatusLine({ agent: okAgent, cwd: undefined, usageStore: store });
    assert.equal(first.rate.fiveHour.usedPercent, 33);
    assert.equal(first.rateFromSnapshot, undefined);

    const boomAgent = {
      activeModel: 'm', lastUsage: usage(1), disposed: false,
      fetchUsage: async () => { throw new Error('rpc timeout'); }
    };
    const second = await buildWebStatusLine({ agent: boomAgent, cwd: undefined, usageStore: store });
    assert.equal(second.rate.fiveHour.usedPercent, 33); // 垫上刚才那份温热快照
    assert.equal(second.rateFromSnapshot, true);
  });

  test('先成功写入快照，下一轮 agent 已 dispose（跳过 fetchUsage）→ 同样回落垫上', async () => {
    const store = createUsageSnapshotStore();
    const okAgent = {
      activeModel: 'm', lastUsage: usage(1), disposed: false,
      fetchUsage: async () => ({ rate_limits_available: true, rate_limits: { seven_day: { utilization: 12 } } })
    };
    await buildWebStatusLine({ agent: okAgent, cwd: undefined, usageStore: store });

    const disposedAgent = { activeModel: 'm', lastUsage: usage(1), disposed: true, fetchUsage: async () => { throw new Error('unreachable'); } };
    const p = await buildWebStatusLine({ agent: disposedAgent, cwd: undefined, usageStore: store });
    assert.equal(p.rate.sevenDay.usedPercent, 12);
    assert.equal(p.rateFromSnapshot, true);
  });

  test('第三方鉴权账号（rate_limits_available:false）→ 快照从未被写入，回落也为空，payload 无 rate', async () => {
    const store = createUsageSnapshotStore();
    const agent = {
      activeModel: 'm', lastUsage: usage(1), disposed: false,
      fetchUsage: async () => ({ rate_limits_available: false, rate_limits: { five_hour: { utilization: 10 } } })
    };
    const p = await buildWebStatusLine({ agent, cwd: undefined, usageStore: store });
    assert.equal(p.rate, undefined);
    assert.equal(p.rateFromSnapshot, undefined);
    assert.equal(store.rate, null); // 关键：从未写入过——第三方鉴权账号不该在 store 里留任何痕迹
  });

  // code review 修复：此前"本轮 RPC 成功但明确无额度"仍会垫上一份 Anthropic 温热快照，
  // 导致切换到第三方鉴权账号后 statusline 继续显示上一账号的 5h/7d。
  test('先有 Anthropic 温热快照，下一轮第三方鉴权明确无额度 → 不垫旧值（payload 无 rate）', async () => {
    const store = createUsageSnapshotStore();
    const okAgent = {
      activeModel: 'm', lastUsage: usage(1), disposed: false,
      fetchUsage: async () => ({ rate_limits_available: true, rate_limits: { five_hour: { utilization: 40 } } })
    };
    await buildWebStatusLine({ agent: okAgent, cwd: undefined, usageStore: store });
    assert.equal(store.rate.fiveHour.usedPercent, 40);

    const thirdParty = {
      activeModel: 'm', lastUsage: usage(1), disposed: false,
      fetchUsage: async () => ({ rate_limits_available: false, rate_limits: { five_hour: { utilization: 10 } } })
    };
    const p = await buildWebStatusLine({ agent: thirdParty, cwd: undefined, usageStore: store });
    assert.equal(p.rate, undefined, '明确无额度时不得垫旧 Anthropic 快照');
    assert.equal(p.rateFromSnapshot, undefined);
  });

  test('先有温热快照，下一轮 no_valid_window（越界 utilization）→ 同样不垫旧值', async () => {
    const store = createUsageSnapshotStore();
    store.rate = { fiveHour: { usedPercent: 55 } };
    store.at = Date.now();
    const agent = {
      activeModel: 'm', lastUsage: usage(1), disposed: false,
      fetchUsage: async () => ({ rate_limits: { five_hour: { utilization: 150 } } })
    };
    const p = await buildWebStatusLine({ agent, cwd: undefined, usageStore: store });
    assert.equal(p.rate, undefined);
    assert.equal(p.rateFromSnapshot, undefined);
  });

  test('越界 utilization（no_valid_window）→ 同样不写入、不回落', async () => {
    const store = createUsageSnapshotStore();
    const agent = {
      activeModel: 'm', lastUsage: usage(1), disposed: false,
      fetchUsage: async () => ({ rate_limits: { five_hour: { utilization: 150 }, seven_day: { utilization: -5 } } })
    };
    const p = await buildWebStatusLine({ agent, cwd: undefined, usageStore: store });
    assert.equal(p.rate, undefined);
    assert.equal(store.rate, null);
  });

  test('快照存在但已超过 TTL → 不回落（payload 无 rate）', async () => {
    const store = createUsageSnapshotStore();
    store.rate = { fiveHour: { usedPercent: 90 } };
    store.at = Date.now() - USAGE_SNAPSHOT_TTL_MS - 1_000; // 手工构造一份"陈旧"快照
    const agent = {
      activeModel: 'm', lastUsage: usage(1), disposed: false,
      fetchUsage: async () => { throw new Error('rpc timeout'); }
    };
    const p = await buildWebStatusLine({ agent, cwd: undefined, usageStore: store });
    assert.equal(p.rate, undefined);
    assert.equal(p.rateFromSnapshot, undefined);
  });
});

test.describe('buildWebStatusLine：额度不可用 → diag-log statusline/rate_reason_change（去重）', () => {
  test('rate_limits_available:false → 记 reason:third_party_auth', async () => {
    const agent = {
      activeModel: 'm', lastUsage: usage(1), disposed: false, sessionId: 'test-sid-third-party',
      lastRateUnavailableReason: null, // 真实 Agent 构造函数里的初始值
      fetchUsage: async () => ({ rate_limits_available: false, rate_limits: { five_hour: { utilization: 10 } } })
    };
    // 独立 store：diag 测试不关心快照，避免成功恢复路径污染模块默认单例。
    const store = createUsageSnapshotStore();
    await buildWebStatusLine({ agent, cwd: undefined, usageStore: store });
    const entries = getDiagLogs('test-sid-third-party').filter(e => e.subsystem === 'statusline');
    assert.equal(entries.length, 1);
    assert.equal(entries[0].detail.reason, 'third_party_auth');
    assert.equal(entries[0].detail.previousReason, null);
  });

  test('utilization 越界导致 rate 整段缺失 → 记 reason:no_valid_window', async () => {
    const agent = {
      activeModel: 'm', lastUsage: usage(1), disposed: false, sessionId: 'test-sid-no-window',
      fetchUsage: async () => ({ rate_limits: { five_hour: { utilization: 150 }, seven_day: { utilization: -5 } } })
    };
    await buildWebStatusLine({ agent, cwd: undefined, usageStore: createUsageSnapshotStore() });
    const entries = getDiagLogs('test-sid-no-window').filter(e => e.subsystem === 'statusline');
    assert.equal(entries.length, 1);
    assert.equal(entries[0].detail.reason, 'no_valid_window');
  });

  test('同一 agent 连续两次同失败态 → 只记一条（去重）', async () => {
    const agent = {
      activeModel: 'm', lastUsage: usage(1), disposed: false, sessionId: 'test-sid-dedup',
      fetchUsage: async () => ({ rate_limits_available: false })
    };
    const store = createUsageSnapshotStore();
    await buildWebStatusLine({ agent, cwd: undefined, usageStore: store });
    await buildWebStatusLine({ agent, cwd: undefined, usageStore: store });
    const entries = getDiagLogs('test-sid-dedup').filter(e => e.subsystem === 'statusline');
    assert.equal(entries.length, 1);
  });

  test('原因切换（third_party_auth → no_valid_window）→ 记两条', async () => {
    const agent = {
      activeModel: 'm', lastUsage: usage(1), disposed: false, sessionId: 'test-sid-switch',
      fetchUsage: async () => ({ rate_limits_available: false })
    };
    const store = createUsageSnapshotStore();
    await buildWebStatusLine({ agent, cwd: undefined, usageStore: store });
    agent.fetchUsage = async () => ({ rate_limits: { five_hour: { utilization: 999 } } });
    await buildWebStatusLine({ agent, cwd: undefined, usageStore: store });
    const entries = getDiagLogs('test-sid-switch').filter(e => e.subsystem === 'statusline');
    assert.equal(entries.length, 2);
    assert.equal(entries[0].detail.reason, 'third_party_auth');
    assert.equal(entries[1].detail.reason, 'no_valid_window');
    assert.equal(entries[1].detail.previousReason, 'third_party_auth');
  });

  test('失败恢复到有效数据 → 记一条恢复（reason:null），再次调用同样健康数据不重复记', async () => {
    const agent = {
      activeModel: 'm', lastUsage: usage(1), disposed: false, sessionId: 'test-sid-recover',
      fetchUsage: async () => ({ rate_limits_available: false })
    };
    const store = createUsageSnapshotStore();
    await buildWebStatusLine({ agent, cwd: undefined, usageStore: store });
    agent.fetchUsage = async () => ({ rate_limits_available: true, rate_limits: { five_hour: { utilization: 20 } } });
    await buildWebStatusLine({ agent, cwd: undefined, usageStore: store });
    const entries = getDiagLogs('test-sid-recover').filter(e => e.subsystem === 'statusline');
    assert.equal(entries.length, 2);
    assert.equal(entries[1].detail.reason, null);
    assert.equal(entries[1].detail.previousReason, 'third_party_auth');

    await buildWebStatusLine({ agent, cwd: undefined, usageStore: store }); // 仍健康：不应再新增
    const entries2 = getDiagLogs('test-sid-recover').filter(e => e.subsystem === 'statusline');
    assert.equal(entries2.length, 2);
  });
});

// 判定谓词是「用户在状态栏上到底有没有看见 5h/7d」（含快照垫底），不是「这一拍 RPC 成不成功」。
// 失败侧原本判定在 agent.fetchUsage 内部，那一层看不到下游的快照回落结果，于是单拍超时即翻转
// 成 rpc_error、下一拍成功再翻回 null——一次瞬时抖动被放大成两条醒目日志，而那一刻状态栏上的
// 额度其实一直在（只是标了「非实时」）。判定统一收敛到本层、且必须落在回落点之后。
// fetchUsage 现在只留结构化事实（agent.lastUsageFetchFailure），自己不写任何 diag。
test.describe('buildWebStatusLine：额度不可用判定以「UI 上有没有数」为准', () => {
  // 真实 fetchUsage 失败时的行为：自报结构化原因 + 返回 null（SDK RPC 是外部边界，可以 mock）
  const failing = (message = 'usage timeout', extra = {}) => async function () {
    this.lastUsageFetchFailure = { reason: 'rpc_error', message, timedOut: message === 'usage timeout', ...extra };
    return null;
  };
  const ok = utilization => async function () {
    this.lastUsageFetchFailure = null;
    return { rate_limits: { five_hour: { utilization } } };
  };

  test('单拍超时但快照垫住 → 一条都不记（截图里那 4 对乒乓归零）', async () => {
    const sid = 'test-sid-flap-suppressed';
    const store = createUsageSnapshotStore();
    const agent = {
      activeModel: 'm', lastUsage: usage(1), disposed: false, sessionId: sid,
      lastRateUnavailableReason: null, lastUsageFetchFailure: null, fetchUsage: ok(40),
    };
    const first = await buildWebStatusLine({ agent, cwd: undefined, usageStore: store });
    assert.equal(first.rate.fiveHour.usedPercent, 40); // 前置：本拍成功，快照已温热

    agent.fetchUsage = failing();
    const second = await buildWebStatusLine({ agent, cwd: undefined, usageStore: store });
    assert.equal(second.rate.fiveHour.usedPercent, 40); // 状态栏上额度并没消失……
    assert.equal(second.rateFromSnapshot, true);        // ……只是标了「非实时」

    agent.fetchUsage = ok(41);
    await buildWebStatusLine({ agent, cwd: undefined, usageStore: store });

    assert.equal(getDiagLogs(sid).filter(e => e.subsystem === 'statusline').length, 0);
  });

  test('超时且无温热快照（额度真消失）→ 从本层记一条 rpc_error', async () => {
    const sid = 'test-sid-cold-timeout';
    const agent = {
      activeModel: 'm', lastUsage: usage(1), disposed: false, sessionId: sid,
      lastRateUnavailableReason: null, lastUsageFetchFailure: null, fetchUsage: failing('usage timeout', { ms: 1502 }),
    };
    const p = await buildWebStatusLine({ agent, cwd: undefined, usageStore: createUsageSnapshotStore() });
    assert.equal(p.rate, undefined); // 前置：UI 上确实没有额度了

    const entries = getDiagLogs(sid).filter(e => e.subsystem === 'statusline');
    assert.equal(entries.length, 1);
    assert.equal(entries[0].detail.reason, 'rpc_error');
    assert.equal(entries[0].detail.timedOut, true);
    assert.equal(entries[0].detail.ms, 1502); // 耗时透出，供判断「1500ms 是不是太紧」
  });

  test('快照过 TTL 后仍失败 → 恰在额度真消失那一刻记一条', async () => {
    const sid = 'test-sid-snapshot-expired';
    const store = createUsageSnapshotStore();
    store.rate = { fiveHour: { usedPercent: 90 } };
    store.at = Date.now() - USAGE_SNAPSHOT_TTL_MS - 1_000; // 手工构造陈旧快照
    const agent = {
      activeModel: 'm', lastUsage: usage(1), disposed: false, sessionId: sid,
      lastRateUnavailableReason: null, lastUsageFetchFailure: null, fetchUsage: failing(),
    };
    const p = await buildWebStatusLine({ agent, cwd: undefined, usageStore: store });
    assert.equal(p.rate, undefined);
    assert.equal(getDiagLogs(sid).filter(e => e.subsystem === 'statusline').length, 1);
  });

  // 去重只看 reason 字符串相等，与它来自 usage 对象还是 failure 无关。这两条把该通用性钉死：
  // 判定收敛前，「连续失败去重」「失败原因之间切换」是 agent 层测的，随契约反转一并移交本层。
  test('连续两次 usage==null 失败 → 只记一条（去重不因原因来自哪个分支而异）', async () => {
    const sid = 'test-sid-consecutive-null-failures';
    const store = createUsageSnapshotStore();
    const agent = {
      activeModel: 'm', lastUsage: usage(1), disposed: false, sessionId: sid,
      lastRateUnavailableReason: null, lastUsageFetchFailure: null, fetchUsage: failing(),
    };
    await buildWebStatusLine({ agent, cwd: undefined, usageStore: store });
    await buildWebStatusLine({ agent, cwd: undefined, usageStore: store });
    assert.equal(getDiagLogs(sid).filter(e => e.subsystem === 'statusline').length, 1);
  });

  test('失败原因之间切换（rpc_no_method → rpc_error）→ 记两条', async () => {
    const sid = 'test-sid-failure-reason-switch';
    const store = createUsageSnapshotStore();
    const agent = {
      activeModel: 'm', lastUsage: usage(1), disposed: false, sessionId: sid,
      lastRateUnavailableReason: null, lastUsageFetchFailure: null,
      fetchUsage: async function () { this.lastUsageFetchFailure = { reason: 'rpc_no_method' }; return null; },
    };
    await buildWebStatusLine({ agent, cwd: undefined, usageStore: store });
    agent.fetchUsage = failing();
    await buildWebStatusLine({ agent, cwd: undefined, usageStore: store });

    const entries = getDiagLogs(sid).filter(e => e.subsystem === 'statusline');
    assert.equal(entries.length, 2);
    assert.equal(entries[0].detail.reason, 'rpc_no_method');
    assert.equal(entries[1].detail.reason, 'rpc_error');
    assert.equal(entries[1].detail.previousReason, 'rpc_no_method');
  });

  test('冷启动失败后恢复 → 记「不可用」+「已恢复」各一条（首次断档属实，不抑制）', async () => {
    const sid = 'test-sid-cold-then-recover';
    const store = createUsageSnapshotStore();
    const agent = {
      activeModel: 'm', lastUsage: usage(1), disposed: false, sessionId: sid,
      lastRateUnavailableReason: null, lastUsageFetchFailure: null, fetchUsage: failing(),
    };
    await buildWebStatusLine({ agent, cwd: undefined, usageStore: store });
    agent.fetchUsage = ok(20);
    await buildWebStatusLine({ agent, cwd: undefined, usageStore: store });

    const entries = getDiagLogs(sid).filter(e => e.subsystem === 'statusline');
    assert.equal(entries.length, 2);
    assert.equal(entries[0].detail.reason, 'rpc_error');
    assert.equal(entries[1].detail.reason, null);
    assert.equal(entries[1].detail.previousReason, 'rpc_error');
  });
});

test.describe('buildWebStatusLine：session 元数据（sid）', () => {
  test('agent.sessionId → p.session={id}（transcript 与 sid 冗余，不含）', async () => {
    const id = '784e20b1-a550-45d1-874b-13b5f55eeb46';
    const p = await buildWebStatusLine({ agent: { sessionId: id, activeModel: 'm', lastUsage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }, cwd: undefined });
    assert.deepEqual(p.session, { id });
  });
  test('无 sessionId → 无 p.session（省字段）', async () => {
    const p = await buildWebStatusLine({ agent: { activeModel: 'm', lastUsage: usage(1) }, cwd: undefined });
    assert.equal(p.session, undefined);
  });
});

test.describe('parsePorcelain：解析 git status --porcelain → 三分 staged/modified/untracked', () => {
  test('混合多行：staged/modified/untracked 各自计数、不互斥', () => {
    const s = 'M  a.js\n M b.js\n?? c.js\nA  d.js\n D e.js';
    assert.deepEqual(parsePorcelain(s), { staged: 2, modified: 2, untracked: 1 }); // M +A = staged2; 空M + 空D = modified2
  });
  test('MM 同时计入 staged 与 modified', () => assert.deepEqual(parsePorcelain('MM x.js'), { staged: 1, modified: 1, untracked: 0 }));
  test('仅暂存（X∈MADRC，Y=空）', () => {
    assert.deepEqual(parsePorcelain('A  a'), { staged: 1, modified: 0, untracked: 0 });
    assert.deepEqual(parsePorcelain('D  a'), { staged: 1, modified: 0, untracked: 0 });
  });
  test('仅工作区改动（Y∈MDT，X=空）', () => {
    assert.deepEqual(parsePorcelain(' M a'), { staged: 0, modified: 1, untracked: 0 });
    assert.deepEqual(parsePorcelain(' D a'), { staged: 0, modified: 1, untracked: 0 });
  });
  test('未跟踪 ??（不双计进 staged/modified）', () => assert.deepEqual(parsePorcelain('?? a'), { staged: 0, modified: 0, untracked: 1 }));
  test('空 / null → 全 0', () => {
    assert.deepEqual(parsePorcelain(''), { staged: 0, modified: 0, untracked: 0 });
    assert.deepEqual(parsePorcelain(null), { staged: 0, modified: 0, untracked: 0 });
  });
});

test.describe('parseRepo：从 remote url 解析 owner/repo', () => {
  test('https + .git', () => assert.equal(parseRepo('https://github.com/Ike-li/claude-chat-mobile.git'), 'Ike-li/claude-chat-mobile'));
  test('git@ scp 形式 + .git', () => assert.equal(parseRepo('git@github.com:Ike-li/claude-chat-mobile.git'), 'Ike-li/claude-chat-mobile'));
  test('https 无 .git 后缀', () => assert.equal(parseRepo('https://github.com/Ike-li/claude-chat-mobile'), 'Ike-li/claude-chat-mobile'));
  test('尾随斜杠', () => assert.equal(parseRepo('https://github.com/owner/repo/'), 'owner/repo'));
});

// ---- per-turn 秒表/token 透出（CLI 式动态状态行数据源）----
test.describe('buildWebStatusLine：turn 段（per-turn 秒表/输出 token）', () => {
  test('agent 在途轮（turnStartedAt 置位）→ p.turn = {startedAt, outTokens}', async () => {
    const p = await buildWebStatusLine({
      agent: { activeModel: 'm', lastUsage: null, turnStartedAt: 1234567890, turnOutputTokens: 3300 },
      cwd: undefined,
    });
    assert.deepEqual(p.turn, { startedAt: 1234567890, outTokens: 3300 });
  });

  test('无在途轮（turnStartedAt null/缺省）→ 不放 turn 段', async () => {
    const idle = await buildWebStatusLine({ agent: { activeModel: 'm', lastUsage: null, turnStartedAt: null, turnOutputTokens: 0 }, cwd: undefined });
    assert.equal(idle.turn, undefined);
    const legacy = await buildWebStatusLine({ agent: { activeModel: 'm', lastUsage: null }, cwd: undefined });
    assert.equal(legacy.turn, undefined);
  });
});

// projectNameFromCwd：状态栏 project 字段的 basename 提取。原 `cwd.split('/').pop()` 手写实现
// 在 server 跑在 Windows 上时，cwd 是 `C:\...`（无 `/`），split 会拿到整条路径而非文件夹名——
// 改用 path.win32/path.posix 的 basename，platform 可注入避免依赖宿主 OS。
test.describe('projectNameFromCwd', () => {
  test('POSIX 路径 → 取末段目录名', () => {
    assert.equal(projectNameFromCwd('/Users/x/projects/ccm', { platform: 'linux' }), 'ccm');
  });
  test('POSIX 路径带尾斜杠 → 同样正确取末段', () => {
    assert.equal(projectNameFromCwd('/Users/x/projects/ccm/', { platform: 'linux' }), 'ccm');
  });
  test('Windows 路径 → 取末段目录名（原实现会退化成整条路径）', () => {
    assert.equal(projectNameFromCwd('C:\\Users\\x\\projects\\ccm', { platform: 'win32' }), 'ccm');
  });
  test('根路径 → basename 为空串时回退整个 cwd', () => {
    assert.equal(projectNameFromCwd('/', { platform: 'linux' }), '/');
  });
  test('空/undefined cwd → 原样返回', () => {
    assert.equal(projectNameFromCwd('', { platform: 'linux' }), '');
    assert.equal(projectNameFromCwd(undefined, { platform: 'linux' }), undefined);
  });
});


test.describe('buildWebStatusLine：fetchUsage null 断档可回落（F1）', () => {
  test('fetchUsage 返回 null → 允许账号级快照垫上', async () => {
    const store = createUsageSnapshotStore();
    await buildWebStatusLine({
      agent: {
        activeModel: 'm', lastUsage: usage(1), disposed: false,
        fetchUsage: async () => ({
          rate_limits_available: true,
          rate_limits: { five_hour: { utilization: 40 } },
        }),
      },
      cwd: undefined, usageStore: store,
    });
    const p = await buildWebStatusLine({
      agent: {
        activeModel: 'm', lastUsage: usage(1), disposed: false,
        fetchUsage: async () => null,
      },
      cwd: undefined, usageStore: store,
    });
    assert.equal(p.rate?.fiveHour?.usedPercent, 40);
    assert.equal(p.rateFromSnapshot, true);
  });
});

test.describe('noteStatusRefreshBusy：忙时排队、结束后补跑', () => {
  test('enter 空闲 → proceed；enter 忙 → queued 不 proceed', () => {
    let s = noteStatusRefreshBusy({}, 'enter');
    assert.equal(s.proceed, true);
    assert.equal(s.busy, true);
    assert.equal(s.queued, false);
    s = noteStatusRefreshBusy(s, 'enter');
    assert.equal(s.proceed, false);
    assert.equal(s.busy, true);
    assert.equal(s.queued, true);
  });
  test('leave 有 queued → reschedule；leave 无 queued → 不 reschedule', () => {
    let s = noteStatusRefreshBusy({ busy: true, queued: true }, 'leave');
    assert.equal(s.busy, false);
    assert.equal(s.queued, false);
    assert.equal(s.reschedule, true);
    s = noteStatusRefreshBusy({ busy: true, queued: false }, 'leave');
    assert.equal(s.reschedule, false);
  });
});

test.describe('buildWebStatusLine：无 lastUsage 仍可用 getContextUsage 出 ctx%', () => {
  test('lastUsage 缺省 + 活 q → 只有 window/percent/totalTokens，无 in/out 明细', async () => {
    const q = { getContextUsage: async () => ({ maxTokens: 1_000_000, percentage: 13, totalTokens: 130_000, categories: [] }) };
    const p = await buildWebStatusLine({ agent: { activeModel: 'grok-4.5[1m]', q, disposed: false }, cwd: undefined });
    assert.equal(p.ctx.windowSize, 1_000_000);
    assert.equal(p.ctx.usedPercent, 13);
    assert.equal(p.ctx.totalTokens, 130_000);
    assert.equal(p.ctx.tokens, undefined);
    assert.equal(p.ctx.in, undefined);
  });
});
