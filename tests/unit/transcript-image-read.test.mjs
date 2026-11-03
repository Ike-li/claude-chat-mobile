// tests/unit/transcript-image-read.test.mjs —— 按引用从 transcript 取回一张图（image:get 的读盘一侧）
// 覆盖：工具截图 / 用户贴图按引用找回 · 子代理文件靠提示找回 · 只在被请求的那个会话文件里找（别的会话的
//       图拿不到）· 白名单外与超上限的块不交出数据 · 畸形 sessionId / 引用拒绝
// 不测：cwd 范围门与会话归属（server 的 image:get 接线，在 invariants/server/request-cwd-scope）
// 槽位：S1（一次性目录上的真 fs）
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getProjectDir } from '../../app/src/sessions/history.js';
import { readTranscriptImage } from '../../app/src/sessions/transcript-image-read.js';
import { IMAGE_MAX_BYTES } from '../../app/src/shared/transcript-image.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/6X2Xb0AAAAASUVORK5CYII=';
const JPEG = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';
const img = (mt, data) => ({ type: 'image', source: { type: 'base64', media_type: mt, data } });

const BASE = mkdtempSync(join(tmpdir(), 'ccm-img-read-'));
test.after(() => rmSync(BASE, { recursive: true, force: true })); // safe-rm: mkdtemp 一次性目录
const CWD = '/test/img-read';
const DIR = join(BASE, getProjectDir(CWD));
mkdirSync(DIR, { recursive: true });
const jsonl = entries => entries.map(e => JSON.stringify(e)).join('\n') + '\n';

const BIG = 'A'.repeat(Math.ceil((IMAGE_MAX_BYTES + 3) / 3) * 4);
writeFileSync(join(DIR, 'sess-a.jsonl'), jsonl([
  { type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_shot', name: 'computer', input: {} }] } },
  { type: 'user', uuid: 'u1', parentUuid: 'a1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_shot', content: [{ type: 'text', text: 'ok' }, img('image/png', PNG)] }] } },
  { type: 'user', uuid: 'u-paste', parentUuid: 'u1', message: { role: 'user', content: [{ type: 'text', text: '[Image #1]' }, img('image/png', PNG), img('image/jpeg', JPEG)] } },
  { type: 'user', uuid: 'u-svg', parentUuid: 'u-paste', message: { role: 'user', content: [img('image/svg+xml', PNG)] } },
  { type: 'user', uuid: 'u-big', parentUuid: 'u-svg', message: { role: 'user', content: [img('image/png', BIG)] } },
  { type: 'assistant', uuid: 'a2', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_agent', name: 'Agent', input: {} }] } },
]));
// 另一个会话：它的图不得经 sess-a 的请求取出
writeFileSync(join(DIR, 'sess-b.jsonl'), jsonl([
  { type: 'user', uuid: 'u-other', message: { role: 'user', content: [img('image/png', PNG)] } },
]));
const SUB = join(DIR, 'sess-a', 'subagents');
mkdirSync(SUB, { recursive: true });
writeFileSync(join(SUB, 'agent-x1.meta.json'), JSON.stringify({ agentType: 'browser', toolUseId: 'toolu_agent' }));
writeFileSync(join(SUB, 'agent-x1.jsonl'), jsonl([
  { type: 'user', uuid: 's1', isSidechain: true, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_inner', content: [img('image/jpeg', JPEG)] }] } },
]));

const read = (sid, ref) => readTranscriptImage(sid, CWD, ref, { baseDir: BASE });

test('工具截图按 t:<toolUseId>:<n> 取回', async () => {
  assert.deepEqual(await read('sess-a', 't:toolu_shot:0'),
    { ok: true, mediaType: 'image/png', data: PNG, bytes: Buffer.from(PNG, 'base64').length });
});

test('用户贴图按 u:<uuid>:<n> 取回，序号指向第 n 个图片块', async () => {
  const r = await read('sess-a', 'u:u-paste:1');
  assert.equal(r.ok, true);
  assert.equal(r.mediaType, 'image/jpeg');
  assert.equal(r.data, JPEG);
});

test('子代理里的截图：带提示能从它的文件取回，不带提示主 transcript 里找不到', async () => {
  const r = await read('sess-a', 't:toolu_inner:0:toolu_agent');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.data, JPEG);
  assert.equal((await read('sess-a', 't:toolu_inner:0')).code, 'not_found');
});

test('只在被请求的会话文件里找：拿 sess-a 的名义取不到 sess-b 的图', async () => {
  assert.equal((await read('sess-b', 'u:u-other:0')).ok, true, '正对照：sess-b 自己取得到');
  const r = await read('sess-a', 'u:u-other:0');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'not_found');
  assert.equal(r.data, undefined);
});

test('白名单外的块即使被引用点名也不交出数据', async () => {
  const r = await read('sess-a', 'u:u-svg:0');
  assert.deepEqual(r, { ok: false, code: 'unsupported' });
});

test('超上限的块不交出数据（前端显示占位）', async () => {
  const r = await read('sess-a', 'u:u-big:0');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'too_large');
  assert.equal(r.data, undefined);
});

test('越界序号、畸形引用、畸形 sessionId', async () => {
  assert.equal((await read('sess-a', 't:toolu_shot:1')).code, 'not_found');
  assert.equal((await read('sess-a', 't:../../x:0')).code, 'bad_ref');
  assert.equal((await read('../sess-a', 't:toolu_shot:0')).code, 'bad_session');
  assert.equal((await read('no-such', 't:toolu_shot:0')).code, 'not_found');
});
