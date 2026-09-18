#!/usr/bin/env node
// tests/gates/check-container-config-isolation.js —— 容器配置隔离闸
//
// 守的判据只有一条：**把仓库根整个挂进容器的 service，必须同时用只读挂载覆盖掉
// 那份 ccm.config.json**。
//
// 【为什么需要】2026-09-18：docker-compose.test.yml 的 `- ../..:/app` 把维护者自己的
// ccm.config.json（生产配置）一起挂了进去。那份设了 DEVICE_APPROVAL_SCOPE='all'，
// 于是容器里的测试 server 走 shouldBypassDeviceApproval 第一行就 return false——
// 127.0.0.1 自连也不再 bypass，每个 socket 都 deviceApproved=false，业务事件被
// server/socket.js 那道门丢弃。集成测试 77/150 红。
//
// 【为什么值一道闸】症状会把人带偏：「正常路径」用例全红而 fail-closed 用例全绿
// （后者碰巧也被拒，结果对但理由完全不对），看着像产品坏了一大片。它被当成环境问题
// 挂了多日没人查。这类失效不会自己举手——测试红了，但红得像是别的原因。
//
// 【判据为什么是「挂仓库根」而不是「所有 service」】playground 那两个 compose 只挂
// app/ scripts/ tests/ package.json 与命名卷，本来就带不进 ccm.config.json。把它们
// 一起要求会逼出无意义的挂载，而无意义的要求迟早被人删掉。
//
// 【为什么必须 :ro】rw 挂载会写穿到宿主机的真配置上。entrypoint 里 `echo {} > ...`
// 是同一个坑的另一种写法——那会直接毁掉维护者的配置。
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const INFRA_DIR = new URL('../infra/', import.meta.url).pathname;
const CONFIG_BASENAME = 'ccm.config.json';

// 只解析我们自己维护的这几份 compose，格式稳定（两空格缩进、volumes 为短横线列表），
// 故不引入 YAML 依赖。解析不到 volumes 的 service 自然就没有仓库挂载，不会误报。
function parseServiceVolumes(text) {
  const services = new Map();
  let inServices = false;
  let current = null;
  let inVolumes = false;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\t/g, '  ').replace(/\s+$/, '');
    if (!line || /^\s*#/.test(line)) continue;
    if (/^services:\s*$/.test(line)) { inServices = true; continue; }
    if (/^\S/.test(line)) { inServices = false; current = null; inVolumes = false; continue; }
    if (!inServices) continue;
    const svc = line.match(/^ {2}([A-Za-z0-9_.-]+):\s*$/);
    if (svc) { current = svc[1]; services.set(current, []); inVolumes = false; continue; }
    if (!current) continue;
    if (/^ {4}volumes:\s*$/.test(line)) { inVolumes = true; continue; }
    if (/^ {4}\S/.test(line)) { inVolumes = false; continue; }
    if (!inVolumes) continue;
    const item = line.match(/^ {6}- \s*(.+)$/);
    if (item) services.get(current).push(item[1].trim());
  }
  return services;
}

// `../..:/app` / `../..:/repo:ro` → 挂载目标；不是仓库根挂载则返回 null
function repoRootTarget(volume) {
  const parts = volume.split(':');
  if (parts[0] !== '../..') return null;
  return parts[1] || null;
}

function coversConfig(volumes, target) {
  const want = `${target.replace(/\/$/, '')}/${CONFIG_BASENAME}`;
  return volumes.some(v => {
    const parts = v.split(':');
    return parts[1] === want && parts[2] === 'ro';
  });
}

const violations = [];
let scanned = 0;
let guarded = 0;

for (const file of readdirSync(INFRA_DIR).filter(f => /^docker-compose.*\.ya?ml$/.test(f)).sort()) {
  const text = readFileSync(join(INFRA_DIR, file), 'utf8');
  scanned += 1;
  for (const [service, volumes] of parseServiceVolumes(text)) {
    for (const volume of volumes) {
      const target = repoRootTarget(volume);
      if (!target) continue;
      if (coversConfig(volumes, target)) { guarded += 1; continue; }
      violations.push(
        `${file} 的 service「${service}」把仓库根挂到 ${target}（${volume}），` +
        `却没有用 :ro 覆盖 ${target}/${CONFIG_BASENAME}。\n` +
        `    宿主机的生产配置会被测试 server 读到——2026-09-18 那次是 DEVICE_APPROVAL_SCOPE='all'，` +
        `集成测试 77/150 红。\n` +
        `    补一条：- ./isolated-config.json:${target}/${CONFIG_BASENAME}:ro   （必须 :ro，rw 会写穿宿主机真配置）`,
      );
    }
  }
}

if (violations.length) {
  console.error('❌ 容器配置隔离检查失败：\n');
  for (const v of violations) console.error(`  - ${v}\n`);
  process.exit(1);
}

console.log(`容器配置隔离 OK（扫了 ${scanned} 份 compose，${guarded} 处仓库根挂载均已覆盖 ${CONFIG_BASENAME}）`);
