// helpers: tests/helpers/playwright.ts

import { test, expect } from '@playwright/test';
import { ensureComposerReady, expectNoBrowserErrors, gotoMock, openGeneralPage, sendChatMessage, waitForIdle } from '../../helpers/playwright';

test.describe('P0 日常零 token Mock UI 回归', () => {
  test('P0-15 设备信赖 TOFU、pending device request 与访问帮助', async ({ page }) => {
    await gotoMock(page);

    // 1. 发送 test:tofu 后显示等待授权 overlay。
    await sendChatMessage(page, 'test:tofu');
    await expect(page.locator('#deviceModal')).toBeVisible();
    await expect(page.locator('#deviceModalId')).toHaveText('unauthorized-fingerprint-999');
    await expect(page.locator('#deviceModal')).toContainText('node scripts/device.js approve');
    await expect(page.locator('#input')).toBeDisabled();
    await expect(page.locator('#deviceModal')).toBeHidden({ timeout: 12_000 });
    await expect(page.locator('#input')).toBeEnabled();

    // 2. 可信设备视角出现 pending device request 卡片，并可打开访问帮助。
    await gotoMock(page);
    await sendChatMessage(page, 'test:devicerequests');
    await waitForIdle(page);
    await expect(page.locator('[data-testid="device-card"]')).toHaveCount(2);
    await expect(page.locator('[data-testid="device-card"]').first()).toContainText('aa-bb-cc-dd');
    await expect(page.locator('[data-testid="device-card"]').first()).toContainText('192.168.1.100');

    // 3. 待批卡片还在时，访问帮助仍从常驻入口可达——卡片栈悬浮在 header **之下**，不吃顶栏点击。
    await openGeneralPage(page, 'help');
    await page.locator('#accessHelpOpen').click();
    await expect(page.locator('#accessHelp')).toBeVisible();
    await expect(page.locator('#accessHelp')).toContainText('令牌');
    await page.locator('#accessHelpClose').click();
    await expect(page.locator('#accessHelp')).toBeHidden();

    await expectNoBrowserErrors(page);
  });

  // 卡片栈是 fixed 覆盖层（容器 pointer-events-none，卡片自身 auto）。它曾从 top-0 起铺开，
  // 在窄屏上 max-w-sm 占满宽度、高约 130px，把 57px 高的 header 整条盖住——有待批设备时
  // 侧栏/首页/日志/＋ 全部点不到，用户只能先处理掉卡片才能做别的事。
  test('P0-15g 待批设备卡片悬浮在顶栏之下，不吃掉 header 的点击', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:devicerequests');
    await waitForIdle(page);
    await expect(page.locator('[data-testid="device-card"]')).toHaveCount(2);

    // 几何上就不该重叠：卡片栈顶边不高于 header 底边
    const gap = await page.evaluate(() => {
      const header = document.querySelector('header')!.getBoundingClientRect();
      const cards = document.querySelector('#deviceRequests')!.getBoundingClientRect();
      return cards.top - header.bottom;
    });
    expect(gap).toBeGreaterThanOrEqual(0);

    // 顶栏三个入口在卡片存在时依然可点（点击超时即为遮挡回归）
    await page.locator('#btnSessions').click();
    await expect(page.locator('#leftSidebar')).not.toHaveClass(/-translate-x-full/);
    await page.locator('#sidebarClose').click();

    await page.locator('#btnConsole').click();
    await expect(page.locator('#consoleModal')).toBeVisible();
    await page.locator('#consoleClose').click();

    await page.locator('#btnNew').click();
    await expect(page.locator('#input')).toBeVisible();

    // 卡片是页面级提示，不能压过模态层——否则弹窗的关闭钮被盖住就出不来了
    const layers = await page.evaluate(() => {
      const z = (sel: string) => Number(getComputedStyle(document.querySelector(sel)!).zIndex);
      return { header: z('header'), cards: z('#deviceRequests'), modal: z('#consoleModal'), blocking: z('#deviceDenied') };
    });
    expect(layers.header).toBeLessThan(layers.cards);
    expect(layers.cards).toBeLessThan(layers.modal);
    expect(layers.modal).toBeLessThanOrEqual(layers.blocking);

    // 卡片本身仍可操作（下移不能把它推出视口或让它失去点击）
    await expect(page.locator('[data-testid="device-card"]')).toHaveCount(2);
    await page.locator('[data-testid="device-card"]').first().getByRole('button', { name: /准入/ }).click();
    await expect(page.locator('[data-testid="device-card"]')).toHaveCount(1);

    await expectNoBrowserErrors(page);
  });

  test('P0-15b pending device request 准入/拒绝后卡片即时更新', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:devicerequests');
    await waitForIdle(page);
    await expect(page.locator('[data-testid="device-card"]')).toHaveCount(2);

    const iphoneCard = page.locator('[data-testid="device-card"][data-device-id="aa-bb-cc-dd-iphone-15-pro"]');
    await iphoneCard.getByRole('button', { name: /准入/ }).click();
    await expect(page.locator('[data-testid="device-card"]')).toHaveCount(1);
    await expect(page.locator('#deviceRequests')).not.toContainText('aa-bb-cc-dd-iphone-15-pro');
    await expect(page.locator('#deviceRequests')).toContainText('ee-ff-00-11-ipad-air-m2');

    const ipadCard = page.locator('[data-testid="device-card"][data-device-id="ee-ff-00-11-ipad-air-m2"]');
    await ipadCard.getByRole('button', { name: /拒绝/ }).click();
    await expect(page.locator('[data-testid="device-card"]')).toHaveCount(0);
    await expect(page.locator('#deviceRequests')).toHaveClass(/hidden/);
    await expect(page.locator('#input')).toBeEnabled();

    await expectNoBrowserErrors(page);
  });

  test('P0-15c 设备被拒后显示拒绝页并可打开访问帮助', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:tofu-denied');
    await expect(page.locator('#deviceDenied')).toBeVisible();
    await expect(page.locator('#deviceDenied')).toContainText('设备未获授权');
    await expect(page.locator('#deviceDenied')).toContainText('重新请求接入');

    await page.locator('#deviceDeniedHelp').click();
    await expect(page.locator('#accessHelp')).toBeVisible();
    await expect(page.locator('#accessHelp')).toContainText('新设备怎么获批');
    await page.locator('#accessHelpClose').click();
    await expect(page.locator('#accessHelp')).toBeHidden();
    await expect(page.locator('#deviceDenied')).toBeVisible();

    await expectNoBrowserErrors(page);
  });

  test('P0-15d 设备被拒后可重新请求接入并回到等待授权态', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:tofu-denied');
    await expect(page.locator('#deviceDenied')).toBeVisible();

    await page.locator('#deviceDeniedRetry').click();
    await expect(page.locator('#deviceDenied')).toBeHidden();
    await expect(page.locator('#deviceModal')).toBeVisible();
    await expect(page.locator('#deviceModalId')).toHaveText('unauthorized-fingerprint-999');
    await expect(page.locator('#deviceModal')).toContainText('node scripts/device.js approve');
    await expect(page.locator('#input')).toBeDisabled();

    await expectNoBrowserErrors(page);
  });

  test('P0-15e 等待设备授权期间保留草稿且禁止发送', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:tofu-delayed');
    await page.locator('#input').fill('test:settings-echo');
    await expect(page.locator('#btnSend')).toBeEnabled();

    await expect(page.locator('#deviceModal')).toBeVisible();
    await expect(page.locator('#deviceModalId')).toHaveText('unauthorized-fingerprint-999');
    await expect(page.locator('#input')).toBeDisabled();
    await expect(page.locator('#input')).toHaveValue('test:settings-echo');
    await expect(page.locator('#btnSend')).toBeDisabled();
    await expect(page.locator('#btnSend')).toHaveAttribute('title', '请先完成设备授权或解除只读状态');

    await expect(page.locator('#deviceModal')).toBeHidden({ timeout: 12_000 });
    await expect(page.locator('#input')).toBeEnabled();
    await expect(page.locator('#input')).toHaveValue('test:settings-echo');
    await expect(page.locator('#btnSend')).toBeEnabled();

    await page.locator('#btnSend').click();
    await waitForIdle(page);
    await expect(page.locator('[data-testid="assistant-message"]').last()).toContainText('设置回显：model=');

    await expectNoBrowserErrors(page);
  });

  test('P0-15f 设备被拒期间保留草稿且继续禁止发送', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:tofu-denied-delayed');
    await page.locator('#input').fill('test:settings-echo');
    await expect(page.locator('#btnSend')).toBeEnabled();

    await expect(page.locator('#deviceModal')).toBeVisible();
    await expect(page.locator('#input')).toBeDisabled();
    await expect(page.locator('#input')).toHaveValue('test:settings-echo');
    await expect(page.locator('#btnSend')).toBeDisabled();

    await expect(page.locator('#deviceDenied')).toBeVisible({ timeout: 12_000 });
    await expect(page.locator('#deviceDenied')).toContainText('设备未获授权');
    await expect(page.locator('#input')).toBeDisabled();
    await expect(page.locator('#input')).toHaveValue('test:settings-echo');
    await expect(page.locator('#btnSend')).toBeDisabled();
    await expect(page.locator('#btnSend')).toHaveAttribute('title', '请先完成设备授权或解除只读状态');

    await page.locator('#deviceDeniedRetry').click();
    await expect(page.locator('#deviceDenied')).toBeHidden();
    await expect(page.locator('#deviceModal')).toBeVisible();
    await expect(page.locator('#input')).toBeDisabled();
    await expect(page.locator('#input')).toHaveValue('test:settings-echo');
    await expect(page.locator('#btnSend')).toBeDisabled();

    await expectNoBrowserErrors(page);
  });

  // L1「接入与设备」那行是全站唯一会亮红点的一行，红点的语义是「点一下就能处理」。而待批卡片
  // 住在 #deviceRequests（z-30 fixed 浮层），#generalScrim 同为 z-30 却在 DOM 里排得更后——
  // 同层后来居上。于是设置面板开着时点进这一页，审批控件既看不见也点不动，红点是空头承诺。
  // 这两条守的是那条通路本身，单测那层只验得了「摘要里的 el 在 index.html 里存在」。
  test('P0-15h 待批设备在设置面板下确实够不着，入口点一下就能把卡片让出来', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoMock(page);
    await sendChatMessage(page, 'test:devicerequests');
    await waitForIdle(page);
    await expect(page.locator('[data-testid="device-card"]')).toHaveCount(2);

    await openGeneralPage(page, 'devices');
    const entry = page.locator('[data-testid="pending-devices-entry"]');
    await expect(entry).toBeVisible();
    await expect(entry).toContainText('2'); // 条数进文案：一台和两台在「要不要现在处理」上不同

    // ★ 先证明问题真的存在，再证明入口解决了它。命中测试直接问「卡片那个点上最顶的是谁」——
    //   断言 scrim「可见」证不了遮挡，只有 elementFromPoint 能。
    const blockedBy = await page.evaluate(() => {
      const card = document.querySelector('[data-testid="device-card"]') as HTMLElement;
      const r = card.getBoundingClientRect();
      return (document.elementFromPoint(r.left + r.width / 2, r.top + 10) as HTMLElement)?.id || '';
    });
    expect(blockedBy).toBe('generalScrim');

    await entry.click();
    await expect(page.locator('#generalSheet')).toHaveClass(/translate-y-full/);
    await expect(page.locator('#generalScrim')).toBeHidden();

    // ★ 让开之后卡片自己在最顶层，且真能点——click 超时即为遮挡回归
    const nowTop = await page.evaluate(() => {
      const card = document.querySelector('[data-testid="device-card"]') as HTMLElement;
      const r = card.getBoundingClientRect();
      const el = document.elementFromPoint(r.left + r.width / 2, r.top + 10) as HTMLElement;
      return card.contains(el);
    });
    expect(nowTop).toBe(true);
    await page.locator('[data-testid="device-card"]').first().getByText('✓ 准入').click();
    await expect(page.locator('[data-testid="device-card"]')).toHaveCount(1);

    await expectNoBrowserErrors(page);
  });

  test('P0-15i 没有待批设备时这条入口整段缺席，不留一个点了没反应的按钮', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoMock(page);
    await ensureComposerReady(page);

    await openGeneralPage(page, 'devices');
    await expect(page.locator('[data-testid="pending-devices-entry"]')).toBeHidden();
    // 摘要那一侧同源：没有待批就不写「台待批」，也不亮红点（单测钉的是同一条判据）
    await expect(page.locator('[data-testid="general-nav-devices"]')).not.toContainText('待批');

    await expectNoBrowserErrors(page);
  });
});
