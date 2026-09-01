import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { parseSmokeArgs, smokeScenarioNames, stripInheritedEnv, SMOKE_ENV_BLOCKLIST } from '../smoke/runner.js';

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

// stripInheritedEnv：smoke 用 {...process.env} 继承调用者环境，而调用者未必干净——
// 2026-09-01 实测，从 CCM web 端启动的 Claude Code 会话继承了生产 server 的整份环境，
// CF_ACCESS_* 流进 smoke 实例后它真的去拉了生产 team 的 JWKS。
test.describe('stripInheritedEnv：不把生产环境带进 smoke 实例', () => {
  test('摘掉 CF Access 三键（否则实例会启用 Access 并对外拉证书）', () => {
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

  test('摘掉 WORK_DIRS_FILE：它会盖掉 runner 显式传的 WORK_DIRS', () => {
    assert.equal('WORK_DIRS_FILE' in stripInheritedEnv({ WORK_DIRS_FILE: '/etc/workdirs.json' }), false);
  });

  test('是删除而不是置空串（空串会在被 loadRuntimeEnvironment 清理前被读到，语义分叉）', () => {
    const out = stripInheritedEnv({ CF_ACCESS_TEAM: 'team' });
    assert.equal(Object.prototype.hasOwnProperty.call(out, 'CF_ACCESS_TEAM'), false);
  });

  test('不改动入参（纯函数）', () => {
    const input = { CF_ACCESS_TEAM: 'team' };
    stripInheritedEnv(input);
    assert.equal(input.CF_ACCESS_TEAM, 'team');
  });

  test('AUTH_TOKEN 不在清单里——runner 随后会显式覆盖它，删掉反而让意图不明显', () => {
    assert.equal(SMOKE_ENV_BLOCKLIST.includes('AUTH_TOKEN'), false);
  });
});
