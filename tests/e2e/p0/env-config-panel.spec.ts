// spec: docs/testing.md
// helpers: tests/helpers/playwright.ts
// 服务与配置面板：设置入口 → 表单由服务端 env:get 下发（前端零硬编码配置项名）→ 敏感项只显示遮罩。
// 最重要的一条是「敏感项永远拿不到明文」——服务端只下发 { set, length }，页面上不该出现任何密钥值。

import { test, expect } from '@playwright/test';
import { expectNoBrowserErrors, gotoMock, openGeneralDiagSection, openGeneralSettings, sendChatMessage, waitForIdle } from '../../helpers/playwright';

test.describe('P0 日常零 token Mock UI 回归', () => {
  test('P0-31 服务与配置面板：入口打开 → 分组渲染 → 敏感项遮罩 → 只读项禁用', async ({ page }) => {
    await gotoMock(page);

    // 1. 设置 → 诊断段 → 服务与配置：面板弹出，设置 sheet 收起
    await openGeneralSettings(page);
    await openGeneralDiagSection(page);
    await page.locator('#btnEnvConfig').click();
    await expect(page.locator('#envConfigModal')).toBeVisible();
    await expect(page.locator('#settingsSheet')).toHaveClass(/translate-y-full/);

    const body = page.locator('#envConfigBody');

    // 2. 分组标题来自服务端下发（前端不硬编码任何配置项名）
    await expect(body).toContainText('鉴权');
    await expect(body).toContainText('运行时');
    await expect(body).toContainText('推送');

    // 3. 普通项渲染出当前值
    await expect(body.locator('input[data-key="PORT"]')).toHaveValue('3000');
    await expect(body.locator('input[data-key="WORK_DIR"]')).toHaveValue('/Users/you/code');

    // 4. ★ 敏感项只显示「已设置（N 字符）」，页面上不得出现明文
    await expect(body).toContainText('已设置（64 字符）'); // AUTH_TOKEN
    await expect(body).toContainText('已设置（43 字符）'); // VAPID_PRIVATE_KEY
    // 遮罩项在点「更换」之前根本没有输入框可读
    await expect(body.locator('input[data-key="AUTH_TOKEN"]')).toHaveCount(0);

    // 5. 只读诊断段：解释「为什么 ANTHROPIC_* 不在表单里」，少了它用户会以为面板漏了
    await expect(body).toContainText('此处不可改');
    await expect(body).toContainText('ANTHROPIC_*');

    // 6. 未设置的项渲染成空输入框（而不是缺席）
    await expect(body.locator('input[data-key="NTFY_TOPIC"]')).toHaveValue('');

    await expectNoBrowserErrors(page);
  });

  test('P0-31b 保存按钮：无改动时禁用，改一项后启用', async ({ page }) => {
    await gotoMock(page);
    await openGeneralSettings(page);
    await openGeneralDiagSection(page);
    await page.locator('#btnEnvConfig').click();

    const save = page.locator('#envConfigSave');
    await expect(save).toBeDisabled();

    // 改端口 → 按钮可用 + 提示需重启（配置生效靠重启，这点必须在保存前就说清）
    await page.locator('#envConfigBody input[data-key="PORT"]').fill('8080');
    await expect(save).toBeEnabled();
    await expect(page.locator('#envConfigHint')).toContainText('重启');

    // 改回原值 → 重新变回「无改动」，不该留下假的脏标记
    await page.locator('#envConfigBody input[data-key="PORT"]').fill('3000');
    await expect(save).toBeDisabled();

    await expectNoBrowserErrors(page);
  });

  test('P0-31c 敏感项「更换」：点了才换出输入框，且提交空值表示清除', async ({ page }) => {
    await gotoMock(page);
    await openGeneralSettings(page);
    await openGeneralDiagSection(page);
    await page.locator('#btnEnvConfig').click();

    const body = page.locator('#envConfigBody');
    const secretInput = body.locator('input[data-key="VAPID_PRIVATE_KEY"]');

    // 初始隐藏
    await expect(secretInput).toBeHidden();

    // 点「更换」→ 输入框出现，且立刻算作一次改动（留空 = 清除该项，这个意图得能表达）
    await body.getByRole('button', { name: '更换' }).first().click();
    await expect(secretInput).toBeVisible();
    await expect(page.locator('#envConfigSave')).toBeEnabled();

    await expectNoBrowserErrors(page);
  });

  test('P0-31d 关闭：✕ 与点遮罩都能收起', async ({ page }) => {
    await gotoMock(page);
    await openGeneralSettings(page);
    await openGeneralDiagSection(page);

    await page.locator('#btnEnvConfig').click();
    await expect(page.locator('#envConfigModal')).toBeVisible();
    await page.locator('#envConfigClose').click();
    await expect(page.locator('#envConfigModal')).toBeHidden();

    await expectNoBrowserErrors(page);
  });
});

test.describe('P0 日常零 token Mock UI 回归 · 保存路径', () => {
  // ★ 这一组补的是审查指出的最大缺口：保存路径此前端到端零覆盖，
  // 而 env-config.js 自己写的不变量 #3「只提交真正改动过的项」一旦回归，
  // AUTH_TOKEN 会被写成「已设置（64 字符）」——所有设备连同正在操作的手机一起被关在门外。
  test('P0-31e 只提交改动过的那一项（不是整份表单）', async ({ page }) => {
    await gotoMock(page);
    await openGeneralSettings(page);
    await openGeneralDiagSection(page);
    await page.locator('#btnEnvConfig').click();

    // 表单里有 PORT / WORK_DIR / NTFY_TOPIC / DEV_MODE / 两个敏感项，只改一个
    await page.locator('#envConfigBody input[data-key="PORT"]').fill('8080');
    await page.locator('#envConfigSave').click();

    // mock 把收到的 key 原样回在 written 里，前端渲染成「已写入 N 项」
    await expect(page.locator('#envConfigHint')).toContainText('已写入 1 项');
    await expectNoBrowserErrors(page);
  });

  // canRestart:false 那一侧此前零覆盖——mock 74 处广播全硬编码 true，把整个分支删掉
  // 全套 E2E 照样绿。而它恰恰是「前台 npm start 的用户」会看到的唯一形态：
  // 配置写进文件了、进程里还是旧值，若不明说得去电脑上重启，这条路就断在最后一步。
  test('P0-31g 非常驻托管时不给「立即重启」，而是明说要到电脑上重启', async ({ page }) => {
    await gotoMock(page);
    await sendChatMessage(page, 'test:no-restart');
    await waitForIdle(page);

    await openGeneralSettings(page);
    await openGeneralDiagSection(page);
    await page.locator('#btnEnvConfig').click();
    await page.locator('#envConfigBody input[data-key="PORT"]').fill('8080');
    await page.locator('#envConfigSave').click();

    const hint = page.locator('#envConfigHint');
    await expect(hint).toContainText('已写入 1 项');
    await expect(hint).toContainText('本进程不是常驻托管');
    // 查 DOM 存在性而不是文案：按钮不该被渲染出来（点了也没用，只会让人以为重启了）
    await expect(page.locator('#envConfigRestart')).toHaveCount(0);
    await expectNoBrowserErrors(page);
  });

  test('P0-31f 保存成功后出现「立即重启」入口（mock 广播 canRestart:true）', async ({ page }) => {
    await gotoMock(page);
    await openGeneralSettings(page);
    await openGeneralDiagSection(page);
    await page.locator('#btnEnvConfig').click();

    await expect(page.locator('#envConfigRestart')).toHaveCount(0, { timeout: 2000 });
    await page.locator('#envConfigBody input[data-key="PORT"]').fill('8080');
    await page.locator('#envConfigSave').click();

    // 配置只写进了文件、进程里还是旧值 —— 没有这个入口，「手机上改配置」就断在最后一步
    await expect(page.locator('#envConfigRestart')).toBeVisible();
    await expect(page.locator('#envConfigHint')).toContainText('重启');
    await expectNoBrowserErrors(page);
  });

  test('P0-31g 改两项则提交两项', async ({ page }) => {
    await gotoMock(page);
    await openGeneralSettings(page);
    await openGeneralDiagSection(page);
    await page.locator('#btnEnvConfig').click();

    await page.locator('#envConfigBody input[data-key="PORT"]').fill('8080');
    await page.locator('#envConfigBody input[data-key="NTFY_TOPIC"]').fill('my-topic');
    await page.locator('#envConfigSave').click();

    await expect(page.locator('#envConfigHint')).toContainText('已写入 2 项');
    await expectNoBrowserErrors(page);
  });

  // VC-D4-01（2026-08-26 探索性测试）：AUTH_TOKEN 那一行必须**看得出来是只读的**。
  // 上面 P0-31 已经断言了「不出现明文」与「没有输入框」，但没断「用户看得到 readonly 这件事」。
  // 差别在于失败形态：少了 `只读` 标记，用户只会看到一行没有输入框的字，
  // 于是去点「更换」——而这一项刻意没有「更换」按钮（在手机上改错 token 会把自己锁在门外，
  // 见 env-schema.js 顶注第 2 条）。看不出只读，就只剩「这面板坏了」这一个解释。
  test('P0-31h AUTH_TOKEN 行：长度 + 只读标记 + 没有「更换」入口（三者缺一都会误导）', async ({ page }) => {
    await gotoMock(page);
    await openGeneralSettings(page);
    await openGeneralDiagSection(page);
    await page.locator('#btnEnvConfig').click();
    await expect(page.locator('#envConfigModal')).toBeVisible();

    // 定位到 AUTH_TOKEN 那一行本身（而不是在整块面板里模糊搜字，那会被别的 secret 项串味）
    const row = page.locator('#envConfigBody')
      .locator('div', { has: page.locator('code', { hasText: /^AUTH_TOKEN$/ }) }).first();

    await expect(row).toContainText('已设置（64 字符）');   // 值位给的是长度，不是任何一段真实字符
    await expect(row).toContainText('只读');                 // ★ 本条新增的那一维
    await expect(row.locator('button', { hasText: '更换' })).toHaveCount(0);
    await expect(row.locator('input')).toHaveCount(0);
    // 只读的理由要留在屏幕上，否则用户只知道「改不了」不知道「去哪改」
    await expect(row).toContainText('npm run setup');

    await expectNoBrowserErrors(page);
  });
});
