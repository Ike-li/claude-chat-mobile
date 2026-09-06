// tests/invariants/fingerprint.test.mjs —— 审批完整性绑定与规范化指纹单测
// 守护：APPROVAL-01（前后端同一份规范化规则，所批即所行，指纹不符拒绝执行）
// 测什么：canonicalizeOp 规范化规则（键字典序递归排序、数组保序、NFC 码点归一化【key 与 value 两条
//   路径分别钉】、路径词法折叠且不碰文件系统、忽略多余字段、拒绝 NaN/Infinity）；fingerprintSync
//   (Node 同步) 与 fingerprintHex (Web Crypto 异步) 逐字节哈希一致性；verifyIntegritySync /
//   verifyIntegrity 篡改拦截（改 tool、改 args、改 cwd）
// 不测什么 + 为什么：不测 UI 审批对话框交互与网络传输延时——属于前端 E2E 测试
//
// 【2026-09-05 合并】原 tests/unit/canonicalize.test.mjs 测同一组导出，逐条比对后 12 条里 10 条
// 在这里已有等价或更强的版本（篡改拦截这里是 tool/args/cwd 三维 × sync/async 两实现，那边只有
// args 一维）。两条真独占已搬进来：key 的排序前 NFC、路径不存在也不抛错。剩下两条不搬——
// 「1.0 与 1 同值」是 JS 语义不是本模块行为（实现就一句 String(v)，恒真）；「改一字符 → 异」
// 被这里的篡改拦截蕴含，且它挑的 'ls -la'→'ls -lA' 在「只比前 N 字符」这类缺陷下反而比这里更弱。
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

  // key 的 NFC 与 value 的 NFC 是【两条代码路径】：value 在序列化时归一化（canonicalizeValue 的
  // string 分支），key 还要在【排序比较器里】先归一化，否则视觉相同、编码不同的 key 排出不同顺序，
  // 两端指纹分叉。上面那条 value 用例盖不住这里——实测把比较器里的两次 normalize('NFC') 删掉，
  // value 用例仍全绿。变异检查也测不出这个差异：算子只有 9 个运算符替换，表达不了「删一次方法调用」。
  // 挑 'b' 与 'á' 是刻意的：归一化后 'b'(U+0062) < 'á'(U+00E1)，未归一化时 'a'(U+0061) < 'b'——
  // 两种写法排序必然相反，缺陷无处可藏。
  test('对象 key 的 NFC 归一化发生在【排序之前】（否则同一组 key 排出两种顺序）', () => {
    const composed = 'á';     // á 单一码点（NFC）
    const decomposed = 'á';  // a + 组合重音符（NFD），视觉相同、编码不同
    assert.notEqual(composed, decomposed);

    const op1 = { tool: 'X', args: { b: 1, [composed]: 2 }, cwd: '/a' };
    const op2 = { tool: 'X', args: { b: 1, [decomposed]: 2 }, cwd: '/a' };
    assert.equal(canonicalizeOp(op1), canonicalizeOp(op2));
  });

  test('工作目录 cwd 进行词法路径折叠（./ 与 ../），不碰真实文件系统', () => {
    const op1 = { tool: 'Read', args: { file: 'a.txt' }, cwd: '/workspace/dir/subdir/..' };
    const op2 = { tool: 'Read', args: { file: 'a.txt' }, cwd: '/workspace/dir' };
    const op3 = { tool: 'Read', args: { file: 'a.txt' }, cwd: '/workspace/./dir/' };
    assert.equal(canonicalizeOp(op1), canonicalizeOp(op2));
    assert.equal(canonicalizeOp(op2), canonicalizeOp(op3));

    // 「不碰文件系统」不是措辞，是可证伪的：路径不存在也必须算得出来。改用 realpath / existsSync
    // 之流会当场抛错。这条与 WorkdirScopeGuard 刻意相反——那里范围是权限边界、必须 resolve 真实
    // 落点；这里完整性层管「用户看到的路径 == 指纹里的路径」，resolve 符号链接反而让两者背离。
    assert.doesNotThrow(
      () => canonicalizeOp({ tool: 'Read', args: {}, cwd: '/definitely/not/a/real/path/../x' }),
      '规范化必须是纯字符串运算：路径不存在也要算得出指纹',
    );
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
