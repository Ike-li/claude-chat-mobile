#!/usr/bin/env node
// tests/gates/check-container-config-isolation.js —— 容器配置隔离闸
//
// 守三条，都来自 2026-09-18 那次排查（集成测试 72 pass / 77 fail）：
//
//   A. 不得把仓库根挂到 service 的 working_dir。
//      配置目录取的是 process.cwd()（app/src/ops/config.js 的 loadConfigSources），
//      仓库根落在 cwd 上就意味着测试 server 读维护者自己的 ccm.config.json——那是生产配置。
//      本机那份设了 DEVICE_APPROVAL_SCOPE='all'，于是 shouldBypassDeviceApproval 第一行
//      return false，容器内 127.0.0.1 自连也不再 bypass，每个 socket 都 deviceApproved=false，
//      业务事件被 server/socket.js 那道门丢弃。
//
//   B. 挂了仓库根的 service，entrypoint 必须把 <working_dir>/ccm.config.json 清空。
//      本仓两个 service 都走「只读挂源 + tar 进容器层再跑」，tar 会把配置一起复制过去。
//      写容器层是安全的（碰不到宿主机那份），但得记着写。
//
//   C. 不得出现以 /ccm.config.json 结尾的挂载目标。
//      「挂根 + 叠一条覆盖挂载」看起来是最省事的隔离，但 Docker Desktop virtiofs 无法在
//      父挂载上覆盖同名文件，容器直接起不来（OCI mount error）。playground compose 早就
//      为此改过写法（playground-compose.test.mjs 有对应断言），这里把同一条红线扩到全部 compose。
//
// 【为什么值一道闸】这次的失效不会自己举手：测试确实红了，但红得像产品坏了一大片——
// 「正常路径」用例全红而 fail-closed 用例全绿（它们碰巧也被拒，结果对但理由完全不对）。
// 它被当成环境问题挂了多日没人查。
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

const INFRA_DIR = new URL('../infra/', import.meta.url).pathname;
const CONFIG_BASENAME = 'ccm.config.json';

// 只解析本仓自己维护的这几份 compose，格式稳定（两空格缩进），故不引入 YAML 依赖。
// 取三样东西：volumes 列表、working_dir、entrypoint 原文。
export function parseServices(text) {
  const services = new Map();
  let inServices = false;
  let current = null;
  let section = null;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\t/g, '  ').replace(/\s+$/, '');
    if (!line || /^\s*#/.test(line)) continue;
    if (/^services:\s*$/.test(line)) { inServices = true; continue; }
    if (/^\S/.test(line)) { inServices = false; current = null; section = null; continue; }
    if (!inServices) continue;
    const svc = line.match(/^ {2}([A-Za-z0-9_.-]+):\s*$/);
    if (svc) {
      current = svc[1];
      services.set(current, { volumes: [], workingDir: null, entrypoint: '' });
      section = null;
      continue;
    }
    if (!current) continue;
    const entry = services.get(current);
    const wd = line.match(/^ {4}working_dir:\s*(\S+)\s*$/);
    if (wd) { entry.workingDir = wd[1].replace(/['"]/g, ''); section = null; continue; }
    if (/^ {4}volumes:\s*$/.test(line)) { section = 'volumes'; continue; }
    if (/^ {4}entrypoint:/.test(line)) { section = 'entrypoint'; continue; }
    if (/^ {4}\S/.test(line)) { section = null; continue; }
    if (section === 'volumes') {
      const item = line.match(/^ {6}- \s*(.+)$/);
      if (item) entry.volumes.push(item[1].trim().replace(/['"]/g, ''));
    } else if (section === 'entrypoint') {
      entry.entrypoint += `${line.trim()}\n`;
    }
  }
  return services;
}

// infraDir 缺省不传：单测传临时目录夹具，CLI 入口用真实 tests/infra/。
export function checkContainerConfigIsolation({ infraDir = INFRA_DIR } = {}) {
  const violations = [];
  let scanned = 0;
  let guarded = 0;
  // 仓库根 = infraDir 往上两层（tests/infra/../.. = 仓库根）。用它比较而不是字面量 '../..'：
  // compose 里等价但字面不同的写法（'../../'、'./../..'、绝对路径）此前会被精确字符串匹配漏判——
  // 不是假设，本仓 playground compose 的 4 个 service 就写成了 '../../app' 这种逐子目录形式，
  // 从未进入过这道闸的判定。
  const repoRoot = resolve(infraDir, '..', '..');

  const files = readdirSync(infraDir).filter(f => /^docker-compose.*\.ya?ml$/.test(f)).sort();

  for (const file of files) {
    const text = readFileSync(join(infraDir, file), 'utf8');
    scanned += 1;
    for (const [service, { volumes, workingDir, entrypoint }] of parseServices(text)) {
      // C：任何 compose、任何 service 都不许叠同名配置覆盖挂载
      for (const volume of volumes) {
        const target = volume.split(':')[1] || '';
        if (target.endsWith(`/${CONFIG_BASENAME}`)) {
          violations.push(
            `${file} 的「${service}」挂了 ${volume}。\n` +
            `    Docker Desktop virtiofs 无法在父挂载上覆盖同名文件，容器会以 OCI mount error 起不来。\n` +
            `    改成「只读挂源 + tar 进容器层 + entrypoint 里 printf '{}' > <working_dir>/${CONFIG_BASENAME}」。`,
          );
        }
      }

      const repoMounts = volumes.filter(v => resolve(infraDir, v.split(':')[0]) === repoRoot);
      if (repoMounts.length === 0) continue;

      for (const volume of repoMounts) {
        const target = volume.split(':')[1] || '';
        // A：仓库根不能落在 working_dir 上——那就是 server 读配置的位置
        if (workingDir && target === workingDir) {
          violations.push(
            `${file} 的「${service}」把仓库根挂到了 working_dir（${volume}，working_dir: ${workingDir}）。\n` +
            `    配置目录取的是 process.cwd()，这等于让测试 server 读维护者的生产 ${CONFIG_BASENAME}。\n` +
            `    2026-09-18 实测：集成测试 77/150 红。改成挂到别处（如 /repo:ro）再 tar 进容器层。`,
          );
          continue;
        }
        // B：tar 进容器层的，entrypoint 必须清空配置
        const wd = workingDir || '/app';
        if (!entrypoint.includes(`${wd}/${CONFIG_BASENAME}`)) {
          violations.push(
            `${file} 的「${service}」挂了仓库根（${volume}），但 entrypoint 没有清空 ${wd}/${CONFIG_BASENAME}。\n` +
            `    tar/复制会把维护者的生产配置一起带进 ${wd}。补一行：printf '{}' > ${wd}/${CONFIG_BASENAME}\n` +
            `    （写容器层是安全的；反过来在挂载上叠覆盖会触发上面那条 virtiofs 问题。）`,
          );
          continue;
        }
        guarded += 1;
      }
    }
  }

  // 扫描面塌了不是"全部合规"：glob 匹配不到任何 compose 文件（目录搬空/改名/正则写错）此前会
  // 静默判过——0 份 compose 时 violations 天然是空数组，走到下面就打印"OK"退出码 0。
  // 与本仓同类门禁（check-playwright-forbidden-patterns.js 等）的护栏对齐。
  if (scanned === 0) {
    violations.push(`扫描面塌了：${infraDir} 下找不到任何 docker-compose*.y[a]ml 文件，不是"全部合规"。`);
  }

  return { scanned, guarded, violations };
}

export function formatContainerConfigIsolation(result) {
  if (result.violations.length) {
    return ['❌ 容器配置隔离检查失败：\n', ...result.violations.map(v => `  - ${v}\n`)].join('\n');
  }
  return `容器配置隔离 OK（扫了 ${result.scanned} 份 compose，${result.guarded} 处仓库根挂载均已在容器层清空 ${CONFIG_BASENAME}）`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const result = checkContainerConfigIsolation();
  const output = formatContainerConfigIsolation(result);
  if (result.violations.length) {
    console.error(output);
    process.exit(1);
  }
  console.log(output);
}
