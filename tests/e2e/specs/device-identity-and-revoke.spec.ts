// spec: 设备身份自证（📱 这台手机 › 本机设备指纹）与已信任设备的吊销（🖥 这台电脑 › 已受信任的设备）。
//
// 这两块是同一个决策的两半：面板里那堆条目里「哪个是我手上这台」——同一 iOS 版本的 Safari UA
// 逐字节相同，只看类型和时间分不出来，所以本机必须能自证短 ID，用户才敢吊销其余的。
// 核心回归点：① 指纹与 localStorage 里的 device_token 同源且是同一套短形式；
// ② isCurrent 那条**不给**吊销按钮（点了必然被服务端的 self 守卫拒掉，摆一个必败按钮本身就是缺陷）；
// ③ 没有元数据的条目如实说「无批准记录」，不编时间。
// helpers: tests/helpers/playwright.ts

import { test, expect } from '@playwright/test';
import { gotoMock, expectNoBrowserErrors } from '../../helpers/playwright';

async function openGeneralSettings(page) {
  await page.locator('#btnSessions').click();
  await page.locator('#btnGeneralSettings').click();
  // 先确认 sheet 真的开了再读里面的文字：面板是常驻 DOM，没开就读会读到上一次的残留。
  await expect(page.locator('#generalSheet')).not.toHaveClass(/translate-y-full/);
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
