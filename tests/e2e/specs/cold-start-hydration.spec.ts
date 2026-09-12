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
    // Composer C：空闲无内容隐藏灰发送；附件仍在
    await expect(page.locator('#btnSend')).toBeHidden();
    await expect(page.locator('#btnAttach')).toBeVisible();
    await page.locator('#input').fill('x');
    await expect(page.locator('#btnSend')).toBeVisible();
    await expect(page.locator('#btnSend')).toBeEnabled();
    await page.locator('#input').fill('');
    await expect(page.locator('#btnSend')).toBeHidden();
    await expect(page.locator('#pillModelText')).not.toHaveText('');
    await expect(page.locator('#pillPermText')).toContainText('Manual');

    // 2. 回空首页枢纽：输入条隐藏；顶栏文件夹 pill 隐藏；无「当前工作区」标。
    await page.locator('#btnHome').click();
    await expect(page.locator('#messages')).toHaveClass(/empty-start/);
    await expect(page.locator('[data-testid="home-dashboard"]')).toBeVisible();
    await expect(page.locator('.dashboard-container')).toBeVisible();
    await expect(page.locator('#composerFooter')).toBeHidden();
    await expect(page.locator('#input')).toBeHidden();
    await expect(page.locator('#topContextPill')).toBeHidden();
    await expect(page.locator('#messages')).not.toContainText('当前工作区');
    await expect(page.locator('#messages')).not.toContainText('ACTIVE WORKSPACE');

    // 3. 点 ＋ 进入 compose 干净新会话页：输入条出现；顶栏文件夹 pill 与状态栏都要在——会话是懒创建的，
    //    但工作区此刻已经定了，而文件浏览 / git 改动 / statusline 的 git 段只依赖 cwd。
    await page.locator('#btnNew').click();
    await expect(page.locator('#messages')).toHaveClass(/empty-start/);
    await expect(page.locator('[data-testid="compose-surface"]')).toBeVisible();
    await expect(page.locator('.dashboard-container')).toHaveCount(0);
    await expect(page.locator('#composerFooter')).toBeVisible();
    await expect(page.locator('#input')).toBeVisible();
    await expect(page.locator('#btnSend')).toBeHidden(); // 空输入不露灰发送
    await expect(page.locator('#btnAttach')).toBeVisible();
    await expect(page.locator('#pillPermText')).toContainText('Manual');
    // 页内默认档摘要至少带上权限文案（与底栏 pill 同源）
    await expect(page.locator('[data-compose-defaults]')).toContainText('Manual');

    // 3a. 顶栏工作区 pill：显示、指向当前工作区、带未提交改动角标（mock session:new 那条 status_line 的 git 段）
    await expect(page.locator('#topContextPill')).toBeVisible();
    await expect(page.locator('#topProjectText')).not.toHaveText('');
    await expect(page.locator('[data-testid="top-context-changes"]')).toHaveText('4');

    // 3b. 状态栏：compose 页也渲染，且 git 摘要真到位（不只是容器可见）
    await expect(page.locator('#cliStatusWrap')).toBeVisible();
    await expect(page.locator('#cliSummary')).toContainText('main');

    // 4. 从 compose 回空首页：pill 收起（状态栏随 #composerFooter 整体隐藏，见步骤 2 那条断言）
    await page.locator('#btnHome').click();
    await expect(page.locator('[data-testid="home-dashboard"]')).toBeVisible();
    await expect(page.locator('#topContextPill')).toBeHidden();
    await expect(page.locator('#composerFooter')).toBeHidden();

    await expectNoBrowserErrors(page);
  });
});
