// spec: specs/claude-chat-mobile-comprehensive-test-plan.md
// seed: tests/seed.goto-mock.spec.ts

import { test, expect } from '@playwright/test';
import { expectNoBrowserErrors, gotoMock, sendChatMessage, waitForIdle } from '../seed.goto-mock.spec';

const tinyPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64'
);

test.describe('P0 日常零 token Mock UI 回归', () => {
  test('P0-18 文件/图片上传、附件 chip 与前端边界', async ({ page }) => {
    await gotoMock(page);

    // 1. 上传一个小文本文件和一张小图片，附件托盘显示 chip。
    await page.locator('#fileInput').setInputFiles([
      { name: 'note.txt', mimeType: 'text/plain', buffer: Buffer.from('hello attachment') },
      { name: 'shot.png', mimeType: 'image/png', buffer: tinyPng }
    ]);
    await expect(page.locator('#attachTray')).toBeVisible();
    await expect(page.locator('#attachTray')).toContainText('note.txt');
    await expect(page.locator('#attachTray')).toContainText('shot.png');
    await expect(page.locator('#btnSend')).toBeEnabled();

    // 2. 发送后附件托盘清空；超限数量给出用户可见错误。
    await page.locator('#btnSend').click();
    await expect(page.locator('#attachTray')).toBeHidden();
    await page.locator('#fileInput').setInputFiles(
      Array.from({ length: 11 }, (_, index) => ({
        name: `file-${index}.txt`,
        mimeType: 'text/plain',
        buffer: Buffer.from(`file ${index}`)
      }))
    );
    await expect(page.locator('#messages')).toContainText('附件数量已达上限');

    await expectNoBrowserErrors(page);
  });

  test('P0-18b 附件超限被拒且重复选择同一文件仍生效', async ({ page }) => {
    await gotoMock(page);

    await page.locator('#fileInput').setInputFiles({
      name: 'too-large.txt',
      mimeType: 'text/plain',
      buffer: Buffer.alloc(10 * 1024 * 1024 + 1, 'x')
    });
    await expect(page.locator('#messages')).toContainText('「too-large.txt」超过 10MB，未添加');
    await expect(page.locator('#attachTray')).toBeHidden();
    await expect(page.locator('#btnSend')).toBeDisabled();

    const repeatFile = { name: 'repeat.txt', mimeType: 'text/plain', buffer: Buffer.from('repeatable attachment') };
    await page.locator('#fileInput').setInputFiles(repeatFile);
    await expect(page.locator('#attachTray').getByText('repeat.txt')).toHaveCount(1);
    await page.locator('#fileInput').setInputFiles(repeatFile);
    await expect(page.locator('#attachTray').getByText('repeat.txt')).toHaveCount(2);
    await expect(page.locator('#btnSend')).toBeEnabled();

    await expectNoBrowserErrors(page);
  });

  test('P0-18c 附件总量超限与无扩展名通用附件回显', async ({ page }) => {
    await gotoMock(page);

    await page.locator('#fileInput').setInputFiles([
      { name: 'total-a.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(7 * 1024 * 1024, 'a') },
      { name: 'total-b.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(7 * 1024 * 1024, 'b') },
      { name: 'total-c.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(7 * 1024 * 1024, 'c') }
    ]);
    await expect(page.locator('#messages')).toContainText('附件总量将超过 20MB，未添加');
    await expect(page.locator('#attachTray')).toContainText('total-a.bin');
    await expect(page.locator('#attachTray')).toContainText('total-b.bin');
    await expect(page.locator('#attachTray')).not.toContainText('total-c.bin');

    await gotoMock(page);
    await page.locator('#fileInput').setInputFiles({
      name: 'LICENSE',
      mimeType: '',
      buffer: Buffer.from('unknown attachment type')
    });
    await expect(page.locator('#attachTray')).toContainText('LICENSE');
    await page.locator('#input').fill('send unknown attachment');
    await page.locator('#btnSend').click();
    await expect(page.locator('#attachTray')).toBeHidden();
    const sent = page.locator('[data-testid="user-message"]').last();
    await expect(sent).toContainText('send unknown attachment');
    await expect(sent).toContainText('LICENSE');

    await expectNoBrowserErrors(page);
  });

  test('P0-18d 切换会话会清空未发送附件避免串线', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:tab');
    await waitForIdle(page);
    await page.locator('#fileInput').setInputFiles({
      name: 'cross-session.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('must not leak to another session')
    });
    await expect(page.locator('#attachTray')).toContainText('cross-session.txt');

    await page.locator('#btnSessions').click();
    await page.locator('div[data-dir="/Users/you/code/another-react-project"] button').first().click();
    await page.locator('button[title="Another App Concurrency"]').click();
    await expect(page.locator('#topProjectText')).toContainText('another-react-project');
    await expect(page.locator('#attachTray')).toBeHidden();
    await expect(page.locator('#btnSend')).toBeDisabled();

    await sendChatMessage(page, 'test:settings-echo');
    await waitForIdle(page);
    const sent = page.locator('[data-testid="user-message"]').last();
    await expect(sent).toContainText('test:settings-echo');
    await expect(sent).not.toContainText('cross-session.txt');

    await expectNoBrowserErrors(page);
  });
});
