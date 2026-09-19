// helpers: tests/helpers/playwright.ts

import { test, expect } from '@playwright/test';
import { ensureComposerReady, expectNoBrowserErrors, gotoMock, sendChatMessage, waitForIdle } from '../../helpers/playwright';
import { MAIN_WORKSPACE, openSessionsSidebar, openWorkspaceSession, startNewSessionInWorkspace } from '../../helpers/sidebar-ui';

test.describe('P0 日常零 token Mock UI 回归', () => {
  test('P0-12 新会话首发 busy 连续性与不闪回首页', async ({ page }) => {
    await gotoMock(page);

    // 1. 新会话首发后 busy 不被懒开广播冲掉。
    await page.locator('#btnNew').click();
    await expect(page.locator('#messages')).toHaveClass(/empty-start/);
    await sendChatMessage(page, 'test:freshbusy');
    await expect(page.locator('#streamLiveStatus')).toBeVisible();
    await expect(page.locator('#btnSend')).toHaveAttribute('data-mode', 'stop');
    await expect(page.locator('#messages')).not.toHaveClass(/empty-start/);
    await expect(page.locator('[data-testid="assistant-message"]').last()).toContainText('新会话首发回复', { timeout: 10_000 });
    await waitForIdle(page);

    await expectNoBrowserErrors(page);
  });

  // 新会话首发的乐观气泡必须活过懒开清屏（2026-08-27，修「发出去的消息消失」）。
  // 新会话比"已有会话"多一道坎：服务端懒开实例后会 broadcastInstances，viewingInstanceId 由 null 变成
  // 新实例 → 前端 setInstances 判定视图变了 → bindView → clearView 清空 #messages。乐观气泡若挺不过
  // 这次清屏，就会「出现一下又消失、等服务端回显才回来」——正是真机反馈里的"闪烁一下才出现"。
  // 走 test:slow-echo：mock 先懒开广播、再延迟 2s 回显，把清屏与回显之间那段窗口撑开到可断言。
  test('P0-12c 新会话首发的乐观气泡活过懒开清屏，且不与回显重复', async ({ page }) => {
    await gotoMock(page);
    await page.locator('#btnNew').click();
    await expect(page.locator('#messages')).toHaveClass(/empty-start/);

    // 「闪烁」= 气泡出现过、又消失、再回来。光靠事后断言"最终有一条"抓不到它（修复前最终也有一条，
    // 只是中间空了 2 秒）。这里挂一个 MutationObserver 记录【首次出现之后】的最小气泡数：
    // 掉到 0 就说明它中途消失过。零 sleep、纯事件驱动，不依赖任何猜测的时间点。
    // 注意这个判据同时天然正确地放过"同步清屏 + 同步恢复"——同一个同步块内的中间态浏览器不会重绘，
    // MutationObserver 的回调也排在其后，用户根本看不见。看不见的消失不算消失。
    await page.evaluate(() => {
      const w = window as unknown as { __seenBubble: boolean; __minAfterFirst: number };
      w.__seenBubble = false;
      w.__minAfterFirst = Infinity;
      const box = document.getElementById('messages')!;
      const sample = () => {
        const n = box.querySelectorAll('[data-testid="user-message"]').length;
        if (n > 0) w.__seenBubble = true;
        if (w.__seenBubble && n < w.__minAfterFirst) w.__minAfterFirst = n;
      };
      new MutationObserver(sample).observe(box, { childList: true, subtree: true });
      sample();
    });

    await page.locator('#input').fill('test:slow-echo');
    await page.locator('#btnSend').click();

    // 懒开广播已到达（离开空表面），但服务端回显还在 2s 延迟里——这中间气泡必须一直在。
    await expect(page.locator('#messages')).not.toHaveClass(/empty-start/);
    const bubbles = page.locator('[data-testid="user-message"]');
    await expect(bubbles).toHaveCount(1, { timeout: 800 });
    await expect(bubbles.last()).toContainText('test:slow-echo');
    await expect(bubbles.last()).toHaveClass(/opacity-70/);

    // 回显到达 → 原地转正，仍是一条
    await expect(bubbles.last()).not.toHaveClass(/opacity-70/, { timeout: 10_000 });
    await expect(bubbles).toHaveCount(1);

    // 核心：整段窗口里气泡一次都没消失过（修复前这里是 0——被懒开广播的 clearView 冲掉了）
    const minAfterFirst = await page.evaluate(
      () => (window as unknown as { __minAfterFirst: number }).__minAfterFirst);
    expect(minAfterFirst).toBeGreaterThanOrEqual(1);

    await expectNoBrowserErrors(page);
  });

  // P0-12f（2026-09-18）：显式新建之后，一条【在 session:new 之前就在途、之后才到】的 instances 包
  // 不得把刚放弃的会话 id 填回来——否则紧随其后的权威包会让 bindView 拿「prev=旧会话 / new=null」
  // 走草稿交换，把用户【在新会话页正打的字】存进旧会话的草稿缓存，再用空串覆盖输入框。
  //
  // 守的是 app.js 里 FE-001 分支上 `!sessionIdClearedByNav` 那道守卫。此前它在整套 E2E 里【不可达】：
  // mock 的 session:new 只发一条 viewingInstanceId=null 的权威包，从不产出那种在途旧包，于是撤掉守卫
  // 测试照样全绿（2026-09-18 实测过三版用例，重填一次都没触发，全部删掉）。
  // test:stale-instances-on-new 把这条时序撑开：武装后 mock 延迟 900ms 才依次发
  // 【在途旧包 → 权威包 → 送达锚点】。
  test('P0-12f 新建后到达的在途旧 instances 包，不得把正在打的字清掉', async ({ page }) => {
    await gotoMock(page);
    // 前提：此刻确实在一个【有 sessionId】的会话里（inst_1 / mock-session-visual-test）。
    // 旧包里没有可重填的 sessionId 的话，FE-001 的 `if (target?.sessionId)` 早退，这条用例就测了个空。
    await sendChatMessage(page, 'test:stale-instances-on-new');
    await waitForIdle(page);

    await page.locator('#btnNew').click();
    await expect(page.locator('#messages')).toHaveClass(/empty-start/);

    // 在新会话页打字——必须发生在那两条包到达【之前】，那才是缺陷窗口的形状。
    const draft = '在新会话页正打到一半的字';
    await page.locator('#input').fill(draft);
    await expect(page.locator('#input')).toHaveValue(draft);

    // 【这条是防假绿的】若 mock 那批包抢在 fill 之前就到了，缺陷窗口根本没被撑开，用例会以
    // 「输入框有字」假绿收场。此处要求送达锚点【尚未】上屏：真抢跑了它就红在这一行，而不是蒙混过关。
    await expect(page.locator('#cliStatus')).not.toContainText('stale-probe-settled');

    // 等送达锚点：socket.io 同一连接保序，它上屏即证明在途旧包与权威包都已被前端处理完。
    await expect(page.locator('#cliStatus')).toContainText('stale-probe-settled', { timeout: 10_000 });

    // 核心：字还在，发送键仍可用。修复前这里是空串——被 bindView 的草稿交换覆盖掉了。
    await expect(page.locator('#input')).toHaveValue(draft);
    await expect(page.locator('#btnSend')).toBeEnabled();

    await expectNoBrowserErrors(page);
  });

  // P0-12g：同一条守卫的【第二个设置点】——目录行的 ＋（app.js 约 6507），它不经过 #btnNew。
  // 两处代码逐字相同，而历史上正是只修了 btnNew 那一处、目录行 ＋ 照旧红（P0-11h 逼出来的）。
  // 只测 btnNew 的话，「有人删掉目录行 ＋ 那处的 sessionIdClearedByNav = true」不会被任何用例发现。
  test('P0-12g 目录行 ＋ 新建后到达的在途旧包，同样不得把正在打的字清掉', async ({ page }) => {
    await gotoMock(page);
    await sendChatMessage(page, 'test:stale-instances-on-new');
    await waitForIdle(page);

    // 点【当前工作区】那一行的 ＋：cwd 不变，于是与上一条用例的差别只剩「走哪个入口」这一个变量。
    await openSessionsSidebar(page);
    await startNewSessionInWorkspace(page, MAIN_WORKSPACE);
    await expect(page.locator('#messages')).toHaveClass(/empty-start/);

    const draft = '从目录行 ＋ 进来打的字';
    await page.locator('#input').fill(draft);
    await expect(page.locator('#input')).toHaveValue(draft);

    await expect(page.locator('#cliStatus')).not.toContainText('stale-probe-settled');
    await expect(page.locator('#cliStatus')).toContainText('stale-probe-settled', { timeout: 10_000 });

    await expect(page.locator('#input')).toHaveValue(draft);
    await expect(page.locator('#btnSend')).toBeEnabled();

    await expectNoBrowserErrors(page);
  });

  // P0-12h（2026-09-19 用户报告）：「新会话已就绪」页上打到一半的字，切去别的会话再回来就没了。
  // 根因不在 keep/swap 判据，而在草稿缓存的 key 只认 sessionId——新会话在首发之前没有 sessionId，
  // 于是 save 恒为 null：那段字从来没有被存过，回来时也没有任何 key 能取回。修法见 draftKeyFor
  // （退回 `new:<cwd>`）。
  //
  // 【为什么纯函数单测不够】这条路径要三处接线同时对上才成立：bindView 传的 prevCwd 必须来自
  // displayedCwd（currentCwd 在 setInstances 里早于 bindView 就被改成【新】cwd 了，用它等于自比自）、
  // 目录行 ＋ 传的 newCwd、以及 applySessionDraftSwap 真的把 plan.save 写进那个 Map。
  // 任意一处漏传，planSessionDraftSwap 的用例照样全绿。
  test('P0-12h 新会话页的草稿切走再回来仍在，原地再按一次 ＋ 才清空', async ({ page }) => {
    await gotoMock(page);

    await openSessionsSidebar(page);
    await startNewSessionInWorkspace(page, MAIN_WORKSPACE);
    await expect(page.locator('#messages')).toHaveClass(/empty-start/);

    const draft = '还没发出去的新会话指令';
    await page.locator('#input').fill(draft);
    await expect(page.locator('#input')).toHaveValue(draft);

    // 切到本工作区里的另一个会话：草稿必须被收走，不许串到那条会话里去（同 P0-11q）。
    // 这一行同时是防假绿的——切换若根本没发生，输入框不会被清空，后面「字还在」就成了空转。
    await openSessionsSidebar(page);
    await openWorkspaceSession(page, MAIN_WORKSPACE, 'Visual Sandbox (Main)');
    await expect(page.locator('#messages')).not.toHaveClass(/empty-start/);
    await expect(page.locator('#input')).toHaveValue('');

    // 回到原工作区的新会话页：字要原样回来。修复前这里是空串。
    await openSessionsSidebar(page);
    await startNewSessionInWorkspace(page, MAIN_WORKSPACE);
    await expect(page.locator('#messages')).toHaveClass(/empty-start/);
    await expect(page.locator('#input')).toHaveValue(draft);
    await expect(page.locator('#btnSend')).toBeEnabled();

    // 反向对照（PR #89 review P1-a 仍然成立）：已经站在这一页上还按「新建」＝要求重来，必须给空白。
    // 少了这一段，把「forceSwap 一律恢复目标槽」写成实现也能让上面几行全绿。
    await openSessionsSidebar(page);
    await startNewSessionInWorkspace(page, MAIN_WORKSPACE);
    await expect(page.locator('#input')).toHaveValue('');

    await expectNoBrowserErrors(page);
  });

  // 全新会话首轮点停止后不跳回主页：sessionId 尚未由 SDK init 返回（本例全程 sessionId 恒 null）时
  // 点"停止"，界面应留在聊天视图（用户消息气泡 + 中断提示可见，输入条可用），不应回落 home/compose
  // 空表面；随后应能正常再发一条消息并收到回复。
  test('P0-13 全新会话首轮点停止后不跳回主页', async ({ page }) => {
    await gotoMock(page);

    await page.locator('#btnNew').click();
    await expect(page.locator('#messages')).toHaveClass(/empty-start/);
    await sendChatMessage(page, 'test:fresh-interrupt');
    await expect(page.locator('#btnSend')).toHaveAttribute('data-mode', 'stop');
    // bindView 已处理懒开广播（离开空表面）——此刻 sessionId 仍未知，正是本任务要修的窗口。
    await expect(page.locator('#messages')).not.toHaveClass(/empty-start/);

    await page.locator('#btnSend[data-mode="stop"]').click();
    await waitForIdle(page);

    // 核心断言：不应跳回 home/compose 空表面。
    await expect(page.locator('[data-testid="home-dashboard"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="compose-surface"]')).toHaveCount(0);
    await expect(page.locator('#messages')).not.toHaveClass(/empty-start/);
    await expect(page.locator('#messages')).toContainText('已中断');
    await expect(page.locator('[data-testid="user-message"]').last()).toContainText('test:fresh-interrupt');
    await expect(page.locator('#input')).toBeVisible();
    await expect(page.locator('#input')).toBeEditable();

    // composer 真正可用：还能正常再发一条消息并收到回复（同一实例可续用）——
    // sendChatMessage 内部会先断言填字后 #btnSend 可点，比空输入时检查 enabled 更能说明问题。
    await sendChatMessage(page, 'test:tool');
    await waitForIdle(page);
    await expect(page.locator('[data-testid="assistant-message"]').last()).toContainText('All tools executed cleanly');

    await expectNoBrowserErrors(page);
  });
});
