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

test('面板头：百分比、用量、颜色阈值同状态栏', () => {
  const view = contextPanelView({ percentage: 77, totalTokens: 770000, maxTokens: 1000000 });
  assert.equal(view.usedText, '已用 77%');
  assert.equal(view.tokensText, '770k / 1.0m');
  assert.equal(view.barPercent, 77);
  assert.equal(view.barTone, 'warning');
  assert.equal(contextPanelView({ percentage: 69, totalTokens: 1, maxTokens: 2 }).barTone, 'accent');
  assert.equal(contextPanelView({ percentage: 90, totalTokens: 1, maxTokens: 2 }).barTone, 'danger');
});

test('超过 100% 时条不溢出，文字照实说', () => {
  const view = contextPanelView({ percentage: 104, totalTokens: 1040000, maxTokens: 1000000 });
  assert.equal(view.barPercent, 100);
  assert.equal(view.usedText, '已用 104%');
});

test('不知道窗口：只报绝对 token，不编分母', () => {
  const view = contextPanelView({ totalTokens: 12000 });
  assert.equal(view.usedText, '');
  assert.equal(view.tokensText, '12k');
  assert.equal(view.barPercent, 0);
});

test('明细行：token 和占窗口的百分比', () => {
  const { rows } = contextPanelView({
    percentage: 77, totalTokens: 770000, maxTokens: 1000000,
    categories: [{ id: 'messages', name: 'Messages', tokens: 684300, kind: 'used' }, { id: 'skills', name: 'Skills', tokens: 6800, kind: 'used' }],
  });
  assert.deepEqual(rows, [
    { name: 'Messages', tokens: '684k', percent: '68.4%' },
    { name: 'Skills', tokens: '7k', percent: '0.7%' },
  ]);
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
