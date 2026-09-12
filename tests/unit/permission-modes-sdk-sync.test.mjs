// 权限档清单必须与 Agent SDK PermissionMode 枚举同源；前端/后端各自持有一份 id 列表，
// 靠本测锁住集合一致，避免 UI 写死或后端白名单漂移成「显示了 SDK 不认的档 / 漏了 SDK 新档」。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { CCM_PERMISSION_MODES } from '../../app/src/agent/cli-settings-defaults.js';
import {
  SDK_PERMISSION_MODES,
  permissionModeTileSpecs,
  isSdkPermissionMode,
  describePersistScope,
} from '../../app/public/js/logic.js';

function readSdkPermissionModes() {
  const dts = readFileSync(
    join(process.cwd(), 'node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts'),
    'utf8',
  );
  const m = dts.match(/export declare type PermissionMode = ([^;]+);/);
  assert.ok(m, 'sdk.d.ts 应声明 export declare type PermissionMode');
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

test('CCM_PERMISSION_MODES 与 SDK PermissionMode 集合一致', () => {
  const sdk = readSdkPermissionModes();
  assert.deepEqual(new Set(CCM_PERMISSION_MODES), new Set(sdk));
});

test('前端 SDK_PERMISSION_MODES 与 SDK PermissionMode 集合一致', () => {
  const sdk = readSdkPermissionModes();
  assert.deepEqual(new Set(SDK_PERMISSION_MODES), new Set(sdk));
});

test('前后端权限档 id 列表集合一致', () => {
  assert.deepEqual(new Set(CCM_PERMISSION_MODES), new Set(SDK_PERMISSION_MODES));
});

test('permissionModeTileSpecs：按 SDK 清单出磁贴，bypass 置底且标 danger', () => {
  const tiles = permissionModeTileSpecs();
  assert.equal(tiles.length, SDK_PERMISSION_MODES.length);
  assert.deepEqual(tiles.map((t) => t.id), [...SDK_PERMISSION_MODES]);
  const bypass = tiles.find((t) => t.id === 'bypassPermissions');
  assert.ok(bypass);
  assert.equal(bypass.danger, true);
  assert.ok(tiles.every((t) => t.title && t.desc));
  // bypass 必须在最后（危险档视觉/触达靠后）
  assert.equal(tiles.at(-1).id, 'bypassPermissions');
});

test('权限档文案是 CLI/桌面英文原名，不走中文 i18n', () => {
  const byId = Object.fromEntries(permissionModeTileSpecs().map((t) => [t.id, t]));
  assert.equal(byId.default.title, 'Manual'); // CLI 菜单 Manual；协议值仍是 default
  assert.equal(byId.default.pill, 'Manual');
  assert.equal(byId.plan.title, 'Plan');
  assert.equal(byId.acceptEdits.title, 'Accept edits');
  assert.equal(byId.dontAsk.title, "Don't ask");
  assert.equal(byId.auto.title, 'Auto');
  assert.equal(byId.bypassPermissions.title, 'Bypass permissions');
  // 不得出现中文本地化档名
  for (const t of permissionModeTileSpecs()) {
    assert.equal(/[\u4e00-\u9fff]/.test(t.title), false, `title 含中文: ${t.title}`);
    assert.equal(/[\u4e00-\u9fff]/.test(t.pill), false, `pill 含中文: ${t.pill}`);
  }
});

test('isSdkPermissionMode：manual 不是协议值；default/auto 合法', () => {
  assert.equal(isSdkPermissionMode('default'), true);
  assert.equal(isSdkPermissionMode('auto'), true);
  assert.equal(isSdkPermissionMode('manual'), false); // 别名由 normalizePermissionMode 处理
  assert.equal(isSdkPermissionMode('nope'), false);
});

// ── 「永久不再问」的影响面文案（1b，2026-09-11）──────────────────────────
//
// CLI 的 suggestions 自带 destination（实测样本是 localSettings）。用户点「永久」之前，
// 必须知道这条规则会落到哪一层——「只这个工作区」和「所有项目」是完全不同的授权。
//
// ★ 失败方向：**绝不能把影响面说小了**。一批规则里只要有一条是 userSettings，
//   整句话就得按 userSettings 说；说成「本工作区」会让用户以为影响范围比实际小得多，
//   从而批准一个他本不会批准的授权。反过来说大了只是啰嗦，不会造成越权。

test('影响面文案：单一 localSettings → 本工作区', () => {
  const v = describePersistScope(['localSettings']);
  assert.match(v.label, /本工作区/);
});

test('影响面文案：userSettings → 所有项目', () => {
  const v = describePersistScope(['userSettings']);
  assert.match(v.label, /所有项目/);
});

test('影响面文案：projectSettings 点明会进 git（团队共享，与只影响自己不同）', () => {
  const v = describePersistScope(['projectSettings']);
  assert.match(v.label, /本项目/);
  assert.match(v.hint, /git/i);
});

// ★ 核心：混合档按**最宽**的说。
test('影响面文案：混合档取最宽的那个（不得把 userSettings 说成本工作区）', () => {
  const v = describePersistScope(['localSettings', 'userSettings']);
  assert.match(v.label, /所有项目/);
  assert.doesNotMatch(v.label, /本工作区/);

  const v2 = describePersistScope(['localSettings', 'projectSettings']);
  assert.match(v2.label, /本项目/);
});

test('影响面文案：没有可落盘的档（只有 session 或空）→ null，调用方据此不给「永久」选项', () => {
  assert.equal(describePersistScope([]), null);
  assert.equal(describePersistScope(['session']), null);
  assert.equal(describePersistScope(undefined), null);
});

// 不认识的 destination 不能当成「不落盘」——SDK 未来加一档，默认必须落在「说不准，按最宽说」
// 一侧，而不是悄悄把它当成 session 从而连选项都不给（那会让用户以为没有永久这回事）。
test('影响面文案：不认识的 destination 按最宽处理，不得静默当成 session', () => {
  const v = describePersistScope(['someFutureScope']);
  assert.notEqual(v, null);
  assert.match(v.label, /所有项目/);
});
