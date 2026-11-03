#!/usr/bin/env node
// tests/gates/check-tailwind-css.js —— 提交的 app/public/css/tw.css 必须等于按当前源码现编的那一份
//
// 【为什么需要】tw.css 是 Tailwind CLI 按 tailwind.config.js 扫 index.html 与 js/**/*.js 预编译的产物，
// 提交进仓库——分发是 master 源码归档，装机不跑构建。新写一个类名却忘了 `npm run build:css`，
// 那条规则就不存在：元素静默没有样式，不报错，E2E 也只在恰好断言了那个计算样式时才红。
// 此前用的 Play CDN 在浏览器里现编，不会有这个缺口；换成预编译后它要靠这道闸补上。
//
// 判据是逐字节相等：重编走 build:css 同一个 CLI、同一份配置，只是输出到 stdout。产物只取决于锁死的
// tailwindcss 版本与输入——autoprefixer 及其 browserslist 数据都打包在 tailwindcss/peers 里，不读 node_modules 别处。
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUTPUT = 'app/public/css/tw.css';
const CLI = createRequire(import.meta.url).resolve('tailwindcss/lib/cli.js');

// rootDir 缺省不传：单测传临时目录夹具，CLI 入口用真实 ROOT。
export function checkTailwindCss({ rootDir = ROOT } = {}) {
  const r = spawnSync(process.execPath, [CLI, '-c', join(rootDir, 'tailwind.config.js')], {
    cwd: rootDir,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    // 打包进 tailwindcss 的 caniuse 数据随版本冻结，「已过期」提示与产物无关，只会把人引去跑 update-browserslist-db
    env: { ...process.env, BROWSERSLIST_IGNORE_OLD_DATA: '1' },
  });
  if (r.error || r.status !== 0) {
    return { problems: [`Tailwind CLI 编译失败（${r.error ? r.error.message : `退出码 ${r.status}`}）：${(r.stderr || '').trim()}`] };
  }

  const committed = readFileSync(join(rootDir, OUTPUT), 'utf8');
  if (committed === r.stdout) return { problems: [] };

  const a = committed.split('\n');
  const b = r.stdout.split('\n');
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return {
    problems: [`${OUTPUT} 与按当前源码现编的结果不一致，第 ${i + 1} 行起：提交的是 ${JSON.stringify(a[i] ?? '<文件结束>')}，`
      + `现编的是 ${JSON.stringify(b[i] ?? '<文件结束>')}。改了类名或 tailwind.config.js 后要跑 npm run build:css，并把产物一起提交`],
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const { problems } = checkTailwindCss();
  if (problems.length > 0) {
    console.error(`❌ tw.css 新鲜度检查未通过\n\n${problems.map(p => `  · ${p}`).join('\n')}`);
    process.exit(1);
  }
  console.log(`tw.css 新鲜度 OK（${OUTPUT} 与按当前源码现编的结果逐字节一致）`);
}
