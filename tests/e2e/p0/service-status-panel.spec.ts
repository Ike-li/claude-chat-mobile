// spec: docs/testing.md
// helpers: tests/helpers/playwright.ts
// 服务状态面板（NFR-15 可见性）：设置入口 → 三段式 sheet（基础/运行指标/异常告警），
// 数据走鉴权 service:status ack（mock server 返回确定性 payload）。

import { test, expect } from '@playwright/test';
import { expectNoBrowserErrors, gotoMock, sendChatMessage, waitForIdle } from '../../helpers/playwright';

test.describe('P0 日常零 token Mock UI 回归', () => {
  test('P0-22 服务状态面板：设置入口打开 → 三段渲染 → 关闭', async ({ page }) => {
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

    // 3. 指标段：8 项 label 齐全 + 数值千分位透传
    for (const label of ['活跃会话', '事件总数', '断线补发命中', '补发降级重载', '限速锁定', '推送成功', '推送失败', 'ntfy 失败']) {
      await expect(body).toContainText(label);
    }
    await expect(body).toContainText('1,841');

    // 4. 告警段：无注入时「无异常」+ 刷新口径提示
    await expect(body).toContainText('✓ 无异常');
    await expect(body).toContainText('指标随服务重启清零');

    // 5. ✕ 关闭（300ms 收合动画后 hidden）
    await page.locator('#serviceStatusClose').click();
    await expect(page.locator('#serviceStatusModal')).toBeHidden();

    await expectNoBrowserErrors(page);
  });

  test('P0-22b 投递失败注入 → 面板告警段出红行、失败指标标红', async ({ page }) => {
    await gotoMock(page);

    // 1. 注入投递失败（后续 service:status ack 带 deliveryFailure + pushFailure=3）
    await sendChatMessage(page, 'test:service-delivery-failure');
    await waitForIdle(page);

    // 2. 打开面板：告警段渲染失败行（文案与抽屉「服务」小节同源纯函数）
    await page.locator('#btnSettings').click();
    await page.locator('#btnServiceStatus').click();
    const body = page.locator('#serviceStatusBody');
    await expect(body).toContainText('推送最近失败于');
    await expect(body).toContainText('（push，累计 3 次）');

    // 3. 失败类指标 >0 标红（alert 行着 text-danger）
    await expect(body.locator('.text-danger').first()).toBeVisible();
    await expect(body).not.toContainText('✓ 无异常');

    await expectNoBrowserErrors(page);
  });
});
