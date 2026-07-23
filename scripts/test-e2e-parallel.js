#!/usr/bin/env node
// scripts/test-e2e-parallel.js —— P0 E2E 双分片并行编排。
//
// mock server（tests/e2e/mock/server.js）用模块级全局变量当状态存储，一个进程只能安全服务
// 一条测试流（Playwright workers>1 共打同一进程实测会让状态互相踩踏、server 直接抛未捕获异常
// 崩溃——不是配置保守，是必要限制，playwright.config.ts 里 workers:1 不能动）。
// 真正的并发只能走进程级隔离：本脚本并行拉起 2 个独立子进程，各自跑 Playwright 原生
// --shard=i/2，通过 CCM_PLAYWRIGHT_PORT 绑定不同端口（各自起独立 mock server）、
// CCM_PLAYWRIGHT_SHARD_SUFFIX 错开报告/产物目录，进程间零共享状态。
// 实测：串行 142 条 4.3 分钟 → 双分片并行约 2.5 分钟（受本机核数与双开 Chromium 的 CPU 争抢限制，
// 不是线性 2 倍提速）。
//
// 用法: npm run test:e2e:parallel
//   exit 0 = 两个分片全部通过, exit 1 = 至少一个分片失败或异常退出。

import { spawn } from 'node:child_process';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

const SHARDS = [
  { shard: '1/2', port: 33341, suffix: '-shard1' },
  { shard: '2/2', port: 33342, suffix: '-shard2' },
];

function runShard({ shard, port, suffix }) {
  return new Promise(resolvePromise => {
    const child = spawn(
      'npx',
      ['playwright', 'test', 'tests/e2e/p0', `--shard=${shard}`, '--reporter=list'],
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
