// spec: 键盘焦点不逃出当前那一层（验收 AC-02-07 / O74、AC-21-07 / O77）。
//   · 全屏门（令牌门、叠在它上面的访问帮助）开着时，Tab / Shift+Tab 不得落进背后的页面——落进去回车就能触发。
//   · 「设置与状态」打开后焦点要进面板，Tab 不出面板；关掉后回到打开它的那个按钮。
//   · 收起的会话设置、设置与状态、移动端抽屉里的控件不得被 Tab 到。
// 判据是 focusin 探针记下的每一次落点，不看 activeElement 的终值：Tab 走出文档末尾时 activeElement
// 会回到 body，只看终值会漏掉「中途落进了顶栏」。
// helpers: tests/helpers/playwright.ts

import { test, expect, type Page } from '@playwright/test';
import { captureBrowserErrors, expectNoBrowserErrors, gotoMock, openGeneralPage, waitForIdle } from '../../helpers/playwright';

// 与 sheets.js 判可聚焦的口径相同：可见、未禁用的原生可聚焦元素与正 tabindex。
const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

async function startFocusProbe(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __focusLog?: Element[]; __focusProbe?: boolean };
    w.__focusLog = [];
    if (w.__focusProbe) return;
    w.__focusProbe = true;
    document.addEventListener('focusin', e => { w.__focusLog?.push(e.target as Element); }, true);
  });
}

// 取走本轮记下的落点，按是否落在 selector 子树内分成两组（tag#id 便于读失败信息）。
async function takeLandings(page: Page, selector: string) {
  return page.evaluate((sel) => {
    const w = window as unknown as { __focusLog: Element[] };
    const name = (el: Element) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}`;
    const inside = w.__focusLog.filter(el => el.closest(sel)).map(name);
    const outside = w.__focusLog.filter(el => !el.closest(sel)).map(name);
    w.__focusLog = [];
    return { inside, outside };
  }, selector);
}

async function focusableCount(page: Page, selector: string) {
  return page.locator(selector).evaluate((root, sel) => [...root.querySelectorAll(sel)]
    .filter(n => !(n as HTMLButtonElement).disabled && (n as HTMLElement).offsetParent !== null).length, FOCUSABLE);
}

async function pressTab(page: Page, times: number, { shift = false } = {}) {
  for (let i = 0; i < times; i++) await page.keyboard.press(shift ? 'Shift+Tab' : 'Tab');
}

const activeInside = (page: Page, selector: string) =>
  page.evaluate(sel => !!document.activeElement?.closest(sel), selector);

test.describe('P0 日常零 token Mock UI 回归', () => {
  test('P0-FOCUS-1 令牌门开着时 Tab / Shift+Tab 都不落进背后的页面', async ({ page }) => {
    captureBrowserErrors(page, { ignoredResourceStatusCodes: [400] });
    await page.request.post('/__reset');
    await page.goto('/#token=bad-token');
    await expect(page.locator('#authGate')).toBeVisible();
    await expect(page.locator('#authToken')).toBeFocused();

    await startFocusProbe(page);
    await pressTab(page, 8);
    await pressTab(page, 8, { shift: true });
    const { inside, outside } = await takeLandings(page, '#authGate');
    expect(inside, '探针要真看见 Tab 在门内走动').toContain('button#authSubmit');
    expect(outside, '令牌门背后的控件被 Tab 到了：回车就能触发它').toEqual([]);

    await expectNoBrowserErrors(page);
  });

  test('P0-FOCUS-2 访问帮助叠在令牌门上时 Tab 只在帮助页里走，关掉后回到令牌门', async ({ page }) => {
    captureBrowserErrors(page, { ignoredResourceStatusCodes: [400] });
    await page.request.post('/__reset');
    await page.goto('/#token=bad-token');
    await expect(page.locator('#authGate')).toBeVisible();

    await page.locator('#authHelpLink').click();
    await expect(page.locator('#accessHelp')).toBeVisible();
    await startFocusProbe(page);
    const n = await focusableCount(page, '#accessHelp');
    await pressTab(page, n + 3);
    await pressTab(page, n + 3, { shift: true });
    let landings = await takeLandings(page, '#accessHelp');
    expect(landings.inside, '探针要真看见 Tab 在帮助页里走动').toContain('button#accessHelpClose');
    expect(landings.outside, '访问帮助盖着整屏，Tab 却落到了它背后').toEqual([]);

    await page.locator('#accessHelpClose').click();
    await expect(page.locator('#accessHelp')).toBeHidden();
    await expect.poll(() => activeInside(page, '#authGate'), '帮助页关掉后焦点要回到令牌门').toBe(true);
    await takeLandings(page, '#authGate'); // 清掉关帮助页那一下的落点
    await pressTab(page, 8);
    landings = await takeLandings(page, '#authGate');
    expect(landings.inside).toContain('button#authSubmit');
    expect(landings.outside, '回到令牌门后 Tab 又落进了背后的页面').toEqual([]);

    await expectNoBrowserErrors(page);
  });

  test('P0-FOCUS-3 「设置与状态」打开焦点进面板、Tab 不出面板，Escape 关掉回到入口', async ({ page }) => {
    await gotoMock(page);
    await page.locator('#btnSessions').click();
    await expect(page.locator('#leftSidebar')).not.toHaveClass(/-translate-x-full/);
    await page.locator('#btnGeneralSettings').click();
    await expect(page.locator('#generalSheet')).not.toHaveClass(/translate-y-full/);
    await expect.poll(() => activeInside(page, '#generalSheet'), '面板打开了，焦点还留在背后').toBe(true);

    await startFocusProbe(page);
    const n = await focusableCount(page, '#generalSheet');
    await pressTab(page, n + 3);
    await pressTab(page, n + 3, { shift: true });
    const { inside, outside } = await takeLandings(page, '#generalSheet');
    expect(inside.length, '探针要真看见 Tab 在面板里走动').toBeGreaterThan(n);
    expect(outside, '设置与状态开着，Tab 却走到了它背后').toEqual([]);

    await page.keyboard.press('Escape');
    await expect(page.locator('#generalSheet')).toHaveClass(/translate-y-full/);
    // 入口在已收起的抽屉里，回不去；抽屉自己收起时把焦点交回了打开它的 #btnSessions
    await expect(page.locator('#btnSessions')).toBeFocused();

    await expectNoBrowserErrors(page);
  });

  test('P0-FOCUS-4 收起的会话设置、设置与状态、抽屉里的控件都 Tab 不到', async ({ page }) => {
    await gotoMock(page);
    await waitForIdle(page);
    await page.locator('#input').focus();

    await startFocusProbe(page);
    await pressTab(page, 40);
    await page.locator('#input').focus();
    await pressTab(page, 40, { shift: true });
    const { inside, outside } = await takeLandings(page, '#settingsSheet, #generalSheet, #leftSidebar');
    expect(outside.length, '探针要真看见 Tab 在页面上走动').toBeGreaterThan(3);
    expect(inside, '收起的面板 / 抽屉里的控件被 Tab 到了：看不见却能被回车触发').toEqual([]);

    await expectNoBrowserErrors(page);
  });

  test('P0-FOCUS-5 从设置与状态打开访问帮助再关掉：焦点回到入口，收起的会话设置仍然 Tab 不到', async ({ page }) => {
    await gotoMock(page);
    await openGeneralPage(page, 'help');
    await page.locator('#accessHelpOpen').click();
    await expect(page.locator('#accessHelp')).toBeVisible();

    await startFocusProbe(page);
    await pressTab(page, 4);
    let landings = await takeLandings(page, '#accessHelp');
    expect(landings.outside, '访问帮助盖着整屏，Tab 却落到了它背后').toEqual([]);

    await page.locator('#accessHelpClose').click();
    await expect(page.locator('#accessHelp')).toBeHidden();
    await expect(page.locator('#accessHelpOpen')).toBeFocused();
    await takeLandings(page, '#generalSheet');
    const n = await focusableCount(page, '#generalSheet');
    await pressTab(page, n + 3);
    landings = await takeLandings(page, '#generalSheet');
    expect(landings.inside.length).toBeGreaterThan(0);
    expect(landings.outside, '帮助页关掉后 Tab 走出了设置与状态').toEqual([]);

    // 帮助页开着时会话设置同时挂着「收起」与「门」两份 inert；门撤掉不得连带撤掉「收起」那份
    await page.keyboard.press('Escape');
    await expect(page.locator('#generalSheet')).toHaveClass(/translate-y-full/);
    await page.locator('#input').focus();
    await takeLandings(page, '#input');
    await pressTab(page, 40);
    await page.locator('#input').focus();
    await pressTab(page, 40, { shift: true });
    landings = await takeLandings(page, '#settingsSheet, #generalSheet, #leftSidebar');
    expect(landings.outside.length).toBeGreaterThan(3);
    expect(landings.inside, '帮助页关掉后，收起的面板 / 抽屉又能被 Tab 到了').toEqual([]);

    await expectNoBrowserErrors(page);
  });
});
