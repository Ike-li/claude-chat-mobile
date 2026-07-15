import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';

// 导入 devices 函数
import {
  loadTrustedDevices,
  loadPendingDevices,
  isDeviceTrusted,
  addPendingDevice,
  removePendingDevice,
  getPendingDevices,
  getLatestPendingDevice,
  approveDevice,
  denyDevice,
  persistTrustedChange,
  MAX_PENDING_DEVICES
} from '../../src/auth/devices.js';

// 路径
const HERE = import.meta.dirname;
// TC-001：优先用 preload 注入的 CCM_*_DEVICES_FILE（临时目录），回退真实 data/——与 devices.js 同源，
// 保证测试断言/备份的路径 = 模块实际写入路径，且 npm test 下彻底不碰生产 data/。
const TRUSTED_DEVICES_FILE = process.env.CCM_TRUSTED_DEVICES_FILE || join(HERE, '..', '..', 'data', 'trusted-devices.json');
const PENDING_DEVICES_FILE = process.env.CCM_PENDING_DEVICES_FILE || join(HERE, '..', '..', 'data', 'pending-devices.json');

const TRUSTED_BACKUP = TRUSTED_DEVICES_FILE + '.bak';
const PENDING_BACKUP = PENDING_DEVICES_FILE + '.bak';

test.describe('devices.js 单元测试', () => {
  // 备份原有数据
  test.before(() => {
    mkdirSync(dirname(TRUSTED_DEVICES_FILE), { recursive: true }); // 隔离目录（preload 临时）或回退真实 data/
    if (existsSync(TRUSTED_DEVICES_FILE)) {
      renameSync(TRUSTED_DEVICES_FILE, TRUSTED_BACKUP);
    }
    if (existsSync(PENDING_DEVICES_FILE)) {
      renameSync(PENDING_DEVICES_FILE, PENDING_BACKUP);
    }
  });

  // 恢复原有数据
  test.after(() => {
    // 删掉测试残留
    if (existsSync(TRUSTED_DEVICES_FILE)) {
      try { unlinkSync(TRUSTED_DEVICES_FILE); } catch {}
    }
    if (existsSync(PENDING_DEVICES_FILE)) {
      try { unlinkSync(PENDING_DEVICES_FILE); } catch {}
    }

    if (existsSync(TRUSTED_BACKUP)) {
      renameSync(TRUSTED_BACKUP, TRUSTED_DEVICES_FILE);
    }
    if (existsSync(PENDING_BACKUP)) {
      renameSync(PENDING_BACKUP, PENDING_DEVICES_FILE);
    }
  });

  test('初始化状态：未授权，待处理列表为空', () => {
    // 强制重新加载以使用刚刚建立的干净空环境
    loadTrustedDevices();
    loadPendingDevices();

    assert.equal(isDeviceTrusted('non-existent-device'), false);
    assert.deepEqual(getPendingDevices(), []);
    assert.equal(getLatestPendingDevice(), null);
  });

  test('添加待审批设备并获取最新设备', () => {
    addPendingDevice('device-1', { ip: '192.168.1.100', userAgent: 'iPhone' });
    
    const pending = getPendingDevices();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].deviceToken, 'device-1');
    assert.equal(pending[0].ip, '192.168.1.100');
    assert.equal(pending[0].userAgent, 'iPhone');
    assert.ok(pending[0].ts > 0);
    
    assert.equal(getLatestPendingDevice(), 'device-1');
    assert.equal(isDeviceTrusted('device-1'), false);
  });

  test('添加多个待审批设备，保持最新排在前面', () => {
    addPendingDevice('device-2', { ip: '192.168.1.200', userAgent: 'iPad' });
    
    const pending = getPendingDevices();
    assert.equal(pending.length, 2);
    assert.equal(pending[0].deviceToken, 'device-2'); // 排序后最新在最前面
    assert.equal(getLatestPendingDevice(), 'device-2');
  });

  test('批准待审批设备', () => {
    const ok = approveDevice('device-2');
    assert.equal(ok, true);

    // 检查是否已被加入受信任列表
    assert.equal(isDeviceTrusted('device-2'), true);
    assert.equal(isDeviceTrusted('device-1'), false);

    // 检查是否已被移出待审批
    const pending = getPendingDevices();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].deviceToken, 'device-1');
    assert.equal(getLatestPendingDevice(), 'device-1');
  });

  test('拒绝并移除设备', () => {
    // 拒绝未批准的 pending 设备
    const ok1 = denyDevice('device-1');
    assert.equal(ok1, true);
    assert.equal(getPendingDevices().length, 0);
    assert.equal(getLatestPendingDevice(), null);

    // 拒绝已批准的 trusted 设备
    const ok2 = denyDevice('device-2');
    assert.equal(ok2, true);
    assert.equal(isDeviceTrusted('device-2'), false);
  });

  test('处理边缘无效输入安全', () => {
    assert.equal(isDeviceTrusted(null), false);
    assert.equal(isDeviceTrusted(undefined), false);
    assert.equal(isDeviceTrusted(''), false);

    addPendingDevice(null, { ip: '1.1.1.1' });
    assert.equal(getPendingDevices().length, 0);

    assert.equal(approveDevice(null), false);
    assert.equal(denyDevice(null), false);
  });

  // F1（code-review #5）：pendingDevices 有容量上限，防 LAN-authenticated flood 撑爆文件/刷屏。
  test('pendingDevices 有容量上限，超出丢最旧（防 flood）', () => {
    loadPendingDevices();
    for (const d of getPendingDevices()) removePendingDevice(d.deviceToken); // 清干净
    assert.equal(getPendingDevices().length, 0);

    const N = MAX_PENDING_DEVICES + 5;
    for (let i = 0; i < N; i++) addPendingDevice(`flood-${i}`, { ip: '10.0.0.1', userAgent: 'x' });

    const pending = getPendingDevices();
    assert.equal(pending.length, MAX_PENDING_DEVICES, '超上限被裁到 MAX');
    assert.equal(pending.some(d => d.deviceToken === 'flood-0'), false, '最早插入的被丢');
    assert.equal(pending.some(d => d.deviceToken === `flood-${N - 1}`), true, '最新的保留');

    for (const d of getPendingDevices()) removePendingDevice(d.deviceToken); // 清理
    assert.equal(getPendingDevices().length, 0);
  });
});

// BE-011：吊销/批准的持久化失败必须可观测——落盘失败时不得把变更提交到内存、更不得谎报成功
// （isDeviceTrusted 每次重读磁盘，谎报成功会让被吊销设备下次检查复活）。纯函数，注入 fake persist，不碰文件系统。
test.describe('persistTrustedChange（BE-011：落盘成功才提交变更）', () => {
  test('persist 成功 → 返回应用了变更的新集合，原集合不被就地修改', () => {
    const cur = new Set(['a', 'b']);
    const next = persistTrustedChange(cur, s => s.delete('a'), () => true);
    assert.ok(next instanceof Set);
    assert.equal(next.has('a'), false);
    assert.equal(next.has('b'), true);
    assert.equal(cur.has('a'), true, '原集合不被就地修改（在副本上变更）');
  });

  test('persist 返回 false → 返回 null（变更未提交，调用方据此报失败、不谎报）', () => {
    const cur = new Set(['a']);
    const next = persistTrustedChange(cur, s => s.delete('a'), () => false);
    assert.equal(next, null);
    assert.equal(cur.has('a'), true, '落盘失败原集合保持不变');
  });

  test('persist 抛错（EACCES/ENOSPC 等）→ 返回 null，视为落盘失败不提交', () => {
    const cur = new Set(['a']);
    const next = persistTrustedChange(cur, s => s.add('b'), () => { throw new Error('EACCES'); });
    assert.equal(next, null);
  });

  test('add 变更同理：persist 成功才含新成员', () => {
    const next = persistTrustedChange(new Set(), s => s.add('x'), () => true);
    assert.equal(next.has('x'), true);
  });
});
