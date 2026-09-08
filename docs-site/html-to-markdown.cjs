/**
 * html-to-markdown.cjs
 * 为 AEO（Agentic Engine Optimization）提供纯净 Markdown 输出。
 * 将 fragments/*.html 转为无 HTML 标签噪音、高信息密度的标准 Markdown，
 * 供 AI Agent（Claude Code, Cursor 等）以最低 Token 预算直接阅读。
 */

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function convertHtmlToMarkdown(html, meta = {}) {
  let text = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<meta\b[^>]*>/gi, '')
    .replace(/<header\b[^>]*>[\s\S]*?<\/header>/gi, ''); // 统一由外层注入标题元数据

  // 1. 保护代码块与 Mermaid 图表
  const codeBlocks = [];
  text = text.replace(/<pre><code(?:\s+class="([^"]*)")?>([\s\S]*?)<\/code><\/pre>/gi, (m, lang, code) => {
    const idx = codeBlocks.length;
    const cleanLang = (lang || '').replace(/^language-/, '');
    codeBlocks.push(`\`\`\`${cleanLang}\n${decodeEntities(code).trim()}\n\`\`\``);
    return `__CODE_BLOCK_${idx}__`;
  });

  text = text.replace(/<div\s+class="mermaid">([\s\S]*?)<\/div>/gi, (m, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push(`\`\`\`mermaid\n${decodeEntities(code).trim()}\n\`\`\``);
    return `__CODE_BLOCK_${idx}__`;
  });

  // 2. 转换标题
  text = text.replace(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi, (m, c) => `\n# ${c.trim()}\n`);
  text = text.replace(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi, (m, c) => `\n## ${c.trim()}\n`);
  text = text.replace(/<h3\b[^>]*>([\s\S]*?)<\/h3>/gi, (m, c) => `\n### ${c.trim()}\n`);
  text = text.replace(/<h4\b[^>]*>([\s\S]*?)<\/h4>/gi, (m, c) => `\n#### ${c.trim()}\n`);

  // 3. 转换 Callout 提示框
  text = text.replace(/<div\s+class="callout\s*([^"]*)">\s*<div\s+class="body">([\s\S]*?)<\/div>\s*<\/div>/gi, (m, cls, body) => {
    let prefix = '> **NOTE:** ';
    if (cls.includes('danger')) prefix = '> **CRITICAL / DANGER:** ';
    else if (cls.includes('warn')) prefix = '> **WARNING:** ';
    else if (cls.includes('tip')) prefix = '> **TIP:** ';
    else if (cls.includes('drift')) prefix = '> **DRIFT NOTICE:** ';
    
    // 把内部的 <strong> 提取出来
    let inner = body.replace(/<strong>([^<]+)<\/strong>/i, '$1 — ').trim();
    inner = inner.replace(/<[^>]+>/g, '').trim();
    return `\n${prefix}${decodeEntities(inner)}\n`;
  });

  // 4. 转换表格
  text = text.replace(/<div\s+class="table-wrap">([\s\S]*?)<\/div>/gi, '$1');
  text = text.replace(/<table\b[^>]*>([\s\S]*?)<\/table>/gi, (m, tableInner) => {
    const rows = [];
    const trMatches = [...tableInner.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)];
    
    for (const tr of trMatches) {
      const cells = [...tr[1].matchAll(/<(?:th|td)\b[^>]*>([\s\S]*?)<\/(?:th|td)>/gi)].map(c => {
        let cellText = c[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        return decodeEntities(cellText).replace(/\|/g, '\\|');
      });
      if (cells.length) rows.push(cells);
    }

    if (!rows.length) return '';
    const colCount = Math.max(...rows.map(r => r.length));
    const normalizedRows = rows.map(r => {
      while (r.length < colCount) r.push('');
      return '| ' + r.join(' | ') + ' |';
    });

    const header = normalizedRows[0];
    const separator = '| ' + Array(colCount).fill('---').join(' | ') + ' |';
    const bodyRows = normalizedRows.slice(1);

    return `\n${header}\n${separator}\n${bodyRows.join('\n')}\n`;
  });

    // 4.1 转换 .kv 键值对网格
  text = text.replace(/<div\s+class="kv">([\s\S]*?)<\/div>/gi, (m, inner) => {
    const rows = [];
    const rowMatches = [...inner.matchAll(/<div\s+class="row">\s*<div\s+class="key">([\s\S]*?)<\/div>\s*<div\s+class="val">([\s\S]*?)<\/div>\s*<\/div>/gi)];
    for (const r of rowMatches) {
      const k = r[1].replace(/<[^>]+>/g, '').trim();
      const v = r[2].replace(/<[^>]+>/g, '').trim();
      rows.push(`- **${k}**: ${v}`);
    }
    return '\n' + rows.join('\n') + '\n';
  });

  // 5. 转换列表
  text = text.replace(/<ul\b[^>]*>([\s\S]*?)<\/ul>/gi, (m, inner) => {
    const items = [...inner.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)]
      .map(c => `- ${c[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()}`);
    return `\n${items.join('\n')}\n`;
  });

  text = text.replace(/<ol\b[^>]*>([\s\S]*?)<\/ol>/gi, (m, inner) => {
    let idx = 1;
    const items = [...inner.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)]
      .map(c => `${idx++}. ${c[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()}`);
    return `\n${items.join('\n')}\n`;
  });

  // 6. 转换内联格式：行内代码、链接、加粗、斜体
  text = text.replace(/<code>([^<]+)<\/code>/gi, (m, code) => `\`${decodeEntities(code)}\``);
  text = text.replace(/<a\b[^>]*\bhref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (m, href, label) => {
    const cleanLabel = label.replace(/<[^>]+>/g, '').trim();
    // 内部链接保持 slug.md，方便直接点击跳转到纯 Markdown
    const targetHref = href.replace(/\.html($|#)/, '.md$1');
    return `[${cleanLabel}](${targetHref})`;
  });
  text = text.replace(/<strong>([\s\S]*?)<\/strong>/gi, (m, c) => `**${c.trim()}**`);
  text = text.replace(/<em>([\s\S]*?)<\/em>/gi, (m, c) => `*${c.trim()}*`);
  text = text.replace(/<p\b[^>]*>([\s\S]*?)<\/p>/gi, (m, c) => `\n${c.trim()}\n`);

  // 7. 剥除残留标签
  text = text.replace(/<[^>]+>/g, ' ');

  // 8. 恢复代码块
  text = text.replace(/__CODE_BLOCK_(\d+)__/g, (m, idx) => codeBlocks[Number(idx)] || '');

  // 9. 解码实体并清理多余空行
  text = decodeEntities(text);
  text = text.replace(/\n{3,}/g, '\n\n').trim();

  // 10. 组装头部 Agent 友好的前置元数据 (Frontmatter / Header)
  let mdHeader = '';
  if (meta.title) {
    mdHeader += `# ${meta.title}\n`;
    if (meta.lead) mdHeader += `> ${meta.lead}\n\n`;
    mdHeader += `- **Part**: ${meta.partLabel || ''}\n`;
    if (meta.readMin) mdHeader += `- **Reading Time**: ~${meta.readMin} min\n`;
    if (meta.tokens) mdHeader += `- **Estimated Tokens**: ~${meta.tokens}\n`;
    mdHeader += `\n---\n\n`;
  }

  return mdHeader + text + '\n';
}

/**
 * 粗略估算 Token 数量 (英文约 4 字符 1 token，中文字符约 1~1.5 token)
 */
function estimateTokens(text) {
  let cjk = 0, nonCjk = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0x4e00 && code <= 0x9fa5) cjk++;
    else nonCjk++;
  }
  return Math.ceil(cjk * 1.3 + nonCjk / 4);
}

module.exports = {
  convertHtmlToMarkdown,
  estimateTokens,
  decodeEntities,
};
