// test/canonicalize.test.mjs —— 审批完整性绑定核心单测（LLD §5.5，承接 AD-7/NFR-17）
// canonicalizeOp/fingerprintHex/verifyIntegrity：前后端共享的同一份 public/js/canonicalize.js
// （机制强度==双端一致性强度）。测试覆盖 LLD §5.5 明文列出的完整检查清单。
import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalizeOp, fingerprintHex, verifyIntegrity } from '../public/js/canonicalize.js';

test.describe('canonicalizeOp', () => {
  test('相同 op → 同规范化字符串', () => {
    const a = { tool: 'Bash', args: { command: 'ls' }, cwd: '/a/b' };
    const b = { tool: 'Bash', args: { command: 'ls' }, cwd: '/a/b' };
    assert.equal(canonicalizeOp(a), canonicalizeOp(b));
  });

  test('args 键序打乱 → 同规范化字符串（对象键排序）', () => {
    const a = { tool: 'Write', args: { file_path: '/x', content: 'y' }, cwd: '/a' };
    const b = { tool: 'Write', args: { content: 'y', file_path: '/x' }, cwd: '/a' };
    assert.equal(canonicalizeOp(a), canonicalizeOp(b));
  });

  test('改一字符 → 异规范化字符串', () => {
    const a = { tool: 'Bash', args: { command: 'ls -la' }, cwd: '/a' };
    const b = { tool: 'Bash', args: { command: 'ls -lA' }, cwd: '/a' };
    assert.notEqual(canonicalizeOp(a), canonicalizeOp(b));
  });

  test('cwd 含 ./ 与尾斜杠 → 归一后同字符串', () => {
    const a = { tool: 'Read', args: {}, cwd: '/a/b/' };
    const b = { tool: 'Read', args: {}, cwd: '/a/./b' };
    assert.equal(canonicalizeOp(a), canonicalizeOp(b));
  });

  test('cwd 含 ../ 逃逸段 → 词法折叠后同字符串（纯字符串操作，不触发文件系统）', () => {
    const a = { tool: 'Read', args: {}, cwd: '/a/c' };
    const b = { tool: 'Read', args: {}, cwd: '/a/b/../c' };
    assert.equal(canonicalizeOp(a), canonicalizeOp(b));
    // 不存在的路径也能正常计算（证明不 resolve 符号链接、不碰文件系统——与 §3.4.1 WorkdirScopeGuard 刻意相反）
    assert.doesNotThrow(() => canonicalizeOp({ tool: 'Read', args: {}, cwd: '/definitely/not/a/real/path/../x' }));
  });

  test('NFC 两形（重音字符组合形 vs 预组合形）→ 同规范化字符串', () => {
    const composed = 'café';                    // é 为单一码点 U+00E9
    const decomposed = 'café';            // e + 组合重音符 U+0301
    assert.notEqual(composed, decomposed);      // 字面确实不同
    const a = { tool: 'Write', args: { content: composed }, cwd: '/a' };
    const b = { tool: 'Write', args: { content: decomposed }, cwd: '/a' };
    assert.equal(canonicalizeOp(a), canonicalizeOp(b)); // NFC 归一化后应视为等价
  });

  test('1.0 与 1 → 同规范化字符串（JS 内部本就是同一 Number 值）', () => {
    const a = { tool: 'X', args: { n: 1.0 }, cwd: '/a' };
    const b = { tool: 'X', args: { n: 1 }, cwd: '/a' };
    assert.equal(canonicalizeOp(a), canonicalizeOp(b));
  });

  test('数组换序 → 异规范化字符串（保序，不排序——顺序即语义）', () => {
    const a = { tool: 'X', args: { items: [1, 2, 3] }, cwd: '/a' };
    const b = { tool: 'X', args: { items: [3, 2, 1] }, cwd: '/a' };
    assert.notEqual(canonicalizeOp(a), canonicalizeOp(b));
  });

  test('调用方对象携带额外字段（reqId/时间戳等）不影响结果——只取 tool/args/cwd 三者', () => {
    const clean = { tool: 'Bash', args: { command: 'ls' }, cwd: '/a' };
    const withExtra = { tool: 'Bash', args: { command: 'ls' }, cwd: '/a', reqId: 'req_123', timestamp: Date.now(), nonce: 'xyz' };
    assert.equal(canonicalizeOp(clean), canonicalizeOp(withExtra));
  });

  test('NaN/Infinity 数值 → 抛错（拒绝不合法数值，不产生歧义指纹）', () => {
    assert.throws(() => canonicalizeOp({ tool: 'X', args: { n: NaN }, cwd: '/a' }));
    assert.throws(() => canonicalizeOp({ tool: 'X', args: { n: Infinity }, cwd: '/a' }));
    assert.throws(() => canonicalizeOp({ tool: 'X', args: { n: -Infinity }, cwd: '/a' }));
  });

  test('嵌套对象/数组混合结构均正确规范化（键排序递归到任意深度）', () => {
    const a = { tool: 'X', args: { b: { z: 1, a: [{ y: 2, x: 1 }] } }, cwd: '/a' };
    const b = { tool: 'X', args: { b: { a: [{ x: 1, y: 2 }], z: 1 } }, cwd: '/a' };
    assert.equal(canonicalizeOp(a), canonicalizeOp(b));
  });
});

test.describe('fingerprintHex / verifyIntegrity', () => {
  test('相同 op → 同指纹（sha256 十六进制，64 字符）', async () => {
    const op = { tool: 'Bash', args: { command: 'ls' }, cwd: '/a' };
    const fp1 = await fingerprintHex(op);
    const fp2 = await fingerprintHex({ ...op });
    assert.equal(fp1, fp2);
    assert.match(fp1, /^[0-9a-f]{64}$/);
  });

  test('篡改 op 保留旧指纹 → verifyIntegrity 判 mismatch', async () => {
    const original = { tool: 'Bash', args: { command: 'ls -la' }, cwd: '/a' };
    const fp = await fingerprintHex(original);
    const tampered = { tool: 'Bash', args: { command: 'rm -rf /' }, cwd: '/a' };
    assert.equal(await verifyIntegrity(fp, tampered), false);
    assert.equal(await verifyIntegrity(fp, original), true);
  });

  test('不同 cwd → 不同指纹（工作目录是操作语义的一部分）', async () => {
    const fp1 = await fingerprintHex({ tool: 'Bash', args: { command: 'ls' }, cwd: '/a' });
    const fp2 = await fingerprintHex({ tool: 'Bash', args: { command: 'ls' }, cwd: '/b' });
    assert.notEqual(fp1, fp2);
  });
});
