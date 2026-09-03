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

  // 刷新后从磁盘读回来的 API Error 此前退化成普通助手气泡（正文里那句 "API Error:" 是唯一线索）。
  // 后端带出 isApiErrorMessage/apiErrorStatus 的部分已用真实 transcript 验证；这里锁前端渲染。
  test('P0-30c 历史里的 API Error 渲染成错误条，不退化为普通助手气泡', async ({ page }) => {
    await gotoMock(page);
    await ensureComposerReady(page);

    await sendChatMessage(page, 'test:history-apierror');

    // 错误条：与 live 侧 error 事件同一语义色（含 ⚠️ 前缀），不是 assistant 气泡
    const errBars = page.locator('#messages .msg-frame.text-danger');
    await expect(errBars).toHaveCount(2, { timeout: 20_000 });
    await expect(errBars.nth(0)).toContainText('⚠️ API Error: 503');
    // 第二条 apiErrorStatus=null（连接错误无 HTTP 响应，真实高频形态）——同样要标成错误
    await expect(errBars.nth(1)).toContainText('流式连接异常中断');
    // 同一批历史里的普通助手消息仍走气泡，不被连坐
    await expect(page.locator('[data-testid="assistant-message"]').last()).toContainText('普通回复不受影响');
    // 关键回归：错误条不得同时是 assistant 气泡（那就是没走差异化分支）
    await expect(page.locator('[data-testid="assistant-message"]').filter({ hasText: 'API Error: 503' })).toHaveCount(0);

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
