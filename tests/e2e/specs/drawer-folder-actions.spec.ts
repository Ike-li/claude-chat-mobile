import { test, expect, type Page } from '@playwright/test';
import { expectNoBrowserErrors, gotoMock, sendChatMessage, waitForIdle, waitUntilConnected, waitUntilDisconnected } from '../../helpers/playwright';
import { ANOTHER_WORKSPACE, MAIN_WORKSPACE, expandWorkspace, openSessionsSidebar, showMoreSessions, workspaceRow } from '../../helpers/sidebar-ui';

// 抽屉文件夹行的长按动作（#300 全部标为已读、#305 置顶 / 取消置顶）。
// 长按挂在文件夹行的主按钮上；桌面右键（contextmenu）与触屏长按走同一个入口（见 long-press.js），这里用右键触发。
const SCRATCH_ROOT = '/Users/you/Library/Application Support/claude-chat-mobile/scratch-workspaces';
const SUBFOLDER = `${MAIN_WORKSPACE}/packages/web`;

async function longPressFolder(page: Page, cwd: string) {
  await workspaceRow(page, cwd).locator('button').first().dispatchEvent('contextmenu');
}

async function markRowUnread(page: Page, sessionId: string) {
  await page.locator(`[data-testid="session-row"][data-session-id="${sessionId}"]`).dispatchEvent('contextmenu');
  await expect(page.locator('#confirmOk')).toHaveText('标为未读');
  await page.locator('#confirmOk').click();
  await expect(page.locator('#confirmModal')).not.toHaveClass(/sheet-open/);
}

// 抽屉里各节的先后（连接根、子文件夹小节、「无文件夹」都算）
function sectionOrder(page: Page) {
  return page.locator('#sessionPanel div[data-dir]').evaluateAll(els => els.map(e => e.getAttribute('data-dir')));
}

// test:projects 只连着主工作区；置顶要比顺序，得有第二个连接根
async function connectTwoRoots(page: Page) {
  await page.request.post(`/__set-connected-folders?dirs=${encodeURIComponent(`${MAIN_WORKSPACE},${ANOTHER_WORKSPACE}`)}`);
}

function unreadChips(page: Page, cwd: string) {
  return workspaceRow(page, cwd).locator('xpath=following-sibling::*[1]').locator('[data-testid="unread-mark"]');
}

test.describe('P0 日常零 token Mock UI 回归', () => {
  // 很久没打开时，CLI 那边跑过的会话在抽屉里堆出一片未读。目标集合与目录角标同源：本页、「稍后再看」（pinned）、
  // 页外开着的（open）、被手动标未读的当前会话，四种来源一起清。此前角标不数 open 那组——行亮着 chip，数字却少一个。
  test('P0-FOLDER-READ-1 长按文件夹「全部标为已读」：四种来源的未读一起清，角标与 chip 同源，刷新后仍是已读', async ({ page }) => {
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

    await longPressFolder(page, MAIN_WORKSPACE);
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
    await longPressFolder(page, MAIN_WORKSPACE);
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

  // 2026-10-26 真机：长按「全部标为已读」只标了屏幕上那 6 行，点开更早的会话一看冒出 34 个未读。
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

    await longPressFolder(page, MAIN_WORKSPACE);
    await expect(page.locator('#confirmBody')).toContainText('还没显示的更早会话也一起');
    await page.locator('#confirmOk').click();
    await expect(unreadChips(page, MAIN_WORKSPACE)).toHaveCount(0);

    await showMoreSessions(page, MAIN_WORKSPACE, 2);
    await expect(older).toBeVisible();
    await expect(unreadChips(page, MAIN_WORKSPACE), '更早的会话没在屏幕上出现过，只能靠文件夹水位算读过').toHaveCount(0);
    await expect(mainDir.locator('[data-testid="dir-unread"]')).toBeHidden();

    await expectNoBrowserErrors(page);
  });

  // 入口不挂在「⋯」上：「⋯」只给连接根、只读配置来源下也没有。标已读不改配置，所以每一节都要有。
  test('P0-FOLDER-READ-2 子文件夹小节、「无文件夹」、只读配置来源下，长按入口都在', async ({ page }) => {
    await gotoMock(page);
    await page.request.post('/__arm-read-baseline?agoMs=7200000'); // 无文件夹那条旧会话（-1h）晚于基线
    await sendChatMessage(page, 'test:projects');
    await waitForIdle(page);
    await page.request.post('/__folders-readonly');
    await page.reload();
    await waitUntilConnected(page);
    await openSessionsSidebar(page);
    await expect(workspaceRow(page, MAIN_WORKSPACE).locator('[data-testid="dir-disconnect"]'), '前提：只读来源下没有「⋯」').toHaveCount(0);

    // 无文件夹：有一条按时间亮的未读
    const scratch = await expandWorkspace(page, SCRATCH_ROOT);
    await expect(scratch.locator('[data-testid="dir-unread"]')).toHaveText('1 未读');
    await longPressFolder(page, SCRATCH_ROOT);
    await expect(page.locator('#confirmTitle')).toHaveText('无文件夹');
    await page.locator('#confirmOk').click();
    await expect(scratch.locator('[data-testid="dir-unread"]')).toBeHidden();
    await expect(unreadChips(page, SCRATCH_ROOT)).toHaveCount(0);

    // 子文件夹小节：没有未读，长按照样有反应（说一声没有，而不是毫无动静）
    await expandWorkspace(page, SUBFOLDER);
    await expect(workspaceRow(page, SUBFOLDER).locator('[data-testid="dir-unread"]')).toBeHidden();
    await longPressFolder(page, SUBFOLDER);
    await expect(page.locator('#leftSidebar [data-testid="drawer-notice"]')).toHaveText('这里没有未读会话');

    // 只读来源下的连接根（基线拨早后它的旧会话按时间亮）
    await expandWorkspace(page, MAIN_WORKSPACE);
    await expect(workspaceRow(page, MAIN_WORKSPACE).locator('[data-testid="dir-unread"]')).toHaveText(/^\d+ 未读$/);
    await longPressFolder(page, MAIN_WORKSPACE);
    await expect(page.locator('#confirmOk')).toHaveText('全部标为已读');
    await page.locator('#confirmOk').click();
    await expect(workspaceRow(page, MAIN_WORKSPACE).locator('[data-testid="dir-unread"]')).toBeHidden();

    await expectNoBrowserErrors(page);
  });

  // #305：置顶只改抽屉顺序；不做乐观更新，等服务端广播新清单再重画，所以按钮文字与顺序都来自服务端。
  // 同一次长按两件事：有未读时主按钮仍是「全部标为已读」、置顶是次按钮；没有未读时置顶就是主按钮。
  test('P0-FOLDER-PIN-1 长按连接根「置顶」：连同子文件夹一起移到最前；再长按变「取消置顶」，取消后回到原顺序', async ({ page }) => {
    await gotoMock(page);
    await sendChatMessage(page, 'test:projects');
    await waitForIdle(page);
    await connectTwoRoots(page);
    await openSessionsSidebar(page);
    const before = await sectionOrder(page);
    expect(before, '前提：主工作区、它的子文件夹、另一个工作区、「无文件夹」').toEqual([MAIN_WORKSPACE, SUBFOLDER, ANOTHER_WORKSPACE, SCRATCH_ROOT]);

    // 有未读：置顶是次按钮
    await longPressFolder(page, ANOTHER_WORKSPACE);
    await expect(page.locator('#confirmTitle')).toHaveText('another-react-project');
    await expect(page.locator('#confirmOk')).toHaveText('全部标为已读');
    await expect(page.locator('#confirmAlt')).toHaveText('置顶');
    await page.locator('#confirmAlt').click();
    await expect.poll(() => sectionOrder(page)).toEqual([ANOTHER_WORKSPACE, MAIN_WORKSPACE, SUBFOLDER, SCRATCH_ROOT]);
    await expect(workspaceRow(page, ANOTHER_WORKSPACE).locator('[data-testid="dir-unread"]'), '点的是置顶，不该顺手把未读清了').toHaveText(/^\d+ 未读$/);

    // 主工作区这时没有未读：置顶就是主按钮。最后置顶的在最前，子文件夹跟着根走，「无文件夹」仍垫底
    await longPressFolder(page, MAIN_WORKSPACE);
    await expect(page.locator('#confirmOk')).toHaveText('置顶');
    await expect(page.locator('#confirmAlt')).toBeHidden();
    await page.locator('#confirmOk').click();
    await expect.poll(() => sectionOrder(page)).toEqual([MAIN_WORKSPACE, SUBFOLDER, ANOTHER_WORKSPACE, SCRATCH_ROOT]);

    // 取消置顶：按钮文字跟着服务端清单变，取消后回到配置顺序
    await longPressFolder(page, MAIN_WORKSPACE);
    await expect(page.locator('#confirmOk')).toHaveText('取消置顶');
    await page.locator('#confirmOk').click();
    await expect.poll(() => sectionOrder(page)).toEqual([ANOTHER_WORKSPACE, MAIN_WORKSPACE, SUBFOLDER, SCRATCH_ROOT]);
    await longPressFolder(page, ANOTHER_WORKSPACE);
    await expect(page.locator('#confirmAlt')).toHaveText('取消置顶');
    await page.locator('#confirmAlt').click();
    await expect.poll(() => sectionOrder(page)).toEqual(before);

    await expectNoBrowserErrors(page);
  });

  test('P0-FOLDER-PIN-2 子文件夹小节没有置顶入口；服务端回失败时界面上没有假置顶', async ({ page }) => {
    await gotoMock(page);
    await sendChatMessage(page, 'test:projects');
    await waitForIdle(page);
    await connectTwoRoots(page);
    await openSessionsSidebar(page);

    await expandWorkspace(page, SUBFOLDER);
    await longPressFolder(page, SUBFOLDER);
    await expect(page.locator('#leftSidebar [data-testid="drawer-notice"]')).toHaveText('这里没有未读会话');
    await expect(page.locator('#confirmModal'), '子文件夹不是连接根，没有置顶这回事').not.toHaveClass(/sheet-open/);

    const before = await sectionOrder(page);
    await page.request.post('/__folder-pin-fail');
    await longPressFolder(page, ANOTHER_WORKSPACE);
    await page.locator('#confirmAlt').click();
    await expect(page.locator('#leftSidebar [data-testid="drawer-notice"]')).toHaveText('置顶没成功，稍后再试');
    expect(await sectionOrder(page), '服务端拒了，顺序却变了 = 假置顶').toEqual(before);
    await longPressFolder(page, ANOTHER_WORKSPACE);
    await expect(page.locator('#confirmAlt')).toHaveText('置顶');
    await page.locator('#confirmCancel').click();

    await expectNoBrowserErrors(page);
  });
});
