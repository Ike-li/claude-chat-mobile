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
      const response = await fetch(`${env.CCM_SMOKE_URL}/health`);
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
    ...process.env,
    AUTH_TOKEN: '',
    PORT: String(port),
    WORK_DIR: workDir,
    WORK_DIRS: workDir,
    CCM_DATA_DIR: dataDir,
    CCM_SMOKE_URL: `http://127.0.0.1:${port}`,
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
