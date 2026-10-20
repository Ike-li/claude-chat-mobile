// tests/acceptance/env/plan.mjs —— 验收环境起停的命令编排（up.mjs / down.mjs 共用）
//
// 先把要做的事拼成步骤列表（纯函数，单测直接比），再由 runSteps 执行。up/down 缺省只打印，
// 所以「打印出来的」与「真执行的」必须是同一份步骤——两处各拼一遍，迟早漂成两套。
//
// 两个 compose 项目，叠在【被测检出】（--target）的 tests/infra 上，覆盖层来自本套件的 env/：
//   ccm-accept     E1 mock / E2 playground / E2反代       tests/infra/docker-compose.playground.yml + env/compose.accept.yml
//   ccm-accept-nu  E3 lan / E3proxy / E3cf（真 claude）  tests/infra/newuser/docker-compose.yml  + env/compose.newuser.accept.yml
//
// 凭据只走两条路：VAPID 密钥进 docker compose 子进程的环境变量；网关令牌写进运行目录里的 600 文件，
// 交给被测检出的 prepare.mjs --settings。两条都不进命令行，打印时只显示变量名。
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const PROJECTS = {
  e2: {
    name: 'ccm-accept',
    base: join('tests', 'infra', 'docker-compose.playground.yml'),
    overlay: join('env', 'compose.accept.yml'),
    profiles: ['mock', 'proxy'],
  },
  e3: {
    name: 'ccm-accept-nu',
    base: join('tests', 'infra', 'newuser', 'docker-compose.yml'),
    overlay: join('env', 'compose.newuser.accept.yml'),
    profiles: ['lan', 'proxy', 'cf'],
  },
};

/** cases/meta.json 里能由 compose 起出来的环境代码 → 所属项目与 profile（null = 项目的缺省服务）。
 *  E2辅助 / T 是对 E2、E3 的另一种用法（容器内脚本、docker exec），不单独起；E4 是人和真机。 */
export const ENV_TARGETS = {
  E1: { project: 'e2', profile: 'mock' },
  E2: { project: 'e2', profile: null },
  'E2反代': { project: 'e2', profile: 'proxy' },
  E3: { project: 'e3', profile: 'lan' },
  E3proxy: { project: 'e3', profile: 'proxy' },
  E3cf: { project: 'e3', profile: 'cf' },
};
export const DEFAULT_ENVS = ['E1', 'E2'];

/** 宿主机端口缺省值（= 首轮验收实测值）。local/config.json 的 ports 可逐项改，compose 覆盖层读同一组变量。 */
export const DEFAULT_PORTS = { E1: 13100, E2: 13000, 'E2反代': 18080, E3: 13001, E3proxy: 13003, E3cf: 13004 };
const PORT_VARS = {
  E1: 'CCM_ACCEPT_PORT_E1', E2: 'CCM_ACCEPT_PORT_E2', 'E2反代': 'CCM_ACCEPT_PORT_E2_PROXY',
  E3: 'CCM_ACCEPT_PORT_E3', E3proxy: 'CCM_ACCEPT_PORT_E3_PROXY', E3cf: 'CCM_ACCEPT_PORT_E3_CF',
};

const PLACEHOLDER = /^<填写/;
const filled = v => typeof v === 'string' && v.trim() !== '' && !PLACEHOLDER.test(v);

export function parseEnvList(raw) {
  if (raw === 'all') return Object.keys(ENV_TARGETS);
  const list = String(raw ?? '').split(',').filter(Boolean);
  const bad = list.filter(code => !(code in ENV_TARGETS));
  if (!list.length || bad.length) {
    throw new Error(`--env 只认 ${Object.keys(ENV_TARGETS).join(' / ')} 或 all（逗号分隔）${bad.length ? `，收到 ${bad.join(' ')}` : ''}`);
  }
  return list;
}

/** 由 local/ 生成 E3 容器里 claude CLI 的 settings（prepare.mjs 会把 127.0.0.1 改成 host.docker.internal）。 */
export function claudeSettings(config, secrets) {
  const g = config.gateway ?? {};
  const m = g.models ?? {};
  const env = {
    ANTHROPIC_BASE_URL: g.baseUrl,
    ANTHROPIC_AUTH_TOKEN: secrets.gatewayAuthToken,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  };
  const MODEL_VARS = {
    sonnet: 'ANTHROPIC_DEFAULT_SONNET_MODEL', opus: 'ANTHROPIC_DEFAULT_OPUS_MODEL', fable: 'ANTHROPIC_DEFAULT_FABLE_MODEL',
    haiku: 'ANTHROPIC_DEFAULT_HAIKU_MODEL', subagent: 'CLAUDE_CODE_SUBAGENT_MODEL',
  };
  for (const [k, v] of Object.entries(MODEL_VARS)) if (filled(m[k])) env[v] = m[k];
  // 机主网关要的其它变量（如关掉某个请求头）放 gateway.extraEnv，写在最后、以机主的为准
  for (const [k, v] of Object.entries(g.extraEnv ?? {})) if (filled(String(v))) env[k] = String(v);
  return { env };
}

function composeArgs(project, target, acceptanceDir, profiles, tail) {
  const p = PROJECTS[project];
  return [
    'compose', '-p', p.name,
    '-f', join(target, p.base), '-f', join(acceptanceDir, p.overlay),
    ...tail.envFile ? ['--env-file', tail.envFile] : [],
    ...profiles.flatMap(x => ['--profile', x]),
    ...tail.args,
  ];
}

function projectsOf(envs) {
  return [...new Set(envs.map(code => ENV_TARGETS[code].project))].sort();
}

/**
 * 起环境的步骤。runDir 是 E3 的运行目录（up.mjs 用 mkdtemp 在 os.tmpdir() 下建）；只打印时传占位路径。
 * state 是 local/state.json 的内容。返回 { steps, errors, warnings }：errors 非空时 up.mjs 拒绝执行。
 */
export function planUp({
  acceptanceDir, target, envs, config = {}, secrets = {}, runDir = null,
  ref = 'HEAD', build = false, fakeMode = 'turn', statePath = null, state = {},
}) {
  const steps = [];
  const errors = [];
  const warnings = [];
  const ports = { ...DEFAULT_PORTS, ...(config.ports ?? {}) };
  const portEnv = Object.fromEntries(Object.entries(PORT_VARS).map(([code, v]) => [v, String(ports[code])]));

  for (const project of projectsOf(envs)) {
    const p = PROJECTS[project];
    if (!existsSync(join(target, p.base))) errors.push(`被测检出缺 ${p.base}：--target 指对了吗（${target}）`);
    const profiles = [...new Set(envs.filter(c => ENV_TARGETS[c].project === project).map(c => ENV_TARGETS[c].profile).filter(Boolean))];

    if (project === 'e2') {
      const env = { ...portEnv, CCM_ACCEPT_FAKE_MODE: fakeMode };
      const secretEnv = [];
      if (filled(secrets.vapidPublicKey) && filled(secrets.vapidPrivateKey)) {
        env.CCM_ACCEPT_VAPID_PUBLIC_KEY = secrets.vapidPublicKey;
        env.CCM_ACCEPT_VAPID_PRIVATE_KEY = secrets.vapidPrivateKey;
        secretEnv.push('CCM_ACCEPT_VAPID_PUBLIC_KEY', 'CCM_ACCEPT_VAPID_PRIVATE_KEY');
      } else {
        warnings.push('local/secrets.json 没填 vapidPublicKey / vapidPrivateKey：E2 起得来，但 web push 订阅类用例（D18）会受阻');
      }
      steps.push({
        kind: 'compose', project, env, secretEnv,
        args: composeArgs('e2', target, acceptanceDir, profiles, { args: ['up', ...build ? ['--build'] : [], '-d', '--wait'] }),
      });
      continue;
    }

    // E3：先生成 settings，再让被测检出的 prepare.mjs 打分发包、生成假边缘与 compose.env
    if (state.e3) {
      // 再起一轮会把 state 里的 runDir 覆盖掉，上一轮运行目录里的凭据副本就再没人知道去删
      errors.push(`local/state.json 里还记着一轮 E3（运行目录 ${state.e3.runDir ?? '未知'}）：先跑 node tests/acceptance/env/down.mjs --env E3 --yes 收掉再起`);
    }
    for (const [path, value] of [['gateway.baseUrl', config.gateway?.baseUrl], ['e3.hostIp', config.e3?.hostIp]]) {
      if (!filled(value)) errors.push(`E3 需要 local/config.json 的 ${path}`);
    }
    if (!filled(secrets.gatewayAuthToken)) errors.push('E3 需要 local/secrets.json 的 gatewayAuthToken');
    for (const k of ['sonnet', 'opus', 'haiku']) {
      if (!filled(config.gateway?.models?.[k])) warnings.push(`local/config.json 没填 gateway.models.${k}：CLI 会用缺省模型名，网关不认时真回合直接 400`);
    }
    const prepare = join(target, 'tests', 'infra', 'newuser', 'prepare.mjs');
    if (!existsSync(prepare)) {
      errors.push(`被测检出缺 tests/infra/newuser/prepare.mjs（${target}）`);
    } else if (!readFileSync(prepare, 'utf8').includes('--settings')) {
      // 旧版 prepare.mjs 只取前三个位置参数：--settings 会被静默丢掉，转头去读被测检出里写死的那份 settings
      errors.push('被测检出的 prepare.mjs 还不认 --settings：先把被测检出更新到含该参数的版本');
    }
    const version = config.e3?.claudeCodeVersion;
    if (!filled(version)) warnings.push('local/config.json 没填 e3.claudeCodeVersion：容器装最新 CLI，可能与宿主机不一致');

    const dir = runDir ?? join(tmpdir(), 'ccm-accept-nu-XXXXXX');
    const settingsPath = join(dir, 'settings.source.json');
    steps.push({ kind: 'write-settings', path: settingsPath, mode: 0o600, content: claudeSettings(config, secrets) });
    if (statePath) steps.push({ kind: 'state', path: statePath, patch: { e3: { runDir: dir, target } } });
    steps.push({ kind: 'node', cwd: target, args: [prepare, dir, String(config.e3?.hostIp ?? ''), ref, '--settings', settingsPath] });
    // prepare.mjs 已把它复制成 <运行目录>/settings.json（容器挂的是那份），源文件留着只是多一份凭据。
    // always：prepare 失败时也要删——那时没有后续步骤会再碰它
    steps.push({ kind: 'unlink', path: settingsPath, always: true });
    steps.push({
      kind: 'compose', project,
      env: { ...portEnv, ...filled(version) ? { CCM_ACCEPT_CLAUDE_CODE_VERSION: version } : {} },
      secretEnv: [],
      args: composeArgs('e3', target, acceptanceDir, profiles, {
        envFile: join(dir, 'compose.env'),
        // npm install 经代理逐包拉，四容器并跑实测 8–20 分钟（与基础 compose 的 start_period 同一个数）
        args: ['up', '--build', '-d', '--wait', '--wait-timeout', '1800'],
      }),
    });
  }
  return { steps, errors, warnings };
}

/**
 * 收环境的步骤：以 compose 项目为单位，带上项目的全部 profile。缺省不删卷——卷里是设备信任表、
 * 装好的分发包、建过的测试会话，删了下一轮要从头造；要清空写 --purge-volumes。
 */
export function planDown({ acceptanceDir, target, envs, purgeVolumes = false, state = {}, statePath = null }) {
  const steps = [];
  for (const project of projectsOf(envs)) {
    const p = PROJECTS[project];
    // newuser compose 的 ${NEWUSER_*:?} 在 down 时也要求有值；down 不读挂载源，给存在的目录即可
    const env = project === 'e3'
      ? { NEWUSER_RUN_DIR: state.e3?.runDir ?? tmpdir(), NEWUSER_HOST_IP: '127.0.0.1' }
      : {};
    steps.push({
      kind: 'compose', project, env, secretEnv: [],
      args: composeArgs(project, target, acceptanceDir, p.profiles, { args: ['down', ...purgeVolumes ? ['-v'] : []] }),
    });
    if (project === 'e3' && state.e3?.runDir) {
      // 运行目录里两份网关凭据：容器挂的 settings.json，与 up 中途失败时可能残留的源文件 settings.source.json。
      // 容器停了就没人要它们了。其余产物（分发包、假边缘）不含真凭据
      steps.push({ kind: 'unlink', path: join(state.e3.runDir, 'settings.json') });
      steps.push({ kind: 'unlink', path: join(state.e3.runDir, 'settings.source.json') });
      if (statePath) steps.push({ kind: 'state', path: statePath, patch: { e3: null } });
    }
  }
  return { steps, errors: [], warnings: [] };
}

const shellQuote = s => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`);

/** 打印用：凭据变量只显示来源，不显示值。 */
export function formatPlan({ steps }) {
  return steps.map(s => {
    if (s.kind === 'compose') {
      const env = Object.entries(s.env)
        .map(([k, v]) => `${k}=${s.secretEnv.includes(k) ? '<local/secrets.json>' : shellQuote(v)}`);
      return [...env, 'docker', ...s.args.map(shellQuote)].join(' ');
    }
    if (s.kind === 'node') return `(cd ${shellQuote(s.cwd)} && node ${s.args.map(shellQuote).join(' ')})`;
    if (s.kind === 'write-settings') return `# 写 ${s.path}（${s.mode.toString(8)}，由 local/config.json + local/secrets.json 生成，内容不打印）`;
    if (s.kind === 'unlink') return `# 删 ${s.path}（网关凭据副本${s.always ? '；前面的步骤失败也删' : ''}）`;
    if (s.kind === 'state') return `# 记 ${s.path}：${JSON.stringify(s.patch)}`;
    return `# ${s.kind}`;
  }).join('\n');
}

export function readState(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return {}; }
}

/**
 * 逐步执行。某一步失败后只再跑标了 always 的步骤（清凭据），返回第一个失败的退出码。
 * spawn 可注入：单测不能真起 docker。log 可注入：测试进程的 stdout 是 node:test 运行器回传结果的通道，
 * 回显直接写进去会混进它的序列化消息。
 */
export function runSteps({ steps }, { spawn = spawnSync, log = console.log } = {}) {
  let failed = 0;
  for (const s of steps) {
    if (failed && !s.always) continue;
    const shown = formatPlan({ steps: [s] });
    log(shown.startsWith('#') ? shown : `\n$ ${shown}`);
    if (s.kind === 'compose') {
      const r = spawn('docker', s.args, { stdio: 'inherit', env: { ...process.env, ...s.env } });
      if (r.status !== 0) failed ||= r.status ?? 1;
    } else if (s.kind === 'node') {
      const r = spawn(process.execPath, s.args, { cwd: s.cwd, stdio: 'inherit' });
      if (r.status !== 0) failed ||= r.status ?? 1;
    } else if (s.kind === 'write-settings') {
      writeFileSync(s.path, JSON.stringify(s.content, null, 2) + '\n', { mode: s.mode });
      chmodSync(s.path, s.mode);   // writeFileSync 的 mode 只在新建时生效，且受 umask 影响
    } else if (s.kind === 'unlink') {
      try { unlinkSync(s.path); } catch (err) { if (err.code !== 'ENOENT') throw err; }
    } else if (s.kind === 'state') {
      const state = { ...readState(s.path), ...s.patch };
      for (const [k, v] of Object.entries(state)) if (v === null) delete state[k];
      mkdirSync(join(s.path, '..'), { recursive: true });
      writeFileSync(s.path, JSON.stringify(state, null, 2) + '\n');
    }
  }
  return failed;
}

