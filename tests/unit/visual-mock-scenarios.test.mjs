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
