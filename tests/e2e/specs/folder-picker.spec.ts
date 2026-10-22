// spec: 「选文件夹」面板（「已连接的文件夹」，2026-09-24）——新会话在哪开。
// helpers: tests/helpers/playwright.ts · tests/helpers/sidebar-ui.ts
//
// 照官方桌面端：新会话页的文件夹胶囊就是选择器——已连接的文件夹（可进子文件夹、就地新建）、无文件夹、
// 添加文件夹（浏览家目录、只看得到目录名、不能加的置灰并写明原因）。
//
// 【这一层验什么、不验什么】只验「界面把意图发对了、结果画对了」。能不能加、名字合不合法、写没写进配置、
// 热加载生没生效由真 server 判（tests/invariants/folder-picker.test.mjs 与 server/folders.test.mjs），
// mock 只用一棵假家目录树回放那几种原因码。
import { test, expect, type Page } from '@playwright/test';
import { captureUserMessages, expectNoBrowserErrors, gotoMock, sendChatMessage, waitForIdle, waitUntilConnected, waitUntilDisconnected } from '../../helpers/playwright';
import { MAIN_WORKSPACE, openSessionsSidebar, workspaceRow } from '../../helpers/sidebar-ui';

const SCRATCH = '/Users/you/Library/Application Support/claude-chat-mobile/scratch-workspaces';
const picker = (page: Page) => page.locator('[data-testid="folder-picker"]');
const pickerTitle = (page: Page) => page.locator('[data-testid="folder-picker-title"]');
const entry = (page: Page, name: string) => picker(page).locator('[data-testid="folder-picker-entry"]', { has: page.locator('[data-folder-label]', { hasText: new RegExp(`^${name}$`) }) });

async function openPickerFromCompose(page: Page) {
  await page.locator('#btnNew').click();
  await expect(page.locator('[data-testid="compose-surface"]')).toBeVisible();
  await page.locator('[data-testid="compose-project-pill"]').click();
  await expect(picker(page)).toHaveClass(/sheet-open/);
}

test.describe('P0 日常零 token Mock UI 回归', () => {
  test.beforeEach(async ({ page }) => {
    await gotoMock(page);
    await waitForIdle(page);
  });

  test('P0-PICK-1 新会话页的文件夹胶囊打开选择器：进已连接文件夹挑一个子文件夹，就在那里开新会话', async ({ page }) => {
    await openPickerFromCompose(page);
    // 「无文件夹」「添加文件夹」在已连接文件夹之上：放末尾时文件夹一多（真机 11 个）就沉到折叠线以下
    const actionsFirst = await picker(page).evaluate(sheet => {
      const firstProject = sheet.querySelector('[data-testid="folder-picker-project"]');
      return ['folder-picker-no-folder', 'folder-picker-add'].every(id => {
        const node = sheet.querySelector(`[data-testid="${id}"]`);
        return Boolean(node && firstProject && (node.compareDocumentPosition(firstProject) & Node.DOCUMENT_POSITION_FOLLOWING));
      });
    });
    expect(actionsFirst, '「无文件夹」「添加文件夹」排在了已连接的文件夹后面').toBe(true);
    const main = picker(page).locator('[data-testid="folder-picker-project"]', { hasText: 'claude-chat-mobile' }).first();
    await expect(main).toBeVisible();
    await main.locator('[data-testid="folder-picker-enter"]').click();
    await expect(pickerTitle(page)).toHaveText('~/code/claude-chat-mobile');
    await entry(page, 'packages').locator('button').first().click();
    await expect(pickerTitle(page)).toHaveText('~/code/claude-chat-mobile/packages');
    // 挑子文件夹时往回走不越过起点：起点之上不在已连接的文件夹里，在那开会话会被服务端拒
    await page.locator('[data-testid="folder-picker-back"]').click();
    await expect(pickerTitle(page)).toHaveText('~/code/claude-chat-mobile');
    await page.locator('[data-testid="folder-picker-back"]').click();
    await expect(pickerTitle(page), '退到了 ~/code——那里不在任何已连接的文件夹里').toHaveText('选择文件夹');
    await picker(page).locator('[data-testid="folder-picker-project"]', { hasText: 'claude-chat-mobile' }).first()
      .locator('[data-testid="folder-picker-enter"]').click();
    await entry(page, 'packages').locator('button').first().click();
    await picker(page).locator('[data-testid="folder-picker-start-here"]').click();

    await expect(picker(page)).not.toHaveClass(/sheet-open/);
    await expect(page.locator('[data-testid="compose-project-pill"]')).toContainText('packages');
    await expect(page.locator('#topProjectText')).toHaveText('packages');
    await expectNoBrowserErrors(page);
  });

  test('P0-PICK-2 添加文件夹：不能加的置灰并写明原因；加上之后就在那里开新会话，抽屉里多一节', async ({ page }) => {
    await openSessionsSidebar(page);
    // 入口在文件夹清单之上：放末尾时文件夹一多（真机 11 个）就沉到折叠线以下，得先滚才找得到
    const addFirst = await page.locator('#sessionPanel').evaluate(panel => {
      const add = panel.querySelector('[data-testid="drawer-add-folder"]');
      const firstDir = panel.querySelector('div[data-dir]');
      return Boolean(add && firstDir && (add.compareDocumentPosition(firstDir) & Node.DOCUMENT_POSITION_FOLLOWING));
    });
    expect(addFirst, '「选择文件夹」排在了文件夹清单后面').toBe(true);
    await expect(page.locator('[data-testid="drawer-add-folder"]')).toContainText('选择文件夹');
    await page.locator('[data-testid="drawer-add-folder"]').click();
    await expect(picker(page)).toHaveClass(/sheet-open/);
    await expect(pickerTitle(page)).toHaveText('~');
    // 家目录本身不能加（官方同）：按钮是灰的，原因写出来
    await expect(picker(page).locator('[data-testid="folder-picker-start-here"]')).toBeDisabled();
    await expect(picker(page).locator('[data-testid="folder-picker-here-reason"]')).toHaveText('不能添加整个家目录');

    await entry(page, 'code').locator('button').first().click();
    await expect(entry(page, 'claude-chat-mobile').locator('[data-folder-sub]')).toHaveText('已经连接');
    // 自己建的平级 worktree 能加（照官方桌面端：只拦 Claude Code 建的）——它不随仓库授权，不让加就用不上
    await expect(entry(page, 'claude-chat-mobile-feat-y').locator('[data-folder-sub]')).toHaveCount(0);
    await expect(entry(page, 'new-idea').locator('[data-folder-sub]')).toHaveCount(0);

    await entry(page, 'new-idea').locator('button').first().click();
    await expect(pickerTitle(page)).toHaveText('~/code/new-idea');
    await picker(page).locator('[data-testid="folder-picker-start-here"]').click();

    await expect(picker(page)).not.toHaveClass(/sheet-open/);
    await expect(page.locator('[data-testid="compose-surface"]')).toBeVisible();
    await expect(page.locator('[data-testid="compose-project-pill"]')).toContainText('new-idea');
    await openSessionsSidebar(page);
    await expect(workspaceRow(page, '/Users/you/code/new-idea')).toHaveCount(1);
    await expectNoBrowserErrors(page);
  });

  // 验收 O41：清单改不了时，抽屉的「＋ 选择文件夹」此前照样可点，走完选择面板才被拒。
  // 与首页引导（P0-FOLDERS-RO）同一取舍：入口置灰，就地说清为什么。
  test('P0-PICK-5 工作区列表来自环境变量的安装：抽屉的「选择文件夹」置灰并说清为什么，点不开面板', async ({ page }) => {
    await sendChatMessage(page, 'test:folders-readonly');
    await waitForIdle(page);
    await openSessionsSidebar(page);
    const add = page.locator('[data-testid="drawer-add-folder"]');
    await expect(add).toBeDisabled();
    await expect(page.locator('[data-testid="drawer-folders-readonly"]')).toHaveText('工作区列表来自环境变量 WORK_DIRS，手机上改不了');
    await add.click({ force: true });
    await expect(picker(page), '置灰的入口点了照样开面板，等于没置灰').not.toHaveClass(/sheet-open/);
    await expectNoBrowserErrors(page);
  });

  // 验收 O41：面板开着时清单变成改不了的（换了安装形态），未连接的目录上「新建文件夹」「在这里开始会话」
  // 都是点了才被拒、前者还会留下空目录（服务端也拒，FOLDER-01）。先说清为什么，两个都不给点。
  test('P0-PICK-17 手机上改不了清单：未连接的目录上不给「新建文件夹」「在这里开始会话」，先说清为什么', async ({ page }) => {
    await openSessionsSidebar(page);
    await page.locator('[data-testid="drawer-add-folder"]').click();
    await page.request.post('/__folders-readonly?code=source_readonly');
    await entry(page, 'code').locator('button').first().click();
    await entry(page, 'new-idea').locator('button').first().click();
    await expect(picker(page).locator('[data-testid="folder-picker-readonly"]')).toHaveText('工作区列表来自环境变量 WORK_DIRS，手机上改不了');
    await expect(picker(page).locator('[data-testid="folder-picker-mkdir"]'), '给了一个建完才报「改不了」、还留下空目录的按钮').toHaveCount(0);
    await expect(picker(page).locator('[data-testid="folder-picker-start-here"]'), '未连接的目录加不进清单，点了只会被拒').toBeDisabled();
    await expectNoBrowserErrors(page);
  });

  // 浏览家目录时新建（2026-10-15 起）：建好就连上、就在里面开新会话——建一个空文件夹本来就是为了在里面干活。
  test('P0-PICK-3 就地新建文件夹：名字不合法时说清为什么；建好之后直接在新文件夹里开新会话', async ({ page }) => {
    await openPickerFromCompose(page);
    await picker(page).locator('[data-testid="folder-picker-add"]').click();
    await entry(page, 'code').locator('button').first().click();

    await picker(page).locator('[data-testid="folder-picker-mkdir"]').click();
    const name = picker(page).locator('[data-testid="folder-picker-mkdir-name"]');
    await name.fill('.secret');
    await picker(page).locator('[data-testid="folder-picker-mkdir-submit"]').click();
    await expect(page.locator('[data-testid="folder-picker-status"]')).toHaveText('名字不能以 . 开头');

    await name.fill('fresh-proj');
    await picker(page).locator('[data-testid="folder-picker-mkdir-submit"]').click();
    await expect(picker(page), '建好之后还停在面板里，得再点一次才能开会话').not.toHaveClass(/sheet-open/);
    await expect(page.locator('[data-testid="compose-project-pill"]')).toContainText('fresh-proj');
    await openSessionsSidebar(page);
    await expect(workspaceRow(page, '/Users/you/code/fresh-proj')).toHaveCount(1);
    await expectNoBrowserErrors(page);
  });

  test('P0-PICK-4 无文件夹：选中后胶囊写「无文件夹」；发出首条消息后抽屉里有这一节，会话挂在下面', async ({ page }) => {
    await openPickerFromCompose(page);
    await picker(page).locator('[data-testid="folder-picker-no-folder"]').click();
    await expect(picker(page)).not.toHaveClass(/sheet-open/);
    await expect(page.locator('[data-testid="compose-project-pill"]'), '显示成 scratch-workspaces，用户认不出这是哪').toContainText('无文件夹');

    // mock 对普通文本只回显不回复（这一轮不会结束），所以不等空闲：等懒开的实例进广播即可
    await sendChatMessage(page, '在无文件夹里说句话');
    await expect(page.locator('#topProjectText')).toHaveText('无文件夹');
    await openSessionsSidebar(page);
    await expect(workspaceRow(page, SCRATCH)).toContainText('无文件夹');
    const subtree = workspaceRow(page, SCRATCH).locator('xpath=following-sibling::*[1]');
    await expect(subtree.locator('[data-testid="session-row"][data-instance-id="inst_fresh"]')).toHaveCount(1);
    // 同一个会话不能再被画进它 cwd 前缀归不到的哪一节
    await expect(workspaceRow(page, MAIN_WORKSPACE).locator('xpath=following-sibling::*[1]').locator('[data-instance-id="inst_fresh"]')).toHaveCount(0);
    await expectNoBrowserErrors(page);
  });

  // 挑中的是仓库里的 linked worktree：它归仓库这个项目，新会话页的 viewingCwd 因而是仓库。首条消息要是按
  // viewingCwd 投，就开进了仓库的主工作树——用户以为隔离了的改动全落在主分支上。抓出向帧看它投到哪。
  test('P0-PICK-7 在仓库里的 worktree 上开新会话：首条消息投到 worktree，不是它所属的仓库', async ({ page }) => {
    const sent = captureUserMessages(page);
    await gotoMock(page);
    await waitForIdle(page);
    await openPickerFromCompose(page);
    await picker(page).locator('[data-testid="folder-picker-project"]', { hasText: 'claude-chat-mobile' }).first()
      .locator('[data-testid="folder-picker-enter"]').click();
    await entry(page, 'wt-feat-z').locator('button').first().click();
    await picker(page).locator('[data-testid="folder-picker-start-here"]').click();
    await expect(picker(page)).not.toHaveClass(/sheet-open/);
    // 等 session:new 的广播落地（它把 currentCwd 覆写成仓库）再发——广播前发出去的本来就对
    await expect(page.locator('#topProjectText')).toHaveText('claude-chat-mobile');

    await sendChatMessage(page, '在 worktree 里干活');
    await expect.poll(() => sent.length).toBeGreaterThan(0);
    expect(sent[0].cwd, '首条消息投到了 worktree 所属的仓库').toBe('/Users/you/code/claude-chat-mobile/wt-feat-z');
    await expectNoBrowserErrors(page);
  });

  // 新会话页选中 worktree 之后点 ＋：新的一页属于仓库本身，上一页的 worktree 目标要当场作废。等 session:new 的
  // 广播来清是来不及的——广播落地前发出去的首条消息会开进上一页的 worktree（2026-10-10 第五轮 review P1）。
  // 断网把广播挡在外面，「广播前就发」这个窗口就稳定可复现。
  test('P0-PICK-10 worktree 新会话页上点 ＋ 再发：开在仓库里，不沿用上一页的 worktree', async ({ page }) => {
    const sent = captureUserMessages(page);
    await gotoMock(page);
    await waitForIdle(page);
    await openPickerFromCompose(page);
    await picker(page).locator('[data-testid="folder-picker-project"]', { hasText: 'claude-chat-mobile' }).first()
      .locator('[data-testid="folder-picker-enter"]').click();
    await entry(page, 'wt-feat-z').locator('button').first().click();
    await picker(page).locator('[data-testid="folder-picker-start-here"]').click();
    await expect(page.locator('#topProjectText')).toHaveText('claude-chat-mobile');

    await page.context().setOffline(true);
    await waitUntilDisconnected(page);
    await page.locator('#btnNew').click();
    await page.locator('#input').fill('新的一页');
    await page.locator('#btnSend').click();
    await expect(page.locator('#input')).toHaveValue('');
    await page.context().setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await waitUntilConnected(page);

    await expect.poll(() => sent.map(m => m.text)).toEqual(['新的一页']);
    expect(sent[0].cwd, '点了 ＋ 的新会话开进了上一页选的 worktree').toBe(MAIN_WORKSPACE);
    await expectNoBrowserErrors(page);
  });

  // 离线时在「无文件夹」的新会话页上连发两条：重放时第一条懒开实例，第二条改投它（不再各建一个 scratch 目录），
  // 撞上第一条开跑的回合就落「未发送 + 重发」。「重发」要投给改投后的那个会话——拿入队时的原始条目
  // （instanceId 为空、cwd 是 scratch 根）去发，服务端会再建一个目录、再开一个会话，同一件事被拆成两半。
  test('P0-PICK-8 离线在「无文件夹」里连发两条：第二条撞上在途轮后，「重发」投给第一条开出来的会话', async ({ page }) => {
    const sent = captureUserMessages(page);
    await gotoMock(page);
    await waitForIdle(page);
    await sendChatMessage(page, 'test:arm-fresh-turn-running');
    await openPickerFromCompose(page);
    await picker(page).locator('[data-testid="folder-picker-no-folder"]').click();
    await expect(page.locator('[data-testid="compose-project-pill"]')).toContainText('无文件夹');

    await page.context().setOffline(true);
    await waitUntilDisconnected(page);
    for (const text of ['离线第一条', '离线第二条']) {
      await page.locator('#input').fill(text);
      await page.locator('#btnSend').click();
      await expect(page.locator('#input')).toHaveValue('');
    }
    await page.context().setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await waitUntilConnected(page);

    const resend = page.locator('[data-testid="outbox-resend"]');
    await expect(resend).toBeVisible();
    const before = sent.length;
    await resend.click();
    await expect.poll(() => sent.length).toBeGreaterThan(before);
    const again = sent[sent.length - 1];
    expect(again.text).toBe('离线第二条');
    expect(again.instanceId, `重发拿的是入队时的原始条目：${JSON.stringify(again)}`).toBe('inst_fresh');
    await expectNoBrowserErrors(page);
  });

  // 同一页连打几条该并成一个会话（P0-PICK-8），但两个「无文件夹」新会话页是用户有意分开的两个会话：
  // 两页的条目都是 instanceId:null + scratch 根，只按这两个字段认，第二页的话就被投进第一页开出来的会话，
  // 带着别人的上下文跑（2026-10-10 第四轮 review P2）。
  test('P0-PICK-9 离线时开了两个「无文件夹」新会话页：重放时各开各的，第二页的话不并进第一页的会话', async ({ page }) => {
    const sent = captureUserMessages(page);
    await gotoMock(page);
    await waitForIdle(page);
    await page.context().setOffline(true);
    await waitUntilDisconnected(page);
    for (const text of ['第一页的话', '第二页的话']) {
      await openPickerFromCompose(page);
      await picker(page).locator('[data-testid="folder-picker-no-folder"]').click();
      await expect(page.locator('[data-testid="compose-project-pill"]')).toContainText('无文件夹');
      await page.locator('#input').fill(text);
      await page.locator('#btnSend').click();
      await expect(page.locator('#input')).toHaveValue('');
    }
    await page.context().setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await waitUntilConnected(page);

    await expect.poll(() => sent.map(m => m.text)).toEqual(['第一页的话', '第二页的话']);
    const second = sent[1];
    expect(second.cwd).toBe(SCRATCH);
    expect(second.instanceId, `第二页的话被投进了第一页开出来的会话：${JSON.stringify(second)}`).toBeNull();
    await expectNoBrowserErrors(page);
  });

  // 「无文件夹」那一节的键是 scratch 根，它只是新会话页的启动键：@ 找文件拿它去问，服务端会拒。
  // 新会话页上还没有目录、也就没有文件；会话开起来之后，文件在它自己的 scratch 目录里。
  // 一个文件夹都没连（新装时跳过了，或全部断开了）：server 照常起、缺省停在「无文件夹」（SCOPE-03）。
  // 首页要说清下一步，而不是只摆一个空的「最近会话」——按钮直接进家目录浏览，加上一个就在那里开新会话。
  test('P0-PICK-11 一个文件夹都没连：首页给出引导，点「选择文件夹」加上一个就在那里开新会话', async ({ page }) => {
    await page.request.post('/__set-connected-folders?dirs=');
    const guide = page.locator('[data-testid="dash-no-folders"]');
    await expect(page.locator('[data-testid="home-dashboard"]')).toBeVisible();
    await expect(guide, '零文件夹的首页没有引导：只剩一个空的「最近会话」，用户不知道去哪加文件夹').toBeVisible();

    await guide.locator('[data-testid="dash-pick-folder"]').click();
    await expect(picker(page)).toHaveClass(/sheet-open/);
    await expect(pickerTitle(page), '引导按钮该直接进家目录浏览，而不是先停在一份空的「已连接的文件夹」上').toHaveText('~');
    await entry(page, 'code').locator('button').first().click();
    await entry(page, 'new-idea').locator('button').first().click();
    await picker(page).locator('[data-testid="folder-picker-start-here"]').click();
    await expect(picker(page)).not.toHaveClass(/sheet-open/);
    await expect(page.locator('[data-testid="compose-project-pill"]')).toContainText('new-idea');
    await expectNoBrowserErrors(page);
  });

  // 首页开着时别处连上了文件夹（电脑上改了配置，热加载广播）：引导跟着广播消失，不等下次重画首页。
  // 有文件夹时首页不出引导，也由这条的终态钉住。
  test('P0-PICK-12 首页开着时连上了文件夹：引导随广播消失', async ({ page }) => {
    await page.request.post('/__set-connected-folders?dirs=');
    const guide = page.locator('[data-testid="dash-no-folders"]');
    await expect(guide).toBeVisible();
    await page.request.post(`/__set-connected-folders?dirs=${encodeURIComponent(MAIN_WORKSPACE)}`);
    await expect(guide, '已经连上了文件夹，首页还在说「还没有连接文件夹」').toBeHidden();
    await expect(page.locator('[data-testid="home-dashboard"]')).toBeVisible();
    await expectNoBrowserErrors(page);
  });

  // 配置了文件夹、却一个都找不到（外置盘没挂上、目录被改名）：清单同样是空的，但首页不能说「还没有连接文件夹」——
  // 用户明明连过。标题说找不到，抽屉「服务」小节说出几个、怎么恢复。
  test('P0-PICK-13 配置的文件夹都找不到：首页说「找不到」而不是「还没连」，抽屉服务小节说出几个', async ({ page }) => {
    await page.request.post('/__set-connected-folders?dirs=&missing=2');
    const guide = page.locator('[data-testid="dash-no-folders"]');
    await expect(guide).toBeVisible();
    await expect(guide, '外置盘没挂上时首页说「还没有连接文件夹」，用户会以为配置丢了').toContainText('已连接的文件夹都找不到了');
    await openSessionsSidebar(page);
    await expect(page.locator('#serviceSection')).toContainText('2 个已连接的文件夹找不到了');
    await expectNoBrowserErrors(page);
  });

  // 浏览家目录时走到一个已经连着的文件夹：「在这里开始会话」直接开，不报「已经连接」也不重复添加。
  // 「已经连接」只作提示，不再置灰。
  test('P0-PICK-14 家目录里点已经连着的文件夹：在这里开始会话直接开，不重复添加', async ({ page }) => {
    await openSessionsSidebar(page);
    await page.locator('[data-testid="drawer-add-folder"]').click();
    await entry(page, 'code').locator('button').first().click();
    await expect(entry(page, 'claude-chat-mobile').locator('[data-folder-sub]')).toHaveText('已经连接');
    await entry(page, 'claude-chat-mobile').locator('button').first().click();
    await expect(pickerTitle(page)).toHaveText('~/code/claude-chat-mobile');
    const start = picker(page).locator('[data-testid="folder-picker-start-here"]');
    await expect(start, '已经连着的文件夹反而开不了会话').toBeEnabled();
    await start.click();
    await expect(picker(page)).not.toHaveClass(/sheet-open/);
    await expect(page.locator('[data-testid="compose-project-pill"]')).toContainText('claude-chat-mobile');
    await openSessionsSidebar(page);
    await expect(workspaceRow(page, MAIN_WORKSPACE), '同一个文件夹被加了第二遍').toHaveCount(1);
    await expectNoBrowserErrors(page);
  });

  // 清单来自环境变量 / 外置文件、或没有配置文件时，手机上加不了文件夹（folders:add 回 source_readonly / no_config_file）。
  // 零文件夹引导不能给一个走完整个选择面板才报错的按钮：广播里带着原因，引导把按钮换成这句话（2026-10-15 Codex review #204）。
  test('P0-PICK-15 零文件夹但手机上改不了清单：引导不给「选择文件夹」，直接说清为什么', async ({ page }) => {
    await page.request.post('/__set-connected-folders?dirs=&missing=1&readonly=source_readonly');
    const guide = page.locator('[data-testid="dash-no-folders"]');
    await expect(guide).toBeVisible();
    await expect(guide.locator('[data-testid="dash-pick-folder"]'), '手机上加不了，引导却给了一个走到底才报错的按钮').toBeHidden();
    await expect(guide.locator('[data-testid="dash-folders-readonly"]')).toHaveText('工作区列表来自环境变量 WORK_DIRS，手机上改不了');
    // 改得了的时候按钮回来、原因收起（同一页上随广播切换）
    await page.request.post('/__set-connected-folders?dirs=&readonly=');
    await expect(guide.locator('[data-testid="dash-pick-folder"]')).toBeVisible();
    await expect(guide.locator('[data-testid="dash-folders-readonly"]')).toBeHidden();
    await expectNoBrowserErrors(page);
  });

  // 「无文件夹」新会话页的 cwd 是 scratch 根：目录要等首条消息才建，服务端也不让浏览根本身（根下是所有无文件夹
  // 会话）。顶栏胶囊此前照样露出来，一点就是「无法加载：这个目录不在已连接的文件夹里」（2026-10-16 真机，
  // 零文件夹安装每次点 ＋ 都落在这一页）。会话开起来之后胶囊指向它自己的 scratch 目录，长按看到的也得是那个目录。
  test('P0-PICK-16 无文件夹：新会话页不给顶栏文件夹入口；会话开起来后入口指向它自己的 scratch 目录', async ({ page }) => {
    const browsed: string[] = [];
    page.on('websocket', ws => ws.on('framesent', frame => {
      if (typeof frame.payload === 'string' && frame.payload.includes('"browse:list"')) {
        browsed.push(JSON.parse(frame.payload.slice(frame.payload.indexOf('[')))[1]?.cwd);
      }
    }));
    await gotoMock(page);
    await waitForIdle(page);
    await openPickerFromCompose(page);
    await picker(page).locator('[data-testid="folder-picker-no-folder"]').click();
    await expect(page.locator('[data-testid="compose-project-pill"]')).toContainText('无文件夹');
    await expect(page.locator('#topContextPill'), '还没有目录可看，入口点开只会报「不在已连接的文件夹里」').toBeHidden();

    await sendChatMessage(page, '在无文件夹里说句话');
    const pill = page.locator('#topContextPill');
    await expect(pill).toBeVisible();
    await expect(pill, '长按看到的是 scratch 根，而点开浏览的是会话自己的目录').toHaveAttribute('title', `工作区：浏览或查看改动 · ${SCRATCH}/scratch-2026-09-24-mock01`);
    await pill.click();
    await expect(page.locator('#workspaceModal')).toBeVisible();
    await expect(page.locator('[data-testid="browse-entry"]').first()).toBeVisible();
    expect(browsed).toEqual([`${SCRATCH}/scratch-2026-09-24-mock01`]);
    await expectNoBrowserErrors(page);
  });

  test('P0-PICK-6 无文件夹里打 @：新会话页说「无匹配文件」而不是报越界；会话开起来之后在它自己的目录里找', async ({ page }) => {
    await openPickerFromCompose(page);
    await picker(page).locator('[data-testid="folder-picker-no-folder"]').click();
    const input = page.locator('#input');
    await input.fill('@');
    await expect(page.locator('[data-testid="at-mention-empty"]')).toHaveText('无匹配文件');

    await input.fill('');
    await sendChatMessage(page, '在无文件夹里说句话');
    // 懒开的实例广播可能晚于打字到达：视图换到新实例时草稿交换会把刚打的 @ 换走，所以换走了就重打
    await expect(async () => {
      await input.fill('@');
      await expect(page.locator('[data-testid="at-mention-chip"]').first()).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 8_000 });
    await expectNoBrowserErrors(page);
  });
});
