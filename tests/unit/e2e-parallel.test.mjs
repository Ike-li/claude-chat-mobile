// tests/unit/e2e-parallel.test.mjs —— e2e-parallel.js --merge-durations 的地板提醒
// 同一个 spec 不跨分片：最大那个文件比「总时长 ÷ 分片数」还长时，它自己就决定了 e2e 的墙钟，
// 再加分片也省不了。合并步骤此时要在 CI 上出一条点名它的 ::warning——只提醒、不红。
// 不测什么：并集校验（漏跑必须红）是 TEST-02，在 tests/invariants/e2e-shard-coverage.test.mjs。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');
const SCRIPT = join(ROOT, 'tests', 'infra', 'e2e-parallel.js');

// 全量清单从磁盘现扫：被测脚本先做并集校验，片段少一个 spec 就红在那一步，走不到地板判断。
function allSpecs() {
  return readdirSync(join(ROOT, 'tests', 'e2e', 'specs'), { recursive: true })
    .map(e => String(e).replaceAll('\\', '/'))
    .filter(f => f.endsWith('.spec.ts'))
    .map(f => `tests/e2e/specs/${f}`)
    .sort();
}

// 每个 spec 默认 1.5s，overrides 改其中几个；摊成 shardCount 份片段，模拟各分片交回的 artifact。
function writeShards(overrides = {}, shardCount = 3) {
  const dir = mkdtempSync(join(tmpdir(), 'ccm-e2e-floor-'));
  const bins = Array.from({ length: shardCount }, () => ({}));
  allSpecs().forEach((s, i) => { bins[i % shardCount][s] = overrides[s] ?? 1.5; });
  bins.forEach((bin, i) => writeFileSync(join(dir, `shard${i + 1}.json`), JSON.stringify(bin)));
  return dir;
}

function runMerge(dir, env = {}) {
  return spawnSync(process.execPath, [SCRIPT, '--merge-durations', dir], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: '', ...env },
  });
}

test('最大的 spec 超过「总时长 ÷ 片数」→ 打出点名它的 ::warning，但不红', () => {
  const big = allSpecs()[0];
  const out = runMerge(writeShards({ [big]: 1000 }));

  assert.equal(out.status, 0, `地板只是提醒，不得让 e2e 变红。stderr: ${out.stderr}`);
  const warning = out.stdout.split('\n').find(l => l.startsWith('::warning'));
  assert.ok(warning, `成了地板却没有 ::warning——CI 上不会有任何人看见。stdout: ${out.stdout}`);
  assert.ok(warning.includes(big), `warning 必须点名是哪个文件，否则不知道该拆谁：${warning}`);
});

// 反向对照：warning 只有很少出现才有人看。恒报的实现能过上一条，过不了这一条。
test('最大的 spec 没超过「总时长 ÷ 片数」→ 不打 warning', () => {
  const big = allSpecs()[0];
  const out = runMerge(writeShards({ [big]: 10 }));

  assert.equal(out.status, 0, `stderr: ${out.stderr}`);
  assert.doesNotMatch(out.stdout, /^::warning/m, '没成地板也报警，提醒就成了噪音，真成地板时没人再看');
});

test('设了 GITHUB_STEP_SUMMARY → run 摘要页写上总时长、平均每片与最大的文件', () => {
  const specs = allSpecs();
  const big = specs[0];
  const summary = join(mkdtempSync(join(tmpdir(), 'ccm-e2e-floor-summary-')), 'summary.md');
  const out = runMerge(writeShards({ [big]: 10 }), { GITHUB_STEP_SUMMARY: summary });

  assert.equal(out.status, 0, `stderr: ${out.stderr}`);
  const text = readFileSync(summary, 'utf8');
  const total = (specs.length - 1) * 1.5 + 10;
  assert.ok(text.includes(`${total.toFixed(0)}s`), `摘要缺总时长 ${total}s：\n${text}`);
  assert.ok(text.includes(`${(total / 3).toFixed(0)}s`), `摘要缺平均每片 ${total / 3}s：\n${text}`);
  assert.ok(text.includes(big), `摘要缺最大的文件 ${big}——快到地板时要能一眼看出是谁：\n${text}`);
});
