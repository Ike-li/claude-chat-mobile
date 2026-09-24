// tests/unit/playground-compose.test.mjs —— playground compose 隔离契约
//
// 这些断言锁的是「干净 Linux 用户」夹具不会吃进宿主机 ccm.config.json / .env / data/ / 秘密。
// YAML 按原文扫，不 parse：${ 插值、列表式 environment、漏写的空键，parse 之后就看不见了。
import assert from 'node:assert/strict';
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
const DOCKERFILE_TEST = join(ROOT, 'tests/infra/Dockerfile.test');
const PACKAGE_LOCK = join(ROOT, 'package-lock.json');
const RUNTIME_ENV = join(ROOT, 'tests/infra/playground/runtime.env');
const PACKAGE_JSON = join(ROOT, 'package.json');

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

test('runtime.env 钉死隔离键，不把 HOME 当工作区，不设 CI', () => {
  const env = parseEnvFile(read(RUNTIME_ENV));
  assert.equal(env.AUTH_TOKEN, PLAYGROUND_TOKEN);
  assert.equal(env.HOME, HOME);
  assert.equal(env.WORK_DIRS, WORK_DIR);
  assert.equal(Object.hasOwn(env, 'WORK_DIR'), false, 'WORK_DIR 已退役（并入 WORKDIRS 首项），夹具不该再注入');
  assert.notEqual(env.WORK_DIRS, env.HOME);
  assert.ok(env.WORK_DIRS.startsWith(`${HOME}/`));
  assert.ok(env.CCM_DATA_DIR.startsWith(`${HOME}/`));
  assert.equal(env.CLAUDE_BIN, '/app/tests/fixtures/fake-claude.sh');
  assert.equal(env.CCM_TEST_PRESERVE_EMPTY_ENV, '1');
  assert.notEqual(env.DEV_MODE, '1');
  assert.equal(Object.hasOwn(env, 'CI'), false);

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
  // 镜像名必须带仓库区分度：docker 镜像名全机共享，通用名（如 ccm-test:local）会被本机
  // 其它项目的构建覆盖，而 compose run 见镜像已存在就直接用 → 测试静默跑在别人的 node_modules 上。
  assert.match(yaml, /image:\s*claude-chat-mobile-test:local/);
  assert.match(yaml, /pull_policy:\s*never/);
  assert.match(yaml, /127\.0\.0\.1:13000:3000/);
  assert.match(yaml, /127\.0\.0\.1:13100:3100/);
  assert.match(yaml, /127\.0\.0\.1:18080:8080/);
  assert.doesNotMatch(yaml, /^\s+-\s+["']?3000:3000["']?\s*$/m);
  // Docker Desktop virtiofs 不能在 `.:/app` 上再叠 /app/.env（宿主机若已有该文件会
  // OCI mount 失败）。隔离改成：不挂仓库根，只挂源码目录；配置由 entrypoint 写进容器层。
  // 两种写法都要防：compose 移进 tests/infra/ 后，「挂仓库根」写出来是 `../..:/app` 而不再是 `.:/app`。
  assert.doesNotMatch(yaml, /^\s+-\s+["']?(?:\.|\.\.\/\.\.):\/app["']?\s*$/m);
  assert.doesNotMatch(yaml, /^\s+- .*:\/app\/\.env/m);
  assert.doesNotMatch(yaml, /^\s+- .*:\/app\/ccm\.config\.json/m);
  // 运行时代码整体在 app/ 下，一条挂载即可；容器内路径与仓库结构一致（/app 恒等于仓库根）。
  assert.match(yaml, /\.\.\/\.\.\/app:\/app\/app/);
  assert.match(yaml, /\.\.\/\.\.\/scripts:\/app\/scripts/);
  assert.match(yaml, /\.\.\/\.\.\/tests:\/app\/tests/);
  // 夹具（tests/infra/playground/）随 ../../tests 挂载一起进容器，不再单独挂一条。
  // 所以这里断言的不是挂载，而是【容器里那条路径真能找到入口脚本】——挂载写对了但
  // command 指向旧路径的话，容器会以 "No such file" 起不来，而挂载断言看不出来。
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

test('test compose 仍不发端口，并与 playground 共享 claude-chat-mobile-test:local 标签', () => {
  const yaml = read(TEST_COMPOSE);
  // 镜像名必须带仓库区分度：docker 镜像名全机共享，通用名（如 ccm-test:local）会被本机
  // 其它项目的构建覆盖，而 compose run 见镜像已存在就直接用 → 测试静默跑在别人的 node_modules 上。
  assert.match(yaml, /image:\s*claude-chat-mobile-test:local/);
  assert.doesNotMatch(yaml, /^\s+ports:/m);
});

// `npm run docker:build` 是 `compose build`，只构建带 build 段的服务。4f0062f9 改挂载方式时连带删了这一段，
// 此后它什么也不做、镜像停在旧依赖上，没有任何报错（2026-09-23 撞见）。
test('test compose 带 build 段：npm run docker:build 真的会构建 Dockerfile.test', () => {
  const block = serviceBlock(read(TEST_COMPOSE), 'test');
  assert.match(block, /^ {4}build:\n {6}context: \.\.\/\.\.\n {6}dockerfile: tests\/infra\/Dockerfile\.test$/m);
  assert.match(read(PACKAGE_JSON), /"docker:build": "docker compose -f tests\/infra\/docker-compose\.test\.yml build"/);
});

// 基础镜像自带的浏览器按 Playwright 版本走。dependabot 只升 package.json / lock、不动 Dockerfile，两边一错开
// test:docker:e2e 就报 "Executable doesn't exist"（2026-09-23 实测：1.61.1 镜像配 1.63.0 依赖，chromium 1228 ≠ 1243）。
test('Dockerfile.test 的 Playwright 基础镜像与 package-lock 里的 @playwright/test 同版本', () => {
  const tag = /^FROM mcr\.microsoft\.com\/playwright:v(\d+\.\d+\.\d+)-/m.exec(read(DOCKERFILE_TEST))?.[1];
  const locked = JSON.parse(read(PACKAGE_LOCK)).packages['node_modules/@playwright/test']?.version;
  assert.ok(tag, 'Dockerfile.test 的 FROM 不是 Playwright 官方镜像了——这条判据要跟着改');
  assert.equal(tag, locked, `Dockerfile.test 基于 Playwright ${tag}，而 lock 里是 ${locked}：改 FROM 的 tag`);
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

test('inventory 认得 playground 树', () => {
  assert.equal(classifyRepositoryPath('tests/infra/docker-compose.playground.yml')?.category, 'Test configuration');
  assert.equal(classifyRepositoryPath('tests/infra/docker-compose.playground.test.yml')?.category, 'Test configuration');
  assert.equal(classifyRepositoryPath('tests/infra/playwright.playground.config.ts')?.category, 'Test configuration');
  assert.equal(classifyRepositoryPath('tests/infra/playground/runtime.env')?.category, 'Test configuration');
  assert.equal(classifyRepositoryPath('tests/playground/http-probes.test.mjs')?.category, 'Test support');
});
