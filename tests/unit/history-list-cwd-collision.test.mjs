// tests/unit/history-list-cwd-collision.test.mjs —— 编码撞名：一个 project 目录归两个 cwd 时，按 transcript 记的 cwd 分开
//
// project 目录名是 cwd 的有损编码：非字母数字一律变成 '-'，中文也是。于是 `/x/a-b` 与 `/x/a/b`、同一父目录下
// 两个等长的中文文件夹（`笔记` / `文档`）落进同一个目录。子文件夹直接可达之后（2026-09-24），这两个 cwd 都是
// 合法的会话目录；列表、打开、按 id 补行只按目录找文件的话，B 的会话会列在 A 下面，点开就在 A 里 resume——
// 模型接着改的是另一个文件夹里的文件（2026-10-10 review P1）。
//
// 判据：目录里每份 transcript 自己记着 cwd，列表与存在性都只认记的是本 cwd 的；读不出 cwd 的老 transcript
// 照旧算谁的都行（少列一条比列错一条安全，但老文件本来就列着，不能因为这次改动消失）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getProjectDir, listSessionsPage, listSessionsByIds, sessionFileExists } from '../../app/src/sessions/history.js';

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'ccm-hist-collide-')));
test.after(() => rmSync(ROOT, { recursive: true, force: true })); // safe-rm: mkdtemp 一次性目录

// 每个用例一套独立的 projects 根，避免列表的 TTL 缓存串场
let seq = 0;
function fixture(left, right) {
  const base = join(ROOT, `c${seq++}`);
  const baseDir = join(base, 'projects');
  const a = join(base, 'code', left);
  const b = join(base, 'code', right);
  mkdirSync(baseDir, { recursive: true });
  mkdirSync(a, { recursive: true });
  mkdirSync(b, { recursive: true });
  assert.equal(getProjectDir(a), getProjectDir(b), `夹具前提：${left} 与 ${right} 编码后同名`);
  return { baseDir, a, b };
}

const T0 = Date.parse('2026-10-10T00:00:00Z');
// CLI 的真实形态：每条记录都带 cwd。noCwd 单给「老 transcript 没有这个字段」那一格用。
function writeSession(baseDir, cwd, id, { at = T0, text = 'hi', noCwd = false } = {}) {
  const dir = join(baseDir, getProjectDir(cwd));
  mkdirSync(dir, { recursive: true });
  const ts = new Date(at).toISOString();
  const own = noCwd ? {} : { cwd };
  const lines = [
    { type: 'user', timestamp: ts, ...own, message: { role: 'user', content: text } },
    { type: 'assistant', timestamp: ts, ...own, message: { role: 'assistant', content: 'ok' } },
  ];
  writeFileSync(join(dir, `${id}.jsonl`), lines.map(e => JSON.stringify(e)).join('\n') + '\n');
}

for (const [left, right] of [['a-b', join('a', 'b')], ['笔记', '文档']]) {
  test(`${left} 与 ${right} 撞名：各自的列表只有自己的会话，total 按自己的算`, async () => {
    const { baseDir, a, b } = fixture(left, right);
    writeSession(baseDir, a, 'mine-1', { at: T0 });
    writeSession(baseDir, b, 'theirs-1', { at: T0 + 1000 });
    writeSession(baseDir, b, 'theirs-2', { at: T0 + 2000 });
    const pa = await listSessionsPage(a, { baseDir, limit: 10 });
    assert.deepEqual(pa.sessions.map(s => s.id), ['mine-1'], `${left} 的列表混进了 ${right} 的会话`);
    assert.equal(pa.total, 1);
    const pb = await listSessionsPage(b, { baseDir, limit: 10 });
    assert.deepEqual(pb.sessions.map(s => s.id), ['theirs-2', 'theirs-1']);
    assert.equal(pb.total, 2);
  });
}

test('撞名时分页按自己的会话截：别人的会话不占 limit 的名额', async () => {
  const { baseDir, a, b } = fixture('p-q', join('p', 'q'));
  writeSession(baseDir, a, 'mine-1', { at: T0 });
  for (let i = 0; i < 3; i += 1) writeSession(baseDir, b, `theirs-${i}`, { at: T0 + 1000 * (i + 1) });
  const page = await listSessionsPage(a, { baseDir, limit: 1 });
  assert.deepEqual(page.sessions.map(s => s.id), ['mine-1'], '最近的几条是别人的，挤掉了自己的');
  assert.equal(page.hasMore, false);
});

test('搜索路径同样只认自己的会话', async () => {
  const { baseDir, a, b } = fixture('s-t', join('s', 't'));
  writeSession(baseDir, a, 'mine-1', { text: '修登录页' });
  writeSession(baseDir, b, 'theirs-1', { text: '修登录页' });
  const page = await listSessionsPage(a, { baseDir, limit: 10, query: '登录' });
  assert.deepEqual(page.sessions.map(s => s.id), ['mine-1']);
});

test('sessionFileExists：别人的会话在同一个目录里也不算本 cwd 的（打开、删除、改名都走这道）', async () => {
  const { baseDir, a, b } = fixture('u-v', join('u', 'v'));
  writeSession(baseDir, a, 'mine-1');
  writeSession(baseDir, b, 'theirs-1');
  assert.equal(await sessionFileExists(a, 'mine-1', { baseDir }), true);
  assert.equal(await sessionFileExists(a, 'theirs-1', { baseDir }), false, '点开会在错误的目录里 resume');
  assert.equal(await sessionFileExists(b, 'theirs-1', { baseDir }), true);
});

test('listSessionsByIds：按 id 补行也不补别人的', async () => {
  const { baseDir, a, b } = fixture('w-x', join('w', 'x'));
  writeSession(baseDir, a, 'mine-1');
  writeSession(baseDir, b, 'theirs-1');
  assert.deepEqual((await listSessionsByIds(a, ['mine-1', 'theirs-1'], { baseDir })).map(s => s.id), ['mine-1']);
});

test('读不出 cwd 的老 transcript：照旧两边都列、都能打开（不因这次改动消失）', async () => {
  const { baseDir, a, b } = fixture('y-z', join('y', 'z'));
  writeSession(baseDir, a, 'mine-1');
  writeSession(baseDir, b, 'theirs-1');
  writeSession(baseDir, a, 'old-1', { noCwd: true, at: T0 - 1000 });
  assert.deepEqual((await listSessionsPage(a, { baseDir, limit: 10 })).sessions.map(s => s.id), ['mine-1', 'old-1']);
  assert.deepEqual((await listSessionsPage(b, { baseDir, limit: 10 })).sessions.map(s => s.id), ['theirs-1', 'old-1']);
  assert.equal(await sessionFileExists(b, 'old-1', { baseDir }), true);
});

test('不撞名的目录：行为不变（自己的会话照列，没有别人的可剔）', async () => {
  const { baseDir, a } = fixture('m-n', join('m', 'n'));
  writeSession(baseDir, a, 'mine-1');
  writeSession(baseDir, a, 'mine-2', { at: T0 + 1000 });
  const page = await listSessionsPage(a, { baseDir, limit: 10 });
  assert.deepEqual(page.sessions.map(s => s.id), ['mine-2', 'mine-1']);
  assert.equal(await sessionFileExists(a, 'mine-2', { baseDir }), true);
});
