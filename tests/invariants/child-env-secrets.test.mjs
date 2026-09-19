// tests/invariants/child-env-secrets.test.mjs —— CCM 自己的控制面密钥不得随子进程环境流给 claude
// 守护：AUTH-06（sdkChildEnv 必须剥掉 CCM 控制面密钥；claude 自己那份环境原样透传）
// 测什么：AUTH_TOKEN 与 VAPID_* / NTFY_* / CF_ACCESS_* 三组前缀被剥；ANTHROPIC_* / CLAUDE_CODE_* /
//         代理变量 / PATH / HOME 原样透传；以及一道漂移闸——env-schema 里每个标了密钥的键都必须被剥掉
// 不测什么 + 为什么：① worktree settings 的 resolvedEnv 叠加层 —— 那是 agent.js 的 filterSafeResolvedEnv，
//         方向相反的另一道闸，归 tests/unit/agent-background-tasks.test.mjs ② 两个 origin 标记不可被
//         调用方覆盖 —— 模块行为不是红线，归 tests/unit/agent-core.test.mjs ③ 子进程真的拿到了什么 ——
//         需真 spawn，归 S2/S5
// 槽位：S1（纯函数，零 IO）
//
// 【缺陷的真实形态】2026-09-17 安全审查 H1。sdkChildEnv 把整份 process.env 原样传给 claude，
// 而 server 会把 ccm.config.json 的值投影进 process.env（app/src/ops/config.js 的投影循环）。
// 于是 AUTH_TOKEN / VAPID 私钥 / ntfy 令牌全进了子进程——**这比终端更宽、不是等宽**：在普通终端里
// 跑 claude，进程环境里根本没有这几个键，它们只存在于 CCM 自己的配置文件里。
//
// 后果不是「又一次本地 shell」（那本来就是产品立场）：工作区里的提示注入 + 一次已放行的 Bash，
// 模型就能 `echo $AUTH_TOKEN`。拿到的是 Web 控制面钥匙，公网绑着时等于远程入口凭据。
//
// 【为什么两个方向都要钉】只断言「密钥被剥掉」的话，把整份 env 清空也能全绿，而那会砍掉第三方
// 网关那条支持路径（走网关的用户靠 shell 里 export 的 ANTHROPIC_* 生效），症状是「claude 在 web
// 里连不上网关、在终端里好好的」——极难归因到这一行。只证「有效」不证「无害」等于没验。

import test from 'node:test';
import assert from 'node:assert/strict';

import { sdkChildEnv } from '../../app/src/shared/child-env.js';

test('AUTH-06：CCM 控制面密钥不进 claude 子进程', () => {
  const out = sdkChildEnv({
    AUTH_TOKEN: 'ccm-control-plane-key',
    VAPID_PRIVATE_KEY: 'vapid-priv',
    VAPID_PUBLIC_KEY: 'vapid-pub',
    VAPID_SUBJECT: 'mailto:someone@example.com',
    NTFY_TOKEN: 'ntfy-tk',
    NTFY_TOPIC: 'my-secret-topic',
    NTFY_URL: 'https://ntfy.sh',
    CF_ACCESS_AUD: 'aud-value',
    CF_ACCESS_HOSTNAME: 'ccm.example.com',
    CF_ACCESS_TEAM: 'myteam',
  });
  for (const key of Object.keys(out)) {
    assert.ok(!key.startsWith('VAPID_'), `VAPID_* 不得进子进程：${key}`);
    assert.ok(!key.startsWith('NTFY_'), `NTFY_* 不得进子进程：${key}`);
    assert.ok(!key.startsWith('CF_ACCESS_'), `CF_ACCESS_* 不得进子进程：${key}`);
  }
  assert.ok(!Object.hasOwn(out, 'AUTH_TOKEN'), 'AUTH_TOKEN 是控制面钥匙，绝不进子进程');
  // 值层面也查一遍：换个键名把同一个秘密带出去，上面那些键名断言看不见。
  const values = Object.values(out);
  assert.ok(!values.includes('ccm-control-plane-key'));
  assert.ok(!values.includes('vapid-priv'));
  assert.ok(!values.includes('my-secret-topic'));
});

test('AUTH-06 反向：claude 自己那份环境原样透传（终端等价性不能被剥没）', () => {
  const out = sdkChildEnv({
    ANTHROPIC_BASE_URL: 'https://gateway.example',
    ANTHROPIC_AUTH_TOKEN: 'gateway-key',
    ANTHROPIC_API_KEY: 'sk-x',
    CLAUDE_CODE_EFFORT_LEVEL: 'high',
    HTTPS_PROXY: 'http://127.0.0.1:7890',
    HTTP_PROXY: 'http://127.0.0.1:7890',
    NO_PROXY: 'localhost',
    PATH: '/usr/bin',
    HOME: '/home/u',
  });
  assert.equal(out.ANTHROPIC_BASE_URL, 'https://gateway.example');
  assert.equal(out.ANTHROPIC_AUTH_TOKEN, 'gateway-key', '网关凭据是 claude 的，不是 CCM 的——不能剥');
  assert.equal(out.ANTHROPIC_API_KEY, 'sk-x');
  assert.equal(out.CLAUDE_CODE_EFFORT_LEVEL, 'high');
  assert.equal(out.HTTPS_PROXY, 'http://127.0.0.1:7890');
  assert.equal(out.HTTP_PROXY, 'http://127.0.0.1:7890');
  assert.equal(out.NO_PROXY, 'localhost');
  assert.equal(out.PATH, '/usr/bin');
  assert.equal(out.HOME, '/home/u');
});

// 漂移闸：child-env.js 在 src/shared（叶子层），**不能** import src/ops 的 env-schema —— 模块边界
// 守卫会拦（check 一环）。所以那份剥离清单只能是硬编码的，而硬编码清单会随 schema 新增密钥而过期，
// 且过期的表现是「新密钥照样进子进程」，没有任何东西会报错。
// 这条测试就是那个报错：schema 里每一个标了密钥的键，都必须被 sdkChildEnv 剥掉。
test('AUTH-06 漂移闸：env-schema 里每个密钥键都必须被剥掉', async () => {
  const { ENV_SCHEMA } = await import('../../app/src/ops/env-schema.js');
  // 与 env-schema.js 内部 buildEnvView 同一条判据（`!!def.secret || def.kind === 'secret'`）
  const secretKeys = Object.entries(ENV_SCHEMA)
    .filter(([, def]) => !!def.secret || def.kind === 'secret')
    .map(([key]) => key);

  assert.ok(secretKeys.length >= 4, `schema 里应有若干密钥键，实际 ${secretKeys.length} 个——判据可能改了`);
  const probe = Object.fromEntries(secretKeys.map(k => [k, `SECRET_VALUE_OF_${k}`]));
  const out = sdkChildEnv(probe);
  for (const key of secretKeys) {
    assert.ok(!Object.hasOwn(out, key),
      `env-schema 把 ${key} 标成了密钥，但 child-env.js 的剥离清单漏了它——把它加进去`);
  }
});
