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

import { createServiceManager, describeUnit, formatStatus, formatControlResult, resolveEventsPath } from '../../scripts/service.js';
import { extractSchedule } from '../../src/ops/service-units.js';

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
  // StartCalendarInterval 逐字对齐 desktop/launchd/log-rotate.plist.template（03:47）——
  // 待机文案由它算出来，fixture 编错就会让测试与实现互相印证一个假形态。
  [`${HOME}/Library/LaunchAgents/com.ccm.logrotate.plist`]: {
    Label: 'com.ccm.logrotate',
    ProgramArguments: ['/bin/bash', `${REPO}/scripts/rotate-logs.sh`],
    RunAtLoad: false,
    StartCalendarInterval: { Hour: 3, Minute: 47 },
    StandardOutPath: `${HOME}/Library/Logs/ccm-logrotate.log`,
    StandardErrorPath: `${HOME}/Library/Logs/ccm-logrotate.log`,
  },
  // 机主真机 plist 的形态（2026-08-18 读自 ~/Library/LaunchAgents/，路径按 identity 纪律换成 /Users/you）：
  // 每 30s 检测 en0 的 DHCP 漂移，变了就 kickstart 隧道。**它没有 KeepAlive** —— 打一枪即退，
  // 所以 launchctl list 里 pid 恒为 `-`，而那正是它健康工作时的样子。
  [`${HOME}/Library/LaunchAgents/com.ccm.tunnel-watch.plist`]: {
    Label: 'com.ccm.tunnel-watch',
    ProgramArguments: ['/bin/bash', `${HOME}/.cloudflared/ccm-tunnel-bindwatch.sh`],
    RunAtLoad: true,
    StartInterval: 30,
    StandardOutPath: `${HOME}/Library/Logs/ccm-tunnel-watch.log`,
    StandardErrorPath: `${HOME}/Library/Logs/ccm-tunnel-watch.log`,
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
    // 「文件在不在」与「能不能解析」在真实实现里是两个独立来源（existsSync vs plutil）。
    // 默认让它们一致——既有用例的语义就是「plists 表里有 = 装了」；要单独构造
    // 「文件在但 plutil 读不出来」的用例，在 extra 里覆盖 fileExists 即可。
    fileExists: (path) => Object.prototype.hasOwnProperty.call(plists, path),
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

  // 这条警告是 Linux 用户在本仓唯一会看到的「那我该怎么办」。它此前写「Linux 请用 systemd，
  // 见 docs/deployment.md」—— 而 deployment.md 收敛成两条入口后明说【本仓库不提供官方 unit】，
  // 于是指路指向了一份不存在的指南。降级提示必须落在真实存在的入口上。
  test('非 macOS 的指路落在真实入口上，不指向仓库不提供的方案', () => {
    const warning = createServiceManager({
      platform: 'linux', home: HOME, repo: REPO,
      execLaunchctl: () => assert.fail('非 darwin 不应调用 launchctl'),
      readPlistFile: () => assert.fail('非 darwin 不应读盘'),
    }).status().warnings.join(' ');

    assert.match(warning, /npm start/, 'headless 那条入口是全平台基线，指路要指到它');
    assert.doesNotMatch(warning, /请用 systemd/, '仓库不提供 systemd unit，别把用户支去找一份不存在的指南');
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
    assert.deepEqual(u.restarts, { lastHour: 0, last24h: 0, manual24h: 0, flapping: false, lastRestartAt: null });
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
            template: 'desktop/launchd/server.plist.template',
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

// ── 待机 ≠ 故障 ───────────────────────────────────────────────────────────
//
// launchd 的 stopped 只说「此刻没有进程」。5 个 unit 里有 3 个（tunnel-watch / logrotate /
// menubar）健康工作时就该是这个状态，而面板一律标「已停止」——机主本人因此来问过
// 「tunnel-watch 要启用吗」。判据来自 plist 里的调度形态，不是 unit 名字表：后者必然漏掉
// 用户自建的 unit，而那恰恰是最容易被误读的一类（它还同时带着「非本仓」标签）。
test.describe('周期 job 的 stopped 是待机，不是故障', () => {
  const unitOf = (name) => makeManager().status().units.find((u) => u.unit === name);

  test('status 给出每个 unit 的调度形态（含模板里没有的自建 unit）', () => {
    assert.deepEqual(unitOf('server').schedule, { kind: 'resident' });
    assert.deepEqual(unitOf('logrotate').schedule, { kind: 'periodic', calendar: { Hour: 3, Minute: 47 } });
    assert.deepEqual(unitOf('tunnel-watch').schedule, { kind: 'periodic', everySeconds: 30 },
      'unknown unit 走的是另一条构造路径，最需要这个字段的就是它');
  });

  test('周期 job 的 detail 说「待机」并给出触发节奏，不说「已停止」', () => {
    assert.match(unitOf('tunnel-watch').detail, /待机 · 每 30 秒触发/);
    assert.match(unitOf('logrotate').detail, /待机 · 每天 03:47/);
  });

  test('自建 unit 仍然保留「非本仓管理」这句——待机说明是补充不是替换', () => {
    assert.match(unitOf('tunnel-watch').detail, /非本仓管理/);
  });

  test('常驻服务停了照旧是故障，绝不粉饰成待机', () => {
    const mgr = makeManager({ tsv: ['PID\tStatus\tLabel', '-\t0\tcom.ccm.server'].join('\n') });
    const server = mgr.status().units.find((u) => u.unit === 'server');
    assert.equal(server.state, 'stopped');
    assert.doesNotMatch(server.detail, /待机/, 'KeepAlive 的 unit 没在跑就是没在跑');
  });

  test('人类可读面板里周期 job 不显示成 ○ stopped', () => {
    const out = formatStatus(makeManager().status());
    const line = out.split('\n').find((l) => l.includes('com.ccm.tunnel-watch'));
    assert.ok(line, 'tunnel-watch 应出现在面板里');
    assert.doesNotMatch(line, /stopped/, '「stopped」这个词正是让机主以为它没启用的原因');
  });
});

// ── start/restart 的结果呈现 ──────────────────────────────────────────────
//
// manager 层标了 unverified 而 CLI 不打印它，等于没标——这类「接线洞」在本仓有前科
// （resume 冷读模型那次，server 侧接好了、前端没接，全套单测照样绿）。把呈现抽成
// 纯函数是为了让它有人看着：start/restart 会真碰 launchctl，端到端 spawn 测不了。
test.describe('formatControlResult —— 弱判据必须出现在人眼前', () => {
  test('普通成功：一行 ✓，不带噪音', () => {
    const out = formatControlResult({ ok: true, label: 'com.ccm.server', action: 'started' });
    assert.match(out.stdout, /✓ com\.ccm\.server/);
    assert.equal(out.stderr, '');
  });

  test('restart 带 pid 变化时把新旧 pid 打出来', () => {
    const out = formatControlResult({ ok: true, label: 'com.ccm.server', action: 'restarted', oldPid: 1, newPid: 2 });
    assert.match(out.stdout, /1 → 2/);
  });

  test('unverified 的成功必须带一行 ⚠ 到 stderr，而不是和普通成功长得一样', () => {
    const out = formatControlResult({
      ok: true, label: 'com.ccm.server', action: 'started',
      unverified: true, warning: '没能确认监听者就是本服务，用 service health 复核',
    });
    assert.match(out.stdout, /✓ com\.ccm\.server/, '仍然是成功，不改退出码语义');
    assert.match(out.stderr, /⚠/);
    assert.match(out.stderr, /复核/);
  });

  test('失败：只有 ✗ 到 stderr', () => {
    const out = formatControlResult({ ok: false, error: '端口 3000 已被其它进程占用' });
    assert.equal(out.stdout, '');
    assert.match(out.stderr, /✗ 端口 3000/);
  });
});

// ── 第三轮审查：补两处零断言的承重路径 ───────────────────────────────────
//
// describeUnit 此前 **100% 无断言**（tests/ 里零引用、零 `.detail` 断言），而 6a38e7c 新增的
// 重启话术全在这个函数里 —— 把它整个改成 `return ''` 全套单测照样绿。
// ★ stop 的目标状态是「它别跑了」。已经不在 launchd domain 里时那个状态本来就成立 ——
// 而 bootout 这时返回非零（"Could not find service"），旧实现据此报 ✗ 并在菜单栏弹失败提示。
// uninstall 一直是宽容的（见那里的注释：「那不是失败是本来就没跑」），stop 这一侧一直缺着；
// 叠加「被 bootout 的 unit 仍显示成健康待机」这个盲区，用户根本无从知道它已经停了。
// loaded 这一位要在**两条构建路径**上都成立，而不是只有已知 unit 有。
// 机主本机就跑着手写的 com.ccm.tunnel-watch —— 自建 unit 恰恰是最容易被误读成「装了没启用」的那类。
test.describe('loaded —— 自建 unit 与 list 失败时的诚实度', () => {
  const WATCH_PLIST = `${HOME}/Library/LaunchAgents/com.ccm.tunnel-watch.plist`;
  const watchPlists = {
    [WATCH_PLIST]: {
      Label: 'com.ccm.tunnel-watch',
      ProgramArguments: ['/bin/bash', `${HOME}/.cloudflared/watch.sh`],
      StartInterval: 30,
      StandardOutPath: `${HOME}/Library/Logs/ccm-tunnel-watch.log`,
    },
  };
  const unitNamed = (s, name) => s.units.find((u) => u.label === `com.ccm.${name}`);

  test('★ 自建 unit 被 bootout 后同样要能看出来（buildUnknownUnits 也得带 loaded）', () => {
    // launchctl 里只有 server，watch 的 plist 在盘上但已不在 domain 里
    const mgr = makeManager({
      plists: watchPlists,
      tsv: ['PID\tStatus\tLabel', '26867\t0\tcom.ccm.server'].join('\n'),
      // 已不在 launchctl list 里，只能靠 ~/Library/LaunchAgents 目录扫描发现 —— 这正是本场景
      extra: { listAgentLabels: () => ['com.ccm.tunnel-watch'] },
    });
    const u = unitNamed(mgr.status({ fast: true }), 'tunnel-watch');
    assert.ok(u, '自建 unit 要出现在 status 里');
    assert.equal(u.loaded, false, '已从 launchd 卸载 —— 这一位不能只有已知 unit 才有');
    assert.doesNotMatch(u.detail, /待机/, '每 30 秒触发一次的说法此刻是假的');
  });

  test('★ launchctl list 失败时不许说「已从 launchd 卸载」—— 那是不知道，不是知道它没了', () => {
    const mgr = makeManager({
      plists: watchPlists,
      execLaunchctl: () => ({ status: 1, stdout: '', stderr: 'Could not connect' }),
      extra: { listAgentLabels: () => ['com.ccm.tunnel-watch'] },
    });
    const s = mgr.status({ fast: true });
    for (const u of s.units) {
      assert.notEqual(u.loaded, false, `${u.label}：list 都读不到，凭什么断言它被卸载了`);
      assert.doesNotMatch(u.detail || '', /不会执行|已从 launchd 卸载/,
        `${u.label} 的 detail 在 list 失败时不该给出确定结论：${u.detail}`);
    }
    assert.ok(s.warnings.some((w) => /launchctl list/.test(w)), '要留一条 warning 说清读不到');
  });
});

test.describe('stop —— 已经停了不是失败', () => {
  // domain 里只有 server；logrotate 的 plist 在磁盘上（HANDWRITTEN 里有）但已被 bootout
  const ONLY_SERVER = ['PID\tStatus\tLabel', '26867\t0\tcom.ccm.server'].join('\n');

  // guardControllable 要求 plist 在磁盘上——这正是本场景的前提（文件在，但已被 bootout）
  const stopManager = (tsv, bootout) => makeManager({
    extra: { fileExists: () => true },
    execLaunchctl: (args) => (args[0] === 'list'
      ? { status: 0, stdout: tsv, stderr: '' }
      : bootout),
  });

  test('★ 停一个已被 bootout 的 unit → ok，不弹失败', () => {
    // 真实 launchctl 对不在 domain 里的 label 就是这么答的
    const mgr = stopManager(ONLY_SERVER, { status: 3, stdout: '', stderr: 'Boot-out failed: 3: No such process' });
    const r = mgr.stop('logrotate');
    assert.equal(r.ok, true, '要的状态已经成立，报 ✗ 只会让人以为出了事');
    assert.equal(r.alreadyStopped, true, '如实标注：这次并没有真去停它');
  });

  test('还在 domain 里 → 照常 bootout', () => {
    const r = stopManager(LAUNCHCTL_TSV, { status: 0, stdout: '', stderr: '' }).stop('logrotate');
    assert.equal(r.ok, true);
    assert.notEqual(r.alreadyStopped, true);
  });

  test('真的失败（权限等）仍然报失败，别把这条宽容变成万能挡箭牌', () => {
    const r = stopManager(LAUNCHCTL_TSV, { status: 1, stdout: '', stderr: 'Operation not permitted' }).stop('logrotate');
    assert.equal(r.ok, false);
  });

  // ★★ launchctlList 在 list 非零退出/抛异常时都返回**空 Map** —— 那是「不知道」，不是
  // 「什么都没加载」。据它早退等于 fail-open：报「✓ 已停止」、退出 0、bootout 一次没跑，
  // 而服务还在跑。宁可照常 bootout 让真错误浮上来。
  test('★★ launchctl list 本身失败 → 不许当成「已经停了」，必须照常 bootout', () => {
    const calls = [];
    const mgr = makeManager({
      extra: { fileExists: () => true },
      execLaunchctl: (args) => {
        calls.push(args[0]);
        return args[0] === 'list'
          ? { status: 1, stdout: '', stderr: 'launchctl: Could not connect' }
          : { status: 1, stdout: '', stderr: 'Operation not permitted' };
      },
    });
    const r = mgr.stop('logrotate');
    assert.ok(calls.includes('bootout'), '不确定它在不在 domain 里时必须真去停一次');
    assert.equal(r.ok, false, 'bootout 失败要如实报，不能报成「已停止」');
  });

  test('★ launchctl list 抛异常时同样不早退', () => {
    const calls = [];
    const mgr = makeManager({
      extra: { fileExists: () => true },
      execLaunchctl: (args) => {
        calls.push(args[0]);
        if (args[0] === 'list') throw new Error('spawn ENOENT');
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    const r = mgr.stop('logrotate');
    assert.ok(calls.includes('bootout'));
    assert.equal(r.ok, true, 'bootout 成功就是真停了');
    assert.notEqual(r.alreadyStopped, true);
  });

  // 弱判据必须出现在人眼前，不能只躺在 --json 里 —— 同本文件 formatControlResult 那组的立场。
  test('★ 「本来就没在跑」要在 CLI 输出里说出来，而不是与真停止长得一模一样', () => {
    const r = stopManager(ONLY_SERVER, { status: 3, stdout: '', stderr: 'Boot-out failed: 3: No such process' }).stop('logrotate');
    const out = formatControlResult(r).stdout;
    assert.match(out, /本来就没在跑|已经停了|未在运行/, `弱判据要可见，实际输出：${JSON.stringify(out)}`);
  });
});

test.describe('describeUnit —— 每条分支都要有人看着', () => {
  const base = { state: 'running', drift: [], plistExists: true, ownership: 'managed' };
  const R = (over) => ({ lastHour: 0, last24h: 0, flapping: false, lastRestartAt: null, ...over });

  test('未安装压过一切', () => {
    assert.equal(describeUnit({ ...base, plistExists: false, restarts: R({ flapping: true }) }), '未安装');
  });

  test('flapping → 说 1 小时内的次数（频率判据，不是退出码）', () => {
    const d = describeUnit({ ...base, restarts: R({ flapping: true, lastHour: 4, last24h: 9 }) });
    assert.match(d, /1 小时内重启 4 次/);
  });

  test('不 flapping 但 24h 内有重启 → 说 24h 的次数', () => {
    const d = describeUnit({ ...base, restarts: R({ last24h: 2 }) });
    assert.match(d, /24 小时内重启 2 次/);
    assert.doesNotMatch(d, /1 小时内/);
  });

  test('单次异常退出且在跑 → 陈述事实，不下告警结论', () => {
    const d = describeUnit({ ...base, restarts: R(), lastExitAbnormal: true });
    assert.match(d, /上次非正常退出（已重新拉起）/);
  });

  test('频率话术压过单次异常退出（否则同一行自相矛盾）', () => {
    const d = describeUnit({ ...base, restarts: R({ last24h: 3 }), lastExitAbnormal: true });
    assert.doesNotMatch(d, /上次非正常退出/);
  });

  test('shape 漂移说「不接管」而不是暗示出错（机主隧道用自写包装脚本）', () => {
    const d = describeUnit({ ...base, restarts: R(), drift: ['shape'] });
    assert.match(d, /自定义启动方式，本工具不接管/);
    assert.doesNotMatch(d, /配置与模板不一致/);
  });

  test('非 shape 漂移逐条列出', () => {
    const d = describeUnit({ ...base, restarts: R(), drift: ['keepAlive', 'path'] });
    assert.match(d, /配置与模板不一致：keepAlive、path/);
  });

  test('foreign 且非 shape → 提示 adopt 前不改写', () => {
    const d = describeUnit({ ...base, restarts: R(), ownership: 'foreign' });
    assert.match(d, /adopt 前不会被改写/);
  });

  // ★ 「待机」这个词的意思是「装着、等着、到点会响」。被 bootout 之后 plist 照样在磁盘上、
  // 调度形态照样读得出来，可它永远不会再响了 —— 说成待机是在报一个反的事实。
  // 停掉 logrotate 一次，日志轮转就此静默死掉，而面板/CLI/doctor 三处都说一切正常。
  // schedule 形状取自**真实的 extractSchedule**，不手编：手编的外部契约一旦编错，
  // 测试与实现会互相印证并恒绿（本仓在 git fixture 上栽过一次）。
  const DAILY = extractSchedule({ StartCalendarInterval: { Hour: 3, Minute: 47 } });

  test('★ 已 bootout 的定时器不能说成「待机」', () => {
    const d = describeUnit({ ...base, state: 'stopped', restarts: R(), schedule: DAILY, loaded: false });
    assert.match(d, /已停止/, '要说清它停了');
    assert.match(d, /不会执行/, '要说清后果：到点也不会响');
    assert.match(d, /start/, '要给出恢复动作');
  });

  test('仍在 launchd 里的定时器照旧说待机（这是 99% 的正常态，别改成告警）', () => {
    const d = describeUnit({ ...base, state: 'stopped', restarts: R(), schedule: DAILY, loaded: true });
    assert.match(d, /待机/);
    assert.doesNotMatch(d, /已停止|不会触发/);
  });

  test('loaded 未知（null）时维持旧行为，不凭空报故障', () => {
    const d = describeUnit({ ...base, state: 'stopped', restarts: R(), schedule: DAILY, loaded: null });
    assert.match(d, /待机/);
  });

  test('crashed 追加一句', () => {
    const d = describeUnit({ ...base, state: 'crashed', restarts: R() });
    assert.match(d, /上次异常退出且当前未运行/);
  });

  test('一切正常 → 空串（没话说就别说）', () => {
    assert.equal(describeUnit({ ...base, restarts: R() }), '');
  });
});

// resolveEventsPath 此前零测试，而它的孪生函数 resolveManifestPath 有一整组 —— 正因为
// 「数据目录算错」的后果是静默的：server 往 A 写、CLI/菜单栏从 B 读，重启记录永远空白且无报错。
// 机主的 .env 真设了 CCM_DATA_DIR，**这条路径在生产上承重**。
test.describe('resolveEventsPath —— 与 data-dir.js 必须同口径', () => {
  const ROOT = '/repo';

  test('都没设 → 回落 <repo>/data', () => {
    assert.equal(resolveEventsPath({}, {}, ROOT), '/repo/data/service-events.json');
  });

  test('读 .env 里的 CCM_DATA_DIR（漏掉它就是 server 写 A、CLI 读 B）', () => {
    assert.equal(resolveEventsPath({}, { CCM_DATA_DIR: '/data/ccm' }, ROOT), '/data/ccm/service-events.json');
  });

  test('shell 环境优先于 .env（与 dotenv 的不覆盖语义一致）', () => {
    assert.equal(
      resolveEventsPath({ CCM_DATA_DIR: '/from/shell' }, { CCM_DATA_DIR: '/from/envfile' }, ROOT),
      '/from/shell/service-events.json'
    );
  });

  test('空串按未设置处理（同 config.js 的 normalizeLoadedEnvironment）', () => {
    assert.equal(resolveEventsPath({ CCM_DATA_DIR: '' }, {}, ROOT), '/repo/data/service-events.json');
  });
});

// formatStatus 的 darwin 渲染路径此前完全没有断言：唯一那条用例设 CCM_TEST_PLATFORM=linux，
// 只走 `!s.supported` 的两行早退。把整段人类可读表格换成 `return '仅支持 macOS\n'`，
// 全套单测照样绿——而那正是机主在终端里唯一会看到的东西。
test.describe('formatStatus —— 人类可读表格（darwin 路径）', () => {
  const base = {
    supported: true, generatedAt: 1786600000000, warnings: [],
    units: [{
      unit: 'server', label: 'com.ccm.server', state: 'running', pid: 51531,
      ownership: 'managed', flapping: false, drift: [], detail: '', listen: null,
      restarts: { lastHour: 0, last24h: 0, manual24h: 0, flapping: false, lastRestartAt: null },
    }],
  };
  const render = (over) => formatStatus({ ...base, ...over });
  const withUnit = (over) => render({ units: [{ ...base.units[0], ...over }] });

  test('正常运行：灯 ● + label + state + pid + 归属', () => {
    const out = withUnit({});
    assert.match(out, /● com\.ccm\.server {2}running pid=51531 {2}\[/, `实际：\n${out}`);
  });

  test('flapping 的灯是 ◐ 而不是 state 对应的那个（频繁重启压过状态）', () => {
    assert.match(withUnit({ flapping: true }), /^◐ com\.ccm\.server/m);
  });

  test('stopped / crashed 各有各的灯', () => {
    assert.match(withUnit({ state: 'stopped', pid: null }), /^○ com\.ccm\.server {2}stopped {2}\[/m);
    assert.match(withUnit({ state: 'crashed', pid: null }), /^✗ com\.ccm\.server {2}crashed {2}\[/m);
  });

  test('未知 state 用 ? 而不是崩掉', () => {
    assert.match(withUnit({ state: 'weird', pid: null }), /^\? com\.ccm\.server {2}weird/m);
  });

  test('有过重启 → 追加「上次重启 N 前」', () => {
    const out = withUnit({ restarts: { lastHour: 0, last24h: 1, flapping: false, lastRestartAt: base.generatedAt - 7200_000 } });
    assert.match(out, /上次重启 2 小时前/, `实际：\n${out}`);
  });

  test('从没重启过 → 不追加那一段（别写「上次重启 ?前」）', () => {
    assert.doesNotMatch(withUnit({}), /上次重启/);
  });

  test('detail 与端口各占一行缩进', () => {
    const out = withUnit({ detail: '24 小时内重启 2 次', listen: { port: 3000, reachable: true } });
    assert.match(out, /^ {4}24 小时内重启 2 次$/m);
    assert.match(out, /^ {4}端口 3000 可连接$/m);
  });

  test('端口连不上要说出来（不是静默省略）', () => {
    assert.match(withUnit({ listen: { port: 3000, reachable: false } }), /^ {4}端口 3000 连不上$/m);
  });

  test('一个 unit 都没有 → 明说，不是给个空表', () => {
    assert.match(render({ units: [] }), /（未发现任何 com\.ccm\.\* unit）/);
  });

  test('warnings 逐条带 ⚠ 前缀列出', () => {
    assert.match(render({ warnings: ['launchctl list 失败：x'] }), /^⚠ launchctl list 失败：x$/m);
  });

  test('不支持的平台只印 warnings，不印表格', () => {
    const out = formatStatus({ supported: false, warnings: ['LaunchAgent 服务管理仅支持 macOS（当前平台：linux）'], units: [] });
    assert.match(out, /仅支持 macOS/);
    assert.doesNotMatch(out, /com\.ccm/);
  });
});

// ── menubar 自启指向的 app ──────────────────────────────────────────────────
//
// 这一组补的是 2026-08-18 在机主真机上发现的坑：com.ccm.menubar 的 plist 指向
// <repo>/desktop/build/CCM.app —— 一个 gitignore 的构建产物。git clean / 换分支
// 把它删掉，开机自启就静默失效，而当时三条自查路径全都显示正常。
//
// 为什么走 warnings 而不是 drift：app 路径是**安装期参数**，status 侧没有期望值可比
// （expectedFactsFor 里 app 恒为 ctx.app ?? null）。塞进 driftFields 会让 expected=null
// vs actual=有值 每次都不相等，恒报假漂移——service-units.js 的头注专门写过这条纪律。
// 真正要判的是 actual 值本身：这个路径还在吗？它在不在会被清掉的地方？
test.describe('status —— menubar 自启指向的 app', () => {
  const menubarPlist = (app) => ({
    [`${HOME}/Library/LaunchAgents/com.ccm.menubar.plist`]: {
      Label: 'com.ccm.menubar',
      ProgramArguments: ['/usr/bin/open', app],
      RunAtLoad: true,
      StandardOutPath: `${HOME}/Library/Logs/ccm-menubar.log`,
      StandardErrorPath: `${HOME}/Library/Logs/ccm-menubar.log`,
    },
  });
  const warningsOf = (overrides) => makeManager(overrides).status().warnings.join('\n');

  test('指向仓库内的构建产物 → 警告它会被 git clean 掉，并给出补救命令', () => {
    const w = warningsOf({
      plists: menubarPlist(`${REPO}/desktop/build/CCM.app`),
      extra: { fileExists: () => true }, // 此刻文件还在——问题不是"没了"，是"待会儿会没"
    });
    assert.match(w, /desktop\/build\/CCM\.app/, '要指出它到底指向哪，否则用户无从下手');
    assert.match(w, /app:install/, '要给出补救命令，不能只报警不指路');
    assert.doesNotMatch(w, new RegExp(REPO.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/desktop'),
      '路径按仓库相对形态给出，不回显绝对路径');
  });

  test('指向 /Applications 且文件在 → 不警告（这正是 app:install 的正常结果）', () => {
    const w = warningsOf({
      plists: menubarPlist('/Applications/CCM.app'),
      extra: { fileExists: () => true },
    });
    assert.doesNotMatch(w, /开机自启/, '正常安装不该报警——否则告警会被训练成噪音');
  });

  test('指向的 app 已不存在 → 警告登录时拉不起菜单栏', () => {
    const w = warningsOf({
      plists: menubarPlist('/Applications/CCM.app'),
      // fileExists 现在同时被两处消费：判 plist 在不在（决定 unit 是否已安装）、
      // 判自启指向的 .app 在不在。真实 fs 对两个路径本来就给不同答案，mock 也必须区分 ——
      // 一律 false 会让 unit 先被判成未安装，根本走不到自启检查这一步。
      extra: { fileExists: (p) => String(p).endsWith('.plist') },
    });
    assert.match(w, /不存在/);
    assert.match(w, /app:install/);
  });

  test('menubar 未安装 → 不产生自启警告（没装不是故障）', () => {
    const w = warningsOf({ plists: {}, extra: { fileExists: () => false } });
    assert.doesNotMatch(w, /开机自启/);
  });
});
