// spec: docs/testing.md
// helpers: tests/helpers/playwright.ts

import { test, expect } from '@playwright/test';
import { ensureComposerReady, expectNoBrowserErrors, gotoMock } from '../../helpers/playwright';

// zh 原文即词典 key 的运行时 t()，en locale 查表、未收录静默回落中文。本 spec 是唯一跑 en 的用例，
// 其余 P0 spec 全部保持 zh 断言不变（见 public/js/i18n.js 头注 + scripts/i18n-check.js 孤儿扫描）。
// 静态外壳靠 applyI18nToDocument 整树扫描（文本节点 + title/placeholder/aria-label/alt），
// app.js/logic.js 的运行时模板各自包 t()——两条路径都要在这里守住。
test.describe('P0 日常零 token Mock UI 回归', () => {
  test('P0-I18N en 冒烟：语言偏好设为 en 后静态串与 placeholder 切换为英文', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('ccm_lang', 'en'));
    await gotoMock(page);
    await ensureComposerReady(page);

    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.locator('#input')).toHaveAttribute('placeholder', 'Message Claude...');

    await page.locator('#btnSettings').click();
    await expect(page.locator('#settingsSheet')).not.toHaveClass(/translate-y-full/);
    await expect(page.locator('#settingsSheet')).toContainText('Select model');
    await expect(page.locator('#settingsSheet')).toContainText('Sound');

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
    await expect(page.locator('#pillPermText')).toHaveText('Default');

    await page.locator('#btnSettings').click();
    // 权限档磁贴：index.html 里是裸文本节点，且中英分属不同分组文案
    await expect(page.locator('#customPermGrid')).toContainText('Plan mode');
    await expect(page.locator('#customPermGrid')).toContainText('Accept edits');
    await expect(page.locator('#settingsSheet')).toContainText('Access & devices');
    // 混排句（文本节点被 <code>/<strong> 切碎）也要拼得成句，不能留半截中文
    await expect(page.locator('#settingsSheet')).not.toContainText('访问与设备');

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

  test('P0-I18N zh 默认：未设偏好时一切保持中文（en 改动不得泄漏进默认路径）', async ({ page }) => {
    await gotoMock(page);
    await ensureComposerReady(page);

    await expect(page.locator('#input')).toHaveAttribute('placeholder', '给 Claude 发消息...');
    await expect(page.locator('#pillPermText')).toHaveText('默认审批');
    await expect(page.locator('#btnNew')).toHaveAttribute('title', '创建新会话');

    await expectNoBrowserErrors(page);
  });
});
