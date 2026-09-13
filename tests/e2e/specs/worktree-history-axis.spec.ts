// helpers: tests/helpers/playwright.ts

import { test, expect } from '@playwright/test';
import { ensureComposerReady, expectNoBrowserErrors, gotoMock, sendChatMessage, waitUntilConnected, waitUntilDisconnected } from '../../helpers/playwright';
import { MAIN_WORKSPACE, expandWorkspace, openSessionsSidebar, openWorkspaceSession } from '../../helpers/sidebar-ui';

// 会话中途 EnterWorktree 之后，两条 cwd 轴在前端分叉：
//   · currentCwd（= instances 广播的 viewingCwd）是【工作区轴】，托管 worktree 的实例归父仓，
//     因为产品判据是「worktree 是临时模式、不占抽屉条目」；
//   · instances[].cwd 是【驾驶轴】，transcript 真正落在那里。
// 拉历史要的是驾驶轴——拿工作区轴去查，真 server 的 sessionFileExists 必然 false，
// ack 回 { messages: [], error: '会话不存在' }，前端打灰行「历史消息加载失败」。
//
// 【为什么这条必须走重连而不是切入】切入走 bindView，它一直用的是 entry.cwd（驾驶轴），本来就对。
// 出问题的是 reloadCurrentFromHistory —— app.js 里那句 `loadHistory(displayedSessionId, undefined)`,
// 默认参数落到 currentCwd。它的触发路径注释原话是「锁屏/切后台冻结页面断开 socket，
// viewingInstanceId 全程不变，故不会走 bindView，只会走到这里」。
// 2026-09-13 真机形态正是如此：首次点开历史好好的，手机锁屏回来就变成「历史消息加载失败」,
// 所以用户报的是「会出现，但不是百分百」。
//
// 【为什么此前 E2E 照不出来】mock 的 viewingCwd 曾直接取实例 cwd，没有真 server 那道 workspaceCwdOf
// 归组，于是「工作区轴 ≠ 驾驶轴」这个形态根本不可达，currentCwd 恰好等于驾驶轴、怎么拉都成功。
// 补齐那道归组（mock/server.js 的 workspaceCwdOf）之后，这一格才照得出来。
test.describe('P0 日常零 token Mock UI 回归', () => {
  test('P0-WT-AXIS 断线重连后重载 worktree 会话的历史，走驾驶轴而不是工作区轴', async ({ page }) => {
    test.setTimeout(60_000); // 断线横幅 + 重连要等实际的退避窗口

    await gotoMock(page);
    await ensureComposerReady(page);

    await openSessionsSidebar(page);
    await expandWorkspace(page, MAIN_WORKSPACE);
    await openWorkspaceSession(page, MAIN_WORKSPACE, 'Worktree Driving Session');

    // 切入路径（bindView → entry.cwd）本来就是对的，先确认它确实把历史拉出来了——
    // 否则下面的重连断言会建立在一个本就空白的页面上，红绿都没有意义。
    await expect(page.locator('#messages')).toContainText('WORKTREE_HISTORY_LOADED', { timeout: 15_000 });

    // 断线 → 重连。重连后 sync:since 对 inst_worktree 回 gap，前端走 reloadCurrentFromHistory:
    // 先 clearView 清屏，再用默认 cwd 重新拉历史。修复前那个默认值是 currentCwd（父仓）。
    await sendChatMessage(page, 'test:disconnect-now');
    await waitUntilDisconnected(page);
    // 服务端主动 disconnect(true) 不会自动重连，走横幅的「立即重试」（同 connection-banner.spec.ts）。
    // 那颗按钮要断开满 5s 才露——短暂抖动不打扰用户，所以这里的等待窗口必须宽于它。
    await page.locator('[data-testid="conn-banner-retry"]').click({ timeout: 20_000 });
    await waitUntilConnected(page, 30_000);

    // 核心断言：清屏重载之后历史必须回来。修复前这里是空白 + 一行「历史消息加载失败」。
    await expect(page.locator('#messages')).toContainText('WORKTREE_HISTORY_LOADED', { timeout: 20_000 });
    await expect(page.locator('#messages')).not.toContainText('历史消息加载失败');

    await expectNoBrowserErrors(page);
  });
});
