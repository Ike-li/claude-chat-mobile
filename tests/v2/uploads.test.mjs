// tests/v2/uploads.test.mjs —— 附件落盘与防穿越安全测试
// 守护：SCOPE-02（sanitize / 大小上限 / 路径不泄露）、FILES-2（symlink 检查与 realpath 归一）、FILES-4（缩略图服务端长度硬限）
// 测什么：sanitizeName 清洗恶意路径与 BOM 前导点；validateAttachments 单文件/总量/数量/缩略图硬限；saveAttachments 真实落盘 0600 权限与 symlink 攻击拦截；buildPromptText 注入提示词；toEventMeta 剥离服务端绝对路径
// 不测什么 + 为什么：不测客户端 canvas 降采样生成逻辑——属于前端职责，服务端实施防御性硬闸
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, mkdir, stat } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import {
  sanitizeName,
  validateAttachments,
  saveAttachments,
  buildPromptText,
  toEventMeta,
  UPLOAD_DIR,
  MAX_FILES,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
} from '../../app/src/files/uploads.js';

test.describe('SCOPE-02: sanitizeName 文件名安全清洗', () => {
  test('常规文件名保持不变', () => {
    assert.equal(sanitizeName('report.pdf'), 'report.pdf');
  });

  test('提取 basename 并替换路径与特殊字符为下划线', () => {
    assert.equal(sanitizeName('folder/file.png'), 'file.png');
    assert.equal(sanitizeName('a:b<c>d"e|f?g*h.txt'), 'a_b_c_d_e_f_g_h.txt');
  });

  test('剥离前导点（防隐藏文件与 ./.. 路径遍历）', () => {
    assert.equal(sanitizeName('.hidden'), 'hidden');
    assert.equal(sanitizeName('...secret.env'), 'secret.env');
  });

  test('BOM 前缀经 trim 处理后不导致前导点复活', () => {
    assert.equal(sanitizeName('\uFEFF.hidden'), 'hidden');
  });

  test('剥离控制字符（\x00-\x1f 及 \x7f）', () => {
    assert.equal(sanitizeName('test\x00\x08\x1f\x7f.log'), 'test.log');
  });

  test('空文件名、点路径或非字符串回退为 "file"', () => {
    assert.equal(sanitizeName(''), 'file');
    assert.equal(sanitizeName('.'), 'file');
    assert.equal(sanitizeName('..'), 'file');
    assert.equal(sanitizeName(null), 'file');
    assert.equal(sanitizeName(undefined), 'file');
  });
});

test.describe('SCOPE-02 & FILES-4: validateAttachments 服务端输入校验', () => {
  const dummyB64 = Buffer.from('hello').toString('base64');

  test('合法附件列表返回 null（校验通过）', () => {
    const list = [{ name: 'test.txt', mimeType: 'text/plain', data: dummyB64 }];
    assert.equal(validateAttachments(list), null);
    assert.equal(validateAttachments([]), null);
    assert.equal(validateAttachments(null), null);
  });

  test('附件数量超出 MAX_FILES 限制报错', () => {
    const list = Array.from({ length: MAX_FILES + 1 }, (_, i) => ({
      name: `f${i}.txt`,
      mimeType: 'text/plain',
      data: dummyB64,
    }));
    const err = validateAttachments(list);
    assert.match(err, /附件过多/);
  });

  test('缺少必要字段（data, name, mimeType）报错', () => {
    assert.match(validateAttachments([{ name: 'a.txt', mimeType: 'text/plain' }]), /缺少数据/);
    assert.match(validateAttachments([{ name: 'a.txt', mimeType: 'text/plain', data: '' }]), /缺少数据/);
    assert.match(validateAttachments([{ data: dummyB64, mimeType: 'text/plain' }]), /缺少 name\/mimeType/);
    assert.match(validateAttachments([{ data: dummyB64, name: 'a.txt' }]), /缺少 name\/mimeType/);
  });

  test('单文件超出 MAX_FILE_BYTES 限制报错', () => {
    const bigB64 = Buffer.alloc(MAX_FILE_BYTES + 1).toString('base64');
    const err = validateAttachments([{ name: 'big.bin', mimeType: 'application/octet-stream', data: bigB64 }]);
    assert.match(err, /单文件上限/);
  });

  test('附件总量超出 MAX_TOTAL_BYTES 限制报错', () => {
    assert.equal(MAX_TOTAL_BYTES, 20 * 1024 * 1024);
    // 构造总和超出 20MB 的多文件（单个不超过 10MB）
    const f8mb = Buffer.alloc(8 * 1024 * 1024).toString('base64');
    const err = validateAttachments([
      { name: '1.bin', mimeType: 'application/octet-stream', data: f8mb },
      { name: '2.bin', mimeType: 'application/octet-stream', data: f8mb },
      { name: '3.bin', mimeType: 'application/octet-stream', data: f8mb },
    ]);
    assert.match(err, /总量过大/);
  });

  test('FILES-4: 缩略图超过 100k 字符或非字符串拒绝', () => {
    const hugeThumb = 'data:image/png;base64,' + 'a'.repeat(100_001);
    const err1 = validateAttachments([
      { name: 'img.png', mimeType: 'image/png', data: dummyB64, thumb: hugeThumb },
    ]);
    assert.match(err1, /缩略图过大/);

    const err2 = validateAttachments([
      { name: 'img.png', mimeType: 'image/png', data: dummyB64, thumb: 12345 },
    ]);
    assert.match(err2, /缩略图类型无效/);
  });
});

test.describe('SCOPE-02 & FILES-2: saveAttachments 真实落盘与 symlink 防护', () => {
  let tmpDir;

  test.beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'ccm-v2-uploads-'));
  });

  test.afterEach(async () => {
    try {
      await rm(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  test('正常落盘写入 WORK_DIR/.ccm-uploads/，权限为 0600', async () => {
    const attachments = [{ name: 'hello.txt', mimeType: 'text/plain', data: Buffer.from('world').toString('base64') }];
    const saved = await saveAttachments(tmpDir, attachments);

    assert.equal(saved.length, 1);
    assert.equal(saved[0].name, 'hello.txt');
    assert.equal(saved[0].size, 5);

    const realDir = realpathSync(join(tmpDir, UPLOAD_DIR));
    assert.ok(saved[0].absPath.startsWith(realDir + sep));

    if (process.platform !== 'win32') {
      const st = await stat(saved[0].absPath);
      assert.equal(st.mode & 0o777, 0o600);
    }
  });

  test('恶意文件名穿越仍安全收敛在 .ccm-uploads 目录内', async () => {
    const malicious = [
      { name: '../../../../../../etc/passwd', mimeType: 'text/plain', data: Buffer.from('x').toString('base64') },
    ];
    const saved = await saveAttachments(tmpDir, malicious);
    const realDir = realpathSync(join(tmpDir, UPLOAD_DIR));

    assert.ok(saved[0].absPath.startsWith(realDir + sep));
    assert.equal(saved[0].absPath.includes('etc/passwd'), false);
  });

  test('FILES-2: 上传目录路径包含可疑符号链接时拒绝落盘', { skip: process.platform === 'win32' }, async () => {
    const base = await mkdtemp(join(tmpdir(), 'ccm-v2-uplink-'));
    try {
      const real = join(base, 'real-work');
      const link = join(base, 'link-work');
      await mkdir(real, { recursive: true });
      await symlink(real, link);

      await assert.rejects(
        saveAttachments(link, [{ name: 'doc.txt', mimeType: 'text/plain', data: Buffer.from('hi').toString('base64') }]),
        /符号链接/
      );
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test('空附件列表直接返回空数组', async () => {
    const res = await saveAttachments(tmpDir, []);
    assert.deepEqual(res, []);
  });
});

test.describe('buildPromptText: 提示词路径注入', () => {
  test('常规文本末尾追加 [附件] 块与绝对路径', () => {
    const prompt = buildPromptText('查看附件', [{ absPath: '/var/repo/.ccm-uploads/f1.txt' }]);
    assert.ok(prompt.startsWith('查看附件\n\n[附件]'));
    assert.ok(prompt.includes('/var/repo/.ccm-uploads/f1.txt'));
  });

  test('纯附件（prompt 为空）只生成 [附件] 块，不保留前置换行', () => {
    const prompt = buildPromptText('', [{ absPath: '/var/repo/.ccm-uploads/f1.txt' }]);
    assert.ok(prompt.startsWith('[附件]'));
    assert.ok(!prompt.includes('\n\n[附件]'));
  });

  test('无附件时原样返回文本', () => {
    assert.equal(buildPromptText('纯文字', []), '纯文字');
    assert.equal(buildPromptText('纯文字', null), '纯文字');
  });
});

test.describe('SCOPE-02: toEventMeta 客户端事件元数据保护', () => {
  test('剥离 absPath 和完整 data，只暴露 storedName 与尺寸', () => {
    const meta = toEventMeta([
      {
        absPath: '/private/secret/dir/.ccm-uploads/1700000000-abcd-photo.png',
        name: 'photo.png',
        mimeType: 'image/png',
        size: 2048,
        thumb: 'data:image/png;base64,thumbdata',
      },
    ]);

    assert.equal(meta.length, 1);
    assert.equal(meta[0].name, 'photo.png');
    assert.equal(meta[0].storedName, '1700000000-abcd-photo.png');
    assert.equal(meta[0].size, 2048);
    assert.equal(meta[0].thumb, 'data:image/png;base64,thumbdata');

    // 绝对路径与原始数据不得泄露
    assert.equal(meta[0].absPath, undefined);
    assert.equal(meta[0].data, undefined);
    assert.ok(!JSON.stringify(meta).includes('/private/secret/dir'));
  });
});
