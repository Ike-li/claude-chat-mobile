// helpers: tests/helpers/playwright.ts
//
// #307「只有『加载了 N 条历史消息』提示条、下面没有气泡」：根因还没复现，这里只钉观测和缓解。
// 历史是分块渲染的（每块 40 条，全部跑完才一次性插入 #messages），中途放弃或某条抛错都会停在只有提示条的样子。
//   · 观测：两条路径各记一条客户端日志（日志面板里看得到），带会话号、两个实例号、已渲染条数。
//   · 缓解：提示条上原地给「重新加载」，重新拉一次历史（不刷新整页），不重复渲染。
// 根因修好之后，这里的「停在只有提示条」应当改成「最终有完整气泡」（见 Issue 处理顺序第 2 步）。

import { test, expect, type Page } from '@playwright/test';
import { gotoMock } from '../../helpers/playwright';
import { MAIN_WORKSPACE, expandWorkspace, expectSidebarClosed, openSessionsSidebar, openWorkspaceSession } from '../../helpers/sidebar-ui';

const LONG_NOTICE = '仅显示最近 2000 条历史消息（共 2100 条），更早的没有加载';
const bubbles = (page: Page) => page.locator('#messages [data-testid="user-message"], #messages [data-testid="assistant-message"]');

async function openLongHistory(page: Page) {
  await openSessionsSidebar(page);
  await expandWorkspace(page, MAIN_WORKSPACE);
  await openWorkspaceSession(page, MAIN_WORKSPACE, 'Long History Session');
  await expectSidebarClosed(page);
}

async function consoleLogText(page: Page) {
  await page.locator('#btnConsole').click();
  await expect(page.locator('#consoleModal')).toBeVisible();
  return page.locator('#consoleLogArea');
}

function pageErrorsExcept(page: Page, injected: string) {
  return ((page as unknown as { __ccmErrors?: string[] }).__ccmErrors ?? []).filter(e => !e.includes(injected));
}

test.describe('#307 历史渲染停在提示条：观测与原地重新加载', () => {
  test('P0-HIST-STALL-1 渲染第 2 块时切到别的会话：日志记下中途放弃，带会话号、两个实例号、已渲染条数', async ({ page }) => {
    await gotoMock(page);
    // 冻结分块调度：第一块同步画完后，第二块的回调攥在手里，切走之后再放（同 P0-LH3）
    await page.evaluate(() => {
      const w = window as unknown as { __frozenIdleCallback: IdleRequestCallback | null };
      w.__frozenIdleCallback = null;
      window.requestIdleCallback = ((cb: IdleRequestCallback) => {
        if (w.__frozenIdleCallback === null) w.__frozenIdleCallback = cb;
        return 0;
      }) as typeof window.requestIdleCallback;
    });
    await openLongHistory(page);
    await expect.poll(() => page.evaluate(() => (window as unknown as { __frozenIdleCallback: unknown }).__frozenIdleCallback !== null)).toBe(true);

    await openSessionsSidebar(page);
    await openWorkspaceSession(page, MAIN_WORKSPACE, 'Archived Planning Session');
    await expectSidebarClosed(page);
    await expect(page.locator('#messages')).toContainText('Summarize archived plan', { timeout: 10_000 });
    await page.evaluate(() => {
      const w = window as unknown as { __frozenIdleCallback: IdleRequestCallback | null };
      w.__frozenIdleCallback?.({ didTimeout: false, timeRemaining: () => 0 } as IdleDeadline);
    });

    const log = await consoleLogText(page);
    await expect(log).toContainText('[HISTORY_RENDER]');
    const line = (await log.innerText()).split('\n').find(l => l.includes('[HISTORY_RENDER]')) || '';
    expect(line, '没写会话号').toContain('mock-session-long-history');
    expect(line, '没写已渲染条数').toContain('40/2000');
    const ids = line.match(/instance=(\S+?)→(\S+?)(\s|$)/);
    expect(ids, `没写两个实例号：${line}`).not.toBeNull();
    expect(ids![1], '两个实例号应当不同').not.toBe(ids![2]);
  });

  test('P0-HIST-STALL-2 第 62 条渲染抛错：日志记下是哪条、带齐字段；提示条上点「重新加载」后消息完整恢复，不重复', async ({ page }) => {
    await gotoMock(page);
    // 第 62 条（第 2 块里）让 marked.parse 抛一次：之后照常，好让「重新加载」那一趟画得出来
    await page.evaluate(() => {
      const m = (window as unknown as { marked: { parse: (s: string, ...rest: unknown[]) => string } }).marked;
      const parse = m.parse;
      let thrown = false;
      m.parse = function (this: unknown, src: string, ...rest: unknown[]) {
        if (!thrown && src === 'Long history stress message #61') { thrown = true; throw new Error('injected render failure'); }
        return parse.call(this, src, ...rest);
      };
    });
    await openLongHistory(page);
    await expect(page.locator('#messages')).toContainText(LONG_NOTICE, { timeout: 15_000 });
    const reload = page.locator('#messages [data-testid="history-reload"]');
    await expect(reload, '停在只有提示条时没有原地「重新加载」').toBeVisible();
    await expect(bubbles(page), '前提：注入后停在只有提示条').toHaveCount(0);

    const log = await consoleLogText(page);
    await expect(log).toContainText('[HISTORY_RENDER]');
    const line = (await log.innerText()).split('\n').find(l => l.includes('[HISTORY_RENDER]')) || '';
    expect(line, '没写是第几条').toContain('62/2000');
    expect(line, '没写会话号').toContain('mock-session-long-history');
    expect(line, '没写已渲染条数').toContain('已渲染 61/2000');
    expect(line, '没写错误原文').toContain('injected render failure');
    expect(line, `没写两个实例号：${line}`).toMatch(/instance=\S+ 当前=\S+/);
    await page.locator('#consoleClose').click();

    await reload.click();
    await expect(page.locator('[data-testid="assistant-message"]', { hasText: 'Long history final message marker' })).toBeVisible({ timeout: 15_000 });
    await expect(bubbles(page), '重新加载后条数不对（丢了或重复了）').toHaveCount(2000);
    await expect(page.locator('#messages').getByText(LONG_NOTICE), '提示条重复了').toHaveCount(1);
    await expect(reload, '恢复之后不该还挂着「重新加载」').toHaveCount(0);
    expect(pageErrorsExcept(page, 'injected render failure')).toEqual([]);
  });

  // 原地按钮只挂在已知的两处停下的地方上；别的路径（正文假设 3）停住时，靠顶栏「⋯」里常驻的那一项
  test('P0-HIST-STALL-3 顶栏「⋯」→「重新加载本会话」：停住后同样能恢复、不重复；没打开会话时这一项不可点', async ({ page }) => {
    await gotoMock(page);
    await page.locator('#btnHome').click();
    await expect(page.locator('#messages')).toHaveClass(/empty-start/);
    await page.locator('#btnMore').click();
    await expect(page.locator('#moreModal')).toBeVisible();
    await expect(page.locator('#moreReloadSession'), '首页没有会话，不该能点').toBeDisabled();
    await page.locator('#moreCancel').click();
    await expect(page.locator('#moreModal')).toBeHidden();

    await page.evaluate(() => {
      const m = (window as unknown as { marked: { parse: (s: string, ...rest: unknown[]) => string } }).marked;
      const parse = m.parse;
      let thrown = false;
      m.parse = function (this: unknown, src: string, ...rest: unknown[]) {
        if (!thrown && src === 'Long history stress message #61') { thrown = true; throw new Error('injected render failure'); }
        return parse.call(this, src, ...rest);
      };
    });
    await openLongHistory(page);
    await expect(page.locator('#messages')).toContainText(LONG_NOTICE, { timeout: 15_000 });
    await expect(bubbles(page), '前提：注入后停在只有提示条').toHaveCount(0);

    await page.locator('#btnMore').click();
    await page.locator('#moreReloadSession').click();
    await expect(page.locator('#moreModal')).toBeHidden();
    await expect(page.locator('[data-testid="assistant-message"]', { hasText: 'Long history final message marker' })).toBeVisible({ timeout: 15_000 });
    await expect(bubbles(page), '重新加载后条数不对（丢了或重复了）').toHaveCount(2000);
    await expect(page.locator('#messages').getByText(LONG_NOTICE), '提示条重复了').toHaveCount(1);
    expect(pageErrorsExcept(page, 'injected render failure')).toEqual([]);
  });
});
