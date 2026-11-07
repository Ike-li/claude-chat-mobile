import { test, expect, type Page } from '@playwright/test';
import {
  clickHeaderMenuItem, closeSettings, expectNoBrowserErrors, gotoMock, sendChatMessage, waitForIdle,
} from '../../helpers/playwright';

// 顶栏精简（2026-11-07）：顶栏只留抽屉、延迟、工作区胶囊、⋯。新会话 / 首页 / 会话日志收进 ⋯ 的下拉，
// 「重新加载本会话」搬进会话设置。此前四颗常驻按钮把胶囊挤到只剩图标，375px 下工作区名根本看不到。
const trigger = (page: Page) => page.locator('#btnMore');
const menu = (page: Page) => page.locator('#headerMenu');

test.describe('P0 日常零 token Mock UI 回归', () => {
  test('P0-HEADER-MENU-1 三项平时收着，展开带文字；点外面、Esc、再点 ⋯ 都能收起', async ({ page }) => {
    await gotoMock(page);
    await expect(trigger(page)).toHaveAttribute('aria-expanded', 'false');
    for (const id of ['btnNew', 'btnHome', 'btnConsole']) {
      await expect(page.locator(`#${id}`), `${id} 还常驻在顶栏`).toBeHidden();
    }

    await trigger(page).click();
    await expect(menu(page)).toBeVisible();
    await expect(trigger(page)).toHaveAttribute('aria-expanded', 'true');
    await expect(menu(page).locator('button')).toHaveText(['新会话', '首页', '会话日志']);

    await page.locator('#messages').click({ position: { x: 20, y: 200 } });
    await expect(menu(page)).toBeHidden();
    await expect(trigger(page)).toHaveAttribute('aria-expanded', 'false');

    await trigger(page).click();
    await page.keyboard.press('Escape');
    await expect(menu(page)).toBeHidden();
    await expect(trigger(page), 'Esc 收起后焦点要回到 ⋯').toBeFocused();

    await trigger(page).click();
    await trigger(page).click();
    await expect(menu(page)).toBeHidden();
    await expectNoBrowserErrors(page);
  });

  test('P0-HEADER-MENU-2 三项走到原来的去处，点完下拉收起；日志关掉后焦点回到 ⋯', async ({ page }) => {
    await gotoMock(page);

    await clickHeaderMenuItem(page, 'btnNew');
    await expect(page.locator('[data-testid="compose-surface"]')).toBeVisible();
    await expect(menu(page)).toBeHidden();

    await clickHeaderMenuItem(page, 'btnHome');
    await expect(page.locator('[data-testid="home-dashboard"]')).toBeVisible();
    await expect(menu(page)).toBeHidden();

    await clickHeaderMenuItem(page, 'btnConsole');
    await expect(page.locator('#consoleModal')).toBeVisible();
    await expect(menu(page)).toBeHidden();
    await page.locator('#consoleClose').click();
    await expect(page.locator('#consoleModal')).toBeHidden();
    // 点的那一项已经随下拉藏起来了，还焦点给它只会丢到 body
    await expect(trigger(page)).toBeFocused();
    await expectNoBrowserErrors(page);
  });

  test('P0-HEADER-MENU-3 重新加载本会话在会话设置里：看着会话才出现，新会话页没有', async ({ page }) => {
    await gotoMock(page);
    const reload = page.locator('#settingsReloadSession');

    await page.locator('#pillDefaults').click();
    await expect(reload).toBeVisible();
    await expect(reload).toContainText('重新加载本会话');
    await closeSettings(page);

    await clickHeaderMenuItem(page, 'btnNew');
    await expect(page.locator('[data-testid="compose-surface"]')).toBeVisible();
    await page.locator('#pillDefaults').click();
    await expect(reload, '新会话页没有可重新加载的历史').toBeHidden();
    await closeSettings(page);

    await expect(page.locator('#moreModal'), '⋯ 的底部菜单该撤掉了').toHaveCount(0);
    await expectNoBrowserErrors(page);
  });

  // 挂着审批也要能走开：顶栏抬在 sheet 之上（body.nav-escape），下拉长在顶栏里，得跟着一起在上面。
  // 「重新加载本会话」此时点不到（入口在底栏，被 sheet 盖着），这是搬进会话设置的代价，见 P0-HIST-STALL-5。
  test('P0-HEADER-MENU-5 审批挂着时下拉不被 sheet 盖住，三项都点得到', async ({ page }) => {
    await gotoMock(page);
    await sendChatMessage(page, 'test:tab');
    await waitForIdle(page);
    await sendChatMessage(page, 'test:pendingsnapshot');
    await expect(page.locator('#permModal')).toBeVisible({ timeout: 10_000 });

    await trigger(page).click();
    await expect(menu(page)).toBeVisible();
    for (const id of ['btnNew', 'btnHome', 'btnConsole']) {
      await page.locator(`#${id}`).click({ trial: true }); // trial：只查点得到，不真点
    }
    await page.keyboard.press('Escape');
    await expect(menu(page)).toBeHidden();
    await expect(page.locator('#permModal'), 'Esc 只收下拉，不动审批卡').toBeVisible();
    await expectNoBrowserErrors(page);
  });

  test('P0-HEADER-MENU-4 375px 下工作区名看得见，顶栏不溢出', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await gotoMock(page);
    await expect(page.locator('#topContextPill')).toBeVisible();
    await expect.poll(() => page.locator('#topProjectText').evaluate(el => el.clientWidth), {
      message: '胶囊被挤得看不到工作区名',
    }).toBeGreaterThan(80);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow).toBe(false);
    await expectNoBrowserErrors(page);
  });
});
