#!/usr/bin/env node
// scripts/doctor.js —— 启动前配置自检
// 用法: node scripts/doctor.js [--env=path/to/.env] [--fix]
//
// 检查项（12 项）:
// 1. AUTH_TOKEN 非空且格式合理
// 2. CLAUDE_BIN 可执行（PATH 查找 claude 或环境变量指向存在）
// 3. WORK_DIR / WORK_DIRS 可写（多 repo 台阶1：白名单各目录）
// 4. PORT 未被占用
// 5. WEB_STATUSLINE 配置口径（web 自有状态栏默认自包含启用，可用 WEB_STATUSLINE=off 关闭）
// 6. CLI statusline bridge 安装态（只读 status；不安装、不改 ~/.claude）
// 7. 网关环境一致性（.env 若有 ANTHROPIC_* 提示已被剥除）
// 8. 配置文件权限（.env / data/*.json 是否为 owner-only 0600）
// 9. 文档一致性（死链 + 旧文件名漂移 + npm scripts + SDK 版本；防文档间漂移的机械化背书）
// 10. 前端 JS 语法（递归检查 public/js/**/*.js——冒烟不加载浏览器脚本，语法错会潜伏致「未连接」）
// 11. 测试覆盖率门槛
// 12. CLI hooks 桥安装态（只读 status；不安装、不改 ~/.claude）
// 13. 日志开关长开（DEBUG_SDK_MESSAGES/LOG_INTERACTIONS/LOG_STDERR + 日志体积）
import { config } from 'dotenv';
import { existsSync, accessSync, constants, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { execFileSync, execSync } from 'node:child_process';
import { homedir, platform } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConnection } from 'node:net';
import { isOwnerOnly, fixPermissions, resolveExecutableViaPath } from '../src/files/file-security.js';
import { normalizeWorkdirEntries, loadWorkdirsFile, resolveWorkdirsFilePath } from '../src/sessions/workdirs.js';
import { checkDocConsistency as runDocConsistency, formatDocConsistency } from './doc-consistency.js';
import { hooksBridgeDiagnostic, statuslineBridgeDiagnostic, statuslineConfigDiagnostic, logSwitchDiagnostic, uploadsFootprintDiagnostic } from '../src/ops/doctor-checks.js';
import { CONFIG_FILE_NAMES } from '../src/ops/doctor-runtime.js'; // BE-013：与 UI 体检共用同一敏感文件清单
import { collectSyntaxFiles } from './collect-source-files.js';

const HERE = dirname(dirname(fileURLToPath(import.meta.url)));
const results = [];

// 诊断结果类型
function ok(name, detail) { results.push({ name, status: 'ok', detail }); }
function warn(name, detail) { results.push({ name, status: 'warn', detail }); }
function fail(name, detail) { results.push({ name, status: 'fail', detail }); }

// 彩色输出
const colors = { ok: '\x1b[32m✓\x1b[0m', warn: '\x1b[33m⚠\x1b[0m', fail: '\x1b[31m✗\x1b[0m' };

function print() {
  console.log('\n=== 配置诊断 ===\n');
  for (const r of results) {
    console.log(`${colors[r.status]} ${r.name}`);
    if (r.detail) console.log(`  ${r.detail}\n`);
  }
  const failed = results.filter(r => r.status === 'fail').length;
  const warned = results.filter(r => r.status === 'warn').length;
  console.log(`=== 结果: ${results.length - failed - warned} 通过, ${warned} 警告, ${failed} 失败 ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

// ──────────────────────── 检查项 ────────────────────────

// D1: AUTH_TOKEN
function checkAuthToken() {
  const token = process.env.AUTH_TOKEN;
  if (token === undefined) {
    warn('AUTH_TOKEN', '未设置 → 仅监听 127.0.0.1（本机），无法从手机访问。需要手机访问请在 .env 设置后重启。');
    return;
  }
  if (!token || !token.trim()) {
    fail('AUTH_TOKEN', '已设置但为空 → 仅监听 127.0.0.1。若要手机访问，设置非空 token。');
    return;
  }
  if (token.length < 8) {
    warn('AUTH_TOKEN', `长度仅 ${token.length} 字符，建议 ≥16 字符（随机字符串）提高安全性。`);
  } else {
    ok('AUTH_TOKEN', `已设置（${token.length} 字符）`);
  }
}

// D2: CLAUDE_BIN 可执行
function checkClaudeBin() {
  const explicit = process.env.CLAUDE_BIN;
  let claudePath = explicit;
  if (!claudePath) {
    claudePath = resolveExecutableViaPath('claude'); // POSIX which / win32 where
    if (!claudePath) {
      fail('CLAUDE_BIN', '未设置 CLAUDE_BIN 且 PATH 查找不到 claude。请确认 Claude Code CLI 已安装并在 PATH 中。');
      return;
    }
  }
  if (!existsSync(claudePath)) {
    fail('CLAUDE_BIN', `路径不存在: ${claudePath}`);
    return;
  }
  try {
    accessSync(claudePath, constants.X_OK);
  } catch {
    fail('CLAUDE_BIN', `路径存在但不可执行: ${claudePath}`);
    return;
  }
  // 检查版本
  try {
    const ver = execSync(`"${claudePath}" --version`, { encoding: 'utf8', timeout: 3000 }).trim();
    ok('CLAUDE_BIN', `${claudePath} — ${ver}`);
  } catch (err) {
    warn('CLAUDE_BIN', `${claudePath} 可执行但 --version 失败: ${err.message}`);
  }
}

// D3: WORK_DIR / WORK_DIRS 可写
function checkWorkDir() {
  checkOneDir('WORK_DIR', process.env.WORK_DIR || homedir());
  // 多 repo 台阶1：WORK_DIRS 白名单各目录也需可写。soft：问题用 warn（server 启动期
  // 对无效项告警跳过、不挡启动，doctor 与之一致——不因可选切换目录有问题就 fail 整个自检）。
  // 解析统一走 workdirs.js（与 server.js preflight 单一事实源）：条目支持 string 或 {path, sessionLimit}。
  // 文件模式复用导出的 loadWorkdirsFile（read+parse+normalize→null），逗号模式走 normalizeWorkdirEntries。
  let result;
  const dirsFile = process.env.WORK_DIRS_FILE;
  if (dirsFile) {
    const filePath = resolveWorkdirsFilePath(dirsFile, HERE);
    result = loadWorkdirsFile(filePath);
    if (!result) warn('WORK_DIRS_FILE', `读取/解析失败 (${filePath})`);
  } else {
    result = normalizeWorkdirEntries((process.env.WORK_DIRS || '').split(',').map(s => s.trim()).filter(Boolean));
  }
  if (result) {
    for (const w of result.warnings) warn('WORK_DIRS', w);
    for (const { path } of result.entries) checkOneDir('WORK_DIRS', path, true);
  }
}

function checkOneDir(label, dir, soft = false) {
  if (!existsSync(dir)) {
    if (soft) { warn(label, `不存在: ${dir}（server 启动期会告警跳过此目录）`); return; }
    try {
      mkdirSync(dir, { recursive: true });
      ok(label, `不存在已创建: ${dir}`);
    } catch (err) {
      fail(label, `不存在且无法创建: ${dir} — ${err.message}`);
    }
    return;
  }
  try {
    accessSync(dir, constants.W_OK);
    ok(label, `可写: ${dir}`);
  } catch {
    (soft ? warn : fail)(label, `存在但不可写: ${dir}`);
  }
}

// D4: PORT 未被占用
async function checkPort() {
  const port = parseInt(process.env.PORT || '3000', 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    fail('PORT', `无效端口: ${process.env.PORT || '3000'}`);
    return;
  }
  return new Promise(resolve => {
    const conn = createConnection({ port, host: '127.0.0.1' });
    conn.on('connect', () => {
      conn.destroy();
      fail('PORT', `端口 ${port} 已被占用（可能上次未干净停止）。请 kill 旧进程或换端口。`);
      resolve();
    });
    conn.on('error', err => {
      if (err.code === 'ECONNREFUSED') {
        ok('PORT', `端口 ${port} 可用`);
      } else {
        warn('PORT', `端口 ${port} 探测失败: ${err.message}`);
      }
      resolve();
    });
    setTimeout(() => { conn.destroy(); resolve(); }, 500); // 超时兜底
  });
}

// D5: WEB_STATUSLINE 配置口径。E16 现在由 statusline.js 自包含组装，不依赖终端 statusLine 脚本或
// ~/.claude/settings.json；settings.json 仍会被 Claude CLI 自己用于 permissions.allow，但不是 web 状态栏前置条件。
function checkStatuslineConfig() {
  const result = statuslineConfigDiagnostic(process.env.WEB_STATUSLINE === 'off');
  (result.status === 'ok' ? ok : warn)(result.name, result.detail);
}

// D6: CLI statusline bridge 安装态。status 子命令是只读探针：不创建 manifest、不改 settings。
// 这里只消费 state，不回显 currentCommand，避免 doctor 输出用户自定义命令内容。
function checkStatuslineBridge() {
  const webOff = process.env.WEB_STATUSLINE === 'off';
  const bridgeOff = process.env.CLI_STATUSLINE_BRIDGE === 'off';
  let installState;
  try {
    const raw = execFileSync(process.execPath, [join(HERE, 'scripts', 'statusline-bridge-setup.js'), 'status'], {
      cwd: HERE,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 3000,
    });
    const parsed = JSON.parse(raw);
    if (!['installed', 'not-installed', 'drifted'].includes(parsed?.state)) {
      throw new Error('status 返回了未知状态');
    }
    installState = parsed.state;
  } catch (err) {
    if (webOff || bridgeOff) {
      const result = statuslineBridgeDiagnostic({ webOff, bridgeOff, installState: 'not-installed' });
      ok(result.name, result.detail);
      return;
    }
    const detail = (err?.stderr?.toString() || err?.message || '未知错误').split('\n').filter(Boolean)[0];
    warn('CLI_STATUSLINE_BRIDGE', `无法只读检查安装状态：${detail}。运行 \`npm run statusline:status\` 查看详情。`);
    return;
  }
  const result = statuslineBridgeDiagnostic({ webOff, bridgeOff, installState });
  (result.status === 'ok' ? ok : warn)(result.name, result.detail);
}

// D12: CLI hooks 桥安装态。与 D6 同款：execFileSync 调只读 status 子命令，只消费 state。
function checkHooksBridge() {
  const bridgeOff = process.env.CLI_HOOKS_BRIDGE === 'off';
  let installState;
  try {
    const raw = execFileSync(process.execPath, [join(HERE, 'scripts', 'hooks-bridge-setup.js'), 'status'], {
      cwd: HERE,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 3000,
    });
    const parsed = JSON.parse(raw);
    if (!['installed', 'not-installed', 'drifted'].includes(parsed?.state)) {
      throw new Error('status 返回了未知状态');
    }
    installState = parsed.state;
  } catch (err) {
    if (bridgeOff) {
      const result = hooksBridgeDiagnostic({ bridgeOff, installState: 'not-installed' });
      ok(result.name, result.detail);
      return;
    }
    const detail = (err?.stderr?.toString() || err?.message || '未知错误').split('\n').filter(Boolean)[0];
    warn('CLI_HOOKS_BRIDGE', `无法只读检查安装状态：${detail}。运行 \`npm run hooks:status\` 查看详情。`);
    return;
  }
  const result = hooksBridgeDiagnostic({ bridgeOff, installState });
  (result.status === 'ok' ? ok : warn)(result.name, result.detail);
}

// D7: 网关环境一致性（.env 若有 ANTHROPIC_* 提示已被剥除）
function checkAnthropicEnv() {
  const envPath = EFFECTIVE.envFile; // WS-011：读被诊断的 .env（--env 指定），非硬编码仓库 HERE/.env
  if (!existsSync(envPath)) {
    ok('ANTHROPIC_* 环境', '.env 不存在（可选）');
    return;
  }
  try {
    const raw = readFileSync(envPath, 'utf8');
    const lines = raw.split('\n').filter(l => l.trim() && !l.trim().startsWith('#'));
    const hasAnthropicKeys = lines.some(l => /^ANTHROPIC_[A-Z_]+=/.test(l.trim()));
    if (hasAnthropicKeys) {
      warn('ANTHROPIC_* 环境',
        `.env 含 ANTHROPIC_* 变量 → 启动期会被剥除。\n` +
        `  模型/网关/凭据只能在启动 shell 里 export，不经 .env 配置（终端等价性）。\n` +
        `  若 web 端模型列表与终端不一致，检查启动 shell 的 ANTHROPIC_* 环境变量。`);
    } else {
      ok('ANTHROPIC_* 环境', '.env 不含 ANTHROPIC_* 变量（正确；网关配置应从 shell export）');
    }
  } catch (err) {
    warn('ANTHROPIC_* 环境', `.env 读取失败: ${err.message}`);
  }
}

// D8: 配置文件权限（.env, data/*.json）。单一事实源列表：checkConfigPermissions 与 fixConfigFiles
// 共用 CONFIG_FILE_NAMES，防止两处各自维护的清单再次漏同步（trusted/pending-devices.json、
// cf-access-certs.json 此前就只在 devices.js/cf-access.js 里用 writeOwnerOnlyFile 写成 0600、
// 却没被这里检查/自动修复覆盖——同样敏感、被漏检）。
// BE-013：清单已上移至 doctor-runtime.js，CLI 检查与 UI 体检（countConfigPermProblems）共用同一份，防漂移。

function checkConfigPermissions() {
  if (platform() === 'win32') {
    ok('配置文件权限', 'Windows 平台跳过检查（不支持 POSIX 权限位）');
    return;
  }

  const files = effectiveConfigFiles(); // WS-011：检查 effective 上下文的 .env + 数据目录，非硬编码仓库路径

  const problems = [];
  for (const { path, name } of files) {
    if (!existsSync(path)) continue;
    if (!isOwnerOnly(path)) {
      problems.push(`${name} 权限过宽（非 0600）`);
    }
  }

  if (problems.length > 0) {
    warn('配置文件权限',
      problems.join('; ') + '\n  运行 `node scripts/doctor.js --fix` 自动修复为 0600');
  } else {
    ok('配置文件权限', '所有配置文件均为 owner-only (0600)');
  }
}

// D9: 文档一致性（死链 + 旧文件名漂移 + npm scripts + SDK 版本）。机械化背书单一事实源纪律：
// PostToolUse hook 只提示"检查同步"，本项把"检查什么"落为可失败的硬门——CI/提交前跑即拦住漂移。
function checkDocConsistency() {
  const result = runDocConsistency({ rootDir: HERE });
  if (result.problems.length > 0) {
    fail('文档一致性', formatDocConsistency(result) + '\n  （单一事实源/防漂移纪律）');
  } else {
    ok('文档一致性', `${result.docFiles.length} 份文档：链接/命令/SDK 版本一致`);
  }
}

// D10: 前端 JS 语法（递归 public/js/**/*.js）。冒烟测试用 socket.io-client、从不加载浏览器 app.js，故前端脚本
// 的语法错会潜伏（2026-06-14 实有：app.js 括号失配→浏览器整体不执行→页面死在「未连接」）。
function checkFrontendSyntax() {
  let files;
  try {
    files = collectSyntaxFiles(HERE).filter(file => file.startsWith('public/js/'));
  } catch {
    warn('前端 JS 语法', 'public/js/ 不存在，跳过');
    return;
  }
  const bad = [];
  for (const f of files) {
    try {
      execFileSync(process.execPath, ['--check', join(HERE, f)], { stdio: 'pipe' });
    } catch (err) {
      const msg = (err.stderr?.toString() || err.message || '').split('\n').slice(0, 3).join(' ').trim();
      bad.push(`${f}: ${msg}`);
    }
  }
  if (bad.length > 0) {
    fail('前端 JS 语法', bad.join('\n  ') + '\n  （浏览器脚本无单测覆盖，语法错会致页面死在「未连接」）');
  } else {
    ok('前端 JS 语法', `public/js/ ${files.length} 个文件（含 app/ 子模块）语法通过`);
  }
}

// D11: 测试覆盖率门槛（npm test --experimental-test-coverage）。
// 门槛与实测值都从子进程输出里读，不在这里复述常量——此处曾写死「≥ 65%」，而
// scripts/coverage-check.js 的默认门槛早已是 75，doctor 于是对着用户报了一个不存在的数字。
// 覆盖率是会持续变的量，任何抄写都会再次漂移，只能转述真实输出。
function checkCoverageThreshold() {
  try {
    const stdout = execSync('node scripts/coverage-check.js', { cwd: HERE, stdio: 'pipe', timeout: 120_000 }).toString();
    const actual = stdout.match(/行覆盖率:\s*([\d.]+)%/)?.[1];
    const threshold = stdout.match(/门槛:\s*([\d.]+)%/)?.[1];
    ok('测试覆盖率', actual && threshold ? `行覆盖率 ${actual}%（门槛 ${threshold}%）` : '达标');
  } catch (err) {
    const msg = (err.stderr?.toString() || err.message || '').split('\n').filter(Boolean).slice(-3).join(' | ');
    warn('测试覆盖率', `覆盖率检查未通过: ${msg || '超时或无法运行'}`);
  }
}

// D13: 日志开关长开。DEBUG_SDK_MESSAGES 长开曾把日志刷到 149MB 而事后才被发现（2026-07-18 归档实测），
// 此前 doctor 对三个开关零感知，服务状态面板是唯一可见性（app.js logging 字段）——那要人主动去看。
//
// 读 process.env 而非解析 .env 原文：上面 config({ path: envFile }) 已把被诊断的 .env 灌进
// process.env，而 dotenv 默认不覆盖已存在的值，所以 process.env 恰好是「shell export 优先、.env 补充」
// 的实际生效态。只读 .env 文件会漏掉 shell export 的开关（doctor 曾因只读文件而给出恒绿假 OK）。
//
// 三个开关的判定口径【故意不统一】，逐字对齐运行时，否则 doctor 报的和实际生效的不是一回事：
//   LOG_INTERACTIONS 严格 === '1'（interaction-log.js:12）
//   DEBUG_SDK_MESSAGES / LOG_STDERR 是 truthy（agent.js:428 / :144）
// 后两个写成 LOG_STDERR=false 反而是【开着】——这正是本检查能顺带暴露的脚枪。
function checkLogSwitches() {
  let logFileBytes = 0;
  // LOG_FILE 留空时的默认路径只在 macOS 部署约定下成立（同 log-terminal.js / rotate-logs.sh）；
  // 其它平台或文件不存在时按 0 处理，让判定退化为「只看开关」而不是误报体积。
  const logFile = process.env.LOG_FILE
    || (platform() === 'darwin' ? join(homedir(), 'Library', 'Logs', 'ccm-server.log') : '');
  if (logFile) {
    try { logFileBytes = statSync(logFile).size; } catch { /* 不存在/无权限：按 0，不影响开关判定 */ }
  }
  const r = logSwitchDiagnostic({
    interactions: process.env.LOG_INTERACTIONS === '1',
    sdkDebug: !!process.env.DEBUG_SDK_MESSAGES,
    stderr: !!process.env.LOG_STDERR,
    logFileBytes,
  });
  (r.status === 'warn' ? warn : ok)('日志开关', r.detail);
}

// 白名单工作目录清单（与 checkWorkDir 同一解析口径，只取路径不做可写校验）。
function workdirPaths() {
  const out = [process.env.WORK_DIR || homedir()];
  const dirsFile = process.env.WORK_DIRS_FILE;
  const result = dirsFile
    ? loadWorkdirsFile(resolveWorkdirsFilePath(dirsFile, HERE))
    : normalizeWorkdirEntries((process.env.WORK_DIRS || '').split(',').map(s => s.trim()).filter(Boolean));
  if (result) for (const { path } of result.entries) out.push(path);
  return [...new Set(out)];
}

// R9：手机上传附件的磁盘占用可见性。只报不删——理由见 uploadsFootprintDiagnostic 的头注释。
function checkUploadsFootprint() {
  const dirs = [];
  for (const cwd of workdirPaths()) {
    const dir = join(cwd, '.ccm-uploads');
    let bytes = 0;
    let files = 0;
    try {
      for (const name of readdirSync(dir)) {
        try { bytes += statSync(join(dir, name)).size; files += 1; }
        catch { /* 读取中被删/无权限：跳过该文件 */ }
      }
    } catch { continue; } // 目录不存在 = 该工作区没传过附件
    dirs.push({ cwd, bytes, files });
  }
  const r = uploadsFootprintDiagnostic({ dirs });
  (r.status === 'warn' ? warn : ok)('附件占用', r.detail);
}

// ──────────────────────── 主流程 ────────────────────────

// 解析命令行 --env 和 --fix
const envArg = process.argv.find(a => a.startsWith('--env='));
const shouldFix = process.argv.includes('--fix');
const envFile = envArg ? envArg.split('=')[1] : join(HERE, '.env');
if (existsSync(envFile)) {
  config({ path: envFile });
  console.log(`已加载: ${envFile}`);
} else if (envArg) {
  console.error(`错误: 指定的 .env 文件不存在: ${envFile}`);
  process.exit(1);
}

// WS-011：统一 effective config 上下文。旧实现 --env 只影响 dotenv 加载（改 process.env），D6/D7/--fix 仍硬读
// 仓库 HERE/.env 与 HERE/data → 诊断指定 prod 配置时检查的是本仓库文件、给出假绿。此处据 --env 解析出被诊断
// 配置的实际 .env 与数据目录，加载/检查/--fix 全用同一上下文。dataDir 取 CCM_DATA_DIR（可能由刚加载的 env
// 文件设定）否则回退 HERE/data；常规无 --env / 无 CCM_DATA_DIR 场景等价旧行为，无回归。
const EFFECTIVE = {
  envFile,
  dataDir: process.env.CCM_DATA_DIR || join(HERE, 'data'),
};
// 把 CONFIG_FILE_NAMES（单一事实源清单）映射到 effective 绝对路径：'.env' → 被诊断的 envFile；
// 'data/xxx.json' → 实际数据目录下的 xxx.json。
function effectiveConfigFiles() {
  return CONFIG_FILE_NAMES.map(name => {
    if (name === '.env') return { path: EFFECTIVE.envFile, name };
    const base = name.replace(/^data[/\\]/, '');
    return { path: join(EFFECTIVE.dataDir, base), name };
  });
}

// 执行 12 项检查（D4 端口检查是 async，需 await）
(async () => {
  checkAuthToken();
  checkClaudeBin();
  checkWorkDir();
  await checkPort();
  checkStatuslineConfig();
  checkStatuslineBridge();
  checkAnthropicEnv();
  checkConfigPermissions();
  checkDocConsistency();
  checkFrontendSyntax();
  checkCoverageThreshold();
  checkHooksBridge();
  checkLogSwitches();
  checkUploadsFootprint();

  // --fix 选项：自动修复权限
  if (shouldFix) {
    console.log('\n=== 执行权限修复 ===\n');
    fixConfigFiles();
  }

  print();
})();

// 权限修复函数
function fixConfigFiles() {
  if (platform() === 'win32') {
    console.log('Windows 平台不支持权限修复\n');
    return;
  }

  const files = effectiveConfigFiles().map(f => f.path); // WS-011：--fix 修的是 effective 上下文的文件，与检查同源

  let fixed = 0;
  let skipped = 0;
  for (const path of files) {
    if (!existsSync(path)) {
      skipped++;
      continue;
    }
    if (fixPermissions(path)) {
      console.log(`✓ 修复 ${path} → 0600`);
      fixed++;
    } else {
      console.log(`✗ 修复失败: ${path}`);
    }
  }

  console.log(`\n修复完成: ${fixed} 个文件，${skipped} 个跳过（不存在）\n`);
}
