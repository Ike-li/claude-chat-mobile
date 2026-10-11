// helpers: tests/helpers/playwright.ts

import { test, expect, type Page } from '@playwright/test';
import { ensureComposerReady, expectNoBrowserErrors, gotoMock, sendChatMessage, waitForIdle } from '../../helpers/playwright';

// 会话里的图片：工具截图（live tool_result.images）与用户贴图（历史条目 images）。
// 事件与历史只带引用，图经 image:get 按需取（mock 见 tests/e2e/mock/server.js 的 MOCK_TRANSCRIPT_IMAGES）。
// 判据全按 DOM 结构：格子的 data-state（pending / loaded / error / too_large）与 <img> 的 data: URL，
// 不按像素、不按文本片段判断「走没走某条分支」。

type ImageRequest = { ref: string; sessionId: string | null; cwd: string | null; instanceId: string | null };
const imageRequests = async (page: Page): Promise<ImageRequest[]> => (await page.request.get('/__image-requests')).json();

test.describe('P0 日常零 token Mock UI 回归', () => {
  test('P0-IMG-01 工具截图：卡片展开才取图，缩略图点开看大图；超单张上限显示占位、不发请求', async ({ page }) => {
    await gotoMock(page);
    await sendChatMessage(page, 'test:tool-screenshot');
    await waitForIdle(page);

    const card = page.locator('details.toolcard').filter({ hasText: 'mcp__claude-in-chrome__computer' });
    await expect(card).toHaveCount(1);
    const tiles = card.locator('[data-testid="transcript-image"]');
    await expect(tiles).toHaveCount(2);
    // 收起着：不取（一次会话几十张截图，打开会话就全拉会压垮手机）
    await expect(tiles.nth(0)).toHaveAttribute('data-state', 'pending');
    await expect(tiles.nth(1)).toHaveAttribute('data-state', 'too_large');
    await expect(tiles.nth(1)).toContainText('图片过大（3.2MB），未加载');

    await card.locator('summary').click();
    await expect(tiles.nth(0)).toHaveAttribute('data-state', 'loaded');
    await expect(tiles.nth(0).locator('img')).toHaveAttribute('src', /^data:image\/png;base64,iVBOR/);
    // 正对照在上一行：第一张确实走了 image:get；超上限那张同一队列里却没有
    const refs = (await imageRequests(page)).map(r => r.ref);
    expect(refs).toContain('t:t_shot:0');
    expect(refs).not.toContain('t:t_shot:1');
    // 取图坐标来自信封：发出它的那个会话与实例
    const req = (await imageRequests(page)).find(r => r.ref === 't:t_shot:0');
    expect(req?.sessionId).toBe('mock-session-visual-test');
    expect(req?.instanceId).toBeTruthy();

    await tiles.nth(0).click();
    await expect(page.locator('#attachPreviewModal')).toBeVisible();
    await expect(page.locator('#attachPreviewImg')).toHaveAttribute('src', /^data:image\/png;base64,iVBOR/);
    await expect(card.locator('.t-out')).toContainText('Successfully captured screenshot');

    await expectNoBrowserErrors(page);
  });

  test('P0-IMG-02 用户贴图：气泡里显示缩略图；取不到的显示「图片无法加载」，整条消息照常渲染', async ({ page }) => {
    await gotoMock(page);
    await ensureComposerReady(page);
    await sendChatMessage(page, 'test:history-images');

    const pasted = page.locator('[data-testid="user-message"]').filter({ hasText: '这个按钮的位置不对' });
    await expect(pasted).toHaveCount(1);
    const tile = pasted.locator('[data-testid="transcript-image"]');
    await expect(tile).toHaveAttribute('data-state', 'loaded');
    await expect(tile.locator('img')).toHaveAttribute('src', /^data:image\/png;base64,iVBOR/);

    // 纯图消息（没写字）也得有气泡；它的图 mock 不认 → 失败态，不是空白、不是整条消失
    const gone = page.locator('[data-testid="user-message"] [data-testid="transcript-image"][data-ref="u:u-img-gone:0"]');
    await expect(gone).toHaveAttribute('data-state', 'error');
    await expect(gone).toHaveText('图片无法加载');
    await expect(page.locator('[data-testid="assistant-message"]').filter({ hasText: '看到了，按钮偏右了。' })).toHaveCount(1);

    // 失败的格子点一下重试：重试真的又发了一次请求（而不只是换了文案）
    const before = (await imageRequests(page)).filter(r => r.ref === 'u:u-img-gone:0').length;
    await gone.click();
    await expect.poll(async () => (await imageRequests(page)).filter(r => r.ref === 'u:u-img-gone:0').length).toBe(before + 1);
    await expect(gone).toHaveAttribute('data-state', 'error');

    await tile.click();
    await expect(page.locator('#attachPreviewModal')).toBeVisible();

    await expectNoBrowserErrors(page);
  });
});
