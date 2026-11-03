// tests/unit/logic-session-row-menu.test.mjs —— 抽屉会话行「⋯」菜单里出现哪些项（sessionRowMenuItems）。
// 一行只有这一个入口（对齐桌面端 SessionDropdownMenu）：标已读/未读在最上，重命名紧随（#458，有 id 就能改，
// 打开着也能改），关闭只给已打开的，删除垫底。
// 不测什么：菜单 sheet 的开合与点了之后的副作用（关闭 / 删除 / 标记）——那是 DOM 与 socket，归 E2E。
import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionRowMenuItems } from '../../app/public/js/logic.js';

const actions = items => items.map(i => i.action);

test('sessionRowMenuItems: 没打开的已存会话 → 标为未读、重命名、删除（可点），没有关闭', () => {
  const items = sessionRowMenuItems({ hasId: true, live: false, unread: false });
  assert.deepEqual(actions(items), ['toggle-read', 'rename', 'delete']);
  assert.equal(items[0].label, '标为未读');
  assert.equal(items[1].label, '重命名');
  assert.equal(items[2].label, '删除会话');
  assert.ok(!items[2].disabled, '没打开的会话必须能直接删');
});

test('sessionRowMenuItems: 已标未读的行，同一项改成「标为已读」', () => {
  const [toggle] = sessionRowMenuItems({ hasId: true, live: false, unread: true });
  assert.equal(toggle.action, 'toggle-read');
  assert.equal(toggle.label, '标为已读');
});

test('sessionRowMenuItems: 已打开的会话 → 多一项关闭，重命名照样可点；删除灰掉并说明要先关闭', () => {
  const items = sessionRowMenuItems({ hasId: true, live: true, unread: false });
  assert.deepEqual(actions(items), ['toggle-read', 'rename', 'close', 'delete']);
  assert.ok(!items[1].disabled, '改名是轻操作，活会话的 CLI 回写由服务端退出补写兜住，不必先关');
  assert.equal(items[2].label, '关闭会话');
  const del = items[3];
  assert.equal(del.disabled, true, '服务端拒删正被驱动的会话，菜单里不能给一个点了只会失败的按钮');
  assert.equal(del.hint, '先关闭会话才能删除');
});

test('sessionRowMenuItems: 还没落盘的新会话（无 id）只能关闭——无从标记、改名，也无从删除', () => {
  assert.deepEqual(actions(sessionRowMenuItems({ hasId: false, live: true, unread: false })), ['close']);
});
