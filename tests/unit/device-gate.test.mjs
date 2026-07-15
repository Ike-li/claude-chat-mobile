import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDeviceGate } from '../../src/auth/device-gate.js';

function tempDataDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ccm-device-gate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// 极简 io 假件：只提供 sockets.sockets Map（与 socket.io 实例同形）
function fakeIo(...sockets) {
  return { sockets: { sockets: new Map(sockets.map((s, i) => [`sid-${i}`, s])) } };
}
function fakeSocket({ deviceToken, approved = false, trustBasis = null } = {}) {
  const s = {
    handshake: { auth: { deviceToken } },
    deviceApproved: approved,
    trustBasis,
    emitted: [],
    disconnected: null,
    emit(ev, payload) { s.emitted.push({ ev, payload }); },
    disconnect(force) { s.disconnected = force; },
  };
  return s;
}

test('初始化：确保 trusted/pending 设备文件存在（owner-only）', t => {
  const dir = tempDataDir(t);
  createDeviceGate({ io: fakeIo(), dataDir: dir, onUnlockSocket: () => {} });
  assert.ok(existsSync(join(dir, 'trusted-devices.json')));
  assert.ok(existsSync(join(dir, 'pending-devices.json')));
});

test('unlockDeviceSockets：只对匹配 deviceToken 的 socket 调 onUnlockSocket', t => {
  const dir = tempDataDir(t);
  const a = fakeSocket({ deviceToken: 'tok-a' });
  const b = fakeSocket({ deviceToken: 'tok-b' });
  const unlocked = [];
  const gate = createDeviceGate({ io: fakeIo(a, b), dataDir: dir, onUnlockSocket: s => unlocked.push(s) });
  gate.unlockDeviceSockets('tok-a');
  assert.deepEqual(unlocked, [a]);
});

test('disconnectDeviceSockets：发 device_status denied 并强断', t => {
  const dir = tempDataDir(t);
  const a = fakeSocket({ deviceToken: 'tok-a' });
  const gate = createDeviceGate({ io: fakeIo(a), dataDir: dir, onUnlockSocket: () => {} });
  gate.disconnectDeviceSockets('tok-a');
  assert.equal(a.emitted.length, 1);
  assert.equal(a.emitted[0].payload.type, 'device_status');
  assert.equal(a.emitted[0].payload.payload.status, 'denied');
  assert.equal(a.disconnected, true);
});

test('pendingDevicesPayload：deviceToken 映射为 deviceId 幂等载体', t => {
  const dir = tempDataDir(t);
  const gate = createDeviceGate({
    io: fakeIo(), dataDir: dir, onUnlockSocket: () => {},
    listPendingDevices: () => [{ deviceToken: 'tok-x', ip: '1.2.3.4', userAgent: 'ua', ts: 42 }],
  });
  assert.deepEqual(gate.pendingDevicesPayload(), {
    devices: [{ deviceId: 'tok-x', ip: '1.2.3.4', userAgent: 'ua', ts: 42 }],
  });
});

test('broadcastPendingDevices：只推给 deviceApproved===true 的可信端', t => {
  const dir = tempDataDir(t);
  const trusted = fakeSocket({ deviceToken: 't1', approved: true });
  const waiting = fakeSocket({ deviceToken: 't2', approved: false });
  const gate = createDeviceGate({
    io: fakeIo(trusted, waiting), dataDir: dir, onUnlockSocket: () => {},
    listPendingDevices: () => [],
  });
  gate.broadcastPendingDevices();
  assert.equal(trusted.emitted.length, 1);
  assert.equal(trusted.emitted[0].payload.type, 'pending_devices');
  assert.equal(waiting.emitted.length, 0);
});
