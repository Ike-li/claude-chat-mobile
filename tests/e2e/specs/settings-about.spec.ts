// spec: 设置「关于」页（#303）——版本与作者、许可证原文、第三方组件、检查更新的三种结果与失败、英文界面。
// helpers: tests/helpers/playwright.ts
//
// 许可证与声明比的是 <pre> 的 textContent 与仓库里的文件（mock 读的就是这几个真文件），不是 innerText：
// 后者会按 CSS 折叠空白，「看起来一样」就绿了。英文界面那条守「原文不参与翻译」：vendor 声明里有中文。

import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { expectNoBrowserErrors, gotoMock, openGeneralPage, openGeneralSettings } from '../../helpers/playwright';

const repoFile = (rel: string) => readFileSync(new URL(`../../../${rel}`, import.meta.url), 'utf8');
const textOf = (page: Page, id: string) => page.locator(`#${id}`).evaluate(el => el.textContent);

async function setUpdateCheck(page: Page, status: string) {
  await page.request.post(`/__set-update-check?status=${status}`);
}

test.describe('P0 日常零 token Mock UI 回归', () => {
  test('P0-ABOUT-1 关于页：版本与 L1 摘要同一份，作者与仓库可点，许可证与声明原样显示，组件清单含浏览器端 Socket.IO 客户端', async ({ page }) => {
    await gotoMock(page);
    await openGeneralSettings(page);
    await expect(page.locator('[data-testid="general-nav-about"]')).toContainText('v1.2.1-mock');
    await page.locator('[data-testid="general-nav-about"]').click();
    await expect(page.locator('#generalPage-about')).toBeVisible();

    await expect(page.locator('#aboutVersion')).toHaveText('v1.2.1-mock');
    await expect(page.locator('#aboutAuthor')).toHaveText('Ike-li');
    await expect(page.locator('#aboutAuthor')).toHaveAttribute('href', 'https://github.com/Ike-li');
    await expect(page.locator('#aboutRepo')).toHaveAttribute('href', 'https://github.com/Ike-li/claude-chat-mobile');
    await expect(page.locator('#aboutReleasesLink')).toHaveAttribute('href', 'https://github.com/Ike-li/claude-chat-mobile/releases');
    // 升级指向文档的「更新」一节，不是 macOS 菜单的「更新桌面端」（那个只用本地源码重编，拿不到新版）
    await expect(page.locator('#aboutUpgradeGuide')).toHaveAttribute('href', /docs\/getting-started\.md#更新$/);

    await page.locator('#aboutLicense summary').click();
    await expect.poll(() => textOf(page, 'aboutLicenseText')).toBe(repoFile('LICENSE'));
    await page.locator('#aboutComponents summary').click();
    await expect.poll(() => textOf(page, 'aboutNoticeText')).toBe(repoFile('NOTICE'));
    await expect.poll(() => textOf(page, 'aboutVendorNoticesText')).toBe(repoFile('app/public/vendor/THIRD-PARTY-NOTICES.md'));
    const list = page.locator('#aboutComponentList li');
    await expect(list).toHaveCount(3);
    await expect(list.filter({ hasText: 'socket.io-client@4.8.4' })).toHaveText('socket.io-client@4.8.4 · MIT · 浏览器端');
    await expect(list.filter({ hasText: '@anthropic-ai/claude-agent-sdk' })).toHaveText('@anthropic-ai/claude-agent-sdk@0.3.201-mock · SEE LICENSE IN README.md');

    await expectNoBrowserErrors(page);
  });

  test('P0-ABOUT-2 检查更新：有新版 / 已是最新 / 本地领先 / 失败各说一句，只有新版才带 Release 链接', async ({ page }) => {
    await gotoMock(page);
    await openGeneralPage(page, 'about');
    const result = page.locator('#aboutUpdateResult');
    const release = page.locator('#aboutReleaseLink');

    const cases: Array<[string, RegExp]> = [
      ['newer', /有新版 v1\.3\.0（当前 v1\.2\.1-mock）/],
      ['same', /已是最新（v1\.2\.1-mock）/],
      ['ahead', /本地领先：当前 v1\.2\.1-mock，GitHub 最新 v1\.2\.0/],
      ['fail', /^检查失败$/],
    ];
    for (const [status, text] of cases) {
      await setUpdateCheck(page, status);
      await page.locator('#btnCheckUpdate').click();
      await expect(result).toHaveText(status === 'newer' ? new RegExp(`${text.source}.*releases/tag/v1\\.3\\.0`) : text);
      if (status === 'newer') {
        await expect(release).toHaveAttribute('href', 'https://github.com/Ike-li/claude-chat-mobile/releases/tag/v1.3.0');
      } else {
        await expect(release).toHaveCount(0);
      }
      await expect(page.locator('#btnCheckUpdate')).toBeEnabled();
    }
    const { calls } = await (await page.request.get('/__update-check-calls')).json();
    expect(calls, '每点一次都要真发一次 about:checkUpdate（缓存在服务端，不在前端）').toBe(4);

    await expectNoBrowserErrors(page);
  });

  test('P0-ABOUT-3 英文界面：页名、按钮与结果是英文，许可证与第三方声明原文一字不改', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('ccm_lang', 'en'));
    await gotoMock(page);
    await openGeneralPage(page, 'about');

    await expect(page.locator('#generalSheetTitle')).toHaveText(/About/);
    await expect(page.locator('#btnCheckUpdate')).toHaveText('Check for updates');
    await expect(page.locator('#aboutUpgradeGuide')).toHaveText('Upgrade guide');
    await expect(page.locator('#aboutComponents summary')).toHaveText('Third-party components & licenses');

    await page.locator('#aboutComponents summary').click();
    await expect.poll(() => textOf(page, 'aboutVendorNoticesText')).toBe(repoFile('app/public/vendor/THIRD-PARTY-NOTICES.md'));
    await expect(page.locator('#aboutComponentList li').filter({ hasText: 'socket.io-client' })).toHaveText(/· browser$/);

    await setUpdateCheck(page, 'newer');
    await page.locator('#btnCheckUpdate').click();
    await expect(page.locator('#aboutUpdateResult')).toContainText('Update available: v1.3.0 · you have v1.2.1-mock');

    await expectNoBrowserErrors(page);
  });
});
