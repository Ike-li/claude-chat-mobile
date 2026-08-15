// tests/unit/config-cli.test.mjs —— scripts/config.js（配置 CLI）
//
// 这一层是 headless 用户唯一的配置入口，也是 desktop 端（P3）的数据源。断言重点有三处：
//
//   ① CLI 值解析**不能**复用 coerceToSchemaType —— 见 parseCliValue 那组，这是本文件最重要的一组
//   ② secret 绝不默认出明文（同 CCMCore.swift 那条「刻意不拼 #token=」的纪律）
//   ③ 写入前必须过 validateEnvChanges，CLI 不是配置文件的特权通道
import test from 'node:test';
import assert from 'node:assert/strict';

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { formatValueForDisplay, parseCliValue, parseConfigArgs, runConfigCommand } from '../../scripts/config.js';

// safe-rm: mkdtemp 一次性目录，路径由 mkdtempSync 返回值直接传入，不经任何拼接
const withTempDir = (fn) => {
  const dir = mkdtempSync(join(tmpdir(), 'ccm-config-cli-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const readConfig = (dir) => JSON.parse(readFileSync(join(dir, 'ccm.config.json'), 'utf8'));

// ★★ 本文件最重要的一组。
//
// coerceToSchemaType 的输入是「.env / shell env 里的字面量」，方向由 TOGGLE_* 那三套约定决定：
// WEB_STATUSLINE 默认开、只有 'off' 才是关。于是 coerce('false') → 'false' !== 'off' → **true**。
//
// 而人在终端敲 `config set WEB_STATUSLINE=false` 时意思毫无疑问是「关掉」。直接复用 coerce
// 会把它打开 —— 正是 log-terminal.js:32 记着的那个脚枪（`LOG_STDERR=false` 反而是开）
// 在 CLI 层的原样重演。两个函数服务两种输入来源，必须分开。
test.describe('parseCliValue —— 人在终端敲的值', () => {
  test('toggle：false / off / no / 0 一律是关', () => {
    for (const raw of ['false', 'off', 'no', '0', 'FALSE', ' Off ']) {
      assert.equal(parseCliValue('WEB_STATUSLINE', raw).value, false, `${JSON.stringify(raw)} 应当是关`);
    }
  });

  test('toggle：true / on / yes / 1 一律是开', () => {
    for (const raw of ['true', 'on', 'yes', '1', 'TRUE', ' On ']) {
      assert.equal(parseCliValue('WEB_STATUSLINE', raw).value, true, `${JSON.stringify(raw)} 应当是开`);
    }
  });

  // 与默认方向无关：DEV_MODE 默认关、WEB_STATUSLINE 默认开，但 CLI 语义是绝对的。
  test('toggle：默认方向不影响 CLI 语义', () => {
    assert.equal(parseCliValue('DEV_MODE', 'false').value, false);
    assert.equal(parseCliValue('DEV_MODE', 'true').value, true);
    assert.equal(parseCliValue('LOG_TERMINAL', 'false').value, false);
  });

  test('toggle：看不懂的值报错而不是猜 —— 猜错就是静默反向生效', () => {
    const r = parseCliValue('WEB_STATUSLINE', 'maybe');
    assert.ok(r.error);
    assert.match(r.error, /true\/false/);
  });

  test('number：整数通过，非整数报错', () => {
    assert.equal(parseCliValue('PORT', '4000').value, 4000);
    assert.ok(parseCliValue('PORT', 'abc').error);
    assert.ok(parseCliValue('PORT', '30.5').error);
  });

  test('list：接受 JSON 数组字面量', () => {
    assert.deepEqual(parseCliValue('WORKDIRS', '["/a","/b"]').value, ['/a', '/b']);
    assert.deepEqual(
      parseCliValue('WORKDIRS', '[{"path":"/a","sessionLimit":3}]').value,
      [{ path: '/a', sessionLimit: 3 }],
    );
  });

  // 逗号串**不猜**：一个含逗号的目录名会被静默裂成两个不存在的路径，而白名单里多一个
  // 不存在的路径不会报错（realpath 校验只 warn-skip）。报错并给出正确写法。
  test('list：逗号串拒收并给出 JSON 写法', () => {
    const r = parseCliValue('WORKDIRS', '/a,/b');
    assert.ok(r.error);
    assert.match(r.error, /JSON/);
  });

  test('未知 key 报错 —— 这不是通用配置编辑器', () => {
    assert.ok(parseCliValue('NOT_A_KEY', 'x').error);
  });

  test('文本类原样通过', () => {
    assert.equal(parseCliValue('WORK_DIR', '/Users/you/code').value, '/Users/you/code');
  });
});

test.describe('parseConfigArgs', () => {
  test('KEY=VAL 形式的 set', () => {
    const a = parseConfigArgs(['set', 'PORT=4000', 'WEB_STATUSLINE=false']);
    assert.equal(a.command, 'set');
    assert.deepEqual(a.assignments, [['PORT', '4000'], ['WEB_STATUSLINE', 'false']]);
  });

  test('值里含 = 时只按首个 = 切分（token 可能含 =）', () => {
    const a = parseConfigArgs(['set', 'NTFY_TOKEN=tk_a=b=c']);
    assert.deepEqual(a.assignments, [['NTFY_TOKEN', 'tk_a=b=c']]);
  });

  test('flags 与位置参数分离', () => {
    const a = parseConfigArgs(['get', 'AUTH_TOKEN', '--json', '--reveal']);
    assert.equal(a.command, 'get');
    assert.deepEqual(a.positionals, ['AUTH_TOKEN']);
    assert.equal(a.flags.json, true);
    assert.equal(a.flags.reveal, true);
  });

  test('无命令时为 undefined（调用方打印用法）', () => {
    assert.equal(parseConfigArgs([]).command, undefined);
  });

  test('未知 flag 被收集而非静默忽略', () => {
    assert.deepEqual(parseConfigArgs(['get', '--revael']).unknownFlags, ['--revael']);
  });
});

// secret 明文绝不默认离开进程 —— 与 buildEnvView 只出 {set,length}、CCMCore.swift 走 pbcopy
// 而不把 token 读进内存是同一条纪律。
test.describe('formatValueForDisplay —— secret 脱敏', () => {
  test('secret 默认只出「设了没 + 多长」', () => {
    const out = formatValueForDisplay('AUTH_TOKEN', 'not-a-real-token', { reveal: false });
    assert.equal(out.includes('not-a-real'), false);
    assert.match(out, /16/);
  });

  test('--reveal 才出明文', () => {
    assert.equal(formatValueForDisplay('AUTH_TOKEN', 'not-a-real-token', { reveal: true }), 'not-a-real-token');
  });

  test('非 secret 直接显示，不受 reveal 影响', () => {
    assert.equal(formatValueForDisplay('PORT', 4000, { reveal: false }), '4000');
  });

  test('未设置的项显示为空而不是 undefined', () => {
    assert.equal(formatValueForDisplay('WORK_DIR', undefined, { reveal: false }), '');
  });
});

test.describe('runConfigCommand —— init', () => {
  test('生成带 schema 版本的文件，权限 0600', () => withTempDir((dir) => {
    const r = runConfigCommand({ command: 'init', positionals: [], flags: {}, assignments: [] }, { dir });
    assert.equal(r.ok, true);
    const cfg = readConfig(dir);
    assert.equal(typeof cfg.$schemaVersion, 'number');
    assert.ok(cfg.AUTH_TOKEN, 'init 必须生成 AUTH_TOKEN —— 不设它 server 只绑 127.0.0.1，手机连不上');
  }));

  test('已存在时拒绝覆盖（里面可能有正在用的 token）', () => withTempDir((dir) => {
    runConfigCommand({ command: 'init', positionals: [], flags: {}, assignments: [] }, { dir });
    const before = readConfig(dir).AUTH_TOKEN;
    const r = runConfigCommand({ command: 'init', positionals: [], flags: {}, assignments: [] }, { dir });
    assert.equal(r.ok, false);
    assert.equal(readConfig(dir).AUTH_TOKEN, before);
  }));
});

test.describe('runConfigCommand —— set / unset', () => {
  const initDir = (dir) => runConfigCommand({ command: 'init', positionals: [], flags: {}, assignments: [] }, { dir });

  test('写入按 schema 类型落盘，不是字符串', () => withTempDir((dir) => {
    initDir(dir);
    const r = runConfigCommand({
      command: 'set', positionals: [], flags: {},
      assignments: [['PORT', '4100'], ['WEB_STATUSLINE', 'false']],
    }, { dir });
    assert.equal(r.ok, true);
    const cfg = readConfig(dir);
    assert.equal(cfg.PORT, 4100);
    assert.equal(cfg.WEB_STATUSLINE, false);
  }));

  // ★ CLI 不是配置文件的特权通道：同一份 validateEnvChanges 挡住面板的东西也要挡住它。
  test('非法值被拒且**一个字都不写** —— 全或无，半生效比不写更糟', () => withTempDir((dir) => {
    initDir(dir);
    const before = readFileSync(join(dir, 'ccm.config.json'), 'utf8');
    const r = runConfigCommand({
      command: 'set', positionals: [], flags: {},
      assignments: [['PORT', '99999'], ['WORK_DIR', '/tmp']],
    }, { dir });
    assert.equal(r.ok, false);
    assert.equal(readFileSync(join(dir, 'ccm.config.json'), 'utf8'), before);
  }));

  test('unset 删除键而不是写空值', () => withTempDir((dir) => {
    initDir(dir);
    runConfigCommand({ command: 'set', positionals: [], flags: {}, assignments: [['PORT', '4100']] }, { dir });
    runConfigCommand({ command: 'unset', positionals: ['PORT'], flags: {}, assignments: [] }, { dir });
    assert.equal(Object.hasOwn(readConfig(dir), 'PORT'), false);
  }));

  test('set 报出哪些项需要重启 —— 用户否则无从知道', () => withTempDir((dir) => {
    initDir(dir);
    const r = runConfigCommand({ command: 'set', positionals: [], flags: {}, assignments: [['PORT', '4100']] }, { dir });
    assert.deepEqual(r.restartRequired, ['PORT']);
  }));

  test('set WORKDIRS 是热加载项，不报需重启', () => withTempDir((dir) => {
    initDir(dir);
    const r = runConfigCommand({
      command: 'set', positionals: [], flags: {},
      assignments: [['WORKDIRS', '["/tmp"]']],
    }, { dir });
    assert.equal(r.ok, true);
    assert.deepEqual(r.restartRequired, []);
  }));
});

test.describe('runConfigCommand —— migrate', () => {
  test('.env → ccm.config.json，类型正确且原文件保留', () => withTempDir((dir) => {
    writeFileSync(join(dir, '.env'), 'AUTH_TOKEN=tok\nPORT=3000\nWEB_STATUSLINE=off\n');
    const r = runConfigCommand({ command: 'migrate', positionals: [], flags: {}, assignments: [] }, { dir });
    assert.equal(r.ok, true);
    const cfg = readConfig(dir);
    assert.equal(cfg.PORT, 3000);
    assert.equal(cfg.WEB_STATUSLINE, false);
    // 原 .env 不删：迁移出错时用户还得靠它回滚，删掉等于把退路一起拿走
    assert.equal(existsSync(join(dir, '.env')), true);
  }));

  test('把外部 workdirs.json 内联进 WORKDIRS', () => withTempDir((dir) => {
    writeFileSync(join(dir, '.env'), 'AUTH_TOKEN=tok\nWORK_DIRS_FILE=workdirs.json\n');
    writeFileSync(join(dir, 'workdirs.json'), JSON.stringify(['/tmp', { path: '/usr', sessionLimit: 3 }]));
    const r = runConfigCommand({ command: 'migrate', positionals: [], flags: {}, assignments: [] }, { dir });
    assert.equal(r.ok, true);
    const cfg = readConfig(dir);
    assert.deepEqual(cfg.WORKDIRS, ['/tmp', { path: '/usr', sessionLimit: 3 }]);
    assert.equal(Object.hasOwn(cfg, 'WORK_DIRS_FILE'), false);
  }));

  test('目标已存在时拒绝 —— 迁移不是覆盖', () => withTempDir((dir) => {
    writeFileSync(join(dir, '.env'), 'AUTH_TOKEN=tok\n');
    writeFileSync(join(dir, 'ccm.config.json'), JSON.stringify({ AUTH_TOKEN: 'existing' }));
    const r = runConfigCommand({ command: 'migrate', positionals: [], flags: {}, assignments: [] }, { dir });
    assert.equal(r.ok, false);
    assert.equal(readConfig(dir).AUTH_TOKEN, 'existing');
  }));

  test('没有 .env 可迁时明确说明，不生成空配置', () => withTempDir((dir) => {
    const r = runConfigCommand({ command: 'migrate', positionals: [], flags: {}, assignments: [] }, { dir });
    assert.equal(r.ok, false);
    assert.equal(existsSync(join(dir, 'ccm.config.json')), false);
  }));
});

test.describe('runConfigCommand —— check', () => {
  test('干净配置报 ok', () => withTempDir((dir) => {
    runConfigCommand({ command: 'init', positionals: [], flags: {}, assignments: [] }, { dir });
    assert.equal(runConfigCommand({ command: 'check', positionals: [], flags: {}, assignments: [] }, { dir }).ok, true);
  }));

  test('坏 JSON 被指出而不是崩掉', () => withTempDir((dir) => {
    writeFileSync(join(dir, 'ccm.config.json'), '{ broken');
    const r = runConfigCommand({ command: 'check', positionals: [], flags: {}, assignments: [] }, { dir });
    assert.equal(r.ok, false);
    assert.ok(r.problems.some(p => /解析|parse/i.test(p)));
  }));

  // ★ check 存在的主要理由：手写文件绕过了写入侧的全部校验。
  test('手写出的非法值被抓出来', () => withTempDir((dir) => {
    writeFileSync(join(dir, 'ccm.config.json'), JSON.stringify({ PORT: 99999, WORKDIRS: '/a,/b' }));
    const r = runConfigCommand({ command: 'check', positionals: [], flags: {}, assignments: [] }, { dir });
    assert.equal(r.ok, false);
    assert.ok(r.problems.length >= 2);
  }));

  test('未知 key 报出来 —— 拼错的 key 是静默失效', () => withTempDir((dir) => {
    writeFileSync(join(dir, 'ccm.config.json'), JSON.stringify({ AUTH_TOEKN: 'typo' }));
    const r = runConfigCommand({ command: 'check', positionals: [], flags: {}, assignments: [] }, { dir });
    assert.ok(r.problems.some(p => p.includes('AUTH_TOEKN')));
  }));

  // .env 时代的两个转义地雷只在旧格式下需要检查（JSON 没有这个失败模式）
  test('旧 .env 里以反斜杠结尾的值被抓出（会吞掉后续配置项）', () => withTempDir((dir) => {
    writeFileSync(join(dir, '.env'), 'WORK_DIR=/Users/you/dir\\\nAUTH_TOKEN=would-be-swallowed\n');
    const r = runConfigCommand({ command: 'check', positionals: [], flags: {}, assignments: [] }, { dir });
    assert.equal(r.ok, false);
    assert.ok(r.problems.some(p => /反斜杠|backslash/.test(p)));
  }));
});

test.describe('runConfigCommand —— schema', () => {
  test('输出带版本号，供 desktop 判断能否解码', () => withTempDir((dir) => {
    const r = runConfigCommand({ command: 'schema', positionals: [], flags: { json: true }, assignments: [] }, { dir });
    assert.equal(r.ok, true);
    assert.equal(typeof r.data.schemaVersion, 'number');
    assert.ok(Array.isArray(r.data.groups));
  }));

  test('schema 输出里不含任何实际值 —— 它是表单描述，不是配置快照', () => withTempDir((dir) => {
    writeFileSync(join(dir, 'ccm.config.json'), JSON.stringify({ AUTH_TOKEN: 'SECRET-VALUE' }));
    const r = runConfigCommand({ command: 'schema', positionals: [], flags: { json: true }, assignments: [] }, { dir });
    assert.equal(JSON.stringify(r.data).includes('SECRET-VALUE'), false);
  }));
});

// ★ schema 不带 --json 时是**活的配置文档**。
//
// .env.example 那 123 行注释是手写的：加一个配置项必须记得同步它，而没有任何门禁查这件事
// （doc-consistency 查死链/npm scripts/版本号/契约计数，没有这一维）。从 ENV_SCHEMA 生成的
// 清单不会有这个问题 —— 加配置项只改一个文件，文档自动跟上。
test('schema 无 --json 时输出人类可读清单，覆盖全部配置项', async () => {
  const { ENV_SCHEMA } = await import('../../src/ops/env-schema.js');
  const r = runConfigCommand({ command: 'schema', positionals: [], flags: {}, assignments: [] }, { dir: '/tmp' });

  assert.ok(r.messages.length > 0, 'schema 必须有人类可读输出，否则用户看到的是空白');
  const text = r.messages.join('\n');
  for (const key of Object.keys(ENV_SCHEMA)) {
    assert.ok(text.includes(key), `配置项 ${key} 未出现在 schema 清单里`);
  }
});

test('schema 清单标出热加载项与只读项', () => {
  const r = runConfigCommand({ command: 'schema', positionals: [], flags: {}, assignments: [] }, { dir: '/tmp' });
  const text = r.messages.join('\n');
  assert.match(text, /WORKDIRS[^\n]*热加载/);
  assert.match(text, /AUTH_TOKEN[^\n]*只读/);
  // WORKDIRS 不能标「只读」—— CLI 能改它，那是给手机面板的渲染提示
  assert.doesNotMatch(text, /WORKDIRS[^\n]*\[只读/);
});
