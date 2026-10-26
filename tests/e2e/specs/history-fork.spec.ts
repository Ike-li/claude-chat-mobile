// helpers: tests/helpers/playwright.ts

import { test, expect, type Locator } from '@playwright/test';
import { ensureComposerReady, expectNoBrowserErrors, gotoMock, sendChatMessage } from '../../helpers/playwright';
import { MAIN_WORKSPACE, expandWorkspace, expectSidebarClosed, openSessionsSidebar, openWorkspaceSession } from '../../helpers/sidebar-ui';

// 对话轴分叉：assistant 气泡操作栏的「分叉」按钮（forkSession upToMessageId）。
// 气泡长按 2026-10-26 起交还给系统选字复制，不承载任何动作（见 P0-FORKf）。
//
// 【2026-09-18 起锚点由服务端算】前端只送「这条气泡自己的 uuid + 方向」，upToMessageId 由
// sessions/rewind-plan.js 的 planFork 对着 transcript 解析。原因：工具卡在前端 DOM 里没有
// uuid，「保留轮的最后一条 entry 是 tool_result」这种形态在前端结构上就看不见，而 SDK 的
// forkSession 是纯 inclusive slice、零修正，锚早了它照切、tool_use 就悬空。
// mock 的护栏随之从「只收 assistant 侧 uuid」翻成「uuid 侧别必须与 keepAnchorTurn 一致」。
//
// 【2026-10-26 退役】P0-FORK（长按 assistant 气泡分叉）、P0-FORKc（长按 user 气泡「丢弃这条及之后」）、
// P0-FORKb（长按首条 user 气泡提示「这是最早一条消息」）。不是测试删了，是被测的入口随气泡长按一起没了：
// assistant 侧的分叉由 P0-FORKd 的按钮守；user 侧那个语义就是 /rewind 的「只恢复对话」，
// 服务端同一个 planRewind（rewind-plan.test.mjs）。
test.describe('P0 日常零 token Mock UI 回归', () => {
  test('P0-FORKd assistant 气泡有常驻「分叉」入口，点击直达确认', async ({ page }) => {
    await gotoMock(page);
    await openSessionsSidebar(page);
    await expandWorkspace(page, MAIN_WORKSPACE);
    await openWorkspaceSession(page, MAIN_WORKSPACE, 'Archived Planning Session');
    await expectSidebarClosed(page);
    await expect(page.locator('#messages')).toContainText('Archived plan replay', { timeout: 10_000 });

    // 对齐 Claude Desktop 1.52386.6：它把「Fork from here」放在 assistant 消息的操作栏里，
    // 与复制/朗读同排。本仓此前只有长按一条路——没有视觉提示、且只绑 touch 事件，
    // 桌面鼠标按不出来，真机实测用户在 assistant 气泡上找了半天没找到。
    const bubble = page.locator('[data-testid="assistant-message"]', { hasText: 'Archived plan replay' });
    const forkBtn = bubble.locator('[data-testid="fork-action"]');
    await expect(forkBtn).toBeVisible();
    await forkBtn.click();

    await expect(page.locator('#confirmTitle')).toContainText('分叉', { timeout: 3_000 });
    await page.locator('#confirmOk').click();
    // mock 的护栏要求 assistant 侧必须配 keepAnchorTurn=true，切过去了才说明方向送对了。
    await expect(page.locator('#messages')).toContainText('Forked session ready.', { timeout: 10_000 });
    await expectNoBrowserErrors(page);
  });

  test('P0-FORKe 缺 uuid 的 assistant 消息没有分叉入口', async ({ page }) => {
    await gotoMock(page);
    await openSessionsSidebar(page);
    await expandWorkspace(page, MAIN_WORKSPACE);
    await openWorkspaceSession(page, MAIN_WORKSPACE, 'Long History Session');
    await expectSidebarClosed(page);
    await expect(page.locator('[data-testid="assistant-message"]').first()).toBeVisible({ timeout: 15_000 });

    // 真实 transcript 里有缺 uuid 的旧条目（history.js 同 uuid 去重那段注释点名了这一档），
    // 流式气泡也一样（getStream 建的 wrap 不带 dataset.uuid）。没有锚点就分叉不了：
    // 入口必须跟着锚点走，否则就是摆一个点了必然失败的按钮。
    // 「复制」不需要锚点、仍在——用它确认操作栏本身渲染了，否则整排没出来这条也会绿。
    const first = page.locator('[data-testid="assistant-message"]').first();
    await expect(first.locator('.msg-action-btn')).not.toHaveCount(0);
    await expect(first.locator('[data-testid="fork-action"]')).toHaveCount(0);
    await expectNoBrowserErrors(page);
  });

  // 【2026-10-26 气泡长按还给系统】O136 起气泡长按改认 Android 的 contextmenu 并 preventDefault，
  // 以为拦下它就能压住系统选字。真机上不是：系统选字照样出来，分叉确认又盖在上面，想复制一段文字复制不了。
  // 两条触屏路径都要看：按住不放到点（iOS 长按不发 contextmenu，只有计时这一路），与 Android 的
  // pointerdown → pointercancel（系统接管选字）→ contextmenu。假时钟快进而不是等，越过原来 550ms 的阈值。
  test('P0-FORKf 触屏长按气泡不弹分叉、不拦系统菜单（长按留给系统选字复制）', async ({ page }) => {
    await page.clock.install();
    await gotoMock(page);

    await openSessionsSidebar(page);
    await expandWorkspace(page, MAIN_WORKSPACE);
    await openWorkspaceSession(page, MAIN_WORKSPACE, 'Archived Planning Session');
    await expectSidebarClosed(page);
    await expect(page.locator('#messages')).toContainText('Any follow-up questions?', { timeout: 10_000 });

    await page.evaluate(() => {
      const w = window as unknown as { __ctxPrevented: boolean[] };
      w.__ctxPrevented = [];
      document.addEventListener('contextmenu', ev => {
        w.__ctxPrevented.push(ev.defaultPrevented);
        ev.preventDefault(); // 测试自己收尾，免得无头浏览器真弹菜单
      });
    });
    // 两条都带 uuid（a-archived-* / u-archived-*）：原来正是这两类气泡挂着长按。
    const bubbles = [
      page.locator('[data-testid="assistant-message"]', { hasText: 'Archived plan replay' }),
      page.locator('[data-testid="user-message"]', { hasText: 'Any follow-up questions?' }),
    ];
    for (const bubble of bubbles) {
      const at = await bubbleCenter(bubble);
      const touch = { ...at, pointerType: 'touch', isPrimary: true, button: 0 };
      await bubble.dispatchEvent('pointerdown', touch);
      await page.clock.runFor(1_000);
      await bubble.dispatchEvent('pointerup', touch);

      await bubble.dispatchEvent('pointerdown', touch);
      await bubble.dispatchEvent('pointercancel', touch);
      await bubble.dispatchEvent('contextmenu', at);
      await page.clock.runFor(1_000);
    }

    // 判 classList 不判可见性：假时钟下 sheet 的过渡停在半路，弹出来了也是 visibility:hidden，toBeHidden 恒绿。
    await expect(page.locator('#confirmModal'), '长按气泡弹出了分叉确认，盖住系统选字').toHaveClass(/(^|\s)hidden(\s|$)/);
    expect(await page.evaluate(() => (window as unknown as { __ctxPrevented: boolean[] }).__ctxPrevented),
      'contextmenu 被拦下，系统的复制菜单出不来').toEqual([false, false]);

    await expectNoBrowserErrors(page);
  });

  // 桌面右键要留给浏览器菜单（选中文字后「复制」）。
  test('P0-FORKg 桌面右键气泡：不弹分叉，也不拦浏览器自己的右键菜单', async ({ page }) => {
    await gotoMock(page);

    await openSessionsSidebar(page);
    await expandWorkspace(page, MAIN_WORKSPACE);
    await openWorkspaceSession(page, MAIN_WORKSPACE, 'Archived Planning Session');
    await expectSidebarClosed(page);
    await expect(page.locator('#messages')).toContainText('Archived plan replay from session history.', { timeout: 10_000 });

    await page.evaluate(() => {
      document.addEventListener('contextmenu', ev => {
        (window as unknown as { __ctxPrevented?: boolean }).__ctxPrevented = ev.defaultPrevented;
        ev.preventDefault(); // 测试自己收尾，免得无头浏览器真弹菜单
      });
    });
    const assistantBubble = page.locator('[data-testid="assistant-message"]', { hasText: 'Archived plan replay' });
    await assistantBubble.click({ button: 'right' });

    await expect.poll(() => page.evaluate(() => (window as unknown as { __ctxPrevented?: boolean }).__ctxPrevented))
      .toBe(false);
    await expect(page.locator('#confirmModal')).toBeHidden();

    await expectNoBrowserErrors(page);
  });
});

async function bubbleCenter(bubble: Locator) {
  const box = await bubble.boundingBox();
  if (!box) throw new Error('bubble bounding box not found');
  return { clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 };
}

// ── 文件轴 Rewind ──
test.describe('P0 日常零 token Mock UI 回归 · Rewind', () => {
  // 2026-09-20：入口从「长按 user 气泡弹二选一」换成 /rewind 斜杠命令的两步面板（对齐终端）。
  // 第一步在清单里按【文案】点中某一轮——按下标点的话，mock candidates 换个顺序就悄悄测了另一条。
  // Composer C：空闲无内容时 #btnSend 是 hidden 的，要等 input 事件把它露出来再点
  // （同 helpers/playwright.ts 的 sendChatMessage；press('Enter') 在这个 composer 上不发送）。
  const runRewindCommand = async (page: import('@playwright/test').Page) => {
    await page.locator('#input').fill('/rewind');
    const btnSend = page.locator('#btnSend');
    await expect(btnSend).toBeVisible({ timeout: 5_000 });
    await btnSend.click();
    await expect(page.locator('#rewindModal')).toBeVisible({ timeout: 3_000 });
  };
  const pickRewindTurn = async (page: import('@playwright/test').Page, text: string) => {
    await runRewindCommand(page);
    await page.locator('#rewindList').getByText(text, { exact: false }).click();
    await expect(page.locator('#rewindStep2')).toBeVisible({ timeout: 3_000 });
  };
  const openArchived = async (page: import('@playwright/test').Page) => {
    await gotoMock(page);
    await openSessionsSidebar(page);
    await expandWorkspace(page, MAIN_WORKSPACE);
    await openWorkspaceSession(page, MAIN_WORKSPACE, 'Archived Planning Session');
    await expectSidebarClosed(page);
  };

  test('P0-REWIND /rewind 面板可回退该轮文件，选模式前先列出影响面', async ({ page }) => {
    await openArchived(page);
    await expect(page.locator('#messages')).toContainText('Any follow-up questions?', { timeout: 10_000 });

    // 用【第二轮】：第一轮是会话首条消息，其前面没有可保留的 chain entry，
    // 真 server 的 planRewind 在那一档返回 first-turn（见下一条用例）。
    await pickRewindTurn(page, 'Any follow-up questions?');

    // preview 的影响面必须先摆出来再让人选模式——回退会真改磁盘，选择不能是盲签。
    await expect(page.locator('#rewindEffect')).toContainText('app.js', { timeout: 3_000 });
    // G5 的负向对照：工作区没有会被覆盖的未提交改动时【不该】出现警告。
    // 少了这一条，一个恒警告的实现也能让下面 P0-REWINDd 那条全绿——而恒警告等于没警告。
    await expect(page.locator('#rewindEffect')).not.toContainText('未提交的改动');
    await page.locator('#rewindModeBoth').click();

    // 成功路径的 UI 由 rewind_applied 广播驱动（本机与其他设备同一条路径）。
    // fork 语义：文案必须说清【原会话保留】——这是本方案相对原地截断的核心差异，
    // 用户据此知道回退不是不可逆的。
    await expect(page.locator('#messages')).toContainText('原会话保留', { timeout: 10_000 });

    // prefill：回退的下一步多半是把这句话改一改重说，所以原话要回填输入框
    // （Desktop 的 rewindSession 同样返回 prefill，SDK 的 d.ts 也点名了这个用途）。
    await expect(page.locator('#input')).toHaveValue('Any follow-up questions?', { timeout: 5_000 });
    await expectNoBrowserErrors(page);
  });

  // 【2026-09-20 退役】原 P0-REWINDc「输入框里已有内容时不回填，不覆盖用户正在打的字」。
  // 入口从长按气泡换成 /rewind 斜杠命令之后，这个行为不存在了：要发起回退就得在输入框里
  // 打 /rewind，草稿必然已经被顶掉，于是 prefill 永远落在空输入框上。
  // 不是「测试删了」，是被测的东西随入口一起没了（同 rewind-plan.test.mjs 里那三条的处理）。
  // prefill 本身仍然有效，由 P0-REWIND 那条的末尾断言守着。

  test('P0-REWINDd 文件回了但新会话没建成：如实告知，并说明原会话未受影响', async ({ page }) => {
    await openArchived(page);
    await expect(page.locator('#messages')).toContainText('One more thing please', { timeout: 10_000 });

    await pickRewindTurn(page, 'One more thing please');
    await expect(page.locator('#rewindEffect')).toContainText('app.js', { timeout: 3_000 });
    // G5：这一档的工作区有会被回退覆盖的未提交改动——警告必须摆在【选模式之前】，
    // 事后再说就晚了，那些改动已经没了。
    await expect(page.locator('#rewindEffect')).toContainText('未提交的改动');
    await page.locator('#rewindModeBoth').click();

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
    await pickRewindTurn(page, 'Just run some shell commands');

    // 出路必须是可点的，不能只是一句文案。新面板里出路就是「只恢复对话」那个模式：
    // 两个要动文件的模式置灰，它保持可点——比原先「再弹一个确认框问要不要改用分叉」少一跳。
    await expect(page.locator('#rewindEffect')).toContainText('没有代码改动', { timeout: 3_000 });
    await expect(page.locator('#rewindModeBoth')).toBeDisabled();
    await expect(page.locator('#rewindModeCode')).toBeDisabled();
    await expect(page.locator('#rewindModeConversation')).toBeEnabled();
    await page.locator('#rewindModeConversation').click();

    // 成功文案必须说清【文件没动】——这一档用户选它正是因为文件回不了，
    // 照搬「已回退 0 个文件」那句会让人以为回退过一遍只是没东西可回。
    await expect(page.locator('#messages')).toContainText('文件未改动', { timeout: 10_000 });
    await expect(page.locator('#messages')).toContainText('原会话保留');
    await expectNoBrowserErrors(page);
  });

  test('P0-REWINDk 找不到快照与没有文件改动是两种成因，文案不能混', async ({ page }) => {
    await openArchived(page);
    await expect(page.locator('#messages')).toContainText('An old turn with no snapshot', { timeout: 10_000 });

    // 与 P0-REWINDj 互为对照：两档都走「canRewind:false → 指向分叉」，但成因不同。
    // 把「没有文件改动」扣到这一档头上是假话——这一轮可能改了一堆文件，只是快照没了。
    // 判据写反时两条会同时红（这条断不该出现的词，那条断该出现的词）。
    await pickRewindTurn(page, 'An old turn with no snapshot');

    await expect(page.locator('#rewindEffect')).toContainText('快照', { timeout: 3_000 });
    await expect(page.locator('#rewindEffect')).not.toContainText('没有代码改动');
    // 出路仍然要给——成因不影响「只恢复对话」这条路可走。
    await expect(page.locator('#rewindModeConversation')).toBeEnabled();
    await expect(page.locator('#rewindModeCode')).toBeDisabled();
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
    await pickRewindTurn(page, 'Switch away while I decide');
    // preview 已经回来了，面板停在第二步等用户选模式；此时 mock 那条 instances 广播已把
    // displayedSessionId 换掉。点下去必须被拦住。
    await expect(page.locator('#rewindEffect')).toBeVisible({ timeout: 3_000 });
    // 这一档 preview 判这一轮没有可回退的文件，两个要动文件的模式是置灰的——
    // 点「只恢复对话」，拦截与选哪个模式无关。
    await page.locator('#rewindModeConversation').click();

    // 拦截发生在面板内部，提示也留在面板里（写进消息流的话会被 sheet 盖住，用户看不到）。
    await expect(page.locator('#rewindEffect')).toContainText('会话已切换', { timeout: 5_000 });
    // 反向断言：绝不能真的对旧锚点执行回退、切到分叉出来的新会话去。
    await expect(page.locator('#messages')).not.toContainText('Forked session ready.');
    await expectNoBrowserErrors(page);
  });

  // 与 P0-REWINDm 同源、只差一个取值：那条切到【另一个会话】，这条回到【首页】。
  // 守卫若写成 `now?.sessionId && now.sessionId !== frozen`，sessionId 变 null 时条件短路、
  // 整个守卫失效，仍会对冻结的旧会话执行破坏性回退（PR #102 review 的 P1）。
  // 两条必须都在：只留 m 那条的话，把判据写成 `now?.sessionId &&` 照样全绿。
  test('P0-REWINDn 面板开着时回到首页：同样拒绝，不对已离开的会话动手', async ({ page }) => {
    await openArchived(page);
    await expect(page.locator('#messages')).toContainText('Go home while I decide', { timeout: 10_000 });

    await pickRewindTurn(page, 'Go home while I decide');
    // preview 已经回来了（这一档 canRewind:true，三个模式都亮着），而 mock 那条广播已把
    // viewing 清空。点下去必须被拦住。
    await expect(page.locator('#rewindEffect')).toContainText('app.js', { timeout: 3_000 });
    await page.locator('#rewindModeBoth').click();

    await expect(page.locator('#rewindEffect')).toContainText('会话已切换', { timeout: 5_000 });
    await expect(page.locator('#messages')).not.toContainText('Forked session ready.');
    await expectNoBrowserErrors(page);
  });

  test('P0-REWINDb 会话首条消息：不能分叉对话，但仍可只恢复代码', async ({ page }) => {
    await openArchived(page);
    await expect(page.locator('#messages')).toContainText('Summarize archived plan', { timeout: 10_000 });

    await runRewindCommand(page);

    // 首轮之前没有可保留的锚点（planRewind 判 first-turn），分叉会退化成复制一个空会话。
    // 但那是【对话轴】的限制——文件快照照样能还原，所以这一轮仍然可选，只是模式受限。
    // 压成一个 canRewind 会让单轮会话完全用不了 Restore code，而终端能（PR #102 review）。
    await expect(page.locator('#rewindList')).toContainText('只能恢复代码', { timeout: 3_000 });
    await page.locator('#rewindList').getByText('Summarize archived plan', { exact: false }).click();
    await expect(page.locator('#rewindStep2')).toBeVisible({ timeout: 3_000 });
    await expect(page.locator('#rewindModeConversation')).toBeDisabled();
    await expect(page.locator('#rewindModeBoth')).toBeDisabled();
    await expect(page.locator('#rewindModeCode')).toBeEnabled();

    // 文案不能描述另一个操作：这一档唯一可点的动作不 fork，照说「将分叉出新会话」是假话。
    await expect(page.locator('#rewindEffect')).not.toContainText('分叉出新会话');
    await expect(page.locator('#rewindEffect')).toContainText('无法分叉对话');

    // 【这个按钮必须真能用】只改 preview 放行、confirm 那边照旧拒 first-turn 的话，
    // 它就是点了必然报错的假选项（PR #104 review）。点下去要真成功。
    await page.locator('#rewindModeCode').click();
    await expect(page.locator('#messages')).toContainText('对话未改动', { timeout: 10_000 });
    await expect(page.locator('#rewindModal')).toBeHidden();
    await openArchived(page);
    await expect(page.locator('#messages')).toContainText('Summarize archived plan', { timeout: 10_000 });
    await runRewindCommand(page);

    // 正常轮次三个模式都开着——否则一个「永远只留 Restore code」的实现也能让上面全绿。
    await page.locator('#rewindList').getByText('Any follow-up questions?', { exact: false }).click();
    await expect(page.locator('#rewindModeConversation')).toBeEnabled({ timeout: 3_000 });
    await expect(page.locator('#rewindModeBoth')).toBeEnabled();
    await expectNoBrowserErrors(page);
  });
});
