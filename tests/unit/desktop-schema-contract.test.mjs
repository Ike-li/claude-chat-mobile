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

import { CONFIG_SCHEMA_VERSION } from '../../src/ops/config-file.js';

const readSwift = (name) => readFileSync(new URL(`../../desktop/${name}`, import.meta.url), 'utf8');

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
  const { buildEnvView } = await import('../../src/ops/env-schema.js');
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
  const { buildEnvView } = await import('../../src/ops/env-schema.js');
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
