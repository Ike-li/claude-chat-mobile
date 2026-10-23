// tests/unit/socket-folders.test.mjs —— folders:pin（#305）handler 自己的设备闸。
// 统一注册器 on() 只拦 deviceApproved === false；置顶改的是所有设备共享的顺序，handler 里再收紧成「必须是 true」。
// 真 server 的接入路径只会赋 true / false，undefined 那一支造不出来，所以在这一层用假 socket 测；
// 其余（精确成员、广播、持久化）在 S2 tests/invariants/server/folder-pin.test.mjs。
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
    pinConnectedFolder: (root, pinned) => { calls.push([root, pinned]); return { ok: true }; },
    audit: { recordAudit() {} },
    actorFromSocket: () => ({}),
  });
  const pin = payload => new Promise(resolve => handlers.get('folders:pin')(payload, resolve));
  return { pin, calls };
}

test('folders:pin：deviceApproved 为 false 或 undefined 都拒绝，置顶函数一次都不调', async () => {
  for (const approved of [false, undefined]) {
    const { pin, calls } = setup(approved);
    const res = await pin({ root: '/r/A', pinned: true });
    assert.equal(res.ok, false, `deviceApproved=${approved} 竟然放行了`);
    assert.equal(res.error, 'device_not_approved');
    assert.deepEqual(calls, []);
  }
});

test('folders:pin：受信任设备才调置顶，root 与 pinned 原样交下去', async () => {
  const { pin, calls } = setup(true);
  assert.deepEqual(await pin({ root: '/r/A', pinned: true }), { ok: true });
  assert.deepEqual(await pin({ root: '/r/A', pinned: false }), { ok: true });
  assert.deepEqual(calls, [['/r/A', true], ['/r/A', false]]);
});
