// tests/unit/visual-mock-scenarios.test.mjs —— E2E 假后端的场景注册表
// 假后端要与真 server 说同一套协议，注册表的分派必须精确匹配、不许重复注册
// （重复 = 后注册的静默覆盖前一个，E2E 就在测一个不存在的场景）。
// 覆盖：精确分派 · 命令式场景分派 · 重复注册被拒 · 业务域模块各自暴露自己的场景
import test from 'node:test';
import assert from 'node:assert/strict';
import { createVisualMockScenarioRegistry } from '../e2e/mock/registry.js';
import { createContentScenarios } from '../e2e/mock/scenarios/content.js';
import { createStatusScenarios } from '../e2e/mock/scenarios/status.js';

test('visual mock scenario registry dispatches exact and prefix commands', async () => {
  const calls = [];
  const registry = createVisualMockScenarioRegistry([
    { command: 'test:statusline', run: async context => calls.push(['statusline', context.cmd]) },
    { prefix: 'test:message-edit', run: async context => calls.push(['message-edit', context.cmd]) },
  ]);

  assert.deepEqual(registry.commands(), ['test:statusline', 'test:message-edit*']);
  assert.equal(await registry.run('test:statusline', { cmd: 'test:statusline' }), true);
  assert.equal(await registry.run('test:message-edit previous prompt', { cmd: 'test:message-edit previous prompt' }), true);
  assert.equal(await registry.run('test:unknown', { cmd: 'test:unknown' }), false);
  assert.deepEqual(calls, [
    ['statusline', 'test:statusline'],
    ['message-edit', 'test:message-edit previous prompt'],
  ]);
});

test('visual mock scenario registry dispatches command aliases through one scenario', async () => {
  const calls = [];
  const registry = createVisualMockScenarioRegistry([
    {
      commands: ['test:question', 'test:question-duplicate'],
      run: async context => calls.push(context.cmd),
    },
  ]);

  assert.deepEqual(registry.commands(), ['test:question', 'test:question-duplicate']);
  assert.equal(await registry.run('test:question', { cmd: 'test:question' }), true);
  assert.equal(await registry.run('test:question-duplicate', { cmd: 'test:question-duplicate' }), true);
  assert.deepEqual(calls, ['test:question', 'test:question-duplicate']);
});

test('visual mock scenario registry rejects duplicate exact and prefix keys', () => {
  assert.throws(() => createVisualMockScenarioRegistry([
    { command: 'test:statusline', run: async () => {} },
    { command: 'test:statusline', run: async () => {} },
  ]), /Duplicate visual mock scenario key: test:statusline/);

  assert.throws(() => createVisualMockScenarioRegistry([
    { prefix: 'test:message-edit', run: async () => {} },
    { prefix: 'test:message-edit', run: async () => {} },
  ]), /Duplicate visual mock scenario key: test:message-edit\*/);
});

test('visual mock business-domain modules expose their commands through the shared registry', () => {
  const getContext = () => ({});
  const registry = createVisualMockScenarioRegistry([
    ...createContentScenarios(getContext),
    ...createStatusScenarios(getContext),
  ]);

  const commands = registry.commands();
  assert.ok(commands.includes('test:tool'));
  assert.ok(commands.includes('test:subagent'));
  assert.ok(commands.includes('test:statusline'));
  assert.ok(commands.includes('test:needsyou'));
});

// 验收 O71：场景自己抛错时，注册表要把它隔离在这一次调用里。user:message 处理函数是 async 的，拒绝没人接
// Node 会直接退出 mock 进程，同一分片后面的用例全部假红。错误要响亮地记下来（console.error），不能静默吞。
test('场景抛错被隔离：run() 照常返回 true、不往外抛，并记一条错误日志', async t => {
  const logged = [];
  t.mock.method(console, 'error', (...args) => logged.push(args.map(String).join(' ')));
  const registry = createVisualMockScenarioRegistry([
    { command: 'test:boom', run: async ({ activeInst }) => { activeInst.state = 'idle'; } },
  ]);
  assert.equal(await registry.run('test:boom', { activeInst: undefined }), true);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /test:boom/);
  assert.match(logged[0], /TypeError/);
});

// 只打 console.error 不够：Playwright 不看 webServer 的 stderr，场景若在满足 DOM 断言之后才抛，触发它的用例
// 照样绿（PR #249 review）。注册表把错误交给调用方的 onError，mock 记账、E2E 收尾断言它为空。
test('场景抛错交给 onError：带命令名与原始错误，供 E2E 收尾断言', async t => {
  t.mock.method(console, 'error', () => {});
  const seen = [];
  const registry = createVisualMockScenarioRegistry([
    { command: 'test:boom', run: async () => { throw new TypeError('boom'); } },
    { command: 'test:ok', run: async () => {} },
  ], { onError: (command, err) => seen.push([command, err]) });
  assert.equal(await registry.run('test:ok'), true);
  assert.equal(seen.length, 0, '没抛错的场景不该记账');
  assert.equal(await registry.run('test:boom'), true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0][0], 'test:boom');
  assert.ok(seen[0][1] instanceof TypeError);
});
