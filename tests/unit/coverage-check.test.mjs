import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { unitTestFiles, findUnloadedProductionFiles } from '../../scripts/coverage-check.js';

test('coverage check expands unit test files without relying on shell globs', () => {
  const files = unitTestFiles();

  assert.ok(files.length > 1);
  assert.ok(files.every(file => file.startsWith('tests/unit/') && file.endsWith('.test.mjs')));
  assert.ok(files.includes('tests/unit/agent-core.test.mjs'));
  assert.ok(files.includes('tests/unit/agent-permissions.test.mjs'));
  assert.ok(!files.includes('tests/unit/agent.test.mjs'));
});

// ── 2026-08-02：门槛与「分母缺口」可见性 ────────────────────────────────────
// 此前门槛 65%、实测 77%，中间 12 个点的空隙——真退化了也一路绿灯；注释还写着「实际约 66%，
// 留 ~1% 缓冲」，早已陈旧。更要命的是那个百分比的分母只含【被加载过的文件】，从未 import 的
// 生产文件是 0% 却完全不拉低数字，于是「达标」会被读成「整体安全」。

test('默认门槛贴近实测（缓冲不超过 5 个点，防再次拉开 12 点空隙）', () => {
  const source = readFileSync(new URL('../../scripts/coverage-check.js', import.meta.url), 'utf8');
  const declared = source.match(/\|\| '(\d+(?:\.\d+)?)'\)/);
  assert.ok(declared, '默认门槛应写在 --threshold 的回退值里');
  const threshold = parseFloat(declared[1]);
  assert.ok(threshold >= 70 && threshold <= 80, `门槛 ${threshold}% 偏离 2026-08-02 实测的 ~77.5%，请连同注释一起更新`);
});

test('findUnloadedProductionFiles：报告里出现过的文件不算缺口，没出现的按 0% 挑出来', () => {
  const report = [
    'ℹ src                       |        |          |         | ',
    'ℹ  agent.js                 |  95.66 |    87.28 |   92.24 | 358-374',
    'ℹ all files                 |  77.51 |    81.91 |   74.22 | ',
  ].join('\n');
  const listFiles = (_root, dir) => (dir === 'src' ? ['src/agent.js', 'src/never-loaded.js'] : []);

  const unloaded = findUnloadedProductionFiles(report, '/fake', listFiles);

  assert.deepEqual(unloaded, ['src/never-loaded.js'], '只有报告里没出现过的才算缺口');
});

test('findUnloadedProductionFiles：全部加载过时返回空（不制造假缺口）', () => {
  const report = 'ℹ  a.js | 100.00 | 100.00 | 100.00 |\nℹ  b.js |  50.00 |  50.00 |  50.00 |';
  const listFiles = (_root, dir) => (dir === 'src' ? ['src/a.js', 'src/nested/b.js'] : []);

  assert.deepEqual(findUnloadedProductionFiles(report, '/fake', listFiles), []);
});

test('缺口扫描真的接进主流程并会打印（算了不说等于没算）', () => {
  const source = readFileSync(new URL('../../scripts/coverage-check.js', import.meta.url), 'utf8');
  assert.match(source, /findUnloadedProductionFiles\(stdout\)/, '主流程必须真的调用缺口扫描');
  assert.match(source, /从未被任何单测加载/, '缺口必须打印出来，不能只算不说');
});
