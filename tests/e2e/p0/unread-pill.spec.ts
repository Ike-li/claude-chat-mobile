// spec: docs/testing.md
// helpers: tests/helpers/playwright.ts

import { test, expect, type Page, type Locator } from '@playwright/test';
import { expectNoBrowserErrors, gotoMock, sendChatMessage, waitForIdle } from '../../helpers/playwright';
import { ANOTHER_WORKSPACE, MAIN_WORKSPACE, expectSidebarClosed, openWorkspaceSession, openSessionsSidebar } from '../../helpers/p0-ui';

// P0-24d/e：未读胶囊第三条自动确认已读路径——用户手动滚动贴近底部（与既有「点击胶囊」「Intersection
// Observer 扫到锚点」并存，见 app.js showUnreadPillIfAny/ackUnread）。核心难点：切入积压未读的会话时，
// 回放缓冲（P0-REPLAY-BUFFER，见 replay-buffer.spec.ts）落底是"程序性"的 scrollBottom(true)，不代表
// 用户已经看到了胶囊——必须被 app.js 的 programmaticScrollUntil 窗口排除，只有窗口过后的真实用户滚动
// 才应该清除胶囊。下面两个断言其一断言"协同不误清"，其一断言"机制本身确实有效"。

// 断言"服务端收到 user:ackUnread"：直接抓 socket.io 出向 WebSocket 帧（Playwright 原生 API，不需要
// mock/前端任何额外配合）。socket.io v4 文本帧形如 42["user:ackUnread",{"instanceId":"..."}]（Engine.IO
// "4"=message + Socket.IO "2"=EVENT + JSON 数组），子串匹配即可，不必解析完整协议。监听器必须在
// gotoMock（页面导航、socket 连接建立）之前挂上，否则会错过这条连接的 websocket 对象——同 gotoMock
// 内部 captureBrowserErrors 必须先于 page.goto 的道理一致。
function captureAckUnreadFrames(page: Page) {
  const frames: string[] = [];
  page.on('websocket', ws => {
    ws.on('framesent', frame => {
      if (typeof frame.payload === 'string' && frame.payload.includes('user:ackUnread')) frames.push(frame.payload);
    });
  });
  return frames;
}

// 真实触发浏览器原生 scroll 事件（而非只改 DOM 属性不派发事件）：先小幅向上滚一点（保证 scrollTop
// 确实变化过一次），再大幅向下滚回底部——滚动量刻意远超实际可滚范围，浏览器会自动 clamp 到底部，
// 不需要精确计算内容高度。
async function wheelScrollToBottom(page: Page) {
  await page.locator('#messages').hover();
  await page.mouse.wheel(0, -80);
  await page.mouse.wheel(0, 1600);
}

// app.js 的程序性滚动窗口（PROGRAMMATIC_SCROLL_WINDOW_MS=400ms）可能仍覆盖第一次手动滚动尝试——用
// expect.poll 反复触发真实滚动手势，直到某次尝试落在窗口之外真正生效。比固定等待更贴近真实体感
// （用户滚了几下才发现胶囊消失），也避免了本项目 npm run check 明确禁止的 waitForTimeout。
async function scrollUntilPillHidden(page: Page, pill: Locator) {
  await expect.poll(async () => {
    await wheelScrollToBottom(page);
    return pill.isHidden();
  }, { timeout: 5_000, intervals: [100] }).toBe(true);
}

test.describe('P0 日常零 token Mock UI 回归', () => {
  test('P0-24 未读角标：切回会话展示未读数，点击跳转到锚点并高亮，随后自动消失', async ({ page }) => {
    await gotoMock(page);

    // test:tab：先把 inst_2 注册进 mockInstances（同 P0-14 系列的既有两步套路）——不然
    // test:unread-pill 直接切 viewingInstanceId 到一个尚不存在的实例，bindView 会落到空首页分支。
    await sendChatMessage(page, 'test:tab');
    await waitForIdle(page);
    // test:unread-pill：mock 切到 inst_2，sync:since ack 带 unreadOnEntry=1（该会话固定回放 2 条顶层
    // 气泡：user_message + text_delta 各一条，unreadOnEntry=1 应指向最后一条即 assistant 回复）。
    await sendChatMessage(page, 'test:unread-pill');

    const pill = page.locator('#unreadPill');
    await expect(pill).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#unreadPillCount')).toHaveText('1');

    const anchor = page.locator('[data-testid="assistant-message"]').last();
    await expect(anchor).toContainText('This is the concurrent session');

    // 仿微信"以下为新消息"分割线：插在锚点前，随高亮同一节奏出现/消失，不进入 sessionDomCache
    // （data-ephemeral="1"，同 streamLiveStatus 的既有排除机制）。
    const divider = page.locator('#unreadDivider');
    await expect(divider).toBeHidden();

    await pill.click();

    await expect(pill).toBeHidden();
    await expect(anchor).toHaveClass(/unread-anchor-flash/);
    await expect(divider).toBeVisible();
    await expect(divider).toContainText('以下为新消息');
    // 分割线须在锚点之前（DOM 顺序），不是随便扔在消息区某处
    const order = await page.evaluate(() => {
      const d = document.querySelector('#unreadDivider');
      const a = document.querySelector('[data-testid="assistant-message"]:last-of-type');
      if (!d || !a) return null;
      return d.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING ? 'divider-before-anchor' : 'other';
    });
    expect(order).toBe('divider-before-anchor');

    await expect(divider).toBeHidden({ timeout: 3_000 }); // 与 flash 同 2s 生命周期后自动移除

    await expectNoBrowserErrors(page);
  });

  // 陷阱记录（排查耗时较长，完整记录避免下次重踩）：分割线自带 2s 自毁计时器（跟随最初创建它的
  // DOM 节点对象，不因该节点被 sessionDomCache 缓存/appendChild 挪动位置而失效）——这意味着"缓存
  // 恢复路径最终 DOM 上还有没有它"这个信号在 2s 内外都会被计时器兜底清空，无法用来判断
  // "有没有被正确排除出缓存"。用 Element.prototype.remove 打点 + 用户可见 DOM 快照实测过：
  // 即便 stripEphemeralMessageNodes 完全没有过滤掉它（即 bug 复现），appendChild 恢复后它确实
  // 存在于 DOM（page.evaluate 同步查询能立即看到），但只要整个切走再切回流程在 2s 内完成，原计时器
  // 依然会准时把它清掉，让"最终 toHaveCount(0)"断言在有 bug 和无 bug 两种情况下都通过——不是
  // 等待时机不够，是这个断言本身选错了要观察的信号。
  // 真正能定位"是否被正确排除出缓存"的时刻，是"切回后、计时器触发前"那个短暂窗口——分割线要么
  // 从未被恢复（修复生效），要么被恢复后短暂可见、2s 后才被计时器清掉（修复失效）。故断言必须在
  // 缓存恢复完成后立即同步检查，不能给计时器窗口留出可乘之机。
  test('P0-24b 分割线不进入 sessionDomCache：切走再切回不残留', async ({ page }) => {
    await gotoMock(page);
    await sendChatMessage(page, 'test:tab');
    await waitForIdle(page);
    await sendChatMessage(page, 'test:unread-pill'); // 切到 inst_2（ANOTHER_WORKSPACE），前端跟随 viewingInstanceId

    const pill = page.locator('#unreadPill');
    await expect(pill).toBeVisible({ timeout: 10_000 });
    await pill.click();
    await expect(page.locator('#unreadDivider')).toBeVisible();

    // 切到主工作区（触发 sessionDomCache.set 缓存 inst_2 当前 DOM，此刻分割线仍在树上）
    await openSessionsSidebar(page);
    await openWorkspaceSession(page, MAIN_WORKSPACE, 'Visual Sandbox (Main)');
    await expectSidebarClosed(page);

    // 切回 inst_2（命中 sessionDomCache 缓存恢复路径）
    await openSessionsSidebar(page);
    await openWorkspaceSession(page, ANOTHER_WORKSPACE, 'Another App Concurrency');
    await expectSidebarClosed(page);
    // 确认缓存恢复真正落地（消息内容已是 inst_2 的），而不是还没跑到 bindView
    await expect(page.locator('[data-testid="assistant-message"]').last()).toContainText('This is the concurrent session');

    // 决定性断言：必须用一次性同步查询（locator.count()，不自动重试），不能用 expect(locator).toHaveCount()
    // 或 expect.poll()——这两者的默认轮询窗口（本项目 playwright.config.ts expect.timeout=8000ms）
    // 远超 2s 清理计时器的生命周期，无论有没有 bug，轮询早晚都会等到"计时器把它清掉"这个状态而判定
    // 通过，让断言形同虚设。toContainText 已确认 bindView 的同步恢复流程（含 appendChild 缓存节点）
    // 已经跑完，此刻查一次即代表真相，不需要再等。
    const dividerCountAfterRestore = await page.locator('#unreadDivider').count();
    expect(dividerCountAfterRestore, '缓存恢复后不应观察到分割线复活（即便随后 2s 计时器会清掉它）').toBe(0);

    await expectNoBrowserErrors(page);
  });

  // PWA 应用图标角标（Badging API）：navigator.setAppBadge/clearAppBadge 在非安装态的无头 Chromium 里
  // 通常不存在，直接 stub 成 spy（同 long-history-render.spec.ts 的 window 属性注入套路）。
  // 挂点：showUnreadPillIfAny 显示胶囊时调 setAppBadgeSafe(count)；ackUnread（点胶囊触发 jumpToUnreadAnchor
  // → ackUnread）调 clearAppBadgeSafe()。两者都是 optional-chaining 包装，stub 缺失也不会抛错，
  // 这里验证的是"确实被调用"，不是"平台支持"。
  test('P0-24c PWA 应用图标角标：未读胶囊显示时 setAppBadge(count)，确认已读时 clearAppBadge', async ({ page }) => {
    await gotoMock(page);

    await page.evaluate(() => {
      const w = window as unknown as { __badgeCalls: string[] };
      w.__badgeCalls = [];
      (navigator as unknown as { setAppBadge: (n?: number) => Promise<void> }).setAppBadge = (n?: number) => {
        w.__badgeCalls.push(`set:${n}`);
        return Promise.resolve();
      };
      (navigator as unknown as { clearAppBadge: () => Promise<void> }).clearAppBadge = () => {
        w.__badgeCalls.push('clear');
        return Promise.resolve();
      };
    });

    await sendChatMessage(page, 'test:tab');
    await waitForIdle(page);
    await sendChatMessage(page, 'test:unread-pill'); // 同 P0-24：inst_2 有 1 条未读

    const pill = page.locator('#unreadPill');
    await expect(pill).toBeVisible({ timeout: 10_000 });

    const callsAfterShow = await page.evaluate(() => (window as unknown as { __badgeCalls: string[] }).__badgeCalls);
    expect(callsAfterShow).toContain('set:1');
    expect(callsAfterShow).not.toContain('clear');

    await pill.click(); // → jumpToUnreadAnchor → ackUnread
    await expect(pill).toBeHidden();

    const callsAfterAck = await page.evaluate(() => (window as unknown as { __badgeCalls: string[] }).__badgeCalls);
    expect(callsAfterAck).toContain('clear');

    await expectNoBrowserErrors(page);
  });

  test('P0-24d 未读胶囊第三条自动确认已读路径：用户手动滚动到底部即清除，服务端收到 user:ackUnread', async ({ page }) => {
    const ackFrames = captureAckUnreadFrames(page); // 必须先于 gotoMock 挂上（见函数注释）
    await gotoMock(page);

    // test:replay-buffer-unread-setup + 两次切入 inst_replay_unread：第一次冷入场建 DOM 缓存（4 条
    // 基线），切到主工作区再切回触发第二次 sync:since——flush 21 条积压事件 + unreadOnEntry=3，
    // 内容足够撑出可滚动高度（不像 inst_2 的 2 条消息那么短，真实滚动手势需要有内容可滚）。
    await sendChatMessage(page, 'test:replay-buffer-unread-setup');
    await openSessionsSidebar(page);
    await openWorkspaceSession(page, ANOTHER_WORKSPACE, 'Replay Unread Session');
    await expectSidebarClosed(page);
    await openSessionsSidebar(page);
    await openWorkspaceSession(page, MAIN_WORKSPACE, 'Visual Sandbox (Main)');
    await expectSidebarClosed(page);
    await openSessionsSidebar(page);
    await openWorkspaceSession(page, ANOTHER_WORKSPACE, 'Replay Unread Session');
    await expectSidebarClosed(page);

    const pill = page.locator('#unreadPill');
    await expect(pill).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#unreadPillCount')).toHaveText('3');

    await scrollUntilPillHidden(page, pill);

    expect(ackFrames.some(f => f.includes('inst_replay_unread'))).toBe(true);

    await expectNoBrowserErrors(page);
  });

  // 协同场景（重点）：证明"程序性落底"（回放缓冲切入积压会话时 scrollBottom(true)）不会被误判成
  // "用户已经看到了"。若 app.js 的 programmaticScrollUntil 窗口失效/被移除，胶囊会在落地瞬间就被
  // 这次程序性滚动自己触发的 scroll 事件误清掉——下面「落地后仍可见」这条断言就是专门抓这个回归的。
  test('P0-24e 协同场景：回放缓冲程序性落底不误清未读胶囊，仅用户真实滚动到底部才清除', async ({ page }) => {
    const ackFrames = captureAckUnreadFrames(page);
    await gotoMock(page);

    await sendChatMessage(page, 'test:replay-buffer-unread-setup');
    await openSessionsSidebar(page);
    await openWorkspaceSession(page, ANOTHER_WORKSPACE, 'Replay Unread Session');
    await expectSidebarClosed(page);
    await openSessionsSidebar(page);
    await openWorkspaceSession(page, MAIN_WORKSPACE, 'Visual Sandbox (Main)');
    await expectSidebarClosed(page);

    // 第二次切回：mock 这次会先 emit 21 条 replay:true 事件（flush 路径）再 ack(21, {unreadOnEntry:3})。
    // 客户端应：flush 完抑制中间滚动 + 收尾一次 scrollBottom(true) 程序性落底 → 显示胶囊。
    await openSessionsSidebar(page);
    await openWorkspaceSession(page, ANOTHER_WORKSPACE, 'Replay Unread Session');
    await expectSidebarClosed(page);

    const pill = page.locator('#unreadPill');
    await expect(pill).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#unreadPillCount')).toHaveText('3');

    // 核心断言：落地后（此刻程序性落底大概率刚发生或即将发生）胶囊必须仍然可见——不能被程序性滚动
    // 自己触发的 scroll 事件误判成"用户已经看到了"而提前清掉。必须用一次性同步检查（isVisible），
    // 不能用 expect().toBeVisible()——后者默认会重试数秒，可能掩盖"曾短暂被误清又恢复"的闪烁回归。
    expect(await pill.isVisible()).toBe(true);
    expect(await page.locator('#unreadPillCount').textContent()).toBe('3');

    // 确实落底到最新消息（沿用 replay-buffer.spec.ts 已验证的判定方式）——证明上面"仍可见"不是因为
    // 程序性落底根本没发生，而是发生了但被正确排除在外。
    await expect.poll(() => page.evaluate(() => {
      const el = document.querySelector('#messages') as HTMLElement;
      return el.scrollHeight - el.scrollTop - el.clientHeight;
    }), { timeout: 10_000 }).toBeLessThan(120);

    // 随后模拟一次真实的用户滚动：只有这次（且落在程序性窗口之外）才应该清除胶囊。
    await scrollUntilPillHidden(page, pill);
    expect(ackFrames.some(f => f.includes('inst_replay_unread'))).toBe(true);

    await expectNoBrowserErrors(page);
  });
});
