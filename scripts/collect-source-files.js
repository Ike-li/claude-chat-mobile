#!/usr/bin/env node
// 项目 JS 源文件遍历（跳过依赖/运行时产物）。原 check-syntax.js 的 node --check 语法门
// 已由 ESLint 接替（npm run check）；此纯函数保留给 doctor.js D10 —— 生产机可能
// --omit=dev 装不了 ESLint，doctor 的前端语法自检必须零 devDependencies 依赖。
import { readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRECTORIES = new Set([
  '.git',
  '.ccm-uploads',
  'data',
  'node_modules',
  'playwright-report',
  'test-results',
]);

export function collectSyntaxFiles(rootDir = ROOT) {
  const files = [];

  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && SKIP_DIRECTORIES.has(entry.name)) continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolute);
      } else if (entry.isFile() && /\.(?:js|mjs|cjs)$/.test(entry.name)) {
        files.push(relative(rootDir, absolute));
      }
    }
  }

  visit(rootDir);
  return files.sort();
}
