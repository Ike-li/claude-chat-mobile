// display-contracts.test.mjs —— 展示契约可执行锚点（零 token）。
// 文档：docs/display-contracts.md
// 改契约：先改本文件期望 → 再改实现 → 同步文档表格。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveModelTileDisplay,
  resolveSendModel,
  resolveModelPillText,
  resolveGatewayModelName,
  effortLevelsFor,
  effortUiState,
  withAutoTier,
  resolvePanelState,
  formatStatuslineCollapsedSummary,
  formatStatuslineCtxBrief,
} from '../../app/public/js/logic.js';
import {
  normalizeEffortUiLevel,
  normalizeEffortLevel,
  CCM_EFFORT_LEVELS,
  UI_EFFORT_LEVELS,
  resolveFreshPrefs,
  resolveResumeEffort,
} from '../../app/src/agent/cli-settings-defaults.js';
import {
  buildWebStatusLine,
  buildCliStatusLine,
} from '../../app/src/ops/statusline.js';

// ─── §1 Models ─────────────────────────────────────────────

const GATEWAY_MODELS = Object.freeze([
  { value: 'default', displayName: 'Default (recommended)', description: 'Use default', resolvedModel: 'grok-4.5[1m]' },
  { value: 'opus', displayName: 'Custom Opus model', resolvedModel: 'grok-4.5' },
  { value: 'sonnet', displayName: 'Custom Sonnet model', resolvedModel: 'grok-4.5' },
  { value: 'fable', displayName: 'Custom Fable model', resolvedModel: 'grok-4.5' },
  { value: 'haiku', displayName: 'Custom Haiku model', resolvedModel: 'grok-4.5' },
  { value: 'grok-4.5-build', displayName: '当前加载模型' },
]);

test.describe('契约 §1 模型：条数 = SDK；标题 = wire；发送 pin wire', () => {
  test('N SDK 条目 → N 磁贴，禁止按 wire 合并', () => {
    const tiles = resolveModelTileDisplay(GATEWAY_MODELS);
    assert.equal(tiles.length, GATEWAY_MODELS.length);
    // 多档同 wire 仍多卡
    assert.equal(tiles.filter(t => t.title === 'grok-4.5').length, 4);
  });

  test('有 resolvedModel → 标题为真实 wire id，value 仍为档位 id', () => {
    const tiles = resolveModelTileDisplay(GATEWAY_MODELS);
    assert.equal(tiles[0].value, 'default');
    assert.equal(tiles[0].title, 'grok-4.5[1m]');
    assert.equal(tiles[1].value, 'opus');
    assert.equal(tiles[1].title, 'grok-4.5');
    assert.match(tiles[1].subtitle, /opus/i);
  });

  test('无 resolvedModel → 标题回落 displayName，不伪造 wire', () => {
    const tiles = resolveModelTileDisplay(GATEWAY_MODELS);
    const last = tiles[tiles.length - 1];
    assert.equal(last.value, 'grok-4.5-build');
    assert.equal(last.title, '当前加载模型');
  });

  test('发送：空/default/档位 pin 到 wire；无列表原样', () => {
    assert.equal(resolveSendModel({ selectValue: '', modelsList: GATEWAY_MODELS }), 'grok-4.5[1m]');
    assert.equal(resolveSendModel({ selectValue: 'default', modelsList: GATEWAY_MODELS }), 'grok-4.5[1m]');
    assert.equal(resolveSendModel({ selectValue: 'opus', modelsList: GATEWAY_MODELS }), 'grok-4.5');
    assert.equal(resolveSendModel({ selectValue: 'haiku', modelsList: [] }), 'haiku');
    assert.equal(resolveSendModel({ selectValue: '', modelsList: [] }), undefined);
  });

  test('pill：有 resolved → wire；无 resolved → 原值+后缀，不得用 displayName 覆盖', () => {
    assert.equal(
      resolveModelPillText({ model: 'opus', modelsList: GATEWAY_MODELS }),
      'grok-4.5',
    );
    assert.equal(
      resolveModelPillText({ model: 'opus', gatewaySuffix: '[1m]', modelsList: [] }),
      'opus[1m]',
    );
    // 无 resolved 时 resolveGatewayModelName 必须空串（不回落 displayName）
    assert.equal(
      resolveGatewayModelName('opus', [{ value: 'opus', displayName: 'Custom Opus' }]),
      '',
    );
  });
});

// ─── §2 Effort ─────────────────────────────────────────────

test.describe('契约 §2 Effort：UI 档 vs SDK 档；ultracode 映射', () => {
  test('SDK 五档 ⊂ UI 档；UI 额外含 ultracode', () => {
    for (const l of CCM_EFFORT_LEVELS) assert.ok(UI_EFFORT_LEVELS.includes(l));
    assert.ok(UI_EFFORT_LEVELS.includes('ultracode'));
    assert.equal(CCM_EFFORT_LEVELS.includes('ultracode'), false);
  });

  test('normalizeEffortLevel（settings/L3）不认 ultracode', () => {
    assert.equal(normalizeEffortLevel('ultracode'), null);
    assert.equal(normalizeEffortLevel('xhigh'), 'xhigh');
  });

  test('normalizeEffortUiLevel：空 → 模型默认；五档原样；ultracode → xhigh+flag', () => {
    assert.deepEqual(normalizeEffortUiLevel(null), { ui: null, sdk: null, ultracode: false });
    assert.deepEqual(normalizeEffortUiLevel(''), { ui: null, sdk: null, ultracode: false });
    assert.deepEqual(normalizeEffortUiLevel('high'), { ui: 'high', sdk: 'high', ultracode: false });
    assert.deepEqual(normalizeEffortUiLevel('xhigh'), { ui: 'xhigh', sdk: 'xhigh', ultracode: false });
    assert.deepEqual(normalizeEffortUiLevel('ultracode'), {
      ui: 'ultracode',
      sdk: 'xhigh',
      ultracode: true,
    });
    assert.equal(normalizeEffortUiLevel('nope'), null);
  });

  test("normalizeEffortUiLevel：'auto' 是一等 UI 档，与 null（没指定 = CLI inherit）不同", () => {
    assert.deepEqual(normalizeEffortUiLevel('auto'), { ui: 'auto', sdk: null, ultracode: false },
      'auto 不传 --effort（CLI 不认 --effort auto，会落成 inherit），ui 必须保留 auto 供后续补发控制请求');
    assert.notDeepEqual(normalizeEffortUiLevel('auto'), normalizeEffortUiLevel(null));
    assert.ok(UI_EFFORT_LEVELS.includes('auto'));
    assert.equal(CCM_EFFORT_LEVELS.includes('auto'), false, 'auto 不是 SDK Options.effort 的合法值');
  });

  test('effortUiState：null 是「没指定」（CLI inherit），不得猜成 low，也不得冒充 auto', () => {
    const levels = withAutoTier(['low', 'medium', 'high']);
    const fresh = effortUiState(null, levels, { mirrorReadonly: false });
    assert.equal(fresh.level, null);
    assert.equal(fresh.selected, '',
      '没指定时 CLI 先读 settings 里存的档——选中 auto 就是替它声称「模型内置默认」，settings 存了档时是假的');
    assert.equal(fresh.label, 'CLI 默认');

    const known = effortUiState(null, levels, { mirrorReadonly: false, effective: 'high' });
    assert.equal(known.selected, '', '实际生效档只用于文案，不当成钉住的档去高亮磁贴');
    assert.equal(known.label, 'high · CLI 默认');

    const mirror = effortUiState(null, levels, { mirrorReadonly: true, effective: 'high' });
    assert.equal(mirror.level, null);
    assert.equal(mirror.selected, '');
    assert.match(mirror.label, /CLI|未知|unknown/i, '镜像态的 null 是「观察不到」，Web 实例的实际档不能拿来补');
  });

  test("effortUiState：'auto' 是显式选中的档，照常高亮", () => {
    const ui = effortUiState('auto', withAutoTier(['low', 'high']), { mirrorReadonly: false, effective: 'medium' });
    assert.equal(ui.selected, 'auto');
    assert.equal(ui.label, 'auto');
  });

  // L3（CLI settings 的 effortLevel）照常当显式档下发给 CLI——跑起来与终端读 settings 一样——但用户
  // 没选过它，对用户而言就是「没指定」。发之前（空首页）与发之后（实例）都得是「<档> · CLI 默认」，
  // 不能发完一条就变成光秃秃的档（验收 O15）。
  test('effortUiState：来源是 CLI settings 的档视同没指定——文案带「CLI 默认」、不高亮磁贴', () => {
    const levels = withAutoTier(['low', 'medium', 'high']);
    const fromCli = effortUiState('high', levels, { mirrorReadonly: false, source: 'cli-settings' });
    assert.equal(fromCli.label, 'high · CLI 默认');
    assert.equal(fromCli.placeholder, 'high · CLI 默认');
    assert.equal(fromCli.selected, '',
      '不是用户钉的档：高亮了就点不动它，想把它钉成自己的选择也无从下手');
    // effective 是「没指定」时向 CLI 问来的档；L3 档本身就是 CLI 在用的档，以它为准
    assert.equal(
      effortUiState('high', levels, { source: 'cli-settings', effective: 'low' }).label,
      'high · CLI 默认',
    );

    const fromUser = effortUiState('high', levels, { source: 'user' });
    assert.equal(fromUser.label, 'high');
    assert.equal(fromUser.selected, 'high');
    // 缺来源（旧回执、E2E mock）按用户自选显示，与改动前一致
    assert.equal(effortUiState('high', levels, {}).label, 'high');
    // 镜像态整组只认 CLI 观察值，Web 实例的来源不参与
    assert.equal(
      effortUiState('high', levels, { mirrorReadonly: true, source: 'cli-settings' }).label,
      'high',
    );
  });

  test('档位来源：新会话与续接按同一优先级给出 user / cli-settings / default', () => {
    const cliHigh = { mode: 'default', effort: 'high' };
    // 新会话：用户在空首页选的（L0）> CLI settings（L3）> 没指定
    assert.equal(resolveFreshPrefs({ cliDefaults: cliHigh }).effortSource, 'cli-settings');
    assert.equal(resolveFreshPrefs({ hasPendingEffort: true, pendingEffort: 'low', cliDefaults: cliHigh }).effortSource, 'user');
    assert.equal(resolveFreshPrefs({ hasPendingEffort: true, pendingEffort: 'high', cliDefaults: cliHigh }).effortSource, 'user',
      '与 settings 同档也是用户自己选的');
    assert.equal(resolveFreshPrefs({}).effortSource, 'default');
    assert.equal(resolveFreshPrefs({ hasPendingEffort: true, pendingEffort: null, cliDefaults: cliHigh }).effortSource, 'default');

    // 续接：会话自己存的（带来源）> CLI settings > 没指定
    assert.deepEqual(resolveResumeEffort({ savedEffort: 'low', savedEffortSource: 'user', cliDefaults: cliHigh }),
      { effort: 'low', source: 'user' });
    assert.deepEqual(resolveResumeEffort({ savedEffort: 'high', savedEffortSource: 'cli-settings', cliDefaults: cliHigh }),
      { effort: 'high', source: 'cli-settings' }, '当初从 settings 来的档，续接后仍标 CLI 默认');
    assert.deepEqual(resolveResumeEffort({ savedEffort: null, cliDefaults: cliHigh }),
      { effort: 'high', source: 'cli-settings' });
    assert.deepEqual(resolveResumeEffort({}), { effort: null, source: 'default' });
  });

  test('withAutoTier：auto 恒在末位（CLI usage `[…|ultracode|auto]`），幂等；无档可调时不凭空加', () => {
    assert.deepEqual(
      withAutoTier(['low', 'medium', 'high', 'xhigh', 'max', 'ultracode']),
      ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode', 'auto'],
    );
    assert.deepEqual(withAutoTier(['low', 'auto']), ['low', 'auto']);
    assert.deepEqual(withAutoTier([]), []);
    assert.deepEqual(withAutoTier(null), []);
  });

  test('effortLevelsFor：明确无 supportedEffortLevels → 隐藏', () => {
    const { hidden, levels } = effortLevelsFor('haiku', [
      { value: 'haiku', displayName: 'Haiku', supportedEffortLevels: [] },
    ]);
    assert.equal(hidden, true);
    assert.deepEqual(levels, []);
  });

  test('resolvePanelState：镜像态整组用 CLI 观察值，禁止 Web 补空', () => {
    const panel = resolvePanelState({
      mirrorReadonly: true,
      observedCli: { model: 'cli-model', permissionMode: null, effort: null },
      web: { model: 'web-model', permissionMode: 'bypassPermissions', effort: 'low' },
    });
    assert.equal(panel.source, 'cli');
    assert.equal(panel.model, 'cli-model');
    assert.equal(panel.permissionMode, null); // 未知保持未知
    assert.equal(panel.effort, null); // 不得变成 web 的 low
  });
});

// ─── §3 Statusline ─────────────────────────────────────────

test.describe('契约 §3 Statusline：结构化对齐；ctx 不误导；折叠摘要', () => {
  test('折叠摘要 = git · ctx；皆无 → statusline；不含 model', () => {
    assert.equal(
      formatStatuslineCollapsedSummary({
        git: { branch: 'dev', staged: 1, modified: 0, untracked: 0 },
        ctx: { usedPercent: 12 },
        model: 'should-not-appear',
      }),
      'dev +1 · ctx 12%',
    );
    assert.equal(formatStatuslineCollapsedSummary({ model: 'x' }), 'statusline');
    assert.equal(formatStatuslineCtxBrief({ tokens: 12_500 }), 'ctx 13k');
  });

  test('ctx 窗口：无运行时真值时不出 %（不按模型名硬造分母）', async () => {
    const p = await buildWebStatusLine({
      agent: { activeModel: 'claude-opus-5', lastUsage: { input_tokens: 532_000, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
      cwd: undefined,
    });
    assert.equal(p.ctx.windowSize, undefined);
    assert.equal(p.ctx.usedPercent, undefined);
    assert.equal(p.ctx.tokens, 532_000);
  });

  test('buildWebStatusLine：effort 有值才带；null 不放字段', async () => {
    const withE = await buildWebStatusLine({
      agent: { activeModel: 'm', effort: 'high', lastUsage: { input_tokens: 1, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
      cwd: undefined,
    });
    assert.equal(withE.effort, 'high');
    assert.equal(withE.model, 'm');

    const none = await buildWebStatusLine({
      agent: { activeModel: 'm', lastUsage: { input_tokens: 1, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
      cwd: undefined,
    });
    assert.equal(none.effort, undefined);
  });

  test('buildCliStatusLine：只消费 snapshot；model 优先 displayName（对齐 CLI 状态栏文案）', async () => {
    const p = await buildCliStatusLine({
      snapshot: {
        model: { id: 'cli-wire', displayName: 'CLI Name' },
        effort: 'max',
        ctx: { tokens: 1000, usedPercent: 5, windowSize: 200_000 },
      },
      cwd: undefined,
    });
    // CLI statusline 展示名优先（与 Web 磁贴「标题=wire」策略不同：statusline 对齐 TUI 文案）
    assert.equal(p.model, 'CLI Name');
    assert.equal(p.effort, 'max');
    assert.equal(p.ctx.tokens, 1000);
    assert.equal(p.ctx.usedPercent, 5);

    const idOnly = await buildCliStatusLine({
      snapshot: { model: { id: 'cli-wire-only' } },
      cwd: undefined,
    });
    assert.equal(idOnly.model, 'cli-wire-only');
  });
});
