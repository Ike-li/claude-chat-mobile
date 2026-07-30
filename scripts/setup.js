#!/usr/bin/env node
// scripts/setup.js —— 一键配置向导：生成 .env（AUTH_TOKEN + WORK_DIR），零依赖。
// 用法: node scripts/setup.js [--env <path>]                        # 交互向导（人用）
//       node scripts/setup.js --yes --work-dir=<path> [--hooks=on|off] [--force]  # 非交互（编程 agent 用）
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
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeOwnerOnlyFile } from '../src/files/file-security.js';

const HERE = dirname(dirname(fileURLToPath(import.meta.url)));

// ──────────────────────── 纯逻辑（可单测）────────────────────────

// 生成十六进制随机 token（默认 32 字节 = 64 hex 字符）。
export function generateToken(bytes = 32) {
  return randomBytes(bytes).toString('hex');
}

// 基于 .env.example 模板填入 AUTH_TOKEN / WORK_DIR，返回新的 .env 内容。
// 只替换行首的赋值行（KEY=…），注释与其他行原样保留。
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
  const out = { envPath: undefined, yes: false, workDir: undefined, hooks: undefined, force: false, unknown: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf('=');
    const name = eq > 0 ? arg.slice(0, eq) : arg;
    const inline = eq > 0 ? arg.slice(eq + 1) : undefined;
    const value = () => (inline !== undefined ? inline : argv[++i]);
    if (name === '--env') out.envPath = value();
    else if (name === '--work-dir') out.workDir = value();
    else if (name === '--hooks') out.hooks = value();
    else if (name === '--yes' || name === '-y') out.yes = true;
    else if (name === '--force') out.force = true;
    else out.unknown.push(arg);
  }
  return out;
}

// 把参数 + 磁盘现状（.env 是否已存在）解析成一份可执行计划，或一条拒绝理由。
// 交互模式下未给的项留 undefined = 「待询问」；非交互模式下必须全部落定。
export function resolveSetupPlan({ args, envExists = false } = {}) {
  const mode = args.yes ? 'noninteractive' : 'interactive';
  const refuse = (code, detail) => ({ mode, refuse: { code, detail } });

  if (args.unknown.length) return refuse('unknown_flag', args.unknown.join(' '));
  if (args.hooks !== undefined && args.hooks !== 'on' && args.hooks !== 'off') {
    return refuse('invalid_hooks', String(args.hooks));
  }
  if (!args.yes) return { mode, workDir: args.workDir, hooks: args.hooks };
  if (!args.workDir) return refuse('work_dir_required');
  if (envExists && !args.force) return refuse('env_exists');
  return { mode, workDir: args.workDir, hooks: args.hooks ?? 'off' };
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
    usage: '用法: node scripts/setup.js [--env <path>]\n'
      + '      node scripts/setup.js --yes --work-dir=<绝对路径> [--hooks=on|off] [--force] [--env <path>]',
    refuse: {
      unknown_flag: d => `无法识别的参数：${d}`,
      invalid_hooks: d => `--hooks 只接受 on 或 off，收到：${d}`,
      work_dir_required: () => '非交互模式必须显式给出 --work-dir=<绝对路径>。'
        + '这里不会静默回落到 $HOME——那等于把整个家目录交给 agent 读写。',
      env_exists: d => `${d} 已存在，非交互模式不会覆盖它（里面可能有正在用的 AUTH_TOKEN）。`
        + '确认要覆盖再加 --force。',
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
    usage: 'usage: node scripts/setup.js [--env <path>]\n'
      + '       node scripts/setup.js --yes --work-dir=<absolute-path> [--hooks=on|off] [--force] [--env <path>]',
    refuse: {
      unknown_flag: d => `Unrecognized argument: ${d}`,
      invalid_hooks: d => `--hooks accepts only on or off, got: ${d}`,
      work_dir_required: () => 'Non-interactive mode requires an explicit --work-dir=<absolute-path>. '
        + 'It will not silently fall back to $HOME — that would hand your entire home directory to the agent.',
      env_exists: d => `${d} already exists; non-interactive mode will not overwrite it `
        + '(it may hold the AUTH_TOKEN you are using). Add --force if you really mean to replace it.',
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

// 落盘 .env（两条路径共用，防交互/非交互各写一份再分叉）。
// 注意成功提示的位置：token 那行必须在 writeOwnerOnlyFile 之后才打印。旧实现先打印
// 「✓ 已生成 AUTH_TOKEN（已写入 .env）」再去问 WORK_DIR，被 EOF/Ctrl-C 打断时一个字没写却已经报了成功。
function writeEnvFile({ envPath, templatePath, workDir, t }) {
  const token = generateToken();
  const template = readFileSync(templatePath, 'utf8');
  const content = buildEnvContent(template, { authToken: token, workDir: workDir || undefined });
  writeOwnerOnlyFile(envPath, content);

  // 校验替换真的生效——buildEnvContent 靠正则匹配 .env.example 模板里的赋值行，模板格式一旦变了
  // 会静默不替换（.replace 无匹配即原样返回），此前不管有没有生效都打印"已写入"成功提示。
  if (!content.includes(`AUTH_TOKEN=${token}`)) {
    console.error(`\n⚠️  .env.example 模板格式有变，AUTH_TOKEN 未能自动写入！请手动在 ${envPath} 里加一行：\nAUTH_TOKEN=${token}`);
  }
  console.log(`\n${c.green('✓')} ${t.tokenLabel}: ${c.dim(token.slice(0, 8) + t.tokenWrittenSuffix)}`);
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

function printNextSteps(t) {
  console.log(c.bold(`\n${t.nextSteps}`));
  console.log(`  ${c.accent('node scripts/doctor.js')}   ${c.dim(t.stepDoctor)}`);
  console.log(`  ${c.accent('npm start')}                ${c.dim(t.stepStart)}`);
  console.log(c.dim(`\n${t.publicNote}\n`));
}

async function runInteractive({ plan, envPath, templatePath, t }) {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    // 已有 .env → 先问是否覆盖（默认否，绝不静默覆盖既有配置）
    if (existsSync(envPath)) {
      const ans = (await rl.question(`⚠️  ${envPath} ${t.overwritePrompt}`)).trim().toLowerCase();
      if (ans !== 'y' && ans !== 'yes') {
        console.log(t.cancelled);
        return;
      }
    }

    // WORK_DIR：命令行已给就不问；交互留空 = $HOME（人自己按回车做的选择，与 agent 静默回落不同）
    const workDir = plan.workDir ?? (await rl.question(`\n${t.workDirLabel} ${c.dim(t.workDirHint)}: `)).trim();
    writeEnvFile({ envPath, templatePath, workDir, t });

    // CLI hooks 桥：默认装（终端直跑的会话唯有装了它才能推到手机——轮询只能在你已经打开
    // app 时追平镜像，永远不会主动叫你）。默认 Y 但必须问：它写的是用户全局 ~/.claude/settings.json。
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

function runNonInteractive({ plan, envPath, templatePath, t }) {
  writeEnvFile({ envPath, templatePath, workDir: plan.workDir, t });
  if (plan.hooks === 'on') installHooksBridge(t);
  else console.log(c.dim(t.hooksSkipped));
  printNextSteps(t);
}

async function main() {
  const args = parseSetupArgs(process.argv.slice(2));
  const envPath = args.envPath || join(HERE, '.env');
  const templatePath = join(HERE, '.env.example');
  const t = MESSAGES[detectLang()];

  console.log(c.bold(`\n${t.title}\n`));

  if (!existsSync(templatePath)) {
    console.error(t.noTemplate);
    process.exit(1);
  }

  const plan = resolveSetupPlan({ args, envExists: existsSync(envPath) });
  if (plan.refuse) {
    console.error(`✗ ${t.refuse[plan.refuse.code](plan.refuse.detail ?? envPath)}\n`);
    console.error(t.usage);
    process.exit(2);
  }

  if (plan.mode === 'noninteractive') runNonInteractive({ plan, envPath, templatePath, t });
  else await runInteractive({ plan, envPath, templatePath, t });
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
