// helpers: tests/helpers/playwright.ts
// MCP elicitation（#460）：服务器要表单输入或 URL 授权时，手机上能看到并作答（以前 SDK 自动 decline，工具静默失败）。
// 服务端的 schema 归一与作答校验由 tests/unit/elicitation.test.mjs、tests/unit/agent-elicitation.test.mjs 与
// tests/integration/elicitation.test.mjs 守；这里守界面：按字段描述画表单、拒收原因留在 sheet 里、URL 卡显示完整
// origin 并在点击里打开、等服务器确认后关卡、第三方文本按纯文本显示。

import { test, expect } from '@playwright/test';
import { expectNoBrowserErrors, gotoMock, sendChatMessage, waitUntilConnected } from '../../helpers/playwright';

const sheet = (page: import('@playwright/test').Page) => page.locator('#elicitationModal');
const elicitationLog = async (page: import('@playwright/test').Page) => (await page.request.get('/__elicitation-log')).json();

test.describe('MCP elicitation', () => {
  test('P0-ELICIT-1 表单：按字段描述画控件；不合法被拒收、原因留在 sheet 里；改对了交上去的是控件里的值', async ({ page }) => {
    await gotoMock(page);
    await sendChatMessage(page, 'test:elicitation-form');

    await expect(sheet(page)).toHaveClass(/sheet-open/);
    await expect(page.getByTestId('elicitation-heading')).toContainText('新建笔记');
    await expect(page.getByTestId('elicitation-server')).toContainText('mock-notes');
    await expect(page.getByTestId('elicitation-message')).toHaveText('新笔记叫什么？');
    const name = page.getByTestId('elicitation-field-name').locator('input');
    const pin = page.getByTestId('elicitation-field-pin').locator('input[type="checkbox"]');
    const color = page.getByTestId('elicitation-field-color').locator('select');
    await expect(page.getByTestId('elicitation-field-name')).toContainText('名字 *');

    await name.fill('x');
    await page.getByTestId('elicitation-accept').click();
    await expect(page.getByTestId('elicitation-error')).toHaveText('「名字」至少 2 个字');
    await expect(sheet(page)).toHaveClass(/sheet-open/);
    await expect(name).toHaveValue('x');

    await name.fill('周报');
    await pin.check();
    await color.selectOption('g');
    await page.getByTestId('elicitation-accept').click();
    await expect(sheet(page)).not.toHaveClass(/sheet-open/);
    const log = await elicitationLog(page);
    expect(log.at(-1)).toMatchObject({ requestId: 'mock-elicit-form', action: 'accept', content: { name: '周报', pin: true, color: 'g' } });
    expect(log.at(-1).instanceId).toBe('inst_1');

    await expectNoBrowserErrors(page);
  });

  test('P0-ELICIT-2 URL 授权：卡上显示完整 origin；「在浏览器打开」在点击里打开链接，等服务器确认完成后关卡', async ({ page }) => {
    await gotoMock(page);
    await page.evaluate(() => {
      (window as any).__opened = [];
      window.open = ((...args: unknown[]) => { (window as any).__opened.push(args); return null; }) as typeof window.open;
    });
    await sendChatMessage(page, 'test:elicitation-url');

    await expect(sheet(page)).toHaveClass(/sheet-open/);
    await expect(page.getByTestId('elicitation-url-origin')).toHaveText('https://auth.example.com');
    await expect(page.getByTestId('elicitation-url-local')).toBeHidden();
    await expect(page.getByTestId('elicitation-form')).toBeHidden();
    await expect(page.getByTestId('elicitation-accept')).toHaveText('在浏览器打开');

    await page.getByTestId('elicitation-accept').click();
    expect(await page.evaluate(() => (window as any).__opened)).toEqual([['https://auth.example.com/authorize?state=1', '_blank', 'noopener']]);
    await expect(page.getByTestId('elicitation-waiting')).toBeVisible();
    await expect(sheet(page)).not.toHaveClass(/sheet-open/); // mock 300ms 后发 elicitation_complete
    await expect(page.locator('#messages')).toContainText('mock-notes 已确认授权完成');
    expect((await elicitationLog(page)).at(-1)).toMatchObject({ requestId: 'mock-elicit-url', action: 'accept' });

    await expectNoBrowserErrors(page);
  });

  test('P0-ELICIT-4 刷新 / 重连后按 sync:since 的 pending 快照重建卡片，照样能作答', async ({ page }) => {
    await gotoMock(page);
    await sendChatMessage(page, 'test:elicitation-form');
    await expect(sheet(page)).toHaveClass(/sheet-open/);

    await page.reload();
    await waitUntilConnected(page);
    await expect(sheet(page)).toHaveClass(/sheet-open/);
    await expect(page.getByTestId('elicitation-heading')).toContainText('新建笔记');
    await page.getByTestId('elicitation-field-name').locator('input').fill('重连后');
    await page.getByTestId('elicitation-accept').click();
    await expect(sheet(page)).not.toHaveClass(/sheet-open/);
    expect((await elicitationLog(page)).at(-1)).toMatchObject({ requestId: 'mock-elicit-form', action: 'accept', content: { name: '重连后' } });

    await expectNoBrowserErrors(page);
  });

  test('P0-ELICIT-3 message 里的 HTML 按纯文本显示；拒绝交的是 decline', async ({ page }) => {
    await gotoMock(page);
    await sendChatMessage(page, 'test:elicitation-html');

    const message = page.getByTestId('elicitation-message');
    await expect(message).toHaveText('<img src=x onerror="window.__elicitXss=1"><b>粗体</b>');
    await expect(message.locator('img, b')).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).__elicitXss)).toBeUndefined();

    await page.getByTestId('elicitation-decline').click();
    await expect(sheet(page)).not.toHaveClass(/sheet-open/);
    expect((await elicitationLog(page)).at(-1)).toMatchObject({ requestId: 'mock-elicit-html', action: 'decline' });

    await expectNoBrowserErrors(page);
  });
});
