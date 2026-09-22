#!/usr/bin/env node
/**
 * 生成 AEO 的两份入口文件。幂等，可反复跑。
 *   llms.txt      —— 手册清单节（标题 / 描述 / token 预算）
 *   llms-full.txt —— 28 章全量正文合成一份
 *
 * 为什么需要它：这两份是 AI agent 读这个项目的入口（AEO），_build/ 下其余五个
 * 生成脚本都有明确的源，唯独它们长期是手工产物 —— 于是它们漂了。首次接上本脚本时
 * 实测：llms.txt 的 28 个 token 标注【全部】与页面自己声明的 Estimated Tokens 对不上，
 * 系统性偏低 83–410。agent 拿这个数做「先加载哪几页」的预算，标错等于误导。
 *
 * 事实源有两处，都不在这两份文件里：
 *   - 结构（章节顺序、页面标题、一句话描述）← docs-site/book.config.cjs（全书唯一事实源）
 *   - 正文与 token 数 ← 各页产物 .md（docs-to-book 构建时实算）
 * 这两份只是上述两者的投影，不再自己存一份会漂的副本。
 *
 * 两份的改写范围不同，这是有意的：
 *   - llms.txt 只重写 `## Full Handbook Pages (Markdown)` 一节 —— 头部摘要、
 *     Try It / See It、Primary Documents & Specs、Agent Quick-Load 四节是手写文案。
 *     边界用节标题本身，不引入 <!-- --> 标记：给 agent 读的文件，少一行噪音是一行。
 *   - llms-full.txt 整份重写 —— 它按定义就是「全部章节的机器合成」，没有手写成分。
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

// 一次读齐：结构来自 book.config，正文与 token 来自产物
const err = [];
const groups = [];
for (const part of cfg.parts) {
  const items = [];
  for (const pg of part.pages) {
    const rel = mdFor(pg);
    if (!existsSync(join(ROOT, rel))) {
      err.push(`产物缺失: ${rel}（book.config 里登记了 ${pg.slug}，手册需要重新生成）`);
      continue;
    }
    const src = readFileSync(join(ROOT, rel), 'utf8');
    const tok = src.match(/\*\*Estimated Tokens\*\*:\s*~?(\d+)/)?.[1];
    if (!tok) { err.push(`${rel} 里没有 Estimated Tokens，无法给 agent 标注加载预算`); continue; }
    items.push({ pg, rel, tok, body: src.replace(/\s+$/, '') });
  }
  groups.push({ label: part.label, items });
}

// 宁可不写，也不写出缺页的版本 —— agent 读到的残缺清单看起来和完整的一样
if (err.length) {
  console.log('未生成，先修下面这些：');
  err.forEach((e) => console.log(`  ✗ ${e}`));
  process.exit(1);
}

const flat = groups.flatMap((g) => g.items.map((it) => ({ ...it, label: g.label })));
const written = [];

// ── llms.txt：只换手册清单那一节 ──────────────────────────────────
{
  const lines = [];
  for (const g of groups) {
    lines.push(`### ${g.label}`);
    for (const it of g.items) {
      lines.push(`- [${it.pg.title}](${BASE}/${it.rel}): ${it.pg.lead} (Tokens: ~${it.tok})`);
    }
    lines.push('');
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
  if (next !== old) { writeFileSync(path, next); written.push('llms.txt'); }
}

// ── llms-full.txt：整份重写 ──────────────────────────────────────
{
  // baseline 取自 book.config 的 version（形如「手册 v2.0 · dev@687bca3」），
  // 不另写一份 —— 它已经在每页页脚里出现过，再存一份就是第三个会漂的地方。
  const baseline = cfg.version.match(/\w+@[\w.]+/)?.[0] ?? cfg.version;
  const head = [
    `# ${cfg.title} · Full Architecture & Developer Handbook (Combined)`,
    `> Automatic compilation of all ${flat.length} handbook chapters into a single markdown for LLM consumption.`,
    `> Baseline: ${baseline} · n=1 Self-Hosted Architecture`,
  ].join('\n');
  const body = flat
    .map((it) => `# Chapter: ${it.pg.title} (${it.label})\n\n${it.body}\n\n\n---\n`)
    .join('\n\n');

  const path = join(ROOT, 'llms-full.txt');
  const next = `${head}\n\n\n\n${body}`;
  const old = existsSync(path) ? readFileSync(path, 'utf8') : '';
  if (next !== old) { writeFileSync(path, next); written.push('llms-full.txt'); }
}

const scale = `${cfg.parts.length} 章 · ${flat.length} 页`;
console.log(written.length ? `已更新 ${written.join(' + ')}：${scale}` : `llms.txt 与 llms-full.txt 均已是最新：${scale}`);
