import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const guard = resolve('tests/gates/check-playwright-forbidden-patterns.js');

test('Playwright guard scans tests/e2e and tests/playground/e2e, not node:test playground files', () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-playwright-guard-'));
  try {
    mkdirSync(join(root, 'tests', 'e2e'), { recursive: true });
    mkdirSync(join(root, 'tests', 'unit'), { recursive: true });
    mkdirSync(join(root, 'tests', 'playground'), { recursive: true });
    writeFileSync(join(root, 'tests', 'e2e', 'ok.spec.ts'), "test('ok', () => {});\n");
    writeFileSync(join(root, 'tests', 'unit', 'platform.test.mjs'), "test.skip('POSIX only', () => {});\n");
    writeFileSync(join(root, 'tests', 'playground', 'http-probes.test.mjs'), "test.skip('node:test skip is legal', () => {});\n");

    const clean = spawnSync(process.execPath, [guard], { cwd: root, encoding: 'utf8' });
    assert.equal(clean.status, 0, clean.stderr || clean.stdout);

    writeFileSync(join(root, 'tests', 'e2e', 'bad.spec.ts'), "test.skip('hidden regression', () => {});\n");
    const blockedE2e = spawnSync(process.execPath, [guard], { cwd: root, encoding: 'utf8' });
    assert.equal(blockedE2e.status, 1);
    assert.match(blockedE2e.stderr, /tests\/e2e\/bad\.spec\.ts/);

    mkdirSync(join(root, 'tests', 'playground', 'e2e'), { recursive: true });
    writeFileSync(join(root, 'tests', 'playground', 'e2e', 'bad.spec.ts'), "test.skip('hidden playground regression', () => {});\n");
    const blockedPlayground = spawnSync(process.execPath, [guard], { cwd: root, encoding: 'utf8' });
    assert.equal(blockedPlayground.status, 1);
    assert.match(blockedPlayground.stderr, /tests\/playground\/e2e\/bad\.spec\.ts/);
    assert.doesNotMatch(blockedPlayground.stderr, /http-probes\.test\.mjs/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
