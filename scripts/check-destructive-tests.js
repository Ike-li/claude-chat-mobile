#!/usr/bin/env node
// scripts/check-destructive-tests.js —— 测试里的递归删除，目标必须是一次性目录
//
// 【为什么有这条闸】2026-08-02 出过一次真实数据丢失：变异检查把 src/sessions/history.js 的
// getProjectDir 改成恒返回 ''，而 tests/unit/history-list.test.mjs 与
// tests/integration/session-delete.test.mjs 都在做
//     rmSync(join(<真实根>, getProjectDir(cwd)), { recursive: true, force: true })
// 路径当场塌成真实根本身，机主 70 个项目的 transcript 与 memory 一次删光（靠 APFS 快照恢复）。
//
// 当时补了两处护栏，但那只覆盖【已知的两处】——明天谁新写一个 rmSync(算出来的路径)，没有任何
// 东西会拦。这条闸把「只覆盖已知」变成「覆盖所有未来的」：
//
//   测试里的 recursive 删除，第一个参数必须【可追溯到 mkdtemp/tmpdir】。
//   确有理由删别处的，写一行 `// safe-rm: <理由>` 显式豁免——豁免要留痕、可审计，
//   而不是靠"大家都知道这里没问题"。
//
// 【判据为什么是 mkdtemp 而不是"路径看起来在 /tmp 下"】mkdtemp 保证目录是本进程刚建出来的、
// 名字随机、不可能撞上任何既有数据。而"看起来在 /tmp 下"是字符串判断，被测代码算歪之后
// 恰恰就不成立了——那正是这次事故的形态。判据必须锚在【来源】上，不能锚在【长相】上。
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { maskCodePositions } from './mutate.js';

const ROOT = join(import.meta.dirname, '..');
const SCAN_DIRS = ['tests'];
const SAFE_SOURCE = /\bmkdtemp(Sync)?\b|\btmpdir\s*\(/;
const EXEMPT_MARKER = /\/\/\s*safe-rm:\s*(.+)/;

// 递归收集测试目录下的 js/mjs
export function collectFiles(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { collectFiles(p, out); continue; }
    if (/\.(m?js)$/.test(e.name)) out.push(p);
  }
  return out;
}

// 收集「标识符 → 它可能的来源表达式们」。覆盖四种写法：
//   const/let X = <expr>      普通赋值
//   X = <expr>                再赋值
//   ARR.push(a, b)            数组累积（mirror-engine.test.mjs 的 ROOTS 就是这么攒的）
//   for (const d of <expr>)   循环变量继承被迭代对象的安全性
export function collectOrigins(source) {
  const origins = new Map();
  const add = (name, expr) => {
    if (!name) return;
    if (!origins.has(name)) origins.set(name, []);
    origins.get(name).push(expr);
  };
  for (const m of source.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]+)/g)) add(m[1], m[2]);
  for (const m of source.matchAll(/^\s*([A-Za-z_$][\w$]*)\s*=\s*([^;\n]+)/gm)) add(m[1], m[2]);
  for (const m of source.matchAll(/([A-Za-z_$][\w$]*)\.push\(([^)]*)\)/g)) {
    for (const arg of m[2].split(',')) add(m[1], arg.trim());
  }
  for (const m of source.matchAll(/for\s*\(\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s+of\s+([^)]+)\)/g)) add(m[1], m[2]);
  return origins;
}

// 收集「产出一次性目录的本地工厂函数」。本仓大量测试是 `const home = makeHome()` 这种写法，
// 工厂体里才是 mkdtempSync——不追这一跳就会把一堆完全安全的写法全报成违规，
// 那样的闸只会被加豁免注释绕过去，等于没有。
// 注意判据没有放松：仍然要求最终能追到 mkdtemp/tmpdir，只是允许中间隔一个本地函数。
export function collectSafeFactories(source) {
  const safe = new Set();
  const patterns = [
    /function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/g,
    /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>\s*\{/g,
  ];
  for (const re of patterns) {
    for (const m of source.matchAll(re)) {
      // 从函数体开头起截一段找 mkdtemp——按大括号配平取完整函数体
      const start = source.indexOf('{', m.index + m[0].length - 1);
      let depth = 0, end = start;
      for (let i = start; i < source.length; i += 1) {
        if (source[i] === '{') depth += 1;
        else if (source[i] === '}') { depth -= 1; if (depth === 0) { end = i; break; } }
      }
      if (SAFE_SOURCE.test(source.slice(start, end))) safe.add(m[1]);
    }
  }
  return safe;
}

// 按顶层逗号切分实参（括号/方括号内的逗号不算）
export function splitArgs(text) {
  const out = []; let depth = 0, cur = '';
  for (const ch of text) {
    if ('([{'.includes(ch)) depth += 1;
    else if (')]}'.includes(ch)) depth -= 1;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

// ★ 求一个路径表达式的【基目录】。这是本闸的核心判据，也是它一度判错的地方：
// join(A, B) 的实际位置由 A 决定，B 只是它下面的名字。早期实现用「表达式里出现过安全变量就放行」，
// 于是 join(PROJECTS_ROOT, getProjectDir(workDir)) 因为提到了 workDir 被判安全——而它其实在
// PROJECTS_ROOT 底下。那正是 2026-08-02 事故的确切形态，闸对它假绿等于白做。
export function pathBase(expr) {
  const e = String(expr).trim();
  const call = /^(?:join|resolve)\s*\(([\s\S]*)\)$/.exec(e);
  if (call) {
    const first = splitArgs(call[1])[0];
    return first ? pathBase(first) : e;
  }
  const tpl = /^`\$\{([^}]+)\}/.exec(e);
  if (tpl) return pathBase(tpl[1]);
  return e;
}

// 不动点传播：一个标识符安全，当且仅当它某个来源的【基目录】能追到 mkdtemp/tmpdir、
// 或追到另一个已知安全的标识符 / 工厂调用。
export function resolveSafeIdentifiers(origins, factories = new Set()) {
  const safe = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, exprs] of origins) {
      if (safe.has(name)) continue;
      if (exprs.some(e => isSafeExpr(e, safe, factories))) { safe.add(name); changed = true; }
    }
  }
  return safe;
}

export function isSafeExpr(expr, safe, factories) {
  const arr = /^\s*\[([\s\S]*)\]\s*$/.exec(String(expr).trim());
  if (arr) {
    const items = splitArgs(arr[1]);
    // 数组里只要有一项来路不明，循环变量就不算安全——宁可多问一句
    return items.length > 0 && items.every(it => isSafeExpr(it, safe, factories));
  }
  const base = pathBase(expr);
  if (SAFE_SOURCE.test(base)) return true;
  for (const f of factories) if (new RegExp('\\b' + f + '\\s*\\(').test(base)) return true;
  const id = /^([A-Za-z_$][\w$]*)(?:\.[\w$]+)*$/.exec(base)?.[1];
  return Boolean(id && safe.has(id));
}

// 找出递归删除调用。第一个实参必须按括号配平地取——早期用 [^,)]+ 取，
// 结果 rmSync(join(ROOT, name), {recursive:true}) 这种【整类】调用压根匹配不上，闸对它恒绿。
export function findDestructiveCalls(source) {
  const lines = source.split('\n');
  const calls = [];
  for (const m of source.matchAll(/\b(rmSync|rm)\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    let depth = 0, close = -1;
    for (let i = open; i < source.length; i += 1) {
      if ('([{'.includes(source[i])) depth += 1;
      else if (')]}'.includes(source[i])) { depth -= 1; if (depth === 0) { close = i; break; } }
    }
    if (close === -1) continue;
    const args = splitArgs(source.slice(open + 1, close));
    if (args.length < 2 || !/recursive\s*:\s*true/.test(args[1])) continue;
    const line = source.slice(0, m.index).split('\n').length;
    calls.push({ line, fn: m[1], arg: args[0], text: lines[line - 1]?.trim() ?? '' });
  }
  return calls;
}

// 字符串/模板串/注释里的 rmSync 是【文案不是调用】——本闸自己的测试文件里就存了一堆
// 故意写坏的样例当夹具，不屏蔽就会把自己的夹具报成违规。沿用 scripts/mutate.js 的
// maskCodePositions（agent-event-contract.js 也是这一路做法），把非代码位置填成空格：
// 长度与换行都保持不变，行号才不会错位。
export function stripNonCode(source) {
  const mask = maskCodePositions(source);
  let out = '';
  for (let i = 0; i < source.length; i += 1) {
    out += mask[i] || source[i] === '\n' ? source[i] : ' ';
  }
  return out;
}

export function checkFile(rawSource, relPath) {
  const source = stripNonCode(rawSource);
  const lines = rawSource.split('\n');
  const factories = collectSafeFactories(source);
  const safe = resolveSafeIdentifiers(collectOrigins(source), factories);
  const violations = [];
  for (const call of findDestructiveCalls(source)) {
    if (isSafeExpr(call.arg, safe, factories)) continue;
    // 豁免标记必须在【原文】里找——stripNonCode 会把注释抹成空格，在屏蔽后的文本里
    // 永远找不到 safe-rm，那样豁免机制等于不存在（本闸自己踩过这个坑）。
    // 向上逐行回看，只要还是注释行就继续找：理由常常写成好几行的注释块。
    if (isExempt(lines, call.line)) continue;
    violations.push({ file: relPath, line: call.line, arg: call.arg, text: call.text });
  }
  return violations;
}

// 从调用行开始向上找豁免标记：本行行尾注释，或紧邻其上的连续注释块内任意一行。
export function isExempt(lines, callLine) {
  if (EXEMPT_MARKER.test(lines[callLine - 1] ?? '')) return true;
  for (let i = callLine - 2; i >= 0; i -= 1) {
    const text = (lines[i] ?? '').trim();
    if (!text.startsWith('//')) break;      // 越过注释块就停，不无限上溯
    if (EXEMPT_MARKER.test(text)) return true;
  }
  return false;
}

function main() {
  const files = SCAN_DIRS.flatMap(d => {
    const p = join(ROOT, d);
    try { statSync(p); } catch { return []; }
    return collectFiles(p);
  });
  const all = [];
  for (const file of files) {
    all.push(...checkFile(readFileSync(file, 'utf8'), relative(ROOT, file)));
  }
  if (all.length === 0) {
    console.log(`✅ 破坏性删除检查：${files.length} 个测试文件，递归删除目标全部可追溯到一次性目录`);
    return;
  }
  console.error('❌ 破坏性删除检查未通过：以下递归删除的目标无法追溯到 mkdtemp/tmpdir\n');
  for (const v of all) {
    console.error(`  ${v.file}:${v.line}`);
    console.error(`      ${v.text}`);
    console.error(`      删除目标「${v.arg}」来路不明——它可能被算成任意路径（含真实数据目录）。`);
  }
  console.error('\n改法二选一：');
  console.error('  ① 让删除目标来自 mkdtemp/tmpdir（首选——从根上不可能炸到真实数据）');
  console.error('  ② 确有理由删别处：在该行或上一行写 `// safe-rm: <理由>` 显式豁免，');
  console.error('     并在删除点加护栏（如 resolve(d) === resolve(ROOT) 就抛错）。');
  console.error('\n背景：2026-08-02 正是这种形态删掉了机主 70 个项目的 transcript 与 memory。');
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) main();
