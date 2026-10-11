// tests/unit/history-fifo.test.mjs —— ~/.claude/projects 下的文件被换成 FIFO 时，history.js 的读盘不得卡住
//
// 那棵树模型写得动。把某个 *.jsonl（或子代理的 agent-*.jsonl / *.meta.json）换成 FIFO 之后，阻塞式 open 永远
// 不返回，占死一个 libuv 线程；默认线程池只有 4 个，几个就让列表、历史、项目发现的读盘整体停摆，没有自愈。
// 判据：每个入口照常返回，FIFO 按「读不出」处理——各入口原有的读失败结果（空历史、null、无标题、read_failed）。
//
// 子进程里跑：卡住的 open 会让测试进程自己退不出去。每个调用单独限时，卡住的记成 'HANG'，断言的 diff 直接
// 指出是哪个入口；线程池调大，免得前面卡住的调用把后面的饿死、看起来像是一起卡的。
// 「FIFO 那一行该不该出现在列表里」不在这里钉：读不出的普通文件今天也照列成无标题，FIFO 与它同口径。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getProjectDir } from '../../app/src/sessions/history.js';

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'ccm-hist-fifo-')));
test.after(() => rmSync(ROOT, { recursive: true, force: true })); // safe-rm: mkdtemp 一次性目录

const MOD = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '../../app/src/sessions/history.js')).href;
const CALL_TIMEOUT_MS = 3000;
const skip = process.platform === 'win32'; // 没有 mkfifo

let seq = 0;
// 一个 cwd + 它的 project 目录：一份正常会话、一份 FIFO。projectsRoot 缺省是隔离的 baseDir。
function fixture({ projectsRoot = join(ROOT, `p${seq}`), mineId = 'mine-1', fifoId = 'fifo-1' } = {}) {
  const cwd = join(ROOT, `cwd${seq++}`);
  mkdirSync(cwd, { recursive: true });
  const dir = join(projectsRoot, getProjectDir(cwd));
  mkdirSync(dir, { recursive: true });
  const at = '2026-10-10T00:00:00.000Z';
  writeFileSync(join(dir, `${mineId}.jsonl`), [
    { type: 'permission-mode', permissionMode: 'plan', sessionId: mineId },
    { type: 'user', uuid: 'u1', sessionId: mineId, cwd, timestamp: at, message: { role: 'user', content: 'hello' } },
    { type: 'assistant', uuid: 'a1', parentUuid: 'u1', sessionId: mineId, cwd, timestamp: at,
      message: { role: 'assistant', model: 'claude-x', content: [{ type: 'text', text: 'hi' }] } },
  ].map(e => JSON.stringify(e)).join('\n') + '\n');
  execFileSync('mkfifo', [join(dir, `${fifoId}.jsonl`)]);
  return { cwd, dir, baseDir: projectsRoot, mineId, fifoId };
}

// calls：一段 JS 源码，求值为 [名字, async () => 值] 的数组，模块在 m 里。env 里值为 undefined 的键从子进程环境删掉。
// 结果同步写出：有调用卡在 FIFO 上时 process.exit 也退不出去（退出要等线程池收工），只能 SIGKILL 自己，
// 异步的 stdout 会丢。父进程先比对结果（HANG 落在哪个入口一眼可见），再看退出状态。
function expectInChild(calls, expected, env = {}) {
  const script = `const m = await import(${JSON.stringify(MOD)});
    const out = {};
    for (const [name, fn] of ${calls}) {
      let timer;
      out[name] = await Promise.race([
        fn().then(v => v ?? null, e => 'THREW ' + (e && e.message)),
        new Promise(r => { timer = setTimeout(() => r('HANG'), ${CALL_TIMEOUT_MS}); }),
      ]);
      clearTimeout(timer);
    }
    (await import('node:fs')).writeSync(1, JSON.stringify(out));
    if (Object.values(out).includes('HANG')) process.kill(process.pid, 'SIGKILL');
    process.exit(0);`;
  const childEnv = { ...process.env, UV_THREADPOOL_SIZE: '64', ...env };
  for (const k of Object.keys(childEnv)) if (childEnv[k] === undefined) delete childEnv[k];
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 60_000, env: childEnv });
  let out = null;
  try { out = JSON.parse(r.stdout); } catch { /* 下一行报 */ }
  assert.ok(out, `子进程没给出结果（signal=${r.signal}）：${r.stderr}`);
  assert.deepEqual(out, expected, 'HANG = 这个入口打开 FIFO 时卡住了，在 server 里就是读盘线程被占死');
  assert.equal(r.status, 0, r.stderr);
}

const q = v => JSON.stringify(v);

test('列表、按 id 补行、标题：目录里有 FIFO 时照常返回，正常会话不受影响', { skip }, () => {
  const { cwd, baseDir, mineId, fifoId } = fixture();
  const o = `{ baseDir: ${q(baseDir)} }`;
  expectInChild(`[
    ['list', async () => (await m.listSessionsPage(${q(cwd)}, { baseDir: ${q(baseDir)}, limit: 10 }))
      .sessions.find(s => s.id === ${q(mineId)})?.title],
    ['search', async () => (await m.listSessionsPage(${q(cwd)}, { baseDir: ${q(baseDir)}, limit: 10, query: 'hel' }))
      .sessions.map(s => s.id)],
    ['byIds', async () => (await m.listSessionsByIds(${q(cwd)}, [${q(fifoId)}, ${q(mineId)}], ${o}))
      .find(s => s.id === ${q(mineId)})?.title],
    ['peekFifo', () => m.peekSessionListTitle(${q(cwd)}, ${q(fifoId)}, ${o})],
  ]`, { list: 'hello', search: [mineId], byIds: 'hello', peekFifo: '' });
});

test('历史与尾窗：FIFO 按读不出处理（空历史 / null / settled），正常会话照常读', { skip }, () => {
  const { cwd, baseDir, mineId, fifoId } = fixture();
  const o = `{ baseDir: ${q(baseDir)} }`;
  expectInChild(`[
    ['history', () => m.getSessionHistory(${q(fifoId)}, ${q(cwd)}, 50, ${o})],
    ['permMode', () => m.readLastPermissionMode(${q(fifoId)}, ${q(cwd)}, ${o})],
    ['model', () => m.readLastAssistantModel(${q(fifoId)}, ${q(cwd)}, ${o})],
    ['tail', () => m.readTranscriptTailEntries(${q(fifoId)}, ${q(cwd)}, ${o})],
    ['classify', async () => (await m.classifyTranscriptTail(${q(fifoId)}, ${q(cwd)}, ${o})).verdict],
    ['mineHistory', async () => (await m.getSessionHistory(${q(mineId)}, ${q(cwd)}, 50, ${o})).map(x => x.content)],
    ['minePermMode', () => m.readLastPermissionMode(${q(mineId)}, ${q(cwd)}, ${o})],
    ['mineModel', () => m.readLastAssistantModel(${q(mineId)}, ${q(cwd)}, ${o})],
  ]`, {
    history: [], permMode: null, model: null, tail: null, classify: 'settled',
    mineHistory: ['hello', 'hi'], minePermMode: 'plan', mineModel: 'claude-x',
  });
});

// 子代理目录同样在那棵树下：agent-a 的流水是 FIFO，agent-b 的 meta 是 FIFO。
test('子代理进度与按需流水：FIFO 的 meta / jsonl 不卡住，按读不出处理', { skip }, () => {
  const { cwd, dir, baseDir, mineId } = fixture();
  const sub = join(dir, mineId, 'subagents');
  mkdirSync(sub, { recursive: true });
  writeFileSync(join(sub, 'agent-a.meta.json'), JSON.stringify({ agentType: 'Explore', toolUseId: 'tu-a' }));
  execFileSync('mkfifo', [join(sub, 'agent-a.jsonl')]);
  execFileSync('mkfifo', [join(sub, 'agent-b.meta.json')]);
  writeFileSync(join(sub, 'agent-b.jsonl'), JSON.stringify({ type: 'assistant', isSidechain: true,
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Grep', input: {} }] } }) + '\n');
  const o = `{ baseDir: ${q(baseDir)} }`;
  expectInChild(`[
    ['scan', async () => (await m.scanSubagents(${q(mineId)}, ${q(cwd)}, ${o}))
      .map(e => [e.agentId, e.agentType, e.lastToolName]).sort()],
    ['flowFifoJsonl', async () => (await m.readSubagentFlow(${q(mineId)}, ${q(cwd)}, 'tu-a', ${o})).reason],
    ['flowFifoMeta', async () => (await m.readSubagentFlow(${q(mineId)}, ${q(cwd)}, 'tu-none', ${o})).reason],
  ]`, {
    scan: [['a', 'Explore', null], ['b', null, 'Grep']],
    flowFifoJsonl: 'read_failed',
    flowFifoMeta: 'not_found',
  });
});

// 生产路径：不传 baseDir，列表先走 SDK listSessions，再按 readdir 补齐 SDK 漏报的——FIFO 就在补齐的差集里。
// HOME 指到一次性目录：本模块与 SDK 的 projects 根都从它推出来（SDK 另认 CLAUDE_CONFIG_DIR，一并去掉）。
// SDK 自己读到 FIFO 不卡（0.3.281 实测），升级后若变了这条也会红。
test('生产路径（真 SDK）：列表补齐、历史、标题都不卡住', { skip }, () => {
  const home = join(ROOT, `home${seq}`);
  const { cwd, mineId, fifoId } = fixture({
    projectsRoot: join(home, '.claude', 'projects'),
    mineId: '11111111-1111-4111-8111-111111111111',
    fifoId: '22222222-2222-4222-8222-222222222222',
  });
  expectInChild(`[
    ['list', async () => (await m.listSessionsPage(${q(cwd)}, { limit: 10 })).sessions.some(s => s.id === ${q(mineId)})],
    ['history', () => m.getSessionHistory(${q(fifoId)}, ${q(cwd)})],
    ['peekFifo', () => m.peekSessionListTitle(${q(cwd)}, ${q(fifoId)})],
  ]`, { list: true, history: [], peekFifo: '' }, { HOME: home, CLAUDE_CONFIG_DIR: undefined });
});
