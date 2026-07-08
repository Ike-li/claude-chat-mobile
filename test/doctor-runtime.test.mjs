// test/doctor-runtime.test.mjs —— UI 安全体检编排（④）。重点：白名单合并容错 + 报告脱敏（明文绝不外泄）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readMergedPermissions, runDoctor } from '../doctor-runtime.js';

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
  test('report 含 9 项 checks + readiness', () => {
    const rep = runDoctor({ home: '/nonexistent-ccm', workDirs: [] });
    assert.equal(rep.checks.length, 9);
    assert.ok(['ready', 'caution', 'blocked'].includes(rep.readiness.level));
  });
});
