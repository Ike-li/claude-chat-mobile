// spec: docs/testing.md
// helpers: tests/helpers/playwright.ts

import { test, expect } from '@playwright/test';
import { expectNoBrowserErrors, gotoMock, sendChatMessage, waitForIdle } from '../../helpers/playwright';

test.describe('P0 日常零 token Mock UI 回归', () => {
  test('P0-24 未读角标：切回会话展示未读数，点击跳转到锚点并高亮，随后自动消失', async ({ page }) => {
    await gotoMock(page);

    // test:tab：先把 inst_2 注册进 mockInstances（同 P0-14 系列的既有两步套路）——不然
    // test:unread-pill 直接切 viewingInstanceId 到一个尚不存在的实例，bindView 会落到空首页分支。
    await sendChatMessage(page, 'test:tab');
    await waitForIdle(page);
    // test:unread-pill：mock 切到 inst_2，sync:since ack 带 unreadOnEntry=1（该会话固定回放 2 条顶层
    // 气泡：user_message + text_delta 各一条，unreadOnEntry=1 应指向最后一条即 assistant 回复）。
    await sendChatMessage(page, 'test:unread-pill');

    const pill = page.locator('#unreadPill');
    await expect(pill).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#unreadPillCount')).toHaveText('1');

    const anchor = page.locator('[data-testid="assistant-message"]').last();
    await expect(anchor).toContainText('This is the concurrent session');

    await pill.click();

    await expect(pill).toBeHidden();
    await expect(anchor).toHaveClass(/unread-anchor-flash/);

    await expectNoBrowserErrors(page);
  });
});
