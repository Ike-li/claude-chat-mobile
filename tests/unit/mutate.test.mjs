// tests/unit/mutate.test.mjs —— 变异检查工具的纯函数单测
//
// 这个工具本身要回答「测试会不会开口」，所以它自己更不能是空过的。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  maskCodePositions,
  parseUncoveredLines,
  generateMutants,
  inferTestFiles,
  sampleMutants,
  isKilled,
  parseLineRanges,
} from '../../scripts/mutate.js';

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

// ── 覆盖率报告解析 ──────────────────────────────────────────────────────────

test('parseUncoveredLines：从报告里取出目标文件的未覆盖行（含区间展开）', () => {
  const report = [
    'ℹ   other.js                 |  90.00 |  80.00 |  70.00 | 5 9-11',
    'ℹ   mirror-engine.js         |  97.18 |  76.19 |  66.67 | 285-286 333-334 394',
    'ℹ all files                  |  77.51 |  81.91 |  74.22 | ',
  ].join('\n');

  const uncovered = parseUncoveredLines(report, 'mirror-engine.js');

  assert.deepEqual([...uncovered].sort((a, b) => a - b), [285, 286, 333, 334, 394]);
});

test('parseUncoveredLines：目标文件不在报告里 → null（表示「不知道」，不是「全覆盖」）', () => {
  const report = 'ℹ   other.js | 90.00 | 80.00 | 70.00 | 5';
  assert.equal(parseUncoveredLines(report, 'missing.js'), null);
});

test('parseUncoveredLines：文件 100% 覆盖（未覆盖列为空）→ 空集合而非 null', () => {
  const report = 'ℹ   full.js                   | 100.00 | 100.00 | 100.00 | ';
  const uncovered = parseUncoveredLines(report, 'full.js');
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
    'tests/unit/a.test.mjs': "import { x } from '../../src/server/mirror-engine.js';",
    'tests/unit/b.test.mjs': "import { y } from '../../src/agent/agent.js';",
    'tests/unit/c.test.mjs': "await import('../../src/server/mirror-engine.js');",
  })[file];

  const found = inferTestFiles('src/server/mirror-engine.js',
    ['tests/unit/a.test.mjs', 'tests/unit/b.test.mjs', 'tests/unit/c.test.mjs'], read);

  assert.deepEqual(found, ['tests/unit/a.test.mjs', 'tests/unit/c.test.mjs'],
    '静态与动态 import 都要认');
});

test('inferTestFiles：读不动的测试文件跳过，不整体失败', () => {
  const read = file => {
    if (file === 'bad') throw new Error('EACCES');
    return "from '../../src/x.js'";
  };
  assert.deepEqual(inferTestFiles('src/x.js', ['bad', 'good'], read), ['good']);
});

test('inferTestFiles：无人引用 → 空数组（调用方据此提示「没有关联测试」）', () => {
  assert.deepEqual(inferTestFiles('src/lonely.js', ['t'], () => 'nothing'), []);
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

test('自动关联只取单测：集成测试起真 server、会把变异循环吊死，要用就 --tests= 显式点名', () => {
  const source = readFileSync(new URL('../../scripts/mutate.js', import.meta.url), 'utf8');
  const listFn = source.slice(source.indexOf('function listTestFiles'), source.indexOf('function listTestFiles') + 300);
  assert.ok(listFn.includes("'tests/unit'"));
  assert.ok(!listFn.includes('tests/integration'), '自动关联面不得包含集成测试目录');
});
