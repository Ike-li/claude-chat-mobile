// tests/unit/shared-data-dir.test.mjs —— data-dir.js 单测（运行时状态根 CCM_DATA_DIR 的唯一解析点）。
// 关键不变量：解析必须发生在【调用期】而非模块求值期——app/src/ops/config.js 在 .env 加载之前就被
// import，模块顶层读 env 会读到加载前的空环境，导致 CCM_DATA_DIR 静默失效、状态写回仓库 data/。
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDataDir, dataFile } from '../../app/src/shared/data-dir.js';

// 仓库根从本文件位置推导（tests/unit → ../..），不得硬编码检出目录名：本仓库常驻多个 worktree
// （../claude-chat-mobile-<分支名>），写死名字的断言换个检出位就红——首版就是这么红在 dev 上的。
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url)).replace(/[/\\]$/, '');

test.describe('data-dir.js', () => {
  test('resolveDataDir：设了 CCM_DATA_DIR 就用它', () => {
    assert.equal(resolveDataDir({ CCM_DATA_DIR: '/external/ccm-data' }), '/external/ccm-data');
  });

  test('resolveDataDir：未设 CCM_DATA_DIR 回落项目根下的 data/', () => {
    assert.equal(resolveDataDir({}, '/repo'), join('/repo', 'data'));
  });

  test('resolveDataDir：空串等同未设置（同 config.js 的 normalize 口径）', () => {
    assert.equal(resolveDataDir({ CCM_DATA_DIR: '' }, '/repo'), join('/repo', 'data'));
  });

  test('resolveDataDir：projectRoot 可注入，保持 parseServerConfig 的纯函数可测性', () => {
    assert.equal(resolveDataDir({}, '/another'), join('/another', 'data'));
  });

  test('dataFile：把文件名挂到解析出的状态根上', () => {
    assert.equal(dataFile('sessions.json', { CCM_DATA_DIR: '/tmp/ccm' }), join('/tmp/ccm', 'sessions.json'));
  });

  test('调用期而非模块期读 env：import 之后再改 process.env 仍然生效', () => {
    const original = process.env.CCM_DATA_DIR;
    try {
      process.env.CCM_DATA_DIR = '/late/bound';
      assert.equal(resolveDataDir(), '/late/bound');
      assert.equal(dataFile('audit-records.json'), join('/late/bound', 'audit-records.json'));
      process.env.CCM_DATA_DIR = '/changed/again';
      assert.equal(resolveDataDir(), '/changed/again');
    } finally {
      if (original === undefined) delete process.env.CCM_DATA_DIR;
      else process.env.CCM_DATA_DIR = original;
    }
  });

  test('默认 projectRoot 是仓库根（data/ 就在其下），不是模块自身所在的 app/src/shared/', () => {
    assert.equal(resolveDataDir({}), join(REPO_ROOT, 'data'));
    assert.equal(dataFile('sessions.json', {}), join(REPO_ROOT, 'data', 'sessions.json'));
  });
});
