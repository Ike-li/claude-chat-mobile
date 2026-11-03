import { test, expect, type Page } from '@playwright/test';
import { expectNoBrowserErrors, gotoMock, sendChatMessage, waitForIdle, waitUntilConnected, waitUntilDisconnected } from '../../helpers/playwright';
import {
  ANOTHER_WORKSPACE, MAIN_WORKSPACE, chooseFolderMenuItem, dragFolderWithMouse, expandWorkspace, expectSidebarOpen, folderDragDelta, folderMenuItem,
  openFolderMenu, openSessionMenu, openSessionsSidebar, openWorkspaceSession, sessionMenuItem, showMoreSessions, workspaceRow, workspaceSubtree,
} from '../../helpers/sidebar-ui';

// 抽屉文件夹行的动作（2026-10-26）：「⋯」菜单里的「全部标为已读」（#300）与「断开连接」，长按拖动调整连接根的上下位置
// （取代 #305 置顶）。此前长按弹「全部标为已读 / 置顶」的确认框，长按就没法再拿来拖。
const SCRATCH_ROOT = '/Users/you/Library/Application Support/claude-chat-mobile/scratch-workspaces';
const SUBFOLDER = `${MAIN_WORKSPACE}/packages/web`;

async function markRowUnread(page: Page, sessionId: string) {
  await openSessionMenu(page, page.locator(`[data-testid="session-row"][data-session-id="${sessionId}"]`));
  await expect(sessionMenuItem(page, 'toggle-read')).toContainText('标为未读');
  await sessionMenuItem(page, 'toggle-read').click();
  await expect(page.locator('#sessionMenuModal')).not.toHaveClass(/sheet-open/);
}

// 抽屉里各节的先后（连接根、子文件夹小节、「无文件夹」都算）
function sectionOrder(page: Page) {
  return page.locator('#sessionPanel div[data-dir]').evaluateAll(els => els.map(e => e.getAttribute('data-dir')));
}

// test:projects 只连着主工作区；排序要比顺序，得有第二个连接根
async function connectTwoRoots(page: Page) {
  await page.request.post(`/__set-connected-folders?dirs=${encodeURIComponent(`${MAIN_WORKSPACE},${ANOTHER_WORKSPACE}`)}`);
}

function unreadChips(page: Page, cwd: string) {
  return workspaceRow(page, cwd).locator('xpath=following-sibling::*[1]').locator('[data-testid="unread-mark"]');
}

test.describe('P0 日常零 token Mock UI 回归', () => {
  // 很久没打开时，CLI 那边跑过的会话在抽屉里堆出一片未读。目标集合与目录角标同源：本页、「稍后再看」（pinned）、
  // 页外开着的（open）、被手动标未读的当前会话，四种来源一起清。此前角标不数 open 那组——行亮着 chip，数字却少一个。
  test('P0-FOLDER-READ-1 文件夹「⋯ → 全部标为已读」：四种来源的未读一起清，角标与 chip 同源，刷新后仍是已读', async ({ page }) => {
    await gotoMock(page);
    await sendChatMessage(page, 'test:live-paged-out'); // 截断成 3 条/页 + 开着一条被挤出本页的旧会话（open 组）
    await waitForIdle(page);
    // pinned：「显示更多」后手动标一条会被挤出本页的会话；刷新回到第一档，session:list 把它补回「稍后再看」
    await openSessionsSidebar(page);
    await expandWorkspace(page, MAIN_WORKSPACE);
    await showMoreSessions(page, MAIN_WORKSPACE);
    await markRowUnread(page, 'mock-session-gap');
    // 再把基线拨到两小时前：主工作区的旧会话都晚于基线，按时间判据亮（先拨的话 gap 已经亮了，就标不成「稍后再看」）
    await page.request.post('/__arm-read-baseline?agoMs=7200000');
    await page.reload();
    await waitUntilConnected(page);
    await openSessionsSidebar(page);
    const mainDir = await expandWorkspace(page, MAIN_WORKSPACE);

    // 当前会话：正看着时手动标未读（手动标记不受「正在看」管辖，当场亮）
    await markRowUnread(page, 'mock-session-visual-test');

    // 前提：四种来源各有未读行，角标与 chip 数一致
    for (const id of ['mock-session-archived', 'mock-session-gap', 'mock-session-older-migration', 'mock-session-visual-test']) {
      await expect(page.locator(`[data-testid="session-row"][data-session-id="${id}"] [data-testid="unread-mark"]`), id).toHaveText('未读');
    }
    await expect(page.getByTestId('session-pinned-head')).toBeVisible();
    const chipCount = await unreadChips(page, MAIN_WORKSPACE).count();
    expect(chipCount).toBe(5); // 本页 archived + worktree、pinned gap、open older-migration、当前会话
    await expect(mainDir.locator('[data-testid="dir-unread"]'), '角标漏数 open 组就会说 4').toHaveText(`${chipCount} 未读`);

    await openFolderMenu(page, MAIN_WORKSPACE);
    await expect(page.locator('#sessionMenuTitle')).toHaveText('claude-chat-mobile');
    await expect(folderMenuItem(page, 'mark-all-read'), '菜单里的个数与角标同源').toHaveText(`全部标为已读（${chipCount}）`);
    await folderMenuItem(page, 'mark-all-read').click();
    const modal = page.locator('#confirmModal');
    await expect(modal).toHaveClass(/sheet-open/);
    await expect(page.locator('#confirmTitle')).toHaveText('claude-chat-mobile');
    await expect(page.locator('#confirmBody')).toHaveText('把这里的 5 个未读会话标为已读，还没显示的更早会话也一起。');
    await expect(page.locator('#confirmOk')).toHaveText('全部标为已读');
    await page.locator('#confirmOk').click();

    await expect(unreadChips(page, MAIN_WORKSPACE)).toHaveCount(0);
    await expect(mainDir.locator('[data-testid="dir-unread"]')).toBeHidden();

    // 服务端位点：五条都记了 seen，手动标记不再生效（旧设备带着旧 manual 回连也盖不过这笔 seen）
    await expect.poll(async () => {
      const state = await (await page.request.get('/__read-state')).json();
      return ['mock-session-archived', 'mock-session-worktree', 'mock-session-gap', 'mock-session-older-migration', 'mock-session-visual-test']
        .filter(id => !(typeof state.seen?.[id] === 'number' && !((state.manual?.[id] ?? -Infinity) > state.seen[id])));
    }).toEqual([]);

    await page.reload();
    await waitUntilConnected(page);
    await openSessionsSidebar(page);
    const dirAfter = await expandWorkspace(page, MAIN_WORKSPACE);
    await expect(page.locator('[data-testid="session-row"][data-session-id="mock-session-archived"]')).toBeVisible();
    await expect(unreadChips(page, MAIN_WORKSPACE)).toHaveCount(0);
    await expect(dirAfter.locator('[data-testid="dir-unread"]')).toBeHidden();

    await expectNoBrowserErrors(page);
  });

  // 离线时 read:mark 发不出去（不带 ack、不排队），靠重连那一趟 read:sync 把本地表整份推上去归并。
  test('P0-FOLDER-READ-3 离线时全部标为已读：重连后服务端位点与本机一致', async ({ page, request }) => {
    await gotoMock(page);
    await page.request.post('/__arm-read-baseline?agoMs=7200000');
    await page.reload();
    await waitUntilConnected(page);
    await openSessionsSidebar(page);
    const mainDir = await expandWorkspace(page, MAIN_WORKSPACE);
    await expect(mainDir.locator('[data-testid="dir-unread"]')).toHaveText(/^\d+ 未读$/);
    const targets = await unreadChips(page, MAIN_WORKSPACE).evaluateAll(chips =>
      chips.map(c => c.closest('[data-testid="session-row"]')?.getAttribute('data-session-id')));
    expect(targets.length).toBeGreaterThan(1);

    await page.context().setOffline(true);
    await waitUntilDisconnected(page);
    await chooseFolderMenuItem(page, MAIN_WORKSPACE, 'mark-all-read');
    await page.locator('#confirmOk').click();
    await expect(unreadChips(page, MAIN_WORKSPACE)).toHaveCount(0);
    const before = await (await request.get('/__read-state')).json();
    expect(targets.filter(id => before.seen?.[id] !== undefined), '前提：离线期间一条都没到服务端').toEqual([]);

    await page.context().setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await waitUntilConnected(page);
    const local = await page.evaluate(() => JSON.parse(localStorage.getItem('ccm-unread-v1') || '{}').seen || {});
    await expect.poll(async () => {
      const remote = (await (await request.get('/__read-state')).json()).seen || {};
      return targets.filter(id => typeof local[id] !== 'number' || remote[id] !== local[id]);
    }).toEqual([]);
    // 文件夹水位同理：离线时报不出去，随重连的 read:sync 补上（否则更早的会话在别的设备上照样亮）
    const localFolders = await page.evaluate(() => JSON.parse(localStorage.getItem('ccm-unread-v1') || '{}').folders || {});
    expect(typeof localFolders[MAIN_WORKSPACE], '前提：本地记下了水位').toBe('number');
    expect(before.folders?.[MAIN_WORKSPACE], '前提：离线期间水位没到服务端').toBeUndefined();
    await expect.poll(async () => (await (await request.get('/__read-state')).json()).folders?.[MAIN_WORKSPACE]).toBe(localFolders[MAIN_WORKSPACE]);

    await expectNoBrowserErrors(page);
  });

  // 2026-10-26 真机：「全部标为已读」只标了屏幕上那 6 行，点开更早的会话一看冒出 34 个未读。
  // 现在它同时记一条文件夹水位，服务端在 session:list 回执里把水位折进每行。按机主当时的顺序走：
  // 先确认更早的会话确实会亮（不然这条在「旧会话本来就不亮」时也会绿），收起回第一档，再标、再展开。
  test('P0-FOLDER-READ-4 全部标为已读后再「显示更多」：拉出来的更早会话不亮', async ({ page }) => {
    await gotoMock(page);
    await sendChatMessage(page, 'test:history-overflow'); // 主工作区每档 3 条
    await waitForIdle(page);
    await page.request.post('/__arm-read-baseline?agoMs=7200000'); // 基线拨到两小时前：主工作区的会话都按时间亮
    await page.reload();
    await waitUntilConnected(page);
    await openSessionsSidebar(page);
    const mainDir = await expandWorkspace(page, MAIN_WORKSPACE);
    const older = page.locator('[data-testid="session-row"][data-session-id="mock-session-older-migration"]');

    await showMoreSessions(page, MAIN_WORKSPACE, 2);
    await expect(older.locator('[data-testid="unread-mark"]'), '前提：更早的这条按时间判据会亮').toHaveText('未读');
    await page.getByTestId('session-show-less').click();
    await expect(older).toHaveCount(0);

    await chooseFolderMenuItem(page, MAIN_WORKSPACE, 'mark-all-read');
    await expect(page.locator('#confirmBody')).toContainText('还没显示的更早会话也一起');
    await page.locator('#confirmOk').click();
    await expect(unreadChips(page, MAIN_WORKSPACE)).toHaveCount(0);

    await showMoreSessions(page, MAIN_WORKSPACE, 2);
    await expect(older).toBeVisible();
    await expect(unreadChips(page, MAIN_WORKSPACE), '更早的会话没在屏幕上出现过，只能靠文件夹水位算读过').toHaveCount(0);
    await expect(mainDir.locator('[data-testid="dir-unread"]')).toBeHidden();

    await expectNoBrowserErrors(page);
  });

  // 标已读不改配置，所以每一节的「⋯」里都有；「断开连接」只给手机上改得了清单的连接根。
  test('P0-FOLDER-READ-2 子文件夹小节、「无文件夹」、只读配置来源下，「⋯」里都有全部标为已读', async ({ page }) => {
    await gotoMock(page);
    await page.request.post('/__arm-read-baseline?agoMs=7200000'); // 无文件夹那条旧会话（-1h）晚于基线
    await sendChatMessage(page, 'test:projects');
    await waitForIdle(page);
    await page.request.post('/__folders-readonly');
    await page.reload();
    await waitUntilConnected(page);
    await openSessionsSidebar(page);

    // 无文件夹：有一条按时间亮的未读
    const scratch = await expandWorkspace(page, SCRATCH_ROOT);
    await expect(scratch.locator('[data-testid="dir-unread"]')).toHaveText('1 未读');
    await chooseFolderMenuItem(page, SCRATCH_ROOT, 'mark-all-read');
    await expect(page.locator('#confirmTitle')).toHaveText('无文件夹');
    await page.locator('#confirmOk').click();
    await expect(scratch.locator('[data-testid="dir-unread"]')).toBeHidden();
    await expect(unreadChips(page, SCRATCH_ROOT)).toHaveCount(0);

    // 子文件夹小节：没有未读，这一项照样在、灰掉并说明（而不是点了毫无动静）
    await expandWorkspace(page, SUBFOLDER);
    await expect(workspaceRow(page, SUBFOLDER).locator('[data-testid="dir-unread"]')).toBeHidden();
    await openFolderMenu(page, SUBFOLDER);
    await expect(folderMenuItem(page, 'mark-all-read')).toBeDisabled();
    await expect(folderMenuItem(page, 'mark-all-read')).toContainText('这里没有未读会话');
    await expect(folderMenuItem(page, 'disconnect'), '子文件夹不是连接根，断开它什么也断不掉').toHaveCount(0);
    await page.locator('#sessionMenuCancel').click();
    await expect(page.locator('#sessionMenuModal')).not.toHaveClass(/sheet-open/);

    // 只读来源下的连接根（基线拨早后它的旧会话按时间亮）：没有「断开连接」，标已读照常
    await expandWorkspace(page, MAIN_WORKSPACE);
    await expect(workspaceRow(page, MAIN_WORKSPACE).locator('[data-testid="dir-unread"]')).toHaveText(/^\d+ 未读$/);
    await openFolderMenu(page, MAIN_WORKSPACE);
    await expect(folderMenuItem(page, 'disconnect'), '只读来源下断不开，菜单里不该给').toHaveCount(0);
    await folderMenuItem(page, 'mark-all-read').click();
    await expect(page.locator('#confirmOk')).toHaveText('全部标为已读');
    await page.locator('#confirmOk').click();
    await expect(workspaceRow(page, MAIN_WORKSPACE).locator('[data-testid="dir-unread"]')).toBeHidden();

    await expectNoBrowserErrors(page);
  });

  // 长按连接根拖动（2026-10-26，取代 #305 置顶）：拖的是整块（根 + 它的子文件夹小节），「无文件夹」恒垫底。
  // 顺序存服务端（所有设备共享），松手先按拖出来的样子摆，服务端广播新清单后整段重画。
  test('P0-FOLDER-ORDER-1 长按连接根拖到别的根上方 / 下方：子文件夹跟着走、「无文件夹」垫底；原地松手不误触展开；刷新后顺序还在', async ({ page }) => {
    await gotoMock(page);
    await sendChatMessage(page, 'test:projects');
    await waitForIdle(page);
    await connectTwoRoots(page);
    await openSessionsSidebar(page);
    const before = await sectionOrder(page);
    expect(before, '前提：主工作区、它的子文件夹、另一个工作区、「无文件夹」').toEqual([MAIN_WORKSPACE, SUBFOLDER, ANOTHER_WORKSPACE, SCRATCH_ROOT]);
    await expandWorkspace(page, MAIN_WORKSPACE);
    const mainSubtree = workspaceSubtree(page, MAIN_WORKSPACE);
    await expect(mainSubtree).toHaveClass(/expanded/);

    // 拖起来又原地松手（改主意了）：顺序不变；浏览器照常补发 click，不拦就把这一节折叠了。用最上面那一行：
    // 它上方没有会收起的展开区，拖起来不会离开指针，抬手的 click 一定落回它身上。
    // 点击切换是同步的，mouse.up 返回时已经发生过，紧接着断言是有效的。
    await workspaceRow(page, MAIN_WORKSPACE).locator('button').first().hover();
    await page.mouse.down();
    await expect(page.locator('#sessionPanel')).toHaveClass(/folder-dragging/);
    await page.mouse.up();
    await expect(page.locator('#sessionPanel')).not.toHaveClass(/folder-dragging/);
    await expect(mainSubtree, '原地松手补发的 click 把这一节折叠了').toHaveClass(/expanded/);
    expect(await sectionOrder(page)).toEqual(before);

    await dragFolderWithMouse(page, ANOTHER_WORKSPACE, MAIN_WORKSPACE, 'above');
    await expect.poll(() => sectionOrder(page)).toEqual([ANOTHER_WORKSPACE, MAIN_WORKSPACE, SUBFOLDER, SCRATCH_ROOT]);

    await page.reload();
    await waitUntilConnected(page);
    await openSessionsSidebar(page);
    expect(await sectionOrder(page), '顺序没存到服务端').toEqual([ANOTHER_WORKSPACE, MAIN_WORKSPACE, SUBFOLDER, SCRATCH_ROOT]);

    await dragFolderWithMouse(page, ANOTHER_WORKSPACE, MAIN_WORKSPACE, 'below');
    await expect.poll(() => sectionOrder(page)).toEqual(before);

    await expectNoBrowserErrors(page);
  });

  // 会话行此前的教训：行上的横向手势和抽屉自己的左滑收起抢同一次触摸。拖文件夹时手指难免横着带一下，
  // 不能因此把抽屉收走；拖动中页面也不能跟着滚（浏览器一接管滚动就发 pointercancel，拖动就断了）。
  test('P0-FOLDER-ORDER-2 触屏长按拖动：横着带出 120px 抽屉也不收，松手后顺序生效', async ({ page }) => {
    await gotoMock(page);
    await sendChatMessage(page, 'test:projects');
    await waitForIdle(page);
    await connectTwoRoots(page);
    await openSessionsSidebar(page);

    const handle = workspaceRow(page, ANOTHER_WORKSPACE).locator('button').first();
    await handle.hover({ trial: true }); // 等抽屉滑入完、行稳定了再量坐标
    const from = await handle.boundingBox();
    if (!from) throw new Error('另一个工作区的行不可见');
    const x = from.x + from.width / 2;
    const y = from.y + from.height / 2;
    const cdp = await page.context().newCDPSession(page);
    const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', px = 0, py = 0) =>
      cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x: px, y: py }] });

    await touch('touchStart', x, y);
    await expect(page.locator('#sessionPanel'), '触屏长按没拖起来').toHaveClass(/folder-dragging/);
    const dy = await folderDragDelta(page, ANOTHER_WORKSPACE, MAIN_WORKSPACE, 'above'); // 横移前量：行会跟着手指走
    for (let i = 1; i <= 4; i++) await touch('touchMove', x - 30 * i, y); // 抽屉的左滑收起阈值是 65px
    await expectSidebarOpen(page);
    for (let i = 1; i <= 4; i++) await touch('touchMove', x - 120, y + dy * (i / 4));
    await touch('touchEnd');

    await expect(page.locator('#sessionPanel')).not.toHaveClass(/folder-dragging/);
    await expect.poll(() => sectionOrder(page)).toEqual([ANOTHER_WORKSPACE, MAIN_WORKSPACE, SUBFOLDER, SCRATCH_ROOT]);
    await expectSidebarOpen(page);

    await expectNoBrowserErrors(page);
  });

  test('P0-FOLDER-ORDER-3 服务端拒了：回到服务端的顺序，并说一声', async ({ page }) => {
    await gotoMock(page);
    await sendChatMessage(page, 'test:projects');
    await waitForIdle(page);
    await connectTwoRoots(page);
    await openSessionsSidebar(page);
    const before = await sectionOrder(page);

    await page.request.post('/__folder-reorder-fail');
    await dragFolderWithMouse(page, ANOTHER_WORKSPACE, MAIN_WORKSPACE, 'above');
    await expect(page.locator('#leftSidebar [data-testid="drawer-notice"]')).toHaveText('顺序没保存上，稍后再试');
    expect(await sectionOrder(page), '服务端拒了，界面却留着拖出来的顺序').toEqual(before);

    await expectNoBrowserErrors(page);
  });

  // 回归（2026-10-26）：MAIN_WORKSPACE 是当前正在看的工作区——先点开 inst_1 的会话把 currentCwd 钉在
  // 这里（connectTwoRoots 本身会把 viewing 归位到「无文件夹」，不代表真实场景），UX-007 让重开抽屉时
  // 默认展开它；用户手动折叠它之后，挪动别的文件夹顺序不该把它重新强制展开——那次广播只是顺序变了，
  // 目录集合、viewingInstanceId、currentCwd 都没变，不该走全量重建那条路径。
  //
  // 排序本身是客户端拖动时就地摆好的（folder-drag.js），sectionOrder 松手即对；但「是否被连带强制展开」
  // 取决于服务端回广播、落地处理完之后的状态，必须等这条广播真落地再断言——否则在它赶到前就断言，
  // 测试会在 bug 仍在的情况下也通过（见 PR 调试记录）。监听器须挂在 gotoMock 之前，否则错过这条连接。
  test('P0-FOLDER-ORDER-4 折叠当前工作区后拖别的文件夹换序，不该把它连带强制展开', async ({ page }) => {
    const instancesFrames: string[] = [];
    page.on('websocket', ws => {
      ws.on('framereceived', frame => {
        if (typeof frame.payload === 'string' && frame.payload.includes('"type":"instances"')) instancesFrames.push(frame.payload);
      });
    });

    await gotoMock(page);
    await sendChatMessage(page, 'test:projects');
    await waitForIdle(page);
    await connectTwoRoots(page);
    await openSessionsSidebar(page);
    await openWorkspaceSession(page, MAIN_WORKSPACE, 'Visual Sandbox (Main)');
    await waitForIdle(page);
    await openSessionsSidebar(page);

    const mainSubtree = workspaceSubtree(page, MAIN_WORKSPACE);
    await expect(mainSubtree, '前提：UX-007 默认展开当前工作区').toHaveClass(/expanded/);
    await workspaceRow(page, MAIN_WORKSPACE).locator('button').first().click();
    await expect(mainSubtree, '手动折叠').not.toHaveClass(/expanded/);

    const framesBeforeDrag = instancesFrames.length;
    await dragFolderWithMouse(page, ANOTHER_WORKSPACE, MAIN_WORKSPACE, 'above');
    await expect.poll(() => sectionOrder(page)).toEqual([ANOTHER_WORKSPACE, MAIN_WORKSPACE, SUBFOLDER, SCRATCH_ROOT]);
    await expect.poll(() => instancesFrames.length, '等服务端换序广播真的落地，不能在它赶到前就断言').toBeGreaterThan(framesBeforeDrag);
    await expect(mainSubtree, '换序不该把手动折叠的当前工作区重新展开').not.toHaveClass(/expanded/);

    await expectNoBrowserErrors(page);
  });
});
