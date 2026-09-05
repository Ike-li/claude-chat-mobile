// uninstall-cli.test.mjs —— 一键卸载编排器（scripts/uninstall.js）
//
// 隔离方式：所有会写盘的用例都把 home/root/dataDir 注入到 mkdtemp 临时目录；
// 桥（statusline/hooks）用**真实子进程**在临时 HOME 里装了再卸——不手搓桥的落盘形态，
// 防 fixture 与实现互相印证（见 memory：fixture 把外部契约编错时测试恒绿）。
// service.js 与 defaults 走 spawn stub：真跑会 bootout 本机生产 unit / 删真实偏好域。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createUninstaller, DATA_FILE_WHITELIST } from '../../scripts/uninstall.js';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const STATUSLINE_SETUP = join(ROOT, 'scripts', 'statusline-bridge-setup.js');
const HOOKS_SETUP = join(ROOT, 'scripts', 'hooks-bridge-setup.js');
const UNINSTALL = join(ROOT, 'scripts', 'uninstall.js');

// 每个用例要 2~4 个一次性目录（home/root，CLI 用例另加 clihome/clidata），此前建了从不删——
// 一次全量 test:unit 就在 /tmp 留 20 个，2026-09-05 清理时这个文件贡献了 1092 个（占所有
// 非 preload 泄漏的一半以上）。收进数组由文件级 after 统一回收：用例内不删，因为
// makeUninstaller 的目录要活到断言读完。
const TMP_DIRS = [];
function makeTmp(tag) {
  const dir = mkdtempSync(join(tmpdir(), `ccm-uninstall-${tag}-`));
  TMP_DIRS.push(dir);
  return dir;
}

test.after(() => {
  for (const dir of TMP_DIRS) {
    try {
      rmSync(dir, { recursive: true, force: true }); // safe-rm: 本文件 makeTmp 建的 mkdtemp 一次性目录
    } catch { /* 尽力而为：清理失败不该把测试结论搞脏 */ }
  }
});

function testEnvFor(home, dataDir) {
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    CCM_DATA_DIR: dataDir,
  };
}

// spawn 包装：桥脚本放行（HOME 已隔离到临时目录，真删真卸都安全）；
// service.js 与 defaults 一律 stub —— 前者会 launchctl bootout 真实 unit，后者动真实偏好域；
// pgrep 默认 stub 成「无进程」——真跑会匹配到宿主机的真实进程，测试不可依赖宿主状态。
function makeSpawn(env, { service, defaults, pgrep } = {}) {
  const calls = [];
  const fn = (cmd, args) => {
    calls.push([cmd, ...args.map(String)]);
    const script = typeof args?.[0] === 'string' ? basename(args[0]) : '';
    if (cmd === 'defaults') return defaults ? defaults(args) : { status: 1, stdout: '', stderr: '' };
    if (cmd === 'pgrep') return pgrep ? pgrep(args) : { status: 1, stdout: '', stderr: '' };
    if (script === 'service.js') {
      if (service) return service(args.slice(1));
      throw new Error(`测试未准备 service.js stub 却被调用：${args.join(' ')}`);
    }
    return spawnSync(cmd, args, { encoding: 'utf8', env });
  };
  fn.calls = calls;
  return fn;
}

function makeUninstaller(overrides = {}) {
  const home = overrides.home ?? makeTmp('home');
  const root = overrides.root ?? makeTmp('root');
  const dataDir = overrides.dataDir ?? join(root, 'data');
  const env = testEnvFor(home, dataDir);
  const lines = [];
  const spawn = overrides.spawn ?? makeSpawn(env, overrides.stubs);
  const u = createUninstaller({
    home,
    root,
    platform: 'darwin',
    env,
    spawn,
    appPath: overrides.appPath ?? join(root, 'no-such-CCM.app'),
    out: (line) => lines.push(line),
    ...overrides.factory,
  });
  return { u, home, root, dataDir, env, lines, spawn };
}

function installBridges(home, env) {
  // statusline 桥的 install 前置：settings.json 里已有 statusLine.command
  const settingsPath = join(home, '.claude', 'settings.json');
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify({
    statusLine: { type: 'command', command: 'bash /tmp/original-statusline.sh', refreshInterval: 60 },
  }, null, 2));
  for (const script of [STATUSLINE_SETUP, HOOKS_SETUP]) {
    const r = spawnSync(process.execPath, [script, 'install'], { encoding: 'utf8', env });
    assert.equal(r.status, 0, `${basename(script)} install 应成功：${r.stderr}\n${r.stdout}`);
  }
  return settingsPath;
}

test('全新机器（什么都没装）：所有步骤跳过、退出成功、不抛错', () => {
  const { u, lines } = makeUninstaller();
  const result = u.run({ purge: false });
  assert.equal(result.ok, true);
  const text = lines.join('\n');
  assert.match(text, /statusline/);
  assert.match(text, /hooks/);
  assert.ok(result.steps.every((s) => s.status === 'skip'), JSON.stringify(result.steps));
});

test('settings.json 已被用户手动删掉：桥判「未安装」，~/.claude/ccm 残余照样清干净', () => {
  // 这条分支容易被漏掉：没有 settings.json ⇒ 桥无从卸载，但产品此前写下的
  // ~/.claude/ccm/<桥目录> 仍在。若此时不认「未安装 = 可清残余」，卸载完会留下一堆孤儿文件，
  // 而用户看到的每一行都是「✓ 跳过」。
  const { u, home } = makeUninstaller();
  const residue = join(home, '.claude', 'ccm', 'statusline-v1');
  mkdirSync(residue, { recursive: true });
  writeFileSync(join(residue, 'snapshot.json'), '{}');
  assert.equal(existsSync(join(home, '.claude', 'settings.json')), false, '前提：settings.json 不存在');

  const result = u.run({ purge: false });
  assert.equal(result.ok, true, JSON.stringify(result.steps));
  assert.equal(existsSync(join(home, '.claude', 'ccm')), false,
    '桥「未安装」也要清掉它留下的残余目录，否则卸载报全绿而磁盘上还有孤儿文件');
});

test('真装两个桥后卸载：settings 恢复原样、manifest 与 ~/.claude/ccm 整目录清空、数据根不动', () => {
  const { u, home, dataDir, env } = makeUninstaller();
  const settingsPath = installBridges(home, env);
  // 数据根放一个会话文件：默认档（非 purge）必须原样保留
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'sessions.json'), '{}');
  // 桥残余：statusline 的 snapshots 目录（uninstall 单件不清它，编排器必须清）
  const snapshots = join(home, '.claude', 'ccm', 'statusline-v1', 'snapshots');
  mkdirSync(snapshots, { recursive: true });
  writeFileSync(join(snapshots, 'x.json'), '{}');

  const result = u.run({ purge: false });
  assert.equal(result.ok, true, JSON.stringify(result.steps));

  const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  assert.equal(settings.statusLine.command, 'bash /tmp/original-statusline.sh');
  assert.equal(settings.hooks, undefined, 'hooks 桥自建的容器应整体回收');
  assert.equal(existsSync(join(home, '.claude', 'ccm')), false, '~/.claude/ccm 应整目录清空');
  assert.equal(readFileSync(join(dataDir, 'sessions.json'), 'utf8'), '{}', '非 purge 不得碰数据根');
});

test('statusline 桥漂移（用户改过 settings）：拒绝并保留桥目录，整体退出非成功', () => {
  const { u, home, env } = makeUninstaller();
  const settingsPath = installBridges(home, env);
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  settings.statusLine.command = 'echo drifted-by-user';
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

  const result = u.run({ purge: false });
  assert.equal(result.ok, false);
  const step = result.steps.find((s) => s.name === 'bridge:statusline');
  assert.equal(step.status, 'refused');
  assert.equal(existsSync(join(home, '.claude', 'ccm', 'statusline-v1', 'install-manifest.json')), true,
    '漂移时不得清桥目录（manifest 是后续人工卸载的凭据）');
});

test('purge：数据根按白名单逐项删，未知文件保留并报告；配置文件删；受管 unit 日志删而 tunnel 日志不动', () => {
  const { u, home, root, dataDir, lines } = makeUninstaller({
    stubs: {
      service: (args) => ({
        status: 0,
        stdout: `${JSON.stringify({ ok: true, unit: args[1], action: 'uninstalled' })}\n`,
        stderr: '',
      }),
    },
  });
  mkdirSync(dataDir, { recursive: true });
  for (const name of DATA_FILE_WHITELIST) writeFileSync(join(dataDir, name), '{}');
  writeFileSync(join(dataDir, 'approval-requests.json.bak-手动备份'), '{}');
  mkdirSync(join(dataDir, 'worktree-settings'), { recursive: true });
  writeFileSync(join(dataDir, 'worktree-settings', 'aa.json'), '{}');
  // service manifest 里只有 server 受管 —— 只有它的日志可删
  writeFileSync(join(dataDir, 'service-install.json'), JSON.stringify({
    schemaVersion: 1, labelPrefix: 'com.ccm',
    units: { server: { label: 'com.ccm.server' } },
  }));
  writeFileSync(join(root, 'ccm.config.json'), '{}');
  writeFileSync(join(root, '.env'), 'AUTH_TOKEN=x\n');
  const logs = join(home, 'Library', 'Logs');
  mkdirSync(logs, { recursive: true });
  for (const f of ['ccm-server.log', 'ccm-server.log.0.gz', 'ccm-tunnel.log']) writeFileSync(join(logs, f), 'x');

  const result = u.run({ purge: true });
  assert.equal(result.ok, true, JSON.stringify(result.steps));

  for (const name of DATA_FILE_WHITELIST) {
    assert.equal(existsSync(join(dataDir, name)), false, `${name} 应被删除`);
  }
  assert.equal(existsSync(join(dataDir, 'worktree-settings')), false);
  assert.equal(existsSync(join(dataDir, 'approval-requests.json.bak-手动备份')), true, '未知文件必须保留');
  assert.match(lines.join('\n'), /bak-手动备份/, '保留的未知文件必须报告');
  assert.equal(existsSync(join(root, 'ccm.config.json')), false);
  assert.equal(existsSync(join(root, '.env')), false);
  assert.equal(existsSync(join(logs, 'ccm-server.log')), false);
  assert.equal(existsSync(join(logs, 'ccm-server.log.0.gz')), false);
  assert.equal(existsSync(join(logs, 'ccm-tunnel.log')), true, 'tunnel 不是产品装的，它的日志不能删');
});

test('launchd：manifest 里的 unit 逐个经 service.js 卸载；「未安装」按跳过处理', () => {
  const seen = [];
  const { u } = makeUninstaller({
    factory: {},
    stubs: {
      service: (args) => {
        seen.push(args.join(' '));
        const unit = args[1];
        if (unit === 'menubar') {
          return { status: 0, stdout: `${JSON.stringify({ ok: false, unit, error: 'com.ccm.menubar 未安装' })}\n`, stderr: '' };
        }
        return { status: 0, stdout: `${JSON.stringify({ ok: true, unit, action: 'uninstalled' })}\n`, stderr: '' };
      },
    },
    prepare: null,
  });
  // 手动放 manifest：server + menubar 受管，tunnel 故意不在
  const dataDir = u.paths.dataDir;
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'service-install.json'), JSON.stringify({
    schemaVersion: 1, labelPrefix: 'com.ccm',
    units: { server: {}, menubar: {} },
  }));

  const result = u.run({ purge: false });
  assert.equal(result.ok, true, JSON.stringify(result.steps));
  assert.deepEqual(seen, ['uninstall server --yes --json', 'uninstall menubar --yes --json']);
  const states = Object.fromEntries(result.steps.filter((s) => s.name.startsWith('unit:')).map((s) => [s.name, s.status]));
  assert.deepEqual(states, { 'unit:server': 'done', 'unit:menubar': 'skip' });
});

test('残留菜单栏进程：按 appPath 锚定探测，SIGTERM 后复查确认退出；PID ≤ 1 与非数字行一律丢弃', () => {
  let probes = 0;
  const killed = [];
  const { u } = makeUninstaller({
    stubs: {
      // 第一次探测命中两个真 PID + 一批必须被丢掉的行，SIGTERM 后复查为空。
      // `0` / `1` 不是理论边界：kill(1) 打的是 init/launchd，kill(0) 在 POSIX 上是
      // 「向本进程组全体发信号」—— 一个只判 Number.isInteger 的实现会把它们照单发出去。
      pgrep: () => (probes++ === 0
        ? { status: 0, stdout: '87128\n0\n1\n-3\nnot-a-pid\n\n87999\n', stderr: '' }
        : { status: 1, stdout: '', stderr: '' }),
    },
    factory: { kill: (pid, sig) => killed.push([pid, sig]), sleep: () => {} },
  });
  const result = u.run({ purge: false });
  assert.equal(result.ok, true, JSON.stringify(result.steps));
  assert.deepEqual(killed, [[87128, 'SIGTERM'], [87999, 'SIGTERM']],
    'pgrep 输出里只有 > 1 的整数才是可发信号的目标');
  const step = result.steps.find((s) => s.name === 'app-process');
  assert.equal(step.status, 'done');
});

test('残留菜单栏进程：dry-run 只报告将终止，不真杀', () => {
  const killed = [];
  const { u } = makeUninstaller({
    stubs: { pgrep: () => ({ status: 0, stdout: '87128\n', stderr: '' }) },
    factory: { kill: (pid, sig) => killed.push([pid, sig]), sleep: () => {} },
  });
  const result = u.run({ purge: false, dryRun: true });
  assert.deepEqual(killed, [], 'dry-run 不得发信号');
  const step = result.steps.find((s) => s.name === 'app-process');
  assert.equal(step.status, 'plan');
  assert.match(step.detail, /87128/);
  assert.equal(result.ok, true);
});

test('残留菜单栏进程：SIGTERM 未生效则报错并指引手动退出，不升级 SIGKILL', () => {
  const killed = [];
  const { u } = makeUninstaller({
    stubs: { pgrep: () => ({ status: 0, stdout: '87128\n', stderr: '' }) }, // 复查仍在
    factory: { kill: (pid, sig) => killed.push([pid, sig]), sleep: () => {} },
  });
  const result = u.run({ purge: false });
  assert.equal(result.ok, false);
  assert.ok(killed.every(([, sig]) => sig === 'SIGTERM'), '只允许 SIGTERM');
  const step = result.steps.find((s) => s.name === 'app-process');
  assert.equal(step.status, 'error');
  assert.match(step.detail, /退出/);
});

test('非 darwin：launchd/app/defaults 整段跳过，桥与数据逻辑照常', () => {
  const { u, spawn } = makeUninstaller({ factory: { platform: 'linux' } });
  const result = u.run({ purge: false });
  assert.equal(result.ok, true);
  assert.ok(spawn.calls.every(([cmd]) => cmd !== 'defaults' && cmd !== 'pgrep'), '非 darwin 不得碰 defaults/pgrep');
  assert.ok(result.steps.some((s) => s.name === 'launchd' && s.status === 'skip'));
});

test('CLI --dry-run 冒烟：真实脚本零改动跑通、退出 0、不动盘上任何东西', () => {
  const home = makeTmp('clihome');
  const dataDir = join(makeTmp('clidata'), 'data');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'sessions.json'), '{}');
  const r = spawnSync(process.execPath, [UNINSTALL, '--dry-run', '--purge'], {
    encoding: 'utf8',
    env: testEnvFor(home, dataDir),
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /dry-run/i);
  assert.match(r.stdout, /statusline/);
  assert.equal(readFileSync(join(dataDir, 'sessions.json'), 'utf8'), '{}', 'dry-run 不得删任何文件');
});
