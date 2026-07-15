import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readCliStatusSnapshot } from '../../src/ops/cli-statusline-bridge.js';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const RUNNER = join(ROOT, 'scripts', 'statusline-bridge.js');
const RENDERER = [process.execPath, '-e', `
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { raw += chunk; });
  process.stdin.on('end', () => {
    process.stdout.write(raw);
    process.stderr.write('renderer-stderr');
  });
`];

test('runner：web-sdk origin 不 capture，但 renderer 的 stdin/stdout/stderr/退出码保持透明', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccm-statusline-runner-sdk-'));
  const raw = JSON.stringify({
    session_id: 'session-sdk',
    workspace: { current_dir: '/repo' },
    effort: { level: 'low' },
  });
  try {
    const result = spawnSync(process.execPath, [
      RUNNER,
      '--snapshot-dir', dir,
      '--refresh-interval', '60',
      '--', ...RENDERER,
    ], {
      input: raw,
      encoding: 'utf8',
      env: { ...process.env, CCM_STATUSLINE_ORIGIN: 'web-sdk' },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, raw);
    assert.equal(result.stderr, 'renderer-stderr');
    assert.deepEqual(readdirSync(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runner：standalone CLI 透明渲染并写入可验证的新鲜快照', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccm-statusline-runner-cli-'));
  const raw = JSON.stringify({
    session_id: 'session-cli',
    workspace: { current_dir: '/repo' },
    model: { id: 'cli-model', display_name: 'CLI Model' },
    effort: { level: 'max' },
  });
  const env = { ...process.env };
  delete env.CCM_STATUSLINE_ORIGIN;
  try {
    const result = spawnSync(process.execPath, [
      RUNNER,
      '--snapshot-dir', dir,
      '--refresh-interval', '60',
      '--', ...RENDERER,
    ], { input: raw, encoding: 'utf8', env });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, raw);
    assert.equal(result.stderr, 'renderer-stderr');
    assert.equal(readdirSync(dir).length, 1);

    const read = readCliStatusSnapshot('session-cli', {
      dir, cwd: '/repo', now: Date.now(), ttlMs: 10_000,
    });
    assert.equal(read.state, 'fresh');
    assert.equal(read.snapshot.model.id, 'cli-model');
    assert.equal(read.snapshot.effort, 'max');
    assert.equal(read.snapshot.refreshIntervalSec, 60);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runner：未传 --snapshot-dir 时尊重 CLI_STATUSLINE_DIR，与 server 自定义目录保持一致', () => {
  const home = mkdtempSync(join(tmpdir(), 'ccm-statusline-runner-env-'));
  const dir = join(home, 'shared-snapshots');
  const raw = JSON.stringify({
    session_id: 'session-env-dir',
    workspace: { current_dir: '/repo' },
  });
  const env = { ...process.env, HOME: home, USERPROFILE: home, CLI_STATUSLINE_DIR: dir };
  delete env.CCM_STATUSLINE_ORIGIN;
  try {
    const result = spawnSync(process.execPath, [RUNNER, '--', ...RENDERER], {
      input: raw, encoding: 'utf8', env,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(readdirSync(dir).length, 1);
    assert.equal(readCliStatusSnapshot('session-env-dir', {
      dir, cwd: '/repo', now: Date.now(), ttlMs: 10_000,
    }).state, 'fresh');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('runner：renderer 非零退出码与输出保持透明', () => {
  const result = spawnSync(process.execPath, [
    RUNNER,
    '--', process.execPath, '-e', `
      let raw = '';
      process.stdin.on('data', chunk => { raw += chunk; });
      process.stdin.on('end', () => {
        process.stdout.write('out:' + raw);
        process.stderr.write('renderer-error');
        process.exitCode = 7;
      });
    `,
  ], {
    input: 'exact-input',
    encoding: 'utf8',
    env: { ...process.env, CCM_STATUSLINE_ORIGIN: 'web-sdk' },
  });

  assert.equal(result.status, 7);
  assert.equal(result.stdout, 'out:exact-input');
  assert.equal(result.stderr, 'renderer-error');
});

test('runner：renderer 提前退出不读 stdin 时吞掉 EPIPE，并保留 renderer 退出码', () => {
  const result = spawnSync(process.execPath, [
    RUNNER,
    '--', process.execPath, '-e', 'process.exit(7)',
  ], {
    input: 'x'.repeat(1024 * 1024),
    encoding: 'utf8',
    env: { ...process.env, CCM_STATUSLINE_ORIGIN: 'web-sdk' },
  });

  assert.equal(result.status, 7, result.stderr);
  assert.doesNotMatch(result.stderr, /EPIPE|Unhandled/i);
});

test('runner：capture 写失败不影响 renderer', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccm-statusline-runner-fail-'));
  try {
    const notDirectory = join(dir, 'not-a-directory');
    writeFileSync(notDirectory, 'x');
    const raw = JSON.stringify({
      session_id: 'session-write-fail',
      workspace: { current_dir: '/repo' },
    });
    const env = { ...process.env };
    delete env.CCM_STATUSLINE_ORIGIN;
    delete env.CCM_STATUSLINE_DEBUG;

    const result = spawnSync(process.execPath, [
      RUNNER,
      '--snapshot-dir', notDirectory,
      '--', ...RENDERER,
    ], { input: raw, encoding: 'utf8', env });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, raw);
    assert.equal(result.stderr, 'renderer-stderr');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
