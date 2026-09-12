// spec: 新会话页的「在新 worktree 里开」两件套（源分支 chip + 勾选），以及意图随第一条消息发出。
// helpers: tests/helpers/playwright.ts
//
// 为什么必须有这一条：勾选与源分支的判据都是纯函数、已在 tests/unit 里两侧验收过，但**那些函数
// 有没有被接到界面上**单测一个字都答不了。这个功能唯一不能出的错是"用户以为勾上了、其实没建"，
// 而那恰好是一个纯 UI 状态问题——勾选框亮着但 user:message 里没带那两个字段，在别处全是绿的。
//
// 【这一层验什么、不验什么】只验「前端把意图发出去了」。mock 不碰磁盘，收到 useWorktree 就回一条
// `[MOCK_INFO] worktree requested from <branch>` 的 system。真正"建对没有"（落点、源分支、
// 重名、干净检查）由跑真 git 的 tests/unit/git-worktree.test.mjs 与集成层守，不在这里重复。
//
// mock 侧固定返回 branches=['dev','main','feature/login'] / current='dev'。

import { test, expect } from '@playwright/test';
import { expectNoBrowserErrors, gotoMock, waitForIdle } from '../../helpers/playwright';

test.describe('P0 日常零 token Mock UI 回归', () => {
  test('P0-40 新会话 worktree：源分支可换、勾选不发请求、意图随第一条消息发出', async ({ page }) => {
    await gotoMock(page);
    await waitForIdle(page);

    await page.locator('#btnNew').click();
    const surface = page.locator('[data-testid="compose-surface"]');
    await expect(surface).toBeVisible();

    // ① 两个 chip 都在，源分支缺省跟随仓库当前分支
    const branchChip = surface.locator('[data-testid="compose-source-branch"]');
    const wtToggle = surface.locator('[data-testid="compose-worktree-toggle"]');
    await expect(branchChip).toBeVisible();
    await expect(branchChip).toContainText('dev');
    // 缺省不勾：勾选是对"这一个新会话"的显式决定，绝不能默认开着
    await expect(wtToggle).toHaveAttribute('aria-pressed', 'false');

    // ② 换源分支：点开是自绘按钮组（不是原生 select——移动端上那个会把弹层渲染到页面另一头）
    await branchChip.click();
    const list = surface.locator('[data-testid="compose-branch-list"]');
    await expect(list).toBeVisible();
    await expect(list.locator('button')).toHaveCount(3);
    await list.locator('button', { hasText: 'main' }).click();
    await expect(list).toHaveCount(0);
    await expect(branchChip).toContainText('main');

    // ③ 勾选只改本地状态：副标题说清落点，但**此刻磁盘上什么都还没建**（懒创建）
    await wtToggle.click();
    await expect(wtToggle).toHaveAttribute('aria-pressed', 'true');
    await expect(surface).toContainText('不动当前工作树');
    await expect(surface).toContainText('main');

    // ④ 发出第一条消息 → 意图跟着这条消息一起到服务端。
    //    这条断言是整个 spec 的核心：勾选框亮着但 payload 里没带字段时，只有它会红。
    await page.locator('#input').fill('改点东西');
    await page.locator('#btnSend').click();
    await expect(page.locator('#messages')).toContainText('worktree requested from main');

    await expectNoBrowserErrors(page);
  });

  test('P0-40b 勾了又回新会话：意图不残留（勾选不是全局偏好）', async ({ page }) => {
    await gotoMock(page);
    await waitForIdle(page);

    await page.locator('#btnNew').click();
    const surface = page.locator('[data-testid="compose-surface"]');
    await surface.locator('[data-testid="compose-worktree-toggle"]').click();
    await expect(surface.locator('[data-testid="compose-worktree-toggle"]')).toHaveAttribute('aria-pressed', 'true');

    await page.locator('#btnNew').click();
    await expect(surface).toBeVisible();
    await expect(surface.locator('[data-testid="compose-worktree-toggle"]')).toHaveAttribute('aria-pressed', 'false');
    // 源分支也回到缺省（跟随仓库当前分支），不保留上一轮选的
    await expect(surface.locator('[data-testid="compose-source-branch"]')).toContainText('dev');

    // 没勾时发消息不得带意图——正对照：上一条用例的核心断言不是恒真的
    await page.locator('#input').fill('普通消息');
    await page.locator('#btnSend').click();
    await expect(page.locator('#messages')).toContainText('普通消息');
    await expect(page.locator('#messages')).not.toContainText('worktree requested');

    await expectNoBrowserErrors(page);
  });
});
