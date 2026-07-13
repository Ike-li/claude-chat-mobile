// test/file-preview.test.mjs —— 工具文件预览纯逻辑（③）。
// attributePath 是「绝不成任意文件读」的唯一安全闸，重点覆盖白名单外 / .. 逃逸 / 前缀误判。
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, unlinkSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { attributePath, buildDiff, readPreview } from '../file-preview.js';

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
  test('MultiEdit：edits 是 truthy 但非数组时不应抛错（code-review P2，此前 (input.edits||[]) 只挡 falsy）', () => {
    assert.deepEqual(buildDiff('MultiEdit', { edits: 'not-an-array' }), { kind: 'multiedit', hunks: [] });
    assert.deepEqual(buildDiff('MultiEdit', { edits: {} }), { kind: 'multiedit', hunks: [] });
  });
});

// 图片预览：Read 读到 PNG/JPEG 等时，以前只回「（二进制内容，略）」——工具卡片展开看不到图。
// readPreview 按魔数识别常见图片，在体积上限内回 base64+mime，供前端 <img src="data:..."> 展示。
test.describe('readPreview：文本 / 二进制 / 图片', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccm-fp-'));
  const paths = [];
  const touch = (name, buf) => {
    const p = join(dir, name);
    writeFileSync(p, buf);
    paths.push(p);
    return p;
  };
  test.after(() => { for (const p of paths) try { unlinkSync(p); } catch {} });

  test('文本文件 → snippet 正文，非 binary', () => {
    const p = touch('a.js', Buffer.from('function foo(){return 1}\n'));
    const r = readPreview(p);
    assert.equal(r.binary, undefined);
    assert.ok(r.snippet.includes('function foo'));
    assert.equal(r.image, undefined);
  });

  test('含 NUL 的非图片二进制 → 二进制占位，无 image', () => {
    const p = touch('x.bin', Buffer.from('hello\x00world'));
    const r = readPreview(p);
    assert.equal(r.binary, true);
    assert.match(r.snippet, /二进制/);
    assert.equal(r.image, undefined);
  });

  test('小 PNG → 返回 image.mimeType + base64，不再只丢「二进制内容，略」', () => {
    // 1×1 PNG
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64'
    );
    const p = touch('dot.png', png);
    const r = readPreview(p);
    assert.equal(r.binary, true);
    assert.ok(r.image);
    assert.equal(r.image.mimeType, 'image/png');
    assert.equal(r.image.base64, png.toString('base64'));
    assert.equal(r.size, png.length);
  });

  test('小 JPEG（FF D8 FF 魔数）→ image/jpeg', () => {
    const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const p = touch('x.jpg', jpg);
    const r = readPreview(p);
    assert.equal(r.image?.mimeType, 'image/jpeg');
    assert.equal(r.image.base64, jpg.toString('base64'));
  });

  test('超大图片不回完整 base64（防 socket 撑爆），给可读占位', () => {
    // 伪造超大 JPEG 头 + 填充；maxBytes 压到很小以测封顶
    const big = Buffer.alloc(8 * 1024);
    big[0] = 0xff; big[1] = 0xd8; big[2] = 0xff;
    const p = touch('big.jpg', big);
    const r = readPreview(p, { maxBytes: 1024 });
    assert.equal(r.binary, true);
    assert.equal(r.image, undefined);
    assert.match(r.snippet, /图片|过大|略/);
    assert.equal(r.truncated, true);
    assert.equal(r.size, big.length);
  });
});
