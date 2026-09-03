// 设备审批网关：socket 按 deviceToken 分组解锁/断连、待批列表广播、trusted-devices.json
// 文件监听（CLI/TTY 侧审批即时同步到 web 连接）。从 server/app.js 下沉。
//
// unlockSocket（重放 init/models/statusline 初始态）依赖 app 层大量同步状态，故不并入本模块，
// 而作为 onUnlockSocket 回调注入——本模块只管"哪些 socket、何时"，重放"放什么"仍属 app。
import { statSync, existsSync, mkdirSync, watch } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { writeOwnerOnlyFile } from '../files/file-security.js';
import { isDeviceTrusted, getPendingDevices } from './devices.js';
import * as audit from '../ops/audit.js';

export function createDeviceGate({
  io,
  dataDir,
  onUnlockSocket,
  listPendingDevices = getPendingDevices,
  isTrusted = isDeviceTrusted,
}) {
  const trustedDevicesFile = join(dataDir, 'trusted-devices.json');
  const pendingDevicesFile = join(dataDir, 'pending-devices.json');

  function getSocketsByDeviceToken(deviceToken) {
    const list = [];
    if (!deviceToken) return list;
    for (const socket of io.sockets.sockets.values()) {
      if (socket.handshake.auth?.deviceToken === deviceToken) list.push(socket);
    }
    return list;
  }

  function unlockDeviceSockets(deviceToken) {
    for (const socket of getSocketsByDeviceToken(deviceToken)) onUnlockSocket(socket);
  }

  function disconnectDeviceSockets(deviceToken) {
    for (const socket of getSocketsByDeviceToken(deviceToken)) {
      socket.emit('agent:event', {
        seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
        type: 'device_status', payload: { status: 'denied', deviceId: deviceToken },
      });
      socket.disconnect(true);
    }
  }

  // 当前全量待审批设备列表（deviceToken→deviceId，幂等载体）。
  function pendingDevicesPayload() {
    return { devices: listPendingDevices().map(d => ({ deviceId: d.deviceToken, ip: d.ip, userAgent: d.userAgent, ts: d.ts })) };
  }

  // 把待审批列表推给所有"已信任"Socket（deviceApproved===true），供其在 Web UI 远程审批。
  function broadcastPendingDevices() {
    const payload = pendingDevicesPayload();
    for (const socket of io.sockets.sockets.values()) {
      if (socket.deviceApproved === true) {
        socket.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'pending_devices', payload,
        });
      }
    }
  }

  // 确保数据文件存在，以便安全进行 watch 监听
  try {
    mkdirSync(dataDir, { recursive: true });
    if (!existsSync(trustedDevicesFile)) writeOwnerOnlyFile(trustedDevicesFile, JSON.stringify([], null, 2));
    if (!existsSync(pendingDevicesFile)) writeOwnerOnlyFile(pendingDevicesFile, JSON.stringify([], null, 2));
  } catch (err) {
    console.error('[devices] 初始化设备认证文件失败:', err.message);
  }

  // 文件变化监听器（用于在 CLI 执行批准/拒绝操作时自动、即时同步对应的客户端连接）。
  // SEC-03 修复中实证发现：原先直接 watch(trustedDevicesFile, ...) 判 eventType==='change' 在 macOS 上不可靠——
  // writeOwnerOnlyFile 是原子写（tmp 文件 + rename 换 inode），第一次 rename 触发的 eventType 是 'rename' 不是
  // 'change'（被现有判断完全漏掉），且 watch 绑定的是旧 inode，一旦被 rename 替换，之后对该路径的写入完全收不到
  // 任何事件。与 workdirs.json 早年踩过的同一个坑，改用同款解法：watch 父目录 + 按 basename 过滤 + mtime 前置守卫。
  function watchTrustedDevicesFile() {
    if (!existsSync(trustedDevicesFile)) return;
    const tdBase = basename(trustedDevicesFile);
    let tdTimer = null;
    let lastTrustedDevicesMtime = 0;
    try { lastTrustedDevicesMtime = statSync(trustedDevicesFile).mtimeMs; } catch { /* 首次变更时再取 */ }
    try {
      const watcher = watch(dirname(trustedDevicesFile), (_evt, filename) => {
        if (filename && filename !== tdBase) return; // 有 filename 时按 basename 过滤，忽略同目录其他文件变动
        let m;
        try { m = statSync(trustedDevicesFile).mtimeMs; } catch { return; } // 文件暂不可读 → 跳过
        if (m === lastTrustedDevicesMtime) return;    // mtime 未变 = 非本文件变动，忽略
        lastTrustedDevicesMtime = m;
        clearTimeout(tdTimer);
        tdTimer = setTimeout(() => {
          const revokedTokens = new Set(); // SEC-03：CLI 从信任表移除的 deviceToken，本轮结束后统一断连（去重）
          for (const socket of io.sockets.sockets.values()) {
            if (socket.deviceApproved === false) {
              const token = socket.handshake.auth?.deviceToken;
              if (isTrusted(token)) {
                console.log(`[devices] 检测到 ${trustedDevicesFile} 变更，自动解锁设备 ${token}`);
                onUnlockSocket(socket);
                audit.recordAudit({ actor: { deviceId: null, via: 'cli' }, action: 'device_approved', target: token, outcome: 'allowed', meta: { via: 'cli' } });
              }
            } else if (socket.deviceApproved === true && socket.trustBasis === 'device-token') {
              // SEC-03：CLI 吊销对称断连——只检查 trustBasis==='device-token' 的连接：isLocal/CF Access
              // 批准的连接与信任表无关，不受影响。
              const token = socket.handshake.auth?.deviceToken;
              if (!isTrusted(token)) revokedTokens.add(token);
            }
          }
          for (const token of revokedTokens) {
            console.log(`[devices] 检测到 ${trustedDevicesFile} 变更，设备 ${token} 信任已被吊销（CLI），断开连接`);
            disconnectDeviceSockets(token); // 复用 Web 侧同款：发 device_status:denied + disconnect(true)
            audit.recordAudit({ actor: { deviceId: null, via: 'cli' }, action: 'device_revoked', target: token, outcome: 'denied', meta: { via: 'cli' } });
          }
          broadcastPendingDevices(); // CLI/TTY 审批后刷新各可信端的待批列表（移除已批准/拒绝项）
        }, 100);
      });
      watcher.unref?.(); // 常驻 server 不受影响；避免在单测等短生命周期进程里吊住事件循环
    } catch (err) {
      console.error('[devices] 无法监视 trusted-devices.json 所在目录:', err.message);
    }
  }

  watchTrustedDevicesFile();

  return {
    trustedDevicesFile,
    pendingDevicesFile,
    getSocketsByDeviceToken,
    unlockDeviceSockets,
    disconnectDeviceSockets,
    pendingDevicesPayload,
    broadcastPendingDevices,
  };
}
