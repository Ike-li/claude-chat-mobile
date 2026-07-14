#!/usr/bin/env node
// scripts/render-plist.js —— 安全渲染 deploy/*.plist.template 占位符（审计 TC-009）。
//
// 此前 deploy/ 模板头部注释建议直接用 `sed -e 's#__X__#value#'` 做替换：value（仓库路径/node 路径等）
// 若含 sed 替换特殊字符 `&`（插入整个匹配串）或定界符本身 `#`，替换结果会被破坏；含 XML 元字符
// （`&`/`<`/`>`）还会生成非法 plist。此脚本用字面量 split/join（非正则、非 shell）做占位符替换，
// 并对替换值做 XML 转义，两类问题一并根治——用法：
//   node scripts/render-plist.js <template> <out> KEY=VALUE [KEY=VALUE...]
// 例：
//   node scripts/render-plist.js deploy/server.plist.template \
//     ~/Library/LaunchAgents/com.you.ccm-server.plist \
//     LABEL=com.you.ccm-server REPO="$PWD" NODE="$(command -v node)" \
//     LOG="$HOME/Library/Logs/ccm-server.log"
// （"$PWD" 等外层双引号是保护当前 shell 调用本脚本时的参数边界，与模板内部的转义/引用是两回事。）
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

// 解析 ['KEY=VALUE', ...] argv 片段为 { KEY: VALUE }；'=' 用 indexOf 定位第一个，VALUE 本身允许含 '='。
export function parseKeyValueArgs(pairs) {
  const vars = {};
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq === -1) throw new Error(`忽略非法参数（须 KEY=VALUE 形式）: ${pair}`);
    vars[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return vars;
}

// 字面量替换 __KEY__ → escapeXml(value)；非正则、非 shell，对 &/#/空格/引号等特殊字符天然免疫。
export function renderTemplate(templateContent, vars) {
  let content = templateContent;
  for (const [key, value] of Object.entries(vars)) {
    content = content.split(`__${key}__`).join(escapeXml(value));
  }
  return content;
}

// 模板头部的说明性 XML 注释（占位符列表/示例命令）本身会提到 __KEY__ 字面量、会被 renderTemplate 一并
// 误替换成一段读不懂的说明文字——对最终安装的 plist 无功能影响（XML 注释不被 launchd 解析），但去掉
// 更干净。只剥离 <?xml ...?> 声明之后紧跟的第一段 <!-- ... -->，不影响模板正文里其余的行内注释。
export function stripLeadingComment(templateContent) {
  const match = templateContent.match(/^(<\?xml[^\n]*\n)(<!--[\s\S]*?-->\n?)/);
  if (!match) return templateContent;
  return templateContent.slice(0, match[1].length) + templateContent.slice(match[0].length);
}

function main(argv) {
  const [templatePath, outPath, ...pairs] = argv;
  if (!templatePath || !outPath || pairs.length === 0) {
    console.error('用法: node scripts/render-plist.js <template> <out> KEY=VALUE [KEY=VALUE...]');
    process.exit(1);
  }

  let vars;
  try {
    vars = parseKeyValueArgs(pairs);
  } catch (err) {
    // 复核发现：此前没 catch，单个不带 '=' 的畸形参数会以裸 Node 堆栈退出，而非下面这行友好提示。
    console.error(`用法: node scripts/render-plist.js <template> <out> KEY=VALUE [KEY=VALUE...]\n${err.message}`);
    process.exit(1);
  }
  const template = stripLeadingComment(readFileSync(templatePath, 'utf8'));
  const content = renderTemplate(template, vars);
  writeFileSync(outPath, content);
  console.log(`已生成 ${outPath}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv.slice(2));
}
