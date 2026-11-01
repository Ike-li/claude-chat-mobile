import { test, expect, type Page } from '@playwright/test';
import { expectNoBrowserErrors, gotoMock, sendChatMessage, waitForIdle, waitUntilConnected } from '../../helpers/playwright';
import { openSessionsSidebar } from '../../helpers/sidebar-ui';

// 抽屉「服务」小节里「N 个已连接的文件夹找不到了」的三个动作（#301）：管理工作区 / 重新检查 / 忽略。
// 此前这条告警没有任何入口，只要 missingFolders > 0 就一直挂着；能删缺失项的工作区编辑器藏在设置的「全部配置」里，
// 从告警出发找不到。目录回来以后还得重启服务——热加载只盯配置文件，不看目录本身在不在。
const A = '/Volumes/ext/project-a';
const B = '/Volumes/ext/project-b';

function alertRow(page: Page) {
  return page.locator('#serviceSection [data-notice-id="missing-folders"]');
}

async function setGone(page: Page, paths: string[], { apply = false } = {}) {
  await page.request.post(`/__set-gone-folders?paths=${encodeURIComponent(paths.join(','))}${apply ? '&apply=1' : ''}`);
}

test.describe('P0 日常零 token Mock UI 回归', () => {
  test('P0-SVC-ALERT-1 「管理文件夹」打开文件夹列表编辑器，删掉缺失项并保存后告警消失', async ({ page }) => {
    await gotoMock(page);
    await setGone(page, [A, B], { apply: true });
    await openSessionsSidebar(page);
    await expect(alertRow(page)).toContainText('2 个已连接的文件夹找不到了');
    await expect(alertRow(page), '文案不能再叫人重启服务').not.toContainText('重启服务');

    await alertRow(page).getByRole('button', { name: '管理文件夹' }).click();
    await expect(page.locator('#envConfigModal')).toBeVisible();
    const paths = page.locator('#envConfigBody input[data-list-path]');
    await expect(paths).toHaveCount(4);
    // 路径是赋给 input.value 的（不是 value 属性），只能逐行读出来比
    const rows = page.locator('#envConfigBody div:has(> input[data-list-path])');
    for (const gone of [A, B]) {
      const values = await rows.locator('input[data-list-path]').evaluateAll(els => els.map(e => (e as HTMLInputElement).value));
      expect(values, '编辑器里得看得见找不到的那几项').toContain(gone);
      await rows.nth(values.indexOf(gone)).getByRole('button', { name: '删除这一项' }).click();
    }
    await expect(paths).toHaveCount(2);
    await page.locator('#envConfigSave').click();
    await expect(page.locator('#envConfigHint')).toContainText('已生效');
    await page.locator('#envConfigBack').click();
    await expect(page.locator('#envConfigModal')).toBeHidden();

    await openSessionsSidebar(page);
    await expect(page.locator('#serviceSection')).toBeHidden();
    await expectNoBrowserErrors(page);
  });

  // 服务端察觉不到目录回来（不盯目录本身），所以只改磁盘态时告警原样挂着；点「重新检查」才重算。
  test('P0-SVC-ALERT-2 「重新检查」：一个目录回来后计数减 1，不用重启服务', async ({ page }) => {
    await gotoMock(page);
    await setGone(page, [A, B], { apply: true });
    await openSessionsSidebar(page);
    await expect(alertRow(page)).toContainText('2 个已连接的文件夹找不到了');

    await setGone(page, [B]); // A 挂回来了
    await expect(alertRow(page), '前提：服务端自己察觉不到').toContainText('2 个已连接的文件夹找不到了');
    await alertRow(page).getByRole('button', { name: '重新检查' }).click();
    await expect(alertRow(page)).toContainText('1 个已连接的文件夹找不到了');
    await expect(page.locator('#leftSidebar [data-testid="drawer-notice"]')).toHaveText('还有 1 个找不到');

    await setGone(page, []);
    await alertRow(page).getByRole('button', { name: '重新检查' }).click();
    await expect(page.locator('#serviceSection')).toBeHidden();
    await expect(page.locator('#leftSidebar [data-testid="drawer-notice"]')).toHaveText('都找到了');
    await expectNoBrowserErrors(page);
  });

  // #355：一键按原始配置条目删掉仍找不到的；目录已恢复的那项不能被旧告警误删。
  test('P0-SVC-ALERT-6 「从列表移除缺失项」：只删仍缺失的，已恢复的保留', async ({ page }) => {
    await gotoMock(page);
    await setGone(page, [A, B], { apply: true });
    await openSessionsSidebar(page);
    await expect(alertRow(page)).toContainText('2 个已连接的文件夹找不到了');

    await setGone(page, [B]); // A 挂回来了，但还没点重新检查——告警仍写着 2 个
    // 改写配置是破坏性的：先确认，并列出要删的路径；取消就什么都不动
    await alertRow(page).getByRole('button', { name: '从列表移除缺失项' }).click();
    await expect(page.locator('#confirmModal')).toHaveClass(/sheet-open/);
    await expect(page.locator('#confirmBody')).toContainText(A);
    await expect(page.locator('#confirmBody')).toContainText(B);
    await page.locator('#confirmCancel').click();
    await expect(page.locator('#confirmModal')).not.toHaveClass(/sheet-open/);
    await expect(alertRow(page)).toContainText('2 个已连接的文件夹找不到了');

    await alertRow(page).getByRole('button', { name: '从列表移除缺失项' }).click();
    await page.locator('#confirmOk').click();
    // 服务端复核后只删仍缺失的 B；A 已恢复，不能被旧告警误删
    await expect(page.locator('#leftSidebar [data-testid="drawer-notice"]')).toHaveText('已移除 1 项');
    await expect(page.locator('#serviceSection')).toBeHidden();
    await expectNoBrowserErrors(page);
  });

  // 指纹 = 告警 id + 路径集合，不是文案：切语言仍有效；个数相同但换了一个路径要重新出现。
  test('P0-SVC-ALERT-3 「忽略」：刷新、切语言后都不再出现；缺失数量相同但路径换了就重新出现', async ({ page }) => {
    await gotoMock(page);
    await setGone(page, [A], { apply: true });
    await openSessionsSidebar(page);
    await expect(alertRow(page)).toContainText('1 个已连接的文件夹找不到了');
    await alertRow(page).getByRole('button', { name: '忽略' }).click();
    await expect(page.locator('#serviceSection')).toBeHidden();

    await page.reload();
    await waitUntilConnected(page);
    await openSessionsSidebar(page);
    await expect(page.locator('#serviceSection')).toBeHidden();

    await page.evaluate(() => localStorage.setItem('ccm_lang', 'en'));
    await page.reload();
    await waitUntilConnected(page);
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await openSessionsSidebar(page);
    await expect(page.locator('#serviceSection'), '按文案匹配的话，换成英文就会重新冒出来').toBeHidden();

    await setGone(page, [B], { apply: true }); // A 回来了、B 丢了：个数还是 1
    await expect(alertRow(page)).toContainText('1 connected folder(s) can\'t be found');
    await expectNoBrowserErrors(page);
  });

  // 推送失败此前也没有任何关闭入口，只能等 24 小时时效窗过去或重启服务。它没有路径集合，指纹是发生时刻：
  // 忽略的是这一次失败，再失败一次必须重新出现——宿主机连不出去时，这一行是唯一的可见面。
  test('P0-SVC-ALERT-4 推送失败「忽略」：刷新后不再出现；再失败一次就重新出现', async ({ page }) => {
    const pushRow = page.locator('#serviceSection [data-notice-id="delivery-failure"]');
    await gotoMock(page);
    await sendChatMessage(page, 'test:service-delivery-failure');
    await waitForIdle(page);
    await openSessionsSidebar(page);
    await expect(pushRow).toContainText('推送最近失败于');
    await pushRow.getByRole('button', { name: '忽略' }).click();
    await expect(page.locator('#serviceSection')).toBeHidden();

    await page.reload();
    await waitUntilConnected(page);
    await openSessionsSidebar(page);
    await expect(page.locator('#serviceSection'), '忽略要落盘，刷新后不能又冒出来').toBeHidden();

    await page.reload();
    await waitUntilConnected(page);
    await sendChatMessage(page, 'test:service-delivery-failure'); // 又失败了一次：发生时刻变了
    await waitForIdle(page);
    await openSessionsSidebar(page);
    await expect(pushRow).toContainText('推送最近失败于');
    await expectNoBrowserErrors(page);
  });

  // 限速锁定与前端错误同理，按发生时刻忽略。真 server 发生这两类时不立刻广播，要等下一次广播或重连才到抽屉，
  // 所以注入后刷新取数，不让 mock 替它广播。
  test('P0-SVC-ALERT-5 限速锁定、前端错误「忽略」：刷新后不再出现；再发生一次就重新出现', async ({ page }) => {
    const section = page.locator('#serviceSection');
    const lockoutRow = section.locator('[data-notice-id="rate-limit-lockout"]');
    const errorRow = section.locator('[data-notice-id="client-error"]');
    const injectAndReload = async () => {
      await sendChatMessage(page, 'test:service-incidents');
      await waitForIdle(page);
      await page.reload();
      await waitUntilConnected(page);
    };
    await gotoMock(page);
    await injectAndReload();
    await openSessionsSidebar(page);
    await expect(lockoutRow).toContainText('登录限速锁定于');
    await expect(errorRow).toContainText('前端错误发生于');
    await lockoutRow.getByRole('button', { name: '忽略' }).click();
    await expect(lockoutRow).toHaveCount(0);
    await errorRow.getByRole('button', { name: '忽略' }).click();
    await expect(section).toBeHidden();

    await page.reload();
    await waitUntilConnected(page);
    await openSessionsSidebar(page);
    await expect(section, '忽略要落盘，刷新后不能又冒出来').toBeHidden();

    await page.reload();
    await waitUntilConnected(page);
    await injectAndReload(); // 又各发生了一次：发生时刻变了
    await openSessionsSidebar(page);
    await expect(lockoutRow).toContainText('登录限速锁定于');
    await expect(errorRow).toContainText('前端错误发生于');
    await expectNoBrowserErrors(page);
  });
});
