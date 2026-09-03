import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { unitTestFiles, findUnloadedProductionFiles, summarizeCoverageGap } from '../../tests/gates/coverage-check.js';

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
  const source = readFileSync(new URL('../../tests/gates/coverage-check.js', import.meta.url), 'utf8');
  const declared = source.match(/\|\| '(\d+(?:\.\d+)?)'\)/);
  assert.ok(declared, '默认门槛应写在 --threshold 的回退值里');
  const threshold = parseFloat(declared[1]);
  assert.ok(threshold >= 70 && threshold <= 80, `门槛 ${threshold}% 偏离 2026-08-02 实测的 ~77.5%，请连同注释一起更新`);
});

test('findUnloadedProductionFiles：报告里出现过的文件不算缺口，没出现的按 0% 挑出来', () => {
  const report = [
    'ℹ app                       |        |          |         | ',
    'ℹ  src                      |        |          |         | ',
    'ℹ   agent.js                |  95.66 |    87.28 |   92.24 | 358-374',
    'ℹ all files                 |  77.51 |    81.91 |   74.22 | ',
  ].join('\n');
  const listFiles = (_root, dir) => (dir === 'app/src' ? ['app/src/agent.js', 'app/src/never-loaded.js'] : []);

  const unloaded = findUnloadedProductionFiles(report, '/fake', listFiles);

  assert.deepEqual(unloaded, ['app/src/never-loaded.js'], '只有报告里没出现过的才算缺口');
});

test('findUnloadedProductionFiles：全部加载过时返回空（不制造假缺口）', () => {
  const report = [
    'ℹ app                       |        |          |         | ',
    'ℹ  src                      |        |          |         | ',
    'ℹ   a.js                    | 100.00 |   100.00 |  100.00 | ',
    'ℹ   nested                  |        |          |         | ',
    'ℹ    b.js                   |  50.00 |    50.00 |   50.00 | 3',
  ].join('\n');
  const listFiles = (_root, dir) => (dir === 'app/src' ? ['app/src/a.js', 'app/src/nested/b.js'] : []);

  assert.deepEqual(findUnloadedProductionFiles(report, '/fake', listFiles), []);
});

// 报告是目录树、叶子行只有 basename。按 basename 判「加载过没有」会让同名文件互相顶替：
// app/src/server/app.js 一旦有了首个单测，app/public/js/app.js（全仓最大的 0% 覆盖文件）就会从缺口
// 名单里静默消失——而这个函数存在的唯一理由就是"别把漂亮的百分比读成安全"。
test('findUnloadedProductionFiles：同名文件不互相顶替（只加载了一个 app.js，另一个仍算缺口）', () => {
  const report = [
    'ℹ src                       |        |          |         | ',
    'ℹ  server                   |        |          |         | ',
    'ℹ   app.js                  |  20.00 |    20.00 |   20.00 | 7',
    'ℹ all files                 |  20.00 |    20.00 |   20.00 | ',
  ].join('\n');
  const listFiles = (_root, dir) => ({
    src: ['app/src/server/app.js'],
    'app/public/js': ['app/public/js/app.js'],
  }[dir] ?? []);

  assert.deepEqual(
    findUnloadedProductionFiles(report, '/fake', listFiles),
    ['app/public/js/app.js'],
    'app/src/server/app.js 被加载过，不该把同名的 app/public/js/app.js 一起算成已加载',
  );
});

test('缺口扫描真的接进主流程并会打印（算了不说等于没算）', () => {
  const source = readFileSync(new URL('../../tests/gates/coverage-check.js', import.meta.url), 'utf8');
  assert.match(source, /summarizeCoverageGap\(stdout\)/, '主流程必须真的调用缺口扫描');
  assert.match(source, /从未被任何单测加载/, '缺口必须打印出来，不能只算不说');
  assert.match(source, /覆盖面: 分母含/, '覆盖面是那个百分比的限定条件，必须恒打印');
});

// 只列文件名不够：「12 个文件没进分母」听着像零头，「= 生产代码的 35.7%」才说得清那个百分比
// 在描述多小的一块。2026-08-03：此前文件头还宣称可以用 --test-coverage-include 把它们计入分母，
// 实测那个标志只是过滤报告里【已加载】的文件，补不上缺口——所以只能把限定条件说清楚。
test('summarizeCoverageGap：把分母覆盖面按文件数与行数一起算出来', () => {
  const report = [
    'ℹ app                       |        |          |         | ',
    'ℹ  src                      |        |          |         | ',
    'ℹ   agent.js                |  95.66 |    87.28 |   92.24 | 358-374',
    'ℹ all files                 |  77.51 |    81.91 |   74.22 | ',
  ].join('\n');
  const listFiles = (_root, dir) => (dir === 'app/src' ? ['app/src/agent.js', 'app/src/huge-untested.js'] : []);
  const countLines = (_root, file) => ({ 'app/src/agent.js': 100, 'app/src/huge-untested.js': 300 }[file] ?? 0);

  const gap = summarizeCoverageGap(report, { rootDir: '/fake', listFiles, countLines });

  assert.deepEqual(gap.unloaded, ['app/src/huge-untested.js']);
  assert.equal(gap.loadedFiles, 1);
  assert.equal(gap.totalFiles, 2);
  assert.equal(gap.gapLines, 300);
  assert.equal(gap.gapPercent, 75, '400 行里 300 行在分母外 → 75%');
});

test('summarizeCoverageGap：算不出行数时 gapPercent 是 null，不是 0（别让「不知道」伪装成「没缺口」）', () => {
  const listFiles = (_root, dir) => (dir === 'app/src' ? ['app/src/a.js'] : []);
  const gap = summarizeCoverageGap('', { rootDir: '/fake', listFiles, countLines: () => 0 });

  assert.equal(gap.gapPercent, null);
  assert.equal(gap.gapLines, 0);
  assert.deepEqual(gap.unloaded, ['app/src/a.js']);
});

// ── 2026-08-17：谁在守这个门槛 ──────────────────────────────────────────────
// doctor 把覆盖率检查改成 `--full` 才跑之后，它对用户说「覆盖率仍由 npm run check 守门」——
// 而 check 的脚本链里根本没有 coverage-check，CI 里也没有，门槛于是一个执行点都不剩。
// 这与本文件上方那条注释记的是同一类错（doctor 曾写死「≥ 65%」报了个不存在的数字）：
// 跨文件的事实断言没人校验，写错就一直错。下面两条把「守门人存在」和「doctor 别乱点名」
// 都变成机械判据。

test('覆盖率门槛必须有自动执行点——CI 里真的会跑 coverage-check', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/test.yml', import.meta.url), 'utf8');
  assert.match(
    workflow,
    /coverage-check\.js/,
    'CI 不跑 coverage-check ＝ 门槛无人守门：doctor 默认已跳过它，除此之外没有任何自动路径',
  );
});

test('doctor 跳过覆盖率时点名的 npm script，必须真的跑 coverage-check', () => {
  const doctor = readFileSync(new URL('../../scripts/doctor.js', import.meta.url), 'utf8');
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

  // 只看 checkCoverageThreshold 的跳过分支——doctor 别处提 npm 命令是它自己的事。
  const skipBranch = doctor.match(/function checkCoverageThreshold[\s\S]*?\n {2}}/)?.[0];
  assert.ok(skipBranch, 'checkCoverageThreshold 的跳过分支没找到，改了结构就同步改这条断言');

  for (const [, script] of skipBranch.matchAll(/npm run ([\w:]+)/g)) {
    assert.match(
      pkg.scripts?.[script] ?? '',
      /coverage-check/,
      `doctor 让用户拿 \`npm run ${script}\` 守覆盖率，但它的定义里没有 coverage-check —— 换个真跑的命令，或别点名`,
    );
  }
});
