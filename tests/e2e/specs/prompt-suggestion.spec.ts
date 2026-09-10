// helpers: tests/helpers/playwright.ts

import { test, expect } from '@playwright/test';
import { expectNoBrowserErrors, gotoMock, sendChatMessage } from '../../helpers/playwright';

// 下一步建议（CCM_PROMPT_SUGGESTION）：每轮 result 结算后，server 用一次旁路提问
// （app/src/agent/agent.js maybeSuggest → query.askSideQuestion）预测用户可能想发的下一句，
// 经 agent:event 的 prompt_suggestion 推给前端。
//
// 这里测的是**前端那一半**——也是这个功能全部价值所在的一半：手机上照着灰字手打一遍的成本
// 比它省下的思考更高，所以建议必须能点、且点了要**只填不发**（建议是猜的，用户几乎总要改
// 一两个词；自动发送会把"猜错"变成"替我做错事"）。
//
// mock 侧 test:prompt-suggestion 场景先发 result 再发 prompt_suggestion，与真 server 同序。
test.describe('下一步建议条', () => {
  test('SUGGEST-1 收到建议 → 显示；点一下把整句填进输入框且【不发送】，建议条随即收起', async ({ page }) => {
    await gotoMock(page);
    const box = page.locator('[data-testid="prompt-suggestion"]');
    await expect(box).toBeHidden(); // 冷启动没有建议

    await sendChatMessage(page, 'test:prompt-suggestion');

    await expect(box).toBeVisible({ timeout: 10_000 });
    const btn = box.locator('button');
    await expect(btn).toHaveText('给 agent.js 补几个边界用例');

    const input = page.locator('#input');
    await expect(input).toHaveValue(''); // 点之前输入框是空的
    await btn.click();

    // 只填不发：文本落进输入框，且【消息流里不出现】这句话（真发了会渲染成用户气泡）
    await expect(input).toHaveValue('给 agent.js 补几个边界用例');
    await expect(box).toBeHidden();
    await expect(page.locator('#messages').getByText('给 agent.js 补几个边界用例', { exact: true })).toHaveCount(0);

    await expectNoBrowserErrors(page);
  });

  test('SUGGEST-3 会话设置面板显示本会话的自动调用次数（只报次数、不报金额）', async ({ page }) => {
    await gotoMock(page);
    // 打开会话设置：点摘要 chip（模型 · 权限 · 思考）
    await page.locator('[data-testid="pill-defaults"]').click();

    const block = page.locator('[data-testid="side-question-stats"]');
    await expect(block).toBeVisible({ timeout: 10_000 });
    // mock 的 instances 里给的是 { suggestion: 3, recap: 1 }。断言【具体数字】而不只是"可见"：
    // 后端字段没传到时前端会整段隐藏，那样只断言可见也能红；但数字对不上（比如取错了键）
    // 只有这条抓得住。
    await expect(block).toContainText('下一步建议 3 次');
    await expect(block).toContainText('会话摘要 1 次');
    // 金额不在这里报——那笔钱已计入会话总成本，列两份会变成两个对不上的数字
    await expect(block).toContainText('已计入会话总成本');
    await expect(block).not.toContainText('$');

    await expectNoBrowserErrors(page);
  });

  test('SUGGEST-2 用户一开始打字，建议条立刻让位（不与自己写的内容抢屏）', async ({ page }) => {
    await gotoMock(page);
    const box = page.locator('[data-testid="prompt-suggestion"]');
    const input = page.locator('#input');

    await sendChatMessage(page, 'test:prompt-suggestion');
    await expect(box).toBeVisible({ timeout: 10_000 });

    // **本文件的反向锚点**：把 app.js 里 input 监听那行 hidePromptSuggestion() 删掉，只有这条会红
    // ——SUGGEST-1 照样全绿，因为它走的是"点击建议"路径，压根不经过打字。
    await input.fill('我自己要写的内容');
    await expect(box).toBeHidden();
    await expect(input).toHaveValue('我自己要写的内容'); // 让位不等于把用户输入也清掉

    await expectNoBrowserErrors(page);
  });
});
