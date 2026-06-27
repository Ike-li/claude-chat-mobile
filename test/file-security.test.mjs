// test/file-security.test.mjs —— file-security.js 安全关键路径单测
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, writeFile, chmod, stat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { constants } from 'node:fs';
import { platform } from 'node:os';
import {
  rejectableSymlinkComponent, writeOwnerOnlyFile, isOwnerOnly, fixPermissions, checkPermissions
} from '../file-security.js';

const isWindows = platform() === 'win32';

test.describe('rejectableSymlinkComponent', () => {
  test('普通路径 → null', () => {
    assert.equal(rejectableSymlinkComponent('/tmp/nonexistent-path'), null);
    assert.equal(rejectableSymlinkComponent('/usr/bin'), null);
  });

  test('不存在的路径 → null', () => {
    assert.equal(rejectableSymlinkComponent('/nonexistent/deep/path'), null);
  });
});

test.describe('writeOwnerOnlyFile', () => {
  let tmpDir;
  test.beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'ccm-fs-test-'));
  });
  test.afterEach(async () => {
    try { await rm(tmpDir, { recursive: true, force: true }); } catch {}
  });

  test('写入并读回内容', async () => {
    if (isWindows) return test.skip('POSIX-only owner permissions');
    const filePath = join(tmpDir, 'test.json');
    const data = JSON.stringify({ key: 'value' });
    writeOwnerOnlyFile(filePath, data); // sync function
    const content = await readFile(filePath, 'utf8');
    assert.equal(content, data);
  });

  test('文件权限为 0600（owner-only）', async () => {
    if (isWindows) return test.skip('POSIX-only owner permissions');
    const filePath = join(tmpDir, 'perm-test.json');
    writeOwnerOnlyFile(filePath, 'data');
    const s = await stat(filePath);
    // 0600 = owner read+write only
    assert.equal(s.mode & 0o777, 0o600);
  });
});

test.describe('isOwnerOnly / fixPermissions / checkPermissions', () => {
  let tmpDir;
  test.beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'ccm-fs-test-'));
  });
  test.afterEach(async () => {
    try { await rm(tmpDir, { recursive: true, force: true }); } catch {}
  });

  test('isOwnerOnly：0600 文件 → true', async () => {
    if (isWindows) return test.skip('POSIX-only');
    const filePath = join(tmpDir, 'private.txt');
    await writeFile(filePath, 'secret');
    await chmod(filePath, 0o600);
    assert.equal(isOwnerOnly(filePath), true);
  });

  test('isOwnerOnly：0644 文件 → false', async () => {
    if (isWindows) return test.skip('POSIX-only');
    const filePath = join(tmpDir, 'public.txt');
    await writeFile(filePath, 'data');
    await chmod(filePath, 0o644);
    assert.equal(isOwnerOnly(filePath), false);
  });

  test('fixPermissions：修复为 0600', async () => {
    if (isWindows) return test.skip('POSIX-only');
    const filePath = join(tmpDir, 'fixme.txt');
    await writeFile(filePath, 'data');
    await chmod(filePath, 0o644);
    fixPermissions(filePath);
    assert.equal(isOwnerOnly(filePath), true);
  });

  test('checkPermissions：不存在的路径 → 空数组（静默跳过）', () => {
    const result = checkPermissions([join(tmpDir, 'no-such-file')]);
    assert.deepEqual(result, []);
  });
});
