// spec: specs/claude-chat-mobile-comprehensive-test-plan.md
// seed: tests/seed.goto-mock.spec.ts

import { test, expect } from '@playwright/test';
import { expectNoBrowserErrors, gotoMock } from '../seed.goto-mock.spec';

test.describe('P0 日常零 token Mock UI 回归', () => {
  test('P0-09 设置面板：权限模式、模型选择、thinking effort 与 [1m] 后缀', async ({ page }) => {
    await gotoMock(page);

    // 1. 打开配置面板，检查模型、权限、思考强度入口。
    await page.locator('#btnSettings').click();
    await expect(page.locator('#settingsSheet')).not.toHaveClass(/translate-y-full/);
    await expect(page.locator('#settingsSheet')).toContainText('选择模型');
    await expect(page.locator('.model-tile')).toContainText(['沿用当前模型', 'Claude 3.5 Sonnet', 'Claude 3.5 Haiku', 'Claude 3 Opus', 'Claude 3 Opus (1m Context)']);
    await expect(page.locator('.perm-tile')).toHaveCount(5);

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
});
