// test/cli-settings-defaults.test.mjs —— FRESH/空首页配置权威源纯函数（零 token）。
// 契约：新会话 L0 pending > L3 CLI settings > L4 硬默认；resume 不走本模块。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizePermissionMode,
  normalizeEffortLevel,
  defaultsFromEffectiveSettings,
  resolveFreshPrefs,
  CCM_PERMISSION_MODES,
} from '../cli-settings-defaults.js';

test.describe('normalizePermissionMode', () => {
  test('合法 CCM 档原样通过', () => {
    for (const m of CCM_PERMISSION_MODES) {
      assert.equal(normalizePermissionMode(m), m);
    }
  });
  test("SDK 别名 'manual' → 'default'", () => {
    assert.equal(normalizePermissionMode('manual'), 'default');
  });
  test("CCM 不支持的 'auto' / 垃圾 → null（回落 L4）", () => {
    assert.equal(normalizePermissionMode('auto'), null);
    assert.equal(normalizePermissionMode('nope'), null);
    assert.equal(normalizePermissionMode(''), null);
    assert.equal(normalizePermissionMode(null), null);
    assert.equal(normalizePermissionMode(undefined), null);
  });
});

test.describe('normalizeEffortLevel', () => {
  test('合法档原样；空 → null（模型默认）', () => {
    assert.equal(normalizeEffortLevel('low'), 'low');
    assert.equal(normalizeEffortLevel('xhigh'), 'xhigh');
    assert.equal(normalizeEffortLevel('max'), 'max');
    assert.equal(normalizeEffortLevel(null), null);
    assert.equal(normalizeEffortLevel(undefined), null);
    assert.equal(normalizeEffortLevel(''), null);
  });
  test('非法 → null', () => {
    assert.equal(normalizeEffortLevel('ultracode'), null);
    assert.equal(normalizeEffortLevel(3), null);
  });
});

test.describe('defaultsFromEffectiveSettings（L3 抽取）', () => {
  test('本机常见形状：defaultMode + effortLevel=low', () => {
    assert.deepEqual(
      defaultsFromEffectiveSettings({
        permissions: { defaultMode: 'default' },
        effortLevel: 'low',
      }),
      { mode: 'default', effort: 'low', model: undefined },
    );
  });
  test('缺字段 → L4 形状（mode=default, effort=null）', () => {
    assert.deepEqual(defaultsFromEffectiveSettings(undefined), {
      mode: 'default', effort: null, model: undefined,
    });
    assert.deepEqual(defaultsFromEffectiveSettings({}), {
      mode: 'default', effort: null, model: undefined,
    });
  });
  test('顶层 model 有值才 pin', () => {
    assert.equal(
      defaultsFromEffectiveSettings({ model: 'claude-opus-4-8' }).model,
      'claude-opus-4-8',
    );
    assert.equal(defaultsFromEffectiveSettings({ model: '' }).model, undefined);
  });
  test('auto defaultMode → 归一失败回落 default', () => {
    assert.equal(
      defaultsFromEffectiveSettings({ permissions: { defaultMode: 'auto' } }).mode,
      'default',
    );
  });
});

test.describe('resolveFreshPrefs（L0 > L3 > L4）', () => {
  const cliLow = { mode: 'acceptEdits', effort: 'low', model: undefined };

  test('无 pending、无 cli → L4 硬默认', () => {
    assert.deepEqual(resolveFreshPrefs({}), {
      mode: 'default', effort: null, model: undefined,
    });
  });

  test('无 pending、有 cli → 用 L3', () => {
    assert.deepEqual(resolveFreshPrefs({ cliDefaults: cliLow }), {
      mode: 'acceptEdits', effort: 'low', model: undefined,
    });
  });

  test('pending mode 覆盖 L3', () => {
    assert.deepEqual(
      resolveFreshPrefs({
        hasPendingMode: true,
        pendingMode: 'plan',
        cliDefaults: cliLow,
      }),
      { mode: 'plan', effort: 'low', model: undefined },
    );
  });

  test('pending effort=null 合法覆盖 L3 的 low（用户显式选「模型默认」）', () => {
    assert.deepEqual(
      resolveFreshPrefs({
        hasPendingEffort: true,
        pendingEffort: null,
        cliDefaults: cliLow,
      }),
      { mode: 'acceptEdits', effort: null, model: undefined },
    );
  });

  test('pending 非法 mode → 回落 default，不沿用脏值', () => {
    assert.equal(
      resolveFreshPrefs({
        hasPendingMode: true,
        pendingMode: 'garbage',
        cliDefaults: cliLow,
      }).mode,
      'default',
    );
  });

  test('cliDefaults.effort 缺省键 → null，不把 undefined 当有值', () => {
    assert.deepEqual(
      resolveFreshPrefs({ cliDefaults: { mode: 'default' } }),
      { mode: 'default', effort: null, model: undefined },
    );
  });

  test('cli model 透传（仅当字符串非空）', () => {
    assert.equal(
      resolveFreshPrefs({ cliDefaults: { mode: 'default', effort: null, model: 'sonnet' } }).model,
      'sonnet',
    );
  });
});
