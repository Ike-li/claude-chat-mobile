// helpers: tests/helpers/playwright.ts

import { test, expect } from '@playwright/test';
import { ensureComposerReady, expectNoBrowserErrors, gotoMock, sendChatMessage } from '../../helpers/playwright';
import { MAIN_WORKSPACE, expandWorkspace, openSessionsSidebar, openWorkspaceSession } from '../../helpers/p0-ui';

// bindView 的 sync:since 曾用裸 ack（F3/2026-08-06）：断线时回调被 socket.io-client 的 _clearAcks()
// 删掉且【不调用】——loadHistory 在同文件为此专门改用 socket.timeout 并写明禁令，但 bindView 与
// requestSync 两处没跟上。回调一丢，hideLoadingCard / loadHistory / applyPendingSnapshot 全部蒸发：
// 加载卡永转、历史永不出现；且首次进入页面期间断线连 connect 补传都没有（initialLoad 尚未翻转）。
// 修复后：sync:since 带 15s 超时，err 分支转拉磁盘历史（loadHistory 自带超时与 err 清理），
// 连接还活着时历史照常落地、加载卡收场。
//
// 【为什么必须真等 15s】同 history-ack-timeout.spec.ts：用断线加速会触发重连 + 全量历史加载，
// 历史会从别的路径回到页面上，用例就假绿了。要锁的恰恰是「ack 蒸发、连接未断」这一格。
test.describe('P0 日常零 token Mock UI 回归', () => {
  test('P0-SYNC-ACK-TIMEOUT sync:since ack 超时后必须转拉磁盘历史，而非加载卡永转', async ({ page }) => {
    test.setTimeout(60_000); // 前端 SYNC_ACK_TIMEOUT_MS = 15s，压不下去，理由见上
    await gotoMock(page);
    await ensureComposerReady(page);
    await sendChatMessage(page, 'test:arm-sync-ack-timeout');

    await openSessionsSidebar(page);
    await expandWorkspace(page, MAIN_WORKSPACE);
    await openWorkspaceSession(page, MAIN_WORKSPACE, 'Timeline Session');

    // 核心断言：sync ack 被 mock 吞掉，历史只能经 err 分支的 loadHistory 兜底落地。
    // 修复前这个回调根本不存在执行时机——页面停在加载卡上直到用户手动刷新。
    await expect(page.locator('#messages')).toContainText('Timeline today follow-up', { timeout: 30_000 });
    // 加载卡必须收场（修复前永转）
    await expect(page.locator('#historyLoadingCard')).toHaveCount(0);

    await expectNoBrowserErrors(page);
  });
});
