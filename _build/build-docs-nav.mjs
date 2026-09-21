#!/usr/bin/env node
/**
 * 给 docs-site 手册页的版本栏补一组回站点主干的链接。幂等，可反复跑。
 *
 * 手册每页有 30+ 条内链，但全部指向手册内部 —— 它不是死胡同，是个闭环：
 * 权重在 28 个页面之间循环，一点也流不回首页；读者看完也找不到回站点的路。
 *
 * 为什么不改生成模板：模板在 .claude/skills/docs-to-book/templates/build.js，
 * 那是个**通用** skill，任何项目都能用它出书，往里塞 claude-chat-mobile 的
 * 站点链接是污染。所以按 diagrams 的同一套路，产物后处理。
 * 重新生成手册后跑一次本脚本即可。
 *
 * 用法：node _build/build-docs-nav.mjs
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MARK = 'ccm-sitelinks';

// 相对 ROOT 的目标，按每个页面自己的深度算前缀 —— docs-site/index.html 与
// docs-site/pages/x.html 差一层，写死 ../ 会让其中一半 404。
const TARGETS = [
  ['zh/', '项目主页'],
  ['demo/', '在线演示'],
  ['diagrams/', '架构图集'],
];

const STYLE = `<style>
  .${MARK} { display: block; margin-top: 6px; opacity: 0.85; }
  .${MARK} a { color: inherit; text-decoration: none; border-bottom: 1px solid transparent; }
  .${MARK} a:hover { border-bottom-color: currentColor; }
  .${MARK} .sep { opacity: 0.45; padding: 0 4px; }
</style>`;

const files = [];
for (const dir of ['docs-site', 'docs-site/pages']) {
  const p = join(ROOT, dir);
  if (!existsSync(p)) continue;
  for (const n of readdirSync(p)) if (n.endsWith('.html')) files.push(join(dir, n));
}

let changed = 0;
for (const f of files) {
  const path = join(ROOT, f);
  let html = readFileSync(path, 'utf8');
  if (html.includes(MARK)) continue;
  if (!html.includes('<div class="colophon">')) continue;

  // 从该页所在目录走回站点根，再拼目标
  const up = relative(dirname(path), ROOT) || '.';
  const links = TARGETS
    .map(([t, label]) => `<a href="${up}/${t}">${label}</a>`)
    .join('<span class="sep">·</span>');

  html = html.replace(
    /<div class="colophon">([\s\S]*?)<\/div>/,
    `<div class="colophon">$1<span class="${MARK}">${links}</span></div>`,
  );
  if (!html.includes('</head>')) continue;
  html = html.replace('</head>', `${STYLE}\n</head>`);

  writeFileSync(path, html);
  changed += 1;
}
console.log(`扫描 ${files.length} 个页面，补写 ${changed} 个`);
