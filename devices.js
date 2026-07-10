// devices.js —— 管理受信任和等待确认的设备指纹列表。
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeOwnerOnlyFile } from './file-security.js';

const HERE = import.meta.dirname || dirname(fileURLToPath(import.meta.url));
// CCM_DATA_DIR 覆盖状态根——仅测试用，与 server.js/sessions.js 同精神（E2E 隔离生产 data/，绝不碰常驻 server 的 data/）。
const DATA_DIR = process.env.CCM_DATA_DIR || join(HERE, 'data');
const TRUSTED_DEVICES_FILE = join(DATA_DIR, 'trusted-devices.json');
const PENDING_DEVICES_FILE = join(DATA_DIR, 'pending-devices.json');

let trustedDevices = new Set();
let pendingDevices = []; // Array of { deviceToken, ip, userAgent, ts }

// F1（code-review #5）：待审设备容量上限。防「已过 AUTH_TOKEN 但未设备审批」的 LAN 客户端用【每次不同的
// 随机 deviceToken】反复握手，把 pending-devices.json 撑爆 + 每来一个就 broadcastPendingDevices 刷屏可信端。
// 正常单用户设备数远小于此；超出按插入序丢最旧（攻击 flood 是新到的，真实少量旧设备优先保留）。
export const MAX_PENDING_DEVICES = 50;

export function loadTrustedDevices() {
  try {
    if (!existsSync(TRUSTED_DEVICES_FILE)) {
      trustedDevices = new Set();
      return;
    }
    const data = JSON.parse(readFileSync(TRUSTED_DEVICES_FILE, 'utf8'));
    if (Array.isArray(data)) {
      trustedDevices = new Set(data.filter(id => typeof id === 'string' && id.trim().length > 0));
    } else {
      trustedDevices = new Set();
    }
  } catch (err) {
    console.error('[devices] 读取 trusted-devices.json 失败:', err.message);
    trustedDevices = new Set();
  }
}

// ④ 安全体检：当前信任设备数（只读，不暴露 token）。
export function getTrustedCount() {
  return trustedDevices ? trustedDevices.size : 0;
}

export function saveTrustedDevices() {
  try {
    mkdirSync(dirname(TRUSTED_DEVICES_FILE), { recursive: true });
    writeOwnerOnlyFile(TRUSTED_DEVICES_FILE, JSON.stringify([...trustedDevices], null, 2));
  } catch (err) {
    console.error('[devices] 保存 trusted-devices.json 失败:', err.message);
  }
}

export function loadPendingDevices() {
  try {
    if (!existsSync(PENDING_DEVICES_FILE)) {
      pendingDevices = [];
      return;
    }
    const data = JSON.parse(readFileSync(PENDING_DEVICES_FILE, 'utf8'));
    if (Array.isArray(data)) {
      pendingDevices = data.filter(d => d && typeof d.deviceToken === 'string');
    } else {
      pendingDevices = [];
    }
  } catch (err) {
    // 忽略加载暂存待审批文件的错误，通常为空或损坏
    pendingDevices = [];
  }
}

export function savePendingDevices() {
  try {
    mkdirSync(dirname(PENDING_DEVICES_FILE), { recursive: true });
    writeOwnerOnlyFile(PENDING_DEVICES_FILE, JSON.stringify(pendingDevices, null, 2));
  } catch (err) {
    console.error('[devices] 保存 pending-devices.json 失败:', err.message);
  }
}

export function isDeviceTrusted(deviceToken) {
  if (!deviceToken || typeof deviceToken !== 'string') return false;
  // 每次检查前可以重新加载，确保多进程/CLI 操作的数据能即时感知
  loadTrustedDevices();
  return trustedDevices.has(deviceToken);
}

export function addPendingDevice(deviceToken, info) {
  if (!deviceToken || typeof deviceToken !== 'string') return;
  loadPendingDevices();
  // 过滤掉同设备已存在的旧记录
  pendingDevices = pendingDevices.filter(d => d.deviceToken !== deviceToken);
  pendingDevices.push({
    deviceToken,
    ...info,
    ts: Date.now()
  });
  // F1：容量上限，超则按插入序丢最旧（数组头部=最早插入）。getPendingDevices 另按 ts 排序供展示，
  // 此处按插入序裁剪确定性、不受同毫秒 ts 排序抖动影响。
  if (pendingDevices.length > MAX_PENDING_DEVICES) {
    pendingDevices = pendingDevices.slice(-MAX_PENDING_DEVICES);
  }
  savePendingDevices();
}

export function removePendingDevice(deviceToken) {
  if (!deviceToken) return;
  loadPendingDevices();
  pendingDevices = pendingDevices.filter(d => d.deviceToken !== deviceToken);
  savePendingDevices();
}

export function getPendingDevices() {
  loadPendingDevices();
  return [...pendingDevices].sort((a, b) => b.ts - a.ts); // 最新请求排在最前面
}

export function getLatestPendingDevice() {
  const list = getPendingDevices();
  return list.length > 0 ? list[0].deviceToken : null;
}

export function approveDevice(deviceToken) {
  if (!deviceToken || typeof deviceToken !== 'string') return false;
  loadTrustedDevices();
  trustedDevices.add(deviceToken);
  saveTrustedDevices();

  // 移出待审批
  loadPendingDevices();
  pendingDevices = pendingDevices.filter(d => d.deviceToken !== deviceToken);
  savePendingDevices();
  return true;
}

export function denyDevice(deviceToken) {
  if (!deviceToken || typeof deviceToken !== 'string') return false;
  loadTrustedDevices();
  trustedDevices.delete(deviceToken);
  saveTrustedDevices();

  // 移出待审批
  loadPendingDevices();
  pendingDevices = pendingDevices.filter(d => d.deviceToken !== deviceToken);
  savePendingDevices();
  return true;
}

// 启动时初始化加载
loadTrustedDevices();
loadPendingDevices();
