// spec: docs/testing.md
// helpers: tests/helpers/playwright.ts

import { test, expect } from '@playwright/test';
import { expectNoBrowserErrors, gotoMock, sendChatMessage, waitForIdle } from '../../helpers/playwright';

test.describe('P0 日常零 token Mock UI 回归', () => {
  test('P0-07 ExitPlanMode 审批与权限档回落', async ({ page }) => {
    await gotoMock(page);

    // 1. 发送 test:exitplan 后进入计划模式并显示 ExitPlanMode 审批。
    await sendChatMessage(page, 'test:exitplan');
    await expect(page.locator('#pillPermText')).toContainText('计划模式');
    await expect(page.locator('#permModal')).toBeVisible();
    await expect(page.locator('#permTool')).toHaveText('ExitPlanMode');
    // UX-001：计划走 markdown 渲染，不再是 JSON 引号 + 字面 \\n
    await expect(page.locator('#permInput')).toContainText('实现 X');
    await expect(page.locator('#permInput')).toContainText('测试 Y');
    await expect(page.locator('#permInput')).not.toContainText('\\n');
    await expect(page.locator('#permInput li')).toHaveCount(2);
    await expect(page.locator('#activeStatusText')).toContainText('ExitPlanMode');

    // 2. 批准后权限档回落默认审批，状态不残留 ExitPlanMode。
    await page.locator('#permAllow').click();
    await expect(page.locator('#permModal')).toBeHidden();
    await expect(page.locator('#pillPermText')).toContainText('默认审批');
    await waitForIdle(page);
    await expect(page.locator('#activeStatusPill')).toBeHidden();
    await expect(page.locator('details.toolcard .t-status').last()).toHaveText('✅');

    await expectNoBrowserErrors(page);
  });
});
