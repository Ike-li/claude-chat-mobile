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
//       代码里写了标记却没进登记簿（改立场时会漏掉它）→ 红；
//       写了 `// n1:` 但格式不合（缺理由 / ID 不规范）→ 红，不静默当成「没有标记」。
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

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const REGISTRY_DOC = 'docs/hard-rules.md';
// 扫描面 = 运行时源码，与 check-import-boundaries.js 的 SCAN_ROOTS + EXTRA_FILES 同口径
// （app/server.js 今天只有几行，但它是运行时入口，将来放进状态就该能登记；漏掉它会让那个位置
//   「登记就红、不登记也红」两头堵）。scripts/ 与 tests/ 不在面内：那里没有产品状态。
const SCAN_ROOTS = ['app/src', 'app/public/js'];
const SCAN_EXTRA_FILES = ['app/server.js'];

const ID_RE = /N1-[A-Z0-9][A-Z0-9-]*/g;
// 标记识别分两步，故意不合成一条正则：
//   第一步认出「这是一条 n1 标记」（任何 `// n1:` 开头），第二步校验形态。
// 合成一条的写法会让【格式不合的标记被当成「这里没有标记」静默放行】——那正好漏在本门禁
// 最想守住的边上：有人写 `// n1: N1-NEWTHING` 忘了写理由且没登记，双向校验会全绿。
// （2026-08-15 独立审查实测复现，见 tests/unit/check-n1-assumptions.test.mjs。）
// 理由是强制的：只写 ID 不写理由，对「改立场那天的人」没有价值——他需要知道这里假设了
// 什么、放弃假设的后果是什么。
const MARKER_LINE_RE = /\/\/\s*n1:\s*(.*)$/;
const MARKER_BODY_RE = /^(N1-[A-Z0-9][A-Z0-9-]*)\s+(\S.*)$/;

// 登记只认**表格行**（trim 后以 | 开头）。正文里的叙述性引用不算登记——否则「文档里随口
// 提一句某个 ID」就能让一个并不存在的标记通过门禁，登记簿失去意义。
// 注意扫的是整份 hard-rules 的表格行、不限 §2：限定章节要解析标题层级，脆弱且收益为零
// （登记表放在哪一节都该算数）。文案里说「§2」是因为今天所有 N1-* 都在那儿。
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
  for (const extra of SCAN_EXTRA_FILES) {
    try {
      readFileSync(join(rootDir, extra));
      files.push(extra);
    } catch {
      // 可选文件缺失 → 跳过
    }
  }
  return files.sort();
}

// 返回 { markers, malformed }：格式不合的单列出来报错，不并进 markers 也不静默丢弃。
export function collectMarkers(rootDir) {
  const markers = [];
  const malformed = [];
  for (const rel of listSourceFiles(rootDir)) {
    readFileSync(join(rootDir, rel), 'utf8').split('\n').forEach((line, index) => {
      const hit = line.match(MARKER_LINE_RE);
      if (!hit) return;
      const body = hit[1].trim();
      const parsed = body.match(MARKER_BODY_RE);
      if (parsed) markers.push({ id: parsed[1], file: rel, line: index + 1, note: parsed[2].trim() });
      else malformed.push({ file: rel, line: index + 1, text: body });
    });
  }
  return { markers, malformed };
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

  const { markers, malformed } = collectMarkers(rootDir);
  const markedSet = new Set(markers.map(m => m.id));
  const registeredSet = new Set(registered);
  const problems = [];

  for (const bad of malformed) {
    problems.push({
      code: 'n1_marker_malformed',
      file: bad.file,
      line: bad.line,
      message: `${bad.file}:${bad.line} 的 n1 标记格式不合「// n1: N1-ID 理由」：\`${bad.text}\``
        + '——ID 须大写 N1- 开头，且必须写理由（改立场那天的人要靠它判断放弃假设的后果）',
    });
  }

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
