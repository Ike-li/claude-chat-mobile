// spec: 配置面板按作用域拆分——齿轮=会话设置（模型/权限/思考强度/会话ID）、侧栏底部入口=通用设置
// （📱 本机偏好 + 🖥 主机与服务 + 🔑 访问与帮助）。核心回归点是**可达性**：通用设置的那几段与会话
// 无关，却曾因唯一入口 #btnSettings 挂在 #composerFooter 内、首页把整个 footer 设 hidden 而一起失联。
// helpers: tests/helpers/playwright.ts

import { test, expect } from '@playwright/test';
import { gotoMock, expectNoBrowserErrors } from '../../helpers/playwright';

test.describe('P0 日常零 token Mock UI 回归', () => {
  test('P0-28 首页无会话时通用设置仍可达（齿轮随 composer 隐藏，侧栏入口不受影响）', async ({ page }) => {
    await gotoMock(page);
    await page.locator('#btnHome').click();

    // 前提：首页确实没有齿轮——这正是本用例存在的理由，若哪天 composer 常驻了此断言会提醒重新评估
    await expect(page.locator('#btnSettings')).toBeHidden();

    await page.locator('#btnSessions').click();
    await expect(page.locator('#leftSidebar')).not.toHaveClass(/-translate-x-full/);

    // 侧栏底部固定条：必须是 #sessionPanel 的兄弟节点，否则 openSessionPanel 的 innerHTML='' 会清掉它
    const entry = page.locator('#btnGeneralSettings');
    await expect(entry).toBeVisible();
    await entry.click();

    // 点设置先收侧栏再弹 sheet（两者同为 z-40，同时开会视觉打架）
    await expect(page.locator('#leftSidebar')).toHaveClass(/-translate-x-full/);
    await expect(page.locator('#generalSheet')).not.toHaveClass(/translate-y-full/);

    // 三节内容齐全：本机 / 主机 / 访问帮助
    await expect(page.locator('#generalSheetBody #prefLang')).toHaveCount(1);
    await expect(page.locator('#generalSheetBody #prefAlertSound')).toHaveCount(1);
    await expect(page.locator('#generalSheetBody #pushStatusRow')).toHaveCount(1);
    await expect(page.locator('#generalSheetBody #hooksBridgeSection')).toHaveCount(1);
    await expect(page.locator('#generalSheetBody #btnServiceStatus')).toHaveCount(1);
    await expect(page.locator('#generalSheetBody #accessHelpOpen')).toHaveCount(1);
    await expect(page.locator('#generalSheetBody #linkGithub')).toHaveCount(1);

    // Escape 关闭
    await page.keyboard.press('Escape');
    await expect(page.locator('#generalSheet')).toHaveClass(/translate-y-full/);

    await expectNoBrowserErrors(page);
  });

  test('P0-28b 齿轮面板收窄为会话级：留模型/权限/思考强度/会话ID，本机与主机项已迁出', async ({ page }) => {
    await gotoMock(page);

    await page.locator('#btnSettings').click();
    await expect(page.locator('#settingsSheet')).not.toHaveClass(/translate-y-full/);

    // 会话级留守
    await expect(page.locator('#settingsSheetBody #customModelGrid')).toHaveCount(1);
    await expect(page.locator('#settingsSheetBody #customPermGrid')).toHaveCount(1);
    await expect(page.locator('#settingsSheetBody #customEffortGroup')).toHaveCount(1);
    await expect(page.locator('#settingsSheetBody #btnConfigRefresh')).toHaveCount(1);
    // 会话 ID 是会话级，从原「访问与设备」段迁入
    await expect(page.locator('#settingsSheetBody #settingsSessionRow')).toHaveCount(1);

    // 本机级 / 主机级已不在会话面板内
    await expect(page.locator('#settingsSheetBody #prefLang')).toHaveCount(0);
    await expect(page.locator('#settingsSheetBody #prefAlertSound')).toHaveCount(0);
    await expect(page.locator('#settingsSheetBody #hooksBridgeSection')).toHaveCount(0);
    await expect(page.locator('#settingsSheetBody #btnServiceStatus')).toHaveCount(0);
    await expect(page.locator('#settingsSheetBody #linkGithub')).toHaveCount(0);

    await expectNoBrowserErrors(page);
  });

  test('P0-28c 每段带作用域说明，用户看得出这条设置影响谁', async ({ page }) => {
    await gotoMock(page);

    await page.locator('#btnSettings').click();
    await expect(page.locator('[data-scope-note="session"]')).toBeVisible();
    await page.keyboard.press('Escape');

    await page.locator('#btnSessions').click();
    await page.locator('#btnGeneralSettings').click();
    await expect(page.locator('[data-scope-note="device"]')).toBeVisible();
    await expect(page.locator('[data-scope-note="host"]')).toBeVisible();

    await expectNoBrowserErrors(page);
  });

  // 可达性的另一半：会话页里侧栏入口同样在，不必先回首页。齿轮与侧栏入口是两条并行通道，
  // 不是「首页走这条、会话页走那条」的互斥分支。
  test('P0-28d 会话页里侧栏设置入口同样可达，且与齿轮面板互不干扰', async ({ page }) => {
    await gotoMock(page);
    await expect(page.locator('#btnSettings')).toBeVisible();

    await page.locator('#btnSessions').click();
    await page.locator('#btnGeneralSettings').click();
    await expect(page.locator('#generalSheet')).not.toHaveClass(/translate-y-full/);
    // 通用设置打开时不会顺带把会话设置也掀起来
    await expect(page.locator('#settingsSheet')).toHaveClass(/translate-y-full/);

    await page.keyboard.press('Escape');
    await expect(page.locator('#generalSheet')).toHaveClass(/translate-y-full/);

    // 关掉通用设置后齿轮照常可用
    await page.locator('#btnSettings').click();
    await expect(page.locator('#settingsSheet')).not.toHaveClass(/translate-y-full/);

    await expectNoBrowserErrors(page);
  });
});
