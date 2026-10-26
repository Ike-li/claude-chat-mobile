import { test, expect } from '@playwright/test';
import { expectNoBrowserErrors, gotoMock, sendChatMessage, waitForIdle, waitUntilConnected, waitUntilDisconnected } from '../../helpers/playwright';
import { MAIN_WORKSPACE, chooseSessionMenuItem, expandWorkspace, expectSidebarClosed, openSessionsSidebar, sessionRowByInstance, startNewSessionInWorkspace, workspaceRow } from '../../helpers/sidebar-ui';

// 「已连接的文件夹」（2026-09-24）：抽屉按项目分组，照官方桌面端的侧栏——
//   · 已连接文件夹里有会话的子文件夹自成一节，紧跟所属文件夹，标题「根 › 相对路径」；
//   · worktree 不自成一节，按实例的 projectKey 挂在所属仓库下，cwd 前缀归不到时也一样（真机 1c401b5d 就是这种会话
//     从抽屉里消失）。真 server 只对连接范围里的 worktree 这样给（2026-10-10 起范围外的要显式连接）；
//     mock 直接给 projectKey，这里测的是前端按它归节；
//   · 「无文件夹」有会话时垫底一节。
const SUB = `${MAIN_WORKSPACE}/packages/web`;
const SCRATCH = '/Users/you/Library/Application Support/claude-chat-mobile/scratch-workspaces';
const subtreeOf = (page, cwd: string) => workspaceRow(page, cwd).locator('xpath=following-sibling::*[1]');

test.describe('P0 日常零 token Mock UI 回归', () => {
  test.beforeEach(async ({ page }) => {
    await gotoMock(page);
  });

  test('P0-PROJ-1 抽屉按项目分组：子文件夹紧跟所属文件夹、平级 worktree 随仓库、无文件夹垫底', async ({ page }) => {
    await sendChatMessage(page, 'test:projects');
    await waitForIdle(page);
    await openSessionsSidebar(page);

    const order = await page.locator('#sessionPanel div[data-dir]').evaluateAll(els => els.map(e => e.getAttribute('data-dir')));
    expect(order.indexOf(SUB), `小节顺序：${JSON.stringify(order)}`).toBe(order.indexOf(MAIN_WORKSPACE) + 1);
    expect(order.at(-1)).toBe(SCRATCH);
    await expect(workspaceRow(page, SUB)).toContainText('claude-chat-mobile › packages/web');
    await expect(workspaceRow(page, SCRATCH)).toContainText('无文件夹');

    // 平级 worktree 的会话挂在仓库那一节，不进「不在已连接的文件夹里」
    await expandWorkspace(page, MAIN_WORKSPACE);
    await expect(subtreeOf(page, MAIN_WORKSPACE).locator('[data-testid="session-row"][data-instance-id="inst_sib_owned"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="unowned-live-section"]')).toHaveCount(0);

    await expandWorkspace(page, SUB);
    await expect(subtreeOf(page, SUB).locator('[data-testid="session-row"][data-instance-id="inst_sub"]')).toHaveCount(1);
    await expect(sessionRowByInstance(page, 'inst_sub'), '子文件夹的会话不能在所属文件夹那一节再出现一次').toHaveCount(1);

    await expandWorkspace(page, SCRATCH);
    const scratchRow = subtreeOf(page, SCRATCH).locator('[data-testid="session-row"][data-instance-id="inst_scratch"]');
    await expect(scratchRow).toHaveCount(1);
    await scratchRow.locator('button').first().click();
    await expect(page.locator('#topProjectText'), '顶栏写成 scratch 目录名，用户根本认不出这是哪').toHaveText('无文件夹');
  });

  test('P0-PROJ-2 删除「无文件夹」会话：确认框说清临时目录会一并删除，删完这一行不再出现', async ({ page }) => {
    await sendChatMessage(page, 'test:projects');
    await waitForIdle(page);
    await openSessionsSidebar(page);
    await expandWorkspace(page, SCRATCH);
    const row = subtreeOf(page, SCRATCH).locator('[data-testid="session-row"]', { hasText: '以前的无文件夹会话' });
    await expect(row).toHaveCount(1);
    await chooseSessionMenuItem(page, row, 'delete');
    await expect(page.locator('#confirmBody'), '不说一声就把模型写在临时目录里的文件一起删了').toContainText('临时目录和里面的文件会一并删除');
    await page.locator('#confirmOk').click();
    await expect(subtreeOf(page, SCRATCH).locator('[data-testid="session-row"]', { hasText: '以前的无文件夹会话' })).toHaveCount(0);
    await expect(page.locator('#messages')).toContainText('临时目录已一并删除');
  });

  // 抽屉里断开文件夹（2026-10-15）：只有连接根给「⋯」（子文件夹小节、「无文件夹」不是连接根）。确认框说清
  // 断开不动文件与会话，并说出这里开着几个会话；断开后那一节消失，开着的会话照常在（挪到「不在已连接的文件夹里」）。
  test('P0-PROJ-3 断开文件夹：只有连接根有入口；确认框说出开着几个会话；断开后那一节消失，会话照常在', async ({ page }) => {
    await sendChatMessage(page, 'test:projects');
    await waitForIdle(page);
    await openSessionsSidebar(page);

    const more = (cwd: string) => workspaceRow(page, cwd).locator('[data-testid="dir-disconnect"]');
    await expect(more(SUB), '子文件夹小节不是连接根，断开它什么也断不掉').toHaveCount(0);
    await expect(more(SCRATCH), '「无文件夹」不能断开').toHaveCount(0);
    await expect(more(MAIN_WORKSPACE)).toHaveCount(1);

    await more(MAIN_WORKSPACE).click();
    await expect(page.locator('#confirmTitle')).toHaveText('断开「claude-chat-mobile」？');
    // 开着的：inst_1、仓库外 worktree 里的（归这个仓库）、子文件夹小节里的——子文件夹那一节会跟着一起消失
    await expect(page.locator('#confirmBody'), '没说开着的会话会怎样，或者说少了（子文件夹小节里在跑的没算）')
      .toContainText('这里有 3 个会话开着，会照常继续');
    await page.locator('#confirmOk').click();

    await expect(workspaceRow(page, MAIN_WORKSPACE), '断开之后那一节还在').toHaveCount(0);
    await expect(page.locator('[data-testid="unowned-live-section"]').locator('[data-testid="session-row"][data-instance-id="inst_1"]'),
      '断开把开着的会话从抽屉里弄丢了').toHaveCount(1);
    await expectNoBrowserErrors(page);
  });

  // 验收 O119：断开一个文件夹后，停在它新会话页上的页面被服务端归位到别的工作区——胶囊换了名字、@ 搜索也跟着换了，
  // 页面上什么都没说，用户以为还在原来的文件夹里开会话。归位时在新会话页上说一句。
  test('P0-PROJ-6 新会话页所在的文件夹被断开 → 归位到别的工作区，并在页面上说明', async ({ page }) => {
    await sendChatMessage(page, 'test:projects');
    await waitForIdle(page);
    const compose = page.locator('[data-testid="compose-surface"]');
    await openSessionsSidebar(page);
    await startNewSessionInWorkspace(page, MAIN_WORKSPACE);
    await expectSidebarClosed(page);
    await expect(compose.getByTestId('compose-project-pill')).toContainText('claude-chat-mobile');

    // 另一台设备把新会话页换到别的文件夹（原来那个还连着）：服务端广播的工作区变了，但不是断开——不提示
    await page.request.post(`/__compose-cwd?cwd=${encodeURIComponent(SUB)}`);
    await expect(compose.getByTestId('compose-project-pill'), '前提：共享视图下这一页跟着换了工作区').toContainText('web');
    await expect(compose.getByTestId('compose-relocated'), '别的设备换个文件夹也被说成「已断开」').toHaveCount(0);
    await openSessionsSidebar(page);
    await startNewSessionInWorkspace(page, MAIN_WORKSPACE);
    await expectSidebarClosed(page);
    await expect(compose.getByTestId('compose-project-pill')).toContainText('claude-chat-mobile');

    await openSessionsSidebar(page);
    await workspaceRow(page, MAIN_WORKSPACE).locator('[data-testid="dir-disconnect"]').click();
    await page.locator('#confirmOk').click();
    await expect(workspaceRow(page, MAIN_WORKSPACE)).toHaveCount(0);

    await expect(compose.getByTestId('compose-project-pill'), '前提：新会话页被归位到别的工作区').not.toContainText('claude-chat-mobile');
    await expect(compose.getByTestId('compose-relocated'), '悄悄换了工作区，页面上什么都没说').toContainText('claude-chat-mobile');
    await expectNoBrowserErrors(page);
  });

  // 验收 O128：新会话页停在一个文件夹上、断线时发了一条（进离线队列），别的设备随后断开了这个文件夹。重连后这一页被归位到
  // 别的工作区，离线那条被永久拒收、原文放回输入框——拒收提示把整张新会话页冲掉了，「已断开」那句跟着没了，用户直接再按
  // 发送，消息就换了个文件夹发出去。新会话页要留着，拒收提示和「已断开」都看得见。
  test('P0-PROJ-6c 新会话页离线发出的消息因文件夹被断开而拒收 → 新会话页与「已断开」提示都留着，原文回输入框', async ({ page, request }) => {
    await sendChatMessage(page, 'test:projects');
    await waitForIdle(page);
    const compose = page.locator('[data-testid="compose-surface"]');
    await openSessionsSidebar(page);
    await startNewSessionInWorkspace(page, MAIN_WORKSPACE);
    await expectSidebarClosed(page);
    await expect(compose.getByTestId('compose-project-pill')).toContainText('claude-chat-mobile');

    await page.context().setOffline(true);
    await waitUntilDisconnected(page);
    await page.locator('#input').fill('断线时在这个文件夹里写的');
    await page.locator('#btnSend').click();
    await expect(page.locator('#input')).toHaveValue('');
    // 另一台设备断开这个文件夹：这一页断着线，经 HTTP 让 mock 照 folders:remove 处理
    expect((await (await request.post(`/__disconnect-folder?path=${encodeURIComponent(MAIN_WORKSPACE)}`)).json()).ok).toBe(true);
    await page.context().setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await waitUntilConnected(page);

    await expect(page.locator('#input'), '前提：拒收后原文放回输入框').toHaveValue('断线时在这个文件夹里写的');
    await expect(page.locator('#messages'), '前提：拒收要说清已停止重试').toContainText('已停止重试');
    await expect(compose, '拒收提示把新会话页冲掉了：看不出输入框里这条再发会发到哪').toHaveCount(1);
    await expect(compose.getByTestId('compose-project-pill'), '前提：新会话页被归位到别的工作区').not.toContainText('claude-chat-mobile');
    await expect(compose.getByTestId('compose-relocated'), '「已断开」那句被冲掉了').toContainText('claude-chat-mobile');
    await expectNoBrowserErrors(page);
  });

  // #330 review P2：展示用的项目清单不能当「连没连着」的依据——「无文件夹」只在用着时占一节、子文件夹只在有会话时
  // 占一节。别的设备把这一页换走后它们不在清单里了，那不是被断开，不提示。
  test('P0-PROJ-6b 新会话页停在「无文件夹」/ 没有会话的子文件夹时别的设备换了文件夹 → 不说「已断开」', async ({ page }) => {
    const compose = page.locator('[data-testid="compose-surface"]');
    await openSessionsSidebar(page);
    await startNewSessionInWorkspace(page, MAIN_WORKSPACE);
    await expectSidebarClosed(page);
    await page.request.post(`/__compose-cwd?cwd=${encodeURIComponent(SCRATCH)}`);
    await expect(compose.getByTestId('compose-project-pill'), '前提：这一页停在「无文件夹」').toContainText('无文件夹');
    await page.request.post(`/__compose-cwd?cwd=${encodeURIComponent(SUB)}`);
    await expect(compose.getByTestId('compose-project-pill')).toContainText('web');
    await expect(compose.getByTestId('compose-relocated'), '「无文件夹」被说成「已断开」').toHaveCount(0);
    // 子文件夹同理：没有会话时它不占一节（这里没跑 test:projects，web 不在清单里），但仍在已连接的根之下
    await page.request.post(`/__compose-cwd?cwd=${encodeURIComponent(MAIN_WORKSPACE)}`);
    await expect(compose.getByTestId('compose-project-pill')).not.toContainText('web');
    await expect(compose.getByTestId('compose-relocated'), '仍在已连接文件夹之下的子文件夹被说成「已断开」').toHaveCount(0);
    await expectNoBrowserErrors(page);
  });

  // 清单来自环境变量 / 外置文件、或没有配置文件时，手机上断不开（folders:remove 回 source_readonly / no_config_file）。
  // 不给「⋯」：点下去只会在确认之后才报「改不了」（同首页零文件夹引导，2026-10-15 Codex review #204）。
  // 能改时给入口由 P0-PROJ-3 钉着。
  test('P0-PROJ-4 手机上改不了清单时不给断开入口', async ({ page }) => {
    await page.request.post(`/__set-connected-folders?dirs=${encodeURIComponent(MAIN_WORKSPACE)}&readonly=source_readonly`);
    await openSessionsSidebar(page);
    await expect(workspaceRow(page, MAIN_WORKSPACE)).toHaveCount(1);
    await expect(workspaceRow(page, MAIN_WORKSPACE).locator('[data-testid="dir-disconnect"]'), '断不开却给了入口，确认之后才报改不了').toHaveCount(0);
    await expectNoBrowserErrors(page);
  });
});
