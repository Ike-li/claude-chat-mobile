// 门禁接线闸 —— tests/gates/ 下的每个门禁，要么真的挂在 npm run check 上，要么在下面显式说明
// 它为什么不在。
//
// 【为什么需要】门禁自己写得再扎实，也挡不住「它根本没被执行」。此前全仓只有 coverage-check 有
// 一条「我被接进 CI 了」的断言，其余门禁从 check 的 && 链里被摘掉、或新写一个忘了接线，
// 没有任何东西会红。而这两件事都是完全静默的：check 照常全绿，只是少查了一整类问题。
//
// 【为什么是白名单而不是给每个门禁加一条断言】给 N 个门禁各写一条「我被接线了」，是用治理治治理：
// 加一个门禁要记得加一条断言，而「记得」正是失败的那一步。反过来列出【不在 check 链里的例外】，
// 新增门禁默认就必须接线，忘了就红。例外只有 3 条，且每条都得写明理由。
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

// 有意不在 check 链里的门禁，附理由。加一条前先问：它真的不该每次 check 都跑吗？
const NOT_IN_CHECK = new Map([
  ['agent-event-contract.js', '不是入口——由 contract-check.js import 后调用，那个才挂在链上'],
  ['guard-host-tests.js', 'PreToolUse 钩子，由 .claude/settings.json 触发，不属于静态检查链'],
  ['mutate.js', '变异测试工具，会故意改坏源码，只能手动进容器跑（见 CLAUDE.md 测试白名单）'],
]);

// check 链里的 `npm run X` 要展开，否则通过 inventory:check 间接接线的门禁会被误判成没接线。
function expandedCheckChain() {
  const seen = new Set();
  const expand = name => {
    if (seen.has(name)) return '';
    seen.add(name);
    const body = pkg.scripts[name] ?? '';
    return body.replace(/\bnpm run ([A-Za-z0-9:_-]+)/g, (_, ref) => expand(ref));
  };
  return expand('check');
}

test('tests/gates/ 下每个门禁都挂在 npm run check 上，或在 NOT_IN_CHECK 里说明原因', () => {
  const chain = expandedCheckChain();
  const gates = readdirSync(new URL('../../tests/gates', import.meta.url)).filter(f => f.endsWith('.js'));

  assert.ok(gates.length > 0, 'tests/gates/ 扫不到文件——扫描面塌了，不是「全部合规」');

  for (const gate of gates) {
    if (NOT_IN_CHECK.has(gate)) {
      assert.ok(
        !chain.includes(`tests/gates/${gate}`),
        `${gate} 被列为不在 check 链里，但它其实挂着——删掉 NOT_IN_CHECK 里的那条`,
      );
      continue;
    }
    assert.ok(
      chain.includes(`tests/gates/${gate}`),
      `${gate} 没有出现在 npm run check 里。要么把它接进链，要么在 NOT_IN_CHECK 里写明为什么不接——` +
      '一个不被执行的门禁比没有门禁更危险，它占着「这块有人守」的位置',
    );
  }
});

// doc-consistency.js 住在 scripts/ 而不是 tests/gates/（它同时是 doctor 的 D9 检查项，
// 而运行时代码不得 import tests/）。它不在上面那轮扫描里，单独钉住。
test('scripts/doc-consistency.js 也挂在 check 链上', () => {
  assert.match(expandedCheckChain(), /scripts\/doc-consistency\.js/);
});
