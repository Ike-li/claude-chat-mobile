// spec: docs/testing.md
// helpers: tests/helpers/playwright.ts

import { test, expect } from '@playwright/test';
import { expectNoBrowserErrors, gotoMock } from '../../helpers/playwright';

test.describe('P0 日常零 token Mock UI 回归', () => {
  test('P0-01 首屏冷启动、hydration 与连接状态', async ({ page }) => {
    // 1. 起始状态/假设：fresh browser context；打开 mock 页面，不依赖真实 Claude。
    // Mock 默认带可渲染会话 → 冷启动应显示输入条（与生产「有 viewing session」一致）。
    await gotoMock(page);

    await expect(page).toHaveTitle(/Claude Chat Mobile/);
    await expect(page.locator('#btnSessions')).toBeVisible();
    await expect(page.locator('#btnConsole')).toBeVisible();
    await expect(page.locator('#btnNew')).toBeVisible();
    await expect(page.locator('#btnHome')).toBeVisible();
    await expect(page.locator('#messages')).toBeVisible();
    await expect(page.locator('#topProjectText')).toContainText('claude-chat-mobile');
    await expect(page.locator('#composerFooter')).toBeVisible();
    await expect(page.locator('#input')).toBeVisible();
    await expect(page.locator('#input')).toHaveAttribute('placeholder', /给 Claude 发消息/);
    await expect(page.locator('#btnSend')).toBeVisible();
    await expect(page.locator('#btnSend')).toBeDisabled();
    await expect(page.locator('#btnAttach')).toBeVisible();
    await expect(page.locator('#btnSettings')).toBeVisible();
    await expect(page.locator('#pillModelText')).not.toHaveText('');
    await expect(page.locator('#pillPermText')).toContainText('默认审批');

    // 2. 回空首页枢纽：输入条隐藏（须先选会话或点 ＋ 才能发消息）。
    await page.locator('#btnHome').click();
    await expect(page.locator('#messages')).toHaveClass(/empty-start/);
    await expect(page.locator('.dashboard-container')).toBeVisible();
    await expect(page.locator('#composerFooter')).toBeHidden();
    await expect(page.locator('#input')).toBeHidden();

    // 3. 点 ＋ 进入 compose 干净新会话页：输入条出现；无最近列表；页内摘要与底栏默认档同源。
    await page.locator('#btnNew').click();
    await expect(page.locator('#messages')).toHaveClass(/empty-start/);
    await expect(page.locator('[data-testid="compose-surface"]')).toBeVisible();
    await expect(page.locator('.dashboard-container')).toHaveCount(0);
    await expect(page.locator('#composerFooter')).toBeVisible();
    await expect(page.locator('#input')).toBeVisible();
    await expect(page.locator('#btnSend')).toBeVisible();
    await expect(page.locator('#btnSend')).toBeDisabled();
    await expect(page.locator('#pillPermText')).toContainText('默认审批');
    // 页内默认档摘要至少带上权限文案（与底栏 pill 同源）
    await expect(page.locator('[data-compose-defaults]')).toContainText('默认审批');

    await expectNoBrowserErrors(page);
  });
});
