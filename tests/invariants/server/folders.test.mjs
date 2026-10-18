// tests/invariants/server/folders.test.mjs —— 手机上添加 / 新建 / 断开文件夹在真 server 上的接线
// 守护：FOLDER-01（能加什么、写到哪、写完是否真的生效；新建只在范围内、越界什么都不建；断开只认连接根）
// 测什么：真 app/server.js 子进程上 folders:browse / folders:add / folders:mkdir / folders:remove 四条事件：
//   加进去的目录立刻出现在 ack 与广播里、配置文件原有条目（含 sessionLimit）原样保留、留审计；
//   不能加的一律拒绝且配置文件逐字节不变；配置文件不存在时不替用户建、来源是环境变量时不假装成功；
//   这两种「手机上改不了」在 instances 广播的 foldersReadonly 里提前说清，能改时是 null，新建也只剩已连接的文件夹里；
//   已经连着的不重复写；断开只认连接根、其余条目原样保留、剩下的全都找不到也照样生效、开着的会话照常跑。
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
// 这台 server 的广播里说的「手机上能不能改清单」：null = 能；否则是原因码（与 folders:add 拒绝时同一套）。
// 首页零文件夹引导据此决定给不给「选择文件夹」。先触发一帧广播再读，不赌连上时那一帧到没到。
const readonlyOf = async s => {
  const got = [];
  s.on('agent:event', e => { if (e.type === 'instances') got.push(e.payload); });
  await emitOn(s, 'session:home', {});
  await waitFor(() => got.length, 'instances 广播');
  return got.at(-1).foldersReadonly;
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
  for (const [path, error] of [['', 'home'], ['..', 'outside_home'], ['code/nope', 'not_found']]) {
    assert.deepEqual(await emit('folders:add', { path }), { ok: false, error }, path);
  }
  assert.equal(readFileSync(configPath, 'utf8'), before);
  // 越界尝试进安全日志；正常浏览不进——每次浏览都记一条「越界」，安全日志就被刷成满屏告警
  const violations = via => auditRows(r => r.action === 'scope_violation' && r.meta?.via === via);
  await waitFor(() => violations('folders:add').length > 0, 'folders:add 越界审计').catch(() => {});
  assert.deepEqual(violations('folders:add').map(r => r.target), ['..']);
  assert.deepEqual(violations('folders:browse'), [], '成功的浏览被记成了越界');
});

// 「在这里开始会话」也用在已经连着的文件夹上：再点一次不该报错，也不该把同一个目录再写一遍。
test('添加已经连着的文件夹：照常成功、标明没有新加，配置逐字节不变，不再记一条扩授权面的审计', async () => {
  const before = readFileSync(configPath, 'utf8');
  const connectedRows = () => auditRows(r => r.action === 'folder_connected' && r.target === a).length;
  const rowsBefore = connectedRows();
  const res = await emit('folders:add', { path: 'code/a' });
  assert.equal(res?.ok, true, `已经连着的文件夹点「在这里开始会话」却报错：${JSON.stringify(res)}`);
  assert.equal(res.added, false);
  assert.ok(res.dirs.includes(a));
  assert.equal(readFileSync(configPath, 'utf8'), before, '同一个目录被再写了一遍');
  assert.equal(connectedRows(), rowsBefore);
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

test('配置文件不存在：拒绝，也不替用户建一个（hard-rules §4.6）；广播里先说清手机上改不了', async () => {
  const missing = join(root, 'no-such-config.json');
  const other = await spawnServer(serverEnv({ CCM_CONFIG_FILE_PATH: missing, WORK_DIRS: a }));
  const s = await connect(other.port);
  try {
    assert.equal(await readonlyOf(s), 'no_config_file', '广播没说手机上改不了：零文件夹引导会给一个走完选择面板才报错的按钮');
    assert.deepEqual(await emitOn(s, 'folders:add', { path: 'code/b' }), { ok: false, error: 'no_config_file' });
    assert.equal(existsSync(missing), false);
    assert.deepEqual(await emitOn(s, 'folders:mkdir', { path: 'code', name: 'no-cfg-proj' }), { ok: false, error: 'no_config_file' });
    assert.equal(existsSync(join(home, 'code', 'no-cfg-proj')), false, '拒了却已经在磁盘上建出来了');
  } finally {
    s.close();
    await killServer(other.proc);
  }
});

// 配置里根本没有 WORKDIRS 键、也没设环境变量：新装时跳过了问文件夹就是这样（2026-10-15 起可以跳过）。
// 来源就是这份配置文件，加进去热加载即生效。此前这一格被当成「来自环境变量」拒掉，零文件夹首页上
// 点「选择文件夹」第一次添加就失败（隔离实例实测撞上，mock 那层看不见）。
test('配置里还没有 WORKDIRS（新装跳过了文件夹）：照常加进配置文件，立刻可用', async () => {
  const cfg = join(root, 'no-workdirs-key.json');
  writeFileSync(cfg, `${JSON.stringify({ $schemaVersion: 1 })}\n`);
  const other = await spawnServer(serverEnv({ CCM_CONFIG_FILE_PATH: cfg }));
  const s = await connect(other.port);
  try {
    assert.equal(await readonlyOf(s), null, '能加却说成改不了：零文件夹引导会把唯一的入口藏起来');
    const res = await emitOn(s, 'folders:add', { path: 'code/b' });
    assert.equal(res?.ok, true, `第一次添加就被拒：${JSON.stringify(res)}`);
    assert.deepEqual(res.dirs, [b]);
    assert.deepEqual(JSON.parse(readFileSync(cfg, 'utf8')).WORKDIRS, [b]);
  } finally {
    s.close();
    await killServer(other.proc);
  }
});

test('工作区来自环境变量：写进配置文件也不会生效，拒绝而不是报成功；广播里先说清手机上改不了', async () => {
  const cfg = join(root, 'env-shadowed.json');
  writeFileSync(cfg, `${JSON.stringify({ WORKDIRS: [a] })}\n`);
  const before = readFileSync(cfg, 'utf8');
  const other = await spawnServer(serverEnv({ CCM_CONFIG_FILE_PATH: cfg, WORK_DIRS: a }));
  const s = await connect(other.port);
  try {
    assert.equal(await readonlyOf(s), 'source_readonly', '广播没说手机上改不了：零文件夹引导会给一个走完选择面板才报错的按钮');
    assert.deepEqual(await emitOn(s, 'folders:add', { path: 'code/b' }), { ok: false, error: 'source_readonly' });
    assert.equal(readFileSync(cfg, 'utf8'), before);
    // 新建也一样：已连接的文件夹之外建出来的加不进清单，只会留一个空目录（验收 O41）；已连接的文件夹里照常建
    assert.deepEqual(await emitOn(s, 'folders:mkdir', { path: 'code', name: 'ro-proj' }), { ok: false, error: 'source_readonly' });
    assert.equal(existsSync(join(home, 'code', 'ro-proj')), false, '拒了却已经在磁盘上建出来了');
    const inner = await emitOn(s, 'folders:mkdir', { path: 'code/a', name: 'ro-inner' });
    assert.deepEqual(inner, { ok: true, path: join(a, 'ro-inner') });
  } finally {
    s.close();
    await killServer(other.proc);
  }
});

// ---- 断开（2026-10-15）：抽屉里「⋯ → 断开这个文件夹」。与添加对称：只写配置文件内联 WORKDIRS、同步热加载、留审计。
// 位置用绝对路径（抽屉小节的 key）：连接根可以在家目录之外，家目录相对路径表达不了；只认与清单精确相等的那个。

// 起一台只认这份配置的 server，连上 socket，收广播。
async function startWith(workdirs, extra = {}) {
  const cfg = join(root, `remove-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(cfg, `${JSON.stringify({ WORKDIRS: workdirs }, null, 2)}\n`);
  const srv = await spawnServer(serverEnv({ CCM_CONFIG_FILE_PATH: cfg, CCM_AUDIT_FILE: auditFile, ...extra }));
  const s = await connect(srv.port);
  const seen = [];
  s.on('agent:event', e => seen.push(e));
  const latest = () => seen.filter(e => e.type === 'instances').pop()?.payload;
  return { cfg, s, latest, stop: async () => { s.close(); await killServer(srv.proc); } };
}

test('断开：只认连接根；子文件夹、无文件夹、不在清单里的一律拒，配置逐字节不变', async () => {
  const sub = join(a, 'sub');
  mkdirSync(sub, { recursive: true });
  const before = readFileSync(configPath, 'utf8');
  const { scratchRoot } = await waitFor(() => events.filter(e => e.type === 'instances').pop()?.payload, 'instances 广播');
  for (const path of [sub, scratchRoot, join(home, 'code'), '/definitely/not/connected', '', 42, null]) {
    assert.deepEqual(await emit('folders:remove', { path }), { ok: false, error: 'not_connected' }, String(path));
  }
  assert.equal(readFileSync(configPath, 'utf8'), before);
});

test('断开：其他条目连同 sessionLimit 原样保留，ack 带回生效后的列表，广播跟上，留审计', async () => {
  const c = join(home, 'code', 'c');
  mkdirSync(c, { recursive: true });
  const srv = await startWith([{ path: a, sessionLimit: 9 }, b, c]);
  try {
    const res = await emitOn(srv.s, 'folders:remove', { path: b });
    assert.deepEqual(res, { ok: true, dirs: [a, c] }, '写进文件却没生效 = 假成功');
    await waitFor(() => srv.latest()?.dirs?.join('|') === [a, c].join('|'), '广播里少了断开的目录');
    assert.deepEqual(JSON.parse(readFileSync(srv.cfg, 'utf8')).WORKDIRS, [{ path: a, sessionLimit: 9 }, c],
      '断开一个却动了别的条目（sessionLimit 被抹掉 = 用户配过的东西凭空消失）');
    const rows = () => auditRows(r => r.action === 'folder_disconnected' && r.target === b);
    await waitFor(() => rows().length === 1, 'folder_disconnected 审计记录').catch(() => {});
    assert.equal(rows().length, 1, '缩授权面的操作同样要留痕');
  } finally {
    await srv.stop();
  }
});

test('断开最后一个：清单变空，只剩「无文件夹」', async () => {
  const srv = await startWith([a]);
  try {
    const res = await emitOn(srv.s, 'folders:remove', { path: a });
    assert.deepEqual(res, { ok: true, dirs: [] });
    await waitFor(() => srv.latest()?.dirs?.length === 0, '广播里的 dirs 变成 []');
    const { scratchRoot, viewingCwd } = srv.latest();
    assert.equal(viewingCwd, scratchRoot, `断开最后一个之后缺省目录没落到「无文件夹」：${viewingCwd}`);
  } finally {
    await srv.stop();
  }
});

// 剩下的条目都找不到（外置盘没挂上）时，热加载的「有条目却一个都解析不出 → 保留旧清单」会把这次断开吞掉。
// 那条保护防的是编辑器写到一半；断开是用户在手机上点的，意图明确，必须生效。
test('断开：剩下的都找不到时照样生效，不被「保留旧清单」吞掉', async () => {
  const srv = await startWith([a, join(home, 'code', 'gone')]);
  try {
    const res = await emitOn(srv.s, 'folders:remove', { path: a });
    assert.deepEqual(res, { ok: true, dirs: [] }, `断开被吞了：${JSON.stringify(res)}`);
  } finally {
    await srv.stop();
  }
});

test('断开正在用的文件夹：已开会话继续，只拒新开', async () => {
  const srv = await startWith([a, b]);
  try {
    const sent = await emitOn(srv.s, 'user:message', { text: '在 a 里开个会话', cwd: a, clientMessageId: `folders-remove-${Date.now()}` });
    assert.equal(sent?.ok, true, `首条消息被拒：${JSON.stringify(sent)}`);
    await waitFor(() => srv.latest()?.instances?.some(i => i.cwd === a), 'a 里的实例出现在广播里');
    const res = await emitOn(srv.s, 'folders:remove', { path: a });
    assert.deepEqual(res, { ok: true, dirs: [b] });
    await waitFor(() => srv.latest()?.dirs?.join('|') === b, '广播里的 dirs 只剩 b');
    assert.ok(srv.latest().instances.some(i => i.cwd === a), '断开把正在跑的会话一起关掉了');
    const fresh = await emitOn(srv.s, 'session:new', { cwd: a });
    assert.equal(fresh?.ok, false, `断开之后还能在里面新开会话：${JSON.stringify(fresh)}`);
  } finally {
    await srv.stop();
  }
});

test('断开：工作区来自环境变量时拒绝（写了也不生效）；配置文件不存在时拒绝，也不替用户建', async () => {
  const shadowed = await startWith([a], { WORK_DIRS: a });
  try {
    const before = readFileSync(shadowed.cfg, 'utf8');
    assert.deepEqual(await emitOn(shadowed.s, 'folders:remove', { path: a }), { ok: false, error: 'source_readonly' });
    assert.equal(readFileSync(shadowed.cfg, 'utf8'), before);
  } finally {
    await shadowed.stop();
  }
  const missing = join(root, 'no-such-config-remove.json');
  const other = await spawnServer(serverEnv({ CCM_CONFIG_FILE_PATH: missing, WORK_DIRS: a }));
  const s = await connect(other.port);
  try {
    assert.deepEqual(await emitOn(s, 'folders:remove', { path: a }), { ok: false, error: 'no_config_file' });
    assert.equal(existsSync(missing), false);
  } finally {
    s.close();
    await killServer(other.proc);
  }
});
