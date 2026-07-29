// tests/unit/cli-settings-defaults.test.mjs —— FRESH/空首页配置权威源纯函数（零 token）。
// 契约：新会话 L0 pending > L3 CLI settings > L4 硬默认；resume 的 mode/model 不走本模块，
// effort 例外（resolveResumeEffort：saved > inherited > L3，见该函数注释）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizePermissionMode,
  normalizeEffortLevel,
  defaultsFromEffectiveSettings,
  resolveFreshPrefs,
  resolveResumeEffort,
  CCM_PERMISSION_MODES,
} from '../../src/agent/cli-settings-defaults.js';

test.describe('normalizePermissionMode', () => {
  test('合法 CCM 档原样通过', () => {
    for (const m of CCM_PERMISSION_MODES) {
      assert.equal(normalizePermissionMode(m), m);
    }
  });
  test("SDK 别名 'manual' → 'default'", () => {
    assert.equal(normalizePermissionMode('manual'), 'default');
  });
  test("'auto' 是合法档（与 CLI / SDK 对齐）", () => {
    assert.equal(normalizePermissionMode('auto'), 'auto');
  });
  test("垃圾 / 空 → null（回落 L4）", () => {
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
      { mode: 'default', effort: 'low', model: undefined, env: undefined },
    );
  });
  test('缺字段 → L4 形状（mode=default, effort=null）', () => {
    assert.deepEqual(defaultsFromEffectiveSettings(undefined), {
      mode: 'default', effort: null, model: undefined, env: undefined,
    });
    assert.deepEqual(defaultsFromEffectiveSettings({}), {
      mode: 'default', effort: null, model: undefined, env: undefined,
    });
  });
  test('顶层 model 有值才 pin', () => {
    assert.equal(
      defaultsFromEffectiveSettings({ model: 'claude-opus-4-8' }).model,
      'claude-opus-4-8',
    );
    assert.equal(defaultsFromEffectiveSettings({ model: '' }).model, undefined);
  });
  test('auto defaultMode → 透传 auto（CLI 设 auto 时新会话继承）', () => {
    assert.equal(
      defaultsFromEffectiveSettings({ permissions: { defaultMode: 'auto' } }).mode,
      'auto',
    );
  });
  test('env 块有值时缓存（浅拷贝）', () => {
    const envIn = { ANTHROPIC_BASE_URL: 'https://gateway.example.com', ANTHROPIC_MODEL: 'opus' };
    const d = defaultsFromEffectiveSettings({ env: envIn });
    assert.deepEqual(d.env, envIn);
    assert.notEqual(d.env, envIn, '应浅拷贝，不直接引用原对象');
  });
  test('env 块缺失/非对象 → undefined', () => {
    assert.equal(defaultsFromEffectiveSettings({}).env, undefined);
    assert.equal(defaultsFromEffectiveSettings({ env: null }).env, undefined);
    assert.equal(defaultsFromEffectiveSettings({ env: 'string' }).env, undefined);
    assert.equal(defaultsFromEffectiveSettings({ env: [1, 2] }).env, undefined);
  });
});

test.describe('resolveFreshPrefs（L0 > L3 > L4）', () => {
  const cliLow = { mode: 'acceptEdits', effort: 'low', model: undefined };

  test('无 pending、无 cli → L4 硬默认', () => {
    assert.deepEqual(resolveFreshPrefs({}), {
      mode: 'default', effort: null, ultracode: false, model: undefined,
    });
  });

  test('无 pending、有 cli → 用 L3', () => {
    assert.deepEqual(resolveFreshPrefs({ cliDefaults: cliLow }), {
      mode: 'acceptEdits', effort: 'low', ultracode: false, model: undefined,
    });
  });

  test('pending mode 覆盖 L3', () => {
    assert.deepEqual(
      resolveFreshPrefs({
        hasPendingMode: true,
        pendingMode: 'plan',
        cliDefaults: cliLow,
      }),
      { mode: 'plan', effort: 'low', ultracode: false, model: undefined },
    );
  });

  test('pending effort=null 合法覆盖 L3 的 low（用户显式选「模型默认」）', () => {
    assert.deepEqual(
      resolveFreshPrefs({
        hasPendingEffort: true,
        pendingEffort: null,
        cliDefaults: cliLow,
      }),
      { mode: 'acceptEdits', effort: null, ultracode: false, model: undefined },
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
      { mode: 'default', effort: null, ultracode: false, model: undefined },
    );
  });

  test('pending ultracode → sdk xhigh + ultracode flag（H1，不得被 normalizeEffortLevel 剥掉）', () => {
    assert.deepEqual(
      resolveFreshPrefs({
        hasPendingEffort: true,
        pendingEffort: 'ultracode',
        cliDefaults: cliLow,
      }),
      { mode: 'acceptEdits', effort: 'xhigh', ultracode: true, model: undefined },
    );
  });

    test('cli model 透传（仅当字符串非空）', () => {
    assert.equal(
      resolveFreshPrefs({ cliDefaults: { mode: 'default', effort: null, model: 'sonnet' } }).model,
      'sonnet',
    );
  });
});

test.describe('resolveResumeEffort（resume 专用：saved > inherited > L3，全部按归一后 ?? 语义折叠）', () => {
  const cliHigh = { mode: 'default', effort: 'high', model: undefined };

  test('saved 有非空值 → 直接采用，不看后两层', () => {
    assert.equal(
      resolveResumeEffort({ savedEffort: 'low', inheritedEffortValue: 'max', cliDefaults: cliHigh }),
      'low',
    );
  });

  test('saved 缺失（undefined，从未在 web 端记录过）→ 落到 inherited', () => {
    assert.equal(
      resolveResumeEffort({ savedEffort: undefined, inheritedEffortValue: 'max', cliDefaults: cliHigh }),
      'max',
    );
  });

  test('saved 显式 null（陷阱：可能是用户选过模型默认，也可能只是上次冷启动兜底写入）→ 仍继续往下兜底，不当终值', () => {
    assert.equal(
      resolveResumeEffort({ savedEffort: null, inheritedEffortValue: 'max', cliDefaults: cliHigh }),
      'max',
    );
  });

  test('saved / inherited 都空 → 落到 L3 CLI settings（本次修复的核心场景：从未碰过 web 的旧会话）', () => {
    assert.equal(
      resolveResumeEffort({ savedEffort: null, inheritedEffortValue: null, cliDefaults: cliHigh }),
      'high',
    );
    assert.equal(
      resolveResumeEffort({ savedEffort: undefined, inheritedEffortValue: undefined, cliDefaults: cliHigh }),
      'high',
    );
  });

  test('inherited 显式 null（该 cwd 末活实例本身也是模型默认）→ 同样继续往下兜底到 L3', () => {
    assert.equal(
      resolveResumeEffort({ savedEffort: undefined, inheritedEffortValue: null, cliDefaults: cliHigh }),
      'high',
    );
  });

  test('三层全空、L3 也未配置 effortLevel → 落回 null（诚实边界，非 bug）', () => {
    assert.equal(resolveResumeEffort({}), null);
    assert.equal(
      resolveResumeEffort({ savedEffort: null, inheritedEffortValue: null, cliDefaults: null }),
      null,
    );
  });

  test('cliDefaults.effort 缺省键 → 视为 null，不把 undefined 当有值', () => {
    assert.equal(resolveResumeEffort({ cliDefaults: { mode: 'default' } }), null);
  });

  test('非法档一律归一为 null 再继续兜底', () => {
    assert.equal(
      resolveResumeEffort({ savedEffort: 'garbage', inheritedEffortValue: null, cliDefaults: cliHigh }),
      'high',
    );
  });
});
