// tests/v2/fingerprint.test.mjs —— 审批完整性绑定与规范化指纹单测
// 守护：APPROVAL-01（前后端同一份规范化规则，所批即所行，指纹不符拒绝执行）
// 测什么：canonicalizeOp 规范化规则（键字典序递归排序、数组保序、NFC 码点归一化、路径词法折叠、忽略多余字段、拒绝 NaN/Infinity）；fingerprintSync (Node 同步) 与 fingerprintHex (Web Crypto 异步) 逐字节哈希一致性；verifyIntegritySync / verifyIntegrity 篡改拦截（改 tool、改 args、改 cwd）
// 不测什么 + 为什么：不测 UI 审批对话框交互与网络传输延时——属于前端 E2E 测试
import test from 'node:test';
import assert from 'node:assert/strict';

import { fingerprintSync, verifyIntegritySync } from '../../app/src/auth/fingerprint.js';
import { canonicalizeOp, fingerprintHex, verifyIntegrity } from '../../app/public/js/canonicalize.js';

test.describe('APPROVAL-01: canonicalizeOp 规范化规则', () => {
  test('只提取 tool, args, cwd 三要素，忽略请求附加元数据（reqId, ts 等）', () => {
    const base = { tool: 'Bash', args: { command: 'git status' }, cwd: '/app/src' };
    const withExtra = {
      ...base,
      reqId: 'req-98765',
      timestamp: 1725450000000,
      caller: 'web-client',
    };
    assert.equal(canonicalizeOp(base), canonicalizeOp(withExtra));
  });

  test('参数对象键乱序时输出完全相同（深度递归字典序排序）', () => {
    const op1 = {
      tool: 'Write',
      args: { b: 2, a: 1, nested: { z: 9, m: 5 } },
      cwd: '/workspace',
    };
    const op2 = {
      tool: 'Write',
      args: { a: 1, nested: { m: 5, z: 9 }, b: 2 },
      cwd: '/workspace',
    };
    assert.equal(canonicalizeOp(op1), canonicalizeOp(op2));
  });

  test('数组严格保序（数组元素顺序属于执行语义，不可重排）', () => {
    const op1 = { tool: 'Bash', args: { flags: ['-a', '-l'] }, cwd: '/tmp' };
    const op2 = { tool: 'Bash', args: { flags: ['-l', '-a'] }, cwd: '/tmp' };
    assert.notEqual(canonicalizeOp(op1), canonicalizeOp(op2));
  });

  test('Unicode NFC 归一化（合成字符与预组合字符视为一致）', () => {
    const composed = 'café';       // U+00E9
    const decomposed = 'cafe\u0301'; // 'e' + U+0301
    assert.notEqual(composed, decomposed);

    const op1 = { tool: 'Write', args: { text: composed }, cwd: '/app' };
    const op2 = { tool: 'Write', args: { text: decomposed }, cwd: '/app' };
    assert.equal(canonicalizeOp(op1), canonicalizeOp(op2));
  });

  test('工作目录 cwd 进行词法路径折叠（./ 与 ../），不碰真实文件系统', () => {
    const op1 = { tool: 'Read', args: { file: 'a.txt' }, cwd: '/workspace/dir/subdir/..' };
    const op2 = { tool: 'Read', args: { file: 'a.txt' }, cwd: '/workspace/dir' };
    const op3 = { tool: 'Read', args: { file: 'a.txt' }, cwd: '/workspace/./dir/' };
    assert.equal(canonicalizeOp(op1), canonicalizeOp(op2));
    assert.equal(canonicalizeOp(op2), canonicalizeOp(op3));
  });

  test('非法数值 (NaN / Infinity) 抛出异常拒绝计算', () => {
    assert.throws(() => canonicalizeOp({ tool: 'Test', args: { val: NaN }, cwd: '/' }));
    assert.throws(() => canonicalizeOp({ tool: 'Test', args: { val: Infinity }, cwd: '/' }));
    assert.throws(() => canonicalizeOp({ tool: 'Test', args: { val: -Infinity }, cwd: '/' }));
  });
});

test.describe('APPROVAL-01: 前后端哈希实现逐字节一致性', () => {
  test('Node 端同步与浏览器 Web Crypto 异步对任意 op 产生逐字节相同的 SHA-256 hex', async () => {
    const cases = [
      { tool: 'Bash', args: { command: 'echo "hello"' }, cwd: '/home/user' },
      { tool: 'Write', args: { path: '/tmp/test.js', content: 'const x = 1;\n' }, cwd: '/workspace' },
      { tool: 'Read', args: { target: 'file.txt' }, cwd: '/a/./b/../c/' },
      { tool: 'Custom', args: { unicode: '你好 🌟', nested: { a: [1, 2, null, true] } }, cwd: '/data' },
    ];

    for (const op of cases) {
      const syncHash = fingerprintSync(op);
      const asyncHash = await fingerprintHex(op);
      assert.equal(syncHash, asyncHash, `哈希在前后端分叉: ${JSON.stringify(op)}`);
      assert.match(syncHash, /^[0-9a-f]{64}$/);
    }
  });
});

test.describe('APPROVAL-01: verifyIntegritySync & verifyIntegrity 篡改拦截', () => {
  const originalOp = {
    tool: 'Bash',
    args: { command: 'ls -la' },
    cwd: '/project',
  };

  test('未篡改时同步与异步校验均返回 true', async () => {
    const fpSync = fingerprintSync(originalOp);
    assert.equal(verifyIntegritySync(fpSync, originalOp), true);
    assert.equal(await verifyIntegrity(fpSync, originalOp), true);
  });

  test('篡改 command 时同步与异步校验均返回 false', async () => {
    const fpSync = fingerprintSync(originalOp);
    const tampered = { ...originalOp, args: { command: 'rm -rf /' } };
    assert.equal(verifyIntegritySync(fpSync, tampered), false);
    assert.equal(await verifyIntegrity(fpSync, tampered), false);
  });

  test('篡改 cwd 时同步与异步校验均返回 false', async () => {
    const fpSync = fingerprintSync(originalOp);
    const tampered = { ...originalOp, cwd: '/different-dir' };
    assert.equal(verifyIntegritySync(fpSync, tampered), false);
    assert.equal(await verifyIntegrity(fpSync, tampered), false);
  });

  test('篡改 tool 名称时同步与异步校验均返回 false', async () => {
    const fpSync = fingerprintSync(originalOp);
    const tampered = { ...originalOp, tool: 'DangerousBash' };
    assert.equal(verifyIntegritySync(fpSync, tampered), false);
    assert.equal(await verifyIntegrity(fpSync, tampered), false);
  });
});
