// tests/invariants/server/request-cwd-scope.test.mjs —— 显式越界的 cwd 一律拒绝，不回落成别的目录
// 守护：SCOPE-05（显式传入的越界 cwd 一律拒绝并记审计，不得静默回落到别的目录）
// 测什么：真 server 上，带着一个不在已连接文件夹里的 cwd 发请求——列表、历史、文件浏览、首条消息——
//   都拿不到**另一个目录**的数据、也不会把消息投进另一个工作区；以及热移除之后的分档：
//   已开会话自己的目录仍可读（读档），但不能在那里新开、也不再列它（开 / 建档）。
// 不测什么 + 为什么：① 判据本身（子目录、worktree、禁区）在 S1 的 folder-access / worktree-ownership
//   ② 前端拿到拒绝后怎么展示属 S3
// 槽位：S2（真 app/server.js 子进程 + 假 CLI + 一次性 CCM_DATA_DIR / 配置文件；transcript 写进容器里一次性 HOME）
// 执行位守卫：必须是第一条 import（它一旦放行晚了，下面那些模块的顶层代码已经跑过了）。
import '../../setup/require-disposable-env.mjs';

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { io as ioClient } from 'socket.io-client';
import { spawnServer, killServer } from '../../integration/_spawn-server.mjs';
import { encodeProjectDir } from '../../../app/src/shared/project-dir.js';

const TOKEN = 'inv-request-cwd-scope-token';
const SID_A = randomUUID();

let root, a, b, c, configPath, auditFile, server, sock;
const projectDirs = [];
const events = [];

test.before(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ccm-inv-reqscope-')));
  a = join(root, 'a');      // 一直连接着
  b = join(root, 'b');      // 先连接，后被热移除（其上留一个在跑的实例）
  c = join(root, 'c');      // 从来没连接过
  for (const d of [a, b, c]) mkdirSync(d);
  writeFileSync(join(a, 'a-only.txt'), 'a\n');
  // A 的一条会话：越界请求若回落到 A（此前的行为），就会把它交出去
  const dir = join(homedir(), '.claude', 'projects', encodeProjectDir(a));
  mkdirSync(dir, { recursive: true });
  projectDirs.push(dir);
  writeFileSync(join(dir, `${SID_A}.jsonl`), `${JSON.stringify({
    type: 'user', uuid: randomUUID(), parentUuid: null, timestamp: new Date().toISOString(),
    sessionId: SID_A, cwd: a, isMeta: false, message: { role: 'user', content: [{ type: 'text', text: 'A 里说的话' }] },
  })}\n`);

  configPath = join(root, 'ccm.config.json');
  writeFileSync(configPath, JSON.stringify({ WORKDIRS: [a, b] }));
  auditFile = join(root, 'audit-records.json');
  server = await spawnServer({
    AUTH_TOKEN: TOKEN, CCM_CONFIG_FILE_PATH: configPath, CCM_DATA_DIR: join(root, 'data'), CCM_AUDIT_FILE: auditFile,
  });
  sock = ioClient(`http://127.0.0.1:${server.port}`, {
    auth: { token: TOKEN, deviceToken: 'inv-reqscope-device' },
    transports: ['websocket'], reconnection: false, timeout: 4000,
    extraHeaders: { Host: 'localhost' },
  });
  sock.on('agent:event', e => events.push(e));
  await new Promise((resolve, reject) => {
    sock.on('connect', resolve);
    sock.on('connect_error', reject);
    setTimeout(() => reject(new Error('socket 未能在 5s 内连上')), 5000);
  });
});

test.after(async () => {
  try { sock?.close(); } catch { /* 已关闭 */ }
  if (server) await killServer(server.proc);
  if (root) rmSync(root, { recursive: true, force: true }); // safe-rm: mkdtemp 一次性目录
  for (const d of projectDirs) rmSync(d, { recursive: true, force: true }); // safe-rm: 目录名由本文件一次性 cwd 编码而来
});

const emit = (event, payload) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`${event} 的 ack 超时——悬挂的 ack 在手机上就是永远转圈`)), 15000);
  sock.emit(event, payload, res => { clearTimeout(timer); resolve(res); });
});
const waitFor = async (pred, what, ms = 8000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const hit = pred();
    if (hit) return hit;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error(`等不到：${what}`);
};
const latestInstances = () => events.filter(e => e.type === 'instances').pop()?.payload;

test('显式越界：列表、历史、文件浏览都拒绝，拿不到另一个目录的数据', async () => {
  // 正对照：A 自己列得出
  assert.ok((await emit('session:list', { cwd: a })).sessions.some(s => s.id === SID_A), '前提：A 的会话列得出来');

  const list = await emit('session:list', { cwd: c });
  assert.match(list.error ?? '', /不在已连接的文件夹里/, `越界列表必须明确拒绝，实际 ${JSON.stringify(list)}`);
  assert.deepEqual(list.sessions, [], '回落成 A 就会把 A 的会话画在 C 的标题下');

  const hist = await emit('session:history', { sessionId: SID_A, cwd: c });
  assert.deepEqual(hist.messages, [], '拿越界 cwd 读到了 A 的历史 = 回落把别的目录的数据交了出去');
  assert.match(hist.error ?? '', /不在已连接的文件夹里/);

  const browse = await emit('browse:list', { cwd: c, relPath: '.' });
  assert.equal(browse.ok, false);
  assert.equal(browse.entries, undefined, '不能列出 C，也不能偷偷列出 A');

  // 审计异步落盘：轮询到位或超时（坏掉时才耗满上限）
  const rowsForC = () => {
    try {
      const audit = existsSync(auditFile) ? JSON.parse(readFileSync(auditFile, 'utf8')) : {};
      return (Array.isArray(audit) ? audit : (audit.records ?? [])).filter(r => r.action === 'scope_violation' && r.target === c);
    } catch { return []; }
  };
  const rows = await waitFor(() => (rowsForC().length >= 3 ? rowsForC() : null), '三次越界各留一条 scope_violation 审计')
    .catch(() => rowsForC());
  assert.ok(rows.length >= 3, `每次越界都要留痕，实际 ${rows.length} 条`);
});

test('显式越界的首条消息：拒绝且不在别的工作区里懒开实例', async () => {
  const res = await emit('user:message', { text: '发到 C', cwd: c, clientMessageId: 'reqscope-c-1' });
  assert.equal(res.ok, false, `越界 cwd 的首条消息必须拒绝，实际 ${JSON.stringify(res)}`);
  assert.equal(res.permanent, true, '重发必然再被拒——离线队列要停止重试');
  const insts = latestInstances()?.instances ?? [];
  assert.equal(insts.length, 0, `不得在别的工作区懒开实例，实际 ${JSON.stringify(insts.map(i => i.cwd))}`);
});

test('热移除之后：已开会话自己的目录仍可读，但不能在那里新开、也不再列它', async () => {
  writeFileSync(join(b, 'kept.txt'), '移除之前的内容');
  const first = await emit('user:message', { text: '在 B 里开', cwd: b, clientMessageId: 'reqscope-b-1' });
  assert.equal(first.ok, true, `前提：B 已连接时能开，实际 ${JSON.stringify(first)}`);
  await waitFor(() => latestInstances()?.instances?.some(i => i.cwd === b), 'B 上的实例出现在广播里');

  writeFileSync(configPath, JSON.stringify({ WORKDIRS: [a] }));
  await waitFor(() => JSON.stringify(latestInstances()?.dirs) === JSON.stringify([a]), '热加载后 dirs 只剩 A');

  const browse = await emit('browse:list', { cwd: b, relPath: '.' });
  assert.equal(browse.ok, true, `已开会话的目录被热移除后仍须可读（读档），实际 ${JSON.stringify(browse)}`);

  // 查看可以，直写不行：写回不经工具审批，移出清单就是「别再碰它」。写回只改已有文件、要带读时的
  // 内容哈希——先用读档把哈希拿到手，保证被拒只可能是因为范围，不是因为参数不全。
  const read = await emit('browse:read', { cwd: b, relPath: 'kept.txt' });
  assert.ok(read.contentHash, `前提：读档能读到文件并给出哈希，实际 ${JSON.stringify(read)}`);
  const wrote = await emit('files:write', { cwd: b, relPath: 'kept.txt', content: '移除之后改的', baseHash: read.contentHash });
  assert.equal(wrote.ok, false, `热移除的目录不得再被文件编辑器直写，实际 ${JSON.stringify(wrote)}`);
  assert.equal(readFileSync(join(b, 'kept.txt'), 'utf8'), '移除之前的内容');

  const created = await emit('session:new', { cwd: b });
  assert.equal(created.ok, false, '热移除的目录上不得新开（仅拒新开）');

  const list = await emit('session:list', { cwd: b });
  assert.match(list.error ?? '', /不在已连接的文件夹里/, '列表是开档：只认当前授权');
});
