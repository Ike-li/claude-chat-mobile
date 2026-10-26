// tests/unit/socket-folders.test.mjs —— folders:reorder（抽屉文件夹长按拖动排序）handler 自己的设备闸。
// 统一注册器 on() 只拦 deviceApproved === false；顺序是所有设备共享的，handler 里再收紧成「必须是 true」。
// 真 server 的接入路径只会赋 true / false，undefined 那一支造不出来，所以在这一层用假 socket 测；
// 其余（精确成员、广播、持久化）在 S2 tests/invariants/server/folder-order.test.mjs。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSocketEventRegistrar } from '../../app/src/server/socket.js';
import { registerFolderSocketHandlers } from '../../app/src/server/socket-folders.js';

function setup(deviceApproved) {
  const handlers = new Map();
  const socket = { deviceApproved, handshake: { auth: {} }, on: (e, h) => handlers.set(e, h), emit() {} };
  const calls = [];
  registerFolderSocketHandlers({
    socket,
    on: createSocketEventRegistrar({ logger: { warn() {}, error() {} } }),
    folderContext: () => ({}),
    addConnectedFolder: () => ({ ok: true }),
    removeConnectedFolder: () => ({ ok: true }),
    reorderConnectedFolders: roots => { calls.push(roots); return { ok: true }; },
    audit: { recordAudit() {} },
    actorFromSocket: () => ({}),
  });
  const reorder = payload => new Promise(resolve => handlers.get('folders:reorder')(payload, resolve));
  return { reorder, calls, handlers };
}

test('folders:reorder：deviceApproved 为 false 或 undefined 都拒绝，排序函数一次都不调', async () => {
  for (const approved of [false, undefined]) {
    const { reorder, calls } = setup(approved);
    const res = await reorder({ roots: ['/r/B', '/r/A'] });
    assert.equal(res.ok, false, `deviceApproved=${approved} 竟然放行了`);
    assert.equal(res.error, 'device_not_approved');
    assert.deepEqual(calls, []);
  }
});

test('folders:reorder：受信任设备才调排序，roots 原样交下去；置顶事件已不再注册', async () => {
  const { reorder, calls, handlers } = setup(true);
  assert.deepEqual(await reorder({ roots: ['/r/B', '/r/A'] }), { ok: true });
  assert.deepEqual(calls, [['/r/B', '/r/A']]);
  assert.equal(handlers.has('folders:pin'), false);
});
