// test/statusline.test.mjs —— statusline.js 纯函数单测（零 token）
// statusLine 为 web 自有状态栏：自包含组装、不调脚本/快照。ctx 绝对 token 来自 SDK 真值；
// ctx 百分比由 buildWebStatusLine 用 contextWindowSize(model) 事后推算（认不出的 model 退回只显绝对数）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { webContextCost, buildWebStatusLine, gitStatus, parseShortstat, parseRepo, parsePorcelain, contextWindowSize } from '../statusline.js';

const usage = t => ({ input_tokens: t, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });

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

  test('保留原始 usage 三件套（cache 命中率段用）', () => {
    const r = webContextCost({ agent: { lastUsage: { input_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 30 } } });
    assert.deepEqual(r.context.usage, { input_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 30 });
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

  test('reused：累计 cache_read（agent.totalCacheReadTokens）透传进 context——会话级累计，区别于 lastUsage 的单轮口径', () => {
    const r = webContextCost({ agent: { lastUsage: usage(1000), totalCacheReadTokens: 1_200_000 } });
    assert.equal(r.context.reused, 1_200_000);
  });

  test('reused：无累计字段 → 0（不漏 undefined）', () => {
    const r = webContextCost({ agent: { lastUsage: usage(1000) } });
    assert.equal(r.context.reused, 0);
  });
});

test.describe('buildWebStatusLine：web 自包含结构化状态（不调脚本/快照）', () => {
  test('组装 model/ctx/cost/duration + cache 命中率；无 cwd 时无 git 段', async () => {
    const p = await buildWebStatusLine({
      agent: {
        activeModel: 'claude-opus-4-8[1m]',
        lastUsage: { input_tokens: 200_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 200_000 },
        totalCostUsd: 1.23, totalDurationMs: 60_000, totalApiDurationMs: 30_000
      },
      cwd: undefined
    });
    assert.equal(p.model, 'claude-opus-4-8[1m]'); // 含网关后缀
    assert.equal(p.ctx.tokens, 400_000);
    assert.equal(p.ctx.cacheHitPct, 50);          // 200k read / 400k total
    assert.equal(p.ctx.in, 200_000);              // token 明细 in/w/r（cli 口径 input/cache写/cache读）
    assert.equal(p.ctx.w, 0);
    assert.equal(p.ctx.r, 200_000);
    assert.equal(p.cost, 1.23);
    assert.deepEqual(p.duration, { wallMs: 60_000, apiMs: 30_000 });
    assert.equal(p.git, undefined);               // 无 cwd → 无 git 段
    assert.equal(p.project, undefined);
    assert.equal(typeof p.ts, 'number');
  });

  test('reused>0 → p.ctx.reused（会话累计复用 token，区别于瞬时 cacheHitPct）', async () => {
    const p = await buildWebStatusLine({ agent: { activeModel: 'm', lastUsage: usage(1000), totalCacheReadTokens: 1_200_000 }, cwd: undefined });
    assert.equal(p.ctx.reused, 1_200_000);
    assert.equal(p.ctx.cacheHitPct, 0);  // 瞬时与累计互不影响：本轮 read=0 → 命中率 0，但累计 reused 仍 1.2M
  });

  test('reused=0 → 不放 p.ctx.reused（省字段，前端不渲染该段）', async () => {
    const p = await buildWebStatusLine({ agent: { activeModel: 'm', lastUsage: usage(1000) }, cwd: undefined });
    assert.equal(p.ctx.reused, undefined);
  });

  test('cacheExpiresAt：推算 deadline = lastCacheHitAt + 300_000（5min ephemeral TTL 约定值，非 SDK 回报）', async () => {
    const hitAt = 1_700_000_000_000;
    const p = await buildWebStatusLine({ agent: { activeModel: 'm', lastUsage: usage(1000), lastCacheHitAt: hitAt }, cwd: undefined });
    assert.equal(p.ctx.cacheExpiresAt, hitAt + 300_000);
  });

  test('cacheExpiresAt：从未命中（lastCacheHitAt=0/缺省）→ 无字段（前端不显倒计时）', async () => {
    const none = await buildWebStatusLine({ agent: { activeModel: 'm', lastUsage: usage(1000), lastCacheHitAt: 0 }, cwd: undefined });
    assert.equal(none.ctx.cacheExpiresAt, undefined);
    const missing = await buildWebStatusLine({ agent: { activeModel: 'm', lastUsage: usage(1000) }, cwd: undefined });
    assert.equal(missing.ctx.cacheExpiresAt, undefined);
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
  const usageT = t => ({ input_tokens: t, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });

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

test.describe('buildWebStatusLine：session 元数据（sid）', () => {
  test('agent.sessionId → p.session={id}（transcript 与 sid 冗余，不含）', async () => {
    const id = '784e20b1-a550-45d1-874b-13b5f55eeb46';
    const p = await buildWebStatusLine({ agent: { sessionId: id, activeModel: 'm', lastUsage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }, cwd: undefined });
    assert.deepEqual(p.session, { id });
  });

  test('无 sessionId → 无 p.session（省字段）', async () => {
    const p = await buildWebStatusLine({ agent: { activeModel: 'm', lastUsage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }, cwd: undefined });
    assert.equal(p.session, undefined);
  });
});

test.describe('parseShortstat：解析 git diff --shortstat 增删行数', () => {
  test('增删都有', () => assert.deepEqual(parseShortstat(' 3 files changed, 12 insertions(+), 4 deletions(-)'), { insertions: 12, deletions: 4 }));
  test('仅删除', () => assert.deepEqual(parseShortstat(' 1 file changed, 12 deletions(-)'), { insertions: 0, deletions: 12 }));
  test('仅新增', () => assert.deepEqual(parseShortstat(' 1 file changed, 5 insertions(+)'), { insertions: 5, deletions: 0 }));
  test('单数形式 insertion/deletion', () => assert.deepEqual(parseShortstat(' 1 file changed, 1 insertion(+), 1 deletion(-)'), { insertions: 1, deletions: 1 }));
  test('空 / null → 0,0', () => {
    assert.deepEqual(parseShortstat(''), { insertions: 0, deletions: 0 });
    assert.deepEqual(parseShortstat(null), { insertions: 0, deletions: 0 });
  });
});

test.describe('parsePorcelain：解析 git status --porcelain → 三分 staged/modified/untracked', () => {
  // XY PATH：X=index(暂存)位、Y=worktree(工作区)位。staged=X∈MADRC · modified=Y∈MDT · untracked=??。
  // 三类独立不互斥：MM（既暂存又改）同时计入 staged 与 modified（对齐 CLI statusline 语义）。
  test('混合多行：staged/modified/untracked 各自计数、不互斥', () => {
    const status = ['M  a.js', ' M b.js', 'MM c.js', 'A  d.js', '?? e.js', ' D f.js'].join('\n');
    assert.deepEqual(parsePorcelain(status), { staged: 3, modified: 3, untracked: 1 }); // staged:a,c,d · modified:b,c,f · untracked:e
  });
  test('MM 同时计入 staged 与 modified', () => assert.deepEqual(parsePorcelain('MM x.js'), { staged: 1, modified: 1, untracked: 0 }));
  test('仅暂存（X∈MADRC，Y=空）', () => {
    assert.deepEqual(parsePorcelain('M  a'), { staged: 1, modified: 0, untracked: 0 });
    assert.deepEqual(parsePorcelain('A  a'), { staged: 1, modified: 0, untracked: 0 });
    assert.deepEqual(parsePorcelain('R  a'), { staged: 1, modified: 0, untracked: 0 });
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
  test('自建 host 取末两段', () => assert.equal(parseRepo('https://git.example.com/grp/sub.git'), 'grp/sub'));
  test('空 / null → null', () => {
    assert.equal(parseRepo(''), null);
    assert.equal(parseRepo(null), null);
  });
});
