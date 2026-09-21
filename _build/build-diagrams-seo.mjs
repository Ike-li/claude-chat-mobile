#!/usr/bin/env node
/**
 * /diagrams/ 下 archify 产物的 SEO 后处理。幂等，可反复跑。
 *
 * archify 生成的图页是自足的单文件：有标题、有交互，但**一条站内链接都没有**。
 * 对爬虫这就是 14 个死胡同 —— 进得去出不来，收到的权重一点也传不出去，
 * 页面之间也不互相佐证。所以这里补三样：
 *
 *   1. canonical      —— 同一张图经 /diagrams/x.html 与带查询串的地址都可达
 *   2. description    —— 缺了的话搜索结果摘要会退化成页面里第一段可见文字
 *   3. 底部站内导航    —— 把死胡同接回站点主干
 *
 * description 复用索引页 index.html 里已有的卡片文案，不另写一份。
 * 重新生成图集后跑一次本脚本即可（archify 会覆盖掉这些注入）。
 *
 * 用法：node _build/build-diagrams-seo.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DIR = join(ROOT, 'diagrams');
const BASE = 'https://ike-li.github.io/claude-chat-mobile/diagrams/';

const stripTags = (s) => s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

// 底部导航。颜色全部由 currentColor 派生 —— archify 有明暗两套主题，
// 写死颜色会在其中一套下变成看不见的字。
const NAV = `<style>
  .ccm-sitenav {
    max-width: 62rem; margin: 2.5rem auto 0; padding: 1rem 1.25rem 0;
    border-top: 1px solid color-mix(in srgb, currentColor 14%, transparent);
    display: flex; flex-wrap: wrap; gap: 0.5rem 1.25rem; align-items: baseline;
    font: 400 0.85rem/1.6 system-ui, -apple-system, "PingFang SC", sans-serif;
    opacity: 0.72;
  }
  .ccm-sitenav a { color: inherit; text-decoration: none; border-bottom: 1px solid transparent; }
  .ccm-sitenav a:hover { border-bottom-color: currentColor; }
  .ccm-sitenav .ccm-sep { opacity: 0.4; }
</style>
<footer class="ccm-sitenav">
  <a href="./">← 全部架构图</a>
  <span class="ccm-sep">·</span>
  <a href="../zh/">Claude Chat Mobile</a>
  <a href="../docs-site/">项目手册</a>
  <a href="../demo/">在线演示</a>
  <a href="https://github.com/Ike-li/claude-chat-mobile">GitHub</a>
</footer>
`;

// 索引页的卡片文案：href -> 描述
const index = readFileSync(join(DIR, 'index.html'), 'utf8');
const descByHref = {};
for (const [, href, body] of index.matchAll(/<a class="card" href="([^"]+)">([\s\S]*?)<\/a>/g)) {
  const m = body.match(/<p class="desc">([\s\S]*?)<\/p>/);
  if (m) descByHref[href] = stripTags(m[1]);
}

const report = [];
for (const file of [...Object.keys(descByHref), 'index.html']) {
  const path = join(DIR, file);
  let html = readFileSync(path, 'utf8');
  const before = html;
  const isIndex = file === 'index.html';
  const title = stripTags(html.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? '')
    .replace(/\s*·\s*Claude Chat Mobile$/, '').replace(/^Claude Chat Mobile\s*·\s*/, '');

  const head = [];
  if (!/rel="canonical"/.test(html)) {
    head.push(`  <link rel="canonical" href="${BASE}${isIndex ? '' : file}">`);
  }
  if (!/name="description"/.test(html)) {
    const d = `${title}——${descByHref[file]}Claude Chat Mobile 架构图集，可交互 SVG。`;
    head.push(`  <meta name="description" content="${d.replace(/"/g, '&quot;')}">`);
  }
  if (head.length) {
    html = html.replace(/(<title>[\s\S]*?<\/title>\n)/, `$1${head.join('\n')}\n`);
  }

  // 索引页自己已经链满了整站，不再加导航（那只会多出一条指向自己的链接）
  if (!isIndex && !html.includes('ccm-sitenav')) {
    html = html.replace(/<\/body>/, `${NAV}</body>`);
  }

  if (html !== before) { writeFileSync(path, html); report.push(`ok   ${file}`); }
  else report.push(`skip ${file}`);
}

console.log(report.join('\n'));
console.log(`\n处理 ${report.length} 个文件，其中 ${report.filter((r) => r.startsWith('ok')).length} 个有改动`);
