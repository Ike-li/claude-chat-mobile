// spec: docs/testing.md
// helpers: tests/helpers/playwright.ts
// 服务状态面板（NFR-15 可见性，判定化改造后）：设置入口 → 两段式 sheet（基础/异常告警），
// 裸计数器段已撤（原始计数留 /metrics 巡检端点）；数据走鉴权 service:status ack（mock 确定性 payload）。

import { test, expect } from '@playwright/test';
import { expectNoBrowserErrors, gotoMock, sendChatMessage, waitForIdle } from '../../helpers/playwright';

test.describe('P0 日常零 token Mock UI 回归', () => {
  test('P0-22 服务状态面板：设置入口打开 → 两段渲染 → 关闭', async ({ page }) => {
    await gotoMock(page);

    // 1. 设置面板 → 点「服务状态」入口：状态 sheet 弹出、设置 sheet 收起
    await page.locator('#btnSettings').click();
    await expect(page.locator('#settingsSheet')).not.toHaveClass(/translate-y-full/);
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
    await page.locator('#btnSettings').click();
    await page.locator('#btnServiceStatus').click();
    const body = page.locator('#serviceStatusBody');
    await expect(body).toContainText('推送最近失败于');
    await expect(body).toContainText('（push，累计 3 次）');

    // 3. 投递失败行着 text-danger（判色查 classList 非 textContent）
    await expect(body.locator('.text-danger').first()).toBeVisible();
    await expect(body).not.toContainText('✓ 无异常');

    await expectNoBrowserErrors(page);
  });

  test('P0-22c 限速锁定+前端错误注入 → 升格告警行渲染与判色', async ({ page }) => {
    await gotoMock(page);

    // 1. 注入判定化告警（后续 service:status ack 带 rateLimitLockout + clientError）
    await sendChatMessage(page, 'test:service-incidents');
    await waitForIdle(page);

    // 2. 打开面板：⛔ 限速锁定（安全信号）+ 🐞 前端错误（指向日志面板）
    await page.locator('#btnSettings').click();
    await page.locator('#btnServiceStatus').click();
    const body = page.locator('#serviceStatusBody');
    await expect(body).toContainText('登录限速锁定于 42 分钟前（累计 2 次）');
    await expect(body).toContainText('可能有人在暴力尝试你的入口');
    await expect(body).toContainText('前端错误发生于 3 分钟前（累计 5 次），详见日志面板');

    // 3. 判色：⛔ 红（安全事件）、🐞 黄（判色查 classList 非 textContent）
    await expect(body.locator('.text-danger', { hasText: '登录限速锁定' })).toBeVisible();
    await expect(body.locator('.text-warning', { hasText: '前端错误' })).toBeVisible();
    await expect(body).not.toContainText('✓ 无异常');

    await expectNoBrowserErrors(page);
  });
});
