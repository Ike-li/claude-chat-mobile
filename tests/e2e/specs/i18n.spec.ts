// helpers: tests/helpers/playwright.ts

import { test, expect } from '@playwright/test';
import { ensureComposerReady, expectNoBrowserErrors, gotoMock, openGeneralPage, openGeneralSettings } from '../../helpers/playwright';

// zh 原文即词典 key 的运行时 t()，en locale 查表、未收录静默回落中文。本 spec 是唯一跑 en 的用例，
// 其余 P0 spec 全部保持 zh 断言不变（见 app/public/js/i18n.js 头注 + tests/gates/i18n-check.js 孤儿扫描）。
// 静态外壳靠 applyI18nToDocument 整树扫描（文本节点 + title/placeholder/aria-label/alt），
// app.js/logic.js 的运行时模板各自包 t()——两条路径都要在这里守住。
test.describe('P0 日常零 token Mock UI 回归', () => {
  test('P0-I18N en 冒烟：语言偏好设为 en 后静态串与 placeholder 切换为英文', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('ccm_lang', 'en'));
    await gotoMock(page);
    await ensureComposerReady(page);

    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.locator('#input')).toHaveAttribute('placeholder', 'Message Claude...');

    await page.locator('#pillDefaults').click();
    await expect(page.locator('#settingsSheet')).not.toHaveClass(/translate-y-full/);
    await expect(page.locator('#modelSection')).toContainText('Model');
    await expect(page.locator('.model-tile').first()).toBeVisible();
    await page.keyboard.press('Escape');

    // 提示音等本机偏好在通用设置里（按作用域拆分后），两个 sheet 的静态壳都要覆盖到
    // 作用域标题「这台手机 / 这台电脑」已从分区降级为组旁的 chip；面板内的静态串照样走整树扫描
    await openGeneralSettings(page);
    await expect(page.locator('#generalSheet')).toContainText('Sound');
    await expect(page.locator('#generalPage-notify [data-scope-chip="device"]')).toContainText('This device only');

    // 语言三选一的文案写死在 index.html 里，正是为了白嫖整树扫描（BUTTON 不在 SKIP_TAGS 里）。
    // 哪天有人把这组按钮改成 JS 生成，这一行会红——那条路拿不到翻译。
    await page.locator('[data-testid="general-nav-behavior"]').click();
    await expect(page.locator('#prefLangGroup [data-lang="auto"]')).toContainText('Auto-detect');

    await expectNoBrowserErrors(page);
  });

  // 整树扫描的回归点：这些串在 index.html 里没有任何 data-i18n 标注，全靠 applyI18nToDocument
  // 遍历文本节点/属性命中词典。标注驱动的老实现会让它们全部漏翻。
  test('P0-I18N en 整树扫描：未标注的静态文本与 title/aria-label 属性也翻译', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('ccm_lang', 'en'));
    await gotoMock(page);
    await ensureComposerReady(page);

    await expect(page.locator('#btnNew')).toHaveAttribute('title', 'New session');
    await expect(page.locator('#btnHome')).toHaveAttribute('aria-label', 'Home');
    // 权限档文案固定 CLI 英文（不走 i18n），en/zh 一致
    await expect(page.locator('#pillPermText')).toHaveText('Manual');

    await page.locator('#pillDefaults').click();
    await expect(page.locator('#customPermGrid')).toContainText('Plan');
    await expect(page.locator('#customPermGrid')).toContainText('Accept edits');
    await page.keyboard.press('Escape');

    // L1 目录的六行由 JS 渲染（logic/general-nav.js 的 t()），不经 applyI18nToDocument 的整树扫描
    await openGeneralSettings(page);
    await expect(page.locator('[data-testid="general-nav-help"]')).toContainText('Help');
    await expect(page.locator('[data-testid="general-nav-devices"]')).toContainText('Access & devices');
    await expect(page.locator('#generalNavRows')).not.toContainText('接入与设备');

    // L2 页里的静态长句仍走整树扫描
    await page.locator('[data-testid="general-nav-host"]').click();
    await expect(page.locator('[data-scope-note="host"]')).toContainText('this computer');

    await expectNoBrowserErrors(page);
  });

  // app.js 运行时模板的回归点：空表面由 JS 生成，不经 applyI18nToDocument，只能靠模板里的 t()。
  test('P0-I18N en 运行时模板：新会话空表面与引导 prompt 为英文', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('ccm_lang', 'en'));
    await gotoMock(page);
    await ensureComposerReady(page);

    await page.locator('#btnNew').click();
    const surface = page.locator('[data-testid="compose-surface"]');
    await expect(surface).toBeVisible();
    await expect(surface).toContainText('New session ready');
    await expect(surface).toContainText('Summarize repo structure');
    await expect(surface).not.toContainText('新会话已就绪');

    // data-p 是发给 Claude 的提示词本身，英文界面下也该是英文
    await expect(surface.locator('.esg-prompt').first())
      .toHaveAttribute('data-p', /Summarize this repo/);

    await expectNoBrowserErrors(page);
  });

  // 语言选择器本身：从原生 <select> 换成自绘按钮组之后的回归点（换的理由见 index.html
  // #prefLangGroup 的注释——原生下拉在 fixed+transform 的 sheet 里，手机上弹层会飘到页面别处）。
  // 四组断言各有分工：localStorage 守真落盘、aria-checked 守单选语义（读屏那条通道）、
  // border-accent 守视觉高亮（看得见的那条通道，与 aria 是两条独立的路、要分别守）、
  // 确认框守「改完提示刷新」。只断言初始默认高亮会恒绿（默认值天然对），核心在**点过之后**那一组。
  test('P0-I18N 语言选择器：点一项即落盘、高亮随之移动、并弹刷新确认', async ({ page }) => {
    await gotoMock(page);
    await openGeneralPage(page, 'behavior');

    const group = page.locator('#prefLangGroup');
    const zh = group.locator('[data-lang="zh"]');
    const en = group.locator('[data-lang="en"]');
    const auto = group.locator('[data-lang="auto"]');

    // 未设过偏好：回显保底 zh（readLangPref 的 fallback）
    await expect(zh).toHaveAttribute('aria-checked', 'true');
    await expect(en).toHaveAttribute('aria-checked', 'false');

    await en.click();

    // ① 真落盘（不是只改了样式）
    await expect.poll(() => page.evaluate(() => localStorage.getItem('ccm_lang'))).toBe('en');
    // ② 单选语义移过去了，且旧项被取消——「只设当前项、不动其他项」的写法会在 zh 那行红
    await expect(en).toHaveAttribute('aria-checked', 'true');
    await expect(zh).toHaveAttribute('aria-checked', 'false');
    await expect(auto).toHaveAttribute('aria-checked', 'false');
    // ③ 视觉高亮同样是互斥的。这条与 ② 不可互相替代：aria 正确而配色三个全亮，
    //    看得见的人就选不出来了；反过来配色对而 aria 不动，读屏用户听到三个一样的按钮。
    await expect(en).toHaveClass(/border-accent/);
    await expect(zh).not.toHaveClass(/border-accent/);
    await expect(auto).not.toHaveClass(/border-accent/);
    // ④ 静态串要等刷新才变，所以必须提示；点「取消」不回滚偏好（已经存下了）
    await expect(page.locator('#confirmModal')).toBeVisible();
    await page.locator('#confirmCancel').click();
    await expect(page.locator('#confirmModal')).toBeHidden();
    await expect(en).toHaveAttribute('aria-checked', 'true');

    // ⑤ 每次打开都从 storage 重读，而不是记住上次画过什么——偏好存在 localStorage 里，
    //    另一个标签页改了它这边也得跟上。这条独立于上面那组：上面验的是点击那条路，
    //    这里故意绕开点击直接改 storage，「open 只回显一次 / 带缓存」的实现只会在这里红。
    await page.keyboard.press('Escape');
    await page.evaluate(() => localStorage.setItem('ccm_lang', 'auto'));
    await openGeneralPage(page, 'behavior');
    await expect(page.locator('#prefLangGroup [data-lang="auto"]')).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('#prefLangGroup [data-lang="en"]')).toHaveAttribute('aria-checked', 'false');

    await expectNoBrowserErrors(page);
  });

  test('P0-I18N zh 默认：未设偏好时一切保持中文（en 改动不得泄漏进默认路径）', async ({ page }) => {
    await gotoMock(page);
    await ensureComposerReady(page);

    await expect(page.locator('#input')).toHaveAttribute('placeholder', '给 Claude 发消息...');
    await expect(page.locator('#pillPermText')).toHaveText('Manual');
    await expect(page.locator('#btnNew')).toHaveAttribute('title', '创建新会话');

    await expectNoBrowserErrors(page);
  });
});
