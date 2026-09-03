// helpers: tests/helpers/playwright.ts

import { test, expect } from '@playwright/test';
import { ensureComposerReady, expectNoBrowserErrors, gotoMock } from '../../helpers/playwright';

// composer「@ 文件引用」：files:search 候选 + 点选回填相对路径文本（见 app/public/js/app.js checkAtMention/
// pickAtMention，纯逻辑在 app/public/js/logic.js detectAtMentionQuery/applyAtMentionPick）。
test.describe('P0 日常零 token Mock UI 回归', () => {
  test('P0-MENTION 打 @ 触发候选 chips，点选回填相对路径', async ({ page }) => {
    await gotoMock(page);
    await ensureComposerReady(page);

    const input = page.locator('#input');
    await input.fill('看下 @app');

    const chips = page.locator('[data-testid="at-mention-chip"]');
    await expect(chips).toHaveCount(1, { timeout: 3_000 });
    await expect(chips.first()).toContainText('src/app.js');

    await chips.first().click();
    await expect(input).toHaveValue('看下 src/app.js ');
    await expect(page.locator('[data-testid="at-mention-chips"]')).toBeHidden();

    await expectNoBrowserErrors(page);
  });

  test('P0-MENTIONd 仅打 @（空 query）也应出候选列表，对齐 CLI', async ({ page }) => {
    await gotoMock(page);
    await ensureComposerReady(page);

    await page.locator('#input').fill('@');
    // 空 query 时 matchFiles 返回前 N 条路径，不应再「无反应」
    const chips = page.locator('[data-testid="at-mention-chip"]');
    await expect(chips.first()).toBeVisible({ timeout: 3_000 });
    await expect(chips).not.toHaveCount(0);

    await expectNoBrowserErrors(page);
  });

  test('P0-MENTIONb 打完空格后引用视为已确认，chips 收起', async ({ page }) => {
    await gotoMock(page);
    await ensureComposerReady(page);

    const input = page.locator('#input');
    await input.fill('看下 @app');
    await expect(page.locator('[data-testid="at-mention-chip"]')).toHaveCount(1, { timeout: 3_000 });

    await input.fill('看下 @app 的实现');
    await expect(page.locator('[data-testid="at-mention-chips"]')).toBeHidden();

    await expectNoBrowserErrors(page);
  });

  test('P0-MENTIONc 连续改写 query 时只认最后一次结果，不残留过期候选', async ({ page }) => {
    await gotoMock(page);
    await ensureComposerReady(page);

    const input = page.locator('#input');
    // 先打一个无匹配的 query（不等它落地），紧接着改成有匹配的——最终态必须只反映最后一次输入，
    // 不能因为前一次请求残留而闪现空结果或过期候选。
    await input.fill('看下 @zzz-nope');
    await input.fill('看下 @app');

    const chips = page.locator('[data-testid="at-mention-chip"]');
    await expect(chips).toHaveCount(1, { timeout: 3_000 });
    await expect(chips.first()).toContainText('src/app.js');

    await expectNoBrowserErrors(page);
  });
});
