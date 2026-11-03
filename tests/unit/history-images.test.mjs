// tests/unit/history-images.test.mjs —— 历史回放里的图片：只带引用、不带 base64
// 覆盖：工具结果截图 → tool_result.images · 用户贴图 → 文本条 images（纯图消息不丢）·
//       白名单外的 media_type 不出引用 · 有图时摘要只留文字 · 子代理流水里的截图带子代理提示
// 不测：按引用取图（transcript-image-read.test.mjs）、live 路径（agent-transcript-images.test.mjs）
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getProjectDir, getSessionHistory, readSubagentFlow } from '../../app/src/sessions/history.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/6X2Xb0AAAAASUVORK5CYII=';
const img = (mt = 'image/png', data = PNG) => ({ type: 'image', source: { type: 'base64', media_type: mt, data } });

const BASE = mkdtempSync(join(tmpdir(), 'ccm-hist-img-'));
test.after(() => rmSync(BASE, { recursive: true, force: true })); // safe-rm: mkdtemp 一次性目录

function writeSession(cwd, id, entries) {
  const dir = join(BASE, getProjectDir(cwd));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.jsonl`), entries.map(e => JSON.stringify(e)).join('\n') + '\n');
  return dir;
}

test('工具截图：tool_result 带图片引用，摘要只剩文字、不再是带「base64 已省略」的 JSON', async () => {
  const cwd = '/test/img-tool';
  writeSession(cwd, 's1', [
    { type: 'assistant', uuid: 'a1', timestamp: 't0', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_shot', name: 'mcp__claude-in-chrome__computer', input: { action: 'screenshot' } }] } },
    { type: 'user', uuid: 'u1', timestamp: 't1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_shot', content: [{ type: 'text', text: '已截图' }, img()] }] } },
  ]);
  const msgs = await getSessionHistory('s1', cwd, 50, { baseDir: BASE });
  const tr = msgs.find(m => m.kind === 'tool_result');
  assert.deepEqual(tr.images, [{ ref: 't:toolu_shot:0', mediaType: 'image/png', bytes: Buffer.from(PNG, 'base64').length }],
    '历史回放里的工具截图没有引用 = 手机上看不到这张图');
  assert.equal(tr.outputSummary, '已截图');
  assert.ok(!JSON.stringify(msgs).includes(PNG.slice(0, 24)), 'base64 进了 session:history = 截图会撑爆手机历史加载');
});

test('用户贴图：图片挂在那条用户气泡上（终端在文字前、桌面端在文字后，两种顺序都认）', async () => {
  const cwd = '/test/img-user';
  writeSession(cwd, 's2', [
    { type: 'user', uuid: 'u-cli', timestamp: 't0', message: { role: 'user', content: [{ type: 'text', text: '[Image #1] 看这个' }, img(), img('image/jpeg')] } },
    { type: 'user', uuid: 'u-desk', timestamp: 't1', message: { role: 'user', content: [img('image/webp'), { type: 'text', text: '桌面端贴的' }] } },
  ]);
  const msgs = await getSessionHistory('s2', cwd, 50, { baseDir: BASE });
  assert.equal(msgs.length, 2, `一条用户消息仍是一个气泡，实际 ${JSON.stringify(msgs.map(m => m.content))}`);
  assert.equal(msgs[0].content, '[Image #1] 看这个');
  assert.deepEqual(msgs[0].images.map(i => [i.ref, i.mediaType]), [['u:u-cli:0', 'image/png'], ['u:u-cli:1', 'image/jpeg']]);
  assert.deepEqual(msgs[1].images.map(i => i.ref), ['u:u-desk:0']);
  assert.equal(msgs[1].uuid, 'u-desk', '带图的用户气泡仍是分叉锚点');
});

test('只发了图、没写字的用户消息不得整条消失', async () => {
  const cwd = '/test/img-only';
  writeSession(cwd, 's3', [
    { type: 'user', uuid: 'u-only', timestamp: 't0', message: { role: 'user', content: [img(), img()] } },
  ]);
  const msgs = await getSessionHistory('s3', cwd, 50, { baseDir: BASE });
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].role, 'user');
  assert.equal(msgs[0].content, '');
  assert.equal(msgs[0].images.length, 2);
});

test('白名单外的 media_type 不出引用；工具摘要保持原口径', async () => {
  const cwd = '/test/img-unsupported';
  writeSession(cwd, 's4', [
    { type: 'user', uuid: 'u-svg', timestamp: 't0', message: { role: 'user', content: [{ type: 'text', text: '矢量图' }, img('image/svg+xml')] } },
    { type: 'user', uuid: 'u2', timestamp: 't1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_bmp', content: [img('image/bmp', 'A'.repeat(800))] }] } },
  ]);
  const msgs = await getSessionHistory('s4', cwd, 50, { baseDir: BASE });
  assert.equal(msgs[0].images, undefined, 'svg 不得给出可取的引用');
  const tr = msgs.find(m => m.kind === 'tool_result');
  assert.equal(tr.images, undefined);
  assert.match(tr.outputSummary, /base64 数据/, '没有可显示的图时，摘要仍提示那里有一段被省略的数据');
});

test('子代理流水里的截图：引用带上那张子代理卡的 id，主 transcript 找不到时去它的文件里找', async () => {
  const cwd = '/test/img-subagent';
  const dir = writeSession(cwd, 's5', [
    { type: 'assistant', uuid: 'a1', timestamp: 't0', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_agent', name: 'Agent', input: { subagent_type: 'x' } }] } },
  ]);
  const subDir = join(dir, 's5', 'subagents');
  mkdirSync(subDir, { recursive: true });
  writeFileSync(join(subDir, 'agent-abc.meta.json'), JSON.stringify({ agentType: 'x', toolUseId: 'toolu_agent' }));
  writeFileSync(join(subDir, 'agent-abc.jsonl'), [
    { type: 'user', uuid: 'sx', isSidechain: true, timestamp: 't1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_inner', content: [img()] }] } },
  ].map(e => JSON.stringify(e)).join('\n') + '\n');
  const flow = await readSubagentFlow('s5', cwd, 'toolu_agent', { baseDir: BASE });
  assert.equal(flow.ok, true);
  const tr = flow.items.find(m => m.kind === 'tool_result');
  assert.deepEqual(tr.images.map(i => i.ref), ['t:toolu_inner:0:toolu_agent']);
});
