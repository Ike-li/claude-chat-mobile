// helpers: tests/helpers/playwright.ts

import { test, expect, type Locator } from '@playwright/test';
import { expectNoBrowserErrors, gotoMock, sendChatMessage, waitForIdle } from '../../helpers/playwright';

// 验收 O25 / O90（AC-22-03、AC-06-03、AC-09-14）：用户气泡原来和助手回复共用 markdown + sanitize 渲染，
// 打的 <Header> 被吞掉、<div className="wrap"> 变成真实块元素、<b> 变粗体、**…** 变加粗，连续空格被压成一个。
// 服务端收到的是原文，只是显示和终端里看到的不一样，用户会以为自己的话被截断了。用户气泡改成纯文本，
// 保留换行与空白；助手回复的 markdown 不变（另由 stream-markdown-thinking-result 的 P0-03d 守着）。
//
// 三个建出点各验一条（见 mock 的 test:raw-user）：发出去的这条（乐观气泡转正）、LIVE（在线新建）、HIST（历史渲染）。
const rawText = (label: string) => `${label} <Header> keep <div className="wrap">w</div> <b>${label}-b</b> **${label}-star**\n  two  spaces`;

async function expectVerbatim(bubble: Locator, text: string) {
  // 先看用户看得见的症状：尖括号原文在不在
  await expect(bubble).toContainText('<Header>');
  await expect(bubble).toContainText(`**`);
  // 没有被当成标签渲染出来的元素
  await expect(bubble.locator('b, strong, em, header, div.wrap')).toHaveCount(0);
  // 换行与连续空格原样保留（toContainText 会规整空白，这里按 DOM 原文比）
  const shown = await bubble.evaluate(el => {
    const node = el.querySelector('[data-testid="user-text"]');
    return node ? { text: node.textContent, ws: getComputedStyle(node).whiteSpace } : null;
  });
  expect(shown).toEqual({ text, ws: 'pre-wrap' });
}

test.describe('用户气泡保真：按纯文本显示', () => {
  test('P0-USER-RAW 三个建出点的用户气泡都原样显示尖括号、星号、换行与连续空格', async ({ page }) => {
    await gotoMock(page);
    const sent = `test:raw-user ${rawText('SENT')}`;
    await sendChatMessage(page, sent);
    await waitForIdle(page);

    const users = page.locator('[data-testid="user-message"]');
    await expectVerbatim(users.filter({ hasText: 'test:raw-user' }), sent);
    await expectVerbatim(users.filter({ hasText: 'LIVE' }), rawText('LIVE'));
    await expectVerbatim(users.filter({ hasText: 'HIST' }), rawText('HIST'));

    // 「改写重发」照旧填回原文
    await users.filter({ hasText: 'test:raw-user' }).getByRole('button', { name: /改写重发/ }).click();
    await expect(page.locator('#input')).toHaveValue(sent);
    await expectNoBrowserErrors(page);
  });
});
