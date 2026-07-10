// scripts/device.js —— CLI 工具：管理待确认和受信任的设备指纹。
import { getPendingDevices, approveDevice, denyDevice, loadTrustedDevices } from '../devices.js';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TRUSTED_DEVICES_FILE = join(HERE, '..', 'data', 'trusted-devices.json');

const args = process.argv.slice(2);
const command = args[0] || 'help';

function printHelp() {
  console.log(`
CCM 设备审批工具
用法:
  node scripts/device.js list           - 列出所有受信任和等待确认的设备
  node scripts/device.js approve <ID>   - 批准指定设备 ID 接入公网
  node scripts/device.js deny <ID>      - 拒绝并移除指定设备 ID
  node scripts/device.js help          - 显示此帮助信息
`);
}

function listDevices() {
  console.log('=== 等待确认的设备 (Pending) ===');
  const pending = getPendingDevices();
  if (pending.length === 0) {
    console.log('  （暂无等待确认的设备）');
  } else {
    pending.forEach((d, idx) => {
      const date = new Date(d.ts).toLocaleString();
      console.log(`  [${idx + 1}] ID: ${d.deviceToken}`);
      console.log(`      IP: ${d.ip} | 申请时间: ${date}`);
      console.log(`      User-Agent: ${d.userAgent || 'Unknown'}`);
    });
  }

  console.log('\n=== 已受信任的设备 (Trusted) ===');
  try {
    if (existsSync(TRUSTED_DEVICES_FILE)) {
      const trusted = JSON.parse(readFileSync(TRUSTED_DEVICES_FILE, 'utf8'));
      if (Array.isArray(trusted) && trusted.length > 0) {
        trusted.forEach((id, idx) => {
          console.log(`  [${idx + 1}] ID: ${id}`);
        });
      } else {
        console.log('  （暂无已受信任的设备）');
      }
    } else {
      console.log('  （暂无已受信任的设备）');
    }
  } catch (err) {
    console.log('  （读取受信任列表失败）', err.message);
  }
  console.log('');
}

function handleApprove(id) {
  if (!id) {
    console.error('❌ 错误：请提供需要批准的设备 ID。可以用 list 命令查看。');
    process.exit(1);
  }
  // 纵深防御：只批准"确在待审批列表里"的设备 token，同 server.js 远程批准路径的既有防线
  // （防打错 ID / 传入陈旧 ID 被静默加入信任列表——approveDevice 本身对任意非空字符串来者不拒）。
  if (!getPendingDevices().some(d => d.deviceToken === id)) {
    console.error(`❌ 错误：设备 ID「${id}」不在待审批列表里，未批准。可用 list 命令查看当前待审批设备。`);
    process.exit(1);
  }
  const ok = approveDevice(id);
  if (ok) {
    console.log(`\n✅ 成功批准设备: ${id}\n设备已加入白名单，连接将立即无缝解锁！`);
  } else {
    console.error(`❌ 错误：批准设备失败。`);
    process.exit(1);
  }
}

function handleDeny(id) {
  if (!id) {
    console.error('❌ 错误：请提供需要拒绝的设备 ID。可以用 list 命令查看。');
    process.exit(1);
  }
  const ok = denyDevice(id);
  if (ok) {
    console.log(`\n🚫 已拒绝并移除设备: ${id}`);
  } else {
    console.error(`❌ 错误：移除设备失败。`);
    process.exit(1);
  }
}

switch (command) {
  case 'list':
    listDevices();
    break;
  case 'approve':
    handleApprove(args[1]);
    break;
  case 'deny':
    handleDeny(args[1]);
    break;
  case 'help':
  default:
    printHelp();
    break;
}
