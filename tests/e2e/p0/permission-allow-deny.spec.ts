// spec: docs/testing.md
// helpers: tests/helpers/playwright.ts

import { test, expect } from '@playwright/test';
import { expectNoBrowserErrors, gotoMock, sendChatMessage, waitForIdle } from '../../helpers/playwright';
import { ANOTHER_WORKSPACE, openSessionsSidebar, openWorkspaceSession } from '../../helpers/p0-ui';

test.describe('P0 日常零 token Mock UI 回归', () => {
  test('P0-06 权限审批 allow/deny 与本会话总是允许', async ({ page }) => {
    await gotoMock(page);

    // 1. 发送 test:permission 后显示权限请求 bottom sheet。
    await sendChatMessage(page, 'test:permission');
    await expect(page.locator('#permModal')).toBeVisible();
    await expect(page.locator('#permTool')).toHaveText('run_command');
    await expect(page.locator('#permCwd')).toContainText('/Users/you/code/claude-chat-mobile');
    // UX-001：普通命令去掉 JSON 引号转义，mono 纯文本
    await expect(page.locator('#permInput')).toHaveText('git push origin main');
    await expect(page.locator('#permAlways')).toBeVisible();

    // 2. 点击允许，工具卡片成功。
    await page.locator('#permAllow').click();
    await expect(page.locator('#permModal')).toBeHidden();
    // UX-019：审批留痕必须保留（不许吞）
    await expect(page.locator('#messages')).toContainText('已允许');
    await waitForIdle(page);
    await expect(page.locator('details.toolcard .t-status').last()).toHaveAttribute('aria-label', '成功');
    await expect(page.locator('[data-testid="assistant-message"]').last()).toContainText('Successfully pushed');

    // 3. fresh state 后点击拒绝，工具卡片拒绝。
    await gotoMock(page);
    await sendChatMessage(page, 'test:permission');
    await expect(page.locator('#permModal')).toBeVisible();
    await page.locator('#permDeny').click();
    await expect(page.locator('#permModal')).toBeHidden();
    await waitForIdle(page);
    await expect(page.locator('details.toolcard .t-status').last()).toHaveAttribute('aria-label', '已拒绝');
    await expect(page.locator('[data-testid="assistant-message"]').last()).toContainText('rejected by user');

    await expectNoBrowserErrors(page);
  });

  test('P0-06b 本会话总是允许同类操作后不再重复弹审批', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:permission');
    await expect(page.locator('#permModal')).toBeVisible();
    await page.locator('#permAlways').check();
    await page.locator('#permAllow').click();
    await expect(page.locator('#permModal')).toBeHidden();
    await waitForIdle(page);

    await sendChatMessage(page, 'test:permission');
    await waitForIdle(page);
    await expect(page.locator('#permModal')).toBeHidden();
    await expect(page.locator('[data-testid="assistant-message"]').last()).toContainText('Successfully pushed');

    await expectNoBrowserErrors(page);
  });

  test('P0-06c 其它设备解决权限请求后当前审批弹窗自动关闭', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:permission-remote-resolved');
    await expect(page.locator('#permModal')).toBeVisible();
    await expect(page.locator('#permTool')).toHaveText('run_command');
    await expect(page.locator('#permInput')).toContainText('git push origin main');

    await expect(page.locator('#permModal')).toBeHidden();
    await waitForIdle(page);
    await expect(page.locator('details.toolcard .t-status').last()).toHaveAttribute('aria-label', '成功');
    await expect(page.locator('[data-testid="assistant-message"]').last()).toContainText('approved on another trusted device');

    await expectNoBrowserErrors(page);
  });

  test('P0-06d 本会话总是允许不会泄漏到另一会话', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:permission');
    await expect(page.locator('#permModal')).toBeVisible();
    await page.locator('#permAlways').check();
    await page.locator('#permAllow').click();
    await expect(page.locator('#permModal')).toBeHidden();
    await waitForIdle(page);

    await sendChatMessage(page, 'test:tab');
    await waitForIdle(page);
    await openSessionsSidebar(page);
    await openWorkspaceSession(page, ANOTHER_WORKSPACE, 'Another App Concurrency');
    await expect(page.locator('#pillPermText')).toContainText('计划模式');

    await sendChatMessage(page, 'test:permission');
    await expect(page.locator('#permModal')).toBeVisible();
    await expect(page.locator('#permTool')).toHaveText('run_command');

    await expectNoBrowserErrors(page);
  });

  test('P0-06e 当前审批轮失败结果会关闭弹窗并恢复输入', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:permission-result-error');
    await expect(page.locator('#permModal')).toBeVisible();
    await expect(page.locator('#permTool')).toHaveText('run_command');
    await expect(page.locator('#permInput')).toContainText('git push origin main');

    await expect(page.locator('#permModal')).toBeHidden({ timeout: 10_000 });
    await waitForIdle(page);
    await expect(page.locator('#messages')).toContainText('出错：mock permission turn failed');
    const failedCard = page.locator('details.toolcard').filter({ hasText: 'run_command' }).last();
    await expect(failedCard.locator('.t-status')).toHaveAttribute('aria-label', '出错');
    await failedCard.locator('summary').click();
    await expect(failedCard.locator('.t-out')).toContainText('mock permission turn failed');

    await sendChatMessage(page, 'test:settings-echo');
    await waitForIdle(page);
    await expect(page.locator('[data-testid="assistant-message"]').last()).toContainText('设置回显：model=');

    await expectNoBrowserErrors(page);
  });

  test('P0-06f 审批弹窗打开时触屏 Enter 不提交且保留换行草稿', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:permission');
    await expect(page.locator('#permModal')).toBeVisible();
    await expect(page.locator('#permInput')).toContainText('git push origin main');
    await expect(page.locator('[data-testid="user-message"]')).toHaveCount(1);

    await page.locator('#input').fill('test:settings-echo');
    await expect(page.locator('#btnSend')).toBeDisabled();
    await expect(page.locator('#btnSend')).toHaveAttribute('title', '请先处理当前审批或选择');
    await page.locator('#input').press('Enter');

    await expect(page.locator('#permModal')).toBeVisible();
    await expect(page.locator('#permInput')).toContainText('git push origin main');
    await expect(page.locator('[data-testid="user-message"]')).toHaveCount(1);
    await expect(page.locator('#input')).toHaveValue('test:settings-echo\n');

    await page.locator('#permDeny').click();
    await expect(page.locator('#permModal')).toBeHidden();
    await waitForIdle(page);
    await expect(page.locator('#input')).toHaveValue('test:settings-echo\n');
    await expect(page.locator('#btnSend')).toBeEnabled();
    await page.locator('#btnSend').click();
    await waitForIdle(page);
    await expect(page.locator('[data-testid="assistant-message"]').last()).toContainText('设置回显：model=');

    await expectNoBrowserErrors(page);
  });

  test('P0-06g 点击审批弹窗遮罩不会关闭或提交背景草稿', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:permission');
    await expect(page.locator('#permModal')).toBeVisible();
    await expect(page.locator('#permInput')).toContainText('git push origin main');
    await expect(page.locator('[data-testid="user-message"]')).toHaveCount(1);

    await page.locator('#input').fill('draft while approving');
    await page.locator('#permModal').click({ position: { x: 12, y: 12 } });

    await expect(page.locator('#permModal')).toBeVisible();
    await expect(page.locator('#permInput')).toContainText('git push origin main');
    await expect(page.locator('[data-testid="user-message"]')).toHaveCount(1);
    await expect(page.locator('#input')).toHaveValue('draft while approving');
    await expect(page.locator('#btnSend')).toBeDisabled();

    await page.locator('#permDeny').click();
    await expect(page.locator('#permModal')).toBeHidden();
    await waitForIdle(page);
    await expect(page.locator('#input')).toHaveValue('draft while approving');

    await expectNoBrowserErrors(page);
  });

  test('UX-003 审批 sheet 弹出后短暂防误触（pointer-events）', async ({ page }) => {
    // 纯视觉/交互契约：.sheet-arming 下按钮 pointer-events:none；解除后可点。
    // 不依赖真实 350ms 竞态（goto 后事件到达时间不定），直接验证 CSS + 类切换契约。
    await gotoMock(page);
    await sendChatMessage(page, 'test:permission');
    await expect(page.locator('#permModal')).toBeVisible();

    const peWhileArming = await page.locator('#permModal').evaluate((modal) => {
      modal.classList.add('sheet-arming');
      return getComputedStyle(modal.querySelector('#permAllow')).pointerEvents;
    });
    expect(peWhileArming).toBe('none');

    const peAfter = await page.locator('#permModal').evaluate((modal) => {
      modal.classList.remove('sheet-arming');
      return getComputedStyle(modal.querySelector('#permAllow')).pointerEvents;
    });
    expect(peAfter).not.toBe('none');

    // 解除后允许点击走通；等 turn 结束避免污染 worker 内后续用例
    await page.locator('#permDeny').click();
    await expect(page.locator('#permModal')).toBeHidden();
    await waitForIdle(page);
    await expectNoBrowserErrors(page);
  });
});
