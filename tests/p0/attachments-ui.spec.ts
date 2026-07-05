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

  test('P0-18e 离线附件重发后不重复显示附件 chip', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:disconnect-now');
    await expect(page.locator('#connDot')).toHaveClass(/bg-danger/, { timeout: 10_000 });

    await page.locator('#fileInput').setInputFiles({
      name: 'offline-attachment.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('offline attachment payload')
    });
    await expect(page.locator('#attachTray')).toContainText('offline-attachment.txt');
    await page.locator('#input').fill('test:settings-echo');
    await page.locator('#btnSend').click();

    const queued = page.locator('.msg-frame.opacity-70').last();
    await expect(queued).toContainText('offline-attachment.txt');
    await expect(queued.locator('.pending-indicator')).toContainText('正在等待连接');
    await expect(page.locator('#attachTray')).toBeHidden();

    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(page.locator('#connDot')).toHaveClass(/bg-success/, { timeout: 10_000 });
    await waitForIdle(page);
    await expect(page.locator('.pending-indicator')).toHaveCount(0);
    await expect(page.locator('#messages').getByText('offline-attachment.txt')).toHaveCount(1);
    await expect(page.locator('[data-testid="assistant-message"]').last()).toContainText('设置回显：model=');

    await expectNoBrowserErrors(page);
  });

  test('P0-18f 移除附件 chip 后不会随消息发送', async ({ page }) => {
    await gotoMock(page);

    await page.locator('#fileInput').setInputFiles([
      { name: 'keep-me.txt', mimeType: 'text/plain', buffer: Buffer.from('keep this attachment') },
      { name: 'remove-me.txt', mimeType: 'text/plain', buffer: Buffer.from('remove this attachment') }
    ]);
    await expect(page.locator('#attachTray')).toContainText('keep-me.txt');
    await expect(page.locator('#attachTray')).toContainText('remove-me.txt');

    const removedChip = page.locator('#attachTray > div').filter({ hasText: 'remove-me.txt' });
    await removedChip.locator('button').click();
    await expect(page.locator('#attachTray')).toContainText('keep-me.txt');
    await expect(page.locator('#attachTray')).not.toContainText('remove-me.txt');

    await sendChatMessage(page, 'test:settings-echo');
    await waitForIdle(page);
    const sent = page.locator('[data-testid="user-message"]').last();
    await expect(sent).toContainText('test:settings-echo');
    await expect(sent).toContainText('keep-me.txt');
    await expect(sent).not.toContainText('remove-me.txt');

    await expectNoBrowserErrors(page);
  });

  test('P0-18g 移除附件 chip 后释放数量配额并只发送剩余附件', async ({ page }) => {
    await gotoMock(page);

    const initialFiles = Array.from({ length: 10 }, (_, index) => ({
      name: `slot-${index}.txt`,
      mimeType: 'text/plain',
      buffer: Buffer.from(`attachment slot ${index}`)
    }));

    await page.locator('#fileInput').setInputFiles(initialFiles);
    await expect(page.locator('#attachTray')).toContainText('slot-0.txt');
    await expect(page.locator('#attachTray')).toContainText('slot-9.txt');

    const removedChip = page.locator('#attachTray > div').filter({ hasText: 'slot-9.txt' });
    await removedChip.locator('button').click();
    await expect(page.locator('#attachTray')).not.toContainText('slot-9.txt');

    await page.locator('#fileInput').setInputFiles({
      name: 'replacement-after-remove.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('replacement after attachment quota frees up')
    });
    await expect(page.locator('#attachTray')).toContainText('replacement-after-remove.txt');
    await expect(page.locator('#messages')).not.toContainText('附件数量已达上限');

    await page.locator('#input').fill('send after freeing attachment quota');
    await page.locator('#btnSend').click();
    await expect(page.locator('#attachTray')).toBeHidden();

    const sent = page.locator('[data-testid="user-message"]').last();
    await expect(sent).toContainText('send after freeing attachment quota');
    for (let index = 0; index < 9; index += 1) {
      await expect(sent).toContainText(`slot-${index}.txt`);
    }
    await expect(sent).toContainText('replacement-after-remove.txt');
    await expect(sent).not.toContainText('slot-9.txt');

    await expectNoBrowserErrors(page);
  });
});
