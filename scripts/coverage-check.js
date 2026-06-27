#!/usr/bin/env node
// scripts/coverage-check.js —— 覆盖率门槛检查
// 用法: node scripts/coverage-check.js [--threshold=50]
//   默认阈值 50% 行覆盖率。在 doctor.js 或 CI 中调用。
//   exit 0 = 达标, exit 1 = 不达标, exit 2 = 运行失败。

import { spawn } from 'node:child_process';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const THRESHOLD = parseFloat(process.argv.find(a => a.startsWith('--threshold='))?.split('=')[1] || '50');

const proc = spawn('node', ['--experimental-test-coverage', '--test', 'test/*.test.mjs'], {
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
    process.exit(2);
  }

  // 解析 "all files" 行的 line %
  const match = stdout.match(/all files\s+\|\s+(\d+\.\d+)\s+\|\s+(\d+\.\d+)\s+\|\s+(\d+\.\d+)\s+\|/);
  if (!match) {
    console.error('无法解析覆盖率报告。');
    process.exit(2);
  }

  const linePct = parseFloat(match[1]);
  const branchPct = parseFloat(match[2]);
  const funcPct = parseFloat(match[3]);

  console.log(`行覆盖率: ${linePct}%  |  分支: ${branchPct}%  |  函数: ${funcPct}%`);
  console.log(`门槛: ${THRESHOLD}%`);

  if (linePct >= THRESHOLD) {
    console.log('✅ 达标');
    process.exit(0);
  } else {
    console.log(`❌ 不达标（差距 ${(THRESHOLD - linePct).toFixed(2)}%）`);
    process.exit(1);
  }
});
