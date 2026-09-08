// tests/invariants/installer-node-path.test.mjs —— 安装器写进外部配置的 node 路径必须跨版本升级存活
// 守护：OPS-05（写进 plist / ~/.claude/settings.json 的 node 路径必须是稳定 symlink，不得是 process.execPath）
// 覆盖：两个 bridge 安装器（hooks / statusline）落盘的 settings.json 与 manifest 两处路径
//       + 拿不到稳定路径时的回落方向
// 槽位：S1（spawnSync 跑本仓安装器 + mkdtemp 一次性 HOME，不起 server、不 spawn claude）
//
// 这条红线的形态：`process.execPath` 是解析过 symlink 的**真身**（Homebrew 下
// `/opt/homebrew/Cellar/node/<版本>/bin/node`，nvm 下 `~/.nvm/versions/node/<版本>/bin/node`）。
// 写进外部配置后，node 一升级那个目录就没了，命令指向不存在的二进制。
// **失效是静默的**——Claude Code 不会因为 hook 命令找不到二进制而报错，用户看到的只是
// 「手机端再也收不到推送」和「状态栏空了」，没有任何线索指向 node 升级。
//
// 2026-09-07 实测到这个缺陷时：settings.json 里写着 25.9.0_3，而 `brew outdated node`
// 已是 `25.9.0_3 < 26.8.1`——不是理论风险，是下一次 upgrade 就触发。
//
// 测试用的注入路径是**一次性目录里指向真 node 的 symlink**，不是随便一个字符串：
//   ① hooks 的 install 内嵌 L1 回环验证会真跑一次装好的命令，路径必须可执行；
//   ② symlink → 真身 正是缺陷本身的形态，注入它才测在点上；
//   ③ 它与 process.execPath 必然不同，"不含 execPath" 这条断言才有鉴别力
//      （若两者可能相等，测试会在代码退回 execPath 时照样绿）。
//
// 不测什么 + 为什么：
//  ① `pickNodePath` 的各分支（空输出 / 路径不存在 / 多行 / 前后空白）——
//     tests/unit/service-install.test.mjs 已有 5 条，不在此重复。
//  ② 登录 shell 真的跑 `command -v node` 的结果——那取决于跑测试的机器装了什么 node，
//     断言会随机器漂移。这里钉的是「安装器用了 resolveStableNodePath 的返回值」，
//     而不是「那个返回值在本机等于什么」。
//  ③ launchd plist 的路径写入——service.js 走的是同一个 resolveStableNodePath，
//     其漂移比对另有 realpath 归一，由 tests/unit/service-install.test.mjs 覆盖。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const HOOKS_SETUP = join(ROOT, 'scripts', 'hooks-bridge-setup.js');
const STATUSLINE_SETUP = join(ROOT, 'scripts', 'statusline-bridge-setup.js');

const settingsPath = home => join(home, '.claude', 'settings.json');
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));

/** 一次性 HOME + 一条指向真 node 的稳定 symlink（模拟 /opt/homebrew/bin/node）。 */
function makeHomeWithStableNode() {
  const home = mkdtempSync(join(tmpdir(), 'ccm-node-path-'));
  const stableNode = join(home, 'stable-node');
  symlinkSync(process.execPath, stableNode);
  return { home, stableNode };
}

function runSetup(script, home, action, extraEnv = {}) {
  return spawnSync(process.execPath, [script, action], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      // hooks 的 L1 回环验证与 L2 探活：一次性目录 + 无人监听的端口，绝不碰真实 ~/.claude
      // 也绝不探到本机在跑的生产 server。
      CLI_HOOKS_DIR: join(home, 'events'),
      CLI_HOOKS_ACKS_DIR: join(home, 'acks'),
      PORT: '9',
      ...extraEnv,
    },
  });
}

test('hooks 桥：settings.json 与 manifest 里的 node 路径是稳定 symlink，不是 execPath 真身', () => {
  const { home, stableNode } = makeHomeWithStableNode();
  try {
    const res = runSetup(HOOKS_SETUP, home, 'install', { CCM_TEST_NODE_PATH: stableNode });
    assert.equal(res.status, 0, res.stderr);

    const settings = readJson(settingsPath(home));
    const manifest = readJson(join(home, '.claude', 'ccm', 'hooks-v1', 'install-manifest.json'));

    // 两个事件的命令都必须用稳定路径
    for (const event of ['Stop', 'Notification']) {
      const command = settings.hooks[event][0].hooks[0].command;
      assert.ok(command.includes(stableNode), `${event} 应使用稳定路径，实际：${command}`);
      assert.ok(
        !command.includes(process.execPath),
        `${event} 写进了 execPath 真身（node 升级后会静默失效）：${command}`,
      );
    }
    // manifest 必须与 settings 记同一条——否则 status 立刻报 drifted，卸载也认不出自己的条目
    assert.ok(manifest.installedCommand.includes(stableNode));
    assert.ok(!manifest.installedCommand.includes(process.execPath));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('statusline 桥：settings.json 与 manifest 里的 node 路径是稳定 symlink，不是 execPath 真身', () => {
  const { home, stableNode } = makeHomeWithStableNode();
  try {
    mkdirSync(dirname(settingsPath(home)), { recursive: true });
    writeFileSync(
      settingsPath(home),
      JSON.stringify({ statusLine: { type: 'command', command: 'echo hi' } }, null, 2),
      { mode: 0o600 },
    );

    const res = runSetup(STATUSLINE_SETUP, home, 'install', { CCM_TEST_NODE_PATH: stableNode });
    assert.equal(res.status, 0, res.stderr);

    const command = readJson(settingsPath(home)).statusLine.command;
    const manifest = readJson(join(home, '.claude', 'ccm', 'statusline-v1', 'install-manifest.json'));

    assert.ok(command.includes(stableNode), `应使用稳定路径，实际：${command}`);
    assert.ok(
      !command.includes(process.execPath),
      `写进了 execPath 真身（node 升级后状态栏会静默失效）：${command}`,
    );
    assert.ok(manifest.installedCommand.includes(stableNode));
    assert.ok(!manifest.installedCommand.includes(process.execPath));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('回落方向：登录 shell 给不出可用路径时用 execPath，不拒绝安装', async () => {
  // 失败方向是**不拒绝**——一个可能随升级失效的路径，总比装不上强。
  // 这里直接验 resolveStableNodePath 的回落分支：给一个不存在的路径，应回落 execPath。
  const { pickNodePath, resolveStableNodePath } = await import('../../scripts/node-path.js');
  assert.equal(pickNodePath('/nonexistent/node', process.execPath, () => false), process.execPath);
  // env 覆盖存在时优先用它（测试注入点本身也要成立，否则上面两条测的是空气）
  process.env.CCM_TEST_NODE_PATH = '/injected/node';
  try {
    assert.equal(resolveStableNodePath(), '/injected/node');
  } finally { delete process.env.CCM_TEST_NODE_PATH; }
});
