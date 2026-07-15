import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const guard = resolve('scripts/check-playwright-forbidden-patterns.js');

test('Playwright guard scans only tests/e2e after the test tree consolidation', () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-playwright-guard-'));
  try {
    mkdirSync(join(root, 'tests', 'e2e'), { recursive: true });
    mkdirSync(join(root, 'tests', 'unit'), { recursive: true });
    writeFileSync(join(root, 'tests', 'e2e', 'ok.spec.ts'), "test('ok', () => {});\n");
    writeFileSync(join(root, 'tests', 'unit', 'platform.test.mjs'), "test.skip('POSIX only', () => {});\n");

    const clean = spawnSync(process.execPath, [guard], { cwd: root, encoding: 'utf8' });
    assert.equal(clean.status, 0, clean.stderr);

    writeFileSync(join(root, 'tests', 'e2e', 'bad.spec.ts'), "test.skip('hidden regression', () => {});\n");
    const blocked = spawnSync(process.execPath, [guard], { cwd: root, encoding: 'utf8' });
    assert.equal(blocked.status, 1);
    assert.match(blocked.stderr, /tests\/e2e\/bad\.spec\.ts/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
