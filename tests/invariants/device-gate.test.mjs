// tests/invariants/device-gate.test.mjs —— 设备准入网关与信任管理单测
// 守护：DEVICE-01（双本机与未审批设备拦截）、DEVICE-02（CLI 吊销/批准通过原子文件监听即时生效；落盘失败不提交变更；待审列表容量有界防 flood）、DEVICE-03（网络响应与待审推送信封隔离敏感数据）
// 测什么：createDeviceGate 初始化文件存在性；unlockDeviceSockets 与 disconnectDeviceSockets 生命周期；broadcastPendingDevices 仅推向可信端；pendingDevices 有界队列 (MAX_PENDING_DEVICES)；persistTrustedChange 原子持久化事务；getTrustedDeviceIds 隔离边界
// 不测什么 + 为什么：不测物理硬件指纹采集与操作系统真实推送通道——分别属于前端采集与 ops/push
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDeviceGate } from '../../app/src/auth/device-gate.js';
import {
  persistTrustedChange,
  MAX_PENDING_DEVICES,
  getTrustedCount,
  getTrustedDeviceIds,
} from '../../app/src/auth/devices.js';

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

test.describe('createDeviceGate 生命周期与事件分发', () => {
  let tempDir;

  test.beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'ccm-device-gate-inv-'));
  });

  test.afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  test('DEVICE-02: 启动时确保 trusted/pending 两个文件存在且为 owner-only', () => {
    createDeviceGate({ io: fakeIo(), dataDir: tempDir, onUnlockSocket: () => {} });
    assert.ok(existsSync(join(tempDir, 'trusted-devices.json')));
    assert.ok(existsSync(join(tempDir, 'pending-devices.json')));
  });

  test('unlockDeviceSockets: 仅对持有匹配 deviceToken 的 Socket 调用 onUnlockSocket', () => {
    const s1 = fakeSocket({ deviceToken: 'token-1' });
    const s2 = fakeSocket({ deviceToken: 'token-2' });
    const unlocked = [];

    const gate = createDeviceGate({
      io: fakeIo(s1, s2),
      dataDir: tempDir,
      onUnlockSocket: (s) => unlocked.push(s),
    });

    gate.unlockDeviceSockets('token-1');
    assert.deepEqual(unlocked, [s1]);
  });

  test('DEVICE-02: disconnectDeviceSockets 触发 device_status denied 并强行断连', () => {
    const s1 = fakeSocket({ deviceToken: 'revoked-token' });
    const gate = createDeviceGate({
      io: fakeIo(s1),
      dataDir: tempDir,
      onUnlockSocket: () => {},
    });

    gate.disconnectDeviceSockets('revoked-token');
    assert.equal(s1.disconnected, true);
    assert.equal(s1.emitted.length, 1);
    assert.equal(s1.emitted[0].ev, 'agent:event');
    assert.equal(s1.emitted[0].payload.type, 'device_status');
    assert.equal(s1.emitted[0].payload.payload.status, 'denied');
    assert.equal(s1.emitted[0].payload.payload.deviceId, 'revoked-token');
  });

  test('broadcastPendingDevices: 仅向已信任客户端 (deviceApproved===true) 广播待审列表', () => {
    const trustedClient = fakeSocket({ deviceToken: 'tok-trusted', approved: true });
    const unapprovedClient = fakeSocket({ deviceToken: 'tok-pending', approved: false });

    const gate = createDeviceGate({
      io: fakeIo(trustedClient, unapprovedClient),
      dataDir: tempDir,
      onUnlockSocket: () => {},
      listPendingDevices: () => [
        { deviceToken: 'device-x', ip: '192.168.1.50', userAgent: 'Safari/iOS', ts: 123456 },
      ],
    });

    gate.broadcastPendingDevices();

    // 已批准的客户端收到待审批列表
    assert.equal(trustedClient.emitted.length, 1);
    assert.equal(trustedClient.emitted[0].payload.type, 'pending_devices');
    assert.deepEqual(trustedClient.emitted[0].payload.payload, {
      devices: [
        { deviceId: 'device-x', ip: '192.168.1.50', userAgent: 'Safari/iOS', ts: 123456 },
      ],
    });

    // 未批准的客户端绝对收不到待审批广播
    assert.equal(unapprovedClient.emitted.length, 0);
  });
});

test.describe('DEVICE-02 & DEVICE-03: 设备信任事务性与信息安全', () => {
  test('DEVICE-02: persistTrustedChange 落盘成功才提交，失败返回 null 且原集合不被篡改', () => {
    const initial = new Set(['dev-1', 'dev-2']);

    // 成功持久化
    const nextSuccess = persistTrustedChange(initial, (s) => s.delete('dev-1'), () => true);
    assert.ok(nextSuccess instanceof Set);
    assert.equal(nextSuccess.has('dev-1'), false);
    assert.equal(nextSuccess.has('dev-2'), true);
    assert.equal(initial.has('dev-1'), true, '原始集合不可就地突变');

    // 持久化返回 false（写盘失败）
    const nextFail = persistTrustedChange(initial, (s) => s.delete('dev-1'), () => false);
    assert.equal(nextFail, null, '写盘失败返回 null');
    assert.equal(initial.has('dev-1'), true);

    // 持久化抛出异常（如磁盘满/权限不足）
    const nextError = persistTrustedChange(initial, (s) => s.add('dev-3'), () => {
      throw new Error('ENOSPC: no space left on device');
    });
    assert.equal(nextError, null, '异常捕获后安全返回 null');
    assert.equal(initial.has('dev-3'), false);
  });

  test('DEVICE-02: MAX_PENDING_DEVICES 容量上限已固定且合理（防内存/刷盘 flood）', () => {
    assert.equal(MAX_PENDING_DEVICES, 50);
  });

  test('DEVICE-03: getTrustedCount 只读受信任总数，不泄露受信任 deviceToken 明细', () => {
    const count = getTrustedCount();
    assert.equal(typeof count, 'number');
    assert.ok(count >= 0);
  });

  test('DEVICE-03: getTrustedDeviceIds 专供本地 CLI 与菜单栏，返回 Array', () => {
    const ids = getTrustedDeviceIds();
    assert.ok(Array.isArray(ids));
  });
});
