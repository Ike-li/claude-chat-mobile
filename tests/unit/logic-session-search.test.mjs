import test from 'node:test';
import assert from 'node:assert/strict';
import {
  matchesSessionTitle,
  remainingOlderSessionCount,
  sessionTitleSearchKeys,
  matchesSessionSearch,
  resolveSessionListTitle,
} from '../../public/js/logic/session-search.js';

test('matchesSessionTitle: 空/空白 query 全匹配', () => {
  assert.equal(matchesSessionTitle('Hello', ''), true);
  assert.equal(matchesSessionTitle('Hello', '   '), true);
  assert.equal(matchesSessionTitle('Hello', null), true);
});

test('matchesSessionTitle: 大小写不敏感子串', () => {
  assert.equal(matchesSessionTitle('Alpha Plan', 'alpha'), true);
  assert.equal(matchesSessionTitle('ALPHA notes', 'pha n'), true);
  assert.equal(matchesSessionTitle('beta', 'alpha'), false);
});

test('remainingOlderSessionCount: total>visible 时返回差值', () => {
  assert.equal(remainingOlderSessionCount(60, 50), 10);
  assert.equal(remainingOlderSessionCount(50, 50), null);
  assert.equal(remainingOlderSessionCount(null, 50), null);
  assert.equal(remainingOlderSessionCount(10, 50), null);
});

test('sessionTitleSearchKeys: 收集 summary/aiTitle/firstUser/firstCmd，去掉空白', () => {
  assert.deepEqual(
    sessionTitleSearchKeys({
      summary: 'CLI /resume 标题',
      aiTitle: 'AI 生成标题',
      firstUser: '首条用户问题',
      firstCmd: '/compact',
    }),
    ['CLI /resume 标题', 'AI 生成标题', '首条用户问题', '/compact'],
  );
  assert.deepEqual(sessionTitleSearchKeys({ summary: '  ', aiTitle: null, firstUser: '' }), []);
});

test('matchesSessionSearch: 任一键命中即可（抽屉可见 summary ≠ readHeadMeta 时仍能搜到）', () => {
  const keys = sessionTitleSearchKeys({
    summary: 'Renamed Visible Title',
    firstUser: 'hello world from the first prompt',
  });
  assert.equal(matchesSessionSearch(keys, 'Renamed Visible'), true);
  assert.equal(matchesSessionSearch(keys, 'HELLO WORLD'), true);
  assert.equal(matchesSessionSearch(keys, 'nope'), false);
  assert.equal(matchesSessionSearch(keys, '  '), true);
});

test('matchesSessionSearch: firstUser 超过展示 60 字的尾部仍能命中', () => {
  const firstUser = `${'x'.repeat(80)}UniqueTailToken`;
  const keys = sessionTitleSearchKeys({ firstUser, aiTitle: firstUser.slice(0, 60) });
  assert.equal(matchesSessionSearch(keys, 'UniqueTailToken'), true);
});

test('resolveSessionListTitle: 展示优先 SDK summary（与浏览行同源），否则 meta，再否则占位', () => {
  assert.equal(resolveSessionListTitle({ summary: 'CLI /resume 同款标题', metaTitle: '首条用户' }), 'CLI /resume 同款标题');
  assert.equal(resolveSessionListTitle({ summary: '', metaTitle: '首条用户' }), '首条用户');
  assert.equal(resolveSessionListTitle({}), '(无标题)');
  assert.equal(resolveSessionListTitle({ metaTitle: 'y'.repeat(80) }), 'y'.repeat(60));
});
