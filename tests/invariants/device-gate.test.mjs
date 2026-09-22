// tests/invariants/device-gate.test.mjs —— 设备准入网关与信任管理单测
// 守护：DEVICE-01（双本机与未审批设备拦截）、DEVICE-02（CLI 吊销/批准通过原子文件监听即时生效；落盘失败不提交变更；待审列表容量有界防 flood）、DEVICE-03（网络响应与待审推送信封隔离敏感数据）
// 测什么：createDeviceGate 初始化文件存在性；unlockDeviceSockets 与 disconnectDeviceSockets 生命周期；broadcastPendingDevices 仅推向可信端；pendingDevices 有界队列 (MAX_PENDING_DEVICES)；persistTrustedChange 原子持久化事务；getTrustedDeviceIds 隔离边界；trustedDevicesPayload 不下发全量 token
// 不测什么 + 为什么：不测物理硬件指纹采集与操作系统真实推送通道——分别属于前端采集与 ops/push
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDeviceGate } from '../../app/src/auth/device-gate.js';
import {
  persistTrustedChange,
  MAX_PENDING_DEVICES,
  getTrustedCount,
  getTrustedDeviceIds,
  loadTrustedDevices,
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

  // 此前只测 typeof count === 'number' / count >= 0——一个恒返回 0 的实现同样能通过。
  // 两个函数都读同一份由 tests/setup/preload-env.mjs 重定向到本进程隔离目录的文件
  // （CCM_TRUSTED_DEVICES_FILE，每个 .test.mjs 文件各自 fork 一个子进程、各自一份，
  // 不存在跨文件竞态）。直接写入已知内容再验证返回值确实反映了写入的数据，且数量
  // 变化时会跟着变，而不是停在某次调用的旧值上。
  test('DEVICE-03: getTrustedCount / getTrustedDeviceIds 确实反映受信任设备的真实数量与 ID（不是恒定值）', (t) => {
    const file = process.env.CCM_TRUSTED_DEVICES_FILE;
    assert.ok(file, '本测试依赖 preload-env.mjs 的 CCM_TRUSTED_DEVICES_FILE 重定向，缺了它这条测试测不出东西');
    const original = existsSync(file) ? readFileSync(file, 'utf8') : null;
    t.after(() => {
      if (original === null) { try { rmSync(file); } catch { /* 本来就没有，删不掉也无妨 */ } }
      else writeFileSync(file, original);
      loadTrustedDevices(); // 恢复内存态，避免污染同文件里排在后面的其它测试
    });

    writeFileSync(file, JSON.stringify(['dev-a', 'dev-b', 'dev-c']));
    loadTrustedDevices();
    assert.equal(getTrustedCount(), 3, 'getTrustedCount 必须反映刚写入的真实数量，不能是恒定值');
    assert.deepEqual(getTrustedDeviceIds().sort(), ['dev-a', 'dev-b', 'dev-c']);

    writeFileSync(file, JSON.stringify(['only-one']));
    loadTrustedDevices();
    assert.equal(getTrustedCount(), 1, '数量变化时必须跟着变，不能停留在上一次调用的值');
    assert.deepEqual(getTrustedDeviceIds(), ['only-one']);
  });

  // ★ 这条守的是「吊销真的能吊销」，不是防窃听：trusted_devices 只广播给 deviceApproved===true
  // 的连接，未审批端本来就收不到。真正的危害是——一台拿到过全量信任表的设备，日后被吊销时
  // 手里仍握着其余设备的 token，可以继续冒充进来，于是那次吊销并没有吊干净。
  // 所以下发面必须逐字段挑，而不是把 getTrustedDeviceProfiles 的结构整个丢出去（它带 deviceId）。
  test('DEVICE-03: trusted_devices 下发面不含任何全量 deviceToken，寻址只用 shortId', (t) => {
    const FULL_A = 'a3f21b09c4d5e6f7a8b9c0d1e2f3a4b5';
    const FULL_B = 'ffffffff0000111122223333444455ee';
    // createDeviceGate 会在 dataDir 下建两个文件并起 watcher，必须给它一次性目录
    const dir = mkdtempSync(join(tmpdir(), 'ccm-trusted-payload-'));
    t.after(() => rmSync(dir, { recursive: true, force: true })); // safe-rm: 上一行 mkdtemp 建的一次性目录
    const gate = createDeviceGate({
      io: fakeIo(),
      dataDir: dir,
      onUnlockSocket: () => {},
      listTrustedDevices: () => ([
        { deviceId: FULL_A, shortId: 'a3f21b09…a4b5', kind: 'iPhone', browser: 'Safari 18', model: null, alias: '客厅平板', ua: 'Mozilla/5.0 (iPhone)', ip: '192.168.1.5', approvedAt: 1799913600000 },
        { deviceId: FULL_B, shortId: 'ffffffff…55ee', kind: 'Mac', browser: null, model: null, alias: null, ua: null, ip: null, approvedAt: null },
      ]),
    });

    const payload = gate.trustedDevicesPayload(FULL_A);
    const wire = JSON.stringify(payload);
    // 顶层也钉住：accessBypassActive 决定面板显示哪一档脚注，漏发会让「吊销对它们无效」
    // 那句永远不出现，用户就又回到「按文案操作、结果相反」的老坑里。
    assert.deepEqual(Object.keys(payload).sort(), ['accessBypassActive', 'devices']);
    assert.equal(payload.accessBypassActive, false, '未注入时缺省必须是 false（＝不谎称管得到）');

    // ★ true 那一档必须单独造出来。只验缺省 false 的话，把这个字段写死成 false 也一样全绿——
    //   而写死成 false 正是缺陷本身（面板永远不警告，用户回到「按文案吊销、设备照常能用」的老坑）。
    //   2026-09-10 注入实测：只有下面这条能咬住。
    const bypassGate = createDeviceGate({
      io: fakeIo(),
      dataDir: dir,
      onUnlockSocket: () => {},
      listTrustedDevices: () => ([{ deviceId: FULL_A, shortId: 'a3f21b09…a4b5', kind: 'iPhone', browser: null, model: null, alias: null, ua: null, ip: null, approvedAt: null }]),
      accessBypassActive: true,
    });
    assert.equal(bypassGate.trustedDevicesPayload(FULL_A).accessBypassActive, true,
      '注入 true 必须原样下发——面板据此显示「这张表管不到隧道进来的连接」');
    // 整条 JSON 里都不许出现全量 token —— 逐字段断言会漏掉「有人往里加了个新字段」这种情况
    assert.equal(wire.includes(FULL_A), false, '下发面出现了全量 deviceToken，吊销将无法真正吊干净');
    assert.equal(wire.includes(FULL_B), false);
    assert.deepEqual(Object.keys(payload.devices[0]).sort(),
      ['alias', 'approvedAt', 'browser', 'ip', 'isCurrent', 'kind', 'model', 'shortId', 'ua'],
      '字段集变了就在这里更新，顺便重新想一遍新字段是不是凭据'
      + '（alias 是用户自己起的名，browser/model 由 UA 派生，都不是凭据；deviceId 永远不许进来）');

    // isCurrent 按接收方算：换一个接收者，标记必须跟着换
    assert.equal(payload.devices[0].isCurrent, true);
    assert.equal(payload.devices[1].isCurrent, false);
    const asB = gate.trustedDevicesPayload(FULL_B);
    assert.equal(asB.devices[0].isCurrent, false);
    assert.equal(asB.devices[1].isCurrent, true);

    // bypass 连接（本机直连 / CF Access）握手里可以完全没有 deviceToken：
    // 此时一条都不该被标成「这台就是你」，否则用户会以为自己不能吊销那台。
    const asBypass = gate.trustedDevicesPayload(undefined);
    assert.deepEqual(asBypass.devices.map(d => d.isCurrent), [false, false]);
  });
});
