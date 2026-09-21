// 设备审批网关：socket 按 deviceToken 分组解锁/断连、待批列表广播、trusted-devices.json
// 文件监听（CLI/TTY 侧审批即时同步到 web 连接）。从 server/app.js 下沉。
//
// unlockSocket（重放 init/models/statusline 初始态）依赖 app 层大量同步状态，故不并入本模块，
// 而作为 onUnlockSocket 回调注入——本模块只管"哪些 socket、何时"，重放"放什么"仍属 app。
import { statSync, existsSync, mkdirSync, watch } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { writeOwnerOnlyFile } from '../files/file-security.js';
import { isDeviceTrusted, getPendingDevices, getTrustedDeviceProfiles } from './devices.js';
import * as audit from '../ops/audit.js';

export function createDeviceGate({
  io,
  dataDir,
  onUnlockSocket,
  listPendingDevices = getPendingDevices,
  listTrustedDevices = getTrustedDeviceProfiles,
  isTrusted = isDeviceTrusted,
  // CF Access 已启用且 DEVICE_APPROVAL_SCOPE !== 'all' —— 此时经隧道进来的连接【完全不查】
  // 这张信任表，吊销对它们既不掉线也不拦截。界面必须说出这件事：一个点得到、却对用户
  // 实际访问路径无效的控件，比没有这个控件更坏（2026-09-10 实测踩到）。
  accessBypassActive = false,
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

  // 已受信任设备列表的下发面（DEVICE-03）。**逐字段挑出来，不是把内部结构整个丢出去**：
  // getTrustedDeviceProfiles 返回的 deviceId 是全量 32 位 token，而 token 就是准入凭据。
  //
  // 红线的理由不是「防局域网窃听」——这条广播只发给 deviceApproved===true 的连接，
  // 未审批端本来就收不到。真正的理由是**让吊销真的能吊销**：一台拿到过全量信任表的设备，
  // 日后被吊销时手里仍握着其余设备的 token，可以继续冒充进来。
  //
  // 寻址改用 shortId（前8…后4）：它同时是用户在手机上、菜单栏里看到的那一串，
  // 既够反查又不是凭据。isCurrent 由服务端比对得出，前端不需要知道自己的 token 长什么样。
  function trustedDevicesPayload(currentDeviceToken) {
    return {
      accessBypassActive,
      devices: listTrustedDevices().map(d => ({
        shortId: d.shortId,
        kind: d.kind,
        browser: d.browser,
        model: d.model,
        alias: d.alias,
        ua: d.ua,
        ip: d.ip,
        approvedAt: d.approvedAt,
        isCurrent: Boolean(currentDeviceToken) && d.deviceId === currentDeviceToken,
      })),
    };
  }

  // 逐 socket 发（不能像 pending 那样共用一份 payload）：isCurrent 是「这台就是你」，
  // 按接收方算，共用一份会让所有人都看到别人的那个标记。
  function broadcastTrustedDevices() {
    for (const socket of io.sockets.sockets.values()) {
      if (socket.deviceApproved === true) {
        socket.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'trusted_devices', payload: trustedDevicesPayload(socket.handshake.auth?.deviceToken),
        });
      }
    }
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

  // 文件变化监听器（用于在 CLI 执行批准/拒绝操作时自动、即时同步对应的客户端连接 + 记审计）。
  // SEC-03 修复中实证发现：原先直接 watch(trustedDevicesFile, ...) 判 eventType==='change' 在 macOS 上不可靠——
  // writeOwnerOnlyFile 是原子写（tmp 文件 + rename 换 inode），第一次 rename 触发的 eventType 是 'rename' 不是
  // 'change'（被现有判断完全漏掉），且 watch 绑定的是旧 inode，一旦被 rename 替换，之后对该路径的写入完全收不到
  // 任何事件。与 workdirs.json 早年踩过的同一个坑，改用同款解法：watch 父目录 + 按 basename 过滤 + mtime 前置守卫。
  //
  // 审计与「在线连接」解耦（原实现只在遍历到匹配的【已连接】socket 时才记审计——离线批准/秋后
  // 吊销一台当下没有活连接的设备，不留任何审计痕迹）：现在对 trusted/pending 两份文件的【全量
  // 成员集合】做前后差集，审计只问"这份文件的集合变了没有"，与谁在线无关；socket 遍历继续保留，
  // 但只服务于"现在就把在线连接解锁/断开"这一件事，两件事分开算，互不遮蔽。
  //
  // 顺带把 pending-devices.json 一并纳入同一个 watcher（原来只 watch trusted 那一份）：deny 一台
  // 【从未进入过 trusted 集合】的待审批设备，trusted 那份文件内容不变（delete 一个不存在的成员
  // 是 no-op），单看 trusted 差集永远看不出这次操作发生过——只有 pending 集合的差集能捕捉
  // 「移除但没有变成 trusted」这一种变化，这正是原始缺口（deny 从未产生过审计记录）。
  function watchDeviceFiles() {
    if (!existsSync(trustedDevicesFile)) return;
    const tdBase = basename(trustedDevicesFile);
    const pdBase = basename(pendingDevicesFile);
    let timer = null;
    let lastTrustedMtime = 0;
    let lastPendingMtime = 0;
    try { lastTrustedMtime = statSync(trustedDevicesFile).mtimeMs; } catch { /* 首次变更时再取 */ }
    try { lastPendingMtime = statSync(pendingDevicesFile).mtimeMs; } catch { /* 首次变更时再取 */ }
    // 全量成员快照，供下面按 tick 做前后差集；两个 list* 各自内部已有 last-good 兜底，文件暂不
    // 存在/读失败时安全回落空集，不需要在这里额外防御。
    let lastTrustedSet = new Set(listTrustedDevices().map(d => d.deviceId));
    let lastPendingSet = new Set(listPendingDevices().map(d => d.deviceToken));
    try {
      const watcher = watch(dirname(trustedDevicesFile), (_evt, filename) => {
        if (filename && filename !== tdBase && filename !== pdBase) return; // 忽略同目录其他文件变动
        let tm = lastTrustedMtime, pm = lastPendingMtime;
        try { tm = statSync(trustedDevicesFile).mtimeMs; } catch { /* 保持旧值，下面判等即不触发 */ }
        try { pm = statSync(pendingDevicesFile).mtimeMs; } catch { /* 同上 */ }
        if (tm === lastTrustedMtime && pm === lastPendingMtime) return; // 两份 mtime 都没变＝与本 watcher 无关
        lastTrustedMtime = tm;
        lastPendingMtime = pm;
        clearTimeout(timer);
        timer = setTimeout(() => {
          // ── 审计：纯集合差集，与是否在线无关 ──
          const nowTrustedSet = new Set(listTrustedDevices().map(d => d.deviceId));
          const nowPendingSet = new Set(listPendingDevices().map(d => d.deviceToken));
          for (const token of nowTrustedSet) {
            if (!lastTrustedSet.has(token)) {
              console.log(`[devices] 检测到 ${trustedDevicesFile} 变更，设备 ${token} 新增信任（CLI）`);
              audit.recordAudit({ actor: { deviceId: null, via: 'cli' }, action: 'device_approved', target: token, outcome: 'allowed', meta: { via: 'cli' } });
            }
          }
          for (const token of lastTrustedSet) {
            if (!nowTrustedSet.has(token)) {
              console.log(`[devices] 检测到 ${trustedDevicesFile} 变更，设备 ${token} 信任已被吊销（CLI）`);
              audit.recordAudit({ actor: { deviceId: null, via: 'cli' }, action: 'device_revoked', target: token, outcome: 'denied', meta: { via: 'cli' } });
            }
          }
          for (const token of lastPendingSet) {
            // 从待审批移除、且没有变成受信任 → 是被 deny 的；变成受信任的那种情况已经在上面
            // 的 trusted 差集里记过 device_approved 了，这里不重复记。
            if (!nowPendingSet.has(token) && !nowTrustedSet.has(token)) {
              console.log(`[devices] 检测到 ${pendingDevicesFile} 变更，设备 ${token} 被拒绝（CLI）`);
              audit.recordAudit({ actor: { deviceId: null, via: 'cli' }, action: 'device_denied', target: token, outcome: 'denied', meta: { via: 'cli' } });
            }
          }
          lastTrustedSet = nowTrustedSet;
          lastPendingSet = nowPendingSet;

          // ── 在线连接的即时解锁/断连：按当前连接的 socket 逐个核对，纯 UX，与上面的审计判定各自独立 ──
          const revokedTokens = new Set(); // SEC-03：CLI 从信任表移除的 deviceToken，本轮结束后统一断连（去重）
          for (const socket of io.sockets.sockets.values()) {
            if (socket.deviceApproved === false) {
              const token = socket.handshake.auth?.deviceToken;
              if (isTrusted(token)) {
                console.log(`[devices] 检测到 ${trustedDevicesFile} 变更，自动解锁设备 ${token}`);
                onUnlockSocket(socket);
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
          }
          broadcastPendingDevices(); // CLI/TTY 审批后刷新各可信端的待批列表（移除已批准/拒绝项）
          broadcastTrustedDevices(); // 信任表刚变过——Web 上那份列表不刷就会停在旧快照上，用户对着它做吊销决策
        }, 100);
      });
      watcher.unref?.(); // 常驻 server 不受影响；避免在单测等短生命周期进程里吊住事件循环
    } catch (err) {
      console.error('[devices] 无法监视设备信任/待审文件所在目录:', err.message);
    }
  }

  watchDeviceFiles();

  return {
    trustedDevicesFile,
    pendingDevicesFile,
    getSocketsByDeviceToken,
    unlockDeviceSockets,
    disconnectDeviceSockets,
    pendingDevicesPayload,
    broadcastPendingDevices,
    trustedDevicesPayload,
    broadcastTrustedDevices,
  };
}
