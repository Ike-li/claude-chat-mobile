// tests/unit/playground-compose.test.mjs —— playground compose 隔离契约
//
// 这些断言锁的是「干净 Linux 用户」夹具不会吃进宿主机 ccm.config.json / .env / data/ / 秘密。
// YAML 按原文扫，不 parse：${ 插值、列表式 environment、漏写的空键，parse 之后就看不见了。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { SPAWN_ENV_BLOCKLIST } from '../helpers/spawn-env.mjs';
import { classifyRepositoryPath } from '../../tests/gates/repo-inventory.js';

const ROOT = join(import.meta.dirname, '..', '..');
const PLAYGROUND_TOKEN = 'playground-local-not-a-secret';
const HOME = '/home/ccm-test';
const WORK_DIR = '/home/ccm-test/workspace';
const COMPOSE = join(ROOT, 'tests/infra/docker-compose.playground.yml');
const TEST_OVERRIDE = join(ROOT, 'tests/infra/docker-compose.playground.test.yml');
const TEST_COMPOSE = join(ROOT, 'tests/infra/docker-compose.test.yml');
const RUNTIME_ENV = join(ROOT, 'tests/infra/playground/runtime.env');
const PACKAGE_JSON = join(ROOT, 'package.json');
const TEST_WORKFLOW = join(ROOT, '.github/workflows/test.yml');
const FAKE_CLAUDE = join(ROOT, 'tests/fixtures/fake-claude.sh');

const ANTHROPIC_KEYS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL'];
const YAML_EMPTY_OR_LITERAL = (key) => new RegExp(`^\\s+${key}:\\s*(?:""|''|\\S)`, 'm');

function read(path) {
  assert.equal(existsSync(path), true, `缺少 ${path}`);
  return readFileSync(path, 'utf8');
}

function parseEnvFile(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    assert.notEqual(eq, -1, `runtime.env 行不是 KEY=VALUE：${trimmed}`);
    out[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return out;
}

function serviceBlock(yaml, name) {
  const start = yaml.search(new RegExp(`^ {2}${name}:`, 'm'));
  assert.notEqual(start, -1, `compose 里没有 ${name} 服务`);
  const header = `  ${name}:\n`;
  const rest = yaml.slice(start + header.length);
  const next = rest.search(/\n {2}[a-zA-Z][a-zA-Z0-9_-]*:|\n[a-zA-Z]/);
  return next === -1 ? rest : rest.slice(0, next);
}

function workflowJobBlock(yaml, name) {
  const start = yaml.search(new RegExp(`^  ${name}:`, 'm'));
  assert.notEqual(start, -1, `workflow 里没有 ${name} job`);
  const header = `  ${name}:\n`;
  const rest = yaml.slice(start + header.length);
  const next = rest.search(/\n {2}[a-zA-Z][a-zA-Z0-9_-]*:/);
  return next === -1 ? rest : rest.slice(0, next);
}

test('runtime.env 钉死隔离键，不把 HOME 当工作区，不设 CI', () => {
  const env = parseEnvFile(read(RUNTIME_ENV));
  assert.equal(env.AUTH_TOKEN, PLAYGROUND_TOKEN);
  assert.equal(env.HOME, HOME);
  assert.equal(env.WORK_DIR, WORK_DIR);
  assert.equal(env.WORK_DIRS, WORK_DIR);
  assert.notEqual(env.WORK_DIR, env.HOME);
  assert.ok(env.WORK_DIR.startsWith(`${HOME}/`));
  assert.ok(env.CCM_DATA_DIR.startsWith(`${HOME}/`));
  assert.equal(env.CLAUDE_BIN, '/app/tests/fixtures/fake-claude.sh');
  assert.equal(env.CCM_TEST_PRESERVE_EMPTY_ENV, '1');
  assert.notEqual(env.DEV_MODE, '1');
  assert.equal(Object.hasOwn(env, 'CI'), false);
  assert.equal(Object.hasOwn(env, 'CCM_FAKE_CLAUDE_TURNS'), false, 'deterministic turn 只能由 playground app 显式开启');

  for (const key of SPAWN_ENV_BLOCKLIST) {
    assert.equal(Object.hasOwn(env, key), true, `runtime.env 缺少 blocklist 键 ${key}`);
  }
  assert.equal(Object.hasOwn(env, 'NTFY_TOKEN'), true);
  for (const key of ANTHROPIC_KEYS) {
    assert.equal(Object.hasOwn(env, key), true, `runtime.env 缺少 ${key}`);
    assert.equal(env[key], '', `${key} 必须是空串，不能省略`);
  }
});

test('playground compose：镜像、端口、overlay、profiles、零插值、映射 environment', () => {
  const yaml = read(COMPOSE);
  assert.match(yaml, /dockerfile:\s*tests\/infra\/Dockerfile\.test/);
  assert.match(yaml, /image:\s*ccm-test:local/);
  assert.match(yaml, /pull_policy:\s*never/);
  assert.match(yaml, /127\.0\.0\.1:13000:3000/);
  assert.match(yaml, /127\.0\.0\.1:13100:3100/);
  assert.match(yaml, /127\.0\.0\.1:18080:8080/);
  assert.doesNotMatch(yaml, /^\s+-\s+["']?3000:3000["']?\s*$/m);
  assert.doesNotMatch(yaml, /^\s+-\s+["']?(?:\.|\.\.\/\.\.):\/app["']?\s*$/m);
  assert.doesNotMatch(yaml, /^\s+- .*:\/app\/\.env/m);
  assert.doesNotMatch(yaml, /^\s+- .*:\/app\/ccm\.config\.json/m);
  assert.match(yaml, /\.\.\/\.\.\/app:\/app\/app/);
  assert.match(yaml, /\.\.\/\.\.\/scripts:\/app\/scripts/);
  assert.match(yaml, /\.\.\/\.\.\/tests:\/app\/tests/);
  assert.match(yaml, /\/app\/tests\/infra\/playground\/entrypoint-app\.sh/);
  assert.doesNotMatch(yaml, /\$\{/);
  assert.doesNotMatch(yaml, /env_file:\s*\.env\b/);
  assert.doesNotMatch(yaml, /\/var\/run\/docker\.sock/);
  assert.doesNotMatch(yaml, /environment:\s*\n(?:[ \t]*#[^\n]*\n)*[ \t]+-\s+[A-Z0-9_]+/);

  for (const key of [...SPAWN_ENV_BLOCKLIST, ...ANTHROPIC_KEYS, 'NTFY_TOKEN']) {
    assert.match(yaml, YAML_EMPTY_OR_LITERAL(key), `YAML 缺少 ${key}: "" 或字面量`);
  }

  const app = serviceBlock(yaml, 'app');
  assert.match(app, /init:\s*true/);
  assert.match(app, /^\s+CCM_FAKE_CLAUDE_TURNS:\s*"1"\s*$/m);
  assert.doesNotMatch(app, /^\s+profiles:/m);

  for (const name of ['mock', 'proxy', 'probe', 'browser']) {
    assert.match(serviceBlock(yaml, name), /^\s+profiles:/m, `${name} 必须有 profiles`);
  }

  const proxy = serviceBlock(yaml, 'proxy');
  assert.match(proxy, /network_mode:\s*service:app/);
  assert.match(proxy, /image:\s*nginx:1\.27-alpine/);

  const browser = serviceBlock(yaml, 'browser');
  assert.doesNotMatch(browser, /network_mode:\s*service:app/);

  for (const name of ['app', 'probe', 'browser']) {
    assert.match(serviceBlock(yaml, name), /playground-home/, `${name} 必须挂 playground-home（或同名数据卷）`);
  }
});

test('fake Claude 默认静默，只有显式 turn 模式才完成 initialize + user 回合', () => {
  const version = spawnSync(FAKE_CLAUDE, ['--version'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(version.status, 0, version.stderr);
  assert.match(version.stdout, /0\.0\.0-fake/);

  const userText = 'hello deterministic fake';
  const input = [
    JSON.stringify({ type: 'control_request', request_id: 'req-init', request: { subtype: 'initialize' } }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: userText }] } }),
    '',
  ].join('\n');

  const silent = spawnSync(FAKE_CLAUDE, ['--output-format', 'stream-json'], {
    cwd: ROOT,
    input,
    encoding: 'utf8',
    timeout: 5_000,
    env: { ...process.env, CCM_FAKE_CLAUDE_TURNS: '' },
  });
  assert.equal(silent.status, 0, silent.stderr);
  assert.equal(silent.stdout, '');

  const turn = spawnSync(FAKE_CLAUDE, ['--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose'], {
    cwd: ROOT,
    input,
    encoding: 'utf8',
    timeout: 5_000,
    env: { ...process.env, CCM_FAKE_CLAUDE_TURNS: '1' },
  });
  assert.equal(turn.status, 0, turn.stderr);
  const messages = turn.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const init = messages.find(message => message.type === 'system' && message.subtype === 'init');
  assert.equal(init?.model, 'claude-fake-test');
  assert.equal(messages.find(message => message.type === 'assistant')?.message?.content?.[0]?.text,
    `CCM deterministic fake reply: ${userText}`);
  assert.equal(messages.find(message => message.type === 'result')?.subtype, 'success');
});

test('test compose 仍不发端口，并与 playground 共享 ccm-test:local 标签', () => {
  const yaml = read(TEST_COMPOSE);
  assert.match(yaml, /image:\s*ccm-test:local/);
  assert.doesNotMatch(yaml, /^\s+ports:/m);
});

test('playground test override：共享 testdata volume，禁止单服务 tmpfs', () => {
  const yaml = read(TEST_OVERRIDE);
  for (const name of ['app', 'probe', 'browser']) {
    assert.match(serviceBlock(yaml, name), /playground-testdata:/, `${name} 必须挂 playground-testdata`);
  }
  assert.doesNotMatch(yaml, /^\s+tmpfs:/m);
});

test('package.json 有 test:docker:playground、没有宿主机原生 test:playground', () => {
  const scripts = JSON.parse(read(PACKAGE_JSON)).scripts;
  assert.equal(Object.hasOwn(scripts, 'test:docker:playground'), true);
  assert.equal(Object.hasOwn(scripts, 'test:playground'), false);
});

test('GitHub CI 必须持续执行真实 app playground，而不是只靠维护者手工运行', () => {
  const yaml = read(TEST_WORKFLOW);
  const job = workflowJobBlock(yaml, 'real-app-e2e');
  assert.match(job, /runs-on:\s*ubuntu-latest/);
  assert.match(job, /npm run test:docker:playground/);
  assert.doesNotMatch(job, /continue-on-error:\s*true/);
});

test('inventory 认得 playground 树', () => {
  assert.equal(classifyRepositoryPath('tests/infra/docker-compose.playground.yml')?.category, 'Test configuration');
  assert.equal(classifyRepositoryPath('tests/infra/docker-compose.playground.test.yml')?.category, 'Test configuration');
  assert.equal(classifyRepositoryPath('tests/infra/playwright.playground.config.ts')?.category, 'Test configuration');
  assert.equal(classifyRepositoryPath('tests/infra/playground/runtime.env')?.category, 'Test configuration');
  assert.equal(classifyRepositoryPath('tests/playground/http-probes.test.mjs')?.category, 'Test support');
});
