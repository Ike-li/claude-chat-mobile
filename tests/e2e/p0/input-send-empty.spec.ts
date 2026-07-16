// spec: docs/testing.md
// helpers: tests/helpers/playwright.ts

import { test, expect } from '@playwright/test';
import { expectNoBrowserErrors, gotoMock, sendChatMessage, waitForIdle } from '../../helpers/playwright';

test.describe('P0 日常零 token Mock UI 回归', () => {
  test('P0-02 输入框、发送按钮与空输入边界', async ({ page }) => {
    await gotoMock(page);

    // 1. 起始状态/假设：fresh state，已连接，输入框为空。
    await expect(page.locator('#btnSend')).toBeDisabled();
    // UI-002：disabled 约 60% 不透明（可见发送位）
    await expect(page.locator('#btnSend')).toHaveClass(/opacity-60/);
    await page.locator('#btnSend').click({ force: true });
    await expect(page.locator('[data-testid="user-message"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="assistant-message"]')).toHaveCount(0);

    // 2. 在输入框输入普通文本 hello。
    await page.locator('#input').fill('hello');
    await expect(page.locator('#btnSend')).toBeEnabled();
    // UI-002：激活态品牌 cta 底白箭头
    await expect(page.locator('#btnSend')).toHaveClass(/bg-cta/);
    await expect(page.locator('#btnSend')).toHaveClass(/text-white/);
    await expect(page.locator('#input')).toHaveValue('hello');

    // 3. 清空输入框。
    await page.locator('#input').fill('');
    await expect(page.locator('#btnSend')).toBeDisabled();
    await expect(page.locator('#btnSend')).toHaveClass(/opacity-60/);
    await expect(page.locator('[data-testid="user-message"]')).toHaveCount(0);

    await expectNoBrowserErrors(page);
  });

  test('P0-02b 触屏 Enter 只换行不发送，按钮仍会发送有效文本', async ({ page }) => {
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
    await expect(page.locator('#input')).toHaveValue('keyboard hello\n');
    await expect(page.locator('[data-testid="user-message"]')).toHaveCount(0);
    await page.locator('#btnSend').click();
    await expect(page.locator('[data-testid="user-message"]').last()).toContainText('keyboard hello');
    await expect(page.locator('#input')).toHaveValue('');
    // 发送后输入空 + busy：主钮 morph 为停止（普通文本 mock 未必立刻 result，不强制 waitForIdle）
    await expect(page.locator('#btnSend')).toHaveAttribute('data-mode', 'stop');
    await expect(page.locator('#btnSend')).toBeEnabled();
    await expect(page.locator('#btnSend')).toHaveAttribute('aria-label', '停止');

    await expectNoBrowserErrors(page);
  });

  test('P0-02c 队列已满时保留草稿并禁用发送按钮', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:queuefull');
    // 发送后输入空 + busy：主钮为停止；queueFull 只在有内容时挡发送（FE-004）
    await expect(page.locator('#btnSend')).toHaveAttribute('data-mode', 'stop');

    await page.locator('#input').fill('message after queue drains');
    await expect(page.locator('#input')).toHaveValue('message after queue drains');
    await expect(page.locator('#btnSend')).toHaveAttribute('data-mode', 'send');
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

  test('P0-02f 前台恢复 sync 不重复已见回复', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:foreground-sync-replay');
    await waitForIdle(page);
    await expect(page.locator('[data-testid="assistant-message"]').filter({ hasText: 'Foreground sync baseline response.' })).toHaveCount(1);

    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    await expect(page.locator('#messages')).toContainText('Foreground sync replay completed.', { timeout: 10_000 });
    await expect(page.locator('[data-testid="assistant-message"]').filter({ hasText: 'Foreground sync baseline response.' })).toHaveCount(1);

    await expectNoBrowserErrors(page);
  });

  test('P0-02g 前台恢复发现实例缺失时回载历史', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:foreground-found-missing');
    await waitForIdle(page);
    await expect(page.locator('#messages')).toContainText('Foreground found=false fixture armed.');
    await expect(page.locator('#messages')).toContainText('Stale foreground instance response.');

    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    await expect(page.locator('#messages')).toContainText('Authoritative history after foreground reload.', { timeout: 10_000 });
    await expect(page.locator('#messages')).not.toContainText('Stale foreground instance response.');
    await expect(page.locator('#messages')).not.toContainText('Foreground found=false fixture armed.');
    await expect(page.locator('#messages')).not.toContainText('test:foreground-found-missing');
    await expect(page.locator('#historyLoadingCard')).toHaveCount(0);

    await expectNoBrowserErrors(page);
  });

  test('P0-02e ultracode 快捷发送只注入一次关键词', async ({ page }) => {
    await gotoMock(page);

    await page.locator('#btnSettings').click();
    await expect(page.locator('#settingsSheet')).not.toHaveClass(/translate-y-full/);
    await expect(page.locator('.effort-tile[data-level="ultracode"]')).toBeVisible();
    await page.locator('.effort-tile[data-level="ultracode"]').click();
    await expect(page.locator('#pillEffortText')).toContainText('ultracode');
    await page.locator('#settingsClose').click();
    await expect(page.locator('#settingsSheet')).toHaveClass(/translate-y-full/);

    await sendChatMessage(page, 'test:workflow-echo');
    await expect(page.locator('[data-testid="user-message"]').last()).toContainText('ultracode test:workflow-echo');
    const firstText = await page.locator('[data-testid="user-message"]').last().innerText();
    expect(firstText.match(/\bultracode\b/g)).toHaveLength(1);
    await waitForIdle(page);
    await expect(page.locator('[data-testid="assistant-message"]').last()).toContainText('ultracode mock response');

    await sendChatMessage(page, 'ultracode test:workflow-echo');
    await expect(page.locator('[data-testid="user-message"]').last()).toContainText('ultracode test:workflow-echo');
    const secondText = await page.locator('[data-testid="user-message"]').last().innerText();
    expect(secondText.match(/\bultracode\b/g)).toHaveLength(1);
    await waitForIdle(page);

    await expectNoBrowserErrors(page);
  });

  test('P0-02h 斜杠命令提示可处理服务端对象格式命令', async ({ page }) => {
    await gotoMock(page);

    await page.locator('#input').fill('/m');
    await expect(page.locator('#cmdHints')).toBeVisible();
    await expect(page.locator('#cmdHints')).toContainText('/model');
    await expect(page.locator('#btnSend')).toBeEnabled();

    await page.locator('#input').fill('plain message after slash hint');
    await expect(page.locator('#cmdHints')).toBeHidden();
    await expect(page.locator('#btnSend')).toBeEnabled();

    await expectNoBrowserErrors(page);
  });

  test('P0-02i 点击斜杠命令提示会填入命令并保持可发送', async ({ page }) => {
    await gotoMock(page);

    await page.locator('#input').fill('/m');
    await expect(page.locator('#cmdHints')).toBeVisible();
    await page.locator('#cmdHints [data-cmd="/model"]').click();

    await expect(page.locator('#input')).toHaveValue('/model ');
    await expect(page.locator('#cmdHints')).toBeHidden();
    await expect(page.locator('#btnSend')).toBeEnabled();

    await expectNoBrowserErrors(page);
  });

  test('P0-02j 点击外部会关闭斜杠命令提示且保留草稿', async ({ page }) => {
    await gotoMock(page);

    await page.locator('#input').fill('/m');
    await expect(page.locator('#cmdHints')).toBeVisible();

    await page.locator('#messages').click({ position: { x: 20, y: 20 } });

    await expect(page.locator('#cmdHints')).toBeHidden();
    await expect(page.locator('#input')).toHaveValue('/m');
    await expect(page.locator('#btnSend')).toBeEnabled();
    await expect(page.locator('[data-testid="user-message"]')).toHaveCount(0);

    await expectNoBrowserErrors(page);
  });

  test('P0-02k 防抖窗口内连续两次触发发送只产生一条消息（FE-004）', async ({ page }) => {
    await gotoMock(page);

    // 发送按钮点击后会同步转入 disabled，原生 disabled 按钮不派发 click 事件、Playwright 的
    // .click() 也会等按钮重新可用才点——都无法真实复现"两次触发落在同一竞态窗口内"。
    // 直接同步调用两次 onclick（中间回填文本，模拟"没反应就手快再点一次"）才是这场竞态的真实形态。
    await page.evaluate(() => {
      const input = document.getElementById('input') as HTMLTextAreaElement;
      const btn = document.getElementById('btnSend') as HTMLButtonElement & { onclick: (() => void) | null };
      input.value = 'test:settings-echo';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      btn.onclick?.();
      input.value = 'test:settings-echo';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      btn.onclick?.();
    });

    await waitForIdle(page);
    await expect(page.locator('[data-testid="user-message"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="assistant-message"]').last()).toContainText('设置回显：model=');

    // 防抖窗口过后应正常恢复：能再发一条新消息（不是被永久卡死）。
    await page.locator('#input').fill('test:settings-echo');
    await expect(page.locator('#btnSend')).toBeEnabled();
    await page.locator('#btnSend').click();
    await waitForIdle(page);
    await expect(page.locator('[data-testid="user-message"]')).toHaveCount(2);

    await expectNoBrowserErrors(page);
  });
});
