// tests/unit/logic-composer-mention.test.mjs —— composer「@ 文件引用」纯逻辑（零 token）
import test from 'node:test';
import assert from 'node:assert/strict';
import { detectAtMentionQuery, applyAtMentionPick } from '../../app/public/js/logic.js';

test.describe('detectAtMentionQuery（composer @ 文件引用触发检测）', () => {
  test('行首 @query → 命中，matchStart 指向 @ 本身', () => {
    assert.deepEqual(detectAtMentionQuery('@ap'), { query: 'ap', matchStart: 0 });
  });
  test('空白后 @query → 命中，matchStart 跳过前导空白', () => {
    assert.deepEqual(detectAtMentionQuery('hello @ap'), { query: 'ap', matchStart: 6 });
  });
  test('@ 后为空（刚打完 @）→ 命中，query 空串', () => {
    assert.deepEqual(detectAtMentionQuery('hello @'), { query: '', matchStart: 6 });
  });
  test('全角 ＠（部分中文输入法）与 ASCII @ 等价', () => {
    // 「看下 」2 汉字 + 空格 → index 2 起匹配「 ＠app」，＠ 在 match[0] 偏移 1 → matchStart=3
    assert.deepEqual(detectAtMentionQuery('看下 ＠app'), { query: 'app', matchStart: 3 });
    assert.deepEqual(detectAtMentionQuery('＠'), { query: '', matchStart: 0 });
  });
  test('query 含路径字符（. / -）', () => {
    assert.deepEqual(detectAtMentionQuery('see @src/app-v2.js'), { query: 'src/app-v2.js', matchStart: 4 });
  });
  test('@ 后跟空格再打字（提及已确认）→ 不命中', () => {
    assert.equal(detectAtMentionQuery('hello @foo bar'), null);
  });
  test('邮箱形态 user@host 结尾（@ 前是单词字符非空白/行首）→ 不命中', () => {
    assert.equal(detectAtMentionQuery('mail me at a@b'), null);
  });
  test('文本中无 @ → 不命中', () => {
    assert.equal(detectAtMentionQuery('no mention here'), null);
  });
  test('多个 @：只认最靠近光标（末尾）的一个', () => {
    assert.deepEqual(detectAtMentionQuery('check @foo and @bar'), { query: 'bar', matchStart: 15 });
  });
  test('空/非字符串输入安全', () => {
    assert.equal(detectAtMentionQuery(''), null);
    assert.equal(detectAtMentionQuery(undefined), null);
    assert.equal(detectAtMentionQuery(null), null);
  });
});

test.describe('applyAtMentionPick（选中候选后重写输入框文本）', () => {
  test('替换 @query 为路径+空格，光标落在空格之后', () => {
    const r = applyAtMentionPick('hello @ap', { matchStart: 6, cursorPos: 9, path: 'src/app.js' });
    assert.deepEqual(r, { text: 'hello src/app.js ', cursorPos: 17 });
  });
  test('@ 之后还有未变动的尾部文本（已带空格）→ 不重复补空格，原样保留尾部', () => {
    const r = applyAtMentionPick('see @ap for details', { matchStart: 4, cursorPos: 7, path: 'src/app.js' });
    assert.deepEqual(r, { text: 'see src/app.js for details', cursorPos: 14 });
  });
  test('@ 之后紧跟非空白字符（罕见：光标不在真末尾且无空格分隔）→ 仍补一个空格分隔', () => {
    const r = applyAtMentionPick('see @apX', { matchStart: 4, cursorPos: 7, path: 'src/app.js' });
    assert.deepEqual(r, { text: 'see src/app.js X', cursorPos: 15 });
  });
  test('行首 @query', () => {
    const r = applyAtMentionPick('@ap', { matchStart: 0, cursorPos: 3, path: 'app.js' });
    assert.deepEqual(r, { text: 'app.js ', cursorPos: 7 });
  });
});
