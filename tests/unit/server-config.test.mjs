import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  loadRuntimeEnvironment,
  normalizeLoadedEnvironment,
  parseServerConfig,
} from '../../src/server/config.js';

test('loadRuntimeEnvironment reads CCM_DATA_DIR before runtime modules are imported', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccm-env-bootstrap-'));
  try {
    const envFile = join(dir, '.env');
    writeFileSync(envFile, [
      'CCM_DATA_DIR=/external/from-dotenv',
      'ANTHROPIC_API_KEY=must-not-leak-from-dotenv',
      'EMPTY=',
    ].join('\n'));
    const env = { ANTHROPIC_AUTH_TOKEN: 'kept-from-shell' };

    loadRuntimeEnvironment(env, { envFile, quiet: true });

    assert.equal(env.CCM_DATA_DIR, '/external/from-dotenv');
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'kept-from-shell');
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.equal(env.EMPTY, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadRuntimeEnvironment：shell 空串 AUTH_TOKEN/CCM_DATA_DIR 不挡 .env 填入（SH-001）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccm-env-empty-shell-'));
  try {
    const envFile = join(dir, '.env');
    writeFileSync(envFile, [
      'AUTH_TOKEN=from-dotenv-token',
      'CCM_DATA_DIR=/external/from-dotenv',
    ].join('\n'));
    // 模拟 LaunchAgent/systemd export 了空串——dotenv 默认不覆盖已有 key
    const env = { AUTH_TOKEN: '', CCM_DATA_DIR: '' };

    loadRuntimeEnvironment(env, { envFile, quiet: true });

    assert.equal(env.AUTH_TOKEN, 'from-dotenv-token');
    assert.equal(env.CCM_DATA_DIR, '/external/from-dotenv');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadRuntimeEnvironment：shell 空串 ANTHROPIC_* 不应被 .env 填入（SH-001 回归）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccm-env-empty-anthropic-'));
  try {
    const envFile = join(dir, '.env');
    writeFileSync(envFile, [
      'ANTHROPIC_API_KEY=sk-ant-should-NOT-leak-per-README-and-doctor-contract',
    ].join('\n'));
    // 模拟 LaunchAgent/systemd export 了空串——ANTHROPIC_* 无论空串还是完全未设，都只认真实 shell 值。
    const env = { ANTHROPIC_API_KEY: '' };

    loadRuntimeEnvironment(env, { envFile, quiet: true });

    assert.equal(env.ANTHROPIC_API_KEY, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('normalizeLoadedEnvironment removes empty values and .env-only ANTHROPIC keys', () => {
  const env = {
    KEEP: 'yes',
    EMPTY: '',
    ANTHROPIC_AUTH_TOKEN: 'from-shell',
    ANTHROPIC_API_KEY: 'from-dotenv',
  };

  normalizeLoadedEnvironment(env, new Set(['ANTHROPIC_AUTH_TOKEN']));

  assert.deepEqual(env, {
    KEEP: 'yes',
    ANTHROPIC_AUTH_TOKEN: 'from-shell',
  });
});

test('parseServerConfig preserves public defaults and supports external CCM_DATA_DIR', () => {
  const config = parseServerConfig({
    PORT: '3100',
    AUTH_TOKEN: 'token',
    INSTANCE_IDLE_RECLAIM_MS: '0',
    CCM_DATA_DIR: '/external/ccm-data',
  }, { home: '/home/example', projectRoot: '/repo' });

  assert.equal(config.port, 3100);
  assert.equal(config.authToken, 'token');
  assert.equal(config.instanceIdleReclaimMs, 0);
  assert.equal(config.workDir, '/home/example');
  assert.equal(config.dataDir, '/external/ccm-data');
  assert.equal(config.idleTimeoutMs, 600000);
  assert.equal(config.approvalTtlMs, 1800000);
  assert.equal(config.notifyThrottleMs, 60000);
  assert.equal(config.sessionDeleteQuietMs, 300000);
});

test('parseServerConfig falls back safely for invalid numeric configuration', () => {
  const config = parseServerConfig({
    PORT: '-1',
    IDLE_TIMEOUT_MS: 'NaN',
    INSTANCE_IDLE_RECLAIM_MS: '-2',
    APPROVAL_TTL_MS: '0',
    NOTIFY_THROTTLE_MS: 'bad',
    SESSION_DELETE_QUIET_MS: '-1',
  }, { home: '/home/example', projectRoot: '/repo' });

  assert.equal(config.port, 3000);
  assert.equal(config.idleTimeoutMs, 600000);
  assert.equal(config.instanceIdleReclaimMs, 1800000);
  assert.equal(config.approvalTtlMs, 1800000);
  assert.equal(config.notifyThrottleMs, 60000);
  assert.equal(config.sessionDeleteQuietMs, 300000);
  assert.equal(config.dataDir, join('/repo', 'data'));
});
