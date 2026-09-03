// 容器内装机路径：非交互 setup 写 HOME 配置，不得改 overlay 上的 /app/ccm.config.json。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { test } from 'node:test';

const HOME_CONFIG = '/home/ccm-test/ccm.config.json';
const OVERLAY_CONFIG = '/app/ccm.config.json';

test('non-interactive setup writes 0600 config in HOME and leaves the overlay alone', () => {
  rmSync(HOME_CONFIG, { force: true });
  const result = spawnSync(process.execPath, [
    'scripts/setup.js',
    '--yes',
    '--work-dir=/home/ccm-test/workspace',
    '--hooks=off',
    '--desktop=off',
    `--config=${HOME_CONFIG}`,
  ], { cwd: '/app', encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr + result.stdout);

  const st = statSync(HOME_CONFIG);
  assert.equal(st.mode & 0o777, 0o600);
  const written = JSON.parse(readFileSync(HOME_CONFIG, 'utf8'));
  assert.ok(written.AUTH_TOKEN);
  assert.equal(written.WORK_DIR, '/home/ccm-test/workspace');
  assert.equal(existsSync('/home/ccm-test/.claude/settings.json'), false);

  assert.equal(existsSync('/app/.env'), false, '宿主机 .env 不得出现在容器 /app');
  assert.equal(existsSync(OVERLAY_CONFIG), false, 'setup --config=HOME 不得写默认 /app/ccm.config.json');
});
