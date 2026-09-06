// tests/v2/file-preview.test.mjs —— 工具卡片文件预览纯逻辑与有界读盘
// 守护：FILE-02（缺口路径修复）、FILES-3（O_NOFOLLOW 防逃逸）、SCOPE-01（attributePath 范围裁决）
// 测什么：attributePath 归属判定与前缀保护；buildDiff 各种工具差异生成；readPreview 文本截断、二进制与图片魔数识别；FIFO 在 openSync 前拒绝且不卡死
// 不测什么 + 为什么：不测编辑器写回或审批状态——属于 file-browse 与 approval 域
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, unlinkSync, symlinkSync } from 'node:fs';
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

  // ★★ FILES-3：叶节点级 symlink 防逃逸。本文件头一直声称守护 FILES-3，但 2026-09-05 的变异实测
  // 显示 `constants.O_NOFOLLOW || 0` 改成 `&& 0`（＝把 NOFOLLOW 整个丢掉）时【没有任何用例变红】
  // ——声称守护和实际断言是两回事。
  //
  // 不造 realpath↔open 之间的替换竞态：直接对一条 symlink 调用 readPreview 就够了。
  // isOpenableTarget 的白名单放行 symlink（isFile() || isSymbolicLink()），所以闸不挡它，
  // 挡它的只有 O_NOFOLLOW —— 丢掉标志位就会顺着链接把目标读出来，正是要防的逃逸。
  test('FILES-3: readPreview 对 symlink 直接 ELOOP，不跟出去读目标', { skip: process.platform === 'win32' }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'ccm-v2-preview-nofollow-'));
    try {
      const target = join(dir, 'secret.txt');
      const link = join(dir, 'link.txt');
      writeFileSync(target, 'SENTINEL-不该被读到');
      symlinkSync(target, link);

      assert.throws(
        () => readPreview(link),
        (err) => err && err.code === 'ELOOP',
        'O_NOFOLLOW 丢失时这里会成功读到 target 的内容——那就是叶节点级逃逸',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true }); // safe-rm: 本用例 mkdtemp 建的一次性目录
    }
  });
});

// ── 魔数嗅探 ────────────────────────────────────────────────────────────────
// 2026-09-05 变异实测：detectImageMime（file-preview.js:90-100）产出的 30 个变异体【全部存活】。
// 那些行确实被执行到了——文本文件走进来时每个 `buf[0] === 0x..` 都求值过——但四条正例分支
// 从没被真实魔数走过，于是把任意一个字节比较改掉都没人吭声。
//
// 判据不依赖扩展名是有意的（工具 Read 的路径可能无后缀 / 后缀撒谎），所以用例也一律写成
// 「内容决定类型」：文件名统一 .bin，只喂字节。
//
// 长度守卫用【恰好等于】的样本钉住：`buf.length >= 8` 写成 `>` 时，恰好 8 字节的 PNG 会被漏判。
test.describe('FILE-02 邻域：detectImageMime 只认内容不认后缀', () => {
  let dir;
  test.before(() => { dir = mkdtempSync(join(tmpdir(), 'ccm-v2-magic-')); });
  test.after(() => { rmSync(dir, { recursive: true, force: true }); }); // safe-rm: 上一行 mkdtemp 的一次性目录

  const write = (name, bytes) => {
    const p = join(dir, name);
    writeFileSync(p, Buffer.from(bytes));
    return p;
  };
  // 各格式的最短合法前缀，长度恰好压在守卫阈值上。
  const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];                 // 8
  const JPEG = [0xff, 0xd8, 0xff];                                              // 3
  const GIF = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61];                             // 6（GIF89a）
  const WEBP = [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50];    // 12

  for (const [label, bytes, mime] of [
    ['PNG（恰好 8 字节）', PNG, 'image/png'],
    ['JPEG（恰好 3 字节）', JPEG, 'image/jpeg'],
    ['GIF89a（恰好 6 字节）', GIF, 'image/gif'],
    ['WEBP（恰好 12 字节）', WEBP, 'image/webp'],
  ]) {
    test(`${label} → 识别为 ${mime}，回 base64 且 truncated=false`, () => {
      const res = readPreview(write(`${label.replace(/[（）]/g, '_')}.bin`, bytes));
      assert.equal(res.binary, true);
      assert.equal(res.image?.mimeType, mime);
      assert.equal(res.truncated, false, '整文件读完的图片不得标 truncated');
      assert.equal(res.image?.base64, Buffer.from(bytes).toString('base64'));
      assert.equal(res.size, bytes.length);
    });
  }

  test('长度不足阈值一律不认（少一字节的 PNG / WEBP 走二进制兜底）', () => {
    const shortPng = readPreview(write('short-png.bin', [...PNG.slice(0, 7)]));
    assert.equal(shortPng.image, undefined, '7 字节不足以判定 PNG');
    const shortWebp = readPreview(write('short-webp.bin', [...WEBP.slice(0, 11)]));
    assert.equal(shortWebp.image, undefined, '11 字节不足以判定 WEBP');
  });

  test('前缀只对一半不认（每个字节比较都必须真的在比）', () => {
    // 逐个格式各破坏最后一个被检查的字节：任何一处 === 被改成 !== 或 && 被改成 ||，这里就会红。
    const cases = [
      ['fake-png.bin', [0x89, 0x50, 0x4e, 0x00, 0x0d, 0x0a, 0x1a, 0x0a]],
      ['fake-jpeg.bin', [0xff, 0xd8, 0x00]],
      ['fake-gif.bin', [0x47, 0x49, 0x46, 0x00, 0x39, 0x61]],
      ['fake-webp.bin', [...WEBP.slice(0, 11), 0x00]],
    ];
    for (const [name, bytes] of cases) {
      const res = readPreview(write(name, bytes));
      assert.equal(res.image, undefined, `${name} 不是合法魔数，不得被当成图片`);
    }
  });

  test('WEBP 的 RIFF 头对但 8-11 位不是 WEBP → 不认（RIFF 也可能是 wav/avi）', () => {
    const riffWav = [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]; // "WAVE"
    const res = readPreview(write('riff-wave.bin', riffWav));
    assert.equal(res.image, undefined, 'RIFF 容器不等于 WEBP，第二段魔数必须真的在比');
  });

  test('纯文本不进图片分支（负例的负例：魔数嗅探不得误伤正常预览）', () => {
    const res = readPreview(write('plain.bin', [...Buffer.from('hello world\n')]));
    assert.equal(res.image, undefined);
    assert.equal(res.binary, undefined);
    assert.match(res.snippet, /hello world/);
  });
});
