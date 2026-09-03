#!/usr/bin/env node
// tests/gates/mutate.js —— 变异检查：按需、单文件、看「测试会不会开口」
//
// 用法：npm run mutate -- app/src/server/mirror-engine.js [--lines=200-260] [--tests a.test.mjs,b.test.mjs] [--limit N]
//
// ⚠️ 跑的期间会反复改写目标源文件，别和 npm test / npm run check 并行跑（会读到变异态）。
//
// 【为什么要有它】覆盖率回答的是「这行被执行过吗」，回答不了「这行错了会有人吭声吗」。两者差得很远：
// 2026-08-02 给 mirror-engine 补的 19 个用例首轮全绿，跑变异后抓出 2 条【真空过】——把被测的防线整个
// 删掉，用例照样绿。给既有代码补的测试默认就是空过的，因为你是照着现状写的断言。
// 所以「写完跑一遍是绿的」什么都证明不了，唯一靠得住的验收是：故意把代码弄坏，看测试红不红。
//
// 【为什么只变异被覆盖到的行】没被执行的行必然存活，那是覆盖率早就告诉过你的事，重复报一遍是噪音。
// 限定在覆盖行上之后，**每个存活的变异体都精确指向「执行到了，但没有人在检查」**——那才是新信息。
//
// 【为什么不上 Stryker】全量变异测试要为每个变异体重跑整套测试。本仓 31k 行、单测基线 61 秒，几小时
// 起步，还会淹在等价变异体的噪声里，当门禁必然被绕过。这里刻意做成**按需的单文件诊断工具，不是闸**
// ——不接进 npm run check，不在 CI 跑。它的使用时机是「刚写完一批测试，想知道它们是不是真的在工作」。
//
// 【存活 ≠ bug】等价变异体（改了但语义不变）、纯日志、防御性兜底都会存活。存活是一个问句：
// 「这里改了你会在意吗？」——在意就补断言，不在意就放过。工具不替你判断。
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCoverageRows } from './coverage-check.js';

const ROOT = join(import.meta.dirname, '..', '..');

// ── 代码位置掩码 ────────────────────────────────────────────────────────────
// 字符串/模板串/注释里的 `&&`、`===` 是文案不是运算符，改了只会造出无意义的变异体（还可能破坏
// 断言消息）。同 tests/gates/agent-event-contract.js 的 skipQuoted/skipLineComment 一路做法。
export function maskCodePositions(source) {
  const mask = new Array(source.length).fill(true);
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '/' && next === '/') {
      const end = source.indexOf('\n', i);
      const stop = end === -1 ? source.length : end;
      for (; i < stop; i += 1) mask[i] = false;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      for (; i < stop; i += 1) mask[i] = false;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      mask[i] = false;
      i += 1;
      while (i < source.length) {
        if (source[i] === '\\') { mask[i] = false; mask[i + 1] = false; i += 2; continue; }
        const closing = source[i] === ch;
        mask[i] = false;
        i += 1;
        if (closing) break;
      }
      continue;
    }
    i += 1;
  }
  return mask;
}

// ── 覆盖率报告解析 ──────────────────────────────────────────────────────────
// 返回未覆盖行号集合；目标文件不在报告里返回 null —— 那是「不知道」，绝不能当成「全覆盖」。
//
// ★ filePath 是【仓库相对路径】，不是 basename。报告是目录树、叶子行只有文件名，按 basename
// 匹配会在同名文件上认错人（本仓 app.js / notifications.js 各有两份），而且那个「不在报告里
// → null → 改为全文件变异」的诚实回落会因为总能撞上同名兄弟而永远不触发。
// 路径还原见 coverage-check.js#parseCoverageRows。
export function parseUncoveredLines(reportText, filePath) {
  for (const row of parseCoverageRows(reportText)) {
    if (row.path !== filePath) continue;
    const lines = new Set();
    for (const token of row.cells[4].trim().split(/\s+/).filter(Boolean)) {
      const [from, to] = token.split('-').map(Number);
      if (!Number.isInteger(from)) continue;
      for (let n = from; n <= (Number.isInteger(to) ? to : from); n += 1) lines.add(n);
    }
    return lines;
  }
  return null;
}

// ── 变异算子 ────────────────────────────────────────────────────────────────
// 刻意小而准，对着本仓真实的 bug 面：守卫条件、阈值比较、状态机转移、?? 与 || 的差别。
// 顺序有意义——长的先匹配，否则 `>=` 会被 `>` 抢走并造出重叠的垃圾变异体。
const OPERATORS = Object.freeze([
  { from: '===', to: '!==' },
  { from: '!==', to: '===' },
  { from: '>=', to: '>' },
  { from: '<=', to: '<' },
  { from: '&&', to: '||' },
  { from: '||', to: '&&' },
  { from: '??', to: '||' },
  { from: 'true', to: 'false', word: true },
  { from: 'false', to: 'true', word: true },
]);

const isWordChar = ch => ch !== undefined && /[\w$]/.test(ch);

export function generateMutants(source, { coveredLines = null } = {}) {
  const mask = maskCodePositions(source);
  const lineOf = new Array(source.length);
  let line = 1;
  for (let i = 0; i < source.length; i += 1) {
    lineOf[i] = line;
    if (source[i] === '\n') line += 1;
  }

  const mutants = [];
  let i = 0;
  while (i < source.length) {
    if (!mask[i]) { i += 1; continue; }
    const op = OPERATORS.find(candidate => {
      if (!source.startsWith(candidate.from, i)) return false;
      // 整段必须都是代码：跨越字符串边界的匹配一律不算
      for (let k = 0; k < candidate.from.length; k += 1) if (!mask[i + k]) return false;
      // 标识符类算子要词边界，否则 `trueish` 里的 true 也会被改
      if (candidate.word) {
        if (isWordChar(source[i - 1]) || isWordChar(source[i + candidate.from.length])) return false;
      }
      return true;
    });
    if (!op) { i += 1; continue; }

    if (!coveredLines || coveredLines.has(lineOf[i])) {
      mutants.push({
        line: lineOf[i],
        column: i - source.lastIndexOf('\n', i - 1),
        from: op.from,
        to: op.to,
        mutated: source.slice(0, i) + op.to + source.slice(i + op.from.length),
        snippet: source.slice(source.lastIndexOf('\n', i) + 1, (source.indexOf('\n', i) + 1 || source.length) - 1).trim(),
      });
    }
    i += op.from.length; // 跳过整个算子，防 `===` 内部再匹配一次 `==`
  }
  return mutants;
}

// 行范围过滤（--lines=200-260,300-310）。整文件跑的存活率天然很高——默认参数、立刻被覆盖的初值、
// 值本来就是 null 的 ?? 这类等价变异都会存活，实测 mirror-engine 全文件 40 抽样存活 21 个（52%），
// 逐条triage 很累。而本工具的正经用法是「刚给某段写完测试，想知道它们是不是真的在工作」，
// 把范围收到那段上，存活的每一条就都值得看。
export function parseLineRanges(spec) {
  if (!spec) return null;
  const lines = new Set();
  for (const token of String(spec).split(',').map(s => s.trim()).filter(Boolean)) {
    const [from, to] = token.split('-').map(Number);
    if (!Number.isInteger(from)) continue;              // 完全解析不出数字 → 跳过这一段
    const end = Number.isInteger(to) ? to : from;
    // 起点小于 1 就夹到 1，而不是整段丢掉：`--lines=0-2` 明显是想要开头那几行，
    // 静默丢掉半个请求比夹一下更糟（用户会以为过滤生效了，其实那段根本没跑）。
    for (let n = Math.max(1, from); n <= end; n += 1) lines.add(n);
  }
  return lines.size > 0 ? lines : null;
}

// 均匀抽样，不是取前 N 个。取前 N 会把变异体全压在文件头部——而一个文件里最值得怀疑的往往是
// 后半段的状态机，头部通常是 import 和常量。截断本身也必须说出来，否则报告读起来像"全查过了"。
export function sampleMutants(mutants, limit) {
  if (!Number.isInteger(limit) || limit <= 0 || mutants.length <= limit) return mutants;
  const step = mutants.length / limit;
  const picked = [];
  for (let i = 0; i < limit; i += 1) picked.push(mutants[Math.floor(i * step)]);
  return picked;
}

// ── 关联测试推断 ────────────────────────────────────────────────────────────
// 判据是「测试文件文本里提到了目标路径」——静态 import、动态 import、readFileSync 夹具都能认到。
// 宁可多带几个测试文件（慢一点），也不能漏掉真正能杀死变异体的那个（会误报成存活）。
export function inferTestFiles(targetPath, testFiles, read) {
  const needle = targetPath.replace(/\\/g, '/');
  const found = [];
  for (const file of testFiles) {
    let source;
    try { source = read(file); } catch { continue; }
    if (typeof source === 'string' && source.includes(needle)) found.push(file);
  }
  return found;
}

// ── 编排 ────────────────────────────────────────────────────────────────────

// 只自动关联【单测】。集成测试起真 server、动辄分钟级，且不带 --test-force-exit 时会吊住整个
// 变异循环（2026-08-02 实测：history.js 把 session-delete 集成测试卷进来后直接挂死 10 分钟）。
// 变异检查要的是秒级反馈。确实想拿集成测试杀变异体，用 --tests= 显式点名。
function listTestFiles(rootDir) {
  const out = [];
  for (const dir of ['tests/unit']) {
    let entries;
    try { entries = readdirSync(join(rootDir, dir)); } catch { continue; }
    for (const name of entries) if (name.endsWith('.test.mjs')) out.push(`${dir}/${name}`);
  }
  return out.sort();
}

// ★ timeoutMs 不是可选的保险，是必需品：变异很容易造出【永不结束】的程序。实测把
//   `typeof timer.unref === 'function'` 翻成 `!==` 之后 unref 不再执行，测试进程永远不退出；
//   而 spawnSync 阻塞事件循环，此时 SIGINT/SIGTERM 处理器根本没机会跑 —— 整个工具连同"退出时
//   还原源文件"的保护一起卡死，把变异后的代码留在了工作树里（2026-08-02 实际踩到）。
//   超时即判"杀死"：把代码改坏到测试跑不完，本来就属于被测试发现了。
// ★★ 变异体会把「算路径的代码」改成算出【别的路径】，而测试会拿那个路径去 rmSync。
// 2026-08-02 真实事故：对 app/src/sessions/history.js 跑变异时，算子把 getProjectDir 里的
//   `String(cwd || '')` 改成 `String(cwd && '')` ⇒ 对任意 cwd 恒返回 ''，于是
//   session-delete.test.mjs 的 `projectDir = join(PROJECTS_ROOT, getProjectDir(workDir))`
//   塌成 PROJECTS_ROOT 本身，它的 cleanup 再 `rmSync(projectDir, {recursive, force})`
//   —— 整个 ~/.claude/projects 被递归删除，积累的 104 个 memory 文件一起没了（靠 APFS 快照才捞回来）。
//
// 两层防护，缺一不可：
//   ① 自动关联只取 tests/unit（见 listTestFiles）——真正碰真实目录的是集成测试。
//   ② 【这里】给每次测试运行换一个临时 HOME。凡是靠 os.homedir() 推路径的（~/.claude/projects、
//      ~/.claude/sessions 都是），变异算歪了也只能砸到一个一次性空目录，够不到真实数据。
// 基线运行也走同一个 HOME：真有测试依赖真实 HOME 的话，会在【基线阶段】就红出来并中止，
// 而不是等到某个变异体把它变成破坏性操作。
function runTests(testFiles, { coverage = false, timeoutMs, home } = {}) {
  return spawnSync(process.execPath, [
    '--import', './tests/setup/preload-env.mjs',
    ...(coverage ? ['--experimental-test-coverage'] : []),
    '--test', ...testFiles,
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    // USERPROFILE 必须一起设：Node 的 os.homedir() 在 win32 读 USERPROFILE、不读 HOME，
    // 只设 HOME 的沙箱在 Windows 上整个失效（2026-08-03 review）。darwin/linux 上多设无害。
    ...(home ? { env: { ...process.env, HOME: home, USERPROFILE: home } } : {}),
    ...(timeoutMs ? { timeout: timeoutMs, killSignal: 'SIGKILL' } : {}),
  });
}

// status !== 0 即算杀死：非零退出、被信号杀（status=null）、超时（同样 status=null）三种都算。
export function isKilled(result) {
  return result.status !== 0;
}

function main() {
  const args = process.argv.slice(2);
  const target = args.find(a => !a.startsWith('--'));
  if (!target) {
    console.error('用法: npm run mutate -- <文件> [--lines=A-B] [--tests a,b] [--limit N] [--fail-on-survivors]');
    process.exitCode = 2;
    return;
  }
  const targetRel = relative(ROOT, resolve(ROOT, target)).replace(/\\/g, '/');
  const targetAbs = join(ROOT, targetRel);
  if (!existsSync(targetAbs)) {
    console.error(`找不到文件：${targetRel}`);
    process.exitCode = 2;
    return;
  }
  const limit = Number(args.find(a => a.startsWith('--limit='))?.split('=')[1] || 60);
  const explicitTests = args.find(a => a.startsWith('--tests='))?.split('=')[1]?.split(',').filter(Boolean);
  const focusLines = parseLineRanges(args.find(a => a.startsWith('--lines='))?.split('=')[1]);

  const testFiles = explicitTests?.length
    ? explicitTests
    : inferTestFiles(targetRel, listTestFiles(ROOT), file => readFileSync(join(ROOT, file), 'utf8'));
  if (testFiles.length === 0) {
    console.error(`没有测试文件提到 ${targetRel} —— 无从判断"会不会开口"。用 --tests= 手动指定。`);
    process.exitCode = 2;
    return;
  }
  console.log(`目标：${targetRel}`);
  console.log(`关联测试：${testFiles.join(', ')}\n`);

  // 崩溃残留优先还原：上一轮被 Ctrl-C / 杀掉时会留下 .mutate-backup，绝不能拿它当原文继续。
  const backup = `${targetAbs}.mutate-backup`;
  if (existsSync(backup)) {
    renameSync(backup, targetAbs);
    console.log('⚠️  发现上一轮残留的备份，已先还原源文件。\n');
  }

  const original = readFileSync(targetAbs, 'utf8');
  writeFileSync(backup, original);
  // 一次性 HOME：见 runTests 上方那段事故说明。必须在 restore 之前声明——restore 被注册成
  // process.on('exit') 处理器，若它引用一个尚未初始化的 const，任何早退路径都会撞 TDZ ReferenceError，
  // 把「还原源文件」这条命脉本身炸掉。
  const sandboxHome = mkdtempSync(join(tmpdir(), 'ccm-mutate-home-'));
  // 任何退出路径都要还原——包括 Ctrl-C 和未捕获异常。绝不能把变异后的代码留在工作树里。
  const restore = () => {
    try { writeFileSync(targetAbs, original); } catch { /* 尽力而为 */ }
    try { if (existsSync(backup)) unlinkSync(backup); } catch { /* 尽力而为 */ }
    try { rmSync(sandboxHome, { recursive: true, force: true }); } catch { /* 尽力而为 */ }
  };
  process.on('exit', restore);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { restore(); process.exit(130); });

  // 基线：测试本来就红的话，后面每个变异体都会被判"杀死"，整轮结论全是假的。
  const baselineStart = Date.now();
  const baseline = runTests(testFiles, { coverage: true, home: sandboxHome });
  const baselineMs = Date.now() - baselineStart;
  if (baseline.status !== 0) {
    console.error('基线测试未通过，变异检查无意义——先把测试跑绿。');
    console.error((baseline.stdout + baseline.stderr).slice(-800));
    process.exitCode = 2;
    return;
  }

  // 传完整相对路径而非 basename：报告是目录树，同名文件按 basename 会取到另一棵子树那一行。
  const uncovered = parseUncoveredLines(baseline.stdout, targetRel);
  if (uncovered === null) {
    console.log('注：覆盖率报告里没有这个文件（关联测试没真正加载它？），改为全文件变异。\n');
  }
  const coveredLines = uncovered === null
    ? null
    : new Set(original.split('\n').map((_, idx) => idx + 1).filter(n => !uncovered.has(n)));

  const scopedLines = focusLines
    ? new Set([...focusLines].filter(n => !coveredLines || coveredLines.has(n)))
    : coveredLines;
  if (focusLines) console.log(`只看 --lines 指定的 ${focusLines.size} 行（与覆盖行取交集后 ${scopedLines.size} 行）。`);
  const all = generateMutants(original, { coveredLines: scopedLines });
  const mutants = sampleMutants(all, limit);
  if (all.length > mutants.length) {
    // 截断必须说出来：不说的话这份报告读起来像"全查过了"。均匀抽样而非取前 N，见 sampleMutants。
    console.log(`⚠️  共 ${all.length} 个变异体，本轮均匀抽样跑 ${mutants.length} 个（--limit= 可调）。`);
  }
  // 变异体会造出死循环，必须给每次运行封顶。基线的 5 倍 + 5s 地板：够容忍慢机器与偶发抖动，
  // 又不至于让一个卡住的变异体把整轮拖垮。
  const perRunTimeoutMs = Math.max(5000, baselineMs * 5);
  const estimateS = Math.ceil((mutants.length * baselineMs) / 1000);
  console.log(`跑 ${mutants.length} 个变异体${coveredLines ? '（只在被覆盖的行上）' : ''}，`
    + `预计 ~${estimateS}s（单次上限 ${Math.round(perRunTimeoutMs / 1000)}s）…\n`);

  const survivors = [];
  let timedOut = 0;
  mutants.forEach((mutant, index) => {
    writeFileSync(targetAbs, mutant.mutated);
    const result = runTests(testFiles, { timeoutMs: perRunTimeoutMs, home: sandboxHome });
    writeFileSync(targetAbs, original);
    if (result.error?.code === 'ETIMEDOUT') timedOut += 1;
    if (!isKilled(result)) survivors.push(mutant);
    if (process.stdout.isTTY) process.stdout.write(`\r  ${index + 1}/${mutants.length}  存活 ${survivors.length}   `);
  });
  if (process.stdout.isTTY) console.log('');
  console.log(`杀死 ${mutants.length - survivors.length}/${mutants.length}，存活 ${survivors.length}。\n`);
  if (timedOut > 0) {
    console.log(`（其中 ${timedOut} 个变异体让测试跑不完而超时，按"杀死"计——改坏到卡死也是被发现了。）\n`);
  }

  if (survivors.length === 0) {
    console.log(`✅ ${mutants.length} 个变异体全部被杀死——这些行不只是被执行到，还真的有人在检查。`);
  } else {
    console.log(`⚠️  ${survivors.length}/${mutants.length} 个变异体存活。它们被执行到了，但改掉之后没有任何测试变红：\n`);
    for (const m of survivors) {
      console.log(`   ${targetRel}:${m.line}:${m.column}  ${m.from} → ${m.to}`);
      console.log(`      ${m.snippet}`);
    }
    console.log('\n存活不等于 bug：等价变异、纯日志、防御性兜底都会存活。');
    console.log('每一条只是一个问句——「这里改了你会在意吗？」在意就补断言，不在意就放过。');
  }
  if (args.includes('--fail-on-survivors') && survivors.length > 0) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}
