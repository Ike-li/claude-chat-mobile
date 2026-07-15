import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { parseSmokeArgs, smokeScenarioNames } from '../smoke/runner.js';

test('real Claude smoke runner requires an explicit list, scenario, or all action', () => {
  assert.deepEqual(parseSmokeArgs(['--list']), { action: 'list', names: [], model: null });
  assert.deepEqual(parseSmokeArgs(['--scenario', 'core']), { action: 'run', names: ['core'], model: null });
  assert.deepEqual(parseSmokeArgs(['--all', '--model', 'mimo-v2.5']), {
    action: 'run',
    names: smokeScenarioNames(),
    model: 'mimo-v2.5',
  });
  assert.throws(() => parseSmokeArgs([]), /--list/);
  assert.throws(() => parseSmokeArgs(['--scenario', 'missing']), /Unknown smoke scenario/);
});

test('real Claude smoke scenarios do not hard-code the historical shared work directory', () => {
  const dir = join(import.meta.dirname, '..', 'smoke', 'scenarios');
  for (const name of readdirSync(dir)) {
    const source = readFileSync(join(dir, name), 'utf8');
    assert.doesNotMatch(source, /\/tmp\/ccm-test/, `${name} must use runner-provided WORK_DIR`);
  }
});
