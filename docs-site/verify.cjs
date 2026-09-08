#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════
   verify.cjs — 校验 fragments/ 片段：链接写法、mermaid 语法、HTML 结构、
   残留 emoji、疑似 Markdown、资产是否就位。若已 build 过，再查产物齐全。
   用法：node verify.cjs   （在输出目录下运行，与 build.cjs 同级）
   ══════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const path = require('path');
const B = require('./build.cjs');

const ROOT = __dirname;
const CONTENT = path.join(ROOT, 'fragments');
const book = B.book;
const flat = B.flatten(book);
const slugs = new Set(flat.map((p) => p.slug));

const problems = [];
const warnings = [];
let mermaidCount = 0, linkCount = 0;

/** 把 <pre> 与 mermaid 块抹成等量空行：块内文本不参与「疑似 Markdown」判断 */
function blankBlocks(html) {
  return B.blankPre(html).replace(/<div class="mermaid">[\s\S]*?<\/div>/gi,
    (m) => '\n'.repeat((m.match(/\n/g) || []).length));
}

flat.forEach((pg) => {
  const f = path.join(CONTENT, pg.slug + '.html');
  if (!fs.existsSync(f)) { problems.push(`[缺失] ${pg.slug}.html`); return; }
  const raw = fs.readFileSync(f, 'utf8');
  const html = B.stripComments(raw);   // 注释里的示例标记不参与任何检查

  // 1) 内部链接：只允许裸文件名 slug.html（或已豁免的相对跨目录路径 ../../en/*.html），且 slug 必须存在
  [...html.matchAll(/<a\b[^>]*?\bhref="([^"]*)"/gi)].forEach((m) => {
    const href = m[1];
    if (!href || href.startsWith('#') || href.startsWith('//') ||
        /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href)) return;
    if (!/\.html($|[?#])/i.test(href)) return;

    // 跨目录外链特例（如 ../../en/security.html）
    if (href.startsWith('../../en/')) {
      const enFile = path.resolve(ROOT, "pages", href);
      if (!fs.existsSync(enFile)) {
        problems.push(`[死链] ${pg.slug}.html → 英文外链不存在「${href}」`);
      }
      return;
    }

    linkCount++;
    const hit = href.match(B.BARE_HTML);
    if (!hit) {
      problems.push(`[链接] ${pg.slug}.html → href="${href}"：内部链接请只写 slug.html，不要带目录`);
      return;
    }
    const slug = hit[1];
    if (!slugs.has(slug) && !(slug === 'index' && flat.some((p) => p.home)))
      problems.push(`[死链] ${pg.slug}.html → href="${href}"：未知 slug「${slug}」`);
  });

  // 2) mermaid：图类型、括号配对、节点内裸尖括号（<br/> 合法）
  [...html.matchAll(/<div class="mermaid">([\s\S]*?)<\/div>/g)].forEach((m, i) => {
    mermaidCount++;
    const code = m[1].trim();
    const open = (code.match(/\[/g) || []).length, close = (code.match(/\]/g) || []).length;
    if (open !== close) problems.push(`[mermaid] ${pg.slug}.html 图${i + 1} 方括号不配对 [${open} ]${close}`);
    const codeNoBr = code.replace(/<br\s*\/?>/g, '');
    if (/\[[^\]]*[<>][^\]]*\]/.test(codeNoBr))
      problems.push(`[mermaid] ${pg.slug}.html 图${i + 1} 节点文字疑含裸 < 或 >`);
    if (!/^(flowchart|graph|sequenceDiagram|stateDiagram|quadrantChart|timeline|gantt|pie|erDiagram|classDiagram|mindmap|journey|gitGraph|xychart-beta|sankey-beta|block-beta)/m.test(code))
      problems.push(`[mermaid] ${pg.slug}.html 图${i + 1} 未识别图类型`);
  });

  // 3) 常见 HTML 误写（封面页 hero 的 h1 豁免）
  if (!pg.home && /<h1[\s>]/.test(html)) problems.push(`[HTML] ${pg.slug}.html 含 <h1>（应由外壳生成）`);
  if (/<(html|body|head)[\s>]/.test(html)) problems.push(`[HTML] ${pg.slug}.html 含 html/body/head`);

  // 4) callout 结构：每个 callout 必须紧邻一个 .body
  const calloutOpen = (html.match(/<div class="callout/g) || []).length;
  const bodyCount = (html.match(/<div class="callout[^"]*">\s*<div class="body">/g) || []).length;
  if (calloutOpen !== bodyCount)
    problems.push(`[组件] ${pg.slug}.html callout(${calloutOpen}) 与 body(${bodyCount}) 数量不匹配`);

  // 5) 残留 emoji（保留 ✓✕✗★☆○●◆◇■□▪▫◐◑◯⌘↵←→↑↓↔§※•·—–）
  const KEEP = '✓✕✗★☆○●◆◇■□▪▫◐◑◯⌘↵←→↑↓↔§※•·—–';
  for (const ch of html) {
    const o = ch.codePointAt(0);
    if (KEEP.includes(ch)) continue;
    if ((o >= 0x1F000 && o <= 0x1FAFF) || (o >= 0x2600 && o <= 0x27BF) ||
        (o >= 0x2B00 && o <= 0x2BFF) || o === 0x2705 || o === 0x274C ||
        o === 0x26A0 || o === 0x2B50 || o === 0xFE0F) {
      problems.push(`[emoji] ${pg.slug}.html 残留 emoji: ${ch}`); break;
    }
  }

  // 6) 疑似 Markdown（片段是 HTML，build 不做 md 转换，写了会原样显示成裸文本）
  //    <pre> 与 mermaid 块内的同形文本合法，先抹成空行；行号因此保持不变。
  blankBlocks(html).split('\n').forEach((line, i) => {
    const ln = i + 1;
    if (/^#{2,3} /.test(line))
      problems.push(`[Markdown] ${pg.slug}.html L${ln}: "${line.trim().slice(0, 20)}…" → 应写成 <h2>/<h3>`);
    else if (/^\|.*\|/.test(line) && !/<(thead|tbody|tr|th|td)/i.test(line))
      problems.push(`[Markdown] ${pg.slug}.html L${ln}: 表格 "|…|" → 应写成 <table>`);
    else if (/^- /.test(line) && !/<li>/i.test(line))
      warnings.push(`[Markdown?] ${pg.slug}.html L${ln}: 行首 "- " 疑似列表 → 确认是否应写成 <ul><li>`);
  });
});

// 7) 资产就位：漏拷任何一个都会让页面裸奔或闪白
['style.css', 'app.js', 'boot.js'].forEach((f) => {
  if (!fs.existsSync(path.join(ROOT, 'assets', f))) problems.push(`[资产] assets/${f} 缺失`);
});
if (mermaidCount > 0 && !fs.existsSync(path.join(ROOT, 'assets', 'mermaid.min.js')))
  problems.push(`[资产] 用了 ${mermaidCount} 张 mermaid 图但 assets/mermaid.min.js 缺失`);

// 8) 已 build 过则检查产物页（未 build 时不报，以便先写 content 再构建）
if (fs.existsSync(path.join(ROOT, 'index.html'))) {
  flat.forEach((pg) => {
    const out = pg.home ? path.join(ROOT, 'index.html') : path.join(ROOT, 'pages', pg.slug + '.html');
    if (!fs.existsSync(out))
      problems.push(`[产物] 已有 index.html 但缺少 ${pg.home ? 'index.html' : 'pages/' + pg.slug + '.html'}（需重新 build）`);
  });
}

console.log(`检查 ${slugs.size} 页 · ${linkCount} 个内部链接 · ${mermaidCount} 张 mermaid 图`);
if (warnings.length) {
  console.log(`\n提示 ${warnings.length} 条（不计入失败）：`);
  warnings.forEach((w) => console.log('  ' + w));
}
if (problems.length) {
  console.log(`\n⚠ 发现 ${problems.length} 个问题：`);
  problems.forEach((p) => console.log('  ' + p));
  process.exitCode = 1;
} else {
  console.log('✓ 未发现链接 / mermaid / HTML / Markdown / 资产问题');
}
