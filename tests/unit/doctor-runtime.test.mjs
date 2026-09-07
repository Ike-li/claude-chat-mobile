// tests/unit/doctor-runtime.test.mjs —— UI 安全体检编排（④）。重点：白名单合并容错 + 报告脱敏（明文绝不外泄）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readMergedPermissions, runDoctor, countConfigPermProblems, CONFIG_FILE_NAMES, readModelSettingsSnapshot, probeTailscale, probeListeningProcesses } from '../../app/src/ops/doctor-runtime.js';
import { modelSettingsConflictDiagnostic, identifySelfServer } from '../../app/src/ops/doctor-checks.js';
import { resolveBindPlan } from '../../app/src/shared/bind-host.js';

// ── 探测 stub 的统一底座（2026-09-07 性能修复）─────────────────────────────
// runDoctor 未注入探测时会真的跑 `which claude` + `claude --version` + `which tailscale`
// + `tailscale status --json`，每个 execFileSync 带 timeout: 3000 —— 一次裸调用约 10 秒。
// 本文件此前逐个用例手工注入，漏了十余处：实测单跑 56.8s，而其中 CPU 仅 1.49s，全在等子进程。
// 因为 test:unit 并行度 9 下 wall time 由最长文件决定，这一个文件就把整条槽钉在近一分钟。
//
// 统一前置成缺省，用例自己传的 probe* 靠 spread 顺序照常覆盖（`{ ...stubProbes(), ...ctx }`），
// 断言语义一条不变。写成函数而不是对象常量：STUB_PROBE / STUB_TS_ABSENT 定义在本文件靠后
// （紧贴各自的成因注释，不宜上移），函数体到调用时才求值，绕开 const 的 TDZ。
const stubProbes = () => ({ probeClaudeBin: () => STUB_PROBE, probeTailscale: () => STUB_TS_ABSENT });

test.describe('readMergedPermissions：合并 global/project/local + 容错', () => {
  test('合并三层 + scope 标注；坏 JSON / 缺文件 skip 不抛', () => {
    const home = mkdtempSync(join(tmpdir(), 'ccm-home-'));
    const proj = mkdtempSync(join(tmpdir(), 'ccm-proj-'));
    try {
      mkdirSync(join(home, '.claude'), { recursive: true });
      writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(*)'] } }));
      mkdirSync(join(proj, '.claude'), { recursive: true });
      writeFileSync(join(proj, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Read(//x/**)'] } }));
      writeFileSync(join(proj, '.claude', 'settings.local.json'), '{ bad json'); // 坏 → skip
      const r = readMergedPermissions({ home, workDirs: [proj] });
      const rules = r.allow.map(a => a.rule);
      assert.ok(rules.includes('Bash(*)'));
      assert.ok(rules.includes('Read(//x/**)'));
      assert.equal(r.allow.find(a => a.rule === 'Bash(*)').scope, 'global');
      assert.equal(r.allow.find(a => a.rule === 'Read(//x/**)').scope, 'project');
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(proj, { recursive: true, force: true });
    }
  });
  test('全缺 → 空 allow（不抛）', () => {
    assert.deepEqual(readMergedPermissions({ home: '/nonexistent-xyz-ccm', workDirs: [] }).allow, []);
  });
});

test.describe('runDoctor：脱敏 + 结构 + 就绪度', () => {
  test('AUTH_TOKEN 明文绝不出现在报告里', () => {
    const rep = runDoctor({ ...stubProbes(), authToken: 'super-secret-token-1234', home: '/nonexistent-ccm', workDirs: [] });
    assert.equal(JSON.stringify(rep).includes('super-secret-token-1234'), false);
    const t = rep.checks.find(c => c.id === 'AUTH_TOKEN');
    assert.equal(t.safe.isSet, true);
    assert.equal(t.status, 'ok');
  });
  test('危险白名单进 WHITELIST.safe.dangerous（带 scope），readiness caution', () => {
    const home = mkdtempSync(join(tmpdir(), 'ccm-h2-'));
    try {
      mkdirSync(join(home, '.claude'), { recursive: true });
      writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(*)', 'Write(//r/**)'] } }));
      // 必须注入 CLI 探测，理由同下一条用例：不注入的话 runDoctor 会真的 which + 跑
      // `claude --version`，而末尾那条 readiness 断言是 15 个 check 的综合判定——CLI 探不到
      // 就判 fail，readiness 被拉到 'blocked'，与这条用例要测的白名单毫无关系。
      // 2026-09-06 CI 实测：本地（有真 claude）绿、容器（compose 设了 CLAUDE_BIN）绿、
      // CI 的 test:unit step（两者都没有）红——同一条用例三个环境三种答案，红的还是无关的那一维。
      const rep = runDoctor({
        ...stubProbes(),
        authToken: 'x'.repeat(32), home, workDirs: [], cfEnabled: false,
        probeClaudeBin: () => STUB_PROBE,
      });
      const wl = rep.checks.find(c => c.id === 'WHITELIST');
      assert.equal(wl.safe.ruleCount, 2);
      assert.equal(wl.safe.dangerous.length, 1); // 仅 Bash(*)
      assert.equal(wl.safe.dangerous[0].rule, 'Bash(*)');
      assert.equal(wl.safe.dangerous[0].scope, 'global');
      assert.equal(rep.readiness.level, 'caution'); // 危险 + 无 CF 但 token ok → 不到 blocked
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
  test('report 含 15 项 checks + readiness（含 DEVICE_GATE / MODEL_SETTINGS / ENV_OVERRIDE / FILE_EDIT / ACCESS_PROFILE / BIND）', () => {
    // 注入探测：不注入的话 runDoctor 会真的 which + 跑一次 claude --version，
    // 让这条断言的结果取决于跑测试的机器上装没装 CLI。
    const rep = runDoctor({ home: '/nonexistent-ccm', workDirs: [], probeClaudeBin: () => STUB_PROBE, probeTailscale: () => STUB_TS_ABSENT });
    assert.equal(rep.checks.length, 16);
    assert.ok(rep.checks.some(c => c.id === 'BIND'));
    assert.ok(rep.checks.some(c => c.id === 'ACCESS_PROFILE'));
    assert.ok(rep.checks.some(c => c.id === 'TAILSCALE'));
    assert.ok(rep.checks.some(c => c.id === 'DEVICE_GATE'));
    assert.ok(rep.checks.some(c => c.id === 'MODEL_SETTINGS'));
    assert.ok(rep.checks.some(c => c.id === 'ENV_OVERRIDE'));
    assert.ok(rep.checks.some(c => c.id === 'FILE_EDIT'));
    assert.ok(['ready', 'caution', 'blocked'].includes(rep.readiness.level));
  });

  // 2026-09-06：此前 CF_ACCESS 未启用恒 warn，而 computeReadiness 把任一 warn 算成 caution ——
  // 于是 LAN / Tailscale / 反代 / 直连的部署**永远到不了 ready**，体检在对不用 Cloudflare 的
  // 用户说「你还差一样东西」，可基线（AUTH_TOKEN + 逐设备审批）他们一样都不少。
  test('CF Access 未启用 + 其余全净 → CF_ACCESS 为 ok 且 readiness 为 ready（Access 是可选加层，不是就绪条件）', () => {
    const rep = runDoctor({
      authToken: 'x'.repeat(32),
      home: '/nonexistent-ccm',
      workDirs: ['/nonexistent-ccm-work'],
      cfEnabled: false,
      probeClaudeBin: () => STUB_PROBE,
      claudeVersion: STUB_PROBE.version,
      configPermsProblems: 0,
      pushEnabled: true,          // PUSH_VAPID 未配另有一条 warn，与本条无关，注入成已配把它排除掉
      shellEnv: {},
      probeTailscale: () => STUB_TS_ABSENT,   // 不注入会真跑 which tailscale；本条与 Tailscale 无关
    });
    const cf = rep.checks.find(c => c.id === 'CF_ACCESS');
    assert.equal(cf.status, 'ok', `未开 Access 不是缺陷：${cf.detail}`);
    assert.equal(cf.safe.enabled, false);
    const notOk = rep.checks.filter(c => c.status !== 'ok').map(c => `${c.id}=${c.status}`);
    assert.equal(rep.readiness.level, 'ready', `不用 Cloudflare 也必须能到 ready；非 ok 项：${notOk.join(', ') || '无'}`);
  });
});

// ── CLAUDE_BIN 实时探测 ────────────────────────────────────────────────────
// 2026-08-27：这一格此前的**唯一**判据是 ctx.claudeVersion —— server 启动那一刻 execSync
// 一次 `claude --version` 拿到的字符串。于是它不是在检查 claude，是在回放一个快照：
// 当天现场 CLI 已升到 2.1.247，web 体检仍显示 2.1.246 且判 ok；claude 被卸载/移走同理。
// 现在与 scripts/doctor.js 共用 probeClaudeBin + claudeBinDiagnostic，两边同一判据。
const STUB_PROBE = { explicit: '/usr/local/bin/claude', exists: true, executable: true, version: '2.1.247 (Claude Code)' };
const claudeCheck = (ctx) => runDoctor({ ...stubProbes(), home: '/nonexistent-ccm', workDirs: [], ...ctx }).checks.find(c => c.id === 'CLAUDE_BIN');

// ── TAILSCALE 探测注入（2026-09-06）───────────────────────────────────────
// 与 probeClaudeBin 同一形态：有副作用的探测可注入，判定走 doctor-checks.tailscaleDiagnostic。
// 不注入时 runDoctor 会真的 which tailscale（找到还会跑 tailscale status --json），
// 结果取决于跑测试的机器装没装 Tailscale——凡是断言计数 / readiness / TAILSCALE 本身的用例都要注入。
const STUB_TS_ABSENT = { found: false };
const STUB_TS_RUNNING = { found: true, backendState: 'Running', dnsName: 'mac.tail1234.ts.net', ipCount: 1 };

test.describe('TAILSCALE：探测可注入，safe 脱敏，port 透传进 serve 提示', () => {
  const tsCheck = (ctx) => runDoctor({ ...stubProbes(), home: '/nonexistent-ccm', workDirs: [], probeClaudeBin: () => STUB_PROBE, ...ctx }).checks.find(c => c.id === 'TAILSCALE');

  test('注入 Running 事实 + port → ok，detail 带 MagicDNS https 地址与 serve --bg <port>', () => {
    const c = tsCheck({ probeTailscale: () => STUB_TS_RUNNING, port: 3456, accessProfile: 'vpn' });
    assert.equal(c.status, 'ok');
    assert.match(c.detail, /https:\/\/mac\.tail1234\.ts\.net/);
    assert.match(c.detail, /tailscale serve[^\n]*3456/, 'server 的实际端口必须透传进提示，写死 3000 会误导改过端口的人');
  });

  test('注入 未安装 + 未声明 → ok（不是缺陷）；未安装 + vpn → warn', () => {
    assert.equal(tsCheck({ probeTailscale: () => STUB_TS_ABSENT, accessProfile: '' }).status, 'ok');
    assert.equal(tsCheck({ probeTailscale: () => STUB_TS_ABSENT, accessProfile: 'vpn' }).status, 'warn');
  });

  test('★ safe 不回显 MagicDNS 名（报告会被贴进 issue / 聊天）', () => {
    const c = tsCheck({ probeTailscale: () => STUB_TS_RUNNING, accessProfile: 'vpn' });
    assert.doesNotMatch(JSON.stringify(c.safe), /tail1234/);
    assert.equal(c.safe.hasDnsName, true);
  });
});

// ── probeTailscale：execFile 可注入，四种真实返回形态都归成扁平事实，绝不抛 ──
// 2026-09-06 本机实测：Homebrew 装了 CLI 但守护进程没跑时，`tailscale status --json` 退出码 1、
// stdout 空、stderr「failed to connect to local Tailscale service」——第一版把它归成 unknown，
// 用户看不出下一步该做什么。这个形态要有自己的名字。
test.describe('probeTailscale：四种返回形态', () => {
  const which = (bin) => (cmd, args) => {
    if (cmd === 'which' && args[0] === 'tailscale') { if (bin) return `${bin}\n`; throw new Error('not found'); }
    throw new Error(`unexpected ${cmd}`);
  };
  const withStatus = (bin, handler) => (cmd, args, opts) => (cmd === 'which' ? which(bin)(cmd, args) : handler(cmd, args, opts));

  test('PATH 里没有（非 darwin 不试固定路径）→ found:false', () => {
    assert.deepEqual(probeTailscale({ platform: 'linux', execFile: which('') }), { found: false });
  });

  test('Running：解析 BackendState 与去尾点的 Self.DNSName', () => {
    const r = probeTailscale({ platform: 'linux', execFile: withStatus('/usr/bin/tailscale', (cmd, args) => {
      assert.equal(cmd, '/usr/bin/tailscale'); assert.deepEqual(args, ['status', '--json']);
      return JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'mac.tail1234.ts.net.', TailscaleIPs: ['100.64.0.1'] } });
    }) });
    assert.deepEqual(r, { found: true, backendState: 'Running', dnsName: 'mac.tail1234.ts.net' });
  });

  test('NeedsLogin 退出码非零但 stdout 仍是 JSON → 照样解析', () => {
    const r = probeTailscale({ platform: 'linux', execFile: withStatus('/usr/bin/tailscale', () => {
      const err = new Error('exit 1'); err.status = 1; err.stdout = JSON.stringify({ BackendState: 'NeedsLogin', Self: { DNSName: '' } }); err.stderr = '';
      throw err;
    }) });
    assert.deepEqual(r, { found: true, backendState: 'NeedsLogin', dnsName: '' });
  });

  test('守护进程没跑（stderr「failed to connect to local Tailscale service」）→ backendState DaemonNotRunning，不抛', () => {
    const r = probeTailscale({ platform: 'darwin', execFile: withStatus('/opt/homebrew/bin/tailscale', () => {
      const err = new Error('Command failed'); err.status = 1; err.stdout = ''; err.stderr = 'failed to connect to local Tailscale service; is Tailscale running?\n';
      throw err;
    }) });
    assert.equal(r.found, true);
    assert.equal(r.backendState, 'DaemonNotRunning');
    assert.equal(r.dnsName, '');
  });

  test('其他失败（超时 / 非 JSON 输出）→ found:true 且 backendState 空，带 error，不抛', () => {
    const r = probeTailscale({ platform: 'linux', execFile: withStatus('/usr/bin/tailscale', () => { const e = new Error('ETIMEDOUT'); e.stdout = 'garbage'; throw e; }) });
    assert.equal(r.found, true);
    assert.equal(r.backendState, '');
    assert.match(String(r.error), /ETIMEDOUT/);
  });
});

test.describe('CLAUDE_BIN：实时探测而非回放启动快照', () => {
  test('探得到且与启动快照一致 → ok，detail 带路径与版本', () => {
    const c = claudeCheck({ probeClaudeBin: () => STUB_PROBE, claudeVersion: '2.1.247 (Claude Code)' });
    assert.equal(c.status, 'ok');
    assert.match(c.detail, /2\.1\.247/);
    assert.match(c.detail, /claude/);
  });

  test('实时版本 ≠ 启动快照 → warn（CLI 升级过，跑着的 SDK 子进程还是旧版）', () => {
    const c = claudeCheck({ probeClaudeBin: () => STUB_PROBE, claudeVersion: '2.1.246 (Claude Code)' });
    assert.equal(c.status, 'warn', '这正是 2026-08-27 现场那一格：装的是 247，server 启动时是 246');
    assert.equal(c.safe.stale, true);
    assert.match(c.detail, /2\.1\.246/);
    assert.match(c.detail, /重启/);
  });

  test('PATH 上找不到 claude → fail（不能因为快照里还留着版本号就判绿）', () => {
    const c = claudeCheck({ probeClaudeBin: () => ({ explicit: '', resolvedPath: '' }), claudeVersion: '2.1.247 (Claude Code)' });
    assert.equal(c.status, 'fail');
    assert.equal(c.safe.found, false);
  });

  test('路径还在但已不可执行 → fail', () => {
    const c = claudeCheck({ probeClaudeBin: () => ({ explicit: '/x/claude', exists: true, executable: false }) });
    assert.equal(c.status, 'fail');
    assert.match(c.detail, /不可执行|not executable/);
  });

  test('没有启动快照（旧调用）→ 只按实时结果判，不误报 stale', () => {
    const c = claudeCheck({ probeClaudeBin: () => STUB_PROBE });
    assert.equal(c.status, 'ok');
    assert.notEqual(c.safe.stale, true);
  });
});

// D18 此前**唯一的消费者是 scripts/doctor.js**（维护者 CLI）。而 ccm 的主场景是手机，
// 手机端两个入口（配置面板 / 安全体检）都看不到它——「env 恒压过配置文件而被压侧无症状」
// 这句话本身就写在 scripts/doctor.js:23，产品自己承认它危险，却只报给最不需要的那类用户。
test.describe('ENV_OVERRIDE：把 doctor D18 接进手机端的安全体检', () => {
  const base = { ...stubProbes(), home: '/nonexistent-ccm', workDirs: [] };

  test('有 shell env 覆盖 → warn，且逐个列出键名', () => {
    const rep = runDoctor({ ...base, shellEnv: { WORK_DIR: '/from/shell', DEV_MODE: '1' } });
    const c = rep.checks.find(x => x.id === 'ENV_OVERRIDE');
    assert.equal(c.status, 'warn');
    assert.deepEqual(c.safe.keys.slice().sort(), ['DEV_MODE', 'WORK_DIR']);
    assert.match(c.detail, /WORK_DIR/);
  });

  test('★ 只列键名，绝不回显值 —— 被覆盖的可能正是 AUTH_TOKEN / VAPID 私钥', () => {
    const rep = runDoctor({ ...base, shellEnv: { AUTH_TOKEN: 'shell-side-secret-token' } });
    assert.equal(JSON.stringify(rep).includes('shell-side-secret-token'), false);
  });

  test('无覆盖 → ok', () => {
    const c = runDoctor({ ...base, shellEnv: { PATH: '/usr/bin' } }).checks.find(x => x.id === 'ENV_OVERRIDE');
    assert.equal(c.status, 'ok');
  });

  // 与 BE-013 同一条纪律：缺省不得假绿。调用方忘了传快照时显 ok，等于把「没查」说成「没问题」。
  test('★ 没传 shellEnv（调用方漏接线）→ 不显 ok，safe.checked=false', () => {
    const c = runDoctor(base).checks.find(x => x.id === 'ENV_OVERRIDE');
    assert.notEqual(c.status, 'ok');
    assert.equal(c.safe.checked, false);
  });
});

test.describe('BE-013：CONFIG_PERMS 不得在「未检查」时假绿 ok', () => {
  test('未传 configPermsProblems（缺省 undefined）→ 不显 ok（应 warn/未知）', () => {
    // 旧实现把缺省 undefined 当 0 → 恒显「0600 安全」ok 假绿。修复后：未检查必须显 warn。
    const cp = runDoctor({ ...stubProbes(), home: '/nonexistent-ccm', workDirs: [] }).checks.find(c => c.id === 'CONFIG_PERMS');
    assert.notEqual(cp.status, 'ok');
    assert.equal(cp.safe.checked, false);
  });
  test('configPermsProblems=null（平台无法检查）→ warn 未知，safe.checked=false', () => {
    const cp = runDoctor({ ...stubProbes(), configPermsProblems: null, home: '/nonexistent-ccm', workDirs: [] }).checks.find(c => c.id === 'CONFIG_PERMS');
    assert.equal(cp.status, 'warn');
    assert.equal(cp.safe.checked, false);
    assert.equal(cp.safe.problemCount, null);
  });
  test('configPermsProblems=0（已检查、干净）→ ok', () => {
    const cp = runDoctor({ ...stubProbes(), configPermsProblems: 0, home: '/nonexistent-ccm', workDirs: [] }).checks.find(c => c.id === 'CONFIG_PERMS');
    assert.equal(cp.status, 'ok');
    assert.equal(cp.safe.checked, true);
    assert.equal(cp.safe.problemCount, 0);
  });
  test('configPermsProblems=3（已检查、有过宽）→ warn 且 detail 含数量', () => {
    const cp = runDoctor({ ...stubProbes(), configPermsProblems: 3, home: '/nonexistent-ccm', workDirs: [] }).checks.find(c => c.id === 'CONFIG_PERMS');
    assert.equal(cp.status, 'warn');
    assert.equal(cp.safe.problemCount, 3);
    assert.match(cp.detail, /3/);
  });
});

test.describe('countConfigPermProblems：真实权限检查（BE-013 数据源）', () => {
  test('win32 平台无 POSIX 权限位 → 返回 null（不可查、绝不假报 0）', () => {
    assert.equal(countConfigPermProblems('/tmp/whatever-ccm', { platform: 'win32' }), null);
  });
  test('清单非空且与 CLI doctor 共用同一事实源', () => {
    assert.ok(Array.isArray(CONFIG_FILE_NAMES) && CONFIG_FILE_NAMES.length > 0);
    assert.ok(CONFIG_FILE_NAMES.includes('.env'));
  });
  test('临时根：0600 干净计 0，chmod 0644 过宽计 1', { skip: process.platform === 'win32' }, () => {
    const root = mkdtempSync(join(tmpdir(), 'ccm-perms-'));
    try {
      mkdirSync(join(root, 'data'), { recursive: true });
      const env = join(root, '.env');
      writeFileSync(env, 'AUTH_TOKEN=x');
      chmodSync(env, 0o600);
      assert.equal(countConfigPermProblems(root), 0); // 仅 .env 存在且 0600
      chmodSync(env, 0o644);
      assert.equal(countConfigPermProblems(root), 1); // 过宽被计
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // BE-013 假绿：CONFIG_FILE_NAMES 的项以【项目根】为基准（'data/sessions.json'），而生产部署普遍用
  // CCM_DATA_DIR 把数据目录移出仓库。server 侧把 CCM_DATA_DIR 当 rootDir 传进来 → 拼出
  // <CCM_DATA_DIR>/data/sessions.json 这个永不存在的路径 → 一个文件都扫不到 → 恒返回 0 →
  // runDoctor 恒输出「配置文件权限 0600 ok」。CLI doctor 用 name.replace(/^data[/\\]/,'') 一直是对的。
  test('数据目录被 CCM_DATA_DIR 移出仓库时仍能扫到过宽文件', { skip: process.platform === 'win32' }, () => {
    const root = mkdtempSync(join(tmpdir(), 'ccm-root-'));
    const dataDir = mkdtempSync(join(tmpdir(), 'ccm-data-'));
    try {
      const env = join(root, '.env');
      writeFileSync(env, 'AUTH_TOKEN=x');
      chmodSync(env, 0o600);
      const sessions = join(dataDir, 'sessions.json');
      writeFileSync(sessions, '{}');
      chmodSync(sessions, 0o644); // 过宽，必须被发现
      const trusted = join(dataDir, 'trusted-devices.json');
      writeFileSync(trusted, '[]');
      chmodSync(trusted, 0o600); // 干净

      assert.equal(countConfigPermProblems(root, { dataDir }), 1, '数据目录里过宽的 sessions.json 必须被计');

      chmodSync(trusted, 0o644);
      assert.equal(countConfigPermProblems(root, { dataDir }), 2, '两个过宽文件都要计');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

test.describe('SONNET-BUG-1：同一危险规则跨 scope 时聚合所有 scope', () => {
  test('Bash(*) 同时在 global+project → 去重成一条、scope 含两者（不再 first-match 恒 global）', () => {
    const home = mkdtempSync(join(tmpdir(), 'ccm-h3-'));
    const proj = mkdtempSync(join(tmpdir(), 'ccm-p3-'));
    try {
      mkdirSync(join(home, '.claude'), { recursive: true });
      mkdirSync(join(proj, '.claude'), { recursive: true });
      writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(*)'] } }));
      writeFileSync(join(proj, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(*)'] } }));
      const wl = runDoctor({ ...stubProbes(), authToken: 'x'.repeat(32), home, workDirs: [proj] }).checks.find(c => c.id === 'WHITELIST');
      assert.equal(wl.safe.dangerous.length, 1); // 去重：同一条不重复列
      assert.match(wl.safe.dangerous[0].scope, /global/);
      assert.match(wl.safe.dangerous[0].scope, /project/);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(proj, { recursive: true, force: true });
    }
  });
  test('仅 global 单一 scope → scope 精确为 global（不回归）', () => {
    const home = mkdtempSync(join(tmpdir(), 'ccm-h4-'));
    try {
      mkdirSync(join(home, '.claude'), { recursive: true });
      writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(*)'] } }));
      const wl = runDoctor({ ...stubProbes(), authToken: 'x'.repeat(32), home, workDirs: [] }).checks.find(c => c.id === 'WHITELIST');
      assert.equal(wl.safe.dangerous.length, 1);
      assert.equal(wl.safe.dangerous[0].scope, 'global');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ── 2026-08-04 code review：按目录分组重写时把用户级 env 采集整条丢了 ─────────────
// CLI 会把 ~/.claude/settings.json 的 env 合并进【每个】目录，所以「全局配一个网关、
// 各项目不单独配」这个最常见布局下，每个 dir 的 tierTargets 都该带上全局那份映射。
// 丢掉它的后果是双向的：全局配网关 → 整条检查恒绿假 OK；全局+目录混合布局 → 反过来误报 warn。
test('readModelSettingsSnapshot：用户级 settings.json 的 env 映射对每个 workDir 生效', () => {
  const home = mkdtempSync(join(tmpdir(), 'ccm-doc-home-'));
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({
    model: 'claude-opus-5',
    env: { ANTHROPIC_BASE_URL: 'https://gw.example', ANTHROPIC_DEFAULT_SONNET_MODEL: 'grok-4.5' },
  }));
  const wd = mkdtempSync(join(tmpdir(), 'ccm-doc-wd-'));
  mkdirSync(join(wd, '.claude'), { recursive: true });
  writeFileSync(join(wd, '.claude', 'settings.local.json'), JSON.stringify({}));

  const snap = readModelSettingsSnapshot({ home, workDirs: [wd] });
  assert.equal(snap.dirs[0].tierTargets.sonnet, 'grok-4.5', '全局网关映射必须下沉到每个 workDir');

  const diag = modelSettingsConflictDiagnostic(snap);
  assert.equal(diag.status, 'warn', '全局配了网关 + model 写全名 = 正该 warn 的配置，不能报 ok');
  assert.match(diag.detail, /全名/);

  rmSync(home, { recursive: true, force: true });   // safe-rm: mkdtemp 一次性目录
  rmSync(wd, { recursive: true, force: true });     // safe-rm: mkdtemp 一次性目录
});

test('readModelSettingsSnapshot：目录级映射覆盖同档位的用户级映射', () => {
  const home = mkdtempSync(join(tmpdir(), 'ccm-doc-home2-'));
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({
    model: 'sonnet',
    env: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'grok-4.5', ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.2' },
  }));
  const wd = mkdtempSync(join(tmpdir(), 'ccm-doc-wd2-'));
  mkdirSync(join(wd, '.claude'), { recursive: true });
  writeFileSync(join(wd, '.claude', 'settings.local.json'), JSON.stringify({
    env: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'mimo-v2.5-pro' },
  }));

  const snap = readModelSettingsSnapshot({ home, workDirs: [wd] });
  assert.equal(snap.dirs[0].tierTargets.sonnet, 'mimo-v2.5-pro', '目录级优先');
  assert.equal(snap.dirs[0].tierTargets.opus, 'glm-5.2', '目录没覆盖的档位保留全局值');
  assert.equal(modelSettingsConflictDiagnostic(snap).status, 'ok');

  rmSync(home, { recursive: true, force: true });   // safe-rm: mkdtemp 一次性目录
  rmSync(wd, { recursive: true, force: true });     // safe-rm: mkdtemp 一次性目录
});

// ── FILE_EDIT：D20 的手机端出口（R45，2026-08-30） ──────────────────────────
// FILE_EDIT 开关就住在 web 配置面板里，公网用户日常看的是 web 体检，不是装机那一次 CLI doctor
// ——受众重合度比 CLI 侧更高。判定与 scripts/doctor.js D20 共用 fileEditExposureDiagnostic；
// 公网信号 = CF Access 实际启用（ctx.cfEnabled，auth 层权威判定）或 PUBLIC_URL 已声明。
test.describe('FILE_EDIT：直写通道 × 公网迹象（web 体检）', () => {
  const feCheck = (ctx) => runDoctor({ ...stubProbes(), home: '/nonexistent-ccm', workDirs: [], probeClaudeBin: () => STUB_PROBE, ...ctx })
    .checks.find(c => c.id === 'FILE_EDIT');

  test('公网启用 + 直写开 → warn，点名审批链与出路', () => {
    const c = feCheck({ cfEnabled: true, fileEditOff: false });
    assert.equal(c.status, 'warn');
    assert.match(c.detail, /审批/);
    assert.match(c.detail, /FILE_EDIT=off/);
  });

  test('FILE_EDIT=off → ok（已只读）', () => {
    assert.equal(feCheck({ cfEnabled: true, fileEditOff: true }).status, 'ok');
  });

  test('无公网声明 → ok（不 nag 局域网部署）', () => {
    assert.equal(feCheck({ cfEnabled: false, fileEditOff: false }).status, 'ok');
  });

  test('★ safe 与 detail 都绝不回显 PUBLIC_URL 的值——体检报告会被贴进 issue/聊天', () => {
    const c = feCheck({ cfEnabled: false, fileEditOff: false, publicUrl: 'https://secret-host.example.com' });
    assert.equal(c.status, 'warn');
    assert.equal(JSON.stringify(c).includes('secret-host'), false);
    assert.equal(c.safe.publicSignal, true);
  });

  test('声明 vpn 时 PUBLIC_URL 不再单独触发 warn（ctx.accessProfile 要真的接进判定）', () => {
    const c = feCheck({ cfEnabled: false, fileEditOff: false, publicUrl: 'http://100.64.0.5:3000', accessProfile: 'vpn' });
    assert.equal(c.status, 'ok');
  });
});

// ── ACCESS_PROFILE：D21 的手机端出口 ────────────────────────────────────────
// 方案声明住在 web 配置面板里，切换后的自洽核对同样该在手机上看得到。
// 判定与 scripts/doctor.js D21 共用 accessProfileDiagnostic；cfConfigured 用 ctx.cfEnabled
// （auth 层权威判定）。safe 只出布尔/枚举字面量，绝不回显 PUBLIC_URL 值。
test.describe('ACCESS_PROFILE：按声明方案的针对性检查（web 体检）', () => {
  const apCheck = (ctx) => runDoctor({ ...stubProbes(), home: '/nonexistent-ccm', workDirs: [], probeClaudeBin: () => STUB_PROBE, ...ctx })
    .checks.find(c => c.id === 'ACCESS_PROFILE');

  test('未声明 → ok（既有部署零新告警）', () => {
    const c = apCheck({});
    assert.ok(c, '体检里应有 ACCESS_PROFILE 一项');
    assert.equal(c.status, 'ok');
    assert.equal(c.safe.declared, false);
  });

  test('声明 vpn 但 CF 层实际开着 → warn（矛盾要在手机上看得到）', () => {
    const c = apCheck({ accessProfile: 'vpn', cfEnabled: true });
    assert.equal(c.status, 'warn');
    assert.match(c.detail, /CF_ACCESS/);
  });

  test('★ safe 只出布尔/枚举，报告 JSON 不含传入的 URL 值', () => {
    const c = apCheck({ accessProfile: 'lan', publicUrl: 'https://secret-host.example.com' });
    assert.equal(JSON.stringify(c).includes('secret-host'), false);
    assert.equal(c.safe.profile, 'lan');
    assert.equal(typeof c.safe.publicUrlSet, 'boolean');
  });

  // 接线钉子：判定函数拿 publiclyReachable 做「声明 vs 监听面」的矛盾核对，而这个值只能由
  // 调用方从 bindPlan 取。忘了传不会报错，只会让整条检查静默失效——恰好是 doctor 里最难发现的
  // 一类缺陷（体检全绿地少一项）。所以这里不测判定，测的是「值真的接进去了」。
  test('publiclyReachable 从 bindPlan 接进 D21：direct + 只绑 loopback → warn', () => {
    const c = apCheck({
      accessProfile: 'direct',
      authToken: 'x'.repeat(32),
      bindPlan: resolveBindPlan({ authToken: 'x'.repeat(32), bindMode: 'loopback' }),
    });
    assert.equal(c.status, 'warn', `矛盾没被抓到，说明 publiclyReachable 没接进去：${c.detail}`);
    assert.match(c.detail, /BIND_MODE|127\.0\.0\.1|本机/);
  });

  test('对照：direct + 对外监听 → ok（防把 direct 一律报成 warn）', () => {
    const c = apCheck({
      accessProfile: 'direct',
      authToken: 'x'.repeat(32),
      bindPlan: resolveBindPlan({ authToken: 'x'.repeat(32), bindMode: 'lan' }),
    });
    assert.equal(c.status, 'ok', c.detail);
  });
});

// 2026-09-06 容器演练：Linux 上 doctor 的 PORT 恒报「被不明进程占用」——取数写死了 /usr/sbin/lsof 与 /bin/ps。
// Linux 改走 /proc（零外部工具），macOS 仍用 lsof/ps 但只允许 PATH 查找。这里用一次性目录造一棵假 /proc 树，
// 与 identifySelfServer 接成整条链：端口 → inode → pid → 命令行/cwd → 认出是自家 server。
test.describe('probeListeningProcesses —— 端口监听者取数', () => {
  test('linux：/proc/net/tcp 的 inode 经 /proc/<pid>/fd 反查到 pid，cmdline 的 NUL 还原成空格，cwd 走 readlink', () => {
    const proc = mkdtempSync(join(tmpdir(), 'ccm-fakeproc-'));
    const repo = mkdtempSync(join(tmpdir(), 'ccm-repo-'));
    try {
      mkdirSync(join(proc, 'net'));
      writeFileSync(join(proc, 'net', 'tcp'), [
        '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
        '   0: 00000000:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 41234 1 0000000000000000 100 0 0 10 0',
        '',
      ].join('\n'));
      // 自家 server：pid 4242 持有 inode 41234
      mkdirSync(join(proc, '4242', 'fd'), { recursive: true });
      symlinkSync('socket:[41234]', join(proc, '4242', 'fd', '7'));
      symlinkSync('/dev/null', join(proc, '4242', 'fd', '0'));
      writeFileSync(join(proc, '4242', 'cmdline'), 'node\0app/server.js\0');
      symlinkSync(repo, join(proc, '4242', 'cwd'));
      // 干扰项：别的进程持有别的 socket；非数字目录；fd 读不到的进程
      mkdirSync(join(proc, '4300', 'fd'), { recursive: true });
      symlinkSync('socket:[999]', join(proc, '4300', 'fd', '3'));
      writeFileSync(join(proc, '4300', 'cmdline'), 'nginx\0');
      mkdirSync(join(proc, 'self'));
      mkdirSync(join(proc, '4400'));
      const r = probeListeningProcesses(3000, { platform: 'linux', procRoot: proc });
      assert.deepEqual(r, [{ pid: 4242, command: 'node app/server.js', cwd: repo }], 'Linux 取数没把端口反查到自家进程');
      assert.deepEqual(identifySelfServer({ processes: r, repoRoot: repo }), { pid: 4242, cwd: repo }, '取数与判定接不上');
      assert.deepEqual(probeListeningProcesses(4000, { platform: 'linux', procRoot: proc }), []);
    } finally {
      rmSync(proc, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });
  test('linux：/proc 不可读 → 空数组不抛（认不出来只会退回原来的 fail 分支）', () => {
    assert.deepEqual(probeListeningProcesses(3000, { platform: 'linux', procRoot: '/nonexistent-ccm-proc' }), []);
  });
  test('darwin：lsof / ps 只按 PATH 查找，不写死 /usr/sbin 与 /bin', () => {
    const calls = [];
    const execFile = (cmd, args) => {
      calls.push(cmd);
      if (cmd === 'lsof' && args.includes('-t')) return '39090\n';
      if (cmd === 'ps') return 'node app/server.js\n';
      if (cmd === 'lsof' && args.includes('cwd')) return 'p39090\nn/Users/you/code/claude-chat-mobile\n';
      throw new Error(`unexpected ${cmd}`);
    };
    const r = probeListeningProcesses(3000, { platform: 'darwin', execFile });
    assert.deepEqual(r, [{ pid: 39090, command: 'node app/server.js', cwd: '/Users/you/code/claude-chat-mobile' }]);
    assert.ok(calls.length > 0 && calls.every((c) => !c.startsWith('/')), `写死了绝对路径：${calls.join(',')}`);
  });
});
