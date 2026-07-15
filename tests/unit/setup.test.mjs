// tests/unit/setup.test.mjs —— setup 向导的纯逻辑单测（零 token、零交互）
// 交互壳（readline 提问 / 写文件）不在此测，靠手动跑 `npm run setup` 验证。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateToken, buildEnvContent } from '../../scripts/setup.js';

test('generateToken: 十六进制、长度=2×bytes、每次不同', () => {
  const t = generateToken(32);
  assert.match(t, /^[0-9a-f]+$/);
  assert.equal(t.length, 64);
  assert.notEqual(generateToken(32), generateToken(32));
});

test('buildEnvContent: 填入 AUTH_TOKEN，其余行原样不动', () => {
  const tpl = 'AUTH_TOKEN=\nPORT=3000\nWORK_DIR=\n';
  const out = buildEnvContent(tpl, { authToken: 'abc123' });
  assert.match(out, /^AUTH_TOKEN=abc123$/m);
  assert.match(out, /^PORT=3000$/m);
});

test('buildEnvContent: 填入 WORK_DIR', () => {
  const tpl = 'AUTH_TOKEN=\nWORK_DIR=\n';
  const out = buildEnvContent(tpl, { authToken: 'x', workDir: '/tmp/work' });
  assert.match(out, /^WORK_DIR=\/tmp\/work$/m);
});

test('buildEnvContent: 省略 workDir 时保持 WORK_DIR= 空（默认 $HOME）', () => {
  const tpl = 'AUTH_TOKEN=\nWORK_DIR=\n';
  const out = buildEnvContent(tpl, { authToken: 'x' });
  assert.match(out, /^WORK_DIR=$/m);
});

test('buildEnvContent: 只替换首个匹配行、不重复注入', () => {
  const tpl = '# AUTH_TOKEN 说明\nAUTH_TOKEN=\n';
  const out = buildEnvContent(tpl, { authToken: 'tok' });
  assert.match(out, /^AUTH_TOKEN=tok$/m);
  assert.match(out, /^# AUTH_TOKEN 说明$/m); // 注释行不被当成赋值行改掉
});
