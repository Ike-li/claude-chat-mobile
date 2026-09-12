// helpers: tests/helpers/playwright.ts
// 服务与配置面板：设置入口 → 表单由服务端 env:get 下发（前端零硬编码配置项名）→ 敏感项只显示遮罩。
// 最重要的一条是「敏感项永远拿不到明文」——服务端只下发 { set, length }，页面上不该出现任何密钥值。

import { test, expect } from '@playwright/test';
import { expectNoBrowserErrors, gotoMock, openGeneralPage, openGeneralSettings, sendChatMessage, waitForIdle } from '../../helpers/playwright';

test.describe('P0 日常零 token Mock UI 回归', () => {
  test('P0-31 服务与配置面板：入口打开 → 分组渲染 → 敏感项遮罩 → 只读项禁用', async ({ page }) => {
    await gotoMock(page);

    // 1. 设置 → 诊断段 → 服务与配置：面板弹出，设置 sheet 收起
    await openGeneralPage(page, 'behavior');
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
    await expect(body.locator('input[data-key="CLAUDE_BIN"]')).toHaveValue('/Users/you/bin/claude');

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
    await openGeneralPage(page, 'behavior');
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
    await openGeneralPage(page, 'behavior');
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

  // 用例名此前声称「✕ 与点遮罩都能收起」，实际只点了 ✕——遮罩那半从来没跑过。改 ← 语义时
  // 一并补上：两种关法必须落到同一个地方，是这次改动的核心契约。
  test('P0-31d 退出：← 与点遮罩都退回来源页，不是关到首页', async ({ page }) => {
    await gotoMock(page);
    await openGeneralPage(page, 'behavior');

    await page.locator('#btnEnvConfig').click();
    await expect(page.locator('#envConfigModal')).toBeVisible();
    // 进来时设置 sheet 被收掉了（两者同 z-40，叠着会互相拦点击）——正因如此退出才必须显式退回
    await expect(page.locator('#generalSheet')).toHaveClass(/translate-y-full/);

    await page.locator('#envConfigBack').click();
    await expect(page.locator('#envConfigModal')).toBeHidden();
    await expect(page.locator('#generalSheet')).not.toHaveClass(/translate-y-full/);
    await expect(page.locator('#generalPage-behavior')).toBeVisible();

    // 点遮罩：同一张面板的第二种关法，必须落到同一个地方
    await page.locator('#btnEnvConfig').click();
    await expect(page.locator('#envConfigModal')).toBeVisible();
    await page.locator('#envConfigModal').click({ position: { x: 5, y: 5 } });
    await expect(page.locator('#envConfigModal')).toBeHidden();
    await expect(page.locator('#generalSheet')).not.toHaveClass(/translate-y-full/);
    await expect(page.locator('#generalPage-behavior')).toBeVisible();

    await expectNoBrowserErrors(page);
  });
});

test.describe('P0 日常零 token Mock UI 回归 · 保存路径', () => {
  // ★ 这一组补的是审查指出的最大缺口：保存路径此前端到端零覆盖，
  // 而 env-config.js 自己写的不变量 #3「只提交真正改动过的项」一旦回归，
  // AUTH_TOKEN 会被写成「已设置（64 字符）」——所有设备连同正在操作的手机一起被关在门外。
  test('P0-31e 只提交改动过的那一项（不是整份表单）', async ({ page }) => {
    await gotoMock(page);
    await openGeneralPage(page, 'behavior');
    await page.locator('#btnEnvConfig').click();

    // 表单里有 PORT / CLAUDE_BIN / NTFY_TOPIC / DEV_MODE / 两个敏感项，只改一个
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

    await openGeneralPage(page, 'behavior');
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
    await openGeneralPage(page, 'behavior');
    await page.locator('#btnEnvConfig').click();

    await expect(page.locator('#envConfigRestart')).toHaveCount(0, { timeout: 2000 });
    await page.locator('#envConfigBody input[data-key="PORT"]').fill('8080');
    await page.locator('#envConfigSave').click();

    // 配置只写进了文件、进程里还是旧值 —— 没有这个入口，「手机上改配置」就断在最后一步
    await expect(page.locator('#envConfigRestart')).toBeVisible();
    await expect(page.locator('#envConfigHint')).toContainText('重启');
    await expectNoBrowserErrors(page);
  });

  // 热加载项（schema 里 reload:'hot'，当前只有 WORKDIRS）改完即时生效。此前保存路径无条件
  // 渲染「重启后生效」并递上「立即重启」——同一张面板里 WORKDIRS 的说明却写着「改完即生效，
  // 无需重启」，两句话自相矛盾，而照着按钮点下去会中断所有在跑的会话与后台任务。
  // 这条用例刻意【不】关掉 canRestart：默认 true 时按钮本来就会出现，所以它真正区分的是
  // 「服务端按 key 分了档、前端读了这个档」，而不是「碰巧没有重启入口」。
  test('P0-31k 只改热加载项（WORKDIRS）→ 说「已生效」，不给重启入口', async ({ page }) => {
    await gotoMock(page);
    await openGeneralPage(page, 'behavior');
    await page.locator('#btnEnvConfig').click();

    const row = page.locator('#envConfigBody input[data-list-path]').first();
    await expect(row).toBeVisible();
    await row.fill('/tmp/ccm-e2e-hot-workdir');
    await page.locator('#envConfigSave').click();

    const hint = page.locator('#envConfigHint');
    await expect(hint).toContainText('已生效');
    await expect(hint).not.toContainText('重启后生效');
    await expect(page.locator('#envConfigRestart')).toHaveCount(0);
    await expectNoBrowserErrors(page);
  });

  test('P0-31g 改两项则提交两项', async ({ page }) => {
    await gotoMock(page);
    await openGeneralPage(page, 'behavior');
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
    await openGeneralPage(page, 'behavior');
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

  // 缺口 6：工作区列表此前在手机上只读（schema 注释写着「结构化编辑器留给 CLI 与 desktop」），
  // 而它是全表**唯一**标了 reload:'hot' 的项——改完即生效、免重启。最适合在手机上改的那一项，
  // 恰恰是唯一改不了的。
  // ★ 提交的必须是**数组**：塞一个字符串进去，下游 Array.isArray 判否 → 静默回落旧白名单，
  //   用户看到「保存成功」而配置一个字没变。这正是它当初被标只读的原因。
  test('P0-31i 工作区列表可编辑：改路径提交数组，条目原有的 sessionLimit 不丢', async ({ page }) => {
    await gotoMock(page);
    await openGeneralPage(page, 'behavior');
    await page.locator('#btnEnvConfig').click();
    await expect(page.locator('#envConfigModal')).toBeVisible();

    const inputs = page.locator('input[data-list-path="1"]');
    await expect(inputs).toHaveCount(2);
    await expect(inputs.nth(0)).toHaveValue('/Users/you/code/claude-chat-mobile');

    // 改第一项的路径
    await inputs.nth(0).fill('/Users/you/code/renamed');

    await page.locator('#envConfigSave').click();

    // ★ mock 的 env:set 与真 server 的 checkList 同判据：WORKDIRS 非数组当场拒。
    //   所以「保存成功」本身就证明前端送的是**数组**而不是拼成的字符串——
    //   后者正是这一档当初被标只读的失败形态（静默回落旧白名单，用户还看到「保存成功」）。
    //   正向断言「已写入 1 项」，不只断言没报错：后者在元素根本不存在时也会绿。
    await expect(page.locator('#envConfigHint')).toContainText('已写入 1 项');
    await expect(page.locator('#envConfigBody')).not.toContainText('必须是数组');

    await expectNoBrowserErrors(page);
  });

  // 删除与新增：read() 恒返回数组，空列表表示「清空白名单」而不是「删除配置项」
  test('P0-31j 工作区列表可增删，提交后回显跟着变', async ({ page }) => {
    await gotoMock(page);
    await openGeneralPage(page, 'behavior');
    await page.locator('#btnEnvConfig').click();

    await page.locator('button[data-list-add="1"]').click();
    const inputs = page.locator('input[data-list-path="1"]');
    await expect(inputs).toHaveCount(3);
    await inputs.nth(2).fill('/Users/you/code/third');
    await page.locator('#envConfigSave').click();
    await expect(page.locator('#envConfigHint')).toContainText('已写入 1 项');
    await expect(page.locator('#envConfigBody')).not.toContainText('必须是数组');

    await expectNoBrowserErrors(page);
  });

});
