// tests/unit/tool-summary.test.mjs —— tool-summary.js 单测（工具卡片摘要口径：截断/序列化/base64 脱敏）。
// live 侧（agent.js 工具卡片）与历史回显侧（history.js）此前各有一份逐字复制的实现，且已语义分叉：
// 只有 live 侧带循环引用护栏。本模块取超集合并，这里锚定合并后的口径。
import test from 'node:test';
import assert from 'node:assert/strict';
import { truncate, stringify, redactBase64, toolSummary, TOOL_SUMMARY_CAP } from '../../src/shared/tool-summary.js';

test.describe('truncate', () => {
  test('超过 cap 截断并加尾标', () => {
    assert.equal(truncate('abcdef', 3), 'abc …（已截断）');
  });

  test('未超 cap 原样返回', () => {
    assert.equal(truncate('abc', 3), 'abc');
  });

  test('非字符串返回空串', () => {
    assert.equal(truncate(null), '');
    assert.equal(truncate(42), '');
  });

  test('默认 cap 为 600', () => {
    assert.equal(TOOL_SUMMARY_CAP, 600);
    assert.equal(truncate('x'.repeat(600)), 'x'.repeat(600));
    assert.equal(truncate('x'.repeat(601)).endsWith(' …（已截断）'), true);
  });
});

test.describe('stringify', () => {
  test('null/undefined → 空串', () => {
    assert.equal(stringify(null), '');
    assert.equal(stringify(undefined), '');
  });

  test('字符串原样返回，不加引号', () => {
    assert.equal(stringify('hi'), 'hi');
  });

  test('对象走 JSON', () => {
    assert.equal(stringify({ a: 1 }), '{"a":1}');
  });

  test('JSON.stringify 抛错时回落 String()', () => {
    const bad = { toJSON() { throw new Error('boom'); } };
    assert.equal(stringify(bad), String(bad));
  });
});

test.describe('redactBase64', () => {
  test('达到阈值的纯 base64 串被替换为 KB 提示', () => {
    const payload = 'A'.repeat(500);
    assert.equal(redactBase64(payload), '（base64 数据，约 1KB，已省略）');
  });

  test('URL-safe 变体（-_）同样识别', () => {
    const payload = `${'-_'.repeat(250)}==`;
    assert.match(redactBase64(payload), /^（base64 数据，约 \d+KB，已省略）$/);
  });

  test('未达阈值的串原样返回', () => {
    assert.equal(redactBase64('A'.repeat(499)), 'A'.repeat(499));
  });

  test('含空白/标点的长文本不误伤（真实代码与 diff 预览）', () => {
    const code = `const x = 1; // ${'note '.repeat(200)}`;
    assert.equal(redactBase64(code), code);
  });

  test('递归进数组与对象', () => {
    const payload = 'A'.repeat(500);
    assert.deepEqual(redactBase64({ list: [payload], nested: { deep: payload } }), {
      list: ['（base64 数据，约 1KB，已省略）'],
      nested: { deep: '（base64 数据，约 1KB，已省略）' },
    });
  });

  // 合并前只有 agent.js 侧有此护栏，history.js 侧遇自引用结构会栈溢出并打断整条消息处理。
  test('循环引用不栈溢出，标记为已省略', () => {
    const cyclic = { name: 'root' };
    cyclic.self = cyclic;
    assert.deepEqual(redactBase64(cyclic), { name: 'root', self: '（循环引用，已省略）' });
  });

  test('数组自引用同样被护栏拦住', () => {
    const arr = ['leaf'];
    arr.push(arr);
    assert.deepEqual(redactBase64(arr), ['leaf', '（循环引用，已省略）']);
  });

  // 合并陷阱：history 侧原写法是 value.map(histRedactBase64)，函数直传会让 map 把 index 灌进第二参。
  // 统一到带 seen 的签名后若沿用直传，第二个元素起 seen 就成了数字，.has() 直接抛 TypeError。
  test('数组各元素独立处理，index 不污染 seen 参数', () => {
    const payload = 'A'.repeat(500);
    assert.deepEqual(redactBase64([payload, payload, payload]), [
      '（base64 数据，约 1KB，已省略）',
      '（base64 数据，约 1KB，已省略）',
      '（base64 数据，约 1KB，已省略）',
    ]);
  });

  // 护栏是保守的：WeakSet 只记「见过」不记「在当前路径上」，所以同一对象在两个分支重复出现（DAG，非环）
  // 也会被标成循环引用。这是从 agent.js live 侧原样继承的既有取舍——摘要场景下宁可多省略也不冒栈溢出风险，
  // 合并时刻意不改行为。锚定在此，免得日后有人当 bug「顺手修」而悄悄改了 live 工具卡片的显示。
  test('同一对象在不同分支重复出现（DAG）按保守口径也算循环，与 live 侧一致', () => {
    const shared = { v: 1 };
    assert.deepEqual(redactBase64({ a: shared, b: shared }), { a: { v: 1 }, b: '（循环引用，已省略）' });
  });

  test('标量原样返回', () => {
    assert.equal(redactBase64(7), 7);
    assert.equal(redactBase64(null), null);
  });
});

test.describe('toolSummary', () => {
  test('脱敏 → 序列化 → 截断，三步同一口径', () => {
    const payload = 'A'.repeat(500);
    assert.equal(toolSummary({ data: payload }), '{"data":"（base64 数据，约 1KB，已省略）"}');
  });

  test('cap 可覆盖', () => {
    assert.equal(toolSummary('abcdef', 3), 'abc …（已截断）');
  });

  test('脱敏发生在截断之前：大 base64 不占满截断额度', () => {
    const summary = toolSummary({ img: 'A'.repeat(5000), keep: 'important' });
    assert.match(summary, /important/);
  });
});
