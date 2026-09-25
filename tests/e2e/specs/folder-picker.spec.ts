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
import { expectNoBrowserErrors, gotoMock, sendChatMessage, waitForIdle, waitUntilConnected, waitUntilDisconnected } from '../../helpers/playwright';
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

  // 挑中的是仓库里的 linked worktree：它归仓库这个项目，新会话页的 viewingCwd 因而是仓库。首条消息要是按
  // viewingCwd 投，就开进了仓库的主工作树——用户以为隔离了的改动全落在主分支上。抓出向帧看它投到哪。
  test('P0-PICK-7 在仓库里的 worktree 上开新会话：首条消息投到 worktree，不是它所属的仓库', async ({ page }) => {
    const sent: string[] = [];
    page.on('websocket', ws => ws.on('framesent', frame => {
      if (typeof frame.payload === 'string' && frame.payload.includes('"user:message"')) sent.push(frame.payload);
    }));
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
    const [, payload] = JSON.parse(sent[0].slice(sent[0].indexOf('[')));
    expect(payload.cwd, '首条消息投到了 worktree 所属的仓库').toBe('/Users/you/code/claude-chat-mobile/wt-feat-z');
    await expectNoBrowserErrors(page);
  });

  // 离线时在「无文件夹」的新会话页上连发两条：重放时第一条懒开实例，第二条改投它（不再各建一个 scratch 目录），
  // 撞上第一条开跑的回合就落「未发送 + 重发」。「重发」要投给改投后的那个会话——拿入队时的原始条目
  // （instanceId 为空、cwd 是 scratch 根）去发，服务端会再建一个目录、再开一个会话，同一件事被拆成两半。
  test('P0-PICK-8 离线在「无文件夹」里连发两条：第二条撞上在途轮后，「重发」投给第一条开出来的会话', async ({ page }) => {
    const sent: Array<{ text?: string; instanceId?: string | null; cwd?: string }> = [];
    page.on('websocket', ws => ws.on('framesent', frame => {
      if (typeof frame.payload === 'string' && frame.payload.includes('"user:message"')) {
        sent.push(JSON.parse(frame.payload.slice(frame.payload.indexOf('[')))[1]);
      }
    }));
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

  // 「无文件夹」那一节的键是 scratch 根，它只是新会话页的启动键：@ 找文件拿它去问，服务端会拒。
  // 新会话页上还没有目录、也就没有文件；会话开起来之后，文件在它自己的 scratch 目录里。
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
