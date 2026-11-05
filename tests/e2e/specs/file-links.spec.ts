// helpers: tests/helpers/playwright.ts

import { test, expect, type Page } from '@playwright/test';
import { expectNoBrowserErrors, gotoMock, sendChatMessage, waitForIdle } from '../../helpers/playwright';

// 消息里的本机文件链接 → 工作区 sheet。这里走真 marked + DOMPurify + 真 CSP；file:open 和 /f/ 是 mock，
// 范围、票据、鉴权的真判定在 tests/invariants/server/file-ticket-route.test.mjs。

async function openLinksMessage(page: Page) {
  await gotoMock(page);
  await sendChatMessage(page, 'test:file-links');
  await waitForIdle(page);
}

const link = (page: Page, name: string) => page.getByRole('link', { name, exact: true });
const body = (page: Page) => page.locator('#fileBrowseBody');
const entry = (page: Page, name: string) => page.locator('[data-testid="browse-entry"]', { hasText: name });
const closeSheet = async (page: Page) => {
  await page.locator('#workspaceClose').click();
  await expect(page.locator('#workspaceModal')).toBeHidden();
};

test.describe('P0 文件链接', () => {
  test('P0-FILE-LINK-1 文件链接留在页内打开，外部链接行为不变', async ({ page }) => {
    await openLinksMessage(page);
    const url = page.url();

    const file = link(page, '带行号');
    // 纯路径才是 Cannot GET 的原型：foo.js:2 这种形态 DOMPurify 本来就会剥 href，查它分辨不出钩子在不在
    await expect(link(page, '视频')).not.toHaveAttribute('href', /.*/);
    await expect(file).not.toHaveAttribute('href', /.*/);
    await expect(file).not.toHaveAttribute('target', /.*/);
    await file.click();
    await expect(page.locator('#workspaceModal')).toBeVisible();
    await expect(page.locator('#fileBrowsePath')).toContainText('demo.js');
    await expect(body(page).locator('.CodeMirror')).toBeVisible();
    expect(page.url(), '点文件链接把页面带走了：手机上就是 Cannot GET').toBe(url);
    await closeSheet(page);

    await expect(link(page, '网页')).toHaveAttribute('href', 'https://example.com/page');
    await expect(link(page, '网页')).toHaveAttribute('target', '_blank');
    await expect(link(page, '网页')).toHaveAttribute('rel', 'noopener noreferrer');
    await expect(link(page, '电话')).toHaveAttribute('href', 'tel:10086');
    await expect(link(page, '邮件')).toHaveAttribute('href', 'mailto:a@example.com');

    // 模型写的原始 HTML 能自带 data-*：认了这个标记就不加 target，点一下整个 PWA 被带到外站
    const forged = link(page, '伪造');
    await expect(forged).toHaveAttribute('target', '_blank');
    await expect(forged).toHaveAttribute('rel', 'noopener noreferrer');
    await expect(forged).not.toHaveAttribute('data-file-path', /.*/);
    await expect(forged).not.toHaveAttribute('data-file-line', /.*/);

    await expectNoBrowserErrors(page);
  });

  test('P0-FILE-LINK-2 代码链接在 CodeMirror 里滚到目标行并高亮', async ({ page }) => {
    await openLinksMessage(page);
    await link(page, '长文件').click();

    const target = body(page).locator('.file-target-line');
    await expect(target).toHaveCount(1);
    await expect(target.locator('..')).toContainText('const line300 = 300;');
    await expect(target).toBeInViewport();

    await expectNoBrowserErrors(page);
  });

  test('P0-FILE-LINK-3 大文件自动续页到目标行，太远时停下交给「加载更多」', async ({ page }) => {
    await openLinksMessage(page);
    await link(page, '分页日志').click();

    const target = body(page).locator('pre .file-target-line');
    await expect(target).toHaveText('log line 700');
    await expect(target).toBeInViewport();
    await closeSheet(page);

    await link(page, '太远的行').click();
    // 2KB 一页，首页加 8 次自动续页。不设上限的话手机会把整个大文件拉完，这里已经落到 line 3900 了
    await expect(body(page).locator('button', { hasText: '18.0KB' })).toBeVisible();
    await expect(target).toHaveCount(0);
    await closeSheet(page);

    // 一页正好断在目标行之前：页尾的空区间不算找到，要接着读下一页，否则高亮一个空标记、那行也没显示
    await link(page, '页尾的下一行').click();
    await expect(target).toHaveText('edge line 00129');
    await expect(target).toBeInViewport();

    await expectNoBrowserErrors(page);
  });

  test('P0-FILE-LINK-4 视频就地播放，离开时停下，不在后台继续响', async ({ page }) => {
    await openLinksMessage(page);
    const video = body(page).locator('video');
    const play = () => video.evaluate(async (el: HTMLVideoElement) => {
      el.loop = true; // fixture 只有 1 秒，放完自动 paused 会让下面的断言假绿
      await el.play();
      return el.paused;
    });
    const paused = () => video.evaluate((el: HTMLVideoElement) => el.paused);

    await link(page, '视频').click();
    await expect(video).toBeVisible();
    await expect.poll(() => video.evaluate((el: HTMLVideoElement) => el.readyState)).toBeGreaterThan(0);
    expect(await play()).toBe(false);
    await closeSheet(page);
    expect(await paused(), '关了 sheet 视频还在放').toBe(true);

    await link(page, '视频').click();
    await expect(video).toBeVisible();
    await expect.poll(() => video.evaluate((el: HTMLVideoElement) => el.readyState)).toBeGreaterThan(0);
    expect(await play()).toBe(false);
    await page.locator('#workspaceTabChanges').click();
    await expect(page.locator('#gitChangesBody')).toBeVisible();
    expect(await paused(), '切到「改动」tab 视频还在放').toBe(true);

    await expectNoBrowserErrors(page);
  });

  test('P0-FILE-LINK-5 图片就地预览，放不了时提示下载', async ({ page }) => {
    await openLinksMessage(page);

    await link(page, '图片').click();
    const image = body(page).locator('img');
    await expect(image).toBeVisible();
    await expect.poll(() => image.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);
    await closeSheet(page);

    await link(page, '坏图').click();
    await expect(body(page)).toContainText('无法预览，可以下载后查看');
    await expect(page.locator('#fileBrowseDownload')).toBeVisible();

    await expectNoBrowserErrors(page);
  });

  test('P0-FILE-LINK-6 目录链接进列表，列表里点开图片、视频，其余二进制给下载', async ({ page }) => {
    await openLinksMessage(page);
    const back = page.locator('#fileBrowseBack');

    await link(page, '目录').click();
    await expect(page.locator('#fileBrowsePath')).toContainText('media');

    await entry(page, 'cover.png').click();
    await expect(body(page).locator('img')).toBeVisible();
    await back.click();

    await entry(page, 'clip.webm').click();
    await expect(body(page).locator('video')).toBeVisible();
    await back.click();

    await entry(page, 'out.zip').click();
    await expect(body(page)).toContainText('不支持预览');
    await expect(page.locator('#fileBrowseDownload')).toBeVisible();

    await expectNoBrowserErrors(page);
  });

  test('P0-FILE-LINK-7 从链接进来后，返回落到文件所在目录，再返回到根', async ({ page }) => {
    await openLinksMessage(page);
    const back = page.locator('#fileBrowseBack');

    await link(page, '图片').click();
    await expect(body(page).locator('img')).toBeVisible();

    await back.click();
    await expect(entry(page, 'cover.png')).toBeVisible();
    await expect(page.locator('#fileBrowseDownload')).toBeHidden();

    await back.click();
    await expect(entry(page, 'demo.js')).toBeVisible();

    await expectNoBrowserErrors(page);
  });

  test('P0-FILE-LINK-8 打不开时说明原因，返回能回到根目录', async ({ page }) => {
    await openLinksMessage(page);

    await link(page, '不存在').click();
    await expect(body(page)).toContainText('无法打开：文件不存在');

    await page.locator('#fileBrowseBack').click();
    await expect(entry(page, 'demo.js')).toBeVisible();

    await expectNoBrowserErrors(page);
  });

  test('P0-FILE-LINK-9 后端没重启、file:open 没有回音时给出提示', async ({ page }) => {
    await page.clock.install();
    await openLinksMessage(page);

    await link(page, '旧后端').click();
    await expect(body(page)).toContainText('加载中');
    await page.clock.runFor(10_000);
    await expect(body(page)).toContainText('服务端没响应');

    await expectNoBrowserErrors(page);
  });

  test('P0-FILE-LINK-10 链接指到别的已连接文件夹时，sheet 的根跟过去', async ({ page }) => {
    await openLinksMessage(page);

    await link(page, '别的文件夹').click();
    await expect(page.locator('#fileBrowsePath')).toHaveText('sibling / notes.txt');

    await expectNoBrowserErrors(page);
  });

  test('P0-FILE-LINK-11 下载按钮：内联类型也落成文件，文本文件也能下，编辑时收起', async ({ page }) => {
    await openLinksMessage(page);
    const button = page.locator('#fileBrowseDownload');
    const downloadedName = async () => {
      const [download] = await Promise.all([page.waitForEvent('download'), button.click()]);
      // 没有 ?download 服务端就按内联回，<a download> 落不落成文件全看各家浏览器
      expect(new URL(download.url()).searchParams.has('download')).toBe(true);
      return download.suggestedFilename();
    };

    await link(page, '图片').click();
    await expect(body(page).locator('img')).toBeVisible();
    expect(await downloadedName()).toBe('cover.png');
    await closeSheet(page);

    await link(page, '带行号').click();
    await expect(body(page).locator('.CodeMirror')).toBeVisible();
    expect(await downloadedName()).toBe('demo.js');

    await page.locator('#fileBrowseEdit').click();
    await expect(button).toBeHidden();
    await page.locator('#fileBrowseCancelEdit').click();
    await expect(button).toBeVisible();

    await expectNoBrowserErrors(page);
  });

  test('P0-FILE-LINK-12 计划审批里的文件链接能打开，关掉后审批还在', async ({ page }) => {
    await gotoMock(page);
    await sendChatMessage(page, 'test:exitplan');

    await page.locator('#permInput').getByRole('link', { name: 'demo.js' }).click();
    await expect(page.locator('#fileBrowsePath')).toContainText('demo.js');
    // Playwright 的点击会核实命中：工作区要是被审批 sheet 盖住，这一下点不到
    await closeSheet(page);
    await expect(page.locator('#permModal')).toBeVisible();

    await expectNoBrowserErrors(page);
  });
});
