// tests/unit/mutate.test.mjs —— 变异检查工具的纯函数单测
//
// 这个工具本身要回答「测试会不会开口」，所以它自己更不能是空过的。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  maskCodePositions,
  parseUncoveredLines,
  generateMutants,
  inferTestFiles,
  listTestFiles,
  sampleMutants,
  isKilled,
  parseLineRanges,
} from '../../tests/gates/mutate.js';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

// ── 代码位置掩码：字符串/注释/正则字面量里的字符不得被当成可变异的代码 ──────

test('maskCodePositions：普通代码全部可变异', () => {
  const src = 'a === b';
  const mask = maskCodePositions(src);
  assert.equal(mask.length, src.length);
  assert.ok(mask.every(Boolean));
});

test('maskCodePositions：字符串字面量内部不算代码（防把文案里的 && 当运算符改掉）', () => {
  const src = "const s = 'a && b';";
  const mask = maskCodePositions(src);
  const inside = src.indexOf('&&');
  assert.equal(mask[inside], false);
  assert.equal(mask[src.indexOf('const')], true);
});

test('maskCodePositions：模板字符串与转义引号处理正确', () => {
  const src = 'const t = `x === y`; const u = \'it\\\'s ===\';';
  const mask = maskCodePositions(src);
  assert.equal(mask[src.indexOf('x ===') + 2], false, '模板串内不是代码');
  assert.equal(mask[src.lastIndexOf('===')], false, '转义引号没有提前结束字符串');
});

test('maskCodePositions：行注释与块注释内部不算代码', () => {
  const src = 'a; // x === y\nb; /* p && q */ c;';
  const mask = maskCodePositions(src);
  assert.equal(mask[src.indexOf('x ===') + 2], false);
  assert.equal(mask[src.indexOf('p &&') + 2], false);
  assert.equal(mask[src.lastIndexOf('c;')], true, '块注释之后要恢复成代码');
});

// ── 正则字面量（2026-09-05 修复的静默少报）────────────────────────────────────
// 此前不认正则字面量，后果不是报错而是【假的干净报告】：正则里的一个 `"` 被当成字符串开头，
// 从那里到下一个 `"`（常常是文件末尾）整片被掩掉，变异体一个都生成不出来，
// 输出却写着「✅ 全部被杀死」。实测受害者：app/src/files/uploads.js（25 处运算符 → 1 个变异体）、
// app/src/shared/sanitizer.js（4 条运算符行全掩 → 0 个变异体）。
test('maskCodePositions：正则里的引号不得开启字符串（本次修复的核心形态）', () => {
  const src = `const s = x.replace(/[/\\\\:*?"<>|]/g, '_');\nif (a === b) return c;`;
  const mask = maskCodePositions(src);
  const tail = src.indexOf('a === b');
  assert.equal(mask[tail], true, '正则之后的代码必须仍是代码——这正是此前塌掉的地方');
  assert.equal(mask[tail + 2], true, '`===` 本身要可变异');
  assert.equal(mask[src.indexOf('"')], false, '正则内部（含那个引号）不是代码');
});

test('maskCodePositions：字符类里的 / 不终结正则', () => {
  // `[/...]` 里的第一个 `/` 若被当成结束符，后面的 `"` 就又漏成字符串开头了。
  const src = `x.replace(/[/"]/g, '');\nlet y = p && q;`;
  const mask = maskCodePositions(src);
  assert.equal(mask[src.indexOf('p &&') + 2], true, '正则闭合位置算错会把后一行一起吃掉');
});

test('maskCodePositions：除号不得被当成正则起始（会静默吃掉整行）', () => {
  const src = 'const mb = bytes / 1048576; if (mb >= 10) drop();';
  const mask = maskCodePositions(src);
  assert.equal(mask[src.indexOf('>=')], true, '`bytes /` 是除法，后面的 >= 必须仍可变异');
  assert.ok(mask.every(Boolean), '整行都是代码，不该有任何一个字符被掩掉');
});

test('maskCodePositions：关键词之后的 / 是正则（return /re/ 这类）', () => {
  const src = 'function f(s) { return /a"b/.test(s); }\nlet z = m || n;';
  const mask = maskCodePositions(src);
  assert.equal(mask[src.indexOf('"')], false, 'return 后是正则，里面的引号不是字符串开头');
  assert.equal(mask[src.indexOf('m ||') + 2], true, '正则之后恢复成代码');
});

test('maskCodePositions：正则标志位一并掩掉，且其后立刻恢复', () => {
  const src = 'const r = /ab/gimsuy; const t = u === v;';
  const mask = maskCodePositions(src);
  assert.equal(mask[src.indexOf('gimsuy')], false, '标志位属于字面量');
  assert.equal(mask[src.indexOf('u ===') + 2], true);
});

test('maskCodePositions：本行内未闭合的 / 按除号处理，不掩任何字符', () => {
  // 判错方向必须是保守的：宁可把正则当除号（少掩、多产几个无意义变异体），
  // 也不能把除号当正则（多掩、静默丢掉真变异体）。
  const src = 'const q = (a) / b;\nconst w = c && d;';
  const mask = maskCodePositions(src);
  assert.ok(mask.every(Boolean));
});

// ── 覆盖率报告解析 ──────────────────────────────────────────────────────────
// node --experimental-test-coverage 的报告是【目录树】，叶子行只有 basename：
//   ℹ src        |  …
//   ℹ  server    |  …
//   ℹ   app.js   |  …
// 所以判据必须按缩进深度还原出完整相对路径。只比 basename 会在同名文件上取到错的那一行，
// 而本仓 app.js（app/src/server + app/public/js）与 notifications.js（app/src/ops + app/public/js/app）各有两份。

// 一份贴着真实形态的报告：两个 app.js 分处两棵子树，未覆盖行故意不同。
const TREE_REPORT = [
  'ℹ start of coverage report',
  'ℹ file                        | line % | branch % | funcs % | uncovered lines',
  'ℹ app                         |        |          |         | ',
  'ℹ  public                     |        |          |         | ',
  'ℹ   js                        |        |          |         | ',
  'ℹ    app.js                   |  10.00 |   10.00 |   10.00 | 1-3',
  'ℹ  src                        |        |          |         | ',
  'ℹ   server                    |        |          |         | ',
  'ℹ    app.js                   |  20.00 |   20.00 |   20.00 | 7 9-10',
  'ℹ    mirror-engine.js         |  97.18 |   76.19 |   66.67 | 285-286 333-334 394',
  'ℹ    full.js                  | 100.00 |  100.00 |  100.00 | ',
  'ℹ all files                   |  77.51 |   81.91 |   74.22 | ',
  'ℹ end of coverage report',
].join('\n');

test('parseUncoveredLines：从报告里取出目标文件的未覆盖行（含区间展开）', () => {
  const uncovered = parseUncoveredLines(TREE_REPORT, 'app/src/server/mirror-engine.js');

  assert.deepEqual([...uncovered].sort((a, b) => a - b), [285, 286, 333, 334, 394]);
});

test('parseUncoveredLines：同名文件按完整路径区分，不会取到另一棵子树那一行', () => {
  // 取错行 = 变异体生成在错的行集合上：要么全存活（假警报），要么跳过真被覆盖的行（假绿）。
  assert.deepEqual([...parseUncoveredLines(TREE_REPORT, 'app/public/js/app.js')], [1, 2, 3]);
  assert.deepEqual([...parseUncoveredLines(TREE_REPORT, 'app/src/server/app.js')], [7, 9, 10]);
});

test('parseUncoveredLines：目标文件不在报告里 → null（表示「不知道」，不是「全覆盖」）', () => {
  assert.equal(parseUncoveredLines(TREE_REPORT, 'app/src/server/missing.js'), null);
  // basename 撞上了但路径不同，同样是「不知道」——绝不能拿另一棵子树的行冒充
  assert.equal(parseUncoveredLines(TREE_REPORT, 'app/src/ops/app.js'), null);
});

test('parseUncoveredLines：文件 100% 覆盖（未覆盖列为空）→ 空集合而非 null', () => {
  const uncovered = parseUncoveredLines(TREE_REPORT, 'app/src/server/full.js');
  assert.ok(uncovered instanceof Set);
  assert.equal(uncovered.size, 0);
});

// ── 变异体生成 ──────────────────────────────────────────────────────────────

test('generateMutants：改写比较/逻辑运算符，带行号与原文', () => {
  const src = 'if (a === b && c) return 1;\n';
  const mutants = generateMutants(src);

  const ops = mutants.map(m => `${m.from}→${m.to}`).sort();
  assert.deepEqual(ops, ['&&→||', '===→!==']);
  assert.ok(mutants.every(m => m.line === 1));
  assert.equal(mutants.find(m => m.from === '===').mutated, 'if (a !== b && c) return 1;\n');
});

test('generateMutants：只改一处，其余保持原样（一次一个变异体）', () => {
  const src = 'x === y; z === w;\n';
  const mutants = generateMutants(src).filter(m => m.from === '===');
  assert.equal(mutants.length, 2);
  assert.equal(mutants[0].mutated, 'x !== y; z === w;\n');
  assert.equal(mutants[1].mutated, 'x === y; z !== w;\n');
});

test('generateMutants：字符串与注释里的运算符不生成变异体', () => {
  const src = "const msg = 'a && b'; // c === d\n";
  assert.deepEqual(generateMutants(src), []);
});

test('generateMutants：>= 优先于 >，不会把 >= 拆成两个重叠变异体', () => {
  const src = 'if (n >= 3) f();\n';
  const mutants = generateMutants(src);
  assert.deepEqual(mutants.map(m => `${m.from}→${m.to}`), ['>=→>']);
});

test('generateMutants：箭头函数的 => 不被误认成比较运算符', () => {
  const src = 'const f = x => x;\n';
  assert.deepEqual(generateMutants(src), []);
});

test('generateMutants：布尔字面量翻转，且不碰标识符里的子串', () => {
  const src = 'const ok = true; const trueish = 1;\n';
  const mutants = generateMutants(src);
  assert.deepEqual(mutants.map(m => `${m.from}→${m.to}`), ['true→false']);
  assert.equal(mutants[0].mutated, 'const ok = false; const trueish = 1;\n');
});

test('generateMutants：?? → || （空值合并与逻辑或的差别是本仓真实 bug 面）', () => {
  const src = 'const v = a ?? null;\n';
  assert.deepEqual(generateMutants(src).map(m => `${m.from}→${m.to}`), ['??→||']);
});

test('generateMutants：coveredLines 给定时只变异被执行过的行', () => {
  const src = 'a === b;\nc === d;\ne === f;\n';
  const mutants = generateMutants(src, { coveredLines: new Set([2]) });
  assert.equal(mutants.length, 1);
  assert.equal(mutants[0].line, 2);
});

test('generateMutants：不给 coveredLines 时全文件都变异（不知道覆盖情况就别自作主张缩小）', () => {
  const src = 'a === b;\nc === d;\n';
  assert.equal(generateMutants(src).length, 2);
});

// ── 关联测试推断 ────────────────────────────────────────────────────────────

test('inferTestFiles：挑出提到目标模块的测试文件', () => {
  const read = file => ({
    'tests/unit/a.test.mjs': "import { x } from '../../app/src/server/mirror-engine.js';",
    'tests/unit/b.test.mjs': "import { y } from '../../app/src/agent/agent.js';",
    'tests/unit/c.test.mjs': "await import('../../app/src/server/mirror-engine.js');",
  })[file];

  const found = inferTestFiles('app/src/server/mirror-engine.js',
    ['tests/unit/a.test.mjs', 'tests/unit/b.test.mjs', 'tests/unit/c.test.mjs'], read);

  assert.deepEqual(found, ['tests/unit/a.test.mjs', 'tests/unit/c.test.mjs'],
    '静态与动态 import 都要认');
});

test('inferTestFiles：读不动的测试文件跳过，不整体失败', () => {
  const read = file => {
    if (file === 'bad') throw new Error('EACCES');
    return "from '../../app/src/x.js'";
  };
  assert.deepEqual(inferTestFiles('app/src/x.js', ['bad', 'good'], read), ['good']);
});

test('inferTestFiles：无人引用 → 空数组（调用方据此提示「没有关联测试」）', () => {
  assert.deepEqual(inferTestFiles('app/src/lonely.js', ['t'], () => 'nothing'), []);
});

// ── 抽样与判定（2026-08-02 首次真跑就踩到的两个缺陷）─────────────────────────

test('sampleMutants：超出上限时均匀抽样，不是取前 N 个', () => {
  const mutants = Array.from({ length: 100 }, (_, i) => ({ line: i + 1 }));
  const picked = sampleMutants(mutants, 5);

  assert.equal(picked.length, 5);
  assert.deepEqual(picked.map(m => m.line), [1, 21, 41, 61, 81],
    '取前 N 会把变异体全压在文件头部，而值得怀疑的通常是后半段的状态机');
});

test('sampleMutants：未超上限 / 上限非法时原样返回', () => {
  const mutants = [{ line: 1 }, { line: 2 }];
  assert.equal(sampleMutants(mutants, 5), mutants);
  assert.equal(sampleMutants(mutants, 0), mutants);
  assert.equal(sampleMutants(mutants, NaN), mutants);
});

test('isKilled：非零退出、被信号杀、超时都算杀死；只有干净退 0 才算存活', () => {
  assert.equal(isKilled({ status: 1 }), true, '测试失败');
  assert.equal(isKilled({ status: null, error: { code: 'ETIMEDOUT' } }), true,
    '变异造出死循环让测试跑不完——那也是被发现了');
  assert.equal(isKilled({ status: null, signal: 'SIGKILL' }), true);
  assert.equal(isKilled({ status: 0 }), false);
});

test('parseLineRanges：单行/区间/逗号混合；解析不出数字的段跳过，起点 <1 夹到 1', () => {
  assert.deepEqual([...parseLineRanges('5,10-12,x,0-2')].sort((a, b) => a - b), [1, 2, 5, 10, 11, 12]);
});

test('parseLineRanges：未指定或全非法 → null（表示「不缩小范围」而不是「空范围」）', () => {
  assert.equal(parseLineRanges(undefined), null);
  assert.equal(parseLineRanges(''), null);
  assert.equal(parseLineRanges('abc'), null);
});

test('generateMutants：同一行多个变异点用 column 区分（否则报告里三条长得一模一样）', () => {
  const src = 'const k = a || b || c;\n';
  const mutants = generateMutants(src);
  assert.equal(mutants.length, 2);
  assert.deepEqual(mutants.map(m => m.column), [src.indexOf('||') + 1, src.lastIndexOf('||') + 1]);
  assert.ok(mutants.every(m => m.line === 1));
});

test('自动关联只取秒级档：unit + invariants 直下，集成测试与不变量树的起 server 档一律排除', () => {
  // 真跑而不是读源码：这条以前断言的是「源码里出现过 'tests/unit' 字样」，
  // 而 tests/invariants 整个在盲区时那句照样成立 —— 只被不变量树覆盖的模块会被报成「没有关联测试」。
  const files = listTestFiles(ROOT);
  assert.ok(files.some(f => f.startsWith('tests/unit/')), '单测必须在自动关联面内');
  assert.ok(files.some(f => f.startsWith('tests/invariants/') && f.split('/').length === 3),
    'invariants 直下的 S0/S1 用例必须在自动关联面内，否则只被不变量树覆盖的模块查不到任何测试');
  for (const excluded of ['tests/integration/', 'tests/invariants/server/', 'tests/invariants/env/', 'tests/e2e/', 'tests/smoke/']) {
    assert.ok(!files.some(f => f.startsWith(excluded)),
      `${excluded} 会起真 server / 分钟级，卷进每一个变异体就把循环废了`);
  }
  assert.ok(files.every(f => f.endsWith('.test.mjs')), '只收测试文件');
});

test('自动关联能找到只被不变量树覆盖的模块（旧单测已退役的那批）', () => {
  // 具体复现 2026-09-05 撞到的形态：message-dedup 的旧单测在按不变量重组时删掉了，
  // 修复前 `npm run mutate -- app/src/agent/message-dedup.js` 报「没有测试文件提到」。
  //
  // 副作用注记：inferTestFiles 是字符串包含匹配，所以下面这两个路径字面量会让【本文件】
  // 也被算成它们的关联测试——真跑 mutate 时会看到 tests/unit/mutate.test.mjs 混在关联表里。
  // 无害（纯函数、毫秒级），但别以为那是配错了。想消掉就得放弃点名具体形态，不值当。
  const files = listTestFiles(ROOT);
  const read = f => readFileSync(join(ROOT, f), 'utf8');
  for (const target of ['app/src/agent/message-dedup.js', 'app/src/sessions/read-state.js']) {
    assert.ok(inferTestFiles(target, files, read).length > 0,
      `${target} 有不变量树测试却关联不到 —— 变异是本仓验收假绿的判据，判据自己失明比没有更糟`);
  }
});

// ── 破坏性隔离（2026-08-02 真实事故的回归）─────────────────────────────────
// 变异体会把"算路径的代码"改成算出别的路径，而测试会拿那个路径去 rmSync。
// 当时：getProjectDir 里的 `String(cwd || '')` 被算子改成 `String(cwd && '')` ⇒ 恒返回 ''，
// session-delete.test.mjs 的 projectDir 塌成 ~/.claude/projects 本身，它的 cleanup 把整棵树删了。

test('变异运行必须换一次性 HOME：靠 os.homedir() 推路径的代码算歪了也够不到真实数据', () => {
  const source = readFileSync(new URL('../../tests/gates/mutate.js', import.meta.url), 'utf8');
  assert.match(source, /HOME: home/, 'runTests 必须能覆盖子进程的 HOME');
  const baselineCall = source.match(/runTests\(testFiles, \{ coverage: true[^)]*\)/)?.[0] ?? '';
  assert.match(baselineCall, /home: sandboxHome/, '基线运行也要走沙箱 HOME —— 真有测试依赖真实 HOME 就该在基线阶段红出来');
  const mutantCall = source.match(/runTests\(testFiles, \{ timeoutMs[^)]*\)/)?.[0] ?? '';
  assert.match(mutantCall, /home: sandboxHome/, '每个变异体运行都要走沙箱 HOME');
});

test('sandboxHome 必须先于 restore 声明：restore 是 exit 处理器，撞 TDZ 会把还原本身炸掉', () => {
  const source = readFileSync(new URL('../../tests/gates/mutate.js', import.meta.url), 'utf8');
  const declared = source.indexOf('const sandboxHome');
  const restore = source.indexOf('const restore =');
  assert.ok(declared > 0 && restore > 0);
  assert.ok(declared < restore,
    'restore 引用 sandboxHome；若声明在后，任何早退路径都会 ReferenceError，源文件就还原不回来了');
});
