// tests/unit/session-rename.test.mjs —— 网页端改名（#458）的标题清洗与活会话防回退
// 防回退：CLI 退出前会把内存里的旧标题当 custom-title 再写一遍（后写者胜），网页刚改的名字就被盖回去。
// 这里用真实临时 transcript + 可控的退出信号模拟「CLI 收尾回写旧名」，断言退出后文件里最后一条是用户的新名字。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sanitizeSessionTitle, createSessionRenamer, SESSION_TITLE_MAX } from '../../app/src/sessions/session-rename.js';
import { getProjectDir, readLastCustomTitle } from '../../app/src/sessions/history.js';

test('sanitizeSessionTitle: 换行与控制字符换成空格并 trim', () => {
  assert.equal(sanitizeSessionTitle('  修登录页\n第二行\r\t\u0000尾  '), '修登录页 第二行 尾');
  assert.equal(sanitizeSessionTitle('a\u2028b'), 'a b');
});

test('sanitizeSessionTitle: 空串、纯空白、纯控制字符、非字符串一律拒绝（null）', () => {
  for (const raw of ['', '   ', '\n\t\u0007', null, undefined, 42, {}]) {
    assert.equal(sanitizeSessionTitle(raw), null, JSON.stringify(raw));
  }
});

test('sanitizeSessionTitle: 超长截到上限，按字符而不是 UTF-16 单元截（不切坏 emoji）', () => {
  const long = '😀'.repeat(SESSION_TITLE_MAX + 5);
  const out = sanitizeSessionTitle(long);
  assert.equal([...out].length, SESSION_TITLE_MAX);
  assert.equal(out, '😀'.repeat(SESSION_TITLE_MAX));
});

function setup({ beforeRead } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'ccm-rename-'));
  const cwd = '/test/rename-project';
  const sessionId = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';
  const dir = join(base, getProjectDir(cwd));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${sessionId}.jsonl`);
  writeFileSync(file, [
    { type: 'user', message: { role: 'user', content: '首条' } },
    { type: 'custom-title', customTitle: '旧名字', sessionId },
  ].map(e => JSON.stringify(e)).join('\n') + '\n');
  const calls = [];
  // 与 SDK renameSession 同形：只往文件尾追加一条 custom-title
  const renameSession = async (id, title, opts) => {
    calls.push({ id, title, opts });
    appendFileSync(file, JSON.stringify({ type: 'custom-title', customTitle: title, sessionId: id }) + '\n');
  };
  const renamer = createSessionRenamer({
    renameSession,
    readLastCustomTitle: async (id, c) => { await beforeRead?.(); return readLastCustomTitle(id, c, { baseDir: base }); },
    log: { info() {}, warn() {} },
  });
  const lastCustomTitle = () => readFileSync(file, 'utf-8').trim().split('\n').map(l => JSON.parse(l))
    .filter(e => e.type === 'custom-title').at(-1)?.customTitle;
  // CLI 收尾：把它内存里的旧标题再写一遍，然后才算退出
  const cliExitRewritingOldTitle = () => appendFileSync(file, JSON.stringify({ type: 'custom-title', customTitle: '旧名字', sessionId }) + '\n');
  return { cwd, sessionId, calls, renamer, lastCustomTitle, cliExitRewritingOldTitle };
}

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

test('改名：调 renameSession 时带 { dir: cwd }，没有活实例就只写这一次', async () => {
  const { cwd, sessionId, calls, renamer, lastCustomTitle } = setup();
  const { afterExit } = await renamer.rename({ sessionId, cwd, title: '新名字', liveExits: [] });
  assert.equal(afterExit, undefined);
  assert.deepEqual(calls, [{ id: sessionId, title: '新名字', opts: { dir: cwd } }]);
  assert.equal(lastCustomTitle(), '新名字');
});

test('活会话：CLI 退出时回写了旧名 → 退出后补写，最后一条是用户的新名字', async () => {
  const { cwd, sessionId, calls, renamer, lastCustomTitle, cliExitRewritingOldTitle } = setup();
  const exit = deferred();
  const { afterExit } = await renamer.rename({ sessionId, cwd, title: '新名字', liveExits: [exit.promise] });
  assert.equal(lastCustomTitle(), '新名字', '改名当场就要落盘，抽屉立刻显示新名字');
  cliExitRewritingOldTitle();
  exit.resolve();
  await afterExit;
  assert.equal(lastCustomTitle(), '新名字');
  assert.equal(calls.length, 2);
});

test('活会话：CLI 退出时没回写 → 不重复追加', async () => {
  const { cwd, sessionId, calls, renamer, lastCustomTitle } = setup();
  const exit = deferred();
  const { afterExit } = await renamer.rename({ sessionId, cwd, title: '新名字', liveExits: [exit.promise] });
  exit.resolve();
  await afterExit;
  assert.equal(lastCustomTitle(), '新名字');
  assert.equal(calls.length, 1);
});

test('活会话里连改两次：退出后只补写最后一次的名字，不把前一次写回来', async () => {
  const { cwd, sessionId, calls, renamer, lastCustomTitle, cliExitRewritingOldTitle } = setup();
  const exit = deferred();
  const first = await renamer.rename({ sessionId, cwd, title: '第一次', liveExits: [exit.promise] });
  const second = await renamer.rename({ sessionId, cwd, title: '第二次', liveExits: [exit.promise] });
  cliExitRewritingOldTitle();
  exit.resolve();
  await Promise.all([first.afterExit, second.afterExit]);
  assert.equal(lastCustomTitle(), '第二次');
  assert.deepEqual(calls.map(c => c.title), ['第一次', '第二次', '第二次']);
});

test('活会话改名后实例退了、再在没有活实例时改一次：前一次的退出补写不得盖掉后一次', async () => {
  const { cwd, sessionId, calls, renamer, lastCustomTitle } = setup();
  const exit = deferred();
  const first = await renamer.rename({ sessionId, cwd, title: '第一次', liveExits: [exit.promise] });
  await renamer.rename({ sessionId, cwd, title: '第二次', liveExits: [] });
  exit.resolve();
  await first.afterExit;
  assert.equal(lastCustomTitle(), '第二次');
  assert.deepEqual(calls.map(c => c.title), ['第一次', '第二次']);
});

test('退出补写正卡在读尾窗时又改了名：最后落盘的是后一次，不把前一次写回来', async () => {
  const readStarted = deferred();
  const releaseRead = deferred();
  const { cwd, sessionId, calls, renamer, lastCustomTitle, cliExitRewritingOldTitle } = setup({
    beforeRead: async () => { readStarted.resolve(); await releaseRead.promise; },
  });
  const exit = deferred();
  const first = await renamer.rename({ sessionId, cwd, title: '第一次', liveExits: [exit.promise] });
  cliExitRewritingOldTitle();
  exit.resolve();
  await readStarted.promise; // 补写已经开始、正在读尾窗
  const second = renamer.rename({ sessionId, cwd, title: '第二次', liveExits: [] });
  releaseRead.resolve();
  await Promise.all([first.afterExit, second]);
  assert.equal(lastCustomTitle(), '第二次');
  assert.equal(calls.at(-1).title, '第二次');
});
