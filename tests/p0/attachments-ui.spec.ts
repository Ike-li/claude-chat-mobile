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

  test('P0-18c 附件总量超过 20MB 时拒绝新增文件', async ({ page }) => {
    await gotoMock(page);

    await page.locator('#fileInput').setInputFiles([
      { name: 'bundle-a.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(10 * 1024 * 1024, 'a') },
      { name: 'bundle-b.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(10 * 1024 * 1024, 'b') },
      { name: 'overflow.bin', mimeType: 'application/octet-stream', buffer: Buffer.from('x') }
    ]);

    await expect(page.locator('#attachTray')).toContainText('bundle-a.bin');
    await expect(page.locator('#attachTray')).toContainText('bundle-b.bin');
    await expect(page.locator('#attachTray')).not.toContainText('overflow.bin');
    await expect(page.locator('#messages')).toContainText('附件总量将超过 20MB，未添加');
    await expect(page.locator('#attachTray').getByText(/bundle-[ab]\.bin/)).toHaveCount(2);
    await expect(page.locator('#btnSend')).toBeEnabled();

    await expectNoBrowserErrors(page);
  });

  test('P0-18d 无扩展名未知类型文件按通用附件处理', async ({ page }) => {
    await gotoMock(page);

    await page.locator('#fileInput').setInputFiles({
      name: 'README',
      mimeType: '',
      buffer: Buffer.from('plain file without an extension')
    });

    await expect(page.locator('#attachTray')).toBeVisible();
    await expect(page.locator('#attachTray')).toContainText('README');
    await expect(page.locator('#attachTray img')).toHaveCount(0);
    await expect(page.locator('#btnSend')).toBeEnabled();

    await expectNoBrowserErrors(page);
  });

  test('P0-18e 发送后用户消息回显附件元数据并清空托盘', async ({ page }) => {
    await gotoMock(page);

    await page.locator('#fileInput').setInputFiles([
      { name: 'context.txt', mimeType: 'text/plain', buffer: Buffer.from('context for Claude') },
      { name: 'screen.png', mimeType: 'image/png', buffer: tinyPng }
    ]);
    await page.locator('#input').fill('请看附件');
    await expect(page.locator('#btnSend')).toBeEnabled();
    await page.locator('#btnSend').click();

    const userMessage = page.locator('[data-testid="user-message"]').last();
    await expect(userMessage).toContainText('请看附件');
    await expect(userMessage).toContainText('context.txt');
    await expect(userMessage.locator('img[title="screen.png"]')).toBeVisible();
    await expect(page.locator('#attachTray')).toBeHidden();
    await expect(page.locator('#btnSend')).toBeDisabled();

    await expectNoBrowserErrors(page);
  });
});
