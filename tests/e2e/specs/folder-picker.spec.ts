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
import { expectNoBrowserErrors, gotoMock, sendChatMessage, waitForIdle } from '../../helpers/playwright';
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
    expect(addFirst, '「添加文件夹」排在了文件夹清单后面').toBe(true);
    await page.locator('[data-testid="drawer-add-folder"]').click();
    await expect(picker(page)).toHaveClass(/sheet-open/);
    await expect(pickerTitle(page)).toHaveText('~');
    // 家目录本身不能加（官方同）：按钮是灰的，原因写出来
    await expect(picker(page).locator('[data-testid="folder-picker-add-here"]')).toBeDisabled();
    await expect(picker(page).locator('[data-testid="folder-picker-here-reason"]')).toHaveText('不能添加整个家目录');

    await entry(page, 'code').locator('button').first().click();
    await expect(entry(page, 'claude-chat-mobile').locator('[data-folder-sub]')).toHaveText('已经连接');
    await expect(entry(page, 'claude-chat-mobile-feat-y').locator('[data-folder-sub]')).toHaveText('这是 git worktree，跟随所属仓库；请添加仓库本身');
    await expect(entry(page, 'new-idea').locator('[data-folder-sub]')).toHaveCount(0);

    await entry(page, 'new-idea').locator('button').first().click();
    await expect(pickerTitle(page)).toHaveText('~/code/new-idea');
    await picker(page).locator('[data-testid="folder-picker-add-here"]').click();

    await expect(picker(page)).not.toHaveClass(/sheet-open/);
    await expect(page.locator('[data-testid="compose-surface"]')).toBeVisible();
    await expect(page.locator('[data-testid="compose-project-pill"]')).toContainText('new-idea');
    await openSessionsSidebar(page);
    await expect(workspaceRow(page, '/Users/you/code/new-idea')).toHaveCount(1);
    await expectNoBrowserErrors(page);
  });

  test('P0-PICK-5 工作区列表来自环境变量的安装：添加被拒时说清为什么，面板不关', async ({ page }) => {
    await sendChatMessage(page, 'test:folders-readonly');
    await waitForIdle(page);
    await openSessionsSidebar(page);
    await page.locator('[data-testid="drawer-add-folder"]').click();
    await entry(page, 'code').locator('button').first().click();
    await entry(page, 'new-idea').locator('button').first().click();
    await picker(page).locator('[data-testid="folder-picker-add-here"]').click();
    await expect(page.locator('[data-testid="folder-picker-status"]')).toHaveText('工作区列表来自环境变量 WORK_DIRS，手机上改不了');
    await expect(picker(page), '没加上却关了面板，用户会以为加上了').toHaveClass(/sheet-open/);
    await expectNoBrowserErrors(page);
  });

  test('P0-PICK-3 就地新建文件夹：名字不合法时说清为什么；建好之后进到新文件夹里', async ({ page }) => {
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
    await expect(pickerTitle(page)).toHaveText('~/code/fresh-proj');
    await expect(picker(page).locator('[data-testid="folder-picker-add-here"]')).toBeEnabled();
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
});
