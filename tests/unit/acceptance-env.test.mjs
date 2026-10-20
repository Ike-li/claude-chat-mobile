// tests/unit/acceptance-env.test.mjs —— 验收环境起停的命令编排（tests/acceptance/env/plan.mjs）
// 只测「拼出来的命令是什么」，不起容器：
//   down 缺省不带 -v（卷里是设备信任表、装好的分发包、建过的测试会话，删了下一轮要从头造）；
//   E3 的运行目录在 os.tmpdir() 下、prepare.mjs 带 --settings 且指向那个目录（产物含网关凭据副本，
//   prepare.mjs 本身就拒绝仓库内的运行目录）；凭据只进子进程环境或 600 文件，不进命令行、不进打印。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import {
  ENV_TARGETS, claudeSettings, formatPlan, parseEnvList, planDown, planUp, runSteps,
} from '../../tests/acceptance/env/plan.mjs';

const TOKEN = 'gw-token-0123456789-never-print';
const VAPID_PRIVATE = 'vapid-private-never-print';

const CONFIG = {
  gateway: {
    baseUrl: 'http://127.0.0.1:9999',
    models: { sonnet: 'model-s', opus: 'model-o', fable: 'model-o', haiku: 'model-h', subagent: 'model-s' },
  },
  e3: { hostIp: '10.0.0.2', claudeCodeVersion: '2.0.0' },
  ports: { E2: 23000 },
};
const SECRETS = { gatewayAuthToken: TOKEN, vapidPublicKey: 'vapid-public', vapidPrivateKey: VAPID_PRIVATE };

async function makeTarget({ prepareSupportsSettings = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'ccm-accept-env-'));
  const target = join(root, 'checkout');
  const acceptanceDir = join(root, 'suite', 'tests', 'acceptance');
  await mkdir(join(target, 'tests', 'infra', 'newuser'), { recursive: true });
  await mkdir(join(acceptanceDir, 'env'), { recursive: true });
  await writeFile(join(target, 'tests', 'infra', 'docker-compose.playground.yml'), 'services: {}\n');
  await writeFile(join(target, 'tests', 'infra', 'newuser', 'docker-compose.yml'), 'services: {}\n');
  await writeFile(join(target, 'tests', 'infra', 'newuser', 'prepare.mjs'),
    prepareSupportsSettings ? '// 用法 … [--settings <路径>]\n' : '// 旧版：settings 写死\n');
  return { root, target, acceptanceDir };
}

const composeSteps = plan => plan.steps.filter(s => s.kind === 'compose');

test('parseEnvList：认 meta.envs 里能起容器的那几个代码与 all，其余拒绝', () => {
  assert.deepEqual(parseEnvList('E1,E2'), ['E1', 'E2']);
  assert.deepEqual(parseEnvList('all'), Object.keys(ENV_TARGETS));
  assert.throws(() => parseEnvList('E4'), /E4/);
  assert.throws(() => parseEnvList(''));
});

test('down 缺省不带 -v；只有显式 --purge-volumes 才带', async t => {
  const ws = await makeTarget();
  t.after(() => rm(ws.root, { recursive: true, force: true }));
  const keep = planDown({ ...ws, envs: parseEnvList('all') });
  assert.equal(composeSteps(keep).length, 2, 'E2 与 E3 两个 compose 项目各一条');
  for (const s of composeSteps(keep)) {
    assert.equal(s.args.at(-1), 'down');
    assert.ok(!s.args.includes('-v') && !s.args.includes('--volumes'), `缺省不得删卷：${s.args.join(' ')}`);
  }
  const purge = planDown({ ...ws, envs: parseEnvList('E2'), purgeVolumes: true });
  assert.ok(composeSteps(purge)[0].args.includes('-v'));
});

test('down 带上项目的全部 profile——只停当前 profile 会把 proxy / cf 那几个容器漏在外面', async t => {
  const ws = await makeTarget();
  t.after(() => rm(ws.root, { recursive: true, force: true }));
  const [e3] = composeSteps(planDown({ ...ws, envs: ['E3'] }));
  assert.ok(e3.args.includes('ccm-accept-nu'));
  for (const p of ['lan', 'proxy', 'cf']) assert.ok(e3.args.join(' ').includes(`--profile ${p}`), `缺 --profile ${p}`);
});

test('up E3：运行目录在 os.tmpdir() 下，prepare.mjs 带 --settings 指向该目录里的 600 文件，compose 读它的 compose.env', async t => {
  const ws = await makeTarget();
  t.after(() => rm(ws.root, { recursive: true, force: true }));
  const runDir = join(tmpdir(), 'ccm-accept-nu-abc123');
  const plan = planUp({ ...ws, envs: ['E3', 'E3cf'], config: CONFIG, secrets: SECRETS, runDir });
  assert.deepEqual(plan.errors, []);

  const write = plan.steps.find(s => s.kind === 'write-settings');
  assert.ok(write.path.startsWith(runDir + sep), '凭据文件必须写在运行目录里，不能落进仓库树');
  assert.equal(write.mode, 0o600);
  assert.equal(write.content.env.ANTHROPIC_AUTH_TOKEN, TOKEN);

  const prep = plan.steps.find(s => s.kind === 'node');
  assert.equal(prep.cwd, ws.target, 'prepare.mjs 打的是被测检出的分发包，必须在那里跑');
  assert.equal(prep.args[0], join(ws.target, 'tests', 'infra', 'newuser', 'prepare.mjs'));
  assert.equal(prep.args[1], runDir);
  assert.equal(prep.args[2], '10.0.0.2');
  const i = prep.args.indexOf('--settings');
  assert.ok(i > 0 && prep.args[i + 1] === write.path, `prepare.mjs 必须带 --settings ${write.path}：${prep.args.join(' ')}`);

  const [up] = composeSteps(plan);
  const line = up.args.join(' ');
  assert.match(line, new RegExp(`--env-file ${join(runDir, 'compose.env').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(line, /--profile lan/);
  assert.match(line, /--profile cf/);
  assert.doesNotMatch(line, /--profile proxy/);
  assert.match(line, /up --build -d --wait/);

  // 只打印（不传 runDir）时给的占位路径同样直接挂在 os.tmpdir() 下，照抄执行也落不进被测检出。
  // 夹具本身就在 tmpdir 里，所以只判「以 tmpdir 开头」看不出它落进了检出——要判父目录恰好是 tmpdir
  const dryPath = planUp({ ...ws, envs: ['E3'], config: CONFIG, secrets: SECRETS })
    .steps.find(s => s.kind === 'write-settings').path;
  assert.equal(dirname(dirname(dryPath)), tmpdir());
  assert.ok(!dryPath.startsWith(ws.target + sep), `占位运行目录落进了被测检出：${dryPath}`);
});

test('凭据不进命令行、不进打印：VAPID 私钥只在子进程环境里，网关令牌只在 600 文件里', async t => {
  const ws = await makeTarget();
  t.after(() => rm(ws.root, { recursive: true, force: true }));
  const plan = planUp({ ...ws, envs: ['E1', 'E2', 'E3'], config: CONFIG, secrets: SECRETS, runDir: join(tmpdir(), 'ccm-accept-nu-x') });
  for (const s of plan.steps) {
    assert.doesNotMatch(JSON.stringify(s.args ?? []), new RegExp(`${TOKEN}|${VAPID_PRIVATE}`), `${s.kind} 的命令行里出现了凭据`);
  }
  const e2 = composeSteps(plan).find(s => s.args.includes('ccm-accept'));
  assert.equal(e2.env.CCM_ACCEPT_VAPID_PRIVATE_KEY, VAPID_PRIVATE);
  assert.equal(e2.env.CCM_ACCEPT_PORT_E2, '23000', 'local/config.json 的端口要传给 compose');
  const printed = formatPlan(plan);
  assert.doesNotMatch(printed, new RegExp(`${TOKEN}|${VAPID_PRIVATE}`));
  assert.match(printed, /CCM_ACCEPT_VAPID_PRIVATE_KEY=<local\/secrets\.json>/);
});

test('E3 前置不全时拒绝：令牌或网关地址还是占位符、被测检出的 prepare.mjs 不认 --settings', async t => {
  const ws = await makeTarget();
  t.after(() => rm(ws.root, { recursive: true, force: true }));
  const placeholder = planUp({
    ...ws, envs: ['E3'], config: { ...CONFIG, gateway: { ...CONFIG.gateway, baseUrl: '<填写>' } },
    secrets: { gatewayAuthToken: '<填写>' }, runDir: join(tmpdir(), 'x'),
  });
  assert.ok(placeholder.errors.some(e => /gateway\.baseUrl/.test(e)));
  assert.ok(placeholder.errors.some(e => /gatewayAuthToken/.test(e)));

  const old = await makeTarget({ prepareSupportsSettings: false });
  t.after(() => rm(old.root, { recursive: true, force: true }));
  const legacy = planUp({ ...old, envs: ['E3'], config: CONFIG, secrets: SECRETS, runDir: join(tmpdir(), 'x') });
  assert.ok(legacy.errors.some(e => /--settings/.test(e)),
    '旧版 prepare.mjs 会把多出来的参数静默丢掉，转头去读被测检出里那份 settings——必须拦下');
});

// runSteps 真执行：write-settings / unlink / state 落在一次性目录的真磁盘上，只把 docker 与 node 子进程换成记录器
// （单测不能真起 compose）。夹具里的 prepare.mjs 本身也以非 0 退出，注入失效时同样停在 compose 之前
test('E3 的 prepare.mjs 失败：照样删掉 write-settings 写出的凭据源文件，不再往下起 compose', async t => {
  const ws = await makeTarget();
  t.after(() => rm(ws.root, { recursive: true, force: true }));
  await writeFile(join(ws.target, 'tests', 'infra', 'newuser', 'prepare.mjs'), '// --settings\nprocess.exit(3);\n');
  const runDir = join(ws.root, 'run');
  await mkdir(runDir);
  const plan = planUp({ ...ws, envs: ['E3'], config: CONFIG, secrets: SECRETS, runDir, statePath: join(ws.root, 'state.json') });
  const calls = [];
  const spawn = cmd => { calls.push(cmd); return { status: cmd === 'docker' ? 0 : 3 }; };

  assert.equal(runSteps(plan, { spawn }), 3, '退出码应是 prepare.mjs 的');
  assert.ok(calls.includes(process.execPath), '夹具没跑到 prepare 那一步，这条在空转');
  assert.ok(!calls.includes('docker'), 'prepare 失败后不该再起 compose');
  assert.equal(existsSync(join(runDir, 'settings.source.json')), false, 'prepare 失败时网关凭据源文件被留在了运行目录里');
});

test('down 删掉运行目录里两份凭据（settings.source.json 与 settings.json）并清掉 state 里的 e3', async t => {
  const ws = await makeTarget();
  t.after(() => rm(ws.root, { recursive: true, force: true }));
  const runDir = join(tmpdir(), 'ccm-accept-nu-old');
  const plan = planDown({ ...ws, envs: ['E3'], state: { e3: { runDir } }, statePath: join(ws.root, 'state.json') });
  const unlinked = plan.steps.filter(s => s.kind === 'unlink').map(s => s.path).sort();
  assert.deepEqual(unlinked, [join(runDir, 'settings.json'), join(runDir, 'settings.source.json')].sort());
  assert.ok(plan.steps.some(s => s.kind === 'state' && s.patch.e3 === null));
});

test('state 里还记着一轮 E3 时 up 拒绝，提示先 down；不起 E3 时不拦', async t => {
  const ws = await makeTarget();
  t.after(() => rm(ws.root, { recursive: true, force: true }));
  const state = { e3: { runDir: join(tmpdir(), 'ccm-accept-nu-old'), target: ws.target } };
  const again = planUp({ ...ws, envs: ['E3'], config: CONFIG, secrets: SECRETS, runDir: join(tmpdir(), 'x'), state });
  assert.ok(again.errors.some(e => /down\.mjs/.test(e)), `应拒绝并提示先 down：${again.errors.join(' / ')}`);
  assert.deepEqual(planUp({ ...ws, envs: ['E1', 'E2'], config: CONFIG, secrets: SECRETS, state }).errors, []);
});

test('claudeSettings：网关地址、令牌、各档模型映射到 claude CLI 的环境变量；未填的档不写', () => {
  const s = claudeSettings({ gateway: { baseUrl: 'http://127.0.0.1:9', models: { sonnet: 'm1', haiku: '<填写>' } } }, { gatewayAuthToken: 't' });
  assert.equal(s.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:9');
  assert.equal(s.env.ANTHROPIC_AUTH_TOKEN, 't');
  assert.equal(s.env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'm1');
  assert.ok(!('ANTHROPIC_DEFAULT_HAIKU_MODEL' in s.env), '占位符不能当模型名写进去');
});
