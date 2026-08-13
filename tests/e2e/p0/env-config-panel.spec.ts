// spec: docs/testing.md
// helpers: tests/helpers/playwright.ts
// 服务与配置面板：设置入口 → 表单由服务端 env:get 下发（前端零硬编码配置项名）→ 敏感项只显示遮罩。
// 最重要的一条是「敏感项永远拿不到明文」——服务端只下发 { set, length }，页面上不该出现任何密钥值。

import { test, expect } from '@playwright/test';
import { expectNoBrowserErrors, gotoMock, openGeneralDiagSection, openGeneralSettings } from '../../helpers/playwright';

test.describe('P0 日常零 token Mock UI 回归', () => {
  test('P0-31 服务与配置面板：入口打开 → 分组渲染 → 敏感项遮罩 → 只读项禁用', async ({ page }) => {
    await gotoMock(page);

    // 1. 设置 → 诊断段 → 服务与配置：面板弹出，设置 sheet 收起
    await openGeneralSettings(page);
    await openGeneralDiagSection(page);
    await page.locator('#btnEnvConfig').click();
    await expect(page.locator('#envConfigModal')).toBeVisible();
    await expect(page.locator('#settingsSheet')).toHaveClass(/translate-y-full/);

    const body = page.locator('#envConfigBody');

    // 2. 分组标题来自服务端下发（前端不硬编码任何配置项名）
    await expect(body).toContainText('鉴权');
    await expect(body).toContainText('运行时');
    await expect(body).toContainText('推送');

    // 3. 普通项渲染出当前值
    await expect(body.locator('input[data-key="PORT"]')).toHaveValue('3000');
    await expect(body.locator('input[data-key="WORK_DIR"]')).toHaveValue('/Users/you/code');

    // 4. ★ 敏感项只显示「已设置（N 字符）」，页面上不得出现明文
    await expect(body).toContainText('已设置（64 字符）'); // AUTH_TOKEN
    await expect(body).toContainText('已设置（43 字符）'); // VAPID_PRIVATE_KEY
    // 遮罩项在点「更换」之前根本没有输入框可读
    await expect(body.locator('input[data-key="AUTH_TOKEN"]')).toHaveCount(0);

    // 5. 只读诊断段：解释「为什么 ANTHROPIC_* 不在表单里」，少了它用户会以为面板漏了
    await expect(body).toContainText('此处不可改');
    await expect(body).toContainText('ANTHROPIC_*');

    // 6. 未设置的项渲染成空输入框（而不是缺席）
    await expect(body.locator('input[data-key="NTFY_TOPIC"]')).toHaveValue('');

    await expectNoBrowserErrors(page);
  });

  test('P0-31b 保存按钮：无改动时禁用，改一项后启用', async ({ page }) => {
    await gotoMock(page);
    await openGeneralSettings(page);
    await openGeneralDiagSection(page);
    await page.locator('#btnEnvConfig').click();

    const save = page.locator('#envConfigSave');
    await expect(save).toBeDisabled();

    // 改端口 → 按钮可用 + 提示需重启（配置生效靠重启，这点必须在保存前就说清）
    await page.locator('#envConfigBody input[data-key="PORT"]').fill('8080');
    await expect(save).toBeEnabled();
    await expect(page.locator('#envConfigHint')).toContainText('重启');

    // 改回原值 → 重新变回「无改动」，不该留下假的脏标记
    await page.locator('#envConfigBody input[data-key="PORT"]').fill('3000');
    await expect(save).toBeDisabled();

    await expectNoBrowserErrors(page);
  });

  test('P0-31c 敏感项「更换」：点了才换出输入框，且提交空值表示清除', async ({ page }) => {
    await gotoMock(page);
    await openGeneralSettings(page);
    await openGeneralDiagSection(page);
    await page.locator('#btnEnvConfig').click();

    const body = page.locator('#envConfigBody');
    const secretInput = body.locator('input[data-key="VAPID_PRIVATE_KEY"]');

    // 初始隐藏
    await expect(secretInput).toBeHidden();

    // 点「更换」→ 输入框出现，且立刻算作一次改动（留空 = 清除该项，这个意图得能表达）
    await body.getByRole('button', { name: '更换' }).first().click();
    await expect(secretInput).toBeVisible();
    await expect(page.locator('#envConfigSave')).toBeEnabled();

    await expectNoBrowserErrors(page);
  });

  test('P0-31d 关闭：✕ 与点遮罩都能收起', async ({ page }) => {
    await gotoMock(page);
    await openGeneralSettings(page);
    await openGeneralDiagSection(page);

    await page.locator('#btnEnvConfig').click();
    await expect(page.locator('#envConfigModal')).toBeVisible();
    await page.locator('#envConfigClose').click();
    await expect(page.locator('#envConfigModal')).toBeHidden();

    await expectNoBrowserErrors(page);
  });
});
