// CLI 式动态状态行纯逻辑单测（零 DOM/零 token）：动词表/文案组装/thinking 秒数累计。
// 目标形态：✻ Stewing… (55s · ↓ 3.3k tokens · thought for 1s)[ · 🖥 npm test]
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SPINNER_VERBS,
  pickSpinnerVerb,
  formatCliSpinnerLine,
  advanceThinkingClock,
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

test('formatCliSpinnerLine: 工具文案作括号外后缀段', () => {
  assert.equal(
    formatCliSpinnerLine({ verb: 'Forging', elapsedSec: 58, outTokens: 3400, toolText: '🖥 npm test' }),
    '✻ Forging… (58s · ↓ 3.4k tokens) · 🖥 npm test',
  );
});

test('formatCliSpinnerLine: 缺 verb/负秒数防御', () => {
  assert.equal(formatCliSpinnerLine({ elapsedSec: -3 }), '✻ Working… (0s)');
  assert.equal(formatCliSpinnerLine(), '✻ Working… (0s)');
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
