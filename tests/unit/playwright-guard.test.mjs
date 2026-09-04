import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const guard = resolve('tests/gates/check-playwright-forbidden-patterns.js');
const run = root => spawnSync(process.execPath, [guard, root], { encoding: 'utf8' });

test('Playwright guard scans tests/e2e and tests/playground/e2e, not node:test playground files', () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-playwright-guard-'));
  try {
    mkdirSync(join(root, 'tests', 'e2e'), { recursive: true });
    mkdirSync(join(root, 'tests', 'unit'), { recursive: true });
    mkdirSync(join(root, 'tests', 'playground'), { recursive: true });
    writeFileSync(join(root, 'tests', 'e2e', 'ok.spec.ts'), "test('ok', () => {});\n");
    writeFileSync(join(root, 'tests', 'unit', 'platform.test.mjs'), "test.skip('POSIX only', () => {});\n");
    writeFileSync(join(root, 'tests', 'playground', 'http-probes.test.mjs'), "test.skip('node:test skip is legal', () => {});\n");

    const clean = run(root);
    assert.equal(clean.status, 0, clean.stderr || clean.stdout);

    writeFileSync(join(root, 'tests', 'e2e', 'bad.spec.ts'), "test.skip('hidden regression', () => {});\n");
    const blockedE2e = run(root);
    assert.equal(blockedE2e.status, 1);
    assert.match(blockedE2e.stderr, /tests\/e2e\/bad\.spec\.ts/);

    mkdirSync(join(root, 'tests', 'playground', 'e2e'), { recursive: true });
    writeFileSync(join(root, 'tests', 'playground', 'e2e', 'bad.spec.ts'), "test.skip('hidden playground regression', () => {});\n");
    const blockedPlayground = run(root);
    assert.equal(blockedPlayground.status, 1);
    assert.match(blockedPlayground.stderr, /tests\/playground\/e2e\/bad\.spec\.ts/);
    assert.doesNotMatch(blockedPlayground.stderr, /http-probes\.test\.mjs/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// TARGET_DIRS 与 tests/infra/playwright.config.ts 的 testDir 是两份独立真相。改 config 漏改门禁时，
// 此前的行为是 existsSync 跳过 → 扫 0 个文件 → 打印「✅ 通过」并退出 0：E2E 照跑、门禁永久失明、
// npm run check 全绿。扫描面塌陷必须与「没有违规」区分开。
test('扫描面为空时报错，不当成「没有违规」', () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-playwright-guard-empty-'));
  try {
    const result = run(root);
    assert.equal(result.status, 1, '目标目录不存在时必须红，不能静默通过');
    assert.match(result.stderr, /扫描面塌了/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
