// helpers: tests/helpers/playwright.ts

import { test, expect } from '@playwright/test';
import { expectNoBrowserErrors, gotoMock, sendChatMessage } from '../../helpers/playwright';

// 额度墙「到点自动继续」横幅（app/public/js/app/auto-continue-banner.js + logic/auto-continue.js）。
// 状态机在真 server（src/server/auto-continue.js），经 instances 广播的 autoContinue 下发；这里测前端那一半：
// 每个相位给对文案与按钮，按钮发对动作——判据是 mock 按动作迁移相位后重新广播，横幅按新快照重画：
// 发错动作（比如该发 arm 却发了 cancel），横幅会落到另一个状态，下面的断言就对不上。
// mock 场景：test:auto-continue-{armed,offered,stale,fired}（tests/e2e/mock/server.js）。
test.describe('额度墙自动继续横幅', () => {
  test('AUTOCONT-1 已布防：说清几点自动继续、按钮是「取消」；点了横幅收起', async ({ page }) => {
    await gotoMock(page);
    const banner = page.locator('[data-testid="auto-continue-banner"]');
    await expect(banner).toBeHidden();

    await sendChatMessage(page, 'test:auto-continue-armed');

    await expect(banner).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('[data-testid="auto-continue-text"]')).toContainText('15:50');
    await expect(page.locator('[data-testid="auto-continue-text"]')).toContainText('自动继续');
    const btn = page.locator('[data-testid="auto-continue-action"]');
    await expect(btn).toHaveText('取消');
    await btn.click();
    await expect(banner).toBeHidden();

    await expectNoBrowserErrors(page);
  });

  test('AUTOCONT-2 开关关着只给选项：点「到点自动继续」→ 变成已布防、按钮换成「取消」', async ({ page }) => {
    await gotoMock(page);
    await sendChatMessage(page, 'test:auto-continue-offered');

    const banner = page.locator('[data-testid="auto-continue-banner"]');
    const btn = page.locator('[data-testid="auto-continue-action"]');
    await expect(banner).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('[data-testid="auto-continue-text"]')).toContainText('15:50');
    await expect(btn).toHaveText('到点自动继续');
    await btn.click();

    // 相位迁移由服务端广播驱动：点击本身不改前端状态，看到「取消」说明 arm 确实到了服务端并被接受
    await expect(btn).toHaveText('取消');
    await expect(page.locator('[data-testid="auto-continue-text"]')).toContainText('届时自动继续');
    await expect(banner).toBeVisible();

    await expectNoBrowserErrors(page);
  });

  test('AUTOCONT-3 睡过重置点没续：说清原因、按钮是「继续」；点了代发续跑、横幅收起', async ({ page }) => {
    await gotoMock(page);
    await sendChatMessage(page, 'test:auto-continue-stale');

    const banner = page.locator('[data-testid="auto-continue-banner"]');
    await expect(banner).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('[data-testid="auto-continue-text"]')).toContainText('休眠');
    const btn = page.locator('[data-testid="auto-continue-action"]');
    await expect(btn).toHaveText('继续');
    await btn.click();
    await expect(banner).toBeHidden();
    // 横幅收起对 cancel 与 continueNow 同形；只有「续跑那句真的发出来了」才证明发的是 continueNow
    const auto = page.locator('[data-testid="user-message"]').filter({ hasText: 'Your usage limit has reset' });
    await expect(auto).toHaveCount(1);
    await expect(auto.locator('[data-testid="auto-continue-tag"]')).toHaveCount(1);

    await expectNoBrowserErrors(page);
  });

  test('AUTOCONT-4 到点代发的那句气泡带「自动继续」标注，用户自己发的不带', async ({ page }) => {
    await gotoMock(page);
    await sendChatMessage(page, 'test:auto-continue-fired');

    const auto = page.locator('[data-testid="user-message"]').filter({ hasText: 'Your usage limit has reset' });
    await expect(auto).toHaveCount(1, { timeout: 10_000 });
    await expect(auto.locator('[data-testid="auto-continue-tag"]')).toHaveCount(1);
    // 结构判据（元素计数）而非文本片段：用户自己那条（触发场景的命令）不得带标注
    const own = page.locator('[data-testid="user-message"]').filter({ hasText: 'test:auto-continue-fired' });
    await expect(own).toHaveCount(1);
    await expect(own.locator('[data-testid="auto-continue-tag"]')).toHaveCount(0);

    await expectNoBrowserErrors(page);
  });
});
