// tty-device-console.js —— 跑着 server 的那个终端里的设备审批：敲回车＝批准最新的待审设备，输入 deny＝拒绝它。
//
// 从 app.js 挪出来是为了能测：app.js 一 import 就起 server，这段逻辑在那里只能靠真终端验证。
// socket 侧的三个动作（解锁 / 断连 / 广播待审列表）属于 device-gate 的闭包，由调用方注入；
// 设备表读写用 devices.js 的同一份单例，与 Web 侧审批共用。
//
// 审计在这里就地记 via:'tty'，再登记给文件监听器（noteAuditedExternally），做法与 Web 侧 user:approveDevice
// 相同。以前这里不记，靠监听器按差集补——监听器只认得进程外的 CLI，于是在 server 终端里敲回车批准，
// 日志写「新增信任（CLI）」、审计写 via:'cli'（2026-11-03 mini 全新安装核对）。
// 只记成功：落盘失败时控制台已有 ❌ 行，与改动前一致；那种情况文件没变，监听器也不会补记。

import { approveDevice, denyDevice, getLatestPendingDevice, getPendingDevices, noteAuditedExternally } from './devices.js';
import * as audit from '../ops/audit.js';

const TTY_ACTOR = Object.freeze({ deviceId: null, via: 'tty' });

export function createTtyDeviceConsole({ unlockDeviceSockets, disconnectDeviceSockets, broadcastPendingDevices }) {
  return function onTtyInput(data) {
    const text = String(data).trim().toLowerCase();
    const latest = getLatestPendingDevice();
    if (text === '') {
      if (latest) {
        console.log(`\n[TTY] 收到回车！一键批准最新设备: ${latest}`);
        // F2（code-review #5）：回车批准的是「Enter 那刻的最新」待审设备——若你看提示到按回车之间又来了新设备，
        // 批准的可能已不是你以为的那个。这里若尚有其他待审设备就告警，让你察觉可能的竞态、必要时 deny 复核。
        const others = getPendingDevices().filter(d => d.deviceToken !== latest).length;
        if (others > 0) {
          console.log(`   ⚠️ 另有 ${others} 个待审设备未处理——请确认刚批准的正是你想放行的那台（如有疑虑，运行 node scripts/device.js deny "${latest}" 撤销）`);
        }
        if (approveDevice(latest)) {
          audit.recordAudit({ actor: TTY_ACTOR, action: 'device_approved', target: latest, outcome: 'allowed', meta: { via: 'tty' } });
          noteAuditedExternally({ trustedAdded: [latest], pendingRemoved: [latest] });
          unlockDeviceSockets(latest);
          broadcastPendingDevices();
        } else {
          console.error(`   ❌ 批准 ${latest} 落盘失败、未生效，请检查服务端磁盘后重试`); // BE-011：不静默当成功
        }
      }
    } else if (text === 'deny') {
      if (latest) {
        console.log(`\n[TTY] 收到 deny！拒绝并移除最新设备: ${latest}`);
        const denied = denyDevice(latest);
        if (denied) {
          audit.recordAudit({ actor: TTY_ACTOR, action: 'device_denied', target: latest, outcome: 'denied', meta: { via: 'tty' } });
          noteAuditedExternally({ trustedRemoved: [latest], pendingRemoved: [latest] });
        }
        disconnectDeviceSockets(latest); // 断连照做（纵深防御）
        broadcastPendingDevices();
        if (!denied) console.error(`   ❌ 吊销 ${latest} 落盘失败、可能未生效（设备重连会复活），请检查服务端磁盘后重试`); // BE-011
      } else {
        console.log('\n[TTY] 当前没有等待审批的设备。');
      }
    }
  };
}
