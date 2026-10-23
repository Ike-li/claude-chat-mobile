// tests/unit/pinned-roots.test.mjs —— 抽屉文件夹「置顶」的存储（#305）：有序的根路径数组，最后置顶的在最前。
// 落盘走真文件（一次性目录），不 mock：「置顶 → flush → 同一个文件新建 store → 还在」才算持久化成立。
// 它只是展示偏好：读坏了当作没有、打一行警告，不能挡启动。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPinnedRootsStore } from '../../app/src/sessions/pinned-roots.js';

const DIR = mkdtempSync(join(tmpdir(), 'ccm-pinned-'));
test.after(() => rmSync(DIR, { recursive: true, force: true })); // safe-rm: mkdtemp 一次性目录
let n = 0;
const freshFile = () => join(DIR, `pinned-${++n}.json`);
const quiet = () => { const lines = []; return { lines, warn: m => lines.push(String(m)), error: m => lines.push(String(m)) }; };

test('置顶移到最前；重复置顶是幂等的「再移到最前」；取消置顶从数组里删掉', () => {
  const store = createPinnedRootsStore({ file: freshFile(), log: quiet() });
  store.set('/r/B', true);
  store.set('/r/C', true);
  assert.deepEqual(store.list(), ['/r/C', '/r/B']);
  store.set('/r/B', true);
  assert.deepEqual(store.list(), ['/r/B', '/r/C']);
  store.set('/r/B', true);
  assert.deepEqual(store.list(), ['/r/B', '/r/C'], '重复置顶不得出现两份');
  store.set('/r/C', false);
  assert.deepEqual(store.list(), ['/r/B']);
});

test('真实持久化：置顶 → flush → 用同一个文件新建 store，置顶仍在且顺序不变', () => {
  const file = freshFile();
  const a = createPinnedRootsStore({ file, log: quiet() });
  a.set('/r/A', true);
  a.set('/r/C', true);
  a.flushSaveSync();
  assert.ok(existsSync(file));
  assert.deepEqual(createPinnedRootsStore({ file, log: quiet() }).list(), ['/r/C', '/r/A']);
});

test('从没置顶过：退出时的 flush 不凭空建文件', () => {
  const file = freshFile();
  createPinnedRootsStore({ file, log: quiet() }).flushSaveSync();
  assert.equal(existsSync(file), false);
});

test('防抖写盘：不 flush 也会在防抖窗之后落盘', async () => {
  const file = freshFile();
  const store = createPinnedRootsStore({ file, log: quiet(), debounceMs: 10 });
  store.set('/r/A', true);
  await new Promise(r => setTimeout(r, 120));
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), ['/r/A']);
});

test('读坏档：文件缺失、JSON 损坏、结构非法都当作没有置顶；损坏与结构非法各打一行警告', () => {
  const missing = quiet();
  assert.deepEqual(createPinnedRootsStore({ file: freshFile(), log: missing }).list(), []);
  assert.deepEqual(missing.lines, [], '文件不存在是新装的常态，不该警告');

  for (const content of ['{not json', '{"roots":["/r/A"]}', '["/r/A", 42]']) {
    const file = freshFile();
    writeFileSync(file, content);
    const log = quiet();
    assert.deepEqual(createPinnedRootsStore({ file, log }).list(), [], content);
    assert.equal(log.lines.length, 1, `${content} 应打一行警告`);
    assert.match(log.lines[0], /pinned-roots/);
  }
});

test('写盘失败：打日志，内存里的顺序照常生效', async () => {
  const blocker = freshFile();
  writeFileSync(blocker, 'x'); // 把「目录」占成一个普通文件，mkdir 必然失败
  const log = quiet();
  const store = createPinnedRootsStore({ file: join(blocker, 'pinned.json'), log, debounceMs: 5 });
  store.set('/r/A', true);
  await new Promise(r => setTimeout(r, 100));
  assert.deepEqual(store.list(), ['/r/A']);
  assert.ok(log.lines.some(l => /pinned-roots/.test(l)), `没打日志：${JSON.stringify(log.lines)}`);
});
