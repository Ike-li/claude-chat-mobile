// spec: 设置 →「诊断」→ 安全体检（④）的展开/收起。
// helpers: tests/helpers/playwright.ts
//
// 为什么锁这一条：报告是内联长列表（十几项 + WHITELIST 明细），而诊断区另两个入口是 bottom sheet
// 自带 ✕ 关闭。第一版这里只做了 classList.remove('hidden')——展开后没有任何回程路径，报告把设置
// 列表整个顶出屏幕（机主真机复现）。收起路径有两条（按钮本身 + 报告尾行），两条都要锁。

import { test, expect } from '@playwright/test';
import { expectNoBrowserErrors, gotoMock, openGeneralDiagSection, openGeneralSettings } from '../../helpers/playwright';

test.describe('P0 日常零 token Mock UI 回归', () => {
  test('P0-32 安全体检：展开渲染报告 → 按钮收起 → 尾部收起行同源', async ({ page }) => {
    await gotoMock(page);
    await openGeneralSettings(page);
    await openGeneralDiagSection(page);

    const btn = page.locator('#btnSecurityCheck');
    const report = page.locator('#doctorReport');
    await expect(report).toBeHidden();
    await expect(btn).toHaveAttribute('aria-expanded', 'false');

    // 1. 展开：就绪度横幅 + 逐项 + WHITELIST 危险明细（含 scope，用户据此知道改哪个文件）
    await btn.click();
    await expect(report).toBeVisible();
    await expect(report).toContainText('可用，但有需留意的偏宽项');
    await expect(report).toContainText('AUTH_TOKEN');
    await expect(report).toContainText('已设置（长度 64）');
    await expect(report).toContainText('Bash(*)');
    await expect(report).toContainText('user');
    await expect(btn).toHaveAttribute('aria-expanded', 'true');
    await expect(btn).toHaveText('🔍 安全体检 · 收起结果 ▲');

    // 2. 按钮兼作收起：面板隐藏、内容清空（下次展开必重跑，不留过期快照）、文案与 aria 复位
    await btn.click();
    await expect(report).toBeHidden();
    await expect(report).toBeEmpty();
    await expect(btn).toHaveAttribute('aria-expanded', 'false');
    await expect(btn).toHaveText('🔍 安全体检 · 公网暴露前自查 →');

    // 3. 尾部收起行：长报告看完停在底部，不必滚回按钮——与按钮同源
    await btn.click();
    await expect(report).toBeVisible();
    await report.getByRole('button', { name: '▲ 收起体检结果' }).click();
    await expect(report).toBeHidden();
    await expect(btn).toHaveAttribute('aria-expanded', 'false');

    await expectNoBrowserErrors(page);
  });
});
