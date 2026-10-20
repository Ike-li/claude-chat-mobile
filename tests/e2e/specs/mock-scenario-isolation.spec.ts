// helpers: tests/helpers/playwright.ts

import { test, expect } from '@playwright/test';
import { expectNoBrowserErrors, gotoMock, sendChatMessage } from '../../helpers/playwright';
import { ANOTHER_WORKSPACE, expandWorkspace, openSessionsSidebar, sessionRowByInstance } from '../../helpers/sidebar-ui';

// 验收 O71（AC-15-15）：mock 的通用派发在「当前没有对应实例」时（新会话页 viewingInstanceId 为 null，
// 通用路径不懒开实例）照样把 activeInst = undefined 交给场景；test:background-done 直接写
// activeInst.state，抛 TypeError。user:message 处理函数是 async 的，这个拒绝没人接，Node 直接退出进程——
// 同一分片里排在后面的用例全部变成「未连接」，整片假红。
test.describe('E2E 假后端：场景出错不拖垮整片', () => {
  test('P0-MOCK-1 新会话页上发后台完成场景：mock 不崩，后台工作区照常标完成', async ({ page }) => {
    await gotoMock(page);
    await page.locator('#btnNew').click();
    await expect(page.locator('[data-testid="compose-surface"]')).toBeVisible({ timeout: 5_000 });

    await sendChatMessage(page, 'test:background-done');

    await openSessionsSidebar(page);
    await expandWorkspace(page, ANOTHER_WORKSPACE);
    await expect(sessionRowByInstance(page, 'inst_2')).toContainText('Another App Concurrency');
    // mock 进程还在：崩了的话这里是连接被拒
    expect((await page.request.get('/__ready')).status()).toBe(200);
    await expectNoBrowserErrors(page);
  });
});
