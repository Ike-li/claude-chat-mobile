// scripts/device.js —— CLI 工具：管理待确认和受信任的设备指纹。
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRuntimeEnvironment } from '../src/server/config.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
// 走 server 的同一条加载路径而不是自己 dotenv 一次：这里只要 CCM_DATA_DIR，但读错源的后果
// 是对着一个空的 trusted-devices.json 工作 —— 「一个设备都没有」和「读错目录了」长得一模一样。
loadRuntimeEnvironment(process.env, { dir: ROOT, quiet: true });
// devices.js 在模块初始化时锚定数据路径，必须先加载 .env 再动态导入。
// 信任表一律经 getTrustedDeviceIds 读，不在这里自己 join 路径：devices.js 除 CCM_DATA_DIR 外
// 还支持 CCM_*_DEVICES_FILE 文件级重定向，本文件自己算的话，list 与 approve 会认不同的源。
const { getPendingDevices, getTrustedDeviceIds, approveDevice, denyDevice } = await import('../src/auth/devices.js');
const { resolveDataDir } = await import('../src/shared/data-dir.js');

// 「我动的是哪个数据目录」。一台机器上可能装着不止一份（本仓 + fork + 演练用的 fresh clone），
// 而本文件按【当前目录的配置】解析数据根 —— 在 A 的目录下批准 B 的设备会如实报成功，
// 那台 server 却什么都没收到（2026-08-19 演练实录）。每条写操作都把落点说出来，让批错实例留痕。
const dataDirNote = () => `（数据目录：${resolveDataDir()}）`;

const args = process.argv.slice(2);
const command = args[0] || 'help';
const jsonMode = args.includes('--json');

function printHelp() {
  console.log(`
CCM 设备审批工具
用法:
  node scripts/device.js list           - 列出所有受信任和等待确认的设备
  node scripts/device.js list --json    - 同上，输出机读 JSON（桌面端菜单栏用）
  node scripts/device.js approve <ID>   - 批准指定设备 ID 接入公网
  node scripts/device.js deny <ID>      - 拒绝并移除指定设备 ID
  node scripts/device.js help          - 显示此帮助信息
`);
}

// 两种输出的唯一数据源。deviceToken → deviceId 的改名与 socket 侧 pendingDevicesPayload
// （src/auth/device-gate.js）保持一致：同一份东西在两条通道上不该有两个名字。
function snapshot() {
  return {
    schemaVersion: 1,
    pending: getPendingDevices().map(d => ({
      deviceId: d.deviceToken, ip: d.ip, userAgent: d.userAgent, ts: d.ts,
    })),
    trusted: getTrustedDeviceIds(),
  };
}

function listDevices() {
  const snap = snapshot();
  // --json：stdout 只许有 JSON。桌面端 JSONDecoder 收到任何人类文案都会整条解析失败，
  // 表现为菜单里"设备审批"永远空着——比报错更难查。
  if (jsonMode) {
    console.log(JSON.stringify(snap));
    return;
  }

  console.log(`=== 等待确认的设备 (Pending) ${dataDirNote()} ===`);
  if (snap.pending.length === 0) {
    console.log('  （暂无等待确认的设备）');
  } else {
    snap.pending.forEach((d, idx) => {
      const date = new Date(d.ts).toLocaleString();
      console.log(`  [${idx + 1}] ID: ${d.deviceId}`);
      console.log(`      IP: ${d.ip} | 申请时间: ${date}`);
      console.log(`      User-Agent: ${d.userAgent || 'Unknown'}`);
    });
  }

  console.log('\n=== 已受信任的设备 (Trusted) ===');
  if (snap.trusted.length === 0) {
    console.log('  （暂无已受信任的设备）');
  } else {
    snap.trusted.forEach((id, idx) => console.log(`  [${idx + 1}] ID: ${id}`));
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
    console.error(`❌ 错误：设备 ID「${id}」不在待审批列表里，未批准 ${dataDirNote()}。`
      + '\n   若这台设备明明在等，多半是跑错了目录——本命令按【当前目录的配置】决定数据根，'
      + '\n   请到那台 server 自己的项目目录下再跑一次。可用 list 命令查看当前待审批设备。');
    process.exit(1);
  }
  const ok = approveDevice(id);
  if (ok) {
    console.log(`\n✅ 成功批准设备: ${id} ${dataDirNote()}\n设备已加入白名单，连接将立即无缝解锁！`);
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
    console.log(`\n🚫 已拒绝并移除设备: ${id} ${dataDirNote()}`);
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
