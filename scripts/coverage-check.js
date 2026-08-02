#!/usr/bin/env node
// scripts/coverage-check.js —— 覆盖率门槛检查
// 用法: node scripts/coverage-check.js [--threshold=75]
//   默认阈值 75% 行覆盖率（2026-08-02 实测 77.5%，留 ~2.5% 缓冲防退化）。在 doctor.js 中调用。
//   exit 0 = 达标, exit 1 = 不达标, exit 2 = 运行失败。
//
// ★ 这个百分比的分母只含【被单测加载过的文件】——node 的 --experimental-test-coverage 不统计
//   从未 import 过的文件，它们既不出现在报告里、也不拉低百分比。所以 77% 不是"77% 的生产代码
//   被测到了"，而是"在已经有人写过测试的那些文件里测到了 77%"。2026-08-02 实测缺口：12 个生产
//   文件从未被任何单测加载，合计 11,140 行 = 生产代码的 35.7%，其中最大两个是
//   public/js/app.js(6961) 与 src/server/app.js(2967)。
//   下面的 reportUnloadedFiles 把这个缺口一并打印出来——单看一个漂亮的百分比会误读成安全。
//   把它们计入分母（Node 24 的 --test-coverage-include）是独立决策，会让数字掉到 ~48%，未启用。

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

// 生产代码扫描面：与覆盖率百分比的分母口径对照用。刻意不含 tests/ 与仓库根脚本。
const PRODUCTION_DIRS = Object.freeze(['src', 'public/js', 'scripts']);

function listProductionFiles(rootDir, dir) {
  const out = [];
  let entries;
  try { entries = readdirSync(join(rootDir, dir), { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    if (entry.name === 'vendor') continue; // 第三方压缩产物，不是本项目代码
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...listProductionFiles(rootDir, rel));
    else if (entry.name.endsWith('.js')) out.push(rel);
  }
  return out;
}

// node 的覆盖率报告只列【被加载过的文件】。把没出现在报告里的生产文件挑出来——它们是 0% 覆盖，
// 却因为不在分母里而完全不影响上面那个百分比。不打印出来的话，门槛达标会被读成"整体安全"。
export function findUnloadedProductionFiles(reportText, rootDir = ROOT, listFiles = listProductionFiles) {
  const loaded = new Set(
    [...reportText.matchAll(/^(?:ℹ\s+)?\s*([A-Za-z0-9_.-]+\.(?:js|mjs))\s+\|/gm)].map(m => m[1]),
  );
  return PRODUCTION_DIRS
    .flatMap(dir => listFiles(rootDir, dir))
    .filter(file => !loaded.has(file.split('/').pop()))
    .sort();
}

function main() {
  const threshold = parseFloat(process.argv.find(a => a.startsWith('--threshold='))?.split('=')[1] || '75');
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

    const unloaded = findUnloadedProductionFiles(stdout);
    if (unloaded.length > 0) {
      console.log(`\n⚠️  以下 ${unloaded.length} 个生产文件从未被任何单测加载 —— 它们是 0% 覆盖，`);
      console.log('   但不在上面那个百分比的分母里（node 只统计加载过的文件）：');
      for (const file of unloaded) console.log(`   · ${file}`);
    }

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
