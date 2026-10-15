// tests/invariants/server/workdir-source.test.mjs —— 授权范围只来自显式连接的文件夹；清单为空也照常可用
// 守护：SCOPE-03（授权范围只来自用户显式连接的文件夹；清单为空或全部失效时照常启动、只剩「无文件夹」，绝不回落家目录）
// 测什么：真 app/server.js 上，配置里没有文件夹、或配置的文件夹全都找不到时：
//   · server 照常起来，家目录及其下的目录一律越界，缺省目录落在「无文件夹」；
//   · 不带 cwd 的新会话页也落在「无文件夹」，并当场建出 scratch 根（scout 要一个真实存在的 cwd）；
//   · 找不到的文件夹进服务告警（instances 广播的 service.missingFolders）与体检（WORK_DIRS warn），不让手机上只剩一片空却说不出原因；
//   · 热加载时显式清空即生效，而「有条目但一个都解析不出」仍保留原清单（编辑器写到一半、外置盘临时掉线）；
//   · 外置清单文件（WORK_DIRS_FILE）读不出来是配置坏了：拒绝启动并点名那个文件，不当成「还没连」；
//   · 正在看的文件夹被移出清单且它是最后一个时，不带参数的新会话页回落到「无文件夹」，不是 undefined。
// 不测什么 + 为什么：① 部分目录无效时的 warn-skip 归 tests/unit/workdirs.test.mjs ② WORK_DIR 折叠的纯函数契约同上
//   ③ 前端的零文件夹引导属 S3
// 槽位：S2（真 app/server.js 子进程 + 假 CLI；HOME / 配置文件 / 数据目录都在一次性目录里）
//
// 【这条为什么不是 SCOPE-01 的一部分】SCOPE-01 管「用户可控路径 realpath 后必须落在授权范围内」。
// 授权范围本身等于家目录时 SCOPE-01 每一条都是绿的，所以要单独钉住「范围从哪来」。
// 2026-09-08 实测过那种塌陷：`workDir: env.WORK_DIR || home` 加上「WORKDIRS 里的目录一个都不存在」，
// 白名单就恰好变成 [$HOME]，全程零报错，启动日志还打印「工作目录: /Users/xxx」。
//
// 【2026-10-15 改语义】原先一个都解析不出时拒绝启动。维护者定「WORKDIRS 留在配置文件、没有文件夹也能用」之后，
// 空清单是正常状态（新装、全部断开），拒绝启动反而把手机整个关在外面；原先拒绝启动要防的「手机上一片空、
// 却不知道是配置问题」改由服务告警与启动日志说清。不变的只有一条：绝不回落家目录。

// 执行位守卫：必须是第一条 import（它一旦放行晚了，下面那些模块的顶层代码已经跑过了）。
import '../../setup/require-disposable-env.mjs';

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { io as ioClient } from 'socket.io-client';
import { spawnServer, killServer } from '../../integration/_spawn-server.mjs';
import { stripInheritedEnv } from '../../helpers/spawn-env.mjs';
import { OUT_OF_SCOPE_ERROR } from '../../../app/src/server/socket-files.js';

const TOKEN = 'inv-scope03-token';
let root, home;
const started = [];

const waitFor = async (pred, what, ms = 8000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const hit = await pred();
    if (hit) return hit;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error(`等不到：${what}`);
};
const writeConfig = (path, config) => writeFileSync(path, `${JSON.stringify({ $schemaVersion: 1, ...config }, null, 2)}\n`);

// 起一台只认这份配置文件的 server，连上 socket。返回读广播、发事件、看输出的几个小工具。
async function start(config) {
  const id = randomUUID().slice(0, 8);
  const configPath = join(root, `ccm.config.${id}.json`);
  writeConfig(configPath, config);
  const server = await spawnServer({
    AUTH_TOKEN: TOKEN,
    HOME: home,
    XDG_DATA_HOME: join(home, '.local', 'share'),
    CCM_DATA_DIR: join(root, `data-${id}`),
    CCM_CONFIG_FILE_PATH: configPath,
    CCM_ENV_FILE_PATH: join(root, `no-such-${id}.env`),
    WORK_DIRS: '',
    WORK_DIRS_FILE: '',
  });
  let output = '';
  server.proc.stdout.on('data', c => { output += c; });
  server.proc.stderr.on('data', c => { output += c; });
  const events = [];
  const sock = await new Promise((resolve, reject) => {
    const s = ioClient(`http://127.0.0.1:${server.port}`, {
      auth: { token: TOKEN, deviceToken: `inv-scope03-${id}` },
      transports: ['websocket'], reconnection: false, timeout: 4000,
      extraHeaders: { Host: 'localhost' },
    });
    s.on('agent:event', e => events.push(e));
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
    setTimeout(() => reject(new Error('socket 未能在 5s 内连上')), 5000);
  });
  const handle = {
    configPath,
    output: () => output,
    latest: () => events.filter(e => e.type === 'instances').pop()?.payload,
    instances: () => waitFor(() => handle.latest(), 'instances 广播'),
    emit: (event, payload) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${event} 的 ack 超时`)), 10000);
      sock.emit(event, payload, res => { clearTimeout(timer); resolve(res); });
    }),
    // 只带回调、不带 payload：session:new 的兼容调用形态（emit('session:new', cb)），走的是「归位」那条路
    emitBare: event => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${event} 的 ack 超时`)), 10000);
      sock.emit(event, res => { clearTimeout(timer); resolve(res); });
    }),
    stop: async () => {
      try { sock.close(); } catch { /* 已关闭 */ }
      await killServer(server.proc);
    },
  };
  started.push(handle);
  return handle;
}

// 起一个 server 子进程并等它自己退出（或超时判定为「起来了」）。不用 spawnServer：它在启动失败时抛错，
// 而这里要断言的正是失败本身——退出码与输出都得看得见。超时是缺陷存在时走的分支，得能干净收场并带回证据。
function runServer(env, { timeoutMs = 15_000 } = {}) {
  return new Promise(resolve => {
    const proc = spawn('node', ['app/server.js'], {
      env: {
        ...stripInheritedEnv(process.env), DEV_MODE: '0', LOG_TERMINAL: 'off', CCM_TEST_PRESERVE_EMPTY_ENV: '1',
        // 预检先查工作区、再查 claude：找不到 claude 也是非 0 退出，会让「没拒绝」的缺陷照样过退出码那一关
        CLAUDE_BIN: join(process.cwd(), 'tests', 'fixtures', 'fake-claude.sh'),
        PORT: '0', ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: process.cwd(),
    });
    let out = '';
    let timedOut = false;
    proc.stdout.on('data', c => { out += c; });
    proc.stderr.on('data', c => { out += c; });
    const timer = setTimeout(() => { timedOut = true; proc.kill('SIGKILL'); }, timeoutMs);
    proc.on('exit', code => { clearTimeout(timer); resolve({ code, out, timedOut }); });
    proc.on('error', err => { clearTimeout(timer); resolve({ code: null, out: `${out}\n${err}`, timedOut }); });
  });
}

test.before(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ccm-inv-scope03-')));
  home = join(root, 'home');
  mkdirSync(join(home, 'code', 'x'), { recursive: true });
});

test.after(async () => {
  for (const s of started) await s.stop().catch(() => {});
  if (root) rmSync(root, { recursive: true, force: true }); // safe-rm: mkdtemp 一次性目录（HOME 也在里面）
});

test('清单为空：照常启动，只剩「无文件夹」，家目录与其下的目录一律越界', async () => {
  const s = await start({}); // 配置里根本没有 WORKDIRS（新装、或全部断开之后）
  const inst = await s.instances();
  assert.deepEqual(inst.dirs, [], `空清单被补成了别的目录：${JSON.stringify(inst.dirs)}`);
  assert.deepEqual((inst.projects ?? []).filter(p => p.kind !== 'scratch'), [], '抽屉里凭空多出了文件夹');
  assert.equal(inst.viewingCwd, inst.scratchRoot, `缺省目录必须落在「无文件夹」，实际是 ${inst.viewingCwd}`);
  for (const cwd of [home, join(home, 'code', 'x')]) {
    const res = await s.emit('session:list', { cwd });
    assert.equal(res.error, OUT_OF_SCOPE_ERROR, `${cwd} 在空清单下竟然可达——授权范围塌成了家目录`);
  }
  assert.doesNotMatch(s.output(), new RegExp(`工作目录:\\s*${home}\\s*$`, 'm'), '启动横幅把家目录说成了工作目录');
});

test('清单为空：不带 cwd 的新会话页落在「无文件夹」，scratch 根当场建出来', async () => {
  const s = await start({});
  const { scratchRoot } = await s.instances();
  const res = await s.emit('session:new', {});
  assert.equal(res?.ok, true, `新会话页被拒：${JSON.stringify(res)}`);
  assert.ok(existsSync(scratchRoot), 'scratch 根没建——scout 会在一个不存在的目录里起');
  assert.equal(s.latest()?.viewingCwd, scratchRoot);
});

test('配置的文件夹一个都找不到：照常启动，进服务告警，不回落家目录', async () => {
  const gone = join(home, 'code', 'gone');
  const s = await start({ WORKDIRS: [gone] });
  const inst = await s.instances();
  assert.deepEqual(inst.dirs, []);
  assert.equal(inst.service?.missingFolders, 1, '配置里的文件夹找不到却没进服务告警——手机上只看到一片空');
  assert.ok(s.output().includes(gone), `启动日志没说是哪个目录找不到：\n${s.output()}`);
  const res = await s.emit('session:list', { cwd: home });
  assert.equal(res.error, OUT_OF_SCOPE_ERROR, '全部失效之后家目录变得可达');
  // 体检与服务告警得是同一句话：两种情况下 workDirs 都是空的，找不到的个数只能由 server 另外喂给 runDoctor
  const doc = await s.emit('doctor:run', {});
  const wd = doc?.checks?.find(c => c.id === 'WORK_DIRS');
  assert.equal(wd?.status, 'warn', `体检把「配置了却找不到」说成了「还没连」：${JSON.stringify(wd)}`);
});

// 外置清单文件（旧版 WORK_DIRS_FILE）读不出来、或不是合法 JSON：那是配置坏了，不是「还没连」。照常启动的话，
// 启动日志与手机首页都会说「还没有连接任何文件夹，在手机上选一个」——可来源是外置文件时手机上加不了（source_readonly），
// 只剩一条走到底才报错的死路。启动时没有旧清单可保留（热加载读失败保留旧清单，同一道判据），只能拒绝启动并点名
// 那个文件（2026-10-15 Codex review #204）。
test('外置清单文件读不出来：拒绝启动并点名那个文件，不当成「还没连」', async () => {
  const broken = join(root, 'workdirs.broken.json');
  writeFileSync(broken, '{ 不是 JSON');
  const configPath = join(root, 'ccm.config.broken-file.json');
  writeConfig(configPath, {});
  const r = await runServer({
    AUTH_TOKEN: TOKEN, HOME: home, XDG_DATA_HOME: join(home, '.local', 'share'),
    CCM_DATA_DIR: join(root, 'data-broken-file'), CCM_CONFIG_FILE_PATH: configPath,
    CCM_ENV_FILE_PATH: join(root, 'no-such-broken-file.env'), WORK_DIRS: '', WORK_DIRS_FILE: broken,
  });
  assert.equal(r.timedOut, false, `外置清单文件读不出来，server 却照常起来了——配置错误被当成了「还没连」。输出：\n${r.out}`);
  assert.notEqual(r.code, 0, `退出码必须非 0（实际 ${r.code}）。输出：\n${r.out}`);
  assert.ok(r.out.includes(broken), `拒绝理由没点名是哪个文件，用户无从下手：\n${r.out}`);
});

test('热加载：有条目但一个都解析不出时保留原清单；显式清空立即生效', async () => {
  const a = join(home, 'code', 'a');
  mkdirSync(a, { recursive: true });
  const s = await start({ WORKDIRS: [a] });
  assert.deepEqual((await s.instances()).dirs, [a]);

  writeConfig(s.configPath, { WORKDIRS: [join(home, 'code', 'gone')] });
  await waitFor(() => /保留旧白名单/.test(s.output()), '「保留旧白名单」的热加载日志');
  assert.deepEqual(s.latest().dirs, [a], '编辑器写到一半 / 外置盘掉线时整份清单被清空');

  writeConfig(s.configPath, { WORKDIRS: [] });
  await waitFor(() => s.latest()?.dirs?.length === 0, '显式清空后广播里的 dirs 变成 []');
});

// 前端发的是 {cwd}，带着已移出清单的目录会按 SCOPE-05 被拒（request-cwd-scope 那批用例管）。
// 这里管的是不带 payload 的那条「归位」路径：它取 primaryWorkDir，清单空了就必须是「无文件夹」，而不是 undefined。
test('正在看的文件夹被移出清单且它是最后一个：不带参数的新会话页回落到「无文件夹」', async () => {
  const b = join(home, 'code', 'b');
  mkdirSync(b, { recursive: true });
  const s = await start({ WORKDIRS: [b] });
  const { scratchRoot } = await s.instances();
  const sent = await s.emit('user:message', { text: '在 b 里开个会话', cwd: b, clientMessageId: `scope03-${randomUUID()}` });
  assert.equal(sent?.ok, true, `首条消息被拒：${JSON.stringify(sent)}`);
  await waitFor(() => s.latest()?.instances?.some(i => i.cwd === b), 'b 里的实例出现在广播里');

  writeConfig(s.configPath, { WORKDIRS: [] });
  await waitFor(() => s.latest()?.dirs?.length === 0, '清空后广播里的 dirs 变成 []');
  assert.equal(s.latest().viewingCwd, b, '在跑的会话所在的文件夹被移出后，查看目录不该被抢走（仅拒新开）');

  const res = await s.emitBare('session:new');
  assert.equal(res?.ok, true, `新会话页被拒：${JSON.stringify(res)}`);
  await waitFor(() => s.latest()?.viewingCwd === scratchRoot, '新会话页回落到「无文件夹」');
  assert.ok(existsSync(scratchRoot), 'scratch 根没建——scout 会在一个不存在的目录里起');
});
