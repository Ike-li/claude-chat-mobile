// tests/invariants/server/folders.test.mjs —— 手机上添加 / 新建文件夹在真 server 上的接线
// 守护：FOLDER-01（能加什么、写到哪、写完是否真的生效；新建只在范围内、越界什么都不建）
// 测什么：真 app/server.js 子进程上 folders:browse / folders:add / folders:mkdir 三条事件：
//   加进去的目录立刻出现在 ack 与广播里、配置文件原有条目（含 sessionLimit）原样保留、留审计；
//   不能加的一律拒绝且配置文件逐字节不变；配置文件不存在时不替用户建、来源是环境变量时不假装成功。
// 不测什么 + 为什么：① 判据本身（只回目录名、symlink、worktree、名字校验）在 S1 folder-picker.test.mjs
//   ② 前端的选择面板属 S3
// 槽位：S2（真 app/server.js 子进程 + 假 CLI；HOME 与配置文件都在一次性目录里）
// 执行位守卫：必须是第一条 import（它一旦放行晚了，下面那些模块的顶层代码已经跑过了）。
import '../../setup/require-disposable-env.mjs';

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, realpathSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { io as ioClient } from 'socket.io-client';
import { spawnServer, killServer } from '../../integration/_spawn-server.mjs';

const TOKEN = 'inv-folders-token';
let root, home, a, b, configPath, auditFile, server, sock;
const events = [];

const connect = port => new Promise((resolve, reject) => {
  const s = ioClient(`http://127.0.0.1:${port}`, {
    auth: { token: TOKEN, deviceToken: 'inv-folders-device' },
    transports: ['websocket'], reconnection: false, timeout: 4000,
    extraHeaders: { Host: 'localhost' },
  });
  s.on('connect', () => resolve(s));
  s.on('connect_error', reject);
  setTimeout(() => reject(new Error('socket 未能在 5s 内连上')), 5000);
});
const emitOn = (s, event, payload) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`${event} 的 ack 超时`)), 10000);
  s.emit(event, payload, res => { clearTimeout(timer); resolve(res); });
});
const emit = (event, payload) => emitOn(sock, event, payload);
const waitFor = async (pred, what, ms = 8000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const hit = pred();
    if (hit) return hit;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error(`等不到：${what}`);
};
const auditRows = pred => {
  try {
    const audit = existsSync(auditFile) ? JSON.parse(readFileSync(auditFile, 'utf8')) : {};
    return (Array.isArray(audit) ? audit : (audit.records ?? [])).filter(pred);
  } catch { return []; }
};
const serverEnv = extra => ({
  AUTH_TOKEN: TOKEN, CCM_DATA_DIR: join(root, `data-${Math.random().toString(36).slice(2)}`),
  HOME: home, XDG_DATA_HOME: join(home, '.local', 'share'), WORK_DIRS: '', WORK_DIRS_FILE: '', ...extra,
});

test.before(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ccm-inv-folders-')));
  home = join(root, 'home');
  a = join(home, 'code', 'a');
  b = join(home, 'code', 'b');
  mkdirSync(a, { recursive: true });
  mkdirSync(b, { recursive: true });
  configPath = join(root, 'ccm.config.json');
  writeFileSync(configPath, `${JSON.stringify({ WORKDIRS: [{ path: a, sessionLimit: 9 }] }, null, 2)}\n`);
  auditFile = join(root, 'audit-records.json');
  // 数据目录放进家目录（点目录，浏览看不见）：禁区用例要证明它是被「禁区」挡下的，不是被「家目录之外」挡下的
  const dataDir = join(home, '.ccm-data');
  mkdirSync(dataDir, { recursive: true });
  server = await spawnServer(serverEnv({ CCM_CONFIG_FILE_PATH: configPath, CCM_AUDIT_FILE: auditFile, CCM_DATA_DIR: dataDir }));
  sock = await connect(server.port);
  sock.on('agent:event', e => events.push(e));
});

test.after(async () => {
  try { sock?.close(); } catch { /* 已关闭 */ }
  if (server) await killServer(server.proc);
  if (root) rmSync(root, { recursive: true, force: true }); // safe-rm: mkdtemp 一次性目录
});

test('浏览：只回名字，已连接的那个标出来', async () => {
  const res = await emit('folders:browse', { path: 'code' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.home, home);
  assert.deepEqual(res.entries, [{ name: 'a', reason: 'already_connected' }, { name: 'b', reason: null }]);
});

test('添加：ack 带回生效后的列表、广播跟上、原有条目原样保留、留审计，新目录立刻可用', async () => {
  const res = await emit('folders:add', { path: 'code/b' });
  assert.deepEqual(res, { ok: true, dirs: [a, b] }, '写进文件却没生效 = 假成功');
  await waitFor(() => events.filter(e => e.type === 'instances').pop()?.payload?.dirs?.includes(b), '广播里出现新目录');
  assert.deepEqual(JSON.parse(readFileSync(configPath, 'utf8')).WORKDIRS, [{ path: a, sessionLimit: 9 }, b],
    '原有条目的 sessionLimit 被抹掉 = 用户配过的东西凭空消失');
  const list = await emit('session:list', { cwd: b });
  assert.equal(list.error, undefined, `加完了却列不了：${JSON.stringify(list)}`);
  const rows = () => auditRows(r => r.action === 'folder_connected' && r.target === b);
  await waitFor(() => rows().length === 1, 'folder_connected 审计记录').catch(() => {});
  assert.equal(rows().length, 1, '扩授权面的操作必须留痕');
});

test('不能加的一律拒绝，配置文件逐字节不变', async () => {
  const before = readFileSync(configPath, 'utf8');
  for (const [path, error] of [['', 'home'], ['..', 'outside_home'], ['code/a', 'already_connected'], ['code/nope', 'not_found']]) {
    assert.deepEqual(await emit('folders:add', { path }), { ok: false, error }, path);
  }
  assert.equal(readFileSync(configPath, 'utf8'), before);
  // 越界尝试进安全日志；正常浏览不进——每次浏览都记一条「越界」，安全日志就被刷成满屏告警
  const violations = via => auditRows(r => r.action === 'scope_violation' && r.meta?.via === via);
  await waitFor(() => violations('folders:add').length > 0, 'folders:add 越界审计').catch(() => {});
  assert.deepEqual(violations('folders:add').map(r => r.target), ['..']);
  assert.deepEqual(violations('folders:browse'), [], '成功的浏览被记成了越界');
});

// 禁区清单在组装根里拼（~/.claude、CCM 数据目录、scratch 根）。S1 的判据用例是自己把清单传进去的——
// 这条管的是 server 真把那三样传进去了：清空那份清单，其余用例照样全绿，而手工拼的
// folders:add {path:'.claude'} 就会把 ~/.claude 写进 WORKDIRS（浏览看不见点目录，添加却认任意相对路径）。
test('添加：禁区一律拒（~/.claude、CCM 数据目录、scratch 根），配置文件逐字节不变', async () => {
  mkdirSync(join(home, '.claude', 'x'), { recursive: true });
  mkdirSync(join(home, '.local', 'share', 'claude-chat-mobile', 'scratch-workspaces'), { recursive: true });
  const before = readFileSync(configPath, 'utf8');
  for (const path of ['.claude', '.claude/x', '.ccm-data', '.local/share/claude-chat-mobile/scratch-workspaces']) {
    assert.deepEqual(await emit('folders:add', { path }), { ok: false, error: 'forbidden' }, path);
  }
  assert.equal(readFileSync(configPath, 'utf8'), before);
});

test('新建：范围内建出一层，越界拒绝且什么都没建出来', async () => {
  const res = await emit('folders:mkdir', { path: 'code', name: 'fresh-proj' });
  assert.deepEqual(res, { ok: true, path: join(home, 'code', 'fresh-proj') });
  assert.ok(existsSync(res.path));
  const out = await emit('folders:mkdir', { path: '..', name: 'escaped' });
  assert.equal(out.ok, false);
  assert.equal(existsSync(join(root, 'escaped')), false);
});

test('配置文件不存在：拒绝，也不替用户建一个（hard-rules §4.6）', async () => {
  const missing = join(root, 'no-such-config.json');
  const other = await spawnServer(serverEnv({ CCM_CONFIG_FILE_PATH: missing, WORK_DIRS: a }));
  const s = await connect(other.port);
  try {
    assert.deepEqual(await emitOn(s, 'folders:add', { path: 'code/b' }), { ok: false, error: 'no_config_file' });
    assert.equal(existsSync(missing), false);
  } finally {
    s.close();
    await killServer(other.proc);
  }
});

test('工作区来自环境变量：写进配置文件也不会生效，拒绝而不是报成功', async () => {
  const cfg = join(root, 'env-shadowed.json');
  writeFileSync(cfg, `${JSON.stringify({ WORKDIRS: [a] })}\n`);
  const before = readFileSync(cfg, 'utf8');
  const other = await spawnServer(serverEnv({ CCM_CONFIG_FILE_PATH: cfg, WORK_DIRS: a }));
  const s = await connect(other.port);
  try {
    assert.deepEqual(await emitOn(s, 'folders:add', { path: 'code/b' }), { ok: false, error: 'source_readonly' });
    assert.equal(readFileSync(cfg, 'utf8'), before);
  } finally {
    s.close();
    await killServer(other.proc);
  }
});
