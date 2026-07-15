import test from 'node:test';
import assert from 'node:assert/strict';
import { unitTestFiles } from '../../scripts/coverage-check.js';

test('coverage check expands unit test files without relying on shell globs', () => {
  const files = unitTestFiles();

  assert.ok(files.length > 1);
  assert.ok(files.every(file => file.startsWith('tests/unit/') && file.endsWith('.test.mjs')));
  assert.ok(files.includes('tests/unit/agent-core.test.mjs'));
  assert.ok(files.includes('tests/unit/agent-permissions.test.mjs'));
  assert.ok(!files.includes('tests/unit/agent.test.mjs'));
});
