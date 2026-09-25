// tests/invariants/server/no-folder.test.mjs —— 「无文件夹」会话在真 server 上的全流程
// 守护：SCRATCH-01（scratch 目录只在它里面最后一个会话被删、且没有活实例时才随之删除）
// 测什么：真 app/server.js 子进程上：选「无文件夹」→ 首条消息懒建一个 scratch 目录、会话开在里面、归「无文件夹」项目；
//   连发的首条消息只建一个目录；删会话时目录里还有别的会话就留着，删到最后一个才连目录一起删。
// 不测什么 + 为什么：① 删除护栏逐条（symlink、形态、根是家目录……）在 S1 scratch-workspaces.test.mjs
//   ② 分配器的在途共用在这一层观测不到（真 server 把连发的首条消息串行化了），只有 unit 覆盖
//   ③ 前端「无文件夹」入口属 S3
// 槽位：S2（真 app/server.js 子进程 + 假 CLI；HOME / XDG_DATA_HOME 都在一次性目录里，scratch 根随之落在里面）
// 执行位守卫：必须是第一条 import（它一旦放行晚了，下面那些模块的顶层代码已经跑过了）。
import '../../setup/require-disposable-env.mjs';

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { io as ioClient } from 'socket.io-client';
import { spawnServer, killServer } from '../../integration/_spawn-server.mjs';
import { encodeProjectDir } from '../../../app/src/shared/project-dir.js';
import { SCRATCH_DIR_RE } from '../../../app/src/sessions/folder-access.js';

const TOKEN = 'inv-no-folder-token';
let root, home, server, sock, scratchRoot;
const events = [];

const emit = (event, payload) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`${event} 的 ack 超时`)), 15000);
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
const scratchDirs = () => (existsSync(scratchRoot) ? readdirSync(scratchRoot).filter(n => SCRATCH_DIR_RE.test(n)) : []);
const writeTranscript = (cwd, sessionId) => {
  const dir = join(home, '.claude', 'projects', encodeProjectDir(cwd));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sessionId}.jsonl`), `${JSON.stringify({
    type: 'user', uuid: randomUUID(), parentUuid: null, timestamp: new Date().toISOString(),
    sessionId, cwd, isMeta: false, message: { role: 'user', content: [{ type: 'text', text: '无文件夹里说的话' }] },
  })}\n`);
};
// 开一个「无文件夹」会话：选无文件夹 → 发首条消息 → 等实例出现，返回实例
async function openNoFolderSession(tag) {
  assert.equal((await emit('session:new', { cwd: scratchRoot }))?.ok, true);
  const res = await emit('user:message', { text: `无文件夹 ${tag}`, cwd: scratchRoot, clientMessageId: `nf-${tag}-${randomUUID()}` });
  assert.equal(res?.ok, true, `无文件夹的首条消息被拒：${JSON.stringify(res)}`);
  return waitFor(() => latestInstances()?.instances?.find(i => i.instanceId === res.instanceId), '实例出现在广播里');
}

test.before(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ccm-inv-nofolder-')));
  home = join(root, 'home');
  const work = join(home, 'code', 'a');
  mkdirSync(work, { recursive: true });
  server = await spawnServer({
    AUTH_TOKEN: TOKEN, WORK_DIRS: work, CCM_DATA_DIR: join(root, 'data'),
    HOME: home, XDG_DATA_HOME: join(home, '.local', 'share'), SESSION_DELETE_QUIET_MS: '0',
    CCM_AUDIT_FILE: join(root, 'audit-records.json'),
  });
  sock = ioClient(`http://127.0.0.1:${server.port}`, {
    auth: { token: TOKEN, deviceToken: 'inv-nofolder-device' },
    transports: ['websocket'], reconnection: false, timeout: 4000,
    extraHeaders: { Host: 'localhost' },
  });
  sock.on('agent:event', e => events.push(e));
  await new Promise((resolve, reject) => {
    sock.on('connect', resolve);
    sock.on('connect_error', reject);
    setTimeout(() => reject(new Error('socket 未能在 5s 内连上')), 5000);
  });
  scratchRoot = (await waitFor(() => latestInstances()?.scratchRoot, '广播里的 scratchRoot'));
});

test.after(async () => {
  try { sock?.close(); } catch { /* 已关闭 */ }
  if (server) await killServer(server.proc);
  if (root) rmSync(root, { recursive: true, force: true }); // safe-rm: mkdtemp 一次性目录（HOME 也在里面）
});

test('选「无文件夹」：scratch 根建出来（scout 要一个真实存在的 cwd），但还不建任何 scratch 目录', async () => {
  assert.ok(scratchRoot.startsWith(home), `scratch 根不在一次性 HOME 里：${scratchRoot}`);
  assert.equal((await emit('session:new', { cwd: scratchRoot }))?.ok, true);
  assert.ok(existsSync(scratchRoot));
  assert.deepEqual(scratchDirs(), [], '不发消息就不留空目录');
  assert.equal(latestInstances()?.viewingCwd, scratchRoot, '空首页停在「无文件夹」上，而不是被归位到第一个文件夹');
});

test('首条消息：懒建一个 scratch 目录，会话开在里面，归「无文件夹」项目', async () => {
  const before = scratchDirs().length;
  const inst = await openNoFolderSession('first');
  assert.equal(dirname(inst.cwd), realpathSync(scratchRoot));
  assert.match(basename(inst.cwd), SCRATCH_DIR_RE);
  assert.equal(inst.projectKey, realpathSync(scratchRoot), '前端按它把这一行挂到「无文件夹」下');
  assert.equal(scratchDirs().length, before + 1);
  assert.ok(latestInstances()?.projects?.some(p => p.kind === 'scratch' && p.key === realpathSync(scratchRoot)),
    '有会话开在里面，抽屉里就该有「无文件夹」这一节——否则这一行只能被画进「不在已连接的文件夹里」');
  await emit('session:close', { instanceId: inst.instanceId });
});

// 「无文件夹」那一节的键是 scratch 根：它只是新会话页的启动键，不是可路由的目录。按 cwd 发的请求（@ 文件搜索、
// 权限规则、刷新配置）带着它来时应当安静地拒——那不是越界尝试，记成 scope_violation 会让服务面板满屏假告警。
// 会话自己的 scratch 目录照常可用（前端在那一节里改用它）。
test('按 cwd 的请求：scratch 根安静地拒（不记越界），会话自己的 scratch 目录照常可用', async () => {
  const inst = await openNoFolderSession('search');
  writeFileSync(join(inst.cwd, 'notes.md'), '# x\n');
  const inside = await emit('files:search', { cwd: inst.cwd, query: 'notes' });
  assert.equal(inside.ok, true, `会话自己的 scratch 目录里搜不了文件：${JSON.stringify(inside)}`);
  assert.ok(inside.paths.some(p => p.includes('notes.md')), JSON.stringify(inside.paths));
  assert.equal((await emit('permissions:rules', { cwd: inst.cwd }))?.cwd, inst.cwd, '会话自己的 scratch 目录读不到权限规则');

  assert.equal((await emit('files:search', { cwd: scratchRoot, query: 'notes' })).ok, false);
  // 「没有审计」要能看见才算数：随后发一条真越界的，等它落盘，再断言 scratch 根那条不在
  const elsewhere = join(root, 'not-connected');
  mkdirSync(elsewhere, { recursive: true });
  await emit('files:search', { cwd: elsewhere, query: 'x' });
  const auditPath = join(root, 'audit-records.json');
  const violations = () => {
    try {
      const audit = existsSync(auditPath) ? JSON.parse(readFileSync(auditPath, 'utf8')) : {};
      return (Array.isArray(audit) ? audit : (audit.records ?? [])).filter(r => r.action === 'scope_violation');
    } catch { return []; }
  };
  await waitFor(() => violations().some(r => r.target === elsewhere), '真越界那条落盘（正对照）');
  assert.deepEqual(violations().filter(r => r.target === scratchRoot || r.target === realpathSync(scratchRoot)), [],
    'scratch 根被记成了越界');
  await emit('session:close', { instanceId: inst.instanceId });
});

// 只读设置、不列文件的两条例外：新会话页的默认档和模型清单本来就是在 scratch 根上探的（session:new 的 scout），
// 权限规则与「刷新配置」带着「无文件夹」的键来，就该落到同一个目录上，而不是回一句「不在已连接的文件夹里」。
test('新会话页：权限规则与刷新配置认「无文件夹」的键（落到 scratch 根，与 session:new 同一个目标）', async () => {
  assert.equal((await emit('session:new', { cwd: scratchRoot }))?.ok, true);
  const rules = await emit('permissions:rules', { cwd: scratchRoot });
  assert.equal(rules?.ok, true, `权限规则被拒：${JSON.stringify(rules)}`);
  assert.equal(rules.cwd, realpathSync(scratchRoot));
  const refreshed = await emit('config:refresh', { cwd: scratchRoot });
  assert.equal(refreshed?.ok, true, `刷新配置被拒：${JSON.stringify(refreshed)}`);
});

// 【这条守的不是分配器的并发合并】真 server 上两条连发的首条消息实际被串行化了：第一条的懒开在第二条
// 到达前就已完成并占住查看 tab，第二条走查看回退投给同一个实例（注入「每条各建一个分配器」时它照样绿）。
// 分配器的在途共用只有 tests/unit/scratch-allocator.test.mjs 覆盖。它在这里守的是：租约释放之后，
// 下一个「无文件夹」会话建的是新目录，而不是继续复用上一个会话的（注入「租约不释放」会红）。
test('连发两条首条消息只建一个目录，且是一个新目录', async () => {
  assert.equal((await emit('session:new', { cwd: scratchRoot }))?.ok, true);
  const before = scratchDirs().length;
  await Promise.all(['x', 'y'].map(tag => emit('user:message', { text: `并发 ${tag}`, cwd: scratchRoot, clientMessageId: `nf-conc-${tag}-${randomUUID()}` })));
  assert.equal(scratchDirs().length, before + 1, '+0 = 复用了上一个会话的目录；+2 = 各开了一个会话');
  for (const i of latestInstances()?.instances ?? []) await emit('session:close', { instanceId: i.instanceId });
});

test('删会话：目录里还有别的会话就留着；删到最后一个，连目录一起删', async () => {
  const inst = await openNoFolderSession('delete');
  const dir = inst.cwd;
  const [first, second] = [randomUUID(), randomUUID()];
  writeTranscript(dir, first);
  writeTranscript(dir, second); // /clear 之后同一目录会有多条
  await emit('session:close', { instanceId: inst.instanceId });
  await waitFor(() => !latestInstances()?.instances?.some(i => i.cwd === dir), '实例关掉');

  const listed = await emit('session:list', { cwd: scratchRoot });
  assert.ok(listed.sessions.some(s => s.id === first && s.scratch === true && s.cwd === dir),
    `「无文件夹」项目列不出里面的会话：${JSON.stringify(listed.sessions)}`);

  // 离开「无文件夹」的新会话页：此后这一节还在不在，只取决于扫盘认不认得出里面的会话
  assert.equal((await emit('session:new', { cwd: home + '/code/a' }))?.ok, true);
  const r1 = await emit('session:deletePermanent', { sessionId: first, cwd: dir });
  assert.equal(r1.ok, true, JSON.stringify(r1));
  assert.equal(r1.scratchRemoved, false);
  assert.ok(existsSync(dir), '还有别的会话在用这个目录，删了就是把另一个会话的工作文件一起删了');
  await waitFor(() => latestInstances()?.projects?.some(p => p.kind === 'scratch'),
    '还有一条无文件夹会话：删一条之后的补扫要认得出它，这一节不能跟着消失');

  const r2 = await emit('session:deletePermanent', { sessionId: second, cwd: dir });
  assert.equal(r2.ok, true, JSON.stringify(r2));
  assert.equal(r2.scratchRemoved, true);
  assert.equal(existsSync(dir), false, '最后一个会话删了，一次性目录不该留在磁盘上');
  await waitFor(() => !latestInstances()?.projects?.some(p => p.kind === 'scratch'), '「无文件夹」一节随最后一个会话消失');
});
