#!/usr/bin/env node
/**
 * 站内链接连通性检查：从首页出发做 BFS，看 sitemap 里的页面有几个走得到。
 *
 * 只在 sitemap 里、却没有任何入链的页面叫孤儿页。sitemap 是「告诉爬虫有这些
 * 地址」，入链才是「告诉爬虫这些地址值得抓」—— 没有入链的页面收录概率明显更低，
 * 而且拿不到任何权重。这个缺口不会让任何功能测试变红，只能单独查。
 *
 * 用法：node _build/check-link-graph.mjs
 * 退出码：有孤儿页时 1
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, relative } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BASE = 'https://ike-li.github.io/claude-chat-mobile';

const fileFor = (urlPath) => {
  const rel = urlPath.replace(/^\//, '');
  return rel === '' || rel.endsWith('/') ? `${rel}index.html` : rel;
};

// sitemap 声明的页面 = 期望被收录的集合
const sitemap = readFileSync(join(ROOT, 'sitemap.xml'), 'utf8');
const wanted = new Set([...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)]
  .map((m) => fileFor(m[1].replace(`${BASE}/`, '/'))));

/** 取出一个 HTML 里所有指向站内 .html / 目录的链接，归一成相对 ROOT 的文件路径 */
function linksOf(file) {
  const abs = join(ROOT, file);
  if (!existsSync(abs)) return [];
  const html = readFileSync(abs, 'utf8');
  const out = new Set();
  for (const [, href] of html.matchAll(/<a\s[^>]*href="([^"]+)"/g)) {
    if (/^(https?:|mailto:|#|javascript:|data:)/.test(href)) continue;
    const clean = href.split('#')[0].split('?')[0];
    if (!clean) continue;
    // 相对当前文件所在目录解析
    let target = resolve(dirname(abs), clean);
    if (clean.endsWith('/') || !clean.includes('.')) target = join(target, 'index.html');
    const rel = relative(ROOT, target);
    if (rel.startsWith('..')) continue;          // 跑出站点根
    if (!rel.endsWith('.html')) continue;         // .md / 资源不计入页面图
    out.add(rel);
  }
  return [...out];
}

// 从首页 BFS
const seen = new Set(['index.html']);
const queue = ['index.html'];
const broken = new Set();
while (queue.length) {
  const cur = queue.shift();
  for (const next of linksOf(cur)) {
    if (!existsSync(join(ROOT, next))) { broken.add(`${cur} → ${next}`); continue; }
    if (seen.has(next)) continue;
    seen.add(next);
    queue.push(next);
  }
}

const orphans = [...wanted].filter((f) => !seen.has(f));
console.log(`从 index.html 出发可达 ${seen.size} 个页面`);
console.log(`sitemap 声明 ${wanted.size} 个，其中可达 ${wanted.size - orphans.length} 个`);

if (broken.size) {
  console.log(`\n指向不存在文件的链接 ${broken.size} 条：`);
  [...broken].slice(0, 10).forEach((b) => console.log(`  ✗ ${b}`));
}
if (orphans.length) {
  console.log(`\n孤儿页（在 sitemap 里但从首页走不到）${orphans.length} 个：`);
  orphans.forEach((o) => console.log(`  · ${o}`));
} else {
  console.log('\n没有孤儿页：sitemap 里每个页面都能从首页点到');
}
process.exit(orphans.length || broken.size ? 1 : 0);
