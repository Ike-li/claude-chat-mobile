#!/usr/bin/env node
// tests/gates/coverage-check.js —— 覆盖率门槛检查
// 用法: node tests/gates/coverage-check.js [--threshold=75]
//   默认阈值 75% 行覆盖率（2026-08-02 实测 77.5%，留 ~2.5% 缓冲防退化）。在 doctor.js 中调用。
//   exit 0 = 达标, exit 1 = 不达标, exit 2 = 运行失败。
//
// ★ 这个百分比的分母只含【被单测加载过的文件】——node 的 --experimental-test-coverage 不统计
//   从未 import 过的文件，它们既不出现在报告里、也不拉低百分比。所以 77% 不是"77% 的生产代码
//   被测到了"，而是"在已经有人写过测试的那些文件里测到了 77%"。最大的两个缺口是
//   app/public/js/app.js 与 app/src/server/app.js，两者合计就占生产代码的三成。
//
//   ★ 这个缺口补不上，别再提案了（2026-08-03 实测）：
//   · --test-coverage-include 只是【过滤】报告里已有的文件，不会把从未加载的文件拉进分母。
//     实测三种 glob（相对/递归/绝对）都一样：未加载的文件照旧不出现，百分比纹丝不动。
//     V8 只对加载过的文件有覆盖数据，这是原理层面的，不是标志用法问题。
//   · "写个 barrel 把生产文件全 import 一遍"也不行：app/public/js/app.js 一加载就碰 document，
//     app/src/server/app.js 会真起服务。
//   所以门槛的语义就只能是"【已经被测的那些文件】别退化"，不是"整体安全"。下面的缺口摘要把
//   分母覆盖面按文件数与行数一起打出来，让这个限定条件出现在每次输出里，而不是躺在注释里。

import { spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(import.meta.dirname, '..', '..');

export function unitTestFiles(rootDir = ROOT) {
  return readdirSync(join(rootDir, 'tests', 'unit'), { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.test.mjs'))
    .map(entry => `tests/unit/${entry.name}`)
    .sort();
}

// 生产代码扫描面：与覆盖率百分比的分母口径对照用。刻意不含 tests/ 与仓库根脚本。
const PRODUCTION_DIRS = Object.freeze(['app/src', 'app/public/js', 'scripts']);

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

// ★ node --experimental-test-coverage 的报告是【目录树】，叶子行只有 basename：
//     ℹ src        |  …
//     ℹ  server    |  …
//     ℹ   app.js   |  …
// 所以要按缩进深度把路径还原回完整相对路径。只比 basename 会在同名文件上认错人——本仓
// app.js（app/src/server + app/public/js）与 notifications.js（app/src/ops + app/public/js/app）各有两份，
// 而认错是【静默】的：本文件拿它算「哪些生产文件从未被加载」，认错就让最该报的那个文件从缺口
// 名单里消失（app/src/server/app.js 一旦有了首个单测，app/public/js/app.js 这个全仓最大的 0% 文件
// 就会被它的同名兄弟顶掉）；tests/gates/mutate.js 拿它挑「哪些行被覆盖过」，认错则把变异体生成到
// 错的行集合上——要么全存活（假警报），要么跳过真被覆盖的行（假绿）。
//
// 返回 [{ path, cells }]，cells 是按 `|` 切开的原始单元格（cells[4] = 未覆盖行）。
export function parseCoverageRows(reportText) {
  const rows = [];
  const stack = [];
  for (const raw of String(reportText ?? '').split('\n')) {
    const line = raw.replace(/^ℹ\s?/, '');
    const cells = line.split('|');
    if (cells.length < 5) continue;                                  // 分隔线等非表格行
    const name = cells[0].trim();
    if (!name || name === 'file' || name === 'all files') continue;  // 表头与汇总行
    const depth = cells[0].length - cells[0].trimStart().length;     // 缩进即层级
    stack.length = depth;                                            // 回到本行所属父级
    stack[depth] = name;
    if (!/\.[cm]?js$/.test(name)) continue;                          // 目录行只进栈、不产出
    rows.push({ path: stack.filter(Boolean).join('/'), cells });
  }
  return rows;
}

// node 的覆盖率报告只列【被加载过的文件】。把没出现在报告里的生产文件挑出来——它们是 0% 覆盖，
// 却因为不在分母里而完全不影响上面那个百分比。不打印出来的话，门槛达标会被读成"整体安全"。
export function findUnloadedProductionFiles(reportText, rootDir = ROOT, listFiles = listProductionFiles) {
  const loaded = new Set(parseCoverageRows(reportText).map(row => row.path));
  return PRODUCTION_DIRS
    .flatMap(dir => listFiles(rootDir, dir))
    .filter(file => !loaded.has(file))
    .sort();
}

// 分母覆盖面：多少个生产文件进了那个百分比、多少个没进、没进的合计多少行。
// 只给一份文件清单不够——"12 个文件没进分母"听起来像零头，"11,140 行 = 生产代码的 35.7%"
// 才说得清那个百分比在描述多小的一块。countLines 可注入，便于单测不碰真实文件系统。
export function summarizeCoverageGap(
  reportText,
  { rootDir = ROOT, listFiles = listProductionFiles, countLines = defaultCountLines } = {},
) {
  const all = PRODUCTION_DIRS.flatMap(dir => listFiles(rootDir, dir));
  const unloaded = findUnloadedProductionFiles(reportText, rootDir, listFiles);
  const linesOf = files => files.reduce((sum, file) => sum + countLines(rootDir, file), 0);
  const totalLines = linesOf(all);
  const gapLines = linesOf(unloaded);
  return {
    unloaded,
    totalFiles: all.length,
    loadedFiles: all.length - unloaded.length,
    gapLines,
    // 分母外的行占生产代码的比例；没有行数信息时给 null 而不是 0——"不知道"和"没有缺口"
    // 是两回事，别让前者伪装成后者。这不是只为测试存在的分支：defaultCountLines 读盘失败
    // 返回 0，全体读失败时 0/0 得 NaN，输出会变成「生产代码的 NaN%」。
    gapPercent: totalLines > 0 ? Number(((gapLines / totalLines) * 100).toFixed(1)) : null,
  };
}

function defaultCountLines(rootDir, relPath) {
  try { return readFileSync(join(rootDir, relPath), 'utf8').split('\n').length; } catch { return 0; }
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

    const gap = summarizeCoverageGap(stdout);
    // 覆盖面恒打印，不只在有缺口时打印：这句话是上面那个百分比的【限定条件】，
    // 一旦只在异常时出现，读到的人就会默认没有限定条件。
    console.log(`覆盖面: 分母含 ${gap.loadedFiles}/${gap.totalFiles} 个生产文件`
      + `（上面的百分比只描述这部分；缺口 ${gap.gapLines} 行`
      + `${gap.gapPercent === null ? '' : ` = 生产代码的 ${gap.gapPercent}%`}）`);
    if (gap.unloaded.length > 0) {
      console.log(`\n⚠️  以下 ${gap.unloaded.length} 个生产文件从未被任何单测加载 —— 它们是 0% 覆盖，`);
      console.log('   但不在上面那个百分比的分母里（node 只统计加载过的文件，这一点改不了，见文件头）：');
      for (const file of gap.unloaded) console.log(`   · ${file}`);
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
