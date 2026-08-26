// spec: docs/testing.md
// helpers: tests/helpers/playwright.ts

import { test, expect } from '@playwright/test';
import { closeGeneralSettings, closeSettings, ensureComposerReady, expectNoBrowserErrors, gotoMock, openGeneralSettings, openSessionSettings, openSettingsSection, sendChatMessage, waitForIdle } from '../../helpers/playwright';

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
    await expect(page.locator('#pillPermText')).toContainText('Plan');
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
    await expect(page.locator('#pillPermText')).toContainText('Plan');
    // 摘要 chip 连写
    await expect(page.locator('#pillDefaults')).toContainText('Plan');

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
    // 方案 A：常见手机高度下打开即见权限尾格（Bypass），无需先滑 sheet body
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('.perm-tile[data-mode="bypassPermissions"]')).toBeInViewport();
    await expect(page.locator('.perm-tile').first()).toBeVisible();

    await expectNoBrowserErrors(page);
  });

  test('P0-09u 底栏会话摘要从模型名开始，不显示前置图标', async ({ page }) => {
    await gotoMock(page);
    await ensureComposerReady(page);

    await expect(page.locator('#pillDefaults > svg')).toHaveCount(0);
    await expect(page.locator('#pillDefaults > :first-child')).toHaveAttribute('id', 'pillModelText');

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
    await expect(page.locator('#pillPermText')).toContainText('Plan');
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
    await expect(page.locator('#pillPermText')).toContainText('Plan');
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
    await expect(page.locator('#pillPermText')).toHaveText('Plan');
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
      const cs = text ? getComputedStyle(text) : null;
      return {
        truncated: Boolean(text && text.scrollWidth > text.clientWidth),
        // 省略机制本身（与字体无关）：三件套齐了才可能出现单行省略号
        ellipsis: cs?.textOverflow ?? '',
        nowrap: cs?.whiteSpace ?? '',
        overflow: cs?.overflow ?? '',
        chipHeight: (chip as HTMLElement).offsetHeight,
      };
    });
    // ★ 断言分两层，因为 scrollWidth > clientWidth 依赖【字体度量】：同一串 24 字符的模型名在
    // macOS 上溢出、在 Linux 容器的回落字体下正好放得下（2026-08-03 实测：宿主机过、容器红）。
    // 那不是 bug，是渲染环境不同。所以——
    // ① 省略机制（text-overflow/white-space/overflow 三件套）与字体无关，任何环境都必须成立；
    // ② 真溢出只在确实溢出的环境里校验：溢出了就必须被截断，没溢出说明这个字体下放得下，不算回归。
    // 这么写比原来更强：三件套此前从没被检查过，缺任何一个都会让"省略"变成"硬换行/裸溢出"。
    expect(layout.ellipsis).toBe('ellipsis');
    expect(layout.nowrap).toBe('nowrap');
    expect(layout.overflow).toBe('hidden');
    expect(layout.chipHeight).toBe(36); // 与动作钮热区协调（Composer A）；单行的直接证据

    await expectNoBrowserErrors(page);
  });

  test('P0-09i 超长模型名不挤掉附件与发送钮', async ({ page }) => {
    // 窄屏 + 长模型名：附件/发送钉在右侧动作区，不被 chip 滚动层盖住
    await page.setViewportSize({ width: 320, height: 700 });
    await gotoMock(page);
    await sendChatMessage(page, 'test:longmodel');
    await waitForIdle(page);

    // 空闲无内容时发送钮隐藏（Composer C）；填一字露出发送再测几何
    await page.locator('#input').fill('x');
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

  // 条数=SDK；标题=真实 wire；data-model 仍是 SDK value（opus）
  test('P0-09k 网关映射：磁贴标题为真实 wire，条数保留档位 value', async ({ page }) => {
    await gotoMock(page);
    await sendChatMessage(page, 'test:gateway-model-alias');
    await waitForIdle(page);

    await expect(page.locator('#pillModelText')).toHaveText('mimo-v2.5-pro-ultraspeed');

    await page.locator('#pillDefaults').click();
    // data-model 仍是 opus（与 TUI 条目对应），主文案是真实 id
    const opusTile = page.locator('.model-tile[data-model="opus"]');
    await expect(opusTile).toBeVisible();
    await expect(opusTile).toContainText('mimo-v2.5-pro-ultraspeed');
    await expect(opusTile).toHaveClass(/ring-accent/);
    await closeSettings(page);

    await expectNoBrowserErrors(page);
  });

  test('P0-09l 新会话未选模型：pill 显 cwd 默认的 wire', async ({ page }) => {
    await gotoMock(page);
    await sendChatMessage(page, 'test:gateway-default-fresh');
    await waitForIdle(page);

    await expect(page.locator('#pillModelText')).toHaveText('mimo-v2.5-pro-ultraspeed');
    await expect(page.locator('#pillModelText')).not.toHaveText(/^opus$/);

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

  // ── 以下两条来自 2026-08-26 的探索性测试（VC-D1-02 / VC-D4-03）────────────────────
  //
  // VC-D1-02：切权限档要在**三处**同时更新——磁贴强调色、底栏 pill、消息流里的留痕横杠。
  // 本文件上面 P0-09d 已经断言过 empty-start 下**不打**横杠（UX-019 的负向），而正向
  // 「有消息之后切档 → 消息流末尾出现 `权限档 → X`」一直没有断言。少了它，回看历史时
  // 看不出权限档何时变过，而这恰恰是审计价值最高的一条留痕。
  test('P0-09v 有消息后切权限档：pill 与消息流横杠同时更新（不是只更新 pill）', async ({ page }) => {
    await gotoMock(page);
    await ensureComposerReady(page);

    // 先发一条，离开 empty-start —— 横杠只在有内容的会话里打（UX-019）
    await sendChatMessage(page, 'test:tab');
    await waitForIdle(page);
    await expect(page.locator('#messages')).not.toHaveClass(/empty-start/);

    // 起始档是 default（Manual）——必须切到**另一档**，点当前档不会产生任何变化，
    // 那样断言会在一个什么都没发生的页面上恒绿。
    await expect(page.locator('#pillPermText')).toHaveText('Manual');
    await openSessionSettings(page);
    await openSettingsSection(page, 'perm');
    const target = page.locator('.perm-tile[data-mode="acceptEdits"]');
    await target.scrollIntoViewIfNeeded();
    await target.click();
    await closeSettings(page);

    // 三处之二：底栏 pill 用 CLI 英文契约名（不是「接受编辑」这类译名）
    await expect(page.locator('#pillPermText')).toHaveText('Accept edits');
    // 三处之三：消息流里留痕。文案同样是契约名，回看时能对上 CLI。
    await expect(page.locator('#messages')).toContainText('权限档 → Accept edits');

    await expectNoBrowserErrors(page);
  });

  // VC-D4-03：这六张磁贴里有一张是 `Bypass permissions`（绕过全部权限检查）。它们此前是纯
  // `<div>` —— Tab 走不到、辅助技术不认得是控件、也读不出「当前选中的是哪一档」。
  // 判据分三层，逐层都失败过：能不能拿到焦点 / 是不是控件 / 选中态说不说得出来。
  test('P0-09w 权限磁贴是可访问控件：键盘可达、有角色、选中态可播报', async ({ page }) => {
    await gotoMock(page);
    await ensureComposerReady(page);
    await openSessionSettings(page);
    await openSettingsSection(page, 'perm');

    const tiles = page.locator('#customPermGrid .perm-tile');
    await expect(tiles).toHaveCount(6);

    // 1. 是真正的控件，不是套了 class 的 div
    for (const mode of ['default', 'plan', 'acceptEdits', 'bypassPermissions']) {
      const tile = page.locator(`.perm-tile[data-mode="${mode}"]`);
      await expect(tile).toHaveRole('button');
    }

    // 2. 选中态能被读出来：当前档 aria-pressed=true，其余 false（而不是全都没有这个属性）
    await expect(page.locator('.perm-tile[data-mode="default"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.perm-tile[data-mode="plan"]')).toHaveAttribute('aria-pressed', 'false');

    // 3. 键盘真的能激活它 —— 只加 role 不接键盘等于换了个说法的同一个 bug。
    //    聚焦后按 Enter，档位必须真的切过去（三处同步里最容易被漏掉的一处）。
    await page.locator('.perm-tile[data-mode="plan"]').scrollIntoViewIfNeeded();
    await page.locator('.perm-tile[data-mode="plan"]').focus();
    await expect(page.locator('.perm-tile[data-mode="plan"]')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('#pillPermText')).toContainText('Plan');
    await expect(page.locator('.perm-tile[data-mode="plan"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.perm-tile[data-mode="default"]')).toHaveAttribute('aria-pressed', 'false');

    await expectNoBrowserErrors(page);
  });
});
