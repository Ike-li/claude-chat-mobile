// helpers: tests/helpers/playwright.ts
// 服务状态面板（NFR-15 可见性，判定化改造后）：设置入口 → 两段式 sheet（基础/异常告警），
// 裸计数器段已撤（原始计数留 /metrics 巡检端点）；数据走鉴权 service:status ack（mock 确定性 payload）。

import { test, expect } from '@playwright/test';
import { expectNoBrowserErrors, gotoMock, openGeneralDiagSection, openGeneralSettings, sendChatMessage, waitForIdle } from '../../helpers/playwright';

test.describe('P0 日常零 token Mock UI 回归', () => {
  test('P0-22 服务状态面板：设置入口打开 → 两段渲染 → 关闭', async ({ page }) => {
    await gotoMock(page);

    // 1. 设置面板 → 点「服务状态」入口：状态 sheet 弹出、设置 sheet 收起
    await openGeneralSettings(page);
    await openGeneralDiagSection(page);
    await page.locator('#btnServiceStatus').click();
    await expect(page.locator('#serviceStatusModal')).toBeVisible();
    await expect(page.locator('#settingsSheet')).toHaveClass(/translate-y-full/);

    // 2. 基础段：运行时长/启动于/版本/连接（mock 确定性版本串）
    const body = page.locator('#serviceStatusBody');
    await expect(body).toContainText('运行时长');
    await expect(body).toContainText('启动于');
    await expect(body).toContainText('server 1.2.1-mock · CLI 0.1.0-mock · SDK 0.3.201-mock');
    await expect(body).toContainText('已连接');
    await expect(body).toContainText('日志开关');
    await expect(body).toContainText('交互日志 开 · SDK 调试 关 · stderr 开');

    // 2.5 重启记录段：launchd 只留「最后一次退出码」那个瞬时值，回答不了「这正常吗」。
    // 夹具给的是一条例行重启（每天一次的 DHCP 漂移），所以**不该标黄** ——
    // 恒亮的告警会训练用户忽略它，那正是这一段要避免的。
    await expect(body).toContainText('重启记录');
    await expect(body).toContainText('com.ccm.tunnel');
    await expect(body).toContainText('24 小时内 1 次');
    // 只针对重启摘要断言"不标黄"。此前这里是全面板 .text-warning count 0，安全日志段落地后
    // 那条本机限速记录（warning）会让它红——但那不是重启段的回归，判据得说清自己在测哪一段。
    await expect(body.locator('.text-warning', { hasText: '小时内重启' })).toHaveCount(0);

    // 3. 裸计数器段已撤：不再渲染「运行指标」及其行 label
    await expect(body).not.toContainText('运行指标');
    await expect(body).not.toContainText('活跃会话');
    await expect(body).not.toContainText('事件总数');

    // 4. 告警段：无注入时「无异常」+ 刷新/时效窗口口径提示
    await expect(body).toContainText('✓ 无异常');
    await expect(body).toContainText('告警超 24 小时自动退场');

    // 5. ✕ 关闭（300ms 收合动画后 hidden）
    await page.locator('#serviceStatusClose').click();
    await expect(page.locator('#serviceStatusModal')).toBeHidden();

    await expectNoBrowserErrors(page);
  });

  test('P0-22b 投递失败注入 → 面板告警段出红行', async ({ page }) => {
    await gotoMock(page);

    // 1. 注入投递失败（后续 service:status ack 带 deliveryFailure）
    await sendChatMessage(page, 'test:service-delivery-failure');
    await waitForIdle(page);

    // 2. 打开面板：告警段渲染失败行（文案与抽屉「服务」小节同源纯函数）
    await openGeneralSettings(page);
    await openGeneralDiagSection(page);
    await page.locator('#btnServiceStatus').click();
    const body = page.locator('#serviceStatusBody');
    await expect(body).toContainText('推送最近失败于');
    await expect(body).toContainText('（push，累计 3 次）');

    // 3. 投递失败行着 text-danger（判色查 classList 非 textContent）
    await expect(body.locator('.text-danger').first()).toBeVisible();
    await expect(body).not.toContainText('✓ 无异常');

    await expectNoBrowserErrors(page);
  });

  // 第三轮审查补的盲区：默认夹具刻意不 flapping（恒亮黄字会掩盖回归），于是
  // `item.alert ? 'text-warning' : null` 这个映射从来没被正向断言过 —— 把它改成恒 null，
  // 全套单测与 E2E 照样绿。这条用例把「频繁重启 → 黄字」钉住。
  test('P0-22d 频繁重启注入 → 重启记录段出黄字摘要（判色查 classList）', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:service-flapping');
    await waitForIdle(page);

    await openGeneralSettings(page);
    await openGeneralDiagSection(page);
    await page.locator('#btnServiceStatus').click();
    const body = page.locator('#serviceStatusBody');

    // 摘要说的是**频率**（1 小时内 N 次），不是「曾崩溃 / 上次异常退出」那套退出码语义
    await expect(body).toContainText('1 小时内重启 4');
    await expect(body).not.toContainText('曾崩溃');
    // ★ 正向断言映射：flapping 那行的**值**必须带 text-warning。
    // addRow 把 valueClass 加在 row.lastChild（值那个 span）上，label 在 firstChild ——
    // 按 label 去 filter 永远匹配不到，这是写这条断言时踩过的坑。
    await expect(body.locator('.text-warning', { hasText: '1 小时内重启 4' })).toBeVisible();
    await expect(body).toContainText('com.ccm.server');
    // 时间线仍是常规灰字，不该跟着标黄
    await expect(body.locator('.text-ink-faint', { hasText: '重启' }).first()).toBeVisible();

    await expectNoBrowserErrors(page);
  });

  test('P0-22c 限速锁定+前端错误注入 → 升格告警行渲染与判色', async ({ page }) => {
    await gotoMock(page);

    // 1. 注入判定化告警（后续 service:status ack 带 rateLimitLockout + clientError）
    await sendChatMessage(page, 'test:service-incidents');
    await waitForIdle(page);

    // 2. 打开面板：⛔ 限速锁定（安全信号）+ 🐞 前端错误（指向日志面板）
    await openGeneralSettings(page);
    await openGeneralDiagSection(page);
    await page.locator('#btnServiceStatus').click();
    const body = page.locator('#serviceStatusBody');
    await expect(body).toContainText('登录限速锁定于 42 分钟前（累计 2 次）');
    await expect(body).toContainText('可能有人在暴力尝试你的入口');
    await expect(body).toContainText('前端错误发生于 3 分钟前（累计 5 次），详见日志面板');

    // 3. 判色：⛔ 红（安全事件）、🐞 黄（判色查 classList 非 textContent）
    // hasText 带「于」：安全日志段也有一行「登录限速锁定 · 公网 …」同为 text-danger，
    // 不加这个字会同时命中两行、触发 strict mode violation。
    await expect(body.locator('.text-danger', { hasText: '登录限速锁定于' })).toBeVisible();
    await expect(body.locator('.text-warning', { hasText: '前端错误' })).toBeVisible();
    await expect(body).not.toContainText('✓ 无异常');

    await expectNoBrowserErrors(page);
  });

  // 安全日志段（2026-09-02）：告警段说「发生过限速锁定」，这一段回答「是谁」。
  // 实测遇到的两次锁定来源都是 ip:127.0.0.1（自己的旧 token），而告警文案当时无条件写
  // 「可能有人在暴力尝试你的入口」——这条用例把「来源分档 → 措辞与判色都跟着变」钉死。
  test('P0-22e 安全日志段：审计记录译成人话，来源决定措辞与判色', async ({ page }) => {
    await gotoMock(page);

    await openGeneralSettings(page);
    await openGeneralDiagSection(page);
    await page.locator('#btnServiceStatus').click();
    const body = page.locator('#serviceStatusBody');

    await expect(body).toContainText('安全日志');
    await expect(body).toContainText('（最近 20 条）');

    // 公网来源 → 红：这才是该警觉的那一类
    await expect(body.locator('.text-danger', { hasText: '登录限速锁定 · 公网 203.0.113.7 · http' })).toBeVisible();
    // 本机来源 → 黄：连试八次是手滑不是入侵。判色查 classList（textContent 分不出档）
    await expect(body.locator('.text-warning', { hasText: '登录限速锁定 · 本机 127.0.0.1 · http' })).toBeVisible();
    // 中性事件 → 常规色，且设备 ID 截到 8 位（全量指纹既占宽也没人逐字读）
    await expect(body).toContainText('批准设备 dev01234 · web');
    await expect(body).not.toContainText('dev0123456789');

    await expectNoBrowserErrors(page);
  });

});
