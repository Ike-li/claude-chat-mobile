// spec: 配置面板按作用域拆分——底栏 chip=会话设置（模型/权限/思考强度/会话ID）、侧栏底部入口=通用设置
// （📱 本机偏好 + 🖥 主机与服务 + 🔑 访问与帮助）。核心回归点是**可达性**：通用设置的那几段与会话
// 无关，却曾因唯一入口挂在 #composerFooter 内、首页把整个 footer 设 hidden 而一起失联。
// helpers: tests/helpers/playwright.ts

import { test, expect } from '@playwright/test';
import { gotoMock, expectNoBrowserErrors } from '../../helpers/playwright';

test.describe('P0 日常零 token Mock UI 回归', () => {
  test('P0-28 首页无会话时通用设置仍可达（会话设置 chip 随 composer 隐藏，侧栏入口不受影响）', async ({ page }) => {
    await gotoMock(page);
    await page.locator('#btnHome').click();

    // 前提：首页确实没有会话设置入口（chip 随 composer 隐藏）——这正是本用例存在的理由，
    // 若哪天 composer 常驻了此断言会提醒重新评估
    await expect(page.locator('#pillDefaults')).toBeHidden();

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

  test('P0-28b 会话设置面板收窄为会话级：留模型/权限/思考强度/会话ID，本机与主机项已迁出', async ({ page }) => {
    await gotoMock(page);

    await page.locator('#pillDefaults').click();
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

    await page.locator('#pillDefaults').click();
    await expect(page.locator('[data-scope-note="session"]')).toBeVisible();
    await page.keyboard.press('Escape');

    await page.locator('#btnSessions').click();
    await page.locator('#btnGeneralSettings').click();
    await expect(page.locator('[data-scope-note="device"]')).toBeVisible();
    await expect(page.locator('[data-scope-note="host"]')).toBeVisible();

    await expectNoBrowserErrors(page);
  });

  // 齿轮已删：它与底栏三个 chip（模型/权限/思考强度）打开的是同一个会话设置 sheet，
  // 纯重复入口。sheet 的全部内容（含会话 ID 行）从任一 chip 进都可达。
  test('P0-28f composer 无齿轮按钮；会话设置从模型 chip 仍可达（含会话 ID 行）', async ({ page }) => {
    await gotoMock(page);

    await expect(page.locator('#btnSettings')).toHaveCount(0);

    await page.locator('#pillDefaults').click();
    await expect(page.locator('#settingsSheet')).not.toHaveClass(/translate-y-full/);
    // 非折叠块内容（会话 ID 行）不因入口变化而失联
    await expect(page.locator('#settingsSheetBody #settingsSessionRow')).toHaveCount(1);

    await page.keyboard.press('Escape');
    await expect(page.locator('#settingsSheet')).toHaveClass(/translate-y-full/);

    await expectNoBrowserErrors(page);
  });

  // 推送铃铛与通用设置同理：它是本机推送健康的告警信号，跟会话无关，挂在 composer 里
  // 首页整个 footer 一藏就失联。迁到侧栏底部固定条后，任何页面都能从侧栏看到它。
  test('P0-28e 推送铃铛在侧栏底部而非 composer；点击→收侧栏+开通用设置', async ({ page }) => {
    // 真机视口（<768px）：历史上 app.css 的 @media 移动端块里有条 display:flex !important
    // 盖过 .hidden 把铃铛永远钉出来，桌面视口的 E2E 抓不到——显隐断言必须在窄屏下跑。
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoMock(page);

    // 已迁出 composer 动作区
    await expect(page.locator('#composerActions #btnPush')).toHaveCount(0);
    // 落点：侧栏底部固定条（#sessionPanel 的兄弟层，免遭 innerHTML='' 清空），默认隐藏——推送健康时不打扰
    await expect(page.locator('#leftSidebar #btnPush')).toHaveCount(1);
    await expect(page.locator('#btnPush')).toBeHidden();

    // 模拟「推送未接通」露出态（真实路径：notifications.setup() 在订阅失败/被拒时 remove hidden）
    await page.evaluate(() => document.getElementById('btnPush')?.classList.remove('hidden'));
    await page.locator('#btnSessions').click();
    await expect(page.locator('#leftSidebar')).not.toHaveClass(/-translate-x-full/);
    await expect(page.locator('#btnPush')).toBeVisible();

    // 点击 = 带去权威解释处：先收侧栏再弹通用设置（两者同 z-40，叠着会打架）
    await page.locator('#btnPush').click();
    await expect(page.locator('#leftSidebar')).toHaveClass(/-translate-x-full/);
    await expect(page.locator('#generalSheet')).not.toHaveClass(/translate-y-full/);
    await expect(page.locator('#generalSheetBody #pushStatusRow')).toHaveCount(1);
    // 深链：推送段应滚进视口（不卡在面板顶部「完成提示」）
    await expect(page.locator('#pushStatusRow')).toBeInViewport({ timeout: 3_000 });

    await expectNoBrowserErrors(page);
  });

  test('P0-28g 侧栏入口文案为「偏好与通知」；顶部分段锚点可跳到主机/帮助', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoMock(page);
    await page.locator('#btnSessions').click();
    await expect(page.locator('#btnGeneralSettings')).toContainText('偏好与通知');
    await page.locator('#btnGeneralSettings').click();
    await expect(page.locator('#generalSheet')).not.toHaveClass(/translate-y-full/);
    await expect(page.locator('[data-testid="general-section-nav"]')).toBeVisible();
    await page.locator('[data-scroll-to="generalSectionHelp"]').click();
    await expect(page.locator('#generalSectionHelp')).toBeInViewport({ timeout: 3_000 });
    await expect(page.locator('#generalDiagDetails')).toBeVisible();
    // 诊断默认折叠（无 open 属性）
    await expect(page.locator('#generalDiagDetails')).toHaveJSProperty('open', false);

    await expectNoBrowserErrors(page);
  });

  // 可达性的另一半：会话页里侧栏入口同样在，不必先回首页。会话设置 chip 与侧栏入口是两条并行通道，
  // 不是「首页走这条、会话页走那条」的互斥分支。
  test('P0-28d 会话页里侧栏设置入口同样可达，且与会话设置面板互不干扰', async ({ page }) => {
    await gotoMock(page);
    await expect(page.locator('#pillDefaults')).toBeVisible();

    await page.locator('#btnSessions').click();
    await page.locator('#btnGeneralSettings').click();
    await expect(page.locator('#generalSheet')).not.toHaveClass(/translate-y-full/);
    // 通用设置打开时不会顺带把会话设置也掀起来
    await expect(page.locator('#settingsSheet')).toHaveClass(/translate-y-full/);

    await page.keyboard.press('Escape');
    await expect(page.locator('#generalSheet')).toHaveClass(/translate-y-full/);

    // 关掉通用设置后会话设置 chip 照常可用
    await page.locator('#pillDefaults').click();
    await expect(page.locator('#settingsSheet')).not.toHaveClass(/translate-y-full/);

    await expectNoBrowserErrors(page);
  });
});
