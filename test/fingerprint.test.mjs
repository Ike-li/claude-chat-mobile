// test/fingerprint.test.mjs —— 审批完整性绑定后端侧同步哈希单测（LLD §5.5，承接 AD-7/NFR-17）
// fingerprint.js 是纯逻辑模块（node:crypto 同步 API），此前完全没有测试覆盖——补齐两类风险：
// ①fingerprintSync/verifyIntegritySync 自身行为；②与前端 public/js/canonicalize.js 的
// fingerprintHex（crypto.subtle 异步）是否产生同一哈希——这条不是"锦上添花"：真正的安全门槛
// （agent.js#resolvePermission）双端都用后端 fingerprintSync 比对、不依赖跨实现一致；但前端
// app.js 的"谨慎确认"预检警示条用 fingerprintHex 比对服务端下发的 fp，若两套实现不一致，
// 预检会对每一次合法审批都误报"完整性预检异常"，把功能变成一直哭狼来的噪音。
import test from 'node:test';
import assert from 'node:assert/strict';
import { fingerprintSync, verifyIntegritySync } from '../fingerprint.js';
import { fingerprintHex } from '../public/js/canonicalize.js';

test.describe('fingerprintSync / verifyIntegritySync', () => {
  test('相同 op → 同指纹（sha256 十六进制，64 字符）', () => {
    const op = { tool: 'Bash', args: { command: 'ls' }, cwd: '/a' };
    const fp1 = fingerprintSync(op);
    const fp2 = fingerprintSync({ ...op });
    assert.equal(fp1, fp2);
    assert.match(fp1, /^[0-9a-f]{64}$/);
  });

  test('verifyIntegritySync：op 匹配 → true，篡改 → false', () => {
    const original = { tool: 'Bash', args: { command: 'ls -la' }, cwd: '/a' };
    const fp = fingerprintSync(original);
    assert.equal(verifyIntegritySync(fp, original), true);
    const tampered = { tool: 'Bash', args: { command: 'rm -rf /' }, cwd: '/a' };
    assert.equal(verifyIntegritySync(fp, tampered), false);
  });

  test('cwd 篡改（工具/参数不变）→ verifyIntegritySync 判 false（cwd 是操作语义的一部分）', () => {
    const fp = fingerprintSync({ tool: 'Read', args: { file_path: '/x' }, cwd: '/project-a' });
    assert.equal(verifyIntegritySync(fp, { tool: 'Read', args: { file_path: '/x' }, cwd: '/project-b' }), false);
  });

  test('与前端 fingerprintHex（crypto.subtle 异步实现）对同一 op 产生完全相同的哈希', async () => {
    const op = { tool: 'Write', args: { file_path: '/x', content: '内容 café' }, cwd: '/a/./b/' };
    const backend = fingerprintSync(op);
    const frontend = await fingerprintHex(op);
    assert.equal(backend, frontend, '前后端哈希实现分叉会让前端预检对每次合法审批都误报');
  });
});
