// spec: docs/testing.md
// helpers: tests/helpers/playwright.ts

import { test, expect } from '@playwright/test';
import { closeGeneralSettings, closeSettings, ensureComposerReady, expectNoBrowserErrors, gotoMock, openGeneralSettings, openSettingsSection, sendChatMessage, waitForIdle } from '../../helpers/playwright';

test.describe('P0 日常零 token Mock UI 回归', () => {
  test('P0-09 设置面板：权限模式、模型选择、thinking effort 与 [1m] 后缀', async ({ page }) => {
    await gotoMock(page);
    await ensureComposerReady(page);

    // 1. 打开配置面板，检查模型、权限、思考强度入口。
    await page.locator('#pillDefaults').click();
    await expect(page.locator('#settingsSheet')).not.toHaveClass(/translate-y-full/);
    await expect(page.locator('#modelSection')).toContainText('模型');
    await expect(page.locator('.model-tile')).toContainText(['Default (recommended)', 'Claude 3.5 Sonnet', 'Claude 3.5 Haiku', 'Claude 3 Opus', 'Claude 3 Opus (1m Context)']);
    await expect(page.locator('.perm-tile')).toHaveCount(6); // 含 CLI/SDK 支持但终端交互菜单不直接暴露的 auto

    // 2. 选择计划模式、[1m] 模型后缀和 high effort。
    await openSettingsSection(page, 'perm');
    await page.locator('.perm-tile[data-mode="plan"]').click();
    await openSettingsSection(page, 'model');
    await page.locator('.model-tile[data-model="claude-3-opus[1m]"]').click();
    await openSettingsSection(page, 'effort');
    await page.locator('.effort-tile[data-level="high"]').click();
    await expect(page.locator('#pillPermText')).toContainText('计划模式');
    await expect(page.locator('#modelInput')).toHaveValue('claude-3-opus[1m]');
    await expect(page.locator('#effortSelect')).toHaveValue('high');
    await closeSettings(page);
    await expect(page.locator('#settingsSheet')).toHaveClass(/translate-y-full/);

    await expectNoBrowserErrors(page);
  });

  // 方案 A：去掉折叠壳，打开即见三块磁贴；当前项 ring 框选；选完不收。
  // 底栏三条 chip 合并为 #pillDefaults 一条「模型 · 权限 · 思考」摘要。
  test('P0-09q 打开会话设置即见三块磁贴，选完保持展开并用框标当前项', async ({ page }) => {
    await gotoMock(page);
    await ensureComposerReady(page);
    await page.locator('#pillDefaults').click();

    await expect(page.locator('#settingsSheet')).not.toHaveClass(/translate-y-full/);
    // 三块始终可见，不再靠 summary open
    await expect(page.locator('.model-tile[data-model="claude-3-5-sonnet"]')).toBeVisible();
    await expect(page.locator('.perm-tile[data-mode="default"]')).toBeVisible();
    await expect(page.locator('#effortSection')).toBeVisible();

    await page.locator('.model-tile[data-model="claude-3-5-sonnet"]').click();
    // 选完不收：磁贴仍在，当前项带 ring
    await expect(page.locator('.model-tile[data-model="claude-3-5-sonnet"]')).toBeVisible();
    await expect(page.locator('.model-tile[data-model="claude-3-5-sonnet"]')).toHaveClass(/ring-accent/);
    // pill 显原始 value（非 displayName）；磁贴标题才是 Claude 3.5 Sonnet
    await expect(page.locator('#pillModelText')).toContainText('claude-3-5-sonnet');

    await page.locator('.perm-tile[data-mode="plan"]').click();
    await expect(page.locator('.perm-tile[data-mode="plan"]')).toHaveClass(/ring-accent/);
    await expect(page.locator('#pillPermText')).toContainText('计划模式');
    // 摘要 chip 连写
    await expect(page.locator('#pillDefaults')).toContainText('计划模式');

    await expectNoBrowserErrors(page);
  });

  // 底栏只剩一条摘要 chip：点一次打开会话设置，三块磁贴都在，不再分入口。
  test('P0-09r 底栏摘要 chip 打开会话设置，三块磁贴同时可见', async ({ page }) => {
    await gotoMock(page);
    await ensureComposerReady(page);

    await page.locator('#pillDefaults').click();
    await expect(page.locator('#settingsSheet')).not.toHaveClass(/translate-y-full/);
    await expect(page.locator('#modelSection')).toBeVisible();
    await expect(page.locator('#permSection')).toBeVisible();
    await expect(page.locator('#effortSection')).toBeVisible();
    await expect(page.locator('.model-tile').first()).toBeVisible();
    await expect(page.locator('.perm-tile').first()).toBeVisible();

    await expectNoBrowserErrors(page);
  });

  // 思考强度在数据上本就是模型的属性（logic.js effortLevelsFor 读 entry.supportedEffortLevels），
  // 但 UI 上长期是与「选择模型」并列的独立区块——切到不支持的模型时整块无声消失，用户只看到
  // 刚才还在的一栏没了，不给任何解释；而模型条目查不到时展示的又是全部模型档位的并集，
  // 并列摆着容易被当成「这些都能选」。改为从属表达：标题指明是谁的档，不支持时就地说明。
  test('P0-09p 思考强度从属于所选模型：标题带模型名，不支持时就地说明而非整块消失', async ({ page }) => {
    await gotoMock(page);
    await ensureComposerReady(page);
    await page.locator('#pillDefaults').click();

    // 支持 effort 的模型：区块说清这是「谁的」档位
    await openSettingsSection(page, 'model');
    await page.locator('.model-tile[data-model="claude-3-5-sonnet"]').click();
    await expect(page.locator('#customEffortGroup')).not.toHaveClass(/hidden/);
    await expect(page.locator('#effortOwnerModel')).toContainText('Claude 3.5 Sonnet');
    await expect(page.locator('#effortUnsupported')).toHaveClass(/hidden/);
    await expect(page.locator('.effort-tile[data-level="high"]')).toHaveCount(1);

    // 不支持的模型：区块留在原地并解释原因，不再凭空消失
    await openSettingsSection(page, 'model');
    await page.locator('.model-tile[data-model="claude-3-5-haiku"]').click();
    await expect(page.locator('#customEffortGroup')).not.toHaveClass(/hidden/);
    await expect(page.locator('#effortUnsupported')).not.toHaveClass(/hidden/);
    await expect(page.locator('#effortUnsupported')).toContainText('Claude 3.5 Haiku');
    await expect(page.locator('.effort-tile')).toHaveCount(0);

    // 换回支持的模型，档位回来且说明收起
    await openSettingsSection(page, 'model');
    await page.locator('.model-tile[data-model="claude-3-opus[1m]"]').click();
    await expect(page.locator('#effortOwnerModel')).toContainText('Claude 3 Opus (1m Context)');
    await expect(page.locator('#effortUnsupported')).toHaveClass(/hidden/);
    await expect(page.locator('.effort-tile[data-level="high"]')).toHaveCount(1);

    await expectNoBrowserErrors(page);
  });

  test('P0-09b 设置选择会随下一条消息发送并可见回显', async ({ page }) => {
    await gotoMock(page);
    await ensureComposerReady(page);

    await page.locator('#pillDefaults').click();
    await openSettingsSection(page, 'perm');
    await page.locator('.perm-tile[data-mode="plan"]').click();
    await expect(page.locator('#pillPermText')).toContainText('计划模式');
    await openSettingsSection(page, 'model');
    await page.locator('.model-tile[data-model="claude-3-opus[1m]"]').click();
    await openSettingsSection(page, 'effort');
    await page.locator('.effort-tile[data-level="high"]').click();
    await expect(page.locator('#modelInput')).toHaveValue('claude-3-opus[1m]');
    await expect(page.locator('#effortSelect')).toHaveValue('high');
    await closeSettings(page);

    await sendChatMessage(page, 'test:settings-echo');
    await waitForIdle(page);
    const reply = page.locator('[data-testid="assistant-message"]').last();
    await expect(reply).toContainText('model=claude-3-opus[1m]');
    await expect(reply).toContainText('permission=plan');
    await expect(reply).toContainText('effort=high');

    await expectNoBrowserErrors(page);
  });

  test('P0-09c 不支持 thinking effort 的模型不会沿用旧 effort', async ({ page }) => {
    await gotoMock(page);
    await ensureComposerReady(page);

    await page.locator('#pillDefaults').click();
    await openSettingsSection(page, 'effort');
    await page.locator('.effort-tile[data-level="high"]').click();
    await expect(page.locator('#effortSelect')).toHaveValue('high');

    await openSettingsSection(page, 'model');
    await page.locator('.model-tile[data-model="claude-3-5-haiku"]').click();
    await expect(page.locator('#modelInput')).toHaveValue('claude-3-5-haiku');
    // 档位区块留在原地并说明原因（见 P0-09p）；底栏 pill 仍隐藏——没有档位可显示，空 chip 是噪音。
    // 行为契约不变：档位清回 model-default，隐藏的兼容 select 置空。
    await expect(page.locator('.effort-tile')).toHaveCount(0);
    await expect(page.locator('#pillEffort')).toHaveClass(/hidden/);
    await expect(page.locator('#effortRow')).toHaveClass(/hidden/);
    await expect(page.locator('#effortSelect')).toHaveValue('');
    await closeSettings(page);

    await sendChatMessage(page, 'test:settings-echo');
    await waitForIdle(page);
    const reply = page.locator('[data-testid="assistant-message"]').last();
    await expect(reply).toContainText('model=claude-3-5-haiku');
    await expect(reply).toContainText('effort=model-default');

    await expectNoBrowserErrors(page);
  });

  test('P0-09d 新会话空首页设置会应用到首条消息', async ({ page }) => {
    await gotoMock(page);

    await page.locator('#btnNew').click();
    await expect(page.locator('#messages')).toHaveClass(/empty-start/);

    await page.locator('#pillDefaults').click();
    await expect(page.locator('#settingsSheet')).not.toHaveClass(/translate-y-full/);
    await openSettingsSection(page, 'perm');
    await page.locator('.perm-tile[data-mode="plan"]').click();
    await openSettingsSection(page, 'model');
    await page.locator('.model-tile[data-model="claude-3-opus[1m]"]').click();
    await openSettingsSection(page, 'effort');
    await page.locator('.effort-tile[data-level="high"]').click();
    await expect(page.locator('#pillPermText')).toContainText('计划模式');
    await expect(page.locator('#modelInput')).toHaveValue('claude-3-opus[1m]');
    await expect(page.locator('#effortSelect')).toHaveValue('high');
    // UX-019：empty-start 下档位变更不打居中系统条（胶囊承载）
    await expect(page.locator('#messages')).toHaveClass(/empty-start/);
    await expect(page.locator('#messages')).not.toContainText('权限档 →');
    await expect(page.locator('#messages')).not.toContainText('思考强度 →');
    await expect(page.locator('#messages')).not.toContainText('模型 →');
    await closeSettings(page);

    await sendChatMessage(page, 'test:fresh-settings-echo');
    await expect(page.locator('#messages')).not.toHaveClass(/empty-start/);
    await waitForIdle(page);
    const reply = page.locator('[data-testid="assistant-message"]').last();
    await expect(reply).toContainText('新会话设置回显：model=claude-3-opus[1m]');
    await expect(reply).toContainText('permission=plan');
    await expect(reply).toContainText('effort=high');

    await expectNoBrowserErrors(page);
  });

  test('P0-09e /model 本地命令只更新下一轮模型不发送聊天', async ({ page }) => {
    await gotoMock(page);
    await ensureComposerReady(page);

    await page.locator('#input').fill('/model claude-3-opus[1m]');
    await expect(page.locator('#btnSend')).toBeEnabled();
    await page.locator('#btnSend').click();

    await expect(page.locator('[data-testid="user-message"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="assistant-message"]')).toHaveCount(0);
    await expect(page.locator('#messages')).toContainText('模型已设为 claude-3-opus[1m]（下一条消息生效）');
    await expect(page.locator('#pillModelText')).toContainText('claude-3-opus[1m]');
    await expect(page.locator('#input')).toHaveValue('');

    await sendChatMessage(page, 'test:settings-echo');
    await waitForIdle(page);
    await expect(page.locator('[data-testid="user-message"]').last()).toContainText('test:settings-echo');
    await expect(page.locator('[data-testid="assistant-message"]').last()).toContainText('model=claude-3-opus[1m]');

    await expectNoBrowserErrors(page);
  });

  test('P0-09f CLI 镜像拿不到 effort 时显示未知，不伪装成 low', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:mirror-readonly');
    await expect(page.locator('#input')).toBeDisabled();
    await expect(page.locator('#pillEffortText')).toHaveText('CLI 档位未知', { timeout: 800 });

    await page.locator('#pillDefaults').click();
    await expect(page.locator('#effortSelect')).toHaveValue('');
    await expect(page.locator('#effortSelect option:checked')).toHaveText('CLI 当前档未知');

    await expectNoBrowserErrors(page);
  });

  test('P0-09g CLI 镜像展示观察态，接管后恢复 Web 设置偏好', async ({ page }) => {
    await gotoMock(page);
    await ensureComposerReady(page);

    await page.locator('#pillDefaults').click();
    await openSettingsSection(page, 'perm');
    await page.locator('.perm-tile[data-mode="plan"]').click();
    await openSettingsSection(page, 'model');
    await page.locator('.model-tile[data-model="claude-3-opus[1m]"]').click();
    await openSettingsSection(page, 'effort');
    await page.locator('.effort-tile[data-level="ultracode"]').click();
    await closeSettings(page);

    await sendChatMessage(page, 'test:mirror-observed-settings');
    await expect(page.locator('#input')).toBeDisabled();
    await expect(page.locator('#pillModelText')).toHaveText('claude-opus-4-8[1m]');
    await expect(page.locator('#pillPermText')).toHaveText('Auto');
    await expect(page.locator('#pillEffortText')).toHaveText('max');

    await page.locator('#btnSend').click();
    await expect(page.locator('#confirmModal')).toBeVisible();
    await page.locator('#confirmOk').click();
    await expect(page.locator('#input')).toBeEnabled();
    await expect(page.locator('#modelInput')).toHaveValue('claude-3-opus[1m]');
    await expect(page.locator('#pillPermText')).toHaveText('计划模式');
    await expect(page.locator('#effortSelect')).toHaveValue('ultracode');

    await expectNoBrowserErrors(page);
  });

  test('P0-09h 超长模型名在摘要 chip 内单行省略且 title 含完整名', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:longmodel');
    await waitForIdle(page);

    await expect(page.locator('#pillModelText')).toHaveText('mimo-v2.5-pro-ultraspeed');
    // 合并 chip 的 title 是「模型 · 权限 · 思考」摘要，须含完整模型名
    await expect(page.locator('#pillDefaults')).toHaveAttribute('title', /mimo-v2\.5-pro-ultraspeed/);
    const layout = await page.locator('#pillDefaults').evaluate((chip) => {
      const text = chip.querySelector('#pillModelText') as HTMLElement | null;
      return {
        truncated: Boolean(text && text.scrollWidth > text.clientWidth),
        chipHeight: (chip as HTMLElement).offsetHeight,
      };
    });
    expect(layout.truncated).toBe(true);
    expect(layout.chipHeight).toBe(28);

    await expectNoBrowserErrors(page);
  });

  test('P0-09i 超长模型名不挤掉附件与发送钮', async ({ page }) => {
    // 窄屏 + 长模型名：附件/发送钉在右侧动作区，不被 chip 滚动层盖住
    await page.setViewportSize({ width: 320, height: 700 });
    await gotoMock(page);
    await sendChatMessage(page, 'test:longmodel');
    await waitForIdle(page);

    await expect(page.locator('#btnAttach')).toBeVisible();
    await expect(page.locator('#btnSend')).toBeVisible();
    const geometry = await page.evaluate(() => {
      const attach = document.querySelector('#btnAttach')?.getBoundingClientRect();
      const send = document.querySelector('#btnSend')?.getBoundingClientRect();
      const model = document.querySelector('#pillModelText') as HTMLElement | null;
      if (!attach || !send) return null;
      return {
        viewportW: window.innerWidth,
        modelTruncated: Boolean(model && model.scrollWidth > model.clientWidth + 0.5),
        // 附件钮完全在视口内，且不与发送钮重叠（允许 1px 亚像素）
        attachInView: attach.left >= 0 && attach.right <= window.innerWidth + 1,
        noOverlap: attach.right <= send.left + 1,
      };
    });
    expect(geometry).not.toBeNull();
    expect(geometry!.attachInView).toBe(true);
    expect(geometry!.noOverlap).toBe(true);
    expect(geometry!.modelTruncated).toBe(true);
    // 长名 chip 与动作区并存时，chip 入口仍可点开会话设置
    await page.locator('#pillDefaults').click();
    await expect(page.locator('#settingsSheet')).not.toHaveClass(/translate-y-full/);

    await expectNoBrowserErrors(page);
  });

  // 网关映射场景（.claude/settings.local.json 的 ANTHROPIC_DEFAULT_OPUS_MODEL）：CLI 侧仍报档位别名
  // 'opus'，但 SDK supportedModels() 在 resolvedModel 带出真实 wire id（如 mimo-v2.5-pro-ultraspeed）。
  // 底栏 pill、select 候选文案、设置面板磁贴标题都应显示 resolvedModel，而不是停留在裸别名 'opus'——
  // 这是 resolveModelDisplayName / resolveModelTileDisplay 的端到端验证，不能只靠纯函数单测。
  test('P0-09k 网关映射模型：pill/select/磁贴显示真实模型名而非档位别名', async ({ page }) => {
    await gotoMock(page);
    await sendChatMessage(page, 'test:gateway-model-alias');
    await waitForIdle(page);

    // 底栏 pill：显 resolvedModel，不是裸别名 'opus'
    await expect(page.locator('#pillModelText')).toHaveText('mimo-v2.5-pro-ultraspeed');

    // 设置面板：select 候选文案 + 磁贴标题同样显 resolvedModel
    await page.locator('#pillDefaults').click();
    await expect(page.locator('#modelInput')).toHaveValue('opus'); // 发送用的 value 仍是档位别名，不受本次改动影响
    await expect(page.locator('.model-tile[data-model="opus"]')).toContainText('mimo-v2.5-pro-ultraspeed');
    await expect(page.locator('.model-tile[data-model="opus"]')).not.toContainText('Opus');
    await closeSettings(page);

    await expectNoBrowserErrors(page);
  });

  // 新会话（未选具体模型）+ 网关默认：cwd 默认为档位别名 opus，SDK resolvedModel 带真实 wire id。
  // 回归 bug「开新会话看不到实际模型名、选了 opus 才显具体名」：currentModel 空时底栏 pill 也应解析出
  // 真实模型名，而不是停在裸别名 'opus'。（P0-09k 是已选 opus 路径，本例专测未选路径。）
  test('P0-09l 新会话未选模型：pill 显 cwd 默认的真实模型名而非裸别名', async ({ page }) => {
    await gotoMock(page);
    await sendChatMessage(page, 'test:gateway-default-fresh');
    await waitForIdle(page);

    // currentModel 空（未选具体模型），但底栏 pill 已把 cwd 默认别名 opus 解析成真实 wire id，
    // 不再停在裸别名——正是本次修的 bug。
    await expect(page.locator('#pillModelText')).toHaveText('mimo-v2.5-pro-ultraspeed');
    await expect(page.locator('#pillModelText')).not.toHaveText('opus');

    await expectNoBrowserErrors(page);
  });

  // /model default 是 CLI「不 pin」语义：不得把字面量 default 写进 modelInput / 发出去。
  // 先 /model 具体模型污染，再 /model default 复位，文案/select/pill/回显四端均不得出现字面量 default。
  test('P0-09j /model default 复位不污染 model 字面量', async ({ page }) => {
    await gotoMock(page);
    await ensureComposerReady(page);

    // /model 会剥离 [1m] 进 dataset.fullModel，select value 只留裸名——与 P0-09e 一致
    await page.locator('#input').fill('/model claude-3-opus[1m]');
    await page.locator('#btnSend').click();
    await expect(page.locator('#messages')).toContainText('模型已设为 claude-3-opus[1m]（下一条消息生效）');
    await expect(page.locator('#pillModelText')).toContainText('claude-3-opus[1m]');

    await page.locator('#input').fill('/model default');
    await page.locator('#btnSend').click();
    await expect(page.locator('#messages')).toContainText('模型已重置为默认（下一条消息生效）');
    await expect(page.locator('#messages')).not.toContainText('模型已设为 default');
    await expect(page.locator('#modelInput')).toHaveValue('');
    await expect(page.locator('#pillModelText')).toContainText('Default (recommended)');

    await sendChatMessage(page, 'test:settings-echo');
    await waitForIdle(page);
    const reply = page.locator('[data-testid="assistant-message"]').last();
    await expect(reply).toContainText('model=未指定(沿用)');
    await expect(reply).not.toContainText('model=default');

    await expectNoBrowserErrors(page);
  });

  // ⑦ CLI 配置刷新按钮：ensureCliDefaults 结果按 cwd 缓存，只在启动/session:new/session:home 才 force
  // 重读——用户在终端侧改了 ~/.claude/settings.json 后 compose 页摘要不会自动感知，需要手动兜底入口。
  // 断言按钮点击后经历禁用→转圈→恢复这段瞬态（mock config:refresh 加了 150ms 延迟，见 mock/server.js）。
  test('P0-09n compose 页配置刷新按钮：点击后经历禁用→转圈→恢复', async ({ page }) => {
    await gotoMock(page);
    await page.locator('#btnNew').click();
    await expect(page.locator('#messages')).toHaveClass(/empty-start/);

    const refreshBtn = page.locator('[data-testid="compose-defaults-refresh"]');
    await expect(refreshBtn).toBeVisible();
    await expect(refreshBtn).toBeEnabled();
    await expect(refreshBtn).not.toHaveClass(/animate-spin/);

    await refreshBtn.click();
    await expect(refreshBtn).toBeDisabled();
    await expect(refreshBtn).toHaveClass(/animate-spin/);

    await expect(refreshBtn).toBeEnabled({ timeout: 2000 });
    await expect(refreshBtn).not.toHaveClass(/animate-spin/);

    await expectNoBrowserErrors(page);
  });

  // ⑦ 续：同一个 config:refresh 的常驻入口。compose 页那个只在新会话页存在——已有会话里想重读
  // 终端侧改过的 settings.json 一直没有入口（这正是 ⑦ 的原始诉求「配置面板无刷新入口」）。
  // 两处共用 wireConfigRefreshButton；转圈落在 [data-spin] 图标上，按钮带文字不整块旋转。
  test('P0-09o 配置面板配置刷新按钮：点击后经历禁用→转圈→恢复', async ({ page }) => {
    await gotoMock(page);
    await ensureComposerReady(page);

    await page.locator('#pillDefaults').click();
    const refreshBtn = page.locator('[data-testid="settings-config-refresh"]');
    const spinIcon = refreshBtn.locator('[data-spin]');
    await expect(refreshBtn).toBeVisible();
    await expect(refreshBtn).toBeEnabled();
    await expect(spinIcon).not.toHaveClass(/animate-spin/);

    await refreshBtn.click();
    await expect(refreshBtn).toBeDisabled();
    await expect(spinIcon).toHaveClass(/animate-spin/);

    await expect(refreshBtn).toBeEnabled({ timeout: 2000 });
    await expect(spinIcon).not.toHaveClass(/animate-spin/);

    await expectNoBrowserErrors(page);
  });

  // 已有生效模型后再切模型（不发送）：底栏摘要 / 磁贴高亮必须立刻跟新选择，不能停在上一轮
  // 已生效的旧模型。回归点：card.onclick 写 modelInput + syncModelUI，不依赖 currentModel 回执。
  test('P0-09s 已有生效模型后再切模型（不发送）：摘要与磁贴随即跟上新选择', async ({ page }) => {
    await gotoMock(page);
    await ensureComposerReady(page);

    await page.locator('#pillDefaults').click();
    await openSettingsSection(page, 'model');
    await page.locator('.model-tile[data-model="claude-3-opus[1m]"]').click();
    await closeSettings(page);
    await sendChatMessage(page, 'test:settings-echo');
    await waitForIdle(page);
    await expect(page.locator('#pillModelText')).toContainText('claude-3-opus[1m]');

    await page.locator('#pillDefaults').click();
    await openSettingsSection(page, 'model');
    await page.locator('.model-tile[data-model="claude-3-5-haiku"]').click();

    await expect(page.locator('#pillModelText')).toHaveText('claude-3-5-haiku');
    await expect(page.locator('.model-tile[data-model="claude-3-5-haiku"]')).toHaveClass(/ring-accent/);
    await expect(page.locator('#pillDefaults')).toHaveAttribute('title', /claude-3-5-haiku/);

    await expectNoBrowserErrors(page);
  });

  // 切回 default 磁贴：displayOverride 必须在 syncModelUI 内、赶在摘要 title 刷新前写好 pill 文案。
  test('P0-09t 切回 default 磁贴：摘要立即显示 Default (recommended)', async ({ page }) => {
    await gotoMock(page);
    await ensureComposerReady(page);

    await page.locator('#pillDefaults').click();
    await openSettingsSection(page, 'model');
    await page.locator('.model-tile[data-model="claude-3-5-haiku"]').click();
    await expect(page.locator('#pillModelText')).toContainText('claude-3-5-haiku');

    await page.locator('.model-tile[data-model="default"]').click();

    await expect(page.locator('#pillModelText')).toContainText('Default (recommended)');
    await expect(page.locator('.model-tile[data-model="default"]')).toHaveClass(/ring-accent/);
    await expect(page.locator('#pillDefaults')).toHaveAttribute('title', /Default \(recommended\)/);

    await expectNoBrowserErrors(page);
  });

  // ⑧ 推送内容预览开关：默认关（与「完成提示」三项默认开相反极性），勾选后持久化到 localStorage，
  // 重开设置面板仍反映上次选择（syncPreferences 从 storage 读回，见 app/settings.js）。
  test('P0-09m 推送内容预览开关默认关，勾选后跨面板重开保持', async ({ page }) => {
    await gotoMock(page);
    await ensureComposerReady(page);

    // 推送预览是本机偏好，按作用域拆分后住在通用设置（侧栏入口）里，不再随齿轮开合
    await openGeneralSettings(page);
    const toggle = page.locator('#prefPushPreview');
    await expect(toggle).toBeVisible();
    await expect(toggle).not.toBeChecked();

    await toggle.click();
    await expect(toggle).toBeChecked();
    const stored = await page.evaluate(() => localStorage.getItem('ccm_push_preview'));
    expect(stored).toBe('1');
    await closeGeneralSettings(page);

    // 重开面板：syncPreferences 从 storage 读回，应仍是勾选态（不是每次都复位成默认关）。
    await openGeneralSettings(page);
    await expect(page.locator('#prefPushPreview')).toBeChecked();

    await expectNoBrowserErrors(page);
  });
});
