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
