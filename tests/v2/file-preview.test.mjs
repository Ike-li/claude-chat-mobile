// tests/v2/file-preview.test.mjs —— 工具卡片文件预览纯逻辑与有界读盘
// 守护：FILE-02（缺口路径修复）、FILES-3（O_NOFOLLOW 防逃逸）、SCOPE-01（attributePath 范围裁决）
// 测什么：attributePath 归属判定与前缀保护；buildDiff 各种工具差异生成；readPreview 文本截断、二进制与图片魔数识别；FIFO 在 openSync 前拒绝且不卡死
// 不测什么 + 为什么：不测编辑器写回或审批状态——属于 file-browse 与 approval 域
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { spawnSync, execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { attributePath, buildDiff, readPreview } from '../../app/src/files/file-preview.js';

test.describe('SCOPE-01: attributePath 路径归属与安全裁决', () => {
  const WORK = ['/home/user/repo', '/home/user/other'];

  test('合法工作目录内子路径正确归属', () => {
    const res = attributePath('/home/user/repo/src/index.js', WORK, '/home/user/repo');
    assert.notEqual(res, null);
    assert.equal(res.workDir, '/home/user/repo');
    assert.equal(res.relPath, 'src/index.js');
    assert.equal(res.resolved, '/home/user/repo/src/index.js');
  });

  test('相对路径以 cwd 正确解析', () => {
    const res = attributePath('lib/util.js', WORK, '/home/user/repo');
    assert.notEqual(res, null);
    assert.equal(res.workDir, '/home/user/repo');
    assert.equal(res.relPath, 'lib/util.js');
    assert.equal(res.resolved, '/home/user/repo/lib/util.js');
  });

  test('工作目录根本身正确归属', () => {
    const res = attributePath('/home/user/repo', WORK, '/home/user/repo');
    assert.notEqual(res, null);
    assert.equal(res.workDir, '/home/user/repo');
  });

  test('白名单外的绝对路径拒绝（返回 null）', () => {
    assert.equal(attributePath('/etc/passwd', WORK, '/home/user/repo'), null);
    assert.equal(attributePath('/home/user/.ssh/id_ed25519', WORK, '/home/user/repo'), null);
  });

  test('../ 相对路径逃逸出工作目录拒绝', () => {
    assert.equal(attributePath('../../etc/shadow', WORK, '/home/user/repo'), null);
    assert.equal(attributePath('/home/user/repo/../secret.txt', WORK, '/home/user/repo'), null);
  });

  test('前缀碰撞保护：同前缀但非子目录拒绝（+sep 判定）', () => {
    assert.equal(attributePath('/home/user/repoX/file.txt', WORK, '/home/user/repo'), null);
    assert.equal(attributePath('/home/user/other-project/file.txt', WORK, '/home/user/repo'), null);
  });

  test('缺失参数安全返回 null', () => {
    assert.equal(attributePath('', WORK, '/home/user/repo'), null);
    assert.equal(attributePath(null, WORK, '/home/user/repo'), null);
    assert.equal(attributePath('/home/user/repo/a.txt', null, '/home/user/repo'), null);
    assert.equal(attributePath('/home/user/repo/a.txt', [], '/home/user/repo'), null);
  });
});

test.describe('buildDiff: 变更摘要提取', () => {
  test('Edit 生成单 hunk', () => {
    const diff = buildDiff('Edit', { old_string: 'const a = 1;', new_string: 'const a = 2;' });
    assert.deepEqual(diff, {
      kind: 'edit',
      hunks: [{ old: 'const a = 1;', new: 'const a = 2;' }],
    });
  });

  test('MultiEdit 生成多 hunk', () => {
    const diff = buildDiff('MultiEdit', {
      edits: [
        { old_string: 'a', new_string: 'b' },
        { old_string: 'c', new_string: 'd' },
      ],
    });
    assert.equal(diff.kind, 'multiedit');
    assert.equal(diff.hunks.length, 2);
    assert.deepEqual(diff.hunks[0], { old: 'a', new: 'b' });
    assert.deepEqual(diff.hunks[1], { old: 'c', new: 'd' });
  });

  test('Write 生成 added 全量内容', () => {
    const diff = buildDiff('Write', { content: 'console.log("hello");' });
    assert.deepEqual(diff, { kind: 'write', added: 'console.log("hello");' });
  });

  test('NotebookEdit 生成 added notebook 源码', () => {
    const diff = buildDiff('NotebookEdit', { new_source: 'import numpy as np' });
    assert.deepEqual(diff, { kind: 'notebook', added: 'import numpy as np' });
  });

  test('Read 返回 null（走 readPreview 读盘）', () => {
    assert.equal(buildDiff('Read', { file_path: 'foo.txt' }), null);
  });

  test('缺少字段或畸形输入不抛异常', () => {
    assert.deepEqual(buildDiff('Edit', {}), { kind: 'edit', hunks: [{ old: '', new: '' }] });
    assert.deepEqual(buildDiff('MultiEdit', { edits: null }), { kind: 'multiedit', hunks: [] });
    assert.deepEqual(buildDiff('MultiEdit', { edits: 'not-an-array' }), { kind: 'multiedit', hunks: [] });
    assert.deepEqual(buildDiff('Write', {}), { kind: 'write', added: '' });
    assert.equal(buildDiff('UnknownTool', {}), null);
  });
});

test.describe('readPreview: 有界读盘与 FILE-02 防护', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccm-v2-preview-'));
  const touchedFiles = [];
  const touch = (name, content) => {
    const p = join(dir, name);
    writeFileSync(p, content);
    touchedFiles.push(p);
    return p;
  };

  test.after(() => {
    for (const p of touchedFiles) {
      try { unlinkSync(p); } catch {}
    }
    rmSync(dir, { recursive: true, force: true });
  });

  test('常规文本读取返回 snippet 与未截断状态', () => {
    const file = touch('sample.txt', 'hello world\nline 2');
    const res = readPreview(file);
    assert.notEqual(res, null);
    assert.equal(res.snippet, 'hello world\nline 2');
    assert.equal(res.truncated, false);
    assert.equal(res.binary, undefined);
  });

  test('按 maxLines 限制截断行数', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
    const file = touch('lines.txt', lines);
    const res = readPreview(file, { maxLines: 5 });
    assert.notEqual(res, null);
    assert.equal(res.truncated, true);
    assert.equal(res.snippet.split('\n').length, 5);
    assert.equal(res.snippet.split('\n')[0], 'line 0');
    assert.equal(res.snippet.split('\n')[4], 'line 4');
  });

  test('按 maxBytes 限制截断字节数', () => {
    const text = 'abcdefghijklmnopqrstuvwxyz';
    const file = touch('bytes.txt', text);
    const res = readPreview(file, { maxBytes: 10 });
    assert.notEqual(res, null);
    assert.equal(res.truncated, true);
    assert.equal(res.snippet.length, 10);
  });

  test('含 NUL 的文件识别为二进制，不回显内容', () => {
    const bin = Buffer.from('abc\x00def');
    const file = touch('bin.dat', bin);
    const res = readPreview(file);
    assert.notEqual(res, null);
    assert.equal(res.binary, true);
    assert.match(res.snippet, /二进制/);
  });

  test('小尺寸常见图片（PNG/JPEG/GIF/WEBP）识别并返回 base64', () => {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex');
    const file = touch('small.png', png);
    const res = readPreview(file);
    assert.notEqual(res, null);
    assert.equal(res.binary, true);
    assert.equal(res.image?.mimeType, 'image/png');
    assert.equal(res.image?.base64, png.toString('base64'));
  });

  test('超大图片返回占位信息，不传 base64 防撑爆 socket', () => {
    const fakeBigJpg = Buffer.alloc(2048);
    fakeBigJpg[0] = 0xff; fakeBigJpg[1] = 0xd8; fakeBigJpg[2] = 0xff;
    const file = touch('big.jpg', fakeBigJpg);
    const res = readPreview(file, { maxBytes: 512 });
    assert.notEqual(res, null);
    assert.equal(res.binary, true);
    assert.equal(res.image, undefined);
    assert.equal(res.truncated, true);
    assert.match(res.snippet, /图片.*过大/);
  });

  // §18-A: FIFO 必须在 open 前挡住，绝不无限阻塞事件循环
  test('FILE-02 / §18-A: readPreview 拒绝 FIFO，绝不调用 openSync 阻塞事件循环', { skip: process.platform === 'win32' }, () => {
    const fifoDir = mkdtempSync(join(tmpdir(), 'ccm-v2-preview-fifo-'));
    const fifo = join(fifoDir, 'test.fifo');
    try {
      execFileSync('mkfifo', [fifo]);
      // 子进程 3 秒超时运行 readPreview(fifo)。
      // 若有 openSync 漏洞，子进程会被挂起并在 3 秒后被 SIGTERM 杀死；
      // 若修复成功，readPreview 在 open 前检查 isOpenableTarget 并立即返回 null，退出码为 0。
      const childScript = `
        import { readPreview } from '${fileURLToPath(new URL('../../app/src/files/file-preview.js', import.meta.url))}';
        const res = readPreview(process.argv[1]);
        if (res !== null) {
          process.exit(2);
        }
        process.exit(0);
      `;
      const res = spawnSync(process.execPath, ['--input-type=module', '-e', childScript, fifo], {
        timeout: 3000,
        encoding: 'utf8',
      });
      assert.equal(
        res.status,
        0,
        `readPreview 应在 openSync 前拒绝 FIFO（返回 null），实际退出码 status=${res.status}, signal=${res.signal}, stderr=${res.stderr}`
      );
    } finally {
      rmSync(fifoDir, { recursive: true, force: true });
    }
  });
});
