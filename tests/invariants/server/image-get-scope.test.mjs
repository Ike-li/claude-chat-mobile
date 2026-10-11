// tests/invariants/server/image-get-scope.test.mjs —— 取图（image:get）的实例内存一路也要先过范围门
// 守护：SCOPE-05（显式传入的越界 cwd 一律拒绝并记审计，不得静默回落到别的目录）
// 测什么：真 server + 会吐截图的假 CLI。live 截图只在实例内存里（假 CLI 不落 transcript），带着这个
//   有效实例去取：越界 cwd 必须拒绝并留 scope_violation 审计；范围内但会话不属于这个目录也拒；
//   热移除之后，在跑会话自己的目录仍取得到（read 档放行实例自己的 cwd）。
// 不测什么 + 为什么：① 读 transcript 那一路的越界（request-cwd-scope.test.mjs 的「取图」用例）
//   ② 引用解析、白名单、上限（S1 的 transcript-image / transcript-image-read）③ 前端显示（S3）
// 槽位：S2（真 app/server.js 子进程 + CCM_FAKE_CLAUDE_MODE=turn-screenshot + 一次性 CCM_DATA_DIR / 配置文件；
//   transcript 种子写进容器里的一次性 HOME）
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

const TOKEN = 'inv-image-get-scope-token';
const SESSION_ID = randomUUID();
const REF = 't:toolu_fake_screenshot:0'; // 假 CLI turn-screenshot 档固定的 tool_use id
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/6X2Xb0AAAAASUVORK5CYII=';

let root, a, b, c, configPath, auditFile, transcript, server, sock, instanceId;
const projectDirs = [];
const events = [];

test.before(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ccm-inv-imgscope-')));
  a = join(root, 'a');      // 一直连接着，但会话不在这里
  b = join(root, 'b');      // 会话与在跑实例都在这里；后半段被热移除
  c = join(root, 'c');      // 从来没连接过
  for (const d of [a, b, c]) mkdirSync(d);
  // 会话归属按 transcript 文件裁决（同 session:history）。假 CLI 不落盘，这里先放一条种子，
  // 内容里没有那张截图——于是取得到就只可能来自实例内存。
  const dir = join(homedir(), '.claude', 'projects', encodeProjectDir(b));
  mkdirSync(dir, { recursive: true });
  projectDirs.push(dir);
  transcript = join(dir, `${SESSION_ID}.jsonl`);
  writeFileSync(transcript, `${JSON.stringify({
    type: 'user', uuid: randomUUID(), parentUuid: null, timestamp: new Date().toISOString(),
    sessionId: SESSION_ID, cwd: b, isMeta: false, message: { role: 'user', content: [{ type: 'text', text: '种子' }] },
  })}\n`);

  configPath = join(root, 'ccm.config.json');
  writeFileSync(configPath, JSON.stringify({ WORKDIRS: [a, b] }));
  auditFile = join(root, 'audit-records.json');
  server = await spawnServer({
    AUTH_TOKEN: TOKEN, CCM_CONFIG_FILE_PATH: configPath, CCM_DATA_DIR: join(root, 'data'), CCM_AUDIT_FILE: auditFile,
    CCM_FAKE_CLAUDE_MODE: 'turn-screenshot', CCM_FAKE_CLAUDE_SESSION_ID: SESSION_ID,
  });
  sock = ioClient(`http://127.0.0.1:${server.port}`, {
    auth: { token: TOKEN, deviceToken: 'inv-imgscope-device' },
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
const scopeAuditRows = target => {
  try {
    const audit = existsSync(auditFile) ? JSON.parse(readFileSync(auditFile, 'utf8')) : {};
    return (Array.isArray(audit) ? audit : (audit.records ?? [])).filter(r => r.action === 'scope_violation' && r.target === target);
  } catch { return []; }
};

test('带着有效的在跑实例：越界 cwd 照样拒绝并记审计，范围内但会话不属于这个目录也拒', async () => {
  const first = await emit('user:message', { text: '截个图', cwd: b, clientMessageId: 'imgscope-1' });
  assert.equal(first.ok, true, `前提：b 上能开实例，实际 ${JSON.stringify(first)}`);
  instanceId = first.instanceId;
  const tr = await waitFor(() => events.find(e => e.type === 'tool_result' && e.payload?.images?.length), 'live 截图的 tool_result');
  assert.deepEqual(tr.payload.images.map(i => i.ref), [REF]);

  // 正对照：自己的目录里取得到，而且只可能来自实例内存——否则下面的「拒绝」可能只是这条路本身不通
  const ok = await emit('image:get', { instanceId, cwd: b, sessionId: SESSION_ID, ref: REF });
  assert.equal(ok.ok, true, `前提：在跑实例自己的目录里取得到，实际 ${JSON.stringify(ok)}`);
  assert.equal(ok.data, PNG);
  assert.ok(!readFileSync(transcript, 'utf8').includes('toolu_fake_screenshot'), '前提：transcript 里没有这张图');

  const out = await emit('image:get', { instanceId, cwd: c, sessionId: SESSION_ID, ref: REF });
  assert.equal(out.ok, false, '带了有效实例就跳过范围门 = 越界 cwd 也能把图取走');
  assert.equal(out.data, undefined);
  assert.match(out.error ?? '', /不在已连接的文件夹里/);
  const rows = await waitFor(() => (scopeAuditRows(c).length ? scopeAuditRows(c) : null), '越界取图留一条 scope_violation 审计')
    .catch(() => scopeAuditRows(c));
  assert.ok(rows.length >= 1, '越界取图没有留痕');

  const wrongDir = await emit('image:get', { instanceId, cwd: a, sessionId: SESSION_ID, ref: REF });
  assert.equal(wrongDir.ok, false, `会话不属于 a 也给了图：${JSON.stringify(wrongDir).slice(0, 200)}`);
  assert.equal(wrongDir.data, undefined);
});

test('热移除之后：在跑会话自己的目录仍取得到（read 档放行实例自己的 cwd），越界照旧拒', async () => {
  assert.ok(instanceId, '前提：上一条用例开出了实例');
  writeFileSync(configPath, JSON.stringify({ WORKDIRS: [a] }));
  await waitFor(() => JSON.stringify(latestInstances()?.dirs) === JSON.stringify([a]), '热加载后 dirs 只剩 a');

  const kept = await emit('image:get', { instanceId, cwd: b, sessionId: SESSION_ID, ref: REF });
  assert.equal(kept.ok, true, `热移除后在跑会话自己的截图取不到了：${JSON.stringify(kept)}`);
  assert.equal(kept.data, PNG);

  const out = await emit('image:get', { instanceId, cwd: c, sessionId: SESSION_ID, ref: REF });
  assert.equal(out.ok, false);
  assert.equal(out.data, undefined);
});
