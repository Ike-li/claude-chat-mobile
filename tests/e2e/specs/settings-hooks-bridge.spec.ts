// spec: 配置面板「终端会话推送」段（CLI hooks 桥的手机端开关）。
// helpers: tests/helpers/playwright.ts
//
// 为什么锁在配置面板而不是服务状态诊断页：这是**手机上唯一**能开这个能力的入口（npm 命令只能在
// 电脑终端跑），而它又是终端直跑会话唯一能推到手机的通道。第一版放进了服务状态页，实测直接
// 没找到——位置错了，遂移到通知这一组（与提示音/震动同一心智）。

import { test, expect } from '@playwright/test';
import { expectNoBrowserErrors, gotoMock, openGeneralSettings, sendChatMessage, waitForIdle } from '../../helpers/playwright';

test.describe('P0 日常零 token Mock UI 回归', () => {
  test('P0-25 终端会话推送：未装显示开启按钮 → 二次确认 → 翻为已启用', async ({ page }) => {
    await gotoMock(page);
    await waitForIdle(page);

    await openGeneralSettings(page);
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

    await openGeneralSettings(page);
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

    await openGeneralSettings(page);
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

    await openGeneralSettings(page);
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

    await openGeneralSettings(page);
    const row = page.locator('#pushStatusRow');
    await expect(row).not.toBeEmpty();
    await expect(row).toContainText(/未开启|已开启|不可用|已被拒绝|未完成订阅/);

    await expectNoBrowserErrors(page);
  });
});
