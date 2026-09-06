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
//   ③ README 登记表首列的每个编号，在 tests/ 树里至少被提到一次——不再有死条目。
//      反向这半故意放宽到整棵 tests/ 树而不是只看「守护：」行：有些不变量由门禁守而非用例守
//      （PROTO-01 在 contract-check.js，TEST-01 在 check-destructive-deletes.js），
//      那些门禁的头注里写了编号，链接同样闭合。
//
// 【它不保证什么】——说清楚，否则会制造虚假安全感：
//   不保证「守护：」行声明的那条红线【真的被断言守住了】。编号是索引不是证据；
//   一个文件完全可以声明守护 APPROVAL-01 却一条相关断言都没有（2026-09-05 的
//   file-preview.test.mjs 正是如此：文件头声称守 FILES-3 与魔数识别，变异实测两者零断言）。
//   验断言有没有咬住只有一个办法：注入缺陷看它红不红（见 docs/testing.md §3）。
//
// 【为什么登记面只认表格首列】README 正文里有占位写法（`SRV-00N` / `BE-0NN` 这种带 N 的模板）
// 与内嵌在描述里的旧编号。拿正则扫全文会把占位符当成真编号，反向检查随即误报。
// 首列是结构化的，不会有这种噪音；而正向检查用全文包含即可（内嵌的旧编号也算登记过）。
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
const ID_RE = /\b([A-Z]+-\d+)\b/g;
// 登记表首列：`| \`AUTH-01\` | …`
const REGISTRY_ROW_RE = /^\|\s*`([A-Z]+-\d+)`/gm;

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
    const guardLine = head.find(line => line.startsWith(GUARD_PREFIX));
    if (!guardLine) {
      problems.push({
        code: 'missing_guard_line',
        file: rel,
        message: `${rel} 头部没有 "${GUARD_PREFIX}XXX-NN" 行——`
          + `放进 ${GUARDED_DIR}/ 就意味着它守着一条登记过的红线；只是普通模块回归的话应该写在 tests/unit/`,
      });
      continue;
    }
    const ids = [...guardLine.matchAll(ID_RE)].map(m => m[1]);
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

  // 反向：登记了却没人提。扫整棵 tests/ 树——有些不变量由门禁守而非用例守。
  const corpus = listFiles(rootDir, CORPUS_DIR, name => /\.(mjs|ts|js)$/.test(name))
    .map(rel => readFileSync(join(rootDir, rel), 'utf8'))
    .join('\n');
  for (const id of listed) {
    if (corpus.includes(id)) continue;
    problems.push({
      code: 'dead_registry_entry',
      id,
      message: `${REGISTRY_DOC} 登记了 ${id}，但整个 ${CORPUS_DIR}/ 树里没有任何文件提到它——`
        + `要么补上守护它的用例/门禁（并在那里写上编号），要么从登记表里删掉。`
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
