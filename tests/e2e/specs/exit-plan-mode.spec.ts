// helpers: tests/helpers/playwright.ts

import { test, expect } from '@playwright/test';
import { ensureComposerReady, expectNoBrowserErrors, gotoMock, sendChatMessage, waitForIdle } from '../../helpers/playwright';

test.describe('P0 日常零 token Mock UI 回归', () => {
  test('P0-07 ExitPlanMode 审批与权限档回落', async ({ page }) => {
    await gotoMock(page);

    // 1. 发送 test:exitplan 后进入计划模式并显示 ExitPlanMode 审批。
    await sendChatMessage(page, 'test:exitplan');
    await expect(page.locator('#pillPermText')).toContainText('Plan');
    await expect(page.locator('#permModal')).toBeVisible();
    await expect(page.locator('#permTool')).toHaveText('ExitPlanMode');
    // UX-001：计划走 markdown 渲染，不再是 JSON 引号 + 字面 \\n
    await expect(page.locator('#permInput')).toContainText('实现 X');
    await expect(page.locator('#permInput')).toContainText('测试 Y');
    await expect(page.locator('#permInput')).not.toContainText('\\n');
    await expect(page.locator('#permInput li')).toHaveCount(2);
    // 对齐 CLI：spinner 行不挂工具后缀（工具卡已显示 ExitPlanMode），保持纯 ✻ 动词… (Ns…) 形态
    await expect(page.locator('#streamLiveStatusText')).toContainText(/^✻ .+… \(\d+s/);
    await expect(page.locator('#streamLiveStatusText')).not.toContainText('ExitPlanMode');

    // 2. 批准后权限档回落默认审批，状态不残留 ExitPlanMode。
    await page.locator('#permAllow').click();
    await expect(page.locator('#permModal')).toBeHidden();
    await expect(page.locator('#pillPermText')).toContainText('Manual');
    await waitForIdle(page);
    await expect(page.locator('#streamLiveStatus')).toHaveCount(0);
    await expect(page.locator('details.toolcard .t-status').last()).toHaveAttribute('aria-label', '成功');

    await expectNoBrowserErrors(page);
  });

  test('P0-07b 矮视口下审批面板超高时，拒绝/允许/中止不用先滚就在视口内（#373）', async ({ page }) => {
    // 手机横屏的逻辑高度。ExitPlanMode 多出三档权限选择，是最容易把面板撑过视口的一张卡。
    await page.setViewportSize({ width: 740, height: 360 });
    await gotoMock(page);
    await sendChatMessage(page, 'test:exitplan');
    await expect(page.locator('#permModal')).toBeVisible();
    await expect(page.locator('#permTool')).toHaveText('ExitPlanMode');

    // 前提：面板确实超高——否则下面的断言量不到「钉在底部」，恒绿。
    const panel = page.locator('#permModal > div').first();
    // 量位置前等滑入过渡（translateY 100%→0，.3s）走完；中途量到的是动画帧，不是停稳后的布局
    await panel.evaluate(el => Promise.all(el.getAnimations().map(a => a.finished)));
    const overflow = await panel.evaluate(el => el.scrollHeight - el.clientHeight);
    expect(overflow, '面板内容应超过视口（否则本用例测不到 #373）').toBeGreaterThan(0);

    await expect(panel).toHaveJSProperty('scrollTop', 0);
    for (const id of ['#permDeny', '#permAllow', '#permInterrupt']) {
      const box = await page.locator(id).boundingBox();
      expect(box, `${id} 应可见`).not.toBeNull();
      expect(box!.y + box!.height, `${id} 底边应在视口内（不需先滚面板）`).toBeLessThanOrEqual(360);
    }
    // 工具名也在视口内：钉住按钮不能以把卡片头部挤出屏幕为代价
    const tool = await page.locator('#permTool').boundingBox();
    expect(tool!.y, '#permTool 顶边应在视口内').toBeGreaterThanOrEqual(0);

    await page.locator('#permAllow').click();
    await expect(page.locator('#permModal')).toBeHidden();
    await expectNoBrowserErrors(page);
  });

  // tw.css 由 Tailwind CLI 预编译，同组工具类按字母序产出、排在后面的胜出：选中时叠上的 text-ink 排在
  // Bypass 标记里的 text-danger 之后，红字被盖成正文色。此前浏览器内编译时 text-ink 先产出，碰巧没事。
  test('P0-07c ExitPlanMode 选中 Bypass 退出档后仍是红字', async ({ page }) => {
    await gotoMock(page);
    await sendChatMessage(page, 'test:exitplan');
    await expect(page.locator('#permModal')).toBeVisible();

    const bypass = page.locator('.perm-exit-mode[data-exit-mode="bypassPermissions"]');
    await bypass.click();
    await expect(bypass, '前提：Bypass 已选中').toHaveClass(/bg-accent-wash/);
    const { got, danger } = await bypass.evaluate(el => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--danger)';
      document.body.appendChild(probe);
      const want = getComputedStyle(probe).color;
      probe.remove();
      return { got: getComputedStyle(el).color, danger: want };
    });
    expect(got, '选中的 Bypass 退出档不是红字').toBe(danger);

    await page.locator('#permAllow').click();
    await expect(page.locator('#permModal')).toBeHidden();
    await expectNoBrowserErrors(page);
  });
});
