// tests/v2/file-browse.test.mjs —— 文件浏览与编辑器写回关键路径测试
// 守护：SCOPE-01（范围门）、FILE-01（baseHash 防静默覆盖）、FILE-02（读写两路特殊文件闸）、FILES-1（目录浏览范围复核）
// 测什么：listDir 目录分页、symlink/special 标记与越界拒绝；readFile 文本分片、UTF-8 字符边界对齐、base64 模式与 FIFO 拦截；writeFileInScope 的 baseHash 并发冲突、权限保持与 FIFO 保护
// 不测什么 + 为什么：不测敏感文件内容过滤——用户即 root，防线在范围门不在内容审查
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  symlinkSync,
  rmSync,
  realpathSync,
  unlinkSync,
  chmodSync,
  statSync,
  lstatSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import {
  listDir,
  readFile,
  writeFileInScope,
  MAX_BROWSE_ENTRIES,
  MAX_BROWSE_BYTES,
} from '../../app/src/files/file-browse.js';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

test.describe('SCOPE-01 & FILES-1: listDir 文件目录浏览', () => {
  const base = mkdtempSync(join(tmpdir(), 'ccm-v2-browse-list-'));
  test.after(() => rmSync(base, { recursive: true, force: true }));

  const cwd = join(base, 'workspace');
  const outside = join(base, 'outside');
  mkdirSync(join(cwd, 'src'), { recursive: true });
  mkdirSync(join(cwd, 'empty'), { recursive: true });
  mkdirSync(outside, { recursive: true });

  writeFileSync(join(cwd, '.env'), 'TOKEN=secret');
  writeFileSync(join(cwd, 'README.md'), '# Title');
  writeFileSync(join(outside, 'hidden.txt'), 'out');

  if (process.platform !== 'win32') {
    symlinkSync(outside, join(cwd, 'link-outside'));
    execFileSync('mkfifo', [join(cwd, 'named.pipe')]);
  }

  const scopeDirs = [realpathSync(cwd)];

  test('常规目录列出：包含文件名、kind、size、mtime 属性', () => {
    const res = listDir(cwd, '.', scopeDirs);
    assert.notEqual(res, null);
    const readme = res.entries.find((e) => e.name === 'README.md');
    assert.notEqual(readme, undefined);
    assert.equal(readme.kind, 'file');
    assert.ok(readme.size > 0);
    assert.equal(typeof readme.mtime, 'number');

    const src = res.entries.find((e) => e.name === 'src');
    assert.notEqual(src, undefined);
    assert.equal(src.kind, 'dir');
  });

  test('.env 等敏感文件不作内容过滤，正常列出', () => {
    const res = listDir(cwd, '.', scopeDirs);
    assert.ok(res.entries.some((e) => e.name === '.env'));
  });

  test('symlink 条目如实标注 kind: symlink，不主动跟随', { skip: process.platform === 'win32' }, () => {
    const res = listDir(cwd, '.', scopeDirs);
    const link = res.entries.find((e) => e.name === 'link-outside');
    assert.notEqual(link, undefined);
    assert.equal(link.kind, 'symlink');
  });

  test('FILE-02: FIFO 管道如实标注 kind: special，前端不误归类为普通文件', { skip: process.platform === 'win32' }, () => {
    const res = listDir(cwd, '.', scopeDirs);
    const pipe = res.entries.find((e) => e.name === 'named.pipe');
    assert.notEqual(pipe, undefined);
    assert.equal(pipe.kind, 'special');
  });

  test('空目录列出为空数组且 truncated 为 false', () => {
    const res = listDir(cwd, 'empty', scopeDirs);
    assert.notEqual(res, null);
    assert.deepEqual(res.entries, []);
    assert.equal(res.truncated, false);
  });

  test('目录分页：maxEntries 与 offset 配合稳定遍历', () => {
    const pageDir = join(cwd, 'paged');
    mkdirSync(pageDir, { recursive: true });
    for (let i = 0; i < 6; i++) {
      writeFileSync(join(pageDir, `item_${i}.txt`), `item ${i}`);
    }

    const page1 = listDir(cwd, 'paged', scopeDirs, { maxEntries: 2, offset: 0 });
    assert.equal(page1.entries.length, 2);
    assert.equal(page1.truncated, true);
    assert.equal(page1.totalCount, 6);

    const page2 = listDir(cwd, 'paged', scopeDirs, { maxEntries: 2, offset: 2 });
    assert.equal(page2.entries.length, 2);
    assert.equal(page2.truncated, true);

    const page3 = listDir(cwd, 'paged', scopeDirs, { maxEntries: 2, offset: 4 });
    assert.equal(page3.entries.length, 2);
    assert.equal(page3.truncated, false);

    const all = [...page1.entries, ...page2.entries, ...page3.entries].map((e) => e.name);
    assert.deepEqual(all, ['item_0.txt', 'item_1.txt', 'item_2.txt', 'item_3.txt', 'item_4.txt', 'item_5.txt']);
  });

  test('客户端请求的 maxEntries 超限时自动夹紧到 MAX_BROWSE_ENTRIES', () => {
    const res = listDir(cwd, '.', scopeDirs, { maxEntries: 999999 });
    assert.ok(res.entries.length <= MAX_BROWSE_ENTRIES);
  });

  test('越界访问（symlink 逃逸或 ../ 越界）fail-closed 返回 null', () => {
    if (process.platform !== 'win32') {
      assert.equal(listDir(cwd, 'link-outside', scopeDirs), null);
    }
    assert.equal(listDir(cwd, '../outside', scopeDirs), null);
    assert.equal(listDir(cwd, 'does-not-exist', scopeDirs), null);
    assert.equal(listDir(cwd, 'README.md', scopeDirs), null); // 文件非目录返回 null
  });

  test('FI-001: 文件在 readdir 后被删除时跳过，不抛出异常', () => {
    const vanish = join(cwd, 'vanish.txt');
    writeFileSync(vanish, 'temp');
    unlinkSync(vanish);
    assert.doesNotThrow(() => listDir(cwd, '.', scopeDirs));
  });
});

test.describe('SCOPE-01 & FILE-02: readFile 内容分片与特殊文件闸', () => {
  const base = mkdtempSync(join(tmpdir(), 'ccm-v2-browse-read-'));
  test.after(() => rmSync(base, { recursive: true, force: true }));

  const cwd = join(base, 'workspace');
  const outside = join(base, 'outside');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(outside, { recursive: true });

  writeFileSync(join(cwd, 'short.txt'), 'hello node test');
  writeFileSync(join(cwd, 'binary.dat'), Buffer.from([0x61, 0x00, 0x62])); // 含 NUL
  writeFileSync(join(outside, 'secret.txt'), 'classified');

  if (process.platform !== 'win32') {
    symlinkSync(outside, join(cwd, 'link-outside'));
    execFileSync('mkfifo', [join(cwd, 'pipe.fifo')]);
  }

  const scopeDirs = [realpathSync(cwd)];

  test('正常读取小文件：正确返回 content、totalSize 与 contentHash', () => {
    const res = readFile(cwd, 'short.txt', scopeDirs);
    assert.notEqual(res, null);
    assert.equal(res.content, 'hello node test');
    assert.equal(res.truncated, false);
    assert.equal(res.binary, false);
    assert.equal(res.contentHash, sha256('hello node test'));
  });

  test('二进制检测：检测到 NUL 时标记 binary: true 且内容置空', () => {
    const res = readFile(cwd, 'binary.dat', scopeDirs);
    assert.notEqual(res, null);
    assert.equal(res.binary, true);
    assert.equal(res.content, '');
    assert.equal(res.contentHash, undefined);
  });

  test('大文件按 maxBytes 分片读取与 offset 续读拼装', () => {
    const longText = 'A'.repeat(500) + 'B'.repeat(500);
    writeFileSync(join(cwd, 'long.txt'), longText);

    const chunk1 = readFile(cwd, 'long.txt', scopeDirs, { maxBytes: 500, offset: 0 });
    assert.equal(chunk1.truncated, true);
    assert.equal(chunk1.content, 'A'.repeat(500));
    assert.equal(chunk1.contentHash, undefined); // 截断读不提供 contentHash

    const chunk2 = readFile(cwd, 'long.txt', scopeDirs, { maxBytes: 500, offset: 500 });
    assert.equal(chunk2.truncated, false);
    assert.equal(chunk2.content, 'B'.repeat(500));
    assert.equal(chunk1.content + chunk2.content, longText);
  });

  test('分片在多字节 UTF-8 字符（如中文）中间切断时自动回退边界', () => {
    const zhText = '前缀文本' + '测' + '后缀文本';
    writeFileSync(join(cwd, 'zh.txt'), zhText, 'utf8');

    // '前缀文本' 4个中文字符 = 12 字节；若 maxBytes=13，恰好切入 '测'(3字节) 的第1个字节
    const chunk1 = readFile(cwd, 'zh.txt', scopeDirs, { maxBytes: 13, offset: 0 });
    assert.equal(chunk1.content, '前缀文本');
    assert.equal(chunk1.bytesRead, 12); // 回退到 12 字节
    assert.equal(chunk1.truncated, true);

    const chunk2 = readFile(cwd, 'zh.txt', scopeDirs, { maxBytes: 50, offset: chunk1.bytesRead });
    assert.equal(chunk2.content, '测' + '后缀文本');
    assert.equal(chunk1.content + chunk2.content, zhText);
  });

  test('base64 模式：精准分页读取二进制数据，不执行 UTF-8 回退', () => {
    const rawBytes = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x06]);
    writeFileSync(join(cwd, 'stream.bin'), rawBytes);

    const p1 = readFile(cwd, 'stream.bin', scopeDirs, { maxBytes: 3, offset: 0, encoding: 'base64' });
    assert.equal(p1.binary, false); // 无 NUL，非文本裁剪模式
    assert.equal(p1.bytesRead, 3);
    assert.equal(p1.content, rawBytes.subarray(0, 3).toString('base64'));

    const p2 = readFile(cwd, 'stream.bin', scopeDirs, { maxBytes: 3, offset: 3, encoding: 'base64' });
    assert.equal(p2.bytesRead, 3);
    assert.equal(p2.content, rawBytes.subarray(3, 6).toString('base64'));

    const combined = Buffer.concat([Buffer.from(p1.content, 'base64'), Buffer.from(p2.content, 'base64')]);
    assert.deepEqual(combined, rawBytes);
  });

  test('越界访问、指向目录或不存在文件均返回 null', () => {
    if (process.platform !== 'win32') {
      assert.equal(readFile(cwd, 'link-outside/secret.txt', scopeDirs), null);
    }
    assert.equal(readFile(cwd, '../outside/secret.txt', scopeDirs), null);
    assert.equal(readFile(cwd, 'src', scopeDirs), null);
    assert.equal(readFile(cwd, 'not-found.txt', scopeDirs), null);
  });

  test('FILE-02: readFile 遇到 FIFO 管道立即返回 null，不调用 openSync 阻塞', { skip: process.platform === 'win32' }, () => {
    const res = readFile(cwd, 'pipe.fifo', scopeDirs);
    assert.equal(res, null);
  });
});

test.describe('FILE-01 & FILE-02: writeFileInScope 编辑器写回与并发保护', () => {
  const base = mkdtempSync(join(tmpdir(), 'ccm-v2-browse-write-'));
  test.after(() => rmSync(base, { recursive: true, force: true }));

  const cwd = join(base, 'workspace');
  const outside = join(base, 'outside');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(outside, { recursive: true });

  writeFileSync(join(cwd, 'editable.txt'), 'version 1');
  writeFileSync(join(outside, 'secret.txt'), 'outside');

  if (process.platform !== 'win32') {
    symlinkSync(outside, join(cwd, 'link-outside'));
    execFileSync('mkfifo', [join(cwd, 'pipe.fifo')]);
  }

  const scopeDirs = [realpathSync(cwd)];

  test('baseHash 匹配时写回成功并返回新 contentHash，支持连续链式编辑', () => {
    const hashV1 = sha256('version 1');
    const res1 = writeFileInScope(cwd, 'editable.txt', 'version 2', scopeDirs, { baseHash: hashV1 });
    assert.equal(res1.ok, true);
    assert.equal(readFileSync(join(cwd, 'editable.txt'), 'utf8'), 'version 2');
    assert.equal(res1.contentHash, sha256('version 2'));

    // 链式写入 version 3
    const res2 = writeFileInScope(cwd, 'editable.txt', 'version 3', scopeDirs, { baseHash: res1.contentHash });
    assert.equal(res2.ok, true);
    assert.equal(readFileSync(join(cwd, 'editable.txt'), 'utf8'), 'version 3');
  });

  test('FILE-01: baseHash 过期或不匹配时拒绝并返回 conflict，不发生静默覆盖', () => {
    const staleHash = sha256('stale content');
    const res = writeFileInScope(cwd, 'editable.txt', 'hacked', scopeDirs, { baseHash: staleHash });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'conflict');
    assert.equal(readFileSync(join(cwd, 'editable.txt'), 'utf8'), 'version 3');
  });

  test('缺失或非法的 baseHash 拒绝', () => {
    const res = writeFileInScope(cwd, 'editable.txt', 'data', scopeDirs, {});
    assert.equal(res.ok, false);
    assert.equal(res.code, 'bad_base_hash');
  });

  test('content 非字符串拒绝', () => {
    const res = writeFileInScope(cwd, 'editable.txt', 12345, scopeDirs, { baseHash: sha256('version 3') });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'bad_content');
  });

  test('写入内容超出 MAX_BROWSE_BYTES 限制拒绝', () => {
    const huge = 'x'.repeat(MAX_BROWSE_BYTES + 1);
    const res = writeFileInScope(cwd, 'editable.txt', huge, scopeDirs, { baseHash: sha256('version 3') });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'too_large');
  });

  test('目标文件不存在拒绝（不隐式创建新文件）', () => {
    const res = writeFileInScope(cwd, 'non-existent.txt', 'content', scopeDirs, { baseHash: sha256('') });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'scope');
    assert.equal(existsSync(join(cwd, 'non-existent.txt')), false);
  });

  test('目标是目录拒绝（code: not_file）', () => {
    mkdirSync(join(cwd, 'dir-target'));
    const res = writeFileInScope(cwd, 'dir-target', 'content', scopeDirs, { baseHash: sha256('') });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'not_file');
  });

  test('越界路径拒绝写入', () => {
    if (process.platform !== 'win32') {
      const res1 = writeFileInScope(cwd, 'link-outside/secret.txt', 'bad', scopeDirs, { baseHash: sha256('outside') });
      assert.equal(res1.ok, false);
      assert.equal(res1.code, 'scope');
    }
    const res2 = writeFileInScope(cwd, '../outside/secret.txt', 'bad', scopeDirs, { baseHash: sha256('outside') });
    assert.equal(res2.ok, false);
    assert.equal(res2.code, 'scope');
  });

  test('FILE-02: 拒绝写入 FIFO 特殊文件，避免卡死或覆盖特殊设备', { skip: process.platform === 'win32' }, () => {
    const emptyHash = sha256('');
    const res = writeFileInScope(cwd, 'pipe.fifo', 'payload', scopeDirs, { baseHash: emptyHash });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'not_file');
    assert.equal(lstatSync(join(cwd, 'pipe.fifo')).isFIFO(), true);
  });

  test('保留原文件权限位（0755 不丢可执行位，0600 不放宽）', { skip: process.platform === 'win32' }, () => {
    const script = join(cwd, 'run.sh');
    const secret = join(cwd, 'secret.env');
    writeFileSync(script, 'echo 1');
    chmodSync(script, 0o755);
    writeFileSync(secret, 'PRIVATE=1');
    chmodSync(secret, 0o600);

    const r1 = writeFileInScope(cwd, 'run.sh', 'echo 2', scopeDirs, { baseHash: sha256('echo 1') });
    assert.equal(r1.ok, true);
    assert.equal(statSync(script).mode & 0o777, 0o755);

    const r2 = writeFileInScope(cwd, 'secret.env', 'PRIVATE=2', scopeDirs, { baseHash: sha256('PRIVATE=1') });
    assert.equal(r2.ok, true);
    assert.equal(statSync(secret).mode & 0o777, 0o600);
  });
});
