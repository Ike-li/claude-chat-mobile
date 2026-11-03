// tests/unit/acceptance-preflight.test.mjs —— 开跑前检查（tests/acceptance/preflight.mjs）
// 覆盖：local/ 两个文件缺失与 secrets 权限不是 600 判 ✗；未填的占位符只点名字段路径；
// 网关探测只看通不通、带超时、请求里不带令牌；任何输出里都不出现 secrets 的值。
// docker 与网关都注入：单测不碰本机 docker，也不发真网络请求。
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPreflight } from '../../tests/acceptance/preflight.mjs';

const SECRET = 'sk-test-0123456789-should-never-print';

async function makeWorkspace({ config, secrets, secretsMode = 0o600 } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'ccm-accept-preflight-'));
  const acceptanceDir = join(root, 'tests', 'acceptance');
  await mkdir(join(acceptanceDir, 'local'), { recursive: true });
  await mkdir(join(acceptanceDir, 'env'), { recursive: true });
  await mkdir(join(root, 'tests', 'infra', 'newuser'), { recursive: true });
  for (const f of ['env/compose.accept.yml', 'env/compose.newuser.accept.yml']) await writeFile(join(acceptanceDir, f), 'services: {}\n');
  for (const f of ['tests/infra/docker-compose.playground.yml', 'tests/infra/newuser/docker-compose.yml']) await writeFile(join(root, f), 'services: {}\n');
  if (config !== null) {
    await writeFile(join(acceptanceDir, 'local', 'config.json'), JSON.stringify(config ?? { gateway: { baseUrl: 'http://127.0.0.1:9' } }));
  }
  if (secrets !== null) {
    const p = join(acceptanceDir, 'local', 'secrets.json');
    await writeFile(p, JSON.stringify(secrets ?? { gatewayAuthToken: SECRET }));
    await chmod(p, secretsMode);
  }
  return { root, acceptanceDir };
}

const dockerOk = () => ({ ok: true, detail: '29.0.0' });
const levelOf = (checks, re) => checks.find(c => re.test(c.item))?.level;

test('齐全且 secrets 为 600 → 全部 ok', async t => {
  const ws = await makeWorkspace();
  t.after(() => rm(ws.root, { recursive: true, force: true }));
  const { checks } = await runPreflight({ acceptanceDir: ws.acceptanceDir, target: ws.root, probeDocker: dockerOk });
  assert.deepEqual(checks.filter(c => c.level !== 'ok'), []);
});

test('secrets.json 权限放宽（644）→ ✗，并给出改法', async t => {
  const ws = await makeWorkspace({ secretsMode: 0o644 });
  t.after(() => rm(ws.root, { recursive: true, force: true }));
  const { checks } = await runPreflight({ acceptanceDir: ws.acceptanceDir, target: ws.root, probeDocker: dockerOk });
  const c = checks.find(x => /secrets\.json/.test(x.item));
  assert.equal(c.level, 'fail');
  assert.match(c.detail, /644/);
  assert.match(c.detail, /600/);
});

test('config.json / secrets.json 缺失 → ✗；docker 不可用 → ✗', async t => {
  const ws = await makeWorkspace({ config: null, secrets: null });
  t.after(() => rm(ws.root, { recursive: true, force: true }));
  const { checks } = await runPreflight({
    acceptanceDir: ws.acceptanceDir, target: ws.root, probeDocker: () => ({ ok: false, detail: 'Cannot connect' }),
  });
  assert.equal(levelOf(checks, /config\.json/), 'fail');
  assert.equal(levelOf(checks, /secrets\.json/), 'fail');
  assert.equal(levelOf(checks, /docker/), 'fail');
});

test('被测检出缺 compose 文件 → ✗（--target 写错时不该等到 up 才发现）', async t => {
  const ws = await makeWorkspace();
  t.after(() => rm(ws.root, { recursive: true, force: true }));
  const elsewhere = join(ws.root, 'not-a-checkout');
  await mkdir(elsewhere);
  const { checks } = await runPreflight({ acceptanceDir: ws.acceptanceDir, target: elsewhere, probeDocker: dockerOk });
  assert.ok(checks.some(c => c.level === 'fail' && /docker-compose\.playground\.yml/.test(c.item)));
});

test('未填的占位符 → ⚠，只点名字段路径，不打印任何 secrets 的值', async t => {
  const ws = await makeWorkspace({
    config: { gateway: { baseUrl: '<填写>', models: { sonnet: '<填写>' } } },
    secrets: { gatewayAuthToken: SECRET, vapidPrivateKey: '<填写>' },
  });
  t.after(() => rm(ws.root, { recursive: true, force: true }));
  const { checks } = await runPreflight({ acceptanceDir: ws.acceptanceDir, target: ws.root, probeDocker: dockerOk });
  const cfg = checks.find(c => /config\.json/.test(c.item) && c.level === 'warn');
  assert.match(cfg.detail, /gateway\.baseUrl/);
  assert.match(cfg.detail, /gateway\.models\.sonnet/);
  const sec = checks.find(c => /secrets\.json/.test(c.item) && c.level === 'warn');
  assert.match(sec.detail, /vapidPrivateKey/);
  assert.doesNotMatch(JSON.stringify(checks), new RegExp(SECRET));
});

test('--gateway：只探通不通，带超时，请求里不带令牌；有 HTTP 响应（哪怕 401）就算通', async t => {
  const ws = await makeWorkspace({ config: { gateway: { baseUrl: 'http://127.0.0.1:9/v1' } } });
  t.after(() => rm(ws.root, { recursive: true, force: true }));
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url: String(url), init }); return { status: 401 }; };

  const { checks } = await runPreflight({
    acceptanceDir: ws.acceptanceDir, target: ws.root, probeDocker: dockerOk, gateway: true, fetchImpl,
  });
  assert.equal(levelOf(checks, /网关/), 'ok');
  assert.equal(calls.length, 1);
  assert.ok(calls[0].init?.signal, '必须带超时（AbortSignal），网关挂死时 preflight 不能跟着挂');
  assert.doesNotMatch(JSON.stringify(calls[0]), new RegExp(SECRET), '连通探测不需要令牌，也就不该发出去');
  assert.doesNotMatch(JSON.stringify(checks), new RegExp(SECRET));
});

// 'localhost:9' 能被 new URL 解析（协议成了 localhost:），所以判据是「http(s) 地址」而不只是「解析得了」
test('--gateway：baseUrl 不是 http(s) 地址（漏写 http://）→ ✗ 并说明要带 http://，不抛异常、不发请求', async t => {
  for (const baseUrl of ['127.0.0.1:9', 'localhost:9', 'not a url']) {
    const ws = await makeWorkspace({ config: { gateway: { baseUrl } } });
    t.after(() => rm(ws.root, { recursive: true, force: true }));
    const calls = [];
    const fetchImpl = async url => { calls.push(String(url)); return { status: 200 }; };
    const { checks, ok } = await runPreflight({
      acceptanceDir: ws.acceptanceDir, target: ws.root, probeDocker: dockerOk, gateway: true, fetchImpl,
    });
    const c = checks.find(x => /网关/.test(x.item));
    assert.equal(c?.level, 'fail', `${baseUrl} 应判 ✗`);
    assert.match(c.detail, /http:\/\//);
    assert.equal(ok, false);
    assert.deepEqual(calls, [], `${baseUrl} 不该拿去发请求`);
  }
});

test('--gateway：连不上或超时 → ✗', async t => {
  const ws = await makeWorkspace({ config: { gateway: { baseUrl: 'http://127.0.0.1:9' } } });
  t.after(() => rm(ws.root, { recursive: true, force: true }));
  const fetchImpl = async () => { throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); };
  const { checks } = await runPreflight({
    acceptanceDir: ws.acceptanceDir, target: ws.root, probeDocker: dockerOk, gateway: true, fetchImpl,
  });
  assert.equal(levelOf(checks, /网关/), 'fail');
});
