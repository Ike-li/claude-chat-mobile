// tests/invariants/server/session-outputs-scope.test.mjs —— 「产出」列表在真 server 上走到范围门
// 守护：SCOPE-01（任何用户可控路径经 realpath 后仍须落在授权工作区内——transcript 里的路径是模型写的，
//   范围外的、经 symlink 逃出去的都不得出现在列表里）
// 测什么：真 server + 种子 transcript：Write 新建和助手链接都收进来；范围外只回数量、不回路径；
//   symlink 逃逸不列出；越界 cwd 与不属于这个目录的会话一律拒绝；列列表不留 scope_violation 审计。
// 不测什么 + 为什么：① 判定规则细节（S1 的 tests/unit/session-outputs.test.mjs）② handler 分支（S1 的
//   tests/invariants/server-file-handlers.test.mjs）③ 界面（S3 的 tests/e2e/specs/session-outputs.spec.ts）
// 槽位：S2（真 app/server.js 子进程 + 一次性 CCM_DATA_DIR / 配置文件；transcript 种子写进容器里的一次性 HOME）
// 执行位守卫：必须是第一条 import（它一旦放行晚了，下面那些模块的顶层代码已经跑过了）。
import '../../setup/require-disposable-env.mjs';

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { io as ioClient } from 'socket.io-client';
import { spawnServer, killServer } from '../../integration/_spawn-server.mjs';
import { encodeProjectDir } from '../../../app/src/shared/project-dir.js';

const TOKEN = 'inv-session-outputs-token';
const SESSION_ID = randomUUID();

let root, repo, other, projectDir, auditFile, server, sock;

const at = minute => `2026-11-06T10:${String(minute).padStart(2, '0')}:00.000Z`;
const assistant = (text, minute) => ({
  type: 'assistant', uuid: randomUUID(), timestamp: at(minute), sessionId: SESSION_ID, cwd: repo,
  message: { role: 'assistant', content: [{ type: 'text', text }] },
});

test.before(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ccm-inv-outputs-')));
  repo = join(root, 'repo');
  other = join(root, 'other'); // 从来没连接过
  mkdirSync(join(repo, 'out'), { recursive: true });
  mkdirSync(other);
  writeFileSync(join(repo, 'out', 'cover.png'), 'png-bytes');
  writeFileSync(join(repo, 'notes.md'), 'notes');
  writeFileSync(join(other, 'secret.txt'), 'secret');
  symlinkSync(join(other, 'secret.txt'), join(repo, 'escape.txt'));

  projectDir = join(homedir(), '.claude', 'projects', encodeProjectDir(repo));
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, `${SESSION_ID}.jsonl`), `${[
    {
      type: 'user', uuid: randomUUID(), timestamp: at(1), sessionId: SESSION_ID, cwd: repo,
      toolUseResult: { type: 'create', filePath: join(repo, 'out', 'cover.png'), content: 'x' },
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
    },
    assistant('文档在 [notes](notes.md)', 2),
    assistant('已经删了 [旧稿](gone.md)，目录是 [out](out)，代码在 [a](src/a.js:12)', 3),
    assistant(`范围外 [s](${join(other, 'secret.txt')}) 和 [p](/tmp/probe-${SESSION_ID}.mjs)`, 4),
    assistant('[逃逸](escape.txt)', 5),
  ].map(entry => JSON.stringify(entry)).join('\n')}\n`);

  const configPath = join(root, 'ccm.config.json');
  writeFileSync(configPath, JSON.stringify({ WORKDIRS: [repo] }));
  auditFile = join(root, 'audit-records.json');
  server = await spawnServer({
    AUTH_TOKEN: TOKEN, CCM_CONFIG_FILE_PATH: configPath, CCM_DATA_DIR: join(root, 'data'), CCM_AUDIT_FILE: auditFile,
  });
  sock = ioClient(`http://127.0.0.1:${server.port}`, {
    auth: { token: TOKEN, deviceToken: 'inv-outputs-device' },
    transports: ['websocket'], reconnection: false, timeout: 4000,
    extraHeaders: { Host: 'localhost' },
  });
  await new Promise((resolve, reject) => {
    sock.once('connect', resolve);
    sock.once('connect_error', reject);
  });
});

test.after(async () => {
  try { sock?.close(); } catch { /* 已关闭 */ }
  if (server) await killServer(server.proc);
  if (root) rmSync(root, { recursive: true, force: true }); // safe-rm: mkdtemp 一次性目录
  if (projectDir) rmSync(projectDir, { recursive: true, force: true }); // safe-rm: 目录名由本文件一次性 cwd 编码而来
});

const outputs = payload => new Promise((resolve, reject) => {
  sock.timeout(5000).emit('session:outputs', payload, (err, response) => (err ? reject(err) : resolve(response)));
});

test('Write 新建与助手链接都收进来；已删除的留着标出来；目录和带行号的不算', async () => {
  const response = await outputs({ cwd: repo, sessionId: SESSION_ID });
  assert.equal(response.ok, true);
  assert.deepEqual(response.items.map(({ name, dir, state, media }) => ({ name, dir, state, media })), [
    { name: 'notes.md', dir: '', state: 'ok', media: null },
    { name: 'cover.png', dir: 'out', state: 'ok', media: 'image' },
    { name: 'gone.md', dir: '', state: 'missing', media: null },
  ]);
  assert.equal(response.items.find(i => i.name === 'cover.png').size, 'png-bytes'.length);
});

test('范围外只回数量：路径不进响应，经 symlink 逃出去的也不列出', async () => {
  const response = await outputs({ cwd: repo, sessionId: SESSION_ID });
  assert.equal(response.outsideCount, 2);
  const raw = JSON.stringify(response);
  assert.doesNotMatch(raw, /secret|probe|escape/);
});

test('越界 cwd 拒绝；会话不属于这个目录也拒绝', async () => {
  assert.equal((await outputs({ cwd: other, sessionId: SESSION_ID })).ok, false);
  assert.equal((await outputs({ cwd: repo, sessionId: randomUUID() })).ok, false);
});

test('列列表不留 scope_violation：路径是模型写的，不是用户的越界尝试', async () => {
  await outputs({ cwd: other, sessionId: SESSION_ID }); // 对照：用户请求越界 cwd，这个该留痕
  await outputs({ cwd: repo, sessionId: SESSION_ID });
  const violations = () => {
    if (!existsSync(auditFile)) return [];
    const audit = JSON.parse(readFileSync(auditFile, 'utf8'));
    return (Array.isArray(audit) ? audit : audit.records ?? []).filter(r => r.action === 'scope_violation');
  };
  const deadline = Date.now() + 8000; // 审计异步落盘
  while (!violations().length && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
  assert.ok(violations().length > 0, '对照没留痕：读不到审计，下面那条否定断言就在空转');
  assert.deepEqual(violations().filter(r => r.target !== other).map(r => r.target), [], '列表里的范围外路径不该留痕');
});
