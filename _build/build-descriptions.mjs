#!/usr/bin/env node
/**
 * 把手册页的 meta description 补到合适长度。
 *
 * 原来的 description 直接取 .md 里那行 `> 摘要`，只有十几个字（显示宽度 30 出头）。
 * Google 摘要区能放到约 155 个拉丁字符宽，太短的会被它自行从正文抓一段来补，
 * 抓到什么不受控 —— 常常是导航或代码片段。
 *
 * 补的内容不是新写的文案，是**这一页自己的章节标题**：既保证描述属实、
 * 每页各不相同，又正好把该页真正谈的那些词喂给检索。
 *
 * 只改 .html 的 meta，不动 .md 里那行 `>` —— 它同时是页面上可见的副标题，
 * 拉长会把版面撑坏。两者本来就不必是同一句话。
 *
 * 用法：node _build/build-descriptions.mjs
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TARGET_MIN = 70;   // 显示宽度下限，低于此会被搜索引擎自行补写
const TARGET_MAX = 150;  // 上限，超出会被截断

const width = (s) => [...s].reduce((n, c) => n + (/[⺀-鿿＀-￯]/.test(c) ? 2 : 1), 0);
const strip = (s) => s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

function build(html) {
  const current = html.match(/<meta name="description" content="([^"]*)"/)?.[1];
  if (!current || width(current) >= TARGET_MIN) return null;

  // 章节标题：跳过锚点 <a>，去掉标签
  const heads = [...html.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/g)]
    .map((m) => strip(m[1]))
    .filter((t) => t && t.length <= 30);
  if (!heads.length) return null;

  let desc = current.replace(/[。.]$/, '');
  const picked = [];
  for (const h of heads) {
    const next = `${desc}。本页讲：${[...picked, h].join('、')}。`;
    if (width(next) > TARGET_MAX) break;
    picked.push(h);
  }
  if (!picked.length) return null;

  const out = `${desc}。本页讲：${picked.join('、')}。`;
  return width(out) >= TARGET_MIN ? out : null;
}

const files = [];
for (const dir of ['docs-site/pages', 'docs-site/fragments', 'docs-site']) {
  const p = join(ROOT, dir);
  if (!existsSync(p)) continue;
  for (const n of readdirSync(p)) if (n.endsWith('.html')) files.push(join(dir, n));
}

let changed = 0;
for (const f of files) {
  const p = join(ROOT, f);
  const html = readFileSync(p, 'utf8');
  const next = build(html);
  if (!next) continue;
  writeFileSync(p, html.replace(
    /<meta name="description" content="[^"]*">/,
    `<meta name="description" content="${next.replace(/"/g, '&quot;')}">`,
  ));
  changed += 1;
  console.log(`  ${f.replace('docs-site/', '')} → 宽度 ${width(next)}`);
}
console.log(`\n补写了 ${changed} 个页面的 description`);
