// #384：prefers-reduced-motion 须覆盖 sheet 之外的循环/入场动效与 Tailwind 工具类。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const css = readFileSync(join(root, 'app/public/css/app.css'), 'utf8');

/** Collect bodies of @media (prefers-reduced-motion: reduce) with nested-brace awareness. */
function reduceBlocks(source) {
  const marker = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{/g;
  const bodies = [];
  let m;
  while ((m = marker.exec(source))) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < source.length && depth > 0; i++) {
      const ch = source[i];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
    }
    bodies.push(source.slice(m.index + m[0].length, i - 1));
  }
  return bodies;
}

test('#384 prefers-reduced-motion 覆盖 dashboard / status-pill / thinking / unread-anchor', () => {
  const joined = reduceBlocks(css).join('\n');
  assert.ok(joined, '须有 prefers-reduced-motion: reduce 块');
  assert.match(joined, /\.dashboard-container\s*\{[^}]*animation:\s*none/, '须关掉 .dashboard-container 的 dash-in');
  assert.match(joined, /\.status-pill-chip\.status-pill-flash\s*\{[^}]*animation:\s*none/, '须关掉 status-pill-flash');
  assert.match(
    joined,
    /details\.thinking\.thinking-live\s*>\s*summary\s*\{[^}]*animation:\s*none/,
    '须关掉 thinking-shimmer（保留 ::before 静态「思考中 · 」前缀）',
  );
  assert.match(joined, /\.unread-anchor-flash\s*\{[^}]*animation:\s*none/, '须关掉 unread-anchor-flash');
});

test('#384 prefers-reduced-motion 覆盖 Tailwind .animate-spin / .animate-pulse', () => {
  const joined = reduceBlocks(css).join('\n');
  assert.match(
    joined,
    /\.animate-spin\s*,\s*\.animate-pulse\s*\{[^}]*animation:\s*none|\.animate-pulse\s*,\s*\.animate-spin\s*\{[^}]*animation:\s*none/,
    '须按类名豁免 .animate-spin 与 .animate-pulse（不只 #connBanner）',
  );
});

test('#384 thinking-live 静态前缀仍在（降级不依赖动画）', () => {
  assert.match(
    css,
    /details\.thinking\.thinking-live\s*>\s*summary::before\s*\{[^}]*content:\s*'思考中 · '/,
    'thinking-live ::before 须保留静态「思考中 · 」文案',
  );
});
