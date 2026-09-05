// tests/v2/logic-bg-tasks.test.mjs —— CLI 式动态状态行的 token 短格式边界
// 守护：DISPLAY-01（秒表行的 token 展示；与 statuslineFmtTok 是两份【有意不同】的实现，共同意图是不出现 "1000.0k"）
// 覆盖：k/m 抬升边界（含修复前会漏出 "1000.0k" 的那一档）· 省略 token 段的条件
// 槽位：S1（纯函数）
//
// 为什么单独有这一份：formatCliSpinnerLine 内联了一个 fmtTok，与 statusline.js 的
// statuslineFmtTok 是两份实现。差异是【有意】的——秒表行逐秒刷新，1 位小数能看出增长；
// 状态行是稳态展示，整数更干净。但两者共同的意图（不出现 "1000.0k"）此前只有 statusline 那份兑现：
// 这里的 `if (k >= 1000)` 是死代码（上一行已把 n >= 1e6 拦掉，此处 k 恒 < 1000），
// 于是 999999 实际输出 "1000.0k"，与它自己的注释「对齐 statuslineFmtTok 边界」正好相反。
// 2026-09-05 变异检查发现（该行的变异体存活 = 死代码的信号），修成按 999.95 判——
// 进位发生在 toFixed(1) 里，(999.95).toFixed(1) === '1000.0'。
//
// 不测什么 + 为什么：
//  ① 秒表行的其余段（thinking / effort / 安静期提示）—— 已在 tests/unit/logic-live-status.test.mjs
//     覆盖，本文件只补它漏掉的数值边界。
//  ② 两份 fmtTok 的输出格式统一 —— 差异是有意的（见上），不该被"统一"掉。
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatCliSpinnerLine } from '../../app/public/js/logic/bg-tasks.js';

const tokensSeg = n => formatCliSpinnerLine({ verb: 'Working', elapsedSec: 1, outTokens: n });

test.describe('formatCliSpinnerLine 的 token 短格式', () => {
  test('不足 1k 显示原值，1000 起进 k 档（带 1 位小数）', () => {
    assert.match(tokensSeg(999), /↓ 999 tokens/);
    assert.match(tokensSeg(1000), /↓ 1\.0k tokens/);
    assert.match(tokensSeg(1500), /↓ 1\.5k tokens/);
  });

  test('★ 抬 m 的边界：999950 起不得再出现 "1000.0k"', () => {
    // 修复前这里输出 "1000.0k" —— 一个自相矛盾的量纲（都到 1000k 了还不抬 m），
    // 而函数自己的注释声称已经对齐了 statuslineFmtTok。
    assert.match(tokensSeg(999949), /↓ 999\.9k tokens/, '差一点就不抬');
    assert.match(tokensSeg(999950), /↓ 1\.0m tokens/, 'toFixed(1) 会把 999.95 进位成 1000.0，必须提前抬');
    assert.match(tokensSeg(999999), /↓ 1\.0m tokens/);
    assert.match(tokensSeg(1e6), /↓ 1\.0m tokens/);

    for (const n of [999950, 999999, 1234567]) {
      assert.ok(!tokensSeg(n).includes('1000.0k'), `${n} 不得渲染成 1000.0k`);
    }
  });

  test('没有 token 读数时整段省略，不显示 "↓ 0 tokens" 或 NaN', () => {
    // 内联的 fmtTok 没有 Number.isFinite 守卫（statuslineFmtTok 有），
    // 靠调用点的 `Number.isFinite(outTokens) && outTokens > 0` 挡住。这条钉的是那道调用点闸。
    for (const n of [null, undefined, 0, -1, NaN, Infinity]) {
      const line = tokensSeg(n);
      assert.ok(!line.includes('tokens'), `outTokens=${String(n)} 时不该出现 token 段，实际：${line}`);
      assert.ok(!line.includes('NaN'), 'NaN 绝不能印到状态行上');
    }
  });
});
