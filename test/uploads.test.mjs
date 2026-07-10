// test/uploads.test.mjs —— uploads.js 安全关键路径单测
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, mkdir } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import {
  sanitizeName, validateAttachments, saveAttachments, buildPromptText, toEventMeta, UPLOAD_DIR
} from '../uploads.js';

test.describe('sanitizeName', () => {
  test('纯文件名原样返回', () => {
    assert.equal(sanitizeName('hello.txt'), 'hello.txt');
  });

  test('路径分隔符替换为 _（basename 优先取末段）', () => {
    // basename('a/b.txt') = 'b.txt'（目录已剥掉，分隔符不会出现在结果中）
    assert.equal(sanitizeName('a/b.txt'), 'b.txt');
    // 但若分隔符在 basename 内（罕见），会被替换
    assert.equal(sanitizeName('a:b.txt'), 'a_b.txt');
  });

  test('前导点剥离', () => {
    assert.equal(sanitizeName('.hidden'), 'hidden');
    assert.equal(sanitizeName('..hidden'), 'hidden');
    assert.equal(sanitizeName('...config'), 'config');
  });

  test('BOM 前缀不应让前导点"复活"（code-review P1：trim 需在去前导点之前跑）', () => {
    // ﻿ 是 trim() 承认的空白字符；若去前导点先跑（此时开头是 BOM 不是点，不剥离），
    // trim 才把 BOM 去掉，结果会重新暴露一个未被剥离的前导点隐藏文件名。
    assert.equal(sanitizeName('﻿.hidden'), 'hidden');
  });

  test('控制字符剥离', () => {
    assert.equal(sanitizeName('test\x00file'), 'testfile');
    assert.equal(sanitizeName('test\x1ffile'), 'testfile');
    // \x7f (DEL) stripped
    const noDel = sanitizeName('a\x7fb');
    assert.ok(!noDel.includes('\x7f'));
  });

  test('空串 → "file"', () => {
    assert.equal(sanitizeName(''), 'file');
    assert.equal(sanitizeName('.'), 'file');
    assert.equal(sanitizeName('..'), 'file');
  });

  test('null/undefined → "file"', () => {
    assert.equal(sanitizeName(null), 'file');
    assert.equal(sanitizeName(undefined), 'file');
  });

  test('仅取 basename（去掉目录路径）', () => {
    // POSIX: basename 用 / 分隔 → 去掉目录
    assert.equal(sanitizeName('/tmp/subdir/file.txt'), 'file.txt');
    // Windows 风格路径在 POSIX 上 \ 不是分隔符 → basename 不剥 → / \ : 替换为 _
    // 精确输出取决于平台，只验证不含危险字符
    const win = sanitizeName('C:\\Users\\file.txt');
    assert.ok(!win.includes('\\'));
    assert.ok(!win.includes(':'));
    assert.ok(win.includes('file.txt'));
  });
});

test.describe('validateAttachments', () => {
  test('空数组 → null', () => {
    assert.equal(validateAttachments([]), null);
  });

  test('非数组 → null', () => {
    assert.equal(validateAttachments(null), null);
    assert.equal(validateAttachments(undefined), null);
    assert.equal(validateAttachments('string'), null);
  });

  test('超过 10 个 → error', () => {
    const arr = Array.from({ length: 11 }, (_, i) => ({
      name: `f${i}.txt`, mimeType: 'text/plain', data: 'aGVsbG8=' // "hello"
    }));
    assert.ok(validateAttachments(arr).includes('过多'));
  });

  test('缺少 data → error', () => {
    assert.equal(validateAttachments([{ name: 'f.txt', mimeType: 'text/plain' }]), '附件缺少数据');
    assert.equal(validateAttachments([{ name: 'f.txt', mimeType: 'text/plain', data: '' }]), '附件缺少数据');
  });

  test('缺少 name/mimeType → error', () => {
    assert.equal(validateAttachments([{ data: 'aGVsbG8=' }]), '附件缺少 name/mimeType');
    assert.equal(validateAttachments([{ name: 'f.txt', data: 'aGVsbG8=' }]), '附件缺少 name/mimeType');
  });

  test('单文件超过 10MB → error', () => {
    // 10MB + 1 byte base64 编码→ ~13.3MB base64 字符串
    const big = Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64');
    const err = validateAttachments([{ name: 'big.bin', mimeType: 'application/octet-stream', data: big }]);
    assert.ok(err.includes('过大'));
  });

  test('总量超过 20MB → error', () => {
    // 三个 8MB 文件：单个不超过 10MB，但总量 24MB > 20MB
    const f8mb = Buffer.alloc(8 * 1024 * 1024).toString('base64');
    const err = validateAttachments([
      { name: 'a.bin', mimeType: 'application/octet-stream', data: f8mb },
      { name: 'b.bin', mimeType: 'application/octet-stream', data: f8mb },
      { name: 'c.bin', mimeType: 'application/octet-stream', data: f8mb }
    ]);
    assert.ok(err && err.includes('总量过大'), `expected '总量过大' in error, got: ${err}`);
  });

  test('合法附件 → null', () => {
    const valid = validateAttachments([
      { name: 'hello.txt', mimeType: 'text/plain', data: 'aGVsbG8=' }
    ]);
    assert.equal(valid, null);
  });
});

test.describe('saveAttachments', () => {
  let tmpDir;
  test.beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'ccm-upload-test-'));
  });
  test.afterEach(async () => {
    try { await rm(tmpDir, { recursive: true, force: true }); } catch {}
  });

  test('正常落盘 → 返回 absPath + 写文件', async () => {
    const attachments = [{ name: 'test.txt', mimeType: 'text/plain', data: 'aGVsbG8=' }];
    const saved = await saveAttachments(tmpDir, attachments);
    assert.equal(saved.length, 1);
    assert.ok(saved[0].absPath.startsWith(join(tmpDir, UPLOAD_DIR)));
    assert.equal(saved[0].name, 'test.txt');
    assert.equal(saved[0].mimeType, 'text/plain');
    assert.equal(saved[0].size, 5);
  });

  test('恶意文件名穿越仍落在上传目录内（真恶意输入，不逃逸）', async () => {
    // 真攻击输入：name 含 ../ 与绝对路径片段。sanitizeName 收敛后落点必须仍在 .ccm-uploads 内。
    const saved = await saveAttachments(tmpDir, [
      { name: '../../../etc/passwd', mimeType: 'text/plain', data: 'aGVsbG8=' }
    ]);
    const dirResolved = resolve(join(tmpDir, UPLOAD_DIR));
    assert.ok(saved[0].absPath.startsWith(dirResolved + sep), `落点逃逸: ${saved[0].absPath}`);
    assert.ok(!saved[0].absPath.includes('etc/passwd'), '穿越到 /etc 未被拦截');
  });

  test('上传目录路径含 symlink → 抛错拒绝（TOCTOU 防御，此前零覆盖）', async () => {
    if (process.platform === 'win32') return;
    const base = await mkdtemp(join(tmpdir(), 'ccm-uplink-'));
    try {
      const real = join(base, 'realwork'); await mkdir(real, { recursive: true });
      const linkWork = join(base, 'linkwork'); await symlink(real, linkWork);
      // workDir 本身经由 symlink（linkWork）→ rejectableSymlinkComponent 检出上传目录路径含软链 → 抛错
      await assert.rejects(
        saveAttachments(linkWork, [{ name: 'a.png', mimeType: 'image/png', data: 'aGVsbG8=' }]),
        /符号链接/,
        '上传目录路径含 symlink 时应拒绝落盘'
      );
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test('空附件列表 → 返回空数组', async () => {
    const saved = await saveAttachments(tmpDir, []);
    assert.deepEqual(saved, []);
  });
});

test.describe('buildPromptText', () => {
  test('有文本 + 附件 → 追加 [附件] 段', () => {
    const result = buildPromptText('帮我看看这个文件', [{ absPath: '/tmp/test.txt' }]);
    assert.ok(result.includes('帮我看看这个文件'));
    assert.ok(result.includes('[附件]'));
    assert.ok(result.includes('/tmp/test.txt'));
  });

  test('纯附件（无文本）→ 只返回 [附件] 段', () => {
    const result = buildPromptText('', [{ absPath: '/tmp/test.txt' }]);
    assert.ok(result.startsWith('[附件]'));
    assert.ok(!result.includes('\n\n[附件]')); // 不前置空行
  });

  test('空 saved → 返回原文', () => {
    assert.equal(buildPromptText('hello', []), 'hello');
    assert.equal(buildPromptText('hello', null), 'hello');
    assert.equal(buildPromptText('', []), '');
  });
});

test.describe('toEventMeta', () => {
  test('元数据不含 absPath 和 data', () => {
    const meta = toEventMeta([
      { absPath: '/secret/path', name: 'f.txt', mimeType: 'text/plain', size: 100, thumb: 'data:...' }
    ]);
    assert.equal(meta.length, 1);
    assert.equal(meta[0].name, 'f.txt');
    assert.equal(meta[0].mimeType, 'text/plain');
    assert.equal(meta[0].size, 100);
    assert.equal(meta[0].thumb, 'data:...');
    assert.equal(meta[0].absPath, undefined);
    assert.equal(meta[0].data, undefined);
  });
});
