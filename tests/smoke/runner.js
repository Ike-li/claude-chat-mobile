#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(import.meta.dirname, '..', '..');

const SCENARIOS = Object.freeze({
  core: { script: 'core.js', description: '核心消息、中断、工具、上下文与跨重启 resume', restart: true },
  background: { script: 'background-task.js', description: '后台任务完成通知与自动汇报轮' },
  reconnect: { script: 'reconnect.js', description: '断线期间继续执行与 sync:since 续传' },
  'permission-modes': { script: 'permission-modes.js', description: 'default 与 bypass 的真实权限行为', model: 'positional' },
  'plan-mode': { script: 'plan-mode.js', description: 'plan 档不执行文件修改', model: 'positional' },
  concurrency: { script: 'concurrency.js', description: '同工作区两个真实会话并发', managesServer: true, args: ['--e2e'], model: 'flag' },
  statusline: { script: 'statusline.js', description: '真实 Web statusline 投影' },
  upload: { script: 'upload.js', description: '附件落盘、注入与 Claude Read 回显' },
  entrypoint: { script: 'entrypoint.js', description: 'Web 会话在 Claude CLI resume 中可见' },
  'model-switch': { script: 'model-switch.js', description: '真实模型切换及 result.models', model: 'flag' },
  question: { script: 'question.js', description: 'AskUserQuestion 真实选择与答案回显' },
  'slash-command': { script: 'slash-command.js', description: 'Agent SDK 斜杠命令行为', managesServer: true },
});

export function smokeScenarioNames() {
  return Object.keys(SCENARIOS);
}

// 起 smoke server 时必须从继承环境里【摘掉】的键。
//
// 【为什么需要】smoke 用 `{...process.env}` 继承调用者的环境，而调用者未必是一个干净的 shell：
// 2026-09-01 实测，从 CCM web 端启动的 Claude Code 会话会继承生产 server 进程的整份环境
// （`CCM_HOOKS_ORIGIN=web-sdk` 就是那条血统的指纹），于是 CF_ACCESS_* / VAPID_* 原样流进每个
// smoke 实例：CF Access 被启用后实例真的去拉了生产 team 的证书，推送密钥也一并带上。
// 隔离靠的是「显式给 WORK_DIR/CCM_DATA_DIR/PORT」，但那只覆盖它们列出的键——**没列到的键默认继承**，
// 这正是清单要存在的原因。删除而不是置空串：loadRuntimeEnvironment 会把空串当「未设置」删掉，
// 但中途任何一个消费者若在删除前读到空串，语义就分叉了（见 config.js 的 SH-001 注释）。
export const SMOKE_ENV_BLOCKLIST = Object.freeze([
  'CF_ACCESS_HOSTNAME', 'CF_ACCESS_TEAM', 'CF_ACCESS_AUD',   // 启用后会对外拉 JWKS + 改鉴权路径
  'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT',  // 生产推送密钥，测试实例不该持有
  'PUBLIC_URL',                                              // 通知深链会指向生产域名
  'NTFY_URL', 'NTFY_TOPIC',                                  // 外部通知通道
  'WORK_DIRS_FILE',                                          // 会盖掉下面显式传的 WORK_DIRS
  'CCM_HOOKS_ORIGIN', 'CCM_STATUSLINE_ORIGIN',               // 两个桥的血统标记，继承会让来源判定失真
]);

/** 从继承环境里摘掉不该带进 smoke 实例的键。纯函数，便于单测。 */
export function stripInheritedEnv(env, blocklist = SMOKE_ENV_BLOCKLIST) {
  const out = { ...env };
  for (const key of blocklist) delete out[key];
  return out;
}

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  if (index === -1) return null;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

export function parseSmokeArgs(args) {
  const model = valueAfter(args, '--model');
  if (args.includes('--list')) return { action: 'list', names: [], model };
  if (args.includes('--all')) return { action: 'run', names: smokeScenarioNames(), model };
  const name = valueAfter(args, '--scenario');
  if (!name) throw new Error('Choose --list, --scenario <name>, or --all');
  if (!SCENARIOS[name]) throw new Error(`Unknown smoke scenario: ${name}`);
  return { action: 'run', names: [name], model };
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(error => error ? reject(error) : resolvePort(port));
    });
  });
}

function waitForExit(child) {
  return new Promise((resolveExit, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolveExit({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    child.once('error', reject);
    child.once('exit', (code, signal) => resolveExit({ code, signal }));
  });
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
  try {
    await waitForExit(child);
  } finally {
    clearTimeout(timer);
  }
}

async function startServer(env) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', chunk => {
      output = (output + chunk).slice(-20_000);
      if (process.env.DEBUG_SERVER) process.stderr.write(chunk);
    });
  }

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode})\n${output}`);
    try {
      // 探针必须带 token：§1.9 起 server 一定有 AUTH_TOKEN，/health 也就一定要鉴权。
      // 不带的话这里恒 401 → response.ok 永假 → 20s 后报「server readiness timed out」，
      // 而日志里 server 明明已经打完启动横幅，很容易误判成 server 起不来。
      const response = await fetch(`${env.CCM_SMOKE_URL}/health?token=${encodeURIComponent(env.AUTH_TOKEN)}`);
      if (response.ok) return child;
    } catch {
      // The listener is not ready yet.
    }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 150));
  }
  await stopServer(child);
  throw new Error(`server readiness timed out\n${output}`);
}

function scenarioArgs(scenario, model) {
  const args = [...(scenario.args || [])];
  if (model && scenario.model === 'flag') args.push(`--model=${model}`);
  if (model && scenario.model === 'positional') args.push(model);
  return args;
}

async function runScript(scenario, env, model, extraArgs = []) {
  const path = join(ROOT, 'tests', 'smoke', 'scenarios', scenario.script);
  const child = spawn(process.execPath, [path, ...scenarioArgs(scenario, model), ...extraArgs], {
    cwd: ROOT,
    env,
    stdio: 'inherit',
  });
  const result = await waitForExit(child);
  if (result.code !== 0) {
    throw new Error(`${scenario.script} failed (${result.signal || result.code})`);
  }
}

async function runScenario(name, model) {
  const scenario = SCENARIOS[name];
  const root = mkdtempSync(join(tmpdir(), `ccm-smoke-${name}-`));
  const workDir = join(root, 'work');
  const dataDir = join(root, 'data');
  mkdirSync(workDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const port = await freePort();
  const env = {
    ...stripInheritedEnv(process.env),    // 摘掉 CF_ACCESS_*/VAPID_* 等生产键（见 SMOKE_ENV_BLOCKLIST）
    AUTH_TOKEN: 'ccm-smoke-test-token',   // §1.9：没有 token server 拒绝启动
    PORT: String(port),
    WORK_DIR: workDir,
    WORK_DIRS: workDir,
    CCM_DATA_DIR: dataDir,
    CCM_SMOKE_URL: `http://127.0.0.1:${port}`,
    // 同集成测 _spawn-server：禁桌面日志窗，防 smoke 起服堆 Terminal.app
    LOG_TERMINAL: 'off',
  };
  let server = null;

  try {
    console.log(`\n=== ${name}: ${scenario.description} ===`);
    if (scenario.managesServer) {
      await runScript(scenario, env, model);
      return;
    }

    server = await startServer(env);
    await runScript(scenario, env, model);
    if (scenario.restart) {
      await stopServer(server);
      server = await startServer(env);
      await runScript(scenario, env, model, ['--phase2']);
    }
  } finally {
    await stopServer(server);
    rmSync(root, { recursive: true, force: true });
  }
}

async function main() {
  try {
    const parsed = parseSmokeArgs(process.argv.slice(2));
    if (parsed.action === 'list') {
      for (const [name, scenario] of Object.entries(SCENARIOS)) {
        console.log(`${name.padEnd(18)} ${scenario.description}`);
      }
      return;
    }
    console.warn('These scenarios call the real Claude CLI and may consume tokens.');
    for (const name of parsed.names) await runScenario(name, parsed.model);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}
