#!/usr/bin/env node
// i18n-check.js —— i18n 的孤儿词典 key 扫描（public/js/i18n.js EN_DICT 有、但 index.html 的界面文案
// 与各 js 的 t('原文') 调用里再没有它）。zh 原文即 key 的设计下，改文案 = 改 key，
// 旧 key 容易变成词典孤儿——本脚本挂进 npm run check 兜住漂移，不做翻译完整性检查（未翻译=静默回落
// 中文是设计内行为，见 public/js/i18n.js 头注，不是错误）。
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
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

// EN_DICT 字面量里的单引号字符串 key（与 public/js/i18n.js 的写法约定一致：'中文 key': '译文'）。
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
// 静态字面量，见 public/js/i18n.js t() 签名）。非字符串参数（变量/三元表达式的非字面量分支）安全跳过。
export function extractTCallKeys(source) {
  const keys = [];
  const callRe = /\bt\(\s*(['"`])((?:(?!\1)[^\\]|\\.)*)\1/g;
  let m;
  while ((m = callRe.exec(source))) keys.push(m[2]);
  return keys;
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
  const i18nFile = join(rootDir, 'public/js/i18n.js');
  if (!existsSync(i18nFile)) return { rootDir, dictKeys: [], problems: [] };
  const dictKeys = extractDictKeys(readFileSync(i18nFile, 'utf8'));

  const usedKeys = new Set();
  const htmlFile = join(rootDir, 'public/index.html');
  if (existsSync(htmlFile)) {
    for (const key of extractHtmlCopyKeys(readFileSync(htmlFile, 'utf8'))) usedKeys.add(key);
  }
  const sources = [];
  for (const relPath of walkFiles(rootDir, 'public/js', /\.(?:js|mjs)$/)) {
    const text = readFileSync(join(rootDir, relPath), 'utf8');
    // 词典文件自身不算引用来源：每个 key 都写在它的 EN_DICT 里，算进去等于这道闸永远绿。
    if (relPath.replace(/\\/g, '/') !== 'public/js/i18n.js') sources.push(text);
    for (const key of extractTCallKeys(text)) usedKeys.add(key);
  }

  const problems = dictKeys
    .filter(key => !usedKeys.has(key) && !sources.some(src => keyAppearsAsLiteral(src, key)))
    .map(key => ({
      code: 'orphan_dict_key',
      key,
      message: `EN_DICT key "${key}" no longer appears in index.html copy or any t('...') call`,
    }));

  return { rootDir, dictKeys, problems };
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
