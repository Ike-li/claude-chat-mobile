#!/usr/bin/env node
// tests/gates/check-destructive-deletes.js —— 测试里的递归删除，目标必须是一次性目录
//
// 【为什么有这条闸】2026-08-02 出过一次真实数据丢失：变异检查把 app/src/sessions/history.js 的
// getProjectDir 改成恒返回 ''，而 tests/unit/history-list.test.mjs 与
// tests/integration/session-delete.test.mjs 都在做
//     rmSync(join(<真实根>, getProjectDir(cwd)), { recursive: true, force: true })
// 路径当场塌成真实根本身，70 个项目的 transcript 与 memory 一次删光（靠 APFS 快照恢复）。
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

const ROOT = join(import.meta.dirname, '..', '..');
const TEST_DIRS = ['tests'];
const SRC_DIRS = ['app/src', 'scripts'];
const SRC_FILES = ['app/server.js'];
const SAFE_SOURCE = /\bmkdtemp(Sync)?\b|\btmpdir\s*\(/;
// ★ 两条规则用【两种】标记，不能共用一个。
// 第一版共用 safe-rm，结果为「单文件删除、目录段算出来」写的豁免，把同一行改成
// rmSync(recursive) 之后照样放行——负向验证当场抓到：那张纸条成了永久通行证。
// 豁免必须绑定到"当初批准的是哪件事"上：批的是有界的单文件删除，就不该覆盖无界的递归删除。
const EXEMPT_MARKER = /\/\/\s*safe-rm:\s*(.+)/;          // 递归删除的豁免
const PATH_EXEMPT_MARKER = /\/\/\s*safe-path:\s*(.+)/;   // 「目录段由代码算出」的豁免

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

// 扫出所有匹配 headRe 的调用，并按【括号配平】取出实参区间。三条规则（递归删除 / shell 删除 /
// 单文件删除）共用这一个走法。
//
// 为什么必须共用：配平这件事本身就修过一次真 bug —— 早期用 [^,)]+ 取第一个实参，
// rmSync(join(ROOT, name), {recursive:true}) 这【整类】调用压根匹配不上，闸对它恒绿。
// 三份逐字节相同的拷贝意味着下一次修只会落到一处，另外两条规则继续失效，而这个闸的
// 失效方式恰恰是「静默放行」。
function* balancedCalls(scanSource, headRe) {
  for (const m of scanSource.matchAll(headRe)) {
    const open = m.index + m[0].length - 1;
    let depth = 0, close = -1;
    for (let i = open; i < scanSource.length; i += 1) {
      if ('([{'.includes(scanSource[i])) depth += 1;
      else if (')]}'.includes(scanSource[i])) { depth -= 1; if (depth === 0) { close = i; break; } }
    }
    if (close === -1) continue;                        // 截断/不配平 → 跳过，不猜
    yield { index: m.index, fn: m[1], open, close };
  }
}

// 行号：按调用头之前的换行数算（三处规则同一算法）。
const lineAt = (source, index) => source.slice(0, index).split('\n').length;

// 找出递归删除调用。
// rmdirSync/rmdir 带 recursive:true 与 rmSync 删除力等价（deprecated 但可用）——不列进来
// 谁用它就整条绕过门禁（2026-08-03 review 抓出的扫描面缺口）。非递归 rmdir 只能删空目录，
// 破坏力有界，仍由下方 recursive:true 判据自然排除。
export function findDestructiveCalls(source) {
  const lines = source.split('\n');
  const calls = [];
  for (const { index, fn, open, close } of balancedCalls(source, /\b(rmSync|rm|rmdirSync|rmdir)\s*\(/g)) {
    const args = splitArgs(source.slice(open + 1, close));
    if (args.length < 2 || !/recursive\s*:\s*true/.test(args[1])) continue;
    const line = lineAt(source, index);
    calls.push({ line, fn, arg: args[0], text: lines[line - 1]?.trim() ?? '' });
  }
  return calls;
}

// shell 层删除（execSync('rm -rf …') 一族）完全绕过 fs 层扫描，且它的删除目标就在字符串参数里、
// 会被 stripNonCode 抹掉——必须单独在【原文】上查。防套娃误报的关键：调用头（exec*( ）从
// 【掩码后】文本找（测试夹具里写在模板串中的样例，其 execSync 头也被抹掉，天然不命中），
// 参数区间按掩码文本括号配平后回【原文】同区间查 `rm -r…`。shell 删除天然追溯不到 mkdtemp，
// 一律要求 `// safe-rm: <理由>` 显式豁免。
// 递归开关：-r / -R / -rf / -fr / --recursive。大小写都要认——-R 是 macOS rm(1) 首先
// 文档化的写法；`[A-Za-z]*` 吃不掉第二个 `-`，所以长形式必须单列一支。
const RECURSIVE_FLAG = '(?:-[A-Za-z]*[rR]|--recursive)';
// 递归开关【不一定紧跟 rm】：`rm -f -r`、`rm --force --recursive`、`rm -v -rf`、`rm -i -R`
// 全是合法写法，而旧判据 `rm\s+RECURSIVE_FLAG` 只认紧跟其后的那一个开关，上述四种一律零违规
// （2026-08-05 探针逐条确认）。这类调用又追溯不到 fs.rm* 扫描，等于 safe-rm 门禁的完整旁路。
// 改成扫完整个选项区：`-[\w=-]+` 只吃 `-` 开头的 token（`=` 是为 `--interactive=never` 这类
// 带值长选项留的），碰到第一个非选项 token 就停。这个边界同时就是防跨命令误报的机制——
// `rm -f a && tar -rf b` 里 `a` 终止了 rm 的选项区，属于 tar 的 `-rf` 不会被算到 rm 头上；
// `;` `|` `&&` 同理，不必逐个枚举分隔符。
// 【残余风险】GNU 允许操作数写在选项前（`rm dir -rf`），本判据不覆盖：要认它就得让扫描越过
// 非选项 token，跨命令误报会立刻回来。真实代码里几乎不这么写，权衡后留口，勿当已覆盖。
const RM_OPTION = '-[\\w=-]+';
const SHELL_RM_RECURSIVE = new RegExp(`\\brm\\s+(?:${RM_OPTION}\\s+)*${RECURSIVE_FLAG}`);
// 形态二：argv 数组。`spawnSync('rm', ['-rf', x])`——命令名与开关分处两个实参，中间隔着
// 引号和方括号，形态一的 `rm\s+` 永远匹配不到。而 execFileSync/execFile/spawnSync/spawn
// 【只收】这种形态，旧判据下它们是扫描名单里的死条目（2026-08-04 实测确认）。
const ARGV_RM_RECURSIVE = new RegExp(`(['"\`])(?:[\\w./-]*/)?rm\\1\\s*,\\s*\\[[^\\]]*${RECURSIVE_FLAG}`);

export function findShellDeletes(maskedSource, rawSource) {
  const lines = rawSource.split('\n');
  const calls = [];
  const headRe = /\b(execSync|execFileSync|exec|execFile|spawnSync|spawn)\s*\(/g;
  for (const { index, fn, open, close } of balancedCalls(maskedSource, headRe)) {
    const rawArgs = rawSource.slice(open + 1, close);   // 区间来自掩码文本，内容回原文取
    // 只盯递归形态；非递归 rm 归下方单文件规则管，破坏力有界。
    if (!SHELL_RM_RECURSIVE.test(rawArgs) && !ARGV_RM_RECURSIVE.test(rawArgs)) continue;
    const line = lineAt(maskedSource, index);
    calls.push({ line, fn, arg: rawArgs.trim().slice(0, 80), text: lines[line - 1]?.trim() ?? '' });
  }
  return calls;
}

// 字符串/模板串/注释里的 rmSync 是【文案不是调用】——本闸自己的测试文件里就存了一堆
// 故意写坏的样例当夹具，不屏蔽就会把自己的夹具报成违规。沿用 tests/gates/mutate.js 的
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
  for (const call of findShellDeletes(source, rawSource)) {
    if (isExempt(lines, call.line)) continue;
    violations.push({ file: relPath, line: call.line, arg: call.arg, text: call.text });
  }
  return violations;
}

// 从调用行开始向上找豁免标记：本行行尾注释，或紧邻其上的连续注释块内任意一行。
export function isExempt(lines, callLine, marker = EXEMPT_MARKER) {
  if (marker.test(lines[callLine - 1] ?? '')) return true;
  for (let i = callLine - 2; i >= 0; i -= 1) {
    const text = (lines[i] ?? '').trim();
    if (!text.startsWith('//')) break;      // 越过注释块就停，不无限上溯
    if (marker.test(text)) return true;
  }
  return false;
}

// 单文件删除（unlinkSync / 不带 recursive 的 rm）。它删不动整棵树，所以【不是】必须报的东西——
// 但如果它的路径「追不到一次性目录」（⇒ 按真实数据处理）「且目录段是代码算出来的」，那就是事故形态
// 的哑火版本：今天无害只因为恰好用的是 unlinkSync，哪天为了删子目录改成 rmSync(recursive) 就地变成实弹。
// 要求写一行 safe-path 说明，等于强制在改成 recursive 之前先看见这条注释。
export function findSingleFileDeletes(source) {
  const lines = source.split('\n');
  const calls = [];
  for (const { index, fn, open, close } of balancedCalls(source, /\b(unlinkSync|unlink|rmSync|rm)\s*\(/g)) {
    const args = splitArgs(source.slice(open + 1, close));
    if (args.length > 1 && /recursive\s*:\s*true/.test(args[1])) continue; // 递归的归上一条规则管
    const line = lineAt(source, index);
    calls.push({ line, fn, arg: args[0] ?? '', text: lines[line - 1]?.trim() ?? '' });
  }
  return calls;
}

// 把「裸标识符」展开成它真正的路径表达式：unlinkSync(file) 里的 file，其 join(...) 写在赋值那行。
// 第一版忘了这一跳，于是对 app.js 那个正是事故形态的调用点【零命中】——闸看着全绿其实什么都没查。
export function resolvePathExpr(expr, origins, depth = 0) {
  const e = String(expr).trim();
  if (depth > 4) return e;
  if (!/^[A-Za-z_$][\w$]*$/.test(e)) return e;
  const srcs = origins.get(e);
  if (!srcs || srcs.length === 0) return e;
  // 多个赋值点时取第一个用于展示；判定走 resolveAll。
  return resolvePathExpr(srcs[0], origins, depth + 1);
}

// 一个标识符在大文件里常有多个赋值点（app.js 的 projectDir 就是）。判"是不是代码算出来的"
// 必须看【全部】来源——只看唯一来源的写法会在真实代码上直接失效（第一版就是这么漏掉 app.js 的）。
export function resolveAllOrigins(expr, origins, depth = 0, seen = new Set()) {
  const e = String(expr).trim();
  if (depth > 4 || seen.has(e)) return [e];
  seen.add(e);
  if (!/^[A-Za-z_$][\w$]*$/.test(e)) return [e];
  const srcs = origins.get(e);
  if (!srcs || srcs.length === 0) return [e];
  return srcs.flatMap(src => resolveAllOrigins(src, origins, depth + 1, seen));
}

export function checkSourceFile(rawSource, relPath) {
  const source = stripNonCode(rawSource);
  const lines = rawSource.split('\n');
  const violations = [];
  // ★ 调用点从【屏蔽后】的文本找（注释里的示例不算调用），但路径表达式要从【原文】取：
  // stripNonCode 会把模板串连同 `${worktreeSettingsKeyFor(cwd)}` 这样的插值一起抹成空格，
  // 而插值里正是"代码算出来的那一段"。在屏蔽后的文本上分析路径 = 把要找的东西先删掉了。

  // 规则一：生产代码里的 recursive 删除，判据与测试一致（可追溯到一次性目录，或显式豁免）。
  violations.push(...checkFile(rawSource, relPath));

  // 规则二：单文件删除，路径「追不到一次性目录」+「目录段由代码算出」→ 要 safe-path 说明。
  // 注意判据里【没有】"基目录必须来自 homedir()"这一维：一度写过一个 collectRealRootIdentifiers
  // 来判它，但那个函数从未被接进来（2026-08-03 review 抓出，已删）。现在的判据是"追不到一次性
  // 目录就按真实数据处理"——比 homedir() 那版更宽（DATA_DIR 下的删除也会被看住），不是漏网。
  const origins = collectOrigins(rawSource);
  const factories = collectSafeFactories(rawSource);
  const tempSafe = resolveSafeIdentifiers(origins, factories);
  for (const call of findSingleFileDeletes(source)) {
    const expr = resolvePathExpr(call.arg, origins);
    // 追得到一次性目录 ⇒ 不是真实数据，跳过；追不到 ⇒ 按真实数据处理。
    if (isSafeExpr(expr, tempSafe, factories)) continue;
    // ★ 只看【目录段】被算出来的情况，不看文件名段。这个区分是本规则的全部价值所在：
    //   join(根, 算出来的目录, '固定名')  ← 目录段塌掉 ⇒ 打到【另一个目录】，正是事故形态
    //   join(根, 固定目录, `${算出来的名字}`) ← 只是同目录下删错一个名字，代价有界
    // 实测本仓 12 处生产删除里，只有前者 1 处；不做这个区分会一次报 10 处，
    // 而那 10 处全是"删自己刚建的临时文件"——规则一吵，标记就会被反射性地加上，从此不再有意义。
    //
    // 「算出来」也不限于字面上的函数调用：projectDir 是裸标识符、真正的 getProjectDir(cwd) 写在它
    // 的赋值里；模板串 `${f(x)}` 的调用藏在插值里。都要展开后再判，且一个标识符可能有多个赋值点。
    const segments = splitArgs((/^(?:join|resolve)\s*\(([\s\S]*)\)$/.exec(expr.trim())?.[1]) ?? '');
    const dirSegments = segments.slice(1, -1); // 去掉基目录与最后的文件名段
    const hasComputedSegment = dirSegments.some(seg =>
      /\$\{[^}]*\(/.test(seg)
      || resolveAllOrigins(seg, origins).some(r => /[A-Za-z_$][\w$]*\s*\(/.test(r)));
    if (!hasComputedSegment) continue;
    if (isExempt(lines, call.line, PATH_EXEMPT_MARKER)) continue;
    violations.push({
      file: relPath, line: call.line, arg: expr, text: call.text,
      kind: 'computed-under-real-root',
    });
  }
  return violations;
}

function main() {
  const gather = dirs => dirs.flatMap(d => {
    const p = join(ROOT, d);
    try { statSync(p); } catch { return []; }
    return collectFiles(p);
  });
  const testFiles = gather(TEST_DIRS);
  const srcFiles = [...gather(SRC_DIRS), ...SRC_FILES.map(f => join(ROOT, f)).filter(f => { try { statSync(f); return true; } catch { return false; } })];
  const all = [];
  for (const file of testFiles) {
    all.push(...checkFile(readFileSync(file, 'utf8'), relative(ROOT, file)));
  }
  for (const file of srcFiles) {
    all.push(...checkSourceFile(readFileSync(file, 'utf8'), relative(ROOT, file)));
  }
  if (all.length === 0) {
    console.log(`✅ 破坏性删除检查：${testFiles.length} 个测试文件 + ${srcFiles.length} 个生产文件，`
      + '递归删除目标全部可追溯到一次性目录');
    return;
  }
  const recursive = all.filter(v => v.kind !== 'computed-under-real-root');
  const computed = all.filter(v => v.kind === 'computed-under-real-root');

  if (recursive.length) {
    console.error('❌ 递归删除的目标无法追溯到一次性目录：\n');
    for (const v of recursive) {
      console.error(`  ${v.file}:${v.line}`);
      console.error(`      ${v.text}`);
      console.error(`      删除目标「${v.arg}」来路不明——它可能被算成任意路径（含真实数据目录）。`);
    }
    console.error('\n  改法二选一：');
    console.error('    ① 让删除目标来自 mkdtemp/tmpdir（首选——从根上不可能炸到真实数据）');
    console.error('    ② 确有理由删别处：写 `// safe-rm: <理由>` 显式豁免，并在删除点加护栏');
    console.error('       （如 resolve(d) === resolve(ROOT) 就抛错）。\n');
  }

  if (computed.length) {
    console.error('❌ 追不到一次性目录、且【目录段由代码算出】的删除，需要显式说明：\n');
    for (const v of computed) {
      console.error(`  ${v.file}:${v.line}`);
      console.error(`      ${v.text}`);
      console.error(`      路径「${v.arg}」里有一段目录是代码算出来的。`);
      console.error('      那一段一旦算成空串，删除就打到【另一个目录】上去了。');
    }
    console.error('\n  这类调用【今天多半是安全的】——单文件删除代价有界。要求写一行');
    console.error('  `// safe-path: <为什么这段目录不会算错 / 算错了为什么无害>`，');
    console.error('  是为了让下一个把它改成 rmSync(recursive) 的人先看见这句话：');
    console.error('  2026-08-02 删掉 70 个项目的，就是同一个形态的递归版本。\n');
  }
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) main();
