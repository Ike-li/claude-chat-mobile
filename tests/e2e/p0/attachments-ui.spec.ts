// spec: docs/testing.md
// helpers: tests/helpers/playwright.ts

import { test, expect } from '@playwright/test';
import { ensureComposerReady, expectNoBrowserErrors, gotoMock, sendChatMessage, waitForIdle } from '../../helpers/playwright';
import { ANOTHER_WORKSPACE, openSessionsSidebar, openWorkspaceSession } from '../../helpers/p0-ui';

const tinyPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64'
);

test.describe('P0 日常零 token Mock UI 回归', () => {
  test('P0-18 文件/图片上传、附件 chip 与前端边界', async ({ page }) => {
    await gotoMock(page);
    await ensureComposerReady(page);

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
    await ensureComposerReady(page);

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
    await ensureComposerReady(page);

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
    await ensureComposerReady(page);
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

    await openSessionsSidebar(page);
    await openWorkspaceSession(page, ANOTHER_WORKSPACE, 'Another App Concurrency');
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
    await ensureComposerReady(page);

    await page.locator('#fileInput').setInputFiles([
      { name: 'keep-me.txt', mimeType: 'text/plain', buffer: Buffer.from('keep this attachment') },
      { name: 'remove-me.txt', mimeType: 'text/plain', buffer: Buffer.from('remove this attachment') }
    ]);
    await expect(page.locator('#attachTray')).toContainText('keep-me.txt');
    await expect(page.locator('#attachTray')).toContainText('remove-me.txt');

    // 真实点击 ✕（hit-44 必须在按钮上而非 chip，否则 ::after 会吞点击）
    await page.locator('#attachTray > div')
      .filter({ hasText: 'remove-me.txt' })
      .getByRole('button', { name: '移除附件' })
      .click();
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
    await ensureComposerReady(page);

    const initialFiles = Array.from({ length: 10 }, (_, index) => ({
      name: `slot-${index}.txt`,
      mimeType: 'text/plain',
      buffer: Buffer.from(`attachment slot ${index}`)
    }));

    await page.locator('#fileInput').setInputFiles(initialFiles);
    await expect(page.locator('#attachTray')).toContainText('slot-0.txt');
    await expect(page.locator('#attachTray')).toContainText('slot-9.txt');

    await page.locator('#attachTray > div')
      .filter({ hasText: 'slot-9.txt' })
      .getByRole('button', { name: '移除附件' })
      .click();
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

  test('P0-18h 发送后用户消息回显附件元数据并清空托盘', async ({ page }) => {
    await gotoMock(page);
    await ensureComposerReady(page);

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
    // 发送后输入空 + busy → 停止态（不再是 disabled 发送）
    await expect(page.locator('#btnSend')).toHaveAttribute('data-mode', 'stop');
    await expect(page.locator('#btnSend')).toBeEnabled();

    await expectNoBrowserErrors(page);
  });

  // E18 附件预览：三条点击路径（fixture 由 mock 场景 test:attach-preview + mock browse:read 提供）——
  // live 气泡缩略图（meta.storedName 按需拉原图）、历史 chip（history.js [附件] 解析形态、无 thumb）、
  // 已删文件（browse:read ok:false → toast 降级、不开灯箱）。断言基于 DOM 状态非像素。
  test('P0-18i 点击气泡附件可预览：live 缩略图 / 历史 chip / 已删文件降级', async ({ page }) => {
    await gotoMock(page);
    await sendChatMessage(page, 'test:attach-preview');

    const modal = page.locator('#attachPreviewModal');
    const previewImg = page.locator('#attachPreviewImg');

    // ① live user_message：缩略图可点击 → 灯箱开、src 为按需拉取拼装的完整 data:image
    const liveMsg = page.locator('[data-testid="user-message"]').filter({ hasText: '看看这张实时消息里的图' });
    await expect(liveMsg.locator('img[title="photo.png"]')).toBeVisible();
    await liveMsg.locator('img[title="photo.png"]').click();
    await expect(modal).toBeVisible();
    await expect(previewImg).toHaveAttribute('src', /^data:image\/png;base64,/);
    await expect(page.locator('#attachPreviewName')).toContainText('photo.png');
    await page.locator('#attachPreviewClose').click();
    await expect(modal).toBeHidden();

    // ② 历史形态（history_append → renderHistoryBubbles）：无 thumb 的 chip → 点击拉原图开灯箱
    const histMsg = page.locator('[data-testid="user-message"]').filter({ hasText: '重启后回看的历史附件消息' });
    await expect(histMsg).toContainText('old.png');
    await histMsg.getByText('old.png').click();
    await expect(modal).toBeVisible();
    await expect(previewImg).toHaveAttribute('src', /^data:image\/png;base64,/);
    await expect(page.locator('#attachPreviewName')).toContainText('old.png');
    await page.locator('#attachPreviewClose').click();
    await expect(modal).toBeHidden();

    // ③ 文件已删：toast 报错、灯箱不开（历史无 thumb，无降级图可放大）
    const goneMsg = page.locator('[data-testid="user-message"]').filter({ hasText: '文件已被清理的历史附件' });
    await goneMsg.getByText('gone.png').click();
    await expect(page.locator('#messages')).toContainText('「gone.png」预览加载失败');
    await expect(modal).toBeHidden();

    await expectNoBrowserErrors(page);
  });
});
