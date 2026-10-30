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

const root = realpathSync(mkdtempSync(join(tmpdir(), 'ccm-recovery-s2-')));
const repo = join(root, 'repo'), old = join(repo, '.claude/worktrees/old'), next = join(repo, '.claude/worktrees/next');
const sid = randomUUID(), token = 'session-recovery-test';
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
  const sessionsFile = join(root, 'sessions.json'); writeFileSync(sessionsFile, JSON.stringify({ currentByCwd: {}, sessions: [{ id: sid, cwd: old, model: 'stale-web-model', permissionMode: 'acceptEdits', effort: 'low' }] }));
  serverEnv = { AUTH_TOKEN: token, CCM_CONFIG_FILE_PATH: config, CCM_DATA_DIR: join(root, 'data'), CCM_SESSIONS_FILE: sessionsFile,
    CCM_FAKE_CLAUDE_MODE: 'turn', CCM_FAKE_CLAUDE_SESSION_ID: sid };
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

test('首条发送先在新目录置换 SDK，保留 ID，附件归新目录桶', async () => {
  const previous = latestPayload.instances.find(a => a.sessionId === sid);
  const sent = await emit('user:message', { instanceId: previous.instanceId, sessionId: sid, cwd: old,
    text: 'continue-after-relocation', clientMessageId: 'relocation-send-473',
    attachments: [{ name: 'proof.txt', mimeType: 'text/plain', data: Buffer.from('ATTACHMENT_NEW_CWD').toString('base64') }] });
  assert.equal(sent.ok, true);
  const resumed = latestPayload.instances.find(a => a.sessionId === sid);
  assert.notEqual(resumed.instanceId, previous.instanceId);
  assert.equal(resumed.cwd, next); assert.equal(resumed.sessionId, sid);
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
  assert.equal(resumed.externalObserved.model, 'external-model-473');
  assert.equal(resumed.permissionMode, 'plan', '冷续接不能用旧网页权限覆盖外部最新记录');
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
