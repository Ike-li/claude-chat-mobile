#!/usr/bin/env node
// tests/infra/e2e-parallel.js —— P0 E2E 分片并行编排。
//
// mock server（tests/e2e/mock/server.js）用模块级全局变量当状态存储，一个进程只能安全服务
// 一条测试流（Playwright workers>1 共打同一进程实测会让状态互相踩踏、server 直接抛未捕获异常
// 崩溃——不是配置保守，是必要限制，playwright.config.ts 里 workers:1 不能动）。
// 真正的并发只能走进程级隔离：本脚本并行拉起 N 个独立子进程，各自跑 Playwright 原生
// --shard=i/N，通过 CCM_PLAYWRIGHT_PORT 绑定不同端口（各自起独立 mock server）、
// CCM_PLAYWRIGHT_SHARD_SUFFIX 错开报告/产物目录，进程间零共享状态。
// 分片数按核数自适应（见 SHARD_COUNT）：一个分片 = 一个 Playwright 进程 + 一个 Chromium
// + 一个 node mock server。
//
// ★ 实测（2026-09-07，10 核，266 条全绿）：串行 8.2 分钟 → 4 分片 2.8 分钟（2.9 倍）。
//
// 【上限为什么是 4：加到 8 一秒都不快，实测 170.3s vs 170.3s】
// Playwright 的 --shard 按【文件】分配、不拆分单个 spec 文件。8 片时负载分成
// 33/66/31/46/20/36/34（第 8 片 0 条）——那个 66 条的分片装着 workspace-sessions-sidebar(39 条)
// 与 settings-model-permission-effort(25 条)，自己就要跑 2.8 分钟，其余 7 片 46s–1.2m 早已跑完在等它。
// 也就是说 2.8 分钟是当前 spec 文件结构的硬下限，与核数、与分片数都无关。再往下压的唯一路径是
// 拆那两个大文件（属于重组测试内容，不是调编排参数），在那之前把分片数调高只是白开进程。
// 顺带纠一条直觉：瓶颈不是 CPU——4 分片时 user+sys 375s / real 170s，并行度才 2.2，10 核远没吃满，
// E2E 的时间大头是浏览器往返等待。
//
// 历史（142 条时）：串行 4.3 分钟 → 双分片 2.5 分钟——同样不是线性提速。
//
// 用法: npm run test:e2e:parallel   （CCM_E2E_SHARDS=N 可显式指定分片数）
//   exit 0 = 全部分片通过, exit 1 = 至少一个分片失败或异常退出。

import { spawn } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');

// 显式覆盖优先；非法值（0/负数/NaN）一律回落自适应，不让一个写错的环境变量把分片数塌成 0 → 一条用例都不跑。
const requested = Number(process.env.CCM_E2E_SHARDS);
const SHARD_COUNT = Number.isInteger(requested) && requested > 0
  ? requested
  : Math.max(2, Math.min(4, Math.floor(availableParallelism() / 2)));

// 端口从 33341 起连号，与 playwright.config.ts 的缺省 CCM_PLAYWRIGHT_PORT 对齐（单跑 test:e2e 用的就是它）。
const BASE_PORT = 33341;
const SHARDS = Array.from({ length: SHARD_COUNT }, (_, i) => ({
  shard: `${i + 1}/${SHARD_COUNT}`,
  port: BASE_PORT + i,
  suffix: `-shard${i + 1}`,
}));

function runShard({ shard, port, suffix }) {
  return new Promise(resolvePromise => {
    const child = spawn(
      // 走 `npm run test:e2e --` 而不是自己拼 `npx playwright test -c <config>`：config 路径因此
      // 只有 package.json 一处真相，本文件不再持有第二份。
      //
      // 这不是洁癖。74fc46e 把 playwright.config.ts 从仓库根移进 tests/infra/ 时，test:e2e 补了 -c
      // 而本文件漏了 —— 仓库根从此没有 config，Playwright 静默回落内建默认：workers 变成 CPU/2
      // （config 的 workers:1 是硬性的，mock server 的模块级状态扛不住并发）、且完全不起 webServer，
      // 266 条全红。它坏了整整那么久没人发现，因为没人跑 test:e2e:parallel（2026-09-07 才查出）。
      // 与其加一道闸去比对两份路径，不如让第二份不存在。
      'npm',
      ['run', 'test:e2e', '--', `--shard=${shard}`, '--reporter=list'],
      {
        cwd: ROOT,
        env: {
          ...process.env,
          CCM_PLAYWRIGHT_PORT: String(port),
          CCM_PLAYWRIGHT_SHARD_SUFFIX: suffix,
        },
        stdio: 'inherit', // 两个分片的 list reporter 交错输出到同一终端；失败时各自的堆栈仍完整可读
      }
    );
    child.on('close', code => resolvePromise({ shard, code: code ?? 1 }));
    child.on('error', err => {
      console.error(`[test-e2e-parallel] shard ${shard} 启动失败: ${err.message}`);
      resolvePromise({ shard, code: 1 });
    });
  });
}

console.log(`[test-e2e-parallel] ${SHARD_COUNT} 个分片并行（${availableParallelism()} 核；CCM_E2E_SHARDS 可覆盖）`);

const results = await Promise.all(SHARDS.map(runShard));

console.log('\n[test-e2e-parallel] 分片结果：');
for (const { shard, code } of results) {
  console.log(`  shard ${shard}: ${code === 0 ? '✓ 通过' : `✘ 失败 (exit ${code})`}`);
}

const failed = results.some(r => r.code !== 0);
if (failed) {
  console.error('\n[test-e2e-parallel] 至少一个分片失败——完整报告见对应 playwright-report-shardN/ 目录。');
  process.exit(1);
}
console.log('\n[test-e2e-parallel] 全部分片通过。');
