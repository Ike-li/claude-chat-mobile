import { test, expect } from '@playwright/test';
import { expectNoBrowserErrors, gotoMock, sendChatMessage, waitForIdle } from '../../helpers/playwright';
import {
  ANOTHER_WORKSPACE, MAIN_WORKSPACE, expandWorkspace, expectSidebarClosed, expectSidebarOpen, openSessionMenu,
  openSessionsSidebar, sessionMenuItem, sessionRowByInstance,
} from '../../helpers/sidebar-ui';

// 抽屉会话行的「⋯」菜单（2026-10-25，对齐桌面端 SessionDropdownMenu）。此前一行有三个入口：✕、🗑、红色侧滑「关闭」，
// 侧滑与抽屉自己的左滑收起抢同一次手势——露出按钮后多滑 30px 抽屉就被收走。现在一行只有「⋯」，长按什么也不做。
// 菜单里有哪些项、什么时候灰掉，判定在 logic 的 sessionRowMenuItems（tests/unit/logic-session-row-menu.test.mjs）；
// 这里守的是界面：入口只剩一个、菜单真的这样画出来、点了走到原来的确认流程。
const menu = (page: import('@playwright/test').Page) => page.locator('#sessionMenuModal');

test.describe('P0 日常零 token Mock UI 回归', () => {
  test('P0-ROW-MENU-1 每行只剩「⋯」一个入口：没有 ✕ / 🗑，也没有侧滑「关闭」', async ({ page }) => {
    await gotoMock(page);
    await sendChatMessage(page, 'test:tab'); // 造一个已打开的后台会话（inst_2），已打开与没打开的行都在
    await waitForIdle(page);
    await openSessionsSidebar(page);
    await expandWorkspace(page, MAIN_WORKSPACE);
    await expandWorkspace(page, ANOTHER_WORKSPACE);

    const panel = page.locator('#sessionPanel');
    const rows = panel.locator('[data-testid="session-row"]');
    await expect(sessionRowByInstance(page, 'inst_2')).toHaveCount(1);
    await expect(panel.locator('[data-testid="session-row"][data-session-id="mock-session-archived"]')).toHaveCount(1);
    await expect(panel.locator('[data-testid="session-close"]'), '✕ 还在：一行又有两个关闭入口').toHaveCount(0);
    await expect(panel.locator('[data-testid="session-delete"]'), '🗑 还在').toHaveCount(0);
    await expect(panel.locator('.swipe-row-container'), '侧滑底还在：它和抽屉的左滑收起抢手势').toHaveCount(0);
    const n = await rows.count();
    expect(n).toBeGreaterThan(1);
    await expect(panel.locator('[data-testid="session-row"] [data-testid="session-menu"]')).toHaveCount(n);

    await expectNoBrowserErrors(page);
  });

  test('P0-ROW-MENU-2 已打开的会话：标已读/未读 · 重命名 · 关闭会话 · 删除会话（灰掉，说要先关闭）；关闭走原确认', async ({ page }) => {
    await gotoMock(page);
    await page.setViewportSize({ width: 900, height: 812 });
    await sendChatMessage(page, 'test:tab');
    await waitForIdle(page);
    await openSessionsSidebar(page);
    await expandWorkspace(page, ANOTHER_WORKSPACE);
    const row = sessionRowByInstance(page, 'inst_2');
    await expect(row).toContainText('Another App Concurrency');

    await openSessionMenu(page, row);
    await expect(page.locator('#sessionMenuTitle')).toHaveText('Another App Concurrency');
    await expect(menu(page).locator('[data-menu-action]')).toHaveCount(4);
    await expect(sessionMenuItem(page, 'rename'), '打开着也能改名').toBeEnabled();
    // 后台会话有新活动，此刻是未读：文案随未读态二选一（单测钉住），这里只要它在、能点
    await expect(sessionMenuItem(page, 'toggle-read')).toBeEnabled();
    await expect(sessionMenuItem(page, 'close')).toContainText('关闭会话');
    const del = sessionMenuItem(page, 'delete');
    await expect(del).toContainText('删除会话');
    await expect(del, '服务端拒删正被驱动的会话，删除必须点不动').toBeDisabled();
    await expect(del).toContainText('先关闭会话才能删除');

    await sessionMenuItem(page, 'close').click();
    await expect(menu(page)).not.toHaveClass(/sheet-open/);
    await expect(page.locator('#confirmModal')).toHaveClass(/sheet-open/);
    await expect(page.locator('#confirmOk')).toHaveText('关闭会话');
    await page.locator('#confirmOk').click();
    await expectSidebarClosed(page);
    await expect(page.locator('#topProjectText')).toContainText('claude-chat-mobile');
    await openSessionsSidebar(page);
    await expect(page.locator('#sessionPanel')).not.toContainText('another-react-project');

    await expectNoBrowserErrors(page);
  });

  test('P0-ROW-MENU-3 没打开的会话：标为未读 · 重命名 · 删除会话（能点），删除走原「彻底删除」确认', async ({ page }) => {
    await gotoMock(page);
    await openSessionsSidebar(page);
    await expandWorkspace(page, MAIN_WORKSPACE);
    const row = page.locator('[data-testid="session-row"][data-session-id="mock-session-archived"]');
    await expect(row).toBeVisible();

    await openSessionMenu(page, row);
    await expect(page.locator('#sessionMenuTitle')).toHaveText('Archived Planning Session');
    await expect(menu(page).locator('[data-menu-action]')).toHaveCount(3);
    await expect(sessionMenuItem(page, 'toggle-read')).toContainText('标为未读');
    await expect(sessionMenuItem(page, 'rename')).toContainText('重命名');
    await expect(sessionMenuItem(page, 'close')).toHaveCount(0);
    await expect(sessionMenuItem(page, 'delete')).toBeEnabled();

    await sessionMenuItem(page, 'delete').click();
    await expect(page.locator('#confirmModal')).toHaveClass(/sheet-open/);
    await expect(page.locator('#confirmOk')).toHaveText('彻底删除');
    // 从抽屉里发起的确认答完要回到抽屉：菜单 sheet 与确认 sheet 上的点击都不算「点抽屉外面」
    await page.locator('#confirmCancel').click();
    await expectSidebarOpen(page);
    await expect(row).toBeVisible();

    await expectNoBrowserErrors(page);
  });

  test('P0-ROW-MENU-4 长按 / 右键会话行什么也不弹', async ({ page }) => {
    await gotoMock(page);
    await openSessionsSidebar(page);
    await expandWorkspace(page, MAIN_WORKSPACE);
    const row = page.locator('[data-testid="session-row"][data-session-id="mock-session-archived"]');
    await expect(row).toBeVisible();

    // 右键与触屏长按此前走同一个入口，且 contextmenu 同步就把确认 sheet 打开——派发完立刻断言是有效的
    await row.dispatchEvent('contextmenu');
    await expect(page.locator('#confirmModal')).not.toHaveClass(/sheet-open/);
    await expect(menu(page)).not.toHaveClass(/sheet-open/);
    await expectSidebarOpen(page);

    await expectNoBrowserErrors(page);
  });

  // Codex review（#407）：菜单项先收菜单再开确认，菜单 300ms 收起动画到点时会把焦点还给「⋯」——那时它已压在确认框后面。
  // 机制在 frontend-sheets 单测的「接力」两条。真浏览器里确认框（带 visibility 过渡）首帧接不住 openSheet 的开场移焦
  // （存量问题，不止这条路径），所以「焦点进了确认框就不被抢」在这里观察不到，只能守：焦点不丢、取消后回到「⋯」。
  // #399 / #425：openSheet 初始焦点走 focusInto(容器)，不再落在第一个菜单项；Tab 才进首项。
  test('P0-ROW-MENU-6 键盘：菜单里选删除 → 菜单收完焦点不丢；取消后回到这一行的「⋯」', async ({ page }) => {
    await gotoMock(page);
    await openSessionsSidebar(page);
    await expandWorkspace(page, MAIN_WORKSPACE);
    const row = page.locator('[data-testid="session-row"][data-session-id="mock-session-archived"]');
    const trigger = row.getByTestId('session-menu');

    await trigger.focus();
    await page.keyboard.press('Enter');
    await expect(menu(page)).toHaveClass(/sheet-open/);
    await expect(menu(page), 'focusInto 应把焦点落到菜单 dialog 容器，而不是首个菜单项').toBeFocused();
    await page.keyboard.press('Tab');
    await expect(sessionMenuItem(page, 'toggle-read')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(sessionMenuItem(page, 'rename')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(sessionMenuItem(page, 'delete')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('#confirmModal')).toHaveClass(/sheet-open/);
    // 菜单加 hidden 与还焦是同一个回调：等到 hidden 出现，还焦那一步就已经走过了
    await expect(menu(page)).toHaveClass(/\bhidden\b/);
    const focusPlace = await page.evaluate(() => {
      const a = document.activeElement;
      if (!a || a === document.body) return 'body';
      if (a.closest('#sessionMenuModal')) return 'hidden-menu';
      if (a.closest('#confirmModal')) return 'confirm';
      return a.getAttribute('data-testid') || a.tagName;
    });
    expect(['confirm', 'session-menu'], `焦点落在 ${focusPlace}：丢了或留在已藏起的菜单里`).toContain(focusPlace);

    await page.locator('#confirmCancel').click();
    await expect(page.locator('#confirmModal')).toHaveClass(/\bhidden\b/);
    await expect(trigger, '取消后焦点该回到发起的那一行，而不是丢进已收起的菜单').toBeFocused();

    await expectNoBrowserErrors(page);
  });

  test('P0-ROW-MENU-5 取消、点遮罩、Esc 都只收菜单，抽屉留着', async ({ page }) => {
    await gotoMock(page);
    await openSessionsSidebar(page);
    await expandWorkspace(page, MAIN_WORKSPACE);
    const row = page.locator('[data-testid="session-row"][data-session-id="mock-session-archived"]');

    await openSessionMenu(page, row);
    await page.locator('#sessionMenuCancel').click();
    await expect(menu(page)).not.toHaveClass(/sheet-open/);
    await expectSidebarOpen(page);

    await openSessionMenu(page, row);
    await menu(page).click({ position: { x: 10, y: 10 } });
    await expect(menu(page)).not.toHaveClass(/sheet-open/);
    await expectSidebarOpen(page);

    await openSessionMenu(page, row);
    // openSheet 下一帧才把焦点移进 sheet；人不会在那一帧里按 Esc，测试也等焦点到位再按。
    // #399 / #425：焦点在 dialog 容器本身（focusInto），不是子控件——用 toBeFocused 守容器，
    // 勿再用 .locator(':focus')（只匹配后代，容器自己有焦点时 count=0）。
    await expect(menu(page)).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(menu(page)).not.toHaveClass(/sheet-open/);
    await expectSidebarOpen(page);

    await expectNoBrowserErrors(page);
  });

  // #359 第 8 项：「⋯」视觉 32px，触控热区扩到 48（.hit-44，四周各 8px，伪元素不占布局）。
  // 向左正好补满与行本体之间的 gap-2，不吞行本体的点击。
  test('P0-ROW-MENU-7 「⋯」热区比视觉框大：框外 6px 仍点得中，行本体照样点得到', async ({ page }) => {
    await gotoMock(page);
    await openSessionsSidebar(page);
    await expandWorkspace(page, MAIN_WORKSPACE);
    const row = page.locator('#sessionPanel [data-testid="session-row"]').first();
    await expect(row.locator('[data-testid="session-menu"]')).toBeVisible();
    // 抽屉滑入有 transform 过渡：等它停稳再量
    await expect.poll(() => page.locator('#leftSidebar').evaluate(el => el.getBoundingClientRect().left)).toBe(0);
    const hit = await row.evaluate((rowEl) => {
      const btn = rowEl.querySelector('[data-testid="session-menu"]')!;
      const main = rowEl.querySelector('button:not([data-testid="session-menu"])')!;
      const r = btn.getBoundingClientRect();
      const m = main.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const onMenu = (x: number, y: number) => document.elementFromPoint(x, y)?.closest('[data-testid="session-menu"]') === btn;
      return {
        left: onMenu(r.left - 6, cy), top: onMenu(cx, r.top - 6), bottom: onMenu(cx, r.bottom + 6), right: onMenu(r.right + 6, cy),
        mainEdge: document.elementFromPoint(m.right - 2, m.top + m.height / 2)?.closest('button') === main,
      };
    });
    expect(hit, '「⋯」框外 6px 点不中').toEqual({ left: true, top: true, bottom: true, right: true, mainEdge: true });
    await expectNoBrowserErrors(page);
  });

  // #359 第 8 项：抽屉的边缘右滑挂在 document 上，以前不看场合。真 Chromium 合成触摸：
  // 先用对照组证明合成手势真能拉出抽屉，再验两种该让位的场合。
  test('P0-DRAWER-GESTURE 边缘右滑：普通区域能呼出；sheet 开着、或起点在横向可滚的代码块里不呼出', async ({ page }) => {
    await gotoMock(page);
    await sendChatMessage(page, 'test:stream');
    const pre = page.locator('[data-testid="assistant-message"]').last().locator('pre').first();
    await expect(pre).toContainText('tester', { timeout: 20_000 });
    await waitForIdle(page);
    // 起点 (x,y) 处的元素收到 touchstart，再向右移 100px；触发与否在 touchmove 里同步判定
    const swipeRight = (x: number, y: number) => page.evaluate(([x0, y0]) => {
      const target = document.elementFromPoint(x0, y0)!;
      const fire = (type: string, x: number) => {
        const touch = new Touch({ identifier: 1, target, clientX: x, clientY: y0 });
        target.dispatchEvent(new TouchEvent(type, {
          touches: type === 'touchend' ? [] : [touch], changedTouches: [touch], bubbles: true, cancelable: true,
        }));
      };
      fire('touchstart', x0);
      fire('touchmove', x0 + 100);
      fire('touchend', x0 + 100);
    }, [x, y]);
    const drawerOpened = async () => !(await page.locator('#leftSidebar').getAttribute('class'))!.includes('-translate-x-full');

    // 对照：从顶栏左缘右滑能拉出抽屉
    await swipeRight(4, 28);
    expect(await drawerOpened(), '对照组没拉出抽屉：合成触摸没生效，下面两条断言没有意义').toBe(true);
    await page.locator('#sidebarScrim').click({ position: { x: 360, y: 400 } });
    await expectSidebarClosed(page);

    // 一：控制台 sheet 开着
    await page.locator('#btnConsole').click();
    await expect(page.locator('body')).toHaveClass(/ccm-sheet-open/);
    await swipeRight(4, 28);
    expect(await drawerOpened(), 'sheet 开着时抽屉被拉到了 sheet 底下').toBe(false);
    await page.keyboard.press('Escape');
    await expect(page.locator('body')).not.toHaveClass(/ccm-sheet-open/);

    // 二：起点在横向溢出的代码块里。真正横滚的是 code.hljs（github 主题给它 display:block + overflow-x:auto），不是 pre
    await pre.locator('code').evaluate(code => { code.textContent = 'x'.repeat(400); });
    const box = await pre.evaluate(el => {
      const scroller = [el, ...Array.from(el.querySelectorAll('*'))]
        .find(n => n.scrollWidth > n.clientWidth && /^(auto|scroll)$/.test(getComputedStyle(n).overflowX));
      const r = scroller?.getBoundingClientRect();
      return { found: Boolean(scroller), x: (r?.left ?? 0) + 4, y: r ? r.top + r.height / 2 : 0 };
    });
    expect(box.found, '代码块里没有横向溢出的可滚元素，测试前提不成立').toBe(true);
    expect(box.x, '可滚区左缘不在 45px 边缘区内，测试前提不成立').toBeLessThan(45);
    await swipeRight(box.x, box.y);
    expect(await drawerOpened(), '在代码块里横滑把抽屉拉出来了').toBe(false);

    await expectNoBrowserErrors(page);
  });
});

// 网页端改名（#458），对应终端 /rename。服务端那一侧（renameSession、清洗、活会话退出补写）由
// tests/integration/session-rename.test.mjs 与 tests/unit/session-rename.test.mjs 守；这里守界面：
// 菜单进得去、预填当前名字、改完抽屉当场换名且抽屉留着、别的标签页也看得到、失败原因留在 sheet 里。
test.describe('会话改名', () => {
  const renameSheet = (page: import('@playwright/test').Page) => page.locator('#sessionRenameModal');
  const archivedRow = (page: import('@playwright/test').Page) =>
    page.locator('[data-testid="session-row"][data-session-id="mock-session-archived"]');

  test('P0-ROW-MENU-7 菜单「重命名」→ 预填当前名字，保存后抽屉当场换名、抽屉留着；另一个标签页打开抽屉也是新名字', async ({ page, context }) => {
    const other = await context.newPage();
    await gotoMock(other);
    await gotoMock(page);
    await openSessionsSidebar(page);
    await expandWorkspace(page, MAIN_WORKSPACE);
    await openSessionMenu(page, archivedRow(page));
    await sessionMenuItem(page, 'rename').click();

    await expect(renameSheet(page)).toHaveClass(/sheet-open/);
    const input = page.getByTestId('session-rename-input');
    await expect(input).toHaveValue('Archived Planning Session');
    await input.fill('  ');
    await expect(page.getByTestId('session-rename-save'), '空名字不让存').toBeDisabled();
    await input.fill('规划 v2');
    await page.getByTestId('session-rename-save').click();

    await expect(renameSheet(page)).not.toHaveClass(/sheet-open/);
    await expectSidebarOpen(page);
    await expect(archivedRow(page)).toContainText('规划 v2');
    await expect(archivedRow(page)).not.toContainText('Archived Planning Session');
    await expect(page.locator('#drawerNotice')).toBeHidden();

    await openSessionsSidebar(other);
    await expandWorkspace(other, MAIN_WORKSPACE);
    await expect(archivedRow(other)).toContainText('规划 v2');

    await expectNoBrowserErrors(page);
    await expectNoBrowserErrors(other);
  });

  test('P0-ROW-MENU-8 改名失败：原因写在 sheet 里、sheet 不关，改了再存能成功', async ({ page }) => {
    await gotoMock(page);
    await openSessionsSidebar(page);
    await expandWorkspace(page, MAIN_WORKSPACE);
    await openSessionMenu(page, archivedRow(page));
    await sessionMenuItem(page, 'rename').click();

    const input = page.getByTestId('session-rename-input');
    await input.fill('MOCK_RENAME_FAIL');
    await input.press('Enter');
    await expect(page.getByTestId('session-rename-error')).toHaveText('改名失败：EACCES: permission denied');
    await expect(renameSheet(page)).toHaveClass(/sheet-open/);
    await expect(archivedRow(page)).toContainText('Archived Planning Session');

    await input.fill('第二次');
    await expect(page.getByTestId('session-rename-error'), '一改输入，上一次的错因就作废').toBeHidden();
    await page.getByTestId('session-rename-save').click();
    await expect(renameSheet(page)).not.toHaveClass(/sheet-open/);
    await expect(archivedRow(page)).toContainText('第二次');

    await expectNoBrowserErrors(page);
  });

  test('P0-ROW-MENU-10 回执还没到就关掉 sheet、又给别的会话打开：迟到的结果不动新 sheet，成功的照样换名', async ({ page }) => {
    await gotoMock(page);
    await openSessionsSidebar(page);
    await expandWorkspace(page, MAIN_WORKSPACE);
    const gapRow = page.locator('[data-testid="session-row"][data-session-id="mock-session-gap"]');
    const mainRow = page.locator('[data-testid="session-row"][data-session-id="mock-session-visual-test"]');
    const input = page.getByTestId('session-rename-input');
    const saveAndDismiss = async (row: import('@playwright/test').Locator, title: string) => {
      await openSessionMenu(page, row);
      await sessionMenuItem(page, 'rename').click();
      await input.fill(title);
      await input.press('Enter');
      await page.locator('#sessionRenameCancel').click();
      await expect(renameSheet(page)).not.toHaveClass(/sheet-open/);
    };

    // mock 把这两条的回执扣住，等新 sheet 开好再按序放：先失败、后成功
    await saveAndDismiss(archivedRow(page), 'MOCK_RENAME_HELD_FAIL');
    await saveAndDismiss(gapRow, 'MOCK_RENAME_HELD');
    await openSessionMenu(page, mainRow);
    await sessionMenuItem(page, 'rename').click();
    await input.fill('还没存的草稿');
    // 两条改名都已到 mock 再放（WebSocket 帧与这里的 HTTP 请求不同路，负载高时前者可能落后）
    await expect.poll(async () => (await page.request.get('/__held-renames')).json()).toEqual(['MOCK_RENAME_HELD_FAIL', 'MOCK_RENAME_HELD']);
    await page.request.post('/__release-renames');

    // 成功的回执到了（抽屉换名）就说明同一条连接上更早的失败回执也已处理过
    await expect(gapRow).toContainText('MOCK_RENAME_HELD');
    await expect(renameSheet(page)).toHaveClass(/sheet-open/);
    await expect(input).toHaveValue('还没存的草稿');
    await expect(page.getByTestId('session-rename-error')).toBeHidden();
    await expect(page.getByTestId('session-rename-save')).toBeEnabled();
    await expect(archivedRow(page)).toContainText('Archived Planning Session');

    await expectNoBrowserErrors(page);
  });

  test('P0-ROW-MENU-9 终端可能还开着这个会话：照样改名，抽屉提示改名可能被覆盖', async ({ page }) => {
    await gotoMock(page);
    await openSessionsSidebar(page);
    await expandWorkspace(page, MAIN_WORKSPACE);
    const row = page.locator('[data-testid="session-row"][data-session-id="mock-session-gap"]');
    await openSessionMenu(page, row);
    await sessionMenuItem(page, 'rename').click();
    await page.getByTestId('session-rename-input').fill('终端里的会话');
    await page.getByTestId('session-rename-save').click();

    await expect(row).toContainText('终端里的会话');
    await expect(page.locator('#drawerNotice')).toContainText('终端正在使用这个会话，改名可能被覆盖');

    await expectNoBrowserErrors(page);
  });
});
