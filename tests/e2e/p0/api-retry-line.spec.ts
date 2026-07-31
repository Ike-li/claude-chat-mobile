// spec: docs/testing.md
// helpers: tests/helpers/playwright.ts
//
// 终端等价性回归：CLI 遇到 5xx/429 会自动重试，期间把整条 spinner 行顶替成
//   ✻ API error · Retrying in 4s · attempt 2/10
// 此前 web 在这段时间只显示 "✻ Hatching… (54s · 仍在等待响应)"，重试细节塞在输入框上方一条
// 会被后台任务横幅压掉的横幅里。这份 spec 锁住「重试态整行顶替 + 重试成功回落 spinner」。

import { test, expect } from '@playwright/test';
import { ensureComposerReady, expectNoBrowserErrors, gotoMock, sendChatMessage, waitForIdle } from '../../helpers/playwright';

test.describe('P0 API 重试与 SDK 提示的可见性', () => {
  test('P0-30 重试期间状态行顶替为 API 错误行，重试成功后回落 spinner', async ({ page }) => {
    await gotoMock(page);
    await ensureComposerReady(page);

    await sendChatMessage(page, 'test:api-retry');
    await expect(page.locator('#streamLiveStatus')).toBeVisible();

    // 重试态：整行顶替（不再是 "✻ 动词… (Ns)" 形态），且必须带上 HTTP 状态码——
    // 手机端看不到终端，状态码是判断「网关问题还是账号问题」的关键信息。
    const liveText = page.locator('#streamLiveStatusText');
    await expect(liveText).toContainText('503');
    await expect(liveText).toContainText(/后重试/);
    await expect(liveText).toContainText('2/10');
    // 顶替语义：重试行不带普通 spinner 的 "… (Ns" 括号段
    await expect(liveText).not.toContainText(/… \(\d+s/);

    // 重试成功（text_delta 到达）→ 回落普通 spinner 形态
    await expect(liveText).toContainText(/^✻ .+… \(\d+s/, { timeout: 20_000 });
    await expect(liveText).not.toContainText('503');

    await expect(page.locator('[data-testid="assistant-message"]').last())
      .toContainText('Retry succeeded', { timeout: 20_000 });
    await waitForIdle(page);

    await expectNoBrowserErrors(page);
  });

  test('P0-30b SDK 自由文本提示（notice）按级别上屏，不再蒸发进日志', async ({ page }) => {
    await gotoMock(page);
    await ensureComposerReady(page);

    await sendChatMessage(page, 'test:api-retry');
    // informational / mirror_error / notification / model_refusal_* / compact_error 归一后的
    // system+kind:notice。warning 级走 text-warning，与「已中断」这类中性回执区分开。
    const notice = page.locator('#messages .msg-frame.text-warning').last();
    await expect(notice).toContainText('EACCES', { timeout: 20_000 });

    await waitForIdle(page);
    await expectNoBrowserErrors(page);
  });
});
