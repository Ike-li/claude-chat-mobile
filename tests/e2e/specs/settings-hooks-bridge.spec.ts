// spec: 配置面板「终端会话推送」段（CLI hooks 桥的手机端开关）。
// helpers: tests/helpers/playwright.ts
//
// 为什么锁在配置面板而不是服务状态诊断页：这是**手机上唯一**能开这个能力的入口（npm 命令只能在
// 电脑终端跑），而它又是终端直跑会话唯一能推到手机的通道。第一版放进了服务状态页，实测直接
// 没找到——位置错了，遂移到通知这一组（与提示音/震动同一心智）。

import { test, expect } from '@playwright/test';
import { expectNoBrowserErrors, gotoMock, openGeneralPage, sendChatMessage, waitForIdle } from '../../helpers/playwright';

test.describe('P0 日常零 token Mock UI 回归', () => {
  test('P0-25 终端会话推送：未装显示开启按钮 → 二次确认 → 翻为已启用', async ({ page }) => {
    await gotoMock(page);
    await waitForIdle(page);

    await openGeneralPage(page, 'host');
    const section = page.locator('#hooksBridgeSection');
    await expect(section).toBeVisible();
    await expect(section).toContainText('未启用');
    await expect(section).toContainText('手机会收到通知');

    // 写用户全局 ~/.claude/settings.json 之前必须先确认——这是 server 唯一会动那个文件的路径
    await section.locator('[data-testid="hooks-bridge-action"]').click();
    await expect(page.locator('#confirmSheet')).toBeVisible();
    await expect(page.locator('#confirmSheet')).toContainText('~/.claude/settings.json');
    await page.locator('#confirmOk').click();

    await expect(section).toContainText('已启用');
    await expect(section.locator('[data-testid="hooks-bridge-action"]')).toHaveText('关闭');

    await expectNoBrowserErrors(page);
  });

  test('P0-25b 已装状态下整段显示为已启用（server 广播的安装态直接驱动渲染）', async ({ page }) => {
    await gotoMock(page);
    // 注：test: 夹具命令不产生正常回合终态，不能用 waitForIdle 收口（会一直等 #streamLiveStatus 消失）
    await sendChatMessage(page, 'test:hooks-installed');

    await openGeneralPage(page, 'host');
    const section = page.locator('#hooksBridgeSection');
    await expect(section).toContainText('已启用');

    await expectNoBrowserErrors(page);
  });

  // 服务端读 ~/.claude 出错（文件损坏/权限变更）时广播 state:'unknown'。这一档早先与「旧 server 不带
  // 该字段」同判 null，整段静默消失——而这是手机上唯一能看到 hooks 桥的入口（见本文件头注），消失
  // 即彻底失联：既不知道有这功能，也无从判断是不是坏了。现在就地说明，且仍不误报成"未启用"。
  test('P0-25c 安装态读取失败：整段不消失，说读不出来而不是说没装', async ({ page }) => {
    await gotoMock(page);
    await sendChatMessage(page, 'test:hooks-unknown');

    await openGeneralPage(page, 'host');
    const section = page.locator('#hooksBridgeSection');
    // 核心：段落还在。修复前这里是 hidden——用户在手机上再也看不到这个功能存在过
    await expect(section).toBeVisible();
    await expect(section).toContainText('状态读取失败');
    await expect(section).toContainText('settings.json');
    // 不得误报装了或没装（原判据要守住的正是这条，不能为了不留白就退回误报）
    await expect(section).not.toContainText('未启用');
    await expect(section).not.toContainText('已启用');
    // 状态未知时不给一键按钮：盲点「开启」可能覆盖一份其实存在、只是没读成功的配置
    await expect(section.locator('[data-testid="hooks-bridge-action"]')).toHaveCount(0);

    await expectNoBrowserErrors(page);
  });

  // 「发一条测试推送」：今晚这条链路的教训——用户没有任何办法自证推送通不通，只能等真事件，
  // 于是"从未订阅成功"被误当成"这功能没用"。未订阅时必须明说，而不是假装发出去了。
  test('P0-26 测试推送：未订阅时如实告知没有收件人，不谎报成功', async ({ page }) => {
    await gotoMock(page);
    await waitForIdle(page);

    await openGeneralPage(page, 'notify');
    await page.locator('#btnPushTest').click();
    await expect(page.locator('#messages')).toContainText('还没订阅推送');

    await expectNoBrowserErrors(page);
  });

  // P0-27：点齿轮打开面板后，推送订阅状态行必须真的渲染出来。
  // 这条是真机截图逼出来的——首版把渲染挂在 app.js 自己的 openSettingsSheet 包装上，可齿轮按钮是
  // settings 控制器 autoBind 到它自己的 open() 的，包装从不生效，于是整行在真机上永远空白。
  test('P0-27 点齿轮打开配置面板 → 推送订阅状态行渲染出来（不是空 div）', async ({ page }) => {
    await gotoMock(page);
    await waitForIdle(page);

    await openGeneralPage(page, 'notify');
    const row = page.locator('#pushStatusRow');
    await expect(row).not.toBeEmpty();
    await expect(row).toContainText(/未开启|已开启|已关闭|不可用|已被拒绝|未完成订阅/);

    await expectNoBrowserErrors(page);
  });

  // 「自己关掉的」与「订阅失败了」在 permission/subscribed 两个维度上完全同形，只有 opt-out 这个
  // 意图分得开。不读它，用户刚主动关掉推送，面板就用警告色报一句「未完成订阅」——把成功说成故障。
  // headless 里造不出真 push subscription（getSubscription() 恒 null），但 opt-out 这一态不需要：
  // 它正是「没有订阅 + 用户关过」，恰好是真机上关掉推送后刷新看到的那一屏。
  test('P0-27b 主动关掉推送后：状态行说「已关闭」而不是警告色的「未完成订阅」', async ({ page }) => {
    // headless Chromium 的 Notification.permission 恒 'denied'，那会落进 denied 分支（它排在
    // optedOut 之前，且**必须**排在前面：权限被拒时说「随时可以重新开启」是假话，点开启必然失败）。
    // 这里要测的是「权限还在、只是自己关掉了」，所以得把权限造成 granted。
    // 不用 context.grantPermissions(['notifications'])：实测它改不动 Notification.permission
    // （授权前后都是 denied），只影响 Permissions API 的 query。覆写这个只读属性是唯一的办法。
    await page.addInitScript(() => {
      localStorage.setItem('ccm_push_opt_out', '1');
      Object.defineProperty(Notification, 'permission', { configurable: true, get: () => 'granted' });
    });
    await gotoMock(page);
    await waitForIdle(page);

    await openGeneralPage(page, 'notify');
    const row = page.locator('#pushStatusRow');
    await expect(row).toContainText('已关闭');
    await expect(row).not.toContainText('未完成订阅');
    // 关掉之后仍然给得出「再开」这条路，不是死路
    await expect(row.locator('[data-testid="push-subscribe"]')).toBeVisible();

    await expectNoBrowserErrors(page);
  });

  // 缺口 2：statusline 桥此前在 web 上整段隐身——service:status 连字段都没有，只能回电脑敲
  // npm run statusline:status。两个桥在 CLAUDE.md 里是并列的，web 上待遇不该差一个量级。
  test('P0-25d 终端状态栏（statusline 桥）：未装显示开启按钮 → 二次确认 → 翻为已启用', async ({ page }) => {
    await gotoMock(page);
    await openGeneralPage(page, 'host');

    const section = page.locator('#statuslineBridgeSection');
    await expect(section).toBeVisible();
    // 与 hooks 桥并列同屏——它们是同一件事的两半，分居两处会让人以为只有一个
    await expect(page.locator('#hooksBridgeSection')).toBeVisible();

    const action = page.locator('[data-testid="statusline-bridge-action"]');
    await expect(action).toBeVisible();
    await action.click();

    // 改的是用户全局 ~/.claude/settings.json，必须二次确认
    await expect(page.locator('#confirmSheet')).toBeVisible();
    await page.locator('#confirmOk').click();

    await expect(section).toContainText('已启用');
    // 已装态下按钮翻成「关闭」，不再是「开启」
    await expect(action).toHaveText('关闭');

    await expectNoBrowserErrors(page);
  });

});
