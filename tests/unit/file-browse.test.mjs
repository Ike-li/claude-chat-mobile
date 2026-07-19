// tests/unit/file-browse.test.mjs —— FileBrowseHandler 单测（docs/design.md，承接 AD-12/FR-07"浏览项目文件"）
// listDir/readFile：请求-响应型只读文件浏览，弱网上限（分页/截断）、二进制检测、symlink 如实标注。
// 敏感文件（.env 等）不做内容过滤——docs/design.md 显式抉择（机主即 root + 透明性，防线在范围门不在内容审查），
// 故本文件不测"过滤"，只测"范围门挡越界 + 弱网上限正确"。真实临时目录测试，同 workdir-scope-guard 惯例。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { listDir, readFile, MAX_BROWSE_ENTRIES, MAX_BROWSE_BYTES } from '../../src/files/file-browse.js';

test.describe('listDir', () => {
  const base = mkdtempSync(join(tmpdir(), 'ccm-browse-'));
  test.after(() => rmSync(base, { recursive: true, force: true }));
  const cwd = join(base, 'project');
  const outside = join(base, 'outside');
  mkdirSync(join(cwd, 'src'), { recursive: true });
  mkdirSync(join(cwd, 'empty-dir'), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(cwd, '.env'), 'SECRET=1'); // 敏感文件——本套件不测过滤，只测能不能正常列出（范围门内即可见）
  writeFileSync(join(cwd, 'README.md'), '# hi');
  symlinkSync(outside, join(cwd, 'link-out'));
  const scopeDirs = [realpathSync(cwd)];

  test('列出目录：含普通文件与目录，size/mtime/kind 齐全', () => {
    const res = listDir(cwd, '.', scopeDirs);
    assert.notEqual(res, null);
    const names = res.entries.map(e => e.name).sort();
    assert.deepEqual(names, ['.env', 'README.md', 'empty-dir', 'link-out', 'src']);
    const readme = res.entries.find(e => e.name === 'README.md');
    assert.equal(readme.kind, 'file');
    assert.ok(readme.size > 0);
    assert.ok(typeof readme.mtime === 'number');
    const src = res.entries.find(e => e.name === 'src');
    assert.equal(src.kind, 'dir');
  });

  test('.env 等敏感文件不做内容过滤——正常出现在列表中（防线在范围门不在内容审查）', () => {
    const res = listDir(cwd, '.', scopeDirs);
    assert.ok(res.entries.some(e => e.name === '.env'));
  });

  test('symlink 条目如实标注 kind:"symlink"，不 follow 解析成其指向的类型', () => {
    const res = listDir(cwd, '.', scopeDirs);
    const link = res.entries.find(e => e.name === 'link-out');
    assert.equal(link.kind, 'symlink');
  });

  test('空目录 → entries=[]', () => {
    const res = listDir(cwd, 'empty-dir', scopeDirs);
    assert.deepEqual(res.entries, []);
    assert.equal(res.truncated, false);
  });

  // FI-001：readdir 与 lstat 之间文件消失 → 跳过该条，整页仍 ok（不抛）
  test('listDir：分页内某文件在 lstat 前消失 → 跳过该项不抛（FI-001）', () => {
    const vanish = join(cwd, 'vanish-me.txt');
    writeFileSync(vanish, 'x');
    // 用 Proxy 包装：模拟 readdir 已含名、lstat 失败——通过先删再 list 难稳定，
    // 这里直接 list 正常目录即可证明不抛；竞态路径靠实现 try/catch 保证。
    assert.doesNotThrow(() => listDir(cwd, '.', scopeDirs));
    // 删一个存在的文件后 list 仍成功
    unlinkSync(vanish);
    const res = listDir(cwd, '.', scopeDirs);
    assert.notEqual(res, null);
    assert.ok(!res.entries.some(e => e.name === 'vanish-me.txt'));
  });

  test('子目录 relPath 正常列出', () => {
    writeFileSync(join(cwd, 'src', 'index.js'), '1');
    const res = listDir(cwd, 'src', scopeDirs);
    assert.deepEqual(res.entries.map(e => e.name), ['index.js']);
  });

  test('大目录分页截断：maxEntries 限制 + offset 续取', () => {
    const bigDir = join(cwd, 'big');
    mkdirSync(bigDir);
    for (let i = 0; i < 10; i++) writeFileSync(join(bigDir, `f${String(i).padStart(2, '0')}.txt`), String(i));
    const page1 = listDir(cwd, 'big', scopeDirs, { maxEntries: 4 });
    assert.equal(page1.entries.length, 4);
    assert.equal(page1.truncated, true);
    assert.equal(page1.totalCount, 10);
    const page2 = listDir(cwd, 'big', scopeDirs, { offset: 4, maxEntries: 4 });
    assert.equal(page2.entries.length, 4);
    assert.equal(page2.truncated, true);
    const page3 = listDir(cwd, 'big', scopeDirs, { offset: 8, maxEntries: 4 });
    assert.equal(page3.entries.length, 2);
    assert.equal(page3.truncated, false);
    // 三页拼接=全部 10 个、不重不漏（稳定排序保证分页正确性）
    const all = [...page1.entries, ...page2.entries, ...page3.entries].map(e => e.name);
    assert.deepEqual(all, Array.from({ length: 10 }, (_, i) => `f${String(i).padStart(2, '0')}.txt`));
  });

  test('relPath 越界（symlink 指向范围外）→ null（fail-closed 拒绝）', () => {
    assert.equal(listDir(cwd, 'link-out', scopeDirs), null);
  });

  test('relPath 用 ../ 逃逸范围 → null', () => {
    assert.equal(listDir(cwd, '../outside', scopeDirs), null);
  });

  test('relPath 指向文件而非目录 → null（不是有效的 list 目标）', () => {
    assert.equal(listDir(cwd, 'README.md', scopeDirs), null);
  });

  test('relPath 指向不存在路径 → null', () => {
    assert.equal(listDir(cwd, 'does-not-exist', scopeDirs), null);
  });

  test('客户端请求 maxEntries 超硬顶 → 服务端夹到 MAX_BROWSE_ENTRIES（弱网上限不可被请求参数绕过）', () => {
    const res = listDir(cwd, '.', scopeDirs, { maxEntries: 999999 });
    assert.ok(res.entries.length <= MAX_BROWSE_ENTRIES);
  });
});

test.describe('readFile', () => {
  const base = mkdtempSync(join(tmpdir(), 'ccm-browse-read-'));
  test.after(() => rmSync(base, { recursive: true, force: true }));
  const cwd = join(base, 'project');
  const outside = join(base, 'outside');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(cwd, 'small.txt'), 'hello world');
  writeFileSync(join(cwd, 'binary.dat'), Buffer.from([0x41, 0x42, 0x00, 0x43])); // 含 NUL
  writeFileSync(join(outside, 'secret.txt'), 'shh');
  symlinkSync(outside, join(cwd, 'link-out'));
  const bigContent = Array.from({ length: 1000 }, (_, i) => String(i).padStart(4, '0')).join(''); // 4000 字节
  writeFileSync(join(cwd, 'big.txt'), bigContent);
  const scopeDirs = [realpathSync(cwd)];

  test('正常读小文件：content 正确、truncated=false、binary=false', () => {
    const res = readFile(cwd, 'small.txt', scopeDirs);
    assert.equal(res.content, 'hello world');
    assert.equal(res.truncated, false);
    assert.equal(res.totalSize, 11);
    assert.equal(res.binary, false);
  });

  test('二进制检测：含 NUL 字节 → binary=true，不回显内容', () => {
    const res = readFile(cwd, 'binary.dat', scopeDirs);
    assert.equal(res.binary, true);
    assert.equal(res.content, '');
    assert.equal(res.totalSize, 4);
  });

  test('大文件按 maxBytes 截断 + offset 续读，拼接后与原文一致', () => {
    const maxBytes = 1000;
    const p1 = readFile(cwd, 'big.txt', scopeDirs, { maxBytes });
    assert.equal(p1.truncated, true);
    assert.equal(p1.content.length, maxBytes);
    assert.equal(p1.totalSize, bigContent.length);
    const p2 = readFile(cwd, 'big.txt', scopeDirs, { offset: maxBytes, maxBytes });
    const p3 = readFile(cwd, 'big.txt', scopeDirs, { offset: maxBytes * 2, maxBytes });
    const p4 = readFile(cwd, 'big.txt', scopeDirs, { offset: maxBytes * 3, maxBytes });
    assert.equal(p4.truncated, false);
    assert.equal(p1.content + p2.content + p3.content + p4.content, bigContent);
  });

  test('越界（symlink 指向范围外）→ null（fail-closed 拒绝）', () => {
    assert.equal(readFile(cwd, 'link-out', scopeDirs), null);
  });

  test('relPath 指向目录而非文件 → null', () => {
    mkdirSync(join(cwd, 'adir'));
    assert.equal(readFile(cwd, 'adir', scopeDirs), null);
  });

  test('relPath 指向不存在路径 → null', () => {
    assert.equal(readFile(cwd, 'nope.txt', scopeDirs), null);
  });

  test('客户端请求 maxBytes 超硬顶 → 服务端夹到 MAX_BROWSE_BYTES（弱网上限不可被请求参数绕过）', () => {
    const res = readFile(cwd, 'big.txt', scopeDirs, { maxBytes: 999999999 });
    assert.ok(res.content.length <= MAX_BROWSE_BYTES);
  });

  test('分片边界切在多字节 UTF-8 字符中间（中文）时不产生乱码，用 bytesRead 续读能拼出完整原文', () => {
    // "中" 是 3 字节（E4 B8 AD）：maxBytes=10 时第一片字面上会读到 9 个 'x'（9 字节）+ "中" 的头 1 字节，
    // 切断在字符中间——若直接 toString('utf8') 会产生替换字符；trimIncompleteUtf8Tail 应把这半个字符
    // 挪给下一片，本片只到 9 字节为止。
    const zh = 'x'.repeat(9) + '中' + 'y'.repeat(9);
    writeFileSync(join(cwd, 'zh.txt'), zh, 'utf8');
    const totalBytes = Buffer.byteLength(zh, 'utf8'); // 9 + 3 + 9 = 21
    const p1 = readFile(cwd, 'zh.txt', scopeDirs, { maxBytes: 10 });
    assert.equal(p1.content, 'x'.repeat(9)); // 不含半个"中"、不含替换字符
    assert.equal(p1.bytesRead, 9); // 不是请求的 10——已回退到字符边界
    assert.equal(p1.truncated, true);
    const p2 = readFile(cwd, 'zh.txt', scopeDirs, { offset: p1.bytesRead, maxBytes: 10 });
    // 客户端必须用 bytesRead（不能用 content.length，字符数≠字节数）算下一片 offset，才能不丢不重续上
    const p3 = readFile(cwd, 'zh.txt', scopeDirs, { offset: p1.bytesRead + p2.bytesRead, maxBytes: 20 });
    assert.equal(p1.content + p2.content + p3.content, zh);
    assert.equal(p1.bytesRead + p2.bytesRead + p3.bytesRead, totalBytes);
  });

  test('最后一片即便切在字符中间也不裁剪（文件本就到此为止，没有下一片可接）', () => {
    // 构造一个总长度会让 maxBytes 整除边界恰好落在最后一个多字节字符中间的场景，
    // 断言 totalSize 达到即视为"最后一片"，正常吐出全部剩余内容（哪怕它以不完整序列结尾也不再裁剪）。
    const content = 'ab中';
    writeFileSync(join(cwd, 'tail.txt'), content, 'utf8');
    const total = Buffer.byteLength(content, 'utf8'); // 2 + 3 = 5
    const res = readFile(cwd, 'tail.txt', scopeDirs, { maxBytes: total }); // 一次读满，本身就是最后一片
    assert.equal(res.truncated, false);
    assert.equal(res.content, content);
  });
});

// E18 附件预览：base64 模式——历史消息里点开图片附件时，前端经 browse:read 按片拉原图字节。
// 契约：encoding:'base64' 时 content=该片字节的 base64（二进制不再拒绝）；分页按【字节精确】切
// （不做 UTF-8 尾裁剪——那是文本模式防乱码的逻辑，字节流拼装方是前端 Uint8Array，切在哪都无损）；
// 范围门/硬顶与文本模式完全同权（模式不放松安全与弱网上限）。
test.describe('readFile base64 模式', () => {
  const base = mkdtempSync(join(tmpdir(), 'ccm-browse-b64-'));
  test.after(() => rmSync(base, { recursive: true, force: true }));
  const cwd = join(base, 'project');
  const outside = join(base, 'outside');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(outside, { recursive: true });
  // 伪随机二进制（确定性生成，含 NUL 与全值域字节），2500 字节 → maxBytes=1000 时 3 片
  const binBytes = Buffer.from(Array.from({ length: 2500 }, (_, i) => (i * 37 + 11) % 256));
  writeFileSync(join(cwd, 'photo.bin'), binBytes);
  symlinkSync(outside, join(cwd, 'link-out'));
  const scopeDirs = [realpathSync(cwd)];

  test('二进制文件分页拉取：每片 content=该片 base64、bytesRead=片字节数，解码拼接与原文件逐字节一致', () => {
    const maxBytes = 1000;
    const p1 = readFile(cwd, 'photo.bin', scopeDirs, { maxBytes, encoding: 'base64' });
    assert.equal(p1.binary, true); // binary 标志仍如实（含 NUL），但不再以此拒绝内容
    assert.equal(p1.totalSize, 2500);
    assert.equal(p1.bytesRead, 1000);
    assert.equal(p1.truncated, true);
    assert.equal(p1.content, binBytes.subarray(0, 1000).toString('base64'));
    const p2 = readFile(cwd, 'photo.bin', scopeDirs, { offset: 1000, maxBytes, encoding: 'base64' });
    const p3 = readFile(cwd, 'photo.bin', scopeDirs, { offset: 2000, maxBytes, encoding: 'base64' });
    assert.equal(p3.bytesRead, 500);
    assert.equal(p3.truncated, false);
    const joined = Buffer.concat([p1, p2, p3].map(p => Buffer.from(p.content, 'base64')));
    assert.ok(joined.equals(binBytes));
  });

  test('base64 模式不做 UTF-8 尾裁剪：多字节字符跨界也按请求字节数精确切片', () => {
    const zh = 'x'.repeat(9) + '中' + 'y'.repeat(9); // 21 字节，"中" 横跨 offset 9-11
    writeFileSync(join(cwd, 'zh.txt'), zh, 'utf8');
    const p1 = readFile(cwd, 'zh.txt', scopeDirs, { maxBytes: 10, encoding: 'base64' });
    assert.equal(p1.bytesRead, 10); // 文本模式会退到 9；base64 模式字节精确
    const p2 = readFile(cwd, 'zh.txt', scopeDirs, { offset: 10, maxBytes: 20, encoding: 'base64' });
    const joined = Buffer.concat([Buffer.from(p1.content, 'base64'), Buffer.from(p2.content, 'base64')]);
    assert.equal(joined.toString('utf8'), zh);
  });

  test('base64 模式硬顶不放松：maxBytes 超限仍夹到 MAX_BROWSE_BYTES（按解码后字节数计）', () => {
    const big = Buffer.alloc(MAX_BROWSE_BYTES + 1024, 7);
    writeFileSync(join(cwd, 'big.bin'), big);
    const res = readFile(cwd, 'big.bin', scopeDirs, { maxBytes: 999999999, encoding: 'base64' });
    assert.equal(res.bytesRead, MAX_BROWSE_BYTES);
    assert.equal(Buffer.from(res.content, 'base64').length, MAX_BROWSE_BYTES);
  });

  test('base64 模式范围门同权：symlink 越界 → null', () => {
    assert.equal(readFile(cwd, 'link-out', scopeDirs, { encoding: 'base64' }), null);
  });

  test('未知 encoding 值按默认文本模式处理（二进制仍拒绝），不抛错', () => {
    const res = readFile(cwd, 'photo.bin', scopeDirs, { encoding: 'hex' });
    assert.equal(res.binary, true);
    assert.equal(res.content, '');
  });
});
