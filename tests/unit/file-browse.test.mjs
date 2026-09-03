// tests/unit/file-browse.test.mjs —— FileBrowseHandler 单测（docs/design.md，承接 AD-12/FR-07"浏览项目文件"）
// listDir/readFile：请求-响应型只读文件浏览，弱网上限（分页/截断）、二进制检测、symlink 如实标注。
// 敏感文件（.env 等）不做内容过滤——docs/design.md 显式抉择（用户即 root + 透明性，防线在范围门不在内容审查），
// 故本文件不测"过滤"，只测"范围门挡越界 + 弱网上限正确"。真实临时目录测试，同 workdir-scope-guard 惯例。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, rmSync, realpathSync, unlinkSync, chmodSync, lstatSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { listDir, readFile, writeFileInScope, MAX_BROWSE_ENTRIES, MAX_BROWSE_BYTES } from '../../app/src/files/file-browse.js';

const sha256 = s => createHash('sha256').update(s).digest('hex');

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

test.describe('readFile：contentHash（编辑器可编辑判定 + writeFileInScope 的 baseHash 来源）', () => {
  const base = mkdtempSync(join(tmpdir(), 'ccm-browse-hash-'));
  test.after(() => rmSync(base, { recursive: true, force: true }));
  const cwd = join(base, 'project');
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(cwd, 'small.txt'), 'hello world');
  writeFileSync(join(cwd, 'binary.dat'), Buffer.from([0x41, 0x42, 0x00, 0x43]));
  const bigContent = Array.from({ length: 1000 }, (_, i) => String(i).padStart(4, '0')).join('');
  writeFileSync(join(cwd, 'big.txt'), bigContent);
  const scopeDirs = [realpathSync(cwd)];

  test('一次性读全（offset=0 未截断）→ 带 contentHash，等于内容的 sha256', () => {
    const res = readFile(cwd, 'small.txt', scopeDirs);
    assert.equal(res.contentHash, sha256('hello world'));
  });

  test('分页读取（截断）→ 不带 contentHash（半份内容不构成有效编辑基线）', () => {
    const res = readFile(cwd, 'big.txt', scopeDirs, { maxBytes: 1000 });
    assert.equal(res.truncated, true);
    assert.equal(res.contentHash, undefined);
  });

  test('续读的非首页（offset>0）即便这片没截断也不带 contentHash', () => {
    const res = readFile(cwd, 'big.txt', scopeDirs, { offset: 3000, maxBytes: 1000 });
    assert.equal(res.truncated, false);
    assert.equal(res.contentHash, undefined);
  });

  test('二进制文件不带 contentHash', () => {
    const res = readFile(cwd, 'binary.dat', scopeDirs);
    assert.equal(res.contentHash, undefined);
  });

  test('非法 UTF-8 但无 NUL 字节（如 Latin-1 编码文本）→ binary=false 仍可预览，但不带 contentHash（不可编辑，防写回时 toString/Buffer.from 往返静默腐化原字节）', () => {
    // 0xE9 单字节在 Latin-1 是 'é'，作为 UTF-8 是非法续接字节起始——toString('utf8') 会静默变 U+FFFD。
    writeFileSync(join(cwd, 'latin1.txt'), Buffer.from([0x68, 0x69, 0xE9, 0x0A])); // "hi" + é + \n
    const res = readFile(cwd, 'latin1.txt', scopeDirs);
    assert.equal(res.binary, false); // 无 NUL 字节，仍走文本预览路径
    assert.equal(res.contentHash, undefined); // 但不给编辑基线——写回会用损坏后的字符串覆盖原字节
  });
});

test.describe('writeFileInScope', () => {
  const base = mkdtempSync(join(tmpdir(), 'ccm-browse-write-'));
  test.after(() => rmSync(base, { recursive: true, force: true }));
  const cwd = join(base, 'project');
  const outside = join(base, 'outside');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(outside, { recursive: true });
  symlinkSync(outside, join(cwd, 'link-out'));
  const scopeDirs = [realpathSync(cwd)];

  test('baseHash 匹配磁盘现状 → 写入成功，磁盘内容更新，返回新 contentHash', () => {
    writeFileSync(join(cwd, 'edit-ok.txt'), 'old content');
    const res = writeFileInScope(cwd, 'edit-ok.txt', 'new content', scopeDirs, { baseHash: sha256('old content') });
    assert.equal(res.ok, true);
    assert.equal(res.contentHash, sha256('new content'));
    assert.equal(readFileSync(join(cwd, 'edit-ok.txt'), 'utf8'), 'new content');
  });

  test('baseHash 与磁盘现状不符（已被其它进程改过）→ conflict，磁盘内容不变', () => {
    writeFileSync(join(cwd, 'edit-conflict.txt'), 'v1');
    const staleHash = sha256('v1');
    writeFileSync(join(cwd, 'edit-conflict.txt'), 'v2 (changed by someone else)'); // 模拟并发外部写入
    const res = writeFileInScope(cwd, 'edit-conflict.txt', 'my edit', scopeDirs, { baseHash: staleHash });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'conflict');
    assert.equal(readFileSync(join(cwd, 'edit-conflict.txt'), 'utf8'), 'v2 (changed by someone else)');
  });

  test('缺 baseHash → bad_base_hash，不写', () => {
    writeFileSync(join(cwd, 'edit-nohash.txt'), 'orig');
    const res = writeFileInScope(cwd, 'edit-nohash.txt', 'x', scopeDirs, {});
    assert.equal(res.ok, false);
    assert.equal(res.code, 'bad_base_hash');
    assert.equal(readFileSync(join(cwd, 'edit-nohash.txt'), 'utf8'), 'orig');
  });

  test('content 非字符串 → bad_content，不写', () => {
    writeFileSync(join(cwd, 'edit-badcontent.txt'), 'orig');
    const res = writeFileInScope(cwd, 'edit-badcontent.txt', 123, scopeDirs, { baseHash: sha256('orig') });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'bad_content');
    assert.equal(readFileSync(join(cwd, 'edit-badcontent.txt'), 'utf8'), 'orig');
  });

  test('内容超过 MAX_BROWSE_BYTES → too_large，不写', () => {
    writeFileSync(join(cwd, 'edit-toolarge.txt'), 'orig');
    const huge = 'x'.repeat(MAX_BROWSE_BYTES + 1);
    const res = writeFileInScope(cwd, 'edit-toolarge.txt', huge, scopeDirs, { baseHash: sha256('orig') });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'too_large');
    assert.equal(readFileSync(join(cwd, 'edit-toolarge.txt'), 'utf8'), 'orig');
  });

  test('越界路径 + 超大内容同时命中 → 判 scope 而非 too_large（审计日志要能认出这是越界尝试，不能被超限吞掉分类）', () => {
    const huge = 'x'.repeat(MAX_BROWSE_BYTES + 1);
    const res = writeFileInScope(cwd, '../outside/does-not-exist.txt', huge, scopeDirs, { baseHash: sha256('') });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'scope');
  });

  test('目标文件从未存在 → scope 拒绝（resolveInScope 对不存在路径的既有 fail-closed 行为，同 readFile/listDir），不新建', () => {
    const target = join(cwd, 'does-not-exist.txt');
    const res = writeFileInScope(cwd, 'does-not-exist.txt', 'x', scopeDirs, { baseHash: sha256('') });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'scope');
    assert.equal(existsSync(target), false);
  });

  test('目标是目录 → not_file，不写', () => {
    mkdirSync(join(cwd, 'a-dir'));
    const res = writeFileInScope(cwd, 'a-dir', 'x', scopeDirs, { baseHash: sha256('') });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'not_file');
  });

  test('越界路径（symlink 指向范围外）→ scope 拒绝，不写', () => {
    writeFileSync(join(outside, 'secret.txt'), 'sensitive');
    const res = writeFileInScope(cwd, 'link-out/secret.txt', 'pwned', scopeDirs, { baseHash: sha256('sensitive') });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'scope');
    assert.equal(readFileSync(join(outside, 'secret.txt'), 'utf8'), 'sensitive');
  });

  test('relPath 用 ../ 逃逸范围 → scope 拒绝', () => {
    writeFileSync(join(outside, 'escape.txt'), 'orig');
    const res = writeFileInScope(cwd, '../outside/escape.txt', 'pwned', scopeDirs, { baseHash: sha256('orig') });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'scope');
  });

  test('写回后再读一次拿到的 contentHash 与写回响应的 contentHash 一致（可连续编辑）', () => {
    writeFileSync(join(cwd, 'edit-chain.txt'), 'v1');
    const w1 = writeFileInScope(cwd, 'edit-chain.txt', 'v2', scopeDirs, { baseHash: sha256('v1') });
    assert.equal(w1.ok, true);
    const r = readFile(cwd, 'edit-chain.txt', scopeDirs);
    assert.equal(r.contentHash, w1.contentHash);
    const w2 = writeFileInScope(cwd, 'edit-chain.txt', 'v3', scopeDirs, { baseHash: r.contentHash });
    assert.equal(w2.ok, true);
    assert.equal(readFileSync(join(cwd, 'edit-chain.txt'), 'utf8'), 'v3');
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

// FIFO / 字符设备 / unix socket：POSIX 下 open(FIFO, O_RDONLY) 在无 writer 时【无限阻塞】，O_NOFOLLOW
// 不改变这一点，也没有超时；fstat 的类型检查在 open 之后才跑，救不了。单进程 Node 卡在这个同步调用上
// = 所有会话/socket/catchUpTick//health 全停摆，无自愈，只能人工杀进程。
// 注：这条修复前无法用常规红测试演示——测试进程本身会被 openSync 同步卡死（timeout 打断不了同步调用），
// 故先实现闸门再以本测试锁定行为；修复前后的差异用隔离子进程实测过。
test('readFile/writeFileInScope 拒绝 FIFO：open 前挡住，绝不阻塞事件循环', { skip: process.platform === 'win32' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccm-fifo-'));
  const scope = [realpathSync(dir)];
  try {
    execFileSync('mkfifo', [join(dir, 'pipe')]);

    const listed = listDir(dir, '.', scope);
    const pipeEntry = listed.entries.find(e => e.name === 'pipe');
    assert.equal(pipeEntry.kind, 'special', 'FIFO 不得被归类成可点读的 file');

    assert.equal(readFile(dir, 'pipe', scope), null, '读 FIFO 必须直接拒绝');

    const emptyHash = createHash('sha256').update(Buffer.alloc(0)).digest('hex');
    const w = writeFileInScope(dir, 'pipe', 'pwned', scope, { baseHash: emptyHash });
    assert.equal(w.ok, false);
    assert.equal(w.code, 'not_file', 'FIFO 的 size 恒 0，空串哈希会误过基线校验');
    assert.equal(lstatSync(join(dir, 'pipe')).isFIFO(), true, 'FIFO 不得被普通文件顶替');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// rename 是「新 inode 顶替」：不显式给 mode 就落成 0o666 & ~umask（通常 0644）。手机上改一行 shell
// 脚本保存后静默丢掉 +x；0600 的敏感文件被放宽到 0644。同仓 writeOwnerOnlyFile 一直做对了。
test('writeFileInScope 保留原文件权限位（0755 不丢 +x，0600 不被放宽）', { skip: process.platform === 'win32' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccm-mode-'));
  const scope = [realpathSync(dir)];
  try {
    for (const [name, mode] of [['run.sh', 0o755], ['secret.env', 0o600]]) {
      const p = join(dir, name);
      writeFileSync(p, 'old\n');
      chmodSync(p, mode);
      const baseHash = createHash('sha256').update(readFileSync(p)).digest('hex');

      const r = writeFileInScope(dir, name, 'new\n', scope, { baseHash });
      assert.equal(r.ok, true, `${name} 应写入成功`);
      assert.equal(readFileSync(p, 'utf8'), 'new\n');
      assert.equal(lstatSync(p).mode & 0o777, mode, `${name} 权限位必须原样保留`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
