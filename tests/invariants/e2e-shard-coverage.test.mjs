// tests/invariants/e2e-shard-coverage.test.mjs —— E2E 跨 runner 分片的覆盖完整性闸
// 守护：TEST-02（分片跑过的 spec 并集必须等于磁盘上的全量清单——漏跑不得表现为全绿）
// 测什么：`e2e-parallel.js --merge-durations <dir>` 对各分片交回的时长片段做并集校验：
//   齐了才 exit 0 并写出合并结果；少一个 spec 就 exit 1 且点名是谁；一个片段都没有也必须红。
// 不测什么 + 为什么：
//   ① 分片跑得对不对（Playwright 真跑）——属 S3，这里只管「有没有跑到」这一维；
//   ② LPT 分配得均不均——那是性能不是红线，分配再差也不会漏跑，不值一条不变量；
//   ③ GitHub Actions 的 artifact 上传/下载本身——是平台行为，测它等于测 GitHub。
// 槽位：S1（纯函数 + 一次性目录真磁盘）
//
// 【为什么这条要机械闸，不能只靠注释】e2e 是 required check。分片编排一旦漏跑某个 spec，
// CI 的表现是**全绿**——没有报错、没有 warning，跟真跑过一模一样。e2e-parallel.js 文件头
// 已有两条 ★ 注释在防同型失效（清单必须扫描得来、recursive 不能省），但注释拦不住
// 「各分片自己算分组、算出了不一致的分组」这条新路径：横向分片后每个 runner 独立读
// 时长缓存，任何一个 job 的 cache 未命中，它就会算出另一套分组，于是有 spec 谁都没跑。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');
const SCRIPT = join(ROOT, 'tests', 'infra', 'e2e-parallel.js');

// 全量清单从磁盘现扫，与被测脚本同源。写死清单会在新增 spec 时让这条测试自己失效——
// 那正是它要防的形态。
function allSpecs() {
  return readdirSync(join(ROOT, 'tests', 'e2e', 'specs'), { recursive: true })
    .map(e => String(e).replaceAll('\\', '/'))
    .filter(f => f.endsWith('.spec.ts'))
    .map(f => `tests/e2e/specs/${f}`)
    .sort();
}

// 把一份 spec 清单摊成 shardCount 个片段文件，模拟各分片 job 交回的 artifact。
function writeShards(dir, specs, shardCount = 3) {
  const bins = Array.from({ length: shardCount }, () => ({}));
  specs.forEach((s, i) => { bins[i % shardCount][s] = 1.5; });
  bins.forEach((bin, i) => {
    writeFileSync(join(dir, `shard${i + 1}.json`), JSON.stringify(bin));
  });
}

function runMerge(dir) {
  return spawnSync(process.execPath, [SCRIPT, '--merge-durations', dir], {
    cwd: ROOT, encoding: 'utf8',
  });
}

test('并集覆盖全部 spec → 通过，并写出合并后的时长表', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccm-shard-merge-'));
  const specs = allSpecs();
  writeShards(dir, specs);

  const out = runMerge(dir);
  assert.equal(out.status, 0, `并集齐全时不该红。stderr: ${out.stderr}`);

  const merged = JSON.parse(readFileSync(join(dir, 'merged.json'), 'utf8'));
  assert.deepEqual(Object.keys(merged).sort(), specs,
    '合并结果必须恰好是全量 spec——多了会让下轮分配算不存在的文件，少了等于漏跑没被发现');
});

// 正对照：先证明这台仪器真的看得见漏跑。没有这一条，「并集齐全」与「校验没生效」
// 在结果上完全一样（docs/testing.md §3）。
test('少一个 spec → 红，且点名缺的是谁', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccm-shard-merge-'));
  const specs = allSpecs();
  const dropped = specs[Math.floor(specs.length / 2)];
  writeShards(dir, specs.filter(s => s !== dropped));

  const out = runMerge(dir);
  assert.equal(out.status, 1, '漏跑必须红——这正是它表现为全绿的那个形态');
  assert.match(out.stderr, new RegExp(dropped.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    '失败消息必须点名漏掉的 spec，否则红了也不知道从哪查');
});

test('一个片段都没有 → 红，不得当成通过', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccm-shard-merge-'));

  const out = runMerge(dir);
  assert.equal(out.status, 1,
    'artifact 全部下载失败时目录是空的——把「什么都没量到」当成通过，等于整轮 e2e 静默失守');
});

// download-artifact 一个 artifact 都没捞到时【压根不建目录】，所以「目录不存在」是真实路径，
// 不是防御性分支——2026-09-13 首次上线就走了这条（run 34743727175，片段全被当隐藏文件漏掉）。
// 当时裸 readdirSync 抛的 ENOENT 栈指向 fs.readdir，不指向真正的原因，排查从错误的一端开始。
test('目录根本不存在 → 红，且说人话而不是抛 ENOENT 栈', () => {
  const out = runMerge(join(tmpdir(), 'ccm-shard-merge-does-not-exist-9d3f'));

  assert.equal(out.status, 1, '目录不存在与目录为空是同一件事：一个片段都没收到');
  assert.doesNotMatch(out.stderr, /ENOENT|readdirSync|at Module/,
    '不能把 fs 的栈甩给读日志的人——错误要指向「片段没上传」，那才是要去看的地方');
  assert.match(out.stderr, /片段/,
    '失败消息必须说清缺的是什么，否则红了也不知道从哪查');
});
