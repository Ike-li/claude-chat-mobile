#!/usr/bin/env node
// i18n-check.js —— ⑨ i18n 分阶段的孤儿词典 key 扫描（public/js/i18n.js EN_DICT 有、但代码/HTML 里
// 再没有 t('原文') 调用或 [data-i18n] 静态标记引用它）。zh 原文即 key 的设计下，改文案 = 改 key，
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

// [data-i18n] 标记元素的文本内容（词边界判定：data-i18n 后须紧跟空白/=/>，不误吞
// data-i18n-placeholder 等前缀相似的属性名）。只认简单文本节点（无嵌套标签），与当前用法一致。
export function extractDataI18nKeys(html) {
  const keys = [];
  const tagRe = /<[a-zA-Z][a-zA-Z0-9-]*\b[^>]*\bdata-i18n(?=[\s=>])[^>]*>([^<]*)</g;
  let m;
  while ((m = tagRe.exec(html))) {
    const text = m[1].trim();
    if (text) keys.push(text);
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

export function checkI18n({ rootDir = ROOT } = {}) {
  const i18nFile = join(rootDir, 'public/js/i18n.js');
  if (!existsSync(i18nFile)) return { rootDir, dictKeys: [], problems: [] };
  const dictKeys = extractDictKeys(readFileSync(i18nFile, 'utf8'));

  const usedKeys = new Set();
  const htmlFile = join(rootDir, 'public/index.html');
  if (existsSync(htmlFile)) {
    for (const key of extractDataI18nKeys(readFileSync(htmlFile, 'utf8'))) usedKeys.add(key);
  }
  for (const relPath of walkFiles(rootDir, 'public/js', /\.(?:js|mjs)$/)) {
    const text = readFileSync(join(rootDir, relPath), 'utf8');
    for (const key of extractTCallKeys(text)) usedKeys.add(key);
  }

  const problems = dictKeys
    .filter(key => !usedKeys.has(key))
    .map(key => ({
      code: 'orphan_dict_key',
      key,
      message: `EN_DICT key "${key}" has no t('...') call or [data-i18n] element referencing it`,
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
