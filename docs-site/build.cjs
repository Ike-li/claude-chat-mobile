#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════
   build.cjs — 把 fragments/<slug>.html 片段编译成完整的多页静态站点
   用法：node build.cjs   （在输出目录下运行）
   依赖：book.config.cjs（全书结构）、fragments/<slug>.html（内容片段）
   产物：index.html + pages/*.html + assets/search-index.js
   ══════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const CONTENT = path.join(ROOT, 'fragments');
const PAGES = path.join(ROOT, 'pages');
const ASSETS = path.join(ROOT, 'assets');
const book = require('./book.config.cjs');
const { convertHtmlToMarkdown, estimateTokens } = require('./html-to-markdown.cjs');


// ══════════════════════════════════════════════════════════════════
//  纯函数区（verify.cjs 复用，勿在此处读写文件）
// ══════════════════════════════════════════════════════════════════

/** HTML 转义：所有来自 book.config 的字段进模板前都要过这一层 */
function esc(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 去掉 HTML 注释：注释里的示例标记不该参与检查、索引或改写 */
function stripComments(html) { return html.replace(/<!--[\s\S]*?-->/g, ''); }

/** 把 <pre> 块内容抹成等量空行：行号不变，块内文本不再被当作正文误判 */
function blankPre(html) {
  return html.replace(/<pre\b[\s\S]*?<\/pre>/gi,
    (m) => '\n'.repeat((m.match(/\n/g) || []).length));
}

/** 展平 parts → 单一顺序页面列表，附 part 信息、全局序号与产物 URL */
function flatten(bk) {
  const flat = [];
  bk.parts.forEach((part) => {
    part.pages.forEach((pg) => {
      flat.push({ ...pg, part, partLabel: part.label, partIcon: part.icon });
    });
  });
  flat.forEach((p, i) => {
    p.n = i;
    p.url = p.home ? 'index.html' : 'pages/' + p.slug + '.html';
  });
  return flat;
}

/** 计算从 fromUrl 到 toUrl 的相对路径 */
function rel(fromUrl, toUrl) {
  const fromDir = path.posix.dirname(fromUrl);
  const r = path.posix.relative(fromDir, toUrl);
  return r || path.posix.basename(toUrl);
}

/** 资源前缀（home 在根，其余在 pages/）*/
function base(p) { return p.home ? '' : '../'; }

/** 提取纯文本：保留 <pre>（命令与配置值要可搜索），解码实体，不截断 */
function plain(html) {
  return stripComments(html)
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x([0-9a-fA-F]+);/g, (m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g,
      (m, n) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }[n]))
    .replace(/&[a-zA-Z]+\d*;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 阅读时长兜底：按正文字数估，config 写了 time 则以 config 为准 */
function estimateTime(text) { return Math.max(1, Math.round(text.length / 400)); }

/** 内部链接的合法写法：裸文件名 slug.html，可带 #锚点 */
const BARE_HTML = /^([^/?#]+)\.html(#[^"]*)?$/;

/**
 * 把正文里的 href="slug.html" 改写成相对当前页的正确路径。
 * 封面产物在根目录、其余页在 pages/，同一个裸文件名在两处含义不同，
 * 所以作者只写 slug，由这里按页计算。异常通过 onError 上报，不静默。
 */
function resolveLinks(html, page, flat, onError) {
  return html.replace(/(<a\b[^>]*?\bhref=")([^"]*)(")/gi, (m, pre, href, post) => {
    if (!href || href.startsWith('#') || href.startsWith('//') ||
        /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href)) return m;      // 锚点 / 协议外链
    
    // 跨目录外链特例（如 ../../en/security.html）保留不改写
    if (href.startsWith('../') || href.startsWith('./') || href.startsWith('/')) {
      return m;
    }

    const hit = href.match(BARE_HTML);
    if (!hit) {
      if (/\.html($|[?#])/i.test(href))
        onError(`${page.slug}.html → href="${href}"：内部链接请只写 slug.html，不要带目录`);
      return m;
    }
    const slug = hit[1];
    const hash = hit[2] || '';
    const target = flat.find((f) => f.slug === slug) ||
      (slug === 'index' ? flat.find((f) => f.home) : null);
    if (!target) {
      onError(`${page.slug}.html → href="${href}"：未知 slug「${slug}」`);
      return m;
    }
    return pre + rel(page.url, target.url) + hash + post;
  });
}

/** 给未包裹的 <table> 套上 .table-wrap，窄屏才能横向滚动 */
function wrapTables(html) {
  return html.replace(/(<div class="table-wrap">\s*)?<table\b[\s\S]*?<\/table>/gi,
    (m, wrapped) => (wrapped ? m : '<div class="table-wrap">' + m + '</div>'));
}

/** 给正文 h2/h3 注入 id，并抽取 TOC */
function processHeadings(html) {
  const toc = [];
  let n = 0;
  const out = html.replace(/<(h2|h3)(\s[^>]*)?>([\s\S]*?)<\/\1>/g, (m, tag, attrs, inner) => {
    attrs = attrs || '';
    let id;
    const idMatch = attrs.match(/id="([^"]+)"/);
    if (idMatch) { id = idMatch[1]; }
    else { id = 's' + (++n); attrs += ` id="${id}"`; }
    const text = inner.replace(/<[^>]+>/g, '').trim();
    toc.push({ level: tag === 'h2' ? 2 : 3, id, text });
    return `<${tag}${attrs}><a class="anchor" href="#${id}" aria-hidden="true"></a>${inner}</${tag}>`;
  });
  return { html: out, toc };
}

// ══════════════════════════════════════════════════════════════════
//  模板区
// ══════════════════════════════════════════════════════════════════

/** 品牌角标：config 未给 mark 时取书名首字 */
function brandMark(bk) {
  if (bk.mark) return bk.mark;
  const t = Array.from(String(bk.title || '').trim());
  return t.length ? t[0] : '·';
}

function sidebar(curr, flat) {
  const b = base(curr);
  const sub = [book.subtitle, book.tagline].filter(Boolean).map(esc).join(' · ');
  let html = `<div class="brand"><a href="${b}index.html">
    <span class="logo"><span class="mark">${esc(brandMark(book))}</span>${esc(book.title)}</span>
    <span class="sub">${sub}</span>
  </a></div><nav class="nav">`;
  book.parts.forEach((part) => {
    const pn = part.icon ? `<span class="pn">${esc(part.icon)}</span>` : '';
    html += `<div class="part"><div class="part-label">${pn}${esc(part.label)}</div>`;
    part.pages.forEach((pg) => {
      const target = flat.find((f) => f.slug === pg.slug);
      const href = rel(curr.url, target.url);
      const active = pg.slug === curr.slug ? ' class="active"' : '';
      const idx = String(target.n).padStart(2, '0');
      html += `<a href="${href}"${active}><span class="idx">${idx}</span><span>${esc(pg.title)}</span></a>`;
    });
    html += `</div>`;
  });
  html += `</nav>`;
  // 奥付：书末的出版信息栏，放版本与源仓库，安静收笔
  const colophon = [book.version, book.repo].filter(Boolean).map(esc).join(' · ');
  if (colophon) html += `<div class="colophon">${colophon}</div>`;
  return html;
}

function tocHtml(toc) {
  if (toc.length < 2) return '';
  const items = toc.map((t) =>
    `<li class="h${t.level}"><a href="#${t.id}">${t.text}</a></li>`).join('');
  return `<aside class="toc"><div class="toc-title">本页目录</div><ul>${items}</ul></aside>`;
}

function pageHead(p, total) {
  const srcLine = p.src && p.src.length
    ? `<span class="src" title="原始文档来源">源自 ${esc(p.src.join(' · '))}</span>` : '';
  const tag = p.partIcon === '◆'
    ? `<span class="part-tag">${esc(p.partLabel)}</span>`
    : `<span class="part-tag"><span class="pn">${esc(p.partIcon)}</span> ${esc(p.partLabel)}</span>`;
  const lead = p.lead ? `<p class="lead">${esc(p.lead)}</p>` : '';
  return `<header class="page-head">
    ${tag}
    <h1>${esc(p.title)}</h1>
    ${lead}
    <div class="meta">
      <span><span class="lbl">阅读约</span> ${p.readMin} 分钟</span>
      <span><span class="lbl">第</span> ${p.n + 1} / ${total} 篇</span>
      ${srcLine}
    </div>
  </header>`;
}

function pager(p, flat) {
  const prev = p.n > 0 ? flat[p.n - 1] : null;
  const next = p.n < flat.length - 1 ? flat[p.n + 1] : null;
  const prevA = prev
    ? `<a class="prev" href="${rel(p.url, prev.url)}"><span class="dir">← 上一篇</span><span class="ttl">${esc(prev.title)}</span></a>`
    : `<a class="prev disabled"></a>`;
  const nextA = next
    ? `<a class="next" href="${rel(p.url, next.url)}"><span class="dir">下一篇 →</span><span class="ttl">${esc(next.title)}</span></a>`
    : `<a class="next disabled"></a>`;
  return `<nav class="pager">${prevA}${nextA}</nav>`;
}

function crumbs(p) {
  return `<b>${esc(p.partLabel)}</b> &nbsp;/&nbsp; ${esc(p.title)}`;
}

function shell(p, bodyHtml, toc, flat) {
  const b = base(p);
  const needMermaid = /class="mermaid"/.test(bodyHtml);
  const mermaidTag = needMermaid ? `<script src="${b}assets/mermaid.min.js"></script>` : '';

  // SEO & 结构化数据
  const siteRoot = 'https://ike-li.github.io/claude-chat-mobile/';
  const siteBase = `${siteRoot}docs-site/`;
  const canonicalUrl = p.home ? siteBase : `${siteBase}pages/${p.slug}.html`;
  const breadcrumbItems = [
    { '@type': 'ListItem', position: 1, name: 'Claude Chat Mobile', item: siteRoot },
    { '@type': 'ListItem', position: 2, name: '项目全景手册', item: siteBase },
  ];
  if (!p.home) {
    breadcrumbItems.push({
      '@type': 'ListItem',
      position: 3,
      name: p.title,
      item: canonicalUrl,
    });
  }
  const breadcrumbJson = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: breadcrumbItems,
  });
  const hreflangMap = {
    quickstart: 'en/quickstart.html',
    'security-model': 'en/security.html',
  };
  const enAlt = hreflangMap[p.slug];
  const hreflangTags = enAlt
    ? `\n<link rel="alternate" hreflang="zh-CN" href="${canonicalUrl}">\n<link rel="alternate" hreflang="en" href="${siteRoot}${enAlt}">\n<link rel="alternate" hreflang="x-default" href="${siteRoot}${enAlt}">`
    : '';

  return `<!DOCTYPE html>
<html lang="${esc(book.lang || 'zh-CN')}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(p.title)} · ${esc(book.title)}</title>
<meta name="description" content="${esc(p.description || p.lead || '')}">
<meta name="llm:tokens" content="${p.tokens}">
<link rel="alternate" type="text/markdown" href="${p.home ? 'index.md' : p.slug + '.md'}">
<link rel="canonical" href="${canonicalUrl}">${hreflangTags}
<link rel="stylesheet" href="${b}assets/style.css">
<script src="${b}assets/boot.js"></script>
<script>window.__BASE__='${b}';</script>
<script type="application/ld+json">${breadcrumbJson}</script>
</head>
<body>
<div class="scrim"></div>
<div class="layout">
  <aside class="sidebar">${sidebar(p, flat)}</aside>
  <script>window.__restoreNavScroll&&window.__restoreNavScroll();</script>
  <div class="main">
    <header class="topbar">
      <button class="icon-btn menu-btn" id="menuBtn" aria-label="菜单">≡</button>
      <div class="crumbs">${crumbs(p)}</div>
      <button class="icon-btn ai-copy-btn" id="copyAiBtn" aria-label="Copy for AI" title="复制当前页面纯净 Markdown 给 AI Agent">
        <span class="btn-text">📋 Copy for AI</span>
      </button>
      <button class="search-trigger" data-search-open>
        <span>搜索手册</span><span class="k">⌘K</span>
      </button>
      <button class="icon-btn" id="themeBtn" aria-label="切换主题" title="切换深浅色 (t)">◐</button>
      <div class="progress" aria-hidden="true"><i id="progressBar"></i></div>
    </header>
    <div class="content-wrap">
      <article class="article fade">
        ${bodyHtml}
        ${pager(p, flat)}
      </article>
      ${toc}
    </div>
  </div>
</div>

<div class="search-mask"></div>
<div class="search-box">
  <input id="searchInput" type="text" placeholder="搜索页面、概念、术语…" autocomplete="off" spellcheck="false">
  <div class="search-results"></div>
  <div class="search-hint"><span><kbd>↑</kbd><kbd>↓</kbd> 选择</span><span><kbd>↵</kbd> 打开</span><span><kbd>esc</kbd> 关闭</span></div>
</div>

<script src="${b}assets/search-index.js"></script>
${mermaidTag}
<script src="${b}assets/app.js"></script>
</body>
</html>`;
}

// ══════════════════════════════════════════════════════════════════
//  主构建流程
// ══════════════════════════════════════════════════════════════════
function build() {
  [CONTENT, PAGES, ASSETS].forEach((d) => fs.mkdirSync(d, { recursive: true }));

  const flat = flatten(book);
  const searchIndex = [];
  const errors = [];
  const missing = [];

  flat.forEach((p) => {
    const fragPath = path.join(CONTENT, p.slug + '.html');
    let frag;
    if (fs.existsSync(fragPath)) {
      frag = fs.readFileSync(fragPath, 'utf8')
        .replace(/<!--\s*build fragment[\s\S]*?-->\s*/i, '')
        .replace(/<meta\s+name=["']robots["'][^>]*>\s*/gi, '');
    } else {
      missing.push(p.slug);
      frag = `<div class="callout warn"><div class="body">
      <strong>本页内容正在撰写</strong>本页（<code>${esc(p.slug)}</code>）的内容片段尚未生成。</div></div>
      <p>${esc(p.lead || '')}</p>`;
    }

    const clean = stripComments(frag);
    const text = plain(clean);
    p.readMin = p.time || estimateTime(text);
    // AEO: 生成纯净 Markdown 镜像产物并估算 Token
    const mdContent = convertHtmlToMarkdown(frag, {
      title: p.title,
      lead: p.lead,
      partLabel: p.partLabel,
      readMin: p.readMin,
      tokens: estimateTokens(frag)
    });
    p.tokens = estimateTokens(mdContent);

    const outMdPath = p.home ? path.join(ROOT, 'index.md') : path.join(PAGES, p.slug + '.md');
    fs.writeFileSync(outMdPath, mdContent, 'utf8');


    const linked = resolveLinks(clean, p, flat, (msg) => errors.push(msg));
    const { html: withIds, toc } = processHeadings(wrapTables(linked));
    const head = p.home ? '' : pageHead(p, flat.length);   // 封面页用自带 hero，不套页眉
    const outHtml = shell(p, (head ? head + '\n' : '') + withIds, tocHtml(toc), flat);

    fs.writeFileSync(
      p.home ? path.join(ROOT, 'index.html') : path.join(PAGES, p.slug + '.html'),
      outHtml, 'utf8');

    searchIndex.push({
      url: p.url, title: p.title, part: p.partLabel,
      lead: p.lead || '', text: text.slice(0, 8000),
    });
  });

  if (errors.length) {
    console.error(`\n✕ 链接无法解析，已停止构建（${errors.length} 处）：`);
    errors.forEach((e) => console.error('  ' + e));
    console.error('\n内部链接只写裸文件名，如 href="overview.html"、href="drift.html#anchor"。');
    process.exit(1);
  }

  fs.writeFileSync(path.join(ASSETS, 'search-index.js'),
    'window.__SEARCH_INDEX__=' + JSON.stringify(searchIndex) + ';', 'utf8');

  console.log(`✓ 构建完成：${flat.length} 页`);
  if (missing.length)
    console.log(`⚠ 缺内容片段（占位）：${missing.length} 页 → ${missing.join(', ')}`);
}

module.exports = {
  book, ROOT, CONTENT, PAGES, ASSETS,
  esc, stripComments, blankPre, flatten, rel, base,
  plain, estimateTime, resolveLinks, wrapTables, processHeadings, BARE_HTML,
};

if (require.main === module) build();
