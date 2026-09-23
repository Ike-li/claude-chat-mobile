// tests/unit/mock-server-reset.test.mjs —— E2E 假后端的用例边界：模块级状态必须在 __reset 时归零
//
// mock（tests/e2e/mock/server.js）把状态全存在模块级变量里，一个进程顺序服务同一分片的所有用例，
// 用例之间唯一的隔离是 /__reset → resetMockState()。漏归零一个，前一条用例的状态就会带进后面的
// 用例，而且表现为【全绿】：2026-09-23 查到 dupOptimisticArmed 从不复位，同一进程里
// optimistic-bubble-history-dup 先跑过之后，P0-SYNC-ACK-TIMEOUT 的 sync:since 被 DUP-OPT 分支
// 抢答，它要守的 15s 超时兜底根本没执行——单跑 17s，全量 1.2s 假绿，之前没人发现。
//
// 所以不靠「加新状态的人记得去 reset 里补一行」，反过来：每个模块级 let 都必须在
// resetMockState() 里被赋值，否则登记进下面的豁免表并写明理由。
//
// 这是源码文本断言，属 docs/testing.md §5 说的「架构守卫」：没有行为层的等价物——
// 行为层要证明「不泄漏」，得把 52 个 spec 的所有先后组合都跑一遍。
// 不测什么：① 场景尾巴活过用例（时间上的泄漏，由 user:message 的 mockResetGeneration 等各自处理）；
// ② 归零成的值对不对（那是各条 E2E 用例自己的断言）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('../e2e/mock/server.js', import.meta.url));

// 有意跨用例存活的模块级 let。加进来必须写清为什么它不该在用例边界归零。
const EXEMPT = {
  questSeq: '单调递增的题号：归零会让后一条用例复用前一条的 requestId，被前端 answeredQuestionIds 吞掉',
  mockReadState: '由 resetReadState() 重建，resetMockState() 调用它（下面单独断言这个前提）',
};

// 「这一行写了它」：赋值、复合赋值、自增自减，以及经属性/下标链的写入、delete、容器原地修改、
// Object.assign——const 只挡住重新赋值，挡不住 `x.armed = true` 或 `x.list.push()` 这种写法。
function writes(name) {
  const n = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const head = `(^|[^.\\w$])${n}`;
  const chain = '(\\.[\\w$]+|\\[[^\\]]*\\])*';
  return new RegExp(
    `${head}${chain}\\s*(=(?!=)|\\+=|-=|\\|\\|=|&&=|\\?\\?=|\\+\\+|--)`
    + `|(\\+\\+|--)\\s*${n}\\b`
    + `|\\bdelete\\s+${n}[.[]`
    + `|${head}${chain}\\.(set|add|push|splice|delete|clear|unshift|pop|shift|fill|sort|reverse)\\(`
    + `|Object\\.assign\\(\\s*${n}\\b`,
  );
}

function functionBody(lines, name) {
  const start = lines.findIndex(l => new RegExp(`^function ${name}\\(`).test(l));
  assert.ok(start >= 0, `mock server 里找不到顶层 function ${name}()——改名或挪位置后本测试会失明，先改这里`);
  let end = start;
  while (end < lines.length && !/^}/.test(lines[end])) end += 1;
  return { start, end, text: lines.slice(start, end + 1).join('\n') };
}

const lines = readFileSync(SERVER, 'utf8').split('\n');
const reset = functionBody(lines, 'resetMockState');
const declared = [];
lines.forEach((line, i) => {
  const m = line.match(/^(let|const)\s+([A-Za-z_$][\w$]*)\s*[=;]/);
  if (m) declared.push({ kind: m[1], name: m[2], line: i + 1 });
});
const lets = declared.filter(d => d.kind === 'let');

test('扫描面非空：一个都没找到不等于没有泄漏', () => {
  assert.ok(lets.length > 0, '一个模块级 let 都没扫到——声明写法或文件位置变了，本测试在空转');
});

test('每个模块级 let 都在 resetMockState() 里被赋值，或在豁免表里写明理由', () => {
  const missing = lets
    .filter(d => !(d.name in EXEMPT) && !writes(d.name).test(reset.text))
    .map(d => `${d.name}（server.js:${d.line}）`);
  assert.deepEqual(missing, [],
    '这些模块级状态不会在 /__reset 时归零，会从上一条用例漏进下一条（同分片、同进程）。'
    + '在 resetMockState() 里复位；确实该跨用例存活的，登记进本文件 EXEMPT 并写理由');
});

test('被原地修改的模块级 const（改属性或容器方法），resetMockState() 里也要复位', () => {
  const outsideReset = (i) => i < reset.start || i > reset.end;
  const missing = declared
    .filter(d => d.kind === 'const' && !(d.name in EXEMPT))
    .filter(d => {
      const re = writes(d.name);
      return lines.some((l, i) => i + 1 !== d.line && outsideReset(i) && re.test(l)) && !re.test(reset.text);
    })
    .map(d => `${d.name}（server.js:${d.line}）`);
  assert.deepEqual(missing, [], 'const 只挡住重新赋值，挡不住改属性、.set/.push 往里攒东西——这些状态跨用例存活');
});

test('豁免表不引用不存在的变量（改名或删掉后豁免会悄悄失效）', () => {
  const names = new Set(declared.map(d => d.name));
  assert.deepEqual(Object.keys(EXEMPT).filter(n => !names.has(n)), []);
});

test('mockReadState 的豁免前提成立：resetMockState() 调 resetReadState()，后者重建它', () => {
  assert.match(reset.text, /\bresetReadState\(\)/, 'resetMockState() 不再调用 resetReadState()，mockReadState 的豁免就不成立了');
  assert.ok(writes('mockReadState').test(functionBody(lines, 'resetReadState').text),
    'resetReadState() 不再重建 mockReadState');
});
