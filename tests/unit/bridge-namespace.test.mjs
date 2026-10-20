// tests/unit/bridge-namespace.test.mjs —— 卸载桥时的递归删除只落在 <绝对 home>/.claude/ccm/<桥> 下
//
// home 由调用方注入（生产是 os.homedir()）。HOME 被设成空串时 os.homedir() 原样返回 ""，
// join('', '.claude', 'ccm', 'hooks-v1') 就成了相对**当前目录**的路径——递归删除打到别处。
// 删除点自己守住：home 不是绝对路径就抛，什么都不删。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeBridgeNamespace } from '../../app/src/ops/bridge-namespace.js';

test('home 不是绝对路径（空串 / 相对路径）：抛错，当前目录下同名的东西一个不动', () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-bridge-ns-'));
  const prev = process.cwd();
  try {
    const victim = join(root, '.claude', 'ccm', 'hooks-v1');
    mkdirSync(victim, { recursive: true });
    writeFileSync(join(victim, 'keep.txt'), 'x');
    process.chdir(root);
    for (const home of ['', '.', 'relative/home']) {
      assert.throws(() => removeBridgeNamespace(home, 'hooks-v1'), /absolute/, `home=${JSON.stringify(home)} 没被拦下`);
    }
    assert.equal(existsSync(join(victim, 'keep.txt')), true, '相对路径的递归删除打到了当前目录');
  } finally {
    process.chdir(prev);
    rmSync(root, { recursive: true, force: true });
  }
});

test('绝对 home：删掉本桥目录；ccm 空了一并移除，另一座桥在就留着', () => {
  const home = mkdtempSync(join(tmpdir(), 'ccm-bridge-ns-home-'));
  try {
    const ccm = join(home, '.claude', 'ccm');
    mkdirSync(join(ccm, 'hooks-v1', 'events'), { recursive: true });
    mkdirSync(join(ccm, 'statusline-v1'), { recursive: true });
    removeBridgeNamespace(home, 'hooks-v1');
    assert.equal(existsSync(join(ccm, 'hooks-v1')), false);
    assert.equal(existsSync(join(ccm, 'statusline-v1')), true, '另一座桥的目录不能连带删');
    removeBridgeNamespace(home, 'statusline-v1');
    assert.equal(existsSync(ccm), false);
    assert.equal(existsSync(join(home, '.claude')), true, '~/.claude 本身不归我们管');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
