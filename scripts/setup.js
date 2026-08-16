#!/usr/bin/env node
// scripts/setup.js —— 一键配置向导：生成 .env（AUTH_TOKEN + WORK_DIR），零依赖。
// 用法: node scripts/setup.js [--config <path>|--env <path>]                        # 交互向导（人用）
//       node scripts/setup.js --yes --work-dir=<path> [--hooks=on|off] [--desktop=on|off] [--force]  # 非交互（编程 agent 用）
//   覆盖最简路径（同 WiFi / 临时公网）的核心配置。头号门槛是「必须设 AUTH_TOKEN,
//   否则只绑 127.0.0.1、手机连不上」——向导默认帮你生成。
//   公网固定部署（Cloudflare Access 2FA / 隧道 / 常驻）不在向导内，见 docs/deployment.md。
//   界面语言按环境 locale 自动选：zh_* → 中文，其余 → 英文。
//
// 为什么有非交互模式：README 一直建议「把安装丢给编程 agent 代跑」，但 agent 的 shell 没有 TTY，
// stdin 立刻 EOF → readline 的 question promise 永不 settle → 进程静默退出 0、.env 一个字没写
// （实测）。非交互模式让意图完全由参数表达，且两个危险默认一律不许静默生效：
//   · WORK_DIR 不回落 $HOME（那等于把整个家目录交给 agent）——必须显式 --work-dir
//   · hooks 不默认装（那会写用户全局 ~/.claude/settings.json）——必须显式 --hooks=on
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { basename, join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeOwnerOnlyFile } from '../src/files/file-security.js';
import { applyConfigChanges, CONFIG_FILE_NAME } from '../src/ops/config-file.js';

const HERE = dirname(dirname(fileURLToPath(import.meta.url)));

// ──────────────────────── 纯逻辑（可单测）────────────────────────

// 生成十六进制随机 token（默认 32 字节 = 64 hex 字符）。
export function generateToken(bytes = 32) {
  return randomBytes(bytes).toString('hex');
}

// 生成统一配置文件 ccm.config.json 的内容（P1b 起的默认格式）。
//
// 与下面 buildEnvContent 的关键差别：那个是**正则替换模板里的赋值行**，模板格式一变就静默
// 不替换（所以调用点还得回头校验一次替换是否真的生效）；这个是结构化构造，写出去的就是数据
// 本身，不存在「没匹配上」。值里的空格 / 引号 / 反斜杠交给 JSON.stringify，不需要 .env 时代
// 那套「同时满足 dotenv 与 shell 两个解析器」的字符白名单。
export function buildConfigContent({ authToken, workDir } = {}) {
  const config = applyConfigChanges({}, {
    ...(authToken ? { AUTH_TOKEN: authToken } : {}),
    ...(workDir ? { WORK_DIR: workDir } : {}),
  });
  return `${JSON.stringify(config, null, 2)}\n`;
}

// 基于 .env.example 模板填入 AUTH_TOKEN / WORK_DIR，返回新的 .env 内容。
// 只替换行首的赋值行（KEY=…），注释与其他行原样保留。
// **旧格式**：仅在 --env 显式指定时使用（如需要 docker --env-file）。
export function buildEnvContent(template, { authToken, workDir } = {}) {
  let out = template;
  if (authToken) out = out.replace(/^AUTH_TOKEN=.*$/m, `AUTH_TOKEN=${authToken}`);
  if (workDir) out = out.replace(/^WORK_DIR=.*$/m, `WORK_DIR=${workDir}`);
  return out;
}

// 按环境 locale 选界面语言：zh_* → 中文，其余 → 英文。
export function detectLang(env = process.env) {
  const raw = env.LC_ALL || env.LC_MESSAGES || env.LANG || '';
  return /^zh/i.test(raw) ? 'zh' : 'en';
}

// 参数解析。未知参数不静默忽略而是收集起来由上层拒绝——`--workdir=` 这种少一个连字符的 typo
// 若被忽略，WORK_DIR 就会悄悄回落到 $HOME，正是本模式要堵的那个洞。
export function parseSetupArgs(argv = []) {
  const out = { envPath: undefined, configPath: undefined, yes: false, workDir: undefined, hooks: undefined, desktop: undefined, force: false, unknown: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf('=');
    const name = eq > 0 ? arg.slice(0, eq) : arg;
    const inline = eq > 0 ? arg.slice(eq + 1) : undefined;
    const value = () => (inline !== undefined ? inline : argv[++i]);
    if (name === '--config') out.configPath = value();
    else if (name === '--env') out.envPath = value();
    else if (name === '--work-dir') out.workDir = value();
    else if (name === '--hooks') out.hooks = value();
    else if (name === '--desktop') out.desktop = value();
    else if (name === '--yes' || name === '-y') out.yes = true;
    else if (name === '--force') out.force = true;
    else out.unknown.push(arg);
  }
  return out;
}

// 把参数 + 磁盘现状（.env 是否已存在）解析成一份可执行计划，或一条拒绝理由。
// 交互模式下未给的项留 undefined = 「待询问」；非交互模式下必须全部落定。
export function resolveSetupPlan({ args, envExists = false, platform = process.platform } = {}) {
  const mode = args.yes ? 'noninteractive' : 'interactive';
  const refuse = (code, detail) => ({ mode, refuse: { code, detail } });

  if (args.unknown.length) return refuse('unknown_flag', args.unknown.join(' '));
  if (args.hooks !== undefined && args.hooks !== 'on' && args.hooks !== 'off') {
    return refuse('invalid_hooks', String(args.hooks));
  }
  if (args.desktop !== undefined && args.desktop !== 'on' && args.desktop !== 'off') {
    return refuse('invalid_desktop', String(args.desktop));
  }
  // 桌面控制台只有 macOS 有。静默忽略会让用户以为装上了 —— 明确拒绝才有信息量，
  // 同 src/ops/log-terminal.js 那条「返回 reason 而不是假装成功」。
  if (args.desktop === 'on' && platform !== 'darwin') {
    return refuse('desktop_unsupported', platform);
  }
  // 两种格式互斥。挑一个赢的话，用户会拿到一个自己没要求的格式，而两个路径写的是不同文件 ——
  // 那正是「读写不同源」类问题的种子。
  if (args.configPath !== undefined && args.envPath !== undefined) return refuse('both_formats');
  if (!args.yes) return { mode, workDir: args.workDir, hooks: args.hooks, desktop: args.desktop };
  if (!args.workDir) return refuse('work_dir_required');
  if (envExists && !args.force) return refuse('env_exists');
  // 默认不装：它要跑 swiftc（可能还要用户先 xcode-select --install），与 hooks 同一心智。
  return { mode, workDir: args.workDir, hooks: args.hooks ?? 'off', desktop: args.desktop ?? 'off' };
}

// 交互壳的双语文案（纯文本片段，颜色在 main 里组装）。
export const MESSAGES = {
  zh: {
    title: '⚙  Claude Chat Mobile —— 配置向导',
    noTemplate: '✗ 找不到 .env.example，请在项目根目录运行。',
    overwritePrompt: '已存在，覆盖它? [y/N] ',
    cancelled: '已取消，现有 .env 未改动。',
    tokenLabel: '已生成 AUTH_TOKEN（手机访问必需）',
    tokenWrittenSuffix: '…（已写入 .env）',
    workDirLabel: 'claude 工作目录 WORK_DIR',
    workDirHint: '(回车 = 默认 $HOME)',
    wroteLabel: '已写入',
    permNote: '(权限 0600)',
    nextSteps: '下一步:',
    stepDoctor: '# 预检配置',
    stepStart: '# 启动；日志会打印手机可用的局域网地址',
    publicNote: '公网访问（固定域名 / Cloudflare Access 2FA / 常驻）见 docs/deployment.md。',
    hooksPrompt: '安装 CLI hooks 桥? 让你在电脑终端直接跑的 claude 会话也能推送到手机 [Y/n] ',
    hooksInstalling: '正在安装并验证…',
    hooksSkipped: '已跳过。随时可跑 npm run hooks:install 补装。',
    hooksFailed: '安装未成功（见上方输出）。不影响其余配置；稍后可跑 npm run hooks:install 重试。',
    desktopPrompt: '编译 macOS 桌面控制台? 菜单栏里看服务状态、改配置、看日志，不用开终端。'
      + '需要 Xcode Command Line Tools（不是完整 Xcode，装过 git 的多半已经有）[y/N] ',
    desktopBuilding: '正在编译桌面 app…',
    desktopFailed: '编译未成功（见上方输出）。不影响其余配置；装好 Command Line Tools'
      + '（xcode-select --install）后跑 npm run app:build 重试。',
    usage: '用法: node scripts/setup.js [--config <path>|--env <path>]\n'
      + '      node scripts/setup.js --yes --work-dir=<绝对路径> [--hooks=on|off] [--desktop=on|off] [--force] [--env <path>]',
    refuse: {
      unknown_flag: d => `无法识别的参数：${d}`,
      invalid_hooks: d => `--hooks 只接受 on 或 off，收到：${d}`,
      invalid_desktop: d => `--desktop 只接受 on 或 off，收到：${d}`,
      desktop_unsupported: d => `桌面控制台只有 macOS 有（当前平台：${d}）。服务器上用手机端与命令行，功能是齐的。`,
      work_dir_required: () => '非交互模式必须显式给出 --work-dir=<绝对路径>。'
        + '这里不会静默回落到 $HOME——那等于把整个家目录交给 agent 读写。',
      both_formats: () => '--config 与 --env 只能给一个：前者写 ccm.config.json，后者写旧格式 .env。',
      env_exists: d => `${d} 已存在，非交互模式不会覆盖它（里面可能有正在用的 AUTH_TOKEN）。`
        + '若是从旧版本升级，请跑 node scripts/config.js migrate 迁移，不要用 --force —— '
        + '那会生成一个新 AUTH_TOKEN，所有已授权设备都要重新批准。'
    },
  },
  en: {
    title: '⚙  Claude Chat Mobile — setup wizard',
    noTemplate: '✗ .env.example not found — run this from the project root.',
    overwritePrompt: 'already exists. Overwrite it? [y/N] ',
    cancelled: 'Cancelled. Your existing .env was left untouched.',
    tokenLabel: 'Generated AUTH_TOKEN (required for phone access)',
    tokenWrittenSuffix: '… (written to .env)',
    workDirLabel: 'claude working directory WORK_DIR',
    workDirHint: '(Enter = default $HOME)',
    wroteLabel: 'Wrote',
    permNote: '(mode 0600)',
    nextSteps: 'Next steps:',
    stepDoctor: '# pre-flight your config',
    stepStart: '# start; the log prints a LAN URL you can open on your phone',
    publicNote: 'Public access (fixed domain / Cloudflare Access 2FA / daemon): see docs/deployment.md.',
    hooksPrompt: 'Install the CLI hooks bridge? Lets sessions you run in your own terminal push to your phone [Y/n] ',
    hooksInstalling: 'Installing and verifying…',
    hooksSkipped: 'Skipped. Run npm run hooks:install anytime.',
    hooksFailed: 'Install did not complete (see output above). Your other config is fine; retry with npm run hooks:install.',
    desktopPrompt: 'Build the macOS desktop console? Service state, config and logs from the menu bar, '
      + 'no terminal needed. Requires Xcode Command Line Tools (not full Xcode; if you have git you likely have them) [y/N] ',
    desktopBuilding: 'Building the desktop app…',
    desktopFailed: 'Build did not complete (see output above). Your other config is fine; install the Command Line '
      + 'Tools (xcode-select --install) and retry with npm run app:build.',
    usage: 'usage: node scripts/setup.js [--config <path>|--env <path>]\n'
      + '       node scripts/setup.js --yes --work-dir=<absolute-path> [--hooks=on|off] [--desktop=on|off] [--force] [--env <path>]',
    refuse: {
      unknown_flag: d => `Unrecognized argument: ${d}`,
      invalid_hooks: d => `--hooks accepts only on or off, got: ${d}`,
      invalid_desktop: d => `--desktop accepts only on or off, got: ${d}`,
      desktop_unsupported: d => `The desktop console is macOS-only (this platform: ${d}). On a server, the phone UI and CLI cover everything.`,
      work_dir_required: () => 'Non-interactive mode requires an explicit --work-dir=<absolute-path>. '
        + 'It will not silently fall back to $HOME — that would hand your entire home directory to the agent.',
      both_formats: () => 'Pass either --config or --env, not both: the former writes ccm.config.json, the latter legacy .env.',
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

// 落盘（交互/非交互两条路径共用，防各写一份再分叉）。
//
// 注意成功提示的位置：token 那行必须在 writeOwnerOnlyFile 之后才打印。旧实现先打印
// 「✓ 已生成 AUTH_TOKEN（已写入 .env）」再去问 WORK_DIR，被 EOF/Ctrl-C 打断时一个字没写却已经报了成功。
//
// format='config'（默认）走结构化构造；'env' 是显式要旧格式时的退路（如需要 docker --env-file）。
function writeSetupFile({ envPath, templatePath, workDir, format, t }) {
  const token = generateToken();

  if (format === 'env') {
    const template = readFileSync(templatePath, 'utf8');
    const content = buildEnvContent(template, { authToken: token, workDir: workDir || undefined });
    writeOwnerOnlyFile(envPath, content);
    // 校验替换真的生效——buildEnvContent 靠正则匹配 .env.example 模板里的赋值行，模板格式一旦变了
    // 会静默不替换（.replace 无匹配即原样返回），此前不管有没有生效都打印"已写入"成功提示。
    if (!content.includes(`AUTH_TOKEN=${token}`)) {
      console.error(`\n⚠️  .env.example 模板格式有变，AUTH_TOKEN 未能自动写入！请手动在 ${envPath} 里加一行：\nAUTH_TOKEN=${token}`);
    }
  } else {
    // 结构化构造没有「没匹配上」这个失败模式，所以上面那道兜底校验在这条路径上不需要。
    writeOwnerOnlyFile(envPath, buildConfigContent({ authToken: token, workDir: workDir || undefined }));
  }

  const written = t.tokenWrittenSuffix.replace(/\.env/, basename(envPath));
  console.log(`\n${c.green('✓')} ${t.tokenLabel}: ${c.dim(token.slice(0, 8) + written)}`);
  console.log(`${c.green('✓')} ${t.wroteLabel} ${c.bold(envPath)} ${c.dim(t.permNote)}`);
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

function printNextSteps(t) {
  console.log(c.bold(`\n${t.nextSteps}`));
  console.log(`  ${c.accent('node scripts/doctor.js')}   ${c.dim(t.stepDoctor)}`);
  console.log(`  ${c.accent('npm start')}                ${c.dim(t.stepStart)}`);
  console.log(c.dim(`\n${t.publicNote}\n`));
}

async function runInteractive({ plan, envPath, templatePath, format, t }) {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    // 已有 .env → 先问是否覆盖（默认否，绝不静默覆盖既有配置）
    const existing = [envPath, join(HERE, CONFIG_FILE_NAME), join(HERE, '.env')].find(p => existsSync(p));
    if (existing) {
      const ans = (await rl.question(`⚠️  ${existing} ${t.overwritePrompt}`)).trim().toLowerCase();
      if (ans !== 'y' && ans !== 'yes') {
        console.log(t.cancelled);
        return;
      }
    }

    // WORK_DIR：命令行已给就不问；交互留空 = $HOME（人自己按回车做的选择，与 agent 静默回落不同）
    const workDir = plan.workDir ?? (await rl.question(`\n${t.workDirLabel} ${c.dim(t.workDirHint)}: `)).trim();
    writeSetupFile({ envPath, templatePath, workDir, format, t });

    // CLI hooks 桥：默认装（终端直跑的会话唯有装了它才能推到手机——轮询只能在你已经打开
    // app 时追平镜像，永远不会主动叫你）。默认 Y 但必须问：它写的是用户全局 ~/.claude/settings.json。
    // 桌面控制台：只在 macOS 上问。默认「不装」—— 它要跑 swiftc，而很多人没装 CLT。
    let desktop = plan.desktop;
    if (desktop === undefined) {
      if (process.platform !== 'darwin') {
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
    if (hooks === 'on') installHooksBridge(t);
    else console.log(c.dim(t.hooksSkipped));

    printNextSteps(t);
  } finally {
    rl.close();
  }
}

function runNonInteractive({ plan, envPath, templatePath, format, t }) {
  writeSetupFile({ envPath, templatePath, workDir: plan.workDir, format, t });
  if (plan.hooks === 'on') installHooksBridge(t);
  else console.log(c.dim(t.hooksSkipped));
  if (plan.desktop === 'on') buildDesktopApp(t);
  printNextSteps(t);
}

async function main() {
  const args = parseSetupArgs(process.argv.slice(2));
  // 默认生成统一配置文件；--env 是显式要旧格式时的退路（如需要 docker --env-file）。
  const format = args.envPath ? 'env' : 'config';
  const envPath = args.envPath || args.configPath || join(HERE, CONFIG_FILE_NAME);
  const templatePath = join(HERE, '.env.example');
  const t = MESSAGES[detectLang()];

  console.log(c.bold(`\n${t.title}\n`));

  // 模板只有旧格式路径才需要。结构化构造不读模板，缺了 .env.example 也照样能装机 ——
  // 早前无条件检查会让「仓库里没有 .env.example」直接 exit 1，而新路径根本用不到它。
  if (format === 'env' && !existsSync(templatePath)) {
    console.error(t.noTemplate);
    process.exit(1);
  }

  // ★ 「已经配置过没有」必须同时看两份。默认目标是 ccm.config.json，而既有部署的配置在 .env 里——
  // 只 stat 新路径的话，setup 会在一台正在跑的实例旁边生成一份带**全新 AUTH_TOKEN** 的配置，
  // 且它优先级更高：所有已授权设备（含正在操作的那台手机）当场失效，PORT/CCM_DATA_DIR/CF_ACCESS_* 一并被遮蔽。
  // desktop/CCMCore.swift 的 setupCommand 拼的就是这条命令，菜单栏点一次「安装向导」就会中。
  const existingConfig = [envPath, join(HERE, CONFIG_FILE_NAME), join(HERE, '.env')].find(existsSync);
  const plan = resolveSetupPlan({ args, envExists: !!existingConfig });
  if (plan.refuse) {
    console.error(`✗ ${t.refuse[plan.refuse.code](plan.refuse.detail ?? existingConfig ?? envPath)}\n`);
    console.error(t.usage);
    process.exit(2);
  }

  if (plan.mode === 'noninteractive') runNonInteractive({ plan, envPath, templatePath, format, t });
  else await runInteractive({ plan, envPath, templatePath, format, t });
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
