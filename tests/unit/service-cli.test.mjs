// tests/unit/service-cli.test.mjs —— scripts/service.js（LaunchAgent 服务管理 CLI）单测
//
// 分两层测：
//   ① createServiceManager 注入 mock deps —— 覆盖全部判定逻辑，**永不真调 launchctl**
//   ② spawnSync 真跑 CLI —— 只覆盖平台降级与 JSON 输出契约（darwin 分支会碰真实
//      ~/Library/LaunchAgents 与真 launchctl，不在这层测）
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createServiceManager } from '../../scripts/service.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(ROOT, 'scripts', 'service.js');

const HOME = '/Users/you';
const REPO = '/Users/you/code/claude-chat-mobile';
const NODE = '/opt/homebrew/bin/node';

// 机主机器上的真实形态：server/tunnel/logrotate 三个手工装的（语义等价、无 manifest）
// + tunnel-watch 一个模板里没有的自建 unit。
const HANDWRITTEN = {
  [`${HOME}/Library/LaunchAgents/com.ccm.server.plist`]: {
    Label: 'com.ccm.server',
    ProgramArguments: ['/bin/zsh', '-lc', `cd ${REPO} && exec ${NODE} server.js`],
    RunAtLoad: true,
    KeepAlive: true,
    StandardOutPath: `${HOME}/Library/Logs/ccm-server.log`,
    StandardErrorPath: `${HOME}/Library/Logs/ccm-server.log`,
  },
  [`${HOME}/Library/LaunchAgents/com.ccm.tunnel.plist`]: {
    Label: 'com.ccm.tunnel',
    ProgramArguments: ['/opt/homebrew/bin/cloudflared', 'tunnel', 'run', 'my-tunnel'],
    RunAtLoad: true,
    KeepAlive: true,
    StandardOutPath: `${HOME}/Library/Logs/ccm-tunnel.log`,
    StandardErrorPath: `${HOME}/Library/Logs/ccm-tunnel.log`,
  },
  [`${HOME}/Library/LaunchAgents/com.ccm.logrotate.plist`]: {
    Label: 'com.ccm.logrotate',
    ProgramArguments: ['/bin/bash', `${REPO}/scripts/rotate-logs.sh`],
    RunAtLoad: false,
    StandardOutPath: `${HOME}/Library/Logs/ccm-logrotate.log`,
    StandardErrorPath: `${HOME}/Library/Logs/ccm-logrotate.log`,
  },
  [`${HOME}/Library/LaunchAgents/com.ccm.tunnel-watch.plist`]: {
    Label: 'com.ccm.tunnel-watch',
    ProgramArguments: ['/bin/zsh', '-lc', 'my own watchdog'],
    RunAtLoad: true,
  },
};

const LAUNCHCTL_TSV = [
  'PID\tStatus\tLabel',
  '26867\t0\tcom.ccm.server',
  '62368\t-9\tcom.ccm.tunnel',
  '-\t0\tcom.ccm.logrotate',
  '-\t0\tcom.ccm.tunnel-watch',
  '750\t0\tio.beszel.tunnel.mac-mini',
].join('\n');

function makeManager(overrides = {}) {
  const plists = overrides.plists ?? HANDWRITTEN;
  return createServiceManager({
    platform: 'darwin',
    home: HOME,
    repo: REPO,
    node: NODE,
    now: () => 1786000000000,
    execLaunchctl: overrides.execLaunchctl
      ?? (() => ({ status: 0, stdout: overrides.tsv ?? LAUNCHCTL_TSV, stderr: '' })),
    readPlistFile: (path) => plists[path] ?? null,
    readManifest: overrides.readManifest ?? (() => null),
    readEnv: overrides.readEnv ?? (() => ({ PORT: '3000', AUTH_TOKEN: 'x'.repeat(64) })),
    envFileExists: overrides.envFileExists ?? (() => true),
    tcpProbe: overrides.tcpProbe ?? (() => true),
    readEvents: overrides.readEvents ?? (() => []),
    lanIp: () => '192.168.1.9',
    ...overrides.extra,
  });
}

test.describe('status —— 平台降级', () => {
  test('非 darwin：supported=false、units 为空、不抛错（CI 与 Docker 都在 Linux 上）', () => {
    const mgr = createServiceManager({
      platform: 'linux',
      home: HOME,
      repo: REPO,
      execLaunchctl: () => assert.fail('非 darwin 不应调用 launchctl'),
      readPlistFile: () => assert.fail('非 darwin 不应读盘'),
    });
    const out = mgr.status();
    assert.equal(out.supported, false);
    assert.equal(out.platform, 'linux');
    assert.deepEqual(out.units, []);
    assert.match(out.warnings.join(' '), /macOS/);
  });
});

test.describe('status —— 机主既有安装的识别', () => {
  test('三个手工装的已知 unit 判 adoptable（语义等价，可安全接管）', () => {
    const units = makeManager().status().units;
    const by = Object.fromEntries(units.map((u) => [u.label, u]));
    assert.equal(by['com.ccm.server'].ownership, 'adoptable');
    assert.equal(by['com.ccm.tunnel'].ownership, 'adoptable');
    assert.equal(by['com.ccm.logrotate'].ownership, 'adoptable');
  });

  test('模板里没有的自建 unit 判 unknown（前缀命中但不是已知 unit）', () => {
    const u = makeManager().status().units.find((x) => x.label === 'com.ccm.tunnel-watch');
    assert.ok(u, 'tunnel-watch 应出现在列表里——它占着 com.ccm. 前缀，看不见就等于不存在');
    assert.equal(u.ownership, 'unknown');
    assert.equal(u.known, false);
  });

  test('前缀不命中的第三方 unit 完全不出现（io.beszel.* 不关我们的事）', () => {
    const labels = makeManager().status().units.map((u) => u.label);
    assert.ok(!labels.some((l) => l.startsWith('io.beszel')), '不应把别人的 unit 拉进来');
  });

  test('未安装的已知 unit 仍列出，state=not-installed（菜单栏要显示「可安装」）', () => {
    // 全新机器：没有任何 plist，launchctl 里也没有对应条目
    const u = makeManager({ plists: {}, tsv: 'PID\tStatus\tLabel' }).status().units.find((x) => x.unit === 'server');
    assert.equal(u.state, 'not-installed');
    assert.equal(u.pid, null);
    // plist 不存在时必须跳过漂移判定：否则 extractUnitFacts(null) 让每项都是 null →
    // diffUnitSemantics 报 shape → ownership 变 foreign → install 会被自己的护栏拒掉。
    assert.equal(u.ownership, 'adoptable', '没装的已知 unit 必须允许被 install');
    assert.deepEqual(u.drift, []);
  });
});

test.describe('status —— 状态与 flapping', () => {
  test('server 在跑且上次正常退出 → running，不 flapping', () => {
    const u = makeManager().status().units.find((x) => x.unit === 'server');
    assert.equal(u.state, 'running');
    assert.equal(u.pid, 26867);
    assert.equal(u.flapping, false);
  });

  // ★ 机主的隧道恒为 LastExitStatus=-9，但那**不是崩溃**：自建看门狗 com.ccm.tunnel-watch
  // 每 30s 检测 en0 的 DHCP 漂移，变了就 `launchctl kickstart -k`（-k 先 SIGKILL）。
  // 路由器每天换一次 IP ⇒ 用「最后一次退出码」判 flapping 等于每天误报一次。
  // 现在退出码只记录事实（lastExitAbnormal），告警交给重启频率。
  test('上次异常退出但没有频繁重启 → 不算 flapping，只记 lastExitAbnormal', () => {
    const u = makeManager().status().units.find((x) => x.unit === 'tunnel');
    assert.equal(u.state, 'running');
    assert.equal(u.lastExitStatus, -9);
    assert.equal(u.lastExitAbnormal, true, '事实要记下来');
    assert.equal(u.flapping, false, '每天一次的看门狗重启不该恒亮告警');
  });

  test('1 小时内重启 3 次 → flapping（真进了崩溃重启循环）', () => {
    const now = 1786000000000;
    const ev = (minsAgo) => ({ ts: now - minsAgo * 60_000, label: 'com.ccm.tunnel', kind: 'restarted' });
    const u = makeManager({ readEvents: () => [ev(30), ev(20), ev(10)] })
      .status().units.find((x) => x.unit === 'tunnel');
    assert.equal(u.flapping, true);
    assert.equal(u.restarts.lastHour, 3);
  });

  test('每天一次的重启历史 → 24h 计数有值但不 flapping', () => {
    const now = 1786000000000;
    const HOUR = 3600_000;
    const ev = (h) => ({ ts: now - h * HOUR, label: 'com.ccm.tunnel', kind: 'restarted' });
    const u = makeManager({ readEvents: () => [ev(71), ev(47), ev(23), ev(2)] })
      .status().units.find((x) => x.unit === 'tunnel');
    assert.equal(u.flapping, false);
    assert.equal(u.restarts.last24h, 2);
    assert.equal(u.restarts.lastRestartAt, now - 2 * HOUR, 'UI 要显示「上次重启 2 小时前」');
  });

  test('重启历史读不出来（文件缺失/坏 JSON）→ 一切为零，不影响其余字段', () => {
    const u = makeManager({ readEvents: () => null }).status().units.find((x) => x.unit === 'server');
    assert.equal(u.flapping, false);
    assert.deepEqual(u.restarts, { lastHour: 0, last24h: 0, flapping: false, lastRestartAt: null });
    assert.equal(u.state, 'running', '其余判定不受影响');
  });

  test('logrotate 已装未运行 → stopped（定时器 unit 的常态，不是故障）', () => {
    const u = makeManager().status().units.find((x) => x.unit === 'logrotate');
    assert.equal(u.state, 'stopped');
    assert.equal(u.flapping, false);
  });
});

test.describe('status —— 漂移与归属', () => {
  test('manifest 有记录 → managed', () => {
    const mgr = makeManager({
      readManifest: () => ({
        schemaVersion: 1,
        labelPrefix: 'com.ccm',
        units: {
          server: {
            label: 'com.ccm.server',
            plistPath: `${HOME}/Library/LaunchAgents/com.ccm.server.plist`,
            sha256: 'a'.repeat(64),
            template: 'deploy/server.plist.template',
          },
        },
      }),
    });
    assert.equal(mgr.status().units.find((u) => u.unit === 'server').ownership, 'managed');
  });

  test('仓库被移动 → drift 含 repo-path，且仍能识别（不是 foreign 化的理由——managed 才看漂移）', () => {
    const moved = {
      ...HANDWRITTEN,
      [`${HOME}/Library/LaunchAgents/com.ccm.server.plist`]: {
        ...HANDWRITTEN[`${HOME}/Library/LaunchAgents/com.ccm.server.plist`],
        ProgramArguments: ['/bin/zsh', '-lc', `cd ${HOME}/old/repo && exec ${NODE} server.js`],
      },
    };
    const u = makeManager({ plists: moved }).status().units.find((x) => x.unit === 'server');
    assert.deepEqual(u.drift, ['repo-path']);
    assert.equal(u.ownership, 'foreign', '无 manifest + 有漂移 = 用户自己改过，只读');
  });

  // 真机实测（2026-08-13）：process.execPath 是 /opt/homebrew/Cellar/node/25.9.0_3/bin/node（真身），
  // 而 plist 里写的是 /opt/homebrew/bin/node（homebrew symlink）——同一个二进制，字符串不同。
  // 不做 realpath 归一就会把正在跑的生产 server 判成 foreign，adopt 直接失效。
  test('plist 写 symlink 路径而 execPath 是真身 → 不报漂移（realpath 归一）', () => {
    const REAL_NODE = '/opt/homebrew/Cellar/node/25.9.0_3/bin/node';
    const mgr = makeManager({
      extra: {
        node: REAL_NODE,
        realpath: (p) => (p === NODE ? REAL_NODE : p),
      },
    });
    const u = mgr.status().units.find((x) => x.unit === 'server');
    assert.deepEqual(u.drift, [], 'symlink 与真身指向同一个二进制，不是漂移');
    assert.equal(u.ownership, 'adoptable');
  });

  test('realpath 解析失败（路径不存在）时回落原值，不因此误报漂移', () => {
    const mgr = makeManager({ extra: { realpath: (p) => p } });
    assert.deepEqual(mgr.status().units.find((x) => x.unit === 'server').drift, []);
  });

  test('用户换掉了启动方式 → drift=[shape] 且 foreign（绝不覆写）', () => {
    const pm2 = {
      ...HANDWRITTEN,
      [`${HOME}/Library/LaunchAgents/com.ccm.server.plist`]: {
        Label: 'com.ccm.server',
        ProgramArguments: ['/usr/local/bin/pm2', 'start', 'server.js'],
      },
    };
    const u = makeManager({ plists: pm2 }).status().units.find((x) => x.unit === 'server');
    assert.deepEqual(u.drift, ['shape']);
    assert.equal(u.ownership, 'foreign');
  });
});

test.describe('status —— 探活只走 TCP，绝不碰 HTTP', () => {
  // src/server/http.js:94-105 对鉴权失败无条件计数，8 次锁 15min，且 app.js:309 让 loopback
  // 也进限速 —— 轮询若打 /health，40 秒就能把机主自己连同手机一起关在门外。
  test('server 的 listen 探活用注入的 tcpProbe，不发任何 HTTP 请求', () => {
    let probed = null;
    const mgr = makeManager({ tcpProbe: (port) => { probed = port; return true; } });
    const u = mgr.status().units.find((x) => x.unit === 'server');
    assert.equal(probed, 3000, '应按 .env 的 PORT 探测');
    assert.deepEqual(u.listen, { port: 3000, reachable: true });
  });

  test('端口连不上 → reachable=false（进程在但没监听，值得报出来）', () => {
    const u = makeManager({ tcpProbe: () => false }).status().units.find((x) => x.unit === 'server');
    assert.equal(u.listen.reachable, false);
  });

  test('--fast 跳过 TCP 探测（菜单栏高频轮询用）', () => {
    let called = false;
    const mgr = makeManager({ tcpProbe: () => { called = true; return true; } });
    const u = mgr.status({ fast: true }).units.find((x) => x.unit === 'server');
    assert.equal(called, false, 'fast 模式不应探测端口');
    assert.equal(u.listen, null);
  });

  test('非 server 的 unit 没有 listen 字段（隧道/定时器不监听本地端口）', () => {
    const units = makeManager().status().units;
    assert.equal(units.find((u) => u.unit === 'tunnel').listen, null);
    assert.equal(units.find((u) => u.unit === 'logrotate').listen, null);
  });
});

test.describe('status —— setup 段与脱敏', () => {
  test('给出 lanUrl 供装机向导展示', () => {
    const out = makeManager().status();
    assert.equal(out.setup.envExists, true);
    assert.equal(out.setup.port, 3000);
    assert.equal(out.setup.lanUrl, 'http://192.168.1.9:3000');
  });

  test('.env 不存在 → envExists=false 且不假装有端口', () => {
    const out = makeManager({ envFileExists: () => false, readEnv: () => ({}) }).status();
    assert.equal(out.setup.envExists, false);
    assert.equal(out.setup.port, 3000, 'PORT 缺省仍回落 3000（与 config.js 同口径）');
  });

  test('输出里绝不出现 AUTH_TOKEN 明文（整份 JSON 扫一遍）', () => {
    const json = JSON.stringify(makeManager().status());
    assert.ok(!json.includes('x'.repeat(64)), 'token 明文绝不能进 status 输出');
  });
});

test.describe('status —— launchctl 失败的降级', () => {
  test('launchctl 非零退出 → 不抛错，warnings 里说明，units 仍按 plist 列出', () => {
    const mgr = makeManager({
      execLaunchctl: () => ({ status: 1, stdout: '', stderr: 'Could not find domain' }),
    });
    const out = mgr.status();
    assert.ok(out.warnings.length > 0, '应有警告');
    assert.ok(out.units.length > 0, 'plist 还在，unit 列表不该空');
    assert.equal(out.units.find((u) => u.unit === 'server').pid, null);
  });

  test('execLaunchctl 抛异常同样降级而非炸掉整个 status', () => {
    const mgr = makeManager({ execLaunchctl: () => { throw new Error('ENOENT'); } });
    assert.doesNotThrow(() => mgr.status());
  });
});

test.describe('CLI 端到端', () => {
  test('CCM_TEST_PLATFORM=linux 时 status --json 输出 supported:false 且 exit 0', () => {
    const r = spawnSync(process.execPath, [CLI, 'status', '--json'], {
      encoding: 'utf8',
      env: { ...process.env, CCM_TEST_PLATFORM: 'linux' },
    });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.supported, false);
    assert.equal(out.schemaVersion, 1);
    assert.deepEqual(out.units, []);
  });

  test('未知子命令 → 用法提示 + 退出码 64', () => {
    const r = spawnSync(process.execPath, [CLI, 'frobnicate'], { encoding: 'utf8' });
    assert.equal(r.status, 64);
    assert.match(r.stderr, /usage/i);
  });

  test('无参数 → 同样是用法提示，不静默成功', () => {
    const r = spawnSync(process.execPath, [CLI], { encoding: 'utf8' });
    assert.equal(r.status, 64);
  });

  test('status 无 --json 时输出人类可读文本（不是裸 JSON）', () => {
    const r = spawnSync(process.execPath, [CLI, 'status'], {
      encoding: 'utf8',
      env: { ...process.env, CCM_TEST_PLATFORM: 'linux' },
    });
    assert.equal(r.status, 0);
    assert.ok(!r.stdout.trim().startsWith('{'), '人类模式不该直接吐 JSON');
    assert.match(r.stdout, /macOS/);
  });
});
