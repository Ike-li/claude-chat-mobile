// helpers: tests/helpers/playwright.ts

import { test, expect } from '@playwright/test';
import { expectNoBrowserErrors, gotoMock, sendChatMessage } from '../../helpers/playwright';

// 回来时的会话摘要（CCM_SESSION_RECAP）。真 server 侧挂在 client:presence 的「回来」那一拍上
// （app/src/server/app.js maybeRecapOnReturn）——**只有那里知道离开了多久**：CLI 那边靠终端焦点，
// 本产品靠客户端主动上报的 presence，而手机上「放下手机又拿起来」只有后者看得见（终端从头到尾
// 没失焦过）。准入判据（离开时长/轮数/最小间隔/是否在跑）在 side-question.js，有单测覆盖；
// 这里只测**前端那一段**：事件到了要渲染成提示条，且空文本不渲染。
//
// mock 侧观察到 hidden true→false 的跳变就发一条固定文案的 session_recap。
async function setPageHidden(page: import('@playwright/test').Page, hidden: boolean) {
  await page.evaluate((h) => {
    Object.defineProperty(document, 'hidden', { value: h, configurable: true });
    Object.defineProperty(document, 'visibilityState', { value: h ? 'hidden' : 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
}

test.describe('回来时的会话摘要', () => {
  test('RECAP-1 离开再回来 → 消息流里出现一条带「回顾」前缀的摘要提示条', async ({ page }) => {
    await gotoMock(page);
    await sendChatMessage(page, 'test:tool'); // 先有点内容，摘要才有落点

    const messages = page.locator('#messages');
    await expect(messages).not.toContainText('回顾');

    await setPageHidden(page, true);   // 放下手机
    await setPageHidden(page, false);  // 回来

    // 走 addBar（与 interrupted/queue_dropped 同一视觉层级），不是新造气泡
    await expect(messages).toContainText('回顾', { timeout: 10_000 });
    await expect(messages).toContainText('正在给 agent.js 补测试');

    await expectNoBrowserErrors(page);
  });

  test('RECAP-2 只是切走没回来（单向 hidden）→ 不出现摘要', async ({ page }) => {
    await gotoMock(page);
    await sendChatMessage(page, 'test:tool');

    // **反向锚点**：mock 只在观察到 true→false 跳变时才发。若哪天把它改成"每次 presence 都发"，
    // 或前端把 handler 接到了别的事件上，这条会红而 RECAP-1 照样绿。
    await setPageHidden(page, true);

    await expect(page.locator('#messages')).not.toContainText('回顾');
    await expectNoBrowserErrors(page);
  });
});
