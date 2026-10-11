// tests/unit/logic-permissions.test.mjs —— Claude in Chrome 审批卡片的文案（logic/permissions.js 的 describeChromePermission）
// 测什么：卡片标题能看出网站和动作 · 「总是允许」按实际授权范围（本会话、这个网站）写 · 中英两份文案都对齐 CLI 审批框
// 不测什么：chromeSite 什么时候下发（那是 agent.js 的判据，见 agent-permissions.test.mjs）· DOM 接线（E2E P0-06k）
// 槽位：S1（纯函数）
import test from 'node:test';
import assert from 'node:assert/strict';
import { describeChromePermission } from '../../app/public/js/logic.js';
import { setLang } from '../../app/public/js/i18n.js';

const CHROME = 'mcp__claude-in-chrome__';

test('有网站：标题写出网站和动作，「总是允许」写成本会话内放行这个网站', () => {
  const v = describeChromePermission(`${CHROME}read_page`, { tabId: 7 }, 'example.org');
  assert.equal(v.title, 'Claude in Chrome 想在 example.org 上读取页面', '只带 tabId 的工具，网站只能从这里看出来');
  assert.equal(v.alwaysLabel, '本会话内允许 example.org 上的所有操作',
    '勾选回传的规则是「本会话内允许这个网站」，文案不得写成「总是允许此类操作」');
});

test('英文与 CLI 审批框同句', () => {
  setLang('en');
  try {
    const v = describeChromePermission(`${CHROME}read_page`, { tabId: 7 }, 'example.org');
    assert.equal(v.title, 'Claude in Chrome wants to read the page on example.org');
    assert.equal(v.alwaysLabel, 'Allow all actions on example.org for this session');
    assert.equal(describeChromePermission(`${CHROME}computer`, { action: 'left_click' }, 'example.org').title,
      'Claude in Chrome wants to click on example.org');
  } finally {
    setLang('zh');
  }
});

test('computer 按 action 说动作；认不出的 action 不硬编一个动作', () => {
  assert.equal(describeChromePermission(`${CHROME}computer`, { action: 'left_click', coordinate: [1, 2] }, 'example.org').title,
    'Claude in Chrome 想在 example.org 上点击');
  assert.equal(describeChromePermission(`${CHROME}computer`, { action: 'type', text: 'hi' }, 'example.org').title,
    'Claude in Chrome 想在 example.org 上输入文字');
  assert.equal(describeChromePermission(`${CHROME}computer`, { action: 'teleport' }, 'example.org').title,
    'Claude in Chrome 想在 example.org 上使用浏览器');
  assert.equal(describeChromePermission(`${CHROME}some_future_tool`, {}, 'example.org').title,
    'Claude in Chrome 想在 example.org 上使用浏览器');
});

test('没有网站：标题不带网站，「总是允许」交回通用文案（范围不明时不替它下结论）', () => {
  const v = describeChromePermission(`${CHROME}tabs_context_mcp`, { createIfEmpty: false }, undefined);
  assert.equal(v.title, 'Claude in Chrome 想读取你的浏览器标签页');
  assert.equal(v.alwaysLabel, null);
  assert.equal(describeChromePermission(`${CHROME}tabs_context_mcp`, { createIfEmpty: true }).title,
    'Claude in Chrome 想新建浏览器窗口并读取你的标签页');
});

test('不是 Claude in Chrome 的工具：返回 null，卡片保持原样', () => {
  assert.equal(describeChromePermission('Bash', { command: 'ls' }, undefined), null);
  assert.equal(describeChromePermission('mcp__other__read_page', { tabId: 1 }, undefined), null);
});
