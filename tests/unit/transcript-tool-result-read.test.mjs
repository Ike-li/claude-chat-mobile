// tests/unit/transcript-tool-result-read.test.mjs —— 按 toolUseId 从 transcript 取回一条工具结果的全文
// （验收 O55：历史工具卡的「展开全文」。tool:full 的读盘一侧，live 卡片走实例内存，历史卡片走这里）
// 覆盖：字符串结果原样取回（不截断）· 带图的结果只留文字、不交出 base64 · 子代理里的卡靠那次 Agent 调用的 id
//       到子代理文件里找 · 只在被请求的会话文件里找 · 畸形 sessionId / 缺 id / 找不到
// 不测：cwd 范围门与会话归属（tool:full handler 的接线，在 invariants/server-file-handlers）
// 槽位：S1（一次性目录上的真 fs）
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getProjectDir } from '../../app/src/sessions/history.js';
import { readTranscriptToolResult } from '../../app/src/sessions/transcript-image-read.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/6X2Xb0AAAAASUVORK5CYII=';
const BASE = mkdtempSync(join(tmpdir(), 'ccm-tool-read-'));
test.after(() => rmSync(BASE, { recursive: true, force: true })); // safe-rm: mkdtemp 一次性目录
const CWD = '/test/tool-read';
const DIR = join(BASE, getProjectDir(CWD));
mkdirSync(DIR, { recursive: true });
const jsonl = entries => entries.map(e => JSON.stringify(e)).join('\n') + '\n';
const LONG = Array.from({ length: 700 }, (_, i) => `line ${i} of the build log`).join('\n');

writeFileSync(join(DIR, 'sess-a.jsonl'), jsonl([
  { type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_bash', name: 'Bash', input: { command: 'make' } }] } },
  { type: 'user', uuid: 'u1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_bash', content: LONG }] } },
  { type: 'user', uuid: 'u2', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_shot', content: [{ type: 'text', text: '已截图' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }] }] } },
  { type: 'assistant', uuid: 'a2', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_agent', name: 'Agent', input: {} }] } },
]));
writeFileSync(join(DIR, 'sess-b.jsonl'), jsonl([
  { type: 'user', uuid: 'u-other', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_other', content: 'secret of b' }] } },
]));
const SUB = join(DIR, 'sess-a', 'subagents');
mkdirSync(SUB, { recursive: true });
writeFileSync(join(SUB, 'agent-x1.meta.json'), JSON.stringify({ agentType: 'general-purpose', toolUseId: 'toolu_agent' }));
writeFileSync(join(SUB, 'agent-x1.jsonl'), jsonl([
  { type: 'user', uuid: 's1', isSidechain: true, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_sub_read', content: 'sub full text' }] } },
]));

const read = (sid, id, opts) => readTranscriptToolResult(sid, CWD, id, { baseDir: BASE, ...opts });

test('字符串结果原样取回，不截断', async () => {
  assert.deepEqual(await read('sess-a', 'toolu_bash'), { ok: true, text: LONG });
});

test('带图的结果只留文字：图另有引用按需取，base64 不进全文', async () => {
  const r = await read('sess-a', 'toolu_shot');
  assert.deepEqual(r, { ok: true, text: '已截图' });
});

test('子代理里的卡：带上那次 Agent 调用的 id 到子代理文件里找；不带则主 transcript 里找不到', async () => {
  assert.deepEqual(await read('sess-a', 'toolu_sub_read', { agentToolUseId: 'toolu_agent' }), { ok: true, text: 'sub full text' });
  assert.equal((await read('sess-a', 'toolu_sub_read')).code, 'not_found');
});

test('只在被请求的会话文件里找：拿 sess-a 的名义取不到 sess-b 的结果', async () => {
  assert.equal((await read('sess-a', 'toolu_other')).code, 'not_found');
  assert.deepEqual(await read('sess-b', 'toolu_other'), { ok: true, text: 'secret of b' });
});

test('畸形 sessionId、缺 toolUseId、会话文件不存在', async () => {
  assert.equal((await read('../sess-a', 'toolu_bash')).code, 'bad_session');
  assert.equal((await read('sess-a', '')).code, 'bad_ref');
  assert.equal((await read('sess-none', 'toolu_bash')).code, 'not_found');
});
