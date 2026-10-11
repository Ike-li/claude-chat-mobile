// tests/unit/agent-transcript-images.test.mjs —— live 工具截图：事件只带引用，图在实例内存里短期保留
// 为什么要内存：tool_result 经 SDK 流到达时 transcript 未必已落盘，手机收到事件立刻来取图，
// 只靠读盘会撞上「刚截的图取不到」。内存有上限，过期 / 挤出后由 transcript 兜底（transcript-image-read）。
// 覆盖：主链与子代理两条分支的引用形态 · 事件里没有 base64 · 有图时摘要只留文字 · 内存命中 ·
//       白名单外不出引用也不缓存 · 字节上限挤出最旧的 · dispose 清空
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSession } from '../helpers/agent-unit.mjs';
import { IMAGE_MAX_BYTES } from '../../app/src/shared/transcript-image.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/6X2Xb0AAAAASUVORK5CYII=';
const img = (mt, data = PNG) => ({ type: 'image', source: { type: 'base64', media_type: mt, data } });

test('主链工具截图：tool_result 带引用、不带 base64，图立刻可从实例内存取到', () => {
  const { s, events } = makeSession();
  // Read 读图片时 tool_use_result 是另一种形态（{type:'image', file:{base64}}）：引用一律从 block.content 取
  s.map({ type: 'user', tool_use_result: { type: 'image', file: { base64: PNG, type: 'image/png' } }, message: { content: [
    { type: 'tool_result', tool_use_id: 'toolu_read', is_error: false, content: [img('image/png')] },
  ] } });
  const tr = events.find(e => e.type === 'tool_result');
  assert.deepEqual(tr.payload.images, [{ ref: 't:toolu_read:0', mediaType: 'image/png', bytes: Buffer.from(PNG, 'base64').length }],
    'live 截图没有引用 = 手机上只看到一段被截断的 JSON');
  assert.equal(tr.payload.outputSummary, '', '只有图的结果，摘要不该再是 {"type":"image","file":{"base64":"（已省略）"}} 骨架');
  assert.ok(!JSON.stringify(events).includes(PNG.slice(0, 24)), 'base64 进了 agent:event = 截图撑爆环形缓冲');
  assert.deepEqual(s.getToolImage('toolu_read', 0), { mediaType: 'image/png', data: PNG });
  assert.equal(s.getToolImage('toolu_read', 1), null);
  s.dispose();
});

test('MCP 截图（文字 + 图）：摘要只留文字', () => {
  const { s, events } = makeSession();
  s.map({ type: 'user', tool_use_result: [{ type: 'text', text: 'Took screenshot' }, img('image/jpeg')], message: { content: [
    { type: 'tool_result', tool_use_id: 'toolu_mcp', is_error: false, content: [{ type: 'text', text: 'Took screenshot' }, img('image/jpeg')] },
  ] } });
  const tr = events.find(e => e.type === 'tool_result');
  assert.equal(tr.payload.outputSummary, 'Took screenshot');
  assert.equal(tr.payload.images[0].mediaType, 'image/jpeg');
  s.dispose();
});

test('子代理的工具截图：引用带子代理那次调用的 id，同样进内存', () => {
  const { s, events } = makeSession();
  s.map({ type: 'user', parent_tool_use_id: 'toolu_agent', message: { content: [
    { type: 'tool_result', tool_use_id: 'toolu_inner', is_error: false, content: [img('image/png')] },
  ] } });
  const tr = events.find(e => e.type === 'tool_result');
  assert.equal(tr.payload.parentToolUseId, 'toolu_agent');
  assert.deepEqual(tr.payload.images.map(i => i.ref), ['t:toolu_inner:0:toolu_agent']);
  assert.ok(s.getToolImage('toolu_inner', 0));
  s.dispose();
});

test('白名单外的图不出引用、不进内存', () => {
  const { s, events } = makeSession();
  s.map({ type: 'user', message: { content: [
    { type: 'tool_result', tool_use_id: 'toolu_svg', is_error: false, content: [img('image/svg+xml')] },
  ] } });
  assert.equal(events.find(e => e.type === 'tool_result').payload.images, undefined);
  assert.equal(s.getToolImage('toolu_svg', 0), null);
  s.dispose();
});

test('内存有字节上限：持续截图时挤出最旧的（之后由 transcript 兜底），最新的始终取得到', () => {
  const { s } = makeSession();
  const big = 'A'.repeat(Math.floor(IMAGE_MAX_BYTES / 3) * 4); // 每张接近单张上限
  for (let i = 0; i < 40; i++) {
    s.map({ type: 'user', message: { content: [
      { type: 'tool_result', tool_use_id: `toolu_${i}`, is_error: false, content: [img('image/png', big)] },
    ] } });
  }
  assert.equal(s.getToolImage('toolu_0', 0), null, '40 张近 2MB 的图全留在内存 = 一个实例吃掉 80MB');
  assert.ok(s.getToolImage('toolu_39', 0), '最新一张必须取得到——手机刚收到事件就会来取');
  s.dispose();
  assert.equal(s.getToolImage('toolu_39', 0), null, 'dispose 后不再持有图片');
});
