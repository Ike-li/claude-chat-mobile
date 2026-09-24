// tests/unit/spawn-env.test.mjs —— 被测 server 子进程的环境隔离清单（smoke 与集成测共用）。
// 动机见 tests/helpers/spawn-env.mjs 头注：两边都用 {...process.env} 继承调用者环境，而
// 从 CCM web 端启动的 Claude Code 会话继承的是生产 server 进程的整份环境。
import test from 'node:test';
import assert from 'node:assert/strict';
import { stripInheritedEnv, SPAWN_ENV_BLOCKLIST } from '../helpers/spawn-env.mjs';
import { ALL_CONFIG_KEYS } from '../../app/src/ops/config-file.js';

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

  // 2026-09-23：在 CCM 驱动的会话里跑冒烟，shell 继承了生产 server 投影进环境的配置
  // （DEVICE_APPROVAL_SCOPE=all 等），被测 server 于是要求设备审批，冒烟客户端卡在 pending、
  // 120s 超时——看着像 SDK 出了问题。逐个列键的清单在这里漏过一次，所以按配置面整体摘。
  // 配置面包括 passthrough 那几个（不进面板但照样投影进环境）：遗留的 WORK_DIR 一旦继承，
  // resolveEnvPrimaryWorkdir 会把它当 shell 显式给的主目录折进列表首位——不带 cwd 的场景就跑在生产目录上。
  test('配置键（env-schema 与 passthrough）一律不继承，只透传 AUTH_TOKEN / PORT / CLAUDE_BIN / CCM_DATA_DIR', () => {
    const inherited = Object.fromEntries(ALL_CONFIG_KEYS.map(key => [key, 'from-production']));
    const out = stripInheritedEnv({ ...inherited, PATH: '/usr/bin' });
    assert.deepEqual(
      Object.keys(out).sort(), ['AUTH_TOKEN', 'CCM_DATA_DIR', 'CLAUDE_BIN', 'PATH', 'PORT'],
      'AUTH_TOKEN / PORT 调用方随后一定覆盖；CLAUDE_BIN 是 CI 与容器把被测实例指向 fake-claude 的开关；'
      + 'CCM_DATA_DIR 是 preload-env 给测试进程的一次性目录，摘掉的话漏传它的调用方会落到仓库 data/。其余配置只能由调用方显式给',
    );
  });

  // 从 Claude 会话里起被测实例时，shell 带着那个会话的身份变量。SDK 只在 CLAUDE_CODE_ENTRYPOINT
  // 未设置时才填 sdk-ts，继承下去的若是终端会话的 cli，被测实例写的每一行都会被 CCM 当成终端写的。
  test('启动它的那个 Claude 会话的身份变量不继承；网关、凭据与用户自配的 CLAUDE_CODE_* 照常透传', () => {
    const out = stripInheritedEnv({
      CLAUDECODE: '1',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDE_CODE_SESSION_ID: 'parent-session',
      CLAUDE_CODE_CHILD_SESSION: '1',
      CLAUDE_CODE_SESSION_ATTENDED: '1',
      CLAUDE_CODE_EXECPATH: '/usr/local/bin/claude',
      CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/parent.sock',
      CLAUDE_CODE_MESSAGING_TOKEN: 'parent-token',
      CLAUDE_PID: '4242',
      CLAUDE_EFFORT: 'max',
      ANTHROPIC_BASE_URL: 'https://gateway.example.com',
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
    });
    assert.deepEqual(
      Object.keys(out).sort(), ['ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN'],
      '冒烟要真打模型，网关与凭据得留着；CLAUDE_CODE_* 里也有用户自己配的，不能按前缀一刀切',
    );
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
