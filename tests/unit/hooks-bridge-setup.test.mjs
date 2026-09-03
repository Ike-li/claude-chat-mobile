// hooks 桥安装器：往用户全局 ~/.claude/settings.json 的 hooks 数组里【追加】一个条目。
// 与 statusline 安装器（替换一个字符串字段）的关键差异：数组语义 → 用户既有条目必须原样保留，
// 卸载只能精确摘掉自己那条，自建的空容器才回收。全部用一次性 tmp HOME，不碰真实 ~/.claude。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const SETUP = join(ROOT, 'scripts', 'hooks-bridge-setup.js');

function makeHome() {
  return mkdtempSync(join(tmpdir(), 'ccm-hooks-setup-'));
}

const settingsPath = home => join(home, '.claude', 'settings.json');
const manifestPath = home => join(home, '.claude', 'ccm', 'hooks-v1', 'install-manifest.json');

function writeSettings(home, value) {
  const path = settingsPath(home);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2), { mode: 0o600 });
  return path;
}

const readJson = path => JSON.parse(readFileSync(path, 'utf8'));

function runSetup(home, action, extraEnv = {}) {
  return spawnSync(process.execPath, [SETUP, action], {
    encoding: 'utf8',
    env: {
      ...process.env, HOME: home, USERPROFILE: home,
      // 默认让安装内嵌的回环验证走一次性目录，绝不碰真实 ~/.claude/ccm/hooks-v1
      CLI_HOOKS_DIR: join(home, 'events'), CLI_HOOKS_ACKS_DIR: join(home, 'acks'),
      // 钉死到无人监听的端口：否则 L2 探活会探到本机真实在跑的生产 server（实测踩到），
      // 测试结果就随机器状态漂移。服务级分支由 hooks-inbox 的 ack 测试单独覆盖。
      PORT: '9',
      ...extraEnv,
    },
  });
}

const parse = res => JSON.parse(res.stdout.trim().split('\n').pop());

test('status：只读，不创建任何文件', () => {
  const home = makeHome();
  try {
    const res = runSetup(home, 'status');
    assert.equal(res.status, 0, res.stderr);
    assert.equal(parse(res).state, 'not-installed');
    assert.equal(existsSync(settingsPath(home)), false);
    assert.equal(existsSync(manifestPath(home)), false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('install：settings.json 不存在时创建；写入 Stop/Notification 两个 hook；manifest 0600', () => {
  const home = makeHome();
  try {
    const res = runSetup(home, 'install');
    assert.equal(res.status, 0, res.stderr);
    const settings = readJson(settingsPath(home));
    for (const event of ['Stop', 'Notification']) {
      assert.ok(Array.isArray(settings.hooks[event]), `${event} 应是数组`);
      assert.equal(settings.hooks[event].length, 1);
      const entry = settings.hooks[event][0];
      assert.equal(entry.hooks[0].type, 'command');
      assert.match(entry.hooks[0].command, /hooks-bridge\.js/);
      assert.ok(entry.hooks[0].timeout > 0, 'hook 须带超时，绝不能挂住用户的回合');
    }
    assert.equal(statSync(manifestPath(home)).mode & 0o777, 0o600);
    assert.equal(parse(runSetup(home, 'status')).state, 'installed');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('install：用户既有 hooks 条目原样保留（追加不覆盖）', () => {
  const home = makeHome();
  try {
    const mine = { matcher: '*', hooks: [{ type: 'command', command: 'echo user-own' }] };
    writeSettings(home, { hooks: { Stop: [mine], PreToolUse: [mine] } });
    assert.equal(runSetup(home, 'install').status, 0);
    const settings = readJson(settingsPath(home));
    assert.equal(settings.hooks.Stop.length, 2);
    assert.deepEqual(settings.hooks.Stop[0], mine, '用户原条目必须一字不动且仍在最前');
    assert.deepEqual(settings.hooks.PreToolUse, [mine], '未涉及的事件不得被碰');

    // 卸载后完全复原
    assert.equal(runSetup(home, 'uninstall').status, 0);
    const after = readJson(settingsPath(home));
    assert.deepEqual(after.hooks.Stop, [mine]);
    assert.deepEqual(after.hooks.PreToolUse, [mine]);
    assert.equal('Notification' in after.hooks, false, '自建的空数组应被回收');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('install：幂等——重复执行不重复追加', () => {
  const home = makeHome();
  try {
    runSetup(home, 'install');
    const second = parse(runSetup(home, 'install'));
    assert.equal(second.idempotent, true);
    assert.equal(readJson(settingsPath(home)).hooks.Stop.length, 1);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('install：manifest 已在但 settings 未改（中断的安装）→ 自动补完', () => {
  const home = makeHome();
  try {
    runSetup(home, 'install');
    const manifest = readJson(manifestPath(home));
    writeSettings(home, { theme: 'dark' }); // 模拟 settings 丢了 hooks 段
    const res = parse(runSetup(home, 'install'));
    assert.equal(res.recovered, true);
    assert.equal(readJson(settingsPath(home)).hooks.Stop[0].hooks[0].command, manifest.installedCommand);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('install：hooks[event] 存在但不是数组 → 拒绝且零改写', () => {
  const home = makeHome();
  try {
    writeSettings(home, { hooks: { Stop: 'not-an-array' } });
    const before = readFileSync(settingsPath(home), 'utf8');
    const res = runSetup(home, 'install');
    assert.notEqual(res.status, 0);
    assert.equal(readFileSync(settingsPath(home), 'utf8'), before, '拒绝时不得留下半成品');
    assert.equal(existsSync(manifestPath(home)), false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('install：已是本桥 wrapper 但无 manifest（孤儿）→ 拒绝', () => {
  const home = makeHome();
  try {
    writeSettings(home, {
      hooks: { Stop: [{ hooks: [{ type: 'command', command: `node ${join(ROOT, 'scripts', 'hooks-bridge.js')}` }] }] },
    });
    assert.notEqual(runSetup(home, 'install').status, 0);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('install：symlink 路径 fail-closed（settings 与 manifest 都查）', () => {
  const home = makeHome();
  try {
    const real = join(home, 'real-settings.json');
    writeFileSync(real, JSON.stringify({ hooks: {} }), { mode: 0o600 });
    mkdirSync(join(home, '.claude'), { recursive: true });
    symlinkSync(real, settingsPath(home));
    const res = runSetup(home, 'install');
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /symbolic link|符号链接/i);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('install：win32 明确拒绝（hook 命令依赖 POSIX 路径形态，不留半成品）', () => {
  const home = makeHome();
  try {
    const res = runSetup(home, 'install', { CCM_TEST_PLATFORM: 'win32' });
    assert.notEqual(res.status, 0);
    assert.equal(existsSync(manifestPath(home)), false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('uninstall：用户改过我们的条目 → status=drifted 且 CAS 拒绝覆盖', () => {
  const home = makeHome();
  try {
    runSetup(home, 'install');
    const settings = readJson(settingsPath(home));
    settings.hooks.Stop[0].hooks[0].command = 'echo hijacked';
    writeSettings(home, settings);
    assert.equal(parse(runSetup(home, 'status')).state, 'drifted');
    const before = readFileSync(settingsPath(home), 'utf8');
    assert.notEqual(runSetup(home, 'uninstall').status, 0);
    assert.equal(readFileSync(settingsPath(home), 'utf8'), before);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// 机主硬性要求：装完必须明确告知成功与否。L1 文件级验证离线可做——安装器用合成 stdin 真执行一遍
// 刚写进 settings 的那条命令，断言事件文件落盘（验的是 CLI 将来会走的完整链路：node 路径、脚本
// 路径、目录可建可写、权限正确）。
test('install 内嵌 L1 回环验证：真跑一次装好的命令并确认事件落盘，人类可读报告', () => {
  const home = makeHome();
  try {
    const res = runSetup(home, 'install');
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /文件级/);
    assert.match(res.stdout, /✓/);
    const result = parse(res);
    assert.equal(result.verify.fileLevel, 'ok');
    // server 未起 → 服务级验证跳过，但安装本身仍算成功
    assert.equal(result.verify.serviceLevel, 'skipped');
    assert.equal(result.state, 'installed');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('verify 子命令可单独重跑（修复后不必重装）', () => {
  const home = makeHome();
  try {
    runSetup(home, 'install');
    const res = runSetup(home, 'verify');
    assert.equal(res.status, 0, res.stderr);
    assert.equal(parse(res).verify.fileLevel, 'ok');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('verify：未安装时明确报未安装，不谎报成功', () => {
  const home = makeHome();
  try {
    const res = runSetup(home, 'verify');
    assert.notEqual(res.status, 0);
    assert.match(res.stderr + res.stdout, /未安装/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// L2 探活的硬约束：只做 TCP 握手，绝不向 server 发 HTTP 请求。
//
// 为什么这条值一个测试：HTTP 鉴权与 socket 握手【共用同一个限速桶】（app/src/server/http.js 的
// createHttpAuth 与 app/src/server/app.js 的 io.use 共享 rlStates），所以一次不带 token 的 /health
// 就是一次货真价实的鉴权失败——它会给 ip:127.0.0.1 上一把退避锁，把机主浏览器的 socket 握手
// 一起拖下水；连续 8 次直接锁 15 分钟。scripts/service.js 的纪律 2 早已写明这个坑并规避
// （探活只用 launchctl + 纯 TCP，"带 token 的 /health 只在 health 子命令里打一次"），
// 而本安装器此前仍在 `fetch('http://127.0.0.1:<port>/health')`，是同一个坑的漏网之鱼。
//
// 判据用「server 端收到几个 HTTP 请求」而不是「源码里有没有 fetch」：前者是外部可观察行为，
// 换成 got/axios/原生 http.request 照样管得住。
test('L2 探活只做 TCP 握手，绝不向 server 发 HTTP 请求（否则撞限速桶）', async () => {
  const home = makeHome();
  const server = createServer((_req, res) => { res.end('should-not-be-reached'); });
  let httpRequests = 0;
  server.on('request', () => { httpRequests += 1; });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const res = runSetup(home, 'install', { PORT: String(port) });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(httpRequests, 0,
      '探活发了 HTTP 请求：每一次都是一次鉴权失败，会把机主自己连同手机一起锁在门外');
    // 「确实探到了」用 serviceLevel 判，不用 server 端的 connection 计数：TCP 握手在内核的
    // listen backlog 上完成、探针立刻 destroy，等本进程的事件循环从 spawnSync 里回来时那条
    // 连接早没了，'connection' 事件根本不派发（实测恒 0）——拿它当判据是在观测一个观测不到的
    // 东西，恒红。serviceLevel 反而正是用户在报告里读到的那一行。
    assert.notEqual(parse(res).verify.serviceLevel, 'skipped',
      '端口明明通着，却报「server 未运行，跳过消费验证」——探活没探到');
  } finally {
    await new Promise(resolve => server.close(resolve));
    rmSync(home, { recursive: true, force: true });
  }
});
