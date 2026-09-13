// tests/unit/logic-models-effort.test.mjs —— models-effort.js 纯函数单测（模型解析/展示/网关后缀 · effort 档位 · ultracode）
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveModelTileDisplay,
  modelGridEmptyHint,
  defaultResolvedModel,
  resolveSendModel,
  formatCachePercent,
  effortLevelSubtitle,
  shouldShowBusyWithMirror,
  withUltracodeKeyword,
  withUltracodeTier,
  resolveEffortSelection,
  modelEntryFor,
  modelLabelFor,
  resolveModelDisplayName,
  resolveGatewayModelName,
  resolveModelPillText,
  effortLevelsFor,
  effortUiState,
  defaultModelTileLabel,
  applyGatewaySuffix,
} from '../../app/public/js/logic/models-effort.js';
import { setLang } from '../../app/public/js/i18n.js';

// 本模块内部通过 t() 查多语言，setLang 是模块级全局状态，同进程内其他测试文件会改动它。
// 每个 test 前重置为 zh，避免受执行顺序影响（惯例同 logic-format.test.mjs）。
test.beforeEach(() => setLang('zh'));

// ─── 1. resolveModelTileDisplay ──────────────────────────────
test.describe('resolveModelTileDisplay —— 模型磁贴展示数据转换', () => {
  const SAMPLE_MODELS = [
    { value: 'default', displayName: 'Claude 3.7', description: 'Recommended default', resolvedModel: 'claude-3-7-sonnet' },
    { value: 'opus', displayName: 'Opus 4', description: 'Deep reasoning', resolvedModel: 'claude-opus-4' },
    { value: 'haiku', displayName: 'Haiku', description: 'Fast' },
  ];

  test('典型输入：正确转换磁贴字段并保留 raw 引用', () => {
    const tiles = resolveModelTileDisplay(SAMPLE_MODELS);
    assert.equal(tiles.length, 3);
    assert.deepEqual(tiles[0], {
      value: 'default',
      title: 'claude-3-7-sonnet',
      subtitle: 'Claude 3.7',
      duplicate: false,
      raw: SAMPLE_MODELS[0],
    });
    assert.deepEqual(tiles[2], {
      value: 'haiku',
      title: 'Haiku',
      subtitle: 'Fast',
      duplicate: false,
      raw: SAMPLE_MODELS[2],
    });
  });

  test('边界输入：null / undefined / 空数组 / 非数组安全回落为空数组', () => {
    assert.deepEqual(resolveModelTileDisplay(null), []);
    assert.deepEqual(resolveModelTileDisplay(undefined), []);
    assert.deepEqual(resolveModelTileDisplay([]), []);
    assert.deepEqual(resolveModelTileDisplay('not-an-array'), []);
    assert.deepEqual(resolveModelTileDisplay(123), []);
  });

  test('边界输入：数组包含字符串项、畸形对象与空属性', () => {
    const mixed = ['raw-string-model', null, { value: 0, displayName: '' }, { description: 'only-desc' }];
    const tiles = resolveModelTileDisplay(mixed);
    assert.equal(tiles.length, 4);
    // 字符串项
    assert.equal(tiles[0].value, 'raw-string-model');
    assert.equal(tiles[0].title, 'raw-string-model');
    assert.equal(tiles[0].subtitle, 'raw-string-model');
    assert.equal(tiles[0].raw, 'raw-string-model');
    // null 项
    assert.equal(tiles[1].value, '');
    assert.equal(tiles[1].title, 'model');
    assert.equal(tiles[1].subtitle, '');
    // value 为数字 0
    assert.equal(tiles[2].value, '0');
    assert.equal(tiles[2].title, '0');
    // 仅 description
    assert.equal(tiles[3].value, '');
    assert.equal(tiles[3].title, 'model');
    assert.equal(tiles[3].subtitle, 'only-desc');
  });

  test('产品语义：N 条 SDK 记录输出 N 张磁贴，禁止按 wire 合并；多档映射同一 wire 时标记 duplicate 并在副标题区分', () => {
    const multiWire = [
      { value: 'default', displayName: 'Default', resolvedModel: 'grok-4.5' },
      { value: 'opus', displayName: 'Custom Opus', resolvedModel: 'grok-4.5' },
      { value: 'sonnet', displayName: 'Custom Sonnet', resolvedModel: 'grok-4.5' },
    ];
    const tiles = resolveModelTileDisplay(multiWire);
    assert.equal(tiles.length, 3);
    for (const t of tiles) {
      assert.equal(t.title, 'grok-4.5');
      assert.equal(t.duplicate, true);
    }
    // default 档位的副标题规则：displayName !== wire 则显示 displayName
    assert.equal(tiles[0].subtitle, 'Default');
    // 非 default 档位：value !== wire 且 displayName 不同，拼出 "value · displayName"
    assert.equal(tiles[1].subtitle, 'opus · Custom Opus');
    assert.equal(tiles[2].subtitle, 'sonnet · Custom Sonnet');
  });

  test('产品语义：副标题回落分支（default 缺失 displayName、value 等于 wire 等）', () => {
    const models = [
      // displayName 等于 wire 时，default 回落 description
      { value: 'default', displayName: 'wire-1', resolvedModel: 'wire-1', description: 'Def desc' },
      // displayName 等于 wire 时且无 description，default 回落 'default'
      { value: 'default', displayName: 'wire-2', resolvedModel: 'wire-2' },
      // 非 default 且 value === wire 时，回落 description 或 displayName
      { value: 'same-wire', resolvedModel: 'same-wire', description: 'Desc' },
      // 无 wire 无 description 时，回落 value；全空时为 ''
      { value: 'no-wire-no-desc' },
      { value: '' },
    ];
    const tiles = resolveModelTileDisplay(models);
    assert.equal(tiles[0].subtitle, 'Def desc');
    assert.equal(tiles[1].subtitle, 'default');
    assert.equal(tiles[2].subtitle, 'Desc');
    assert.equal(tiles[3].subtitle, 'no-wire-no-desc');
    assert.equal(tiles[4].subtitle, '');
  });
});

// ─── 2. modelGridEmptyHint ────────────────────────────────────
test.describe('modelGridEmptyHint —— 模型网格无卡提示文案', () => {
  test('典型输入：有磁贴时返回 null（不显示就地提示）', () => {
    assert.equal(modelGridEmptyHint({ tileCount: 1 }), null);
    assert.equal(modelGridEmptyHint({ tileCount: 5 }), null);
  });

  test('边界输入：tileCount 为 0、负数、NaN、null、undefined 或未传参时返回提示文案', () => {
    const expected = '还没拿到这个工作区的模型清单。点上方 ⟳ 重新读取，或发一条消息后自动补齐。';
    assert.equal(modelGridEmptyHint({ tileCount: 0 }), expected);
    assert.equal(modelGridEmptyHint({ tileCount: -1 }), expected);
    assert.equal(modelGridEmptyHint({ tileCount: NaN }), expected);
    assert.equal(modelGridEmptyHint({ tileCount: null }), expected);
    assert.equal(modelGridEmptyHint({}), expected);
    assert.equal(modelGridEmptyHint(), expected);
    assert.equal(modelGridEmptyHint({ tileCount: '3' }), expected);
  });

  test('产品语义：按最终渲染卡片数判定，陈述事实并指向 ⟳，不使用易产生假态的「正在读取…」', () => {
    const hint = modelGridEmptyHint({ tileCount: 0 });
    assert.match(hint, /点上方 ⟳ 重新读取/);
    assert.doesNotMatch(hint, /正在读取/);
  });
});

// ─── 3. defaultResolvedModel ──────────────────────────────────
test.describe('defaultResolvedModel —— 获取 default 档位的真实 wire id', () => {
  test('典型输入：列表中存在 default 对象且有 resolvedModel 时返回修剪后的 wire', () => {
    const list = [
      { value: 'opus', resolvedModel: 'claude-opus' },
      { value: 'default', resolvedModel: '  claude-3-7-sonnet  ' },
    ];
    assert.equal(defaultResolvedModel(list), 'claude-3-7-sonnet');
  });

  test('边界输入：非数组、空数组、无 default 条目返回空字符串', () => {
    assert.equal(defaultResolvedModel(null), '');
    assert.equal(defaultResolvedModel(undefined), '');
    assert.equal(defaultResolvedModel([]), '');
    assert.equal(defaultResolvedModel('not-array'), '');
    assert.equal(defaultResolvedModel([{ value: 'opus' }]), '');
  });

  test('边界与产品语义：default 为纯字符串或 resolvedModel 为空/null 时返回空字符串', () => {
    assert.equal(defaultResolvedModel(['default']), '');
    assert.equal(defaultResolvedModel([{ value: 'default' }]), '');
    assert.equal(defaultResolvedModel([{ value: 'default', resolvedModel: null }]), '');
    assert.equal(defaultResolvedModel([{ value: 'default', resolvedModel: '   ' }]), '');
  });
});

// ─── 4. resolveSendModel ──────────────────────────────────────
test.describe('resolveSendModel —— 发送前将档位 pin 为真实 wire id', () => {
  const MODELS = [
    { value: 'default', resolvedModel: 'grok-4.5[1m]' },
    { value: 'opus', resolvedModel: 'grok-4.5' },
    { value: 'haiku', displayName: 'Haiku' },
  ];

  test('典型输入：指定具体档位时优先 pin 到对应 wire', () => {
    assert.equal(resolveSendModel({ selectValue: 'opus', modelsList: MODELS }), 'grok-4.5');
  });

  test('边界输入：空参数、null 或全空对象返回 undefined 或 default wire', () => {
    assert.equal(resolveSendModel(), undefined);
    assert.equal(resolveSendModel({}), undefined);
    assert.equal(resolveSendModel({ selectValue: null, modelsList: null }), undefined);
    assert.equal(resolveSendModel({ selectValue: '', modelsList: MODELS }), 'grok-4.5[1m]');
  });

  test('产品语义：empty 或 default 映射为 default 条目的 resolvedModel；无列表时返回 undefined 让 CLI 自选', () => {
    assert.equal(resolveSendModel({ selectValue: 'default', modelsList: MODELS }), 'grok-4.5[1m]');
    assert.equal(resolveSendModel({ fullModel: 'default', modelsList: MODELS }), 'grok-4.5[1m]');
    assert.equal(resolveSendModel({ selectValue: 'default', modelsList: [] }), undefined);
    assert.equal(resolveSendModel({ selectValue: '', modelsList: [] }), undefined);
  });

  test('产品语义：fullModel 优先级高于 selectValue；列表中无对应 resolved 时保留原值', () => {
    assert.equal(resolveSendModel({ selectValue: 'opus', fullModel: 'haiku', modelsList: MODELS }), 'haiku');
    assert.equal(resolveSendModel({ selectValue: 'unknown-model', modelsList: MODELS }), 'unknown-model');
  });
});

// ─── 5. formatCachePercent ────────────────────────────────────
test.describe('formatCachePercent —— 缓存比例取整百分比', () => {
  test('典型输入：0..1 小数比率正确转换为四舍五入百分比', () => {
    assert.equal(formatCachePercent(0.856), '86%');
    assert.equal(formatCachePercent(0.123), '12%');
    assert.equal(formatCachePercent(0.5), '50%');
  });

  test('典型输入：百分数 (>1) 原样四舍五入为整百分比', () => {
    assert.equal(formatCachePercent(85.6), '86%');
    assert.equal(formatCachePercent(99.4), '99%');
    assert.equal(formatCachePercent(100), '100%');
  });

  test('边界输入：0 与 1 边界值', () => {
    assert.equal(formatCachePercent(0), '0%');
    assert.equal(formatCachePercent(1), '100%');
    assert.equal(formatCachePercent('0'), '0%');
    assert.equal(formatCachePercent('0.75'), '75%');
  });

  test('边界输入：null / undefined / 空串 / 非数值 / NaN / Infinity 回落破折号 —', () => {
    assert.equal(formatCachePercent(null), '—');
    assert.equal(formatCachePercent(undefined), '—');
    assert.equal(formatCachePercent(''), '0%'); // Number('') 为 0，有效数字
    assert.equal(formatCachePercent('   '), '0%');
    assert.equal(formatCachePercent('abc'), '—');
    assert.equal(formatCachePercent(NaN), '—');
    assert.equal(formatCachePercent(Infinity), '—');
    assert.equal(formatCachePercent(-Infinity), '—');
  });

  test('产品语义：负数百分比正常输出（不按 [0, 1] 乘 100）', () => {
    assert.equal(formatCachePercent(-5.2), '-5%');
  });
});

// ─── 6. effortLevelSubtitle ───────────────────────────────────
test.describe('effortLevelSubtitle —— 思考档位副文案', () => {
  test('典型输入：所有支持档位输出预期副文案', () => {
    assert.equal(effortLevelSubtitle('low'), '更快更省');
    assert.equal(effortLevelSubtitle('medium'), '均衡');
    assert.equal(effortLevelSubtitle('med'), '均衡');
    assert.equal(effortLevelSubtitle('high'), '更深入');
    assert.equal(effortLevelSubtitle('xhigh'), '很深入更慢');
    assert.equal(effortLevelSubtitle('max'), '最深入更慢更贵');
    assert.equal(effortLevelSubtitle('ultracode'), 'xhigh + 多 agent workflow · 最彻底');
  });

  test('边界输入：大小写无关与空格容错', () => {
    assert.equal(effortLevelSubtitle('LOW'), '更快更省');
    assert.equal(effortLevelSubtitle('Medium'), '均衡');
    assert.equal(effortLevelSubtitle('XHigh'), '很深入更慢');
    assert.equal(effortLevelSubtitle('UltraCode'), 'xhigh + 多 agent workflow · 最彻底');
  });

  test('边界输入：空串 / null / undefined / 未知档位返回空串', () => {
    assert.equal(effortLevelSubtitle(''), '');
    assert.equal(effortLevelSubtitle(null), '');
    assert.equal(effortLevelSubtitle(undefined), '');
    assert.equal(effortLevelSubtitle('unknown-level'), '');
    assert.equal(effortLevelSubtitle(0), '');
  });
});

// ─── 7. shouldShowBusyWithMirror ──────────────────────────────
test.describe('shouldShowBusyWithMirror —— 镜像只读时不与本地忙碌条同现', () => {
  test('典型输入：非只读时如实反映 busy 状态', () => {
    assert.equal(shouldShowBusyWithMirror({ mirrorReadonly: false, busy: true }), true);
    assert.equal(shouldShowBusyWithMirror({ mirrorReadonly: false, busy: false }), false);
  });

  test('边界输入：空对象与缺省调用安全回落', () => {
    assert.equal(shouldShowBusyWithMirror(), false);
    assert.equal(shouldShowBusyWithMirror({}), false);
    assert.equal(shouldShowBusyWithMirror({ busy: 1 }), true);
    assert.equal(shouldShowBusyWithMirror({ busy: 0 }), false);
  });

  test('产品语义：mirrorReadonly 为 true 时恒为 false，绝不与本地忙碌条同现', () => {
    assert.equal(shouldShowBusyWithMirror({ mirrorReadonly: true, busy: true }), false);
    assert.equal(shouldShowBusyWithMirror({ mirrorReadonly: true, busy: false }), false);
  });
});

// ─── 8. withUltracodeKeyword ──────────────────────────────────
test.describe('withUltracodeKeyword —— 仅用户在消息中写 ultracode 时保留关键词触发', () => {
  test('典型输入：未带 ultracode 时在消息头部补充关键词', () => {
    assert.equal(withUltracodeKeyword('请帮我审查代码'), 'ultracode 请帮我审查代码');
    assert.equal(withUltracodeKeyword('hello world'), 'ultracode hello world');
  });

  test('边界输入：空串 / 纯空白 / null / undefined 仅返回 ultracode', () => {
    assert.equal(withUltracodeKeyword(''), 'ultracode');
    assert.equal(withUltracodeKeyword('   '), 'ultracode');
    assert.equal(withUltracodeKeyword(null), 'ultracode');
    assert.equal(withUltracodeKeyword(undefined), 'ultracode');
    assert.equal(withUltracodeKeyword(0), 'ultracode 0');
  });

  test('产品语义：开头已有 ultracode（不区分大小写）时不重复叠加', () => {
    assert.equal(withUltracodeKeyword('ultracode'), 'ultracode');
    assert.equal(withUltracodeKeyword('ultracode inspect'), 'ultracode inspect');
    assert.equal(withUltracodeKeyword('UltraCode do something'), 'UltraCode do something');
    assert.equal(withUltracodeKeyword('  ultracode  trim test  '), 'ultracode  trim test');
  });

  test('产品语义：若开头是 ultracode 开头的其他单词（如 ultracoder），必须加上空格补全关键词', () => {
    assert.equal(withUltracodeKeyword('ultracoder test'), 'ultracode ultracoder test');
  });
});

// ─── 9. withUltracodeTier ─────────────────────────────────────
test.describe('withUltracodeTier —— 仅在支持 xhigh 时追加 ultracode 档位', () => {
  test('典型输入：包含 xhigh 且不含 ultracode 时追加 ultracode', () => {
    const res = withUltracodeTier(['low', 'medium', 'high', 'xhigh']);
    assert.deepEqual(res, ['low', 'medium', 'high', 'xhigh', 'ultracode']);
  });

  test('边界输入：非数组输入返回空数组', () => {
    assert.deepEqual(withUltracodeTier(null), []);
    assert.deepEqual(withUltracodeTier(undefined), []);
    assert.deepEqual(withUltracodeTier('xhigh'), []);
    assert.deepEqual(withUltracodeTier(123), []);
  });

  test('产品语义：不支持 xhigh 时不追加 ultracode；已含 ultracode 时幂等不重复添加', () => {
    const noXhigh = ['low', 'medium', 'high'];
    assert.equal(withUltracodeTier(noXhigh), noXhigh);

    const alreadyHas = ['xhigh', 'ultracode'];
    assert.equal(withUltracodeTier(alreadyHas), alreadyHas);
  });
});

// ─── 10. resolveEffortSelection ───────────────────────────────
test.describe('resolveEffortSelection —— UI 档位映射为 SDK 参数与 ultracode 标记', () => {
  test('典型输入：普通档位原样透传，ultracode 标记为 false', () => {
    assert.deepEqual(resolveEffortSelection('low'), { effort: 'low', ultracode: false });
    assert.deepEqual(resolveEffortSelection('high'), { effort: 'high', ultracode: false });
    assert.deepEqual(resolveEffortSelection('max'), { effort: 'max', ultracode: false });
  });

  test('边界输入：空串 / null / undefined 映射为 effort: null', () => {
    assert.deepEqual(resolveEffortSelection(''), { effort: null, ultracode: false });
    assert.deepEqual(resolveEffortSelection(null), { effort: null, ultracode: false });
    assert.deepEqual(resolveEffortSelection(undefined), { effort: null, ultracode: false });
  });

  test('产品语义：UI 档 ultracode 映射为 effort=xhigh 与 ultracode=true，禁止把字面量 ultracode 塞入 effort', () => {
    const res = resolveEffortSelection('ultracode');
    assert.deepEqual(res, { effort: 'xhigh', ultracode: true });
    assert.notEqual(res.effort, 'ultracode');
  });
});

// ─── 11. modelEntryFor ────────────────────────────────────────
test.describe('modelEntryFor —— 模型候选项匹配（精确与网关后缀/子串桥接）', () => {
  const CANDIDATES = [
    { value: 'opus', displayName: 'Claude Opus' },
    { value: 'claude-sonnet-3-7[1m]', displayName: 'Sonnet 1M' },
    { value: 'deepseek-v3', displayName: 'DeepSeek V3' },
    'string-model',
  ];

  test('典型输入：精确匹配 value 或字符串项', () => {
    assert.equal(modelEntryFor('opus', CANDIDATES), CANDIDATES[0]);
    assert.equal(modelEntryFor('string-model', CANDIDATES), 'string-model');
  });

  test('边界输入：空值、非数组或空列表返回 null', () => {
    assert.equal(modelEntryFor('', CANDIDATES), null);
    assert.equal(modelEntryFor(null, CANDIDATES), null);
    assert.equal(modelEntryFor(undefined, CANDIDATES), null);
    assert.equal(modelEntryFor('opus', null), null);
    assert.equal(modelEntryFor('opus', []), null);
    assert.equal(modelEntryFor('opus', [null, undefined, {}]), null);
  });

  test('产品语义：带网关后缀 [1m] 且词边界匹配时成功桥接', () => {
    // 调用方为 prefix-claude-sonnet-3-7[1m]，候选为 claude-sonnet-3-7[1m]
    const matched = modelEntryFor('custom-claude-sonnet-3-7[1m]', CANDIDATES);
    assert.equal(matched, CANDIDATES[1]);
  });

  test('产品语义：子串匹配防越界（如 deepseek-v3 不得误匹配 deepseek-v3.1）', () => {
    assert.equal(modelEntryFor('deepseek-v3.1', CANDIDATES), null);
    assert.equal(modelEntryFor('deepseek-v3-chat', CANDIDATES), CANDIDATES[2]);
  });

  test('产品语义：后缀不一致时不得匹配（如 [2m] 不匹配 [1m]）', () => {
    assert.equal(modelEntryFor('claude-sonnet-3-7[2m]', CANDIDATES), null);
  });
});

// ─── 12. modelLabelFor ────────────────────────────────────────
test.describe('modelLabelFor —— 给人看的模型展示名（折叠头与思考归属）', () => {
  const CANDIDATES = [
    { value: 'opus', displayName: 'Claude 3 Opus' },
    { value: 'bare-sonnet' },
    'plain-string',
  ];

  test('典型输入：匹配到对象时优先返回 displayName，无 displayName 则返回 value', () => {
    assert.equal(modelLabelFor('opus', CANDIDATES), 'Claude 3 Opus');
    assert.equal(modelLabelFor('bare-sonnet', CANDIDATES), 'bare-sonnet');
    assert.equal(modelLabelFor('plain-string', CANDIDATES), 'plain-string');
  });

  test('边界输入：空值返回空字符串（CLI 不 pin 语义），未命中时诚实回落原值', () => {
    assert.equal(modelLabelFor('', CANDIDATES), '');
    assert.equal(modelLabelFor(null, CANDIDATES), '');
    assert.equal(modelLabelFor(undefined, CANDIDATES), '');
    assert.equal(modelLabelFor('unknown-model', CANDIDATES), 'unknown-model');
    assert.equal(modelLabelFor('opus', null), 'opus');
  });

  test('产品语义：与磁贴展示名同源，不输出 default 内部字面量', () => {
    assert.equal(modelLabelFor('', [{ value: 'default', displayName: 'Default' }]), '');
  });
});

// ─── 13. resolveModelDisplayName ──────────────────────────────
test.describe('resolveModelDisplayName —— 模型选择器与文案展示名', () => {
  const CANDIDATES = [
    { value: 'opus', displayName: 'Claude 3 Opus', resolvedModel: 'grok-wire' },
    { value: 'empty-name', displayName: '   ', resolvedModel: 'grok-wire' },
    { value: 'no-name' },
  ];

  test('典型输入：优先返回修剪后的 displayName，无 displayName 则回落 value', () => {
    assert.equal(resolveModelDisplayName('opus', CANDIDATES), 'Claude 3 Opus');
    assert.equal(resolveModelDisplayName('empty-name', CANDIDATES), 'empty-name');
    assert.equal(resolveModelDisplayName('no-name', CANDIDATES), 'no-name');
  });

  test('边界输入：空串 / null / undefined 返回空串，未命中回落原值字符串', () => {
    assert.equal(resolveModelDisplayName('', CANDIDATES), '');
    assert.equal(resolveModelDisplayName(null, CANDIDATES), '');
    assert.equal(resolveModelDisplayName(undefined, CANDIDATES), '');
    assert.equal(resolveModelDisplayName('custom-val', CANDIDATES), 'custom-val');
    assert.equal(resolveModelDisplayName('123', CANDIDATES), '123');
  });

  test('产品语义：绝不把 resolvedModel 抬成展示名（中转站不重写展示名）', () => {
    const name = resolveModelDisplayName('opus', CANDIDATES);
    assert.equal(name, 'Claude 3 Opus');
    assert.notEqual(name, 'grok-wire');
  });
});

// ─── 14. resolveGatewayModelName ──────────────────────────────
test.describe('resolveGatewayModelName —— 网关真实 wire 模型名探测', () => {
  const CANDIDATES = [
    { value: 'opus', displayName: 'Custom Opus', resolvedModel: 'grok-4.5' },
    { value: 'sonnet', displayName: 'Custom Sonnet', resolvedModel: '  grok-sonnet  ' },
    { value: 'haiku', displayName: 'Custom Haiku' },
    { value: 'empty-wire', resolvedModel: '   ' },
  ];

  test('典型输入：候选项确有 resolvedModel 时返回修剪后的 wire 名称', () => {
    assert.equal(resolveGatewayModelName('opus', CANDIDATES), 'grok-4.5');
    assert.equal(resolveGatewayModelName('sonnet', CANDIDATES), 'grok-sonnet');
  });

  test('边界输入：空值、非对象、列表为空返回空串', () => {
    assert.equal(resolveGatewayModelName('', CANDIDATES), '');
    assert.equal(resolveGatewayModelName(null, CANDIDATES), '');
    assert.equal(resolveGatewayModelName(undefined, CANDIDATES), '');
    assert.equal(resolveGatewayModelName('opus', null), '');
    assert.equal(resolveGatewayModelName('opus', []), '');
  });

  test('产品语义：无 resolvedModel 或为空时恒返回空串，绝不回落 displayName 或 value（P0-09e 锁定）', () => {
    assert.equal(resolveGatewayModelName('haiku', CANDIDATES), '');
    assert.equal(resolveGatewayModelName('empty-wire', CANDIDATES), '');
    assert.equal(resolveGatewayModelName('non-existent', CANDIDATES), '');
  });
});

// ─── 15. resolveModelPillText ─────────────────────────────────
test.describe('resolveModelPillText —— 底栏当前模型 pill 文案决策', () => {
  const MODELS = [
    { value: 'default', resolvedModel: 'grok-default' },
    { value: 'opus', displayName: 'Opus Disp', resolvedModel: 'grok-4.5' },
    { value: 'sonnet[1m]', resolvedModel: 'grok-sonnet' },
  ];

  test('典型输入：已选模型且有网关 resolvedModel 时优先显示 wire', () => {
    assert.equal(resolveModelPillText({ model: 'opus', modelsList: MODELS }), 'grok-4.5');
  });

  test('典型输入：已选模型无网关映射时显示原值 + 后缀', () => {
    assert.equal(resolveModelPillText({ model: 'custom', gatewaySuffix: '[1m]', modelsList: MODELS }), 'custom[1m]');
    assert.equal(resolveModelPillText({ model: 'custom', modelsList: MODELS }), 'custom');
  });

  test('边界输入：未选模型时的回落链路（default.wire → cliDefaultLabel → cwdDefaultModel → 默认）', () => {
    // 1. default wire 存在时优先采用
    assert.equal(resolveModelPillText({ modelsList: MODELS }), 'grok-default');

    // 2. 无 default wire，有 cliDefaultLabel
    assert.equal(resolveModelPillText({ cliDefaultLabel: 'CLI Default' }), 'CLI Default');

    // 3. 无 default wire/cliDefaultLabel，有 cwdDefaultModel（命中网关解析）
    const noDefModels = [
      { value: 'opus', resolvedModel: 'grok-4.5' },
      { value: 'sonnet[1m]', resolvedModel: 'grok-sonnet' },
    ];
    assert.equal(resolveModelPillText({ cwdDefaultModel: 'sonnet[1m]', modelsList: noDefModels }), 'grok-sonnet');

    // 4. 无 default wire/cliDefaultLabel，cwdDefaultModel 剥除网关后缀裸名
    assert.equal(resolveModelPillText({ cwdDefaultModel: 'claude-opus[1m]' }), 'claude-opus');

    // 5. 全空回落「默认」
    assert.equal(resolveModelPillText(), '默认');
    assert.equal(resolveModelPillText({}), '默认');
  });

  test('产品语义：禁止无 resolvedModel 时用 displayName 覆盖 pill', () => {
    const list = [{ value: 'haiku', displayName: 'Display Haiku' }];
    assert.equal(resolveModelPillText({ model: 'haiku', modelsList: list }), 'haiku');
  });
});

// ─── 16. effortLevelsFor ──────────────────────────────────────
test.describe('effortLevelsFor —— 决定模型支持的思考档位列表与行可见性', () => {
  const CANDIDATES = [
    { value: 'opus', supportedEffortLevels: ['low', 'medium', 'high', 'xhigh'] },
    { value: 'haiku', supportedEffortLevels: [] },
    { value: 'unsupported' },
  ];

  test('典型输入：匹配到模型且支持 effort，返回对应档位列表且 hidden: false', () => {
    const res = effortLevelsFor('opus', CANDIDATES);
    assert.deepEqual(res, {
      hidden: false,
      levels: ['low', 'medium', 'high', 'xhigh'],
    });
  });

  test('边界输入：非数组列表或空列表返回全空与 hidden: false', () => {
    assert.deepEqual(effortLevelsFor('', null), { hidden: false, levels: [] });
    assert.deepEqual(effortLevelsFor('opus', []), { hidden: false, levels: [] });
  });

  test('产品语义：明确不支持 effort 的模型（supportedEffortLevels 为空或缺省）返回 hidden: true', () => {
    assert.deepEqual(effortLevelsFor('haiku', CANDIDATES), { hidden: true, levels: [] });
    assert.deepEqual(effortLevelsFor('unsupported', CANDIDATES), { hidden: true, levels: [] });
  });

  test('产品语义：未指定具体模型或匹配不上时，返回所有候选 supportedEffortLevels 的并集', () => {
    const multi = [
      { value: 'm1', supportedEffortLevels: ['low', 'medium'] },
      { value: 'm2', supportedEffortLevels: ['medium', 'high'] },
    ];
    const res = effortLevelsFor('not-in-list', multi);
    assert.deepEqual(res, { hidden: false, levels: ['low', 'medium', 'high'] });
  });

  test('产品语义：返回的 levels 数组为浅拷贝切片，修改不污染原候选条目', () => {
    const res = effortLevelsFor('opus', CANDIDATES);
    res.levels.push('mutated');
    assert.equal(CANDIDATES[0].supportedEffortLevels.includes('mutated'), false);
  });
});

// ─── 17. effortUiState ────────────────────────────────────────
test.describe('effortUiState —— 计算思考档位的 UI 展示状态', () => {
  const SUPPORTED = ['low', 'medium', 'high'];

  test('典型输入：有效档位在候选列表中时正确选中', () => {
    const state = effortUiState('medium', SUPPORTED);
    assert.deepEqual(state, {
      level: 'medium',
      selected: 'medium',
      label: 'medium',
      placeholder: 'medium（当前模型不可选）',
    });
  });

  test('边界输入：supportedLevels 为非数组或 null 时安全处理', () => {
    const state = effortUiState('low', null);
    assert.equal(state.selected, '');
    assert.equal(state.level, 'low');
  });

  test('产品语义：绝不把未知/null 猜成 low，FRESH 态保留「默认思考」与「模型默认」', () => {
    const fresh = effortUiState(null, SUPPORTED);
    assert.deepEqual(fresh, {
      level: null,
      selected: '',
      label: '默认思考',
      placeholder: '模型默认',
    });
    assert.notEqual(fresh.level, 'low');
    assert.notEqual(fresh.selected, 'low');
  });

  test('产品语义：mirrorReadonly 时表达 CLI 档位不可观测，文案区分于 FRESH', () => {
    const mirror = effortUiState(null, SUPPORTED, { mirrorReadonly: true });
    assert.deepEqual(mirror, {
      level: null,
      selected: '',
      label: 'CLI 档位未知',
      placeholder: 'CLI 当前档未知',
    });
  });

  test('产品语义：已设置档位但当前模型不支持时，selected 置空并展示占位提示', () => {
    const unavail = effortUiState('max', SUPPORTED);
    assert.equal(unavail.selected, '');
    assert.equal(unavail.level, 'max');
    assert.equal(unavail.placeholder, 'max（当前模型不可选）');
  });
});

// ─── 18. defaultModelTileLabel ────────────────────────────────
test.describe('defaultModelTileLabel —— 模型网格「默认磁贴」文案决策', () => {
  test('典型输入：无 currentModel 但已知 cwdDefaultModel 时显示默认模型名并剥离网关后缀', () => {
    const res = defaultModelTileLabel({ currentModel: '', cwdDefaultModel: 'claude-3-7-sonnet[1m]' });
    assert.deepEqual(res, {
      title: '默认模型',
      subtitle: 'claude-3-7-sonnet',
      showsName: true,
    });
  });

  test('典型输入：已知 currentModel 时显示「沿用当前模型」通用文案', () => {
    const res = defaultModelTileLabel({ currentModel: 'opus', cwdDefaultModel: 'claude-3-7-sonnet' });
    assert.deepEqual(res, {
      title: '沿用当前模型',
      subtitle: '不指定特定模型',
      showsName: false,
    });
  });

  test('边界输入：全空或未传参时回落通用文案', () => {
    assert.deepEqual(defaultModelTileLabel(), {
      title: '沿用当前模型',
      subtitle: '不指定特定模型',
      showsName: false,
    });
    assert.deepEqual(defaultModelTileLabel({ currentModel: null, cwdDefaultModel: null }), {
      title: '沿用当前模型',
      subtitle: '不指定特定模型',
      showsName: false,
    });
  });
});

// ─── 19. applyGatewaySuffix ───────────────────────────────────
test.describe('applyGatewaySuffix —— 发送前网关后缀补齐与去重', () => {
  const MODELS = [
    { value: 'opus', resolvedModel: 'grok-4.5' },
    { value: 'haiku' },
    'string-model',
  ];

  test('典型输入：不在候选列表中的自定义模型追加网关后缀', () => {
    assert.equal(applyGatewaySuffix('custom-model', '[1m]', MODELS), 'custom-model[1m]');
  });

  test('边界输入：model 为空或 gatewaySuffix 为空时原样返回', () => {
    assert.equal(applyGatewaySuffix('', '[1m]', MODELS), '');
    assert.equal(applyGatewaySuffix(null, '[1m]', MODELS), null);
    assert.equal(applyGatewaySuffix('opus', '', MODELS), 'opus');
    assert.equal(applyGatewaySuffix('opus', null, MODELS), 'opus');
    assert.equal(applyGatewaySuffix('opus', '[1m]', null), 'opus[1m]');
    assert.equal(applyGatewaySuffix('opus', '[1m]', []), 'opus[1m]');
  });

  test('产品语义：同时认 value 与 resolvedModel 为合法候选名，不重复贴后缀（防 grok-4.5[1m][1m]）', () => {
    // 1. 命中 candidate.value
    assert.equal(applyGatewaySuffix('opus', '[1m]', MODELS), 'opus');
    assert.equal(applyGatewaySuffix('haiku', '[1m]', MODELS), 'haiku');

    // 2. 命中 candidate.resolvedModel（核心回归锚点 7febabc）
    assert.equal(applyGatewaySuffix('grok-4.5', '[1m]', MODELS), 'grok-4.5');

    // 3. 命中 string 项
    assert.equal(applyGatewaySuffix('string-model', '[1m]', MODELS), 'string-model');
  });
});
