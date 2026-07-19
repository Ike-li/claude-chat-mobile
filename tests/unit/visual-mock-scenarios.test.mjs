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
