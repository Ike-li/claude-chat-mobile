// helpers: tests/helpers/playwright.ts

import { test, expect, type Page } from '@playwright/test';
import { ensureComposerReady, expectNoBrowserErrors, gotoMock, sendChatMessage, waitUntilConnected, waitUntilDisconnected } from '../../helpers/playwright';
import { MAIN_WORKSPACE, expandWorkspace, expectSidebarClosed, openSessionsSidebar, openWorkspaceSession } from '../../helpers/sidebar-ui';

// 续接会丢掉一段对话（SESSION-04）：电脑上开着的终端在旧叶子下写过东西、又比手机侧晚退出，CLI 下次 resume
// 就接回终端那一支，手机上最近那段不进模型上下文。真 server 在 resume 时算出来，发送前以 resume_divergent 拒收，
// 前端出面板：「分叉到新会话」/「仍然发送」/ 取消。mock 的 test:arm-resume-divergence 给 Archived Planning Session
// 挂上这个结论（形态取真机 c78e8b47：终端那一轮接上、手机上最近 2 条被丢）。
// 守的是用户看得见的：被拒的那条不留假气泡、话回到输入框；面板说清两端与条数；三个选项各自的结局。
// 不守：结论算得对不对（tests/unit/resume-anchor.test.mjs）；闸与自动继续（tests/invariants/resume-divergence-gate.test.mjs）。
const TEXT = '手机上接着问：上一步的结论是什么？';

async function openArmedArchivedSession(page: Page) {
  await gotoMock(page);
  await ensureComposerReady(page);
  await sendChatMessage(page, 'test:arm-resume-divergence');
  await openSessionsSidebar(page);
  await expandWorkspace(page, MAIN_WORKSPACE);
  await openWorkspaceSession(page, MAIN_WORKSPACE, 'Archived Planning Session');
  await expectSidebarClosed(page);
  await expect(page.locator('#messages')).toContainText('Archived plan replay', { timeout: 10_000 });
}

async function hitDivergenceGate(page: Page) {
  await openArmedArchivedSession(page);
  await sendChatMessage(page, TEXT);
  await expect(page.locator('#confirmModal')).toBeVisible({ timeout: 5_000 });
}

const bubblesWithText = (page: Page) => page.locator('[data-testid="user-message"]', { hasText: TEXT });

test.describe('P0 日常零 token Mock UI 回归', () => {
  test('P0-RESUME-DIV 续接会丢对话时发送被拒：不留假气泡、话回到输入框，面板说清两端与条数；取消就留着', async ({ page }) => {
    await hitDivergenceGate(page);

    await expect(page.locator('#confirmTitle')).toContainText('续接会丢掉一段对话');
    await expect(page.locator('#confirmBody')).toContainText('模型会从终端那一轮接上，手机上最近 2 条消息不在它的上下文里');
    await expect(page.locator('#confirmOk')).toHaveText('分叉到新会话');
    await expect(page.locator('#confirmAlt')).toBeVisible();
    await expect(page.locator('#confirmAlt')).toHaveText('仍然发送');
    // 这条没发出去：留着那颗转圈的乐观气泡，用户会以为模型收到了
    await expect(bubblesWithText(page)).toHaveCount(0);
    await expect(page.locator('#input')).toHaveValue(TEXT);

    await page.locator('#confirmCancel').click();
    await expect(page.locator('#confirmModal')).toBeHidden();
    await expect(page.locator('#input')).toHaveValue(TEXT);
    await expect(bubblesWithText(page)).toHaveCount(0);

    await expectNoBrowserErrors(page);
  });

  test('P0-RESUME-DIVb 仍然发送：带上「确认的是这一段」重发，这次真发出去', async ({ page }) => {
    await hitDivergenceGate(page);

    // mock 镜像真 server 的闸：确认必须是这一段最新那条的 uuid，送错（漏带、送布尔）会被再拒一次、面板重新弹出
    await page.locator('#confirmAlt').click();
    await expect(bubblesWithText(page)).toHaveCount(1, { timeout: 10_000 });
    await expect(page.locator('#confirmModal')).toBeHidden();
    await expect(page.locator('#input')).toHaveValue('');

    await expectNoBrowserErrors(page);
  });

  test('P0-RESUME-DIVc 分叉到新会话：切到从最新那条分出的新会话，话挪进它的输入框，原会话不留这份草稿', async ({ page }) => {
    await hitDivergenceGate(page);

    // mock 的 session:fork 护栏只收 keepAnchorTurn=true + a-archived-*（结论里的 newestUuid）：方向或锚点送错就分叉失败
    await page.locator('#confirmOk').click();
    await expect(page.locator('#messages')).toContainText('Forked session ready.', { timeout: 10_000 });
    await expect(page.locator('#input')).toHaveValue(TEXT);
    await expect(page.locator('#messages')).toContainText('已分叉到新会话');
    await expect(bubblesWithText(page)).toHaveCount(0); // 不替用户发：会话换了，先看一眼再按发送

    // 是「挪」不是「复制」：回到原会话，输入框里不该还躺着同一句
    await openSessionsSidebar(page);
    await expandWorkspace(page, MAIN_WORKSPACE);
    await openWorkspaceSession(page, MAIN_WORKSPACE, 'Archived Planning Session');
    await expectSidebarClosed(page);
    await expect(page.locator('#messages')).toContainText('Archived plan replay', { timeout: 10_000 });
    await expect(page.locator('#input')).toHaveValue('');

    await expectNoBrowserErrors(page);
  });

  // 离线打的字，重连后由 outbox 重放：后台重放不替人选，落「未发送 + 重发」。点「重发」再撞上同一道闸时，
  // 这条要挪回输入框、弹出同一块面板——否则「重发」只会一遍遍撞闸，提示里许诺的选择永远出不来。
  test('P0-RESUME-DIVd 离线时发的那条重连后撞闸：落「未发送」；点「重发」把它挪回输入框并弹出同一块面板', async ({ page }) => {
    await openArmedArchivedSession(page);

    await page.context().setOffline(true);
    await waitUntilDisconnected(page);
    await page.locator('#input').fill(TEXT);
    await page.locator('#btnSend').click();
    await expect(page.locator('#input')).toHaveValue('');
    await page.context().setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await waitUntilConnected(page);

    const resend = page.locator('[data-testid="outbox-resend"]');
    await expect(resend).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#confirmModal')).toBeHidden(); // 后台重放不弹面板、不替人选
    await resend.click();
    await expect(page.locator('#confirmModal')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('#input')).toHaveValue(TEXT);
    await expect(bubblesWithText(page)).toHaveCount(0); // 挪回输入框了，不留一颗挂着「未发送」的气泡

    await page.locator('#confirmAlt').click();
    await expect(bubblesWithText(page)).toHaveCount(1, { timeout: 10_000 });
    await expect(page.locator('#input')).toHaveValue('');

    await expectNoBrowserErrors(page);
  });

  // 规则 5 置换之后才拒收：终端在旧叶子下真打过一轮的那种分叉，正是在置换（dispose 旧实例 → resume 新实例）时算出来的，
  // 拒收到达前前端已收到「同一会话换了新实例」的广播。① 迟到负 ack 守卫按实例比对的话，会把它当成「已切走」：
  // 话被撤掉却不回填、面板也不出 ② 分叉要送发送那一刻的驾驶轴 cwd——旧实例已不在列表里，现算会回落到父仓，
  // 服务端按父仓找不到 worktree 的 transcript，回「会话不存在」（PR #210 Codex review P2）。
  test('P0-RESUME-DIVe 规则 5 置换后才拒收（worktree 会话）：话回到输入框、面板照出；分叉送驾驶轴 cwd 并成功', async ({ page }) => {
    await gotoMock(page);
    await ensureComposerReady(page);
    await sendChatMessage(page, 'test:arm-resume-divergence-worktree-swap');
    await openSessionsSidebar(page);
    await expandWorkspace(page, MAIN_WORKSPACE);
    await openWorkspaceSession(page, MAIN_WORKSPACE, 'Worktree Driving Session');
    await expectSidebarClosed(page);
    await expect(page.locator('#messages')).toContainText('WORKTREE_HISTORY_LOADED', { timeout: 15_000 });

    await sendChatMessage(page, TEXT);
    await expect(page.locator('#confirmModal')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('#confirmBody')).toContainText('模型会从手机那一轮接上，终端上最近 2 条消息不在它的上下文里');
    await expect(page.locator('#confirmBody')).toContainText('另一支的 2 条不在');
    await expect(page.locator('#input')).toHaveValue(TEXT);
    await expect(bubblesWithText(page)).toHaveCount(0);

    await page.locator('#confirmOk').click();
    await expect(page.locator('#messages')).toContainText('WORKTREE_FORK_READY', { timeout: 10_000 });
    await expect(page.locator('#messages')).toContainText('已分叉到新会话');
    await expect(page.locator('#input')).toHaveValue(TEXT);

    await expectNoBrowserErrors(page);
  });
});
