#!/usr/bin/env node
// tests/gates/check-disposable-env-guard.js —— 执行位守卫的接线闸
//
// 【这道闸挡的是什么】tests/setup/require-disposable-env.mjs 把「必须进容器」从文档约定变成了
// 进程级强制，但它只对【import 了它的文件】生效。漏加那行 import 是完全静默的：文件照常跑，
// 照常绿，只是那层保护根本没接上。而「记得加」正是 2026-08-02 事故失败的那一步——
// 靠人归类的环节，迟早会漏。
//
// 【为什么判据是目录前缀，不是「危险性」】判危险性又回到了归类。目录前缀机械可判：
// 这三个目录整体不在 guard-host-tests.js 的宿主机白名单里，理由各自写在下面。
// 新文件落进这些目录就自动被管辖，不需要任何人想起来登记。
//
// 【为什么还要查顺序】只查「有没有那行 import」是半条判据：ESM 的静态 import 按源码顺序求值，
// 守卫排在被测模块后面的话，那些模块的顶层代码（落盘路径常量、watcher、防抖定时器）
// 已经跑完了才轮到守卫退出。位置错 = 保护没生效，而它看起来和加对了一模一样。
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../..', import.meta.url).pathname;

// 管辖目录 + 它为什么不能在开发机上跑。理由要点到形态，不能只写「危险」——
// 看的人得据此判断新目录该不该进这张表。
export const GUARDED_DIRS = new Map([
  ['tests/invariants/env', '卸载器：隔离依赖被测代码认注入的 home/root/appPath，回落 homedir() 就打在真实家目录上'],
  ['tests/invariants/server', '起真 app/server.js 子进程'],
  ['tests/integration', '起真 server 并 spawn claude，且有用例按设计操作真实 ~/.claude/projects'],
]);

const GUARD_SPECIFIER = /^import\s+['"](?:\.\.\/)+setup\/require-disposable-env\.mjs['"];?\s*$/;

/** 源码里的静态 import 行，按源码顺序。块注释与行注释里的 import 字样不算。 */
function staticImportLines(source) {
  const out = [];
  let inBlockComment = false;
  for (const raw of source.split('\n')) {
    if (inBlockComment) {
      if (raw.includes('*/')) inBlockComment = false;
      continue;
    }
    // 先剥掉【同一行内闭合】的块注释再判定：`/* 说明 */ import x from 'y';` 整行以 /* 开头，
    // 若按行首直接跳过就会漏掉那条 import——漏判的方向是「守卫看起来排在第一条」，
    // 即 fail-open，正是这道闸最不能有的失效方向。
    const line = raw.replace(/\/\*.*?\*\//g, '').trim();
    if (line.startsWith('/*')) { inBlockComment = true; continue; }
    // 只认顶层静态 import（ESM 要求它在顶层，所以行首即可判定）。
    // `await import(...)` 是表达式，不以 import 开头，天然不在此列——它也确实不需要排在最前。
    if (/^import\s/.test(line)) out.push(line);
  }
  return out;
}

/**
 * @returns {string|null} 违规原因；null = 合规
 */
export function checkSource(source) {
  const imports = staticImportLines(source);
  const at = imports.findIndex(l => GUARD_SPECIFIER.test(l));
  if (at < 0) {
    return '缺少执行位守卫：顶部应有 `import \'<相对路径>/setup/require-disposable-env.mjs\';`';
  }
  if (at !== 0) {
    return `执行位守卫排在第 ${at + 1} 条 import，必须是第 1 条`
      + `（它前面的 \`${imports[0]}\` 的顶层代码会先于守卫执行）`;
  }
  return null;
}

function main() {
  const violations = [];
  let scanned = 0;

  for (const [dir, why] of GUARDED_DIRS) {
    let entries;
    try {
      entries = readdirSync(join(ROOT, dir));
    } catch {
      // 目录读不到就是判据面塌了，不是「全部合规」——这一条必须红。
      violations.push({ file: dir, why: `管辖目录读不到：${dir}（目录改名或删除时，本闸的扫描面会静默变空）` });
      continue;
    }
    const tests = entries.filter(f => f.endsWith('.test.mjs'));
    if (tests.length === 0) {
      violations.push({ file: dir, why: `管辖目录里一个 .test.mjs 都没有：${dir}` });
      continue;
    }
    for (const f of tests) {
      scanned += 1;
      const rel = `${dir}/${f}`;
      const why2 = checkSource(readFileSync(join(ROOT, rel), 'utf8'));
      if (why2) violations.push({ file: rel, why: why2, dirReason: why });
    }
  }

  if (violations.length) {
    process.stderr.write('\n✖ 执行位守卫接线闸\n\n');
    for (const v of violations) {
      process.stderr.write(`  ${v.file}\n    ${v.why}\n`);
      if (v.dirReason) process.stderr.write(`    该目录为什么必须进容器：${v.dirReason}\n`);
      process.stderr.write('\n');
    }
    process.stderr.write(
      '  守卫模块：tests/setup/require-disposable-env.mjs（那份文件头写了它挡什么、不挡什么）\n\n');
    process.exit(1);
  }
  process.stdout.write(`disposable-env guard OK (${scanned} files)\n`);
}

if (process.argv[1]) {
  const { realpathSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  try {
    if (realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) main();
  } catch { /* 比对失败就不自动执行 */ }
}
