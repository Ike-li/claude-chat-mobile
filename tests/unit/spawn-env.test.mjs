// tests/unit/spawn-env.test.mjs —— 被测 server 子进程的环境隔离清单（smoke 与集成测共用）。
// 动机见 tests/helpers/spawn-env.mjs 头注：两边都用 {...process.env} 继承调用者环境，而
// 从 CCM web 端启动的 Claude Code 会话继承的是生产 server 进程的整份环境。
import test from 'node:test';
import assert from 'node:assert/strict';
import { stripInheritedEnv, SPAWN_ENV_BLOCKLIST } from '../helpers/spawn-env.mjs';

test.describe('stripInheritedEnv：不把生产环境带进被测实例', () => {
  test('摘掉 CF Access 三键（否则实例会启用 Access 并对外拉生产 team 的 JWKS）', () => {
    const out = stripInheritedEnv({
      CF_ACCESS_HOSTNAME: 'ccm.example.com', CF_ACCESS_TEAM: 'team', CF_ACCESS_AUD: 'aud', PATH: '/usr/bin',
    });
    assert.equal('CF_ACCESS_HOSTNAME' in out, false);
    assert.equal('CF_ACCESS_TEAM' in out, false);
    assert.equal('CF_ACCESS_AUD' in out, false);
    assert.equal(out.PATH, '/usr/bin', '无关键必须原样保留');
  });

  test('摘掉推送密钥与外部通知通道', () => {
    const out = stripInheritedEnv({
      VAPID_PRIVATE_KEY: 'k', VAPID_PUBLIC_KEY: 'p', VAPID_SUBJECT: 'mailto:a@b.c',
      NTFY_URL: 'https://ntfy.sh', NTFY_TOPIC: 't', PUBLIC_URL: 'https://prod.example.com',
    });
    assert.deepEqual(Object.keys(out), []);
  });

  test('摘掉 WORK_DIRS_FILE：它会盖掉调用方显式传的 WORK_DIRS', () => {
    assert.equal('WORK_DIRS_FILE' in stripInheritedEnv({ WORK_DIRS_FILE: '/etc/workdirs.json' }), false);
  });

  test('摘掉 BIND_MODE / BIND_HOST：父 shell 的 custom+空 host 会让每个被测实例拒绝启动', () => {
    const out = stripInheritedEnv({ BIND_MODE: 'custom', BIND_HOST: '::', PATH: '/usr/bin' });
    assert.equal('BIND_MODE' in out, false);
    assert.equal('BIND_HOST' in out, false);
    assert.equal(out.PATH, '/usr/bin');
  });

  test('摘掉两个桥的血统标记（继承会让来源判定失真）', () => {
    const out = stripInheritedEnv({ CCM_HOOKS_ORIGIN: 'web-sdk', CCM_STATUSLINE_ORIGIN: 'web-sdk' });
    assert.deepEqual(Object.keys(out), []);
  });

  test('是删除而不是置空串（空串在被 loadRuntimeEnvironment 清理前若被读到，语义就分叉）', () => {
    const out = stripInheritedEnv({ CF_ACCESS_TEAM: 'team' });
    assert.equal(Object.prototype.hasOwnProperty.call(out, 'CF_ACCESS_TEAM'), false);
  });

  test('不改动入参（纯函数）', () => {
    const input = { CF_ACCESS_TEAM: 'team' };
    stripInheritedEnv(input);
    assert.equal(input.CF_ACCESS_TEAM, 'team');
  });

  test('AUTH_TOKEN / WORK_DIR / CCM_DATA_DIR 不在清单里——调用方随后会显式覆盖，删掉反而让意图不明显', () => {
    for (const key of ['AUTH_TOKEN', 'WORK_DIR', 'CCM_DATA_DIR', 'PORT']) {
      assert.equal(SPAWN_ENV_BLOCKLIST.includes(key), false, `${key} 不该进 blocklist`);
    }
  });

  test('清单是冻结的：调用方不得就地改它（会影响另一个共用者）', () => {
    assert.equal(Object.isFrozen(SPAWN_ENV_BLOCKLIST), true);
  });
});
