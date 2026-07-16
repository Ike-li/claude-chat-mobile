// tests/unit/doctor-runtime.test.mjs —— UI 安全体检编排（④）。重点：白名单合并容错 + 报告脱敏（明文绝不外泄）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readMergedPermissions, runDoctor, countConfigPermProblems, CONFIG_FILE_NAMES } from '../../src/ops/doctor-runtime.js';

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
  test('report 含 10 项 checks + readiness（含 DEVICE_GATE / AUTH-003）', () => {
    const rep = runDoctor({ home: '/nonexistent-ccm', workDirs: [] });
    assert.equal(rep.checks.length, 10);
    assert.ok(rep.checks.some(c => c.id === 'DEVICE_GATE'));
    assert.ok(['ready', 'caution', 'blocked'].includes(rep.readiness.level));
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
