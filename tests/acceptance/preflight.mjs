#!/usr/bin/env node
// tests/acceptance/preflight.mjs —— 开跑前检查（只读，不起任何东西）
//
//   node tests/acceptance/preflight.mjs [--gateway] [--target <被测检出目录>]
//
// 查四样：local/config.json 与 local/secrets.json 在不在（后者必须 600）、还有哪些占位符没填、
// docker 与 compose 能不能用、被测检出与本套件的 compose 文件齐不齐。--gateway 再对 config 里的
// 网关地址做一次带超时的连通探测——只看通不通，不带令牌：连通性不需要凭据，也就不该把它发出去。
// 输出只点名字段路径，从不打印 secrets 的值。有 ✗ 以 1 退出。
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLACEHOLDER = /^<填写/;
// compose 覆盖层用了 !override / !reset（env/compose.*.accept.yml），2.24 起才支持
const MIN_COMPOSE = [2, 24];

function placeholders(value, path = '') {
  if (typeof value === 'string') return PLACEHOLDER.test(value) ? [path] : [];
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => placeholders(v, path ? `${path}.${k}` : k));
  }
  return [];
}

// 'localhost:9' 也解析得了（协议成了 localhost:），所以要的是 http(s) 地址，而不只是 new URL 不抛
function httpOrigin(raw) {
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null;
  } catch { return null; }
}

function readJson(file) {
  try { return { value: JSON.parse(readFileSync(file, 'utf8')) }; } catch (err) { return { error: err.code === 'ENOENT' ? '不存在' : `读不出来（${err.message.split('\n')[0]}）` }; }
}

export function defaultDockerProbe() {
  const run = args => execFileSync('docker', args, { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    const server = run(['version', '--format', '{{.Server.Version}}']);
    const compose = run(['compose', 'version', '--short']).replace(/^v/, '');
    const [major, minor] = compose.split('.').map(Number);
    if (major < MIN_COMPOSE[0] || (major === MIN_COMPOSE[0] && minor < MIN_COMPOSE[1])) {
      return { ok: false, detail: `docker compose ${compose} 太旧：覆盖层用了 !override，需要 ≥ ${MIN_COMPOSE.join('.')}` };
    }
    return { ok: true, detail: `docker ${server} · compose ${compose}` };
  } catch (err) {
    return { ok: false, detail: String(err.stderr || err.message).trim().split('\n')[0] };
  }
}

export async function runPreflight({
  acceptanceDir, target, gateway = false, probeDocker = defaultDockerProbe, fetchImpl = fetch, timeoutMs = 5_000,
}) {
  const checks = [];
  const add = (level, item, detail = '') => checks.push({ level, item, detail });

  const configPath = join(acceptanceDir, 'local', 'config.json');
  const config = readJson(configPath);
  if (config.error) add('fail', 'local/config.json', `${config.error}：先跑 node tests/acceptance/setup.mjs 再填写`);
  else {
    add('ok', 'local/config.json');
    const todo = placeholders(config.value);
    if (todo.length) add('warn', 'local/config.json 未填', todo.join('、'));
  }

  const secretsPath = join(acceptanceDir, 'local', 'secrets.json');
  const secrets = readJson(secretsPath);
  if (secrets.error) add('fail', 'local/secrets.json', `${secrets.error}：先跑 node tests/acceptance/setup.mjs 再填写`);
  else {
    const mode = statSync(secretsPath).mode & 0o777;
    if (mode !== 0o600) add('fail', 'local/secrets.json 权限', `是 ${mode.toString(8).padStart(4, '0')}，应为 600：chmod 600 tests/acceptance/local/secrets.json`);
    else add('ok', 'local/secrets.json（600）');
    const todo = placeholders(secrets.value);
    if (todo.length) add('warn', 'local/secrets.json 未填', todo.join('、'));
  }

  const docker = probeDocker();
  add(docker.ok ? 'ok' : 'fail', 'docker', docker.detail);

  for (const [base, rel] of [
    [acceptanceDir, 'env/compose.accept.yml'],
    [acceptanceDir, 'env/compose.newuser.accept.yml'],
    [target, 'tests/infra/docker-compose.playground.yml'],
    [target, 'tests/infra/newuser/docker-compose.yml'],
  ]) {
    const p = join(base, rel);
    add(existsSync(p) ? 'ok' : 'fail', base === target ? `被测检出 ${rel}` : rel, existsSync(p) ? '' : `找不到 ${p}`);
  }

  if (gateway) {
    const baseUrl = config.value?.gateway?.baseUrl;
    const origin = baseUrl && httpOrigin(baseUrl);
    if (!baseUrl || PLACEHOLDER.test(baseUrl)) {
      add('fail', '网关', 'local/config.json 的 gateway.baseUrl 还没填');
    } else if (!origin) {
      add('fail', '网关', 'local/config.json 的 gateway.baseUrl 不是 http(s) 地址：要带 http:// 或 https://（如 http://127.0.0.1:<端口>）');
    } else {
      try {
        const res = await fetchImpl(baseUrl, { method: 'GET', signal: AbortSignal.timeout(timeoutMs) });
        add('ok', '网关', `${origin} 有响应（HTTP ${res.status}）`);
      } catch (err) {
        const why = err.name === 'TimeoutError' ? `${timeoutMs}ms 内无响应` : (err.cause?.code || err.message);
        add('fail', '网关', `${origin} 连不上：${why}`);
      }
    }
  }
  return { checks, ok: !checks.some(c => c.level === 'fail') };
}

async function main(argv) {
  const acceptanceDir = fileURLToPath(new URL('.', import.meta.url));
  let target = resolve(acceptanceDir, '..', '..');
  let gateway = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--gateway') gateway = true;
    else if (argv[i] === '--target' && argv[i + 1]) target = resolve(argv[++i]);
    else {
      console.error(`不认识的参数 ${argv[i]}\n用法: node tests/acceptance/preflight.mjs [--gateway] [--target <被测检出目录>]`);
      process.exit(2);
    }
  }
  const { checks, ok } = await runPreflight({ acceptanceDir, target, gateway });
  const mark = { ok: '✓', warn: '⚠', fail: '✗' };
  for (const c of checks) console.log(`${mark[c.level]} ${c.item}${c.detail ? `：${c.detail}` : ''}`);
  process.exit(ok ? 0 : 1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
