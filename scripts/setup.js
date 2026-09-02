#!/usr/bin/env node
// scripts/setup.js —— 一键配置向导：生成 ccm.config.json（AUTH_TOKEN + WORK_DIR），零依赖。
// 用法: node scripts/setup.js [--config <path>]                                     # 交互向导（人用）
//       node scripts/setup.js --yes --work-dir=<path> [--hooks=on|off] [--desktop=on|off] [--force]  # 非交互（编程 agent 用）
//   覆盖最简路径（同 WiFi / 临时公网）的核心配置。头号门槛是「必须设 AUTH_TOKEN,
//   否则只绑 127.0.0.1、手机连不上」——向导默认帮你生成。
//   公网固定部署（Cloudflare Access 2FA / 隧道 / 常驻）不在向导内，见 docs/deployment.md。
//   界面语言按环境 locale 自动选：zh_* → 中文，其余 → 英文。
//
// 为什么有非交互模式：README 一直建议「把安装丢给编程 agent 代跑」，但 agent 的 shell 没有 TTY，
// stdin 立刻 EOF → 旧实现会打出覆盖提示后 exit 0、一个字没写。无 TTY 现在直接拒绝，
// 必须用 --yes --work-dir --hooks 把意图写全。两个危险默认一律不许静默生效：
//   · WORK_DIR 不回落 $HOME（那等于把整个家目录交给远程入口）——必须显式且不能是家目录
//   · hooks 不默认装（那会写用户全局 ~/.claude/settings.json）——必须显式 --hooks=on
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { basename, join, dirname, resolve, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { writeOwnerOnlyFile } from '../src/files/file-security.js';
import { applyConfigChanges, CONFIG_FILE_NAME } from '../src/ops/config-file.js';
import { ACCESS_PROFILES } from '../src/ops/env-schema.js';

const HERE = dirname(dirname(fileURLToPath(import.meta.url)));

// ──────────────────────── 纯逻辑（可单测）────────────────────────

// 生成十六进制随机 token（默认 32 字节 = 64 hex 字符）。
export function generateToken(bytes = 32) {
  return randomBytes(bytes).toString('hex');
}

// 生成统一配置文件 ccm.config.json 的内容（P1b 起的默认格式）。
//
// 结构化构造：写出去的就是数据本身，不存在旧模板替换时代「正则没匹配上就静默不生效」的
// 失败模式（那套 buildEnvContent + .env.example 已于 2026-08-17 随「生成旧格式」能力一并
// 退役——它面向的人群在新格式成为默认后趋近于零；读取已存在 .env 的回落链不受影响，
// 见 src/ops/config-file.js）。值里的空格 / 引号 / 反斜杠交给 JSON.stringify，不需要
// .env 时代那套「同时满足 dotenv 与 shell 两个解析器」的字符白名单。
export function buildConfigContent({ authToken, workDir, workDirs, fileEdit, accessProfile } = {}) {
  const config = applyConfigChanges({}, {
    ...(authToken ? { AUTH_TOKEN: authToken } : {}),
    ...(workDir ? { WORK_DIR: workDir } : {}),
    // 向导登记的全部工作区。即使只有一个也写出来：让 WORKDIRS 这个键出现在文件里，
    // 用户日后想加项目时打开配置一眼就能看到往哪加（热加载，保存即生效），
    // 不用先去读文档考古出这个键名——2026-08-19 新用户实测的困惑正是「不知道有没有/怎么设多个」。
    ...(Array.isArray(workDirs) && workDirs.length ? { WORKDIRS: workDirs } : {}),
    // 只有明确说「关」才写键；默认开由 schema 负责（TOGGLE_OFF 的 on 值是空串，写出来反而多余）。
    ...(fileEdit === 'off' ? { FILE_EDIT: 'off' } : {}),
    // 同一纪律：只有显式选了方案才写键；回车跳过 = 未声明（一切消费点回落现状推断）。
    ...(accessProfile ? { ACCESS_PROFILE: accessProfile } : {}),
  });
  return `${JSON.stringify(config, null, 2)}\n`;
}

// 按环境 locale 选界面语言：zh_* → 中文，其余 → 英文。
export function detectLang(env = process.env) {
  const raw = env.LC_ALL || env.LC_MESSAGES || env.LANG || '';
  return /^zh/i.test(raw) ? 'zh' : 'en';
}

// 参数解析。未知参数不静默忽略而是收集起来由上层拒绝——`--workdir=` 这种少一个连字符的 typo
// 若被忽略，WORK_DIR 就会悄悄回落到 $HOME，正是本模式要堵的那个洞。
export function parseSetupArgs(argv = []) {
  const out = { configPath: undefined, yes: false, workDir: undefined, hooks: undefined, desktop: undefined, accessProfile: undefined, force: false, help: false, unknown: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf('=');
    const name = eq > 0 ? arg.slice(0, eq) : arg;
    const inline = eq > 0 ? arg.slice(eq + 1) : undefined;
    const value = () => (inline !== undefined ? inline : argv[++i]);
    if (name === '--config') out.configPath = value();
    else if (name === '--work-dir') out.workDir = value();
    else if (name === '--hooks') out.hooks = value();
    else if (name === '--desktop') out.desktop = value();
    else if (name === '--access-profile') out.accessProfile = value();
    else if (name === '--yes' || name === '-y') out.yes = true;
    else if (name === '--force') out.force = true;
    else if (name === '--help' || name === '-h') out.help = true;
    else out.unknown.push(arg);
  }
  return out;
}

// 交互回车不得静默变成 $HOME（那等于把整个家目录交给远程入口，与 hard-rules「可选功能不猜」同轴）。
// `~/project` 展开后若不是家目录本身则接受；相对路径拒绝，避免 cwd 不同时配到别处。
export function normalizeSetupWorkDir(raw, { home = homedir() } = {}) {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return { ok: false, code: 'work_dir_required' };
  const homeAbs = resolve(home);
  let candidate;
  if (trimmed === '~') candidate = homeAbs;
  else if (trimmed.startsWith('~/')) candidate = resolve(homeAbs, trimmed.slice(2));
  else if (!isAbsolute(trimmed)) return { ok: false, code: 'work_dir_not_absolute' };
  else candidate = resolve(trimmed);
  if (candidate === homeAbs) return { ok: false, code: 'work_dir_is_home' };
  return { ok: true, workDir: candidate };
}

// 交互向导问 WORK_DIR：问到合法为止，而不是一拒就退出。用户到这一步可能已经答过
// 「覆盖现有配置? y」，一个 typo 让他重跑整个向导是白付的代价。
//
// maxAttempts 不是保守起见——它是正确性要求：ask 若因 stdin 关闭而恒返回空串，
// 没有上限就是死循环（本文件头注释记的那次 EOF 事故就是这个形状）。
export async function promptWorkDir(ask, { home = homedir(), maxAttempts = 3, onInvalid } = {}) {
  let last = { ok: false, code: 'work_dir_required' };
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    last = normalizeSetupWorkDir(await ask(), { home });
    if (last.ok) return last;
    onInvalid?.({ code: last.code, attempt, remaining: maxAttempts - attempt });
  }
  return last;
}

// 交互向导问工作区列表：第一个必填（即 WORK_DIR，手机端默认打开的目录），其后可选追加，
// 空回车结束。追加项无效只报原因继续问、不炸整个向导；重复项去重。循环有硬上限：
// ask 若因 stdin 关闭恒返回非空垃圾，没有上限就是死循环（同 promptWorkDir 的 EOF 教训）。
export async function promptWorkDirs(ask, askMore, { home = homedir(), maxAttempts = 3, onInvalid } = {}) {
  const first = await promptWorkDir(ask, { home, maxAttempts, onInvalid });
  if (!first.ok) return first;
  const dirs = [first.workDir];
  for (let i = 0; i < 20; i += 1) {
    const raw = String((await askMore()) ?? '').trim();
    if (!raw) break;
    const r = normalizeSetupWorkDir(raw, { home });
    if (!r.ok) {
      onInvalid?.({ code: r.code });
      continue;
    }
    if (!dirs.includes(r.workDir)) dirs.push(r.workDir);
  }
  return { ok: true, workDir: dirs[0], workDirs: dirs };
}

// 把参数 + 磁盘现状（.env 是否已存在）解析成一份可执行计划，或一条拒绝理由。
// 交互模式下未给的项留 undefined = 「待询问」；非交互模式下必须全部落定。
export function resolveSetupPlan({ args, envExists = false, platform = process.platform, isTty = true, home = homedir() } = {}) {
  if (args.help) return { mode: 'help' };
  const mode = args.yes ? 'noninteractive' : 'interactive';
  const refuse = (code, detail) => ({ mode, refuse: { code, detail } });

  if (args.unknown.length) return refuse('unknown_flag', args.unknown.join(' '));
  if (args.hooks !== undefined && args.hooks !== 'on' && args.hooks !== 'off') {
    return refuse('invalid_hooks', String(args.hooks));
  }
  if (args.desktop !== undefined && args.desktop !== 'on' && args.desktop !== 'off') {
    return refuse('invalid_desktop', String(args.desktop));
  }
  // 方案枚举来自 env-schema 的 ACCESS_PROFILES（单一事实源）。非法值直接拒，不猜意图——
  // 「zerotier」大概率想要 vpn，但替用户猜写进配置就是 hard-rules §1 明令禁止的静默决定。
  if (args.accessProfile !== undefined && !ACCESS_PROFILES.includes(args.accessProfile)) {
    return refuse('invalid_access_profile', String(args.accessProfile));
  }
  // 桌面控制台只有 macOS 有。静默忽略会让用户以为装上了 —— 明确拒绝才有信息量，
  // 同 src/ops/log-terminal.js 那条「返回 reason 而不是假装成功」。
  if (args.desktop === 'on' && platform !== 'darwin') {
    return refuse('desktop_unsupported', platform);
  }
  if (!args.yes) {
    if (!isTty) return refuse('tty_required');
    return { mode, workDir: args.workDir, hooks: args.hooks, desktop: args.desktop, accessProfile: args.accessProfile };
  }
  if (!args.workDir) return refuse('work_dir_required');
  const workDirNorm = normalizeSetupWorkDir(args.workDir, { home });
  if (!workDirNorm.ok) return refuse(workDirNorm.code);
  if (envExists && !args.force) return refuse('env_exists');
  // 默认不装：它要跑 swiftc（可能还要用户先 xcode-select --install），与 hooks 同一心智。
  // accessProfile 是纯配置项：缺省 undefined = 不写键（未声明），不套 hooks 的「危险动作缺省 off」。
  return { mode, workDir: workDirNorm.workDir, hooks: args.hooks ?? 'off', desktop: args.desktop ?? 'off', accessProfile: args.accessProfile };
}

// 覆盖提示的判定：把「检测到哪个文件」与「将写入哪个文件」当成两件事。
//
// 它们不同的那一格才是危险格：旧文件不会被覆盖，而是被优先级更高的新文件**架空**——
// 磁盘上原样躺着、看起来毫发无损，实际里面每一项都不再生效。用「覆盖它?」问这一格
// 是在问错的问题，用户答的也就不是他以为的那件事。
export function describeOverwrite({ existingConfig, outPath }) {
  if (!existingConfig) return null;
  return { existing: existingConfig, target: outPath, shadows: existingConfig !== outPath };
}

// 交互壳的双语文案（纯文本片段，颜色在 main 里组装）。
export const MESSAGES = {
  zh: {
    title: '⚙  Claude Chat Mobile —— 配置向导',
    overwritePrompt: '已存在，覆盖它? [y/N] ',
    shadowWarning: (existing, target) =>
      `⚠️  检测到 ${existing}，但本次将写入 ${target}。\n`
      + `   新文件优先级更高：${existing} 会原样留在磁盘上，却从此完全失效——\n`
      + '   CCM_DATA_DIR（会话与已信任设备）、PORT、VAPID_*（推送）、CF_ACCESS_*（公网 2FA）全部不再生效。\n'
      + '   想保留这些请改用 node scripts/config.js migrate 迁移，而不是在这里新写一份。\n'
      + '   仍要继续? [y/N] ',
    cancelled: '已取消，现有配置未改动。',
    tokenLabel: '已生成 AUTH_TOKEN（手机访问必需）',
    tokenWrittenSuffix: '…（已写入 %s）',
    workDirLabel: '手机端要打开哪个项目目录？',
    workDirHint: '(claude 会话将在这个目录里读写代码。填绝对路径或 ~/ 路径；不能是家目录本身。稍后还能追加更多)',
    moreDirPrompt: '再加一个项目目录？(可选，直接回车结束)',
    workdirsSummary: n => `已登记 ${n} 个工作区，第一个是默认打开的`,
    workdirsHint: '以后增删工作区：改 ccm.config.json 里的 WORKDIRS 数组即可，保存即生效（热加载，免重启）；也可在手机端「设置」里改。',
    wroteLabel: '已写入',
    permNote: '(权限 0600)',
    nextSteps: '下一步:',
    stepDoctor: '# 预检配置',
    stepStart: '# 启动；日志会打印手机可用的局域网地址',
    publicNote: '公网访问（固定域名 / Cloudflare Access 2FA / 常驻）见 docs/deployment.md。',
    accessPrompt: '你打算怎么从手机访问？（决定 doctor 与安全体检按哪套方案帮你检查；详见 docs/deployment.md）\n'
      + '  1) 仅局域网 —— 同一 WiFi 直连\n'
      + '  2) Cloudflare Tunnel + Access —— 固定域名 + 公网 2FA\n'
      + '  3) 加密隧道 / VPN —— WireGuard、Tailscale tailnet、ZeroTier…\n'
      + '  4) 反向代理 / 托管隧道 —— nginx、Caddy、frp、ngrok、Tailscale Funnel…\n'
      + '（Tailscale 两种用法分属 3 和 4：设备进 tailnet 选 3，用 Funnel 暴露到公网选 4）\n'
      + '选 1-4，回车 = 暂不声明（以后可在手机「设置」或 node scripts/config.js 里改）: ',
    accessInvalid: '请输入 1-4，或直接回车跳过',
    accessChosenNote: p => `已声明公网访问方案：${p}（写入 ACCESS_PROFILE；doctor 与安全体检会按它做针对性检查）`,
    accessNotes: {
      cloudflare: '公网搭建步骤（固定域名 / Cloudflare Tunnel / Access 2FA / 常驻）见 docs/deployment.md「从零搭建」。',
      vpn: '加密隧道 / VPN 的落地要点见 docs/deployment.md「不用 Cloudflare 的公网入口」：手机用隧道内地址访问，'
        + '要收通知须显式设 PUBLIC_URL。该章文末有可直接粘贴给编程 agent 的选型与落地 prompt。',
      'reverse-proxy': '反向代理 / 托管隧道的落地要点见 docs/deployment.md「不用 Cloudflare 的公网入口」：Host 透传与 WebSocket 升级'
        + '是硬要求（托管隧道通常自带），建议在入口层再补一层认证；用托管隧道还要留意换 URL 后同步改 PUBLIC_URL，'
        + '否则推送深链指向失效地址。该章文末有可直接粘贴给编程 agent 的选型与落地 prompt。',
      lan: '同一 WiFi 直连即可：启动日志会打印手机可用的局域网地址；从手机打开的步骤见 docs/getting-started.md。',
    },
    fileEditPrompt: '启用手机端文件编辑器? 可直接修改工作区内文件——不经 Claude 工具审批链'
      + '（仍有范围/大小/哈希/审计护栏）。长期公网暴露建议关闭 [Y/n] ',
    fileEditOffNote: '已关闭：将写入 FILE_EDIT=off（手机端文件界面只读；配置里随时可改回）。',
    hooksPrompt: '安装 CLI hooks 桥? 让你在电脑终端直接跑的 claude 会话也能推送到手机 [Y/n] ',
    hooksInstalling: '正在安装并验证…',
    hooksSkipped: '已跳过。随时可跑 npm run hooks:install 补装。',
    desktopSkipped: '已跳过桌面控制台。随时可跑 npm run app:install 补装。',
    hooksFailed: '安装未成功（见上方输出）。不影响其余配置；稍后可跑 npm run hooks:install 重试。',
    desktopPrompt: '编译 macOS 桌面控制台? 菜单栏里看服务状态、改配置、看日志，不用开终端。'
      + '需要 Xcode Command Line Tools（不是完整 Xcode，装过 git 的多半已经有）[y/N] ',
    desktopBuilding: '正在编译桌面 app…',
    desktopFailed: '编译未成功（见上方输出）。不影响其余配置；装好 Command Line Tools'
      + '（xcode-select --install）后跑 npm run app:build 重试。',
    usage: '用法: node scripts/setup.js [--config <path>]\n'
      + '      node scripts/setup.js --yes --work-dir=<绝对路径> [--hooks=on|off] [--desktop=on|off] [--access-profile=cloudflare|vpn|reverse-proxy|lan] [--force]',
    refuse: {
      unknown_flag: d => `无法识别的参数：${d}`,
      invalid_hooks: d => `--hooks 只接受 on 或 off，收到：${d}`,
      invalid_desktop: d => `--desktop 只接受 on 或 off，收到：${d}`,
      invalid_access_profile: d => `--access-profile 只接受 cloudflare / vpn / reverse-proxy / lan，收到：${d}`,
      desktop_unsupported: d => `桌面控制台只有 macOS 有（当前平台：${d}）。服务器上用手机端与命令行，功能是齐的。`,
      work_dir_required: () => '必须显式给出工作目录的绝对路径（--work-dir= 或向导里键入）。'
        + '这里不会静默回落到 $HOME——那等于把整个家目录交给远程入口。',
      work_dir_is_home: () => 'WORK_DIR 不能是家目录。请换成一个具体项目目录。',
      work_dir_not_absolute: () => 'WORK_DIR 必须是绝对路径（或以 ~/ 写成家目录下的子目录）。',
      tty_required: () => '当前没有交互终端。不要跑 npm run setup；改用：'
        + ' node scripts/setup.js --yes --work-dir=<绝对路径> --hooks=on|off',
      env_exists: d => `${d} 已存在，非交互模式不会覆盖它（里面可能有正在用的 AUTH_TOKEN）。`
        + '若是从旧版本升级，请跑 node scripts/config.js migrate 迁移，不要用 --force —— '
        + '那会生成一个新 AUTH_TOKEN，所有已授权设备都要重新批准。'
    },
  },
  en: {
    title: '⚙  Claude Chat Mobile — setup wizard',
    overwritePrompt: 'already exists. Overwrite it? [y/N] ',
    shadowWarning: (existing, target) =>
      `⚠️  Found ${existing}, but this run will write ${target}.\n`
      + `   The new file takes precedence: ${existing} stays on disk untouched yet stops applying entirely —\n`
      + '   CCM_DATA_DIR (sessions and trusted devices), PORT, VAPID_* (push) and CF_ACCESS_* (public 2FA) all go dead.\n'
      + '   To keep them, run node scripts/config.js migrate instead of writing a fresh file here.\n'
      + '   Continue anyway? [y/N] ',
    cancelled: 'Cancelled. Your existing config was left untouched.',
    tokenLabel: 'Generated AUTH_TOKEN (required for phone access)',
    tokenWrittenSuffix: '… (written to %s)',
    workDirLabel: 'Which project folder should open on your phone?',
    workDirHint: '(claude sessions will read and write code there. Absolute or ~/ path; not your home directory itself. You can add more next)',
    moreDirPrompt: 'Add another project folder? (optional; press Enter to finish)',
    workdirsSummary: n => `Registered ${n} workspace(s); the first one opens by default`,
    workdirsHint: 'To add or remove workspaces later, edit the WORKDIRS array in ccm.config.json — it hot-reloads on save (no restart). The phone Settings page can edit it too.',
    wroteLabel: 'Wrote',
    permNote: '(mode 0600)',
    nextSteps: 'Next steps:',
    stepDoctor: '# pre-flight your config',
    stepStart: '# start; the log prints a LAN URL you can open on your phone',
    publicNote: 'Public access (fixed domain / Cloudflare Access 2FA / daemon): see docs/deployment.md.',
    accessPrompt: 'How will your phone reach this machine? (decides which profile doctor and the security check tailor to; see docs/deployment.md)\n'
      + '  1) LAN only — same-WiFi direct access\n'
      + '  2) Cloudflare Tunnel + Access — fixed domain + public 2FA\n'
      + '  3) Encrypted tunnel / VPN — WireGuard, Tailscale tailnet, ZeroTier…\n'
      + '  4) Reverse proxy / hosted tunnel — nginx, Caddy, frp, ngrok, Tailscale Funnel…\n'
      + '(Tailscale splits across 3 and 4: joining your tailnet is 3, exposing it via Funnel is 4)\n'
      + 'Pick 1-4, or press Enter to skip (change later in the phone Settings or via node scripts/config.js): ',
    accessInvalid: 'Enter 1-4, or press Enter to skip',
    accessChosenNote: p => `Access profile declared: ${p} (written as ACCESS_PROFILE; doctor and the security check tailor to it)`,
    accessNotes: {
      cloudflare: 'Public setup steps (fixed domain / Cloudflare Tunnel / Access 2FA / daemon): see docs/deployment.md, section "从零搭建" (from scratch).',
      vpn: 'Encrypted tunnel / VPN essentials: see docs/deployment.md, section "不用 Cloudflare 的公网入口" — reach the phone via the in-tunnel address, '
        + 'and set PUBLIC_URL explicitly if you want notification deep links. That section ends with a prompt you can paste to a coding agent.',
      'reverse-proxy': 'Reverse proxy / hosted tunnel essentials: see docs/deployment.md, section "不用 Cloudflare 的公网入口" — Host passthrough and '
        + 'WebSocket upgrade are hard requirements (hosted tunnels usually handle both); consider an extra auth layer at the entry point, and if your '
        + 'tunnel URL changes, update PUBLIC_URL too or push deep links will point at a dead address. That section ends with a prompt you can paste to a coding agent.',
      lan: 'Same-WiFi direct access just works: the startup log prints the LAN address for your phone; see docs/getting-started.md.',
    },
    fileEditPrompt: 'Enable the phone file editor? It edits workspace files directly — bypassing Claude\'s '
      + 'tool-approval chain (scope/size/hash/audit guards still apply). Recommended off for long-term public exposure [Y/n] ',
    fileEditOffNote: 'Off: FILE_EDIT=off will be written (phone file UI becomes read-only; change it in config anytime).',
    hooksPrompt: 'Install the CLI hooks bridge? Lets sessions you run in your own terminal push to your phone [Y/n] ',
    hooksInstalling: 'Installing and verifying…',
    hooksSkipped: 'Skipped. Run npm run hooks:install anytime.',
    desktopSkipped: 'Skipped the desktop console. Run npm run app:install anytime.',
    hooksFailed: 'Install did not complete (see output above). Your other config is fine; retry with npm run hooks:install.',
    desktopPrompt: 'Build the macOS desktop console? Service state, config and logs from the menu bar, '
      + 'no terminal needed. Requires Xcode Command Line Tools (not full Xcode; if you have git you likely have them) [y/N] ',
    desktopBuilding: 'Building the desktop app…',
    desktopFailed: 'Build did not complete (see output above). Your other config is fine; install the Command Line '
      + 'Tools (xcode-select --install) and retry with npm run app:build.',
    usage: 'usage: node scripts/setup.js [--config <path>]\n'
      + '       node scripts/setup.js --yes --work-dir=<absolute-path> [--hooks=on|off] [--desktop=on|off] [--access-profile=cloudflare|vpn|reverse-proxy|lan] [--force]',
    refuse: {
      unknown_flag: d => `Unrecognized argument: ${d}`,
      invalid_hooks: d => `--hooks accepts only on or off, got: ${d}`,
      invalid_desktop: d => `--desktop accepts only on or off, got: ${d}`,
      invalid_access_profile: d => `--access-profile accepts only cloudflare / vpn / reverse-proxy / lan, got: ${d}`,
      desktop_unsupported: d => `The desktop console is macOS-only (this platform: ${d}). On a server, the phone UI and CLI cover everything.`,
      work_dir_required: () => 'An explicit absolute --work-dir= is required (or type one in the wizard). '
        + 'It will not silently fall back to $HOME — that would hand your entire home directory to a remote entrypoint.',
      work_dir_is_home: () => 'WORK_DIR cannot be your home directory. Use a specific project folder.',
      work_dir_not_absolute: () => 'WORK_DIR must be an absolute path (or a ~/… path under your home directory).',
      tty_required: () => 'This shell has no TTY. Do not run npm run setup. Use: '
        + 'node scripts/setup.js --yes --work-dir=<absolute-path> --hooks=on|off',
      env_exists: d => `${d} already exists; non-interactive mode will not overwrite it `
        + '(it may hold the AUTH_TOKEN you are using). Upgrading from an older version? Run '
        + 'node scripts/config.js migrate instead — --force would mint a new AUTH_TOKEN and every '
        + 'approved device would have to be re-approved.'
    },
  },
};

// ──────────────────────── 交互壳（手动跑验证）────────────────────────

const c = {
  bold: s => `\x1b[1m${s}\x1b[0m`,
  green: s => `\x1b[32m${s}\x1b[0m`,
  dim: s => `\x1b[2m${s}\x1b[0m`,
  accent: s => `\x1b[36m${s}\x1b[0m`,
};

// 公网访问方案问询：数字 1-4 单选，回车 = 不声明（不写键）。非法输入重问、问满 maxAttempts
// 回落不声明——EOF/管道喂错内容都不能死循环（promptWorkDir 的教训），且失败方向必须是
// 「不写」而不是猜一个方案（hard-rules §1）。编号顺序即推荐的认知顺序：从最简单的 lan 起步。
export async function promptAccessProfile(ask, { maxAttempts = 3, onInvalid } = {}) {
  const MAP = { 1: 'lan', 2: 'cloudflare', 3: 'vpn', 4: 'reverse-proxy' };
  for (let i = 0; i < maxAttempts; i += 1) {
    const raw = String((await ask()) ?? '').trim();
    if (raw === '') return undefined;
    if (Object.hasOwn(MAP, raw)) return MAP[raw];
    onInvalid?.();
  }
  return undefined;
}

// 落盘（交互/非交互两条路径共用，防各写一份再分叉）。
//
// 注意成功提示的位置：token 那行必须在 writeOwnerOnlyFile 之后才打印。旧实现先打印
// 「✓ 已生成 AUTH_TOKEN（已写入 .env）」再去问 WORK_DIR，被 EOF/Ctrl-C 打断时一个字没写却已经报了成功。
function writeSetupFile({ outPath, workDir, workDirs, fileEdit, accessProfile, t }) {
  const token = generateToken();
  // 结构化构造没有旧模板替换那种「正则没匹配上就静默不生效」的失败模式，无需写后校验。
  writeOwnerOnlyFile(outPath, buildConfigContent({ authToken: token, workDir: workDir || undefined, workDirs, fileEdit, accessProfile }));

  const written = t.tokenWrittenSuffix.replace('%s', basename(outPath));
  console.log(`\n${c.green('✓')} ${t.tokenLabel}: ${c.dim(token.slice(0, 8) + written)}`);
  console.log(`${c.green('✓')} ${t.wroteLabel} ${c.bold(outPath)} ${c.dim(t.permNote)}`);
  if (Array.isArray(workDirs) && workDirs.length) {
    console.log(`${c.green('✓')} ${t.workdirsSummary(workDirs.length)}`);
    console.log(c.dim(`  ${t.workdirsHint}`));
  }
}

// CLI hooks 桥安装（两条路径共用）。写的是用户全局 ~/.claude/settings.json，故只在明确要装时才调。
// 此刻 server 通常还没起，安装器的服务级验证会显示"跳过"，文件级验证仍然真跑一遍。
function installHooksBridge(t) {
  console.log(c.dim(t.hooksInstalling));
  const r = spawnSync(process.execPath, [join(HERE, 'scripts', 'hooks-bridge-setup.js'), 'install'], {
    stdio: 'inherit',
  });
  if (r.status !== 0) console.log(c.dim(t.hooksFailed));
}

// 桌面控制台。失败不阻断装机 —— 它是可选增强，而最可能的失败原因（没装 Command Line
// Tools）用户看提示自己就能解决。同 installHooksBridge 的处理。
function buildDesktopApp(t) {
  console.log(c.dim(t.desktopBuilding));
  const r = spawnSync(process.execPath, [join(HERE, 'scripts', 'app-build.js')], { stdio: 'inherit' });
  if (r.status !== 0) console.log(c.dim(t.desktopFailed));
}

function printNextSteps(t, accessProfile) {
  console.log(c.bold(`\n${t.nextSteps}`));
  console.log(`  ${c.accent('node scripts/doctor.js')}   ${c.dim(t.stepDoctor)}`);
  console.log(`  ${c.accent('npm start')}                ${c.dim(t.stepStart)}`);
  // 选了方案就给对应的落地指引（只指路文档不打印全文——40 行的 agent prompt 住在
  // deployment.md 里才不会漂移）；没选维持通用一句。
  console.log(c.dim(`\n${(accessProfile && t.accessNotes[accessProfile]) || t.publicNote}\n`));
}

// deps 只为可测而存在：这个壳里出过两个只有「真跑一遍交互」才看得见的 bug（问了不用、
// 问错文件），而它们恰恰是最不会有人手动复跑的路径。默认值即真实实现。
export async function runInteractive({ plan, outPath, existingConfig, t }, deps = {}) {
  const {
    createRl = () => createInterface({ input: stdin, output: stdout }),
    writeFile = writeSetupFile,
    buildDesktop = buildDesktopApp,
    installHooks = installHooksBridge,
    platform = process.platform,
  } = deps;
  const rl = createRl();
  try {
    // 已有配置 → 先问是否覆盖（默认否，绝不静默覆盖既有配置）。
    // existingConfig 由 main() 算好后传进来，**这里不再自己搜一遍**：此前独立搜 [outPath,
    // ccm.config.json, .env] 与 main() 的判据分岔，于是提示里说的文件和真正要写的文件是两个。
    const overwrite = describeOverwrite({ existingConfig, outPath });
    if (overwrite) {
      const prompt = overwrite.shadows
        ? t.shadowWarning(overwrite.existing, overwrite.target)
        : `⚠️  ${overwrite.target} ${t.overwritePrompt}`;
      const ans = (await rl.question(prompt)).trim().toLowerCase();
      if (ans !== 'y' && ans !== 'yes') {
        console.log(t.cancelled);
        return;
      }
    }

    // 工作区：命令行已给就不问（给错了直接拒，交互里不替它「救」一个显式参数）。
    // 自己键入的则问到对为止——空回车 / 家目录一律拒绝，与非交互同一条硬规则；
    // 首个之后可追加更多目录（2026-08-19 新用户实测：只问一个目录会让人以为手机端只能配一个项目）。
    const workDirNorm = plan.workDir
      ? normalizeSetupWorkDir(plan.workDir)
      : await promptWorkDirs(
        async () => (await rl.question(`\n${t.workDirLabel} ${c.dim(t.workDirHint)}: `)).trim(),
        async () => (await rl.question(`${t.moreDirPrompt}: `)).trim(),
        { onInvalid: ({ code }) => console.error(`✗ ${t.refuse[code]()}`) },
      );
    if (!workDirNorm.ok) {
      console.error(`✗ ${t.refuse[workDirNorm.code]()}`);
      return;
    }

    // 公网访问方案：纯声明（决定 doctor/安全体检按哪套方案做针对性检查），回车 = 不声明不写键。
    // 命令行 --access-profile 已给则不再问（同 workDir：显式参数交互里不重复问）。放在 FILE_EDIT
    // 之前——先答拓扑，下一问「长期公网暴露建议关闭」的语境才立得住。
    const accessProfile = plan.accessProfile !== undefined
      ? plan.accessProfile
      : await promptAccessProfile(
        async () => (await rl.question(`\n${t.accessPrompt}`)).trim(),
        { onInvalid: () => console.error(`✗ ${t.accessInvalid}`) },
      );
    if (accessProfile) console.log(c.dim(t.accessChosenNote(accessProfile)));

    // 文件编辑器直写：唯一绕过 Agent 工具审批链的写入通道（R45，2026-08-30）。回车=维持
    // schema 默认开（机主即 root，hard-rules §2.3），答 n 才写 FILE_EDIT=off。必须在写文件
    // 之前问——它是配置项，不像 hooks/desktop 是写完配置后才执行的安装动作。
    const fileEditAns = (await rl.question(`\n${t.fileEditPrompt}`)).trim().toLowerCase();
    const fileEdit = fileEditAns === 'n' || fileEditAns === 'no' ? 'off' : undefined;
    if (fileEdit === 'off') console.log(c.dim(t.fileEditOffNote));

    writeFile({ outPath, workDir: workDirNorm.workDir, workDirs: workDirNorm.workDirs, fileEdit, accessProfile, t });

    // CLI hooks 桥：默认装（终端直跑的会话唯有装了它才能推到手机——轮询只能在你已经打开
    // app 时追平镜像，永远不会主动叫你）。默认 Y 但必须问：它写的是用户全局 ~/.claude/settings.json。
    // 桌面控制台：只在 macOS 上问。默认「不装」—— 它要跑 swiftc，而很多人没装 CLT。
    let desktop = plan.desktop;
    if (desktop === undefined) {
      if (platform !== 'darwin') {
        desktop = 'off';
      } else {
        const ans = (await rl.question(`\n${t.desktopPrompt}`)).trim().toLowerCase();
        desktop = ans === 'y' || ans === 'yes' ? 'on' : 'off';
      }
    }

    let hooks = plan.hooks;
    if (hooks === undefined) {
      const ans = (await rl.question(`\n${t.hooksPrompt}`)).trim().toLowerCase();
      hooks = ans === '' || ans === 'y' || ans === 'yes' ? 'on' : 'off';
    }
    if (hooks === 'on') installHooks(t);
    else console.log(c.dim(t.hooksSkipped));
    // 问了就必须用：此前 desktop 赋值后再没被读过，答 y 的用户什么也等不到，
    // 连一句「已跳过」都没有——比不问更糟，因为他以为装上了。
    if (desktop === 'on') buildDesktop(t);
    else if (platform === 'darwin') console.log(c.dim(t.desktopSkipped));

    printNextSteps(t, accessProfile);
  } finally {
    rl.close();
  }
}

// deps 与 runInteractive 同款，理由也一样：这条路径上的行为只有真跑一遍才看得见，
// 而它恰恰是「照着文档敲一行命令」的人用的那条。
export function runNonInteractive({ plan, outPath, existingConfig, t }, deps = {}) {
  const {
    writeFile = writeSetupFile,
    buildDesktop = buildDesktopApp,
    installHooks = installHooksBridge,
    warn = (m) => console.warn(m),
  } = deps;
  // 影子化的后果与走哪条路径无关。交互路径拿到整段警告，而 `--yes --force` 一声不吭。
  // --force 的语义是「我知道有既有配置，继续」，不是「别告诉我会发生什么」。
  const overwrite = describeOverwrite({ existingConfig, outPath });
  if (overwrite?.shadows) warn(t.shadowWarning(overwrite.existing, overwrite.target));
  writeFile({ outPath, workDir: plan.workDir, accessProfile: plan.accessProfile, t });
  if (plan.hooks === 'on') installHooks(t);
  else console.log(c.dim(t.hooksSkipped));
  if (plan.desktop === 'on') buildDesktop(t);
  printNextSteps(t, plan.accessProfile);
}

async function main() {
  const args = parseSetupArgs(process.argv.slice(2));
  const outPath = args.configPath || join(HERE, CONFIG_FILE_NAME);
  const t = MESSAGES[detectLang()];

  console.log(c.bold(`\n${t.title}\n`));

  // ★ 默认目标必须同时看 ccm.config.json 与 .env：只 stat 新路径的话，setup 会在一台
  // 正在跑的实例旁边生成一份带**全新 AUTH_TOKEN** 的配置，且它优先级更高。
  // `--config <path>` 是显式另写一份，只看那个路径——否则仓库里已有配置时，文档写的
  // 隔离装机永远被拒。
  const existingConfig = args.configPath
    ? (existsSync(outPath) ? outPath : undefined)
    : [outPath, join(HERE, CONFIG_FILE_NAME), join(HERE, '.env')].find(existsSync);
  const plan = resolveSetupPlan({ args, envExists: !!existingConfig, isTty: !!stdin.isTTY });
  if (plan.mode === 'help') {
    console.log(t.usage);
    process.exit(0);
  }
  if (plan.refuse) {
    console.error(`✗ ${t.refuse[plan.refuse.code](plan.refuse.detail ?? existingConfig ?? outPath)}\n`);
    console.error(t.usage);
    process.exit(2);
  }

  if (plan.mode === 'noninteractive') runNonInteractive({ plan, outPath, existingConfig, t });
  else await runInteractive({ plan, outPath, existingConfig, t });
}

// 仅直接运行时进入交互；被测试 import 时不执行 main。
// 不能只比字符串：node 加载模块时会解析符号链接，import.meta.url 因此可能是 realpath，而 argv[1]
// 是调用者原样传进来的（macOS 的 /var → /private/var 就会踩到）。两者不等时 main 从不执行、
// `npm run setup` 静默退出 0 什么都不做——与本文件要根除的那类静默失败同源。
function invokedDirectly() {
  if (!process.argv[1]) return false;
  const self = fileURLToPath(import.meta.url);
  if (self === resolve(process.argv[1])) return true;
  try {
    return self === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (invokedDirectly()) main();
