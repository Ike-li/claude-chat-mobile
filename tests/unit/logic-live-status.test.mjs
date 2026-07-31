// CLI 式动态状态行纯逻辑单测（零 DOM/零 token）：动词表/文案组装/thinking 秒数累计。
// 目标形态：✻ Stewing… (55s · ↓ 3.3k tokens · thought for 1s)——对齐 CLI，无工具后缀（命令由上方工具卡显示）
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SPINNER_VERBS,
  pickSpinnerVerb,
  formatCliSpinnerLine,
  formatCliRetryLine,
  advanceThinkingClock,
  TURN_DONE_VERBS,
  pickTurnDoneVerb,
  formatCliDuration,
  LIVE_STALE_HINT_SEC,
  LIVE_STALE_WARN_SEC,
  resolveLiveWaitPhase,
} from '../../public/js/logic.js';

test('SPINNER_VERBS: 非空冻结词表，含 CLI 同款动词', () => {
  assert.ok(Array.isArray(SPINNER_VERBS) && SPINNER_VERBS.length > 50);
  assert.ok(Object.isFrozen(SPINNER_VERBS));
  for (const v of ['Stewing', 'Pondering', 'Noodling', 'Simmering', 'Clauding']) {
    assert.ok(SPINNER_VERBS.includes(v), `缺 ${v}`);
  }
});

test('pickSpinnerVerb: 注入 rand 确定性 + 返回值属于词表', () => {
  assert.equal(pickSpinnerVerb(() => 0), SPINNER_VERBS[0]);
  assert.equal(pickSpinnerVerb(() => 0.999999), SPINNER_VERBS[SPINNER_VERBS.length - 1]);
  assert.ok(SPINNER_VERBS.includes(pickSpinnerVerb()));
});

test('formatCliSpinnerLine: 最小形态只有动词+秒数', () => {
  assert.equal(formatCliSpinnerLine({ verb: 'Stewing', elapsedSec: 55 }), '✻ Stewing… (55s)');
});

test('formatCliSpinnerLine: token 段 1 位小数 k/m，0/null 省略', () => {
  assert.equal(formatCliSpinnerLine({ verb: 'Brewing', elapsedSec: 3, outTokens: 999 }), '✻ Brewing… (3s · ↓ 999 tokens)');
  assert.equal(formatCliSpinnerLine({ verb: 'Brewing', elapsedSec: 3, outTokens: 3300 }), '✻ Brewing… (3s · ↓ 3.3k tokens)');
  assert.equal(formatCliSpinnerLine({ verb: 'Brewing', elapsedSec: 3, outTokens: 1200000 }), '✻ Brewing… (3s · ↓ 1.2m tokens)');
  assert.equal(formatCliSpinnerLine({ verb: 'Brewing', elapsedSec: 3, outTokens: 0 }), '✻ Brewing… (3s)');
  assert.equal(formatCliSpinnerLine({ verb: 'Brewing', elapsedSec: 3, outTokens: null }), '✻ Brewing… (3s)');
});

test('formatCliSpinnerLine: thinking 进行中带 effort', () => {
  assert.equal(
    formatCliSpinnerLine({ verb: 'Musing', elapsedSec: 12, outTokens: 1200, thinking: { state: 'active', ms: 800 }, effort: 'xhigh' }),
    '✻ Musing… (12s · ↓ 1.2k tokens · thinking with xhigh effort)',
  );
});

test('formatCliSpinnerLine: thinking 进行中无 effort 退化为 thinking…', () => {
  assert.equal(
    formatCliSpinnerLine({ verb: 'Musing', elapsedSec: 2, thinking: { state: 'active', ms: 300 } }),
    '✻ Musing… (2s · thinking…)',
  );
});

test('formatCliSpinnerLine: thinking 结束 thought for Ns，四舍五入且下限 1s', () => {
  assert.equal(
    formatCliSpinnerLine({ verb: 'Stewing', elapsedSec: 55, outTokens: 3300, thinking: { state: 'done', ms: 1400 } }),
    '✻ Stewing… (55s · ↓ 3.3k tokens · thought for 1s)',
  );
  assert.equal(
    formatCliSpinnerLine({ verb: 'Stewing', elapsedSec: 55, thinking: { state: 'done', ms: 2600 } }),
    '✻ Stewing… (55s · thought for 3s)',
  );
  // 极短 thinking（<500ms）也不显示 0s
  assert.equal(
    formatCliSpinnerLine({ verb: 'Stewing', elapsedSec: 5, thinking: { state: 'done', ms: 120 } }),
    '✻ Stewing… (5s · thought for 1s)',
  );
});

test('formatCliSpinnerLine: 对齐 CLI 不拼工具后缀段（多余 toolText 参数被忽略）', () => {
  assert.equal(
    formatCliSpinnerLine({ verb: 'Forging', elapsedSec: 58, outTokens: 3400, toolText: '🖥 npm test' }),
    '✻ Forging… (58s · ↓ 3.4k tokens)',
  );
});

test('formatCliSpinnerLine: 缺 verb/负秒数防御', () => {
  assert.equal(formatCliSpinnerLine({ elapsedSec: -3 }), '✻ Working… (0s)');
  assert.equal(formatCliSpinnerLine(), '✻ Working… (0s)');
});

// 距上次事件的安静期提示：纯前端心理预期管理，与服务端 10 分钟 idleTimeout 独立。
test('LIVE_STALE_* 阈值：hint=20s / warn=60s', () => {
  assert.equal(LIVE_STALE_HINT_SEC, 20);
  assert.equal(LIVE_STALE_WARN_SEC, 60);
});

test('formatCliSpinnerLine: sinceLastEventSec 未达阈值不追加', () => {
  assert.equal(
    formatCliSpinnerLine({ verb: 'Stewing', elapsedSec: 10, sinceLastEventSec: null }),
    '✻ Stewing… (10s)',
  );
  assert.equal(
    formatCliSpinnerLine({ verb: 'Stewing', elapsedSec: 10, sinceLastEventSec: 19 }),
    '✻ Stewing… (10s)',
  );
});

test('formatCliSpinnerLine: sinceLastEventSec≥hint 追加「仍在等待响应」', () => {
  assert.equal(
    formatCliSpinnerLine({ verb: 'Stewing', elapsedSec: 30, sinceLastEventSec: 20 }),
    '✻ Stewing… (30s · 仍在等待响应)',
  );
  assert.equal(
    formatCliSpinnerLine({ verb: 'Brewing', elapsedSec: 30, outTokens: 3300, sinceLastEventSec: 25 }),
    '✻ Brewing… (30s · ↓ 3.3k tokens · 仍在等待响应)',
  );
});

test('formatCliSpinnerLine: sinceLastEventSec≥warn 追加「响应较慢…」且两级不叠加', () => {
  assert.equal(
    formatCliSpinnerLine({ verb: 'Stewing', elapsedSec: 90, sinceLastEventSec: 60 }),
    '✻ Stewing… (90s · 响应较慢，可能是深度思考或网络问题)',
  );
  // thinking 段之后再追加提示
  assert.equal(
    formatCliSpinnerLine({
      verb: 'Musing',
      elapsedSec: 90,
      thinking: { state: 'active', ms: 800 },
      effort: 'xhigh',
      sinceLastEventSec: 75,
    }),
    '✻ Musing… (90s · thinking with xhigh effort · 响应较慢，可能是深度思考或网络问题)',
  );
  // 不含 hint 文案
  assert.ok(
    !formatCliSpinnerLine({ verb: 'Stewing', elapsedSec: 90, sinceLastEventSec: 60 }).includes('仍在等待响应'),
  );
});

// API 重试态：CLI 会把整条 spinner 行顶替成 "✻ API error · Retrying in 4s · attempt 2/10"
// （retryStatus ? 重试行 : spinner 行 的二选一，不是往括号里加段）。web 对齐同一语义。
// 注意 SDK 的 api_retry payload 只有状态码+错误枚举、没有上游报文原文——原文只能等终态 error 事件。
test('formatCliRetryLine: 有 errorStatus → API 错误 + 状态码 + 活倒计时 + 尝试次数', () => {
  assert.equal(
    formatCliRetryLine({ attempt: 2, maxRetries: 10, remainingSec: 4, errorStatus: 503 }),
    '✻ API 错误 503 · 4s 后重试 · 第 2/10 次',
  );
  assert.equal(
    formatCliRetryLine({ attempt: 1, maxRetries: 10, remainingSec: 1, errorStatus: 429 }),
    '✻ API 错误 429 · 1s 后重试 · 第 1/10 次',
  );
});

// errorStatus 为 null 是真实高频形态（连接超时无 HTTP 响应），须走独立文案而非显示 undefined。
test('formatCliRetryLine: 无 errorStatus → 等待 API 响应，并追加「检查网络」', () => {
  assert.equal(
    formatCliRetryLine({ attempt: 2, maxRetries: 10, remainingSec: 8, errorStatus: null }),
    '✻ 等待 API 响应 · 8s 后重试 · 第 2/10 次 · 检查网络',
  );
  assert.equal(
    formatCliRetryLine({ attempt: 2, maxRetries: 10, remainingSec: 8 }),
    '✻ 等待 API 响应 · 8s 后重试 · 第 2/10 次 · 检查网络',
  );
});

test('formatCliRetryLine: 倒计时归零仍显示（马上重试），负数钳到 0', () => {
  assert.equal(
    formatCliRetryLine({ attempt: 3, maxRetries: 10, remainingSec: 0, errorStatus: 500 }),
    '✻ API 错误 500 · 0s 后重试 · 第 3/10 次',
  );
  assert.equal(
    formatCliRetryLine({ attempt: 3, maxRetries: 10, remainingSec: -2, errorStatus: 500 }),
    '✻ API 错误 500 · 0s 后重试 · 第 3/10 次',
  );
});

test('formatCliRetryLine: remainingSec 缺失 → 省略倒计时段（不伪造 0s）', () => {
  assert.equal(
    formatCliRetryLine({ attempt: 2, maxRetries: 10, errorStatus: 503 }),
    '✻ API 错误 503 · 第 2/10 次',
  );
});

test('formatCliRetryLine: attempt/maxRetries 缺失降级', () => {
  // 只有 attempt → 第 N 次
  assert.equal(
    formatCliRetryLine({ attempt: 2, remainingSec: 4, errorStatus: 503 }),
    '✻ API 错误 503 · 4s 后重试 · 第 2 次',
  );
  // 都没有 → 省略该段
  assert.equal(
    formatCliRetryLine({ remainingSec: 4, errorStatus: 503 }),
    '✻ API 错误 503 · 4s 后重试',
  );
  // 全空防御
  assert.equal(formatCliRetryLine(), '✻ 等待 API 响应 · 检查网络');
});

test('formatCliRetryLine: 非数字 errorStatus 按无状态码处理', () => {
  assert.equal(
    formatCliRetryLine({ attempt: 1, maxRetries: 10, remainingSec: 2, errorStatus: 'boom' }),
    '✻ 等待 API 响应 · 2s 后重试 · 第 1/10 次 · 检查网络',
  );
});

test('resolveLiveWaitPhase: sendInFlight 优先；否则按 sawContentDelta 分 waiting/responding', () => {
  assert.equal(resolveLiveWaitPhase({ sendInFlight: true, sawContentDelta: true }), 'sending');
  assert.equal(resolveLiveWaitPhase({ sendInFlight: true, sawContentDelta: false }), 'sending');
  assert.equal(resolveLiveWaitPhase({ sendInFlight: false, sawContentDelta: false }), 'waiting');
  assert.equal(resolveLiveWaitPhase({ sendInFlight: false, sawContentDelta: true }), 'responding');
  // 缺省防御
  assert.equal(resolveLiveWaitPhase({}), 'waiting');
  assert.equal(resolveLiveWaitPhase(), 'waiting');
});

// 回合收尾行（对齐 CLI turn_duration：✻ Cogitated for 8s）——过去式动词表是独立于活 spinner 的另一套。
test('TURN_DONE_VERBS: CLI 同款 8 词冻结表', () => {
  assert.ok(Object.isFrozen(TURN_DONE_VERBS));
  assert.deepEqual([...TURN_DONE_VERBS], ['Baked', 'Brewed', 'Churned', 'Cogitated', 'Cooked', 'Crunched', 'Sautéed', 'Worked']);
});

test('pickTurnDoneVerb: 注入 rand 确定性 + 兜底 Worked', () => {
  assert.equal(pickTurnDoneVerb(() => 0), 'Baked');
  assert.equal(pickTurnDoneVerb(() => 0.999999), 'Worked');
  assert.equal(pickTurnDoneVerb(() => 3 / 8), 'Cogitated'); // 索引 3
  assert.ok(TURN_DONE_VERBS.includes(pickTurnDoneVerb()));
});

test('formatCliDuration: <60s 整秒下取整', () => {
  assert.equal(formatCliDuration(0), '0s');
  assert.equal(formatCliDuration(8500), '8s');
  assert.equal(formatCliDuration(59999), '59s');
});

test('formatCliDuration: ≥60s 逐位，秒四舍五入且逢 60 进位', () => {
  assert.equal(formatCliDuration(60000), '1m 0s');
  assert.equal(formatCliDuration(169000), '2m 49s');
  assert.equal(formatCliDuration(119999), '2m 0s'); // 59.999s round→60 进位到 2m 0s
  assert.equal(formatCliDuration(3723000), '1h 2m 3s');
  assert.equal(formatCliDuration(93784000), '1d 2h 3m'); // 天级不带秒（对齐 CLI Hs）
});

test('formatCliDuration: 负数/非数防御 → 0s', () => {
  assert.equal(formatCliDuration(-3), '0s');
  assert.equal(formatCliDuration(NaN), '0s');
  assert.equal(formatCliDuration('x'), '0s');
  assert.equal(formatCliDuration(), '0s');
});

test('advanceThinkingClock: 首帧只记 lastTs 不累计', () => {
  const out = advanceThinkingClock({ ms: 0, lastTs: 0 }, 10_000);
  assert.deepEqual(out, { ms: 0, lastTs: 10_000 });
});

test('advanceThinkingClock: gap 内累计间隔', () => {
  let s = advanceThinkingClock({ ms: 0, lastTs: 0 }, 10_000);
  s = advanceThinkingClock(s, 10_400);
  s = advanceThinkingClock(s, 11_000);
  assert.deepEqual(s, { ms: 1000, lastTs: 11_000 });
});

test('advanceThinkingClock: 超 gap 视为新 burst 不补空档', () => {
  let s = advanceThinkingClock({ ms: 500, lastTs: 10_000 }, 20_000); // gap 默认 2000ms，跳过 10s 空档
  assert.deepEqual(s, { ms: 500, lastTs: 20_000 });
  s = advanceThinkingClock(s, 20_300); // 新 burst 内继续累计
  assert.deepEqual(s, { ms: 800, lastTs: 20_300 });
});
