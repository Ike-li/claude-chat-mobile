#!/usr/bin/env node
// tests/gates/check-invariant-ids.js —— 不变量编号 ⇔ 登记表，双向必须闭合。
//
// 【为什么有这条闸】2026-09-05 之前，`// 守护：SRV-003` 这类编号在 tests/ 里被引用 100+ 次，
// 而定义只存在于一份 gitignored 的草稿里——仓库内零定义。对任何没参与过那次会话的人
// （包括三个月后的自己），那就是一串噪音。同一次清理还发现 `AUTH-001` 这个孤例笔误
// （其余都是 AUTH-01..04），以及编号写了却没人守的死条目。
//
// 这三种失效有个共同点：**不会让任何测试变红**。它们只会慢慢烂掉，直到编号体系整体失去可信度，
// 然后下一个人开始无视文件头的「守护：」行——那时这套按不变量组织测试的方式就真的死了。
//
// 【它保证什么】
//   ① tests/invariants/ 下每个用例文件都有 `// 守护：` 行——写这个文件时做过「守哪条」的判断。
//   ② 「守护：」行引用的每个编号，在 tests/README.md 里查得到——不再有悬空引用。
//   ③ README 登记表首列的每个编号，在 tests/ 树里至少有一处规范的「守护：」声明行——
//      不再有死条目。反向这半扫的是整棵 tests/ 树（不限 GUARDED_DIR）：有些不变量由
//      门禁守而非用例守（PROTO-01 在 contract-check.js，TEST-01 在
//      check-destructive-deletes.js），只要它们头部也有「守护：」行，链接同样闭合。
//      【2026-09 收紧】此前这半是"登记表 ID 在 tests/ 树任意文件的任意位置被提及即算数"
//      的纯子串匹配——不要求「守护：」行格式。一个编号只要在某处的散文里被写死过，
//      即使守护它的用例早被删光，反向检查也会一直放行，是本闸最想堵住的那类恒绿。
//      现在两个方向统一只认「守护：」声明行。
//
// 【它不保证什么】——说清楚，否则会制造虚假安全感：
//   不保证「守护：」行声明的那条红线【真的被断言守住了】。编号是索引不是证据；
//   一个文件完全可以声明守护 APPROVAL-01 却一条相关断言都没有（2026-09-05 的
//   file-preview.test.mjs 正是如此：文件头声称守 FILES-3 与魔数识别，变异实测两者零断言）。
//   验断言有没有咬住只有一个办法：注入缺陷看它红不红（见 docs/testing.md §3）。
//
// 【为什么正向登记面只认表格首列】README 正文里有占位写法（`SRV-00N` / `BE-0NN` 这种带 N
// 的模板）与内嵌在描述里的旧编号。拿正则扫全文会把占位符当成真编号，反向检查随即误报。
// 首列是结构化的，不会有这种噪音；而正向检查（守护行→登记表）用全文包含即可，
// README 正文里叙述性提到某个编号也算「查得到」——那半是「有没有定义」，不是「有没有守护」。
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const REGISTRY_DOC = 'tests/README.md';
const GUARDED_DIR = 'tests/invariants';
const CORPUS_DIR = 'tests';
const GUARD_PREFIX = '// 守护：';
// 只在文件头找「守护：」行。正文里出现同样的字样是叙述，不是声明。
const HEAD_LINES = 12;
// [A-Z]+(?:-[A-Z]+)* 吃掉像 SRV-NEW-004 这类【多段】复合编号的全部大写段——旧写法
// [A-Z]+-\d+ 不含连字符，对 "SRV-NEW-004" 只会从 "NEW" 处第一次同时满足 \b 与 [A-Z]+-\d+，
// 匹配出被截断的 "NEW-004"，报错时给的 id 是错的、对着登记表怎么查都查不到。
const ID_RE = /\b([A-Z]+(?:-[A-Z]+)*-\d+)\b/g;
// 登记表首列：`| \`AUTH-01\` | …`
const REGISTRY_ROW_RE = /^\|\s*`([A-Z]+(?:-[A-Z]+)*-\d+)`/gm;

// 本门禁自身：头注里用叙述性文字反复提到"守护："这个词（如「文件头的「守护：」行」），
// 但那些行不以 GUARD_PREFIX 开头，不会被下面的判据误判——排除它只是防御性的，真正的
// 自引用风险在 tests/unit/check-invariant-ids.test.mjs 的测试夹具字符串（拼出过
// "// 守护：AUTH-01" 这样的样本文本）。两个都排除，消除自满足回路：一个不再被任何真实
// 用例/门禁守护的编号，不该只因为这道闸自己的源码或测试夹具里出现过同名字符串就被判定
// "仍有人提及"。
export const SELF_FILES = new Set(['tests/gates/check-invariant-ids.js', 'tests/unit/check-invariant-ids.test.mjs']);

/** 文件头部行数组里的「守护：」声明 ID 列表；没有守护行返回 null（区别于"有守护行但零 ID"）。 */
function extractGuardIds(headLines) {
  const guardLine = headLines.find(line => line.startsWith(GUARD_PREFIX));
  if (!guardLine) return null;
  return [...guardLine.matchAll(ID_RE)].map(m => m[1]);
}

function listFiles(rootDir, dir, filter) {
  const out = [];
  const walk = (relDir) => {
    let entries;
    try { entries = readdirSync(join(rootDir, relDir), { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const rel = join(relDir, entry.name);
      if (entry.isDirectory()) walk(rel);
      else if (filter(entry.name)) out.push(rel);
    }
  };
  walk(dir);
  return out.sort();
}

export function checkInvariantIds({ rootDir = ROOT } = {}) {
  const problems = [];
  let registryText;
  try {
    registryText = readFileSync(join(rootDir, REGISTRY_DOC), 'utf8');
  } catch {
    // 登记表读不到时绝不能当成「没有问题」——那正是扫描面塌掉的形态。
    return { ok: false, rootDir, listed: [], guarded: [], problems: [{
      code: 'registry_missing',
      message: `${REGISTRY_DOC} 读不到——编号登记表是本闸的判据，缺了它任何结论都不成立`,
    }] };
  }

  const listed = [...registryText.matchAll(REGISTRY_ROW_RE)].map(m => m[1]);
  const guardedFiles = listFiles(rootDir, GUARDED_DIR, name => name.endsWith('.test.mjs'));

  if (guardedFiles.length === 0) {
    return { ok: false, rootDir, listed, guarded: [], problems: [{
      code: 'scan_empty',
      message: `${GUARDED_DIR}/ 下扫不到任何用例文件——扫描面塌了，不是「全部合规」`,
    }] };
  }

  const used = new Map();
  for (const rel of guardedFiles) {
    const head = readFileSync(join(rootDir, rel), 'utf8').split('\n').slice(0, HEAD_LINES);
    const ids = extractGuardIds(head);
    if (ids === null) {
      problems.push({
        code: 'missing_guard_line',
        file: rel,
        message: `${rel} 头部没有 "${GUARD_PREFIX}XXX-NN" 行——`
          + `放进 ${GUARDED_DIR}/ 就意味着它守着一条登记过的红线；只是普通模块回归的话应该写在 tests/unit/`,
      });
      continue;
    }
    if (ids.length === 0) {
      problems.push({
        code: 'guard_line_without_id',
        file: rel,
        message: `${rel} 的「守护：」行里没有编号（形如 AUTH-01）——`
          + `散文说明不能替代编号，编号才是跨文件把同一条红线串起来的东西`,
      });
      continue;
    }
    for (const id of ids) {
      if (!used.has(id)) used.set(id, []);
      used.get(id).push(rel);
      if (!registryText.includes(id)) {
        problems.push({
          code: 'unregistered_id',
          file: rel,
          id,
          message: `${rel} 守护 ${id}，但 ${REGISTRY_DOC} 里查不到它——`
            + `悬空编号对读者等于噪音。先把它写进登记表（说清这条红线是什么），再引用`,
        });
      }
    }
  }

  // 反向：登记了却没有任何规范的「守护：」声明行引用过。扫整棵 tests/ 树（不限 GUARDED_DIR）——
  // 有些不变量由门禁守而非用例守（PROTO-01 在 contract-check.js，TEST-01 在
  // check-destructive-deletes.js），只要它们头部也有「守护：」行就算数。不要求 .test.mjs 后缀
  // （门禁脚本不是测试文件），但仍要求规范声明格式——任意位置的散文提及不算，那正是此前
  // 这半判据的漏洞（见文件头「2026-09 收紧」注）。
  const allGuardedIds = new Set();
  for (const rel of listFiles(rootDir, CORPUS_DIR, name => /\.(mjs|ts|js)$/.test(name))) {
    if (SELF_FILES.has(rel)) continue;
    const head = readFileSync(join(rootDir, rel), 'utf8').split('\n').slice(0, HEAD_LINES);
    const ids = extractGuardIds(head);
    if (ids) for (const id of ids) allGuardedIds.add(id);
  }
  for (const id of listed) {
    if (allGuardedIds.has(id)) continue;
    problems.push({
      code: 'dead_registry_entry',
      id,
      message: `${REGISTRY_DOC} 登记了 ${id}，但 ${CORPUS_DIR}/ 树里没有任何文件的「守护：」行引用它——`
        + `要么补上守护它的用例/门禁（并在文件头写上「守护：${id}」），要么从登记表里删掉。`
        + `留着 = 登记表在声称一条其实没人守的红线`,
    });
  }

  return { ok: problems.length === 0, rootDir, listed, guarded: [...used.keys()].sort(), problems };
}

export function formatInvariantIds(result) {
  if (result.ok) {
    return [
      '不变量编号 OK（登记表 ⇔ 守护行双向闭合）',
      `登记: ${result.listed.length} 条 · 被守护行引用: ${result.guarded.length} 条`,
      `root: ${relative(process.cwd(), result.rootDir) || '.'}`,
    ].join('\n');
  }
  return result.problems.map(p => `[${p.code}] ${p.message}`).join('\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const result = checkInvariantIds();
  const output = formatInvariantIds(result);
  if (!result.ok) {
    console.error(output);
    process.exit(1);
  }
  console.log(output);
}
