// spec: specs/claude-chat-mobile-comprehensive-test-plan.md
// seed: tests/seed.goto-mock.spec.ts

import { test, expect } from '@playwright/test';
import { expectNoBrowserErrors, gotoMock, sendChatMessage, waitForIdle } from '../seed.goto-mock.spec';

test.describe('P0 日常零 token Mock UI 回归', () => {
  test('P0-02 输入框、发送按钮与空输入边界', async ({ page }) => {
    await gotoMock(page);

    // 1. 起始状态/假设：fresh state，已连接，输入框为空。
    await expect(page.locator('#btnSend')).toBeDisabled();
    await page.locator('#btnSend').click({ force: true });
    await expect(page.locator('[data-testid="user-message"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="assistant-message"]')).toHaveCount(0);

    // 2. 在输入框输入普通文本 hello。
    await page.locator('#input').fill('hello');
    await expect(page.locator('#btnSend')).toBeEnabled();
    await expect(page.locator('#input')).toHaveValue('hello');

    // 3. 清空输入框。
    await page.locator('#input').fill('');
    await expect(page.locator('#btnSend')).toBeDisabled();
    await expect(page.locator('[data-testid="user-message"]')).toHaveCount(0);

    await expectNoBrowserErrors(page);
  });

  test('P0-02b Enter 键不会发送空输入但会发送有效文本', async ({ page }) => {
    await gotoMock(page);

    await page.locator('#input').press('Enter');
    await page.locator('#input').fill('   ');
    await expect(page.locator('#btnSend')).toBeDisabled();
    await page.locator('#input').press('Enter');
    await expect(page.locator('[data-testid="user-message"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="assistant-message"]')).toHaveCount(0);

    await page.locator('#input').fill('keyboard hello');
    await expect(page.locator('#btnSend')).toBeEnabled();
    await page.locator('#input').press('Enter');
    await expect(page.locator('[data-testid="user-message"]').last()).toContainText('keyboard hello');
    await expect(page.locator('#input')).toHaveValue('');
    await expect(page.locator('#btnSend')).toBeDisabled();

    await expectNoBrowserErrors(page);
  });

  test('P0-02c 队列已满时保留草稿并禁用发送按钮', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:queuefull');
    await expect(page.locator('#btnSend')).toHaveAttribute('title', '前面已有消息在排队，请等当前任务结束');

    await page.locator('#input').fill('message after queue drains');
    await expect(page.locator('#input')).toHaveValue('message after queue drains');
    await expect(page.locator('#btnSend')).toBeDisabled();
    await expect(page.locator('#btnSend')).toHaveAttribute('title', '前面已有消息在排队，请等当前任务结束');

    await expect(page.locator('#btnSend')).toBeEnabled({ timeout: 10_000 });
    await expect(page.locator('#btnSend')).toHaveAttribute('title', '');
    await page.locator('#btnSend').click();
    await expect(page.locator('[data-testid="user-message"]').last()).toContainText('message after queue drains');
    await expect(page.locator('#input')).toHaveValue('');

    await expectNoBrowserErrors(page);
  });

  test('P0-02d 断线时消息进入离线队列并在重连后发送', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:disconnect-now');
    await expect(page.locator('#connDot')).toHaveClass(/bg-danger/, { timeout: 10_000 });

    await page.locator('#input').fill('test:settings-echo');
    await expect(page.locator('#btnSend')).toBeEnabled();
    await page.locator('#btnSend').click();
    await expect(page.locator('.pending-indicator').last()).toContainText('正在等待连接');
    await expect(page.locator('#input')).toHaveValue('');

    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(page.locator('#connDot')).toHaveClass(/bg-success/, { timeout: 10_000 });
    await waitForIdle(page);
    await expect(page.locator('[data-testid="assistant-message"]').last()).toContainText('设置回显：model=');

    await expectNoBrowserErrors(page);
  });

  test('P0-02e ultracode 快捷发送只注入一次关键词', async ({ page }) => {
    await gotoMock(page);

    await page.locator('#input').fill('test:workflow-echo');
    await page.locator('#btnUltracode').click();
    await expect(page.locator('[data-testid="user-message"]').last()).toContainText('ultracode test:workflow-echo');
    const firstText = await page.locator('[data-testid="user-message"]').last().innerText();
    expect(firstText.match(/\bultracode\b/g)).toHaveLength(1);
    await waitForIdle(page);
    await expect(page.locator('[data-testid="assistant-message"]').last()).toContainText('ultracode mock response');

    await page.locator('#input').fill('ultracode test:workflow-echo');
    await page.locator('#btnUltracode').click();
    await expect(page.locator('[data-testid="user-message"]').last()).toContainText('ultracode test:workflow-echo');
    const secondText = await page.locator('[data-testid="user-message"]').last().innerText();
    expect(secondText.match(/\bultracode\b/g)).toHaveLength(1);
    await waitForIdle(page);

    await expectNoBrowserErrors(page);
  });
});
