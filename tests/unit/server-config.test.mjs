import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  getShellEnvSnapshot,
  loadRuntimeEnvironment,
  normalizeLoadedEnvironment,
  parseServerConfig,
} from '../../src/ops/config.js';

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
    // 模拟外层 export 了空串——dotenv 默认不覆盖已有 key
    const env = { AUTH_TOKEN: '', CCM_DATA_DIR: '' };

    loadRuntimeEnvironment(env, { envFile, quiet: true });

    assert.equal(env.AUTH_TOKEN, 'from-dotenv-token');
    assert.equal(env.CCM_DATA_DIR, '/external/from-dotenv');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadRuntimeEnvironment：测试 child 的显式空认证配置不被 .env 回填', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccm-env-test-empty-'));
  try {
    const envFile = join(dir, '.env');
    writeFileSync(envFile, [
      'AUTH_TOKEN=from-dotenv-token',
      'CF_ACCESS_HOSTNAME=chat.example.com',
      'CF_ACCESS_TEAM=test-team',
      'CF_ACCESS_AUD=test-aud',
      'CLAUDE_BIN=/from-dotenv/claude',
    ].join('\n'));
    const env = {
      CCM_TEST_PRESERVE_EMPTY_ENV: '1',
      AUTH_TOKEN: '',
      CF_ACCESS_HOSTNAME: '',
      CF_ACCESS_TEAM: '',
      CF_ACCESS_AUD: '',
    };

    loadRuntimeEnvironment(env, { envFile, quiet: true });

    assert.equal(env.AUTH_TOKEN, undefined);
    assert.equal(env.CF_ACCESS_HOSTNAME, undefined);
    assert.equal(env.CF_ACCESS_TEAM, undefined);
    assert.equal(env.CF_ACCESS_AUD, undefined);
    assert.equal(env.CLAUDE_BIN, '/from-dotenv/claude');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── P1a：统一配置文件 ccm.config.json ────────────────────────────────────────
//
// 上面四条锁的是 .env 路径（仍受支持：显式 --env=prod.env 与迁移期回落都走它）。
// 这三条锁新路径 —— 重点是**类型化只发生在配置层内部**：JSON 里写 boolean / number，
// 投影回 process.env 之后仍是那 7 处消费点认得的字面量，消费点一行不改。
test('loadRuntimeEnvironment：读 ccm.config.json，结构化值投影成消费点认得的字面量', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccm-config-json-'));
  try {
    writeFileSync(join(dir, 'ccm.config.json'), JSON.stringify({
      $schemaVersion: 1,
      PORT: 4100,
      AUTH_TOKEN: 'from-json',
      WEB_STATUSLINE: false,   // 默认开的项，关掉 → 必须投成 'off'
      DEV_MODE: true,          // 默认关的项，打开 → 必须投成 '1'
      LOG_TERMINAL: true,      // 第三套字面量 → 必须投成 'on'
      CCM_DATA_DIR: '/external/data', // passthrough：不在 ENV_SCHEMA 里也要活下来
    }));
    const env = {};

    loadRuntimeEnvironment(env, { dir, quiet: true });

    assert.equal(env.PORT, '4100');
    assert.equal(env.AUTH_TOKEN, 'from-json');
    assert.equal(env.WEB_STATUSLINE, 'off');      // app.js:1229 判 === 'off'
    assert.equal(env.DEV_MODE, '1');              // config.js:65 判 === '1'
    assert.equal(env.LOG_TERMINAL, 'on');         // log-terminal.js:33 判 !== 'on'
    assert.equal(env.CCM_DATA_DIR, '/external/data');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadRuntimeEnvironment：开关为默认态时不写 key —— 空串 ≡ 未设置', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccm-config-default-'));
  try {
    writeFileSync(join(dir, 'ccm.config.json'), JSON.stringify({
      WEB_STATUSLINE: true,  // 默认就是开 → 不该留下 WEB_STATUSLINE=''
      DEV_MODE: false,       // 默认就是关 → 同理
    }));
    const env = {};

    loadRuntimeEnvironment(env, { dir, quiet: true });

    assert.equal(env.WEB_STATUSLINE, undefined);
    assert.equal(env.DEV_MODE, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadRuntimeEnvironment：shell 值仍然压过 ccm.config.json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccm-config-shell-wins-'));
  try {
    writeFileSync(join(dir, 'ccm.config.json'), JSON.stringify({ PORT: 4100, AUTH_TOKEN: 'from-json' }));
    const env = { PORT: '9000' };

    loadRuntimeEnvironment(env, { dir, quiet: true });

    assert.equal(env.PORT, '9000');          // shell 赢
    assert.equal(env.AUTH_TOKEN, 'from-json'); // 未被 shell 指定的仍从文件来
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// VC-D4-02 的地基：配置面板要标出「这一行被 shell 环境变量压过了」，就必须拿到一份
// **投影之前**的 env 快照。投影之后文件值也进了 process.env（上面那条「shell 赢」测的正是
// 这个投影），来源就再也分不开——那时做出来的标注是永远不报的假功能。
//
// 快照刻意由 loadRuntimeEnvironment 自己在第一行拍，而不是像 scripts/doctor.js:673 那样
// 靠调用方守一句注释：顺序由构造保证，写不错。下面两条锁的就是这个不变量。
test('getShellEnvSnapshot：快照拍在投影之前 —— 文件值不得混进来（否则每一项都会被标成「被覆盖」）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccm-shell-snapshot-'));
  try {
    writeFileSync(join(dir, 'ccm.config.json'), JSON.stringify({ PORT: 4100, AUTH_TOKEN: 'from-json' }));
    const env = { WORK_DIR: '/from/shell' };

    loadRuntimeEnvironment(env, { dir, quiet: true });

    const snap = getShellEnvSnapshot();
    assert.equal(snap.WORK_DIR, '/from/shell', 'shell 真的设过的要在');
    assert.equal(snap.PORT, undefined, '文件值不能出现在快照里');
    assert.equal(snap.AUTH_TOKEN, undefined, '同上');
    // 投影确实发生过——否则上面两条会因为「压根没投影」而假绿
    assert.equal(env.PORT, '4100');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('getShellEnvSnapshot：是拷贝不是引用 —— 后续投影改 env 不得回写快照', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccm-shell-snapshot-copy-'));
  try {
    writeFileSync(join(dir, 'ccm.config.json'), JSON.stringify({ PORT: 4100 }));
    const env = {};
    loadRuntimeEnvironment(env, { dir, quiet: true });
    env.LATER_SET = 'x';
    assert.equal(getShellEnvSnapshot().LATER_SET, undefined);
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
    // 模拟外层 export 了空串——ANTHROPIC_* 无论空串还是完全未设，都只认真实 shell 值。
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
