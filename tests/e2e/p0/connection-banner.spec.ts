// spec: docs/testing.md
// helpers: tests/helpers/playwright.ts
//
// 连接状态横幅的端到端可见性。阈值边界（799/800、4999/5000 等）由纯逻辑单测
// tests/unit/logic-connection-banner.test.mjs 钉住，这里只测「真断线 → 真出现 → 真重连 → 真收起」，
// 避开「证明 800ms 内不显示」这类脆弱的反向计时断言。
// 5s 重试阈值用 web-first 断言的 timeout 等过去（非 waitForTimeout，过禁止模式门禁）。

import { test, expect } from '@playwright/test';
import { expectNoBrowserErrors, gotoMock, sendChatMessage, waitForIdle } from '../../helpers/playwright';

test.describe('P0 日常零 token Mock UI 回归', () => {
  test('P0-02g 断线时顶部横幅可见并给出重试，重连后变绿再自动收起', async ({ page }) => {
    await gotoMock(page);

    // 连接正常时横幅不占位（秒连不闪）
    await expect(page.locator('[data-testid="conn-banner"]')).toBeHidden();

    await sendChatMessage(page, 'test:disconnect-now');
    await expect(page.locator('#connDot')).toHaveClass(/bg-danger/, { timeout: 10_000 });

    // 断开超过 1s → 横幅出现，文案可读（这正是此前只有 3.5px 小圆点、没有任何可读反馈的地方）
    const banner = page.locator('[data-testid="conn-banner"]');
    await expect(banner).toBeVisible({ timeout: 10_000 });
    await expect(banner).toContainText('连接断开，自动重连中…');
    await expect(banner).toContainText('已断开');

    // 断开满 5s 才露「立即重试」——短暂抖动不打扰
    await expect(page.locator('[data-testid="conn-banner-retry"]')).toBeVisible({ timeout: 15_000 });

    // 点重试走 reconnectIfNeeded：与 online 事件同一条路径
    await page.locator('[data-testid="conn-banner-retry"]').click();
    await expect(page.locator('#connDot')).toHaveClass(/bg-success/, { timeout: 10_000 });

    // 重连成功先给绿条，再自动收起。
    // 必须同时断言「可见」+「success 色阶」：apply() 的隐藏分支只改 className、不清文案，而
    // toContainText 读 textContent 且对隐藏元素同样匹配——只断言文案的话，"算出了绿条但从没显示"
    // 这类回归会照样过。
    await expect(banner).toBeVisible();
    await expect(banner).toHaveClass(/conn-banner--success/);
    await expect(banner).toContainText('已重新连接');
    await expect(banner).toBeHidden({ timeout: 10_000 });

    await expectNoBrowserErrors(page);
  });

  test('P0-02i 桌面栅格（≥1024px）下横幅落在主列 header 与消息区之间，不掉进侧栏列', async ({ page }) => {
    // body 在 ≥1024px 变成 grid（app.css「桌面端响应式栅格布局」），#leftSidebar/header/#messages/footer
    // 全部显式定位。任何未显式定位的非 fixed body 子元素都会被自动排版塞进隐式行 —— 对横幅来说
    // 就是 300px 宽、卡在左侧栏底下，并挤掉 composer。其余 E2E 全在移动视口，结构上测不到这条。
    await page.setViewportSize({ width: 1280, height: 800 });
    await gotoMock(page);

    await sendChatMessage(page, 'test:disconnect-now');
    const banner = page.locator('[data-testid="conn-banner"]');
    await expect(banner).toBeVisible({ timeout: 10_000 });

    const bannerBox = (await banner.boundingBox())!;
    const headerBox = (await page.locator('header').boundingBox())!;
    const messagesBox = (await page.locator('#messages').boundingBox())!;
    const sidebarBox = (await page.locator('#leftSidebar').boundingBox())!;

    // 在主列：左边缘与 header/#messages 对齐，而不是坐在 300px 的侧栏列里
    expect(bannerBox.x).toBeGreaterThanOrEqual(sidebarBox.width - 1);
    expect(Math.abs(bannerBox.x - headerBox.x)).toBeLessThanOrEqual(1);
    expect(bannerBox.width).toBeGreaterThan(sidebarBox.width);
    // 纵向夹在 header 与消息区之间
    expect(bannerBox.y).toBeGreaterThanOrEqual(headerBox.y + headerBox.height - 1);
    expect(bannerBox.y + bannerBox.height).toBeLessThanOrEqual(messagesBox.y + 1);
    // 横幅出现不该把输入区挤出视口（grid 隐式行 + overflow:hidden 会裁掉 footer）
    const composerBox = (await page.locator('#composerFooter').boundingBox())!;
    expect(composerBox.y + composerBox.height).toBeLessThanOrEqual(800 + 1);

    await expectNoBrowserErrors(page);
  });

  test('P0-02h 横幅可见时消息区仍可用：离线队列不受影响', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:disconnect-now');
    await expect(page.locator('#connDot')).toHaveClass(/bg-danger/, { timeout: 10_000 });
    await expect(page.locator('[data-testid="conn-banner"]')).toBeVisible({ timeout: 10_000 });

    // 横幅是非阻断的：断线期间仍能把消息排进离线队列（不回归 P0-02d 的能力）
    await page.locator('#input').fill('test:settings-echo');
    await expect(page.locator('#btnSend')).toBeEnabled();
    await page.locator('#btnSend').click();
    await expect(page.locator('.pending-indicator').last()).toContainText('正在等待连接');

    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(page.locator('#connDot')).toHaveClass(/bg-success/, { timeout: 10_000 });
    await waitForIdle(page);
    await expect(page.locator('[data-testid="assistant-message"]').last()).toContainText('设置回显：model=');

    await expectNoBrowserErrors(page);
  });
});
