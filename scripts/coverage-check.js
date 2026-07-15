#!/usr/bin/env node
// scripts/coverage-check.js —— 覆盖率门槛检查
// 用法: node scripts/coverage-check.js [--threshold=50]
//   默认阈值 65% 行覆盖率（实际约 66%，留 ~1% 缓冲防退化）。在 doctor.js 或 CI 中调用。
//   exit 0 = 达标, exit 1 = 不达标, exit 2 = 运行失败。

import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(import.meta.dirname, '..');

export function unitTestFiles(rootDir = ROOT) {
  return readdirSync(join(rootDir, 'tests', 'unit'), { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.test.mjs'))
    .map(entry => `tests/unit/${entry.name}`)
    .sort();
}

function main() {
  const threshold = parseFloat(process.argv.find(a => a.startsWith('--threshold='))?.split('=')[1] || '65');
  const proc = spawn(process.execPath, [
    '--import', './tests/setup/preload-env.mjs',
    '--experimental-test-coverage',
    '--test',
    ...unitTestFiles(),
  ], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '', stderr = '';

  proc.stdout.on('data', d => { stdout += d; });
  proc.stderr.on('data', d => { stderr += d; });

  proc.on('close', code => {
    if (code !== 0) {
      console.error('测试未全部通过，覆盖率检查中止。');
      console.error(stderr.slice(-500));
      process.exitCode = 2;
      return;
    }

    // 解析 "all files" 行的 line %
    const match = stdout.match(/all files\s+\|\s+(\d+\.\d+)\s+\|\s+(\d+\.\d+)\s+\|\s+(\d+\.\d+)\s+\|/);
    if (!match) {
      console.error('无法解析覆盖率报告。');
      process.exitCode = 2;
      return;
    }

    const linePct = parseFloat(match[1]);
    const branchPct = parseFloat(match[2]);
    const funcPct = parseFloat(match[3]);

    console.log(`行覆盖率: ${linePct}%  |  分支: ${branchPct}%  |  函数: ${funcPct}%`);
    console.log(`门槛: ${threshold}%`);

    if (linePct >= threshold) {
      console.log('✅ 达标');
      return;
    }
    console.log(`❌ 不达标（差距 ${(threshold - linePct).toFixed(2)}%）`);
    process.exitCode = 1;
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}
