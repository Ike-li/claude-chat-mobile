// 「产出」tab 的数据：从 transcript 算出这个会话产出了哪些文件。
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_SESSION_OUTPUTS, outputsFromEntry, readSessionOutputs } from '../../app/src/sessions/session-outputs.js';
import { getProjectDir } from '../../app/src/sessions/history.js';
import { parseFileLink } from '../../app/public/js/logic/file-links.js';

const CWD = '/work/proj';
const TS = '2026-11-06T10:00:00.000Z';
const AT = Date.parse(TS);

const toolResult = (result, extra = {}) => ({
  type: 'user', timestamp: TS, cwd: CWD, toolUseResult: result,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] }, ...extra,
});
const assistant = (text, extra = {}) => ({
  type: 'assistant', timestamp: TS, cwd: CWD,
  message: { role: 'assistant', content: [{ type: 'text', text }] }, ...extra,
});
const paths = entry => outputsFromEntry(entry).map(o => o.path);

test('Write 新建的文件算产出，覆盖已有文件不算', () => {
  assert.deepEqual(outputsFromEntry(toolResult({ type: 'create', filePath: '/work/proj/a.md', content: 'x' })), [
    { path: '/work/proj/a.md', at: AT },
  ]);
  assert.deepEqual(paths(toolResult({ type: 'update', filePath: '/work/proj/a.md', content: 'y' })), []);
});

test('Edit 的结果没有 type，不算产出：改动 tab 已经有了，收进来会淹没列表', () => {
  assert.deepEqual(paths(toolResult({ filePath: '/work/proj/a.js', oldString: 'a', newString: 'b' })), []);
  assert.deepEqual(paths(toolResult({ type: 'create', filePath: '/work/proj/a.js' })), ['/work/proj/a.js'], '对照：同一文件新建时算');
});

test('助手正文的本地文件链接算产出：相对路径按这条记录的 cwd 解析', () => {
  assert.deepEqual(paths(assistant('封面在 [cover](out/cover.png)')), ['/work/proj/out/cover.png']);
  assert.deepEqual(paths(assistant('[v](/data/v.mp4)')), ['/data/v.mp4']);
  assert.deepEqual(paths(assistant('[v](file:///data/v.mp4)')), ['/data/v.mp4']);
  assert.deepEqual(paths(assistant('![图](out/a.png)')), ['/work/proj/out/a.png']);
  assert.deepEqual(paths(assistant('[a](x.md) 和 [b](y.md)')), ['/work/proj/x.md', '/work/proj/y.md']);
});

test('文件名带空格：尖括号和百分号编码两种写法都认', () => {
  assert.deepEqual(paths(assistant('[v](<out/Python 浅拷贝与深拷贝.mp4>)')), ['/work/proj/out/Python 浅拷贝与深拷贝.mp4']);
  assert.deepEqual(paths(assistant('[v](out/Python%20%E6%B5%85.mp4)')), ['/work/proj/out/Python 浅.mp4']);
});

test('带行号的链接是代码引用，不是产出', () => {
  for (const href of ['src/a.js:12', 'src/a.js:12-20', 'src/a.js:12:3', 'src/a.js#L12', '/work/proj/a.js:9']) {
    assert.deepEqual(paths(assistant(`[a](${href}) 成果在 [ok](ok.md)`)), ['/work/proj/ok.md'], href);
  }
});

test('外部链接和页内锚点不算', () => {
  for (const href of ['https://a.b/c', 'http://a.b', 'mailto:a@b.c', 'tel:10086', '#section', '//a.b/c']) {
    assert.deepEqual(paths(assistant(`[a](${href}) 成果在 [ok](ok.md)`)), ['/work/proj/ok.md'], href);
  }
});

test('代码块和行内代码里的链接语法不算：那是在讲语法，不是给文件', () => {
  assert.deepEqual(paths(assistant('```md\n[a](out/a.png)\n```\n成果在 [ok](ok.md)')), ['/work/proj/ok.md']);
  assert.deepEqual(paths(assistant('写成 `[a](out/a.png)` 就行，成果在 [ok](ok.md)')), ['/work/proj/ok.md']);
});

test('子代理的记录不算，用户消息里的链接也不算', () => {
  assert.deepEqual(paths(assistant('[a](a.md)', { isSidechain: true })), []);
  assert.deepEqual(paths(assistant('[a](a.md)')), ['/work/proj/a.md'], '对照：主链的同一条算');
  assert.deepEqual(paths(toolResult({ type: 'create', filePath: '/a' }, { isSidechain: true })), []);
  assert.deepEqual(paths(toolResult({ type: 'create', filePath: '/a' })), ['/a'], '对照：主链的同一条算');
  assert.deepEqual(paths({ type: 'user', timestamp: TS, cwd: CWD, message: { role: 'user', content: [{ type: 'text', text: '[a](a.md)' }] } }), []);
});

test('服务端与前端 parseFileLink 对同一批链接的路径结论一致（前后端互不 import，靠这张表防漂移）', () => {
  for (const href of ['a.md', 'out/a b.png', 'out/a%20b.png', '/abs/a.md', 'file:///abs/a.md', 'a.md?x=1', '中文.md']) {
    const front = parseFileLink(href);
    const expected = front.path.startsWith('/') ? front.path : `${CWD}/${front.path}`;
    const markdownHref = href.includes(' ') ? `<${href}>` : href;
    assert.deepEqual(paths(assistant(`[x](${markdownHref})`)), [expected], href);
  }
  for (const href of ['https://a.b', 'mailto:a@b.c', 'tel:10086', '//a.b/c']) {
    assert.equal(parseFileLink(href), null, href);
    assert.deepEqual(paths(assistant(`[x](${href})`)), [], href);
  }
});

const roots = [];
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

function transcriptDir() {
  const baseDir = mkdtempSync(join(tmpdir(), 'ccm-outputs-'));
  roots.push(baseDir);
  mkdirSync(join(baseDir, getProjectDir(CWD)), { recursive: true });
  return baseDir;
}
const SID = '11111111-1111-4111-8111-111111111111';
const fileOf = baseDir => join(baseDir, getProjectDir(CWD), `${SID}.jsonl`);
const writeLines = (baseDir, entries) => writeFileSync(fileOf(baseDir), entries.map(e => JSON.stringify(e)).join('\n') + '\n');

test('同一文件只出现一次，按最近一次提到的时间倒序', async () => {
  const baseDir = transcriptDir();
  writeLines(baseDir, [
    toolResult({ type: 'create', filePath: '/work/proj/a.md' }, { timestamp: '2026-11-06T10:00:00.000Z' }),
    assistant('[b](b.md)', { timestamp: '2026-11-06T11:00:00.000Z' }),
    assistant('[a](a.md)', { timestamp: '2026-11-06T12:00:00.000Z' }),
  ]);
  assert.deepEqual(await readSessionOutputs(SID, CWD, { baseDir }), [
    { path: '/work/proj/a.md', at: Date.parse('2026-11-06T12:00:00.000Z') },
    { path: '/work/proj/b.md', at: Date.parse('2026-11-06T11:00:00.000Z') },
  ]);
});

test('末行写到一半不影响前面的结果', async () => {
  const baseDir = transcriptDir();
  writeLines(baseDir, [assistant('[a](a.md)')]);
  appendFileSync(fileOf(baseDir), '{"type":"assistant","message":{"role":"assi');
  assert.deepEqual((await readSessionOutputs(SID, CWD, { baseDir })).map(o => o.path), ['/work/proj/a.md']);
});

test('超过上限只留最新的', async () => {
  const baseDir = transcriptDir();
  const n = MAX_SESSION_OUTPUTS + 5;
  writeLines(baseDir, Array.from({ length: n }, (_, i) => assistant(`[f](f${i}.md)`, {
    timestamp: new Date(AT + i * 1000).toISOString(),
  })));
  const items = await readSessionOutputs(SID, CWD, { baseDir });
  assert.equal(items.length, MAX_SESSION_OUTPUTS);
  assert.equal(items[0].path, `/work/proj/f${n - 1}.md`);
});

test('会话文件不存在、会话 id 不合法：回空，不抛错', async () => {
  const baseDir = transcriptDir();
  writeLines(baseDir, [assistant('[a](a.md)')]);
  assert.equal((await readSessionOutputs(SID, CWD, { baseDir })).length, 1, '对照：这个会话读得到');
  assert.deepEqual(await readSessionOutputs('22222222-2222-4222-8222-222222222222', CWD, { baseDir }), []);
  assert.deepEqual(await readSessionOutputs(`../${getProjectDir(CWD)}/${SID}`, CWD, { baseDir }), [], '绕路指回同一文件也不行');
});
