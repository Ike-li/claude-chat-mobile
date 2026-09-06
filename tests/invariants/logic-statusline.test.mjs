// tests/invariants/logic-statusline.test.mjs —— 状态行前端展示逻辑：取值优先级、边界、diff
// 守护：DISPLAY-01（statusline 的展示语义；契约见 docs/display-contracts.md）
// 覆盖：token 短格式的 k/m 抬升边界 · git 三选一 · ctx 剩余量的四档取值优先级与 0/负值语义 · 复制文本的来源标签 · Edit 卡 diff 的 LCS 边界
// 槽位：S1（纯函数，数据进数据出，不碰 DOM/window/socket）
//
// 为什么单开这一份：2026-09-05 用变异量了全部 16 个 app/public/js/logic 模块，中位 kill rate 88%，
// 而 statusline.js 是 22/36 = 61%，垫底（permissions.js 的 36% 与 format.js 的 0% 分母分别只有
// 11 和 1，属变异盲区、不是覆盖差）。存活的 14 个里逐条判过，下面每条断言都对准其中一个——
// 不是为了把数字刷上去，是那些存活体改坏之后用户真会看到错的东西。
//
// 后端那份 statusline 在 tests/invariants/statusline.test.mjs（app/src/ops/statusline.js），两回事，别搞混。
//
// 不测什么 + 为什么（都是判过的等价/不现实变异，重跑变异看到它们别再追一遍）：
//  ① `n >= 1e6` 翻成 `>`：n=1e6 时走下面的 k 分支，Math.round(1e6/1e3)=1000 ≥1000 照样输出 "1.0m"，
//     两条路结果逐字相同。真正有区分度的是 `n >= 1e3`（下面第一条用例钉住）。
//  ② `if (!p || typeof p !== 'object')` 翻成 `&&`：null 与字符串输入继续往下走也拿不到任何字段，
//     最终仍返回 ''。守卫是防御性的，无可观测差异。
//  ③ `String(oldStr ?? '')` 翻成 `||`：只有 oldStr 为 0 / false 时才有别，而它是 Edit 工具的
//     old_string 参数，恒为字符串。为不现实的输入写断言只会把夹具做成自证。
//  ④ 颜色/DOM 呈现 —— 这里全是纯函数，渲染归 S3（tests/e2e/）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  statuslineFmtTok,
  formatStatuslineGitBrief,
  formatStatuslineCtxLeft,
  formatStatuslineCopyText,
  unifiedDiffLines,
} from '../../app/public/js/logic/statusline.js';

test.describe('statuslineFmtTok：k/m 抬升的两个边界', () => {
  test('1000 抬成 1k —— 边界值本身要落在 k 那一侧', () => {
    // `n >= 1e3` 翻成 `>` 时，恰好 1000 会掉进 String(n) 分支显示成裸 "1000"，
    // 与相邻的 1001 显示成 "1k" 并排出现，读起来像两个不同量纲。
    assert.equal(statuslineFmtTok(1000), '1k');
    assert.equal(statuslineFmtTok(999), '999', '不到 1000 保持原样');
  });

  test('round 到 k 后 ≥1000 继续抬 m —— 不出现 "1000k"', () => {
    // 这是函数头注释明写的意图，但没人验过。999500 四舍五入到 1000k，必须再抬一级。
    assert.equal(statuslineFmtTok(999500), '1.0m');
    assert.equal(statuslineFmtTok(999499), '999k', '差一点就不抬');
    assert.equal(statuslineFmtTok(1e6), '1.0m');
  });

  test('非有限值返回空串，不把 NaN 印到状态行上', () => {
    assert.equal(statuslineFmtTok(NaN), '');
    assert.equal(statuslineFmtTok(Infinity), '');
  });
});

test.describe('formatStatuslineGitBrief：三个计数任一非零都要走明细分支', () => {
  test('只有 modified 时也要显示明细，不能掉进 changed 兜底', () => {
    // `staged || modified || untracked` 里任何一个 || 被改成 &&，都会让「只改了没暂存」
    // 这个最常见的状态走进 else 分支，明细数字整个消失。
    assert.equal(formatStatuslineGitBrief({ branch: 'main', modified: 3 }), 'main !3');
    assert.equal(formatStatuslineGitBrief({ branch: 'main', staged: 2 }), 'main +2');
    assert.equal(formatStatuslineGitBrief({ branch: 'main', untracked: 1 }), 'main ?1');
  });

  test('三者同时有值时按 +!? 顺序拼接', () => {
    assert.equal(
      formatStatuslineGitBrief({ branch: 'dev', staged: 1, modified: 2, untracked: 3 }),
      'dev +1 !2 ?3',
    );
  });

  test('无分支名 → 空串（没在 git 仓库里就整段不显示）', () => {
    assert.equal(formatStatuslineGitBrief({ modified: 5 }), '');
    assert.equal(formatStatuslineGitBrief(null), '');
  });
});

// 注意输出两侧都过 statuslineFmtTok：窗口 1000 显示成 "1k"。这是有意的对称——
// 一边写 800、另一边写 1000 会让人以为量纲不同。下面的期望值一律按格式化后的形态写。
test.describe('formatStatuslineCtxLeft：四档取值优先级，以及 0 与负值的分别', () => {
  test('窗口为 0 直接不显示——不能让它掉进后面的减法', () => {
    // `win <= 0` 翻成 `<` 后 win=0 会继续往下算，输出一个 "left 0/0"：
    // 一个看起来像「上下文已用尽」的假警报，而真相是这次根本没拿到窗口大小。
    assert.equal(formatStatuslineCtxLeft({ windowSize: 0, totalTokens: 5 }), '');
    assert.equal(formatStatuslineCtxLeft({ windowSize: -1, totalTokens: 5 }), '');
    assert.equal(formatStatuslineCtxLeft({ totalTokens: 5 }), '', '没有窗口大小就不显示');
  });

  test('totalTokens 为 0 不算「有值」，要让位给后面的 tokens', () => {
    // 三条 `Number.isFinite(x) && x > 0` 中的 && 一旦变成 ||，0 就会被当成有效读数，
    // 覆盖掉后面那档真实的 tokens —— 屏幕上写着「一点没用」，实际已经用了 200。
    assert.equal(formatStatuslineCtxLeft({ windowSize: 1000, totalTokens: 0, tokens: 200 }), 'left 800/1k');
    assert.equal(formatStatuslineCtxLeft({ windowSize: 1000, usedPercent: 0, tokens: 200 }), 'left 800/1k');
  });

  test('取值优先级：totalTokens > usedPercent > tokens', () => {
    const win = 1000;
    assert.equal(formatStatuslineCtxLeft({ windowSize: win, totalTokens: 100, usedPercent: 50, tokens: 900 }),
      'left 900/1k', 'totalTokens 在最前');
    assert.equal(formatStatuslineCtxLeft({ windowSize: win, usedPercent: 50, tokens: 900 }),
      'left 500/1k', '没有 totalTokens 时用百分比换算');
    assert.equal(formatStatuslineCtxLeft({ windowSize: win, tokens: 900 }),
      'left 100/1k', '两者都无才用 tokens');
  });

  test('三档都恰好是 0 → 显示满格，而不是整段消失', () => {
    // 这是源码里那段 `=== 0` 特判的意义：0 是「确实还没用」，与「压根没拿到读数」不同。
    // 少了它，一个刚开的会话会显示不出上下文行，看起来像功能坏了。
    assert.equal(formatStatuslineCtxLeft({ windowSize: 1000, totalTokens: 0 }), 'left 1k/1k');
    assert.equal(formatStatuslineCtxLeft({ windowSize: 1000, usedPercent: 0 }), 'left 1k/1k');
    assert.equal(formatStatuslineCtxLeft({ windowSize: 1000, tokens: 0 }), 'left 1k/1k');
  });

  test('负数读数是坏数据，三个字段都要挡住——不得算出比窗口还大的剩余量，也不得当成 0', () => {
    // 两层各有三条独立的 && ：取值层 `isFinite(x) && x > 0`，0 特判层 `isFinite(x) && x === 0`。
    // 六条里任何一条翻成 ||，负数就会被收下——取值层收下会算出 1005 > 窗口的剩余量，
    // 0 特判层收下会显示成「满格」，即把一个坏读数说成「上下文一点没用」。
    // 三个字段必须逐个测：它们是三条独立的短路，只测一个，另外两条上的回归不会有任何测试变红
    // （2026-09-05 首版就只测了 tokens，变异把另两条抓了出来）。
    for (const field of ['totalTokens', 'usedPercent', 'tokens']) {
      assert.equal(formatStatuslineCtxLeft({ windowSize: 1000, [field]: -5 }), '',
        `${field} 为负是坏数据，整段不显示`);
      assert.equal(formatStatuslineCtxLeft({ windowSize: 1000, [field]: NaN }), '',
        `${field} 非有限值同理`);
    }
  });

  test('已用超出窗口时夹到 0，不显示负剩余', () => {
    assert.equal(formatStatuslineCtxLeft({ windowSize: 1000, totalTokens: 1500 }), 'left 0/1k');
  });
});

test.describe('formatStatuslineCopyText：可粘贴文本', () => {
  test('空载荷不产出「statusline」这个占位词', () => {
    // 折叠摘要在没内容时回落成字面量 'statusline'（那是给折叠态当标签用的）。
    // 复制文本里要把它滤掉；`summary && summary !== 'statusline'` 的 && 变成 ||
    // 就会把这个占位词粘进用户要贴到 issue 里的文本。
    assert.equal(formatStatuslineCopyText({}), '');
    assert.equal(formatStatuslineCopyText(null), '');
  });

  test('来源标签互斥：sdk 不得同时被标成 CLI', () => {
    // CLI 与 Web SDK 是两条驾驶通道，标错等于把「谁在开车」说反了。
    assert.equal(formatStatuslineCopyText({ source: { kind: 'sdk' } }), 'source Web SDK');
    assert.equal(formatStatuslineCopyText({ source: { kind: 'cli' } }), 'source CLI');
    assert.equal(formatStatuslineCopyText({ source: { kind: 'unknown' } }), '', '未知来源不猜');
  });

  test('有内容时逐行拼接', () => {
    const text = formatStatuslineCopyText({ model: 'opus', effort: 'high', cost: 1.5, version: '1.0.0' });
    assert.deepEqual(text.split('\n'), ['model opus', 'effort high', 'est $1.50', 'v1.0.0']);
  });
});

test.describe('unifiedDiffLines：LCS 的 dp 表边界', () => {
  // 两条循环的下界（i >= 0 / j >= 0）各管 dp 表的第 0 行与第 0 列。回溯时先直接比较行内容，
  // 只有首行不同时才去查 dp —— 所以要构造「首行不同、且必须靠 dp 才能决定先删还是先增」的输入，
  // 否则边界改坏了也看不出来（首行相同的用例对这两个变异体全绿）。

  test('新增落在开头：dp 第 0 行漏算会把它错判成删除', () => {
    // i 循环少跑 i=0 ⇒ dp[0][*] 恒 0 ⇒ 首步选了「删」，'x' 被判成删掉又重新加回来。
    assert.deepEqual(unifiedDiffLines('x', 'y\nx'), ['+ y', '  x']);
  });

  test('行序交换：dp 第 0 列漏算会把删增顺序颠倒', () => {
    // j 循环少跑 j=0 ⇒ dp[*][0] 恒 0 ⇒ 首步比较翻转，输出变成 +b / a / -b。
    assert.deepEqual(unifiedDiffLines('a\nb', 'b\na'), ['- a', '  b', '+ a']);
  });

  test('一侧整体为空时短路，不产出一条无内容的空行', () => {
    // ''.split('\n') 恒产出 ['']，落进通用 LCS 会多算一条空的 -/+ 行（渲染成一条空白色条）。
    assert.deepEqual(unifiedDiffLines('', 'a\nb'), ['+ a', '+ b']);
    assert.deepEqual(unifiedDiffLines('a\nb', ''), ['- a', '- b']);
  });

  test('尾部多一个换行不算「整体为空」，那一行是真实变更', () => {
    assert.deepEqual(unifiedDiffLines('a\nb', 'a\nb\n'), ['  a', '  b', '+ ']);
  });

  test('完全相同 → 全是同行', () => {
    assert.deepEqual(unifiedDiffLines('a\nb', 'a\nb'), ['  a', '  b']);
  });
});
