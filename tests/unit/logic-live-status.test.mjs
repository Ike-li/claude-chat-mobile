// CLI 式动态状态行纯逻辑单测（零 DOM/零 token）：动词表/文案组装/thinking 秒数累计。
// 目标形态：✻ Stewing… (55s · ↓ 3.3k tokens · thought for 1s)——对齐 CLI，无工具后缀（命令由上方工具卡显示）
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SPINNER_VERBS,
  pickSpinnerVerb,
  formatCliSpinnerLine,
  advanceThinkingClock,
  TURN_DONE_VERBS,
  pickTurnDoneVerb,
  formatCliDuration,
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
