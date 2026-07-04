// spec: specs/claude-chat-mobile-comprehensive-test-plan.md
// seed: tests/seed.goto-mock.spec.ts

import { test, expect } from '@playwright/test';
import { expectNoBrowserErrors, gotoMock } from '../seed.goto-mock.spec';

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
});
