#!/usr/bin/env node
// i18n-check.js —— i18n 词典的双向扫描，挂在 npm run check 里。
//   · 孤儿 key：app/public/js/i18n.js EN_DICT 有、但 index.html 的界面文案与各 js 的 t('原文') 调用里再没有它。
//     zh 原文即 key 的设计下，改文案 = 改 key，旧 key 容易变成词典孤儿。
//   · 未翻译 key：t('原文') 用了含中文的 key、EN_DICT 里没有。运行时仍静默回落中文（i18n.js 头注），
//     但开发时就要拦下——2026-09-24 之前不查这一向，/rewind 面板上线时 30 条文案漏翻 26 条，没有任何东西报出来。
//     有意不译的文案（语言名「中文」这类）不要包 t()，直接写字面量。
//     常量表里的中文用 tk('原文') 标记，取用点 t(变量)——tk() 的 key 一并收（PR #175 review）。
//     只查 t() / tk() 文案，看不见的有两类：index.html 静态外壳（有两条有意不译：「中文」「语言 / Language」）；
//     直接写死在代码里、不经 t() 就上屏的中文（2026-09-24 人工审计修过两处：设备列表的「N 天前批准」、
//     后台任务行的「N条」）。
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKIP_DIRECTORIES = new Set(['.git', 'node_modules', '.worktrees', 'vendor']);

function walkFiles(rootDir, dir, pattern) {
  const abs = join(rootDir, dir);
  if (!existsSync(abs)) return [];
  const files = [];
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    if (entry.isDirectory() && SKIP_DIRECTORIES.has(entry.name)) continue;
    const relPath = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(rootDir, relPath, pattern));
    else if (pattern.test(entry.name)) files.push(relPath);
  }
  return files.sort();
}

// EN_DICT 字面量里的单引号字符串 key（与 app/public/js/i18n.js 的写法约定一致：'中文 key': '译文'）。
export function extractDictKeys(source) {
  const bodyMatch = /EN_DICT\s*=\s*Object\.freeze\(\{([\s\S]*?)\}\)/.exec(source);
  if (!bodyMatch) return [];
  const keys = [];
  const keyRe = /'((?:[^'\\]|\\.)*)'\s*:/g;
  let m;
  while ((m = keyRe.exec(bodyMatch[1]))) keys.push(m[1].replace(/\\'/g, "'"));
  return keys;
}

const HTML_ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', '#39': "'", apos: "'", nbsp: ' ' };
// 汉字 + CJK 标点/全角符号：混排里 `<strong>无需上电脑终端</strong>。` 会切出只含一个 `。` 的文本节点，
// 漏掉它就会在英文界面上残留一个孤零零的中文句号。（标点区间写 \u 转义：源码里直接放全角空格会被
// ESLint no-irregular-whitespace 判红。）
const HAS_CHINESE = /[\u4e00-\u9fa5\u3000-\u303f\uff00-\uffef]/;

function decodeEntities(text) {
  return text.replace(/&(#?\w+);/g, (whole, name) => (name in HTML_ENTITIES ? HTML_ENTITIES[name] : whole));
}

// HTML 里全部可翻译文案：含中文的文本节点 + I18N_ATTRS 属性值（与 i18n.js applyI18nToDocument 的
// 运行时扫描范围一一对应）。运行时是整树扫描、不看 data-i18n 标注，所以"用没用到"也必须整树来判，
// 否则改一句 HTML 文案会让旧 key 静默变孤儿而 check 抓不到。
// 只收含中文的：词典 key 恒为中文原文，'English'/'GitHub →' 这类不是 key，收进来只会稀释判定。
export function extractHtmlCopyKeys(html) {
  const stripped = String(html)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
  const keys = [];

  // 标签之间的文本节点（>...<）；首段（首个 < 之前）不是界面文案，忽略。
  const textRe = />([^<]+)</g;
  let m;
  while ((m = textRe.exec(stripped))) {
    const text = decodeEntities(m[1]).trim();
    if (text && HAS_CHINESE.test(text)) keys.push(text);
  }

  const attrRe = /\b(?:title|placeholder|aria-label|alt)\s*=\s*"([^"]*)"/g;
  while ((m = attrRe.exec(stripped))) {
    const text = decodeEntities(m[1]).trim();
    if (text && HAS_CHINESE.test(text)) keys.push(text);
  }
  return keys;
}

// t('...') / t("...") / t(`...`) 调用的字符串字面量参数（无模板插值场景——本仓 t() 用法目前恒为
// 静态字面量，见 app/public/js/i18n.js t() 签名）。非字符串参数（变量/三元表达式的非字面量分支）安全跳过。
// tk('...') 一并收：常量表里的中文用它标记，取用点再 t(变量)（见 i18n.js tk() 头注）。
export function extractTCallKeys(source) {
  const keys = [];
  const callRe = /\btk?\(\s*(['"`])((?:(?!\1)[^\\]|\\.)*)\1/g;
  let m;
  while ((m = callRe.exec(source))) keys.push(m[2]);
  return keys;
}

// 剥掉 JS 注释：注释换成等长空白（总长与行号不变），字符串、模板字面量（含 ${} 里的嵌套）与正则
// 字面量原样保留。未翻译检查只看代码——注释里举个 t('中文示例') 的例子不是界面文案（PR #175 review）。
// 正则字面量按前一个有效字符判定：行首或 ( , = : [ ! & | ? { } ; 之后的 / 才算正则开头，这是常见的
// 近似；极端写法下会把除号当正则或反过来，代价是那一行少剥或多剥注释。
export function stripJsComments(source) {
  const s = String(source);
  let out = '';
  let i = 0;
  let prev = '';             // 上一个有效字符（跳过空白与注释），用来区分除号和正则
  const exprDepth = [];      // 每层模板 ${…} 里尚未闭合的 { 个数

  // i 指在模板文本里（` 或 } 之后），拷到闭合的 ` 或下一个 ${ 为止
  const copyTemplateText = () => {
    while (i < s.length) {
      const ch = s[i];
      if (ch === '\\') { out += s.slice(i, i + 2); i += 2; continue; }
      if (ch === '`') { out += ch; i++; prev = ch; return; }
      if (ch === '$' && s[i + 1] === '{') { out += '${'; i += 2; exprDepth.push(0); prev = '{'; return; }
      out += ch; i++;
    }
  };

  while (i < s.length) {
    const c = s[i];
    const n = s[i + 1];
    if (c === '/' && n === '/') {
      const nl = s.indexOf('\n', i);
      const end = nl === -1 ? s.length : nl;
      out += ' '.repeat(end - i);
      i = end;
    } else if (c === '/' && n === '*') {
      const close = s.indexOf('*/', i + 2);
      const end = close === -1 ? s.length : close + 2;
      out += s.slice(i, end).replace(/[^\n]/g, ' ');
      i = end;
    } else if (c === '\'' || c === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== c && s[j] !== '\n') j += s[j] === '\\' ? 2 : 1;
      out += s.slice(i, j + 1);
      i = j + 1;
      prev = c;
    } else if (c === '`') {
      out += c;
      i++;
      copyTemplateText();
    } else if (c === '}' && exprDepth.length && exprDepth[exprDepth.length - 1] === 0) {
      exprDepth.pop();
      out += c;
      i++;
      copyTemplateText();
    } else if (c === '/' && (prev === '' || '(,=:[!&|?{};'.includes(prev))) {
      let j = i + 1;
      let inClass = false;
      while (j < s.length && s[j] !== '\n') {
        if (s[j] === '\\') { j += 2; continue; }
        if (s[j] === '[') inClass = true;
        else if (s[j] === ']') inClass = false;
        else if (s[j] === '/' && !inClass) break;
        j++;
      }
      out += s.slice(i, j + 1);
      i = j + 1;
      prev = '/';
    } else {
      if (exprDepth.length && c === '{') exprDepth[exprDepth.length - 1]++;
      else if (exprDepth.length && c === '}') exprDepth[exprDepth.length - 1]--;
      out += c;
      i++;
      if (!/\s/.test(c)) prev = c;
    }
  }
  return out;
}

// key 是否作为字符串字面量出现在源码里。覆盖查表式用法——顶层常量表不能直接 t()（会在 setLang()
// 之前求值），于是 key 以裸字面量存在表里、由 t(变量) 取用，extractTCallKeys 看不见它。
// 比 t('...') 宽，但仍要求 key 实打实出现过：真被删掉的旧文案照样报孤儿。
export function keyAppearsAsLiteral(source, key) {
  const escaped = key.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\t/g, '\\t');
  for (const form of new Set([key, escaped])) {
    if (source.includes(`'${form.replace(/'/g, "\\'")}'`)) return true;
    if (source.includes(`"${form.replace(/"/g, '\\"')}"`)) return true;
    if (source.includes(`\`${form}\``)) return true;
  }
  return false;
}

export function checkI18n({ rootDir = ROOT } = {}) {
  const i18nFile = join(rootDir, 'app/public/js/i18n.js');
  if (!existsSync(i18nFile)) return { rootDir, dictKeys: [], problems: [] };
  const dictKeys = extractDictKeys(readFileSync(i18nFile, 'utf8'));

  const usedKeys = new Set();
  const htmlFile = join(rootDir, 'app/public/index.html');
  if (existsSync(htmlFile)) {
    for (const key of extractHtmlCopyKeys(readFileSync(htmlFile, 'utf8'))) usedKeys.add(key);
  }
  const sources = [];
  const tKeyFiles = new Map(); // 含中文的 t() / tk() key → 用到它的文件（相对路径）
  for (const relPath of walkFiles(rootDir, 'app/public/js', /\.(?:js|mjs)$/)) {
    const text = readFileSync(join(rootDir, relPath), 'utf8');
    // 词典文件自身不算引用来源：每个 key 都写在它的 EN_DICT 里，算进去等于这道闸永远绿。
    // 同理也不算「用到」：它是词典，不是界面。
    const isDictFile = relPath.replace(/\\/g, '/') === 'app/public/js/i18n.js';
    if (!isDictFile) sources.push(text);
    for (const key of extractTCallKeys(text)) usedKeys.add(key);
    if (isDictFile) continue;
    // 未翻译只看代码：先剥注释，注释里的 t('…') 用法示例不是界面文案
    for (const key of extractTCallKeys(stripJsComments(text))) {
      if (!HAS_CHINESE.test(key)) continue;
      if (!tKeyFiles.has(key)) tKeyFiles.set(key, new Set());
      tKeyFiles.get(key).add(relPath.replace(/\\/g, '/'));
    }
  }

  const orphans = dictKeys
    .filter(key => !usedKeys.has(key) && !sources.some(src => keyAppearsAsLiteral(src, key)))
    .map(key => ({
      code: 'orphan_dict_key',
      key,
      message: `EN_DICT key "${key}" no longer appears in index.html copy or any t('...') call`,
    }));

  const dictKeySet = new Set(dictKeys);
  const untranslated = [...tKeyFiles]
    .filter(([key]) => !dictKeySet.has(key))
    .map(([key, files]) => ({
      code: 'untranslated_t_key',
      key,
      files: [...files],
      message: `t('${key}') has no English translation in EN_DICT (used in ${[...files].join(', ')}); `
        + 'the English UI falls back to the Chinese original. Add it to app/public/js/i18n.js, '
        + 'or drop the t() if the text is meant to stay untranslated (e.g. a language name)',
    }));

  return { rootDir, dictKeys, problems: [...orphans, ...untranslated] };
}

export function formatI18nCheck(result) {
  if (result.problems.length === 0) {
    return [
      'i18n check OK',
      `dict keys: ${result.dictKeys.length}`,
      `root: ${relative(process.cwd(), result.rootDir) || '.'}`,
    ].join('\n');
  }
  return result.problems.map(p => `[${p.code}] ${p.message}`).join('\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const result = checkI18n();
  const output = formatI18nCheck(result);
  if (result.problems.length > 0) {
    console.error(output);
    process.exit(1);
  }
  console.log(output);
}
