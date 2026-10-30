// 守护：SESSION-03（侧栏打开、资源读取和续接使用同一会话位置）· SCOPE-01（迁移不越界）
// 测什么：真 Socket/server、真 Git worktree、真实搬文件，无 SDK cwd 事件。
// 不测什么 + 为什么：Desktop 真进程和模型输出需手工联动；这里仅假 CLI 回合。
// 槽位：S2（容器的一次性 HOME / 数据目录）。
import '../../setup/require-disposable-env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, renameSync, rmSync, realpathSync, appendFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { io } from 'socket.io-client';
import { spawnServer, killServer } from '../../integration/_spawn-server.mjs';
import { encodeProjectDir } from '../../../app/src/shared/project-dir.js';
import { bucketFor } from '../../../app/src/files/uploads.js';
import { writeCliStatusSnapshot } from '../../../app/src/ops/cli-statusline-bridge.js';
import { presentOnlineSendAck } from '../../../app/public/js/logic/outbox-send.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'ccm-recovery-s2-')));
const statusDir = join(root, 'statusline');
const repo = join(root, 'repo'), old = join(repo, '.claude/worktrees/old'), next = join(repo, '.claude/worktrees/next');
const sid = randomUUID(), terminalSid = randomUUID(), token = 'session-recovery-test';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/6X2Xb0AAAAASUVORK5CYII=';
const projectDirs = [];
let server, sock, initial, latest;
let serverEnv;
const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
const txFile = cwd => {
  const dir = join(homedir(), '.claude/projects', encodeProjectDir(cwd));
  mkdirSync(dir, { recursive: true }); projectDirs.push(dir);
  return join(dir, `${sid}.jsonl`);
};
const messages = cwd => [
  { type: 'user', uuid: 'u-473', parentUuid: null, sessionId: sid, cwd, entrypoint: 'claude-desktop', timestamp: new Date().toISOString(), message: { role: 'user', content: 'DESKTOP_TARGET_HISTORY' } },
  { type: 'assistant', uuid: 'a-473', parentUuid: 'u-473', sessionId: sid, cwd, entrypoint: 'claude-desktop', timestamp: new Date().toISOString(), message: { role: 'assistant', model: 'external-model-473', content: [{ type: 'text', text: 'EXTERNAL_ANSWER' }] } },
  { type: 'assistant', uuid: 'tool-use-473', parentUuid: 'a-473', sessionId: sid, cwd, entrypoint: 'claude-desktop', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-473', name: 'Read', input: {} }] } },
  { type: 'user', uuid: 'tool-result-473', parentUuid: 'tool-use-473', sessionId: sid, cwd, entrypoint: 'claude-desktop', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-473', content: [{ type: 'text', text: 'MOVED_TOOL_FULL' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }] }] } },
  { type: 'permission-mode', permissionMode: 'plan', cwd },
];
const emit = async (name, payload) => {
  try { return await sock.timeout(12000).emitWithAck(name, payload); }
  catch (err) { throw new Error(`${name}: ${err.message}`, { cause: err }); }
};
test.before(async () => {
  mkdirSync(repo); git('init', '-b', 'main'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'test');
  writeFileSync(join(repo, 'target.txt'), 'MAIN_CODE'); git('add', 'target.txt'); git('commit', '-m', 'fixture');
  git('worktree', 'add', '-b', 'old-branch', old); git('worktree', 'add', '-b', 'next-branch', next);
  writeFileSync(join(old, 'target.txt'), 'OLD_CODE'); writeFileSync(join(next, 'target.txt'), 'NEXT_CODE');
  initial = txFile(old); latest = txFile(next);
  writeFileSync(initial, messages(old).map(e => JSON.stringify(e)).join('\n') + '\n');
  const config = join(root, 'config.json'); writeFileSync(config, JSON.stringify({ WORKDIRS: [repo] }));
  const sessionsFile = join(root, 'sessions.json'); writeFileSync(sessionsFile, JSON.stringify({ currentByCwd: {}, sessions: [{ id: sid, cwd: old, model: 'stale-web-model', permissionMode: 'acceptEdits', effort: 'low' },
    { id: terminalSid, cwd: repo, model: 'web-model-473', permissionMode: 'acceptEdits', effort: 'low', effortSource: 'user' }] }));
  serverEnv = { AUTH_TOKEN: token, CCM_CONFIG_FILE_PATH: config, CCM_DATA_DIR: join(root, 'data'), CCM_SESSIONS_FILE: sessionsFile,
    CCM_FAKE_CLAUDE_MODE: 'turn', CCM_FAKE_CLAUDE_SESSION_ID: sid, CLI_STATUSLINE_DIR: statusDir };
  server = await spawnServer(serverEnv);
  sock = io(`http://127.0.0.1:${server.port}`, { auth: { token, deviceToken: 'recovery-device' }, transports: ['websocket'], reconnection: false, extraHeaders: { Host: 'localhost' } });
  sock.on('agent:event', e => { if (e.type === 'instances') latestPayload = e.payload; });
  await new Promise((resolve, reject) => { sock.once('connect', resolve); sock.once('connect_error', reject); });
});
let latestPayload;
test.after(async () => {
  sock?.disconnect(); if (server) await killServer(server.proc);
  for (const dir of projectDirs) rmSync(dir, { recursive: true, force: true }); // safe-rm: project cwd 基于本文件 mkdtemp
  rmSync(root, { recursive: true, force: true }); // safe-rm: mkdtemp 一次性目录
});

test('打开后外部迁移，旧 cwd 的历史及再次点击都恢复到同一 ID 和 worktree', async () => {
  const opened = await emit('session:switch', { sessionId: sid, cwd: old });
  assert.equal(opened.ok, true); assert.equal(opened.sessionId, sid);
  renameSync(initial, latest);
  appendFileSync(latest, messages(next).map(e => JSON.stringify(e)).join('\n') + '\n');
  const history = await emit('session:history', { sessionId: sid, cwd: old });
  assert.equal(history.error, undefined);
  assert.ok(history.messages.some(m => m.content?.includes('DESKTOP_TARGET_HISTORY')));
  const clicked = await emit('session:switch', { sessionId: sid, cwd: old });
  assert.equal(clicked.ok, true); assert.equal(clicked.instanceId, opened.instanceId); assert.equal(clicked.sessionId, sid);
  const instance = latestPayload?.instances.find(a => a.instanceId === opened.instanceId);
  assert.equal(instance?.cwd, old, '读取恢复不得冒充活 SDK 已换目录');
  assert.equal(instance?.transcriptCwd, next); assert.equal(instance?.panelCwd, next);
  assert.equal(instance?.externalObserved?.model, 'external-model-473');
  assert.equal(instance?.externalObserved?.permissionMode, 'plan');
  assert.equal(instance?.externalObserved?.effort, null, '外部档位未知不能补成网页保存的 low');
  const full = await emit('tool:full', { sessionId: sid, cwd: old, instanceId: opened.instanceId, toolUseId: 'tool-473' });
  assert.equal(full.ok, true); assert.match(full.text, /MOVED_TOOL_FULL/);
  const image = await emit('image:get', { sessionId: sid, cwd: old, instanceId: opened.instanceId, ref: 't:tool-473:0' });
  assert.equal(image.ok, true); assert.equal(image.data, PNG);
  const file = await emit('browse:read', { cwd: instance.panelCwd, relPath: 'target.txt' });
  assert.equal(file.ok, true); assert.equal(file.content, 'NEXT_CODE');
  const status = await emit('git:status', { cwd: instance.panelCwd });
  assert.equal(status.ok, true);
  assert.equal(status.branch, 'next-branch');
  assert.equal(execFileSync('git', ['branch', '--show-current'], { cwd: instance.panelCwd, encoding: 'utf8' }).trim(), 'next-branch');
  assert.equal(readFileSync(join(repo, 'target.txt'), 'utf8'), 'MAIN_CODE');
});

test('位置已变时拒绝调权限档，并单发快照让选择器拨回外部记录', async () => {
  const seen = [];
  const onEvent = e => seen.push(e);
  sock.on('agent:event', onEvent);
  sock.emit('user:setPermissionMode', { mode: 'default' });
  for (const deadline = Date.now() + 3000; !seen.some(e => e.type === 'instances') && Date.now() < deadline;) {
    await new Promise(r => setTimeout(r, 50));
  }
  sock.off('agent:event', onEvent);
  assert.ok(seen.some(e => e.type === 'system' && /会话位置已变化/.test(e.payload?.message)));
  const echo = seen.find(e => e.type === 'instances')?.payload.instances.find(a => a.sessionId === sid);
  assert.ok(echo, '拒绝后要回推快照，否则选择器停在用户刚点的档');
  assert.equal(echo.externalObserved?.permissionMode, 'plan');
  assert.equal(echo.permissionMode, 'acceptEdits');
  assert.ok(!seen.some(e => e.type === 'permission_mode'), '回推网页档会盖掉外部面板');
});

test('首条发送先在新目录置换 SDK，保留 ID，附件归新目录桶', async () => {
  writeCliStatusSnapshot({ schemaVersion: 1, source: 'claude-cli', sessionId: sid, cwd: next, capturedAt: Date.now(), refreshIntervalSec: 60, effort: 'max' }, { dir: statusDir });
  let previous;
  for (const deadline = Date.now() + 10000; !(previous = latestPayload.instances.find(a => a.sessionId === sid && a.externalObserved?.effort === 'max')) && Date.now() < deadline;) {
    await new Promise(r => setTimeout(r, 100));
  }
  assert.ok(previous, '外部 CLI 的 effort 进了展示');
  assert.notEqual(previous.effort, 'max');
  const sent = await emit('user:message', { instanceId: previous.instanceId, sessionId: sid, cwd: old,
    text: 'continue-after-relocation', clientMessageId: 'relocation-send-473',
    attachments: [{ name: 'proof.txt', mimeType: 'text/plain', data: Buffer.from('ATTACHMENT_NEW_CWD').toString('base64') }] });
  assert.equal(sent.ok, true);
  const resumed = latestPayload.instances.find(a => a.sessionId === sid);
  assert.notEqual(resumed.instanceId, previous.instanceId);
  assert.equal(resumed.cwd, next); assert.equal(resumed.sessionId, sid);
  assert.equal(resumed.effort, previous.effort, '外部 effort 只做展示，置换沿用网页自己的档');
  assert.equal(resumed.effortSource, previous.effortSource);
  const uploadDir = join(root, 'data/uploads', bucketFor(next));
  assert.ok(readdirSync(uploadDir).some(name => readFileSync(join(uploadDir, name), 'utf8') === 'ATTACHMENT_NEW_CWD'));
  assert.equal(existsSync(join(root, 'data/uploads', bucketFor(old))), false);
});

test('服务器重启后，旧目录入口仍恢复同一会话及新目录', async () => {
  sock.disconnect(); await killServer(server.proc);
  server = await spawnServer(serverEnv);
  sock = io(`http://127.0.0.1:${server.port}`, { auth: { token, deviceToken: 'recovery-device' }, transports: ['websocket'], reconnection: false, extraHeaders: { Host: 'localhost' } });
  sock.on('agent:event', e => { if (e.type === 'instances') latestPayload = e.payload; });
  await new Promise((resolve, reject) => { sock.once('connect', resolve); sock.once('connect_error', reject); });
  const reopened = await emit('session:switch', { sessionId: sid, cwd: old });
  assert.equal(reopened.ok, true); assert.equal(reopened.sessionId, sid);
  const resumed = latestPayload.instances.find(a => a.sessionId === sid);
  assert.equal(resumed.cwd, next);
  assert.equal(resumed.externalObserved, null, '冷续接走普通续接的档位优先级，不采信外部记录');
});

test('自动恢复遇到多份有效记录时拒绝创建实例，明确位置仍能读取', async () => {
  const ambiguousId = randomUUID();
  for (const cwd of [repo, next]) {
    const dir = join(homedir(), '.claude/projects', encodeProjectDir(cwd));
    mkdirSync(dir, { recursive: true }); projectDirs.push(dir);
    writeFileSync(join(dir, `${ambiguousId}.jsonl`), JSON.stringify({ type: 'user', cwd, message: { role: 'user', content: 'MULTIPLE_COPIES' } }) + '\n');
  }
  const opened = await emit('session:switch', { sessionId: ambiguousId, cwd: old });
  assert.equal(opened.ok, false); assert.match(opened.error, /多份记录/);
  assert.ok(!latestPayload.instances.some(a => a.sessionId === ambiguousId));
  const selected = await emit('session:history', { sessionId: ambiguousId, cwd: next });
  assert.equal(selected.error, undefined);
  assert.ok(selected.messages.some(m => m.content === 'MULTIPLE_COPIES'));
});

test('非法和越界请求不能借迁移兜底读历史', async () => {
  for (const payload of [{ sessionId: '../escape', cwd: old }, { sessionId: sid, cwd: '/outside-connected' }]) {
    assert.ok((await emit('session:history', payload)).error);
  }
});

test('续接终端写过、没搬家的会话：沿用网页存的模型与权限，外部记录不当运行档', async () => {
  const dir = join(homedir(), '.claude/projects', encodeProjectDir(repo));
  mkdirSync(dir, { recursive: true }); projectDirs.push(dir);
  writeFileSync(join(dir, `${terminalSid}.jsonl`), [
    { type: 'user', uuid: 'u-cli', parentUuid: null, sessionId: terminalSid, cwd: repo, entrypoint: 'cli', message: { role: 'user', content: 'TERMINAL_TURN' } },
    { type: 'assistant', uuid: 'a-cli', parentUuid: 'u-cli', sessionId: terminalSid, cwd: repo, entrypoint: 'cli', message: { role: 'assistant', model: 'terminal-model-473', content: [{ type: 'text', text: 'ok' }] } },
    { type: 'permission-mode', permissionMode: 'plan', cwd: repo },
  ].map(e => JSON.stringify(e)).join('\n') + '\n');
  const opened = await emit('session:switch', { sessionId: terminalSid, cwd: repo });
  assert.equal(opened.ok, true);
  let inst = latestPayload.instances.find(a => a.sessionId === terminalSid);
  assert.equal(inst.model, 'web-model-473', '会话末条模型只做展示回落，不能变成 --model');
  assert.equal(inst.permissionMode, 'acceptEdits', '续接权限档：saved > transcript');
  assert.equal(inst.externalObserved, null);
  assert.equal((await emit('session:switch', { sessionId: terminalSid, cwd: repo })).ok, true);
  inst = latestPayload.instances.find(a => a.sessionId === terminalSid);
  assert.equal(inst.externalObserved, null, '聚焦已开实例也不把外部记录当运行档');
});

test('打开中的会话被后点的会话取代：前一个回执不算失败，视图留在后点的那个', async () => {
  const coldSid = randomUUID();
  const dir = join(homedir(), '.claude/projects', encodeProjectDir(repo));
  writeFileSync(join(dir, `${coldSid}.jsonl`), JSON.stringify({ type: 'user', uuid: 'u-cold', parentUuid: null, sessionId: coldSid, cwd: repo, message: { role: 'user', content: 'COLD' } }) + '\n');
  const first = emit('session:switch', { sessionId: coldSid, cwd: repo }); // 冷续接要 spawn，期间第二次点击先完成
  const second = await emit('session:switch', { sessionId: terminalSid, cwd: repo });
  assert.equal(second.ok, true);
  const superseded = await first;
  assert.equal(superseded.ok, true, '前端对 ok:false 一律弹「打不开」，用户已经去了别的会话');
  assert.equal(superseded.superseded, true);
  assert.equal(latestPayload.viewingInstanceId, second.instanceId);
});

test('发送前找不到会话记录：回执是永久失败，前端回填草稿而不是进 outbox 反复重发', async () => {
  const inst = latestPayload.instances.find(a => a.sessionId === terminalSid);
  rmSync(join(homedir(), '.claude/projects', encodeProjectDir(repo), `${terminalSid}.jsonl`));
  const sent = await emit('user:message', { instanceId: inst.instanceId, sessionId: terminalSid, cwd: repo, text: 'after-record-gone', clientMessageId: 'record-gone-473' });
  assert.equal(sent.ok, false); assert.match(sent.error, /会话不存在/);
  const shown = presentOnlineSendAck(sent);
  assert.equal(shown.requeue, false, '换个时间重发结果一样');
  assert.equal(shown.restoreDraft, true);
});
