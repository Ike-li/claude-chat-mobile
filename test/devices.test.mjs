import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

// 导入 devices 函数
import {
  loadTrustedDevices,
  saveTrustedDevices,
  loadPendingDevices,
  savePendingDevices,
  isDeviceTrusted,
  addPendingDevice,
  removePendingDevice,
  getPendingDevices,
  getLatestPendingDevice,
  approveDevice,
  denyDevice
} from '../devices.js';

// 路径
const HERE = import.meta.dirname;
const TRUSTED_DEVICES_FILE = join(HERE, '..', 'data', 'trusted-devices.json');
const PENDING_DEVICES_FILE = join(HERE, '..', 'data', 'pending-devices.json');

const TRUSTED_BACKUP = join(HERE, '..', 'data', 'trusted-devices.json.bak');
const PENDING_BACKUP = join(HERE, '..', 'data', 'pending-devices.json.bak');

test.describe('devices.js 单元测试', () => {
  // 备份原有数据
  test.before(() => {
    mkdirSync(join(HERE, '..', 'data'), { recursive: true });
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
});
