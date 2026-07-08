// test/file-preview.test.mjs —— 工具文件预览纯逻辑（③）。
// attributePath 是「绝不成任意文件读」的唯一安全闸，重点覆盖白名单外 / .. 逃逸 / 前缀误判。
import test from 'node:test';
import assert from 'node:assert/strict';
import { attributePath, buildDiff } from '../file-preview.js';

const WORK = ['/home/u/repo', '/home/u/other'];

test.describe('attributePath：路径归属 + 安全裁决（安全核心）', () => {
  test('workDir 内文件 → 归属 { workDir, relPath }', () => {
    const r = attributePath('/home/u/repo/src/a.js', WORK, '/home/u/repo');
    assert.equal(r.workDir, '/home/u/repo');
    assert.equal(r.relPath, 'src/a.js');
  });
  test('相对路径锚 cwd', () => {
    const r = attributePath('src/a.js', WORK, '/home/u/repo');
    assert.equal(r.resolved, '/home/u/repo/src/a.js');
    assert.equal(r.workDir, '/home/u/repo');
  });
  test('workDir 根本身 → 归属', () => {
    assert.equal(attributePath('/home/u/repo', WORK, '/home/u/repo').workDir, '/home/u/repo');
  });
  test('白名单外绝对路径（/etc/passwd）→ null（拒绝）', () => {
    assert.equal(attributePath('/etc/passwd', WORK, '/home/u/repo'), null);
  });
  test('~/.ssh 类白名单外 → null', () => {
    assert.equal(attributePath('/home/u/.ssh/id_rsa', WORK, '/home/u/repo'), null);
  });
  test('.. 逃逸出 workDir → null（resolve 后不在白名单内）', () => {
    assert.equal(attributePath('../../../etc/passwd', WORK, '/home/u/repo'), null);
    assert.equal(attributePath('/home/u/repo/../secret', WORK, '/home/u/repo'), null);
  });
  test('前缀相同但非子目录（/home/u/repoX vs /home/u/repo）不误判（靠 +sep）', () => {
    assert.equal(attributePath('/home/u/repoX/a', WORK, '/home/u/repo'), null);
  });
  test('缺参数不抛，返回 null', () => {
    assert.equal(attributePath('', WORK, '/x'), null);
    assert.equal(attributePath('/x/a', null, '/x'), null);
  });
});

test.describe('buildDiff：变更摘要（不读盘，来自缓存的完整 tool input）', () => {
  test('Edit → old/new 成对', () => {
    assert.deepEqual(buildDiff('Edit', { old_string: 'a', new_string: 'b' }),
      { kind: 'edit', hunks: [{ old: 'a', new: 'b' }] });
  });
  test('MultiEdit → 多 hunk', () => {
    const d = buildDiff('MultiEdit', { edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: 'd' }] });
    assert.equal(d.kind, 'multiedit');
    assert.equal(d.hunks.length, 2);
    assert.deepEqual(d.hunks[1], { old: 'c', new: 'd' });
  });
  test('Write → 全新内容', () => {
    assert.deepEqual(buildDiff('Write', { content: 'hello' }), { kind: 'write', added: 'hello' });
  });
  test('Read → null（走读盘 snippet）', () => {
    assert.equal(buildDiff('Read', { file_path: '/x' }), null);
  });
  test('缺字段安全（Edit 无 old_string → 空串）', () => {
    assert.deepEqual(buildDiff('Edit', {}), { kind: 'edit', hunks: [{ old: '', new: '' }] });
  });
});
