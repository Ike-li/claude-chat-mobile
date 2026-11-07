// 上下文面板怎么显示。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compactBlockReason, compactLineText, contextPanelView, usageFromStatusCtx,
} from '../../app/public/js/logic/context-panel.js';

test('距自动压缩 = 阈值减已用：截图里的 770k / 967k', () => {
  assert.equal(compactLineText({ totalTokens: 770000, autoCompactThreshold: 967000, isAutoCompactEnabled: true }), '距自动压缩还剩 197k');
});

test('真 CLI 的形状：buffer 没有单独成行，free 188k，但距压缩是 156k，不能拿 free 行当答案', () => {
  assert.equal(compactLineText({
    totalTokens: 11391, autoCompactThreshold: 167000, isAutoCompactEnabled: true,
    categories: [{ id: 'free_space', name: 'Free space', tokens: 188609, kind: 'free' }],
  }), '距自动压缩还剩 156k');
});

test('快到了或已过阈值：不报一个没意义的小数字', () => {
  const near = { autoCompactThreshold: 167000, isAutoCompactEnabled: true };
  assert.equal(compactLineText({ ...near, totalTokens: 140000 }), '即将自动压缩');
  assert.equal(compactLineText({ ...near, totalTokens: 180000 }), '即将自动压缩');
  assert.equal(compactLineText({ ...near, totalTokens: 136000 }), '距自动压缩还剩 31k', '对照：3 万以上照常报');
});

test('自动压缩关了就说关了；没有阈值时不编一个', () => {
  assert.equal(compactLineText({ totalTokens: 1, autoCompactThreshold: 167000, isAutoCompactEnabled: false }), '自动压缩已关闭');
  assert.equal(compactLineText({ totalTokens: 1, isAutoCompactEnabled: true }), '');
  assert.equal(compactLineText({ autoCompactThreshold: 167000, isAutoCompactEnabled: true }), '', '不知道用了多少');
});

test('面板头：百分比、用量；还没有类别时条用单色，阈值同状态栏', () => {
  const view = contextPanelView({ percentage: 77, totalTokens: 770000, maxTokens: 1000000 });
  assert.equal(view.usedText, '已用 77%');
  assert.equal(view.tokensText, '770k / 1.0m');
  assert.deepEqual(view.segments, [{ tone: 'warning', percent: 77 }]);
  assert.equal(contextPanelView({ percentage: 69, totalTokens: 1, maxTokens: 2 }).segments[0].tone, 'accent');
  assert.equal(contextPanelView({ percentage: 90, totalTokens: 1, maxTokens: 2 }).segments[0].tone, 'danger');
});

test('超过 100% 时条不溢出，文字照实说', () => {
  const view = contextPanelView({ percentage: 104, totalTokens: 1040000, maxTokens: 1000000 });
  assert.equal(view.segments[0].percent, 100);
  assert.equal(view.usedText, '已用 104%');
});

test('不知道窗口：只报绝对 token，不编分母，也不画条', () => {
  const view = contextPanelView({ totalTokens: 12000 });
  assert.equal(view.usedText, '');
  assert.equal(view.tokensText, '12k');
  assert.deepEqual(view.segments, []);
});

const used = (name, tokens) => ({ name, tokens, kind: 'used' });
const MAX = 1000000;
const SEVEN = [used('Skills', 6800), used('Messages', 166400), used('System prompt', 10700), used('MCP tools', 20500),
  used('System tools', 20000), used('Memory files', 6800), used('MCP server instructions', 2900)];
const BUFFER = { name: 'Autocompact buffer', tokens: 33000, kind: 'buffer' };
const FREE = { name: 'Free space', tokens: 732800, kind: 'free' };
const DEFERRED = { name: 'MCP tools (deferred)', tokens: 68700, kind: 'deferred' };
const tones = view => view.rows.map(r => [r.name, r.tone]);

test('颜色按占用排名给，不按类别：放不下时前几名彩色，其余灰色（同桌面端，连 buffer 共 5 段）', () => {
  const view = contextPanelView({ percentage: 23, totalTokens: 234200, maxTokens: MAX, categories: [...SEVEN, BUFFER, FREE] });
  assert.deepEqual(tones(view), [
    ['Messages', '0'], ['MCP tools', '1'], ['System tools', '2'], ['System prompt', '3'],
    ['Skills', 'other'], ['Memory files', 'other'], ['MCP server instructions', 'other'],
    ['Autocompact buffer', 'buffer'], ['Free space', 'free'],
  ]);
});

test('同一类别排名变了，颜色跟着变：这是桌面端两张截图 System prompt 一灰一黄的原因', () => {
  const swapped = [used('System tools', 500), used('Messages', 400), used('MCP tools', 300), used('Skills', 200), used('Memory files', 100), used('System prompt', 50)];
  assert.deepEqual(tones(contextPanelView({ maxTokens: MAX, categories: swapped })).slice(0, 2), [['System tools', '0'], ['Messages', '1']]);
});

test('放得下就都给色：没有 other 这一段', () => {
  const few = [used('Messages', 500), used('System tools', 300)];
  const view = contextPanelView({ maxTokens: MAX, categories: few });
  assert.deepEqual(view.rows.map(r => r.tone), ['0', '1']);
  assert.deepEqual(view.segments.map(s => s.tone), ['0', '1']);
});

test('分段条：彩色段、合并的灰段、buffer；空闲是底色，deferred 不占窗口，都不成段', () => {
  const view = contextPanelView({ percentage: 23, totalTokens: 234200, maxTokens: MAX, categories: [...SEVEN, BUFFER, FREE, DEFERRED] });
  assert.deepEqual(view.segments.map(s => s.tone), ['0', '1', '2', '3', 'other', 'buffer']);
  assert.equal(view.segments[0].percent, 16.64);
  assert.equal(view.segments[4].percent, 1.65, 'other 是三个小类合起来');
  assert.equal(view.segments[5].percent, 3.3);
});

test('明细行：token、占窗口的百分比；deferred 排在最后，百分比写 —', () => {
  const { rows } = contextPanelView({ percentage: 77, totalTokens: 770000, maxTokens: MAX, categories: [DEFERRED, used('Messages', 684300), FREE] });
  assert.deepEqual(rows, [
    { name: 'Messages', tokens: '684k', percent: '68.4%', tone: '0' },
    { name: 'Free space', tokens: '733k', percent: '73.3%', tone: 'free' },
    { name: 'MCP tools (deferred)', tokens: '69k', percent: '—', tone: 'deferred' },
  ]);
});

test('MCP 工具和记忆文件：带数量的列表，工具名去掉 mcp__ 前缀；没有就不出现', () => {
  const { lists } = contextPanelView({
    maxTokens: MAX,
    mcpTools: [{ name: 'mcp__claude-in-chrome__read_page', serverName: 'claude-in-chrome', tokens: 2100 }, { name: 'mcp__a__b__c', serverName: 'a', tokens: 0 }],
    memoryFiles: [{ path: '~/.claude/CLAUDE.md', tokens: 6800 }],
  });
  assert.deepEqual(lists, [
    { key: 'mcp', label: 'MCP 工具', count: 2, rows: [{ name: 'claude-in-chrome · read_page', tokens: '2k' }, { name: 'a · b__c', tokens: '—' }] },
    { key: 'memory', label: '记忆文件', count: 1, rows: [{ name: '~/.claude/CLAUDE.md', tokens: '7k' }] },
  ]);
  assert.deepEqual(contextPanelView({ maxTokens: MAX }).lists, []);
});

test('状态栏数据垫底：打开面板那一刻就有数，优先级同 formatStatuslineCtxLeft', () => {
  assert.deepEqual(usageFromStatusCtx({ usedPercent: 23, windowSize: 200000, totalTokens: 45000 }), { percentage: 23, totalTokens: 45000, maxTokens: 200000 });
  assert.deepEqual(usageFromStatusCtx({ usedPercent: 23, windowSize: 200000, tokens: 2000 }), { percentage: 23, totalTokens: 46000, maxTokens: 200000 }, '有 % 时不用单轮 tokens');
  assert.deepEqual(usageFromStatusCtx({ tokens: 2000 }), { percentage: undefined, totalTokens: 2000, maxTokens: undefined });
  assert.deepEqual(usageFromStatusCtx(undefined), {});
});

test('压缩按钮：能压时没有原因；不能压时说清楚为什么', () => {
  const idle = { mirrorReadonly: false, turnRunning: false, pendingPrompt: false, hasAttachments: false };
  assert.equal(compactBlockReason(idle), '');
  assert.equal(compactBlockReason({ ...idle, mirrorReadonly: true }), '终端正在驾驶这个会话，接管后才能压缩');
  assert.equal(compactBlockReason({ ...idle, turnRunning: true }), '回合进行中，结束后可压缩');
  assert.equal(compactBlockReason({ ...idle, pendingPrompt: true }), '先处理审批或选择，再压缩');
  assert.equal(compactBlockReason({ ...idle, hasAttachments: true }), '有待发附件，发出或移除后再压缩');
});
