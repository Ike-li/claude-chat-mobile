// spec: 配置面板按作用域拆分——底栏 chip=会话设置（模型/权限/思考强度/会话ID）、侧栏底部入口=通用设置
// （📱 本机偏好 + 🖥 主机与服务 + 🔑 访问与帮助）。核心回归点是**可达性**：通用设置的那几段与会话
// 无关，却曾因唯一入口挂在 #composerFooter 内、首页把整个 footer 设 hidden 而一起失联。
// helpers: tests/helpers/playwright.ts

import { test, expect } from '@playwright/test';
import { ensureComposerReady, gotoMock, expectNoBrowserErrors } from '../../helpers/playwright';

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
    // CLI 重读在标题行右侧（不占 body 纵向），仍属会话设置面板
    await expect(page.locator('#settingsSheet #btnConfigRefresh')).toHaveCount(1);
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

  // 作用域（本机 / 整机）从「把面板切成两大段」降级为「每组旁边一个 chip」：它回答的是
  // 「我改的东西影响谁」，那是**决定改之后**才关心的问题，不该占用导航主轴。信息一个字没丢。
  test('P0-28c 作用域以 chip 形式贴在组标题旁（会话设置仍无说明条）', async ({ page }) => {
    await gotoMock(page);

    // 会话设置：不再放「只影响当前会话…」说明条（省纵向、少废话）
    await page.locator('#pillDefaults').click();
    await expect(page.locator('#settingsSheet')).not.toHaveClass(/translate-y-full/);
    await expect(page.locator('[data-scope-note="session"]')).toHaveCount(0);
    await page.keyboard.press('Escape');

    await page.locator('#btnSessions').click();
    await page.locator('#btnGeneralSettings').click();

    // 「通知」页：本机档 chip 就在「怎么提醒我」那组旁边
    await page.locator('[data-testid="general-nav-notify"]').click();
    await expect(page.locator('#generalPage-notify [data-scope-chip="device"]')).toBeVisible();

    // 「行为与开关」页：语言是本机档，审批规则与服务配置是整机档——两档同页并存，正是 chip 化的意义。
    // host 档在这一页有多个组（审批规则、服务与配置），故取 first 而不是要求全页唯一。
    await page.locator('[data-testid="general-back"]').click();
    await page.locator('[data-testid="general-nav-behavior"]').click();
    await expect(page.locator('#generalPage-behavior [data-scope-chip="device"]').first()).toBeVisible();
    await expect(page.locator('#generalPage-behavior [data-scope-chip="host"]').first()).toBeVisible();

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
    // 深链在两级导航下是**两步**：先切到「通知」页，再滚到推送段。只滚不切页的话，目标还在
    // hidden 的子页里，scrollIntoView 静默无效——表现为「点了没反应」，所以两步都要钉。
    await expect(page.locator('#generalPage-notify')).toBeVisible();
    await expect(page.locator('[data-testid="general-nav-home"]')).toBeHidden();
    await expect(page.locator('#pushStatusRow')).toBeInViewport({ timeout: 3_000 });

    await expectNoBrowserErrors(page);
  });

  // 两级导航取代了平铺 + sticky 分段 chip。入口文案换到作用域轴（「设置与状态」），副标题点名
  // 「会有人专门来找」的四件事——旧文案里「本机提醒」在面板中根本不存在，而设备信任/吊销这个
  // 全站唯一能踢掉丢失手机的地方，四个词零指向。
  test('P0-28g 侧栏入口文案与 L1 目录：六行可扫，点进去是 L2 页，返回回得来', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoMock(page);
    await page.locator('#btnSessions').click();
    await expect(page.locator('#btnGeneralSettings')).toContainText('设置与状态');
    await expect(page.locator('#btnGeneralSettings')).toContainText('设备信任');
    await page.locator('#btnGeneralSettings').click();
    await expect(page.locator('#generalSheet')).not.toHaveClass(/translate-y-full/);

    // L1：六行目录，且默认就停在目录层（不记住上次翻到哪一页）
    await expect(page.locator('[data-testid="general-nav-home"]')).toBeVisible();
    await expect(page.locator('#generalNavRows > [data-nav-to]')).toHaveCount(6);
    await expect(page.locator('[data-testid="general-back"]')).toBeHidden();

    // 平铺时代的 sticky 分段导航已随两级化退役
    await expect(page.locator('[data-testid="general-section-nav"]')).toHaveCount(0);

    // L1 → L2：标题跟着换，返回键出现，其余五页收起
    await page.locator('[data-testid="general-nav-devices"]').click();
    await expect(page.locator('#generalPage-devices')).toBeVisible();
    await expect(page.locator('#generalPage-notify')).toBeHidden();
    await expect(page.locator('[data-testid="general-nav-home"]')).toBeHidden();
    await expect(page.locator('#generalSheetTitle')).toContainText('接入与设备');
    const back = page.locator('[data-testid="general-back"]');
    await expect(back).toBeVisible();

    // 指纹与信任名单必须同屏——指纹的唯一用途就是在名单里认出手上这台，
    // 此前二者分居「📱 本机」与「🖥 主机」两段、隔着整整一屏。
    await expect(page.locator('#generalPage-devices #deviceFingerprintShort')).toBeVisible();
    await expect(page.locator('#generalPage-devices #trustedDevicesSection')).toHaveCount(1);

    // L2 → L1
    await back.click();
    await expect(page.locator('[data-testid="general-nav-home"]')).toBeVisible();
    await expect(page.locator('#generalPage-devices')).toBeHidden();
    await expect(page.locator('#generalSheetTitle')).toContainText('设置与状态');

    await expectNoBrowserErrors(page);
  });

  // 缺口 3：MCP 服务器与 skills 数早就随 init 事件到了浏览器（agent.js emit('init')），
  // 但前端从来没有渲染面——grep mcpServers / skillsCount 在 app/public 下零命中。
  // 失败态必须带上原始 status：'failed' 与 'needs-auth' 是两种完全不同的处置。
  test('P0-28j 「这台电脑」页显示 MCP 服务器与 skills 数，失败的那台带原始状态', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoMock(page);
    await ensureComposerReady(page);

    await page.locator('#btnSessions').click();
    await page.locator('#btnGeneralSettings').click();
    await page.locator('[data-testid="general-nav-host"]').click();

    const body = page.locator('[data-testid="host-env-body"]');
    await expect(body).toBeVisible();
    await expect(body).toContainText('MCP');
    await expect(body).toContainText('filesystem');
    // 连不上的那台：名字后面必须跟着原始 status，不能压成一个笼统的「异常」
    await expect(body).toContainText('postgres（failed）');
    await expect(body).toContainText('Skills');
    await expect(body).toContainText('7');

    await expectNoBrowserErrors(page);
  });

  // 缺口 1a：审批白名单此前在 web 上既读不到也写不了——agent.js:269 明写放行白名单完全交给
  // settingSources 的 permissions.allow，而用户在手机上批到烦时无从知道那份名单里有什么。
  // ★ deny 与 allow 必须分档且可分辨：把 deny 显示成 allow 会让人以为危险操作已被放行。
  test('P0-28k 「行为与开关」页显示审批规则三档，deny 与 allow 分开且各自计数', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoMock(page);
    await ensureComposerReady(page);

    await page.locator('#btnSessions').click();
    await page.locator('#btnGeneralSettings').click();
    await page.locator('[data-testid="general-nav-behavior"]').click();

    const body = page.locator('[data-testid="permission-rules-body"]');
    await expect(body).toBeVisible();

    // 三档各自成组，计数跟着各自的条数走（mock 给的是 allow 3 / deny 1 / ask 1）
    const allow = body.locator('[data-rule-group="allow"]');
    const deny = body.locator('[data-rule-group="deny"]');
    await expect(allow).toContainText('3');
    await expect(allow).toContainText('Read');
    await expect(deny).toContainText('1');
    await expect(deny).toContainText('rm -rf');
    await expect(body.locator('[data-rule-group="ask"]')).toContainText('WebFetch');

    // ★ 那条危险规则必须落在 deny 组里，不能出现在 allow 组里
    await expect(allow).not.toContainText('rm -rf');

    await expectNoBrowserErrors(page);
  });

  // 缺口 4：接入二维码。此前只有终端有（node scripts/qr.js），而「人不在电脑前」正是本产品的前提。
  // ★ 二维码没有「安全的默认档」——码里含 token，等同一把钥匙。故必须两步展开，且离开页面就收起：
  //   钥匙不该挂在一个用户以为已经翻过去的界面上。
  test('P0-28l 接入二维码：两步展开、有倒计时、离开页面即收起', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoMock(page);
    await ensureComposerReady(page);

    await page.locator('#btnSessions').click();
    await page.locator('#btnGeneralSettings').click();
    await page.locator('[data-testid="general-nav-devices"]').click();

    // 第一步：只有入口按钮，码本身不在 DOM 里
    await expect(page.locator('[data-testid="qr-reveal"]')).toBeVisible();
    await expect(page.locator('[data-testid="qr-panel"]')).toBeHidden();
    await expect(page.locator('[data-testid="qr-canvas"]')).toHaveCount(0);

    // 第二步：点入口只到确认，**还不显示码**——这一条正是「两步」的意义
    await page.locator('[data-testid="qr-reveal"]').click();
    await expect(page.locator('[data-testid="qr-confirm"]')).toBeVisible();
    await expect(page.locator('[data-testid="qr-canvas"]')).toHaveCount(0);

    // 第三步：确认后才画出来，且带自动隐藏倒计时
    await page.locator('[data-testid="qr-confirm-show"]').click();
    await expect(page.locator('[data-testid="qr-panel"]')).toBeVisible();
    await expect(page.locator('[data-testid="qr-canvas"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="qr-countdown"]')).toContainText('自动隐藏');

    // ★ 离开这一页，码必须从 DOM 里真的消失（不是只加 hidden）
    await page.locator('[data-testid="general-back"]').click();
    await page.locator('[data-testid="general-nav-host"]').click();
    await expect(page.locator('[data-testid="qr-canvas"]')).toHaveCount(0);

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
