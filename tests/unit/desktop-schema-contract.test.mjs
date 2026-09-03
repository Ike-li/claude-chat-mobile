// tests/unit/desktop-schema-contract.test.mjs —— Swift 侧与 JS 侧的跨语言契约
//
// desktop app 消费 `node scripts/config.js schema --json` 的输出，两边各有一个版本号常量。
// 它们必须同步，而**跨语言的东西没有编译器帮忙**：改了 JS 侧的 CONFIG_SCHEMA_VERSION 忘了
// 改 Swift，症状是 app 静默显示「配置格式不兼容」——一个只在真机上才看得见的失败。
//
// 先例：scripts/service.js 的 STATUS_SCHEMA_VERSION 与 CCMCore.swift 的 UnitStatus 也是这种
// 关系，至今靠约定维持。这条断言是把那类约定机械化的第一步。
import test from 'node:test';
import assert from 'node:assert/strict';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { CONFIG_SCHEMA_VERSION } from '../../app/src/ops/config-file.js';

const readSwift = (name) => readFileSync(new URL(`../../desktop/${name}`, import.meta.url), 'utf8');
const ROOT = join(import.meta.dirname, '..', '..');

test('Swift 的 SUPPORTED_CONFIG_SCHEMA_VERSION 与 JS 的 CONFIG_SCHEMA_VERSION 一致', () => {
  const src = readSwift('CCMCore.swift');
  const m = /let\s+SUPPORTED_CONFIG_SCHEMA_VERSION\s*=\s*(\d+)/.exec(src);
  assert.ok(m, 'CCMCore.swift 里找不到 SUPPORTED_CONFIG_SCHEMA_VERSION —— 改名了就同步改这条断言');
  assert.equal(
    Number(m[1]),
    CONFIG_SCHEMA_VERSION,
    `Swift 侧声明 ${m[1]}，JS 侧是 ${CONFIG_SCHEMA_VERSION}。改了一边必须改另一边，`
    + '否则 desktop app 会静默显示「配置格式不兼容」——只在真机上才看得见。',
  );
});

// ★ Swift 侧的字段名是硬编码的（Decodable 靠属性名匹配 JSON key）。JS 侧改个 key 名，
// Swift 那边不会报错，只会**静默解码成 nil** —— 整列控件消失而没有任何提示。
// 这条断言把「schema 输出里有哪些字段」钉住：真要改，两边一起改。
test('schema 输出的字段名与 Swift 的 Decodable 属性对齐', async () => {
  const { buildEnvView } = await import('../../app/src/ops/env-schema.js');
  const view = buildEnvView({ PORT: '3000', AUTH_TOKEN: 'x' });
  const src = readSwift('CCMCore.swift');

  // 取一个有代表性的 item（含 value 的普通项 + 含 masked 的 secret 项）
  const allItems = view.groups.flatMap(g => g.items);
  const fields = new Set(allItems.flatMap(i => Object.keys(i)));

  // Swift 的 ConfigItem 声明了哪些属性
  const block = /struct ConfigItem: Decodable \{([\s\S]*?)\n\}/.exec(src);
  assert.ok(block, '找不到 ConfigItem 结构体');
  // 正则要认反引号：Swift 关键字属性写作 `default`，漏了这一支会把已声明的字段误报成缺失。
  const declared = new Set([...block[1].matchAll(/^\s*let\s+`?(\w+)`?\s*:/gm)].map(m => m[1]));

  const missing = [...fields].filter(f => !declared.has(f));
  assert.deepEqual(
    missing,
    [],
    `这些字段 schema 会下发但 Swift 没声明，会被静默丢弃：${missing.join(', ')}`,
  );
});

test('分组字段对齐（groups 的 id/label/items）', () => {
  const src = readSwift('CCMCore.swift');
  const block = /struct ConfigGroup: Decodable \{([\s\S]*?)\n\}/.exec(src);
  assert.ok(block, '找不到 ConfigGroup 结构体');
  const declared = new Set([...block[1].matchAll(/^\s*let\s+`?(\w+)`?\s*:/gm)].map(m => m[1]));
  for (const key of ['id', 'label', 'items']) {
    assert.ok(declared.has(key), `ConfigGroup 缺字段 ${key}`);
  }
});

// ★★ 名字对上了，类型也得对上。
//
// 缺陷实录（子代理变异验证）：把 `let min: Int?` 改成 `String?`，上面两条断言全绿 ——
// 而 JSONDecoder 对 typeMismatch 是**整份 abort**（不是"这一个字段变 nil"），
// 配合 ccm-config-window.swift 的 `try?` 就是配置窗口整个变成「config.js 输出无法解析」。
//
// CCMCore.swift 头注那句「除 schemaVersion 外全部可选…宁可少渲染一行」对**缺失/null** 成立，
// 对**类型变化**不成立。所以 JS 侧任何一个 min/max/default/unit 的类型调整都会炸窗口。
test('schema 下发值的类型与 Swift 声明的类型一致', async () => {
  const { buildEnvView } = await import('../../app/src/ops/env-schema.js');
  const src = readSwift('CCMCore.swift');

  // Swift 类型 → 期望的 JS typeof。复合类型统一按 object 比。
  const EXPECT = {
    String: 'string', Int: 'number', Bool: 'boolean',
    LocalizedText: 'object', MaskedSecret: 'object', ToggleLiterals: 'object',
  };

  const block = /struct ConfigItem: Decodable \{([\s\S]*?)\n\}/.exec(src);
  const declared = new Map(
    [...block[1].matchAll(/^\s*let\s+`?(\w+)`?\s*:\s*(\w+)\??/gm)].map(m => [m[1], m[2]]),
  );

  // 用一份**含值**的视图：只有真下发了才比得了类型
  const items = buildEnvView({ PORT: '3000', AUTH_TOKEN: 'x', WEB_STATUSLINE: 'off' })
    .groups.flatMap(g => g.items);

  const bad = [];
  for (const item of items) {
    for (const [key, value] of Object.entries(item)) {
      // undefined / null 不进 JSON（JSON.stringify 直接丢弃这个键），Swift 那边解成 nil ——
      // 而全部字段都是可选类型，这正是设计好的。只有**真下发了但类型不对**才会 abort 解码。
      if (value === undefined || value === null) continue;
      const swiftType = declared.get(key);
      if (!swiftType) continue;            // 漏字段由上一条断言负责
      const want = EXPECT[swiftType];
      if (!want) continue;                 // 没见过的 Swift 类型，不猜
      const got = Array.isArray(value) ? 'array' : typeof value;
      if (got !== want) bad.push(`${item.key}.${key}: Swift 声明 ${swiftType}(→${want}) 但下发 ${got}`);
    }
  }
  assert.deepEqual(bad, [], `类型不匹配会让 JSONDecoder 整份 abort、配置窗口空白：\n${bad.join('\n')}`);
});

// ★ 顶层 wire key 也要钉住。
//
// 上面第一条比的是**两个常量的值**，从不看 cmdSchema 实际输出的键名。实测把输出里的
// `schemaVersion` 改名后：Swift 解出 nil → isCompatible=false → 窗口显示「配置格式不兼容」，
// 而两条断言仍全绿 —— 正是那条断言开头声称要防的症状。
test('config schema 的输出里确实有 schemaVersion 这个键', async () => {
  const { runConfigCommand } = await import('../../scripts/config.js');
  const r = runConfigCommand(
    { command: 'schema', positionals: [], flags: {}, assignments: [] },
    { dir: '/tmp' },
  );
  assert.equal(r.ok, true);
  assert.ok(
    Object.hasOwn(r.data, 'schemaVersion'),
    'Swift 的 ConfigSchema 按这个键名解码；改名会让窗口显示「配置格式不兼容」而门禁无感',
  );
  assert.equal(typeof r.data.schemaVersion, 'number');
});

// ══════════════════════════════════════════════════════════════════════════
// service.js / device.js 的输出 ⇔ Swift Decodable
//
// 上面那几条守的是 `config.js schema`。而 `service.js status --json` 与
// `device.js list --json` 这两条通道**至今靠约定维持** —— 本文件开头第 7-8 行就写着这句。
// 补上它的理由是一个具体的失败：`setup.envExists` 一旦改名，Swift 静默解成 nil，
// `nil == false` 判为 false，于是「首次安装向导」的三个入口（自动弹窗、菜单项、控制台按钮）
// **同时消失**，没有编译错、没有测试红、没有日志——只有真机上点不到才发现。
//
// 断言方向只有一边：**Swift 声明的每个存储属性都必须出现在 JS 输出里**。
// 反向不强制 —— JS 多下发字段是安全的（Swift 忽略），少给一个才是静默失败。
// ══════════════════════════════════════════════════════════════════════════

// 只取存储属性。Swift 里存储属性写 `let x: T`，计算属性写 `var x: T { ... }`——
// 后者不参与解码，混进来就是必然误报（UnitStatus 有 8 个计算属性，比存储属性还多）。
// 反引号那一支沿用上面 ConfigItem 的先例（Swift 关键字属性写作 `default`）。
function storedProperties(src, structName) {
  const block = new RegExp(`struct ${structName}: Decodable \\{([\\s\\S]*?)\\n\\}`).exec(src);
  assert.ok(block, `找不到 struct ${structName}: Decodable —— 改名了就同步改这里`);
  return new Map(
    [...block[1].matchAll(/^\s*let\s+`?(\w+)`?\s*:\s*\[?(\w+)/gm)].map(m => [m[1], m[2]]),
  );
}

// ★ 抽取器自己必须正反两面都测：它一旦漏抽，下面所有契约断言会一起变成**假绿**。
test.describe('storedProperties 抽取器', () => {
  const FAKE = [
    'struct Sample: Decodable {',
    '    let kept: String?',
    '    let `default`: String?',
    '    let nested: [Inner]?',
    '    var computed: String { kept ?? "" }',
    '    var alsoComputed: Bool {',
    '        kept != nil',
    '    }',
    '}',
  ].join('\n');

  test('抽到存储属性，含反引号与数组元素类型', () => {
    const got = storedProperties(FAKE, 'Sample');
    assert.deepEqual([...got.keys()], ['kept', 'default', 'nested']);
    assert.equal(got.get('nested'), 'Inner');
  });

  test('计算属性一个都不能抽进来（抽进来就是必然误报）', () => {
    const got = storedProperties(FAKE, 'Sample');
    assert.ok(!got.has('computed'));
    assert.ok(!got.has('alsoComputed'));
  });
});

// ── service.js status --json ───────────────────────────────────────────────
const HOME = '/Users/you';
const REPO_PATH = '/Users/you/code/claude-chat-mobile';
const NODE_PATH = '/opt/homebrew/bin/node';

// 最小夹具，但必须把 ScheduleInfo 的三种形态都造出来，否则 everySeconds / calendar
// 这两个字段根本不下发，断言就变成空过：
//   server        → resident（KeepAlive）
//   logrotate     → periodic + StartCalendarInterval  ⇒ calendar
//   tunnel-watch  → periodic + StartInterval          ⇒ everySeconds
const PLISTS = {
  [`${HOME}/Library/LaunchAgents/com.ccm.server.plist`]: {
    Label: 'com.ccm.server',
    ProgramArguments: ['/bin/zsh', '-lc', `cd ${REPO_PATH} && exec ${NODE_PATH} app/server.js`],
    RunAtLoad: true,
    KeepAlive: true,
    StandardOutPath: `${HOME}/Library/Logs/ccm-server.log`,
    StandardErrorPath: `${HOME}/Library/Logs/ccm-server.log`,
  },
  [`${HOME}/Library/LaunchAgents/com.ccm.logrotate.plist`]: {
    Label: 'com.ccm.logrotate',
    ProgramArguments: ['/bin/bash', `${REPO_PATH}/scripts/rotate-logs.sh`],
    RunAtLoad: false,
    StartCalendarInterval: { Hour: 3, Minute: 47 },
    StandardOutPath: `${HOME}/Library/Logs/ccm-logrotate.log`,
    StandardErrorPath: `${HOME}/Library/Logs/ccm-logrotate.log`,
  },
  [`${HOME}/Library/LaunchAgents/com.ccm.tunnel-watch.plist`]: {
    Label: 'com.ccm.tunnel-watch',
    ProgramArguments: ['/bin/bash', `${HOME}/.cloudflared/ccm-tunnel-bindwatch.sh`],
    RunAtLoad: true,
    StartInterval: 30,
    StandardOutPath: `${HOME}/Library/Logs/ccm-tunnel-watch.log`,
    StandardErrorPath: `${HOME}/Library/Logs/ccm-tunnel-watch.log`,
  },
};

async function realStatus() {
  const { createServiceManager } = await import('../../scripts/service.js');
  const mgr = createServiceManager({
    platform: 'darwin',
    home: HOME,
    repo: REPO_PATH,
    node: NODE_PATH,
    now: () => 1786000000000,
    execLaunchctl: () => ({
      status: 0,
      stdout: ['PID\tStatus\tLabel', '26867\t0\tcom.ccm.server', '-\t0\tcom.ccm.logrotate', '-\t0\tcom.ccm.tunnel-watch'].join('\n'),
      stderr: '',
    }),
    readPlistFile: (path) => PLISTS[path] ?? null,
    fileExists: (path) => Object.hasOwn(PLISTS, path),
    readEnv: () => ({ PORT: '3000', AUTH_TOKEN: 'x'.repeat(64) }),
    envFileExists: () => true,
    tcpProbe: () => true,
    portListenerPid: () => 26867,
    lanIp: () => '192.168.1.9',
    readEvents: () => [],
  });
  // ★ 必须走非 fast：--fast 不做 tcpProbe，listen 恒为 null（service.js 的 status 里
  //   `unit === 'server' && !fast` 那一支），ListenInfo 的两个字段就永远校验不到。
  return mgr.status({ fast: false });
}

test.describe('service.js status --json ⇔ Swift Decodable', () => {
  const assertCovered = (structName, emittedKeys, hint) => {
    const src = readSwift('CCMCore.swift');
    const declared = [...storedProperties(src, structName).keys()];
    const missing = declared.filter(k => !emittedKeys.has(k));
    assert.deepEqual(missing, [],
      `Swift 的 ${structName} 声明了这些字段但 JS 没下发：${missing.join(', ')}。`
      + `会被静默解成 nil —— ${hint}`);
  };

  test('ServiceStatus 顶层字段全部下发', async () => {
    const s = await realStatus();
    assertCovered('ServiceStatus', new Set(Object.keys(s)),
      '菜单首行摘要、图标、unit 列表都从这里来，缺一个就整段不显示');
  });

  test('SetupInfo 字段全部下发', async () => {
    const s = await realStatus();
    assertCovered('SetupInfo', new Set(Object.keys(s.setup ?? {})),
      'envExists 决定「首次安装向导」的三个入口是否出现，改名会让它们同时消失');
  });

  test('UnitStatus 字段全部下发', async () => {
    const s = await realStatus();
    const keys = new Set(s.units.flatMap(u => Object.keys(u)));
    assertCovered('UnitStatus', keys, '每个 unit 一行的灯、状态词、归属标注全靠它');
  });

  test('ListenInfo 字段全部下发（只有 server 且非 fast 时才有）', async () => {
    const s = await realStatus();
    const listen = s.units.find(u => u.unit === 'server')?.listen;
    assert.ok(listen, '夹具没造出 listen —— 检查 tcpProbe / fast 参数，否则这条断言是空过的');
    assertCovered('ListenInfo', new Set(Object.keys(listen)),
      '端口冲突判定（「:3000 被其它进程占用」）唯一的输入');
  });

  test('ScheduleInfo 三种形态的字段全部下发', async () => {
    const s = await realStatus();
    const keys = new Set(s.units.flatMap(u => Object.keys(u.schedule ?? {})));
    // 夹具没造全就等于空过，先自检
    for (const k of ['kind', 'calendar', 'everySeconds']) {
      assert.ok(keys.has(k), `夹具没造出 schedule.${k}，这条断言会变成空过`);
    }
    assertCovered('ScheduleInfo', keys,
      'stopped 是故障还是健康待机全看它 —— 缺了会把定时任务误报成崩溃');
  });
});

// ── device.js list --json ──────────────────────────────────────────────────
test.describe('device.js list --json ⇔ Swift Decodable', () => {
  test('DeviceSnapshot 与 PendingDevice 字段全部下发', async (t) => {
    const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
    const { spawnSync } = await import('node:child_process');
    const { tmpdir } = await import('node:os');

    const dataDir = await mkdtemp(join(tmpdir(), 'ccm-desktop-contract-'));
    t.after(() => rm(dataDir, { recursive: true, force: true }));
    // 必须放一台 pending，否则 pending[] 为空，PendingDevice 的字段一个都校验不到
    await writeFile(join(dataDir, 'pending-devices.json'), JSON.stringify(
      [{ deviceToken: 'tok-1', ip: '192.168.1.5', userAgent: 'iPhone', ts: 1700000000000 }],
    ));
    await writeFile(join(dataDir, 'trusted-devices.json'), JSON.stringify(['tok-trusted']));

    // 剥掉 preload-env 的文件级重定向：在 devices.js 里它们优先于 CCM_DATA_DIR，
    // 不剥的话 CLI 会去读那份共享文件而不是本用例的夹具（同 device-cli.test.mjs 的做法）。
    const { CCM_TRUSTED_DEVICES_FILE: _t, CCM_PENDING_DEVICES_FILE: _p, ...env } = process.env;
    const r = spawnSync(process.execPath, ['scripts/device.js', 'list', '--json'], {
      cwd: ROOT, env: { ...env, CCM_DATA_DIR: dataDir }, encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.ok(out.pending?.length, '夹具没造出 pending 设备，PendingDevice 断言会空过');

    const src = readSwift('CCMCore.swift');
    for (const [structName, emitted, hint] of [
      ['DeviceSnapshot', new Set(Object.keys(out)), '待审设备整段从菜单里消失'],
      ['PendingDevice', new Set(out.pending.flatMap(d => Object.keys(d))), '菜单里那行只剩「未知设备」，核对不了 ID'],
    ]) {
      const declared = [...storedProperties(src, structName).keys()];
      const missing = declared.filter(k => !emitted.has(k));
      assert.deepEqual(missing, [],
        `Swift 的 ${structName} 声明了这些字段但 device.js 没下发：${missing.join(', ')} —— ${hint}`);
    }
  });
});

// ── 心跳通道的三个字面量 ───────────────────────────────────────────────────
// doctor 的 D19 用 `defaults read <bundleId> <key>` 读菜单栏写下的心跳。这条通道上
// **三个字面量分散在三个文件里**（Swift 常量 / Info.plist 模板 / doctor.js），任何一个
// 改了另两个都不会报错 —— 症状是 doctor 恒说「读不到心跳，多半是旧版」，
// 而那正是「一切正常」与「app 卡死了」都会走到的那条分支，等于这道检查静默失效。
test.describe('菜单栏心跳的跨文件字面量', () => {
  const doctorSrc = () => readFileSync(join(ROOT, 'scripts', 'doctor.js'), 'utf8');

  test('bundle id：doctor.js 与 Info.plist.template 一致', () => {
    const tpl = readFileSync(join(ROOT, 'desktop', 'Info.plist.template'), 'utf8');
    const fromTpl = /<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/.exec(tpl);
    assert.ok(fromTpl, 'Info.plist.template 里找不到 CFBundleIdentifier');
    const fromDoctor = /MENUBAR_BUNDLE_ID\s*=\s*'([^']+)'/.exec(doctorSrc());
    assert.ok(fromDoctor, 'doctor.js 里找不到 MENUBAR_BUNDLE_ID');
    assert.equal(fromDoctor[1], fromTpl[1],
      'bundle id 对不上，defaults read 会读一个不存在的域，D19 从此恒判「没有心跳」');
  });

  test('心跳键名：Swift 常量与 doctor.js 读的键一致', () => {
    const swift = readSwift('CCMCore.swift');
    const doctor = doctorSrc();
    for (const constName of ['HEARTBEAT_AT_KEY', 'HEARTBEAT_OK_KEY']) {
      const m = new RegExp(`let ${constName}\\s*=\\s*"([^"]+)"`).exec(swift);
      assert.ok(m, `CCMCore.swift 里找不到 ${constName}`);
      assert.ok(doctor.includes(`'${m[1]}'`),
        `doctor.js 没有读 ${m[1]} 这个键 —— 心跳写了但没人读，D19 会恒判「没有心跳」`);
    }
  });
});
