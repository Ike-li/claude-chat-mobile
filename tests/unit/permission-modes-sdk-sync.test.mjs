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
