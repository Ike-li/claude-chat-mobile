// tests/unit/logic-permissions.test.mjs —— permissions.js 纯函数单测（权限档枚举与磁贴规格）
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SDK_PERMISSION_MODES,
  isSdkPermissionMode,
  permissionModeTileSpecs,
  describePersistScope,
} from '../../app/public/js/logic/permissions.js';
import { setLang } from '../../app/public/js/i18n.js';

// describePersistScope 内部走 t()，而 setLang 是模块级全局状态、同进程内别的测试文件会改它。
// 每个 test 前重置为 zh，避免受执行顺序影响（惯例同 logic-format.test.mjs）。
test.beforeEach(() => setLang('zh'));

test.describe('SDK_PERMISSION_MODES —— 权限档常量导出', () => {
  test('典型输入：包含全部 6 个预期的权限档', () => {
    assert.equal(SDK_PERMISSION_MODES.length, 6);
    assert.deepEqual(SDK_PERMISSION_MODES, [
      'default',
      'plan',
      'acceptEdits',
      'dontAsk',
      'auto',
      'bypassPermissions',
    ]);
  });

  test('边界输入：对象已冻结，防止运行时被意外篡改', () => {
    assert.equal(Object.isFrozen(SDK_PERMISSION_MODES), true);
    assert.throws(() => {
      // 严格模式或冻结数组 push/修改应报错
      SDK_PERMISSION_MODES.push('illegal');
    }, TypeError);
  });

  test('产品语义：顺序是安全档在前、bypassPermissions 危险档置底', () => {
    assert.equal(SDK_PERMISSION_MODES[0], 'default');
    assert.equal(SDK_PERMISSION_MODES.at(-1), 'bypassPermissions');
    assert.equal(SDK_PERMISSION_MODES.indexOf('bypassPermissions'), SDK_PERMISSION_MODES.length - 1);
  });
});

test.describe('isSdkPermissionMode —— 权限档判定', () => {
  test('典型输入：6 个合法权限档均返回 true', () => {
    for (const mode of SDK_PERMISSION_MODES) {
      assert.equal(isSdkPermissionMode(mode), true, `${mode} 应当被判定为合法权限档`);
    }
  });

  test('边界输入：null、undefined、空串、数字、布尔值及对象等非合法字符串返回 false', () => {
    assert.equal(isSdkPermissionMode(null), false);
    assert.equal(isSdkPermissionMode(undefined), false);
    assert.equal(isSdkPermissionMode(''), false);
    assert.equal(isSdkPermissionMode(0), false);
    assert.equal(isSdkPermissionMode(1), false);
    assert.equal(isSdkPermissionMode(-1), false);
    assert.equal(isSdkPermissionMode(true), false);
    assert.equal(isSdkPermissionMode(false), false);
    assert.equal(isSdkPermissionMode({}), false);
    assert.equal(isSdkPermissionMode([]), false);
    assert.equal(isSdkPermissionMode(NaN), false);
  });

  test('产品语义：manual 是 CLI 别名而非协议值，返回 false', () => {
    assert.equal(isSdkPermissionMode('manual'), false);
  });

  test('产品语义：严格大小写匹配，非完全匹配返回 false', () => {
    assert.equal(isSdkPermissionMode('Default'), false);
    assert.equal(isSdkPermissionMode('PLAN'), false);
    assert.equal(isSdkPermissionMode('acceptedits'), false);
    assert.equal(isSdkPermissionMode('bypasspermissions'), false);
    assert.equal(isSdkPermissionMode('unknown_mode'), false);
  });
});

test.describe('permissionModeTileSpecs —— 磁贴规格生成', () => {
  test('典型输入：默认无参调用返回 6 个完整磁贴规格，结构与字段类型契约完整', () => {
    const tiles = permissionModeTileSpecs();
    assert.equal(tiles.length, 6);
    assert.deepEqual(tiles.map(t => t.id), [...SDK_PERMISSION_MODES]);

    for (const tile of tiles) {
      assert.equal(typeof tile.id, 'string');
      assert.equal(typeof tile.title, 'string');
      assert.equal(typeof tile.desc, 'string');
      assert.equal(typeof tile.selectLabel, 'string');
      assert.equal(typeof tile.pill, 'string');
      assert.equal(typeof tile.bar, 'string');
      assert.equal(typeof tile.danger, 'boolean');
      assert.ok(tile.title.length > 0, `${tile.id} title 不能为空`);
      assert.ok(tile.desc.length > 0, `${tile.id} desc 不能为空`);
    }
  });

  test('典型输入：传入自定义合法子集数组，按输入顺序生成', () => {
    const subset = ['plan', 'auto'];
    const tiles = permissionModeTileSpecs(subset);
    assert.equal(tiles.length, 2);
    assert.equal(tiles[0].id, 'plan');
    assert.equal(tiles[0].title, 'Plan');
    assert.equal(tiles[1].id, 'auto');
    assert.equal(tiles[1].title, 'Auto');
  });

  test('边界输入：非数组输入（null、undefined、数字、字符串）回落到默认 SDK_PERMISSION_MODES', () => {
    assert.equal(permissionModeTileSpecs(null).length, 6);
    assert.equal(permissionModeTileSpecs(undefined).length, 6);
    assert.equal(permissionModeTileSpecs('default').length, 6);
    assert.equal(permissionModeTileSpecs(123).length, 6);
    assert.equal(permissionModeTileSpecs({}).length, 6);
  });

  test('边界输入：空数组输入返回空数组', () => {
    assert.deepEqual(permissionModeTileSpecs([]), []);
  });

  test('边界输入：输入数组中包含非法或未知模式时，自动过滤掉非法项', () => {
    const mixed = ['default', 'invalidMode', null, undefined, 42, 'bypassPermissions'];
    const tiles = permissionModeTileSpecs(mixed);
    assert.equal(tiles.length, 2);
    assert.equal(tiles[0].id, 'default');
    assert.equal(tiles[1].id, 'bypassPermissions');
  });

  test('产品语义：只有 bypassPermissions 标记 danger: true，其余均为 false', () => {
    const tiles = permissionModeTileSpecs();
    const bypass = tiles.find(t => t.id === 'bypassPermissions');
    assert.ok(bypass);
    assert.equal(bypass.danger, true);

    const safeTiles = tiles.filter(t => t.id !== 'bypassPermissions');
    assert.equal(safeTiles.length, 5);
    for (const tile of safeTiles) {
      assert.equal(tile.danger, false, `${tile.id} 不应标记为 danger`);
    }
  });

  test('产品语义：文案固定英文原名（禁止走 t() 中文本地化），核对 6 档文案细节', () => {
    const byId = Object.fromEntries(permissionModeTileSpecs().map(t => [t.id, t]));

    assert.deepEqual(byId.default, {
      id: 'default',
      title: 'Manual',
      desc: 'Prompts for dangerous operations',
      selectLabel: 'Manual',
      pill: 'Manual',
      bar: 'Manual',
      danger: false,
    });
    assert.deepEqual(byId.plan, {
      id: 'plan',
      title: 'Plan',
      desc: 'Planning mode, no tool execution',
      selectLabel: 'Plan',
      pill: 'Plan',
      bar: 'Plan',
      danger: false,
    });
    assert.deepEqual(byId.acceptEdits, {
      id: 'acceptEdits',
      title: 'Accept edits',
      desc: 'Auto-accept file edit operations',
      selectLabel: 'Accept edits',
      pill: 'Accept edits',
      bar: 'Accept edits',
      danger: false,
    });
    assert.deepEqual(byId.dontAsk, {
      id: 'dontAsk',
      title: "Don't ask",
      desc: 'Deny if not pre-approved, no prompts',
      selectLabel: "Don't ask",
      pill: "Don't ask",
      bar: "Don't ask",
      danger: false,
    });
    assert.deepEqual(byId.auto, {
      id: 'auto',
      title: 'Auto',
      desc: 'Model classifier approves or denies',
      selectLabel: 'Auto',
      pill: 'Auto',
      bar: 'Auto',
      danger: false,
    });
    assert.deepEqual(byId.bypassPermissions, {
      id: 'bypassPermissions',
      title: 'Bypass permissions',
      desc: 'Bypass all permission checks',
      selectLabel: 'Bypass permissions',
      pill: 'Bypass',
      bar: 'Bypass permissions',
      danger: true,
    });

    // 严防任何中文字符渗入
    for (const tile of Object.values(byId)) {
      assert.equal(/[一-鿿]/.test(tile.title), false);
      assert.equal(/[一-鿿]/.test(tile.desc), false);
      assert.equal(/[一-鿿]/.test(tile.selectLabel), false);
      assert.equal(/[一-鿿]/.test(tile.pill), false);
      assert.equal(/[一-鿿]/.test(tile.bar), false);
    }
  });
});

test.describe('describePersistScope —— 永久不再问影响面描述', () => {
  test('典型输入：单项已知落盘作用域（zh 语言）', () => {
    const local = describePersistScope(['localSettings']);
    assert.deepEqual(local, {
      label: '本工作区',
      hint: '写入 .claude/settings.local.json，只影响这台电脑上的这个工作区',
    });

    const project = describePersistScope(['projectSettings']);
    assert.deepEqual(project, {
      label: '本项目',
      hint: '写入项目里的 .claude/settings.json —— 这个文件会进 git，团队其他人也会拿到',
    });

    const user = describePersistScope(['userSettings']);
    assert.deepEqual(user, {
      label: '所有项目',
      hint: '写入 ~/.claude/settings.json，对这台电脑上的每个项目生效',
    });
  });

  test('边界输入：非数组、空数组、或只包含不落盘的 session / cliArg 均返回 null', () => {
    assert.equal(describePersistScope(undefined), null);
    assert.equal(describePersistScope(null), null);
    assert.equal(describePersistScope(''), null);
    assert.equal(describePersistScope(0), null);
    assert.equal(describePersistScope({}), null);
    assert.equal(describePersistScope([]), null);
    assert.equal(describePersistScope(['session']), null);
    assert.equal(describePersistScope(['cliArg']), null);
    assert.equal(describePersistScope(['session', 'cliArg']), null);
  });

  test('边界输入：过滤非落盘项后正确返回落盘描述', () => {
    const v = describePersistScope(['session', 'localSettings', 'cliArg']);
    assert.equal(v?.label, '本工作区');
  });

  test('产品语义：混合档取最宽的一档（userSettings > projectSettings > localSettings）', () => {
    // local + project -> project
    const p1 = describePersistScope(['localSettings', 'projectSettings']);
    assert.equal(p1?.label, '本项目');

    // local + user -> user
    const u1 = describePersistScope(['localSettings', 'userSettings']);
    assert.equal(u1?.label, '所有项目');

    // project + user -> user
    const u2 = describePersistScope(['projectSettings', 'userSettings']);
    assert.equal(u2?.label, '所有项目');

    // 三者皆有 -> user
    const u3 = describePersistScope(['localSettings', 'projectSettings', 'userSettings']);
    assert.equal(u3?.label, '所有项目');
  });

  test('产品语义：失败方向绝不能把影响面说小 —— 未知 destination 按最宽档（所有项目）处理', () => {
    // 单独未知
    const unknownSingle = describePersistScope(['futureScopeName']);
    assert.equal(unknownSingle?.label, '所有项目');
    assert.match(unknownSingle?.hint || '', /settings\.json/);

    // 已知窄档 + 未知 -> 必须按最宽档处理，不得静默退化为本工作区或本项目
    const mixedLocal = describePersistScope(['localSettings', 'unknownScope']);
    assert.equal(mixedLocal?.label, '所有项目');

    const mixedProject = describePersistScope(['projectSettings', 'unknownScope']);
    assert.equal(mixedProject?.label, '所有项目');

    // 含有非法类型项在数组内时，由于不是 session/cliArg，也被视作未知 destination 按最宽处理
    const withGarbage = describePersistScope([123, null]);
    assert.equal(withGarbage?.label, '所有项目');
  });

  test('产品语义：英文 locale 下走 i18n 翻译', () => {
    setLang('en');
    try {
      const local = describePersistScope(['localSettings']);
      assert.equal(local?.label, 'this workspace');

      const project = describePersistScope(['projectSettings']);
      assert.equal(project?.label, 'this project');

      const user = describePersistScope(['userSettings']);
      assert.equal(user?.label, 'all projects');
    } finally {
      setLang('zh');
    }
  });
});
