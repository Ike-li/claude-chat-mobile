// helpers: tests/helpers/playwright.ts

import { test, expect } from '@playwright/test';
import { ensureComposerReady, expectNoBrowserErrors, gotoMock, sendChatMessage } from '../../helpers/playwright';
import { MAIN_WORKSPACE, expandWorkspace, expectSidebarClosed, openSessionsSidebar, openWorkspaceSession } from '../../helpers/sidebar-ui';

// 长按历史气泡的两个动作：assistant → 对话轴 fork（forkSession upToMessageId）；
// user → 先弹二选一，可选文件轴 Rewind（session:rewind:preview/confirm）或 fork。
//
// 【2026-09-18 起锚点由服务端算】前端只送「这条气泡自己的 uuid + 方向」，upToMessageId 由
// sessions/rewind-plan.js 的 planFork 对着 transcript 解析。原因：工具卡在前端 DOM 里没有
// uuid，「保留轮的最后一条 entry 是 tool_result」这种形态在前端结构上就看不见，而 SDK 的
// forkSession 是纯 inclusive slice、零修正，锚早了它照切、tool_use 就悬空。
// mock 的护栏随之从「只收 assistant 侧 uuid」翻成「uuid 侧别必须与 keepAnchorTurn 一致」。
// 长按靠真实 550ms setTimeout 触发（见 app.js bindBubbleLongPress），不用 waitForTimeout
// （禁用模式）——派发 touchstart 后直接轮询等确认弹层出现，天然把这段延迟吃掉。
test.describe('P0 日常零 token Mock UI 回归', () => {
  test('P0-FORK 长按 assistant 气泡可从该点分叉新会话', async ({ page }) => {
    await gotoMock(page);

    await openSessionsSidebar(page);
    await expandWorkspace(page, MAIN_WORKSPACE);
    await openWorkspaceSession(page, MAIN_WORKSPACE, 'Archived Planning Session');
    await expectSidebarClosed(page);
    await expect(page.locator('#messages')).toContainText('Archived plan replay from session history.', { timeout: 10_000 });

    const assistantBubble = page.locator('[data-testid="assistant-message"]', { hasText: 'Archived plan replay' });
    const box = await assistantBubble.boundingBox();
    if (!box) throw new Error('assistant bubble bounding box not found');
    const touch = { identifier: 0, clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 };
    await assistantBubble.dispatchEvent('touchstart', { touches: [touch], changedTouches: [touch], targetTouches: [touch] });

    await expect(page.locator('#confirmModal')).toBeVisible({ timeout: 3_000 });
    await expect(page.locator('#confirmTitle')).toContainText('分叉');
    await page.locator('#confirmOk').click();

    // mock session:fork 切到 mock-session-forked，其 session:history 回一段带独立文案的历史，验证真切换了会话。
    await expect(page.locator('#messages')).toContainText('Forked session ready.', { timeout: 10_000 });

    await expectNoBrowserErrors(page);
  });

  test('P0-FORKc 长按用户消息分叉：送自己的 uuid + keepAnchorTurn=false（语义而非位置）', async ({ page }) => {
    await gotoMock(page);

    await openSessionsSidebar(page);
    await expandWorkspace(page, MAIN_WORKSPACE);
    await openWorkspaceSession(page, MAIN_WORKSPACE, 'Archived Planning Session');
    await expectSidebarClosed(page);
    await expect(page.locator('#messages')).toContainText('Any follow-up questions?', { timeout: 10_000 });

    // 2026-09-18 起锚点由服务端算（planFork），前端只送「自己的 uuid + 语义标志」。
    // mock 的护栏随之翻转成【uuid 侧别必须与 keepAnchorTurn 一致】：这条 user 气泡要送
    // u-archived-2 + keepAnchorTurn=false，把语义送反（配成 true）会被 mock 拒绝、
    // 下面的「切到新会话」断言就失败——护栏守的东西换了，区分力仍在。
    const secondUserBubble = page.locator('[data-testid="user-message"]', { hasText: 'Any follow-up questions?' });
    const box = await secondUserBubble.boundingBox();
    if (!box) throw new Error('user bubble bounding box not found');
    const touch = { identifier: 0, clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 };
    await secondUserBubble.dispatchEvent('touchstart', { touches: [touch], changedTouches: [touch], targetTouches: [touch] });

    // 2026-09-10 起 user 气泡长按先弹二选一（回退 / 分叉）。这里选「从这里分叉」，
    // 它与回退的方向相反：回退丢弃这条所在轮、分叉同样丢弃这条及之后，两者都由服务端
    // 按同一个 planFork/planRewind 判据解析，前端只负责把方向说清楚。
    await expect(page.locator('#confirmModal')).toBeVisible({ timeout: 3_000 });
    await page.locator('#confirmAlt').click();
    await expect(page.locator('#confirmModal')).toBeVisible({ timeout: 3_000 });
    await page.locator('#confirmOk').click();
    await expect(page.locator('#messages')).toContainText('Forked session ready.', { timeout: 10_000 });

    await expectNoBrowserErrors(page);
  });

  test('P0-FORKb 长按会话首条用户消息（前面无 assistant 回复）时禁用分叉', async ({ page }) => {
    await gotoMock(page);

    await openSessionsSidebar(page);
    await expandWorkspace(page, MAIN_WORKSPACE);
    await openWorkspaceSession(page, MAIN_WORKSPACE, 'Archived Planning Session');
    await expectSidebarClosed(page);
    await expect(page.locator('#messages')).toContainText('Summarize archived plan', { timeout: 10_000 });

    const firstUserBubble = page.locator('[data-testid="user-message"]', { hasText: 'Summarize archived plan' });
    const box = await firstUserBubble.boundingBox();
    if (!box) throw new Error('user bubble bounding box not found');
    const touch = { identifier: 0, clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 };
    await firstUserBubble.dispatchEvent('touchstart', { touches: [touch], changedTouches: [touch], targetTouches: [touch] });

    // 先弹二选一；选「从这里分叉」后才走到"前面没有 assistant 可作锚点"这一档。
    await expect(page.locator('#confirmModal')).toBeVisible({ timeout: 3_000 });
    await page.locator('#confirmAlt').click();
    await expect(page.locator('#messages')).toContainText('这是最早一条消息', { timeout: 3_000 });
    await expect(page.locator('#confirmModal')).toBeHidden();

    await expectNoBrowserErrors(page);
  });
});

// ── 文件轴 Rewind ──
test.describe('P0 日常零 token Mock UI 回归 · Rewind', () => {
  const longPressUser = async (page: import('@playwright/test').Page, text: string) => {
    const bubble = page.locator('[data-testid="user-message"]', { hasText: text });
    const box = await bubble.boundingBox();
    if (!box) throw new Error(`user bubble not found: ${text}`);
    const touch = { identifier: 0, clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 };
    await bubble.dispatchEvent('touchstart', { touches: [touch], changedTouches: [touch], targetTouches: [touch] });
  };
  const openArchived = async (page: import('@playwright/test').Page) => {
    await gotoMock(page);
    await openSessionsSidebar(page);
    await expandWorkspace(page, MAIN_WORKSPACE);
    await openWorkspaceSession(page, MAIN_WORKSPACE, 'Archived Planning Session');
    await expectSidebarClosed(page);
  };

  test('P0-REWIND 长按用户气泡可回退该轮文件，确认框先列出影响面', async ({ page }) => {
    await openArchived(page);
    await expect(page.locator('#messages')).toContainText('Any follow-up questions?', { timeout: 10_000 });

    // 用【第二条】user 气泡：第一条是会话首条消息，其前面没有可保留的 chain entry，
    // 真 server 的 planRewind 在那一档返回 first-turn（见下一条用例）。
    await longPressUser(page, 'Any follow-up questions?');
    await expect(page.locator('#confirmModal')).toBeVisible({ timeout: 3_000 });
    await page.locator('#confirmOk').click(); // 主动作 = 回退

    // preview 的影响面必须先摆出来再让人点确认——回退会真改磁盘，"确认"不能是盲签。
    await expect(page.locator('#confirmBody')).toContainText('app.js', { timeout: 3_000 });
    await expect(page.locator('#confirmBody')).toContainText('完整保留');
    // G5 的负向对照：工作区没有会被覆盖的未提交改动时【不该】出现警告。
    // 少了这一条，一个恒警告的实现也能让下面 P0-REWINDd 那条全绿——而恒警告等于没警告。
    await expect(page.locator('#confirmBody')).not.toContainText('未提交的改动');
    await expect(page.locator('#confirmBody')).toContainText('12'); // insertions
    await page.locator('#confirmOk').click();

    // 成功路径的 UI 由 rewind_applied 广播驱动（本机与其他设备同一条路径）。
    // fork 语义：文案必须说清【原会话保留】——这是本方案相对原地截断的核心差异，
    // 用户据此知道回退不是不可逆的。
    await expect(page.locator('#messages')).toContainText('原会话保留', { timeout: 10_000 });

    // prefill：回退的下一步多半是把这句话改一改重说，所以原话要回填输入框
    // （Desktop 的 rewindSession 同样返回 prefill，SDK 的 d.ts 也点名了这个用途）。
    await expect(page.locator('#input')).toHaveValue('Any follow-up questions?', { timeout: 5_000 });
    await expectNoBrowserErrors(page);
  });

  test('P0-REWINDc 输入框里已有内容时不回填，不覆盖用户正在打的字', async ({ page }) => {
    await openArchived(page);
    await expect(page.locator('#messages')).toContainText('Any follow-up questions?', { timeout: 10_000 });

    await page.locator('#input').fill('我正在打的另一段话');
    await longPressUser(page, 'Any follow-up questions?');
    await expect(page.locator('#confirmModal')).toBeVisible({ timeout: 3_000 });
    await page.locator('#confirmOk').click();
    await expect(page.locator('#confirmBody')).toContainText('app.js', { timeout: 3_000 });
    await page.locator('#confirmOk').click();

    await expect(page.locator('#messages')).toContainText('原会话保留', { timeout: 10_000 });
    // 回退成功了，但输入框里的草稿必须原样还在——静默吞掉用户打了一半的话是不可接受的。
    await expect(page.locator('#input')).toHaveValue('我正在打的另一段话');
    await expectNoBrowserErrors(page);
  });

  test('P0-REWINDd 文件回了但新会话没建成：如实告知，并说明原会话未受影响', async ({ page }) => {
    await openArchived(page);
    await expect(page.locator('#messages')).toContainText('One more thing please', { timeout: 10_000 });

    await longPressUser(page, 'One more thing please');
    await expect(page.locator('#confirmModal')).toBeVisible({ timeout: 3_000 });
    await page.locator('#confirmOk').click();
    await expect(page.locator('#confirmBody')).toContainText('app.js', { timeout: 3_000 });
    // G5：这一档的工作区有会被回退覆盖的未提交改动——警告必须摆在【点确认之前】，
    // 事后再说就晚了，那些改动已经没了。
    await expect(page.locator('#confirmBody')).toContainText('未提交的改动');
    await page.locator('#confirmOk').click();

    // 这一支是「做了一半」：文件已经回退，但新会话没建成。不能只弹一句笼统的失败——
    // 用户需要知道①文件已经动了②原会话没事、可以重试。少任何一条他都不知道现在处境如何。
    await expect(page.locator('#messages')).toContainText('文件已回退', { timeout: 10_000 });
    await expect(page.locator('#messages')).toContainText('原会话未受影响');
    // G6/G7 的告知：这两条都是「服务端算得出、不说用户就不知道」——不说的后果不是报错，
    // 是用户以为全好了。三条提示各占一行，warning 在最前（整体性失败比个别文件更要紧）。
    await expect(page.locator('#messages')).toContainText('README.md');   // unrestored 点名到文件
    await expect(page.locator('#messages')).toContainText('符号链接');     // skippedLinks 说清原因
    await expectNoBrowserErrors(page);
  });

  test('P0-REWINDj 这一轮没有文件改动时，提示要给出路而不是死路', async ({ page }) => {
    await openArchived(page);
    await expect(page.locator('#messages')).toContainText('Just run some shell commands', { timeout: 10_000 });

    // 用户实测撞上的就是这一档：那一轮只跑了 Bash，checkpoint 只在 Edit/Write 前快照，
    // 于是 filesChanged 为空、canRewind 判 false。此前前端只 addBar 一句「这一轮没有可回退的
    // 文件改动」——讲清了为什么不行，但没讲还能干什么，用户连着试了 6 次拿到 6 条一样的话。
    await longPressUser(page, 'Just run some shell commands');
    await expect(page.locator('#confirmModal')).toBeVisible({ timeout: 3_000 });
    await page.locator('#confirmOk').click(); // 主动作 = 回退

    // 出路必须是可点的，不能只是一句文案。
    await expect(page.locator('#confirmModal')).toBeVisible({ timeout: 3_000 });
    await expect(page.locator('#confirmBody')).toContainText('Bash');       // 说清为什么没有可回退的
    await expect(page.locator('#confirmBody')).toContainText('不动任何文件'); // 说清分叉不是回退
    await page.locator('#confirmOk').click();

    // 点下去应当直接进入分叉确认，而不是把用户扔回原地重来一遍。
    await expect(page.locator('#confirmTitle')).toContainText('分叉', { timeout: 3_000 });
    await page.locator('#confirmOk').click();
    await expect(page.locator('#messages')).toContainText('Forked session ready.', { timeout: 10_000 });
    await expectNoBrowserErrors(page);
  });

  test('P0-REWINDk 找不到快照与没有文件改动是两种成因，文案不能混', async ({ page }) => {
    await openArchived(page);
    await expect(page.locator('#messages')).toContainText('An old turn with no snapshot', { timeout: 10_000 });

    // 与 P0-REWINDj 互为对照：两档都走「canRewind:false → 指向分叉」，但成因不同。
    // 把「没有文件改动」扣到这一档头上是假话——这一轮可能改了一堆文件，只是快照没了。
    // 判据写反时两条会同时红（这条断不该出现的词，那条断该出现的词）。
    await longPressUser(page, 'An old turn with no snapshot');
    await expect(page.locator('#confirmModal')).toBeVisible({ timeout: 3_000 });
    await page.locator('#confirmOk').click(); // 主动作 = 回退

    await expect(page.locator('#confirmBody')).toContainText('快照', { timeout: 3_000 });
    await expect(page.locator('#confirmBody')).not.toContainText('Bash');
    // 出路仍然要给——成因不影响「改用分叉」这条路可走。
    await expect(page.locator('#confirmBody')).toContainText('不动任何文件');
    await page.locator('#confirmOk').click();
    await expect(page.locator('#confirmTitle')).toContainText('分叉', { timeout: 3_000 });
    await expectNoBrowserErrors(page);
  });

  test('P0-REWINDm 确认框等待期间会话被切走：不拿旧锚点去分叉新会话', async ({ page }) => {
    await openArchived(page);
    await expect(page.locator('#messages')).toContainText('Switch away while I decide', { timeout: 10_000 });

    // preview 回完之后 mock 立刻推一条改了 viewingInstanceId 的 instances 广播，
    // 前端 bindView 会把 displayedSessionId 换掉——而此时「改用分叉」的确认框还开着。
    // 【为什么必须拦】requestSessionFork 内部取的是【当前】的 currentCwd / displayedSessionId，
    // 放行就会把 A 会话气泡的锚点和已经变成 B 的会话拼到一起发出去：那个请求做不出预期的分叉，
    // 用户还会停在 B 里只看到一句失败。成功路径早有同款校验（「会话已切换，回退已取消」），
    // 这条 fallback 分支必须对齐，不能因为它是「次要出路」就少一道。
    await longPressUser(page, 'Switch away while I decide');
    await expect(page.locator('#confirmModal')).toBeVisible({ timeout: 3_000 });
    await page.locator('#confirmOk').click(); // 主动作 = 回退

    await expect(page.locator('#confirmBody')).toContainText('Bash', { timeout: 3_000 });
    await page.locator('#confirmOk').click(); // 改用分叉

    await expect(page.locator('#messages')).toContainText('会话已切换', { timeout: 5_000 });
    // 反向断言：绝不能真的切到分叉出来的新会话去。
    await expect(page.locator('#messages')).not.toContainText('Forked session ready.');
    await expectNoBrowserErrors(page);
  });

  test('P0-REWINDb 会话首条消息无可保留锚点时，preview 阶段就拒绝且不弹二次确认', async ({ page }) => {
    await openArchived(page);
    await expect(page.locator('#messages')).toContainText('Summarize archived plan', { timeout: 10_000 });

    await longPressUser(page, 'Summarize archived plan');
    await expect(page.locator('#confirmModal')).toBeVisible({ timeout: 3_000 });
    await page.locator('#confirmOk').click(); // 主动作 = 回退

    // 拒绝发生在动任何文件【之前】，所以不该出现"将恢复 N 个文件"那道确认框。
    // 文案要点名是什么挡住的（这里是"第一轮"），否则用户无从判断该换个位置试还是根本不行。
    await expect(page.locator('#messages')).toContainText('第一轮', { timeout: 5_000 });
    await expect(page.locator('#confirmModal')).toBeHidden();
    await expectNoBrowserErrors(page);
  });
});
