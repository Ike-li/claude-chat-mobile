#!/usr/bin/env node
// n=1 假设面守卫：docs/hard-rules.md §2 的登记簿 ⇔ 代码里的 `// n1: <ID>` 标记，双向必须相等。
//
// 【为什么需要】hard-rules §2 把「n=1 自托管」写成显式产品立场，并据此列出有意不做的事
// （AD-5 per-连接镜像锁、SP-10 完整闭合）。这是项目最好的决策文档——但代码里对这条立场的
// 依赖一直是【隐式】的：viewingInstanceId / mirrorReadonly 等全局单值散落在四个文件里，
// `grep 'n=1'` 只能捞到「注释里恰好提到这三个字」的地方，不等于假设面的完整枚举。
// 真到了要改立场那天（hard-rules §5 写明了重开条件），没有任何机制能回答
// 「哪些地方假设了单用户」。本门禁把那份枚举变成可执行的登记簿。
//
// 【本门禁能保证什么 / 不能保证什么】——这条必须说清楚，否则它会制造虚假安全感：
//   能：已登记的假设点不漂移。假设点被重构掉而文档没跟（标记消失）→ 红；
//       代码里写了标记却没进登记簿（改立场时会漏掉它）→ 红。
//   不能：**发现新增的、未登记的 n=1 假设**。n=1 依赖没有语法特征——它不像
//       `rmSync(recursive:true)` 那样可被静态识别，一个新的全局单例在语法上与
//       任何普通模块级变量毫无区别。本脚本是登记簿的完整性闸，不是假设面的发现器。
//       新增假设点仍然只能靠 review 时想起来登记。
//
// 【与 safe-rm / safe-path 的关系】标记语法同款（`// 前缀: 理由`），但方向相反：
// 那两个是「危险模式已被发现，要求写豁免理由」，本门禁是「立场依赖无法被发现，要求主动登记」。
// 三种标记互不通用。
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const REGISTRY_DOC = 'docs/hard-rules.md';
// 扫描面 = 运行时源码两处，与 check-import-boundaries.js 的 SCAN_ROOTS 同口径。
const SCAN_ROOTS = ['src', 'public/js'];

const ID_RE = /N1-[A-Z0-9][A-Z0-9-]*/g;
// 代码标记：`// n1: N1-XXX 理由`。要求 ID 后跟空白 + 理由——只写 ID 不写理由的标记对
// 「改立场那天的人」没有价值，他需要知道这里假设了什么、放弃假设的后果是什么。
const MARKER_RE = /\/\/\s*n1:\s*(N1-[A-Z0-9][A-Z0-9-]*)\s+(\S.*)$/;

// 登记只认 §2 里的**表格行**（trim 后以 | 开头）。正文里的叙述性引用不算登记——
// 否则「文档里随口提一句某个 ID」就能让一个并不存在的标记通过门禁，登记簿失去意义。
export function extractRegisteredIds(text) {
  const ids = new Set();
  for (const line of text.split('\n')) {
    if (!line.trimStart().startsWith('|')) continue;
    for (const match of line.matchAll(ID_RE)) ids.add(match[0]);
  }
  return [...ids].sort();
}

function listSourceFiles(rootDir) {
  const files = [];
  const skip = new Set(['node_modules', '.git', 'data', '.ccm-uploads', 'vendor']);
  const visit = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!skip.has(entry.name)) visit(join(dir, entry.name));
      } else if (/\.(?:js|mjs)$/.test(entry.name)) {
        files.push(relative(rootDir, join(dir, entry.name)));
      }
    }
  };
  for (const root of SCAN_ROOTS) {
    try {
      visit(join(rootDir, root));
    } catch {
      // 扫描根不存在（如单测夹具只建了一侧）→ 跳过
    }
  }
  return files.sort();
}

export function collectMarkers(rootDir) {
  const markers = [];
  for (const rel of listSourceFiles(rootDir)) {
    readFileSync(join(rootDir, rel), 'utf8').split('\n').forEach((line, index) => {
      const match = line.match(MARKER_RE);
      if (match) markers.push({ id: match[1], file: rel, line: index + 1, note: match[2].trim() });
    });
  }
  return markers;
}

export function checkN1Assumptions({ rootDir = ROOT } = {}) {
  let registered;
  try {
    registered = extractRegisteredIds(readFileSync(join(rootDir, REGISTRY_DOC), 'utf8'));
  } catch {
    return {
      rootDir,
      registered: [],
      marked: [],
      markers: [],
      problems: [{
        code: 'n1_registry_missing',
        file: REGISTRY_DOC,
        message: `找不到登记簿 ${REGISTRY_DOC}——n=1 假设面的真相源缺失`,
      }],
    };
  }

  const markers = collectMarkers(rootDir);
  const markedSet = new Set(markers.map(m => m.id));
  const registeredSet = new Set(registered);
  const problems = [];

  for (const id of registered) {
    if (markedSet.has(id)) continue;
    problems.push({
      code: 'n1_marker_missing',
      id,
      file: REGISTRY_DOC,
      message: `${REGISTRY_DOC} 登记了 ${id}，但 ${SCAN_ROOTS.join(' / ')} 里找不到 \`// n1: ${id} …\` 标记`
        + '——假设点已被重构掉就从登记簿删除，标记被误删就补回去',
    });
  }

  for (const marker of markers) {
    if (registeredSet.has(marker.id)) continue;
    problems.push({
      code: 'n1_marker_unregistered',
      id: marker.id,
      file: marker.file,
      line: marker.line,
      message: `${marker.file}:${marker.line} 标了 ${marker.id}，但 ${REGISTRY_DOC} §2 的表格里没登记它`
        + '——没进登记簿的假设点，改 n=1 立场时会被漏掉',
    });
  }

  return { rootDir, registered, marked: [...markedSet].sort(), markers, problems };
}

export function formatN1Assumptions(result) {
  if (result.problems.length === 0) {
    return [
      'n=1 假设面 OK（登记簿 ⇔ 代码标记双向一致）',
      `登记: ${result.registered.length} 项 · 标记: ${result.markers.length} 处`,
      `root: ${relative(process.cwd(), result.rootDir) || '.'}`,
    ].join('\n');
  }
  return result.problems.map(problem => `[${problem.code}] ${problem.message}`).join('\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const result = checkN1Assumptions();
  const output = formatN1Assumptions(result);
  if (result.problems.length > 0) {
    console.error(output);
    process.exit(1);
  }
  console.log(output);
}
