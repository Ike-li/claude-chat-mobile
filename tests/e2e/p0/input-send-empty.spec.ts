// spec: docs/testing.md
// helpers: tests/helpers/playwright.ts

import { test, expect } from '@playwright/test';
import { closeSettings, ensureComposerReady, expectNoBrowserErrors, gotoMock, openSettingsSection, sendChatMessage, waitForIdle } from '../../helpers/playwright';

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
    await expect(page.locator('#connDot')).toHaveClass(/bg-danger/, { timeout: 10_000 });

    await page.locator('#input').fill('test:settings-echo');
    await expect(page.locator('#btnSend')).toBeEnabled();
    await page.locator('#btnSend').click();
    await expect(page.locator('.pending-indicator').last()).toContainText('正在等待连接');
    await expect(page.locator('#input')).toHaveValue('');

    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(page.locator('#connDot')).toHaveClass(/bg-success/, { timeout: 10_000 });
    await waitForIdle(page);
    await expect(page.locator('[data-testid="assistant-message"]').last()).toContainText('设置回显：model=');

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
