// test/statusline.test.mjs —— statusline.js 纯函数单测（零 token）
// statusLine 为 web 自有状态栏：自包含组装、不调脚本/快照。ctx 口径：只回 SDK 真实
// token 绝对数，不算窗口/百分比（SDK/jsonl/快照都不暴露 web 会话真实 context window，从 model 名猜会误判）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { webContextCost, buildWebStatusLine, gitStatus, parseShortstat, parseRepo } from '../statusline.js';

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
