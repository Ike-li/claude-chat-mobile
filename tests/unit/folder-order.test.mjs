// tests/unit/folder-order.test.mjs —— 抽屉文件夹手动顺序的存储（长按拖动排序，取代 #305 置顶）：有序的根路径数组，整份替换。
// 落盘走真文件（一次性目录），不 mock：「排序 → flush → 同一个文件新建 store → 还在」才算持久化成立。
// 它只是展示偏好：读坏了当作没有、打一行警告，不能挡启动。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFolderOrderStore } from '../../app/src/sessions/folder-order.js';

const DIR = mkdtempSync(join(tmpdir(), 'ccm-folder-order-'));
test.after(() => rmSync(DIR, { recursive: true, force: true })); // safe-rm: mkdtemp 一次性目录
let n = 0;
const freshFile = () => join(DIR, `order-${++n}.json`);
const quiet = () => { const lines = []; return { lines, warn: m => lines.push(String(m)), error: m => lines.push(String(m)) }; };

test('setOrder 整份替换；list 给的是副本，改它不影响存储', () => {
  const store = createFolderOrderStore({ file: freshFile(), log: quiet() });
  store.setOrder(['/r/B', '/r/C', '/r/A']);
  assert.deepEqual(store.list(), ['/r/B', '/r/C', '/r/A']);
  store.setOrder(['/r/A', '/r/B']);
  assert.deepEqual(store.list(), ['/r/A', '/r/B'], '不是合并：上一份里的 /r/C 不该留下');
  store.list().push('/r/X');
  assert.deepEqual(store.list(), ['/r/A', '/r/B']);
});

test('真实持久化：排序 → flush → 用同一个文件新建 store，顺序不变', () => {
  const file = freshFile();
  const a = createFolderOrderStore({ file, log: quiet() });
  a.setOrder(['/r/C', '/r/A']);
  a.flushSaveSync();
  assert.ok(existsSync(file));
  assert.deepEqual(createFolderOrderStore({ file, log: quiet() }).list(), ['/r/C', '/r/A']);
});

test('从没排过序：退出时的 flush 不凭空建文件', () => {
  const file = freshFile();
  createFolderOrderStore({ file, log: quiet() }).flushSaveSync();
  assert.equal(existsSync(file), false);
});

test('防抖写盘：不 flush 也会在防抖窗之后落盘', async () => {
  const file = freshFile();
  const store = createFolderOrderStore({ file, log: quiet(), debounceMs: 10 });
  store.setOrder(['/r/A']);
  await new Promise(r => setTimeout(r, 120));
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), ['/r/A']);
});

test('读坏档：文件缺失、JSON 损坏、结构非法都当作没有顺序；损坏与结构非法各打一行警告', () => {
  const missing = quiet();
  assert.deepEqual(createFolderOrderStore({ file: freshFile(), log: missing }).list(), []);
  assert.deepEqual(missing.lines, [], '文件不存在是新装的常态，不该警告');

  for (const content of ['{not json', '{"roots":["/r/A"]}', '["/r/A", 42]']) {
    const file = freshFile();
    writeFileSync(file, content);
    const log = quiet();
    assert.deepEqual(createFolderOrderStore({ file, log }).list(), [], content);
    assert.equal(log.lines.length, 1, `${content} 应打一行警告`);
    assert.match(log.lines[0], /folder-order/);
  }
});

test('写盘失败：打日志，内存里的顺序照常生效', async () => {
  const blocker = freshFile();
  writeFileSync(blocker, 'x'); // 把「目录」占成一个普通文件，mkdir 必然失败
  const log = quiet();
  const store = createFolderOrderStore({ file: join(blocker, 'order.json'), log, debounceMs: 5 });
  store.setOrder(['/r/A']);
  await new Promise(r => setTimeout(r, 100));
  assert.deepEqual(store.list(), ['/r/A']);
  assert.ok(log.lines.some(l => /folder-order/.test(l)), `没打日志：${JSON.stringify(log.lines)}`);
});
