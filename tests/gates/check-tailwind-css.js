#!/usr/bin/env node
// tests/gates/check-tailwind-css.js —— 提交的 app/public/css/tw.css 必须等于按当前源码现编的那一份
//
// 【为什么需要】tw.css 是 Tailwind CLI 从 CSS 入口读取配置、扫描 index.html 与 js/**/*.js 预编译的产物，
// 提交进仓库——分发是 master 源码归档，装机不跑构建。新写一个类名却忘了 `npm run build:css`，
// 那条规则就不存在：元素静默没有样式，不报错，E2E 也只在恰好断言了那个计算样式时才红。
// 此前用的 Play CDN 在浏览器里现编，不会有这个缺口；换成预编译后它要靠这道闸补上。
//
// 判据是逐字节相等：重编走 build:css 同一个 CLI、同一份配置。v4 的 stdout 比文件多一个换行，
// 所以与 build:css 一样写临时文件再读，不能 trim 后把产物末尾的真实漂移也吞掉。产物只取决于锁死的
// tailwindcss / @tailwindcss/cli 版本与 CSS 入口、配置及扫描到的源码。
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUTPUT = 'app/public/css/tw.css';
const CLI = join(dirname(createRequire(import.meta.url).resolve('@tailwindcss/cli/package.json')), 'dist/index.mjs');

// rootDir 缺省不传：单测传临时目录夹具，CLI 入口用真实 ROOT。
export function checkTailwindCss({ rootDir = ROOT } = {}) {
  const tempDir = mkdtempSync(join(tmpdir(), 'ccm-tailwind-css-'));
  try {
    const r = spawnSync(process.execPath, [CLI, '-i', join(rootDir, 'app/public/css/tailwind.css'), '-o', join(tempDir, 'tw.css')], {
      cwd: rootDir,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    if (r.error || r.status !== 0) {
      return { problems: [`Tailwind CLI 编译失败（${r.error ? r.error.message : `退出码 ${r.status}`}）：${(r.stderr || '').trim()}`] };
    }

    const committed = readFileSync(join(rootDir, OUTPUT), 'utf8');
    const generated = readFileSync(join(tempDir, 'tw.css'), 'utf8');
    if (committed === generated) return { problems: [] };

    const a = committed.split('\n');
    const b = generated.split('\n');
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return {
      problems: [`${OUTPUT} 与按当前源码现编的结果不一致，第 ${i + 1} 行起：提交的是 ${JSON.stringify(a[i] ?? '<文件结束>')}，`
        + `现编的是 ${JSON.stringify(b[i] ?? '<文件结束>')}。改了类名、CSS 入口或 tailwind.config.js 后要跑 npm run build:css，并把产物一起提交`],
    };
  } finally {
    rmSync(tempDir, { recursive: true, force: true }); // safe-rm: 上面 mkdtempSync 创建的单次编译目录
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const { problems } = checkTailwindCss();
  if (problems.length > 0) {
    console.error(`❌ tw.css 新鲜度检查未通过\n\n${problems.map(p => `  · ${p}`).join('\n')}`);
    process.exit(1);
  }
  console.log(`tw.css 新鲜度 OK（${OUTPUT} 与按当前源码现编的结果逐字节一致）`);
}
