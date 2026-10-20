// helpers: tests/helpers/playwright.ts

import { test, expect } from '@playwright/test';
import { expectNoBrowserErrors, gotoMock, sendChatMessage, waitForIdle } from '../../helpers/playwright';

// 验收 O59（AC-13-12）：两个页面开着同一会话，A 发 /context，B 实时看到用户气泡、转圈和完成行，却看不到
// Context Usage 表，刷新后才从磁盘补上。真 server 上复现过（S2，fake-claude 本地命令档）：A、B 收到的事件
// 逐条一致，都有那条 local-cmd 的 text_delta——丢在 B 的前端。
//
// 本地命令的输出是【一条】增量紧跟着 result。result 到达时 finalizeStreams 先清掉 80ms 的预览定时器，正文
// 只在 requestAnimationFrame 里写进气泡；浏览器对后台标签页暂停 rAF，于是 B（同一浏览器里的另一个标签页）
// 气泡一直是空的。用户气泡、转圈、完成行都是同步写 DOM，所以都看得到——和观察一字不差。普通回复的增量
// 持续几秒，预览早已渲染过，不露馅。
// 这里把 B 的 rAF 挂起（只排队、不执行）来模拟后台标签页。
test.describe('本地命令输出：所有开着这个会话的页面都看得到', () => {
  test('P0-LOCAL-CMD-1 后台标签页（rAF 暂停）也写进本地命令的输出，不留空气泡', async ({ page, context }) => {
    const observer = await context.newPage();
    await observer.addInitScript(() => {
      const queued: FrameRequestCallback[] = [];
      (window as any).__rafQueued = queued;
      window.requestAnimationFrame = (cb: FrameRequestCallback) => { queued.push(cb); return queued.length; };
    });
    await gotoMock(observer);
    await gotoMock(page);

    await sendChatMessage(page, 'test:local-command-output');
    await waitForIdle(page);
    await expect(page.locator('[data-testid="assistant-message"]').last()).toContainText('Context Usage');

    // 栅栏：完成行（同步写 DOM）已到 ⇒ result 已处理、finalizeStreams 已经跑过
    await expect(observer.locator('#messages')).toContainText('✻');
    await expect(observer.locator('[data-testid="assistant-message"]').last()).toContainText('Context Usage');
    await expect(observer.locator('[data-testid="assistant-message"]').last().locator('table')).toHaveCount(1);
    await expectNoBrowserErrors(page);
  });
});
