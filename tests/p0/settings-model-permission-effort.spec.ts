// spec: specs/claude-chat-mobile-comprehensive-test-plan.md
// seed: tests/seed.goto-mock.spec.ts

import { test, expect } from '@playwright/test';
import { expectNoBrowserErrors, gotoMock, sendChatMessage, waitForIdle } from '../seed.goto-mock.spec';

test.describe('P0 日常零 token Mock UI 回归', () => {
  test('P0-09 设置面板：权限模式、模型选择、thinking effort 与 [1m] 后缀', async ({ page }) => {
    await gotoMock(page);

    // 1. 打开配置面板，检查模型、权限、思考强度入口。
    await page.locator('#btnSettings').click();
    await expect(page.locator('#settingsSheet')).not.toHaveClass(/translate-y-full/);
    await expect(page.locator('#settingsSheet')).toContainText('选择模型');
    await expect(page.locator('.model-tile')).toContainText(['Default (recommended)', 'Claude 3.5 Sonnet', 'Claude 3.5 Haiku', 'Claude 3 Opus', 'Claude 3 Opus (1m Context)']);
    await expect(page.locator('.perm-tile')).toHaveCount(6); // 含 CLI/SDK 支持但终端交互菜单不直接暴露的 auto

    // 2. 选择计划模式、[1m] 模型后缀和 high effort。
    await page.locator('.perm-tile[data-mode="plan"]').click();
    await page.locator('.model-tile[data-model="claude-3-opus[1m]"]').click();
    await page.locator('.effort-tile[data-level="high"]').click();
    await expect(page.locator('#pillPermText')).toContainText('计划模式');
    await expect(page.locator('#modelInput')).toHaveValue('claude-3-opus[1m]');
    await expect(page.locator('#effortSelect')).toHaveValue('high');
    await page.locator('#settingsClose').click();
    await expect(page.locator('#settingsSheet')).toHaveClass(/translate-y-full/);

    await expectNoBrowserErrors(page);
  });

  test('P0-09b 设置选择会随下一条消息发送并可见回显', async ({ page }) => {
    await gotoMock(page);

    await page.locator('#btnSettings').click();
    await page.locator('.perm-tile[data-mode="plan"]').click();
    await expect(page.locator('#pillPermText')).toContainText('计划模式');
    await page.locator('.model-tile[data-model="claude-3-opus[1m]"]').click();
    await page.locator('.effort-tile[data-level="high"]').click();
    await expect(page.locator('#modelInput')).toHaveValue('claude-3-opus[1m]');
    await expect(page.locator('#effortSelect')).toHaveValue('high');
    await page.locator('#settingsClose').click();

    await sendChatMessage(page, 'test:settings-echo');
    await waitForIdle(page);
    const reply = page.locator('[data-testid="assistant-message"]').last();
    await expect(reply).toContainText('model=claude-3-opus[1m]');
    await expect(reply).toContainText('permission=plan');
    await expect(reply).toContainText('effort=high');

    await expectNoBrowserErrors(page);
  });

  test('P0-09c 不支持 thinking effort 的模型不会沿用旧 effort', async ({ page }) => {
    await gotoMock(page);

    await page.locator('#btnSettings').click();
    await page.locator('.effort-tile[data-level="high"]').click();
    await expect(page.locator('#effortSelect')).toHaveValue('high');

    await page.locator('.model-tile[data-model="claude-3-5-haiku"]').click();
    await expect(page.locator('#modelInput')).toHaveValue('claude-3-5-haiku');
    await expect(page.locator('#customEffortGroup')).toHaveClass(/hidden/);
    await expect(page.locator('#effortRow')).toHaveClass(/hidden/);
    await expect(page.locator('#effortSelect')).toHaveValue('');
    await page.locator('#settingsClose').click();

    await sendChatMessage(page, 'test:settings-echo');
    await waitForIdle(page);
    const reply = page.locator('[data-testid="assistant-message"]').last();
    await expect(reply).toContainText('model=claude-3-5-haiku');
    await expect(reply).toContainText('effort=model-default');

    await expectNoBrowserErrors(page);
  });

  test('P0-09d 新会话空首页设置会应用到首条消息', async ({ page }) => {
    await gotoMock(page);

    await page.locator('#btnNew').click();
    await expect(page.locator('#messages')).toHaveClass(/empty-start/);

    await page.locator('#btnSettings').click();
    await expect(page.locator('#settingsSheet')).not.toHaveClass(/translate-y-full/);
    await page.locator('.perm-tile[data-mode="plan"]').click();
    await page.locator('.model-tile[data-model="claude-3-opus[1m]"]').click();
    await page.locator('.effort-tile[data-level="high"]').click();
    await expect(page.locator('#pillPermText')).toContainText('计划模式');
    await expect(page.locator('#modelInput')).toHaveValue('claude-3-opus[1m]');
    await expect(page.locator('#effortSelect')).toHaveValue('high');
    await page.locator('#settingsClose').click();

    await sendChatMessage(page, 'test:fresh-settings-echo');
    await expect(page.locator('#messages')).not.toHaveClass(/empty-start/);
    await waitForIdle(page);
    const reply = page.locator('[data-testid="assistant-message"]').last();
    await expect(reply).toContainText('新会话设置回显：model=claude-3-opus[1m]');
    await expect(reply).toContainText('permission=plan');
    await expect(reply).toContainText('effort=high');

    await expectNoBrowserErrors(page);
  });

  test('P0-09e /model 本地命令只更新下一轮模型不发送聊天', async ({ page }) => {
    await gotoMock(page);

    await page.locator('#input').fill('/model claude-3-opus[1m]');
    await expect(page.locator('#btnSend')).toBeEnabled();
    await page.locator('#btnSend').click();

    await expect(page.locator('[data-testid="user-message"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="assistant-message"]')).toHaveCount(0);
    await expect(page.locator('#messages')).toContainText('模型已设为 claude-3-opus[1m]（下一条消息生效）');
    await expect(page.locator('#pillModelText')).toContainText('claude-3-opus[1m]');
    await expect(page.locator('#input')).toHaveValue('');

    await sendChatMessage(page, 'test:settings-echo');
    await waitForIdle(page);
    await expect(page.locator('[data-testid="user-message"]').last()).toContainText('test:settings-echo');
    await expect(page.locator('[data-testid="assistant-message"]').last()).toContainText('model=claude-3-opus[1m]');

    await expectNoBrowserErrors(page);
  });

  test('P0-09f CLI 镜像拿不到 effort 时显示未知，不伪装成 low', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:mirror-readonly');
    await expect(page.locator('#mirrorBanner')).toBeVisible();
    await expect(page.locator('#pillEffortText')).toHaveText('CLI 档位未知', { timeout: 800 });

    await page.locator('#btnSettings').click();
    await expect(page.locator('#effortSelect')).toHaveValue('');
    await expect(page.locator('#effortSelect option:checked')).toHaveText('CLI 当前档未知');

    await expectNoBrowserErrors(page);
  });

  test('P0-09g CLI 镜像展示观察态，接管后恢复 Web 设置偏好', async ({ page }) => {
    await gotoMock(page);

    await page.locator('#btnSettings').click();
    await page.locator('.perm-tile[data-mode="plan"]').click();
    await page.locator('.model-tile[data-model="claude-3-opus[1m]"]').click();
    await page.locator('.effort-tile[data-level="ultracode"]').click();
    await page.locator('#settingsClose').click();

    await sendChatMessage(page, 'test:mirror-observed-settings');
    await expect(page.locator('#mirrorBanner')).toBeVisible();
    await expect(page.locator('#pillModelText')).toHaveText('claude-opus-4-8[1m]');
    await expect(page.locator('#pillPermText')).toHaveText('Auto');
    await expect(page.locator('#pillEffortText')).toHaveText('max');

    page.once('dialog', dialog => dialog.accept());
    await page.locator('#btnMirrorOverride').click();
    await expect(page.locator('#mirrorBanner')).toBeHidden();
    await expect(page.locator('#modelInput')).toHaveValue('claude-3-opus[1m]');
    await expect(page.locator('#pillPermText')).toHaveText('计划模式');
    await expect(page.locator('#effortSelect')).toHaveValue('ultracode');

    await expectNoBrowserErrors(page);
  });
});
