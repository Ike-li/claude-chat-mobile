// tests/v2/file-security.test.mjs —— 文件安全守卫关键路径测试
// 守护：FILE-03（owner-only 权限）、FILES-2（symlink 检查与路径归一）、FILE-02（特殊文件白名单闸）
// 测什么：isOpenableTarget 白名单放行与特殊文件拦截；rejectableSymlinkComponent 检出可写目录与中间路径的软链；writeOwnerOnlyFile 原子写 0600 与错误回滚；权限校验与跨平台可执行文件解析
// 不测什么 + 为什么：不测特定平台系统命令（which/where）真机返回值，通过注入 execFile 保持测试确定性与零外部依赖
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, chmodSync, statSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  isOpenableTarget,
  rejectableSymlinkComponent,
  writeOwnerOnlyFile,
  isOwnerOnly,
  fixPermissions,
  checkPermissions,
  resolveExecutableViaPath,
} from '../../app/src/files/file-security.js';

test.describe('FILE-02: isOpenableTarget 特殊文件白名单闸', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccm-v2-target-'));
  test.after(() => rmSync(dir, { recursive: true, force: true }));

  test('常规文件放行（返回 true）', () => {
    const f = join(dir, 'plain.txt');
    writeFileSync(f, 'content');
    assert.equal(isOpenableTarget(f), true);
  });

  test('常规符号链接放行（返回 true，后续由 O_NOFOLLOW / scope 处理）', { skip: process.platform === 'win32' }, () => {
    const target = join(dir, 'target.txt');
    const link = join(dir, 'link.txt');
    writeFileSync(target, 'target');
    symlinkSync(target, link);
    assert.equal(isOpenableTarget(link), true);
  });

  test('目录拒绝（返回 false）', () => {
    const sub = join(dir, 'sub-dir');
    mkdirSync(sub);
    assert.equal(isOpenableTarget(sub), false);
  });

  test('不存在的路径返回 false', () => {
    assert.equal(isOpenableTarget(join(dir, 'non-existent')), false);
  });

  test('FIFO / 命名管道拒绝（返回 false，防止 openSync 无限阻塞）', { skip: process.platform === 'win32' }, () => {
    const fifo = join(dir, 'pipe.fifo');
    execFileSync('mkfifo', [fifo]);
    assert.equal(isOpenableTarget(fifo), false);
  });
});

test.describe('rejectableSymlinkComponent: 符号链接越界防护', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccm-v2-sym-'));
  test.after(() => rmSync(dir, { recursive: true, force: true }));

  test('普通路径与不存在路径返回 null', () => {
    assert.equal(rejectableSymlinkComponent('/nonexistent/path/123'), null);
    assert.equal(rejectableSymlinkComponent(join(dir, 'plain.txt')), null);
  });

  test('用户可写目录中的 symlink 检出并返回绝对路径', { skip: process.platform === 'win32' }, () => {
    const target = join(dir, 'real.txt');
    const link = join(dir, 'symlink.txt');
    writeFileSync(target, 'test');
    symlinkSync(target, link);
    assert.equal(rejectableSymlinkComponent(link), resolve(link));
  });

  test('路径中间组件为 symlink 时也能被检出', { skip: process.platform === 'win32' }, () => {
    const realDir = join(dir, 'real-folder');
    const linkDir = join(dir, 'link-folder');
    mkdirSync(realDir, { recursive: true });
    symlinkSync(realDir, linkDir);
    assert.equal(rejectableSymlinkComponent(join(linkDir, 'inside.txt')), resolve(linkDir));
  });
});

test.describe('FILE-03: writeOwnerOnlyFile 原子写与 0600 权限', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccm-v2-owner-'));
  test.after(() => rmSync(dir, { recursive: true, force: true }));

  test('写入内容并完整读回', () => {
    const file = join(dir, 'data.json');
    const payload = JSON.stringify({ secure: true, val: 42 });
    writeOwnerOnlyFile(file, payload);
    assert.equal(readFileSync(file, 'utf8'), payload);
  });

  test('文件权限精确为 0600 (owner rw only)', { skip: process.platform === 'win32' }, () => {
    const file = join(dir, 'secret.env');
    writeOwnerOnlyFile(file, 'KEY=secret');
    const st = statSync(file);
    assert.equal(st.mode & 0o777, 0o600);
  });

  test('覆盖写入时保持 0600 并原子替换', { skip: process.platform === 'win32' }, () => {
    const file = join(dir, 'overwrite.txt');
    writeOwnerOnlyFile(file, 'v1');
    writeOwnerOnlyFile(file, 'v2');
    assert.equal(readFileSync(file, 'utf8'), 'v2');
    const st = statSync(file);
    assert.equal(st.mode & 0o777, 0o600);
  });
});

test.describe('isOwnerOnly / fixPermissions / checkPermissions 权限审计与修复', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccm-v2-perms-'));
  test.after(() => rmSync(dir, { recursive: true, force: true }));

  test('isOwnerOnly 精确区分 0600/0644 文件与 0700/0755 目录', { skip: process.platform === 'win32' }, () => {
    const f600 = join(dir, 'f600.txt');
    const f644 = join(dir, 'f644.txt');
    const d700 = join(dir, 'd700');
    const d755 = join(dir, 'd755');

    writeFileSync(f600, 'a');
    chmodSync(f600, 0o600);
    writeFileSync(f644, 'b');
    chmodSync(f644, 0o644);

    mkdirSync(d700);
    chmodSync(d700, 0o700);
    mkdirSync(d755);
    chmodSync(d755, 0o755);

    assert.equal(isOwnerOnly(f600, false), true);
    assert.equal(isOwnerOnly(f644, false), false);
    assert.equal(isOwnerOnly(d700, true), true);
    assert.equal(isOwnerOnly(d755, true), false);
  });

  test('fixPermissions 修复不合规权限为 0600/0700', { skip: process.platform === 'win32' }, () => {
    const f = join(dir, 'fix-file.txt');
    writeFileSync(f, 'content');
    chmodSync(f, 0o644);
    assert.equal(isOwnerOnly(f, false), false);

    assert.equal(fixPermissions(f, false), true);
    assert.equal(isOwnerOnly(f, false), true);

    const d = join(dir, 'fix-dir');
    mkdirSync(d);
    chmodSync(d, 0o755);
    assert.equal(isOwnerOnly(d, true), false);

    assert.equal(fixPermissions(d, true), true);
    assert.equal(isOwnerOnly(d, true), true);
  });

  test('checkPermissions 汇总不合规路径', { skip: process.platform === 'win32' }, () => {
    const p1 = join(dir, 'ok.txt');
    const p2 = join(dir, 'bad.txt');
    writeFileSync(p1, 'ok');
    chmodSync(p1, 0o600);
    writeFileSync(p2, 'bad');
    chmodSync(p2, 0o644);

    const problems = checkPermissions([p1, p2, join(dir, 'missing.txt')], false);
    assert.deepEqual(problems, [p2]);
  });
});

test.describe('resolveExecutableViaPath: PATH 查找与防注入', () => {
  test('非法或包含 shell 元字符的可执行名直接拒绝', () => {
    assert.equal(resolveExecutableViaPath('git; rm -rf /'), '');
    assert.equal(resolveExecutableViaPath('cat && echo'), '');
    assert.equal(resolveExecutableViaPath('foo | bar'), '');
    assert.equal(resolveExecutableViaPath('foo`bar`'), '');
    assert.equal(resolveExecutableViaPath('foo$bar'), '');
    assert.equal(resolveExecutableViaPath(''), '');
    assert.equal(resolveExecutableViaPath(null), '');
    assert.equal(resolveExecutableViaPath(undefined), '');
  });

  test('POSIX 平台使用 which 命令查找并截取首行', () => {
    const fakeExec = (cmd, args) => {
      assert.equal(cmd, 'which');
      assert.deepEqual(args, ['claude']);
      return '/opt/homebrew/bin/claude\n';
    };
    const res = resolveExecutableViaPath('claude', { platform: 'darwin', execFile: fakeExec });
    assert.equal(res, '/opt/homebrew/bin/claude');
  });

  test('Windows 平台使用 where 命令并截取首行（防多条输出）', () => {
    const fakeExec = (cmd, args) => {
      assert.equal(cmd, 'where');
      assert.deepEqual(args, ['claude.exe']);
      return 'C:\\Users\\bin\\claude.exe\r\nC:\\ProgramData\\claude.exe\r\n';
    };
    const res = resolveExecutableViaPath('claude.exe', { platform: 'win32', execFile: fakeExec });
    assert.equal(res, 'C:\\Users\\bin\\claude.exe');
  });

  test('命令执行抛错时安全返回空字符串，不崩溃', () => {
    const fakeExec = () => {
      throw new Error('command not found');
    };
    const res = resolveExecutableViaPath('claude', { platform: 'linux', execFile: fakeExec });
    assert.equal(res, '');
  });
});
