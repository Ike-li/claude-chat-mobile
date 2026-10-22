// helpers: tests/helpers/playwright.ts

import { test, expect, type Page } from '@playwright/test';
import { captureUserMessages, closeSettings, ensureComposerReady, expectNoBrowserErrors, gotoMock, openSettingsSection, sendChatMessage, waitForIdle, waitUntilConnected, waitUntilDisconnected } from '../../helpers/playwright';
import { MAIN_WORKSPACE, expandWorkspace, expectSidebarClosed, openSessionsSidebar, openWorkspaceSession } from '../../helpers/sidebar-ui';

test.describe('P0 日常零 token Mock UI 回归', () => {
  test('P0-02 输入框、发送按钮与空输入边界', async ({ page }) => {
    await gotoMock(page);
    await ensureComposerReady(page);

    // 1. 起始状态/假设：fresh state，已连接，输入框为空。
    // Composer C：空闲且无内容时发送钮整颗隐藏（shouldHideComposerSendButton），避免「点了没反应」——
    // 所以这里不再点它（隐藏元素连 force click 都点不动），只断言它不可点且不可见，空态不产生任何消息。
    await expect(page.locator('#btnSend')).toBeDisabled();
    await expect(page.locator('#btnSend')).toBeHidden();
    await expect(page.locator('[data-testid="user-message"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="assistant-message"]')).toHaveCount(0);

    // 2. 在输入框输入普通文本 hello。
    await page.locator('#input').fill('hello');
    await expect(page.locator('#btnSend')).toBeEnabled();
    // UI-002：激活态品牌 cta 底白箭头
    await expect(page.locator('#btnSend')).toHaveClass(/bg-cta/);
    await expect(page.locator('#btnSend')).toHaveClass(/text-white/);
    await expect(page.locator('#input')).toHaveValue('hello');

    // 3. 清空输入框。
    await page.locator('#input').fill('');
    await expect(page.locator('#btnSend')).toBeDisabled();
    await expect(page.locator('#btnSend')).toHaveClass(/opacity-60/);
    await expect(page.locator('[data-testid="user-message"]')).toHaveCount(0);

    await expectNoBrowserErrors(page);
  });

  test('P0-02b 触屏 Enter 只换行不发送，按钮仍会发送有效文本', async ({ page }) => {
    await gotoMock(page);
    await ensureComposerReady(page);

    await page.locator('#input').press('Enter');
    await page.locator('#input').fill('   ');
    await expect(page.locator('#btnSend')).toBeDisabled();
    await page.locator('#input').press('Enter');
    await expect(page.locator('[data-testid="user-message"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="assistant-message"]')).toHaveCount(0);

    await page.locator('#input').fill('keyboard hello');
    await expect(page.locator('#btnSend')).toBeEnabled();
    await page.locator('#input').press('Enter');
    await expect(page.locator('#input')).toHaveValue('keyboard hello\n');
    await expect(page.locator('[data-testid="user-message"]')).toHaveCount(0);
    await page.locator('#btnSend').click();
    await expect(page.locator('[data-testid="user-message"]').last()).toContainText('keyboard hello');
    await expect(page.locator('#input')).toHaveValue('');
    // 发送后输入空 + busy：主钮 morph 为停止（普通文本 mock 未必立刻 result，不强制 waitForIdle）
    await expect(page.locator('#btnSend')).toHaveAttribute('data-mode', 'stop');
    await expect(page.locator('#btnSend')).toBeEnabled();
    await expect(page.locator('#btnSend')).toHaveAttribute('aria-label', '停止');

    await expectNoBrowserErrors(page);
  });

  // 排队已移除（2026-07-30）：在途轮期间不收新消息。输入框仍可打字存草稿，主按钮恒为停止钮，
  // placeholder 说明为什么发不出去（唯一提示点，不再另起一行小字）；轮次结束后自动解锁，草稿原样还在、可直接发出。
  test('P0-02c 任务运行中保留草稿、禁止发送并由 placeholder 提示', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:turn-running');
    await expect(page.locator('#btnSend')).toHaveAttribute('data-mode', 'stop');
    await expect(page.locator('#input')).toHaveAttribute('placeholder', /运行中/);
    // 同一句话只说一次：composer 上方不再有重复的小字提示行
    await expect(page.locator('[data-testid="composer-busy-hint"]')).toHaveCount(0);

    // 输入框仍可打字（草稿能力保留），但主按钮不变回发送——运行中发不出去
    await page.locator('#input').fill('message after the turn finishes');
    await expect(page.locator('#input')).toHaveValue('message after the turn finishes');
    await expect(page.locator('#btnSend')).toHaveAttribute('data-mode', 'stop');

    // 轮次结束 → placeholder 回到空闲文案、主按钮回到发送态，草稿原样保留
    await expect(page.locator('#input')).toHaveAttribute('placeholder', '给 Claude 发消息...', { timeout: 10_000 });
    await expect(page.locator('#btnSend')).toHaveAttribute('data-mode', 'send');
    await expect(page.locator('#btnSend')).toBeEnabled();
    await expect(page.locator('#input')).toHaveValue('message after the turn finishes');
    await page.locator('#btnSend').click();
    await expect(page.locator('[data-testid="user-message"]').last()).toContainText('message after the turn finishes');
    await expect(page.locator('#input')).toHaveValue('');

    await expectNoBrowserErrors(page);
  });

  test('P0-02d 断线时消息进入离线队列并在重连后发送', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:disconnect-now');
    await waitUntilDisconnected(page);

    await page.locator('#input').fill('test:settings-echo');
    await expect(page.locator('#btnSend')).toBeEnabled();
    await page.locator('#btnSend').click();
    await expect(page.locator('.pending-indicator').last()).toContainText('正在等待连接');
    await expect(page.locator('#input')).toHaveValue('');

    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await waitUntilConnected(page);
    await waitForIdle(page);
    await expect(page.locator('[data-testid="assistant-message"]').last()).toContainText('设置回显：model=');
    // 验收 O65：重发完了「正在重发离线发送队列中的 1 条消息…」还一直挂着
    await expect(page.locator('#messages'), '重发已经结束，进行中的横幅要撤掉').not.toContainText('正在重发离线发送队列');

    await expectNoBrowserErrors(page);
  });

  // MSG-02：离线队列里的实例句柄活得比 server 进程久，重启后可能撞上同号的另一个会话。重放要带上入队时
  // 那个实例跑的会话，服务端据此核对（核对本身在 tests/invariants/server/instance-identity.test.mjs）。
  // 两个入队点都得带：离线时发的、在线发出去没被确认转进重发的。mock 是平行实现、不做这道核对，这里只钉前端送出去的是什么。
  test('P0-02d2 离线时发的消息，重放带上入队时那个会话（MSG-02）', async ({ page }) => {
    const sent = captureUserMessages(page);
    await gotoMock(page);
    await waitForIdle(page);
    await sendChatMessage(page, 'test:disconnect-now');
    await waitUntilDisconnected(page);

    await page.locator('#input').fill('离线时打的字');
    await page.locator('#btnSend').click();
    await expect(page.locator('#input')).toHaveValue('');
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await waitUntilConnected(page);

    await expect.poll(() => sent.filter(m => m.fromOutbox === true).length).toBe(1);
    const replay = sent.find(m => m.fromOutbox === true)!;
    expect(replay.text).toBe('离线时打的字');
    expect(replay.instanceId).toBe('inst_1');
    expect(replay.sessionId, `重放没带入队时的会话，服务端认不出同号的另一个会话：${JSON.stringify(replay)}`)
      .toBe('mock-session-visual-test');
    await expectNoBrowserErrors(page);
  });

  test('P0-02d3 在线发出去没被确认、转进重发的那条，重放同样带上会话（MSG-02）', async ({ page }) => {
    const sent = captureUserMessages(page);
    await gotoMock(page);
    await ensureComposerReady(page);
    await sendChatMessage(page, 'test:arm-send-transient-fail');
    // 武装命令本身不收尾（运行条一直亮着），照其它 arm 用例的做法切到另一个会话再发
    await openSessionsSidebar(page);
    await expandWorkspace(page, MAIN_WORKSPACE);
    await openWorkspaceSession(page, MAIN_WORKSPACE, 'Archived Planning Session');
    await expectSidebarClosed(page);
    await expect(page.locator('#messages')).toContainText('Archived plan replay', { timeout: 10_000 });

    await sendChatMessage(page, '在线没被确认的那条');
    // 第一次被 mock 以可重试的负 ack 拒掉 → 进 outbox → 重发送达
    await expect.poll(() => sent.filter(m => m.fromOutbox === true).length).toBe(1);
    const replay = sent.find(m => m.fromOutbox === true)!;
    expect(replay.text).toBe('在线没被确认的那条');
    expect(replay.instanceId).toBe('inst_archived');
    expect(replay.sessionId, `在线转入重发的条目没带会话：${JSON.stringify(replay)}`).toBe('mock-session-archived');
    await expectNoBrowserErrors(page);
  });

  // 验收 O31：离线重放被服务端永久拒收后，outbox 清了、输入框是空的，原文只剩一行「已停止重试」——这条再也不会发，
  // 用户也拿不回自己打的字。投给眼前这个会话、输入框空着时，原文放回输入框。
  test('P0-02d7 离线重放被永久拒收：原文放回输入框，提示说清已停止重试', async ({ page }) => {
    await gotoMock(page);
    await ensureComposerReady(page);
    await sendChatMessage(page, 'test:arm-outbox-permanent');
    // 武装命令本身不收尾（运行条一直亮着），照其它 arm 用例的做法切到另一个会话再发
    await openSessionsSidebar(page);
    await expandWorkspace(page, MAIN_WORKSPACE);
    await openWorkspaceSession(page, MAIN_WORKSPACE, 'Archived Planning Session');
    await expectSidebarClosed(page);
    await expect(page.locator('#messages')).toContainText('Archived plan replay', { timeout: 10_000 });

    await page.context().setOffline(true);
    await waitUntilDisconnected(page);
    await page.locator('#input').fill('会被永久拒收的那条');
    await page.locator('#btnSend').click();
    await expect(page.locator('#input')).toHaveValue('');
    await page.context().setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await waitUntilConnected(page);

    await expect(page.locator('#input'), '永久拒收后原文丢了：outbox 已清，这条不会再发').toHaveValue('会被永久拒收的那条');
    await expect(page.locator('#messages')).toContainText('已停止重试');
    await expect(page.locator('#messages')).toContainText('原文已放回输入框');
    await expectNoBrowserErrors(page);
  });

  // PR #232 review：重载页面后恢复出来的 outbox 条目没有气泡。它发往不在眼前的会话、又被服务端永久拒收时，提示没有
  // 落点，outbox 已清，用户打的字就没了。暂存起来，回到它的会话时交还；别的会话里看不到它。
  test('P0-02d11 重载后发往别的会话的离线条目被永久拒收：原文暂存，回到那个会话时交还', async ({ page }) => {
    const sent = captureUserMessages(page);
    await gotoMock(page);
    await ensureComposerReady(page);
    await sendChatMessage(page, 'test:arm-outbox-permanent');
    await openSessionsSidebar(page);
    await expandWorkspace(page, MAIN_WORKSPACE);
    await openWorkspaceSession(page, MAIN_WORKSPACE, 'Archived Planning Session');
    await expectSidebarClosed(page);
    await expect(page.locator('#messages')).toContainText('Archived plan replay', { timeout: 10_000 });

    // 重载后恢复出来的条目：发往 Visual Sandbox (Main)，内存里没有气泡。得在应用脚本跑之前写——
    // 重载前写的会被 pagehide 时的 persistOutbox 用内存里的空队列盖掉。
    await page.addInitScript(() => localStorage.setItem('ccm-outbox-v1', JSON.stringify([{
      text: '发往主会话的那条', model: null, clientMessageId: 'p0-02d11-dead-letter',
      instanceId: 'inst_1', cwd: '/Users/you/code/claude-chat-mobile', sessionId: 'mock-session-visual-test',
    }])));
    await page.reload();
    await waitUntilConnected(page);
    await expect.poll(() => sent.some(m => m.clientMessageId === 'p0-02d11-dead-letter' && m.fromOutbox === true),
      { message: '前提：恢复出来的条目要被重放（mock 已武装成永久拒收）' }).toBe(true);
    await expect(page.locator('#messages'), '别的会话的失败不该打到眼前这个会话上').not.toContainText('发往主会话的那条');

    await openSessionsSidebar(page);
    await expandWorkspace(page, MAIN_WORKSPACE);
    await openWorkspaceSession(page, MAIN_WORKSPACE, 'Visual Sandbox (Main)');
    await expectSidebarClosed(page);
    await expect(page.locator('#input'), '永久拒收、outbox 已清：不交还的话这条就没了').toHaveValue('发往主会话的那条');
    await expect(page.locator('#messages')).toContainText('原文已放回输入框');
    await expectNoBrowserErrors(page);
  });

  // 离线攒了两条，重放的第 1 条在服务端触发规则 5 置换：同一会话换了实例号，前端先收到新号的广播、再收到 ack，
  // 离线条目还拿着入队时的旧号。新实例的 sync:since 报磁盘 ahead，前端清屏重载；第 2 条拿着旧号撞上第 1 条开跑的那轮，
  // 落「未发送 + 重发」。mock 的时序是：清屏 → 第 2 条的负 ack → 历史落地。
  // 守三件事：① 归属按会话认，批后结算不收掉新实例那轮的运行条 ② 清屏保住同一会话的离线气泡，第 2 条的提示挂在它自己
  // 的气泡上，气泡排在重载的历史之后、落底可见（修之前气泡随清屏摘下，提示退成一条独立提示条插在空的 #messages 里，
  // 历史接在它下面，实测 top 为负、要往上翻）③ 已送达的第 1 条被历史认领，屏幕上只有一颗。
  const replayTwoOfflineAcrossSwap = async (page: Page, [first, second]: [string, string], arm = 'test:arm-outbox-replay-swap') => {
    await gotoMock(page);
    await ensureComposerReady(page);
    await sendChatMessage(page, arm);
    // 武装命令本身不收尾，照其它 arm 用例的做法切到另一个会话再发
    await openSessionsSidebar(page);
    await expandWorkspace(page, MAIN_WORKSPACE);
    await openWorkspaceSession(page, MAIN_WORKSPACE, 'Archived Planning Session');
    await expectSidebarClosed(page);
    await expect(page.locator('#messages')).toContainText('Archived plan replay', { timeout: 10_000 });

    await page.context().setOffline(true);
    await waitUntilDisconnected(page);
    for (const text of [first, second]) {
      await page.locator('#input').fill(text);
      await page.locator('#btnSend').click();
      await expect(page.locator('#input')).toHaveValue('');
    }
    await page.context().setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await waitUntilConnected(page);
    // 重载的历史落地的标志：mock 只在第 1 条送达之后才把它写进这个会话的历史（uuid 只此一处）
    await expect(page.locator('[data-testid="user-message"][data-uuid="u-archived-replayed"]'), '清屏重载的历史没有落地').toHaveCount(1, { timeout: 10_000 });
  };

  const expectResendOnSecondBubbleAfterHistory = async (page: Page, second: string) => {
    const secondPending = page.locator('[data-testid="user-message"].opacity-70').filter({ hasText: second });
    await expect(secondPending, '第 2 条的离线气泡不在了：同一会话的清屏重载没保住它，或历史落地时被同文的旧消息认领撤掉').toHaveCount(1);
    await expect(secondPending.locator('[data-testid="outbox-resend"]'), '「未发送 + 重发」没挂在第 2 条自己的气泡上').toBeVisible();
    await expect(page.locator('#messages [data-testid="outbox-resend"]'), '提示另起了一条（落在重载的历史上方），不只挂在气泡上').toHaveCount(1);
    await expect.poll(() => page.evaluate(text => {
      const tops = [...document.querySelectorAll('#messages > [data-top-level="1"]')];
      const last = tops[tops.length - 1];
      return Boolean(last?.classList.contains('opacity-70') && last.textContent?.includes(text));
    }, second), { message: '第 2 条的气泡要排在重载的历史之后（它是最新的一条）' }).toBe(true);
    await expect(secondPending.locator('[data-testid="outbox-resend"]'), '「重发」不在视口里，要往上翻才看得到').toBeInViewport();
  };

  test('P0-02d4 离线重放的第 1 条让同一会话换了实例：运行条留着，第 2 条的「重发」挂在它排在历史之后的气泡上', async ({ page }) => {
    await replayTwoOfflineAcrossSwap(page, ['离线第一条', '离线第二条']);

    await expectResendOnSecondBubbleAfterHistory(page, '离线第二条');
    const first = page.locator('[data-testid="user-message"]').filter({ hasText: '离线第一条' });
    await expect(first, '已送达的第 1 条：历史带回它之后，被保住的离线气泡要让历史认领，屏幕上只能有一颗').toHaveCount(1);
    await expect(first, '第 1 条留下的应是历史里那颗确认态气泡').not.toHaveClass(/opacity-70/);
    await expect(page.locator('#streamLiveStatus'), '第 1 条在新实例上开跑的那轮，运行条被批后结算收掉了').toBeVisible();
    await expectNoBrowserErrors(page);
  });

  // 第 2 条被在途轮拒收，确定没进 transcript。历史里恰好有一条同文的旧消息（「继续」这类短句天天重复），按文本认领
  // 会把它当成第 2 条已经落盘，撤掉保住的气泡，「重发」跟着没了。
  test('P0-02d5 同上，第 2 条与历史里一条旧消息同文：被拒收的气泡不让旧消息认领，「重发」照样留着', async ({ page }) => {
    await replayTwoOfflineAcrossSwap(page, ['离线第一条', 'Any follow-up questions?']);

    await expectResendOnSecondBubbleAfterHistory(page, 'Any follow-up questions?');
    await expect(page.locator('[data-testid="user-message"]').filter({ hasText: 'Any follow-up questions?' }),
      '历史里那条旧消息与被拒收的第 2 条应各占一颗').toHaveCount(2);
    await expectNoBrowserErrors(page);
  });

  // 验收 O29：第 1 条的回显先于重载的历史到达，把清屏保住的离线气泡认领转正；历史随后落地，落定逻辑只认未确认的
  // 气泡、跳过了它——它留在历史上方，历史里又渲染出同一条，回复在最底。
  test('P0-02d8 回显先于重载的历史到达：保住的气泡不留在历史上方，屏幕上只有一颗', async ({ page }) => {
    await replayTwoOfflineAcrossSwap(page, ['离线第一条', '离线第二条'], 'test:arm-outbox-replay-swap-echo-first');

    const first = page.locator('[data-testid="user-message"]').filter({ hasText: '离线第一条' });
    await expect(first, '回显转正的那颗与历史里那颗各占一颗：保住的气泡没被历史认领').toHaveCount(1);
    await expect.poll(() => page.evaluate(() => {
      const tops = [...document.querySelectorAll('#messages > [data-top-level="1"]')];
      const at = (needle: string) => tops.findIndex(el => el.textContent?.includes(needle));
      return at('离线第一条') > at('Okay, heading home.');
    }), { message: '第 1 条排在历史最后一轮之前：它被留在了重载的历史上方' }).toBe(true);
    await expectResendOnSecondBubbleAfterHistory(page, '离线第二条');
    await expectNoBrowserErrors(page);
  });

  // 同上，但重载的历史先于第 2 条的拒收落地：历史渲染时第 2 条还没有结论。按文字认领会把它当成已落盘，clientMessageId
  // 交给那条同文的旧消息、撤掉气泡；拒收再到时提示只能另起一条，续发送达，回显带着同一个 id，被当成「旧消息已在屏幕上」
  // 吞掉，这条送达的消息哪儿都不显示。mock 放出拒收后那一轮随即跑完：排着的第 2 条自动续发（O66），不用点「重发」。
  test('P0-02d6 历史先于第 2 条的拒收落地、且与旧消息同文：气泡不被认领，本轮结束自动续发送达后这条照样显示', async ({ page }) => {
    const second = 'Any follow-up questions?';
    await replayTwoOfflineAcrossSwap(page, ['离线第一条', second], 'test:arm-outbox-replay-swap-history-first');

    await expect(page.locator('#messages [data-testid="outbox-resend"]'), '本轮结束后排着的第 2 条应自动续发、提示收起').toHaveCount(0);
    const same = page.locator('[data-testid="user-message"]').filter({ hasText: second });
    await expect(same, '「重发」送达的那条没显示出来（回显被当成历史里同文的旧消息吞掉了）').toHaveCount(2);
    await expect(same.last(), '送达的那条应被回显转正').not.toHaveClass(/opacity-70/);
    await expectNoBrowserErrors(page);
  });

  // 验收 O66：断网时连发三条，恢复后第 1 条送出、开跑，后两条撞上这一轮被拒收。此前它们落「⏸ 未发送 + 重发」，
  // 回合结束也不会自己续发，得逐条点；而且三颗问气泡挨在一起，界面显示成「问1 问2 问3 答1 答2 答3」。
  // 终端里忙时打的话会排队、回合结束再发——这里对齐：排队、每轮结束按序自动续发下一条，真正发出时气泡挪到最后。
  test('P0-02d9 离线连发三条：按序排队，每轮结束自动续发下一条，问答顺序与发送一致', async ({ page }) => {
    await gotoMock(page);
    await ensureComposerReady(page);
    await sendChatMessage(page, 'test:arm-outbox-turns');
    await waitForIdle(page);

    await page.context().setOffline(true);
    await waitUntilDisconnected(page);
    for (const text of ['离线问一', '离线问二', '离线问三']) {
      await page.locator('#input').fill(text);
      await page.locator('#btnSend').click();
      await expect(page.locator('#input')).toHaveValue('');
    }
    await page.context().setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await waitUntilConnected(page);

    const answer = (n: string) => page.locator('[data-testid="assistant-message"]').filter({ hasText: `答：离线问${n}` });
    const queued = page.locator('[data-testid="user-message"].opacity-70');
    await expect(answer('一')).toBeVisible();
    await expect(queued, '第 2、3 条撞上第 1 条那一轮，应在排队').toHaveCount(2);
    await expect(queued.first()).toContainText('本轮结束后自动发送');

    // 不点「重发」：本轮一结束，第 2 条自己发出；第 3 条还得等第 2 条那一轮
    await page.request.post('/__outbox-turn-end');
    await expect(answer('二')).toBeVisible();
    await expect(queued).toHaveCount(1);
    await expect(answer('三')).toHaveCount(0);
    await page.request.post('/__outbox-turn-end');
    await expect(answer('三')).toBeVisible();
    await expect(queued).toHaveCount(0);
    await page.request.post('/__outbox-turn-end');

    const order = await page.locator('#messages [data-testid="user-message"], #messages [data-testid="assistant-message"]')
      .evaluateAll(nodes => nodes
        .map(n => ((n.getAttribute('data-testid') === 'assistant-message' ? '答' : '问') + ((n.textContent || '').match(/离线问(一|二|三)/)?.[1] || '')))
        .filter(x => x.length > 1));
    expect(order, '问答顺序应与发送顺序一致').toEqual(['问一', '答一', '问二', '答二', '问三', '答三']);
    await expectNoBrowserErrors(page);
  });

  // 同上，但第 1 条那一轮被用户按了停止：停止 = 不想接着跑，排着的不再自动发（终端里中断后排着的话也不会自己发出去），
  // 退回手动「重发」；手动点了照样送达，问答顺序照样对。
  test('P0-02d10 排着的离线条目：按了停止就不再自动续发，退回手动「重发」', async ({ page }) => {
    await gotoMock(page);
    await ensureComposerReady(page);
    await sendChatMessage(page, 'test:arm-outbox-turns');
    await waitForIdle(page);

    await page.context().setOffline(true);
    await waitUntilDisconnected(page);
    for (const text of ['离线问一', '离线问二']) {
      await page.locator('#input').fill(text);
      await page.locator('#btnSend').click();
      await expect(page.locator('#input')).toHaveValue('');
    }
    await page.context().setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await waitUntilConnected(page);

    const answer = (n: string) => page.locator('[data-testid="assistant-message"]').filter({ hasText: `答：离线问${n}` });
    const queued = page.locator('[data-testid="user-message"].opacity-70');
    await expect(answer('一')).toBeVisible();
    await expect(queued).toHaveCount(1);
    await expect(queued).toContainText('本轮结束后自动发送');

    await expect(page.locator('#btnSend')).toHaveAttribute('data-mode', 'stop');
    await page.locator('#btnSend').click();
    // 停止后那一轮结束（instances 广播 turnRunning:false 到了，主按钮回到发送）——此时若还在排队就会被续发出去
    await expect(page.locator('#btnSend')).not.toHaveAttribute('data-mode', 'stop');
    await expect(queued).toContainText('本轮已停止');
    await expect(answer('二')).toHaveCount(0);

    await queued.locator('[data-testid="outbox-resend"]').click();
    await expect(answer('二')).toBeVisible();
    await expect(queued).toHaveCount(0);
    await page.request.post('/__outbox-turn-end');
    await expectNoBrowserErrors(page);
  });

  // O66 review ①：普通工作区的新会话页上离线连发，条目都不带实例号。第一条懒开实例并开跑，第二条被服务端经 viewing
  // 投给它、撞上那一轮被拒收。此前它按 {instanceId:null} 排队，本轮结束认不出目标，永远不续发。
  test('P0-02d12 新会话页上离线连发：第一条懒开的那一轮结束后，第二条自动续发', async ({ page }) => {
    await gotoMock(page);
    await ensureComposerReady(page);
    await sendChatMessage(page, 'test:arm-outbox-turns');
    await waitForIdle(page);
    await page.locator('#btnNew').click();
    await expect(page.locator('[data-testid="compose-surface"]')).toBeVisible();

    await page.context().setOffline(true);
    await waitUntilDisconnected(page);
    for (const text of ['新页离线一', '新页离线二']) {
      await page.locator('#input').fill(text);
      await page.locator('#btnSend').click();
      await expect(page.locator('#input')).toHaveValue('');
    }
    await page.context().setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await waitUntilConnected(page);

    const received = async () => (await (await page.request.get('/__outbox-received')).json()) as Array<{ text: string; instanceId: string | null; viewing: string | null; refused: boolean }>;
    const sentOf = async (text: string) => (await received()).filter(m => m.text === text);
    await expect.poll(async () => (await sentOf('新页离线一')).length).toBe(1);
    expect((await sentOf('新页离线一'))[0].instanceId, '前提：第一条是懒开（不带实例号）').toBeNull();
    await expect.poll(async () => (await sentOf('新页离线二')).length).toBe(1);
    await expect(page.locator('#messages'), '前提：第二条撞上第一条那一轮，在排队').toContainText('本轮结束后自动发送');

    await page.request.post('/__outbox-turn-end');
    await expect.poll(async () => (await sentOf('新页离线二')).length, '本轮结束应自动续发第二条').toBe(2);
    expect((await sentOf('新页离线二'))[1].instanceId).toBe('inst_fresh');
    await page.request.post('/__outbox-turn-end');
    await expectNoBrowserErrors(page);
  });

  // O66 review ②：页面重载后从持久化队列恢复的条目没有气泡；发往的又不是眼下查看的会话，就连提示条也没有落点。
  // 此前没有落点就直接返回、不登记排队，而它已经从持久化队列里移除——既不自动续发，也没有手动「重发」。
  test('P0-02d13 重载后恢复的离线条目发往后台会话：撞上那一轮也排队，结束后自动续发', async ({ page }) => {
    await gotoMock(page);
    await ensureComposerReady(page);
    await sendChatMessage(page, 'test:arm-outbox-turns');
    await waitForIdle(page);
    await sendChatMessage(page, 'test:tab'); // 备好后台实例 inst_2，眼下仍看 inst_1
    await waitForIdle(page);
    // 在新文档起步时写持久化队列：pagehide 会用内存里的空队列覆盖重载前写进去的东西
    await page.addInitScript(() => {
      if (sessionStorage.getItem('seed-bg-outbox')) return;
      sessionStorage.setItem('seed-bg-outbox', '1');
      const row = (n: number, text: string) => ({
        text, model: null, clientMessageId: `cm-bg-${n}`,
        instanceId: 'inst_2', sessionId: 'mock-session-another', cwd: '/Users/you/code/another-react-project',
      });
      localStorage.setItem('ccm-outbox-v1', JSON.stringify([row(1, '后台离线一'), row(2, '后台离线二')]));
    });
    await page.reload();
    await waitUntilConnected(page);

    const received = async () => (await (await page.request.get('/__outbox-received')).json()) as Array<{ text: string; instanceId: string | null; viewing: string | null; refused: boolean }>;
    const sentOf = async (text: string) => (await received()).filter(m => m.text === text);
    await expect.poll(async () => (await sentOf('后台离线一')).length).toBe(1);
    await expect.poll(async () => (await sentOf('后台离线二')).length, '前提：第二条被投过一次、撞上第一条那一轮').toBe(1);
    expect((await sentOf('后台离线二'))[0], '前提：发往后台实例 inst_2、眼下查看的是 inst_1，且被它那一轮拒收').toMatchObject({ instanceId: 'inst_2', viewing: 'inst_1', refused: true });
    await expect(page.locator('#messages'), '前提：眼下的会话里没有它的提示条').not.toContainText('本轮结束后自动发送');

    await page.request.post('/__outbox-turn-end');
    await expect.poll(async () => (await sentOf('后台离线二')).length, '本轮结束应自动续发第二条').toBe(2);
    await page.request.post('/__outbox-turn-end');
    await expectNoBrowserErrors(page);
  });

  test('P0-02f 前台恢复 sync 不重复已见回复', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:foreground-sync-replay');
    await waitForIdle(page);
    await expect(page.locator('[data-testid="assistant-message"]').filter({ hasText: 'Foreground sync baseline response.' })).toHaveCount(1);

    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    await expect(page.locator('#messages')).toContainText('Foreground sync replay completed.', { timeout: 10_000 });
    await expect(page.locator('[data-testid="assistant-message"]').filter({ hasText: 'Foreground sync baseline response.' })).toHaveCount(1);

    await expectNoBrowserErrors(page);
  });

  test('P0-02g 前台恢复发现实例缺失时回载历史', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:foreground-found-missing');
    await waitForIdle(page);
    await expect(page.locator('#messages')).toContainText('Foreground found=false fixture armed.');
    await expect(page.locator('#messages')).toContainText('Stale foreground instance response.');

    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    await expect(page.locator('#messages')).toContainText('Authoritative history after foreground reload.', { timeout: 10_000 });
    await expect(page.locator('#messages')).not.toContainText('Stale foreground instance response.');
    await expect(page.locator('#messages')).not.toContainText('Foreground found=false fixture armed.');
    await expect(page.locator('#messages')).not.toContainText('test:foreground-found-missing');
    await expect(page.locator('#historyLoadingCard')).toHaveCount(0);

    await expectNoBrowserErrors(page);
  });

  test('P0-02e ultracode 档不改写用户正文（Settings.ultracode 会话 flag）', async ({ page }) => {
    await gotoMock(page);
    await ensureComposerReady(page);

    await page.locator('#pillDefaults').click();
    await expect(page.locator('#settingsSheet')).not.toHaveClass(/translate-y-full/);
    await openSettingsSection(page, 'effort');
    await expect(page.locator('.effort-tile[data-level="ultracode"]')).toBeVisible();
    await page.locator('.effort-tile[data-level="ultracode"]').click();
    await expect(page.locator('#pillEffortText')).toContainText('ultracode');
    await closeSettings(page);
    await expect(page.locator('#settingsSheet')).toHaveClass(/translate-y-full/);

    // 正文保持用户原样，不再自动注入 ultracode 前缀
    await sendChatMessage(page, 'test:workflow-echo');
    await waitForIdle(page);
    const firstText = await page.locator('[data-testid="user-message"]').last().innerText();
    expect(firstText).toContain('test:workflow-echo');
    expect(firstText.match(/\bultracode\b/g) || []).toHaveLength(0);

    // 用户自行写 ultracode 关键词仍原样发送（CLI 关键词 trigger）
    await sendChatMessage(page, 'ultracode test:workflow-echo');
    await waitForIdle(page);
    const secondText = await page.locator('[data-testid="user-message"]').last().innerText();
    expect(secondText).toContain('ultracode test:workflow-echo');
    expect(secondText.match(/\bultracode\b/g)).toHaveLength(1);

    await expectNoBrowserErrors(page);
  });

  test('P0-02h 斜杠命令提示可处理服务端对象格式命令', async ({ page }) => {
    await gotoMock(page);
    await ensureComposerReady(page);

    await page.locator('#input').fill('/m');
    await expect(page.locator('#cmdHints')).toBeVisible();
    await expect(page.locator('#cmdHints')).toContainText('/model');
    await expect(page.locator('#btnSend')).toBeEnabled();

    await page.locator('#input').fill('plain message after slash hint');
    await expect(page.locator('#cmdHints')).toBeHidden();
    await expect(page.locator('#btnSend')).toBeEnabled();

    await expectNoBrowserErrors(page);
  });

  // commands_changed（SDK 0.3.229）：CLI 中途发现新命令/skill 的全量推送。真 server 侧
  // agent.js 把它转成 slash_commands 事件，前端 handle.slash_commands 替换补全列表。
  // 断言走可见的 #cmdHints，不读 window.availableSkills——后者是实现细节，且读全局变量的断言
  // 在补全渲染断链时照样绿。
  test('P0-02n 中途推送的 slash 命令替换补全列表（REPLACE 而非合并）', async ({ page }) => {
    await gotoMock(page);
    await ensureComposerReady(page);

    // 1. 基线：首帧 init 给的是 help / model / effort，此时 /h 能提示出 /help。
    await page.locator('#input').fill('/h');
    await expect(page.locator('#cmdHints')).toBeVisible();
    await expect(page.locator('#cmdHints')).toContainText('/help');

    // 2. 触发中途推送：新列表是 deploy / rollback / model，与基线不是超集关系。
    await sendChatMessage(page, 'test:commands-changed');
    await waitForIdle(page);

    // 3. 新命令进入补全。
    await page.locator('#input').fill('/d');
    await expect(page.locator('#cmdHints')).toBeVisible();
    await expect(page.locator('#cmdHints')).toContainText('/deploy');

    // 4. ★ 这一条才是 REPLACE 与「合并」的分水岭：旧命令必须消失。
    //    若前端把新列表并进旧列表，上面第 3 步照样绿，只有这里会红。
    await page.locator('#input').fill('/h');
    await expect(page.locator('#cmdHints')).toBeHidden();

    // 5. ★ terminal 名单必须跨过这次全量推送继续生效。
    //    commands_changed 那条路【带不到】terminal 名单（SDK 的 SlashCommand[] 无 terminalOriented
    //    标记），而它推来的新列表里确实含 color。若前端/后端任一端把名单跟着一起重置成空，
    //    /color 就会在这里重新冒出来——这是本条断言唯一要抓的退化。
    await page.locator('#input').fill('/c');
    await expect(page.locator('#cmdHints')).toBeHidden();

    await expectNoBrowserErrors(page);
  });

  // terminal_slash_commands（SDK）：绑在本地终端的命令不进手机补全菜单。
  // 判据由 SDK 每轮 init 下发，不是前端硬编码黑名单。
  test('P0-02p terminal 绑定命令不出现在补全菜单，同帧的普通命令照常出现', async ({ page }) => {
    await gotoMock(page);
    await ensureComposerReady(page);

    // 正对照先行：同一帧 init 里的普通命令必须显示得出来，否则下面的「不显示」无法区分
    // 是「过滤生效」还是「补全整个断链了」。
    await page.locator('#input').fill('/e');
    await expect(page.locator('#cmdHints')).toBeVisible();
    await expect(page.locator('#cmdHints')).toContainText('/effort');

    // 首帧 init 的 slashCommands 含 color，terminalSlashCommands 标了它 → 补全里不得出现。
    await page.locator('#input').fill('/c');
    await expect(page.locator('#cmdHints')).toBeHidden();

    await expectNoBrowserErrors(page);
  });

  test('P0-02i 点击斜杠命令提示会填入命令并保持可发送', async ({ page }) => {
    await gotoMock(page);
    await ensureComposerReady(page);

    await page.locator('#input').fill('/m');
    await expect(page.locator('#cmdHints')).toBeVisible();
    await page.locator('#cmdHints [data-cmd="/model"]').click();

    await expect(page.locator('#input')).toHaveValue('/model ');
    await expect(page.locator('#cmdHints')).toBeHidden();
    await expect(page.locator('#btnSend')).toBeEnabled();

    await expectNoBrowserErrors(page);
  });

  test('P0-02j 点击外部会关闭斜杠命令提示且保留草稿', async ({ page }) => {
    await gotoMock(page);
    await ensureComposerReady(page);

    await page.locator('#input').fill('/m');
    await expect(page.locator('#cmdHints')).toBeVisible();

    await page.locator('#messages').click({ position: { x: 20, y: 20 } });

    await expect(page.locator('#cmdHints')).toBeHidden();
    await expect(page.locator('#input')).toHaveValue('/m');
    await expect(page.locator('#btnSend')).toBeEnabled();
    await expect(page.locator('[data-testid="user-message"]')).toHaveCount(0);

    await expectNoBrowserErrors(page);
  });

  test('P0-02k 防抖窗口内连续两次触发发送只产生一条消息（FE-004）', async ({ page }) => {
    await gotoMock(page);

    // 发送按钮点击后会同步转入 disabled，原生 disabled 按钮不派发 click 事件、Playwright 的
    // .click() 也会等按钮重新可用才点——都无法真实复现"两次触发落在同一竞态窗口内"。
    // 直接同步调用两次 onclick（中间回填文本，模拟"没反应就手快再点一次"）才是这场竞态的真实形态。
    await page.evaluate(() => {
      const input = document.getElementById('input') as HTMLTextAreaElement;
      const btn = document.getElementById('btnSend') as HTMLButtonElement & { onclick: (() => void) | null };
      input.value = 'test:settings-echo';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      btn.onclick?.();
      input.value = 'test:settings-echo';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      btn.onclick?.();
    });

    await waitForIdle(page);
    await expect(page.locator('[data-testid="user-message"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="assistant-message"]').last()).toContainText('设置回显：model=');

    // 防抖窗口过后应正常恢复：能再发一条新消息（不是被永久卡死）。
    await page.locator('#input').fill('test:settings-echo');
    await expect(page.locator('#btnSend')).toBeEnabled();
    await page.locator('#btnSend').click();
    await waitForIdle(page);
    await expect(page.locator('[data-testid="user-message"]')).toHaveCount(2);

    await expectNoBrowserErrors(page);
  });

  // 在线乐观气泡（2026-08-27）：真机反馈「发出去的消息消失，过几秒才出现」。根因不是丢消息——
  // 在线路径【根本不建本地气泡】，气泡的诞生被压在服务端一串 await 之后（懒开实例 spawn CLI +
  // setModel control_request，上界 SERVER_PRE_TURN_UPPER_BOUND_MS=10s）。这段窗口里输入框已清空、
  // 消息流却还是空的，观感就是"没发成功"。
  // 这条回归以前【结构性抓不到】：mock 收到 user:message 后同步 echo，回包永远瞬时。
  // 所以本用例走 test:slow-echo 把那段空窗显式化，断言 timeout 短于 mock 延迟才有区分力。
  test('P0-02m 在线发送立即出现未确认气泡，服务端回显后原地转正', async ({ page }) => {
    await gotoMock(page);
    await ensureComposerReady(page);

    await page.locator('#input').fill('test:slow-echo');
    await page.locator('#btnSend').click();

    // ★ 800ms 必须远短于 mock 的 SLOW_ECHO_DELAY_MS(2000)：只有本地乐观气泡能让它通过。
    // 若这里放宽到默认 timeout，服务端回显也能满足断言，用例就退化成「气泡最终会出现」，零区分力。
    const bubbles = page.locator('[data-testid="user-message"]');
    await expect(bubbles).toHaveCount(1, { timeout: 800 });
    await expect(bubbles.last()).toContainText('test:slow-echo');
    // 未确认态可见：半透明 + 待发指示，让"已发出但还没落定"与"已确认"在视觉上可区分
    await expect(bubbles.last()).toHaveClass(/opacity-70/);
    await expect(page.locator('.pending-indicator').last()).toBeVisible();
    // 发送动作本身已完成：输入框清空、主钮进入停止态
    await expect(page.locator('#input')).toHaveValue('');

    // 服务端回显到达 → 原地转正（去半透明、撤待发指示），且【不产生第二个气泡】
    await expect(bubbles.last()).not.toHaveClass(/opacity-70/, { timeout: 10_000 });
    await expect(bubbles).toHaveCount(1);
    await expect(page.locator('.pending-indicator')).toHaveCount(0);

    await expectNoBrowserErrors(page);
  });

  // VC-D1-01（2026-08-26 探索性测试）：一次完整回合的**三段形变**。
  // 本文件上面 P0-02 只覆盖了第一段（空输入 → 打字 → 发送钮活过来），后两段散落在别的用例里，
  // 从没有一条把它们串成一条链断言过。串起来才拦得住这类失败：
  //   · 发送钮停在方块但正文已完整 → 回合结算没落地，输入框会一直拒收下一条
  //   · 正文出现但从没见过动态行 → 流式通道没接上，用户在等待期间看不到任何进展
  //   · 回合结束没有收尾行 → 回看历史时看不出这一轮花了多久
  test('P0-02l 一次完整回合的三段形变：灰 → 停止方块＋动态行 → 回箭头＋收尾行', async ({ page }) => {
    await gotoMock(page);
    await ensureComposerReady(page);

    // 第一段：空输入 = 不可点且整颗隐藏（Composer C，避免「点了没反应」）
    await expect(page.locator('#btnSend')).toBeDisabled();
    await expect(page.locator('#btnSend')).toBeHidden();
    await page.locator('#input').fill('test:tool');
    await expect(page.locator('#btnSend')).toBeVisible();
    await expect(page.locator('#btnSend')).toBeEnabled();

    // 第二段：点发送后 箭头 → 停止方块，且流内出现动态状态行（等待期间的唯一进展信号）
    await page.locator('#btnSend').click();
    await expect(page.locator('#btnSend')).toHaveAttribute('data-mode', 'stop');
    await expect(page.locator('#streamLiveStatus')).toBeVisible();
    await expect(page.locator('[data-testid="user-message"]').last()).toContainText('test:tool');

    // 第三段：回合结算 —— 动态行退场、发送钮回到非 stop 态、留下 CLI 式收尾行。
    // 收尾行动词是 8 选 1 随机（TURN_DONE_VERBS，逐字取自 CLI 词表），所以按形状匹配而不是钉死某个词。
    await waitForIdle(page);
    await expect(page.locator('#btnSend')).not.toHaveAttribute('data-mode', 'stop');
    await expect(page.locator('[data-testid="assistant-message"]').last()).toContainText('All tools executed cleanly');
    await expect(page.locator('#messages')).toContainText(
      /✻ (Baked|Brewed|Churned|Cogitated|Cooked|Crunched|Sautéed|Worked) for \d+[smhd]/);

    await expectNoBrowserErrors(page);
  });
});
