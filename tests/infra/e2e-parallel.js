#!/usr/bin/env node
// tests/infra/e2e-parallel.js —— P0 E2E 分片并行编排（按实测时长做负载均衡）。
//
// mock server（tests/e2e/mock/server.js）用模块级全局变量当状态存储，一个进程只能安全服务
// 一条测试流（Playwright workers>1 共打同一进程实测会让状态互相踩踏、server 直接抛未捕获异常
// 崩溃——不是配置保守，是必要限制，playwright.config.ts 里 workers:1 不能动）。
// 真正的并发只能走进程级隔离：本脚本并行拉起 N 个独立子进程，各自跑一组 spec 文件，通过
// CCM_PLAYWRIGHT_PORT 绑定不同端口（各自起独立 mock server）、CCM_PLAYWRIGHT_SHARD_SUFFIX
// 错开报告/产物目录，进程间零共享状态。
//
// 【为什么不用 Playwright 原生 --shard】它按【用例条数】均分，而本仓用例时长从 0.3s 到 16.1s
// 差 50 倍。2026-09-07 实测：原生 4 分片各 1.6/2.0/2.3/2.8 分钟，总时长由最慢那片决定 = 167s，
// 而完美均衡的理论最优只要 122s——45 秒纯粹损失在不均衡上。原生 8 分片更糟：负载塌成
// 33/66/31/46/20/36/34（一片 0 条），总时长 170s，与 4 分片一秒不差。
//
// 【改成按时长 LPT 分配后】同一批 270 条用例实测：
//   4 分片：167s → **140.8s**，全绿。这是缺省档，并发度与改造前一致 = 不引入新的时序压力。
//   8 分片：**88s**，但**会偶发假红**，见下。
//
// 【为什么缺省不是 8】8 分片跑了 3 轮：87.8s 全绿 / 91.8s 红 1 条 / 124.7s 红 1 条。红的两条都在
// task-progress.spec.ts（P0-17k、P0-17i），都是时序敏感用例——并发抬高后 CPU 争抢把它们的
// 断言窗口挤没了。P0-17k 已修（它误用了 600ms 窗口的场景变体，本该用 -hold，见该用例注释）；
// P0-17i 的 test:mirror 时序还没查清。**假红比慢更糟**：它会让人停止相信这套测试。
// 所以缺省停在实测稳定的 4，把 8 留给显式选择：`CCM_E2E_SHARDS=8 npm run test:e2e:parallel`。
// 修完 task-progress 里剩下的时序敏感用例后，这里的上限就可以调到 8。
//
// 【地板是 69.6s，不是 0】同一个 spec 文件不能跨分片，所以「最大文件的时长」是任何分片数都
// 突破不了的下限：workspace-sessions-sidebar 69.6s(39 条)、task-progress 62.4s(14 条)。
// 8 分片实测 88s 比地板高 18s，差在 8 个 Chromium + 8 个 mock server 的启动与 CPU 争抢。
// 再往下只能拆那两个大文件——那是重组测试内容，不是调编排参数。
//
// 用法: npm run test:e2e:parallel        （CCM_E2E_SHARDS=N 显式指定分片数）
//   exit 0 = 全部分片通过, exit 1 = 至少一个分片失败或异常退出。

import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');
const SPEC_DIR = join(ROOT, 'tests', 'e2e', 'specs');
// 时长缓存：跑完自动更新，下次据此分配。gitignore——它是本机测量值，进版本库只会变成一份
// 会漂移的第二真相。缺失/损坏一律退化成等权重，那时分配等价于「按文件数均分」，仍然正确。
const DURATIONS_FILE = join(ROOT, 'tests', 'infra', '.e2e-durations.json');

const requested = Number(process.env.CCM_E2E_SHARDS);
// 上限 4 是【稳定性】选的，不是性能选的：8 分片更快（88s vs 140.8s）但实测会偶发假红，理由见文件头。
// 非法值（0/负数/NaN）回落自适应，不让一个写错的环境变量把分片数塌成 0 → 一条用例都不跑。
const SHARD_COUNT = Number.isInteger(requested) && requested > 0
  ? requested
  : Math.max(2, Math.min(4, Math.floor(availableParallelism() / 2)));

const BASE_PORT = 33341;

// ★ 文件清单【扫描得来】，不是写死的列表。这一条是硬要求：任何形式的 checked-in 清单都会在
// 新增 spec 时静默漏跑，而漏跑表现为「全绿」——与 74fc46e 那次漏传 -c 同型的失效。
function listSpecs() {
  return readdirSync(SPEC_DIR).filter(f => f.endsWith('.spec.ts')).sort()
    .map(f => `tests/e2e/specs/${f}`);
}

function loadDurations() {
  if (!existsSync(DURATIONS_FILE)) return {};
  try {
    const parsed = JSON.parse(readFileSync(DURATIONS_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return {}; }  // 损坏就当没有：等权重分配仍然跑全部用例，只是不够优
}

// LPT（longest processing time first）：按权重降序，每次放进当前最轻的一组。
// 对「一批不可再分的任务分到 N 台机器」这个问题，LPT 是经典近似解，且实现只有几行。
function assign(specs, durations, count) {
  const known = specs.map(s => durations[s]).filter(v => typeof v === 'number' && v > 0);
  // 没有历史数据的文件按中位数计，避免新文件被当成 0 权重全堆进同一组。
  const fallback = known.length ? known.slice().sort((a, b) => a - b)[Math.floor(known.length / 2)] : 1;
  const bins = Array.from({ length: count }, () => []);
  const load = new Array(count).fill(0);
  for (const spec of specs.slice().sort((a, b) => (durations[b] ?? fallback) - (durations[a] ?? fallback))) {
    let lightest = 0;
    for (let i = 1; i < count; i += 1) if (load[i] < load[lightest]) lightest = i;
    bins[lightest].push(spec);
    load[lightest] += durations[spec] ?? fallback;
  }
  return bins.map((files, i) => ({ files, predicted: load[i] }));
}

// 从 list reporter 的输出里刮每条用例的时长，按文件累加。用输出而不是 JSON reporter：
// stdout 本来就要转发给用户看（实时进度），顺手解析零额外成本，也不用多接一个 reporter。
const LINE_RE = /(tests\/e2e\/specs\/[a-z0-9-]+\.spec\.ts):\d+:\d+ › .*? \(([\d.]+)(ms|s)\)/g;
function harvest(text, into) {
  for (const [, file, value, unit] of text.matchAll(LINE_RE)) {
    into[file] = (into[file] ?? 0) + (unit === 'ms' ? Number(value) / 1000 : Number(value));
  }
}

function runShard({ files, index }, collected) {
  return new Promise(resolve => {
    // 走 `npm run test:e2e --` 而不是自己拼 `npx playwright test -c <config>`：config 路径因此
    // 只有 package.json 一处真相，本文件不再持有第二份。74fc46e 把 playwright.config.ts 移进
    // tests/infra/ 时 test:e2e 补了 -c 而本文件漏了，Playwright 静默回落内建默认（workers 变
    // CPU/2、完全不起 webServer），266 条全红且没人知道——与其加闸比对两份路径，不如让第二份不存在。
    const child = spawn('npm', ['run', 'test:e2e', '--', ...files, '--reporter=list'], {
      cwd: ROOT,
      env: {
        ...process.env,
        CCM_PLAYWRIGHT_PORT: String(BASE_PORT + index),
        CCM_PLAYWRIGHT_SHARD_SUFFIX: `-shard${index + 1}`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let buffered = '';
    // tee：原样转发给用户（保住实时进度与失败堆栈），同时留一份用来刮时长。
    child.stdout.on('data', d => { process.stdout.write(d); buffered += d; });
    child.stderr.on('data', d => { process.stderr.write(d); buffered += d; });
    child.on('close', code => { harvest(buffered, collected); resolve({ index, code: code ?? 1 }); });
    child.on('error', err => {
      console.error(`[test-e2e-parallel] shard ${index + 1} 启动失败: ${err.message}`);
      resolve({ index, code: 1 });
    });
  });
}

const specs = listSpecs();
const durations = loadDurations();
const groups = assign(specs, durations, SHARD_COUNT);
const haveHistory = Object.keys(durations).length > 0;

console.log(`[test-e2e-parallel] ${SHARD_COUNT} 个分片 · ${specs.length} 个 spec · `
  + `${haveHistory ? '按上轮实测时长均衡' : '首次运行（无时长数据，等权重分配；跑完即生成）'}`
  + `（${availableParallelism()} 核；CCM_E2E_SHARDS 可覆盖）`);
if (haveHistory) {
  console.log(`[test-e2e-parallel] 各片预测：${groups.map(g => `${g.predicted.toFixed(0)}s`).join(' / ')}`);
}

const collected = {};
const results = await Promise.all(groups.map((g, index) => runShard({ files: g.files, index }, collected)));

// 只在这一轮真的量到了东西时才落盘，避免一次异常退出把缓存清成空对象。
// 与旧值合并：某一片崩了不该让它那几个文件的历史时长凭空消失。
if (Object.keys(collected).length) {
  try {
    writeFileSync(DURATIONS_FILE, `${JSON.stringify({ ...durations, ...collected }, null, 2)}\n`);
  } catch (err) {
    console.error(`[test-e2e-parallel] 时长缓存写入失败（不影响本轮结果）: ${err.message}`);
  }
}

console.log('\n[test-e2e-parallel] 分片结果：');
for (const { index, code } of results) {
  console.log(`  shard ${index + 1}/${SHARD_COUNT}: ${code === 0 ? '✓ 通过' : `✘ 失败 (exit ${code})`}`);
}

if (results.some(r => r.code !== 0)) {
  console.error('\n[test-e2e-parallel] 至少一个分片失败——完整报告见对应 playwright-report-shardN/ 目录。');
  process.exit(1);
}
console.log('\n[test-e2e-parallel] 全部分片通过。');
