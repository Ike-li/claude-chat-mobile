// tests/unit/logic-session-search.test.mjs —— 会话抽屉的标题搜索（纯函数）
// 覆盖：空/空白 query 全匹配 · 大小写不敏感子串 · 搜索键的收集顺序（summary/aiTitle/首条 user 文本）
//       · remainingOlderSessionCount 折叠计数
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  matchesSessionTitle,
  remainingOlderSessionCount,
  sessionTitleSearchKeys,
  matchesSessionSearch,
  resolveSessionListTitle,
  sanitizeNotifySessionTitle,
  formatNotifyIdentity,
  notifySessionTag,
  lookupNotifySessionTitle,
  otherWorkspaceNotifyOpts,
  displaySessionTitle,
} from '../../app/public/js/logic/session-search.js';
import { setLang } from '../../app/public/js/i18n.js';

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

// 验收 AC-04-13：手动标「稍后再看」、被分页挤出本页的会话由服务端放进 pinned 补回列表，它们也是看得见的行。
// 只减本页行数时，73 个会话、50 + 1 行可见，提示写「还有 23 个」，实际只藏了 22 个。
test('remainingOlderSessionCount: 补回的「稍后再看」行也算可见，不再计进「还有 N 个」', () => {
  assert.equal(remainingOlderSessionCount(73, 50, 1), 22);
  assert.equal(remainingOlderSessionCount(51, 50, 1), null, '页内 + 补回正好等于总数时没有更早的会话');
  assert.equal(remainingOlderSessionCount(60, 50, 0), 10, '没有补回行时与原来一致');
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

// 验收 O42 / O75：服务端给无标题会话写死占位「(无标题)」（通知层与 cross-side-parity 认这个字面量，不动），
// 前端的 `s.title || t(...)` 兜底因此永远走不到，英文界面上照样是「(无标题)」。
test('displaySessionTitle: 服务端占位按界面语言显示；空值用调用方给的兜底；正常标题原样', () => {
  setLang('en');
  try {
    assert.equal(displaySessionTitle('(无标题)', 'New session'), 'Untitled session');
  } finally {
    setLang('zh');
  }
  assert.equal(displaySessionTitle('(无标题)', '新会话'), '无标题会话');
  assert.equal(displaySessionTitle('', '新会话'), '新会话');
  assert.equal(displaySessionTitle(undefined, '新会话'), '新会话');
  assert.equal(displaySessionTitle('修个 bug', '新会话'), '修个 bug');
});

test('formatNotifyIdentity: 事件 · 项目 · 会话，缺项跳过、占位标题丢弃', () => {
  assert.equal(
    formatNotifyIdentity('✅ 任务完成', { cwd: '/a/claude-chat-mobile', sessionTitle: '独立审查 count_tokens 缓存' }),
    '✅ 任务完成 · claude-chat-mobile · 独立审查 count_tokens 缓存',
  );
  assert.equal(formatNotifyIdentity('✅ 任务完成', { cwd: '/a/proj', sessionTitle: '新会话' }), '✅ 任务完成 · proj');
  assert.equal(formatNotifyIdentity('⚠️ 等待审批', { cwd: '/a/proj' }), '⚠️ 等待审批 · proj');
  assert.equal(formatNotifyIdentity('', { cwd: '/a/proj', sessionTitle: '修登录' }), 'proj · 修登录');
});

test('sanitizeNotifySessionTitle: 换行压成单行，超长截断', () => {
  assert.equal(sanitizeNotifySessionTitle('hello\nworld'), 'hello world');
  assert.equal(sanitizeNotifySessionTitle('x'.repeat(80)).length, 41);
});

test('notifySessionTag: 按会话分组，缺 id 回落共用槽', () => {
  assert.equal(notifySessionTag('abc-123'), 'ccm-abc-123');
  assert.equal(notifySessionTag(''), 'ccm-push');
  assert.equal(notifySessionTag(null), 'ccm-push');
});

test('lookupNotifySessionTitle: 抽屉缓存优先于 instance.firstMessage，占位丢弃', () => {
  const sessionsCache = new Map([
    ['/a/proj', { sessions: [{ id: 's1', title: '抽屉可见标题' }] }],
  ]);
  const instances = [{ sessionId: 's1', title: '首条用户消息截断' }, { sessionId: 's2', title: '新会话' }];
  assert.equal(lookupNotifySessionTitle({ sessionId: 's1', cwd: '/a/proj', sessionsCache, instances }), '抽屉可见标题');
  assert.equal(lookupNotifySessionTitle({ sessionId: 's2', cwd: '/a/proj', sessionsCache, instances }), '');
  assert.equal(lookupNotifySessionTitle({ sessionId: 's3', cwd: '/a/proj', sessionsCache, instances: [{ sessionId: 's3', title: '仅 instance 有' }] }), '仅 instance 有');
  assert.equal(lookupNotifySessionTitle({ sessionId: null, cwd: '/a/proj', sessionsCache, instances }), '');
});

// cwd 聚合态（notifyStateChanges）分不出是哪条会话：同目录先完成的 A 和刚完成的 B 都是 done，
// find(cwd+state) 会命中插入序更早的 A。这条路径只标项目、禁止绑 sessionId。
test('otherWorkspaceNotifyOpts: 不绑具体会话，tag 按项目分组', () => {
  const opts = otherWorkspaceNotifyOpts('/Users/x/code/claude-chat-mobile');
  assert.equal(opts.sessionId, null);
  assert.equal(opts.cwd, '/Users/x/code/claude-chat-mobile');
  assert.equal(opts.tag, 'ccm-cwd-claude-chat-mobile');
  assert.equal(otherWorkspaceNotifyOpts('').tag, 'ccm-push');
});
