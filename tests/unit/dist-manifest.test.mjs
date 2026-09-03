// tests/unit/dist-manifest.test.mjs —— 分发裁剪的不变量。
//
// 分发形态：`git archive` + `.gitattributes` 的 export-ignore，产出一棵「装机即可运行」的源码树。
// 这里锁三条，任何一条破了都会让用户下载到跑不起来的包：
//   ① 生产闭包（从用户会执行的入口静态展开的 import 图 + 按路径读的文件）**一个都不能**被 export-ignore；
//   ② 测试树与维护者门禁**必须**被 export-ignore，否则裁剪等于没做；
//   ③ 裁剪后的树里，保留的文档不能链接到被裁掉的文件——否则用户第一次跑 doctor 的 D9 就见红。
//
// 判据用 `git check-attr` 而不是解析 .gitattributes 文本：前者是 git 自己的裁决，
// 后者要重新实现一遍 gitattributes 的匹配与优先级规则（越靠后的规则覆盖前面的），必然分叉。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { bareImports, DIST_ENTRIES, EXTRA_RUNTIME_FILES, productionClosure } from '../../scripts/dist-manifest.js';
import { worktreeTree } from '../helpers/worktree-tree.mjs';

const ROOT = join(import.meta.dirname, '..', '..');

function git(args, opts = {}) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', ...opts });
  assert.equal(r.status, 0, `git ${args.join(' ')} 失败：${r.stderr}`);
  return r.stdout;
}

/** 批量问 git：这些路径的 export-ignore 是不是 set。用 --stdin 避免 ARG_MAX。 */
function exportIgnored(paths) {
  if (paths.length === 0) return new Set();
  const out = spawnSync('git', ['check-attr', '--stdin', 'export-ignore'], {
    cwd: ROOT, encoding: 'utf8', input: paths.join('\n'),
  });
  assert.equal(out.status, 0, out.stderr);
  const ignored = new Set();
  for (const line of out.stdout.split('\n')) {
    // 形如 `tests/unit/x.test.mjs: export-ignore: set`
    const m = line.match(/^(.*): export-ignore: (.*)$/);
    if (m && m[2] === 'set') ignored.add(m[1]);
  }
  return ignored;
}

test('入口清单里的文件都真实存在（防脚本改名后清单失效）', () => {
  for (const entry of [...DIST_ENTRIES, ...EXTRA_RUNTIME_FILES]) {
    assert.equal(existsSync(join(ROOT, entry)), true, `入口/运行时依赖不存在：${entry}`);
  }
});

test('① 生产闭包一个文件都不被 export-ignore', () => {
  const closure = productionClosure(ROOT);
  const ignored = exportIgnored(closure);
  assert.deepEqual(
    [...ignored].sort(),
    [],
    '这些生产必需文件会被 git archive 裁掉，用户下载后跑不起来',
  );
  // 闭包本身要覆盖到全部运行时源码，否则说明入口清单漏了分支。
  const srcFiles = git(['ls-files', 'src']).trim().split('\n');
  const uncovered = srcFiles.filter(f => !closure.includes(f));
  assert.deepEqual(uncovered, [], 'src/ 有文件不在生产闭包里：要么是死代码，要么入口清单漏了');
});

// 测试树、测试基建（tests/infra/）与全部门禁（tests/gates/）都在 tests/ 下，所以这里是
// 一条目录前缀而不是一串文件名模式。此前门禁散在 scripts/ 里，这个判据是十来个名字的长正则，
// 与 .gitattributes、repo-inventory 各存一份、三处各自漂移。目录前缀不需要维护。
test('② 测试树与维护者门禁确实被裁掉', () => {
  const tracked = git(['ls-files']).trim().split('\n');
  const MAINTAINER_ONLY_SCRIPTS = /^scripts\/(release\.sh|gen-icons\.js|upstream-watch\.js|dist-manifest\.js)$/;
  const mustDrop = tracked.filter(f =>
    f.startsWith('tests/')
    || f.startsWith('.github/')
    || f === 'eslint.config.js'
    || f === '.dockerignore'
    || MAINTAINER_ONLY_SCRIPTS.test(f),
  );
  assert.ok(mustDrop.length > 200, `预期裁掉的文件数应远大于 200，实际 ${mustDrop.length}`);

  const ignored = exportIgnored(mustDrop);
  const leaked = mustDrop.filter(f => !ignored.has(f));
  assert.deepEqual(leaked, [], '这些测试/门禁文件仍会被打进分发包');
});

// 两个「长得像门禁、实际是用户命令依赖」的例外。scripts/doctor.js 直接 import 它们，
// 裁掉的话用户跑 `node scripts/doctor.js` 会 ERR_MODULE_NOT_FOUND——这是唯一跨界的一条边，
// 单列出来钉住，防止日后按文件名模式批量清理时误伤。
test('doctor 依赖的两个门禁模块必须留在包里', () => {
  const exceptions = ['scripts/doc-consistency.js', 'scripts/collect-source-files.js'];
  // 读工作区那份，不是 `git show HEAD:`：否则工作区里刚把 import 删掉时这条仍会绿。
  const doctorSrc = readFileSync(join(ROOT, 'scripts/doctor.js'), 'utf8');
  for (const f of exceptions) {
    const base = f.replace('scripts/', './');
    assert.ok(doctorSrc.includes(base), `doctor.js 不再 import ${base}，本例外可以删了`);
  }
  assert.deepEqual([...exportIgnored(exceptions)], [], 'doctor 的依赖被裁掉了');
});

// 分发包的装机路径是 `npm ci --omit=dev`（不装 playwright/eslint 那 300M 里的一大半）。
// 生产代码若 import 了 devDependency，用户要到 npm ci 之后才发现，而那时装机已经失败。
test('④ 生产代码只依赖 dependencies，零 devDependency 泄漏', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const prod = new Set(Object.keys(pkg.dependencies ?? {}));
  const dev = new Set(Object.keys(pkg.devDependencies ?? {}));
  const used = bareImports(ROOT, productionClosure(ROOT));

  const leakedDev = used.filter(p => dev.has(p) && !prod.has(p));
  assert.deepEqual(leakedDev, [], '生产代码 import 了 devDependency，npm ci --omit=dev 后会 ERR_MODULE_NOT_FOUND');

  const undeclared = used.filter(p => !prod.has(p) && !dev.has(p));
  assert.deepEqual(undeclared, [], '生产代码 import 了未声明的包');
});

test('③ 裁剪后的树自洽：保留的文档不链接到被裁掉的文件', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccm-dist-'));
  try {
    // 打包对象是【工作区 tree】而不是 HEAD：未提交的移动/新增必须计入，否则这条用例会用
    // 上一次提交的文件树配这一次的裁剪规则，两边不同源 → 改坏了也恒绿（见 helpers/worktree-tree.mjs）。
    const tar = spawnSync('git', ['archive', '--worktree-attributes', '--format=tar', worktreeTree(ROOT)], {
      cwd: ROOT, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024,
    });
    assert.equal(tar.status, 0, String(tar.stderr));
    const untar = spawnSync('tar', ['-x', '-C', dir], { input: tar.stdout });
    assert.equal(untar.status, 0, String(untar.stderr));

    // 【调用方式必须与 doctor.js:474 完全一致】只传 rootDir，contractCounts 走默认值（直读
    // protocol.js 真值）。此前这里自己拼了一个 { agentEventTypes, inboundSocketEvents }，
    // key 名与实现期望的 { outbound, inbound } 对不上 → 计数恒 undefined → 恒报两条
    // contract_count_drift。当时只断言 dead_link 才没暴露，那是用错误的调用方式制造假信号。
    const { checkDocConsistency } = await import('../../scripts/doc-consistency.js');
    const result = checkDocConsistency({ rootDir: dir });
    assert.deepEqual(
      result.problems.map(p => `${p.code} | ${p.file} | ${p.message}`),
      [],
      '用户在分发包里跑 node scripts/doctor.js，D9 文档一致性会见红',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true }); // safe-rm: dir 来自本用例的 mkdtemp
  }
});
