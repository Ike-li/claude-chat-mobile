// spec: 新会话页的「环境」：保存当前设置、选中后一次带上全部设置、改名更新删除、文件夹断开。
// helpers: tests/helpers/playwright.ts
//
// 判据的纯函数在 tests/unit/logic-saved-environments.test.mjs，存储与设备闸在 tests/unit/saved-environments、
// socket-environments。这里只验它们接到界面上了：这个功能最不能出的错，是列表里写着「新 worktree」，
// 选中后开出来的会话却没带上。

import { test, expect, type Page } from '@playwright/test';
import { expectNoBrowserErrors, gotoMock, sendChatMessage, waitForIdle, waitUntilConnected, waitUntilDisconnected } from '../../helpers/playwright';

const HOME_REPO = '/Users/you/code/claude-chat-mobile';
const OTHER_REPO = '/Users/you/code/another-react-project';

async function openCompose(page: Page, environments: object[] = []) {
  await gotoMock(page);
  await waitForIdle(page);
  await page.request.post('/__set-environments', { params: { list: JSON.stringify(environments) } });
  await page.locator('#btnNew').click();
  await expect(page.getByTestId('compose-surface')).toBeVisible();
}

test.describe('P0 日常零 token Mock UI 回归', () => {
  test('P0-ENV-1 保存当前设置：chip 换成环境名；改了设置就退回本电脑，改回来又认得', async ({ page }) => {
    await openCompose(page);
    const chip = page.getByTestId('compose-environment-chip');
    const save = page.getByTestId('compose-environment-save');
    const worktree = page.getByTestId('compose-worktree-toggle');
    await expect(chip).toContainText('本电脑');

    await save.click();
    const name = page.getByTestId('environment-name');
    await expect(name).toHaveValue('claude-chat-mobile'); // 默认用文件夹名，不用手打
    await name.fill('CCM 开发');
    await page.getByTestId('environment-form-save').click();
    await expect(page.getByTestId('environment-picker')).toBeHidden();
    await expect(chip).toContainText('CCM 开发');
    await expect(save).toHaveCount(0);

    await worktree.click();
    await expect(chip).toContainText('本电脑');
    await expect(save).toBeVisible();
    await worktree.click();
    await expect(chip).toContainText('CCM 开发');

    await expectNoBrowserErrors(page);
  });

  test('P0-ENV-2 选环境一次带上文件夹、模型、effort、worktree，意图随第一条消息发出', async ({ page }) => {
    await openCompose(page, [{ id: 'e1', name: 'React 隔离', cwd: OTHER_REPO, model: 'claude-3-5-sonnet', effort: 'high', worktree: true }]);
    // 环境的文件夹必须在已连接列表里：不在的话广播一到前端就清掉 currentCwd。这个端点顺带把视图切到「无文件夹」，
    // 正好验证从别处选环境也能把文件夹带过去
    await page.request.post('/__set-connected-folders', { params: { dirs: `${HOME_REPO},${OTHER_REPO}` } });
    await expect(page.getByTestId('compose-surface')).toBeVisible();
    await page.getByTestId('compose-environment-chip').click();
    await page.getByTestId('environment-row').filter({ hasText: 'React 隔离' }).getByTestId('environment-select').click();
    await expect(page.getByTestId('environment-picker')).toBeHidden();

    await expect(page.getByTestId('compose-project-pill')).toContainText('another-react-project');
    await expect(page.getByTestId('compose-worktree-toggle')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#pillModelText')).toContainText('claude-3-5-sonnet');
    await expect(page.locator('#pillEffortText')).toContainText('high');
    await expect(page.getByTestId('compose-environment-chip')).toContainText('React 隔离');

    // 胶囊写对不算数：要看发到服务端的是什么
    await sendChatMessage(page, 'test:fresh-settings-echo');
    await expect(page.locator('#messages')).toContainText('[MOCK_INFO] worktree requested from dev');
    await waitForIdle(page);
    const reply = page.locator('[data-testid="assistant-message"]').last();
    await expect(reply).toContainText('新会话设置回显：model=claude-3-5-sonnet');
    // effort 在 P0-ENV-2f 验：mock 的 worktree 分支先开一次实例，把待应用档位消费掉了，echo 再开时已经没有

    await expectNoBrowserErrors(page);
  });

  test('P0-ENV-2f 换文件夹时 model、effort 都真的发到服务端，不是只有胶囊写着', async ({ page }) => {
    await openCompose(page, [{ id: 'e1', name: 'React', cwd: OTHER_REPO, model: 'claude-3-5-sonnet', effort: 'high', worktree: false }]);
    await page.request.post('/__set-connected-folders', { params: { dirs: `${HOME_REPO},${OTHER_REPO}` } });
    await expect(page.getByTestId('compose-surface')).toBeVisible();
    await page.getByTestId('compose-environment-chip').click();
    await page.getByTestId('environment-row').filter({ hasText: 'React' }).getByTestId('environment-select').click();
    await expect(page.getByTestId('compose-environment-chip')).toContainText('React');

    await sendChatMessage(page, 'test:fresh-settings-echo');
    await waitForIdle(page);
    const reply = page.locator('[data-testid="assistant-message"]').last();
    await expect(reply).toContainText('新会话设置回显：model=claude-3-5-sonnet');
    await expect(reply).toContainText('effort=high');

    await expectNoBrowserErrors(page);
  });

  test('P0-ENV-2b 环境里的模型不在当前候选列表：选中后真的发得出去，不是只有胶囊写着', async ({ page }) => {
    await openCompose(page, [{ id: 'e1', name: '自定义模型', cwd: HOME_REPO, model: 'my-custom-model', effort: null, worktree: false }]);
    await page.getByTestId('compose-environment-chip').click();
    await page.getByTestId('environment-row').filter({ hasText: '自定义模型' }).getByTestId('environment-select').click();
    await expect(page.locator('#pillModelText')).toContainText('my-custom-model');
    await expect(page.locator('#modelInput')).toHaveValue('my-custom-model');
    await expect(page.getByTestId('compose-environment-chip')).toContainText('自定义模型');

    await sendChatMessage(page, 'test:fresh-settings-echo');
    await waitForIdle(page);
    await expect(page.locator('[data-testid="assistant-message"]').last()).toContainText('新会话设置回显：model=my-custom-model');

    await expectNoBrowserErrors(page);
  });

  test('P0-ENV-2c 分支还在路上就发第一条：环境要的 worktree 不能落空，否则改动全落到主工作树', async ({ page }) => {
    await openCompose(page, [{ id: 'e1', name: 'React 隔离', cwd: OTHER_REPO, model: null, effort: null, worktree: true }]);
    await page.request.post('/__set-connected-folders', { params: { dirs: `${HOME_REPO},${OTHER_REPO}` } });
    await expect(page.getByTestId('compose-surface')).toBeVisible();
    await page.request.post('/__hold-branches'); // 换文件夹后的 git:branches 回执先扣着，发完才放行

    await page.getByTestId('compose-environment-chip').click();
    await page.getByTestId('environment-row').filter({ hasText: 'React 隔离' }).getByTestId('environment-select').click();
    await page.locator('#input').fill('马上开工');
    await page.locator('#btnSend').click();
    await expect(page.locator('#messages')).toContainText('worktree requested');
    const { released } = await (await page.request.post('/__release-branches')).json();
    expect(released, '回执得一直扣到消息发出之后，否则这条验的不是这个窗口').toBeGreaterThan(0);

    await expectNoBrowserErrors(page);
  });

  async function pickWorktreeEnvironmentWhileBranchesHeld(page: Page) {
    await openCompose(page, [{ id: 'e1', name: 'React 隔离', cwd: OTHER_REPO, model: null, effort: null, worktree: true }]);
    await page.request.post('/__set-connected-folders', { params: { dirs: `${HOME_REPO},${OTHER_REPO}` } });
    await expect(page.getByTestId('compose-surface')).toBeVisible();
    await page.request.post('/__hold-branches');
    await page.getByTestId('compose-environment-chip').click();
    await page.getByTestId('environment-row').filter({ hasText: 'React 隔离' }).getByTestId('environment-select').click();
    await expect(page.getByTestId('environment-picker')).toBeHidden();
  }

  test('P0-ENV-2d 读分支临时失败：不算「不是 git 仓库」，worktree 意图留着，建不出来由服务端说', async ({ page }) => {
    await pickWorktreeEnvironmentWhileBranchesHeld(page);
    await page.request.post('/__release-branches', { params: { reply: 'git_failed' } });
    await expect(page.getByTestId('compose-environment-chip')).toContainText('React 隔离');

    await page.locator('#input').fill('读分支失败也别落到主工作树');
    await page.locator('#btnSend').click();
    await expect(page.locator('#messages')).toContainText('worktree requested');

    await expectNoBrowserErrors(page);
  });

  test('P0-ENV-2e 确认不是 git 仓库：这里没有 worktree，取消意图，chip 如实退回本电脑', async ({ page }) => {
    await pickWorktreeEnvironmentWhileBranchesHeld(page);
    await page.request.post('/__release-branches', { params: { reply: 'not_git' } });
    await expect(page.getByTestId('compose-environment-chip')).toContainText('本电脑');

    await sendChatMessage(page, 'test:fresh-settings-echo'); // 这条场景会开实例并收尾，普通消息在 mock 的空首页上收不了尾
    await waitForIdle(page);
    await expect(page.locator('#messages')).not.toContainText('worktree requested');

    await expectNoBrowserErrors(page);
  });

  test('P0-ENV-3 选「本电脑」还原默认设置，文件夹不动', async ({ page }) => {
    await openCompose(page, [{ id: 'e1', name: '隔离', cwd: HOME_REPO, model: 'claude-3-5-sonnet', effort: 'high', worktree: true }]);
    const chip = page.getByTestId('compose-environment-chip');
    await chip.click();
    await page.getByTestId('environment-row').filter({ hasText: '隔离' }).getByTestId('environment-select').click();
    await expect(chip).toContainText('隔离');

    await chip.click();
    await page.getByTestId('environment-this-computer').click();
    await expect(chip).toContainText('本电脑');
    await expect(page.getByTestId('compose-worktree-toggle')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('#pillModelText')).not.toContainText('claude-3-5-sonnet');
    await expect(page.getByTestId('compose-project-pill')).toContainText('claude-chat-mobile');

    await expectNoBrowserErrors(page);
  });

  test('P0-ENV-4 重名：说清原因，sheet 留着，打的字不丢', async ({ page }) => {
    await openCompose(page, [{ id: 'e1', name: '已有', cwd: OTHER_REPO, model: null, effort: null, worktree: false }]);
    await page.getByTestId('compose-environment-save').click();
    const name = page.getByTestId('environment-name');
    await name.fill('已有');
    await page.getByTestId('environment-form-save').click();
    await expect(page.getByTestId('environment-picker-status')).toContainText('同名');
    await expect(name).toHaveValue('已有');

    await expectNoBrowserErrors(page);
  });

  test('P0-ENV-5 编辑：改名、用当前设置更新、删除要确认', async ({ page }) => {
    await openCompose(page, [{ id: 'e1', name: '旧名', cwd: HOME_REPO, model: null, effort: null, worktree: false }]);
    await page.getByTestId('compose-worktree-toggle').click();
    await page.getByTestId('compose-environment-chip').click();
    const row = name => page.getByTestId('environment-row').filter({ hasText: name });

    await row('旧名').getByTestId('environment-edit').click();
    await page.getByTestId('environment-name').fill('新名');
    await page.getByTestId('environment-form-save').click();
    await expect(row('新名')).toBeVisible();
    await expect(row('新名')).not.toContainText('新 worktree'); // 只改名，设置不跟着当前页走

    await row('新名').getByTestId('environment-edit').click();
    await page.getByTestId('environment-update').click();
    await expect(row('新名')).toContainText('新 worktree');

    await row('新名').getByTestId('environment-edit').click();
    await page.getByTestId('environment-delete').click();
    await page.locator('#confirmOk').click();
    // 先等列表回来：表单开着时这里也没有环境行，直接断言数量会在删除完成前就绿
    await expect(page.getByTestId('environment-this-computer')).toBeVisible();
    await expect(row('新名')).toHaveCount(0);

    await expectNoBrowserErrors(page);
  });

  test('P0-ENV-6 文件夹断开的环境：标出来、选不了，但能改能删', async ({ page }) => {
    await openCompose(page, [{ id: 'e1', name: '旧仓库', cwd: '/Users/you/code/gone', model: null, effort: null, worktree: false, available: false }]);
    await page.getByTestId('compose-environment-chip').click();
    const row = page.getByTestId('environment-row').filter({ hasText: '旧仓库' });
    await expect(row).toContainText('文件夹已断开');
    await expect(row.getByTestId('environment-select')).toBeDisabled();
    await expect(row.getByTestId('environment-edit')).toBeEnabled();

    await expectNoBrowserErrors(page);
  });

  test('P0-ENV-8 断线时保存：当场说明，不留到重连后才悄悄生效', async ({ page }) => {
    await openCompose(page);
    await page.getByTestId('compose-environment-save').click();
    await page.getByTestId('environment-name').fill('断线时存的');

    await page.context().setOffline(true);
    await waitUntilDisconnected(page);
    await page.getByTestId('environment-form-save').click();
    await expect(page.getByTestId('environment-picker-status')).toContainText('连接');

    // 重连后那次写操作不能补发：否则用户再点一次就撞「已有同名环境」
    await page.context().setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await waitUntilConnected(page);
    await page.getByTestId('environment-form-save').click();
    await expect(page.getByTestId('environment-picker')).toBeHidden();
    await expect(page.getByTestId('compose-environment-chip')).toContainText('断线时存的');
  });

  test('P0-ENV-7 「无文件夹」页：能选环境，但当前设置没有文件夹可存', async ({ page }) => {
    await openCompose(page, [{ id: 'e1', name: '日常', cwd: HOME_REPO, model: null, effort: null, worktree: false }]);
    await page.request.post('/__set-connected-folders', { params: { dirs: HOME_REPO } }); // 把视图切到「无文件夹」
    await expect(page.getByTestId('compose-environment-chip')).toBeVisible();
    await expect(page.getByTestId('compose-environment-save')).toHaveCount(0);

    await page.getByTestId('compose-environment-chip').click();
    await expect(page.getByTestId('environment-new')).toHaveCount(0);
    await page.getByTestId('environment-row').filter({ hasText: '日常' }).getByTestId('environment-edit').click();
    await expect(page.getByTestId('environment-update')).toHaveCount(0);

    await expectNoBrowserErrors(page);
  });
});
