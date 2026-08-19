#!/usr/bin/env node
// scripts/doctor.js —— 启动前配置自检
// 用法: node scripts/doctor.js [--env=path/to/.env] [--fix] [--full]
//
// 检查项（17 项，顺序与 main() 里的调用序列一一对应；增删项须同步这份清单）:
// 1. AUTH_TOKEN 非空且格式合理
// 2. CLAUDE_BIN 可执行（PATH 查找 claude 或环境变量指向存在）
// 3. WORK_DIR / WORK_DIRS 可写（多 repo 台阶1：白名单各目录）
// 4. PORT 未被占用（被自家 server unit 占用判 ok——桌面端拉着服务时那是正常态）
// 5. WEB_STATUSLINE 配置口径（web 自有状态栏默认自包含启用，可用 WEB_STATUSLINE=off 关闭）
// 6. CLI statusline bridge 安装态（只读 status；不安装、不改 ~/.claude）
// 7. 网关环境一致性（.env 若有 ANTHROPIC_* 提示已被剥除）
// 8. 配置文件权限（.env / data/*.json 是否为 owner-only 0600）
// 9. 文档一致性（死链 + 旧文件名漂移 + npm scripts + SDK 版本；防文档间漂移的机械化背书）
// 10. 前端 JS 语法（递归检查 public/js/**/*.js——冒烟不加载浏览器脚本，语法错会潜伏致「未连接」）
// 11. 测试覆盖率门槛（仅 --full；默认跳过——装机预检不该跑完整单测）
// 12. CLI hooks 桥安装态（只读 status；不安装、不改 ~/.claude）
// 13. 日志开关长开（DEBUG_SDK_MESSAGES/LOG_INTERACTIONS/LOG_STDERR + 日志体积）
// 14. CLAUDE_CONFIG_DIR 兼容性（CLI 认它、本仓固定读 ~/.claude；设了会静默读不到历史，见 doctor-checks.claudeConfigDirDiagnostic）
// 15. 附件占用可见性（各工作区 .ccm-uploads 体积；只报不删，见 doctor-checks.uploadsFootprintDiagnostic）
// 16. 桌面端服务安装态（只读 scripts/service.js status；不装、不改任何 plist）
// 17. 配置格式可见性（legacy .env 恒 ok 非 warn——一等路径不催迁，只在此告知迁移能力，见 doctor-checks.configFormatDiagnostic）
import { existsSync, accessSync, constants, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { execFileSync, execSync } from 'node:child_process';
import { homedir, platform } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConnection } from 'node:net';
import { isOwnerOnly, fixPermissions, resolveExecutableViaPath } from '../src/files/file-security.js';
import { normalizeWorkdirEntries, loadWorkdirsFile, resolveWorkdirsFilePath } from '../src/sessions/workdirs.js';
import { CONFIG_FILE_NAME, readConfigFileRaw, readConfigFileValues } from '../src/ops/config-file.js';
import { loadRuntimeEnvironment } from '../src/server/config.js';
import { checkDocConsistency as runDocConsistency, formatDocConsistency } from './doc-consistency.js';
import {
  claudeConfigDirDiagnostic,
  configFormatDiagnostic,
  hooksBridgeDiagnostic,
  logSwitchDiagnostic,
  portOccupancyDiagnostic,
  resolveServicePortOwner,
  serviceUnitsDiagnostic,
  statuslineBridgeDiagnostic,
  statuslineConfigDiagnostic,
  uploadsFootprintDiagnostic,
} from '../src/ops/doctor-checks.js';
import { CONFIG_FILE_NAMES } from '../src/ops/doctor-runtime.js'; // BE-013：与 UI 体检共用同一敏感文件清单
import { collectSyntaxFiles } from './collect-source-files.js';
import { detectLang } from './setup.js';

const HERE = dirname(dirname(fileURLToPath(import.meta.url)));
const results = [];

// 界面语言按环境 locale 自动选，与 scripts/setup.js 同一判据（zh_* → 中文，其余英文）。
//
// **刻意内联双语而不是像 setup.js 那样建 MESSAGES 字典**：那边的文案要在交互流程的多处复用，
// 起个 key 是值得的；doctor 的每条文案只用一次，内联能保证两个语言版本永远挨在一起 ——
// 字典方案下改中文忘了改英文，没有任何机制会发现。
const LANG = detectLang();
const bi = (zh, en) => (LANG === 'en' ? en : zh);

// 诊断结果类型
function ok(name, detail) { results.push({ name, status: 'ok', detail }); }
function warn(name, detail) { results.push({ name, status: 'warn', detail }); }
function fail(name, detail) { results.push({ name, status: 'fail', detail }); }

// 彩色输出
const colors = { ok: '\x1b[32m✓\x1b[0m', warn: '\x1b[33m⚠\x1b[0m', fail: '\x1b[31m✗\x1b[0m' };

function print() {
  console.log(bi('\n=== 配置诊断 ===\n', '\n=== Configuration diagnostics ===\n'));
  for (const r of results) {
    console.log(`${colors[r.status]} ${r.name}`);
    if (r.detail) console.log(`  ${r.detail}\n`);
  }
  const failed = results.filter(r => r.status === 'fail').length;
  const warned = results.filter(r => r.status === 'warn').length;
  console.log(bi(`=== 结果: ${results.length - failed - warned} 通过, ${warned} 警告, ${failed} 失败 ===\n`, `=== Result: ${results.length - failed - warned} passed, ${warned} warning(s), ${failed} failed ===\n`));
  process.exit(failed > 0 ? 1 : 0);
}

// ──────────────────────── 检查项 ────────────────────────

// D1: AUTH_TOKEN
function checkAuthToken() {
  const token = process.env.AUTH_TOKEN;
  if (token === undefined) {
    warn('AUTH_TOKEN', bi('未设置 → 仅监听 127.0.0.1（本机），无法从手机访问。需要手机访问请在配置里设置后重启。', 'Not set → binds 127.0.0.1 only; your phone cannot reach it. Set it in the config file and restart.'));
    return;
  }
  if (!token || !token.trim()) {
    fail('AUTH_TOKEN', bi('已设置但为空 → 仅监听 127.0.0.1。若要手机访问，设置非空 token。', 'Set but empty → binds 127.0.0.1 only. Use a non-empty token for phone access.'));
    return;
  }
  if (token.length < 8) {
    warn('AUTH_TOKEN', bi(`长度仅 ${token.length} 字符，建议 ≥16 字符（随机字符串）提高安全性。`, `Only ${token.length} characters; 16+ random characters is recommended.`));
  } else {
    ok('AUTH_TOKEN', bi(`已设置（${token.length} 字符）`, `Set (${token.length} characters)`));
  }
}

// D2: CLAUDE_BIN 可执行
function checkClaudeBin() {
  const explicit = process.env.CLAUDE_BIN;
  let claudePath = explicit;
  if (!claudePath) {
    claudePath = resolveExecutableViaPath('claude'); // POSIX which / win32 where
    if (!claudePath) {
      fail('CLAUDE_BIN', bi('未设置 CLAUDE_BIN 且 PATH 查找不到 claude。请确认 Claude Code CLI 已安装并在 PATH 中。', 'CLAUDE_BIN unset and no claude on PATH. Make sure the Claude Code CLI is installed and on PATH.'));
      return;
    }
  }
  if (!existsSync(claudePath)) {
    fail('CLAUDE_BIN', bi(`路径不存在: ${claudePath}`, `Path does not exist: ${claudePath}`));
    return;
  }
  try {
    accessSync(claudePath, constants.X_OK);
  } catch {
    fail('CLAUDE_BIN', bi(`路径存在但不可执行: ${claudePath}`, `Path exists but is not executable: ${claudePath}`));
    return;
  }
  // 检查版本
  try {
    const ver = execSync(`"${claudePath}" --version`, { encoding: 'utf8', timeout: 3000 }).trim();
    ok('CLAUDE_BIN', `${claudePath} — ${ver}`);
  } catch (err) {
    warn('CLAUDE_BIN', bi(`${claudePath} 可执行但 --version 失败: ${err.message}`, `${claudePath} is executable but --version failed: ${err.message}`));
  }
}

// D3: WORK_DIR / WORK_DIRS 可写
function checkWorkDir() {
  checkOneDir('WORK_DIR', process.env.WORK_DIR || homedir());
  // 多 repo 台阶1：WORK_DIRS 白名单各目录也需可写。soft：问题用 warn（server 启动期
  // 对无效项告警跳过、不挡启动，doctor 与之一致——不因可选切换目录有问题就 fail 整个自检）。
  // 解析统一走 workdirs.js（与 server.js preflight 单一事实源）：条目支持 string 或 {path, sessionLimit}。
  // 文件模式复用导出的 loadWorkdirsFile（read+parse+normalize→null），逗号模式走 normalizeWorkdirEntries。
  const { result, from, filePath } = resolveWorkdirSource();
  if (!result && from === 'WORK_DIRS_FILE') warn('WORK_DIRS_FILE', `读取/解析失败 (${filePath})`);
  if (result) {
    for (const w of result.warnings) warn('WORK_DIRS', w);
    for (const { path } of result.entries) checkOneDir('WORK_DIRS', path, true);
  }
}

function checkOneDir(label, dir, soft = false) {
  if (!existsSync(dir)) {
    if (soft) { warn(label, bi(`不存在: ${dir}（server 启动期会告警跳过此目录）`, `Missing: ${dir} (the server warns and skips it at startup)`)); return; }
    try {
      mkdirSync(dir, { recursive: true });
      ok(label, bi(`不存在已创建: ${dir}`, `Did not exist; created: ${dir}`));
    } catch (err) {
      fail(label, bi(`不存在且无法创建: ${dir} — ${err.message}`, `Missing and could not be created: ${dir} — ${err.message}`));
    }
    return;
  }
  try {
    accessSync(dir, constants.W_OK);
    ok(label, bi(`可写: ${dir}`, `Writable: ${dir}`));
  } catch {
    (soft ? warn : fail)(label, bi(`存在但不可写: ${dir}`, `Exists but is not writable: ${dir}`));
  }
}

// scripts/service.js status --json 的只读探针。D4 与 D16 共用一次结果（跑两遍等于两次 launchctl）。
// 与 D6/D12 同款 execFileSync 范式。读不到返回 null，两个检查项各自降级。
let _serviceStatus;
function readServiceStatus() {
  if (_serviceStatus !== undefined) return _serviceStatus;
  try {
    const raw = execFileSync(process.execPath, [join(HERE, 'scripts', 'service.js'), 'status', '--json'], {
      cwd: HERE,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 8000,
    });
    const parsed = JSON.parse(raw);
    _serviceStatus = parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    _serviceStatus = null;
  }
  return _serviceStatus;
}

// 端口是不是自家 server 占的。三个条件都要：unit 在跑、探到的端口一致、确实连得通。
// 不能只看「server 在跑」——doctor 支持 --env=other.env，那份 .env 的 PORT 可能与在跑的服务不同，
// 只看运行态会把「别的进程占了我要用的端口」误报成预期占用。
// 只负责取数；三条件判定在 doctor-checks.resolveServicePortOwner（纯函数、可测）。
// 判据留在这里时零覆盖 —— 改成无条件 return label 全套单测照样绿。
function servicePortOwner(port) {
  return resolveServicePortOwner({ status: readServiceStatus(), port });
}

// D4: PORT 未被占用（或被自家 server unit 占用——桌面端拉着服务时那是正常态，不是故障）
async function checkPort() {
  const port = parseInt(process.env.PORT || '3000', 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    const r = portOccupancyDiagnostic({ port: process.env.PORT || '3000', lang: LANG });
    fail(r.name, r.detail);
    return;
  }
  const probe = await new Promise(resolve => {
    const conn = createConnection({ port, host: '127.0.0.1' });
    conn.on('connect', () => { conn.destroy(); resolve({ occupied: true }); });
    conn.on('error', err => {
      resolve(err.code === 'ECONNREFUSED' ? { occupied: false } : { probeError: err.message });
    });
    setTimeout(() => { conn.destroy(); resolve({ probeError: '探测超时' }); }, 500); // 超时兜底
  });
  const ownerLabel = probe.occupied ? servicePortOwner(port) : null;
  const r = portOccupancyDiagnostic({ port, ...probe, ownerLabel, lang: LANG });
  ({ ok, warn, fail })[r.status](r.name, r.detail);
}

// D16: 桌面端服务安装态。与 D6/D12 同款只读探针；判定全在 doctor-checks.serviceUnitsDiagnostic，
// 与 UI 体检共用同一份（两处各写一份迟早分叉）。
function checkServiceUnits() {
  const s = readServiceStatus();
  const r = serviceUnitsDiagnostic({
    platform: s?.platform ?? platform(),
    supported: s?.supported ?? false,
    units: s?.units ?? null,
    lang: LANG,
  });
  ({ ok, warn, fail })[r.status](r.name, r.detail);
}

// D5: WEB_STATUSLINE 配置口径。E16 现在由 statusline.js 自包含组装，不依赖终端 statusLine 脚本或
// ~/.claude/settings.json；settings.json 仍会被 Claude CLI 自己用于 permissions.allow，但不是 web 状态栏前置条件。
function checkStatuslineConfig() {
  const result = statuslineConfigDiagnostic(process.env.WEB_STATUSLINE === 'off', LANG);
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
      const result = statuslineBridgeDiagnostic({ webOff, bridgeOff, installState: 'not-installed', lang: LANG });
      ok(result.name, result.detail);
      return;
    }
    const detail = (err?.stderr?.toString() || err?.message || '未知错误').split('\n').filter(Boolean)[0];
    warn('CLI_STATUSLINE_BRIDGE', bi(`无法只读检查安装状态：${detail}。运行 npm run statusline:status 查看详情。`, `Could not read install state: ${detail}. Run npm run statusline:status for details.`));
    return;
  }
  const result = statuslineBridgeDiagnostic({ webOff, bridgeOff, installState, lang: LANG });
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
      const result = hooksBridgeDiagnostic({ bridgeOff, installState: 'not-installed', lang: LANG });
      ok(result.name, result.detail);
      return;
    }
    const detail = (err?.stderr?.toString() || err?.message || '未知错误').split('\n').filter(Boolean)[0];
    warn('CLI_HOOKS_BRIDGE', bi(`无法只读检查安装状态：${detail}。运行 npm run hooks:status 查看详情。`, `Could not read install state: ${detail}. Run npm run hooks:status for details.`));
    return;
  }
  const result = hooksBridgeDiagnostic({ bridgeOff, installState, lang: LANG });
  (result.status === 'ok' ? ok : warn)(result.name, result.detail);
}

// D7: 网关环境一致性（配置文件里若有 ANTHROPIC_* 提示已被剥除）
//
// **两种格式都要查。** 这一项的全部价值是告诉用户「你写这儿没用」——只查 .env 的话，
// 新默认格式下它归零：写进 ccm.config.json 的 ANTHROPIC_* 照样被剥除，而 doctor 会对着
// 一份已经被忽略的 .env 报「✓ 不含 ANTHROPIC_*」。配置层确实会 warn，但 doctor 传的是 quiet。
function checkAnthropicEnv() {
  const NAME = bi('ANTHROPIC_* 环境', 'ANTHROPIC_* environment');
  // --env 指定时只查那一份（WS-011：诊断谁就查谁）；否则两份都查。
  const targets = envArg
    ? [EFFECTIVE.envFile]
    : [join(HERE, CONFIG_FILE_NAME), join(HERE, '.env')].filter(existsSync);

  if (!targets.length || (envArg && !existsSync(EFFECTIVE.envFile))) {
    ok(NAME, bi('未找到配置文件（可选）', 'No config file found (optional)'));
    return;
  }

  const offenders = [];
  for (const file of targets) {
    try {
      const raw = readFileSync(file, 'utf8');
      const hit = file.endsWith('.json')
        // JSON 侧比对键名，不用行正则：格式化后一个键可能跨行
        ? Object.keys(JSON.parse(raw)).some(k => /^ANTHROPIC_[A-Z_]+$/.test(k))
        : raw.split('\n').filter(l => l.trim() && !l.trim().startsWith('#'))
          .some(l => /^ANTHROPIC_[A-Z_]+=/.test(l.trim()));
      if (hit) offenders.push(basename(file));
    } catch (err) {
      warn(NAME, bi(`${basename(file)} 读取失败: ${err.message}`, `Could not read ${basename(file)}: ${err.message}`));
      return;
    }
  }

  if (offenders.length) {
    warn(NAME, bi(
      `${offenders.join(' / ')} 含 ANTHROPIC_* 变量 → 启动期会被剥除。\n`
      + '  模型/网关/凭据只能在启动 shell 里 export，不经配置文件设置（终端等价性）。\n'
      + '  若 web 端模型列表与终端不一致，检查启动 shell 的 ANTHROPIC_* 环境变量。',
      `${offenders.join(' / ')} contains ANTHROPIC_* variables → they are stripped at startup.\n`
      + '  Model / gateway / credentials must be exported in the launching shell, not set in a config file (terminal equivalence).\n'
      + "  If the web model list differs from your terminal, check the launching shell's ANTHROPIC_* variables."));
    return;
  }
  ok(NAME, bi(
    `${targets.map(f => basename(f)).join(' / ')} 不含 ANTHROPIC_* 变量（正确；网关配置应从 shell export）`,
    `${targets.map(f => basename(f)).join(' / ')} has no ANTHROPIC_* variables (correct: gateway config must come from the shell)`));
}


// D8: 配置文件权限（.env, data/*.json）。单一事实源列表：checkConfigPermissions 与 fixConfigFiles
// 共用 CONFIG_FILE_NAMES，防止两处各自维护的清单再次漏同步（trusted/pending-devices.json、
// cf-access-certs.json 此前就只在 devices.js/cf-access.js 里用 writeOwnerOnlyFile 写成 0600、
// 却没被这里检查/自动修复覆盖——同样敏感、被漏检）。
// BE-013：清单已上移至 doctor-runtime.js，CLI 检查与 UI 体检（countConfigPermProblems）共用同一份，防漂移。

function checkConfigPermissions() {
  if (platform() === 'win32') {
    ok(bi('配置文件权限', 'Config file permissions'), bi('Windows 平台跳过检查（不支持 POSIX 权限位）', 'Skipped on Windows (no POSIX permission bits)'));
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
    warn(bi('配置文件权限', 'Config file permissions'), problems.join('; ') + bi(
      '\n  运行 node scripts/doctor.js --fix 自动修复为 0600',
      '\n  Run node scripts/doctor.js --fix to tighten them to 0600'));
  } else {
    ok(bi('配置文件权限', 'Config file permissions'), bi('所有配置文件均为 owner-only (0600)', 'All config files are owner-only (0600)'));
  }
}

// D9: 文档一致性（死链 + 旧文件名漂移 + npm scripts + SDK 版本）。机械化背书单一事实源纪律：
// PostToolUse hook 只提示"检查同步"，本项把"检查什么"落为可失败的硬门——CI/提交前跑即拦住漂移。
function checkDocConsistency() {
  const result = runDocConsistency({ rootDir: HERE });
  if (result.problems.length > 0) {
    fail(bi('文档一致性', 'Docs consistency'), formatDocConsistency(result) + bi('\n  （单一事实源/防漂移纪律）', '\n  (single-source-of-truth / anti-drift discipline)'));
  } else {
    ok(bi('文档一致性', 'Docs consistency'), bi(`${result.docFiles.length} 份文档：链接/命令/SDK 版本一致`, `${result.docFiles.length} docs: links / commands / SDK versions consistent`));
  }
}

// D10: 前端 JS 语法（递归 public/js/**/*.js）。冒烟测试用 socket.io-client、从不加载浏览器 app.js，故前端脚本
// 的语法错会潜伏（2026-06-14 实有：app.js 括号失配→浏览器整体不执行→页面死在「未连接」）。
function checkFrontendSyntax() {
  let files;
  try {
    files = collectSyntaxFiles(HERE).filter(file => file.startsWith('public/js/'));
  } catch {
    warn(bi('前端 JS 语法', 'Frontend JS syntax'), bi('public/js/ 不存在，跳过', 'public/js/ not found, skipped'));
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
    fail(bi('前端 JS 语法', 'Frontend JS syntax'), bad.join('\n  ') + bi('\n  （浏览器脚本无单测覆盖，语法错会致页面死在「未连接」）', '\n  (browser scripts have no unit tests; a syntax error leaves the page stuck on the not-connected screen)'));
  } else {
    ok(bi('前端 JS 语法', 'Frontend JS syntax'), bi(`public/js/ ${files.length} 个文件（含 app/ 子模块）语法通过`, `public/js/: ${files.length} files (including app/ submodules) parse cleanly`));
  }
}

// D11: 测试覆盖率门槛（npm test --experimental-test-coverage）。
// 门槛与实测值都从子进程输出里读，不在这里复述常量——此处曾写死「≥ 65%」，而
// scripts/coverage-check.js 的默认门槛早已是 75，doctor 于是对着用户报了一个不存在的数字。
// 覆盖率是会持续变的量，任何抄写都会再次漂移，只能转述真实输出。
//
// 默认跳过：装机预检会因此再跑一遍完整单测（约一分钟），新用户只想知道 token/CLI/端口是否可用。
// 跳过后门槛由 CI 的 unit-test job 守（`.github/workflows/test.yml` 直接跑 coverage-check.js）；
// 本地要立刻知道就 `node scripts/doctor.js --full`。
// ★ 这里【不要】点名 `npm run check`：它的脚本链里没有 coverage-check，写上去就是又一次
//   「对着用户报一个不存在的东西」。tests/unit/coverage-check.test.mjs 会按 package.json 核对本段里
//   提到的每个 npm script。
function checkCoverageThreshold({ full = false } = {}) {
  if (!full) {
    ok(bi('测试覆盖率', 'Test coverage'), bi('已跳过（装机预检默认不跑单测；本地用 --full，CI 每次推送都跑）', 'Skipped (first-run doctor does not run the unit suite; use --full locally, CI runs it on every push)'));
    return;
  }
  try {
    const stdout = execSync('node scripts/coverage-check.js', { cwd: HERE, stdio: 'pipe', timeout: 120_000 }).toString();
    const actual = stdout.match(/行覆盖率:\s*([\d.]+)%/)?.[1];
    const threshold = stdout.match(/门槛:\s*([\d.]+)%/)?.[1];
    ok(bi('测试覆盖率', 'Test coverage'), actual && threshold ? bi(`行覆盖率 ${actual}%（门槛 ${threshold}%）`, `Line coverage ${actual}% (threshold ${threshold}%)`) : bi('达标', 'meets threshold'));
  } catch (err) {
    const msg = (err.stderr?.toString() || err.message || '').split('\n').filter(Boolean).slice(-3).join(' | ');
    warn(bi('测试覆盖率', 'Test coverage'), bi(`覆盖率检查未通过: ${msg || '超时或无法运行'}`, `Coverage check failed: ${msg || 'timed out or could not run'}`));
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
    lang: LANG,
    interactions: process.env.LOG_INTERACTIONS === '1',
    sdkDebug: !!process.env.DEBUG_SDK_MESSAGES,
    stderr: !!process.env.LOG_STDERR,
    logFileBytes,
  });
  (r.status === 'warn' ? warn : ok)(bi('日志开关', 'Log switches'), r.detail);
}

// CLAUDE_CONFIG_DIR：CLI 认、本仓不认。设了它 → 会话历史静默读不到，见 claudeConfigDirDiagnostic。
function checkClaudeConfigDir() {
  const r = claudeConfigDirDiagnostic({ configDir: process.env.CLAUDE_CONFIG_DIR || '', lang: LANG });
  (r.status === 'warn' ? warn : ok)('CLAUDE_CONFIG_DIR', r.detail);
}

// 工作区来源解析 —— **与 src/server/app.js 的 readWorkdirSource 同一优先级**：
// 内联 WORKDIRS > 外部 workdirs.json > 逗号串 WORK_DIRS。
// D3 与 workdirPaths 共用这一份：那条「同一解析口径」的注释以前只是口头约定，两处各写一遍，
// 加第三条路径时必然只改一处 —— 而 doctor 的全部价值就在于「它看到的 = server 会看到的」。
function resolveWorkdirSource() {
  // ★ 跟随**被诊断的**配置：--env=prod.env 时不能去读仓库根那份 ccm.config.json，
  // 否则 doctor 检查的是本仓库的工作区、却报给你 prod 的诊断结论 —— 正是 WS-011 声明要消灭的假绿。
  const inline = envArg ? null : readConfigFileRaw(HERE)?.WORKDIRS;
  if (Array.isArray(inline)) return { result: normalizeWorkdirEntries(inline), from: 'WORKDIRS' };
  const dirsFile = process.env.WORK_DIRS_FILE;
  if (dirsFile) {
    const filePath = resolveWorkdirsFilePath(dirsFile, HERE);
    return { result: loadWorkdirsFile(filePath), from: 'WORK_DIRS_FILE', filePath };
  }
  const raw = (process.env.WORK_DIRS || '').split(',').map(s => s.trim()).filter(Boolean);
  return { result: normalizeWorkdirEntries(raw), from: 'WORK_DIRS' };
}

// 白名单工作目录清单（与 checkWorkDir 同一解析口径，只取路径不做可写校验）。
function workdirPaths() {
  const out = [process.env.WORK_DIR || homedir()];
  const { result } = resolveWorkdirSource();
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
  const r = uploadsFootprintDiagnostic({ dirs, lang: LANG });
  (r.status === 'warn' ? warn : ok)(bi('附件占用', 'Attachment footprint'), r.detail);
}

// D17: 配置格式可见性。source 来自上面 readConfigFileValues 的结果——与 server 同一条读取路径。
function checkConfigFormat() {
  // 解析失败要原样传下去，**不能压成 source:'none'**：那会让「配置坏了」和「还没配置」变成同一格，
  // 整份体检据此 exit 0，而 server 用同一个文件根本起不来。
  const r = configFormatDiagnostic({
    source: loaded.error ? 'none' : (loaded.source || 'none'),
    error: loaded.error || null,
    lang: LANG,
  });
  (r.status === 'fail' ? fail : ok)(bi('配置格式', 'Config format'), r.detail);
}

// ──────────────────────── 主流程 ────────────────────────

// 解析命令行 --env / --fix / --full
const envArg = process.argv.find(a => a.startsWith('--env='));
const shouldFix = process.argv.includes('--fix');
const shouldFull = process.argv.includes('--full');
const envFile = envArg ? envArg.split('=')[1] : join(HERE, '.env');
if (envArg && !existsSync(envFile)) {
  console.error(`错误: 指定的 .env 文件不存在: ${envFile}`);
  process.exit(1);
}

// 配置加载走 server 的同一条路径（loadRuntimeEnvironment），而不是自己 dotenv.config 一次。
// 理由是判据必须同源：doctor 的全部价值在于「它看到的 = server 启动时会看到的」。自己解析一份
// 就会有分叉——而 setup.js 现在默认生成的是 ccm.config.json，旧的 dotenv 路径对它完全失明，
// 新装用户跑 doctor 会被告知「未设置 AUTH_TOKEN」，照着改了还是没用。
const loaded = readConfigFileValues(HERE, envArg ? { envFile } : {});
if (loaded.error) {
  // ★ 必须先报再加载：loadRuntimeEnvironment 对坏 JSON 是 fail-loud（会抛），排在这之前的话
  // doctor 直接崩栈、16 项体检一项都不跑 —— 而诊断坏配置正是它存在的理由。
  console.error(bi(`⚠️  配置文件解析失败：${loaded.error}`, `⚠️  Could not parse the config file: ${loaded.error}`));
} else if (loaded.source !== 'none') {
  console.log(bi(`已加载: ${loaded.path}`, `Loaded: ${loaded.path}`));
}
try {
  loadRuntimeEnvironment(process.env, envArg ? { envFile } : { dir: HERE, quiet: true });
} catch (err) {
  console.error(bi(`⚠️  配置加载失败，后续检查基于不完整的环境：${err?.message || err}`, `⚠️  Config load failed; checks below run on an incomplete environment: ${err?.message || err}`));
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
    // '.env' 映射到**被诊断的**那份（--env=prod.env 时不是仓库里这份）；
    // 其余项目根文件（ccm.config.json）按仓库根解析；data/* 挂到实际数据目录。
    if (name === '.env') return { path: EFFECTIVE.envFile, name };
    if (!name.startsWith('data')) return { path: join(HERE, name), name };
    const base = name.replace(/^data[/\\]/, '');
    return { path: join(EFFECTIVE.dataDir, base), name };
  });
}

// 执行 17 项检查（D4 端口检查是 async，需 await）
(async () => {
  checkAuthToken();
  checkClaudeBin();
  checkWorkDir();
  await checkPort();
  checkStatuslineConfig();
  checkStatuslineBridge();
  checkAnthropicEnv();
  checkConfigPermissions();
  checkConfigFormat();
  checkDocConsistency();
  checkFrontendSyntax();
  checkCoverageThreshold({ full: shouldFull });
  checkHooksBridge();
  checkLogSwitches();
  checkClaudeConfigDir();
  checkUploadsFootprint();
  checkServiceUnits();

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
