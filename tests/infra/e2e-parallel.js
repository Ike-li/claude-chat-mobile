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
// ── CI 横向分片（2026-09-13）────────────────────────────────────────────
// 上面那些数字全是【N 个分片挤同一台机器】量出来的。CI 上换了形态：每个分片独占一台
// GitHub runner（`CCM_E2E_SHARD_INDEX=i` 只跑第 i 片），CPU 争抢那一项直接消失，
// 所以「8 分片会偶发假红」这条【不能照搬到 CI】——它的病因之一正是 4 核跑 8 个 Chromium，
// 而横向分片下每台 runner 只有 1 个。另一条病因（分组变化重排 spec、暴露 mock server
// 模块级全局态的隐藏耦合）与分片数无关，改任何分配方式都要承担一次，由 retries:1 兜。
//
// ★ 横向分片新增了一条【漏跑表现为全绿】的路径：各 runner 各自读时长缓存算分组，任何一台
// cache 未命中就会算出另一套分组，于是某些 spec 谁都没跑，而 CI 全绿。`--merge-durations`
// 就是堵这条缝的——汇总 job 拿各片交回的时长片段做并集校验，少一个就红。
// 由 tests/invariants/e2e-shard-coverage.test.mjs 守（TEST-02）。
//
// 用法: npm run test:e2e:parallel        （CCM_E2E_SHARDS=N 显式指定分片数）
//   CCM_E2E_SHARD_INDEX=i                 只跑第 i 片（1-based），供 CI 横向分片使用
//   node tests/infra/e2e-parallel.js --merge-durations <dir>   合并片段并校验覆盖完整
//   exit 0 = 全部分片通过, exit 1 = 至少一个分片失败或异常退出。

import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');
const SPEC_DIR = join(ROOT, 'tests', 'e2e', 'specs');
// 时长缓存：跑完自动更新，下次据此分配。gitignore——它是本机测量值，进版本库只会变成一份
// 会漂移的第二真相。缺失/损坏一律退化成等权重，那时分配等价于「按文件数均分」，仍然正确。
// CI 上靠 actions/cache 跨 run 复用：不进版本库这条不变，但【必须让它在 CI 上存在】——
// 否则 LPT 整个退化成按文件数轮转，而轮转在分片数变大时会更差（实测 6 片轮转 194s、
// LPT 106s，轮转比 4 片还慢，因为两个大文件恰好撞进同一片）。
const DURATIONS_FILE = join(ROOT, 'tests', 'infra', '.e2e-durations.json');

const requested = Number(process.env.CCM_E2E_SHARDS);
// 上限 4 是【稳定性】选的，不是性能选的：8 分片更快（88s vs 140.8s）但实测会偶发假红，理由见文件头。
// 非法值（0/负数/NaN）回落自适应，不让一个写错的环境变量把分片数塌成 0 → 一条用例都不跑。
const SHARD_COUNT = Number.isInteger(requested) && requested > 0
  ? requested
  : Math.max(2, Math.min(4, Math.floor(availableParallelism() / 2)));

const BASE_PORT = 33341;
const MERGED_NAME = 'merged.json';

// CI 横向分片：只跑第 i 片（1-based）。非法值当作没设——回落成本机的「全部分片都跑」，
// 是【跑多了】而不是【跑少了】，与本文件通篇「漏跑不可接受」的取向一致。
const rawIndex = Number(process.env.CCM_E2E_SHARD_INDEX);
const SHARD_INDEX = Number.isInteger(rawIndex) && rawIndex >= 1 && rawIndex <= SHARD_COUNT
  ? rawIndex
  : null;

// ★ 文件清单【扫描得来】，不是写死的列表。这一条是硬要求：任何形式的 checked-in 清单都会在
// 新增 spec 时静默漏跑，而漏跑表现为「全绿」——与 74fc46e 那次漏传 -c 同型的失效。
// ★ recursive 也不能省，理由同上、换了个形态：playwright.config.ts 的 testMatch 是
// 'specs/**/*.spec.ts'（递归），只扫一层就会漏掉 specs/<子目录>/*.spec.ts，而【其余顶层 spec
// 照常作为显式 CLI 参数传进去 ⇒ 四片全绿】。这个分叉在本脚本只供本机手动跑时还只是隐患，
// 自它成为 CI 入口那一刻起就是「required check 静默放过整个子目录」。
function listSpecs() {
  return readdirSync(SPEC_DIR, { recursive: true })
    .map(entry => String(entry).replaceAll('\\', '/'))  // recursive 的返回值分隔符随平台
    .filter(f => f.endsWith('.spec.ts')).sort()
    .map(f => `tests/e2e/specs/${f}`);
}

// ── 子命令：合并各分片交回的时长片段 + 并集校验（守 TEST-02）──────────────
// 放在主流程【之前】早退，而且不认识的参数一律报错：此前本脚本完全忽略 argv，
// 于是任何一个打错的子命令都会静默退化成「跑全量 E2E」——写这条测试时就当场踩了一次。
function mergeDurations(dir) {
  if (!dir) {
    console.error('[test-e2e-parallel] --merge-durations 需要一个目录参数');
    return 1;
  }
  const merged = {};
  let fragments = 0;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json') || name === MERGED_NAME) continue;
    try {
      Object.assign(merged, JSON.parse(readFileSync(join(dir, name), 'utf8')));
      fragments += 1;
    } catch (err) {
      console.error(`[test-e2e-parallel] 片段 ${name} 解析失败: ${err.message}`);
      return 1;
    }
  }
  // 一个片段都没有 ≠ 通过。artifact 全部下载失败时目录就是空的，静默放过等于整轮 e2e 失守。
  if (fragments === 0) {
    console.error(`[test-e2e-parallel] ${dir} 下没有任何分片时长片段——`
      + '所有分片的 artifact 都没下载到，本轮 e2e 的覆盖面无从证明。');
    return 1;
  }
  const expected = listSpecs();
  const missing = expected.filter(spec => !(spec in merged));
  if (missing.length > 0) {
    console.error(`[test-e2e-parallel] ${missing.length} 个 spec 没有被任何分片跑到`
      + `（共 ${expected.length} 个，收到 ${fragments} 份片段）：\n`
      + missing.map(s => `  - ${s}`).join('\n')
      + '\n分片分组出现了分歧（多半是某台 runner 的时长缓存没命中，算出了另一套分组）。'
      + '\n**这类漏跑在 CI 上表现为全绿**，所以这里必须红。');
    return 1;
  }
  // 只留清单内的键：spec 被删/改名后，旧键会一直在缓存里漂着，下轮分配给不存在的文件配权重。
  const clean = Object.fromEntries(expected.map(spec => [spec, merged[spec]]));
  writeFileSync(join(dir, MERGED_NAME), `${JSON.stringify(clean, null, 2)}\n`);
  console.log(`[test-e2e-parallel] ${fragments} 份片段合并为 ${expected.length} 个 spec 的时长表，覆盖完整。`);
  return 0;
}

if (process.argv[2] === '--merge-durations') {
  process.exit(mergeDurations(process.argv[3]));
}
if (process.argv[2]?.startsWith('--')) {
  console.error(`[test-e2e-parallel] 不认识的参数 ${process.argv[2]}——`
    + '本脚本只接受 --merge-durations <dir>，分片数与分片序号走环境变量。');
  process.exit(1);
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
// 路径段含 `/`：listSpecs 是 recursive 的，子目录 spec 一旦出现，这里抓不到它的时长 ⇒
// 并集校验会把「跑了但没量到」误判成「没跑」，自己制造假红。两处的递归性必须同步。
const LINE_RE = /(tests\/e2e\/specs\/[a-z0-9/-]+\.spec\.ts):\d+:\d+ › .*? \(([\d.]+)(ms|s)\)/g;
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

// 横向分片下本进程只负责一片，其余交给别的 runner。分组算法与全量模式【同一份】——
// 各 runner 读到同一份时长缓存就会算出同一套分组；算不出同一套的那种失效由汇总 job 的
// --merge-durations 并集校验接住（TEST-02）。
const mine = SHARD_INDEX === null
  ? groups.map((g, index) => ({ files: g.files, index }))
  : [{ files: groups[SHARD_INDEX - 1].files, index: SHARD_INDEX - 1 }];
if (SHARD_INDEX !== null) {
  console.log(`[test-e2e-parallel] 本 runner 只跑第 ${SHARD_INDEX}/${SHARD_COUNT} 片`
    + `（${mine[0].files.length} 个 spec）`);
}

const collected = {};
const results = await Promise.all(mine.map(shard => runShard(shard, collected)));

// 只在这一轮真的量到了东西时才落盘，避免一次异常退出把缓存清成空对象。
if (Object.keys(collected).length) {
  // 单片模式写【只含本片实测值】的独立片段，不碰主缓存：
  // ① 主缓存是本机资产，一次误设 CCM_E2E_SHARD_INDEX 不该把它削成一片；
  // ② 并集校验要的正是「这一片真跑了哪些」——掺进恢复来的旧值，缺失就被旧值填上了，
  //    闸子当场失明（而它看起来照样是绿的）。
  // 全量模式保持原行为：与旧值合并，某一片崩了不让它那几个文件的历史时长凭空消失。
  const [target, payload] = SHARD_INDEX === null
    ? [DURATIONS_FILE, { ...durations, ...collected }]
    : [join(ROOT, 'tests', 'infra', `.e2e-durations-shard${SHARD_INDEX}.json`), collected];
  try {
    writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`);
  } catch (err) {
    console.error(`[test-e2e-parallel] 时长缓存写入失败（不影响本轮结果）: ${err.message}`);
  }
}

console.log('\n[test-e2e-parallel] 分片结果：');
for (const { index, code } of results) {
  console.log(`  shard ${index + 1}/${SHARD_COUNT}: ${code === 0 ? '✓ 通过' : `✘ 失败 (exit ${code})`}`);
}

if (results.some(r => r.code !== 0)) {
  // 指 test-results 而不是 playwright-report：上面 spawn 时带了 --reporter=list，命令行的 reporter
  // 会【覆盖】config 里的 reporter 数组，html 那一项根本不执行 ⇒ playwright-report-shardN/ 从来不生成。
  // 原文指向那个目录，照着去找只会扑空（.github/workflows/test.yml 的 artifact 路径同源）。
  console.error('\n[test-e2e-parallel] 至少一个分片失败——失败截图见对应 test-results-shardN/ 目录。');
  process.exit(1);
}
// 单片模式下别说「全部分片通过」：这台 runner 对其余分片一无所知，那句话是它无权作的保证。
console.log(SHARD_INDEX === null
  ? '\n[test-e2e-parallel] 全部分片通过。'
  : `\n[test-e2e-parallel] 第 ${SHARD_INDEX}/${SHARD_COUNT} 片通过（其余分片在别的 runner 上）。`);
