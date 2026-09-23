// tests/invariants/child-env-secrets.test.mjs —— CCM 自己的控制面密钥不得随子进程环境流出去
// 守护：AUTH-06（childEnv / sdkChildEnv 必须剥掉 CCM 控制面密钥；claude 自己那份环境原样透传）
// 测什么：AUTH_TOKEN 与 VAPID_* / NTFY_* / CF_ACCESS_* 三组前缀被剥；ANTHROPIC_* / CLAUDE_CODE_* /
//         代理变量 / PATH / HOME 原样透传；一道漂移闸——env-schema 里每个标了密钥的键都必须被剥掉；
//         以及 server 自己派生的 git（变更面板、状态栏）与 `claude --version`（doctor）真的拿不到它们
// 不测什么 + 为什么：① worktree settings 的 resolvedEnv 叠加层 —— 那是 agent.js 的 filterSafeResolvedEnv，
//         方向相反的另一道闸，归 tests/unit/agent-background-tasks.test.mjs ② 两个 origin 标记不可被
//         调用方覆盖 —— 模块行为不是红线，归 tests/unit/agent-core.test.mjs ③ SDK 会话与启动横幅那次
//         `claude --version` 的真 spawn —— 要起真 server，归 S2/S5
// 槽位：S1（纯函数 + 一次性目录里的真 git / sh 子进程）
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
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { childEnv, sdkChildEnv } from '../../app/src/shared/child-env.js';
import { listGitChanges } from '../../app/src/files/git-workspace.js';
import { gitStatus } from '../../app/src/ops/statusline.js';
import { probeClaudeBin } from '../../app/src/ops/doctor-runtime.js';

// 两个出口同一道闸：sdkChildEnv 给 SDK 会话，childEnv 给 server 自己派生的其余子进程。
const FUNNELS = [['sdkChildEnv', sdkChildEnv], ['childEnv', childEnv]];

for (const [name, funnel] of FUNNELS) {
test(`AUTH-06：CCM 控制面密钥不进子进程（${name}）`, () => {
  const out = funnel({
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

test(`AUTH-06 反向：claude 自己那份环境原样透传（终端等价性不能被剥没）（${name}）`, () => {
  const out = funnel({
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
test(`AUTH-06 漂移闸：env-schema 里每个密钥键都必须被剥掉（${name}）`, async () => {
  const { ENV_SCHEMA } = await import('../../app/src/ops/env-schema.js');
  // 与 env-schema.js 内部 buildEnvView 同一条判据（`!!def.secret || def.kind === 'secret'`）
  const secretKeys = Object.entries(ENV_SCHEMA)
    .filter(([, def]) => !!def.secret || def.kind === 'secret')
    .map(([key]) => key);

  assert.ok(secretKeys.length >= 4, `schema 里应有若干密钥键，实际 ${secretKeys.length} 个——判据可能改了`);
  const probe = Object.fromEntries(secretKeys.map(k => [k, `SECRET_VALUE_OF_${k}`]));
  const out = funnel(probe);
  for (const key of secretKeys) {
    assert.ok(!Object.hasOwn(out, key),
      `env-schema 把 ${key} 标成了密钥，但 child-env.js 的剥离清单漏了它——把它加进去`);
  }
});
}

// ── 真 spawn：server 自己派生的子进程（2026-09-22 review P2）────────────────────────
// 上面只证明漏斗的形状。这一组证明 server 真的用了它：此前只有 SDK 那条走漏斗，server 自己在工作区里
// 跑的 git 继承整份 process.env。git 不是 claude，但仓库配置能让它执行任意命令（core.fsmonitor 在
// status 时执行、diff 驱动、过滤器），而 .git/config 对模型是可写的——一次已放行的写文件就能把命令挂上去，
// 等 server 下次跑 git status 时带着 AUTH_TOKEN 执行，绕过上面那道剥离。
//
// 钩子把自己拿到的环境写进文件。必须同时断言「钩子确实跑了」与「透传的变量还在」：前者防夹具没触发
// 就恒绿，后者防有人把整份 env 清空来过这条——那会砍掉 PATH 与第三方网关那条支持路径。
const SECRET = 'ccm-control-plane-key-for-auth06';

function withProcessEnv(overrides, fn) {
  const saved = Object.fromEntries(Object.keys(overrides).map(k => [k, process.env[k]]));
  Object.assign(process.env, overrides);
  const restore = () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  };
  return Promise.resolve().then(fn).finally(restore);
}

// 一次性仓库 + 一个把环境写到 dump 文件的 fsmonitor 钩子。全局 / 系统 git 配置经环境屏蔽，
// 否则跑测试那台机器的 ~/.gitconfig 会掺进来。
function makeRepoWithEnvDumpingHook() {
  const root = mkdtempSync(join(tmpdir(), 'ccm-auth06-git-'));
  const repo = join(root, 'repo');
  const dump = join(root, 'env.dump');
  const hook = join(root, 'fsmonitor-hook.sh');
  writeFileSync(hook, `#!/bin/sh\n/usr/bin/env >> '${dump}'\nexit 1\n`);
  chmodSync(hook, 0o755);
  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...args) => execFileSync('git', args, { cwd: repo, env: gitEnv, stdio: 'pipe' });
  execFileSync('git', ['init', '-q', repo], { env: gitEnv, stdio: 'pipe' });
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  git('add', 'a.txt');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'init');
  writeFileSync(join(repo, 'a.txt'), 'two\n');
  git('config', 'core.fsmonitor', hook);
  return { root, repo, dump };
}

const HOOK_ENV = { AUTH_TOKEN: SECRET, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', CCM_AUTH06_PASSTHROUGH: 'kept' };

function assertDumpClean(dump, label) {
  let seen = '';
  try { seen = readFileSync(dump, 'utf8'); } catch { /* 钩子没跑，下一行报 */ }
  assert.match(seen, /CCM_AUTH06_PASSTHROUGH=kept/, `${label}：钩子没跑或环境被整份清空了——两种都会让本条恒绿`);
  assert.ok(!seen.includes(SECRET), `${label}：AUTH_TOKEN 跟着子进程环境流出去了`);
}

test('AUTH-06：变更面板跑的 git 拿不到控制面密钥（core.fsmonitor 钩子实测）', async () => {
  const { root, repo, dump } = makeRepoWithEnvDumpingHook();
  try {
    await withProcessEnv(HOOK_ENV, async () => {
      const r = await listGitChanges(repo);
      assert.ok(r.ok && r.unstaged.some(e => e.path === 'a.txt'), `git status 要真的跑通：${JSON.stringify(r)}`);
    });
    assertDumpClean(dump, 'listGitChanges');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('AUTH-06：状态栏跑的 git 拿不到控制面密钥（core.fsmonitor 钩子实测）', async () => {
  const { root, repo, dump } = makeRepoWithEnvDumpingHook();
  try {
    await withProcessEnv(HOOK_ENV, () => gitStatus(repo));
    assertDumpClean(dump, 'gitStatus');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// doctor 的 `claude --version` 探测：CLAUDE_BIN 指向的就是一个会执行的文件，与 SDK 会话是同一个二进制。
// 与生产同形：无参调用，密钥在 process.env 里（server 的投影就是这么把它带进来的）。
test('AUTH-06：doctor 探测 claude --version 时拿不到控制面密钥', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-auth06-claude-'));
  try {
    const dump = join(root, 'env.dump');
    const fake = join(root, 'claude');
    writeFileSync(fake, `#!/bin/sh\n/usr/bin/env >> '${dump}'\necho '9.9.9 (Claude Code)'\n`);
    chmodSync(fake, 0o755);
    let probe;
    await withProcessEnv({ CLAUDE_BIN: fake, AUTH_TOKEN: SECRET, CCM_AUTH06_PASSTHROUGH: 'kept' }, () => { probe = probeClaudeBin(); });
    assert.equal(probe.version, '9.9.9 (Claude Code)', JSON.stringify(probe));
    assertDumpClean(dump, 'probeClaudeBin');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
