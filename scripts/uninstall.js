// uninstall.js —— 一键卸载：只删本产品安装/配置/运行时写下的东西。
//
// 边界纪律（判据是「文件是谁写下的」，不是名字像谁）：
//   删除目标只允许来自两类——代码内字面量路径，或产品自己写的 manifest 白名单
//   （service-install.json 的 unit 表、DATA_FILE_WHITELIST）。不 glob、不删「看起来像我们的」、
//   不信磁盘 JSON 里存的路径。
//   永不动：~/.claude/projects、~/.cloudflared、不在 manifest 的 launchd unit（含手工装的
//   com.ccm.tunnel*）、settings.json 里桥条目以外的内容、各工作区 .ccm-uploads（只报不删——
//   历史消息附件预览要读它，沿用 doctor 的立场）。
//
// 两档语义：默认只卸安装面（launchd 受管 unit / CCM.app / 偏好域 / 两个 CLI 桥及其
// ~/.claude/ccm 残余）；--purge 追加数据面（数据根白名单逐项、仓库根配置文件、受管 unit 日志）。
// 数据根**不整树 rmSync**：CCM_DATA_DIR 若被配到宽目录（比如 $HOME），整树删除就是 8/2 那次
// 事故的形态；白名单逐项删把爆炸半径钉死在已知文件名内，未知文件保留并报告。
//
// 结构照抄 service.js：可注入工厂 + 底部 import 守卫的瘦 CLI。桥/服务经子进程编排而非 import
// ——bridge-setup 脚本 import 即执行 main()，且它们的确认/CAS 语义应原样生效，不在这里复刻。
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync, rmdirSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';

import { resolveManifestPath, resolveUninstallConfirm } from './service.js';
import { SERVICE_UNIT_LOG_NAMES } from '../src/ops/service-units.js';
import { readConfigFileValues } from '../src/ops/config-file.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(HERE);

// 数据根白名单：只列**代码会写**的文件名（各模块的 dataFile(...) 调用点）。手动 .bak、
// 迁移期历史目录等一律不在表内 ⇒ 保留并报告。改这张表前先确认对应写入点真的存在。
export const DATA_FILE_WHITELIST = Object.freeze([
  'sessions.json',
  'approval-requests.json',
  'audit-records.json',
  'cf-access-certs.json',
  'trusted-devices.json',
  'pending-devices.json',
  'push-subscription.json',
  'init-cache.json',
  'service-events.json',
  'service-snapshot.json',
  'service-install.json',
  'log-terminal.json',
]);
const DATA_DIR_WHITELIST = Object.freeze(['worktree-settings']);
const CONFIG_FILES = Object.freeze(['ccm.config.json', '.env', 'workdirs.json']);

const BRIDGES = Object.freeze([
  { key: 'statusline', script: join(HERE, 'statusline-bridge-setup.js'), dir: 'statusline-v1', npmScript: 'statusline:uninstall' },
  { key: 'hooks', script: join(HERE, 'hooks-bridge-setup.js'), dir: 'hooks-v1', npmScript: 'hooks:uninstall' },
]);

const ICON = { done: '✓', skip: '·', plan: '→', refused: '⚠', error: '⚠' };

function parseJsonLine(stdout) {
  const lines = String(stdout || '').trim().split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try { return JSON.parse(lines[i]); } catch { /* 混着人类可读输出，继续向上找 */ }
  }
  return null;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function createUninstaller({
  home = homedir(),
  root = REPO_ROOT,
  platform = process.platform,
  env = process.env,
  spawn = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8', env }),
  // 生产唯一入口不覆盖此默认值；测试注入 mkdtemp 临时路径。
  appPath = '/Applications/CCM.app',
  kill = (pid, sig) => process.kill(pid, sig),
  sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
  out = (line) => process.stdout.write(`${line}\n`),
} = {}) {
  const fileEnv = readConfigFileValues(root).values;
  const manifestPath = resolveManifestPath(env, fileEnv, root);
  const dataDir = dirname(manifestPath);
  const settingsPath = join(home, '.claude', 'settings.json');
  const ccmDir = join(home, '.claude', 'ccm');

  // spawn 可能抛（可执行文件不存在等）——卸载器的方向是 fail-safe：判定不了就少删，不多删。
  function safeSpawn(cmd, args) {
    try {
      const r = spawn(cmd, args);
      return r && typeof r.status === 'number' ? r : { status: 1, stdout: '', stderr: String(r?.error || '') };
    } catch (error) {
      return { status: 1, stdout: '', stderr: String(error?.message || error) };
    }
  }

  function readManifestUnits() {
    try {
      const parsed = JSON.parse(readFileSync(manifestPath, 'utf8'));
      return Object.keys(parsed?.units || {});
    } catch {
      return [];
    }
  }

  function run({ purge = false, dryRun = false } = {}) {
    const steps = [];
    const push = (name, status, detail) => {
      steps.push({ name, status, detail });
      out(`${ICON[status] || ' '} ${name} — ${detail}`);
    };

    // ---- 1. launchd 受管 unit（只认 service manifest；手工装的 tunnel 等天然不在其列）----
    const managedUnits = readManifestUnits();
    if (platform !== 'darwin') {
      push('launchd', 'skip', '非 macOS，无 launchd 服务');
    } else if (!managedUnits.length) {
      push('launchd', 'skip', 'manifest 无受管 unit（从未安装或已卸载）');
    } else {
      for (const unit of managedUnits) {
        if (dryRun) {
          push(`unit:${unit}`, 'plan', '将经 service.js 卸载（bootout + 删 plist + 更新 manifest）');
          continue;
        }
        const r = safeSpawn(process.execPath, [join(HERE, 'service.js'), 'uninstall', unit, '--yes', '--json']);
        const parsed = parseJsonLine(r.stdout);
        if (parsed?.ok) push(`unit:${unit}`, 'done', '已卸载（bootout + 删 plist）');
        else if (parsed?.error?.includes('未安装')) push(`unit:${unit}`, 'skip', parsed.error);
        else if (parsed?.error) push(`unit:${unit}`, 'refused', `${parsed.error}（人工确认后：node scripts/service.js uninstall ${unit} --yes --force）`);
        else push(`unit:${unit}`, 'error', `service.js 输出无法解析：${(r.stderr || r.stdout || '').trim().slice(0, 200)}`);
      }
    }

    // ---- 2. 残留的菜单栏 app 进程 ----
    // menubar 的 LaunchAgent 是 /usr/bin/open 启动型：GUI 进程不是 agent 的子进程，bootout
    // 够不着它；删 .app 也杀不死已加载进内存的映像（unlink 语义）。按可执行路径精确锚定探测
    // （不按进程名猜），只发 SIGTERM 后复查——打不死不升级 SIGKILL，如实报人工处理。
    const pgrepPids = () => {
      const r = safeSpawn('pgrep', ['-f', `${join(appPath, 'Contents', 'MacOS')}/`]);
      if (r.status !== 0) return [];
      return String(r.stdout || '').split('\n')
        .map((l) => Number.parseInt(l, 10))
        .filter((pid) => Number.isInteger(pid) && pid > 1);
    };
    if (platform === 'darwin') {
      const pids = pgrepPids();
      if (!pids.length) {
        push('app-process', 'skip', '无残留的菜单栏 app 进程');
      } else if (dryRun) {
        push('app-process', 'plan', `将终止仍在运行的菜单栏 app（PID ${pids.join('、')}）`);
      } else {
        for (const pid of pids) {
          try { kill(pid, 'SIGTERM'); } catch { /* 进程可能恰好自己退了 */ }
        }
        let remaining = pids;
        for (let i = 0; i < 8 && remaining.length; i++) {
          sleep(250);
          remaining = pgrepPids();
        }
        if (remaining.length) {
          push('app-process', 'error', `SIGTERM 未生效（PID ${remaining.join('、')}），请在菜单栏点「退出」手动退出`);
        } else {
          push('app-process', 'done', `已终止菜单栏 app（PID ${pids.join('、')}）`);
        }
      }
    }

    // ---- 3. /Applications/CCM.app ----
    if (platform !== 'darwin') {
      push('app', 'skip', '非 macOS，无桌面 app');
    } else if (!existsSync(appPath)) {
      push('app', 'skip', `${appPath} 不存在`);
    } else if (dryRun) {
      push('app', 'plan', `将删除 ${appPath}`);
    } else {
      // safe-rm: appPath 默认值恒为字面量 /Applications/CCM.app（与 app-build.js:141 同目标）；
      // 生产唯一入口（本文件底部 CLI）不传覆盖，非默认值只来自单测注入的 mkdtemp 临时目录
      rmSync(appPath, { recursive: true, force: true });
      push('app', 'done', `已删除 ${appPath}`);
    }

    // ---- 4. UserDefaults 偏好域 ----
    if (platform !== 'darwin') {
      push('defaults', 'skip', '非 macOS，无偏好域');
    } else if (dryRun) {
      const probe = safeSpawn('defaults', ['read', 'com.ccm.menubar']);
      push('defaults', probe.status === 0 ? 'plan' : 'skip',
        probe.status === 0 ? '将清除偏好域 com.ccm.menubar' : '偏好域 com.ccm.menubar 不存在');
    } else {
      const r = safeSpawn('defaults', ['delete', 'com.ccm.menubar']);
      if (r.status === 0) push('defaults', 'done', '已清除偏好域 com.ccm.menubar');
      else push('defaults', 'skip', '偏好域 com.ccm.menubar 不存在');
    }

    // ---- 5. 两个 CLI 桥 + ~/.claude/ccm 残余 ----
    // 残余目录只在「桥确认已卸/本就未装」后才清：漂移或判定失败时 manifest 是后续人工
    // 卸载的凭据，删掉它等于把恢复 settings.json 的唯一线索也销毁。
    let residueOkAll = true;
    for (const bridge of BRIDGES) {
      const name = `bridge:${bridge.key}`;
      let residueOk = false;
      if (!existsSync(settingsPath)) {
        push(name, 'skip', '未安装（~/.claude/settings.json 不存在）');
        residueOk = true;
      } else {
        const s = safeSpawn(process.execPath, [bridge.script, 'status']);
        const parsed = parseJsonLine(s.stdout);
        if (s.status !== 0 || !parsed?.state) {
          push(name, 'error', `状态无法判定，保守跳过：${(s.stderr || '').trim().slice(0, 200)}`);
        } else if (parsed.state === 'not-installed') {
          push(name, 'skip', '未安装');
          residueOk = true;
        } else if (parsed.state === 'drifted') {
          push(name, 'refused', `settings.json 与安装清单不一致（你手动改过？），拒绝自动卸载。人工核对后跑 npm run ${bridge.npmScript}`);
        } else if (dryRun) {
          push(name, 'plan', '将卸载（按 manifest 恢复 settings.json 原条目）');
          residueOk = true;
        } else {
          const r = safeSpawn(process.execPath, [bridge.script, 'uninstall']);
          if (r.status === 0) {
            push(name, 'done', '已卸载，settings.json 已恢复原条目');
            residueOk = true;
          } else {
            push(name, 'refused', `卸载失败：${(r.stderr || '').trim().slice(0, 200)}`);
          }
        }
      }
      residueOkAll &&= residueOk;
      const residueDir = join(ccmDir, bridge.dir);
      if (residueOk && existsSync(residueDir)) {
        if (dryRun) {
          push(`residue:${bridge.key}`, 'plan', `将清理 ${residueDir}`);
        } else {
          // safe-rm: home 为注入参数（生产默认 homedir()），'.claude/ccm/<桥目录>' 各段全为
          // 本文件字面量；且仅在该桥确认「已卸载或未安装」后执行，漂移/判定失败一律不走到这里
          rmSync(residueDir, { recursive: true, force: true });
          push(`residue:${bridge.key}`, 'done', `已清理 ${residueDir}`);
        }
      }
    }
    if (residueOkAll && !dryRun && existsSync(ccmDir)) {
      let entries = readdirSync(ccmDir);
      if (entries.length === 1 && entries[0] === '.DS_Store') {
        unlinkSync(join(ccmDir, '.DS_Store')); // safe-path: 字面量文件名，目录为上面拼好的 ccmDir
        entries = [];
      }
      if (!entries.length) {
        rmdirSync(ccmDir); // safe-path: 非递归 rmdir，只删空目录，路径各段全字面量 + 注入 home
        push('residue:ccm', 'done', `已移除空目录 ${ccmDir}`);
      } else {
        push('residue:ccm', 'skip', `${ccmDir} 仍有未识别内容，保留：${entries.join('、')}`);
      }
    }

    // ---- 6. --purge：数据面 ----
    if (purge) {
      // 6a. 数据根：白名单逐项删，未知内容保留并报告（绝不整树 rmSync，理由见文件头）。
      if (!existsSync(dataDir)) {
        push('purge:data', 'skip', `数据根不存在：${dataDir}`);
      } else {
        let removed = 0;
        for (const fname of DATA_FILE_WHITELIST) {
          const p = join(dataDir, fname);
          if (!existsSync(p)) continue;
          if (!dryRun) unlinkSync(p); // safe-path: 文件名来自 DATA_FILE_WHITELIST 字面量表；dataDir 与 service.js 的 resolveManifestPath 同源解析
          removed++;
        }
        for (const dname of DATA_DIR_WHITELIST) {
          const p = join(dataDir, dname);
          if (!existsSync(p)) continue;
          // safe-rm: 目录名恒为字面量 'worktree-settings'，内容全部是 server 按 cwd 哈希生成的
          // 0600 settings 快照（src/server/app.js WORKTREE_SETTINGS_DIR），无用户手写文件
          if (!dryRun) rmSync(p, { recursive: true, force: true });
          removed++;
        }
        const leftovers = readdirSync(dataDir).filter((f) => !dryRun
          || (!DATA_FILE_WHITELIST.includes(f) && !DATA_DIR_WHITELIST.includes(f)));
        if (leftovers.length) {
          for (const f of leftovers) out(`  · 未识别，保留：${join(dataDir, f)}`);
          push('purge:data', dryRun ? 'plan' : 'done', `白名单 ${removed} 项${dryRun ? '将' : '已'}删除；${leftovers.length} 项未识别内容保留在 ${dataDir}`);
        } else {
          if (!dryRun) rmdirSync(dataDir); // safe-path: 非递归 rmdir，仅目录已空时执行
          push('purge:data', dryRun ? 'plan' : 'done', `白名单 ${removed} 项${dryRun ? '将' : '已'}删除，目录${dryRun ? '将' : '已'}清空移除`);
        }
      }

      // 6b. 仓库根配置文件。
      for (const fname of CONFIG_FILES) {
        const p = join(root, fname);
        if (!existsSync(p)) continue;
        if (dryRun) { push(`purge:config:${fname}`, 'plan', `将删除 ${p}`); continue; }
        unlinkSync(p); // safe-path: 文件名恒为 CONFIG_FILES 字面量之一；root 生产值为本仓根（import.meta 派生），测试注入 mkdtemp
        push(`purge:config:${fname}`, 'done', `已删除 ${p}`);
      }

      // 6c. 受管 unit 的日志（unit 列表取自卸载前的 manifest 快照；logName 出自代码内字面量表，
      // 不信 manifest 存的 LOG 路径——同 service.js 卸载不信 plistPath 的理由）。
      if (platform === 'darwin' && managedUnits.length) {
        const logsDir = join(home, 'Library', 'Logs');
        for (const unit of managedUnits) {
          const logName = SERVICE_UNIT_LOG_NAMES[unit];
          if (!logName) continue;
          const targets = [];
          if (existsSync(join(logsDir, logName))) targets.push(logName);
          if (existsSync(logsDir)) {
            const rotated = new RegExp(`^${escapeRegex(logName)}\\.\\d+\\.gz$`);
            targets.push(...readdirSync(logsDir).filter((f) => rotated.test(f)));
          }
          if (!targets.length) { push(`purge:logs:${unit}`, 'skip', '无日志文件'); continue; }
          if (dryRun) { push(`purge:logs:${unit}`, 'plan', `将删除 ${targets.join('、')}`); continue; }
          for (const f of targets) {
            unlinkSync(join(logsDir, f)); // safe-path: 文件名要么恒等于 service-units 字面量表里的 logName，要么被 ^logName.\d+.gz$ 锚定（rotate-logs.sh 的轮转产物形态）
          }
          push(`purge:logs:${unit}`, 'done', `已删除 ${targets.join('、')}`);
        }
      }

      // 6d. 各工作区 .ccm-uploads：只报不删（历史消息附件预览要读它）。
      const workdirs = Array.isArray(fileEnv.WORKDIRS)
        ? fileEnv.WORKDIRS.map((w) => (typeof w === 'string' ? w : w?.dir || w?.path)).filter(Boolean)
        : [];
      for (const dir of workdirs) {
        const uploads = join(dir, '.ccm-uploads');
        if (existsSync(uploads)) out(`  ⚠ 保留（只报不删，删了历史附件预览会断链）：${uploads}`);
      }
    }

    // ---- 收尾：永不动 + 手动清单 ----
    out('');
    out('以下永不由本命令触碰：~/.claude/projects（CLI transcript）、~/.cloudflared、');
    out('不在 manifest 的 launchd unit（含手工装的 com.ccm.tunnel*）、settings.json 里桥条目以外的内容。');
    out('浏览器/手机侧需手动：站点数据（localStorage/推送订阅）、已安装的 PWA。');

    const ok = !steps.some((s) => s.status === 'refused' || s.status === 'error');
    return { ok, steps };
  }

  return { run, paths: { dataDir, manifestPath, settingsPath, ccmDir } };
}

async function main(argv) {
  const flags = { yes: false, purge: false, dryRun: false };
  for (const a of argv) {
    if (a === '--yes' || a === '-y') flags.yes = true;
    else if (a === '--purge') flags.purge = true;
    else if (a === '--dry-run') flags.dryRun = true;
    else {
      process.stderr.write('usage: uninstall.js [--purge] [--dry-run] [--yes]\n'
        + '  默认只卸安装面（launchd 受管 unit / CCM.app / 偏好域 / 两个 CLI 桥）\n'
        + '  --purge   追加删除数据根白名单、仓库根配置文件、受管 unit 日志\n'
        + '  --dry-run 只打印将执行的动作，不动任何东西\n');
      process.exitCode = 64;
      return;
    }
  }
  const u = createUninstaller();
  process.stdout.write(`一键卸载${flags.purge ? '（含 --purge 数据面）' : ''} — 数据根：${u.paths.dataDir}\n\n`);

  process.stdout.write('计划（dry-run 预演）：\n');
  const plan = u.run({ purge: flags.purge, dryRun: true });
  if (flags.dryRun) {
    process.exitCode = plan.ok ? 0 : 1;
    return;
  }

  const isTty = !!(process.stdin.isTTY && process.stdout.isTTY);
  let answer = null;
  if (!flags.yes && isTty) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    answer = await rl.question(`\n确认执行卸载${flags.purge ? '（--purge 会删数据根/配置/日志，建议先备份）' : ''}？[y/N] `);
    rl.close();
  }
  const confirm = resolveUninstallConfirm({ yes: flags.yes, isTty, answer });
  if (!confirm.confirmed) {
    process.stderr.write('\n未确认，已取消（未动任何东西）。非交互环境请加 --yes。\n');
    process.exitCode = 1;
    return;
  }

  process.stdout.write('\n执行：\n');
  const result = u.run({ purge: flags.purge });
  process.stdout.write(result.ok ? '\n✓ 卸载完成\n' : '\n⚠ 部分步骤被拒绝或失败，见上方 ⚠ 行\n');
  process.exitCode = result.ok ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv.slice(2));
}
