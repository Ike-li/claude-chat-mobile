// tests/invariants/server/files-scope.test.mjs —— socket 文件面的范围门与审计留痕
// 守护：SCOPE-01（socket 上的 browse/read/write 与纯函数层走同一道范围门；越界必须记审计，那是无 approval-store 的写路径唯一事后可追溯记录）
// 覆盖：合法路径放行 + ../ 与绝对路径越界拒绝 + 越界记 scope_violation + 拒绝不泄漏服务端绝对路径
// 槽位：S2（真 app/server.js 子进程 + 一次性 WORK_DIR / CCM_DATA_DIR）
//
// 不测什么 + 为什么：
//  ① realpath / symlink 三层窗口（FILES-1/2/3）—— 判据在纯函数层，用真 symlink 测更直接，
//     已在 tests/invariants/file-browse.test.mjs 与 workdir-scope-guard.test.mjs（S1）。
//     本文件只证明「socket 这条路径确实走了那道门」，不重测门本身。
//  ② FILE_EDIT=off 整段关闭 —— 需要另起一台 server，单独用例。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { io as ioClient } from 'socket.io-client';
import { spawnServer, killServer } from '../../integration/_spawn-server.mjs';

const TOKEN = 'inv-files-scope-token';

let dir, workdir, auditFile, server, sock;

test.before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ccm-inv-files-'));
  workdir = join(dir, 'repo');
  mkdirSync(join(workdir, 'src'), { recursive: true });
  writeFileSync(join(workdir, 'src', 'a.txt'), 'hello\n');
  // 越界目标：工作区【外】的兄弟目录，模拟 ../ 逃逸后的真实落点
  mkdirSync(join(dir, 'outside'), { recursive: true });
  writeFileSync(join(dir, 'outside', 'secret.txt'), 'do-not-read\n');

  auditFile = join(dir, 'audit-records.json');
  server = await spawnServer({
    AUTH_TOKEN: TOKEN, WORK_DIR: workdir, CCM_DATA_DIR: dir, CCM_AUDIT_FILE: auditFile,
  });

  sock = ioClient(`http://127.0.0.1:${server.port}`, {
    auth: { token: TOKEN, deviceToken: 'inv-files-device' },
    transports: ['websocket'], reconnection: false, timeout: 4000,
    extraHeaders: { Host: 'localhost' },   // 本机直连：bypass 设备门，本文件只测范围门
  });
  await new Promise((resolve, reject) => {
    sock.on('connect', resolve);
    sock.on('connect_error', reject);
    setTimeout(() => reject(new Error('socket 未能在 5s 内连上')), 5000);
  });
});

test.after(async () => {
  try { sock?.close(); } catch { /* 已关闭 */ }
  if (server) await killServer(server.proc);
  if (dir) rmSync(dir, { recursive: true, force: true }); // safe-rm: mkdtemp 一次性目录
});

const emit = (event, payload) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`${event} 的 ack 超时——悬挂的 ack 在手机上就是永远转圈`)), 5000);
  sock.emit(event, payload, res => { clearTimeout(timer); resolve(res); });
});

const auditActions = () => {
  if (!existsSync(auditFile)) return [];
  try {
    const raw = JSON.parse(readFileSync(auditFile, 'utf8'));
    const list = Array.isArray(raw) ? raw : (raw.records ?? raw.entries ?? []);
    return list.map(r => r.action);
  } catch { return []; }
};

test('合法路径放行：列目录与读文件都拿得到内容', async () => {
  const listed = await emit('browse:list', { cwd: workdir, relPath: 'src' });
  assert.equal(listed.ok !== false, true, `列目录应成功，实际 ${JSON.stringify(listed)}`);

  const read = await emit('browse:read', { cwd: workdir, relPath: 'src/a.txt' });
  assert.equal(read.ok !== false, true);
  assert.match(read.content ?? '', /hello/);
});

test('../ 逃逸出工作区 → 拒绝', async () => {
  const res = await emit('browse:read', { cwd: workdir, relPath: '../outside/secret.txt' });
  assert.equal(res.ok, false, '相对路径回退必须被范围门挡下');
  assert.ok(!JSON.stringify(res).includes('do-not-read'), '拒绝的响应里绝不能夹带越界文件内容');
});

test('绝对路径直指工作区外 → 拒绝', async () => {
  const res = await emit('browse:read', { cwd: workdir, relPath: join(dir, 'outside', 'secret.txt') });
  assert.equal(res.ok, false);
});

test('列目录同样受范围门约束', async () => {
  const res = await emit('browse:list', { cwd: workdir, relPath: '../outside' });
  assert.equal(res.ok, false);
});

test('写回越界 → 拒绝，且工作区外的文件不得被改动', async () => {
  const target = join(dir, 'outside', 'secret.txt');
  const before = readFileSync(target, 'utf8');
  const res = await emit('files:write', {
    cwd: workdir, relPath: '../outside/secret.txt', content: 'PWNED', baseHash: 'whatever',
  });
  assert.equal(res.ok, false, '写路径的范围门必须先于内容检查');
  assert.equal(readFileSync(target, 'utf8'), before, '被拒绝的写不得留下任何副作用');
});

test('越界尝试留下 scope_violation 审计（写路径唯一的事后可追溯记录）', async () => {
  await emit('browse:read', { cwd: workdir, relPath: '../outside/secret.txt' });
  // 审计是异步落盘，给一小段时间；这里不是在等竞态窗口，而是等一次确定会发生的写。
  await new Promise(r => setTimeout(r, 300));
  assert.ok(auditActions().includes('scope_violation'),
    `越界必须留痕，实际审计动作：${JSON.stringify(auditActions())}`);
});

test('拒绝信息不泄漏服务端绝对路径', async () => {
  const res = await emit('browse:read', { cwd: workdir, relPath: '../outside/secret.txt' });
  const text = JSON.stringify(res);
  assert.ok(!text.includes(dir), '错误信息把宿主机真实路径回给浏览器 = 不必要的信息泄漏');
});
