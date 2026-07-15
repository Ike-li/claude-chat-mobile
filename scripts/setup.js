#!/usr/bin/env node
// scripts/setup.js —— 一键配置向导：交互生成 .env（AUTH_TOKEN + WORK_DIR），零依赖。
// 用法: node scripts/setup.js [--env path/to/.env]
//   覆盖最简路径（同 WiFi / 临时公网）的核心配置。头号门槛是「必须设 AUTH_TOKEN,
//   否则只绑 127.0.0.1、手机连不上」——向导默认帮你生成。
//   公网固定部署（Cloudflare Access 2FA / 隧道 / 常驻）不在向导内，见 docs/deployment.md。
//   界面语言按环境 locale 自动选：zh_* → 中文，其余 → 英文。
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
  },
};

// ──────────────────────── 交互壳（手动跑验证）────────────────────────

const c = {
  bold: s => `\x1b[1m${s}\x1b[0m`,
  green: s => `\x1b[32m${s}\x1b[0m`,
  dim: s => `\x1b[2m${s}\x1b[0m`,
  accent: s => `\x1b[36m${s}\x1b[0m`,
};

function parseArgs(argv) {
  const i = argv.indexOf('--env');
  return { envPath: i >= 0 && argv[i + 1] ? argv[i + 1] : join(HERE, '.env') };
}

async function main() {
  const { envPath } = parseArgs(process.argv.slice(2));
  const templatePath = join(HERE, '.env.example');
  const t = MESSAGES[detectLang()];

  console.log(c.bold(`\n${t.title}\n`));

  if (!existsSync(templatePath)) {
    console.error(t.noTemplate);
    process.exit(1);
  }

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

    // AUTH_TOKEN：默认自动生成（实测头号门槛——不设则手机连不上）
    const token = generateToken();
    console.log(`\n${c.green('✓')} ${t.tokenLabel}: ${c.dim(token.slice(0, 8) + t.tokenWrittenSuffix)}`);

    // WORK_DIR：默认留空（= $HOME）
    const wd = (await rl.question(`\n${t.workDirLabel} ${c.dim(t.workDirHint)}: `)).trim();

    const template = readFileSync(templatePath, 'utf8');
    const content = buildEnvContent(template, { authToken: token, workDir: wd || undefined });
    writeOwnerOnlyFile(envPath, content);

    // 校验替换真的生效——buildEnvContent 靠正则匹配 .env.example 模板里的赋值行，模板格式一旦变了
    // 会静默不替换（.replace 无匹配即原样返回），此前不管有没有生效都打印"已写入"成功提示。
    if (!content.includes(`AUTH_TOKEN=${token}`)) {
      console.error(`\n⚠️  .env.example 模板格式有变，AUTH_TOKEN 未能自动写入！请手动在 ${envPath} 里加一行：\nAUTH_TOKEN=${token}`);
    }
    console.log(`\n${c.green('✓')} ${t.wroteLabel} ${c.bold(envPath)} ${c.dim(t.permNote)}`);
    console.log(c.bold(`\n${t.nextSteps}`));
    console.log(`  ${c.accent('node scripts/doctor.js')}   ${c.dim(t.stepDoctor)}`);
    console.log(`  ${c.accent('npm start')}                ${c.dim(t.stepStart)}`);
    console.log(c.dim(`\n${t.publicNote}\n`));
  } finally {
    rl.close();
  }
}

// 仅直接运行时进入交互；被测试 import 时不执行 main。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
