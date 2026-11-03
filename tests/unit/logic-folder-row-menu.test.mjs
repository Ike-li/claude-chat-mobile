// tests/unit/logic-folder-row-menu.test.mjs —— 抽屉文件夹行「⋯」菜单里出现哪些项（folderRowMenuItems）。
// 2026-10-26：长按改成拖动排序，「全部标为已读」从长按挪进「⋯」；「⋯」此前只给连接根、只有「断开」一项。
// 不测什么：菜单 sheet 的开合与点了之后的确认框、标记、断开——那是 DOM 与 socket，归 E2E。
import test from 'node:test';
import assert from 'node:assert/strict';
import { folderRowMenuItems } from '../../app/public/js/logic.js';

const actions = items => items.map(i => i.action);

test('folderRowMenuItems: 有未读的连接根 → 全部标为已读（带个数）在上、断开连接垫底', () => {
  const items = folderRowMenuItems({ unreadCount: 5, canDisconnect: true });
  assert.deepEqual(actions(items), ['mark-all-read', 'disconnect']);
  assert.equal(items[0].label, '全部标为已读（5）');
  assert.ok(!items[0].disabled);
  assert.equal(items[1].label, '断开连接');
  assert.equal(items[1].danger, true);
});

test('folderRowMenuItems: 子文件夹小节、「无文件夹」、只读来源下的连接根 → 只有全部标为已读', () => {
  assert.deepEqual(actions(folderRowMenuItems({ unreadCount: 2, canDisconnect: false })), ['mark-all-read']);
});

test('folderRowMenuItems: 没有未读、未读数还没算出来 → 照样列出但灰掉，写明原因', () => {
  const none = folderRowMenuItems({ unreadCount: 0, canDisconnect: false })[0];
  assert.equal(none.label, '全部标为已读');
  assert.equal(none.disabled, true);
  assert.equal(none.hint, '这里没有未读会话');

  const loading = folderRowMenuItems({ unreadCount: null, canDisconnect: false })[0];
  assert.equal(loading.disabled, true, '个数不知道时点下去标的是哪几条说不清');
  assert.equal(loading.hint, '未读数加载中，稍后再试');
});
