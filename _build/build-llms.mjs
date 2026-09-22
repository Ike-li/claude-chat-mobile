#!/usr/bin/env node
/**
 * 从 docs-site/book.config.cjs 重新生成 llms.txt 的手册清单节。幂等，可反复跑。
 *
 * 为什么需要它：llms.txt 是 AI agent 读这个项目的入口（AEO），_build/ 下其余五个
 * 生成脚本都有明确的源，唯独它一直是手工产物 —— 于是它漂了。首次接上本脚本时实测：
 * 28 个页面的 token 标注【全部】与页面自己声明的 Estimated Tokens 对不上，
 * 系统性偏低 83–410。agent 拿这个数做「先加载哪几页」的预算，标错等于误导。
 *
 * 事实源有两处，都不在 llms.txt 里：
 *   - 结构（章节顺序、页面标题、一句话描述）← docs-site/book.config.cjs（全书唯一事实源）
 *   - token 数 ← 各页产物 .md 里的 `**Estimated Tokens**: ~N`（docs-to-book 构建时实算）
 * llms.txt 只是这两者的投影，不再自己存一份会漂的副本。
 *
 * 只重写 `## Full Handbook Pages (Markdown)` 一节 —— 头部摘要、Try It / See It、
 * Primary Documents & Specs、Agent Quick-Load 四节是手写文案，脚本不碰。
 * 边界用节标题本身，不引入 <!-- --> 标记：llms.txt 是给 agent 读的，少一行噪音是一行。
 *
 * 用法：node _build/build-llms.mjs
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BASE = 'https://ike-li.github.io/claude-chat-mobile';
const SECTION = '## Full Handbook Pages (Markdown)';

const cfg = createRequire(import.meta.url)(join(ROOT, 'docs-site/book.config.cjs'));

// index 是 home 页，产物落在 docs-site/ 根；其余在 docs-site/pages/。
// 两者差一层，统一当 pages/ 处理会让首页那条指向 404。
const mdFor = (pg) => (pg.home ? 'docs-site/index.md' : `docs-site/pages/${pg.slug}.md`);

const err = [];
const lines = [];
let pages = 0;

for (const part of cfg.parts) {
  lines.push(`### ${part.label}`);
  for (const pg of part.pages) {
    const rel = mdFor(pg);
    if (!existsSync(join(ROOT, rel))) {
      err.push(`产物缺失: ${rel}（book.config 里登记了 ${pg.slug}，手册需要重新生成）`);
      continue;
    }
    const tok = readFileSync(join(ROOT, rel), 'utf8').match(/\*\*Estimated Tokens\*\*:\s*~?(\d+)/)?.[1];
    if (!tok) { err.push(`${rel} 里没有 Estimated Tokens，无法给 agent 标注加载预算`); continue; }
    lines.push(`- [${pg.title}](${BASE}/${rel}): ${pg.lead} (Tokens: ~${tok})`);
    pages += 1;
  }
  lines.push('');
}

// 宁可不写，也不写出一份缺页的 llms.txt —— agent 读到的残缺清单看起来和完整的一样
if (err.length) {
  console.log('未生成，先修下面这些：');
  err.forEach((e) => console.log(`  ✗ ${e}`));
  process.exit(1);
}

const path = join(ROOT, 'llms.txt');
const old = readFileSync(path, 'utf8');
const start = old.indexOf(SECTION);
if (start < 0) {
  console.log(`✗ llms.txt 里找不到节标题「${SECTION}」，无法定位重写边界`);
  process.exit(1);
}

// 本节终点 = 下一个 ## 标题；没有下一节时就写到文件尾
const rest = old.slice(start + SECTION.length);
const at = rest.search(/\n## /);
const tail = at < 0 ? '' : `\n${rest.slice(at + 1)}`;
const next = `${old.slice(0, start)}${SECTION}\n\n${lines.join('\n')}${tail}`;

if (next === old) {
  console.log(`llms.txt 已是最新：${cfg.parts.length} 章 · ${pages} 页`);
  process.exit(0);
}
writeFileSync(path, next);
console.log(`llms.txt 已更新：${cfg.parts.length} 章 · ${pages} 页`);
