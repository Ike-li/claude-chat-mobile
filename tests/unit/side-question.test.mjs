// tests/unit/side-question.test.mjs —— 两个旁路提问（下一步建议 / 回来时的摘要）的准入判据与回复归一。
// 零 token、纯函数：时钟一律由参数传入，不 sleep。
//
// 这两个功能的失败方向是刻意选的：**宁可不出现，也不要出现得不合时宜**。所以下面每一条
// 「不该出现」的用例都比「该出现」的那条更重要——判据写松了不会报错，只会让用户被打扰。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  shouldRecap,
  shouldSuggest,
  normalizeSideAnswer,
  RECAP_MIN_AWAY_MS,
  RECAP_MIN_INTERVAL_MS,
  RECAP_MIN_ASSISTANT_TURNS,
  RECAP_PROMPT,
  SUGGEST_PROMPT,
} from '../../app/src/agent/side-question.js';

const NOW = 1_800_000_000_000;
const okRecap = {
  awayMs: RECAP_MIN_AWAY_MS + 1, assistantTurns: RECAP_MIN_ASSISTANT_TURNS,
  lastRecapAt: 0, now: NOW, isBusy: false, enabled: true,
};

test.describe('shouldRecap：只在「真的离开过、真的有进展、屏幕不在滚」时给', () => {
  test('基准形状 → true（防下面每条否定用例都因为基准就是 false 而恒绿）', () => {
    assert.equal(shouldRecap(okRecap), true);
  });

  test('离开时长不足 → false（切一下后台就回来不算「离开」）', () => {
    assert.equal(shouldRecap({ ...okRecap, awayMs: RECAP_MIN_AWAY_MS - 1 }), false);
    assert.equal(shouldRecap({ ...okRecap, awayMs: 0 }), false);
    // 边界本身要给：恰好等于阈值算「够久」，否则阈值语义变成「严格大于」而与文档不符
    assert.equal(shouldRecap({ ...okRecap, awayMs: RECAP_MIN_AWAY_MS }), true);
  });

  test('会话还没实质进展 → false', () => {
    assert.equal(shouldRecap({ ...okRecap, assistantTurns: RECAP_MIN_ASSISTANT_TURNS - 1 }), false);
    assert.equal(shouldRecap({ ...okRecap, assistantTurns: 0 }), false);
  });

  test('正在跑 → false（用户回来看到的是实时进度，摘要只会和它打架）', () => {
    assert.equal(shouldRecap({ ...okRecap, isBusy: true }), false);
  });

  test('距上次摘要不足最小间隔 → false（反复进出只给一次）', () => {
    assert.equal(shouldRecap({ ...okRecap, lastRecapAt: NOW - RECAP_MIN_INTERVAL_MS + 1 }), false);
    assert.equal(shouldRecap({ ...okRecap, lastRecapAt: NOW - RECAP_MIN_INTERVAL_MS }), true);
  });

  test('lastRecapAt=0 表示本会话还没给过 → 首次不受间隔约束', () => {
    // 若实现把 0 也拿去做减法，now-0 是个巨大的差值、恰好也 >= 间隔，这条会假绿；
    // 所以再给一个「now 很小」的场景，让「没特判 0」的实现必然算出不足间隔而返回 false。
    assert.equal(shouldRecap({ ...okRecap, lastRecapAt: 0, now: 1000 }), true);
  });

  test('开关关掉 → false（且优先于其它一切判据）', () => {
    assert.equal(shouldRecap({ ...okRecap, enabled: false }), false);
  });

  test('空参数 → false（缺省绝不能是「给」）', () => {
    assert.equal(shouldRecap(), false);
    assert.equal(shouldRecap({}), false);
  });
});

test.describe('shouldSuggest：出错/被中断的那一轮不猜', () => {
  const okSuggest = { assistantTurns: 2, isError: false, interrupted: false, enabled: true };

  test('基准形状 → true', () => {
    assert.equal(shouldSuggest(okSuggest), true);
  });

  test('本轮出错 → false（用户要判断的是刚才发生了什么）', () => {
    assert.equal(shouldSuggest({ ...okSuggest, isError: true }), false);
  });

  test('本轮被中断 → false', () => {
    assert.equal(shouldSuggest({ ...okSuggest, interrupted: true }), false);
  });

  test('只聊过一轮 → false（一次往返猜不准下一步）', () => {
    assert.equal(shouldSuggest({ ...okSuggest, assistantTurns: 1 }), false);
    assert.equal(shouldSuggest({ ...okSuggest, assistantTurns: 0 }), false);
  });

  test('开关关掉 → false', () => {
    assert.equal(shouldSuggest({ ...okSuggest, enabled: false }), false);
  });

  test('空参数 → false', () => {
    assert.equal(shouldSuggest(), false);
    assert.equal(shouldSuggest({}), false);
  });
});

test.describe('normalizeSideAnswer：空回复不渲染、裸文本可直接填进输入框', () => {
  test('空 / 纯空白 / 非字符串 → null（模型判断「没什么可说」时按提示词返回空）', () => {
    for (const bad of ['', '   ', '\n\t ', null, undefined, 42, {}, []]) {
      assert.equal(normalizeSideAnswer(bad), null, `期望 null: ${JSON.stringify(bad)}`);
    }
  });

  test('去掉整句包裹的引号（带引号填进输入框很碍事）', () => {
    assert.equal(normalizeSideAnswer('"run the tests"'), 'run the tests');
    assert.equal(normalizeSideAnswer('「跑一下测试」'), '跑一下测试');
    assert.equal(normalizeSideAnswer('  "跑一下测试"  '), '跑一下测试');
  });

  test('句【内】的引号不动（只剥首尾成对的那层）', () => {
    assert.equal(normalizeSideAnswer('把 "foo" 改成 "bar"'), '把 "foo" 改成 "bar"');
    assert.equal(normalizeSideAnswer('说了句 "hi'), '说了句 "hi');
  });

  test('只剥一层：剥完仍是空 → null', () => {
    assert.equal(normalizeSideAnswer('""'), null);
    assert.equal(normalizeSideAnswer('「」'), null);
  });

  test('超长截断并加省略号（契约是「一句话」，模型跑题时不该占满屏幕）', () => {
    const long = 'x'.repeat(500);
    const out = normalizeSideAnswer(long, { maxChars: 400 });
    assert.equal(out.length, 401);          // 400 + 省略号
    assert.ok(out.endsWith('…'));
    // 不足上限的不加省略号——否则每条建议末尾都挂一个假的「还有更多」
    assert.equal(normalizeSideAnswer('短句', { maxChars: 400 }), '短句');
  });
});

test.describe('提示词：两条硬要求写进了文本本身', () => {
  test('都要求「不确定就沉默」——这是失败方向的唯一载体', () => {
    assert.match(RECAP_PROMPT, /reply with nothing/i);
    assert.match(SUGGEST_PROMPT, /reply with nothing/i);
  });
  test('都不指定输出语言（跟随会话语言，实测中文会话得到中文回复）', () => {
    for (const p of [RECAP_PROMPT, SUGGEST_PROMPT]) {
      assert.doesNotMatch(p, /in English|reply in [A-Z]/);
    }
  });
});

// completedTurns 只数**本进程看见的** result。重启或空闲回收之后 resume 回来时它是 0，于是这两道
// 「首轮不猜 / 没什么可摘要」的门槛会把一个聊了半天的老会话当成刚开的：回来时的摘要要再攒两轮才跑，
// 第一轮的下一步建议直接被抑制——而 askSideQuestion 拿得到完整上下文，本来就答得出来。
// hasPriorHistory 表达的正是「本进程之外已经聊过」，不是精确轮数。
test.describe('hasPriorHistory：resume 回来的老会话不该被当成刚开的', () => {
  test('shouldSuggest：0 轮但有历史 → 给建议', () => {
    assert.equal(shouldSuggest({ assistantTurns: 0, hasPriorHistory: true }), true);
  });

  test('shouldSuggest：0 轮且没有历史 → 仍然不给（首轮不猜的门槛不能被顺手拆掉）', () => {
    assert.equal(shouldSuggest({ assistantTurns: 0, hasPriorHistory: false }), false);
    assert.equal(shouldSuggest({ assistantTurns: 1 }), false);
  });

  test('shouldSuggest：有历史也压不过出错/被中断', () => {
    assert.equal(shouldSuggest({ assistantTurns: 0, hasPriorHistory: true, isError: true }), false);
    assert.equal(shouldSuggest({ assistantTurns: 0, hasPriorHistory: true, interrupted: true }), false);
    assert.equal(shouldSuggest({ assistantTurns: 0, hasPriorHistory: true, enabled: false }), false);
  });

  test('shouldRecap：0 轮但有历史 → 给摘要（其余门槛照旧）', () => {
    const base = { awayMs: 10 * 60_000, assistantTurns: 0, now: 1_000_000 };
    assert.equal(shouldRecap({ ...base, hasPriorHistory: true }), true);
    assert.equal(shouldRecap({ ...base, hasPriorHistory: false }), false);
  });

  test('shouldRecap：有历史也压不过「离开不够久」与「正在跑」', () => {
    assert.equal(shouldRecap({ awayMs: 60_000, assistantTurns: 0, hasPriorHistory: true, now: 1 }), false);
    assert.equal(shouldRecap({ awayMs: 10 * 60_000, assistantTurns: 0, hasPriorHistory: true, isBusy: true, now: 1 }), false);
  });
});
