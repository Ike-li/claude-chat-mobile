// scripts/perf-report.js —— CLI 工具：汇总前端性能上报（ccm-server.log 里的 [client-perf] 行），按维度出 n / p50 / p90 / max。只读。
import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { loadRuntimeEnvironment } from '../app/src/ops/config.js';
import { formatClientPerfReport, parseSince, summarizeClientPerf } from '../app/src/ops/client-perf-report.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// LOG_FILE 可能配在 ccm.config.json 里：走 server 的同一条加载路径，免得读的不是 server 写的那份
loadRuntimeEnvironment(process.env, { dir: ROOT, quiet: true });

function printHelp() {
  console.log(`
CCM 前端性能汇总
用法:
  node scripts/perf-report.js                      - 汇总全部记录
  node scripts/perf-report.js --since 7d           - 只看最近 7 天（也可 24h，或 2026-10-25 这样的日期）
  node scripts/perf-report.js <日志文件 ...>        - 指定日志文件（.gz 也认）
不指定文件时读 LOG_FILE（未配置则 ~/Library/Logs/ccm-server.log），连同 rotate-logs.sh 轮转出的 .N.gz 一起读。
`);
}

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) { printHelp(); process.exit(0); }

let since = null;
const files = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--since') {
    since = parseSince(args[++i]);
    if (since == null) { console.error(`--since 认不出：${args[i] ?? '（缺值）'}，要 7d、24h 或 YYYY-MM-DD`); process.exit(1); }
  } else if (args[i].startsWith('-')) {
    console.error(`未知参数：${args[i]}`);
    printHelp();
    process.exit(1);
  } else files.push(args[i]);
}

if (!files.length) {
  const logFile = process.env.LOG_FILE || join(homedir(), 'Library', 'Logs', 'ccm-server.log');
  files.push(logFile);
  // rotate-logs.sh 的归档：<f>.0.gz（最新）… <f>.N.gz
  const archive = new RegExp(`^${basename(logFile).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.\\d+\\.gz$`);
  try {
    for (const name of readdirSync(dirname(logFile))) if (archive.test(name)) files.push(join(dirname(logFile), name));
  } catch { /* 目录读不了：下面读主文件时一并报 */ }
}

const lines = [];
for (const file of files) {
  try {
    const raw = readFileSync(file);
    lines.push(...(file.endsWith('.gz') ? gunzipSync(raw) : raw).toString('utf8').split('\n').filter(line => line.includes(' [client-perf] ')));
  } catch (err) {
    console.error(err?.code === 'ENOENT' ? `日志文件不存在：${file}（未配置 LOG_FILE，或进程输出没有重定向到文件）` : `读取失败：${file}（${err?.message}）`);
    process.exit(1);
  }
}

console.log(`读取：${files.join('、')}\n`);
console.log(formatClientPerfReport(summarizeClientPerf(lines, { since })));
