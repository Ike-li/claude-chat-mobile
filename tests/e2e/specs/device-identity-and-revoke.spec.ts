// spec: 设备身份自证（本机设备指纹）与已信任设备的吊销（已受信任的设备）——两段同在「🔐 接入与设备」页。
// （旧注释把吊销记在「🖥 这台电脑」名下，那是两级导航改版前的位置，早已不对。）
//
// 这两块是同一个决策的两半：面板里那堆条目里「哪个是我手上这台」——同一 iOS 版本的 Safari UA
// 逐字节相同，只看类型和时间分不出来，所以本机必须能自证短 ID，用户才敢吊销其余的。
// 核心回归点：① 指纹与 localStorage 里的 device_token 同源且是同一套短形式；
// ② isCurrent 那条**不给**吊销按钮（点了必然被服务端的 self 守卫拒掉，摆一个必败按钮本身就是缺陷）；
// ③ 没有元数据的条目如实说「无批准记录」，不编时间。
// helpers: tests/helpers/playwright.ts

import { test, expect } from '@playwright/test';
import { gotoMock, expectNoBrowserErrors } from '../../helpers/playwright';

// 指纹与信任名单同住「接入与设备」这一页——面板是两级的，不切页的话它们在 hidden 子页里，
// DOM 查得到但点不到。先确认 sheet 真的开了再读里面的文字：面板是常驻 DOM，没开就读会读到上一次的残留。
async function openGeneralSettings(page) {
  await page.locator('#btnSessions').click();
  await page.locator('#btnGeneralSettings').click();
  await expect(page.locator('#generalSheet')).not.toHaveClass(/translate-y-full/);
  await page.locator('[data-testid="general-nav-devices"]').click();
  await expect(page.locator('#generalPage-devices')).toBeVisible();
}

test.describe('设备身份与吊销', () => {
  test('本机指纹与 localStorage 的 device_token 同源，且是 前8…后4', async ({ page }) => {
    await gotoMock(page);
    await openGeneralSettings(page);

    const token = await page.evaluate(() => localStorage.getItem('device_token'));
    expect(token).toMatch(/^[0-9a-f]{32}$/); // app.js 用 16 字节随机数生成

    const shown = await page.getByTestId('device-fingerprint-short').textContent();
    expect(shown).toBe(`${token!.slice(0, 8)}…${token!.slice(-4)}`);

    // 完整 ID 折在 <details> 里，但内容必须是同一串——用户核对不上时要能展开看全量
    await expect(page.getByTestId('device-fingerprint-full')).toHaveText(token!);

    await expectNoBrowserErrors(page);
  });

  test('已信任设备列表：当前这台不给吊销按钮，缺元数据的条目如实说无批准记录', async ({ page }) => {
    await gotoMock(page);
    await openGeneralSettings(page);

    const rows = page.getByTestId('trusted-device-row');
    await expect(rows).toHaveCount(3);

    // isCurrent 那条：有徽章、没有吊销按钮
    const current = rows.filter({ hasText: '这台（当前）' });
    await expect(current).toHaveCount(1);
    await expect(current.getByTestId('trusted-device-revoke')).toHaveCount(0);

    // 其余两条都可吊销
    await expect(page.getByTestId('trusted-device-revoke')).toHaveCount(2);

    // approvedAt=null 的那条（mock 里 shortId 7e6d…）：不编时间
    await expect(rows.filter({ hasText: '7e6d1122…3ede' })).toContainText('无批准记录');
    // 有元数据的那条给相对时间，不是绝对时间戳
    await expect(rows.filter({ hasText: 'a3f21b09…a4b5' })).toContainText('天前批准');

    await expectNoBrowserErrors(page);
  });

  test('吊销走二次确认；确认后该条从列表消失，当前这台不受影响', async ({ page }) => {
    await gotoMock(page);
    await openGeneralSettings(page);

    const target = page.getByTestId('trusted-device-row').filter({ hasText: 'a3f21b09…a4b5' });
    await target.getByTestId('trusted-device-revoke').click();

    // 破坏性操作必须过确认（appConfirm，不是原生 confirm）
    await expect(page.locator('#confirmModal')).toBeVisible();
    await page.locator('#confirmOk').click();

    await expect(page.getByTestId('trusted-device-row')).toHaveCount(2);
    await expect(page.getByTestId('trusted-device-row').filter({ hasText: 'a3f21b09…a4b5' })).toHaveCount(0);
    // 自己那条还在——吊销别人不该把当前设备带走
    await expect(page.getByTestId('trusted-device-row').filter({ hasText: '这台（当前）' })).toHaveCount(1);

    await expectNoBrowserErrors(page);
  });

  // ★ 2026-09-10 实录：机主把三台设备全吊销后，各设备照常可用——因为 CF Access 已验的连接
  // 走 bypass 分支，压根不查信任表。而当时脚注写的是「吊销后该设备立刻失去访问权」，
  // 用户照着操作，得到与文案相反的结果。这两条钉住脚注按管辖面分档。
  test('CF Access bypass 生效时，脚注必须直说这张表管不到隧道进来的连接', async ({ page }) => {
    await gotoMock(page);
    await page.request.post('/__access-bypass?active=1');
    await openGeneralSettings(page);

    const note = page.locator('#trustedDevicesNote');
    await expect(note).toContainText('吊销对它们无效');
    await expect(note).toContainText('DEVICE_APPROVAL_SCOPE');
    // 说反话的那句必须消失，不能两句并列
    await expect(note).not.toContainText('立刻失去访问权');
    await expect(note).toHaveClass(/text-warning/);

    await expectNoBrowserErrors(page);
  });

  test('bypass 未生效时用常规文案（吊销确实立刻生效）', async ({ page }) => {
    await gotoMock(page);
    await openGeneralSettings(page);

    const note = page.locator('#trustedDevicesNote');
    await expect(note).toContainText('立刻失去访问权');
    await expect(note).not.toContainText('吊销对它们无效');

    await expectNoBrowserErrors(page);
  });

  // ★ 实录：三条记录标题全是「Android」，只有短 ID 不同，用户看不出该吊销哪台。
  // 根因有二：同一部手机的微信 webview 与 Chrome 是两条独立记录（deviceToken 存在各自的
  // localStorage），而 Chrome 冻结了 UA 的机型位（`Android 10; K`），机型压根拿不到。
  // 所以标题要拼上浏览器，并允许用户自己起名——别名是唯一对所有平台都成立的分辨手段。
  test('标题拼上浏览器；有别名时别名压过自动信息', async ({ page }) => {
    await gotoMock(page);
    await openGeneralSettings(page);

    const names = page.getByTestId('trusted-device-name');
    await expect(names.nth(0)).toHaveText(/^客厅平板 · a3f21b09…a4b5$/, '有别名就只显示别名，不再拼类型/浏览器');
    await expect(names.nth(2)).toHaveText(/^Mac · Chrome 152 · cd2760a5…ec82$/, '没别名时拼类型与浏览器');
    // 机型拿不到是常态（Chrome 冻结 UA 机型位），不得留悬空分隔符
    await expect(names.nth(2)).not.toHaveText(/· ·|· $/);

    await expectNoBrowserErrors(page);
  });

  test('点 ✎ 就地改名：Enter 提交后标题变别名', async ({ page }) => {
    await gotoMock(page);
    await openGeneralSettings(page);

    const row = page.getByTestId('trusted-device-row').filter({ hasText: 'cd2760a5…ec82' });
    await row.getByTestId('trusted-device-rename').click();
    const input = row.getByTestId('trusted-device-alias-input');
    await expect(input).toBeVisible();
    await input.fill('我的 Mac');
    await input.press('Enter');

    await expect(page.getByTestId('trusted-device-name').nth(2)).toHaveText(/^我的 Mac · cd2760a5…ec82$/);
    await expectNoBrowserErrors(page);
  });

  test('Esc 放弃改名，标题回到原样', async ({ page }) => {
    await gotoMock(page);
    await openGeneralSettings(page);

    const row = page.getByTestId('trusted-device-row').filter({ hasText: 'cd2760a5…ec82' });
    await row.getByTestId('trusted-device-rename').click();
    const input = row.getByTestId('trusted-device-alias-input');
    await input.fill('不该被保存');
    await input.press('Escape');

    await expect(page.getByTestId('trusted-device-name').nth(2)).toHaveText(/^Mac · Chrome 152 · cd2760a5…ec82$/);
    await expectNoBrowserErrors(page);
  });

  test('取消确认则什么都不发生', async ({ page }) => {
    await gotoMock(page);
    await openGeneralSettings(page);

    await page.getByTestId('trusted-device-row').filter({ hasText: 'a3f21b09…a4b5' })
      .getByTestId('trusted-device-revoke').click();
    await expect(page.locator('#confirmModal')).toBeVisible();
    await page.locator('#confirmCancel').click();

    await expect(page.getByTestId('trusted-device-row')).toHaveCount(3);
    await expectNoBrowserErrors(page);
  });
});
