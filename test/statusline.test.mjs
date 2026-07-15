// test/statusline.test.mjs —— statusline.js 纯函数单测（零 token）
// statusLine 为 web 自有状态栏：自包含组装、不调脚本/快照。显示面目标对齐 CLI statusline。
// ctx 绝对 token 来自 SDK 真值；ctx 百分比优先 getContextUsage、降级 contextWindowSize(model)。
import test from 'node:test';
import assert from 'node:assert/strict';
import { webContextCost, buildWebStatusLine, gitStatus, parseRepo, parsePorcelain, contextWindowSize, getContextUsageSafe, usageBitsForStatusLine } from '../statusline.js';

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

test.describe('contextWindowSize：model→上下文窗口大小映射', () => {
  test('[1m] 后缀 → 1M', () => assert.equal(contextWindowSize('claude-opus-4-8[1m]'), 1_000_000));
  test('"1M context" 文案 → 1M', () => assert.equal(contextWindowSize('Opus 4.8 (1M context)'), 1_000_000));
  test('裸 Claude 模型 → 200k', () => assert.equal(contextWindowSize('claude-opus-4-8'), 200_000));
  test('sonnet / haiku → 200k', () => {
    assert.equal(contextWindowSize('claude-sonnet-5'), 200_000);
    assert.equal(contextWindowSize('claude-haiku-4-5-20251001'), 200_000);
  });
  test('认不出的 model → null（前端退回绝对数）', () => {
    assert.equal(contextWindowSize('gpt-4o'), null);
    assert.equal(contextWindowSize(''), null);
    assert.equal(contextWindowSize(null), null);
  });
});

test.describe('buildWebStatusLine：ctx% 由 model→窗口映射推算', () => {
  const usageT = t => ({ input_tokens: t, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });

  test('[1m] 模型 + tokens=400k → usedPercent=40 · windowSize=1M', async () => {
    const p = await buildWebStatusLine({ agent: { activeModel: 'claude-opus-4-8[1m]', lastUsage: usageT(400_000) }, cwd: undefined });
    assert.equal(p.ctx.windowSize, 1_000_000);
    assert.equal(p.ctx.usedPercent, 40);
  });

  test('裸模型 + tokens=100k → usedPercent=50（100k/200k）', async () => {
    const p = await buildWebStatusLine({ agent: { activeModel: 'claude-opus-4-8', lastUsage: usageT(100_000) }, cwd: undefined });
    assert.equal(p.ctx.windowSize, 200_000);
    assert.equal(p.ctx.usedPercent, 50);
  });

  test('usedPercent 封顶 100（tokens 超窗口）', async () => {
    const p = await buildWebStatusLine({ agent: { activeModel: 'claude-opus-4-8[1m]', lastUsage: usageT(1_200_000) }, cwd: undefined });
    assert.equal(p.ctx.usedPercent, 100);
  });

  test('认不出的 model → 无 usedPercent/windowSize，仍保留绝对 token', async () => {
    const p = await buildWebStatusLine({ agent: { activeModel: 'some-unknown-model', lastUsage: usageT(100_000) }, cwd: undefined });
    assert.equal(p.ctx.usedPercent, undefined);
    assert.equal(p.ctx.windowSize, undefined);
    assert.equal(p.ctx.tokens, 100_000);
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

test.describe('buildWebStatusLine：ctx% 优先 SDK getContextUsage、降级 contextWindowSize（Part2 修 5x bug）', () => {
  const usageC = t => ({ input_tokens: t, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });
  test('活跃会话（q.getContextUsage 返回权威值）→ windowSize/usedPercent 来自 SDK；categories 不透传', async () => {
    // 关键 bug 场景：model 是 haiku（静态映射猜 200k），但 SDK 实报 maxTokens=1M → ctx% 不再偏高 5x
    const cats = [{ name: 'Skills', tokens: 5000, color: '#abc' }, { name: 'Free space', tokens: 995000, color: '#def' }];
    const q = { getContextUsage: async () => ({ maxTokens: 1_000_000, percentage: 23, categories: cats }) };
    const p = await buildWebStatusLine({ agent: { activeModel: 'claude-haiku-4-5', lastUsage: usageC(50_000), q, disposed: false }, cwd: undefined });
    assert.equal(p.ctx.windowSize, 1_000_000);   // SDK 权威，非静态 200k
    assert.equal(p.ctx.usedPercent, 23);         // 官方 percentage，非 tokens/win 自算
    assert.equal(p.ctx.categories, undefined);   // 对齐 CLI statusline：categories 不进 statusline
  });
  test('disposed 会话（q 存在但 disposed）→ 不调 SDK、降级 contextWindowSize', async () => {
    let called = false;
    const q = { getContextUsage: async () => { called = true; return { maxTokens: 1e6, percentage: 5, categories: [] }; } };
    const p = await buildWebStatusLine({ agent: { activeModel: 'claude-haiku-4-5', lastUsage: usageC(50_000), q, disposed: true }, cwd: undefined });
    assert.equal(called, false);                 // disposed → 不调 SDK
    assert.equal(p.ctx.windowSize, 200_000);     // 降级静态映射
    assert.equal(p.ctx.usedPercent, 25);         // 50k/200k
  });
  test('无 q（idle/历史）→ 降级 contextWindowSize', async () => {
    const p = await buildWebStatusLine({ agent: { activeModel: 'claude-opus-4-8[1m]', lastUsage: usageC(400_000) }, cwd: undefined });
    assert.equal(p.ctx.windowSize, 1_000_000);   // 静态映射 [1m]→1M
    assert.equal(p.ctx.usedPercent, 40);
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
});

test.describe('buildWebStatusLine：fetchUsage 接线（5h/7d + lines）', () => {
  test('agent.fetchUsage 返回有效 → p.rate / p.lines', async () => {
    const agent = {
      activeModel: 'm', lastUsage: usage(1000), disposed: false,
      fetchUsage: async () => ({
        rate_limits_available: true,
        rate_limits: { five_hour: { utilization: 70, resets_at: '2026-07-14T18:00:00Z' } },
        session: { total_lines_added: 8, total_lines_removed: 2 }
      })
    };
    const p = await buildWebStatusLine({ agent, cwd: undefined });
    assert.equal(p.rate.fiveHour.usedPercent, 70);
    assert.equal(p.rate.fiveHour.resetsAt, '2026-07-14T18:00:00Z');
    assert.deepEqual(p.lines, { added: 8, removed: 2 });
  });
  test('fetchUsage 抛错 / disposed → 字段省，不崩', async () => {
    const boom = await buildWebStatusLine({
      agent: { activeModel: 'm', lastUsage: usage(1), disposed: false, fetchUsage: async () => { throw new Error('rpc'); } },
      cwd: undefined
    });
    assert.equal(boom.rate, undefined);
    assert.equal(boom.lines, undefined);
    const disposed = await buildWebStatusLine({
      agent: { activeModel: 'm', lastUsage: usage(1), disposed: true, fetchUsage: async () => ({ rate_limits_available: true, rate_limits: { five_hour: { utilization: 1 } } }) },
      cwd: undefined
    });
    assert.equal(disposed.rate, undefined);
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
