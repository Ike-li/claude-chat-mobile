// tests/unit/playwright-guard.test.mjs —— Playwright 禁止模式门禁自身
// 那道闸禁的是 test.only/skip/fixme 与 networkidle/waitForTimeout（前者让 e2e 静默少跑，
// 后者制造随机红）。本文件证明它扫得到 tests/e2e 与 tests/playground/e2e 两处，
// 且【扫描面为空时报错】——扫不到文件必须是红，不能当成「没有违规」。
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

// 手写 new Promise(...setTimeout...) 等价于被禁的 waitForTimeout，只是绕过了字面禁令——
// 同样是不稳定的固定等待。但 tests/e2e/mock/ 下的 setTimeout 是模拟服务端时序延迟的工具函数
// （const delay = ms => new Promise(res => setTimeout(res, ms))），用途完全不同，必须排除。
test('手写 new Promise(...setTimeout...) 在 spec 里被抓住，在 tests/e2e/mock/ 下被放行', () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-playwright-guard-settimeout-'));
  try {
    mkdirSync(join(root, 'tests', 'e2e', 'specs'), { recursive: true });
    mkdirSync(join(root, 'tests', 'e2e', 'mock'), { recursive: true });

    writeFileSync(join(root, 'tests', 'e2e', 'mock', 'server.js'),
      "const delay = ms => new Promise(res => setTimeout(res, ms));\nmodule.exports = { delay };\n");
    const cleanMockOnly = run(root);
    assert.equal(cleanMockOnly.status, 0, cleanMockOnly.stderr || cleanMockOnly.stdout);

    writeFileSync(join(root, 'tests', 'e2e', 'specs', 'sleepy.spec.ts'),
      "await new Promise(resolve => setTimeout(resolve, 1000));\n");
    const blocked = run(root);
    assert.equal(blocked.status, 1);
    assert.match(blocked.stderr, /specs\/sleepy\.spec\.ts/);
    assert.match(blocked.stderr, /手写睡眠/);
    assert.doesNotMatch(blocked.stderr, /mock\/server\.js/, 'mock 基建的合法用法不该被同一条规则误伤');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// test.setTimeout(N) 是 Playwright 官方 API（延长这条测试的超时），字面上含 "setTimeout" 子串
// 但语义与"手写睡眠"无关——不能被新规则误伤。
test('test.setTimeout(N)（Playwright 官方的延长测试超时 API）不被新规则误伤', () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-playwright-guard-testtimeout-'));
  try {
    mkdirSync(join(root, 'tests', 'e2e'), { recursive: true });
    writeFileSync(join(root, 'tests', 'e2e', 'slow.spec.ts'),
      "test('slow', async ({ page }) => { test.setTimeout(60_000); });\n");
    const result = run(root);
    assert.equal(result.status, 0, result.stderr || result.stdout);
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
