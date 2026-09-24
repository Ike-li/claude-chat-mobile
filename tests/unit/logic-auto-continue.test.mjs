// tests/unit/logic-auto-continue.test.mjs —— 额度墙自动继续横幅的纯判定（app/public/js/logic/auto-continue.js）
// 数据来自 instances 广播的 autoContinue（server/auto-continue.js 的 snapshot），按 sessionId 归键。
// 覆盖：只显示当前会话那条 · 三个相位各给什么文案与按钮 · stale 的四种原因各自说清「为什么没续」
//       · 时刻按看的人的本地时区、跨日补日期 · 坏数据不崩也不显示
// 不测：DOM 接线与点击发事件（S3，tests/e2e/specs/auto-continue.spec.ts）
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveAutoContinueBanner, formatAutoContinueClock } from '../../app/public/js/logic/auto-continue.js';
import { setLang } from '../../app/public/js/i18n.js';

// 时刻按「相对今天」构造：写死时间戳会让同日/跨日断言依赖测试的运行时刻（23:30 跑就翻车）
const todayAt = (h, m = 0) => { const d = new Date(); d.setHours(h, m, 0, 0); return d.getTime(); };
const NOW = todayAt(12, 0);
const entry = (over = {}) => ({
  sessionId: 's1', cwd: '/w', phase: 'armed', reason: null,
  resetsAt: todayAt(15, 50), fireAt: todayAt(15, 51), rateLimitType: 'five_hour', origin: 'auto', ...over,
});

test('formatAutoContinueClock：同日只印时分，跨日补月/日（只印时分会被读成今天）', () => {
  assert.equal(formatAutoContinueClock(todayAt(15, 50), NOW), '15:50');
  const d = new Date(todayAt(10, 0)); d.setDate(d.getDate() + 3);
  assert.equal(formatAutoContinueClock(d.getTime(), NOW), `${d.getMonth() + 1}/${d.getDate()} 10:00`);
  assert.equal(formatAutoContinueClock(NaN, NOW), '', '坏时刻宁可不印，也不印 1970');
});

test('只显示当前查看会话的那一条：别的会话布防了不该在这里冒出来', () => {
  assert.equal(resolveAutoContinueBanner([entry({ sessionId: 'other' })], 's1', NOW), null);
  assert.ok(resolveAutoContinueBanner([entry({ sessionId: 'other' }), entry()], 's1', NOW));
});

test('没有会话 / 没有条目 / 坏数据 → 不显示', () => {
  assert.equal(resolveAutoContinueBanner([entry()], null, NOW), null);
  assert.equal(resolveAutoContinueBanner([], 's1', NOW), null);
  assert.equal(resolveAutoContinueBanner(undefined, 's1', NOW), null);
  assert.equal(resolveAutoContinueBanner([null, 'x'], 's1', NOW), null);
  assert.equal(resolveAutoContinueBanner([entry({ phase: 'future_phase' })], 's1', NOW), null, '不认识的相位不瞎猜');
});

test('armed：说清几点自动继续，按钮是「取消」', () => {
  const b = resolveAutoContinueBanner([entry()], 's1', NOW);
  assert.match(b.text, /15:50/);
  assert.match(b.text, /自动继续/);
  assert.equal(b.action, 'cancel');
  assert.equal(b.actionLabel, '取消');
});

test('offered（开关关着）：告诉重置时刻，按钮是「到点自动继续」', () => {
  const b = resolveAutoContinueBanner([entry({ phase: 'offered', reason: 'disabled', fireAt: null })], 's1', NOW);
  assert.match(b.text, /15:50/);
  assert.equal(b.action, 'arm');
  assert.equal(b.actionLabel, '到点自动继续');
});

test('offered（重置点远于 24h）：说明为什么不自动等，按钮是「仍要到点继续」', () => {
  const d = new Date(todayAt(10, 0)); d.setDate(d.getDate() + 3);
  const b = resolveAutoContinueBanner([entry({ phase: 'offered', reason: 'horizon', resetsAt: d.getTime(), fireAt: null })], 's1', NOW);
  assert.match(b.text, /24 小时/);
  assert.match(b.text, new RegExp(`${d.getMonth() + 1}/${d.getDate()}`));
  assert.equal(b.action, 'arm');
  assert.equal(b.actionLabel, '仍要到点继续');
});

test('stale：每种原因都要说清为什么没自动继续，按钮是「继续」', () => {
  const cases = {
    slept: /休眠/,
    other_driver: /终端|桌面端/,
    unverified: /读不到.*记录/,
    resume_failed: /重新打开/,
  };
  for (const [reason, re] of Object.entries(cases)) {
    const b = resolveAutoContinueBanner([entry({ phase: 'stale', reason, fireAt: null })], 's1', NOW);
    assert.match(b.text, re, `reason=${reason}：不说原因，用户会以为功能坏了`);
    assert.equal(b.action, 'continueNow');
    assert.equal(b.actionLabel, '继续');
  }
});

test('stale 的未知原因仍给出通用说明与「继续」，不因为多一种原因就整条消失', () => {
  const b = resolveAutoContinueBanner([entry({ phase: 'stale', reason: 'something_new', fireAt: null })], 's1', NOW);
  assert.ok(b.text);
  assert.equal(b.action, 'continueNow');
});

test('英文界面：文案与按钮都有译文（中文原文漏出来就是词典缺项）', () => {
  setLang('en');
  try {
    const b = resolveAutoContinueBanner([entry()], 's1', NOW);
    assert.doesNotMatch(b.text + b.actionLabel, /[一-鿿]/);
  } finally {
    setLang('zh');
  }
});
