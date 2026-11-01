// tests/invariants/server/request-cwd-scope.test.mjs —— 显式越界的 cwd 一律拒绝，不回落成别的目录
// 守护：SCOPE-05（显式传入的越界 cwd 一律拒绝并记审计，不得静默回落到别的目录）
// 测什么：真 server 上，带着一个不在已连接文件夹里的 cwd 发请求——列表、历史、取图、文件浏览、首条消息——
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
const IMG_UUID = randomUUID();
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/6X2Xb0AAAAASUVORK5CYII=';
const TOOL_ID = 'toolu_scope_bash';
const LONG_OUT = Array.from({ length: 400 }, (_, i) => `A 的构建日志第 ${i} 行`).join('\n'); // 超过 Bash 摘要上限 2000

let root, a, b, c, gone, configPath, auditFile, server, sock;
const projectDirs = [];
const events = [];

test.before(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ccm-inv-reqscope-')));
  a = join(root, 'a');      // 一直连接着
  b = join(root, 'b');      // 先连接，后被热移除（其上留一个在跑的实例）
  c = join(root, 'c');      // 从来没连接过
  gone = join(root, 'gone-parent', 'gone'); // 已连接，运行中连同父目录被删掉（2026-11-01）
  for (const d of [a, b, c, gone]) mkdirSync(d, { recursive: true });
  writeFileSync(join(a, 'a-only.txt'), 'a\n');
  // A 的一条会话：越界请求若回落到 A（此前的行为），就会把它交出去
  const dir = join(homedir(), '.claude', 'projects', encodeProjectDir(a));
  mkdirSync(dir, { recursive: true });
  projectDirs.push(dir);
  writeFileSync(join(dir, `${SID_A}.jsonl`), `${JSON.stringify({
    type: 'user', uuid: randomUUID(), parentUuid: null, timestamp: new Date().toISOString(),
    sessionId: SID_A, cwd: a, isMeta: false, message: { role: 'user', content: [{ type: 'text', text: 'A 里说的话' }] },
  })}\n${JSON.stringify({
    type: 'user', uuid: IMG_UUID, parentUuid: null, timestamp: new Date().toISOString(),
    sessionId: SID_A, cwd: a, isMeta: false,
    message: { role: 'user', content: [{ type: 'text', text: 'A 里贴的图' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }] },
  })}\n${JSON.stringify({
    type: 'assistant', uuid: randomUUID(), parentUuid: null, timestamp: new Date().toISOString(), sessionId: SID_A, cwd: a,
    message: { role: 'assistant', content: [{ type: 'tool_use', id: TOOL_ID, name: 'Bash', input: { command: 'cat build.log' } }] },
  })}\n${JSON.stringify({
    type: 'user', uuid: randomUUID(), parentUuid: null, timestamp: new Date().toISOString(), sessionId: SID_A, cwd: a, isMeta: false,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: TOOL_ID, content: LONG_OUT }] },
  })}\n`);

  configPath = join(root, 'ccm.config.json');
  writeFileSync(configPath, JSON.stringify({ WORKDIRS: [a, b, gone] }));
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
const scopeRows = (target) => {
  try {
    const audit = existsSync(auditFile) ? JSON.parse(readFileSync(auditFile, 'utf8')) : {};
    return (Array.isArray(audit) ? audit : (audit.records ?? [])).filter(r => r.action === 'scope_violation' && r.target === target);
  } catch { return []; }
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
  const rowsForC = () => scopeRows(c);
  // 60 秒内完全相同的两次（列表、历史都经 routeCwd）合并成一条记 repeat：按次数数，不按条数
  const timesForC = () => rowsForC().reduce((n, r) => n + (r.repeat ?? 1), 0);
  const times = await waitFor(() => (timesForC() >= 3 ? timesForC() : null), '三次越界都留下 scope_violation 审计')
    .catch(() => timesForC());
  assert.ok(times >= 3, `每次越界都要留痕，实际 ${times} 次`);
});

// 已连接的文件夹在 server 运行中被删掉（连同父目录）：配置只在启动 / 热加载时剔掉不存在的目录，在那之前
// 广播里一直有它，抽屉每 12 秒对它发一次 session:list。照样拒，但那是「已经不在了」，不是越界尝试——
// 记成 scope_violation 就是每小时 300 条，几小时把环形审计里真正的安全记录挤光（2026-10-17 生产实况）。
test('已连接的文件夹被删掉：照样拒绝，但不记越界审计', async () => {
  assert.deepEqual((await emit('session:list', { cwd: gone })).error, undefined, '前提：删掉之前它是已连接的文件夹');
  rmSync(join(root, 'gone-parent'), { recursive: true, force: true }); // safe-rm: mkdtemp 一次性目录下的子目录
  const list = await emit('session:list', { cwd: gone });
  assert.ok(list.error, `消失的目录不能被当作可列的目录，实际 ${JSON.stringify(list)}`);
  assert.deepEqual(list.sessions, []);
  // 哨兵：同一条 socket 上的请求按序处理，哨兵那条落盘了，前面那条要记早就记了。用一个没出现过的目标——
  // 拿 C 当哨兵会和上面那几次合并，条数不涨
  const sentinel = join(root, 'never-connected');
  await emit('session:list', { cwd: sentinel });
  await waitFor(() => scopeRows(sentinel).length > 0, '哨兵那条越界审计落盘');
  assert.deepEqual(scopeRows(gone), [], '已连接但已删掉的文件夹被记成了越界');
});

test('取图：越界 cwd 与「会话不属于这个目录」都拿不到图', async () => {
  const ref = `u:${IMG_UUID}:0`;
  // 正对照：历史里给出了这个引用，按 A 取得到——否则下面的「拒绝」可能只是这条通道本身不通
  const hist = await emit('session:history', { sessionId: SID_A, cwd: a });
  assert.ok(hist.messages.some(m => m.images?.some(i => i.ref === ref)), `前提：A 的历史给出图片引用，实际 ${JSON.stringify(hist.messages)}`);
  const ok = await emit('image:get', { cwd: a, sessionId: SID_A, ref });
  assert.equal(ok.ok, true, `前提：A 自己取得到，实际 ${JSON.stringify(ok)}`);
  assert.equal(ok.data, PNG);

  const out = await emit('image:get', { cwd: c, sessionId: SID_A, ref });
  assert.equal(out.ok, false, '拿越界 cwd 取到了 A 的图 = 回落把别的目录的数据交了出去');
  assert.equal(out.data, undefined);
  assert.match(out.error ?? '', /不在已连接的文件夹里/);

  // b 在范围内，但 SID_A 不是 b 的会话：会话归属要按 cwd 裁决，不能只看引用找得到
  const wrongDir = await emit('image:get', { cwd: b, sessionId: SID_A, ref });
  assert.equal(wrongDir.ok, false, `会话不属于这个目录也给了图：${JSON.stringify(wrongDir).slice(0, 200)}`);
  assert.equal(wrongDir.data, undefined);

  // 带一个不存在的实例 id 不能绕过上面两道
  const viaInstance = await emit('image:get', { instanceId: 'no-such-instance', cwd: c, sessionId: SID_A, ref });
  assert.equal(viaInstance.data, undefined);
});

// 历史工具卡的「展开全文」（验收 O55）：tool:full 带会话坐标时回落去 transcript 取全文，门与 image:get 同款。
test('tool:full 的历史路径：越界 cwd、会话不属于这个目录都拿不到全文；带不存在的实例 id 也绕不过去', async () => {
  // 正对照：历史里那张卡确实被截断了，按 A 取得到全文——否则下面的「拒绝」可能只是这条通道本身不通
  const hist = await emit('session:history', { sessionId: SID_A, cwd: a });
  const card = hist.messages.find(m => m.kind === 'tool_result' && m.toolUseId === TOOL_ID);
  assert.ok(card?.outputSummary.endsWith('…（已截断）'), `前提：历史摘要被截断，实际 ${JSON.stringify(card)}`);
  const ok = await emit('tool:full', { cwd: a, sessionId: SID_A, toolUseId: TOOL_ID });
  assert.deepEqual(ok, { ok: true, text: LONG_OUT });

  const out = await emit('tool:full', { cwd: c, sessionId: SID_A, toolUseId: TOOL_ID });
  assert.equal(out.ok, false, '拿越界 cwd 取到了 A 的全文 = 回落把别的目录的数据交了出去');
  assert.equal(out.text, undefined);
  assert.match(out.error ?? '', /不在已连接的文件夹里/);

  const wrongDir = await emit('tool:full', { cwd: b, sessionId: SID_A, toolUseId: TOOL_ID });
  assert.equal(wrongDir.ok, false, `会话不属于这个目录也给了全文：${JSON.stringify(wrongDir).slice(0, 200)}`);
  assert.equal(wrongDir.text, undefined);

  const viaInstance = await emit('tool:full', { instanceId: 'no-such-instance', cwd: c, sessionId: SID_A, toolUseId: TOOL_ID });
  assert.equal(viaInstance.text, undefined);
});

test('显式越界的首条消息：拒绝且不在别的工作区里懒开实例', async () => {
  const res = await emit('user:message', { text: '发到 C', cwd: c, clientMessageId: 'reqscope-c-1' });
  assert.equal(res.ok, false, `越界 cwd 的首条消息必须拒绝，实际 ${JSON.stringify(res)}`);
  assert.equal(res.permanent, true, '重发必然再被拒——离线队列要停止重试');
  const insts = latestInstances()?.instances ?? [];
  assert.equal(insts.length, 0, `不得在别的工作区懒开实例，实际 ${JSON.stringify(insts.map(i => i.cwd))}`);
});

// 验收 O128：离线队列里的首条带着入队时的 cwd，那个文件夹随后被断开。拒收的回执归前端——它把原文放回输入框、
// 在新会话页上说清楚；服务端再推一行提示，前端的提示条会先清掉整张新会话页，「已断开、改在这里开」跟着没了。
test('离线重放的首条撞上越界 cwd：照样永久拒收，但不推提示行（在线发送照推，作正对照）', async () => {
  const notices = from => events.slice(from).filter(e => e.type === 'system' || e.type === 'error').map(e => e.payload?.message);
  const seenOnline = events.length;
  const online = await emit('user:message', { text: '在线发到 C', cwd: c, clientMessageId: 'reqscope-c-online' });
  assert.equal(online.ok, false);
  await new Promise(r => setTimeout(r, 200));
  assert.equal(notices(seenOnline).length, 1, `正对照：在线发送被拒时服务端推一行提示，这里要看得见，实际 ${JSON.stringify(notices(seenOnline))}`);

  const seenReplay = events.length;
  const replay = await emit('user:message', { text: '离线时排在 C 的', cwd: c, clientMessageId: 'reqscope-c-outbox', fromOutbox: true });
  assert.equal(replay.ok, false, `越界 cwd 的离线重放必须拒绝，实际 ${JSON.stringify(replay)}`);
  assert.equal(replay.permanent, true, '离线队列要据此停止重试');
  await new Promise(r => setTimeout(r, 200));
  assert.deepEqual(notices(seenReplay), [], '离线重放被拒时服务端不该再推提示行：回执归前端（它会把原文放回输入框、留着新会话页）');
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

  // 不传 cwd：缺省落查看目录，而正看着的就是 B 上那个实例。缺省值不过开档的话，不传 cwd 就绕过了上面那条——
  // 直写照样写进去、刷新配置照样在 B 上起一个 scout（2026-10-11 review）。
  const viewing = latestInstances()?.instances?.find(i => i.instanceId === latestInstances()?.viewingInstanceId);
  assert.equal(viewing?.cwd, b, `前提：正看着 B 上的实例，实际 ${JSON.stringify(viewing)}`);
  const wroteDefault = await emit('files:write', { relPath: 'kept.txt', content: '不传 cwd 改的', baseHash: read.contentHash });
  assert.equal(wroteDefault.ok, false, `不传 cwd 就写进了热移除的目录：${JSON.stringify(wroteDefault)}`);
  assert.equal(readFileSync(join(b, 'kept.txt'), 'utf8'), '移除之前的内容');
  const refreshed = await emit('config:refresh', {});
  assert.equal(refreshed?.ok, false, `不传 cwd 就在热移除的目录上起了 scout：${JSON.stringify(refreshed)}`);
  // 读档照旧：缺省落到 B 也能读（已开会话自己的目录仍可查看）
  assert.equal((await emit('browse:list', { relPath: '.' }))?.ok, true, '读档的缺省目录被一起收紧了');

  const created = await emit('session:new', { cwd: b });
  assert.equal(created.ok, false, '热移除的目录上不得新开（仅拒新开）');

  const list = await emit('session:list', { cwd: b });
  assert.match(list.error ?? '', /不在已连接的文件夹里/, '列表是开档：只认当前授权');
});
