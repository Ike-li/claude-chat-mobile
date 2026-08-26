// tests/unit/doctor-runtime.test.mjs —— UI 安全体检编排（④）。重点：白名单合并容错 + 报告脱敏（明文绝不外泄）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readMergedPermissions, runDoctor, countConfigPermProblems, CONFIG_FILE_NAMES, readModelSettingsSnapshot } from '../../src/ops/doctor-runtime.js';
import { modelSettingsConflictDiagnostic } from '../../src/ops/doctor-checks.js';

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
    const rep = runDoctor({ authToken: 'super-secret-token-1234', home: '/nonexistent-ccm', workDirs: [] });
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
      const rep = runDoctor({ authToken: 'x'.repeat(32), home, workDirs: [], cfEnabled: false });
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
  test('report 含 12 项 checks + readiness（含 DEVICE_GATE / MODEL_SETTINGS / ENV_OVERRIDE）', () => {
    const rep = runDoctor({ home: '/nonexistent-ccm', workDirs: [] });
    assert.equal(rep.checks.length, 12);
    assert.ok(rep.checks.some(c => c.id === 'DEVICE_GATE'));
    assert.ok(rep.checks.some(c => c.id === 'MODEL_SETTINGS'));
    assert.ok(rep.checks.some(c => c.id === 'ENV_OVERRIDE'));
    assert.ok(['ready', 'caution', 'blocked'].includes(rep.readiness.level));
  });
});

// D18 此前**唯一的消费者是 scripts/doctor.js**（维护者 CLI）。而 ccm 的主场景是手机，
// 手机端两个入口（配置面板 / 安全体检）都看不到它——「env 恒压过配置文件而被压侧无症状」
// 这句话本身就写在 scripts/doctor.js:23，产品自己承认它危险，却只报给最不需要的那类用户。
test.describe('ENV_OVERRIDE：把 doctor D18 接进手机端的安全体检', () => {
  const base = { home: '/nonexistent-ccm', workDirs: [] };

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
    const cp = runDoctor({ home: '/nonexistent-ccm', workDirs: [] }).checks.find(c => c.id === 'CONFIG_PERMS');
    assert.notEqual(cp.status, 'ok');
    assert.equal(cp.safe.checked, false);
  });
  test('configPermsProblems=null（平台无法检查）→ warn 未知，safe.checked=false', () => {
    const cp = runDoctor({ configPermsProblems: null, home: '/nonexistent-ccm', workDirs: [] }).checks.find(c => c.id === 'CONFIG_PERMS');
    assert.equal(cp.status, 'warn');
    assert.equal(cp.safe.checked, false);
    assert.equal(cp.safe.problemCount, null);
  });
  test('configPermsProblems=0（已检查、干净）→ ok', () => {
    const cp = runDoctor({ configPermsProblems: 0, home: '/nonexistent-ccm', workDirs: [] }).checks.find(c => c.id === 'CONFIG_PERMS');
    assert.equal(cp.status, 'ok');
    assert.equal(cp.safe.checked, true);
    assert.equal(cp.safe.problemCount, 0);
  });
  test('configPermsProblems=3（已检查、有过宽）→ warn 且 detail 含数量', () => {
    const cp = runDoctor({ configPermsProblems: 3, home: '/nonexistent-ccm', workDirs: [] }).checks.find(c => c.id === 'CONFIG_PERMS');
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
      const wl = runDoctor({ authToken: 'x'.repeat(32), home, workDirs: [proj] }).checks.find(c => c.id === 'WHITELIST');
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
      const wl = runDoctor({ authToken: 'x'.repeat(32), home, workDirs: [] }).checks.find(c => c.id === 'WHITELIST');
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
